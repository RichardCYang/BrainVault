// Runs the exact original/current functions, with explicitly isolated DOM inputs.
// No database, HTTP-authentication or bundler integration is implied by this harness.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { joinSummaryPrefix } from '../../public/summary-prefix.js';
import { t, setLanguage } from '../../public/i18n.js';
export { setLanguage };
export const original = JSON.parse(readFileSync(new URL('../fixtures/bounded-save-summary-original.json', import.meta.url), 'utf8'));
export const currentApp = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export const currentServer = readFileSync(new URL('../../src/lib/bookmark.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export function extractFunction(source, name) {
  const match = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  if (!match) throw new Error(`Missing complete function: ${name}`);
  return match[0];
}
export function makeHarness(mode = 'current', { crypto = { randomUUID } } = {}) {
  if (!['original','current'].includes(mode)) throw new Error('Invalid variant');
  const old = mode === 'original';
  const section = (name, start, end) => old ? original.sections[name] : currentApp.slice(currentApp.indexOf(start), currentApp.indexOf(end));
  const functions = ['summarizeKanbanData','buildBlockPayload'].map(name => old ? original.functions[name] : extractFunction(currentApp, name));
  // The only TypeScript annotation in this exact selected server function is its
  // BookmarkData parameter; no unrelated server imports are stubbed or executed.
  const serverSummary = (old ? original.serverSummary : extractFunction(currentServer, 'summarizeBookmarkData'))
    .replace('export function summarizeBookmarkData(data: BookmarkData)', 'function serverSummary(data)');
  return new Function('joinSummaryPrefix','t','globalThis', `
    ${section('table','const tableLimits =','const kanbanLimits =')}
    ${section('kanban','const kanbanLimits =','const bookmarkLimits =')}
    ${section('bookmark','const bookmarkLimits =','const slashCommands =')}
    ${functions.join('\n')}
    ${serverSummary}
    const getBlockTextarea = row => row.textarea ?? null;
    const getBlockChecked = row => row.checkbox ?? null;
    const getBlockById = () => { throw Error('Pass knownBlock explicitly'); };
    ${old ? original.functions.getBlockMetadata : extractFunction(currentApp,'getBlockMetadata')}
    const isTextAlignableBlockType = () => false;
    const extractTableData = row => normalizeTableData(row.data);
    const extractKanbanData = row => normalizeKanbanData(row.data);
    const extractBookmarkData = row => normalizeBookmarkData(row.data);
    return {
      normalizeTableData,normalizeKanbanData,normalizeBookmarkData,normalizeBookmarkUrl,
      summarizeKanbanData,summarizeBookmarkData,serverSummary,buildBlockPayload,
      tableSummary: table => buildBlockPayload({dataset:{blockType:'TABLE'},data:table},null).markdown,
      createClientId,validateKanbanTags
    };
  `)(joinSummaryPrefix,t,{crypto});
}
export function makeFixture(kind, salt = 0, small = false) {
  const text = (n, marker) => `${salt}:${marker}:`.padEnd(n, 'x').slice(0,n);
  if (kind === 'table') return {headerRow:true,headerColumn:true,rows:Array.from({length:small?3:50},(_,i)=>Array.from({length:small?3:20},(_,j)=>text(small?20:4000,`${i}:${j}`)))};
  if (kind === 'kanban') return {title:text(small?12:120,'board'),columns:Array.from({length:small?3:12},(_,i)=>({id:`col-${i}`,title:text(small?12:80,`column-${i}`),color:'blue',cards:Array.from({length:small?2:50},(_,j)=>({id:`card-${i}-${j}`,title:text(small?16:160,`title-${i}-${j}`),description:text(small?24:1000,`description-${i}-${j}`),icon:'📝',color:'pink',tags:Array.from({length:small?1:8},(_,k)=>text(small?5:40,`tag-${k}`))}))}))};
  if (kind === 'bookmark') return {title:text(small?12:120,'bookmark'),view:'list',listColumns:3,maxItems:500,items:Array.from({length:small?3:500},(_,i)=>({id:`item-${i}`,url:`https://example.com/${salt}/${i}/`.padEnd(small?60:2048,'x'),title:text(small?15:300,`title-${i}`),description:text(small?24:1000,`description-${i}`),siteName:'Example',imageUrl:'',faviconUrl:'',previewToken:'',verified:false}))};
  throw new Error(`Unknown fixture: ${kind}`);
}
export function operations(harness) {
  return {
    table: data => harness.tableSummary(data),
    kanban: data => harness.summarizeKanbanData(data),
    bookmark: data => harness.summarizeBookmarkData(data),
    serverBookmark: data => harness.serverSummary(data),
    kanbanNormalize: data => harness.normalizeKanbanData(data)
  };
}
