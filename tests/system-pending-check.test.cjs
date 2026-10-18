'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),pending=require('../desktop/pending-check.cjs'),cont=require('../desktop/continuation-control.cjs');
const work=require('../desktop/work-efficiency.cjs'),hash=require('../desktop/evidence-basis.cjs').hash;
const deny=()=>{throw Error('No external calls in pending-check tests');};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'system-pending-'));
 const a=new Assistant({dir,chat:deny,platformRequest:deny,connectorRequest:deny,webRequest:deny});
 t.after(()=>{require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 a.data.modelCalls ||= [];
 const j=agent.buildJob(a,{goal:'记录已知事实并更新原文档',autoAccept:false});a.data.delegations.push(j);
 const task=a.createTask({title:'报告',criteria:'保留已有事实',steps:[{title:'正文',kind:'draft',outputRole:'primary'},{title:'交付',kind:'external',tool:'lark_update'}]});task.agentJobId=j.id;j.taskIds=[task.id];
 const source=agent.source(a,j,'known','资料','已核实：周五发布');task.sourceIds=[source.id];require('../desktop/protocol-access.cjs').retain(a,'source',source,{task,job:j});
 work.before(a,j);Object.assign(j.executionState.workEfficiency,{attempts:18,phase:'recovery_pending',lastFailure:{code:'NO_NEW_EVIDENCE',message:'old'},tried:{old:{at:'2026-01-01'}},history:[]});
 const basis=cont.basis(a,j,task),intent=hash({contract:j.goal,requirements:null}),e={taskId:task.id,basis,intentBasis:intent,cycles:1,hops:2,revisionPending:true,executions:4};j.executionState.continuation={version:1,activeTaskId:task.id,activeBasis:basis,episodes:{[basis]:e}};
 const run={id:'run',jobId:j.id,status:'running',startedAt:'2026-01-01T00:00:00.000Z',steps:[{tool:'advance_task',args:{taskId:task.id},at:'2026-01-01T00:00:01.000Z',continuation:{handled:true,tracked:true,kind:'execution',basis}}]};a.data.agentRuns.unshift(run);a.activeAgentRun=run;a.activeAgentJob=j;a.automaticExecution=true;
 const step=task.steps[0],generationSnapshot=require('../desktop/revision-protocol.cjs').snapshot(a,task),artifact={id:'draft',taskId:task.id,stepId:step.id,title:'正文',content:'已核实：周五发布',createdAt:'2026-01-01T00:00:02.000Z',generationSnapshot};
 a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task,job:j});step.done=true;step.artifactId=artifact.id;require('../desktop/deliverables.cjs').record(a,task,step,artifact);require('../desktop/step-evidence.cjs').record(a,task,step);pending.recordGenerated(a,j,task,step,artifact);a.save();
 return {a,j,task,step,artifact,run,e,source,dir};
}
function recordCall(f,{id='call',at='2026-01-01T00:00:04.000Z',status='done'}={}){const c={id,runId:f.run.id,taskId:f.task.id,at,status,requestId:'request-'+id,usageReported:status==='done'};f.a.data.modelCalls.push(c);f.run.modelCallsDetail ||= [];f.run.modelCallsDetail.push(structuredClone(c));f.run.modelCalls=f.run.modelCallsDetail.length;return c;}
test('P03: execution pause precedes legacy no-progress and preserves owner/counters',t=>{
 const f=fixture(t),before=structuredClone(f.e);assert.equal(work.assertAllowed(f.a,f.j,{task:f.task}).allowed,true);
 f.a.data.stewardship.paused=true;assert.throws(()=>work.assertAllowed(f.a,f.j,{task:f.task}),e=>e.code==='EXECUTION_GATE_CLOSED'&&!e.noProgress&&e.gateClosed);
 assert.deepEqual(f.e,before);assert.equal(f.j.executionState.workEfficiency.attempts,18);assert.equal(f.a.data.decisions.length,0);
});
test('P03: generated output and check claim keep stable identity; settled check is not reissued',t=>{
 const f=fixture(t),id=f.e.pendingCheck.generationAttemptId,claim=pending.claim(f.a,f.j,f.task);
 assert.ok(claim);assert.equal(pending.permits(f.a,f.j,{task:f.task,phase:'content',claim}),true);
 assert.equal(pending.permits(f.a,f.j,{task:{...f.task,id:'other'},phase:'content',claim}),false);
 assert.equal(pending.permits(f.a,f.j,{task:f.task,phase:'result',claim}),false);
 assert.equal(pending.claim(f.a,f.j,f.task).claimId,claim.claimId);
 pending.noteCheck(f.a,f.j,f.task,{passed:false,basis:f.e.pendingCheck.checkBasis,at:'2026-01-01T01:00:00Z'},{phase:'content'});
 assert.equal(f.e.pendingCheck.status,'settled');assert.equal(pending.claim(f.a,f.j,f.task),null);assert.equal(f.e.pendingCheck.generationAttemptId,id);assert.equal(f.e.cycles,1);
});
test('P03: source/intent/replaced output/cycle exhaustion invalidate pending ownership',t=>{
 for(const change of [f=>f.source.content+='changed',f=>f.j.goal+='new',f=>f.artifact.content+='changed',f=>f.e.cycles=3,f=>f.e.blocked=true]){
  const f=fixture(t);change(f);assert.equal(pending.inspect(f.a,f.j).eligible,false);assert.equal(pending.claim(f.a,f.j,f.task),null);
 }
});
test('P03: interrupted claim retains identity only with settled request history; unknown stays guarded',t=>{
 const f=fixture(t);pending.claim(f.a,f.j,f.task);recordCall(f,{id:'unknown',at:'2098-01-01',status:'running'});pending.interrupt(f.a,f.j,f.task,{code:'EXECUTION_GATE_CLOSED',gateClosed:true});f.run.finishedAt='2099-01-01';f.a.activeAgentRun={id:'new',jobId:f.j.id,steps:[]};
 assert.throws(()=>pending.claim(f.a,f.j,f.task),e=>e.code==='CHECK_REQUEST_UNRESOLVED');
 const good=fixture(t),claim=pending.claim(good.a,good.j,good.task);recordCall(good,{at:'2098-01-01'});pending.interrupt(good.a,good.j,good.task,{code:'EXECUTION_GATE_CLOSED',gateClosed:true});good.run.finishedAt='2099-01-01';good.a.activeAgentRun={id:'new',jobId:good.j.id,steps:[]};assert.equal(pending.claim(good.a,good.j,good.task).claimId,claim.claimId);assert.equal(good.e.cycles,1);assert.equal(good.j.executionState.workEfficiency.attempts,18);assert.equal(good.e.pendingCheck.claimHistory[0].runId,'run');
});
test('P03: legacy pause proof is precise, idempotent and journal-backed; no generic new-hash revival',t=>{
 const f=fixture(t);delete f.e.pendingCheck;delete f.artifact.generationAttemptId;
 f.run.steps[0].result={taskId:f.task.id,status:'todo'};
 f.run.steps.push({tool:'verify_content',args:{taskId:f.task.id},at:'2026-01-01T00:00:03.000Z',errorCode:'WORK_STRATEGY_CHANGE',error:'old',continuation:{handled:true,tracked:true,basis:f.e.basis}});
 f.run.finishedAt='2026-01-01T00:00:09.000Z';f.run.status='needs_input';f.a.activeAgentRun=null;f.a.activeAgentJob=null;
 f.e.suspendedBy={code:'WORK_STRATEGY_CHANGE',at:'2026-01-01T00:00:08.000Z'};f.j.executionState.continuation.activeTaskId=null;
 f.a.data.events.unshift({id:'pause',title:'自动托管已暂停',at:'2026-01-01T00:00:05.000Z'});recordCall(f);
 const before=JSON.stringify(f.a.data),choice=pending.inspect(f.a,f.j);assert.equal(choice.eligible,true);assert.equal(choice.prepareRequired,true);assert.equal(JSON.stringify(f.a.data),before);
 f.a.data.events[0].at='2025-12-31';assert.equal(pending.inspect(f.a,f.j).eligible,false);f.a.data.events[0].at='2026-01-01T00:00:05.000Z';
 f.a.data.stewardship.paused=true;assert.equal(pending.prepare(f.a,f.j),false);f.a.data.stewardship.paused=false;
 assert.equal(pending.prepare(f.a,f.j),true);assert.equal(pending.prepare(f.a,f.j),false);assert.equal(f.j.executionState.continuation.activeTaskId,f.task.id);
 assert.equal(require('../desktop/work-journal.cjs').read(f.a).events.filter(e=>e.type===pending.TYPE).length,1);
 assert.equal(f.e.cycles,1);assert.equal(f.e.hops,2);assert.equal(f.j.executionState.workEfficiency.attempts,18);assert.equal(f.a.data.decisions.length,0);
});
test('P03: failed output save rolls back draft and pending check together',async t=>{
 const f=fixture(t),original=f.artifact.id,save=f.a.save.bind(f.a);
 // A new revision is legal only after the original check has settled.
 // An unresolved check must remain a barrier, even for a save-failure test.
 pending.claim(f.a,f.j,f.task);
 const check={passed:false,gaps:['正文需要补充已核实的发布时间'],basis:f.e.pendingCheck.checkBasis,at:new Date().toISOString()};
 pending.noteCheck(f.a,f.j,f.task,check);cont.noteCheck(f.a,f.j,f.task,check);
 const old=structuredClone(f.e.pendingCheck),cycles=f.e.cycles;let attempted=false;
 f.run.steps.push({tool:'advance_task',args:{taskId:f.task.id},at:new Date().toISOString(),continuation:{handled:true,tracked:true,kind:'execution',basis:f.e.basis}});
 f.step.done=false;delete f.step.artifactId;f.step.targetArtifactId=original;
 t.mock.method(require('../desktop/generation.cjs'),'run',async()=>({kind:'artifact',title:'新正文',content:'已核实：周五发布。新版'}));
 t.mock.method(f.a,'save',()=>{if(f.a.data.artifacts.some(r=>r.taskId===f.task.id&&r.id!==original)){attempted=true;throw Error('simulated output storage failure');}return save();});
 await f.a.advance(f.task.id);
 assert.equal(attempted,true,'the rollback test must reach the actual new-output save boundary: '+JSON.stringify({lastError:f.task.lastError,runs:f.task.progressRuns}));
 assert.deepEqual(f.a.data.artifacts.filter(r=>r.taskId===f.task.id).map(r=>r.id),[original]);assert.deepEqual(f.e.pendingCheck,old);assert.equal(f.e.cycles,cycles);
});
test('P03: a committed check is settled once even if Agent settlement is replayed',t=>{
 const f=fixture(t);pending.claim(f.a,f.j,f.task);
 const check={passed:false,gaps:['真实缺口'],basis:f.e.pendingCheck.checkBasis,at:new Date().toISOString()};
 pending.noteCheck(f.a,f.j,f.task,check);cont.noteCheck(f.a,f.j,f.task,check);const cycles=f.e.cycles;
 cont.noteCheck(f.a,f.j,f.task,check);pending.noteCheck(f.a,f.j,f.task,check);
 assert.equal(f.e.cycles,cycles);assert.equal(cycles,2);assert.equal(f.e.pendingCheck.status,'settled');assert.equal(pending.claim(f.a,f.j,f.task),null);
});
function legacyDecision(f){
 delete f.e.pendingCheck;delete f.artifact.generationAttemptId;
 f.run.steps[0].result={taskId:f.task.id,status:'todo'};
 f.run.steps.push({tool:'verify_content',args:{taskId:f.task.id},at:'2026-01-01T00:00:03.000Z',errorCode:'WORK_STRATEGY_CHANGE',error:'old technical failure',continuation:{handled:true,tracked:true,basis:f.e.basis}});
 f.run.finishedAt='2026-01-01T00:00:09.000Z';f.run.status='needs_input';f.a.activeAgentRun=null;f.a.activeAgentJob=null;
 f.e.suspendedBy={code:'WORK_STRATEGY_CHANGE',at:'2026-01-01T00:00:08.000Z'};f.j.executionState.continuation.activeTaskId=null;f.j.status='needs_input';f.j.lastError='old technical failure';f.j.failures=7;
 f.a.data.events.unshift({id:'pause',title:'自动托管已暂停',at:'2026-01-01T00:00:05.000Z'});recordCall(f);
 const decision={id:'technical',jobId:f.j.id,kind:'question',key:'progress:old',question:'当前证据下无法继续取得进展，你希望怎样处理？',context:'old technical failure',sourceIds:[],status:'open',taskIds:[f.task.id],createdAt:'2026-01-01T00:00:08.100Z'};f.a.data.decisions.push(decision);
 return decision;
}
test('P03 UI: technical resume is exact, idempotent, paused, and never a business answer',async t=>{
 const f=fixture(t),d=legacyDecision(f);f.a.data.stewardship.paused=true;
 const other={id:'business',jobId:f.j.id,kind:'question',key:'business',question:'必要业务问题',context:'unknown',sourceIds:[],status:'open',taskIds:[f.task.id]};f.a.data.decisions.push(other);f.a.save();
 const before=JSON.stringify({notes:f.task.notes,req:f.task.userRequirement,contract:f.j.executionContract,tried:f.j.executionState.workEfficiency.tried,cycles:f.e.cycles,hops:f.e.hops,failures:f.j.failures,ledger:f.a.spendLedger});
 const input={id:f.j.id,...pending.view(f.a,f.j)};assert.ok(input.proofId);
 assert.throws(()=>pending.resume(f.a,f.j,input),e=>e.code==='TRUSTED_UI_COMMAND_REQUIRED');
 await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input:{...input,proofId:'forged'}}),e=>e.code==='STATE_STALE');
 await f.a.dispatch('uiCommand',{action:'agentCheckResume',input});
 assert.equal(f.a.data.stewardship.paused,true);assert.equal(d.status,'answered');assert.equal(d.origin,'execution_recovery');assert.equal(d.answerBasis,undefined);assert.equal(other.status,'open');
 assert.equal(before,JSON.stringify({notes:f.task.notes,req:f.task.userRequirement,contract:f.j.executionContract,tried:f.j.executionState.workEfficiency.tried,cycles:f.e.cycles,hops:f.e.hops,failures:f.j.failures,ledger:f.a.spendLedger}));
 assert.equal(f.j.executionState.workEfficiency.attempts,18);assert.equal(f.a.data.modelCalls.length,1);
 const sequence=require('../desktop/work-journal.cjs').read(f.a).events.length,already=structuredClone(f.a.data),disk=fs.readFileSync(f.a.file);await f.a.dispatch('uiCommand',{action:'agentCheckResume',input});assert.equal(require('../desktop/work-journal.cjs').read(f.a).events.length,sequence);assert.deepEqual(f.a.data,already);assert.deepEqual(fs.readFileSync(f.a.file),disk);
 // Defense in depth: even a legacy answerBasis accidentally present on this
 // technical receipt must not make it a reusable business decision.
 const decisions=require('../desktop/decisions.cjs');d.answerBasis=decisions.signature(f.a,f.j);
 const result=decisions.ask(f.a,f.j,{key:d.key,question:d.question,context:'actual new question',taskIds:[f.task.id]});assert.notEqual(result.alreadyAnswered,true);
});
test('P03 UI: append failure changes nothing; committed projection failure replays once',async t=>{
 const f=fixture(t),d=legacyDecision(f);f.a.data.stewardship.paused=true;f.a.save();const input={id:f.j.id,...pending.view(f.a,f.j)},journal=require('../desktop/work-journal.cjs'),append=journal.append;
 const mock=t.mock.method(journal,'append',()=>{throw Error('before append');});
 await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),/before append/);assert.equal(d.status,'open');assert.equal(f.j.executionState.continuation.activeTaskId,null);mock.mock.restore();
 const save=f.a.save.bind(f.a);let fail=true;const saveMock=t.mock.method(f.a,'save',()=>{if(fail){fail=false;throw Error('projection disk failure');}return save();});
 await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),e=>e.committed===true);
 saveMock.mock.restore();journal.replay(f.a);assert.equal(d.status,'answered');assert.equal(f.j.executionState.continuation.activeTaskId,f.task.id);assert.equal(f.a.data.stewardship.paused,true);
 assert.equal(journal.read(f.a).events.filter(e=>e.type===pending.TYPE).length,1);assert.equal(f.e.cycles,1);assert.equal(f.e.hops,2);assert.equal(f.j.failures,7);
});

test('PC-P1-01: naked claimed cold start, truncated or conflicting durable calls never reopen check',async t=>{
 const f=fixture(t);pending.claim(f.a,f.j,f.task);f.run.finishedAt='2099-01-01';f.run.status='interrupted';f.run.modelCallsDetail=[];f.run.modelCalls=0;f.a.activeAgentRun={id:'new',jobId:f.j.id,steps:[]};assert.throws(()=>pending.claim(f.a,f.j,f.task),e=>e.code==='CHECK_REQUEST_UNRESOLVED');
 for(const change of [f=>{f.run.modelCalls=2;f.run.modelCallsDetail.push({id:'lost',at:'2026-01-01T00:00:06.000Z',status:'running'});},f=>f.run.modelCallsDetail[0].status='running',f=>delete f.run.modelCallsDetail]){const x=fixture(t),d=legacyDecision(x);change(x);assert.equal(pending.view(x.a,x.j),null);await assert.rejects(x.a.dispatch('uiCommand',{action:'agentCheckResume',input:{id:x.j.id,proofId:'none',decisionId:d.id,expectedRevision:x.a.data.runtime.revision,expectedWorkRevision:x.j.workRevision??1,expectedTaskRevision:x.task.workRevision??1}}));assert.equal(d.status,'open');}
});
test('PC-P1-02: resumed-before-error cannot be labelled pause; resume-after-error preserves proof',async t=>{
 const f=fixture(t),d=legacyDecision(f),input={id:f.j.id,...pending.view(f.a,f.j)};f.a.data.events.push({id:'resume',title:'自动托管已恢复',at:'2026-01-01T00:00:06.000Z'});assert.equal(pending.view(f.a,f.j),null);await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),e=>e.code==='STATE_STALE');assert.equal(d.status,'open');f.a.data.events.at(-1).at='2026-01-01T00:00:09.500Z';assert.ok(pending.view(f.a,f.j));
});
test('PC-P1-03: later sibling owner wins before commit and during committed replay',async t=>{
 const f=fixture(t),d=legacyDecision(f),input={id:f.j.id,...pending.view(f.a,f.j)},s=f.j.executionState.continuation;s.activeTaskId='sibling';s.activeBasis='sibling-basis';assert.equal(pending.view(f.a,f.j),null);await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),e=>e.code==='STATE_STALE');assert.equal(d.status,'open');assert.equal(s.activeTaskId,'sibling');
 s.activeTaskId=null;s.activeBasis=f.e.basis;const journal=require('../desktop/work-journal.cjs'),original=journal.project;const mock=t.mock.method(journal,'project',(a,event)=>{s.activeTaskId='sibling';s.activeBasis='sibling-basis';return original(a,event);});await f.a.dispatch('uiCommand',{action:'agentCheckResume',input:{id:f.j.id,...pending.view(f.a,f.j)}});mock.mock.restore();assert.equal(s.activeTaskId,'sibling');assert.equal(d.status,'open');journal.replay(f.a);assert.equal(s.activeTaskId,'sibling');assert.equal(d.status,'open');
});
test('PC-P2-01: registering identical generated receipt retains settled identity',t=>{
 const f=fixture(t);pending.claim(f.a,f.j,f.task);pending.noteCheck(f.a,f.j,f.task,{passed:true,basis:f.e.pendingCheck.checkBasis});const old=structuredClone(f.e.pendingCheck);pending.recordGenerated(f.a,f.j,f.task,f.step,f.artifact);assert.deepEqual(f.e.pendingCheck,old);assert.equal(pending.claim(f.a,f.j,f.task),null);
});
test('pause-claim-settle: pause at each checkpoint survives cold start without a new opportunity',async t=>{
 for(const point of ['before-claim','after-claim','after-check'])await t.test(point,async t=>{
  const f=fixture(t);f.run.modelCallsDetail=[];f.run.modelCalls=0;let claim;
  if(point!=='before-claim')claim=pending.claim(f.a,f.j,f.task);
  if(point==='after-check'){const check={passed:true,basis:f.e.pendingCheck.checkBasis,at:new Date().toISOString()};require('../desktop/state-transitions.cjs').commit(f.a,()=>{f.task.contentVerification=check;pending.noteCheck(f.a,f.j,f.task,check);cont.noteCheck(f.a,f.j,f.task,check);});}
  await f.a.dispatch('stewardshipPause',{});
  if(point==='before-claim')assert.throws(()=>pending.claim(f.a,f.j,f.task),e=>e.gateClosed);
  if(point==='after-claim')pending.interrupt(f.a,f.j,f.task,{code:'EXECUTION_GATE_CLOSED',gateClosed:true});
  f.run.status='paused';f.run.finishedAt=new Date().toISOString();f.a.activeAgentRun=null;f.a.activeAgentJob=null;f.a.save();const original=structuredClone(f.e),calls=f.a.data.modelCalls.length;
  const cold=new Assistant({dir:f.dir,chat:deny,platformRequest:deny,connectorRequest:deny,webRequest:deny});t.after(()=>{require('../desktop/access.cjs').cancel(cold);require('../desktop/deadline-scheduler.cjs').dispose(cold);});cold.automaticExecution=true;
  const j=cold.data.delegations.find(j=>j.id===f.j.id),task=cold.task(f.task.id),e=j.executionState.continuation.episodes[f.e.basis];assert.equal(cold.data.stewardship.paused,true);assert.deepEqual(e,original);assert.equal(agent.tick(cold),false);assert.equal(cold.data.modelCalls.length,calls);
  await cold.dispatch('stewardshipResume',{});cold.activeAgentRun={id:'resumed',jobId:j.id,steps:[]};cold.activeAgentJob=j;
  const resumed=pending.claim(cold,j,task);if(point==='after-check'){assert.equal(resumed,null);assert.equal(e.pendingCheck.status,'settled');}else{assert.ok(resumed);if(claim)assert.equal(resumed.claimId,claim.claimId);assert.equal(e.cycles,original.cycles);assert.equal(e.pendingCheck.generationAttemptId,original.pendingCheck.generationAttemptId);}assert.equal(cold.data.modelCalls.length,calls);
 });
});

test('PC-P1-01: only proven local input refusal permits a zero-call inherited claim',t=>{
 for(const mutate of [null,f=>{f.run.steps.at(-1).errorDiagnostic={source:'unknown'};},f=>{f.a.spendLedger.scopes['job:'+f.j.id].pending.orphan={reservedUSD:1};}]){
  const f=fixture(t),claim=pending.claim(f.a,f.j,f.task);f.run.modelCallsDetail=[];f.run.modelCalls=0;f.run.finishedAt=new Date().toISOString();f.run.status='blocked';f.run.error='local input size';const diagnostic={source:'codex_cli',kind:'input_too_large',actualChars:200,maxChars:100,inputPolicyVersion:'old'};f.run.steps.push({tool:'verify_content',args:{taskId:f.task.id},errorCode:'MODEL_CONFIG',errorDiagnostic:diagnostic});f.j.executionState.inputRecovery={attempts:{upgrade:{status:'ready',previousRunId:f.run.id,previousError:f.run.error,previousDiagnostic:diagnostic,preflight:{taskId:f.task.id,artifactId:f.artifact.id,contentBasis:f.e.pendingCheck.checkBasis}}}};f.a.spendLedger.scopes['job:'+f.j.id] ||= {pending:{}};f.a.activeAgentRun={id:'restored',steps:[]};if(mutate){mutate(f);assert.throws(()=>pending.claim(f.a,f.j,f.task),e=>e.code==='CHECK_REQUEST_UNRESOLVED');}else assert.equal(pending.claim(f.a,f.j,f.task).claimId,claim.claimId);
 }
});
test('PC-P1-01: recent and durable task, run, reserve and phase identities cannot disagree',t=>{
 for(const key of ['taskId','runId','spendScope','spendTicketId','stage','role']){const f=fixture(t);legacyDecision(f);const recent=f.a.data.modelCalls.at(-1),detail=f.run.modelCallsDetail.at(-1);if(['stage','role'].includes(key)){recent[key]=detail[key]=key==='stage'?'task_verify':'verify';}else if(['spendScope','spendTicketId'].includes(key))recent[key]=detail[key]='original';if(key==='runId')detail[key]='wrong';else recent[key]='wrong';assert.equal(pending.view(f.a,f.j),null,key);}
});
test('PC-P1-02: timed resume and ambiguous policy changes invalidate historical pause proof',async t=>{
 for(const title of ['定时暂停已结束','托管策略已更新']){const f=fixture(t),d=legacyDecision(f),input={id:f.j.id,...pending.view(f.a,f.j)};f.a.data.events.push({id:'change',title,at:'2026-01-01T00:00:06.000Z'});assert.equal(pending.view(f.a,f.j),null);await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),e=>e.code==='STATE_STALE');assert.equal(d.status,'open');}
});
test('PC-P1-01: join recent calls by identity before run filtering and reject duplicates',async t=>{
 for(const kind of ['other-run','duplicate','unrelated']){const f=fixture(t),d=legacyDecision(f),input={id:f.j.id,...pending.view(f.a,f.j)},recent=f.a.data.modelCalls.at(-1);
  if(kind==='other-run')recent.runId='another-run';
  else f.a.data.modelCalls.push({...recent,...(kind==='unrelated'?{id:'unrelated-call',runId:'another-run'}:{})});
  if(kind==='unrelated'){assert.ok(pending.view(f.a,f.j));continue;}
  assert.equal(pending.view(f.a,f.j),null,kind);await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),e=>e.code==='STATE_STALE');assert.equal(d.status,'open');
 }
});
