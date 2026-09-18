#!/usr/bin/env python3
"""Execute original/current SELECT text against SQLite test fixtures.
Run: python scripts/verify-search-query-projection.py
The exact query text is exercised, not a SQL mock. SQLite is supplementary:
this does NOT certify MariaDB optimizer/collation/transaction behavior.
"""
from pathlib import Path
import json
import re
import sqlite3
import hashlib
ROOT=Path(__file__).resolve().parents[1]
FIXTURE=json.loads((ROOT/'tests/fixtures/search-tree-resource-baseline.json').read_text())['files']
def main():
    sources={'baseline':FIXTURE['src/routes/search.routes.ts']['source'],'current':(ROOT/'src/routes/search.routes.ts').read_text()}
    queries={mode:re.findall(r'`(SELECT[\s\S]*?)`',source) for mode,source in ((mode, text.replace('\r\n','\n')) for mode, text in sources.items())}
    assert all(len(q)==2 for q in queries.values())
    for before,after in zip(queries['baseline'],queries['current']):
        assert before[before.index('FROM'):]==after[after.index('FROM'):]
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.executescript('''
    CREATE TABLE pages(id TEXT PRIMARY KEY,title TEXT,icon TEXT,updated_at TEXT,owner_id TEXT,is_archived INTEGER,cover_url TEXT);
    CREATE TABLE blocks(id TEXT PRIMARY KEY,page_id TEXT,type TEXT,markdown TEXT,updated_at TEXT,metadata TEXT,html_cache TEXT);
    CREATE TABLE page_shares(page_id TEXT,user_id TEXT,permission TEXT);
    CREATE TABLE collection_shares(collection_id TEXT,user_id TEXT,permission TEXT);
    CREATE TABLE page_collection_memberships(page_id TEXT,collection_id TEXT);
    ''')
    cases=[
      ('owner',True,False,None,None,True),('outsider',False,False,None,None,False),
      ('direct-read',False,False,'READ',None,False),('direct-edit',False,False,'EDIT',None,True),
      ('collection-read',False,False,None,'READ',True),('collection-edit',False,False,None,'EDIT',True),
      ('collection-read-direct-edit',False,False,'EDIT','READ',True),('collection-edit-direct-read',False,False,'READ','EDIT',True),
      ('archived-owner',True,True,None,None,False),('archived-direct-edit',False,True,'EDIT',None,False),
      ('archived-collection',False,True,None,'EDIT',False),('other-users-shares',False,False,None,None,False)
    ]
    allowed=[]
    for i,(name,owner,archived,direct,collection,visible) in enumerate(cases):
        title=f'needle {name} literal %_! \\ 한글 😀',
        stamp=f'2025-01-{i+1:02d}T00:00:00.000Z'
        db.execute('INSERT INTO pages VALUES (?,?,?,?,?,?,?)',(name,title[0],None if i%2 else '📝',stamp,'viewer' if owner else 'different-owner',int(archived),'https://example.invalid/cover'))
        db.execute('INSERT INTO blocks VALUES (?,?,?,?,?,?,?)',('block-'+name,name,'MARKDOWN',title[0],stamp,json.dumps({'payload':'x'*2048}),'<p>'+ 'x'*2048 +'</p>'))
        if direct:db.execute('INSERT INTO page_shares VALUES (?,?,?)',(name,'viewer',direct))
        if collection:
            db.execute('INSERT INTO collection_shares VALUES (?,?,?)',('collection-'+name,'viewer',collection))
            db.execute('INSERT INTO page_collection_memberships VALUES (?,?)',(name,'collection-'+name))
        if name=='other-users-shares':db.execute('INSERT INTO page_shares VALUES (?,?,?)',(name,'someone-else','EDIT'))
        if visible:allowed.append(name)
    db.commit();db.execute('PRAGMA query_only=ON')
    checks=0;traces=[]
    for user in ('viewer','someone-else','unrelated-user'):
      for term in ('needle','%_!','%','_','!','\\','한글','😀',"' OR 1=1 --",'not-found'):
       for limit in (1,5,20,50):
        pattern='%'+term.replace('!','!!').replace('%','!%').replace('_','!_')+'%'
        params=(user,user,user,user,pattern,limit)
        for index in range(2):
            before=[dict(r) for r in db.execute(queries['baseline'][index],params)]
            after=[dict(r) for r in db.execute(queries['current'][index],params)]
            projected=[{key:row[key] for key in (after[0] if after else [])} for row in before]
            assert projected==after,(user,term,limit,index)
            assert len(after)<=limit
            if user=='viewer' and term=='needle' and limit==50:
                actual={row['id'] if index==0 else row['page_id'] for row in after}
                assert actual==set(allowed),(actual,allowed)
            if user=='unrelated-user':assert not after
            if term=="' OR 1=1 --":assert not after
            checks+=1;traces.append(after)
    output={'status':'PASS','engine':'SQLite '+sqlite3.sqlite_version,'authorizationFixtures':len(cases),'queryComparisons':checks,
      'visibleFixturePageIds':allowed,'traceSha256':hashlib.sha256(json.dumps(traces,sort_keys=True).encode()).hexdigest(),
      'limitations':'Exact SELECT/predicates exercised with SQLite fixtures; not a MariaDB integration, collation or isolation-level test.'}
    db.close();print(json.dumps(output,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
