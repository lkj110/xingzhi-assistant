const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const policy=require('../desktop/access-policy-store.cjs'),ledger=require('../desktop/operation-ledger.cjs'),platform=require('../desktop/data-platform.cjs');
const authorization={trusted:true,actor:'user_command',command:'fixtureExplicitPlatformScope'};
async function fixture(t,{bound=true}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-platform-permission-')));
 const a=new Assistant({dir,chat:async()=>{throw Error('Unexpected model request');},connectorRequest:async()=>{throw Error('Unexpected connector request');}});
 t.after(async()=>{a.stop();await a.runPromise;fs.rmSync(dir,{recursive:true,force:true});});
 require('./helpers/platform-fixture.cjs').install(a,{username:'alice'});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 const job=agent.buildJob(a,{goal:'Inspect fixture SG metadata',dataPlatform:'sg-readonly'});a.data.delegations.push(job);
 if(bound){job.platformPrincipal='alice';policy.syncTrustedJob(a,job,authorization);}
 return {a,job,dir};
}
function remote(job,subject='alice'){return {principalScope:{kind:'account',provider:'platform',subject},resourceScope:{kind:'platform',key:'sg-readonly',jobId:job.id},operations:['platform_query']};}
const q={op:'task',taskId:42};
test('Platform bootstrap binds a fresh explicit scope before its first metadata read',async t=>{
 const {a,job}=await fixture(t,{bound:false});let requests=0;
 assert.equal(job.platformPrincipal,undefined);
 a.platformRequest=async()=>{requests++;assert.equal(job.platformPrincipal,'alice');assert.equal(policy.check(a,{...remote(job),operation:'platform_query'}).allowed,true);return {owner:'alice'};};
 const batch=await ledger.prepareBatch(a,job),r=await ledger.fetch(a,job,q,{batch});
 assert.equal(r.snapshot.data.owner,'alice');assert.equal(requests,1);assert.equal(a.platformFixture.identityCalls,1);
 assert.equal(policy.check(a,{...remote(job,'bob'),operation:'platform_query'}).allowed,false);
});
test('The Agent authenticates a new platform scope once before a multi-query batch',async t=>{
 const {a,job}=await fixture(t,{bound:false});let calls=0;a.platformRequest=async()=>{calls++;return {owner:'alice'};};
 const result=await agent.act(a,job,'platform_query',{queries:[q,{op:'task',taskId:43}]});
 assert.equal(result.results.length,2);assert.ok(result.results.every(r=>r.sourceId));assert.equal(calls,2);assert.equal(a.platformFixture.identityCalls,1);
});
test('Every batch checks the account before reusing cached data',async t=>{
 const {a,job}=await fixture(t);let requests=0;a.platformRequest=async()=>{requests++;return {owner:'alice'};};
 const first=await ledger.fetch(a,job,q),s=agent.source(a,job,'fixture-platform','Fixture',JSON.stringify(first.snapshot),{platformSnapshot:true,platformPrincipal:'alice'});ledger.finish(a,job,first.operation,s.id);
 const second=await ledger.fetch(a,job,q);assert.equal(second.reused,true);assert.equal(requests,1);assert.equal(a.platformFixture.identityCalls,2);
 a.platformFixture.identity={username:'bob'};
 await assert.rejects(ledger.fetch(a,job,q),/账号|身份|授权/);assert.equal(requests,1);assert.equal(job.platformPrincipal,'alice');assert.equal(policy.check(a,{...remote(job,'bob'),operation:'platform_query'}).allowed,false);
});
test('Revocation before the identity preflight sends no CLI request',async t=>{
 const {a,job}=await fixture(t);policy.revoke(a,remote(job),authorization);let calls=0;a.platformRequest=async()=>{calls++;return {};};
 await assert.rejects(ledger.fetch(a,job,q));assert.equal(calls,0);assert.equal(a.platformFixture.identityCalls,0);
});
test('Identity binding and revalidation use the exact verified tenant',async t=>{
 const {a,job}=await fixture(t,{bound:false});a.platformFixture.identity={username:'alice',tenantId:'tenant-a'};await ledger.prepareBatch(a,job);
 assert.deepEqual(job.platformPrincipal,{username:'alice',tenantId:'tenant-a'});a.platformFixture.identity={username:'alice',tenantId:'tenant-b'};
 await assert.rejects(ledger.prepareBatch(a,job),/账号|租户|授权/);assert.deepEqual(job.platformPrincipal,{username:'alice',tenantId:'tenant-a'});
});
test('An unrelated permission change does not invalidate current account verification',async t=>{
 const {a,job}=await fixture(t);Object.defineProperty(a,'platformRequest',{value:async()=>{
  policy.grant(a,{principalScope:policy.PUBLIC,resourceScope:{kind:'web',key:'public',jobId:'another-job'},operations:['read_url']},authorization);return {username:'alice'};
 }});
 await ledger.prepareBatch(a,job);assert.equal(job.platformPrincipal,'alice');
});
test('A missing authority cannot be recovered from old platform fields or a cached account',async t=>{
 const {a,job}=await fixture(t);a.save();fs.unlinkSync(policy.locations(a).store);let calls=0;a.platformRequest=async()=>{calls++;return {};};
 job.dataPlatform='sg-readonly';job.platformPrincipal='alice';await assert.rejects(ledger.fetch(a,job,q));assert.equal(calls,0);assert.equal(a.platformFixture.identityCalls,0);
});
test('Restoring old workspace scope cannot revive a revoked account grant',async t=>{
 const {a,job}=await fixture(t);const old=structuredClone(job);policy.revoke(a,remote(job),authorization);
 Object.assign(job,old);let requests=0;a.platformRequest=async()=>{requests++;return {owner:'alice'};};
 await assert.rejects(ledger.fetch(a,job,q));assert.equal(requests,0);assert.equal(a.platformFixture.identityCalls,0);assert.equal(policy.check(a,{...remote(job),operation:'platform_query'}).allowed,false);
});
test('Revocation during upstream project resolution prevents its second child request',async t=>{
 const {a,job}=await fixture(t);const calls=[];
 a.platformRequest=async args=>{calls.push(args);policy.revoke(a,remote(job),authorization);return {projectId:7,owner:'alice'};};
 await assert.rejects(ledger.fetch(a,job,{op:'upstream',taskId:42}),e=>e.code==='OPERATION_STALE');
 assert.equal(calls.length,1);assert.ok(calls[0].includes('get'));assert.equal(a.data.sources.length,0);
 const op=Object.values(ledger.state(job).operations)[0];assert.equal(op.presentationStatus,'historical');assert.equal(op.observations[0].data.projectId,7);
});
for(const change of ['principal','scope','revision','workRevision','pause','abort','regrant'])test(`A late response after ${change} changes is historical`,async t=>{
 const {a,job}=await fixture(t);a.platformRequest=async()=>{
  if(change==='principal')job.platformPrincipal='bob';
  if(change==='scope')job.dataPlatform='off';
  if(change==='revision')ledger.state(job).permissionRevision++;
  if(change==='workRevision')job.workRevision++;
  if(change==='pause')job.status='paused';
  if(change==='abort'){a.controller ||= new AbortController();a.controller.abort(Error('fixture cancellation'));}
  if(change==='regrant'){policy.revoke(a,remote(job),authorization);policy.grant(a,remote(job),authorization);}
  return {owner:'alice',secret:'MUST_NOT_PERSIST'};
 };
 await assert.rejects(ledger.fetch(a,job,q),e=>e.code==='OPERATION_STALE');
 const op=Object.values(ledger.state(job).operations)[0];assert.equal(op.status,'superseded');assert.equal(op.presentationStatus,'historical');assert.equal(op.principal,'alice');assert.equal(op.observations[0].data.owner,'alice');assert.equal(a.data.sources.length,0);assert.doesNotMatch(JSON.stringify(op),/MUST_NOT_PERSIST/);
});
test('A late rejected request after scope change cannot become a current cached failure',async t=>{
 const {a,job}=await fixture(t);a.platformRequest=async()=>{job.dataPlatform='off';throw Error('fixture timeout');};
 await assert.rejects(ledger.fetch(a,job,q),e=>e.code==='OPERATION_STALE');const op=Object.values(ledger.state(job).operations)[0];assert.equal(op.presentationStatus,'historical');assert.equal(op.errorCode,undefined);
});
for(const removed of [false,true])test(`Late platform facts survive a ${removed?'removed':'replaced'} workspace job without resurrecting it`,async t=>{
 const {a,job}=await fixture(t);a.platformRequest=async()=>{
  a.data.delegations=removed?[]:[{...structuredClone(job),executionState:undefined}];return {owner:'alice',body:'LATE_RESTORE_BODY'};
 };
 await assert.rejects(ledger.fetch(a,job,q),e=>e.code==='OPERATION_STALE');
 const saved=JSON.parse(fs.readFileSync(a.file,'utf8'));
 const historical=removed?saved.runtime.platformOperationHistory:saved.delegations[0].executionState.history;
 assert.equal(historical[0].presentationStatus,'historical');assert.equal(saved.delegations.length,removed?0:1);assert.equal(saved.sources.length,0);
 if(removed)assert.doesNotMatch(JSON.stringify(historical),/LATE_RESTORE_BODY/);else assert.equal(historical[0].observations[0].data.body,'LATE_RESTORE_BODY');
});
test('Late response bodies are omitted when local retention was revoked',async t=>{
 const {a,job}=await fixture(t);a.platformRequest=async()=>{
  policy.revoke(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',jobId:job.id},operations:['local_retention']},authorization);
  policy.revoke(a,remote(job),authorization);return {sql:'WITHDRAWN_BODY'};
 };
 await assert.rejects(ledger.fetch(a,job,q),e=>e.code==='OPERATION_STALE');
 const op=Object.values(ledger.state(job).operations)[0];assert.equal(op.observations[0].bodyOmitted,true);assert.match(op.observations[0].contentHash,/^[a-f0-9]{64}$/);assert.doesNotMatch(fs.readFileSync(a.file,'utf8'),/WITHDRAWN_BODY/);
});
test('A batch cannot authorize another request after its captured scope changes',async t=>{
 const {a,job}=await fixture(t);const batch=await ledger.prepareBatch(a,job);let calls=0;a.platformRequest=async()=>{calls++;return {};};job.platformPrincipal='bob';
 await assert.rejects(ledger.fetch(a,job,q,{batch}),e=>e.code==='OPERATION_STALE');assert.equal(calls,0);
});
test('An identity response cannot bind after the user withdraws the pending scope',async t=>{
 const {a,job}=await fixture(t,{bound:false});let calls=0;
 // Replace the test transport completely to exercise the in-flight auth race.
 Object.defineProperty(a,'platformRequest',{value:async()=>{calls++;const before=structuredClone(job);job.dataPlatform='off';policy.syncTrustedJob(a,job,{...authorization,before});return {username:'alice'};}});
 await assert.rejects(ledger.prepareBatch(a,job));assert.equal(calls,1);assert.equal(policy.check(a,{...remote(job),operation:'platform_query'}).allowed,false);
});
test('An old unbound workspace cannot create a bootstrap intent on migration',async t=>{
 const {a,job}=await fixture(t,{bound:false});
 // A distinct temporary workspace simulates first migration, not a lost store.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-platform-legacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const legacy={...a,dir,file:path.join(dir,'workspace.json'),data:structuredClone(a.data)};delete legacy.data.runtime;
 fs.writeFileSync(legacy.file,JSON.stringify(legacy.data));policy.initialize(legacy);policy.reconcile(legacy);
 const old=legacy.data.delegations.find(j=>j.id===job.id);old.dataPlatform='sg-readonly';let calls=0;legacy.platformRequest=async()=>{calls++;return {username:'alice'};};
 assert.throws(()=>policy.beginPlatformIdentity(legacy,old));assert.equal(calls,0);
});
test('Direct adapter checks scope again between dependent child calls',async()=>{
 const job={dataPlatform:'sg-readonly',platformPrincipal:'alice'},calls=[];
 await assert.rejects(platform.query(job,{op:'upstream',taskId:42},{request:async args=>{calls.push(args);job.dataPlatform='off';return {projectId:7};}}),e=>e.code==='OPERATION_STALE');assert.equal(calls.length,1);
});
