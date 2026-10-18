const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,deny}=require('./root-relation-fixture.cjs'),coral=require('./root-relation-physical-fixture.cjs');
const resume=require('../desktop/storage-method-resume.cjs'),method=require('../desktop/evidence-storage-method.cjs');
const continuation=require('../desktop/continuation-control.cjs'),ledger=require('../desktop/operation-ledger.cjs'),policy=require('../desktop/access-policy-store.cjs');
const {hash}=require('../desktop/evidence-basis.cjs'),{commit}=require('../desktop/state-transitions.cjs'),dispatch=require('../desktop/dispatch-lifecycle.cjs');
const clone=structuredClone,at=n=>new Date(Date.UTC(2026,9,16,10)+n*1000).toISOString();
function setup(t){
 const f=fixture(t,{kinds:'物理表血缘'}),{a,job,task}=f;
 job.platformPrincipal='fixture-user';job.autoAccept=false;job.workRevision=task.workRevision=1;
 const remote={principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']};
 policy.grant(a,remote,{trusted:true,actor:'user_command',command:'fixture'});
 f.source('outputs',{taskId:123,outputs:[{databaseName:'db',tableName:'out',storageRegion:'sg'}]},{taskId:123});
 f.source('table_lineage',coral.data('out',['a','b','c','d']),{database:'db',table:'out'});
 const needs=require('../desktop/relation-obligations.cjs').evidenceNeeds(a,job,task);assert.equal(needs.length,4);
 const original={basis:'original-episode',taskId:task.id,intentBasis:continuation.intentBasis(job,task),evidenceAcquisition:{version:1,requestBasis:'original-request',attempts:{}}};
 const episode={basis:'current-episode',taskId:task.id,intentBasis:original.intentBasis,cycles:3,hops:2,executions:17,fromValidationGrantId:'historical',blocked:true,reason:'同一未解决要求已完成 3 次修订检查仍未收敛：fixture gaps',evidenceAcquisition:{version:1,attempts:{}}};
 job.executionState.continuation={version:1,activeTaskId:task.id,activeBasis:episode.basis,episodes:{[original.basis]:original,[episode.basis]:episode}};
 const results=[];
 for(const [i,need] of needs.entries()){
  const key=method.attemptKey(need),attempt={query:clone(need.query),obligationId:need.obligationId,rootIds:clone(need.rootIds),status:'failed',at:at(2),finishedAt:at(4),errorCode:'EVIDENCE_RESULT_UNAVAILABLE',error:method.LEGACY_SIZE_ERROR};
  original.evidenceAcquisition.attempts[key]=clone(attempt);episode.evidenceAcquisition.attempts[key]=clone(attempt);
  const check=policy.checkTool(a,job,'platform_query',{queries:[need.query]});
  const op={id:'original-operation-'+i,key:ledger.key(job,need.query),query:clone(need.query),requestedQuery:clone(need.query),actualQuery:clone(need.query),status:'interrupted',startedAt:at(3),interruptedAt:at(10),attempt:1,scope:job.dataPlatform,projectId:job.projectId||null,principal:job.platformPrincipal,permissionRevision:0,epoch:ledger.epoch(job),workRevision:1,policy:hash({policyId:check.policyId,grantRevision:check.grantRevision}),previousSourceId:null};
  job.executionState.operations[op.key]=op;results.push({query:clone(need.query),error:method.LEGACY_SIZE_ERROR});
 }
 const oldStep={tool:'platform_query',at:at(1),args:{taskId:task.id,queries:needs.map(n=>clone(n.query))},evidenceAcquisition:{taskId:task.id,episodeBasis:original.basis,requestBasis:'original-request',targets:clone(needs)},result:{results}};
 a.data.agentRuns.push({id:'original-run',jobId:job.id,status:'done',startedAt:at(0),finishedAt:at(5),steps:[oldStep]});
 const proofs=method.project(a,job,task,episode);assert.ok(proofs.every(p=>p.eligible),JSON.stringify(proofs));
 const request=require('../desktop/evidence-request.cjs').normalize(a,task,{kind:'needs_evidence',summary:'原物理缺口',gaps:['物理缺口'],requirements:needs.map(n=>n.obligationId)},'current-request');
 task.evidenceRequest=request;episode.evidenceAcquisition.requestBasis=request.basis;
 job.executionState.evidenceMethodAttempts={};
 for(const [i,p] of proofs.entries()){
  const claim={key:p.claimKey,method:method.METHOD,scope:method.scope(job),query:clone(p.need.query),proof:clone(p.proof),previousAttempt:clone(p.proof.previousAttempt),taskId:task.id,episodeBasis:episode.basis,requestBasis:request.basis,request:clone(request),context:method.context(a,job,task,method.permitted(a,job,task,p.need.query)),status:'started',at:at(22+i),errorCode:'EVIDENCE_METHOD_RESULT_UNKNOWN',error:'原请求结果未知'};
  job.executionState.evidenceMethodAttempts[claim.key]=claim;
  episode.evidenceAcquisition.attempts[p.proof.attemptKey]={query:clone(claim.query),obligationId:p.need.obligationId,rootIds:clone(p.need.rootIds),status:'started',at:claim.at,method:method.METHOD,methodClaimKey:claim.key,previousAttempt:clone(claim.previousAttempt)};
 }
 const failed={id:'failed-run',jobId:job.id,startedAt:at(20),finishedAt:at(30),status:'ready',steps:[],modelCalls:0,modelCallsDetail:[],usage:{inputTokens:0,outputTokens:0,estimatedUSD:0,unknownCalls:0},recovery:{reason:'正在自动纠偏：'+episode.reason}};a.data.agentRuns.push(failed);
 a.save();Object.assign(f,{episode,original,needs,remote,failed});
 t.mock.method(a,'publicState',()=>({storageMethodResume:resume.view(job)}));
 return f;
}
const ui=(f,action,input)=>f.a.dispatch('uiCommand',{action,input:{id:f.job.id,...input}});
const input=f=>{const p=resume.preview(f.a,f.job);assert.equal(p.eligible,true,p.reason);return {taskId:p.taskId,bindingId:p.bindingId,executedBy:'supervisor',authorizationNote:'用户已有授权继续，限四个原未知 claim 的一次技术恢复'};};
const authorize=async f=>{const value=input(f);await ui(f,resume.ACTION,value);return value;};
function prepare(f,{count=4}={}){
 const run={id:'resume-run',jobId:f.job.id,status:'running',startedAt:new Date().toISOString(),steps:[]};f.a.data.agentRuns.push(run);f.a.activeAgentRun=run;
 const cs=resume.candidates(f.a,f.job,f.task,f.episode).filter(c=>c.mode==='dispatch').slice(0,count),step={tool:'platform_query',at:new Date().toISOString(),args:{taskId:f.task.id,queries:cs.map(c=>c.query)}};
 dispatch.prepare(f.a,f.job,run,step,()=>resume.claimInCommit(f.a,f.job,f.task,f.episode,step));
 return {run,step};
}
function boundary(f,step,query){return commit(f.a,()=>{step.dispatch.phase='dispatch_started';return resume.markExternalInCommit(f.a,f.job,f.task,f.episode,step,query);});}
function restart(f,t){
 require('../desktop/deadline-scheduler.cjs').dispose(f.a);
 const {Assistant}=require('../desktop/core.cjs');f.a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(f.a));
 f.job=f.a.data.delegations.find(j=>j.id===f.job.id);f.task=f.a.task(f.task.id);f.episode=f.job.executionState.continuation.episodes[f.episode.basis];
 t.mock.method(f.a,'publicState',()=>({storageMethodResume:resume.view(f.job)}));
}
const preserved=f=>({claims:clone(f.job.executionState.evidenceMethodAttempts),request:clone(f.task.evidenceRequest),original:clone(f.original),cycles:f.episode.cycles,hops:f.episode.hops,executions:f.episode.executions,spend:clone(f.a.spendLedger)});

test('preview is pure, binds exactly four full original claims, and cannot enable ordinary candidates',t=>{
 const f=setup(t),data=clone(f.a.data),spend=clone(f.a.spendLedger);t.mock.method(f.a,'save',deny);
 const p=resume.preview(f.a,f.job);assert.equal(p.eligible,true,p.reason);assert.equal(p.claims.length,4);assert.equal(p.historyUnknown,true);
 assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);assert.equal(resume.view(f.job).candidate,true);
 assert.ok(method.project(f.a,f.job,f.task,f.episode).every(p=>!p.eligible));assert.deepEqual(f.a.data,data);assert.deepEqual(f.a.spendLedger,spend);
});
test('raw/model/feedback/tick contexts cannot authorize; actual uiCommand can, including concurrent duplicate clicks',async t=>{
 const f=setup(t),value=input(f),before=preserved(f);
 assert.throws(()=>resume.authorize(f.a,f.job,{...value,uiCommand:true,trusted:true}),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 for(const action of [resume.ACTION,resume.PREVIEW])await assert.rejects(f.a.dispatch(action,{id:f.job.id,...value}),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 const command=require('../desktop/workspace-view.cjs').command;
 const originalDispatch=f.a.dispatch.bind(f.a);t.mock.method(f.a,'dispatch',(action,v)=>action==='agentFeedback'?resume.authorize(f.a,f.job,value):originalDispatch(action,v));
 assert.throws(()=>command(f.a,{action:'agentFeedback',input:{}}),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 await Promise.all([ui(f,resume.ACTION,value),ui(f,resume.ACTION,value)]);
 const g=resume.active(f.job);assert.equal(Object.keys(f.job.executionState.storageMethodResume.grants).length,1);assert.equal(g.executedBy,'supervisor');assert.equal(g.binding.claims.length,4);assert.deepEqual(preserved(f),before);
 restart(f,t);await ui(f,resume.ACTION,value);assert.equal(resume.active(f.job).grantId,g.grantId);assert.equal(resume.candidates(f.a,f.job,f.task,f.episode).length,4);
});
for(const [name,change] of [
 ['missing claim',f=>delete f.job.executionState.evidenceMethodAttempts[Object.keys(f.job.executionState.evidenceMethodAttempts)[0]]],
 ['claim full text changed',f=>Object.values(f.job.executionState.evidenceMethodAttempts)[0].error+=' changed'],
 ['run unfinished',f=>delete f.failed.finishedAt],['run not ready',f=>f.failed.status='done'],['run model call',f=>f.failed.modelCalls=1],['run usage',f=>f.failed.usage.unknownCalls=1],['run query',f=>f.failed.steps.push({tool:'platform_query'})],
 ['run ambiguous',f=>f.a.data.agentRuns.push({...clone(f.failed),id:'other-run'})],
 ['task owner',f=>f.task.agentJobId='other'],['scope',f=>f.job.dataPlatform='other'],['principal',f=>f.job.platformPrincipal='other'],['project',f=>f.job.projectId='other'],
 ['policy',f=>policy.revoke(f.a,f.remote,{trusted:true,actor:'user_command',command:'fixture'})],
 ['permission revision',f=>f.job.executionState.permissionRevision=1],['work revision',f=>f.job.workRevision=2],['task revision',f=>f.task.workRevision=2],
 ['request',f=>f.task.evidenceRequest.summary+=' changed'],['intent',f=>f.job.goal+=' changed'],['episode',f=>f.episode.cycles=2],['pending check identity',f=>f.episode.pendingCheck={generationAttemptId:'different'}],
 ['source',f=>f.a.data.sources.find(s=>f.task.sourceIds.includes(s.id)).content+=' changed'],['pause',f=>f.job.executionPaused=true],
 ['operation',f=>Object.values(f.job.executionState.operations)[0].attempt=2],['live operation',f=>Object.values(f.job.executionState.operations)[0].status='running'],
 ['ambiguous operation',f=>{const op=Object.values(f.job.executionState.operations)[0];f.job.executionState.operations.other={...clone(op),id:'conflict',key:'other'};}],
 ['history',f=>{const op=Object.values(f.job.executionState.operations)[0];f.job.executionState.history=[{...clone(op),id:'later',startedAt:at(40)}];}],
 ['query',f=>Object.values(f.job.executionState.evidenceMethodAttempts)[0].query.table='changed'],
 ['typed gap closed',f=>f.source('table_lineage',coral.data('a'),{database:'db',table:'a'})]
])test('stale preview refuses '+name+' and creates no grant',async t=>{
 const f=setup(t),value=input(f);change(f);f.a.save();await assert.rejects(ui(f,resume.ACTION,value));assert.equal(resume.active(f.job),null);
});

test('authorization save failure rolls back grant and original history without sending',async t=>{
 const f=setup(t),value=input(f),before=clone(f.a.data);t.mock.method(f.a,'save',()=>{throw Error('disk denied');});
 await assert.rejects(ui(f,resume.ACTION,value),/disk denied/);assert.deepEqual(f.a.data,before);
});
test('atomic step and reservations, duplicate claim denied, restart never regains dispatch',async t=>{
 const f=setup(t),before=preserved(f);await authorize(f);const {step}=prepare(f);
 const disk=JSON.parse(fs.readFileSync(f.a.file)),g=resume.active(f.job);assert.equal(Object.keys(g.reservations).length,4);assert.ok(disk.agentRuns.find(r=>r.id==='resume-run').steps[0].storageMethodResume);
 assert.equal(resume.currentDispatch(f.a,f.job,f.task,f.episode,step).allowed,true);
 assert.throws(()=>resume.claimInCommit(f.a,f.job,f.task,f.episode,step),{code:'RESUME_TRUSTED_TRANSACTION_REQUIRED'});
 assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);assert.deepEqual(preserved(f),before);
 restart(f,t);assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);const run=f.a.data.agentRuns.find(r=>r.id==='resume-run');f.a.activeAgentRun=run;
 assert.equal(resume.currentDispatch(f.a,f.job,f.task,f.episode,run.steps[0]).allowed,false,'persisted step flags cannot recreate runtime ownership');
});
test('prepared step save failure rolls back both step and reservations; no stranded claim',async t=>{
 const f=setup(t);await authorize(f);const save=t.mock.method(f.a,'save',()=>{throw Error('prepare save denied');});
 assert.throws(()=>prepare(f),/prepare save denied/);assert.deepEqual(resume.active(f.job).reservations,{});assert.equal(f.a.activeAgentRun.steps.length,0);
 save.mock.restore();f.a.activeAgentRun=null;assert.equal(resume.candidates(f.a,f.job,f.task,f.episode).length,4);
});
test('per-query external stages are atomic, partial restart preserves unknown and will not replay batch',async t=>{
 const f=setup(t);await authorize(f);const {step}=prepare(f);boundary(f,step,{op:'identity'});
 const key=step.storageMethodResume.claimKeys[0],claim=f.job.executionState.evidenceMethodAttempts[key],old=claim.proof.operation;
 f.job.executionState.history=[clone(old)];f.job.executionState.operations[old.key]={...clone(old),id:'new-query',status:'running',attempt:2,startedAt:new Date().toISOString()};f.a.save();
 assert.equal(resume.currentDispatch(f.a,f.job,f.task,f.episode,step).allowed,true);
 boundary(f,step,claim.query);const reservations=resume.active(f.job).reservations;assert.ok(reservations[key].queryStartedAt);assert.equal(Object.values(reservations).filter(r=>r.queryStartedAt).length,1);
 assert.throws(()=>boundary(f,step,claim.query),{code:'RESUME_EXTERNAL_ALREADY_STARTED'});
 restart(f,t);assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);assert.equal(f.job.executionState.evidenceMethodAttempts[key].errorCode,'EVIDENCE_METHOD_RESULT_UNKNOWN');
});
test('hard gate and original full-claim hash are rechecked for same dispatch',async t=>{
 const f=setup(t);await authorize(f);const {step}=prepare(f);f.job.executionPaused=true;
 assert.equal(resume.currentDispatch(f.a,f.job,f.task,f.episode,step).allowed,false);f.job.executionPaused=false;
 const claim=Object.values(f.job.executionState.evidenceMethodAttempts)[0];claim.error+=' changed';f.a.save();
 assert.equal(resume.currentDispatch(f.a,f.job,f.task,f.episode,step).allowed,false);
});

async function durableReceipt(f,{failed=false}={}){
 // Controlled pre-existing history, not permission to resend an unknown claim.
 // Persist a complete successor receipt and its real same-source ACL/metadata.
 const claim=Object.values(f.job.executionState.evidenceMethodAttempts)[0],old=claim.proof.operation,query=clone(claim.query),when=new Date().toISOString();
 const op={...clone(old),id:require('node:crypto').randomUUID(),attemptId:require('node:crypto').randomUUID(),logicalKey:require('../desktop/evidence-item-lifecycle.cjs').logicalKey(f.job,f.task,query),status:failed?'failed':'running',attempt:old.attempt+1,startedAt:when,completedAt:when,taskId:f.task.id};delete op.interruptedAt;
 let result;
 commit(f.a,()=>{
  (f.job.executionState.history ||= []).push(clone(old));f.job.executionState.operations[op.key]=op;
  if(failed){
   Object.assign(op,{errorCode:'AUTH_REQUIRED',error:'Controlled historical permission denial',receipt:{version:1,operationId:op.id,requestedQuery:clone(query),originalQuery:clone(query),actualQuery:clone(query),classification:'AUTH_REQUIRED',dispatched:true,observedAt:when}});
   result={query,operationId:op.id,errorCode:op.errorCode,receipt:clone(op.receipt)};
  }
 });
 if(!failed){
  // Construct a pre-existing successful receipt with the real dispatch and
  // response pipeline. This fixture does not invoke a retry of the old UNKNOWN
  // claim, nor turn an arbitrary prepared snapshot into a verified response.
  const run={id:'controlled-retained-'+op.id,jobId:f.job.id,status:'running',startedAt:when,steps:[]},step={tool:'platform_query',args:{taskId:f.task.id,queries:[query]}};
  f.a.data.agentRuns.push(run);f.a.activeAgentRun=run;dispatch.prepare(f.a,f.job,run,step,()=>{});
  let request;
  const snapshot=await require('../desktop/data-platform.cjs').query(f.job,query,{request:async()=>coral.data(query.table),storageScope:{operationId:op.id},
   beforeRequest:child=>{request=dispatch.boundary(f.a,f.job,child,{operation:op,operationId:op.id,attemptId:op.attemptId,parentQuery:query});},
   afterResponse:(child,data)=>commit(f.a,()=>{op.responses=[{requestId:request.requestId,query:clone(child),data:clone(data),dataHash:hash(data),retained:true,receivedAt:new Date().toISOString()}];})});
  commit(f.a,()=>{
   const stored=require('../desktop/data-platform.cjs').splitPlatformSnapshot(snapshot),source=require('../desktop/agent.cjs').source(f.a,f.job,'controlled-historical:'+op.id,'Controlled historical receipt',JSON.stringify(stored.snapshot),{platformSnapshot:true,platformPrincipal:f.job.platformPrincipal,...stored.sourceMeta});
   ledger.finish(f.a,f.job,op,source.id);result={query,operationId:op.id,sourceId:source.id};step.result={results:[result]};run.status='done';run.finishedAt=new Date().toISOString();
  });
  dispatch.clear(f.a,f.job);f.a.activeAgentRun=null;
 }
 f.a.platformRequest=deny;return {query,result};
}
for(const failed of [false,true])test('unique durable '+(failed?'negative':'successful')+' receipt wins; recorded association never becomes dispatch',async t=>{
 const f=setup(t),before=clone(f.job.executionState.evidenceMethodAttempts);await durableReceipt(f,{failed});
 const p=resume.preview(f.a,f.job);assert.equal(p.eligible,true,p.reason);assert.equal(p.claims.filter(c=>c.mode==='associate').length,1);
 await authorize(f);const cs=resume.candidates(f.a,f.job,f.task,f.episode),associated=cs.find(c=>c.mode==='associate');assert.ok(associated);assert.equal(cs.filter(c=>c.mode==='dispatch').length,3);
 assert.equal(associated.receipt.op.status,failed?'failed':'done');assert.equal(resume.reservation(f.job,associated.claimKey),null);
 commit(f.a,()=>{const receipt=associated.receipt;(resume.active(f.job).receipts ||= {})[associated.claimKey]={operationId:receipt.op.id,sourceId:receipt.source?.id||null,status:receipt.op.status};const attempt=f.episode.evidenceAcquisition.attempts[f.job.executionState.evidenceMethodAttempts[associated.claimKey].proof.attemptKey];attempt.status=receipt.op.status;});
 assert.equal(resume.candidates(f.a,f.job,f.task,f.episode).length,3);assert.equal(resume.view(f.job).grant.claims.find(c=>c.claimKey===associated.claimKey).phase,'settled');
 restart(f,t);assert.equal(resume.candidates(f.a,f.job,f.task,f.episode).length,3);assert.deepEqual(f.job.executionState.evidenceMethodAttempts,before);
});
test('explicit legacy resume uses the real ledger without mutating old unknown claims',async t=>{
 const f=setup(t),before=preserved(f);await authorize(f);const {step}=prepare(f,{count:1});
 require('./helpers/platform-fixture.cjs').install(f.a);let calls=0;
 f.a.platformRequest=async()=>{calls++;return coral.data(step.args.queries[0].table);};
 const result=await require('../desktop/agent.cjs').act(f.a,f.job,step.tool,step.args);
 assert.ok(result.results[0].sourceId,JSON.stringify(result));assert.equal(calls,1);assert.deepEqual(f.job.executionState.evidenceMethodAttempts,before.claims);assert.deepEqual(f.a.spendLedger,before.spend);
 assert.equal(Object.values(resume.active(f.job).reservations)[0].operationId,Object.values(f.job.executionState.operations).find(o=>o.sourceId===result.results[0].sourceId).id);
 restart(f,t);assert.equal(resume.candidates(f.a,f.job,f.task,f.episode).filter(c=>c.mode==='associate').length,1);assert.deepEqual(f.job.executionState.evidenceMethodAttempts,before.claims);
});
test('ordinary lookup cannot use an unlinked old unknown claim as a dispatch grant',async t=>{
 const f=setup(t),before=preserved(f),query=clone(Object.values(before.claims)[0].query);
 require('./helpers/platform-fixture.cjs').install(f.a);let calls=0;f.a.platformRequest=async()=>{calls++;throw Error('ordinary lookup must not dispatch an unknown claim');};
 const batch=await ledger.prepareBatch(f.a,f.job);
 for(const retry of [false,true])await assert.rejects(ledger.fetch(f.a,f.job,query,{batch,retry}),{code:'OPERATION_RECONCILIATION_REQUIRED',stopBatch:true});
 assert.equal(calls,0);assert.deepEqual(preserved(f),before);
});
test('receipt collision, undurable source and ambiguous successor all refuse new dispatch',async t=>{
 const f=setup(t);await durableReceipt(f);await authorize(f);const associated=resume.candidates(f.a,f.job,f.task,f.episode).find(c=>c.mode==='associate'),g=resume.active(f.job);
 g.receipts[associated.claimKey]={operationId:'different',status:'done',sourceId:associated.receipt.source.id};f.a.save();assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);
 delete g.receipts[associated.claimKey];f.a.save();f.a.data.sources.find(s=>s.id===associated.receipt.source.id).title+=' undurable';assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);
 f.a.save();f.job.executionState.operations.duplicate={...clone(associated.receipt.op),key:'duplicate',id:'duplicate'};f.a.save();assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);
});
test('real ledger omits actualQuery until response; current runtime may claim exact live op only once',async t=>{
 const f=setup(t);await authorize(f);const {step}=prepare(f);boundary(f,step,{op:'identity'});
 const key=step.storageMethodResume.claimKeys[0],claim=f.job.executionState.evidenceMethodAttempts[key],old=claim.proof.operation;
 const op={...clone(old),id:'new-live',status:'running',attempt:2,startedAt:new Date().toISOString()};delete op.actualQuery;
 f.job.executionState.history=[clone(old)];f.job.executionState.operations[old.key]=op;f.a.save();
 assert.equal(resume.assertDispatch(f.a,f.job,f.task,step).allowed,true);boundary(f,step,claim.query);
 assert.equal(resume.reservation(f.job,key).operationId,op.id);op.id='different-live';f.a.save();assert.throws(()=>resume.assertDispatch(f.a,f.job,f.task,step),{code:'RESUME_LIVE_OPERATION_CONFLICT'});
});
test('identity boundary save failure rolls back stages; committed error retains consumed grant',async t=>{
 const f=setup(t);await authorize(f);const {step}=prepare(f),before=clone(resume.active(f.job));
 const save=f.a.save.bind(f.a),mock=t.mock.method(f.a,'save',()=>{throw Error('boundary denied');});
 assert.throws(()=>boundary(f,step,{op:'identity'}),/boundary denied/);assert.deepEqual(resume.active(f.job),before);assert.equal(step.dispatch.phase,'prepared');
 mock.mock.restore();t.mock.method(f.a,'save',()=>{save();throw Object.assign(Error('after commit'),{committed:true});});
 assert.throws(()=>boundary(f,step,{op:'identity'}),e=>e.committed===true);assert.ok(Object.values(resume.active(f.job).reservations).every(r=>r.identityStartedAt));
 restart(f,t);assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);
});
test('candidate and same-dispatch guards reject budget changes, preserving spent/held values',async t=>{
 const f=setup(t);await authorize(f);const {step}=prepare(f);f.a.activeAgentJob=f.job;const scope=require('../desktop/spend.cjs').scope(f.a);scope.spentUSD=scope.limitUSD;f.a.activeAgentJob=null;
 const before=clone(f.a.spendLedger);assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);assert.throws(()=>resume.assertDispatch(f.a,f.job,f.task,step),{code:'RESUME_EXECUTION_GUARDED'});assert.deepEqual(f.a.spendLedger,before);
});

test('legacy null active task retains exact active basis; normal owner selection does not invalidate grant',async t=>{
 const f=setup(t);f.job.executionState.continuation.activeTaskId=null;f.a.save();const before=clone(f.a.data);
 const p=resume.preview(f.a,f.job);assert.equal(p.eligible,true,p.reason);assert.deepEqual(f.a.data,before);
 await authorize(f);assert.equal(f.job.executionState.continuation.activeTaskId,null);
 f.job.executionState.continuation.activeTaskId=f.task.id;f.a.save();assert.equal(resume.candidates(f.a,f.job,f.task,f.episode).length,4);
 f.job.executionState.continuation.activeTaskId='other';f.a.save();assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);
});
test('public resume view does not inspect ACL, source bodies, ledger files or eligibility',t=>{
 const f=setup(t);t.mock.method(resume,'preview',deny);t.mock.method(fs,'readFileSync',deny);
 const result=resume.view(f.job);assert.equal(result.candidate,true);assert.equal(result.historyUnknown,true);assert.equal(result.grant,null);
});

for(const [name,change] of [
 ['principal',f=>f.job.platformPrincipal='other'],['project',f=>f.job.projectId='other'],['scope',f=>f.job.dataPlatform='other'],
 ['permission',f=>f.job.executionState.permissionRevision++],['policy',f=>policy.revoke(f.a,f.remote,{trusted:true,actor:'user_command',command:'fixture'})],
 ['task owner',f=>f.task.agentJobId='other'],['task revision',f=>f.task.workRevision++],['work revision',f=>f.job.workRevision++],
 ['request',f=>f.task.evidenceRequest.summary+='changed'],['intent',f=>f.job.goal+='changed'],['source',f=>f.a.data.sources.find(s=>f.task.sourceIds.includes(s.id)).content+='changed'],
 ['pending check',f=>f.episode.pendingCheck={generationAttemptId:'different'}],['query',(_f,step)=>step.args.queries[0].table='other'],
 ['unresolved external effect',f=>f.a.data.agentActions.push({id:'unresolved',jobId:f.job.id,taskId:f.task.id,tool:'lark_update',status:'uncertain'})]
])test('same dispatch refuses '+name+' drift at external boundary',async t=>{
 const f=setup(t);await authorize(f);const {step}=prepare(f),reservations=clone(resume.active(f.job).reservations);change(f,step);f.a.save();
 assert.throws(()=>resume.assertDispatch(f.a,f.job,f.task,step));assert.throws(()=>boundary(f,step,{op:'identity'}));assert.deepEqual(resume.active(f.job).reservations,reservations);
});

test('missing active-grant pointer cannot discard previous reservations or create another grant',async t=>{
 const f=setup(t),value=await authorize(f);prepare(f);f.a.activeAgentRun=null;
 f.job.executionState.storageMethodResume.activeGrantId=null;f.a.save();const history=clone(f.job.executionState.storageMethodResume);
 assert.equal(resume.preview(f.a,f.job).reason,'RESUME_GRANT_STATE_INVALID');assert.deepEqual(resume.candidates(f.a,f.job,f.task,f.episode),[]);
 await assert.rejects(ui(f,resume.ACTION,value),{code:'RESUME_GRANT_STATE_INVALID'});assert.deepEqual(f.job.executionState.storageMethodResume,history);
});
test('publicState exposes bounded resume status and omits private grant/claim state',async t=>{
 const f=setup(t);await authorize(f);const {Assistant}=require('../desktop/core.cjs'),state=Assistant.prototype.publicState.call(f.a,{summary:true}),row=state.delegations.find(j=>j.id===f.job.id);
 assert.equal(row.storageMethodResume.grant.claimCount,4);assert.equal(row.storageMethodResume.historyUnknown,true);assert.equal(row.executionState,undefined);
 assert.equal(row.storageMethodResume.grant.binding,undefined);assert.equal(row.storageMethodResume.grant.authorizationRef,undefined);
});

test('formal continuation.started can revalidate candidates inside the same prepared-step commit',async t=>{
 const f=setup(t);await authorize(f);const step=require('../desktop/evidence-recovery.cjs').next(f.a,f.job,f.task,f.episode);assert.equal(step?.tool,'platform_query');step.at=new Date().toISOString();
 const run={id:'formal-resume-run',jobId:f.job.id,status:'running',startedAt:new Date().toISOString(),steps:[]};f.a.data.agentRuns.push(run);f.a.activeAgentRun=run;
 dispatch.prepare(f.a,f.job,run,step,()=>continuation.started(f.a,f.job,step));
 assert.equal(step.continuation.kind,'evidence');assert.equal(Object.keys(resume.active(f.job).reservations).length,4);assert.equal(resume.assertDispatch(f.a,f.job,f.task,step).allowed,true);
});

test('durable receipt appearing after prepare blocks even identity and only permits association',async t=>{
 const f=setup(t);await authorize(f);const {step}=prepare(f),key=step.storageMethodResume.claimKeys[0],claim=f.job.executionState.evidenceMethodAttempts[key],old=claim.proof.operation,q=claim.query;
 const source=f.source('table_lineage',coral.data(q.table),q,{},false),at=new Date().toISOString();
 f.job.executionState.history=[clone(old)];f.job.executionState.operations[old.key]={...clone(old),id:'late-receipt',status:'done',sourceId:source.id,attempt:2,startedAt:at,completedAt:at};f.a.save();
 assert.equal(resume.currentDispatch(f.a,f.job,f.task,f.episode,step).allowed,true);
 assert.throws(()=>boundary(f,step,{op:'identity'}),{code:'RESUME_RECEIPT_REQUIRES_ASSOCIATION'});
 assert.equal(resume.candidates(f.a,f.job,f.task,f.episode).filter(c=>c.mode==='associate').length,1);assert.ok(Object.values(resume.active(f.job).reservations).every(r=>!r.identityStartedAt));
});
