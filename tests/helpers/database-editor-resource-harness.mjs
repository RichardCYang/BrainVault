// Execute the original/current module, not a reimplementation. The small DOM
// double below measures deterministic algorithmic work, not browser layout.
import { readFileSync } from 'node:fs';
export const root = new URL('../../', import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL('tests/fixtures/database-editor-resource-baseline.json', root), 'utf8'));
export const source = (before = false) => before ? baseline.files['public/database-block.js'].source : readFileSync(new URL('public/database-block.js', root), 'utf8');
let sequence = 0;
export async function load(before = false, instrument = false) {
  let text = source(before).replace(/\r\n/g, '\n');
  if (instrument) {
    text = text.replace('return property.options.find((option) => option.id === optionId) ?? null;', 'return property.options.find((option) => (auditMetrics.optionComparisons++, option.id === optionId)) ?? null;')
      .replaceAll('names.includes(', 'auditIncludes(names, ')
      .replace('selectedNames.has(', '(auditMetrics.nameLookups++, selectedNames).has(');
    const start = text.indexOf('function createDatabaseMultiSelectValueReader(');
    if (start >= 0) {
      const end = text.indexOf('\nfunction createValueEditor(', start);
      let part = text.slice(start, end)
        .replace('byId.get(value[index])', '(auditMetrics.optionLookups++, byId.get(value[index]))')
        .replace('for (const option of property.options) {', 'for (const option of property.options) { auditMetrics.indexVisits++;')
        .replace('labels ??= [];', 'if (!labels) { labels = []; auditMetrics.labelArrays++; }')
        .replace('optionsByProperty = undefined;', 'auditMetrics.releasedIndexProperties += optionsByProperty?.size ?? 0; optionsByProperty = undefined;');
      text = text.slice(0, start) + part + text.slice(end);
    }
    text = text.replaceAll('value.map((id) => getOption(property, id)?.name).filter(Boolean).join(", ")', '(auditMetrics.labelArrays += 2, value.map((id) => getOption(property, id)?.name).filter(Boolean).join(", "))');
    text = `export const auditMetrics = {optionComparisons:0,optionLookups:0,indexVisits:0,labelArrays:0,nameComparisons:0,nameLookups:0,releasedIndexProperties:0};\nfunction auditIncludes(values,target){for(const value of values){auditMetrics.nameComparisons++;if(value===target)return true;}return false;}\n` + text;
  }
  text = text.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (_,a,relative,b) => a+new URL(relative,new URL('public/database-block.js',root)).href+b);
  text += '\nexport { createValueEditor, createTableView, createListView, createBoardView };';
  text += `\n//# sourceURL=database-editor-${before ? 'original' : 'updated'}-${sequence++}.js`;
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
}
export class Element {
  constructor(tag) {
    this.tag = tag; this.dataset = {}; this.attributes = {}; this.children = []; this.listeners = new Map(); this.style = {}; this.value = ''; this.textContent = ''; this.className = '';
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...values) => { this.className = [...new Set([...classes(), ...values])].join(' '); },
      remove: (...values) => { const set = classes(); for (const value of values) set.delete(value); this.className = [...set].join(' '); },
      contains: value => classes().has(value),
      toggle: (value, force) => { const enabled = force ?? !classes().has(value); this.classList[enabled ? 'add' : 'remove'](value); return enabled; }
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  removeAttribute(key) { delete this.attributes[key]; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, fn) { const fns = this.listeners.get(type) ?? []; fns.push(fn); this.listeners.set(type, fns); }
  send(type) { for (const fn of this.listeners.get(type) ?? []) fn({ target: this }); }
  get lastElementChild() { return this.children.at(-1); }
}
export const documentDouble = { createElement: tag => new Element(tag) };
export function render(module, database, view = 'table', callbacks = {}) {
  const names = {table:'createTableView',list:'createListView',board:'createBoardView'};
  return module[names[view]](null, database, {...database.views[0],type:view}, database.rows, callbacks.onDirty ?? (()=>{}), callbacks.replaceEditor ?? (()=>{}));
}
export function controls(element, result = []) {
  if (element.tag === 'input' || element.tag === 'select') result.push(element);
  for (const child of element.children ?? []) if (child && typeof child === 'object') controls(child, result);
  return result;
}
export function snapshot(element) {
  return {tag:element.tag,text:element.textContent,value:element.value,type:element.type,checked:element.checked,classes:element.className,
    attributes:element.attributes,dataset:element.dataset,maxLength:element.maxLength,placeholder:element.placeholder,
    children:element.children.map(child => typeof child === 'object' ? snapshot(child) : child)};
}
export function fixture({rows=200,properties=20,options=30,type='multi_select'} = {}) {
  const schema = Array.from({length:properties},(_,i)=>({id:i?'p'+i:'title',name:'Property '+i,type:i?type:'title',options:i&&['multi_select','select'].includes(type)?Array.from({length:options},(_,j)=>({id:'o'+j,name:'항목 '+j+' 😀',color:'blue'})):[]}));
  return {title:'Resource regression',properties:schema,rows:Array.from({length:rows},(_,i)=>({id:'r'+i,values:Object.fromEntries(schema.map(p=>[p.id,p.type==='title'?'Row '+i:p.type==='multi_select'?p.options.map(o=>o.id):p.type==='select'?p.options.at(-1)?.id??'':p.type==='checkbox'?i%2===0:p.type==='number'?i:'text '+i]))})),
    views:[{id:'view',name:'View',type:'table',filters:[],sorts:[],groupPropertyId:null,hiddenPropertyIds:[]}],activeViewId:'view'};
}
export function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) {Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value; }
export function reset(module) { for (const key of Object.keys(module.auditMetrics)) module.auditMetrics[key] = 0; }
export function random(seed=0x18db2026) { let s=seed>>>0;return n=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s%n;}; }
