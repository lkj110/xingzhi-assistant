'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,deny}=require('./root-relation-fixture.cjs');
const ledger=require('../desktop/operation-ledger.cjs'),items=require('../desktop/evidence-item-lifecycle.cjs'),dispatch=require('../desktop/dispatch-lifecycle.cjs');
const method=require('../desktop/evidence-storage-method.cjs'),legacy=require('../desktop/evidence-legacy-preflight.cjs'),policy=require('../desktop/access-policy-store.cjs');
const {hash}=require('../desktop/evidence-basis.cjs'),agent=require('../desktop/agent.cjs'),platform=require('../desktop/data-platform.cjs');
const clone=structuredClone,at=n=>new Date(Date.UTC(2026,9,17)+n*1000).toISOString();
function setup(t,{directions=[null]}={}){
 const f=fixture(t),{a,job,task}=f;job.platformPrincipal='fixture-user';job.workRevision=task.workRevision=1;
 policy.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'controlled acquisition admission'});
 const query={op:'code',taskId:'123'},episode={basis:'controlled-admission',taskId:task.id,intentBasis:legacy.scope(job,task).intent,evidenceAcquisition:{requestBasis:'controlled-request',attempts:{}}};
 job.executionState.continuation={episodes:{[episode.basis]:episode},activeBasis:episode.basis};task.evidenceRequest={kind:'needs_evidence',basis:'controlled-request'};
 Object.assign(f,{query,episode,directions});freshClaim(f);require('./helpers/platform-fixture.cjs').install(a);a.platformRequest=deny;return f;
}
function freshClaim(f){
 const {a,job,task,episode,query}=f,run={id:require('node:crypto').randomUUID(),jobId:job.id,status:'running',startedAt:new Date().toISOString(),steps:[]};a.data.agentRuns.push(run);a.activeAgentRun=run;
 const step={tool:'platform_query',args:{taskId:task.id,queries:[query]},at:new Date().toISOString()};
 dispatch.prepare(a,job,run,step,()=>{
  const ac=episode.evidenceAcquisition;(ac.attemptHistory ||= []).push(...clone(Object.values(ac.attempts)));ac.attempts={};
  step.evidenceAcquisition={taskId:task.id,episodeBasis:episode.basis,requestBasis:task.evidenceRequest.basis,targets:f.directions.map(direction=>({query:clone(query),direction,obligationId:'controlled-'+direction,rootIds:['123']}))};
  for(const n of step.evidenceAcquisition.targets){const entry={...clone(n),at:step.at};ac.attempts[method.attemptKey(n)]=entry;items.claimInCommit(job,task,entry,step);}
 });Object.assign(f,{run,step,attempts:Object.values(episode.evidenceAcquisition.attempts)});return step;
}
function reboot(f,t){
 require('../desktop/deadline-scheduler.cjs').dispose(f.a);
 const a=new (require('../desktop/core.cjs').Assistant)({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 const job=a.data.delegations.find(v=>v.id===f.job.id),task=a.data.tasks.find(v=>v.id===f.task.id),episode=job.executionState.continuation.episodes[f.episode.basis];
 require('./helpers/platform-fixture.cjs').install(a);a.platformRequest=deny;
 return {...f,a,job,task,episode,run:a.data.agentRuns.find(r=>r.id===f.run.id),step:a.data.agentRuns.find(r=>r.id===f.run.id).steps.find(s=>s.id===f.step.id),attempts:Object.values(episode.evidenceAcquisition.attempts)};
}
async function crashBeforeBoundary(f,t){
 const batch=await ledger.prepareBatch(f.a,f.job),boundary=dispatch.boundary;
 const mock=t.mock.method(dispatch,'boundary',(a,j,q,m)=>{if(q.op!=='identity')throw Object.assign(Error('controlled crash before business boundary'),{dispatchFailure:true});return boundary(a,j,q,m);});
 await assert.rejects(ledger.fetch(f.a,f.job,f.query,{batch}),/controlled crash/);mock.mock.restore();
 return Object.values(f.job.executionState.operations)[0];
}
function oldUnknown(f,{history=false,keyKind='legacy'}={}){
 dispatch.clear(f.a,f.job);f.a.activeAgentRun=null;
 const key=keyKind==='legacy'?hash({jobId:f.job.id,projectId:f.job.projectId||null,scope:f.job.dataPlatform,principal:f.job.platformPrincipal,request:platform.command(f.query)}):ledger.key(f.job,f.query);
 const old={id:'controlled-old-unknown',key,query:clone(f.query),requestedQuery:clone(f.query),principal:f.job.platformPrincipal,scope:f.job.dataPlatform,projectId:f.job.projectId||null,permissionRevision:0,epoch:ledger.epoch(f.job),workRevision:f.job.workRevision,status:'unknown',attempt:1,startedAt:at(0),requests:[{requestId:'controlled-old-request',query:clone(f.query)}]};
 if(history)(f.job.executionState.history ||= []).push(old);else f.job.executionState.operations[key]=old;
 return old;
}
for(const location of ['legacy-slot','canonical-slot','history'])for(const change of ['workRevision','epoch'])for(const retry of [false,true])test(`ACQ-1 cold ${location}, ${change}, retry=${retry}: unknown blocks business dispatch`,async t=>{
 let f=setup(t),old=oldUnknown(f,{history:location==='history',keyKind:location==='canonical-slot'?'canonical':'legacy'});const original=clone(old);
 if(change==='workRevision')f.job.workRevision++;else f.job.executionContract={...f.job.executionContract,revision:'controlled-next-epoch'};
 assert.equal(ledger.valid(f.job,old,f.a),false);f.a.save();f=reboot(f,t);const spend=clone(f.a.spendLedger);let calls=0;f.a.platformRequest=async()=>{calls++;return {sql:'must not be sent'};};
 if(retry){const batch=await ledger.prepareBatch(f.a,f.job);await assert.rejects(ledger.fetch(f.a,f.job,f.query,{batch,retry:true}),{code:'OPERATION_RECONCILIATION_REQUIRED',stopBatch:true});}
 else await assert.rejects(agent.act(f.a,f.job,'platform_query',{queries:[f.query]}),{code:'OPERATION_RECONCILIATION_REQUIRED',stopBatch:true});
 assert.equal(calls,0);assert.deepEqual(f.a.spendLedger,spend);
 const records=[...Object.values(f.job.executionState.operations),...(f.job.executionState.history||[])];assert.deepEqual(records.find(o=>o.id===old.id),original);assert.equal(records.length,1);
});
test('ACQ-1 unknown history is checked before an otherwise valid success cache',async t=>{
 let f=setup(t);f.a.platformRequest=async()=>({sql:'select controlled'});await agent.act(f.a,f.job,'platform_query',f.step.args);
 const done=clone(Object.values(f.job.executionState.operations)[0]);oldUnknown(f,{history:true});f.a.save();f=reboot(f,t);const before=clone(f.a.spendLedger);let calls=0;f.a.platformRequest=async()=>{calls++;throw Error('must not dispatch');};
 await assert.rejects(agent.act(f.a,f.job,'platform_query',{queries:[f.query]}),{code:'OPERATION_RECONCILIATION_REQUIRED'});assert.equal(calls,0);assert.deepEqual(f.job.executionState.operations[done.key],done);assert.deepEqual(f.a.spendLedger,before);
});
test('ACQ-1 scope matching is independent of revision but does not conflate other accounts or projects',t=>{
 const f=setup(t),old=oldUnknown(f);f.job.workRevision++;f.job.executionContract={revision:'different'};
 assert.equal(ledger.unsettledForQuery(f.job,f.query).length,1);
 for(const [field,value] of [['principal','other-account'],['scope','another-scope'],['projectId','another-project']]){
  const previous=old[field],previousKey=old.key;old[field]=value;
  old.key=ledger.key({...f.job,[{principal:'platformPrincipal',scope:'dataPlatform',projectId:'projectId'}[field]]:value},f.query);
  assert.deepEqual(ledger.unsettledForQuery(f.job,f.query),[]);old[field]=previous;old.key=previousKey;
 }
 delete old.scope;delete old.projectId;assert.equal(ledger.unsettledForQuery(f.job,f.query).length,1,'legacy scoped key is still an exact binding');
});
for(const location of ['legacy-slot','canonical-slot','history'])for(const field of ['principal','scope','projectId'])for(const mode of ['missing','conflicting'])for(const retry of [false,true])test(`ACQ-1 exact scoped key preserves unknown with ${mode} ${field} in ${location}, retry=${retry}`,async t=>{
 let f=setup(t),old=oldUnknown(f,{history:location==='history',keyKind:location==='canonical-slot'?'canonical':'legacy'});
 if(mode==='missing')delete old[field];else old[field]='contradictory-historical-metadata';
 const original=clone(old);f.job.workRevision++;f.a.save();f=reboot(f,t);const spend=clone(f.a.spendLedger);let calls=0;f.a.platformRequest=async()=>{calls++;throw Error('must reconcile original request');};
 if(retry){const batch=await ledger.prepareBatch(f.a,f.job);await assert.rejects(ledger.fetch(f.a,f.job,f.query,{batch,retry:true}),{code:'OPERATION_RECONCILIATION_REQUIRED',stopBatch:true});}
 else await assert.rejects(agent.act(f.a,f.job,'platform_query',{queries:[f.query]}),{code:'OPERATION_RECONCILIATION_REQUIRED',stopBatch:true});
 assert.equal(calls,0);assert.deepEqual(f.a.spendLedger,spend);
 assert.deepEqual([...Object.values(f.job.executionState.operations),...(f.job.executionState.history||[])].find(o=>o.id===old.id),original);
});
test('ACQ-2 cold prepared zero-boundary operation is replaced atomically; one real dispatch settles both targets done',async t=>{
 let f=setup(t,{directions:['input','output']}),old=await crashBeforeBoundary(f,t);const oldId=old.id,oldAttempt=old.attemptId,spend=clone(f.a.spendLedger);
 assert.equal(old.status,'prepared');assert.equal(old.requests,undefined);for(const entry of f.attempts)assert.equal(items.inspect(f.a,f.job,entry).phase,'queued');
 f.run.status='interrupted';f.run.finishedAt=new Date().toISOString();f.step.error='controlled stop before boundary';require('../desktop/evidence-recovery.cjs').settled(f.a,f.job,f.task,f.episode,f.step);f.a.save();
 f=reboot(f,t);assert.deepEqual(f.attempts.map(v=>v.status),['queued','queued']);assert.equal(items.candidate(f.a,f.job,f.task,f.query).action,'execute');freshClaim(f);let calls=0;f.a.platformRequest=async()=>{calls++;return {sql:'select controlled recovered'};};
 const result=await agent.act(f.a,f.job,'platform_query',f.step.args),op=Object.values(f.job.executionState.operations).find(o=>o.status==='done');
 assert.equal(calls,1);assert.ok(result.results[0].sourceId);assert.notEqual(op.id,oldId);assert.notEqual(op.attemptId,oldAttempt);assert.equal(op.requests.length,1);
 assert.deepEqual(f.attempts.map(v=>v.status),['done','done']);assert.ok(f.attempts.every(v=>v.sourceId===op.sourceId&&v.operationId===op.id));
 const retired=f.job.executionState.history.find(o=>o.id===oldId);assert.equal(retired.phase,'not_dispatched');assert.equal(retired.status,'superseded');assert.equal(retired.zeroBoundaryResolution.proof.operationId,oldId);assert.equal(retired.resolvedBy,op.id);assert.equal(retired.requests,undefined);assert.deepEqual(f.a.spendLedger,spend);
 f=reboot(f,t);const current=f.job.executionState.operations[op.key];assert.equal(current.status,'done');assert.ok(f.attempts.every(v=>items.inspect(f.a,f.job,v).phase==='persisted'));assert.deepEqual(f.a.spendLedger,spend);
});
test('ACQ-2 replacement save failure rolls back retirement and sends zero; next cold attempt dispatches once',async t=>{
 let f=setup(t),old=await crashBeforeBoundary(f,t);f=reboot(f,t);freshClaim(f);const before=clone(f.job.executionState.operations[old.key]),batch=await ledger.prepareBatch(f.a,f.job),save=f.a.save.bind(f.a);let calls=0;
 f.a.platformRequest=async()=>{calls++;return {sql:'controlled recovered after disk repair'};};
 const mock=t.mock.method(f.a,'save',()=>{if(f.job.executionState.history?.some(o=>o.zeroBoundaryResolution))throw Object.assign(Error('controlled replacement ENOSPC'),{code:'ENOSPC'});return save();});
 await assert.rejects(ledger.fetch(f.a,f.job,f.query,{batch}),/controlled replacement ENOSPC/);mock.mock.restore();assert.equal(calls,0);assert.deepEqual(f.job.executionState.operations[old.key],before);assert.equal(f.job.executionState.history,undefined);
 f=reboot(f,t);freshClaim(f);f.a.platformRequest=async()=>{calls++;return {sql:'controlled recovered after disk repair'};};await agent.act(f.a,f.job,'platform_query',f.step.args);assert.equal(calls,1);assert.equal(Object.values(f.job.executionState.operations)[0].status,'done');
});
test('ACQ-2 an actual business boundary stays unknown across cold restart and a fresh claim',async t=>{
 let f=setup(t),calls=0;f.a.platformRequest=async()=>{calls++;throw Object.assign(Error('controlled crash after actual boundary'),{dispatchFailure:true});};
 const batch=await ledger.prepareBatch(f.a,f.job);await assert.rejects(ledger.fetch(f.a,f.job,f.query,{batch}),/controlled crash/);
 const original=clone(Object.values(f.job.executionState.operations)[0]),spend=clone(f.a.spendLedger);assert.equal(calls,1);assert.equal(original.requests.length,1);assert.equal(items.inspect(f.a,f.job,f.attempts[0]).phase,'unknown');
 f=reboot(f,t);const reopened=clone(f.job.executionState.operations[original.key]);assert.equal(reopened.status,'interrupted');assert.equal(reopened.phase,'dispatched');assert.deepEqual(reopened.requests,original.requests);assert.ok(reopened.interruptedAt);freshClaim(f);f.a.platformRequest=async()=>{calls++;return {};};
 await assert.rejects(agent.act(f.a,f.job,'platform_query',f.step.args),{code:'OPERATION_RECONCILIATION_REQUIRED'});assert.equal(calls,1);assert.deepEqual(f.job.executionState.operations[original.key],reopened);assert.deepEqual(f.a.spendLedger,spend);
});
test('admission inspection never initializes a new job or manufactures absent proof',()=>{
 const a={data:{agentRuns:[]}},job={id:'controlled-empty',dataPlatform:'sg-readonly'},before=clone(job);
 assert.deepEqual(ledger.unsettledForQuery(job,{op:'code',taskId:'123'}),[]);assert.equal(items.zeroBoundaryProof(a,job,{}).eligible,false);assert.deepEqual(job,before);assert.equal(job.executionState,undefined);
});
const corruptions=[
 ['missing log',f=>delete f.step.dispatch.requests],
 ['old schema',f=>delete f.step.dispatch.requestSchema],
 ['args hash drift',f=>{f.step.dispatch.argsHash='wrong';}],
 ['dispatch id drift',f=>{f.step.dispatch.id='different';}],
 ['operation key drift',(f,op)=>{delete f.job.executionState.operations[op.key];op.key='different';f.job.executionState.operations[op.key]=op;}],
 ['wrong attempt identity',f=>{f.step.evidenceAcquisition.identities[f.attempts[0].logicalKey].attemptId='different';}],
 ['missing reciprocal binding',f=>delete f.attempts[0].operationId],
 ['duplicate run',f=>f.a.data.agentRuns.push(clone(f.run))],
 ['conflicting operation history',(f,op)=>(f.job.executionState.history ||= []).push({...clone(op),status:'unknown'})],
 ['operation request',(f,op)=>{op.requests=[{requestId:'controlled-possible-send',query:clone(f.query)}];}],
 ['foreign request identity',f=>f.step.dispatch.requests.push({requestId:'controlled-wrong',query:clone(f.query),attemptId:'different',operationId:'different'})],
 ['retained response',(f,op)=>{op.responses=[{retained:true,data:{sql:'unknown'},requestId:'controlled'}];}]
];
for(const [name,change] of corruptions)test('ACQ-2 never admits prepared with '+name,async t=>{
 let f=setup(t),op=await crashBeforeBoundary(f,t);change(f,op);const before=clone(op);assert.notEqual(items.inspect(f.a,f.job,f.attempts[0]).phase,'queued');f.a.save();f=reboot(f,t);freshClaim(f);let calls=0;f.a.platformRequest=async()=>{calls++;return {};};
 const batch=await ledger.prepareBatch(f.a,f.job);await assert.rejects(ledger.fetch(f.a,f.job,f.query,{batch}),{code:'OPERATION_RECONCILIATION_REQUIRED'});assert.equal(calls,0);assert.deepEqual(f.job.executionState.operations[op.key],before);assert.equal(f.job.executionState.operations[op.key].zeroBoundaryResolution,undefined);
});
function preflight(t){
 const f=fixture(t),{a,job,task}=f;job.platformPrincipal='fixture-user';job.workRevision=task.workRevision=1;
 policy.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'controlled legacy preflight'});
 const query={op:'code',taskId:'123'},target={query,obligationId:'controlled',rootIds:['123']},attempt={...clone(target),status:'failed',at:at(3),finishedAt:at(6),error:'controlled timeout',errorCode:'TRANSIENT'};
 const episode={basis:'controlled-old',taskId:task.id,intentBasis:legacy.scope(job,task).intent,evidenceAcquisition:{requestBasis:'controlled-request',attempts:{[method.attemptKey(target)]:attempt}}};job.executionState.continuation={episodes:{[episode.basis]:episode},activeBasis:episode.basis};
 const check=policy.checkTool(a,job,'platform_query',{queries:[query]}),step={id:'controlled-step',tool:'platform_query',args:{taskId:task.id,queries:[query]},at:at(1),error:attempt.error,errorCode:'TRANSIENT',evidenceAcquisition:{taskId:task.id,episodeBasis:episode.basis,requestBasis:'controlled-request',targets:[target]}};
 step.dispatch={id:step.id,stepId:step.id,jobId:job.id,taskId:task.id,runId:'controlled-run',tool:step.tool,argsHash:hash(step.args),phase:'dispatch_started',preparedAt:at(2),requests:[{query:{op:'identity'},at:at(4),phase:'dispatch_started'}],failure:{dispatchId:step.id,stepId:step.id,runId:'controlled-run',phase:'dispatch_started',code:'TRANSIENT',message:attempt.error,at:at(5)},scopeHash:hash(legacy.scope(job,task)),policyHash:hash({policyId:check.policyId,grantRevision:check.grantRevision})};
 const run={id:'controlled-run',jobId:job.id,status:'paused',error:attempt.error,startedAt:at(0),finishedAt:at(7),steps:[step]};a.data.agentRuns.push(run);a.save();return {...f,query,attempt,episode,step,run};
}
const proof=f=>legacy.buildProof(f.a,f.job,f.task,{runId:f.run.id,stepId:f.step.id,query:f.query});
for(const field of ['at','finishedAt'])for(const value of [undefined,null,'','not-a-time','999999-01-01'])test(`ACQ-5 attempt.${field}=${String(value)} cannot create a correction`,t=>{
 const f=preflight(t);if(value===undefined)delete f.attempt[field];else f.attempt[field]=value;
 const before=clone(f.a.data),spend=clone(f.a.spendLedger),p=proof(f);assert.equal(p.eligible,false);assert.equal(p.reason,'ORIGINAL_ATTEMPT_TIME_INVALID');assert.throws(()=>legacy.prepare(f.a,f.job,f.task,p),{code:'EVIDENCE_PREFLIGHT_UNPROVEN'});assert.deepEqual(f.a.data,before);assert.deepEqual(f.a.spendLedger,spend);
});
for(const [start,end] of [[6,3],[-1,6],[1,6],[4.5,6],[3,4],[3,8],[-10,20]])test(`ACQ-5 rejects attempt window ${start}..${end}`,t=>{
 const f=preflight(t);f.attempt.at=at(start);f.attempt.finishedAt=at(end);assert.equal(proof(f).reason,'ORIGINAL_ATTEMPT_TIME_INVALID');assert.equal(f.job.executionState.evidencePreflightCorrections,undefined);
});
const timeFields=[f=>[f.run,'startedAt'],f=>[f.step,'at'],f=>[f.step.dispatch,'preparedAt'],f=>[f.step.dispatch.requests[0],'at'],f=>[f.step.dispatch.failure,'at'],f=>[f.run,'finishedAt']];
for(let index=0;index<timeFields.length;index++)for(const invalid of ['not-a-time',undefined,at(-5)])test(`ACQ-5 outer time ${index} rejects ${String(invalid)}`,t=>{
 const f=preflight(t),[object,key]=timeFields[index](f);object[key]=invalid;
 // An earlier run start is valid; make it late to test its order instead.
 if(index===0&&invalid===at(-5))object[key]=at(9);
 const p=proof(f);assert.equal(p.eligible,false);assert.ok(['TIME_ORDER_INVALID','RUN_NOT_TERMINAL'].includes(p.reason));assert.equal(f.job.executionState.evidencePreflightCorrections,undefined);
});
test('ACQ-5 finite inclusive dispatch windows remain provable and idempotent without rewriting history',t=>{
 const f=preflight(t);f.attempt.at=at(2);f.attempt.finishedAt=at(7);const before=clone(f.attempt),spend=clone(f.a.spendLedger),p=proof(f);assert.equal(p.eligible,true,p.reason);
 legacy.prepare(f.a,f.job,f.task,p);legacy.prepare(f.a,f.job,f.task,p);assert.equal(Object.keys(f.job.executionState.evidencePreflightCorrections).length,1);assert.deepEqual(f.attempt,before);assert.deepEqual(f.a.spendLedger,spend);
 const durable=JSON.parse(fs.readFileSync(f.a.file));assert.equal(Object.keys(durable.delegations.find(j=>j.id===f.job.id).executionState.evidencePreflightCorrections).length,1);
});
test('ACQ-5 prepare revalidates a previously valid proof after both original times disappear',t=>{
 const f=preflight(t),p=proof(f);assert.equal(p.eligible,true);delete f.attempt.at;delete f.attempt.finishedAt;const before=clone(f.a.data),spend=clone(f.a.spendLedger);
 assert.equal(proof(f).reason,'ORIGINAL_ATTEMPT_TIME_INVALID');assert.throws(()=>legacy.prepare(f.a,f.job,f.task,p),{code:'STATE_STALE'});assert.deepEqual(f.a.data,before);assert.deepEqual(f.a.spendLedger,spend);assert.equal(f.job.executionState.evidencePreflightCorrections,undefined);
});
