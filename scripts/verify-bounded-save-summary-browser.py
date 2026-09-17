#!/usr/bin/env python3
"""Real Chromium DOM regression of the exact original and modified app modules.

Optional test dependency: Python 3 + playwright, and Chromium (or CHROMIUM_PATH).
Run: python scripts/verify-bounded-save-summary-browser.py
Prints JSON only; no repository logs/screenshots. A loopback fixture server returns
an unauthenticated response, then the test explicitly supplies page state. This
is a real DOM/module-load/edit/serialize/read-only test, NOT live MariaDB/auth E2E.
The served-only audit export is never written into the production app module.
Use --offline when managed Chromium blocks all URLs: modules load from in-memory
Blob URLs via an import map, and local/session storage + fetch are explicit
in-memory doubles. IndexedDB is unavailable in this mode, so persistence correctly
fails closed. This mode does NOT verify network/IndexedDB/writable-page boot.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, unquote
import hashlib, json, mimetypes, os, re, shutil, threading, sys
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
FIXTURE=json.loads((ROOT/'tests/fixtures/bounded-save-summary-original.json').read_text())
CURRENT=(ROOT/'public/app.js').read_text()

def original_app():
    text=CURRENT.removeprefix('import { joinSummaryPrefix } from "./summary-prefix.js";\n')
    for name,start,end in [('table','const tableLimits =','const kanbanLimits ='),('kanban','const kanbanLimits =','const bookmarkLimits ='),('bookmark','const bookmarkLimits =','const slashCommands =')]:
        a,b=text.index(start),text.index(end)
        text=text[:a]+FIXTURE['sections'][name]+text[b:]
    for name in ['summarizeKanbanData','buildBlockPayload']:
        text,count=re.subn(r'^function '+name+r'\([\s\S]*?^}',lambda _:FIXTURE['functions'][name],text,count=1,flags=re.M)
        assert count==1
    # Verify the reconstruction really is the uploaded app, not an approximate
    # rewrite. The uploaded app uses CRLF; the fixture normalizes line endings.
    assert hashlib.sha256(text.replace('\n','\r\n').encode()).hexdigest()==FIXTURE['fileSha256']['public/app.js']
    return text
ORIGINAL=original_app()
HOOK='\nglobalThis.__boundedAudit = {state,elements,renderBlock,buildBlockPayload,scheduleBlockSave,syncPageModeUi,normalizeTableData,normalizeKanbanData,normalizeBookmarkData,isPageReadOnly};\n'
class Server(ThreadingHTTPServer):
    daemon_threads=True
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        path=unquote(urlsplit(self.path).path)
        if path.startswith('/api/'):
            self.send_response(401); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(b'{"error":{"code":"UNAUTHENTICATED","message":"Isolated browser fixture"}}'); return
        rel=path.lstrip('/') or 'index.html'
        file=(ROOT/'public'/rel).resolve()
        if not file.is_relative_to((ROOT/'public').resolve()) or not file.is_file():
            self.send_response(404);self.end_headers();return
        content=((self.server.variant_source+HOOK).encode() if rel=='app.js' else file.read_bytes())
        mime='text/javascript' if file.suffix=='.js' else mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        self.send_response(200);self.send_header('Content-Type',mime+'; charset=utf-8');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(content)
    def do_POST(self): self.send_response(405);self.end_headers()
    do_PATCH=do_POST
    do_DELETE=do_POST
EVALUATE=r'''() => {
 const a=__boundedAudit, checks=[], outputs={};
 function check(name,value){if(!value)throw Error(name);checks.push(name);}
 const hostile='<img src=x onerror="globalThis.__executed=true"><script>globalThis.__executed=true</script>';
 a.state.user={id:'fixture-user',username:'fixture'};
 a.state.workspaceView='page';a.state.pageMode='write';
 a.state.selectedPage={id:'fixture-page',ownerId:'fixture-user',title:'Fixture',version:1,contentVersion:1,access:{canEdit:true},blocks:[]};
 const data={
  TABLE:{headerRow:true,headerColumn:true,rows:Array.from({length:50},(_,r)=>Array.from({length:20},(_,c)=>r===0&&c===0?hostile:`${r}:${c}:`.padEnd(4000,'x')))},
  KANBAN:{title:'Board 한국어',columns:Array.from({length:12},(_,c)=>({id:`c${c}`,title:`Column ${c}`,color:'blue',cards:Array.from({length:50},(_,k)=>({id:`card${c}-${k}`,title:k===0?hostile:`Title ${k}`,description:'d'.repeat(1000),icon:'📝',color:'pink',tags:['one','two']}))}))},
  BOOKMARK:{title:'Bookmarks',view:'list',maxItems:500,listColumns:3,items:Array.from({length:500},(_,i)=>({id:`b${i}`,title:i===0?hostile:`Title ${i}`,description:'d'.repeat(1000),url:`https://example.com/${i}`,verified:false,previewToken:'',imageUrl:'',faviconUrl:'',siteName:'Example'}))}
 };
 for(const type of Object.keys(data)) {
  const key=type.toLowerCase();
  const block={id:`fixture-${key}`,pageId:'fixture-page',type,markdown:'',checked:false,version:1,sortOrder:0,parentBlockId:null,metadata:{[key]:data[type],custom:{retained:true}},children:[],updatedAt:'2026-09-17T00:00:00Z'};
  a.state.selectedPage.blocks=[block];
  const row=a.renderBlock(block);a.elements.blockList.replaceChildren(row);
  const first=a.buildBlockPayload(row,block);
  check(`${type}: full metadata preserved`,type==='TABLE'?first.metadata.table.rows.length===50&&first.metadata.table.rows[49][19]===data.TABLE.rows[49][19]:type==='KANBAN'?first.metadata.kanban.columns[11].cards.length===50:first.metadata.bookmark.items.length===500);
  check(`${type}: summary stays bounded`,first.markdown.length===20000);
  check(`${type}: custom metadata kept`,first.metadata.custom.retained===true);
  check(`${type}: hostile data is not executable DOM`,!row.querySelector('script, [onerror]')&&!globalThis.__executed);
  if(type==='TABLE'){
   check('TABLE: header rendering kept',row.querySelector('th').scope==='col');
   row.querySelector('.table-cell-input').value='edited 한국어 📝';
   row.querySelector('[data-table-row="49"][data-table-column="19"]').value='tail edit retained';
  } else if(type==='KANBAN') {
   check('KANBAN: all 600 cards rendered',row.querySelectorAll('.kanban-card').length===600);
   row.querySelector('.kanban-card-title').value='edited 한국어 📝';
   row.querySelectorAll('.kanban-card-description')[599].value='tail edit retained';
  } else {
   const links=[...row.querySelectorAll('a[target="_blank"]')];
   check('BOOKMARK: link hardening kept',links.length>=500&&links.every(link=>link.rel.includes('noopener')));
   row.querySelector('.bookmark-title-input').value='edited 한국어 📝';
   row.bookmarkData.items[499].description='tail edit retained';
  }
  const edited=a.buildBlockPayload(row,block);
  check(`${type}: real DOM edit enters payload`,edited.markdown.includes('edited 한국어 📝'));
  const tail=type==='TABLE'?edited.metadata.table.rows[49][19]:type==='KANBAN'?edited.metadata.kanban.columns[11].cards[49].description:edited.metadata.bookmark.items[499].description;
  check(`${type}: edits after summary prefix are not lost`,tail==='tail edit retained');
  a.state.pageMode='read';a.syncPageModeUi();
  check(`${type}: read-only guard rejects persistence`,a.isPageReadOnly()&&a.scheduleBlockSave(row)===false);
  check(`${type}: read-only controls locked`,[...row.querySelectorAll('input,textarea')].every(el=>el.readOnly||el.disabled));
  a.state.pageMode='write';a.state.selectedPage.access.canEdit=false;
  check(`${type}: unauthorized editor cannot schedule save`,a.scheduleBlockSave(row)===false);
  a.state.selectedPage.access.canEdit=true;
  outputs[type]={first,edited};
  a.elements.blockList.replaceChildren();
 }
 a.state.pageMode='read';a.state.selectedPage=null;
 return {checks,outputs,executed:!!globalThis.__executed};
}'''
def main():
    executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
    if not executable: raise RuntimeError('Set CHROMIUM_PATH to Chromium/Chrome')
    offline='--offline' in sys.argv
    report={'scope':'Chromium real module/DOM differential; explicit page state, not live database/authentication E2E','offline':offline,'variants':{}}
    if offline: report['limitations']='Blob-loaded actual app modules; fetch/local/session storage are explicit doubles; IndexedDB unavailable, persistence fails closed; no network or writable boot validation.'
    results={}
    with sync_playwright() as p:
        args=['--disable-background-networking','--disable-dev-shm-usage']
        if hasattr(os,'geteuid') and os.geteuid()==0: args.append('--no-sandbox')
        browser=p.chromium.launch(executable_path=executable,headless=True,args=args)
        report['chromium']=browser.version
        try:
            for variant,source in [('original',ORIGINAL),('current',CURRENT)]:
                server=Server(('127.0.0.1',0),Handler);server.variant_source=source
                thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
                context=browser.new_context();page=context.new_page();errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                try:
                    if not offline:
                        page.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='networkidle')
                    else:
                        html=(ROOT/'public/index.html').read_text()
                        html=re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', html, flags=re.I)
                        html=re.sub(r'<link\b[^>]*>', '', html, flags=re.I)
                        page.set_content(html)
                        modules={}
                        for file in (ROOT/'public').glob('*.js'):
                            content=source+HOOK if file.name=='app.js' else file.read_text()
                            content=re.sub(r'''(["'])(\./[^"']+\.js)\1''',lambda match:match[1]+'https://brainvault.test/'+match[2][2:]+match[1],content)
                            modules['https://brainvault.test/'+file.name]=content
                        page.evaluate('''async modules => {
                            const makeStorage=()=>{const m=new Map();return {get length(){return m.size},key:i=>[...m.keys()][i]??null,getItem:k=>m.get(String(k))??null,setItem:(k,v)=>m.set(String(k),String(v)),removeItem:k=>m.delete(String(k)),clear:()=>m.clear()}};
                            Object.defineProperty(window,'localStorage',{value:makeStorage(),configurable:true});
                            Object.defineProperty(window,'sessionStorage',{value:makeStorage(),configurable:true});
                            Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true});
                            window.fetch=async()=>new Response(JSON.stringify({error:{code:'UNAUTHENTICATED',message:'Offline fixture'}}),{status:401,headers:{'Content-Type':'application/json'}});
                            const imports={};for(const [name,source] of Object.entries(modules))imports[name]=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
                            const map=document.createElement('script');map.type='importmap';map.textContent=JSON.stringify({imports});document.head.append(map);
                            await import('https://brainvault.test/app.js');
                        }''',modules)
                    page.wait_for_function('!!globalThis.__boundedAudit',timeout=15000)
                    result=page.evaluate(EVALUATE)
                    assert not errors, errors
                    digest=hashlib.sha256(json.dumps(result['outputs'],ensure_ascii=True,sort_keys=True).encode()).hexdigest()
                    results[variant]=result['outputs']
                    report['variants'][variant]={'checks':result['checks'],'checkCount':len(result['checks']),'payloadSha256':digest,'pageErrors':errors}
                finally:context.close();server.shutdown();server.server_close()
        finally:browser.close()
    assert results['original']==results['current'],'Original/modified real-DOM save payloads differ'
    report['identicalWholePayloads']=True
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
