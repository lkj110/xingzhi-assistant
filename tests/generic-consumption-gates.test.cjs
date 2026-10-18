'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const pending=require('../desktop/pending-check.cjs'),cont=require('../desktop/continuation-control.cjs'),control=require('../desktop/execution-control.cjs');
const consumption=require('../desktop/evidence-consumption.cjs'),access=require('../desktop/protocol-access.cjs');
const hash=require('../desktop/evidence-basis.cjs').hash,tx=require('../desktop/state-transitions.cjs'),writes=require('../desktop/agent-writes.cjs');
const deny=()=>{throw Error('Unexpected external/model request in controlled gate test');};
function fixture(t,{draftOnly=true,closed=false}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'generic-consumption-gates-')));
 const a=new Assistant({dir,chat:deny,platformRequest:deny,connectorRequest:deny,webRequest:deny});
 t.after(()=>{require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const j=agent.buildJob(a,{goal:'整理已知证据并保存报告',useOutputFolder:true,fileMode:'auto',autoAccept:false},{outputFolder:fs.realpathSync(dir)});a.data.delegations.push(j);
 const task=a.createTask({title:'普通交接报告',criteria:'保留已核实事实',steps:[{title:'正文',kind:'draft',outputRole:'primary'},{title:'文件交付',kind:'external',tool:'write_file'}]});task.agentJobId=j.id;j.taskIds=[task.id];
 const source=agent.source(a,j,'known','材料','已核实：周五发布');task.sourceIds=[source.id];access.retain(a,'source',source,{task,job:j});
 require('../desktop/operation-ledger.cjs').state(j);
 const basis=cont.basis(a,j,task),e={taskId:task.id,basis,intentBasis:cont.intentBasis(j,task),cycles:1,hops:2,executions:4};j.executionState.continuation={version:1,activeTaskId:task.id,activeBasis:basis,episodes:{[basis]:e}};
 const run={id:'controlled-run',jobId:j.id,status:'running',startedAt:'2026-01-01T00:00:00.000Z',modelCalls:0,modelCallsDetail:[],steps:[]};a.data.agentRuns.unshift(run);a.activeAgentRun=run;a.activeAgentJob=j;a.automaticExecution=true;
 const f={a,j,task,e,run,source,dir,closed,step:task.steps[0]};t.mock.method(consumption,'coverage',()=>f.closed);
 function draft(id='controlled-draft',partial=draftOnly){
  run.steps.push({tool:'advance_task',args:{taskId:task.id},at:`2026-01-01T00:00:0${run.steps.length+1}.000Z`,continuation:{basis,tracked:true}});
  const artifact={id,taskId:task.id,stepId:f.step.id,title:'报告',content:'已核实：周五发布 '+id,createdAt:new Date().toISOString(),draftOnly:partial};
  a.data.artifacts.push(artifact);access.retain(a,'artifact',artifact,{task,job:j});f.step.done=true;f.step.artifactId=id;require('../desktop/deliverables.cjs').record(a,task,f.step,artifact);require('../desktop/step-evidence.cjs').record(a,task,f.step);pending.recordGenerated(a,j,task,f.step,artifact);return artifact;
 }
 f.draft=draft;f.artifact=draft();a.save();return f;
}
function idle(f){f.run.status='done';f.run.finishedAt=new Date().toISOString();f.a.activeAgentRun=null;f.a.activeAgentJob=null;}

test('B6 partial draft defers checks, preserves counters, and direct verify spends nothing',async t=>{
 const f=fixture(t),original=structuredClone(f.e);assert.equal(f.e.pendingCheck.status,'deferred_evidence');
 assert.deepEqual(pending.inspect(f.a,f.j),{eligible:false,deferred:true,reason:'CHECK_EVIDENCE_PENDING',needsReconcile:false,taskId:f.task.id,ownerEpisodeId:f.e.basis});
 assert.equal(pending.repairBarrier(f.a,f.j,f.task),null);
 await assert.rejects(control.verifyContent(f.a,f.j,f.task),err=>err.code==='EVIDENCE_REQUIRED'&&Array.isArray(err.businessObligations));
 assert.deepEqual(f.e,original);assert.equal(f.run.modelCalls,0);assert.equal(f.artifact.draftOnly,true);
});
test('B6 closed coverage explicitly activates the same draft with the current check basis',t=>{
 const f=fixture(t),old=structuredClone(f.e.pendingCheck);idle(f);
 // A later supporting output changes contentBasis, but is not an input to the
 // earlier draft. Activation must refresh checkBasis, not regenerate the draft.
 const step={id:'later-analysis',kind:'analysis',done:true,artifactId:'later-artifact'};f.task.steps.push(step);
 const extra={id:'later-artifact',taskId:f.task.id,stepId:step.id,content:'后续核对结果',createdAt:new Date().toISOString()};f.a.data.artifacts.push(extra);access.retain(f.a,'artifact',extra,{task:f.task,job:f.j});
 assert.notEqual(control.contentBasis(f.a,f.j,f.task),old.checkBasis);f.closed=true;
 const state=JSON.stringify(f.a.data),choice=pending.inspect(f.a,f.j);assert.equal(JSON.stringify(f.a.data),state);assert.equal(choice.prepareRequired,true);
 assert.equal(pending.prepare(f.a,f.j),true);assert.equal(pending.prepare(f.a,f.j),false);assert.equal(f.e.pendingCheck.status,'pending');
 assert.equal(f.e.pendingCheck.generationAttemptId,old.generationAttemptId);assert.equal(f.e.pendingCheck.artifactId,old.artifactId);assert.equal(f.e.pendingCheck.inputBasis,old.inputBasis);assert.equal(f.e.pendingCheck.checkBasis,control.contentBasis(f.a,f.j,f.task));
 f.a.activeAgentRun={id:'controlled-check',jobId:f.j.id,steps:[]};const claim=pending.claim(f.a,f.j,f.task);assert.ok(claim);assert.equal(f.e.cycles,1);assert.equal(f.e.executions,4);assert.equal(f.a.data.artifacts.length,2);
});
test('B6 a changed draft input remains deferred for coordination, never silently rebased',t=>{
 const f=fixture(t);idle(f);const before=structuredClone(f.e.pendingCheck);f.closed=true;f.source.content+=' 用户改动';
 const decision=pending.inspect(f.a,f.j);assert.equal(decision.eligible,false);assert.equal(decision.needsReconcile,true);assert.equal(decision.reason,'CHECK_DEFERRED_INPUT_CHANGED');
 assert.equal(pending.prepare(f.a,f.j),false);assert.deepEqual(f.e.pendingCheck,before);f.a.activeAgentRun={id:'new-run',steps:[]};assert.throws(()=>pending.claim(f.a,f.j,f.task),err=>err.code==='PLAN_RECONCILE_REQUIRED');
});
test('B6 new facts must be incorporated before additive inputs can activate the original draft',async t=>{
 const f=fixture(t);idle(f);const oldInput=structuredClone(f.step.inputBasis),oldCheck=structuredClone(f.e.pendingCheck);f.closed=true;
 const extra=agent.source(f.a,f.j,'additional','新增证据','新事实：已核对消费者');f.task.sourceIds.push(extra.id);access.retain(f.a,'source',extra,{task:f.task,job:f.j});
 let remaining=1;t.mock.method(consumption,'view',()=>({obtained:2,remaining,incorporatedAwaitingCheck:2-remaining,draftOnly:true}));
 assert.equal(pending.inspect(f.a,f.j).reason,'CHECK_EVIDENCE_NOT_INTEGRATED');assert.equal(pending.prepare(f.a,f.j),false);
 await assert.rejects(control.verifyContent(f.a,f.j,f.task),err=>err.code==='EVIDENCE_REQUIRED');
 remaining=0;assert.equal(pending.inspect(f.a,f.j).prepareRequired,true);assert.equal(pending.prepare(f.a,f.j),true);assert.deepEqual(f.step.inputBasis,oldInput);
 assert.notEqual(f.e.pendingCheck.activationInputBasis,oldCheck.inputBasis);assert.equal(f.e.pendingCheck.inputBasis,oldCheck.inputBasis);assert.equal(f.e.pendingCheck.artifactId,oldCheck.artifactId);
 f.a.activeAgentRun={id:'activate-added-inputs',jobId:f.j.id,steps:[]};assert.ok(pending.claim(f.a,f.j,f.task));assert.equal(f.e.cycles,1);
});
test('B6 closed coverage with facts still awaiting integration creates deferred, not final pending',t=>{
 const f=fixture(t);f.closed=true;t.mock.method(consumption,'view',()=>({obtained:2,remaining:1,incorporatedAwaitingCheck:1,draftOnly:true}));
 tx.commit(f.a,()=>f.draft('partial-second-batch'));assert.equal(f.e.pendingCheck.status,'deferred_evidence');assert.equal(pending.inspect(f.a,f.j).reason,'CHECK_EVIDENCE_NOT_INTEGRATED');
});
test('B6 complete typed coverage does not claim content checks ahead of unfinished prerequisites',t=>{
 const f=fixture(t);f.closed=true;f.task.steps.unshift({id:'prerequisite',kind:'analysis',done:false,title:'核对前置事实'});
 tx.commit(f.a,()=>f.draft('with-prerequisite'));assert.equal(f.e.pendingCheck.status,'deferred_evidence');assert.equal(pending.inspect(f.a,f.j).reason,'CHECK_PREREQUISITES_PENDING');assert.equal(pending.prepare(f.a,f.j),false);
});
test('B6 integration counts never authorize a changed original input',t=>{
 const f=fixture(t);idle(f);f.closed=true;t.mock.method(consumption,'view',()=>({obtained:2,remaining:0,incorporatedAwaitingCheck:2,draftOnly:true}));
 f.source.content+=' changed in place';const extra=agent.source(f.a,f.j,'extra','额外','补充');f.task.sourceIds.push(extra.id);access.retain(f.a,'source',extra,{task:f.task,job:f.j});
 assert.equal(pending.inspect(f.a,f.j).reason,'CHECK_DEFERRED_INPUT_CHANGED');assert.equal(pending.prepare(f.a,f.j),false);
});
test('B6 a replacement partial draft archives only an unclaimed deferred receipt',t=>{
 const f=fixture(t),old=structuredClone(f.e.pendingCheck);tx.commit(f.a,()=>f.draft('next-draft'));
 assert.equal(f.e.pendingCheck.status,'deferred_evidence');assert.equal(f.e.pendingCheck.artifactId,'next-draft');assert.equal(f.e.checkReceipts.length,1);assert.equal(f.e.checkReceipts[0].generationAttemptId,old.generationAttemptId);assert.equal(f.e.checkReceipts[0].status,'superseded');assert.equal(f.e.cycles,1);
});
test('B6 pending, claimed, interrupted and unknown checks cannot be downgraded by a new draft',async t=>{
 for(const status of ['pending','claimed','interrupted','unknown'])await t.test(status,t=>{
  const f=fixture(t,{draftOnly:false});f.e.pendingCheck.status=status;if(status!=='pending'){f.e.pendingCheck.claimId='existing-claim';f.e.pendingCheck.claimedByRunId='old-run';}
  const before=structuredClone(f.e.pendingCheck),ids=f.a.data.artifacts.map(r=>r.id);
  assert.throws(()=>tx.commit(f.a,()=>f.draft('replacement',true)),err=>err.code==='CHECK_REQUEST_UNRESOLVED');
  assert.deepEqual(f.e.pendingCheck,before);assert.deepEqual(f.a.data.artifacts.map(r=>r.id),ids);assert.equal(f.task.primaryArtifactId,f.artifact.id);
 });
});
test('B6 paused activation stays deferred; prepared journal replay keeps identity and counters',t=>{
 const f=fixture(t);idle(f);f.closed=true;f.a.data.stewardship.paused=true;assert.equal(pending.prepare(f.a,f.j),false);assert.equal(f.e.pendingCheck.status,'deferred_evidence');
 f.a.data.stewardship.paused=false;assert.equal(pending.prepare(f.a,f.j),true);const before=structuredClone(f.e);require('../desktop/work-journal.cjs').replay(f.a);assert.deepEqual(f.e,before);
 assert.equal(require('../desktop/work-journal.cjs').read(f.a).events.filter(e=>e.type===pending.TYPE).length,1);
});
test('B6 direct file and Lark preparation/execution cannot publish draftOnly',async t=>{
 const f=fixture(t);t.mock.method(access,'assertTool',()=>{});
 for(const tool of ['write_file','lark_update']){
  await assert.rejects(writes.prepare(f.a,f.j,tool,{taskId:f.task.id}),err=>err.code==='DRAFT_EVIDENCE_INCOMPLETE');
  const record={id:'draft-action-'+tool,jobId:f.j.id,taskId:f.task.id,tool,status:'pending',target:path.join(f.dir,'draft.md'),baseline:{url:'https://fixture.invalid/doc'},args:{taskId:f.task.id}};
  await assert.rejects(writes.execute(f.a,f.j,record),err=>err.code==='DRAFT_EVIDENCE_INCOMPLETE');assert.equal(record.status,'pending');
 }
 assert.equal(f.a.data.agentActions.length,0);assert.equal(fs.existsSync(path.join(f.dir,'draft.md')),false);
});
test('B6 an old uncertain file action still receives read-only reconciliation',async t=>{
 const f=fixture(t);t.mock.method(access,'assertTool',()=>{});
 const target=path.join(f.dir,'old.md'),latest=path.join(f.dir,'latest.md');fs.writeFileSync(target,f.artifact.content);fs.writeFileSync(latest,f.artifact.content);
 const record={id:'old-action',key:'old-action',jobId:f.j.id,taskId:f.task.id,tool:'write_file',status:'uncertain',target,latestName:'latest.md',fileFormat:'md',artifactId:f.artifact.id,content:f.artifact.content,args:{taskId:f.task.id}};f.a.data.agentActions.push(record);
 t.mock.method(require('../desktop/agent-tools.cjs'),'outputFile',deny);t.mock.method(require('../desktop/agent-tools.cjs'),'publishLatest',deny);
 const result=await writes.execute(f.a,f.j,record);assert.equal(result.verified,true);assert.equal(record.status,'done');assert.equal(f.artifact.draftOnly,true);
});
test('B6 content pass clears draftOnly atomically, but does not imply result acceptance',async t=>{
 const f=fixture(t,{closed:true});assert.equal(f.e.pendingCheck.status,'pending');
 t.mock.method(require('../desktop/generation-context.cjs'),'call',async()=>{pending.claim(f.a,f.j,f.task);return {passed:true,summary:'受控检查：正文已满足要求',gaps:[]};});
 const result=await control.verifyContent(f.a,f.j,f.task);assert.equal(result.verification.passed,true);assert.equal(f.artifact.draftOnly,false);assert.equal(f.e.pendingCheck.status,'settled');assert.notEqual(f.task.status,'completed');assert.equal(f.task.verification?.passed,undefined);
 assert.ok(require('../desktop/acceptance.cjs').completionBlockers(f.a,f.j).length);
});
test('B6 a content failure or coverage loss never clears draftOnly',async t=>{
 for(const loss of [false,true])await t.test(loss?'coverage loss':'content failure',async t=>{
  const f=fixture(t,{closed:true});t.mock.method(require('../desktop/generation-context.cjs'),'call',async()=>{if(loss)f.closed=false;return {passed:loss,summary:'受控检查',gaps:loss?[]:['缺少说明']};});
  if(loss)await assert.rejects(control.verifyContent(f.a,f.j,f.task),err=>err.code==='EVIDENCE_REQUIRED');else assert.equal((await control.verifyContent(f.a,f.j,f.task)).verification.passed,false);
  assert.equal(f.artifact.draftOnly,true);
 });
});
test('B6 failed content-check commit rolls back both verification and draftOnly release',async t=>{
 const f=fixture(t,{closed:true}),old=structuredClone(f.e.pendingCheck),save=f.a.save.bind(f.a);
 t.mock.method(require('../desktop/generation-context.cjs'),'call',async()=>({passed:true,summary:'受控检查通过',gaps:[]}));
 t.mock.method(f.a,'save',()=>{if(f.task.contentVerification?.passed===true)throw Error('controlled persistence failure');return save();});
 await assert.rejects(control.verifyContent(f.a,f.j,f.task),/controlled persistence failure/);assert.equal(f.artifact.draftOnly,true);assert.notEqual(f.task.contentVerification?.passed,true);assert.deepEqual(f.e.pendingCheck,old);
});
test('B6 direct acceptance, completion checks and manual-complete cannot bypass draftOnly',async t=>{
 const f=fixture(t),acceptance=require('../desktop/acceptance.cjs');f.task.status='review';f.task.steps.forEach(s=>s.done=true);f.task.verification={passed:true,summary:'伪造已通过',gaps:[]};
 assert.ok(acceptance.reasons(f.a,f.task).some(r=>r.code==='draft_evidence'));
 assert.ok(acceptance.completionBlockers(f.a,f.j).some(r=>r.code==='draft_evidence'));
 assert.throws(()=>acceptance.preflight(f.a,{id:f.task.id}),/增量草稿/);
 assert.throws(()=>acceptance.markManualComplete(f.a,{id:f.task.id,confirmation:{summary:'完成'}}),err=>err.code==='DRAFT_EVIDENCE_INCOMPLETE');
 assert.throws(()=>acceptance.recordCompletionCheck(f.a,f.j,{passed:true,summary:'完成',gaps:[]},{basis:acceptance.completionBasis(f.a,f.j)}),err=>err.code==='COMPLETION_STALE');
 assert.equal(f.task.status,'review');assert.equal(f.artifact.draftOnly,true);
});
test('B6 progress projection uses the consumption module, without turning counts into completion',t=>{
 const f=fixture(t),expected={obtained:8,incorporatedAwaitingCheck:5,remaining:3,lastDraftAt:'2026-01-01T00:00:00Z',draftOnly:true,status:'committed'};
 t.mock.method(consumption,'view',()=>structuredClone(expected));const before=JSON.stringify(f.a.data),view=control.view(f.a,f.j);
 assert.deepEqual(view.evidenceConsumption,[{taskId:f.task.id,title:f.task.title,...expected}]);assert.equal(JSON.stringify(f.a.data),before);
});
test('B6 completed zero-call rounds show zero; unknown, unfinished and contradictory usage never do',async()=>{
 const {runUsageSummary,provenZeroModelCalls}=await import('../src/run-usage.mjs');
 const run={status:'done',startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:01:00Z',modelCalls:0,modelCallsDetail:[],usage:{reportedCalls:0,unknownCalls:0,unpricedCalls:0,totalTokens:0,estimatedUSD:0}};
 assert.equal(provenZeroModelCalls(run),true);assert.equal(runUsageSummary(run),'0 token · 折算 $0.0000 · 未调用模型');
 for(const status of ['approval','ready','retry','completed'])assert.equal(provenZeroModelCalls({...run,status}),true);
 for(const change of [{modelCalls:undefined},{modelCalls:'0'},{finishedAt:undefined},{status:'running'},{modelCallsDetail:[{status:'error'}]},{usage:{unknownCalls:1}},{usage:{unpricedCalls:1}},{usage:{reportedCalls:1}},{usage:{estimatedUSD:1}},{usage:{inputTokens:1}},{heldUSD:1},{unknownCalls:1},{finishedAt:'invalid'},{startedAt:'2027-01-01'}])assert.equal(provenZeroModelCalls({...run,...change}),false,JSON.stringify(change));
 assert.doesNotMatch(runUsageSummary({...run,usage:{unknownCalls:1}}),/未调用模型|\$0/);
});
