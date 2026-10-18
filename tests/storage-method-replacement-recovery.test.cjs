'use strict';
// Controlled synthetic legacy record; runtime dispatch, ledger, storage, ACL and plan are real.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,deny}=require('./root-relation-fixture.cjs');
const coral=require('./root-relation-physical-fixture.cjs');
const method=require('../desktop/evidence-storage-method.cjs'),recovery=require('../desktop/evidence-recovery.cjs');
const c=require('../desktop/continuation-control.cjs'),agent=require('../desktop/agent.cjs');
const ledger=require('../desktop/operation-ledger.cjs'),policy=require('../desktop/access-policy-store.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const clone=structuredClone,at=n=>new Date(Date.UTC(2026,9,16,10)+n*1000).toISOString();

// Real typed frontier, policy, transactions, ledger, storage and plan resolver.
// Only historical records and the explicitly denied/substituted transport are
// synthetic. No production directory is opened by these tests.
function setup(t,{roots=['123'],large=false,permissionRevision=0}={}){
 const f=fixture(t,{roots,kinds:'物理表血缘'}),{a,job,task}=f;
 job.platformPrincipal='fixture-user';job.autoAccept=false;job.workRevision=task.workRevision=1;job.executionState.permissionRevision=permissionRevision;
 const remote={principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']};
 policy.grant(a,remote,{trusted:true,actor:'user_command',command:'fixture'});
 for(const root of roots)f.source('outputs',{taskId:Number(root),outputs:[{databaseName:'db',tableName:'out',storageRegion:'sg'}]},{taskId:Number(root)});
 f.source('table_lineage',coral.data('out',['leaf']),{database:'db',table:'out'});
 const need=recovery.needs(a,job,task)[0],key=method.attemptKey(need);
 assert.ok(need);assert.equal(need.query.table,'leaf');
 const attempt={query:clone(need.query),obligationId:need.obligationId,rootIds:clone(need.rootIds),status:'failed',at:at(2),finishedAt:at(4),errorCode:'EVIDENCE_RESULT_UNAVAILABLE',error:method.LEGACY_SIZE_ERROR};
 const original={basis:'original-episode',taskId:task.id,intentBasis:c.intentBasis(job,task),evidenceAcquisition:{version:1,requestBasis:'original-request',attempts:{[key]:clone(attempt)}}};
 const episode={...clone(original),basis:'current-episode',fromValidationGrantId:'historical-grant',cycles:3,hops:2,executions:17,blocked:true,reason:'original exhausted reason',factKeys:c.factKeys(a,job,task)};
 job.executionState.continuation={version:1,activeTaskId:task.id,activeBasis:episode.basis,episodes:{[original.basis]:original,[episode.basis]:episode}};
 const check=policy.checkTool(a,job,'platform_query',{queries:[need.query]});assert.equal(check.allowed,true);
 const op={id:'original-operation',key:ledger.key(job,need.query),query:clone(need.query),requestedQuery:clone(need.query),actualQuery:clone(need.query),status:'interrupted',startedAt:at(3),interruptedAt:at(10),attempt:1,scope:job.dataPlatform,projectId:job.projectId||null,principal:job.platformPrincipal,permissionRevision,epoch:ledger.epoch(job),workRevision:1,policy:hash({policyId:check.policyId,grantRevision:check.grantRevision}),previousSourceId:null};
 job.executionState.operations[op.key]=op;
 const step={tool:'platform_query',at:at(1),args:{taskId:task.id,queries:[clone(need.query)]},evidenceAcquisition:{taskId:task.id,episodeBasis:original.basis,requestBasis:'original-request',targets:[clone(need)]},result:{results:[{query:clone(need.query),error:method.LEGACY_SIZE_ERROR}]}};
 const run={id:'original-run',jobId:job.id,status:'done',startedAt:at(0),finishedAt:at(5),steps:[step]};a.data.agentRuns.push(run);
 a.activeAgentJob=job;const spend=require('../desktop/spend.cjs').scope(a);a.activeAgentJob=null;
 Object.assign(spend,{limitUSD:200,spentUSD:170.97393881,heldUSD:3.30575550});require('../desktop/spend.cjs').persist(a);
 const audit={queries:0},out={...f,need,key,attempt,episode,original,op,step,run,remote,audit};
 function transport(){require('./helpers/platform-fixture.cjs').install(out.a);out.a.platformRequest=async args=>{
  audit.queries++;assert.deepEqual(args,require('../desktop/data-platform.cjs').command(need.query));
  const data=coral.data('leaf',['next']);if(large)data.guidEntityMap.leaf.attributes.sql='retained original '.repeat(require('../desktop/documents.cjs').maxChars);
  return data;
 };}
 out.restart=()=>{
  const {Assistant}=require('../desktop/core.cjs');out.a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});
  t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(out.a));
  out.job=out.a.data.delegations.find(j=>j.id===job.id);out.task=out.a.task(task.id);
  out.episode=out.job.executionState.continuation.episodes[episode.basis];transport();return out;
 };
 transport();a.save();return out;
}
const life=require('../desktop/dispatch-lifecycle.cjs'),items=require('../desktop/evidence-item-lifecycle.cjs');
const claims=f=>Object.values(f.job.executionState.evidenceMethodAttempts||{});
const current=f=>f.episode.evidenceAcquisition.attempts[f.key];
const accounting=f=>({cycles:f.episode.cycles,hops:f.episode.hops,executions:f.episode.executions,blocked:f.episode.blocked,spend:clone(f.a.spendLedger)});
const origin=f=>claims(f).map(v=>({key:v.key,at:v.at,method:v.method,familyKey:v.familyKey,originOperationId:v.originOperationId,proof:clone(v.proof),previousAttempt:clone(v.previousAttempt)}));
function dispatch(f,tool='platform_query'){
 life.clear(f.a,f.job);f.a.activeAgentRun=null;
 const step=c.next(f.a,f.job);assert.equal(step?.tool,tool,'the cold continuation must expose a real executable action');
 const record={id:require('node:crypto').randomUUID(),jobId:f.job.id,status:'running',startedAt:new Date().toISOString(),steps:[]};
 f.a.data.agentRuns.unshift(record);f.a.activeAgentRun=record;f.a.activeAgentJob=f.job;
 life.prepare(f.a,f.job,record,step,()=>c.started(f.a,f.job,step));
 f.step=step;f.record=record;return step;
}
function pauseAndRestart(f){
 f.record.status='paused';f.a.save();life.clear(f.a,f.job);f.a.activeAgentRun=null;f.a.activeAgentJob=null;
 f.restart();
}
async function initialBoundaryFailure(t){
 const f=setup(t);dispatch(f);f.initialOrigin=origin(f);f.initialAccounting=accounting(f);
 const save=f.a.save.bind(f.a);let rejected=false;
 f.a.save=()=>{if(!rejected&&f.step.dispatch.requests.some(r=>r.query.op!=='identity')){rejected=true;throw Object.assign(Error('controlled first business boundary ENOSPC'),{code:'ENOSPC'});}return save();};
 try{await assert.rejects(agent.act(f.a,f.job,f.step.tool,f.step.args),/controlled first business boundary ENOSPC/);}finally{f.a.save=save;}
 assert.equal(rejected,true);assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,1);
 assert.equal(f.step.dispatch.requests.filter(r=>r.query.op!=='identity').length,0,'failed boundary save rolls back before business transport');
 f.prior=clone(f.job.executionState.operations[ledger.key(f.job,f.need.query)]);
 assert.equal(f.prior.status,'prepared');assert.equal(f.prior.requests?.length||0,0);
 pauseAndRestart(f);assert.equal(items.inspect(f.a,f.job,current(f)).phase,'queued');
 assert.deepEqual(origin(f),f.initialOrigin);assert.deepEqual(accounting(f),f.initialAccounting);return f;
}
async function replacementFailure(f){
 const before=clone(f.job.executionState.operations),history=clone(f.job.executionState.history),sources=clone(f.a.data.sources);
 const step=dispatch(f),attemptId=current(f).attemptId;
 assert.deepEqual(step.args.queries,[f.need.query],'only the exact unsent query is eligible');
 const save=f.a.save.bind(f.a);let rejected=false,outcome;
 f.a.save=()=>{if(!rejected&&f.job.executionState.history.some(o=>o.zeroBoundaryResolution)){rejected=true;throw Object.assign(Error('controlled operation replacement ENOSPC'),{code:'ENOSPC'});}return save();};
 try{outcome=await agent.act(f.a,f.job,step.tool,step.args);step.result=outcome;}
 catch(error){outcome={error:error.message,code:error.code};step.error=error.message;step.errorCode=error.code;}
 finally{f.a.save=save;}
 assert.equal(rejected,true,'inject at replacement retirement/new-operation commit, not the dispatch claim');
 assert.match(JSON.stringify(outcome),/controlled operation replacement ENOSPC/);
 c.settled(f.a,f.job,step);
 assert.equal(f.audit.queries,0,'replacement failure never reaches business transport');
 assert.equal(step.dispatch.requests.filter(r=>r.query.op!=='identity').length,0);
 assert.deepEqual(f.job.executionState.operations,before);assert.deepEqual(f.job.executionState.history,history);
 assert.deepEqual(f.a.data.sources,sources);assert.deepEqual(origin(f),f.initialOrigin);assert.deepEqual(accounting(f),f.initialAccounting);
 assert.equal(current(f).attemptId,attemptId);assert.equal(current(f).operationId,undefined,'replacement rollback leaves this intermediate attempt without an operation');
 pauseAndRestart(f);
 assert.equal(claims(f).length,1);assert.deepEqual(origin(f),f.initialOrigin);assert.deepEqual(accounting(f),f.initialAccounting);
 assert.deepEqual(f.job.executionState.operations[f.prior.key],f.prior,'cold restart retains the original prepared slot byte-for-byte');
 const old=items.allAttempts(f.job).find(v=>v.attemptId===f.prior.attemptId);
 assert.equal(items.zeroBoundaryProof(f.a,f.job,old,f.job.executionState.operations[f.prior.key]).eligible,true);
 const view=items.inspect(f.a,f.job,current(f));
 assert.equal(view.phase,'queued',JSON.stringify({phase:view.phase,reason:view.reason}));
 assert.equal(c.next(f.a,f.job)?.tool,'platform_query','a proven-unsent predecessor remains actionable after replacement rollback');
 return attemptId;
}
async function finishAndAssociate(f){
 const step=dispatch(f);assert.deepEqual(step.args.queries,[f.need.query]);
 step.result=await agent.act(f.a,f.job,step.tool,step.args);c.settled(f.a,f.job,step);
 assert.equal(step.result.results.length,1);assert.equal(step.result.results[0].error,undefined);
 const sourceId=step.result.results[0].sourceId;assert.ok(sourceId);
 assert.equal(f.audit.queries,1,'only the remaining unsent business query is dispatched, exactly once');
 assert.equal(f.a.platformFixture.identityCalls,1);
 assert.equal(claims(f).length,1);assert.equal(claims(f)[0].status,'done');
 assert.deepEqual(origin(f),f.initialOrigin);assert.deepEqual(accounting(f),f.initialAccounting);
 const operation=f.job.executionState.operations[f.prior.key];assert.equal(operation.status,'done');
 assert.equal(operation.requests.length,1);assert.equal(items.readableSource(f.a,f.job,operation).id,sourceId);
 const retired=f.job.executionState.history.filter(o=>o.methodClaimId===claims(f)[0].key);
 assert.equal(retired.length,1,'failed replacement commits create no operation ordinal or history entry');
 assert.equal(retired[0].id,f.prior.id);assert.equal(retired[0].phase,'not_dispatched');assert.equal(retired[0].status,'superseded');
 assert.equal(retired[0].resolvedBy,operation.id);assert.equal(operation.attempt,f.prior.attempt+1);
 assert.equal(retired[0].zeroBoundaryResolution.proof.operationHash,hash(f.prior));
 f.record.status='done';f.record.finishedAt=new Date().toISOString();f.a.save();f.restart();
 assert.deepEqual(f.episode.evidenceAcquisition.pendingPlan.sourceIds,[sourceId]);
 const plan=dispatch(f,'plan_task');assert.deepEqual(plan.args.sourceIds,[sourceId]);assert.equal(plan.args.existingTaskId,f.task.id);
 const oldInputs=[...f.task.sourceIds];plan.result=await agent.act(f.a,f.job,plan.tool,plan.args);c.settled(f.a,f.job,plan);
 assert.equal(plan.error,undefined);assert.ok(f.task.sourceIds.includes(sourceId));assert.ok(oldInputs.every(id=>f.task.sourceIds.includes(id)));
 assert.equal(f.episode.evidenceAcquisition.pendingPlan,undefined);assert.equal(f.task.acceptedAt,undefined);
 assert.equal(f.audit.queries,1);assert.equal(f.a.platformFixture.identityCalls,0,'plan association sends no identity request');
 assert.deepEqual(origin(f),f.initialOrigin);assert.deepEqual(accounting(f),f.initialAccounting);
 f.record.status='done';f.record.finishedAt=new Date().toISOString();f.a.save();f.restart();
 assert.ok(f.task.sourceIds.includes(sourceId),'executed association survives cold restart');
 assert.equal(f.episode.evidenceAcquisition.pendingPlan,undefined);assert.equal(f.audit.queries,1);
 assert.deepEqual(origin(f),f.initialOrigin);assert.deepEqual(accounting(f),f.initialAccounting);
}
test('same claim replacement ENOSPC: cold recovery preserves original proof and counters, dispatches only unsent query once, and executes plan association',async t=>{
 const f=await initialBoundaryFailure(t);await replacementFailure(f);await finishAndAssociate(f);
});
test('same claim two consecutive replacement ENOSPC: operationless intermediate attempts cold-resume to one business dispatch and executed plan association',async t=>{
 const f=await initialBoundaryFailure(t),first=await replacementFailure(f),second=await replacementFailure(f);
 assert.notEqual(first,second);
 for(const id of [first,second]){const entry=items.allAttempts(f.job).find(v=>v.attemptId===id);assert.ok(entry);assert.equal(entry.operationId,undefined);}
 assert.equal(current(f).continuedFromAttemptId,first);assert.equal(claims(f)[0].preparedContinuations.length,2);
 await finishAndAssociate(f);
});
const mutations=[
 ['handoff link dispatch tampered',f=>claims(f)[0].preparedContinuations.at(-1).dispatch.id='wrong-dispatch'],
 ['handoff proof hash tampered',f=>claims(f)[0].preparedContinuations.at(-1).proof.dispatchHash='wrong-proof'],
 ['handoff predecessor link missing',f=>current(f).continuedFromAttemptId='missing-attempt'],
 ['handoff self cycle',f=>current(f).continuedFromAttemptId=current(f).attemptId],
 ['handoff two-attempt cycle',f=>{const previous=items.allAttempts(f.job).find(v=>v.attemptId===current(f).continuedFromAttemptId);previous.continuedFromAttemptId=current(f).attemptId;}],
 ['additional unknown operation',f=>f.job.executionState.history.push({...clone(claims(f)[0].proof.operation),id:'unproven-extra-operation',status:'unknown'})]
];
for(const [name,mutate] of mutations)test('same claim replacement cold recovery rejects '+name+' without dispatch or accounting changes',async t=>{
 const f=await initialBoundaryFailure(t);await replacementFailure(f);await replacementFailure(f);
 mutate(f);f.a.save();f.restart();
 const before=clone({operations:f.job.executionState.operations,history:f.job.executionState.history,claims:claims(f),sources:f.a.data.sources,inputs:f.task.sourceIds,accounting:accounting(f)});
 const acl=fs.readFileSync(policy.locations(f.a).store),view=items.inspect(f.a,f.job,current(f));
 assert.notEqual(view.phase,'queued','tampered/unknown history cannot prove zero boundaries');
 assert.equal(c.next(f.a,f.job),null,'rejected handoff cannot grant a new query or plan');
 assert.deepEqual({operations:f.job.executionState.operations,history:f.job.executionState.history,claims:claims(f),sources:f.a.data.sources,inputs:f.task.sourceIds,accounting:accounting(f)},before);
 assert.deepEqual(fs.readFileSync(policy.locations(f.a).store),acl);assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);
 assert.equal(f.episode.evidenceAcquisition.pendingPlan,undefined);assert.equal(f.task.acceptedAt,undefined);
 t.diagnostic(JSON.stringify({phase:view.phase,reason:view.reason,businessRequests:f.audit.queries,identityRequests:f.a.platformFixture.identityCalls}));
});
