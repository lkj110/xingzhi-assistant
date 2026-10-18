const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,deny}=require('./root-relation-fixture.cjs');
const coral=require('./root-relation-physical-fixture.cjs');
const agent=require('../desktop/agent.cjs'),c=require('../desktop/continuation-control.cjs');
const rv=require('../desktop/repair-validation.cjs'),r=require('../desktop/relation-obligations.cjs');
const journal=require('../desktop/work-journal.cjs'),recovery=require('../desktop/evidence-recovery.cjs');
const policy=require('../desktop/access-policy-store.cjs'),spend=require('../desktop/spend.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const clone=x=>structuredClone(x),at=n=>new Date(Date.UTC(2026,9,16,10)+n*1000).toISOString();
const note='先设计根本性的方案，然后派另一个subagent审核方案，确认最终版之后，再进行实施，最后继续推进sg事项';

// Real task/binding/Coral/request/plan/journal implementations. Only the model
// and CLI transport are substitutes; the fixture denies all real networking.
function setup(t,{roots=['123'],rootInput=['leaf'],missingMapping=false}={}){
 const base=fixture(t,{roots,kinds:'物理表血缘'}),{a,job,task}=base;
 job.platformPrincipal='fixture-user';job.autoAccept=false;job.maxActions=2;
 const remote={principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']};
 policy.grant(a,remote,{trusted:true,actor:'user_command',command:'fixture'});
 const outputData={taskId:123,outputs:[{type:'partition',databaseName:'db',tableName:'out',storageRegion:'sg'}]};
 const mapping=missingMapping?null:base.source('outputs',outputData);
 // Like retained legacy SG snapshots, locally readable metadata without a
 // remote principal cannot establish a typed root-output mapping.
 const legacySource=missingMapping?base.source('outputs',outputData,{taskId:123},{platformPrincipal:null}):null;
 const center=(table,input=[],output=[],bind=true)=>base.source('table_lineage',coral.data(table,input,output),{database:'db',table},{},bind);
 const root=missingMapping?null:center('out',rootInput);
 const original={id:'original-report',taskId:task.id,stepId:task.steps[0].id,title:'原稿',content:'保留原已核实事实及未核实缺口',createdAt:at(-15)};
 a.data.artifacts.push(original);task.primaryArtifactId=original.id;task.steps[0].artifactId=original.id;task.generationMode='single';
 const old={intent:require('../desktop/work-efficiency.cjs').intent(a,job),version:2,phase:'awaiting_change',waitBasis:'original-wait',lastFailure:{code:'PLAN_ALREADY_RECONCILED',taskId:task.id},blocker:{at:at(100)},history:[],tried:{},reads:{retained:'original reads'}};
 job.executionState.workEfficiency=old;job.createdAt=task.createdAt=at(-20);job.status='blocked';job.nextRunAt=null;
 a.data.agentRuns=[{id:'prior-unknown',jobId:job.id,startedAt:at(-10),steps:[{tool:'advance_task',args:{taskId:task.id},at:at(-9),errorCode:'MODEL_INVALID_RESPONSE'}]}];
 for(const [n,tool,errorCode] of [[0,'advance_task','MODEL_INVALID_RESPONSE'],[90,'plan_task','PLAN_ALREADY_RECONCILED']]){
  const id=tool+':'+task.id,args={taskId:task.id},actionKey=hash(tool==='plan_task'?{tool,taskId:task.id}:{tool,args});
  old.history.push({id,basis:old.waitBasis,startedAt:at(n),finishedAt:at(n+5),outcome:'no_progress',actionKeys:[actionKey],executedActions:[{tool,args}]});old.tried[old.waitBasis+':'+id]={at:at(n)};
  a.data.agentRuns.unshift({id:'run-'+n,jobId:job.id,startedAt:at(n),finishedAt:at(n+6),steps:[{tool,args,at:at(n+1),errorCode,strategyRecovery:{id}}]});
 }
 a.activeAgentJob=job;const scope=spend.scope(a);a.activeAgentJob=null;
 Object.assign(scope,{limitUSD:200,spentUSD:157.1,unknownAcknowledged:4,unreservedCalls:0});scope.usage.unknownCalls=4;spend.persist(a);
 const audit={queries:[],generation:0,planner:0};
 const f={...base,root,mapping,legacySource,center,remote,original,old:clone(old),scope:clone(scope),audit,
  input:{taskId:task.id,artifactId:original.id,expectedWorkRevision:job.workRevision??1,expectedTaskRevision:task.workRevision??1,authorizationNote:note,executedBy:'supervisor',commandId:'evidence-recovery-click'},
  restart(){const {Assistant}=require('../desktop/core.cjs');const b=new Assistant({dir:base.dir,chat:deny,connectorRequest:deny,webRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(b));f.a=b;f.job=b.data.delegations.find(j=>j.id===job.id);f.task=b.task(task.id);installTransport();return f;}};
 function installTransport(){require('./helpers/platform-fixture.cjs').install(f.a);f.a.platformRequest=async args=>{
  audit.queries.push([...args]);
  if(args.includes('data-outputs')){assert.deepEqual(args,require('../desktop/data-platform.cjs').command({op:'outputs',taskId:123}));return clone(outputData);}
  const index=args.indexOf('--table-name'),table=args[index+1];
  assert.notEqual(index,-1);assert.deepEqual(args,require('../desktop/data-platform.cjs').command({op:'table_lineage',database:'db',table}));
  assert.ok(['out','leaf','next','other'].includes(table),'only explicit symbolic frontier targets');
  return coral.data(table,table==='out'?rootInput:table==='leaf'?['next']:[]);
 };}
 installTransport();a.save();
 const preview=rv.preview(a,job);assert.equal(preview.eligibility,true,JSON.stringify(preview));assert.equal(preview.proof.knownCycles,1);assert.equal(preview.proof.complete,false);
 rv.authorize(a,job,f.input);return f;
}
const state=f=>f.job.executionState.continuation;
const current=f=>state(f).episodes[state(f).activeBasis];
const grants=f=>journal.read(f.a).events.filter(e=>e.type===rv.TYPE&&e.payload.kind==='grant');
const claims=f=>journal.read(f.a).events.filter(e=>e.type===rv.TYPE&&e.payload.kind==='claim');
const handoffs=f=>journal.read(f.a).events.filter(e=>e.type===recovery.HANDOFF);
const detail=f=>JSON.stringify({status:f.job.status,error:f.job.lastError,episode:current(f),request:f.task.evidenceRequest,steps:f.a.data.agentRuns[0]?.steps?.map(s=>({tool:s.tool,code:s.errorCode,error:s.error}))});
function assertAudit(f){
 const g=rv.active(f.job);assert.deepEqual(g.legacyWorkEfficiency,f.old);assert.equal(g.proof.complete,false);assert.equal(g.knownFailures,1);assert.ok(g.proof.unknown.length);
 for(const k of ['history','tried','reads'])assert.deepEqual(f.job.executionState.workEfficiency[k],f.old[k],k);
 const s=f.a.spendLedger.scopes['job:'+f.job.id];for(const k of ['limitUSD','spentUSD','heldUSD','unknownAcknowledged','unreservedCalls'])assert.equal(s[k],f.scope[k],k);assert.equal(s.usage.unknownCalls,4);
 assert.equal(grants(f).length,1);
}
async function dispatch(f,tool){
 const step=c.next(f.a,f.job);assert.equal(step?.tool,tool,detail(f));step.at=new Date().toISOString();
 c.started(f.a,f.job,step);f.a.save();step.result=await agent.act(f.a,f.job,step.tool,step.args);c.settled(f.a,f.job,step);f.a.save();return step;
}
// Acquisition-only cases still exercise the scheduler, but new evidence now
// receives a real original-draft patch before the next recursive query.
async function integrateAvailable(f){
 const consumption=require('../desktop/evidence-consumption.cjs'),policy=require('../desktop/execution-policy.cjs');
 if(consumption.inspect(f.a,f.job,f.task)?.command!=='evidence_consume')return;
 f.job.nextRunAt=null;policy.prepare(f.a,f.job);const action=policy.claim(f.a,f.job);assert.equal(action?.tool,'advance_task');
 const oldChat=f.a.chat,oldRun=f.a.activeAgentRun,oldJob=f.a.activeAgentJob;
 const run={id:require('node:crypto').randomUUID(),jobId:f.job.id,startedAt:new Date().toISOString(),status:'running',steps:[],modelCalls:0,modelCallsDetail:[]};
 f.a.activeAgentRun=run;f.a.activeAgentJob=f.job;f.a.data.agentRuns.unshift(run);
 f.a.chat=async(_p,_k,_m,o)=>{o.onUsage?.({inputTokens:10,outputTokens:5});const p=f.task.evidenceConsumption.attempts[f.task.evidenceConsumption.activeAttemptId],original=require('../desktop/deliverables.cjs').primary(f.a,f.task),section=consumption.sections(original.content).at(-1);const entries=p.targetFacts.map((fact,i)=>({...fact,quote:'已纳入本轮实际查询事实 '+fact.factKey}));return {kind:'patch',edits:[{before:original.content,after:original.content+'\n'+entries.map(f=>f.quote).join('\n')}],summary:'受控补证修订',evidenceIntegration:entries.map(f=>({factKey:f.factKey,obligationId:f.obligationId,sectionId:section.id,quote:f.quote}))};};
 try{action.at=new Date().toISOString();run.steps.push(action);c.started(f.a,f.job,action);action.result=await agent.act(f.a,f.job,action.tool,action.args);c.settled(f.a,f.job,action);run.status='done';run.finishedAt=new Date().toISOString();f.a.save();}finally{f.a.chat=oldChat;f.a.activeAgentRun=oldRun;f.a.activeAgentJob=oldJob;}
}
async function acquire(f){const query=await dispatch(f,'platform_query');assert.ok(query.result.results.every(v=>v.sourceId),JSON.stringify(query.result));const plan=await dispatch(f,'plan_task');return {query,plan};}

test('known physical frontier is acquired before repair claim, with exact Coral targets and no model call',async t=>{
 const f=setup(t),before=clone(rv.active(f.job)),oldBasis=state(f).activeBasis;
 assert.deepEqual(r.evidenceNeeds(f.a,f.job,f.task).map(n=>({direction:n.direction,query:n.query})),[{direction:'input',query:{op:'table_lineage',database:'db',table:'leaf'}}]);
 await agent.run(f.a,f.job.id);
 assert.deepEqual(f.a.data.agentRuns[0].steps.map(s=>s.tool),['platform_query','plan_task'],detail(f));
 assert.equal(claims(f).length,0);assert.deepEqual(rv.active(f.job),before);assert.equal(f.audit.queries.length,1);assert.ok(f.task.sourceIds.includes(f.mapping.id)&&f.task.sourceIds.includes(f.root.id));
 assert.notEqual(state(f).activeBasis,oldBasis,'plan commit must already project ordinary IR4');assert.equal(current(f).cycles,0);assert.equal(current(f).fromValidationGrantId,before.grantId);assert.equal(current(f).validationGrantId,undefined);
 assert.equal(r.physicalContext(f.a,f.job,f.task).closureProven,false,'new fact does not mean relation closure');assertAudit(f);
});

test('missing root mapping starts with exact outputs, then real own-center queries before any repair',async t=>{
 const f=setup(t,{missingMapping:true}),grant=clone(rv.active(f.job));
 const needs=r.evidenceNeeds(f.a,f.job,f.task);assert.ok(needs.length);assert.ok(needs.every(n=>n.query.op==='outputs'&&String(n.query.taskId)==='123'));
 for(const query of [{op:'outputs',taskId:123},{op:'table_lineage',database:'db',table:'out'},{op:'table_lineage',database:'db',table:'leaf'},{op:'table_lineage',database:'db',table:'next'}]){
  await integrateAvailable(f);const next=c.next(f.a,f.job);assert.equal(next?.tool,'platform_query',detail(f));assert.ok(next.args.queries.length);
  for(const q of next.args.queries)assert.deepEqual(require('../desktop/data-platform.cjs').command(q),require('../desktop/data-platform.cjs').command(query));
  await agent.run(f.a,f.job.id);assert.deepEqual(f.a.data.agentRuns[0].steps.map(s=>s.tool),['platform_query','plan_task'],detail(f));assert.ok(f.a.data.agentRuns[0].steps.every(s=>!s.error),detail(f));
  assert.equal(claims(f).length,0);assert.deepEqual(rv.active(f.job),grant);f.job.nextRunAt=null;f.a.save();f.restart();
 }
 assert.equal(f.audit.queries.length,4);assert.equal(r.physicalContext(f.a,f.job,f.task).closureProven,true);assert.ok(r.recoveryFacts(f.a,f.job,f.task).length);assert.equal(handoffs(f).length,1);assert.equal(current(f).fromValidationGrantId,grant.grantId);assertAudit(f);
});

test('outputs receipt saved before settled restarts through atomic plan without repeating the metadata query',async t=>{
 const f=setup(t,{missingMapping:true}),step=c.next(f.a,f.job);assert.equal(step?.tool,'platform_query',detail(f));assert.equal(step.args.queries.length,1);assert.equal(step.args.queries[0].op,'outputs');
 c.started(f.a,f.job,step);f.a.save();const result=await agent.act(f.a,f.job,step.tool,step.args);assert.ok(result.results[0].sourceId);f.restart();
 const next=c.next(f.a,f.job);assert.equal(next?.tool,'plan_task',detail(f));
 assert.deepEqual(next.args.sourceIds,[result.results[0].sourceId],JSON.stringify({legacy:f.legacySource.id,sources:f.a.data.sources.map(s=>({id:s.id,principal:s.platformPrincipal})),operations:Object.values(f.job.executionState.operations).map(o=>({query:o.query,status:o.status,sourceId:o.sourceId,migrated:o.migrated,principal:o.principal}))}));await dispatch(f,'plan_task');
 assert.equal(f.audit.queries.length,1);assert.equal(claims(f).length,0);assert.equal(handoffs(f).length,1);assert.ok(r.recoveryFacts(f.a,f.job,f.task).length);assertAudit(f);
});

test('plan evidenceResolution and grant handoff are one atomic journal commit, replay grants no extra credit',async t=>{
 const f=setup(t),oldBasis=state(f).activeBasis,grant=clone(rv.active(f.job));
 let prepared;const prepare=recovery.handoffEvent;
 t.mock.method(recovery,'handoffEvent',(a,j,task)=>{
  const event=prepare(a,j,task);
  prepared={event:!!event,proof:!!task.lastEvidenceResolution?.recoveryProof,pendingFacts:r.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution}).length,
   localReads:task.sourceIds.map(id=>require('../desktop/protocol-access.cjs').allowedObject(a,'source',a.data.sources.find(s=>s.id===id),j,task))};
  return event;
 });
 const {plan}=await acquire(f);
 const p=journal.read(f.a).events.find(e=>e.type==='evidence_plan_committed'&&e.commitId===plan.result.commitId),h=handoffs(f);
 assert.equal(h.length,1,JSON.stringify(prepared));assert.ok(prepared.localReads.every(Boolean),'draft must apply task ACL to every new binding');assert.equal(h[0].commitId,p.commitId,'binding proof and handoff must share the durable commit');assert.equal(h[0].payload.previousBasis,oldBasis);assert.equal(h[0].payload.grantId,grant.grantId);assert.ok(h[0].payload.newFactKeys.length);
 const old=clone(state(f).episodes[oldBasis]),basis=state(f).activeBasis,count=Object.keys(state(f).episodes).length;
 assert.equal(c.refresh(f.a,f.job),false);assert.equal(rv.allowedAction(f.a,f.job,{tool:'advance_task',args:{taskId:f.task.id}}).reason,'VALIDATION_HANDED_OFF');
 f.restart();const events=journal.read(f.a).events.length;await agent.act(f.a,f.job,'plan_task',plan.args);journal.replay(f.a,{force:true});assert.equal(c.refresh(f.a,f.job),false);
 assert.equal(journal.read(f.a).events.length,events);assert.equal(Object.keys(state(f).episodes).length,count);assert.equal(state(f).activeBasis,basis);assert.deepEqual(state(f).episodes[oldBasis],old);assert.deepEqual(rv.active(f.job),grant);assertAudit(f);
});

test('saved in-flight claim returning actual needs_evidence queries only its original physical gap',async t=>{
 const f=setup(t),g=rv.active(f.job),basis=state(f).activeBasis;
 // A previously dispatched attempt can finish after the new preflight route
 // exists. Claim through the real module; do not fabricate a grant or proof.
 const step={tool:'advance_task',args:{taskId:f.task.id},at:new Date().toISOString(),continuation:{handled:true,tracked:true,kind:'execution',basis}};
 rv.before(f.a,f.job,step);f.a.save();
 f.a.chat=async(_p,_k,m,o)=>{o.onUsage?.({inputTokens:10,outputTokens:5});if(m[0].content.includes('动作格式')){f.audit.planner++;return deny();}assert.equal(o.stage,'task_work');f.audit.generation++;return {kind:'needs_evidence',summary:'补齐入口123上游leaf中心',gaps:['入口123物理表血缘上游leaf未展开'],requirements:[r.required(f.a,f.job,f.task)[0].id],artifactId:f.original.id};};
 step.result=await agent.act(f.a,f.job,step.tool,step.args);assert.equal(step.result.evidenceRequest.kind,'needs_evidence');c.settled(f.a,f.job,step);f.a.save();
 assert.equal(rv.active(f.job).outcome,'failed');assert.equal(claims(f).length,1);const consumed=clone(rv.active(f.job));
 f.restart();f.job.nextRunAt=null;assert.equal(c.ready(f.a,f.job),true,detail(f));assert.equal(agent.tick(f.a),true,detail(f));await f.a.runPromise;
 assert.deepEqual(f.a.data.agentRuns[0].steps.map(s=>s.tool),['platform_query','plan_task'],detail(f));assert.equal(f.audit.generation,1);assert.equal(f.audit.planner,0);assert.equal(f.audit.queries.length,1);
 assert.equal(current(f).fromValidationGrantId,g.grantId);assert.deepEqual(rv.active(f.job),consumed);assert.equal(claims(f).length,1);assertAudit(f);
});

for(const fault of ['projection','save'])test('atomic evidence plan '+fault+' crash resumes same handoff and proof after cold restart',async t=>{
 const f=setup(t);await dispatch(f,'platform_query');const plan=c.next(f.a,f.job),before=fs.readFileSync(f.a.file),save=f.a.save,project=c.projectEvidenceHandoff;
 if(fault==='projection')c.projectEvidenceHandoff=()=>{throw Error('fixture crash during handoff projection');};else f.a.save=()=>{throw Error('fixture snapshot save failed');};
 try{await assert.rejects(agent.act(f.a,f.job,'plan_task',plan.args));}finally{f.a.save=save;c.projectEvidenceHandoff=project;}
 assert.equal(handoffs(f).length,1);fs.writeFileSync(f.a.file,before);f.restart();
 assert.equal(handoffs(f).length,1);assert.equal(current(f).fromValidationGrantId,rv.active(f.job).grantId);assert.equal(current(f).cycles,0);assert.equal(claims(f).length,0);assert.equal(f.task.evidenceRequest,undefined);
 const basis=state(f).activeBasis;await agent.act(f.a,f.job,'plan_task',plan.args);journal.replay(f.a,{force:true});assert.equal(c.refresh(f.a,f.job),false);assert.equal(state(f).activeBasis,basis);assert.equal(handoffs(f).length,1);assertAudit(f);
});

test('recursive own-center acquisition retains attempts across IR4 bases and never claims the old grant',async t=>{
 const f=setup(t);await acquire(f);await integrateAvailable(f);const first=state(f).activeBasis;
 assert.deepEqual(c.next(f.a,f.job).args.queries,[{op:'table_lineage',database:'db',table:'next'}]);await acquire(f);c.refresh(f.a,f.job);
 assert.notEqual(state(f).activeBasis,first);assert.equal(r.physicalContext(f.a,f.job,f.task).closureProven,true);assert.deepEqual(r.evidenceNeeds(f.a,f.job,f.task),[]);
 assert.equal(f.audit.queries.length,2);assert.equal(claims(f).length,0);assert.equal(handoffs(f).length,1);assert.equal(current(f).fromValidationGrantId,rv.active(f.job).grantId);assertAudit(f);
});

test('an explicit needs_evidence target excludes a different root and rejects widened query dispatch',t=>{
 const f=setup(t,{roots:['123','456']});
 f.source('outputs',{taskId:456,outputs:[{databaseName:'db',tableName:'other',storageRegion:'sg'}]},{taskId:456});
 f.need({gaps:['仅入口123物理表血缘上游leaf缺失'],requirements:[]});
 assert.ok(r.evidenceNeeds(f.a,f.job,f.task).some(n=>n.rootIds.includes('456')),'unrelated frontier really exists');
 const next=c.next(f.a,f.job);assert.deepEqual(next.args.queries,[{op:'table_lineage',database:'db',table:'leaf'}]);
 const injected=clone(next);injected.args.queries.push({op:'table_lineage',database:'db',table:'other'});
 assert.throws(()=>c.started(f.a,f.job,injected));assert.equal(claims(f).length,0);assert.equal(f.audit.queries.length,0);
});

for(const explicit of [false,true])test('query receipts saved before settled recover to plan after restart (explicit request='+explicit+')',async t=>{
 const f=setup(t,{rootInput:['leaf','other']});
 if(explicit)f.need({gaps:['入口123物理表血缘上游缺失'],requirements:[r.required(f.a,f.job,f.task)[0].id]});
 const step=c.next(f.a,f.job);assert.equal(step.tool,'platform_query');assert.equal(step.args.queries.length,2);c.started(f.a,f.job,step);f.a.save();
 const result=await agent.act(f.a,f.job,step.tool,step.args);assert.ok(result.results.every(v=>v.sourceId));assert.equal(current(f).evidenceAcquisition.pendingPlan,undefined);
 // Both real operation receipts and sources are durable, but the run crashed
 // before its settlement produced pendingPlan. Recovery must not requery.
 const count=f.audit.queries.length;f.restart();const next=c.next(f.a,f.job);assert.equal(next?.tool,'plan_task',detail(f));
 assert.deepEqual([...next.args.sourceIds].sort(),result.results.map(v=>v.sourceId).sort());await dispatch(f,'plan_task');assert.equal(f.audit.queries.length,count);assert.equal(claims(f).length,0);assert.equal(handoffs(f).length,1);assertAudit(f);
});

test('failed query receipt never becomes semantic evidence, repair claim, or fresh credit',async t=>{
 const f=setup(t),basis=state(f).activeBasis;f.a.platformRequest=async args=>{f.audit.queries.push(args);throw Object.assign(Error('fixture observed permission denial'),{code:'AUTH_REQUIRED',status:403});};
 const step=await dispatch(f,'platform_query');assert.ok(step.result.results.every(v=>!v.sourceId&&v.error));assert.equal(f.audit.queries.length,1);assert.equal(claims(f).length,0);assert.equal(rv.active(f.job).claimedAttemptId,null);
 assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);assert.equal(c.refresh(f.a,f.job),false);assert.equal(handoffs(f).length,0);f.restart();
 assert.equal(recovery.hasWork(f.a,f.job,f.task,current(f)),false);assert.equal(c.refresh(f.a,f.job),false);assert.equal(state(f).activeBasis,basis);assert.equal(claims(f).length,0);assert.equal(f.audit.queries.length,1);assertAudit(f);
});

test('new but unrelated physical center cannot hand off the consumed grant',t=>{
 const f=setup(t),step={tool:'advance_task',args:{taskId:f.task.id}},basis=state(f).activeBasis;
 rv.before(f.a,f.job,step);rv.finish(f.a,f.job,'CLAIMED_RESULT_UNKNOWN');c.refresh(f.a,f.job);
 f.need({gaps:['入口123物理表血缘上游leaf缺失'],requirements:[]});const unrelated=f.center('other',[],[],false),grant=clone(rv.active(f.job));
 f.resolve([unrelated.id]);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);assert.equal(c.refresh(f.a,f.job),false);assert.equal(state(f).activeBasis,basis);assert.equal(handoffs(f).length,0);assert.deepEqual(rv.active(f.job),grant);assert.equal(claims(f).length,1);assertAudit(f);
});

test('partial batch durable success plus observed failure recovers only successful receipts without requery',async t=>{
 const f=setup(t,{rootInput:['leaf','other']});
 f.a.platformRequest=async args=>{const table=args[args.indexOf('--table-name')+1];f.audit.queries.push(args);if(table==='other')throw Object.assign(Error('fixture explicit denial'),{code:'AUTH_REQUIRED',status:403});assert.equal(table,'leaf');return coral.data('leaf',['next']);};
 const step=c.next(f.a,f.job);c.started(f.a,f.job,step);f.a.save();const result=await agent.act(f.a,f.job,step.tool,step.args);
 assert.equal(result.results.filter(v=>v.sourceId).length,1);assert.equal(result.results.filter(v=>v.error).length,1);f.restart();
 const plan=c.next(f.a,f.job);assert.equal(plan.tool,'plan_task');assert.deepEqual(plan.args.sourceIds,result.results.filter(v=>v.sourceId).map(v=>v.sourceId));await dispatch(f,'plan_task');
 assert.equal(f.audit.queries.length,2);assert.equal(handoffs(f).length,1);const attempts=Object.values(current(f).evidenceAcquisition.attempts);assert.deepEqual(attempts.map(v=>v.status).sort(),['done','failed']);
 assert.equal(r.physicalContext(f.a,f.job,f.task).closureProven,false);assert.equal(claims(f).length,0);assertAudit(f);
});

test('handoff append before crash preserves a newer manual pause on replay, then resumes the same proof',async t=>{
 const f=setup(t);await dispatch(f,'platform_query');const step=c.next(f.a,f.job),before=clone(f.a.data),append=journal.append;
 journal.append=(...args)=>{const receipt=append(...args);throw Object.assign(Error('fixture response lost after append'),{committed:true,commitReceipt:receipt});};
 try{await assert.rejects(agent.act(f.a,f.job,'plan_task',step.args));}finally{journal.append=append;}
 assert.equal(handoffs(f).length,1);const paused=before.delegations.find(j=>j.id===f.job.id);Object.assign(paused,{status:'paused',executionPaused:true,nextRunAt:null});fs.writeFileSync(f.a.file,JSON.stringify(before));f.restart();
 assert.equal(f.job.status,'paused');assert.equal(c.ready(f.a,f.job),false);assert.equal(state(f).validationHandoffs[rv.active(f.job).grantId].pending,true);assert.equal(claims(f).length,0);assert.equal(agent.tick(f.a),false);
 f.job.executionPaused=false;f.job.status='ready';assert.equal(c.refresh(f.a,f.job),true);const basis=state(f).activeBasis;assert.equal(current(f).fromValidationGrantId,rv.active(f.job).grantId);assert.equal(c.refresh(f.a,f.job),false);f.a.save();f.restart();
 assert.equal(state(f).activeBasis,basis);assert.equal(handoffs(f).length,1);assert.equal(claims(f).length,0);assertAudit(f);
});

test('same physical fact under a new source ID and binding time does not replenish exhausted ordinary IR4',async t=>{
 const f=setup(t);await acquire(f);await integrateAvailable(f);await acquire(f);c.refresh(f.a,f.job);const e=current(f);
 for(let i=0;i<3;i++){const s={tool:'advance_task',args:{taskId:f.task.id}};c.started(f.a,f.job,s);c.noteCheck(f.a,f.job,f.task,{passed:false,basis:'ordinary-failed-'+i,gaps:['原要求仍未核实']});}
 assert.equal(e.cycles,3);assert.equal(e.blocked,true);const basis=state(f).activeBasis,grant=clone(rv.active(f.job)),count=Object.keys(state(f).episodes).length;
 f.need({gaps:['入口123物理表血缘仍未核实'],requirements:[r.required(f.a,f.job,f.task)[0].id]});const duplicate=f.center('leaf',['next'],[],false);f.resolve([duplicate.id]);
 assert.equal(c.refresh(f.a,f.job),false);f.a.save();f.restart();assert.equal(c.refresh(f.a,f.job),false);assert.equal(state(f).activeBasis,basis);assert.equal(Object.keys(state(f).episodes).length,count);assert.equal(current(f).cycles,3);assert.deepEqual(rv.active(f.job),grant);assertAudit(f);
});

for(const guard of ['pause','revoked','budget','unknown_spend','uncertain'])test('directed evidence acquisition and handoff retain '+guard+' gate',async t=>{
 const f=setup(t),basis=state(f).activeBasis;
 if(guard==='pause')f.job.executionPaused=true;
 if(guard==='revoked')policy.revoke(f.a,f.remote,{trusted:true,actor:'user_command',command:'fixture'});
 if(guard==='budget')f.a.spendLedger.scopes['job:'+f.job.id].spentUSD=200;
 if(guard==='unknown_spend')f.a.spendLedger.scopes['job:'+f.job.id].unreservedCalls=1;
 if(guard==='uncertain')f.a.data.agentActions.push({id:'existing-uncertain',jobId:f.job.id,taskId:f.task.id,status:'uncertain',tool:'lark_update'});
 let next;try{next=c.next(f.a,f.job);}catch(error){assert.ok(['VALIDATION_PATH_UNRESOLVED','VALIDATION_BASIS_CHANGED'].includes(error.code),error.stack);}
 assert.notEqual(next?.tool,'platform_query');assert.equal(c.refresh(f.a,f.job),false);assert.equal(state(f).activeBasis,basis);assert.equal(f.audit.queries.length,0);assert.equal(claims(f).length,0);assert.equal(handoffs(f).length,0);
});


// Controlled ER-P1-1: the first restart has a durable v2 prepare with zero
// boundaries. The second has an exact attempt/operation receipt (or an actual
// unknown boundary), never an inferred permission to resend missing history.
async function twiceInterruptedEvidence(t,{result='done'}={}){
 const f=setup(t);f.job.maxActions=1;
 rv.before(f.a,f.job,{tool:'advance_task',args:{taskId:f.task.id}});
 rv.finish(f.a,f.job,'CLAIMED_RESULT_UNKNOWN');c.refresh(f.a,f.job);
 f.need({gaps:['入口123物理表血缘上游leaf缺失'],requirements:[r.required(f.a,f.job,f.task)[0].id]});
 const grant=clone(rv.active(f.job)),basis=state(f).activeBasis,episode=clone(current(f));
 assert.equal(episode.blocked,true);
 const first=c.next(f.a,f.job);assert.equal(first?.tool,'platform_query',detail(f));
 const lifecycle=require('../desktop/dispatch-lifecycle.cjs');
 const begin=step=>{
  const run={id:require('node:crypto').randomUUID(),jobId:f.job.id,status:'running',startedAt:new Date().toISOString(),steps:[]};
  f.a.data.agentRuns.unshift(run);f.a.activeAgentRun=run;step.at=new Date().toISOString();
  lifecycle.prepare(f.a,f.job,run,step,()=>c.started(f.a,f.job,step));return run;
 };
 const preparedRun=begin(first),firstAttemptId=Object.values(current(f).evidenceAcquisition.attempts)[0].attemptId;
 assert.deepEqual(first.dispatch.requests,[]);
 preparedRun.status='interrupted';preparedRun.finishedAt=new Date().toISOString();f.a.save();f.restart();
 const resumed=c.next(f.a,f.job);assert.deepEqual(resumed.args,first.args);
 const resumedRun=begin(resumed);f.a.save();
 assert.notEqual(Object.values(current(f).evidenceAcquisition.attempts)[0].attemptId,firstAttemptId);
 let receipt;
 if(result!=='missing'){
  if(result==='failed')f.a.platformRequest=async args=>{f.audit.queries.push(args);throw Object.assign(Error('fixture observed permission denial'),{code:'AUTH_REQUIRED',status:403});};
  receipt=(await agent.act(f.a,f.job,resumed.tool,resumed.args)).results[0];
  if(result==='done')assert.ok(receipt.sourceId,JSON.stringify(receipt));else assert.ok(receipt.error&&!receipt.sourceId);
 }else{
  f.a.platformRequest=async args=>{f.audit.queries.push(args);throw Object.assign(Error('controlled response lost after boundary'),{code:'ABORTED',dispatchFailure:true});};
  await assert.rejects(agent.act(f.a,f.job,resumed.tool,resumed.args),/controlled response lost/);
 }
 resumedRun.status='interrupted';resumedRun.finishedAt=new Date().toISOString();f.a.save();
 f.restart();
 const attempt=Object.values(current(f).evidenceAcquisition.attempts)[0];
 assert.equal(attempt.status,result==='done'?'done':result==='failed'?'failed':'started');
 assert.ok(attempt.attemptId&&attempt.operationId&&attempt.dispatchId);
 assert.equal(current(f).evidenceAcquisition.pendingPlan,undefined);
 assert.equal(current(f).blocked,true);assert.equal(handoffs(f).length,0);
 return {f,receipt,grant,basis,episode};
}

test('ER-P1-1 actual tick binds a durable receipt after two restarts without another query or grant',async t=>{
 const {f,receipt,grant,basis,episode}=await twiceInterruptedEvidence(t);
 const before=clone(f.a.data),ledger=clone(f.a.spendLedger);
 assert.equal(recovery.hasWork(f.a,f.job,f.task,current(f)),true);
 assert.equal(c.ready(f.a,f.job),true);assert.equal(c.acquiring(f.a,f.job),true);
 assert.deepEqual(f.a.data,before,'readiness must not recover or save the attempt');assert.deepEqual(f.a.spendLedger,ledger);
 assert.equal(agent.tick(f.a),true,detail(f));await f.a.runPromise;
 const steps=f.a.data.agentRuns[0].steps;assert.deepEqual(steps.map(s=>s.tool),['plan_task'],detail(f));
 assert.ok(!steps[0].error,detail(f));assert.deepEqual(steps[0].args.sourceIds,[receipt.sourceId]);
 assert.ok(f.task.sourceIds.includes(receipt.sourceId));assert.equal(f.task.evidenceRequest,undefined);
 assert.equal(f.audit.queries.length,1);assert.equal(f.audit.generation,0);assert.equal(f.audit.planner,0);
 assert.equal(claims(f).length,1);assert.equal(handoffs(f).length,1);assert.deepEqual(rv.active(f.job),grant);
 const activeBasis=state(f).activeBasis,ordinary=clone(current(f));
 assert.notEqual(activeBasis,basis);assert.equal(ordinary.fromValidationGrantId,grant.grantId);assert.equal(ordinary.validationGrantId,undefined);
 assert.equal(ordinary.cycles,0);assert.equal(ordinary.hops,0);
 for(const field of ['cycles','hops','blocked','reason'])assert.deepEqual(state(f).episodes[basis][field],episode[field],field);
 // Stable plan replay and another cold boot cannot repeat the same handoff.
 const planArgs=clone(steps[0].args);f.a.save();f.restart();
 await agent.act(f.a,f.job,'plan_task',planArgs);journal.replay(f.a,{force:true});
 assert.equal(c.refresh(f.a,f.job),false);assert.equal(state(f).activeBasis,activeBasis);
 assert.equal(current(f).cycles,ordinary.cycles);assert.equal(current(f).hops,ordinary.hops);
 assert.equal(f.audit.queries.length,1);assert.equal(claims(f).length,1);assert.equal(handoffs(f).length,1);
 assert.deepEqual(rv.active(f.job),grant);assertAudit(f);
});

for(const invalid of ['missing','failed','stale_epoch','wrong_query','outside_job','wrong_principal','changed_request']){
 test('ER-P1-1 resumed attempt with '+invalid+' receipt cannot obtain a third dispatch or fresh credit',async t=>{
  const {f,receipt,grant,basis}=await twiceInterruptedEvidence(t,{result:['missing','failed'].includes(invalid)?invalid:'done'});
  const operation=receipt?.sourceId&&Object.values(f.job.executionState.operations).find(o=>o.sourceId===receipt.sourceId);
  if(invalid==='stale_epoch')f.job.executionState.permissionRevision=(f.job.executionState.permissionRevision||0)+1;
  if(invalid==='wrong_query')operation.actualQuery={op:'table_lineage',database:'db',table:'other'};
  if(invalid==='outside_job')f.job.sourceIds=f.job.sourceIds.filter(id=>id!==receipt.sourceId);
  if(invalid==='wrong_principal')f.a.data.sources.find(s=>s.id===receipt.sourceId).platformPrincipal='different-user';
  if(invalid==='changed_request')f.task.evidenceRequest.basis+=':replacement-request';
  f.a.save();f.restart();
  const before=clone(f.a.data),queries=f.audit.queries.length,runs=f.a.data.agentRuns.length;
  assert.equal(recovery.hasWork(f.a,f.job,f.task,current(f)),false,invalid);
  assert.equal(c.ready(f.a,f.job),false);assert.equal(c.acquiring(f.a,f.job),false);
  assert.deepEqual(f.a.data,before,'invalid receipt inspection must remain pure');
  for(let i=0;i<2;i++){assert.equal(agent.tick(f.a),false,detail(f));await f.a.runPromise;}
  assert.equal(f.a.data.agentRuns.length,runs);assert.equal(f.audit.queries.length,queries);
  assert.equal(f.job.status,'blocked');assert.equal(state(f).activeBasis,basis);assert.equal(current(f).blocked,true);
  assert.equal(handoffs(f).length,0);assert.equal(claims(f).length,1);assert.deepEqual(rv.active(f.job),grant);
  if(receipt?.sourceId)assert.ok(!f.task.sourceIds.includes(receipt.sourceId));
  assertAudit(f);
 });
}

for(const guard of ['pause','revoked_read','budget','unknown_spend','uncertain']){
 test('ER-P1-1 durable receipt after two restarts still obeys '+guard+' guard',async t=>{
  const {f,receipt,grant,basis}=await twiceInterruptedEvidence(t);
  if(guard==='pause'){f.job.executionPaused=true;f.job.status='paused';}
  if(guard==='revoked_read')policy.revoke(f.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+receipt.sourceId,jobId:f.job.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
  if(guard==='budget')f.a.spendLedger.scopes['job:'+f.job.id].spentUSD=200;
  if(guard==='unknown_spend')f.a.spendLedger.scopes['job:'+f.job.id].unreservedCalls=1;
  if(guard==='uncertain'){
   const id='already-readback-uncertain';
   f.a.data.agentActions.push({id,jobId:f.job.id,taskId:f.task.id,status:'uncertain',tool:'lark_update',automaticReconciliation:{basis:hash({id,permissionRevision:f.job.executionState.permissionRevision||0}),at:at(150)}});
  }
  spend.persist(f.a);f.a.save();f.restart();
  const queries=f.audit.queries.length,runs=f.a.data.agentRuns.length,budget=clone(f.a.spendLedger),actions=clone(f.a.data.agentActions);
  assert.equal(c.ready(f.a,f.job),false,guard);assert.equal(c.acquiring(f.a,f.job),false);
  assert.equal(agent.tick(f.a),false,detail(f));await f.a.runPromise;
  assert.equal(f.a.data.agentRuns.length,runs);assert.equal(f.audit.queries.length,queries);
  assert.equal(state(f).activeBasis,basis);assert.equal(current(f).blocked,true);
  assert.equal(handoffs(f).length,0);assert.equal(claims(f).length,1);assert.equal(grants(f).length,1);
  assert.deepEqual(rv.active(f.job),grant);assert.deepEqual(f.a.spendLedger,budget);assert.deepEqual(f.a.data.agentActions,actions);
  assert.ok(!f.task.sourceIds.includes(receipt.sourceId));
  if(guard==='pause')assert.equal(f.job.status,'paused');
 });
}
