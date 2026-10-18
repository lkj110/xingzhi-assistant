'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs'),coral=require('./root-relation-physical-fixture.cjs');
const policy=require('../desktop/access-policy-store.cjs'),ledger=require('../desktop/operation-ledger.cjs'),method=require('../desktop/evidence-storage-method.cjs'),recovery=require('../desktop/evidence-recovery.cjs'),legacy=require('../desktop/evidence-legacy-preflight.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
const clone=structuredClone;
function setup(t){
 const f=fixture(t,{kinds:'物理表血缘'}),{a,job,task}=f;job.platformPrincipal='fixture-user';job.workRevision=task.workRevision=1;legacy.registerBuiltInAdapter(a);
 policy.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'controlled'});
 f.source('outputs',{taskId:123,outputs:[{databaseName:'db',tableName:'out',storageRegion:'sg'}]},{taskId:123});f.source('table_lineage',coral.data('out',['leaf']),{database:'db',table:'out'});
 const need=recovery.needs(a,job,task)[0],query=need.query,at=n=>new Date(Date.UTC(2026,9,17,0,0,n)).toISOString(),raw=JSON.stringify({...coral.data('leaf',[]),controlledLongField:'x'.repeat(700000)});
 const diagnostics={stage:'storage',reason:'structural_limit',rawBytes:Buffer.byteLength(raw),rawSha256:require('node:crypto').createHash('sha256').update(raw).digest('hex'),limitChars:500000};
 const check=policy.checkTool(a,job,'platform_query',{queries:[query]});
 const op={id:'controlled-original-operation',key:ledger.key(job,query),query:clone(query),requestedQuery:clone(query),actualQuery:clone(query),scope:job.dataPlatform,projectId:job.projectId||null,principal:job.platformPrincipal,permissionRevision:0,workRevision:1,policy:hash({policyId:check.policyId,grantRevision:check.grantRevision}),epoch:ledger.epoch(job),status:'failed',attempt:1,errorCode:'INVALID_PLATFORM_RESPONSE',error:'controlled local size failure',startedAt:at(3),completedAt:at(5)};
 op.receipt={version:1,operationId:op.id,requestedQuery:query,originalQuery:query,actualQuery:query,classification:op.errorCode,diagnostics,dispatched:true,observedAt:op.completedAt};job.executionState.operations[op.key]=op;
 const attempt={query:clone(query),rootIds:need.rootIds,obligationId:need.obligationId,status:'failed',at:at(2),finishedAt:at(6),errorCode:op.errorCode,error:op.error};
 const old={basis:'controlled-original',taskId:task.id,intentBasis:require('../desktop/continuation-control.cjs').intentBasis(job,task),evidenceAcquisition:{requestBasis:'controlled-old-request',attempts:{[method.attemptKey(need)]:attempt}}},episode={...clone(old),basis:'controlled-current'};job.executionState.continuation={episodes:{[old.basis]:old,[episode.basis]:episode},activeBasis:episode.basis};
 const step={id:'controlled-old-step',at:at(1),tool:'platform_query',args:{taskId:task.id,queries:[query]},evidenceAcquisition:{taskId:task.id,episodeBasis:old.basis,requestBasis:old.evidenceAcquisition.requestBasis,targets:[need]},result:{results:[{query,operationId:op.id,error:op.error,errorCode:op.errorCode,receipt:clone(op.receipt)}]}};
 step.dispatch={id:step.id,stepId:step.id,jobId:job.id,taskId:task.id,runId:'controlled-old-run',argsHash:hash(step.args),requests:[{query:{op:'identity'},at:at(2)},{query:clone(query),at:at(4)}]};
 a.data.agentRuns.push({id:'controlled-old-run',jobId:job.id,status:'done',startedAt:at(0),finishedAt:at(7),steps:[step]});a.save();return {...f,need,query,op,old,episode,step};
}
const inspect=f=>method.eligibility(f.a,f.job,f.task,f.episode,f.need);
test('typed storage diagnostics authorize fixed v2 method while preserving v1 adapter',t=>{
 const f=setup(t),before=clone(f.a.data),p=inspect(f);assert.equal(p.eligible,true,p.reason);assert.equal(p.method,'platform-chunks-v2');assert.equal(method.METHOD,'coral-structural-v1');assert.equal(p.originOperationId,f.op.id);assert.deepEqual(f.a.data,before);
 f.episode.basis='another-episode';f.need.rootIds=[...f.need.rootIds];assert.equal(inspect(f).familyKey,p.familyKey);
});
for(const [name,change,reason] of [
 ['missing raw bytes',f=>delete f.op.receipt.diagnostics.rawBytes,'COMPLETE_RESPONSE_UNPROVEN'],
 ['missing raw hash',f=>delete f.op.receipt.diagnostics.rawSha256,'COMPLETE_RESPONSE_UNPROVEN'],
 ['over transport limit',f=>f.op.receipt.diagnostics.rawBytes=16000001,'COMPLETE_RESPONSE_UNPROVEN'],
 ['ambiguous boundary',f=>f.step.dispatch.requests.push(clone(f.step.dispatch.requests[1])),'STORAGE_BOUNDARY_PROOF_MISSING_OR_AMBIGUOUS'],
 ['platform 34007',f=>f.op.receipt.diagnostics={stage:'parse',details:{code:34007}},'TYPED_STORAGE_ORIGIN_MISSING_OR_AMBIGUOUS'],
 ['stdout truncation',f=>f.op.receipt.diagnostics={stage:'transport',reason:'stdout_limit'},'TYPED_STORAGE_ORIGIN_MISSING_OR_AMBIGUOUS'],
 ['integrity corruption',f=>f.op.errorCode='LOCAL_RESULT_INTEGRITY','TYPED_STORAGE_ORIGIN_MISSING_OR_AMBIGUOUS'],
 ['old unknown claim',f=>f.job.executionState.evidenceMethodAttempts={old:{method:method.METHOD,status:'unknown',proof:{operation:clone(f.op)},query:clone(f.query)}},'STORAGE_FAMILY_UNRESOLVED'],
 ['v2 already failed',f=>f.job.executionState.evidenceMethodAttempts={v2:{method:method.V2_METHOD,status:'failed',proof:{operation:clone(f.op)},query:clone(f.query)}},'STORAGE_FAMILY_METHOD_CONSUMED']
])test('typed storage rejects '+name,t=>{const f=setup(t);change(f);assert.equal(inspect(f).reason,reason);});
test('a retained original result routes only to local processing; damaged retention never re-fetches',t=>{
 const f=setup(t),data=coral.data('leaf',[]);f.op.responses=[{query:f.query,data,retained:true,dataHash:hash(data)}];
 assert.equal(inspect(f).reason,'LOCAL_REPROCESS_REQUIRED');assert.deepEqual(method.localSnapshot(f.op).data,data);
 f.op.responses[0].dataHash='corrupt';assert.equal(inspect(f).reason,'LOCAL_RESULT_INTEGRITY');assert.throws(()=>method.localSnapshot(f.op),{code:'LOCAL_RESULT_INTEGRITY'});
});
test('real controlled v2 claim dispatch binds origin/family and a later storage failure cannot claim again',async t=>{
 const f=setup(t),action=recovery.next(f.a,f.job,f.task,f.episode);assert.equal(action?.tool,'platform_query');
 const run={id:'controlled-new-run',jobId:f.job.id,status:'running',steps:[]};f.a.data.agentRuns.unshift(run);f.a.activeAgentRun=run;action.at=new Date().toISOString();
 require('../desktop/dispatch-lifecycle.cjs').prepare(f.a,f.job,run,action,()=>recovery.started(f.a,f.job,f.task,f.episode,action));
 const grant=Object.values(f.job.executionState.evidenceMethodAttempts)[0];assert.equal(grant.method,'platform-chunks-v2');
 require('./helpers/platform-fixture.cjs').install(f.a);let calls=0;f.a.platformRequest=async()=>{calls++;return coral.data('leaf',[]);};
 const batch=await ledger.prepareBatch(f.a,f.job),fetched=await ledger.fetch(f.a,f.job,f.query,{batch});
 assert.equal(fetched.operation.originOperationId,f.op.id);assert.equal(fetched.operation.familyKey,grant.familyKey);assert.equal(fetched.operation.methodClaimId,grant.key);
 const error=ledger.storageFailure(f.a,f.job,fetched.operation,Object.assign(Error('controlled disk exhaustion'),{code:'LOCAL_RESULT_STORAGE'}));assert.equal(error.stopBatch,true);
 recovery.settled(f.a,f.job,f.task,f.episode,action);assert.equal(grant.status,'failed');assert.equal(calls,1);assert.equal(inspect(f).eligible,false);
 const claims=clone(f.job.executionState.evidenceMethodAttempts),local=recovery.next(f.a,f.job,f.task,f.episode);assert.equal(local.tool,'recover_platform_result');
 const result=await require('../desktop/agent.cjs').act(f.a,f.job,local.tool,local.args);assert.ok(result.sourceId);assert.equal(result.localRecovered,true);assert.equal(calls,1);assert.deepEqual(f.job.executionState.evidenceMethodAttempts,claims);
 assert.deepEqual(f.job.executionState.history.find(o=>o.id===f.op.id),f.op);
});
