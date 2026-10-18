'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const deny=()=>{throw Error('acquisition-local-recovery forbids real network/model/process');};
global.fetch=deny;require('node:net').Socket.prototype.connect=deny;require('node:child_process').spawn=deny;
const {fixture}=require('./root-relation-fixture.cjs'),coral=require('./root-relation-physical-fixture.cjs');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),ledger=require('../desktop/operation-ledger.cjs');
const items=require('../desktop/evidence-item-lifecycle.cjs'),dispatch=require('../desktop/dispatch-lifecycle.cjs'),recovery=require('../desktop/evidence-recovery.cjs');
const policy=require('../desktop/access-policy-store.cjs'),platform=require('../desktop/data-platform.cjs'),storage=require('../desktop/platform-result.cjs');
const {hash,canonical}=require('../desktop/evidence-basis.cjs'),commit=require('../desktop/state-transitions.cjs').commit;
const authorization={trusted:true,actor:'user_command',command:'controlled_local_recovery'};
const clone=structuredClone;
function setup(t,{acquisition=true,large=false}={}){
 const f=fixture(t,{kinds:'物理表血缘'}),{a,job,task}=f;job.platformPrincipal='fixture-user';job.workRevision=task.workRevision=1;
 policy.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},authorization);
 const query={op:'table_lineage',database:'db',table:'out'},data=coral.data('out',['leaf']);if(large)data.guidEntityMap.out.attributes.metadata='controlled '.repeat(80000);
 const episode={basis:'local-episode',taskId:task.id,intentBasis:require('../desktop/continuation-control.cjs').intentBasis(job,task),evidenceAcquisition:{requestBasis:'local-request',attempts:{}}};
 job.executionState.continuation={episodes:{[episode.basis]:episode},activeBasis:episode.basis};task.evidenceRequest={kind:'needs_evidence',basis:'local-request'};
 const run={id:'original-run',jobId:job.id,status:'running',startedAt:new Date().toISOString(),steps:[]};a.data.agentRuns.push(run);
 const step={tool:'platform_query',args:{taskId:task.id,queries:[query]},at:new Date().toISOString()};
 if(acquisition){a.activeAgentRun=run;dispatch.prepare(a,job,run,step,()=>{
  step.evidenceAcquisition={taskId:task.id,episodeBasis:episode.basis,requestBasis:task.evidenceRequest.basis,targets:['input','output'].map(direction=>({query,direction,obligationId:'obligation-'+direction,rootIds:['123']}))};
  for(const n of step.evidenceAcquisition.targets){const entry={...clone(n),status:'started',at:new Date().toISOString()};episode.evidenceAcquisition.attempts[n.direction]=entry;items.claimInCommit(job,task,entry,step);}
 });}
 const state={...f,query,data,run,step,episode,calls:0};
 function transport(a){require('./helpers/platform-fixture.cjs').install(a);a.platformRequest=async()=>{state.calls++;return clone(state.data);};}
 transport(a);
 state.restart=()=>{
  state.run.status='interrupted';state.run.finishedAt=new Date().toISOString();dispatch.clear(state.a,state.job);state.a.activeAgentRun=null;state.a.save();
  const next=new Assistant({dir:f.dir,chat:deny,agentRequest:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(next));transport(next);
  state.a=next;state.job=next.data.delegations.find(j=>j.id===job.id);state.task=next.data.tasks.find(v=>v.id===task.id);state.episode=state.job.executionState.continuation.episodes[episode.basis];state.run=next.data.agentRuns.find(r=>r.id===run.id);
 };
 state.op=()=>Object.values(state.job.executionState.operations)[0];
 state.recover=()=>agent.act(state.a,state.job,'recover_platform_result',{operationId:state.op().id,...(state.op().taskId?{taskId:state.task.id}:{})});
 state.retain=async()=>{const batch=await ledger.prepareBatch(state.a,state.job),r=await ledger.fetch(state.a,state.job,query,{batch});items.storageFailure(state.a,state.job,r.operation,Object.assign(Error('controlled disk full'),{code:'ENOSPC'}));return r;};
 return state;
}
function protectedState(f){const o=f.op();return {id:o.id,attemptId:o.attemptId,logicalKey:o.logicalKey,attempt:o.attempt,requests:clone(o.requests),claims:clone(f.job.executionState.evidenceMethodAttempts||{}),history:clone(f.job.executionState.history||[]),callsUsed:f.job.callsUsed,usage:clone(f.job.usage),spend:clone(f.a.spendLedger)};}
function representation(snapshot,format,scope){
 if(format==='inline')return storage.split(snapshot);
 if(format==='v2')return storage.split(storage.prepare(snapshot,scope));
 const raw=Buffer.from(JSON.stringify(canonical(snapshot.data))),data=storage.projectData(snapshot.data),manifest={version:1,format:'coral-structural-v1',codec:'gzip-base64',rawBytes:raw.length,rawSha256:storage.digest(raw),projectionSha256:storage.digest(JSON.stringify(canonical(data))),dataView:'structural_projection',originalDataRetained:true};
 return {snapshot:{...snapshot,data,platformResult:manifest},sourceMeta:{platformArchive:{...manifest,body:require('node:zlib').gzipSync(raw).toString('base64')}}};
}
function finish(f,snapshot,format){return commit(f.a,()=>{const saved=representation(snapshot,format,{principal:f.job.platformPrincipal,projectId:f.job.projectId||null,scope:f.job.dataPlatform,permissionRevision:f.job.executionState.permissionRevision,operationId:f.op().id}),s=agent.source(f.a,f.job,'controlled:'+format,'controlled',JSON.stringify(saved.snapshot),{platformSnapshot:true,platformPrincipal:f.job.platformPrincipal,...saved.sourceMeta});ledger.finish(f.a,f.job,f.op(),s.id);return s;});}

test('real source commit ENOSPC cold-restarts into explicit local action; both targets finish atomically without identity, method or model budget',async t=>{
 const f=setup(t,{large:true}),save=f.a.save.bind(f.a);let fail=true;
 t.mock.method(f.a,'save',()=>{if(fail&&f.a.data.sources.some(s=>s.platformSnapshot)&&f.op()?.status==='done'){fail=false;throw Object.assign(Error('controlled source commit ENOSPC'),{code:'ENOSPC'});}return save();});
 await assert.rejects(agent.act(f.a,f.job,'platform_query',f.step.args),{stopBatch:true});
 assert.equal(f.calls,1);assert.equal(f.op().errorCode,'LOCAL_RESULT_STORAGE');assert.equal(f.a.data.sources.length,0);assert.equal(f.op().responses.length,1);
 f.restart();const before=protectedState(f),identityCalls=f.a.platformFixture.identityCalls;
 assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),true);const action=recovery.next(f.a,f.job,f.task,f.episode);assert.equal(action.tool,'recover_platform_result');
 const localRun={id:'local-run',jobId:f.job.id,status:'running',steps:[]};f.a.data.agentRuns.push(localRun);f.a.activeAgentRun=localRun;
 dispatch.prepare(f.a,f.job,localRun,action,()=>assert.equal(recovery.started(f.a,f.job,f.task,f.episode,action),true));
 const result=await agent.act(f.a,f.job,action.tool,action.args),s=f.a.data.sources.find(v=>v.id===result.sourceId);
 assert.equal(result.localRecovered,true);assert.equal(result.storageValidation,'original_response_verified');assert.equal(f.calls,1);assert.equal(f.a.platformFixture.identityCalls,identityCalls);
 assert.deepEqual(protectedState(f),before);assert.deepEqual(storage.fullSnapshot(s).data,f.data);assert.equal(f.op().status,'done');assert.equal(f.op().responses,undefined);
 assert.deepEqual(Object.values(f.episode.evidenceAcquisition.attempts).map(v=>[v.status,v.sourceId]),[['done',s.id],['done',s.id]]);
 assert.ok(policy.check(f.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+s.id,jobId:f.job.id},operation:'local_read'}).allowed);
 const disk=JSON.parse(fs.readFileSync(f.a.file));assert.equal(disk.sources.find(v=>v.id===s.id).platformArchive.manifestHash,s.platformArchive.manifestHash);
 assert.equal(disk.delegations.find(v=>v.id===f.job.id).executionState.operations[f.op().key].sourceId,s.id);
 assert.equal(result.platformArchive,undefined);assert.ok(!JSON.stringify(result).includes(s.platformArchive.chunks[0].body));
 const settled=clone(f.a.data),again=await f.recover();assert.equal(again.sourceId,s.id);assert.equal(again.reused,true);assert.deepEqual(f.a.data,settled);assert.equal(f.calls,1);assert.equal(f.a.platformFixture.identityCalls,identityCalls);
});

test('local commit ENOSPC rolls back source/ACL/operation/items and can recover again after another cold restart',async t=>{
 const f=setup(t,{large:true});await f.retain();f.restart();
 const before=clone(f.a.data),acl=fs.readFileSync(policy.locations(f.a).store),save=f.a.save.bind(f.a);let fail=true;
 t.mock.method(f.a,'save',()=>{if(fail){fail=false;throw Object.assign(Error('controlled local ENOSPC'),{code:'ENOSPC'});}return save();});
 await assert.rejects(f.recover(),{code:'ENOSPC'});assert.deepEqual(f.a.data,before);assert.deepEqual(fs.readFileSync(policy.locations(f.a).store),acl);
 f.restart();const result=await f.recover();assert.ok(result.sourceId);assert.equal(f.calls,1);assert.equal(f.a.platformFixture.identityCalls,0);
});

test('complete retained response in an interrupted unknown operation recovers locally without treating it as permission to resend',async t=>{
 const f=setup(t);const batch=await ledger.prepareBatch(f.a,f.job);await ledger.fetch(f.a,f.job,f.query,{batch});f.op().status='unknown';f.restart();
 const before=protectedState(f);assert.equal(ledger.eligibility(f.job,f.op()).action,'reconcile');assert.ok((await f.recover()).sourceId);assert.deepEqual(protectedState(f),before);assert.equal(f.calls,1);
});

for(const [name,change] of [
 ['data without matching hash',f=>f.op().responses[0].data.injected=true],
 ['response hash',f=>f.op().responses[0].dataHash='f'.repeat(64)],
 ['request id',f=>f.op().responses[0].requestId='different-request'],
 ['operation id',f=>f.op().requests[0].operationId='different-operation'],
 ['attempt id',f=>f.op().requests[0].attemptId='different-attempt'],
 ['response query',f=>f.op().responses[0].query.table='other'],
 ['request query',f=>f.op().requests[0].query.table='other'],
 ['duplicate response',f=>f.op().responses.push(clone(f.op().responses[0]))],
 ['duplicate request',f=>f.op().requests.push(clone(f.op().requests[0]))],
 ['missing response',f=>delete f.op().responses],
 ['missing dispatch proof',f=>f.a.data.agentRuns=[]],
 ['item operation',f=>Object.values(f.episode.evidenceAcquisition.attempts)[1].operationId='other'],
 ['policy',f=>f.op().policy='different-policy'],
 ['principal',f=>f.job.platformPrincipal='other'],
 ['scope',f=>f.job.dataPlatform='off'],
 ['permission revision',f=>f.job.executionState.permissionRevision++],
 ['operation key',f=>f.op().key='wrong-slot'],
 ['task mismatch',f=>f.op().taskId='another-task'],
 ['integrity failure is not storage recovery',f=>f.op().errorCode='LOCAL_RESULT_INTEGRITY'],
 ['platform failure is not storage recovery',f=>f.op().errorCode='INVALID_PLATFORM_RESPONSE'],
])test('local recovery rejects '+name+' without new transport or mutations',async t=>{
 const f=setup(t);await f.retain();f.restart();change(f);const before=clone(f.a.data);
 await assert.rejects(f.recover(),e=>['LOCAL_RESULT_INTEGRITY','ACCESS_POLICY_UNKNOWN','ACCESS_POLICY_REVOKED'].includes(e.code));
 assert.deepEqual(f.a.data,before);assert.equal(f.calls,1);assert.equal(f.a.platformFixture.identityCalls,0);assert.equal(f.a.data.sources.length,0);
});

for(const kind of ['remote','retention','local_read'])test('current '+kind+' revocation blocks local recovery before archive preparation',async t=>{
 const f=setup(t);await f.retain();f.restart();
 policy.revoke(f.a,kind==='remote'?{principalScope:{kind:'account',provider:'platform',subject:f.job.platformPrincipal},resourceScope:{kind:'platform',key:f.job.dataPlatform,jobId:f.job.id},operations:['platform_query']}:{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',jobId:f.job.id},operations:[kind==='retention'?'local_retention':'local_read']},authorization);
 let prepared=0;t.mock.method(platform,'prepareSnapshot',()=>{prepared++;throw Error('must check ACL first');});
 await assert.rejects(f.recover());assert.equal(prepared,0);assert.equal(f.calls,1);assert.equal(f.a.platformFixture.identityCalls,0);assert.equal(f.a.data.sources.length,0);
});

test('consumed storage method does not hide a retained result or allocate a new method claim',async t=>{
 const f=setup(t);await f.retain();const op=f.op();
 f.job.executionState.evidenceMethodAttempts={old:{key:'old',method:'coral-structural-v1',status:'unknown',proof:{operation:{id:'origin'}}},v2:{key:'v2',method:'platform-chunks-v2',status:'failed',operationId:op.id,proof:{operation:{id:'origin'}},query:clone(f.query)}};
 const before=clone(f.job.executionState.evidenceMethodAttempts);f.restart();assert.equal(recovery.next(f.a,f.job,f.task,f.episode).tool,'recover_platform_result');
 await f.recover();assert.deepEqual(f.job.executionState.evidenceMethodAttempts,before);assert.equal(f.calls,1);
});

for(const format of ['inline','v1','v2']){
 test(format+' finish verifies the original response, cache binds digest/version, old success stays explicitly unverified',async t=>{
  const f=setup(t,{acquisition:false,large:format!=='inline'}),r=await f.retain();
  const raw={...r.snapshot,data:clone(f.data)};delete raw.platformResult;delete raw.platformArchive;
  const s=finish(f,raw,format);assert.equal(f.op().responseProof.dataHash,hash(f.data));assert.equal(f.op().receipt.storageValidated,true);
  f.restart();const result=(await agent.act(f.a,f.job,'platform_query',{queries:[f.query]})).results[0];assert.equal(result.reused,true);assert.equal(result.storageValidation,'original_response_verified');assert.equal(f.calls,1);
  const op=f.op(),saved=f.a.data.sources.find(v=>v.id===s.id);delete op.responseProof;delete op.sourceIntegrityHash;delete op.receipt.storageValidated;delete op.receipt.responseProof;f.a.save();
  const before=clone(op),legacy=(await agent.act(f.a,f.job,'platform_query',{queries:[f.query]})).results[0];
  assert.equal(legacy.storageValidation,'legacy_unverified');assert.equal(legacy.compatibility,'original_response_proof_missing');assert.deepEqual(op,before);assert.equal(f.calls,1);assert.deepEqual(storage.fullSnapshot(saved).data,f.data);
 });
 test(format+' finish rejects snapshot mutation between fetch and completion, preserving original response',async t=>{
  const f=setup(t,{acquisition:false,large:format!=='inline'}),r=await f.retain();
  const raw={...r.snapshot,data:{...clone(f.data),injected:'changed after receipt'}};delete raw.platformResult;delete raw.platformArchive;
  const before=clone(f.a.data);assert.throws(()=>finish(f,raw,format),{code:'LOCAL_RESULT_INTEGRITY',reason:'original_response_digest'});assert.deepEqual(f.a.data,before);assert.equal(f.op().responses.length,1);
 });
}

test('ordinary inline cache rejects corrupted valid JSON before any business dispatch, including expired cache after restart',async t=>{
 const f=setup(t,{acquisition:false});const result=(await agent.act(f.a,f.job,'platform_query',{queries:[f.query]})).results[0];
 const source=f.a.data.sources.find(v=>v.id===result.sourceId),body=JSON.parse(source.content);assert.equal(body.platformResult,undefined);body.data.injected='must not appear';source.content=JSON.stringify(body);f.op().completedAt='2000-01-01T00:00:00Z';f.restart();
 const before=clone(f.op());await assert.rejects(agent.act(f.a,f.job,'platform_query',{queries:[f.query,{op:'code',taskId:'987'}]}),{code:'LOCAL_RESULT_INTEGRITY',stopBatch:true});assert.equal(f.calls,1);assert.deepEqual(f.op(),before);
});

test('a fully valid v2 manifest and archive bound to another operation cannot complete this receipt',async t=>{
 const f=setup(t,{acquisition:false,large:true}),r=await f.retain(),raw={...r.snapshot,data:clone(f.data)};delete raw.platformResult;delete raw.platformArchive;
 const stored=representation(raw,'v2',{principal:f.job.platformPrincipal,projectId:f.job.projectId||null,scope:f.job.dataPlatform,permissionRevision:0,operationId:'another-operation'}),before=clone(f.a.data);
 assert.deepEqual(storage.restore(stored.snapshot,stored.sourceMeta),f.data);
 assert.throws(()=>commit(f.a,()=>{const s=agent.source(f.a,f.job,'swapped','swapped',JSON.stringify(stored.snapshot),{platformSnapshot:true,platformPrincipal:f.job.platformPrincipal,...stored.sourceMeta});ledger.finish(f.a,f.job,f.op(),s.id);}),{code:'LOCAL_RESULT_INTEGRITY',reason:'archive_operation_binding'});
 assert.deepEqual(f.a.data,before);assert.equal(f.calls,1);
});
