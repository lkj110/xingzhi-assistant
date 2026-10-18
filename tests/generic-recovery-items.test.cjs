'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture}=require('./root-relation-fixture.cjs');
const ledger=require('../desktop/operation-ledger.cjs'),items=require('../desktop/evidence-item-lifecycle.cjs'),dispatch=require('../desktop/dispatch-lifecycle.cjs'),recovery=require('../desktop/evidence-recovery.cjs');
const policy=require('../desktop/access-policy-store.cjs'),agent=require('../desktop/agent.cjs'),commit=require('../desktop/state-transitions.cjs').commit;
const clone=structuredClone;
function setup(t,count=4,{bothDirections=false}={}){
 const f=fixture(t),{a,job,task}=f;job.platformPrincipal='fixture-user';job.workRevision=task.workRevision=1;
 policy.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'controlled'});
 const queries=Array.from({length:count},(_,i)=>({op:'code',taskId:String(123+i)}));
 const episode={basis:'controlled-episode',taskId:task.id,intentBasis:require('../desktop/continuation-control.cjs').intentBasis(job,task),evidenceAcquisition:{requestBasis:'controlled-request',attempts:{}}};
 job.executionState.continuation={episodes:{[episode.basis]:episode},activeBasis:episode.basis};task.evidenceRequest={kind:'needs_evidence',basis:'controlled-request'};
 const run={id:'controlled-run',jobId:job.id,status:'running',startedAt:new Date().toISOString(),steps:[]};a.data.agentRuns.push(run);a.activeAgentRun=run;
 const step={tool:'platform_query',args:{taskId:task.id,queries},at:new Date().toISOString()};
 dispatch.prepare(a,job,run,step,()=>{step.evidenceAcquisition={taskId:task.id,episodeBasis:episode.basis,requestBasis:task.evidenceRequest.basis,targets:queries.flatMap(query=>(bothDirections?['input','output']:[null]).map(direction=>({query,direction,obligationId:'controlled-obligation',rootIds:['123']})))};for(const n of step.evidenceAcquisition.targets){const entry={...clone(n),status:'started',at:new Date().toISOString()};episode.evidenceAcquisition.attempts[require('../desktop/evidence-storage-method.cjs').attemptKey(n)]=entry;items.claimInCommit(job,task,entry,step);}});
 a.platformRequest=async args=>args.includes('whoami')?{username:'fixture-user'}:{taskId:123,sql:'select controlled_column from controlled_table'};
 require('./helpers/platform-fixture.cjs').install(a);a.platformRequest=async()=>({taskId:123,sql:'select controlled_column from controlled_table'});
 return {...f,queries,episode,run,step,attempts:Object.values(episode.evidenceAcquisition.attempts)};
}
function saveResult(f,result){return commit(f.a,()=>{const stored=require('../desktop/data-platform.cjs').splitPlatformSnapshot(result.snapshot),s=agent.source(f.a,f.job,'controlled:'+result.operation.id,'controlled',JSON.stringify(stored.snapshot),{platformSnapshot:true,platformPrincipal:f.job.platformPrincipal,...stored.sourceMeta});ledger.finish(f.a,f.job,result.operation,s.id);return s;});}
test('controlled partial batch: first two sources survive third unknown; fourth is proven queued',async t=>{
 const f=setup(t),batch=await ledger.prepareBatch(f.a,f.job);for(let i=0;i<2;i++)saveResult(f,await ledger.fetch(f.a,f.job,f.queries[i],{batch}));
 f.a.platformRequest=async()=>{throw Object.assign(Error('controlled crash at transport'),{code:'ABORTED',dispatchFailure:true});};
 await assert.rejects(ledger.fetch(f.a,f.job,f.queries[2],{batch}),/controlled crash/);
 f.step.error='controlled batch interrupted';f.run.status='interrupted';f.run.finishedAt=new Date().toISOString();
 recovery.settled(f.a,f.job,f.task,f.episode,f.step);f.a.save();
 assert.deepEqual(f.attempts.map(x=>x.status),['done','done','unknown','queued']);
 assert.equal(f.episode.evidenceAcquisition.pendingPlan.sourceIds.length,2);
 const durable=JSON.parse(fs.readFileSync(f.a.file));assert.deepEqual(Object.values(durable.delegations.find(j=>j.id===f.job.id).executionState.continuation.episodes[f.episode.basis].evidenceAcquisition.attempts).map(x=>x.status),['done','done','unknown','queued']);
 assert.equal(items.inspect(f.a,f.job,f.attempts[0]).source.id,f.attempts[0].sourceId);
 assert.equal(items.candidate(f.a,f.job,f.task,f.queries[2]).action,'reconcile');
 assert.equal(items.candidate(f.a,f.job,f.task,f.queries[3]).action,'execute');
 await assert.rejects(ledger.fetch(f.a,f.job,f.queries[2],{batch,retry:true}),{code:'OPERATION_RECONCILIATION_REQUIRED'});
});
test('identity transient failures use independent three-attempt scope budget; zero business operations',async t=>{
 t.mock.timers.enable({apis:['Date']});
 const f=setup(t,1);delete f.a.platformRequest;let calls=0;f.a.platformRequest=async()=>{calls++;throw Object.assign(Error('controlled identity timeout'),{code:'TRANSIENT'});};
 for(let i=0;i<3;i++){
  await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:'TRANSIENT'});
  const records=Object.values(f.job.executionState.identityPreflights).flat();assert.equal(records.length,i+1);
  assert.equal(Object.keys(f.job.executionState.operations).length,0);
  await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:i===2?'TRANSIENT_EXHAUSTED':'TRANSIENT_BACKOFF'});
  t.mock.timers.tick(300000); // Advance time; never forge an impossible terminal timestamp.
 }
 assert.equal(calls,3);assert.equal(f.attempts[0].status,'started');
});
test('business transient counter and logical identity survive root and episode changes',async t=>{
 const f=setup(t,1),batch=await ledger.prepareBatch(f.a,f.job);f.a.platformRequest=async()=>{throw Object.assign(Error('controlled 503'),{code:'TRANSIENT'});};
 for(let i=0;i<3;i++){const r=await ledger.fetch(f.a,f.job,f.queries[0],{batch});assert.equal(r.errorCode,'TRANSIENT');r.operation.completedAt=new Date(Date.now()-300000).toISOString();r.operation.retryAt=r.operation.completedAt;f.a.save();if(i<2){delete f.attempts[0].operationId;items.claimInCommit(f.job,f.task,f.attempts[0],f.step);f.a.save();}}
 const key=f.attempts[0].logicalKey;assert.equal(items.transientCount(f.job,key),3);
 f.attempts[0].rootIds=['a-new-root'];f.job.executionState.continuation.episodes.new=clone(f.episode);
 assert.equal(items.logicalKey(f.job,f.task,f.queries[0]),key);assert.equal(items.transientCount(f.job,key),3);
 const op=Object.values(f.job.executionState.operations)[0];assert.equal(ledger.eligibility(f.job,op).action,'diagnose');
});
test('atomic source/operation/acquisition save failure rolls back done and keeps retained response',async t=>{
 const f=setup(t,1),batch=await ledger.prepareBatch(f.a,f.job),r=await ledger.fetch(f.a,f.job,f.queries[0],{batch}),before=clone(f.a.data.sources);
 t.mock.method(f.a,'save',()=>{throw Object.assign(Error('controlled disk full'),{code:'ENOSPC'});});
 assert.throws(()=>saveResult(f,r),/controlled disk full/);assert.deepEqual(f.a.data.sources,before);assert.notEqual(r.operation.status,'done');assert.notEqual(f.attempts[0].status,'done');assert.equal(r.operation.responses.length,1);
});
test('response persistence failure stops dispatch and never marks a result retained',async t=>{
 const f=setup(t,1),batch=await ledger.prepareBatch(f.a,f.job),save=f.a.save.bind(f.a);
 t.mock.method(f.a,'save',()=>{if(Object.values(f.job.executionState.operations).some(o=>o.responses?.length))throw Error('controlled receipt failure');return save();});
 await assert.rejects(ledger.fetch(f.a,f.job,f.queries[0],{batch}),{code:'LOCAL_RESULT_STORAGE',stopBatch:true});
 const op=Object.values(f.job.executionState.operations)[0];assert.equal(op.responses,undefined);assert.equal(items.inspect(f.a,f.job,f.attempts[0]).phase,'unknown');
});
test('wrong operation identity, missing boundary log and integrity errors do not become queue eligibility',async t=>{
 const f=setup(t,1),batch=await ledger.prepareBatch(f.a,f.job),r=await ledger.fetch(f.a,f.job,f.queries[0],{batch});saveResult(f,r);
 r.operation.attemptId='unrelated';assert.equal(items.inspect(f.a,f.job,f.attempts[0]).phase,'unknown');
 r.operation.attemptId=f.attempts[0].attemptId;f.a.data.sources.find(s=>s.id===r.operation.sourceId).content='broken';assert.equal(items.inspect(f.a,f.job,f.attempts[0]).phase,'unresolved');
 assert.equal(ledger.classify({code:'LOCAL_RESULT_STORAGE'}),'LOCAL_RESULT_STORAGE');assert.equal(ledger.classify({code:'LOCAL_RESULT_INTEGRITY'}),'LOCAL_RESULT_INTEGRITY');
});

test('one business identity settles both input/output targets without losing directional obligations',async t=>{
 const f=setup(t,1,{bothDirections:true});let calls=0;f.a.platformRequest=async()=>{calls++;return {taskId:123,sql:'select controlled_column from controlled_table'};};
 assert.equal(f.attempts.length,2);assert.equal(new Set(f.attempts.map(a=>a.attemptId)).size,1);
 const batch=await ledger.prepareBatch(f.a,f.job),r=await ledger.fetch(f.a,f.job,f.queries[0],{batch}),source=saveResult(f,r);
 recovery.settled(f.a,f.job,f.task,f.episode,f.step);
 assert.equal(calls,1);assert.deepEqual(f.attempts.map(a=>a.status),['done','done']);assert.deepEqual(f.attempts.map(a=>a.direction),['input','output']);
 assert.deepEqual(f.episode.evidenceAcquisition.pendingPlan.sourceIds,[source.id]);
 assert.equal(f.step.dispatch.requests.filter(r=>r.query.op!=='identity').length,1);
});

test('v2 archive carries the real ledger operation identity and reciprocal source version',async t=>{
 const f=setup(t,1);f.a.platformRequest=async()=>({taskId:123,sql:'select controlled_data;'.repeat(30000)});
 const batch=await ledger.prepareBatch(f.a,f.job),r=await ledger.fetch(f.a,f.job,f.queries[0],{batch});
 assert.equal(r.snapshot.platformResult.format,'platform-chunks-v2');assert.equal(r.snapshot.platformArchive.binding.operationId,r.operation.id);
 const source=saveResult(f,r);assert.equal(source.platformOperationId,r.operation.id);assert.equal(r.operation.sourceVersion,source.version||1);assert.equal(r.operation.receipt.sourceId,source.id);
 source.platformOperationId='wrong-operation';assert.equal(items.inspect(f.a,f.job,f.attempts[0]).phase,'unresolved');
});

test('new job initializes executionState only inside the identity-preflight mutation',async t=>{
 const f=setup(t,1),identity=require('../desktop/evidence-identity-preflight.cjs');delete f.job.executionState;
 assert.deepEqual(identity.decision(f.job,identity.key(f.job,'controlled')),{action:'execute'});assert.equal(f.job.executionState,undefined);
 const batch=await ledger.prepareBatch(f.a,f.job);assert.equal(batch.identity.data.username,'fixture-user');
 assert.equal(Object.values(f.job.executionState.identityPreflights).flat().length,1);assert.deepEqual(f.job.executionState.operations,{});
});
test('new-job preflight save failure rolls back state initialization and sends nothing',async t=>{
 const f=setup(t,1);delete f.job.executionState;const before=f.a.platformFixture.identityCalls;
 t.mock.method(f.a,'save',()=>{throw Error('controlled initialization persistence failure');});
 await assert.rejects(ledger.prepareBatch(f.a,f.job),/initialization persistence failure/);
 assert.equal(f.job.executionState,undefined);assert.equal(f.a.platformFixture.identityCalls,before);
});

function nextCachedTargets(f){
 const step={tool:'platform_query',args:{taskId:f.task.id,queries:f.queries},at:new Date().toISOString()};
 dispatch.prepare(f.a,f.job,f.run,step,()=>{
  const work=f.episode.evidenceAcquisition;(work.attemptHistory ||= []).push(...clone(Object.values(work.attempts)));work.attempts={};
  step.evidenceAcquisition={taskId:f.task.id,episodeBasis:f.episode.basis,requestBasis:f.task.evidenceRequest.basis,targets:clone(f.step.evidenceAcquisition.targets)};
  for(const n of step.evidenceAcquisition.targets){const entry={...clone(n),at:step.at};work.attempts[require('../desktop/evidence-storage-method.cjs').attemptKey(n)]=entry;items.claimInCommit(f.job,f.task,entry,step);}
 });f.step=step;f.attempts=Object.values(f.episode.evidenceAcquisition.attempts);
}
for(const failed of [false,true])test('cached '+(failed?'negative receipt':'success')+' settles every same-query target without changing original history',async t=>{
 const f=setup(t,1,{bothDirections:true});if(failed)f.a.platformRequest=async()=>{throw Object.assign(Error('controlled denied'),{code:'AUTH_REQUIRED'});};else f.a.platformRequest=async()=>({taskId:123,sql:'select controlled_cached_data;'.repeat(30000)});
 const batch=await ledger.prepareBatch(f.a,f.job),original=await ledger.fetch(f.a,f.job,f.queries[0],{batch});if(!failed)saveResult(f,original);
 if(!failed)assert.equal(original.snapshot.platformResult.format,'platform-chunks-v2');
 const oldOperation=clone(original.operation);nextCachedTargets(f);const oldAttempts=clone(f.episode.evidenceAcquisition.attemptHistory),budget=clone(f.a.spendLedger);let calls=0;
 f.a.platformRequest=async()=>{calls++;throw Error('cache must not dispatch');};
 const result=await agent.act(f.a,f.job,'platform_query',f.step.args);assert.equal(result.results[0].reused,true);assert.equal(calls,0);
 assert.deepEqual(f.attempts.map(v=>v.status),failed?['failed','failed']:['done','done']);
 for(const attempt of f.attempts){assert.equal(attempt.reusedOperationId,original.operation.id);assert.equal(attempt.operationId,undefined);assert.equal(items.inspect(f.a,f.job,attempt).phase,failed?'failed':'persisted');}
 recovery.settled(f.a,f.job,f.task,f.episode,f.step);f.a.save();
 assert.deepEqual(f.attempts.map(v=>v.direction),['input','output']);assert.deepEqual(original.operation,oldOperation);assert.deepEqual(f.episode.evidenceAcquisition.attemptHistory,oldAttempts);assert.deepEqual(f.a.spendLedger,budget);
 const durable=JSON.parse(fs.readFileSync(f.a.file)),job=durable.delegations.find(j=>j.id===f.job.id),a={...f.a,data:durable},attempts=Object.values(job.executionState.continuation.episodes[f.episode.basis].evidenceAcquisition.attempts);
 for(const attempt of attempts)assert.equal(items.inspect(a,job,attempt).phase,failed?'failed':'persisted');
 assert.equal(items.candidate(a,job,durable.tasks.find(t=>t.id===f.task.id),f.queries[0]).action,failed?'request_access':'reuse');
 if(!failed)assert.deepEqual(f.episode.evidenceAcquisition.pendingPlan.sourceIds,[original.operation.sourceId]);
});
test('cached multi-target commit failure rolls back every target and preserves the original operation',async t=>{
 const f=setup(t,1,{bothDirections:true}),batch=await ledger.prepareBatch(f.a,f.job),original=await ledger.fetch(f.a,f.job,f.queries[0],{batch});saveResult(f,original);nextCachedTargets(f);
 const before=clone(f.attempts),op=clone(original.operation),save=f.a.save.bind(f.a);
 t.mock.method(f.a,'save',()=>{if(f.attempts.some(v=>v.reusedOperationId))throw Error('controlled cached settlement save failure');return save();});
 await assert.rejects(ledger.fetch(f.a,f.job,f.queries[0],{batch}),/cached settlement save failure/);
 assert.deepEqual(f.attempts,before);assert.deepEqual(original.operation,op);
});
test('cached multi-target settlement cannot overwrite another target unknown or conflicting operation',async t=>{
 const f=setup(t,1,{bothDirections:true}),batch=await ledger.prepareBatch(f.a,f.job),original=await ledger.fetch(f.a,f.job,f.queries[0],{batch});saveResult(f,original);nextCachedTargets(f);
 f.attempts[1].phase='unknown';const before=clone(f.attempts);
 assert.throws(()=>commit(f.a,()=>ledger.reuseInCommit(f.a,f.job,f.attempts[0],original.operation)),{code:'OPERATION_RECONCILIATION_REQUIRED'});assert.deepEqual(f.attempts,before);
 f.attempts[1].operationId='another-operation';assert.throws(()=>commit(f.a,()=>ledger.reuseInCommit(f.a,f.job,f.attempts[0],original.operation)),{code:'EVIDENCE_IDENTITY_CONFLICT'});
 assert.equal(f.attempts[0].reusedOperationId,undefined);
});
test('reused receipt inspection rejects missing operation, query/policy drift and corrupt source after restart',async t=>{
 const f=setup(t,1,{bothDirections:true}),batch=await ledger.prepareBatch(f.a,f.job),original=await ledger.fetch(f.a,f.job,f.queries[0],{batch});saveResult(f,original);nextCachedTargets(f);await ledger.fetch(f.a,f.job,f.queries[0],{batch});
 const durable=JSON.parse(fs.readFileSync(f.a.file));
 for(const change of ['missing','query','policy','source','unknown']){
  const a={...f.a,data:clone(durable)},job=a.data.delegations.find(j=>j.id===f.job.id),op=job.executionState.operations[original.operation.key],attempts=Object.values(job.executionState.continuation.episodes[f.episode.basis].evidenceAcquisition.attempts);
  if(change==='missing')delete job.executionState.operations[op.key];
  if(change==='query'){op.query={op:'code',taskId:'999'};op.requestedQuery=op.actualQuery=op.query;}
  if(change==='policy')op.policy='changed';
  if(change==='source')a.data.sources.find(s=>s.id===op.sourceId).content='corrupt';
  if(change==='unknown')op.status='interrupted';
  const before=clone(a.data);for(const attempt of attempts){const inspected=items.inspect(a,job,attempt);assert.equal(inspected.source,undefined,change);assert.ok(['unknown','unresolved'].includes(inspected.phase),change);}
  assert.deepEqual(a.data,before);
 }
});
