// Dependency-free component harness. Router/database doubles are explicit: this
// does not replace the project's real Express/MariaDB integration tests.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/search-tree-resource-baseline.json', import.meta.url), 'utf8'));
export function sourceFor(path, mode = 'current') {
  return mode === 'baseline' ? baseline.files[path].source : readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}
export function namedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  return source.slice(start, end < 0 ? source.length : end).trim();
}
export function browserSource(mode = 'current') {
  const source = sourceFor('public/app.js', mode);
  return ['getSearchDialogFocusableElements', 'getSearchResultButtons', 'handleSearchDialogKeydown']
    .map(name => namedFunction(source, name)).join('\n');
}
export function makeKeyboard(mode = 'current', { count = 30, disabled = [], hidden = [], open = true, noFocusables = false } = {}) {
  const metrics = { queries: 0, rectReads: 0, focusableQueries: 0 };
  const document = { activeElement: null };
  const makeElement = id => ({ id, disabled: false, hidden: false,
    focus() { document.activeElement = this; }, getAttribute() { return null; },
    getClientRects() { metrics.rectReads++; return this.hidden ? [] : [{}]; }
  });
  const input = makeElement('input'), close = makeElement('close');
  const buttons = Array.from({length: count}, (_, i) => {
    const el = makeElement(`result-${i}`); el.disabled = disabled.includes(i); el.hidden = hidden.includes(i); return el;
  });
  const dialog = makeElement('dialog');
  dialog.querySelectorAll = () => { metrics.focusableQueries++; return noFocusables ? [] : [input, close, ...buttons]; };
  const elements = { searchInput: input, searchDialog: dialog,
    searchResults: { querySelectorAll() { metrics.queries++; return buttons; } } };
  const state = { searchDialogOpen: open };
  let closes = 0;
  const handler = new Function('document', 'elements', 'state', 'closeSearchDialog', 'mobileSidebarFocusableSelector',
    browserSource(mode) + '\nreturn handleSearchDialogKeydown;')(
    document, elements, state, () => { closes++; state.searchDialogOpen = false; }, 'input,button');
  input.focus();
  return { metrics, state, buttons, input, dialog, close, document,
    key(key, { target = document.activeElement, ...options } = {}) {
      let prevented = false, stopped = false;
      const event = { key, target, ...options, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } };
      handler(event);
      return { focused: document.activeElement?.id, prevented, stopped, closes, open: state.searchDialogOpen };
    }
  };
}
export function makeTree(mode = 'current', instrument = false) {
  const metrics = { mapGets: 0, setAdds: 0 };
  class CountedMap extends Map { get(key) { metrics.mapGets++; return super.get(key); } }
  class CountedSet extends Set { add(value) { metrics.setAdds++; return super.add(value); } }
  const source = stripTypeScriptTypes(sourceFor('src/lib/treeview.ts', mode)).replace(/^export /gm, '');
  const api = new Function('Map', 'Set', source + '\nreturn { render: renderTreeViewHtml, normalize: normalizeTreeViewData, summarize: summarizeTreeViewData, path: getNodePath };')(
    instrument ? CountedMap : Map, instrument ? CountedSet : Set);
  return { ...api, metrics };
}
export function treeFixture(count = 300, { reverse = false, flat = false, notes = true, oneNote = false, long = false } = {}) {
  const nodes = Array.from({length:count}, (_, i) => ({id:`node-${i}`, parentId:!flat && i ? `node-${i-1}` : null,
    title:long ? `노드 ${i} <&> 😀`.repeat(30) : `Node ${i}`,
    note: notes && (!oneNote || i === count - 1) ? `Memo ${i}\n<script>unsafe</script>` : '', expanded:i%3 !== 0}));
  return {title:'<Tree> 한글 😀',nodes:reverse ? nodes.reverse() : nodes};
}
const likeSource = stripTypeScriptTypes(readFileSync(new URL('../../src/lib/sql-like.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
const literalPattern = new Function(likeSource + '\nreturn toSqlLikeContainsPattern;')();
// Only SELECT projection is modeled here. Tests separately prove FROM/WHERE/
// authorization/order/limit SQL and parameters are byte-for-byte unchanged.
export function projectRow(sql, row) {
  const projection = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM')).trim();
  const result = {};
  for (const item of projection.split(',')) {
    const column = item.trim();
    if (/^[pb]\.\*$/.test(column)) {
      for (const [key, value] of Object.entries(row)) if (!key.startsWith('page_') || key === 'page_id') result[key] = value;
    } else {
      const match = column.match(/^[pb]\.(\w+)(?:\s+AS\s+(\w+))?$/i);
      if (!match) throw new Error(`Unexpected SELECT projection: ${column}`);
      const name = match[2] ?? match[1];
      result[name] = row[name];
    }
  }
  return result;
}
export function makeSearch(mode = 'current', {pages = [], blocks = [], failAt = 0} = {}) {
  const calls = [], registrations = [], headers = {};
  let response, nextError, handler, transactions = 0, selectedBytes = 0;
  const router = {get(path, middleware, callback) { registrations.push({path,middleware}); handler = callback; }};
  const transaction = async callback => {
    transactions++;
    return callback({query: async (sql, params) => {
      calls.push({sql,params});
      if (calls.length === failAt) throw new Error('Database fixture failure');
      const rows = (calls.length % 2 ? pages : blocks).map(row => projectRow(sql,row));
      selectedBytes += Buffer.byteLength(JSON.stringify(rows));
      return rows;
    }});
  };
  let source = stripTypeScriptTypes(sourceFor('src/routes/search.routes.ts', mode));
  source = source.slice(source.indexOf('function snippet('));
  new Function('searchRouter','validate','searchQuerySchema','requireUser','getValidatedQuery','transaction','toSqlLikeContainsPattern', source)(
    router, value => value, {}, user => { if (!user) throw new Error('Unauthenticated'); return user; }, req => req.query, transaction, literalPattern);
  return { calls, registrations, headers,
    async run({user = {id:'user-owner'}, q = 'needle', limit = 20} = {}) {
      await handler({user,query:{q,limit}}, {setHeader(name,value) {headers[name]=value;}, json(value) {response=value;}}, error => {nextError=error;});
      return {response,headers,nextError:nextError?.message,transactions,selectedBytes};
    }
  };
}
export function searchFixture(count = 30, unusedSize = 256 * 1024) {
  const text = 'x'.repeat(unusedSize);
  const pages = Array.from({length:count},(_,i)=>({id:`page-${i}`,title:`Needle page ${i}`,icon:i%2?'📝':null,updated_at:new Date(1735689600000-i*2000).toISOString(), owner_id:'user-owner',is_archived:0, cover_url:'https://example.invalid/'+ 'a'.repeat(100),cover_position_x:50,cover_position_y:50,is_collection:0,parent_page_id:null,created_at:'2025-01-01T00:00:00.000Z'}));
  const blocks = Array.from({length:count},(_,i)=>({id:`block-${i}`,page_id:`page-${i}`,page_title:`Needle page ${i}`,page_icon:i%2?'📝':null,type:'TREEVIEW',markdown:`prefix needle 한글 ${i}`,updated_at:new Date(1735689601000-i*2000).toISOString(), metadata:{payload:text},html_cache:text,sort_order:i,edit_version:1,parent_block_id:null,checked:0,created_at:'2025-01-01T00:00:00.000Z'}));
  return {pages,blocks};
}
