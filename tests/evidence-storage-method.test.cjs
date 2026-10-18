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
const eligible=f=>method.eligibility(f.a,f.job,f.task,f.episode,f.need);
const claims=f=>Object.values(f.job.executionState.evidenceMethodAttempts||{});
function start(f){const step=c.next(f.a,f.job);assert.equal(step?.tool,'platform_query');step.at=new Date().toISOString();c.started(f.a,f.job,step);return step;}
async function query(f,{settle=true}={}){const step=start(f);step.result=await agent.act(f.a,f.job,step.tool,step.args);if(settle)c.settled(f.a,f.job,step);return step;}
const accounting=f=>({cycles:f.episode.cycles,hops:f.episode.hops,executions:f.episode.executions,blocked:f.episode.blocked,spend:clone(f.a.spendLedger)});

test('pure exact proof and peek expose one fixed method without consuming or changing accounting',t=>{
 const f=setup(t),before=clone(f.a.data),spend=clone(f.a.spendLedger);t.mock.method(f.a,'save',deny);
 const result=eligible(f);assert.equal(result.eligible,true,result.reason);assert.equal(method.METHOD,'coral-structural-v1');
 assert.equal(result.proof.operation.id,f.op.id);assert.deepEqual(result.proof.previousAttempt,f.attempt);assert.equal(result.proof.runId,f.run.id);
 for(let i=0;i<2;i++){assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),true);assert.equal(c.peek(f.a,f.job,f.task).phase,'evidence');}
 result.proof.previousAttempt.error='changed returned clone';assert.equal(f.episode.evidenceAcquisition.attempts[f.key].error,method.LEGACY_SIZE_ERROR);
 assert.deepEqual(f.a.data,before);assert.deepEqual(f.a.spendLedger,spend);assert.equal(f.audit.queries,0);
});

for(const [name,change] of [
 ['similar error',f=>f.episode.evidenceAcquisition.attempts[f.key].error+='。'],
 ['wrong typed error',f=>f.episode.evidenceAcquisition.attempts[f.key].errorCode='AUTH_REQUIRED'],
 ['new method failure recursion',f=>f.episode.evidenceAcquisition.attempts[f.key].previousAttempt=clone(f.attempt)],
 ['run removed',f=>f.a.data.agentRuns=[]],
 ['model error text',f=>{f.step.tool='advance_task';f.step.error=method.LEGACY_SIZE_ERROR;}],
 ['run another job',f=>f.run.jobId='other'],
 ['unfinished run',f=>f.run.status='running'],
 ['result missing',f=>f.step.result.results=[]],
 ['result mismatch',f=>f.step.result.results[0].error+='!'],
 ['fake source result',f=>f.step.result.results[0].sourceId='fake'],
 ['wrong operation result',f=>f.step.result.results[0].operationId='other'],
 ['wrong step query',f=>f.step.args.queries[0].table='other'],
 ['wrong original episode',f=>f.step.evidenceAcquisition.episodeBasis='other'],
 ['original attempt mismatch',f=>f.original.evidenceAcquisition.attempts[f.key].at=at(-20)],
 ['operation outside step interval',f=>f.op.startedAt=at(6)],
 ['operation changed to AUTH',f=>Object.assign(f.op,{status:'failed',errorCode:'AUTH_REQUIRED'})],
 ['operation changed to NOT_FOUND',f=>Object.assign(f.op,{status:'failed',errorCode:'NOT_FOUND'})],
 ['operation running unknown',f=>f.op.status='running'],
 ['operation done',f=>f.op.status='done'],
 ['operation wrong account',f=>f.op.principal='other'],
 ['job wrong account',f=>f.job.platformPrincipal='other'],
 ['operation wrong scope',f=>f.op.scope='other'],
 ['operation wrong local project',f=>f.op.projectId='other'],
 ['operation actual query drift',f=>f.op.actualQuery.table='other'],
 ['operation fabricated key',f=>f.op.key='fake'],
 ['permission revision changed',f=>f.job.executionState.permissionRevision++],
 ['requirements changed',f=>f.job.goal+=' another requirement'],
 ['withdrawn gap',f=>f.source('table_lineage',coral.data('leaf'),{database:'db',table:'leaf'})],
 ['unsupported entity',f=>f.need.query.entityType='ClickHouse'],
 ['fake typed gap',f=>f.need.identity.table='other'],
 ['pause',f=>f.job.executionPaused=true],
 ['revoked',f=>policy.revoke(f.a,f.remote,{trusted:true,actor:'user_command',command:'fixture'})],
 ['budget exhausted',f=>f.a.spendLedger.scopes['job:'+f.job.id].spentUSD=200],
 ['unknown model spend',f=>f.a.spendLedger.scopes['job:'+f.job.id].unreservedCalls=1],
 ['unknown external write',f=>f.a.data.agentActions.push({id:'unknown-write',jobId:f.job.id,taskId:f.task.id,tool:'lark_update',status:'uncertain'})],
 ['accepted boundary',f=>{const b=require('../desktop/platform-boundaries.cjs');f.job.executionState.acceptedBoundaries=[{version:1,id:'accepted',identity:b.identity(f.job,f.need.query),query:clone(f.need.query),coverage:'query',decision:{decisionId:'user-accepted'}}];}],
 ['later operation despite stale slot',f=>{f.job.executionState.history=[{...clone(f.op),id:'later',startedAt:at(20),status:'failed',errorCode:'NOT_FOUND'}];}],
 ['later real result',f=>f.a.data.agentRuns.push({id:'later',jobId:f.job.id,steps:[{tool:'platform_query',at:at(30),result:{results:[{query:clone(f.need.query),error:'denied',errorCode:'AUTH_REQUIRED'}]}}]})]
])test('reject '+name+' without mutation or network',t=>{
 const f=setup(t);change(f);const before=clone(f.a.data),spend=clone(f.a.spendLedger);t.mock.method(f.a,'save',deny);
 assert.equal(eligible(f).eligible,false,name);assert.deepEqual(f.a.data,before);assert.deepEqual(f.a.spendLedger,spend);assert.equal(f.audit.queries,0);
});

test('dedup identity excludes root order, run/episode names and duplicate root directions',t=>{
 const f=setup(t,{roots:['123','456']}),first=eligible(f);assert.equal(first.eligible,true,first.reason);
 f.need.rootIds.reverse();f.run.id='renamed-run';f.episode.basis='renamed-current';
 assert.equal(eligible(f).claimKey,first.claimKey);
 const before=accounting(f),step=start(f),claim=claims(f)[0];
 assert.equal(step.args.queries.length,1);assert.equal(claim.key,first.claimKey);assert.deepEqual(claim.previousAttempt,f.attempt);
 assert.deepEqual(accounting(f),before);assert.equal(claim.status,'started');assert.equal(claim.errorCode,'EVIDENCE_METHOD_RESULT_UNKNOWN');
 const onDisk=JSON.parse(fs.readFileSync(f.a.file));assert.equal(onDisk.delegations.find(j=>j.id===f.job.id).executionState.evidenceMethodAttempts[claim.key].status,'started');
 assert.equal(onDisk.tasks.find(t=>t.id===f.task.id).evidenceRequest.basis,claim.requestBasis);
 assert.throws(()=>c.started(f.a,f.job,step),{code:'EVIDENCE_METHOD_ALREADY_CLAIMED'});
 f.episode.evidenceAcquisition={version:1,attempts:{}};
 assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),false,'new episode/root grouping cannot use ordinary first-attempt path');
 assert.equal(claims(f).length,1);assert.equal(f.audit.queries,0);
});

for(const point of ['request','claim'])test(point+' save failure rolls back and permits zero identity/data requests',async t=>{
 const f=setup(t),before=accounting(f);let step;
 if(point==='claim')step=c.next(f.a,f.job);
 t.mock.method(f.a,'save',()=>{throw Error('fixture failed save');});
 await assert.rejects(async()=>{step ||= c.next(f.a,f.job);c.started(f.a,f.job,step);await agent.act(f.a,f.job,step.tool,step.args);},/fixture failed save/);
 assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);assert.equal(claims(f).length,0);
 assert.deepEqual(f.episode.evidenceAcquisition.attempts[f.key],f.attempt);assert.deepEqual(accounting(f),before);
 if(point==='request')assert.equal(f.task.evidenceRequest,undefined);else assert.ok(f.task.evidenceRequest);
});

test('claim crash/restart retains original request and proof, never reissues an unknown operation',t=>{
 const f=setup(t),before=accounting(f);start(f);const claim=clone(claims(f)[0]),request=clone(f.task.evidenceRequest);f.restart();
 for(let i=0;i<2;i++){assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),false);assert.equal(c.next(f.a,f.job),null);f.a.save();f.restart();}
 assert.deepEqual(claims(f),[claim]);assert.deepEqual(f.task.evidenceRequest,request);assert.deepEqual(accounting(f),before);assert.equal(f.audit.queries,0);
});

test('durable large structural receipt recovers after cold start to the original atomic plan, zero requery',async t=>{
 const f=setup(t,{large:true}),before=accounting(f),old=clone(f.original);
 const step=await query(f,{settle:false});assert.equal(f.audit.queries,1);assert.ok(step.result.results[0].sourceId,JSON.stringify(step.result));
 const source=f.a.data.sources.find(s=>s.id===step.result.results[0].sourceId);
 assert.equal(claims(f)[0].method,method.METHOD);assert.equal(method.METHOD,'coral-structural-v1');
 assert.equal(JSON.parse(source.content).platformResult.format,method.V2_METHOD);assert.equal(method.V2_METHOD,'platform-chunks-v2');assert.ok(source.platformArchive);
 const request=clone(f.task.evidenceRequest);f.restart();const pure=clone(f.a.data);
 assert.equal(method.currentClaim(f.a,f.job,f.task,claims(f)[0]),true,'original request/context must survive restart');
 assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),true);assert.deepEqual(f.a.data,pure);
 const plan=c.next(f.a,f.job);assert.equal(plan?.tool,'plan_task');assert.equal(plan.args.evidenceResolution.basis,request.basis);
 assert.deepEqual(plan.args.sourceIds,[source.id]);assert.equal(claims(f)[0].status,'done');
 f.restart();assert.deepEqual(c.next(f.a,f.job).args,plan.args);assert.equal(f.audit.queries,1);
 c.started(f.a,f.job,plan);plan.result=await agent.act(f.a,f.job,plan.tool,plan.args);c.settled(f.a,f.job,plan);
 assert.ok(f.task.sourceIds.includes(source.id));assert.equal(f.task.evidenceRequest,undefined);assert.ok(f.task.lastEvidenceResolution.recoveryProof);
 assert.deepEqual(f.job.executionState.continuation.episodes[old.basis],old);
 for(const k of ['cycles','hops','executions'])assert.equal(f.episode[k],before[k]);assert.deepEqual(f.a.spendLedger,before.spend);assert.equal(f.audit.queries,1);
});

for(const change of ['request','requirements','owner','permission','source','query','undurable'])test('saved receipt cannot associate after '+change+' drift',async t=>{
 const f=setup(t);await query(f,{settle:false});
 if(change==='request')f.task.evidenceRequest.basis+='changed';
 if(change==='requirements')f.job.goal+=' changed';
 if(change==='owner')f.task.agentJobId='other';
 if(change==='permission')policy.revoke(f.a,f.remote,{trusted:true,actor:'user_command',command:'fixture'});
 if(change==='source'){const source=f.a.data.sources.find(s=>f.task.sourceIds.includes(s.id)),snapshot=JSON.parse(source.content);snapshot.data.outputs=[];source.content=JSON.stringify(snapshot);}
 if(change==='query')Object.values(f.job.executionState.operations).find(o=>o.status==='done').actualQuery.table='other';
 if(change==='undurable'){
  const disk=JSON.parse(fs.readFileSync(f.a.file)),j=disk.delegations.find(j=>j.id===f.job.id);
  j.executionState.operations[f.op.key]=clone(f.op);fs.writeFileSync(f.a.file,JSON.stringify(disk));
 }else f.a.save();
 const before=clone(f.a.data);assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),false);assert.deepEqual(f.a.data,before);
 assert.equal(recovery.next(f.a,f.job,f.task,f.episode),null);assert.equal(f.audit.queries,1);assert.equal(f.episode.cycles,3);assert.equal(claims(f)[0].status,'started');
});

test('new method failure records its typed diagnostic and preserves failed legacy proof across restart',async t=>{
 const f=setup(t),before=accounting(f);f.a.platformRequest=async()=>{f.audit.queries++;throw Object.assign(Error('synthetic permission denial'),{code:'AUTH_REQUIRED',status:403});};
 const step=await query(f);assert.equal(step.result.results[0].errorCode,'AUTH_REQUIRED');
 assert.equal(claims(f)[0].status,'failed');assert.equal(claims(f)[0].errorCode,'AUTH_REQUIRED');assert.deepEqual(claims(f)[0].previousAttempt,f.attempt);
 f.restart();assert.equal(c.next(f.a,f.job),null);assert.equal(eligible(f).eligible,false);assert.deepEqual(accounting(f),before);assert.equal(f.audit.queries,1);
});

test('a forged step source cannot replace the durable operation receipt or clear the request',t=>{
 const f=setup(t),step=start(f);step.result={results:[{query:clone(f.need.query),sourceId:f.task.sourceIds[0]}]};c.settled(f.a,f.job,step);
 assert.equal(claims(f)[0].status,'started');assert.equal(f.episode.evidenceAcquisition.pendingPlan,undefined);assert.ok(f.task.evidenceRequest);assert.equal(f.episode.cycles,3);
});

test('plan-only reopen preserves the established typed evidence request',async t=>{
 const f=setup(t);c.next(f.a,f.job);const request=clone(f.task.evidenceRequest);
 await agent.act(f.a,f.job,'plan_task',{existingTaskId:f.task.id,key:f.task.agentKey,title:f.task.title,criteria:f.task.criteria,reason:'reopen same draft',sourceIds:f.task.sourceIds});
 assert.deepEqual(f.task.evidenceRequest,request);assert.equal(f.episode.cycles,3);assert.equal(f.audit.queries,0);
});

test('batch projection computes typed needs once and never caches across a state change',t=>{
 const f=setup(t),relations=require('../desktop/relation-obligations.cjs'),original=relations.evidenceNeeds;let reads=0;
 t.mock.method(relations,'evidenceNeeds',(...args)=>{reads++;return original(...args);});
 assert.equal(method.project(f.a,f.job,f.task,f.episode)[0].eligible,true);assert.equal(reads,1);
 const step=c.next(f.a,f.job);assert.equal(reads,2);c.started(f.a,f.job,step);assert.equal(reads,3);
 assert.equal(method.project(f.a,f.job,f.task,f.episode)[0].eligible,false);assert.equal(reads,4);
});

test('cold receipt recovery recomputes typed needs after its actual claim commit',async t=>{
 const f=setup(t);await query(f,{settle:false});f.restart();
 const relations=require('../desktop/relation-obligations.cjs'),original=relations.evidenceNeeds,projections=[];
 t.mock.method(relations,'evidenceNeeds',(...args)=>{
  projections.push({claim:claims(f)[0].status,pending:!!f.episode.evidenceAcquisition.pendingPlan});
  return original(...args);
 });
 const before=accounting(f),step=c.next(f.a,f.job);
 assert.equal(step.tool,'plan_task');
 assert.deepEqual(projections,[{claim:'started',pending:false},{claim:'done',pending:true}]);
 assert.equal(f.audit.queries,1);assert.deepEqual(accounting(f),before);
});

test('response save failure leaves an unknown consumed claim, including after cold restart',async t=>{
 const f=setup(t),before=accounting(f),sources=clone(f.a.data.sources),step=start(f),claim=clone(claims(f)[0]),save=f.a.save.bind(f.a);
 // Fail at the actual response-persistence boundary. A failed final source
 // commit followed by a durable failure receipt is a known local failure;
 // this case specifically retains the unknown response/consumed claim path.
 t.mock.method(f.a,'save',()=>{if(Object.values(f.job.executionState.operations).some(o=>o.responses?.length))throw Error('fixture response save failed');return save();});
 await assert.rejects(agent.act(f.a,f.job,step.tool,step.args),{code:'LOCAL_RESULT_STORAGE',stopBatch:true});assert.equal(f.audit.queries,1);
 assert.deepEqual(f.a.data.sources,sources);assert.equal(f.episode.evidenceAcquisition.pendingPlan,undefined);
 c.settled(f.a,f.job,step);assert.equal(claims(f)[0].status,'started');assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),false);
 const consumed=claims(f)[0];assert.equal(consumed.key,claim.key);assert.deepEqual(consumed.proof,claim.proof);assert.deepEqual(consumed.previousAttempt,claim.previousAttempt);
 assert.equal(ledger.eligibility(f.job,Object.values(f.job.executionState.operations).find(o=>o.id===consumed.operationId)).action,'reconcile');
 assert.deepEqual(accounting(f),before);
 f.restart();assert.equal(c.next(f.a,f.job),null);assert.equal(claims(f).length,1);assert.equal(claims(f)[0].key,claim.key);assert.equal(claims(f)[0].errorCode,'EVIDENCE_METHOD_RESULT_UNKNOWN');assert.equal(f.audit.queries,1);assert.deepEqual(accounting(f),before);
});

test('pending-plan save failure rolls back to durable receipt and resumes it without another query',async t=>{
 const f=setup(t);await query(f,{settle:false});const before=clone(f.a.data);
 const save=t.mock.method(f.a,'save',()=>{throw Error('fixture pending plan save failed');});
 assert.throws(()=>c.next(f.a,f.job),/pending plan save failed/);assert.deepEqual(f.a.data,before);assert.equal(claims(f)[0].status,'started');
 save.mock.restore();f.restart();const step=c.next(f.a,f.job);assert.equal(step.tool,'plan_task');assert.equal(claims(f)[0].status,'done');assert.equal(f.audit.queries,1);
});

test('a second storage-size failure cannot recursively claim the repaired method',async t=>{
 const f=setup(t);f.a.platformRequest=async()=>{f.audit.queries++;throw Object.assign(Error(method.LEGACY_SIZE_ERROR),{code:'INVALID_PLATFORM_RESPONSE',diagnostics:{stage:'storage',reason:'structural_limit'}});};
 const step=await query(f);assert.equal(step.result.results[0].errorCode,'INVALID_PLATFORM_RESPONSE');assert.equal(claims(f)[0].status,'failed');
 assert.equal(Object.values(f.job.executionState.operations)[0].receipt.diagnostics.reason,'structural_limit');
 f.restart();assert.equal(c.next(f.a,f.job),null);assert.equal(claims(f).length,1);assert.equal(f.audit.queries,1);assert.equal(f.episode.cycles,3);
});

for(const variant of ['legacy key','other principal','other scope','other permission revision'])test('review F1: '+variant+' history coexists with the unique current receipt across cold association',async t=>{
 const f=setup(t,{permissionRevision:variant==='other permission revision'?1:0}),before=accounting(f);let unrelated;
 if(variant==='legacy key'){
  delete f.job.executionState.operations[f.op.key];
  f.op.key=hash({...method.scope(f.job),request:require('../desktop/data-platform.cjs').command(f.need.query)});
  f.job.executionState.operations[f.op.key]=f.op;
 }else if(variant==='other permission revision'){
  unrelated={...clone(f.op),id:'old-permission-operation',key:hash({...method.scope(f.job),request:require('../desktop/data-platform.cjs').command(f.need.query)}),permissionRevision:0};
  // This tests association of an already durable current receipt. An unproved
  // old interrupted request cannot authorize obtaining that receipt anew just
  // because its permission revision differs (covered separately below).
 }else{
  unrelated={...clone(f.op),id:'unrelated-retained-operation',key:'unrelated-retained-key',...(variant==='other principal'?{principal:'other-user'}:{scope:'other-region'})};
  f.job.executionState.operations[unrelated.key]=clone(unrelated);
 }
 f.a.save();assert.equal(eligible(f).eligible,true);
 const step=await query(f,{settle:false}),id=step.result.results[0].sourceId;assert.ok(id);assert.equal(f.audit.queries,1);
 const current=Object.values(f.job.executionState.operations).find(o=>o.sourceId===id),responseProof=clone(current.responseProof);
 assert.equal(current.status,'done');assert.equal(current.receipt.storageValidated,true);assert.deepEqual(current.receipt.responseProof,responseProof);
 assert.equal(current.requests.length,1);assert.equal(current.requests[0].operationId,current.id);assert.equal(current.requests[0].attemptId,current.attemptId);assert.equal(responseProof.requestId,current.requests[0].requestId);assert.equal(responseProof.requestHash,hash(current.requests[0]));
 const source=f.a.data.sources.find(s=>s.id===id);assert.equal(responseProof.dataHash,require('../desktop/platform-result.cjs').dataDigest(JSON.parse(source.content),source));
 if(variant==='other permission revision'){f.job.executionState.operations[unrelated.key]=clone(unrelated);f.a.save();}
 const prior=clone(claims(f)[0].proof.operation);
 f.restart();assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),true);
 assert.deepEqual(f.job.executionState.operations[current.key].responseProof,responseProof);
 const plan=c.next(f.a,f.job);assert.equal(plan.tool,'plan_task');assert.deepEqual(plan.args.sourceIds,[id]);
 if(variant==='legacy key'){const retained=f.job.executionState.operations[prior.key];assert.equal(retained.status,'superseded');assert.equal(retained.resolvedBy,claims(f)[0].operationId);}
 else assert.deepEqual(f.job.executionState.operations[unrelated.key],unrelated);
 c.started(f.a,f.job,plan);plan.result=await agent.act(f.a,f.job,plan.tool,plan.args);assert.ok(!plan.error);c.settled(f.a,f.job,plan);
 assert.ok(f.task.sourceIds.includes(id));assert.equal(f.task.evidenceRequest,undefined);assert.deepEqual(f.job.executionState.history.find(o=>o.id===prior.id),prior);
 assert.equal(f.a.platformFixture.identityCalls,0);f.restart();assert.ok(f.task.sourceIds.includes(id));assert.equal(f.audit.queries,1);assert.equal(claims(f).length,1);assert.equal(f.episode.cycles,before.cycles);assert.deepEqual(f.a.spendLedger,before.spend);
});
test('review F1: another permission revision never proves an old interrupted request was not sent',async t=>{
 const f=setup(t,{permissionRevision:1}),before=accounting(f),sources=clone(f.a.data.sources);
 const old={...clone(f.op),id:'old-permission-operation',key:hash({...method.scope(f.job),request:require('../desktop/data-platform.cjs').command(f.need.query)}),permissionRevision:0};
 f.job.executionState.operations[old.key]=clone(old);f.a.save();assert.equal(eligible(f).eligible,true);
 await assert.rejects(query(f,{settle:false}),error=>{
  assert.equal(error.code,'OPERATION_RECONCILIATION_REQUIRED');assert.equal(error.stopBatch,true);
  assert.deepEqual(error.decision,{action:'reconcile',reason:'ATTEMPT_IDENTITY_UNPROVEN',operationId:old.id});return true;
 });
 assert.equal(f.audit.queries,0);assert.deepEqual(f.a.data.sources,sources);assert.deepEqual(f.job.executionState.operations[old.key],old);assert.deepEqual(accounting(f),before);
 assert.ok(Object.values(f.job.executionState.operations).every(o=>o.status!=='done'));assert.equal(claims(f).length,1);assert.equal(claims(f)[0].status,'started');
 f.restart();assert.equal(c.next(f.a,f.job),null);assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);assert.deepEqual(f.job.executionState.operations[old.key],old);assert.deepEqual(accounting(f),before);
});
for(const variant of ['live ambiguity','wrong key','wrong attempt','wrong policy'])test('review F1: '+variant+' cannot replace the bound successor receipt',async t=>{
 const f=setup(t);await query(f,{settle:false});const op=Object.values(f.job.executionState.operations).find(o=>o.status==='done');
 if(variant==='live ambiguity'){const other={...clone(op),id:'ambiguous-successor',key:'ambiguous-slot'};f.job.executionState.operations[other.key]=other;}
 if(variant==='wrong key'){delete f.job.executionState.operations[op.key];op.key='wrong-key';f.job.executionState.operations[op.key]=op;}
 if(variant==='wrong attempt')op.attempt++;
 if(variant==='wrong policy')op.policy='different-policy';
 f.a.save();f.restart();assert.equal(recovery.hasWork(f.a,f.job,f.task,f.episode),false);assert.equal(c.next(f.a,f.job),null);
 assert.equal(f.episode.cycles,3);assert.ok(f.task.evidenceRequest);assert.equal(claims(f)[0].status,'started');assert.equal(f.audit.queries,1);
});

for(const tool of ['verify_content','advance_task','read_source','plan_task','platform_query'])test('dispatch ownership: unprepared '+tool+' cannot prepare or recover evidence',t=>{
 const f=setup(t),before=clone(f.a.data),spend=clone(f.a.spendLedger),disk=fs.readFileSync(f.a.file,'utf8');t.mock.method(f.a,'save',deny);
 const step={tool,args:{taskId:f.task.id,...(tool==='platform_query'?{queries:[clone(f.need.query)]}:{})}};
 assert.equal(recovery.started(f.a,f.job,f.task,f.episode,step),false);assert.deepEqual(f.a.data,before);assert.deepEqual(f.a.spendLedger,spend);assert.equal(fs.readFileSync(f.a.file,'utf8'),disk);assert.equal(f.audit.queries,0);
});
for(const drift of ['basis','arguments','tool'])test('dispatch ownership: prepared '+drift+' drift cannot consume another route',t=>{
 const f=setup(t),step=c.next(f.a,f.job);
 if(drift==='basis')f.task.evidenceRequest.basis+='changed';
 if(drift==='arguments')step.args.queries[0].table='other';
 if(drift==='tool')step.tool='plan_task';
 const before=clone(f.a.data),spend=clone(f.a.spendLedger),disk=fs.readFileSync(f.a.file,'utf8');t.mock.method(f.a,'save',deny);
 assert.equal(recovery.started(f.a,f.job,f.task,f.episode,step),false);assert.deepEqual(f.a.data,before);assert.deepEqual(f.a.spendLedger,spend);assert.equal(fs.readFileSync(f.a.file,'utf8'),disk);assert.equal(claims(f).length,0);
});
test('dispatch ownership: pending durable receipt is not reconciled by a non-evidence check',async t=>{
 const f=setup(t);await query(f,{settle:false});f.restart();assert.equal(claims(f)[0].status,'started');
 const before=clone(f.a.data),spend=clone(f.a.spendLedger),disk=fs.readFileSync(f.a.file,'utf8');t.mock.method(f.a,'save',deny);
 assert.equal(recovery.started(f.a,f.job,f.task,f.episode,{tool:'verify_content',args:{taskId:f.task.id}}),false);
 assert.deepEqual(f.a.data,before);assert.deepEqual(f.a.spendLedger,spend);assert.equal(fs.readFileSync(f.a.file,'utf8'),disk);assert.equal(f.episode.evidenceAcquisition.pendingPlan,undefined);assert.equal(f.audit.queries,1);
});

function dispatchFixture(t){
 const f=setup(t),life=require('../desktop/dispatch-lifecycle.cjs'),step=c.next(f.a,f.job),record={id:'new-dispatch-run',jobId:f.job.id,status:'running',steps:[]};
 f.a.data.agentRuns.unshift(record);f.a.activeAgentRun=record;f.a.activeAgentJob=f.job;
 life.prepare(f.a,f.job,record,step,()=>c.started(f.a,f.job,step));
 t.after(()=>life.clear(f.a,f.job));return {...f,life,step,record};
}
test('dispatch transaction: no durable claim may precede its exact run step',t=>{
 const f=setup(t),life=require('../desktop/dispatch-lifecycle.cjs'),step=c.next(f.a,f.job),record={id:'atomic-dispatch-run',jobId:f.job.id,steps:[]};
 f.a.data.agentRuns.unshift(record);f.a.activeAgentRun=record;
 const save=f.a.save.bind(f.a);let count=0;
 t.mock.method(f.a,'save',()=>{count++;assert.equal(record.steps[0],step);assert.equal(claims(f)[0].dispatch.id,step.dispatch.id);save();});
 life.prepare(f.a,f.job,record,step,()=>c.started(f.a,f.job,step));assert.equal(count,1);life.clear(f.a,f.job);
});
test('dispatch transaction: failed atomic claim save rolls back both step and claim before transport',t=>{
 const f=setup(t),life=require('../desktop/dispatch-lifecycle.cjs'),step=c.next(f.a,f.job),record={id:'failed-dispatch-run',jobId:f.job.id,steps:[]};
 f.a.data.agentRuns.unshift(record);f.a.activeAgentRun=record;t.mock.method(f.a,'save',()=>{throw Error('cannot save prepared');});
 assert.throws(()=>life.prepare(f.a,f.job,record,step,()=>c.started(f.a,f.job,step)),/cannot save prepared/);
 assert.equal(record.steps.length,0);assert.equal(claims(f).length,0);assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);
});
for(const [label,change] of [
 ['task',f=>f.step.dispatch.taskId='other'],['args',f=>f.step.args.queries[0].table='other'],
 ['principal',f=>f.job.platformPrincipal='other'],['project',f=>f.job.projectId='other'],
 ['permission',f=>f.job.executionState.permissionRevision++],['goal',f=>f.job.goal+='changed'],
 ['source version',f=>f.task.sourceIds=[]],['pause',f=>f.job.executionPaused=true],
 ['budget',f=>f.a.spendLedger.scopes['job:'+f.job.id].spentUSD=200],
 ['policy',f=>policy.revoke(f.a,f.remote,{trusted:true,actor:'user_command',command:'fixture'})]
])test('same dispatch rejects changed '+label+' before identity',async t=>{
 const f=dispatchFixture(t);change(f);await assert.rejects(()=>agent.act(f.a,f.job,f.step.tool,f.step.args));
 assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);assert.equal(claims(f).length,1);assert.equal(claims(f)[0].status,'started');
});
test('dispatch start save failure sends nothing and cold resume completes the same zero-boundary claim',async t=>{
 let f=dispatchFixture(t);const before=accounting(f),old=clone(claims(f)[0]);t.mock.method(f.a,'save',()=>{throw Error('cannot save dispatch boundary');});
 await assert.rejects(()=>agent.act(f.a,f.job,f.step.tool,f.step.args),/cannot save dispatch boundary/);
 assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);assert.equal(f.step.dispatch.phase,'prepared');
 f=f.restart();assert.equal(c.next(f.a,f.job).tool,'platform_query');assert.equal(claims(f).length,1);assert.deepEqual(accounting(f),before);
 f.job.maxActions=1;f.a.save();await agent.run(f.a,f.job.id);
 assert.equal(f.audit.queries,1);assert.equal(f.a.platformFixture.identityCalls,1);
 assert.equal(claims(f).length,1);const current=claims(f)[0];assert.equal(current.status,'done');
 for(const field of ['key','method','at','proof','previousAttempt'])assert.deepEqual(current[field],old[field]);
 assert.deepEqual(accounting(f),before);assert.equal(f.episode.evidenceAcquisition.pendingPlan.sourceIds.length,1);
 f.restart();assert.equal(claims(f).length,1);assert.equal(claims(f)[0].status,'done');assert.equal(f.audit.queries,1);assert.equal(c.next(f.a,f.job).tool,'plan_task');
});
test('dispatch start save failure with missing boundary schema remains unresolved after cold restart',async t=>{
 let f=dispatchFixture(t);const before=accounting(f),recordId=f.record.id;t.mock.method(f.a,'save',()=>{throw Error('cannot save dispatch boundary');});
 await assert.rejects(()=>agent.act(f.a,f.job,f.step.tool,f.step.args),/cannot save dispatch boundary/);
 assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);
 f=f.restart();delete f.a.data.agentRuns.find(r=>r.id===recordId).steps[0].dispatch.requestSchema;f.a.save();f.restart();
 assert.equal(c.next(f.a,f.job),null);assert.equal(claims(f).length,1);assert.equal(claims(f)[0].status,'started');
 assert.equal(f.audit.queries,0);assert.equal(f.a.platformFixture.identityCalls,0);assert.deepEqual(accounting(f),before);
});
test('pause after identity response still blocks first business request',async t=>{
 const f=dispatchFixture(t);let identities=0;Object.defineProperty(f.a,'platformRequest',{configurable:true,value:async args=>{
  assert.deepEqual(args,require('../desktop/data-platform.cjs').command({op:'identity'}));identities++;f.job.executionPaused=true;return {username:'fixture-user'};
 }});
 await assert.rejects(()=>agent.act(f.a,f.job,f.step.tool,f.step.args));assert.equal(identities,1);assert.equal(f.audit.queries,0);
 assert.equal(f.step.dispatch.phase,'dispatch_started');assert.equal(claims(f)[0].status,'started');
});

for(const point of ['query save','budget after identity'])test('local '+point+' is control flow, never a fabricated platform receipt',async t=>{
 const f=dispatchFixture(t);let identities=0,queries=0;
 Object.defineProperty(f.a,'platformRequest',{configurable:true,value:async args=>{
  if(JSON.stringify(args)===JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'}))){identities++;if(point==='budget after identity')f.a.spendLedger.scopes['job:'+f.job.id].spentUSD=200;return {username:'fixture-user'};}
  queries++;throw Error('must not reach business transport');
 }});
 const save=f.a.save.bind(f.a);let rejected=false;
 if(point==='query save')t.mock.method(f.a,'save',()=>{if(!rejected&&f.step.dispatch.requests?.some(r=>r.query.op==='table_lineage')){rejected=true;throw Error('one-shot query boundary save failure');}return save();});
 let caught;try{await agent.act(f.a,f.job,f.step.tool,f.step.args);}catch(error){caught=error;}
 assert.ok(caught,'local error must leave the batch');assert.equal(identities,1);assert.equal(queries,0);
 if(point==='budget after identity')assert.equal(caught.spendLimit,true);else assert.equal(caught.code,'DISPATCH_PERSISTENCE_FAILED');
 f.life.failed(f.a,f.job,caught);assert.equal(f.step.dispatch.failure.code,caught.code||null);
 assert.ok(Object.values(f.job.executionState.operations).every(op=>!op.receipt),'no false remote dispatched receipt');
 assert.equal(claims(f)[0].status,'started');
});
test('failure diagnostics survive runtime identity invalidation and retain the original error',t=>{
 const f=dispatchFixture(t),original=Object.assign(Error('original identity rejection'),{code:'OPERATION_STALE'});f.step.args.queries[0].table='changed';
 assert.doesNotThrow(()=>f.life.failed(f.a,f.job,original));assert.equal(f.step.dispatch.failure.code,'OPERATION_STALE');assert.equal(f.step.dispatch.failure.phase,'prepared');
 const old=f.record.steps.shift();assert.doesNotThrow(()=>f.life.failed(f.a,f.job,original));assert.equal(f.record.dispatchFailures[0].dispatchId,old.dispatch.id);
});

test('ordinary active dispatch keeps omitted-project resolution, cached responses and invalid input semantics',async t=>{
 const f=setup(t),life=require('../desktop/dispatch-lifecycle.cjs');f.a.activeAgentJob=f.job;
 f.source('task',{id:456,projectId:777},{taskId:456});let calls=0;
 f.a.platformRequest=async args=>{calls++;assert.ok(args.includes('--project-id'));assert.ok(args.includes('777'));return {nodes:[{id:456,projectId:777}],upstream:[]};};
 const dispatch=async query=>{
  const run={id:'ordinary-'+Math.random(),jobId:f.job.id,steps:[]},step={tool:'platform_query',args:{taskId:f.task.id,queries:[query]},at:new Date().toISOString()};
  f.a.data.agentRuns.unshift(run);f.a.activeAgentRun=run;life.prepare(f.a,f.job,run,step,()=>{});
  try{return await agent.act(f.a,f.job,step.tool,step.args);}finally{life.clear(f.a,f.job);}
 };
 const q={op:'upstream',taskId:456,depth:1};const first=await dispatch(q);assert.ok(first.results[0].sourceId);assert.equal(calls,1);
 const second=await dispatch(q);assert.equal(second.results[0].reused,true);assert.equal(calls,1);
 const identity=f.a.platformFixture.identityCalls;await assert.rejects(()=>dispatch({op:'upstream',taskId:'invalid',depth:1}));assert.equal(calls,1);assert.equal(f.a.platformFixture.identityCalls,identity);
});

test('managed late pause preserves actual response as historical and stops the remaining batch',async t=>{
 const f=setup(t),life=require('../desktop/dispatch-lifecycle.cjs');f.a.activeAgentJob=f.job;
 const beforeSources=f.a.data.sources.length,queries=[{op:'task',taskId:456,projectId:777},{op:'task',taskId:457,projectId:777}];let calls=0;
 f.a.platformRequest=async args=>{calls++;assert.deepEqual(args,require('../desktop/data-platform.cjs').command(queries[0]));f.job.executionPaused=true;return {id:456,owner:'fixture-owner',secret:'MUST_NOT_RETAIN'};};
 const run={id:'late-pause-managed',jobId:f.job.id,steps:[]},step={tool:'platform_query',args:{taskId:f.task.id,queries},at:new Date().toISOString()};f.a.data.agentRuns.unshift(run);f.a.activeAgentRun=run;
 life.prepare(f.a,f.job,run,step,()=>{});
 await assert.rejects(()=>agent.act(f.a,f.job,step.tool,step.args),e=>e.code==='OPERATION_STALE'&&e.gateClosed===true);
 assert.equal(calls,1);assert.equal(f.a.platformFixture.identityCalls,1);assert.equal(f.a.data.sources.length,beforeSources);
 const disk=JSON.parse(fs.readFileSync(f.a.file,'utf8')),op=Object.values(disk.delegations.find(j=>j.id===f.job.id).executionState.operations).find(o=>o.query?.taskId===456);
 assert.equal(op.status,'superseded');assert.equal(op.presentationStatus,'historical');assert.equal(op.observations[0].data.owner,'fixture-owner');assert.equal(op.receipt,undefined);assert.doesNotMatch(JSON.stringify(op),/MUST_NOT_RETAIN/);
});
