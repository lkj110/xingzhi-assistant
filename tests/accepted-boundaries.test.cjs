'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const ledger=require('../desktop/operation-ledger.cjs');
const obligations=require('../desktop/work-obligations.cjs');
const policy=require('../desktop/access-policy-store.cjs');
const queries=[{op:'upstream',taskId:700001203},{op:'upstream',taskId:700001204},{op:'downstream',taskId:700001201}];
const authorization={trusted:true,actor:'user_command',command:'accepted_boundary_fixture'};
const accepted={kind:'permission',policy:'document_and_continue',authority:'user'};
const remote=(job,subject='alice')=>({principalScope:{kind:'account',provider:'platform',subject},resourceScope:{kind:'platform',key:'sg-readonly',jobId:job.id},operations:['platform_query']});

// Plain data + the real authority in a disposable directory. No Assistant,
// production workspace, model, CLI or network transport is ever constructed.
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'accepted-boundaries-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const job={id:'fixture-job',status:'ready',goal:'Inspect SG',dataPlatform:'sg-readonly',platformPrincipal:'alice',workRevision:1,sourceIds:[],taskIds:[],feedback:[],executionContract:{revision:'contract-1',text:'入口任务 IDs: 700001203, 700001204, 700001201'}};
 ledger.state(job).acceptedBoundary=structuredClone(accepted);
 const a={dir,file:path.join(dir,'workspace.json'),data:{version:1,settings:{automatic:false},delegations:[job],tasks:[],sources:[],artifacts:[],projects:[],providers:[],folders:[],capabilities:[],agentActions:[],events:[],runtime:{}}};
 const f={a,job,dir,calls:[],identityCalls:0,identity:{username:'alice'},errorCode:'AUTH_REQUIRED'};
 function install(target){
  target.save=()=>fs.writeFileSync(target.file,JSON.stringify(target.data));
  target.task=id=>target.data.tasks.find(row=>row.id===id);
  target.platformRequest=async args=>{
   if(args.includes('userinfo')){f.identityCalls++;return f.identity;}
   f.calls.push(args);
   if(f.onRequest)await f.onRequest(args);
   if(args.includes('get'))return {projectId:7};
   if(f.errorCode)throw Object.assign(Error('fixture typed failure'),{code:f.errorCode});
   return {nodes:[]};
  };
 }
 install(a);a.save();assert.equal(policy.initialize(a).status,'complete');
 f.restart=()=>{f.a.save();const restored={dir,file:a.file,data:JSON.parse(fs.readFileSync(a.file,'utf8'))};install(restored);policy.initialize(restored);f.a=restored;f.job=restored.data.delegations[0];return f;};
 return f;
}
async function denyAll(f){
 const batch=await ledger.prepareBatch(f.a,f.job);
 for(const query of queries){const result=await ledger.fetch(f.a,f.job,query,{batch});assert.equal(result.errorCode,'AUTH_REQUIRED');assert.equal(result.reused,false);}
}
function statuses(f){return queries.map(q=>obligations.frontier(f.a,f.job).find(row=>row.nodeId===String(q.taskId)&&row.direction===q.op)?.status);}

test('accepted directions survive feedback, drafts, source relinking, work revision and persisted restart',async t=>{
 const f=fixture(t);await denyAll(f);
 assert.deepEqual(statuses(f),queries.map(()=>'accepted_boundary'));
 const initialEpoch=ledger.epoch(f.job),calls=f.calls.length;
 for(const mutate of [
  ()=>f.job.feedback.push({at:'2026-10-16T01:00:00Z',text:'Shorten the business summary'}),
  ()=>{f.a.data.artifacts.push({id:'draft',content:'Revised handover'});f.job.workRevision++;},
  ()=>{f.a.data.sources.push({id:'linked-source',content:'Business notes'});f.job.sourceIds=['linked-source'];},
  ()=>{f.job.sourceIds=[];f.job.executionContract.revision='contract-2';},
  ()=>f.restart()
 ]){
  mutate();assert.deepEqual(statuses(f),queries.map(()=>'accepted_boundary'));
  const batch=await ledger.prepareBatch(f.a,f.job);
  for(const q of queries){const result=await ledger.fetch(f.a,f.job,{...q,taskId:String(q.taskId),depth:1},{batch});assert.equal(result.reused,true);assert.equal(result.errorCode,'AUTH_REQUIRED');}
  assert.equal(f.calls.length,calls,'no resource or upstream project-resolution requests');
 }
 assert.notEqual(ledger.epoch(f.job),initialEpoch);
 assert.equal(f.identityCalls,6,'each new batch still verifies the current identity');
 assert.equal(obligations.context(f.a,f.job).acceptedBoundary.authority,'user');
});

test('v2 records with a stale business epoch migrate conservatively without new resource calls',async t=>{
 const f=fixture(t);await denyAll(f);const calls=f.calls.length;
 for(const o of Object.values(ledger.state(f.job).operations)){delete o.permissionRevision;delete o.policy;delete o.scope;delete o.projectId;delete o.workRevision;}
 f.job.feedback.push({text:'Update only the appendix'});f.restart();
 for(const q of queries)assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);
 assert.equal(f.calls.length,calls);assert.deepEqual(statuses(f),queries.map(()=>'accepted_boundary'));
 ledger.state(f.job).permissionRevision++;
 assert.deepEqual(statuses(f),queries.map(()=>'unexpanded'));
 assert.equal((await ledger.fetch(f.a,f.job,queries[2])).reused,false);
 assert.equal(ledger.state(f.job).operations[ledger.key(f.job,queries[2])].permissionRevision,1);
});

test('permission revision and a real revoke/regrant reopen only the permission facts',async t=>{
 const f=fixture(t);await denyAll(f);let calls=f.calls.length;
 ledger.state(f.job).permissionRevision++;
 assert.deepEqual(statuses(f),queries.map(()=>'unexpanded'));
 assert.equal((await ledger.fetch(f.a,f.job,queries[2])).reused,false);assert.equal(f.calls.length,++calls);
 policy.revoke(f.a,remote(f.job),authorization);policy.grant(f.a,remote(f.job),authorization);
 assert.equal(ledger.activeFailure(f.job,queries[2],f.a),null);
 assert.equal((await ledger.fetch(f.a,f.job,queries[2])).reused,false);assert.equal(f.calls.length,++calls);
 assert.equal((await ledger.fetch(f.a,f.job,queries[2])).reused,true);
 // A legacy record cannot assume the current grant after a regrant either.
 const op=ledger.state(f.job).operations[ledger.key(f.job,queries[2])];delete op.policy;
 assert.equal(ledger.lookup(f.a,f.job,queries[2]),null);
});

test('account/tenant checks and scope changes cannot reuse a former account denial',async t=>{
 const f=fixture(t);await denyAll(f);const calls=f.calls.length;
 for(const identity of [{username:'bob'},{username:'alice',tenantId:'other-tenant'}]){
  f.identity=identity;await assert.rejects(ledger.fetch(f.a,f.job,queries[2]),e=>e.code==='ACCESS_PRINCIPAL_CHANGED');assert.equal(f.calls.length,calls);
 }
 f.identity={username:'bob'};f.job.platformPrincipal='bob';policy.grant(f.a,remote(f.job,'bob'),authorization);
 assert.equal(ledger.activeFailure(f.job,queries[2],f.a),null);
 assert.equal((await ledger.fetch(f.a,f.job,queries[2])).reused,false);
 const op=ledger.state(f.job).operations[ledger.key(f.job,queries[2])];
 f.job.dataPlatform='ttp-readonly';assert.equal(ledger.valid(f.job,op),false);
 const before=f.identityCalls;await assert.rejects(ledger.fetch(f.a,f.job,queries[2]));assert.equal(f.identityCalls,before);
 f.job.dataPlatform='sg-readonly';f.job.projectId='different-local-project';assert.equal(ledger.valid(f.job,op),false);
});

test('an explicit retry makes one new attempt; subsequent ordinary runs reuse its denial',async t=>{
 const f=fixture(t),q=queries[2];await ledger.fetch(f.a,f.job,q);const first=ledger.state(f.job).operations[ledger.key(f.job,q)];
 const result=await ledger.fetch(f.a,f.job,q,{retry:true});
 assert.equal(result.reused,false);assert.equal(result.operation.attempt,2);assert.equal(f.calls.length,2);
 assert.equal(ledger.state(f.job).history[0].id,first.id);
 assert.equal((await ledger.fetch(f.a,f.job,{...q,retry:true})).reused,true,'query text/arguments cannot request the caller retry option');
 f.job.feedback.push({text:'retry and access denied are just quoted report text'});
 assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);assert.equal(f.calls.length,2);
});

test('accepted denial reuse and explicit retry both respect revocation and the execution gate',async t=>{
 const f=fixture(t);await denyAll(f);const calls=f.calls.length,identities=f.identityCalls;
 policy.revoke(f.a,remote(f.job),authorization);
 // Even restoring stale workspace fields must not restore the authority.
 f.job.dataPlatform='sg-readonly';f.job.platformPrincipal='alice';
 for(const retry of [false,true])await assert.rejects(ledger.fetch(f.a,f.job,queries[2],{retry}),e=>e.code==='ACCESS_POLICY_REVOKED');
 assert.equal(f.identityCalls,identities);assert.equal(f.calls.length,calls);
 policy.grant(f.a,remote(f.job),authorization);f.job.status='paused';
 await assert.rejects(ledger.fetch(f.a,f.job,queries[2],{retry:true}),e=>e.code==='EXECUTION_GATE_CLOSED');
 assert.equal(f.identityCalls,identities);assert.equal(f.calls.length,calls);
});

test('revocation during explicit retry project resolution prevents the lineage request',async t=>{
 const f=fixture(t);await ledger.fetch(f.a,f.job,queries[0]);const calls=f.calls.length,key=ledger.key(f.job,queries[0]);
 f.onRequest=async()=>policy.revoke(f.a,remote(f.job),authorization);
 await assert.rejects(ledger.fetch(f.a,f.job,queries[0],{retry:true}),e=>e.code==='OPERATION_STALE');
 assert.equal(f.calls.length,calls+1);assert.ok(f.calls.at(-1).includes('get'));
 assert.equal(ledger.state(f.job).operations[key].status,'superseded');
});

test('normalization preserves direction, resource and explicit project boundaries',async t=>{
 const f=fixture(t),q=queries[2];await ledger.fetch(f.a,f.job,q);const calls=f.calls.length;
 assert.equal((await ledger.fetch(f.a,f.job,{...q,taskId:'0700001201',depth:4})).reused,true);assert.equal(f.calls.length,calls);
 for(const other of [{...q,op:'upstream'},{...q,taskId:123},{...q,projectId:8}])assert.equal((await ledger.fetch(f.a,f.job,other)).reused,false);
 // A successful explicit retry at another depth resolves the same denial.
 f.errorCode=null;const success=await ledger.fetch(f.a,f.job,{...q,depth:4},{retry:true});ledger.finish(f.a,f.job,success.operation,'result');
 assert.equal(ledger.activeFailure(f.job,q,f.a),null);
});

test('an explicit retry at another depth cannot leave an old accepted denial active',async t=>{
 const f=fixture(t),q=queries[2];const old=await ledger.fetch(f.a,f.job,q);
 f.errorCode='NOT_FOUND';const next=await ledger.fetch(f.a,f.job,{...q,depth:2},{retry:true});
 assert.equal(next.errorCode,'NOT_FOUND');assert.equal(old.operation.status,'superseded');
 assert.equal(ledger.activeFailure(f.job,q,f.a),null);assert.equal(statuses(f)[2],'unexpanded');
 assert.equal(ledger.eligibility(f.job,next.operation).action,'repair_input');
});

test('unrelated policy grants leave accepted SG permission failures valid',async t=>{
 const f=fixture(t);await denyAll(f);const calls=f.calls.length;
 policy.grant(f.a,{principalScope:policy.PUBLIC,resourceScope:{kind:'web',key:'public',jobId:'unrelated-job'},operations:['read_url']},authorization);
 assert.deepEqual(statuses(f),queries.map(()=>'accepted_boundary'));
 for(const q of queries)assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);
 assert.equal(f.calls.length,calls);
});

test('acceptance is a user state; unrelated accepted gaps and ordinary prose do not accept permission failures',async t=>{
 const f=fixture(t);delete ledger.state(f.job).acceptedBoundary;await denyAll(f);
 f.job.feedback.push({text:'先保留缺口，完成可访问部分'});f.a.data.artifacts.push({content:'先保留缺口，完成可访问部分'});
 ledger.state(f.job).gaps.push({id:'unrelated',status:'accepted_gap',acceptedBy:'user',text:'Accepted missing appendix'});
 assert.deepEqual(statuses(f),queries.map(()=>'blocked'));
 const operation=ledger.state(f.job).operations[ledger.key(f.job,queries[2])];
 ledger.state(f.job).gaps.push({id:'permission',status:'accepted_gap',acceptedBy:'user',operationId:operation.id,decisionId:'explicit-user-decision'});
 assert.deepEqual(statuses(f),['blocked','blocked','accepted_boundary']);
 f.job.executionContract.text+='\n先保留缺口，完成可访问部分';
 assert.deepEqual(statuses(f),queries.map(()=>'accepted_boundary'),'the existing authoritative contract choice remains compatible');
});

test('NOT_FOUND and transient failures retain their separate eligibility and retry rules',async t=>{
 const f=fixture(t),q=queries[2];f.errorCode='NOT_FOUND';
 const missing=await ledger.fetch(f.a,f.job,q);assert.equal(ledger.eligibility(f.job,missing.operation).action,'repair_input');
 assert.equal(statuses(f)[2],'blocked');assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);
 f.job.feedback.push({text:'Correct the resource mapping'});assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);
 assert.equal((await ledger.fetch(f.a,f.job,{...q,taskId:700001202})).reused,false,'a genuinely changed identifier is a new request');
 f.errorCode='TRANSIENT';const transient=await ledger.fetch(f.a,f.job,q,{retry:true});
 assert.equal(ledger.eligibility(f.job,transient.operation).action,'wait_until');
 assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);
 transient.operation.retryAt='2000-01-01T00:00:00Z';assert.equal((await ledger.fetch(f.a,f.job,q)).reused,false);
});

test('successful snapshots retain freshness, feedback and source-access invalidation',async t=>{
 const f=fixture(t),q=queries[2];f.errorCode=null;
 const result=await ledger.fetch(f.a,f.job,q),source={id:'result',platformPrincipal:'alice',content:JSON.stringify(result.snapshot)};
 f.a.data.sources.push(source);f.job.sourceIds.push(source.id);ledger.finish(f.a,f.job,result.operation,source.id);
 assert.equal(ledger.lookup(f.a,f.job,q).reused,true);
 source.deleted=true;assert.equal(ledger.lookup(f.a,f.job,q),null);source.deleted=false;
 result.operation.completedAt=new Date(Date.now()-ledger.freshMs-1).toISOString();assert.equal(ledger.lookup(f.a,f.job,q),null);
 result.operation.completedAt=new Date().toISOString();f.job.feedback.push({text:'New business request'});assert.equal(ledger.lookup(f.a,f.job,q),null);
});
