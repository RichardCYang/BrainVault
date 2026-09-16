import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { formatNumber, formatDateTime, t } from '../../public/i18n.js';
import { joinSummaryPrefix } from '../../public/summary-prefix.js';

export const baseline = JSON.parse(readFileSync(new URL('../fixtures/resource-deep-audit-baseline.json', import.meta.url), 'utf8'));
export const kinds = ['ai-chat', 'accordion', 'database', 'timetable', 'gantt', 'treeview'];
const functionNames = { 'ai-chat':'AiChat', accordion:'Accordion', database:'Database', timetable:'Timetable', gantt:'Gantt', treeview:'TreeView' };
export function sourceFor(kind, mode='current') {
  const path = `public/${kind}-block.js`;
  return mode === 'baseline' ? baseline.files[path].source : readFileSync(new URL('../../'+path, import.meta.url),'utf8');
}
export function makeModule(kind, mode='current', { countUuid=false, countSummary=false, answerLimit=50_000 }={}) {
  const metrics = { uuidCalls:0, summaryFields:0, joinedCodeUnits:0 };
  let source = sourceFor(kind, mode).replace(/\r\n/g,'\n').replace(/^import[^\n]*;\r?$/gm,'').replace(/^export /gm,'');
  // Instrument only the original summary function, never unrelated joins.
  // Timing benchmarks leave instrumentation disabled.
  if(countSummary && mode==='baseline' && kind !== 'treeview') {
    const name='summarize'+functionNames[kind]+'Data';
    const original=exportedFunction(sourceFor(kind,mode), name);
    let changed=original.replace(/\.join\("(\\n(?:\\n)?)"\)/g, '.map(line => (metrics.summaryFields++,line)).join("$1")');
    changed=changed.replace(/return ([\s\S]*?)\.slice\(0, (?:20_000|20000)\)/, 'return measureFullSummary($1).slice(0, 20000)');
    source=source.replace(original.replace(/^export /gm,''),changed.replace(/^export /gm,''));
  }
  const measuredJoin = (lines, options) => {
    function* measured() { for(const line of lines) { metrics.summaryFields++; yield line; } }
    const output=joinSummaryPrefix(measured(), options); metrics.joinedCodeUnits+=output.length; return output;
  };
  const globalValue=countUuid ? { crypto:{ randomUUID(){metrics.uuidCalls++;return '00000000-0000-4000-8000-'+String(metrics.uuidCalls).padStart(12,'0');} } } : globalThis;
  const suffix=functionNames[kind];
  const factory = new Function('formatNumber','formatDateTime','t','AI_CHAT_ANSWER_MAX_LENGTH','renderServerBlockHtml','joinSummaryPrefix','globalThis','metrics','measureFullSummary', source+`\nreturn {normalize:normalize${suffix}Data,summarize:summarize${suffix}Data,createDefault:createDefault${suffix}Data,metrics};`);
  return factory(formatNumber,formatDateTime,t,answerLimit,()=>{throw Error('DOM renderer not part of Node summary harness');},countSummary?measuredJoin:joinSummaryPrefix,globalValue,metrics,(value)=>{metrics.joinedCodeUnits+=value.length;return value;});
}
export function exportedFunction(source,name) {
  const match=source.replace(/\r\n/g,'\n').match(new RegExp('export function '+name+'\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n\\}'));
  if(!match)throw Error('Function not found: '+name);
  return match[0];
}
// Execute the exact server summary function. Its unmodified normalization dependency
// is injected so this does not masquerade as a zod/icon-validation integration test.
export function makeServerSummary(kind,mode='current',normalize=()=>{throw Error('normalizer required');}) {
  const path=`src/lib/${kind}.ts`, name=`summarize${functionNames[kind]}Data`;
  const source=mode==='baseline'?baseline.files[path].source:readFileSync(new URL('../../'+path,import.meta.url),'utf8');
  const fn=stripTypeScriptTypes(exportedFunction(source,name)).replace(/^export /gm,'');
  const labels={chatgpt:'ChatGPT',gemini:'Gemini',claude:'Claude',deepseek:'DeepSeek',grok:'Grok'};
  return new Function('joinSummaryPrefix','normalizeAccordionData','getAiProviderLabel',fn+`;return ${name};`)(joinSummaryPrefix,normalize,provider=>labels[provider]??labels.chatgpt);
}
export function randomGenerator(seed=0xB4C02616) {let x=seed>>>0;return()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x/2**32;};}
export function fixture(kind,{large=false,count,mark='A',unicode=false}={}) {
  const n=count??(large?({ 'ai-chat':50,accordion:50,database:200,timetable:200,gantt:200,treeview:300 })[kind]:3);
  const text=(unicode?'한😀':mark).repeat(large?25000:5);
  if(kind==='ai-chat')return {title:'Chat <&>',provider:'claude',model:'Model',layout:'paginated',hideAnswerBorder:true,turns:Array.from({length:n},(_,i)=>({answeredAt:i%2?'':'2026-09-16T09:30',question:`Q${i}`,answer:text.slice(0,large?50000:15)}))};
  if(kind==='accordion')return {title:'Accordion <&>',showOrder:true,items:Array.from({length:n},(_,i)=>({id:`a${i}`,icon:'📄',title:'Section '+i,content:text.slice(0,large?8000:15),open:i%2===0}))};
  if(kind==='database'){
    const properties=Array.from({length:large?8:3},(_,i)=>({id:'p'+i,name:'Property '+i,type:i===0?'title':'text',options:[]}));
    return {title:'Database',properties,rows:Array.from({length:n},(_,i)=>({id:'r'+i,values:Object.fromEntries(properties.map(p=>[p.id,text.slice(0,large?2000:15)]))})),views:[{id:'v1',name:'Table',type:'table',filters:[],sorts:[],hiddenPropertyIds:[],groupPropertyId:null}],activeViewId:'v1'};
  }
  if(kind==='timetable')return {title:'Timetable',date:'2026-09-16',interval:1,entries:Array.from({length:n},(_,i)=>({id:'e'+i,start:'09:00',end:'10:00',title:('Entry '+i+' '+text).slice(0,large?160:15),note:text.slice(0,large?500:15),completed:i%2===0}))};
  if(kind==='gantt')return {title:'Gantt',scale:'month',viewStart:'2026-09-01',showWeekends:true,tasks:Array.from({length:n},(_,i)=>({id:'g'+i,start:'2026-09-16',end:'2026-09-20',title:('Task '+i+' '+text).slice(0,large?160:15),assignee:text.slice(0,large?80:15),progress:i%101,status:['not_started','in_progress','review','done','blocked'][i%5]}))};
  return {title:'Tree',nodes:Array.from({length:n},(_,i)=>({id:'n'+i,parentId:null,title:'Node '+i,note:text.slice(0,large?8000:15),expanded:true}))};
}
export function freeze(value) {if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}
