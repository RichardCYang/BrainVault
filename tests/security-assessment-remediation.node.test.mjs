// Isolated production-function regressions. Database transactions below are
// deterministic simulations; these are not a substitute for MariaDB integration tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as network from '../src/lib/network-address.ts';
import { ApiError, notFound } from '../src/lib/http.ts';
import { storageOwnerDirectory } from '../src/lib/storage-owner-path.ts';
import { hasPageDeletionMembershipOutsideCollectionScope } from '../src/lib/page-delete-snapshot.ts';
import { CollaborationMemoryBudget } from '../src/lib/collaboration-memory-budget.ts';
import { assessCollaborationUpgradeAdmission } from '../src/lib/collaboration-resource-limits.ts';
import { WebSocketFragmentBudget } from '../src/lib/websocket.ts';
import { FakeSocket, makeWebSocketModule, clientFrame, settle, makeClock } from './helpers/resource-followup-harness.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const erase = name => stripTypeScriptTypes(read(name).replace(/\r\n/g, '\n')).replace(/^import[\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Production section missing: ${start}`);
  return source.slice(a, b);
}
function factory(source, globals, exports) {
  return new Function(...Object.keys(globals), `${source}\nreturn {${exports.join(',')}};`)(...Object.values(globals));
}
const positions = {32:[4,5,6,7],40:[5,6,7,9],48:[6,7,9,10],56:[7,9,10,11],64:[9,10,11,12],96:[12,13,14,15]};
function translated(length, ipv4, { u = 0, suffix = 0 } = {}) {
  const bytes = Buffer.alloc(16); bytes[0] = 0x2a; bytes[1] = 0; bytes[3] = 0x64;
  ipv4.split('.').map(Number).forEach((byte, i) => { bytes[positions[length][i]] = byte; });
  bytes[8] = u;
  if (length < 96) bytes[15] = suffix;
  return Array.from({length:8}, (_,i) => bytes.readUInt16BE(i*2).toString(16)).join(':');
}
for (const length of [32,40,48,56,64,96]) {
  test(`BV-30: /${length} public/private translation and discovery are classified correctly`, () => {
    const prefix = network.parseNat64Prefix(`2a00:64::/${length}`);
    assert.ok(prefix);
    for (const ip of ['127.0.0.1','10.0.0.7','169.254.169.254','192.168.1.1']) {
      assert.equal(network.isPrivateOrNat64TranslatedAddress(translated(length, ip), [prefix]), true);
    }
    assert.equal(network.isPrivateOrNat64TranslatedAddress(translated(length, '8.8.8.8'), [prefix]), false);
    assert.deepEqual(network.inferNat64PrefixFromIpv4OnlyAddress(translated(length, '192.0.0.170')), prefix);
    if (length < 96) {
      for (const ip of ['127.0.0.1','8.8.8.8']) {
        assert.equal(network.isPrivateOrNat64TranslatedAddress(translated(length, ip, {u:1}), [prefix]), true);
        assert.equal(network.isPrivateOrNat64TranslatedAddress(translated(length, ip, {suffix:1}), [prefix]), true);
      }
      assert.equal(network.inferNat64PrefixFromIpv4OnlyAddress(translated(length,'192.0.0.170',{u:1})), null);
    }
  });
}
test('BV-30: the report /96 example is outside that prefix, not a u-octet bypass', () => {
  const prefix = network.parseNat64Prefix('2a00:64::/96');
  assert.equal(network.isPrivateOrNat64TranslatedAddress('2a00:64::7f00:1',[prefix]), true);
  assert.equal(network.isPrivateOrNat64TranslatedAddress('2a00:64::1:7f00:1',[prefix]), false);
  assert.equal(network.parseNat64Prefix('2a00:64:0:0:100::/96'), null);
});
function bookmarkHarness() {
  const clock = makeClock(); let calls = 0;
  const control = { nat64: [], ipv4: ['8.8.8.8'], interfaces: {} };
  const source = section(erase('src/lib/bookmark.ts'), 'function isDnsNoDataError(', 'async function resolvePublicAddresses(');
  class Resolver {
    cancel() {}
    async resolve4() { calls++; return control.ipv4; }
    async resolve6(host) {
      if (host !== 'ipv4only.arpa') return [];
      if (control.nat64 instanceof Error) throw control.nat64;
      return control.nat64;
    }
  }
  const globals = {
    ...network, ApiError, net, URL,
    dns: {promises:{Resolver}}, os: {networkInterfaces:()=>control.interfaces},
    env: {BOOKMARK_FETCH_NAT64_PREFIXES:[network.parseNat64Prefix('2a00:64::/96')], PUBLIC_ORIGIN:'https://brainvault.example'},
    normalizeBookmarkFetchHostname: value => value.toLowerCase().replace(/^\[|\]$/g,''),
    Date:clock.Date,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout
  };
  return {...factory(source,globals,['resolveNat64Prefixes','resolvePublicOriginAddressKeys','assertBookmarkAddressesAreNotSelfOrigin']),control,clock,get calls(){return calls;}};
}
test('BV-30: configured prefixes do not bypass failed, empty or ambiguous discovery', async () => {
  const h = bookmarkHarness();
  h.control.nat64 = Object.assign(new Error('No data'),{code:'ENODATA'});
  assert.equal(await h.resolveNat64Prefixes(1000),null);
  h.control.nat64 = [];
  assert.equal(await h.resolveNat64Prefixes(1000),null);
  h.control.nat64 = [translated(64,'192.0.0.170'),'2001:4860::8888'];
  assert.equal(await h.resolveNat64Prefixes(1000),null);
  h.control.nat64 = [translated(64,'192.0.0.170')];
  assert.deepEqual((await h.resolveNat64Prefixes(1000)).map(p=>p.prefixLength).sort((a,b)=>a-b),[64,96]);
  h.clock.tick(60001); h.control.nat64 = [];
  assert.equal(await h.resolveNat64Prefixes(62000),null);
});
test('BV-38: origin DNS refreshes after TTL and local interfaces refresh per validation', async () => {
  const h = bookmarkHarness();
  assert.ok((await h.resolvePublicOriginAddressKeys(1000)).has(network.canonicalIpAddressKey('8.8.8.8')));
  h.control.ipv4=['9.9.9.9'];
  await h.resolvePublicOriginAddressKeys(1000); assert.equal(h.calls,1);
  h.clock.tick(60001);
  assert.ok((await h.resolvePublicOriginAddressKeys(62000)).has(network.canonicalIpAddressKey('9.9.9.9')));
  assert.equal(h.calls,2);
  await h.assertBookmarkAddressesAreNotSelfOrigin([{address:'1.1.1.1',family:4}],62000);
  h.control.interfaces={eth0:[{address:'1.1.1.1'}]};
  await assert.rejects(h.assertBookmarkAddressesAreNotSelfOrigin([{address:'1.1.1.1',family:4}],62000),{code:'BOOKMARK_URL_BLOCKED'});
});

const deletionSource=section(erase('src/routes/page.routes.ts'),'function assertPageDeletionAuthorizationScope(', 'function hasPageMoveMembershipOutsideSourceScope(');
const {assertPageDeletionAuthorizationScope: deletionGate}=factory(deletionSource,{ApiError,hasPageDeletionMembershipOutsideCollectionScope},['assertPageDeletionAuthorizationScope']);
test('BV-31: owner can purge collection; ADMIN can purge members but not its collection root',()=>{
  const root={id:'pag_root'}, child={id:'pag_child'};
  const memberships=[{page_id:root.id,collection_id:root.id},{page_id:child.id,collection_id:root.id}];
  const admin={role:'ADMIN',scope:'COLLECTION',collectionId:root.id};
  assert.throws(()=>deletionGate(admin,[root,child],memberships),{code:'COLLECTION_OWNER_REQUIRED'});
  assert.doesNotThrow(()=>deletionGate(admin,[child],memberships));
  assert.doesNotThrow(()=>deletionGate({role:'OWNER',scope:'OWNER',collectionId:root.id},[root,child],memberships));
  assert.throws(()=>deletionGate(admin,[child],[]),{code:'PAGE_EDIT_CONFLICT'});
});
test('BV-31: direct-grant mutation admission denies delegated ADMIN and retains owner generation binding',async()=>{
  let row={owner_id:'usr_owner',attachment_generation:7,collection_id:'pag_root',collection_permission:'ADMIN',collection_share_generation:'share_admin'};
  const source=section(erase('src/routes/collaboration.routes.ts'),'async function capturePageShareAdministrationAdmission(', 'async function assertPageShareAdministrationOwnerWorkspaceGeneration(');
  const {capturePageShareAdministrationAdmission:admit}=factory(source,{db:{queryOne:async()=>row},ApiError,notFound},['capturePageShareAdministrationAdmission']);
  await assert.rejects(admit('pag_child','usr_admin'),{code:'PAGE_OWNER_REQUIRED'});
  assert.equal((await admit('pag_child','usr_owner')).ownerWorkspaceGeneration,7);
  row=null; await assert.rejects(admit('missing','usr_admin'),{code:'NOT_FOUND'});
  const route=read('src/routes/collaboration.routes.ts');
  assert.match(route,/Direct page shares can only be removed by the workspace owner/);
});

function recoveryHarness({ownerId='usr_owner'}={}) {
  let rows=[], sequence=0;
  const client={
    async queryOne(sql,args) {
      if(sql.includes('FROM users'))return {id:args[0]};
      if(sql.includes('FROM page_recovery_grants'))return {owner_id:ownerId};
      if(sql.startsWith('SELECT id'))return rows.find(r=>r.page===args[0]&&r.principal===args[1]&&r.lineage===args[2]&&r.kind===args[3]&&r.hash===args[4])??null;
      if(sql.includes('COUNT(*)')){
        const shared=sql.includes('owner_id <> principal_id');
        const selected=rows.filter(r=>r.principal===(shared?args[4]:args[0])&&(!shared||r.owner!==r.principal));
        const lineage=shared?selected.filter(r=>r.page===args[0]&&r.lineage===args[1]):[];
        return {candidate_count:selected.length,payload_bytes:selected.reduce((n,r)=>n+r.bytes,0),lineage_count:lineage.length,lineage_bytes:lineage.reduce((n,r)=>n+r.bytes,0)};
      }
      throw new Error('Unexpected recovery query: '+sql);
    },
    async execute(sql,a){
      if(sql.includes('INSERT INTO page_recovery_candidates'))rows.push({id:a[0],page:a[1],principal:a[2],owner:a[3],lineage:a[4],kind:a[5],bytes:a[8].length,hash:a[9]});
      else assert.match(sql,/UPDATE page_recovery_grants/);
      return {affectedRows:1};
    }
  };
  const globals={db:client,transaction:fn=>fn(client),ApiError,notFound,createHash,createId:()=>`rcv_${++sequence}`};
  const api=factory(erase('src/lib/recovery-candidates.ts'),globals,['storeRecoveryCandidate']);
  const input=(i,extra={})=>({pageId:'pag_1',principalId:'usr_collaborator',lineageKey:'direct',kind:'DIRECT_DRAFT',sourceId:`draft_${i}`,generation:`local_${i}`,payload:Buffer.from(`untrusted-${i}`),...extra});
  return {...api,input,get rows(){return rows;}};
}
test('BV-32: changing client generations cannot bypass the non-owner lineage quota',async()=>{
  const h=recoveryHarness();
  for(let i=0;i<3;i++)assert.equal((await h.storeRecoveryCandidate(h.input(i))).created,true);
  assert.equal((await h.storeRecoveryCandidate(h.input(0,{generation:'different'}))).created,false);
  await assert.rejects(h.storeRecoveryCandidate(h.input(3)),{code:'RECOVERY_VAULT_QUOTA_EXCEEDED'});
  assert.equal(h.rows.length,3);
});
test('BV-32: non-owner recovery quota is also aggregate across different pages',async()=>{
  const h=recoveryHarness();
  for(let i=0;i<8;i++)await h.storeRecoveryCandidate(h.input(i,{pageId:`pag_${i}`}));
  await assert.rejects(h.storeRecoveryCandidate(h.input(9,{pageId:'pag_9'})),{code:'RECOVERY_VAULT_QUOTA_EXCEEDED'});
});
test('BV-32: owner salvage remains available and invalid kind/lineage pairs fail closed',async()=>{
  const h=recoveryHarness({ownerId:'usr_collaborator'});
  for(let i=0;i<10;i++)await h.storeRecoveryCandidate(h.input(i));
  assert.equal(h.rows.length,10);
  for(const extra of [{kind:'OTHER'},{kind:'YJS_UPDATE'},{lineageKey:'yjs:legacy'},{kind:'YJS_LEGACY_UPDATE'}]) {
    await assert.rejects(h.storeRecoveryCandidate(h.input(11,extra)),{code:'INVALID_RECOVERY_LINEAGE'});
  }
  await h.storeRecoveryCandidate(h.input(12,{kind:'YJS_UPDATE',lineageKey:'yjs:doc_epoch_1'}));
  await h.storeRecoveryCandidate(h.input(13,{kind:'YJS_LEGACY_UPDATE',lineageKey:'yjs:legacy'}));
});

function totpHarness(threshold=3, {enabled=true,reused=false}={}) {
  const state={attempts:0,blocked:false,evaluations:0,reservations:0,commits:0,rollbacks:0,lastStep:reused?42:null,sessions:new Map()};
  let activeClient=null,tail=Promise.resolve();
  const db={queryOne:async()=>state.blocked?{blocked:1}:null};
  const session=id=>state.sessions.get(id)??{token_hash:id,user_id:'usr_owner',source_ip:'8.8.8.8',binding_hash:'binding',failed_attempts:0};
  const client={
    async queryOne(sql,a){
      if(sql.includes('FROM users')){assert.match(sql,/FOR UPDATE/);return {id:'usr_owner',totp_ip_block_enabled:enabled?1:0,totp_ip_block_threshold:threshold};}
      if(sql.includes('mfa_login_sessions')){assert.match(sql,/FOR UPDATE/);return session(a[0]);}
      if(sql.includes('user_totp_credentials'))return {user_id:'usr_owner',last_used_step:state.lastStep};
      if(sql.includes('user_totp_ip_blocks')){assert.match(sql,/FOR UPDATE/);return state.blocked?{blocked:1,failed_attempts:threshold}:null;}
      if(sql.includes('user_totp_ip_failures'))return state.attempts?{failed_attempts:state.attempts}:null;
      throw new Error('Unexpected TOTP query: '+sql);
    },
    async execute(sql,a){
      if(sql.includes('UPDATE mfa_login_sessions')){const row=session(a[0]);state.sessions.set(a[0],{...row,failed_attempts:row.failed_attempts+1});state.reservations++;}
      else if(sql.includes('INSERT INTO user_totp_ip_blocks'))state.blocked=true;
      else if(sql.includes('DELETE FROM user_totp_ip_blocks')){}
      else if(sql.includes('DELETE FROM user_totp_ip_failures'))state.attempts=0;
      else if(sql.includes('INSERT INTO user_totp_ip_failures'))state.attempts=a[2];
      else if(sql.includes('UPDATE user_totp_credentials'))state.lastStep=a[0];
      else throw new Error('Unexpected TOTP mutation: '+sql);
      return {affectedRows:1};
    }
  };
  const transaction=fn=>{
    const result=tail.then(async()=>{
      const backup={...state,sessions:new Map(state.sessions)};activeClient=client;
      try{const value=await fn(client);state.commits++;return value;}
      catch(e){const rollbacks=state.rollbacks+1;Object.assign(state,backup,{rollbacks});throw e;}
      finally{activeClient=null;}
    });tail=result.catch(()=>{});return result;
  };
  const globals={db,transaction,ApiError,net,recordCountryLoginBlockStrict:async(...a)=>assert.equal(a.at(-1),client)};
  const ip=factory(erase('src/lib/totp-ip-block.ts'),globals,['isPermanentlyBlockedTotpIp','recordTotpIpFailure','clearTotpIpFailures']);
  const code=erase('src/routes/mfa.routes.ts');
  const functions=section(code,'async function reserveMfaAttempt(', 'async function recordReservedMfaFailure(')
    +section(code,'async function getLoginUserForUpdate(', 'function createMfaLoginResult(');
  let handler;
  const route=section(code,'mfaRouter.post(\n  "/login/totp",','mfaRouter.post(\n  "/login/passkey/options",');
  const noop=()=>{};
  factory(functions+route,{
    ...globals,...ip,
    mfaRouter:{post:(_p,...handlers)=>{handler=handlers.at(-1);}},
    requireSameOriginBrowserRequest:noop,requireJsonRequestBody:noop,mfaLoginIpRateLimit:noop,mfaLoginAccountRateLimit:noop,
    mfaLoginTokenRateLimit:noop,requireActiveMfaLoginSession:noop,
    validate:noop,mfaLoginTotpSchema:{},maxMfaAttempts:8,hashOpaqueToken:v=>v,
    getClientIpAddress:()=> '8.8.8.8',requireMfaCeremonyBinding:()=> 'binding',
    getActiveMfaSession:async token=>session(token),enforceMfaLoginNetworkAccess:async()=>{},
    recordLoginAttempt:async(...a)=>assert.equal(a[3],activeClient),
    decryptMfaSecret:()=> 'test-secret',findMatchingTotpStep:(_s,value)=>{state.evaluations++;return value==='valid'?42:null;},
    completeMfaSession:async()=>{},createMfaLoginResult:()=>({token:'token',user:{id:'usr_owner'}}),
    clearMfaCeremonyBinding:noop,setAuthSessionCookie:noop
  },[]);
  const invoke=async(token,code='invalid')=>{
    let error,body;await handler({body:{mfaToken:token,code}},{locals:{mfaLoginSession:session(token)},json:value=>{body=value;}},e=>{error=e;});return {error,body};
  };
  return {state,invoke};
}
for(const threshold of [1,3,8])test(`BV-33: ${threshold}-failure block is committed before parallel sessions evaluate more codes`,async()=>{
  const h=totpHarness(threshold);
  const results=await Promise.all(Array.from({length:16},(_,i)=>h.invoke(`token_${i}`)));
  assert.equal(h.state.evaluations,threshold);
  assert.equal(h.state.reservations,threshold);
  assert.equal(h.state.blocked,true);
  assert.equal(h.state.commits,threshold);
  assert.ok(results.every(r=>['INVALID_MFA_CODE','TOTP_IP_PERMANENTLY_BLOCKED'].includes(r.error?.code)));
});
test('BV-33: invalid-code failures persist, TOTP success clears the counter, reused codes remain blocked',async()=>{
  const h=totpHarness(3);
  assert.equal((await h.invoke('one')).error.code,'INVALID_MFA_CODE');
  assert.equal(h.state.attempts,1);
  assert.equal((await h.invoke('two','valid')).error,undefined);
  assert.equal(h.state.attempts,0);
  assert.equal(h.state.lastStep,42);
  assert.equal((await h.invoke('three','valid')).error.code,'MFA_CODE_REUSED');
});
test('BV-33: disabling IP policy does not bypass the eight-attempt session cap',async()=>{
  const h=totpHarness(3,{enabled:false});
  await Promise.all(Array.from({length:16},()=>h.invoke('same-session')));
  assert.equal(h.state.evaluations,8);assert.equal(h.state.reservations,8);assert.equal(h.state.blocked,false);
});

function authHarness() {
  const users=new Map(),registered=new Map();let handler,seq=0;
  const source=erase('src/routes/auth.routes.ts'),noop=()=>{};
  const db={execute:async(sql,a)=>{
    assert.match(sql,/registration_approved/);assert.match(sql,/\?, 0\)/);
    if(!users.has(a[1]))users.set(a[1],{id:a[0],username:a[1],password_hash:a[4],registration_approved:0});
    return {affectedRows:1};
  },queryOne:async(_sql,a)=>users.get(a[0])??null};
  const globals={
    ApiError,env:{REGISTRATION_ENABLED:true},authRouter:{post:(p,...a)=>registered.set(p,a.at(-1))},db,
    transaction:fn=>fn(db),createId:()=>`usr_${++seq}`,hashPassword:async p=>`hash:${p}`,
    verifyPassword:async(p,h)=>h===`hash:${p}`,dummyPasswordHash:Promise.resolve('dummy'),syntheticLoginUserId:'synthetic',
    evaluatePasswordLogin:async(_c,_id,match)=>match?'ALLOWED':'DENIED',recordLoginAttempt:async()=>{},
    requireSameOriginBrowserRequest:noop,requireJsonRequestBody:noop,registrationRateLimit:noop,registrationGlobalRateLimit:noop,
    loginIpRateLimit:noop,loginAccountRateLimit:noop,validate:noop,registerSchema:{},loginSchema:{},
    padRegistrationResponse:async()=>{},padLoginResponse:async()=>{},getClientIpAddress:()=> '8.8.8.8',getClientTimeZone:noop,getClientWebRtcSignal:noop,
    enforceCountryLoginPolicy:async()=>{},enforceVpnAccessPolicy:async()=>{},isPreAuthLoginPolicyDenial:()=>false,
    getMfaMethods:async()=>({totp:false,passkey:false}),normalizeAuthVersion:()=>1,
    clearMfaCeremonyBinding:noop,setAuthSessionCookie:noop,signAuthToken:()=> 'token',toPublicUser:u=>({id:u.id})
  };
  factory(section(source,'authRouter.post(\n  "/register",','authRouter.post("/logout",'),globals,[]);
  const invoke=async(route,body)=>{
    const result={status:200,error:null,body:null};const res={status:n=>{result.status=n;return res;},json:b=>{result.body=b;},setHeader:noop};
    await registered.get(route)({body},res,e=>{result.error=e;result.status=e.statusCode;});return result;
  };
  return {users,invoke};
}
test('BV-34: registering a free or taken name yields the same response and neither probe password logs in',async()=>{
  const h=authHarness();h.users.set('taken',{id:'usr_existing',username:'taken',password_hash:'hash:owner-password',registration_approved:1});
  const free=await h.invoke('/register',{username:'free',password:'probe'});
  const taken=await h.invoke('/register',{username:'taken',password:'probe'});
  assert.equal(free.error,null);assert.deepEqual(free,taken);assert.equal(free.status,202);
  for(const username of ['free','taken','missing'])assert.equal((await h.invoke('/login',{username,password:'probe'})).error.code,'INVALID_CREDENTIALS');
  assert.equal(h.users.get('taken').password_hash,'hash:owner-password');
  assert.equal((await h.invoke('/login',{username:'taken',password:'owner-password'})).status,200);
  h.users.get('free').registration_approved=1;
  assert.equal((await h.invoke('/login',{username:'free',password:'probe'})).status,200);
  assert.match(read('migrations/080_registration_approval.sql'),/NOT NULL DEFAULT 1/);
});

for(const value of ['..','../other','a/../b','a\\..\\b','/tmp/root','C:\\root','usr:ads','usr x','', 'x'.repeat(65)]) {
  test(`BV-36: unsafe storage owner segment ${JSON.stringify(value)} is rejected`,()=>{
    assert.throws(()=>storageOwnerDirectory('/tmp/root',value),{code:'INVALID_STORAGE_OWNER'});
  });
}
test('BV-36: all four transfer boundaries use the validating owner-directory helper',()=>{
  assert.equal(storageOwnerDirectory('/tmp/root','usr_valid-123'),path.resolve('/tmp/root/usr_valid-123'));
  const source=read('src/lib/data-transfer.ts');
  assert.equal((source.match(/storageOwnerDirectory\((?:attachmentUploadRoot|customIconUploadRoot), userId\)/g)??[]).length,4);
  assert.doesNotMatch(source,/path\.join\((?:attachmentUploadRoot|customIconUploadRoot), userId\)/);
});

function wsSetup({readBudget=new WebSocketFragmentBudget(),messageBudget=new WebSocketFragmentBudget(),limit=1024*1024}={}) {
  const module=makeWebSocketModule(),socket=new FakeSocket();
  const connection=new module.WebSocketConnection(socket,limit,new WebSocketFragmentBudget(),readBudget,messageBudget);
  connection.start();return {...module,socket,connection,readBudget,messageBudget};
}
const wsCloseCode=s=>s.writes.find(b=>(b[0]&15)===8)?.readUInt16BE(2);
test('BV-35: one-byte and nonfragmented partial frames expire despite progress',()=>{
  for(const length of [1,100]){
    const h=wsSetup();const frame=clientFrame(2,Buffer.alloc(4096));
    h.socket.emit('data',frame.subarray(0,length));h.clock.tick(10000);
    h.socket.emit('data',frame.subarray(length,length+1));h.clock.tick(5000);
    assert.equal(wsCloseCode(h.socket),1008);assert.equal(h.readBudget.retainedBytes,0);h.connection.terminate();
  }
});
test('BV-35: shared read capacity is admitted before allocation and released on close',()=>{
  const budget=new WebSocketFragmentBudget(65536);const a=wsSetup({readBudget:budget}),b=wsSetup({readBudget:budget});
  a.socket.emit('data',Buffer.from([0x82]));assert.equal(budget.retainedBytes,65536);
  b.socket.emit('data',Buffer.from([0x82]));assert.equal(wsCloseCode(b.socket),1008);
  a.connection.terminate();b.connection.terminate();assert.equal(budget.retainedBytes,0);
});
test('BV-35: queued and active messages retain aggregate reservations until handlers settle',async()=>{
  const budget=new WebSocketFragmentBudget(12),a=wsSetup({messageBudget:budget}),b=wsSetup({messageBudget:budget});
  let finish;const pending=new Promise(resolve=>{finish=resolve;});a.connection.onMessage(()=>pending);
  a.socket.emit('data',clientFrame(2,Buffer.alloc(8)));
  b.socket.emit('data',clientFrame(2,Buffer.alloc(8)));
  assert.equal(wsCloseCode(b.socket),1008);assert.equal(budget.retainedBytes,8);
  a.connection.terminate();assert.equal(budget.retainedBytes,8);
  finish();await settle();assert.equal(budget.retainedBytes,0);b.connection.terminate();
});
test('BV-35: room reservations share a hard ceiling, shrink safely, and release idempotently',()=>{
  const b=new CollaborationMemoryBudget(100),a=b.reserve(60),c=b.reserve(40);
  assert.equal(b.reserve(1),null);a.shrinkTo(20);assert.equal(b.reservedBytes,60);
  assert.ok(b.reserve(40));assert.throws(()=>a.shrinkTo(21),RangeError);
  a.release();a.release();c.release();assert.equal(b.reservedBytes,40);
  assert.equal(b.reserve(-1),null);assert.equal(b.reserve(NaN),null);
});
test('BV-35: pending upgrade slots also have a per-IP ceiling',()=>{
  assert.deepEqual(assessCollaborationUpgradeAdmission({pendingUpgrades:8,pendingUserUpgrades:0,pendingIpUpgrades:8}),{accepted:false,reason:'ip-upgrades'});
  assert.deepEqual(assessCollaborationUpgradeAdmission({pendingUpgrades:8,pendingUserUpgrades:0,pendingIpUpgrades:7}),{accepted:true});
});
test('BV-35: actual room lifecycle retains reservations until a failed in-flight load settles',async()=>{
  const source=section(erase('src/lib/collaboration-server.ts'),'class PageCollaborationHub {','function attachPageCollaborationServer(');
  const budget=new CollaborationMemoryBudget(100);let rejectLoad;
  const loading=new Promise((_resolve,reject)=>{rejectLoad=reject;});
  const timer=()=>({unref(){}});
  const {PageCollaborationHub}=factory(source,{
    sharedRoomMemoryBudget:budget,residentRoomReservationBytes:20,loadingRoomReservationBytes:80,
    CollaborationValidationPool:class{async close(){}},activeHubs:new Set(),
    heartbeatIntervalMs:1000,accessRecheckIntervalMs:1000,setInterval:timer,clearInterval(){},
    setTimeout:timer,clearTimeout(){},ApiError,transaction:()=>loading,
    console:{error(){}},Buffer
  },['PageCollaborationHub']);
  const hub=new PageCollaborationHub(new EventEmitter());
  const room=hub.getOrCreateRoom('pag_1','doc_1');assert.equal(budget.reservedBytes,80);
  assert.throws(()=>hub.getOrCreateRoom('pag_2','doc_2'),{code:'COLLABORATION_MEMORY_LIMIT'});
  hub.disconnectPage('pag_1');assert.equal(budget.reservedBytes,80);
  rejectLoad(new Error('Simulated database failure'));await room.loadPromise;await settle();
  assert.equal(budget.reservedBytes,0);await hub.close();assert.equal(budget.reservedBytes,0);
});
