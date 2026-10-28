'use strict';
// Integration coverage uses deterministic verifier responses. No provider,
// network, installed application or historical sealed replay is invoked.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),grounding=require('../desktop/grounding.cjs');
const marker=require('../desktop/marker-confirmation.cjs'),acceptance=require('../desktop/acceptance.cjs');
const control=require('../desktop/execution-control.cjs'),facts=require('../desktop/execution-facts.cjs');
const notice='仅当东门关闭时，请在西门集合；其他情况仍在东门。';
const input='当日安排：仅当东门关闭时，集合地点改到西门；其他情况仍在东门。本通知只说明已有安排，尚未执行。';

function fixture(t,{linked=false,noticeCount=1}={}){
 const temp=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(temp,'xingzhi-marker-flow-'));let transportCalls=0;
 const prohibited=async()=>{transportCalls++;throw Error('Real model/network calls are prohibited');};
 const a=new Assistant({dir,chat:prohibited,webRequest:prohibited,connectorRequest:prohibited});
 const assistants=[a];t.after(()=>{for(const item of assistants){require('../desktop/access.cjs').cancel(item);require('../desktop/deadline-scheduler.cjs').dispose(item);}assert.equal(transportCalls,0);assert.ok(path.resolve(dir).startsWith(temp+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;a.data.settings.autoExtract=false;a.data.settings.autoComplete=true;
 a.data.providers=[{id:'offline-verifier',type:'openai',name:'Offline fixture',model:'fixture'}];a.data.settings.roles={execute:'offline-verifier',verify:'offline-verifier',organize:'offline-verifier'};
 const claimTexts=noticeCount===1?[notice]:Array.from({length:noticeCount},(_,i)=>'第'+(i+1)+'组：'+notice),content=claimTexts.join('\n');
 const sourceText=noticeCount===1?input:'当天各组既有安排如下：\n'+content+'\n本安排尚未执行。';
 a.addSources([{title:'当天安排原文',content:sourceText}]);const source=a.data.sources[0];
 const task=a.createTask({title:'集合通知',description:'根据现有安排写一份集合通知，准确保留条件。',criteria:'明确两个集合地点及各自条件。',sourceIds:[source.id],generationMode:'single',steps:[{title:'形成通知',kind:'draft'}]});
 grounding.captureUserInput(task,'description',task.description);
 const step=task.steps[0],draft={id:'marker-flow-draft',taskId:task.id,stepId:step.id,title:'集合通知',content,createdAt:new Date().toISOString()};
 a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});step.done=true;step.artifactId=draft.id;require('../desktop/deliverables.cjs').record(a,task,step,draft,{});
 let job;
 if(linked){job=require('../desktop/agent.cjs').buildJob(a,{goal:task.description,autoAccept:true,allowWeb:false});Object.assign(job,{title:'集合通知',status:'ready',taskIds:[task.id],sourceIds:[source.id],fileMode:'off'});task.agentJobId=job.id;a.data.delegations.push(job);t.mock.method(require('../desktop/agent-plan.cjs'),'assertReady',()=>{});}
 const state={a,task,source,draft,job,dir,assistants,prohibited,claimTexts,checks:0};
 t.mock.method(require('../desktop/generation-context.cjs'),'call',async (assistant,checkingTask,_prompt,payload,role)=>{
  assert.equal(role,'verify');state.checks++;return checked(state,{assistant,task:checkingTask,phase:payload.verificationPhase==='content'?'content':'result'});
 });
 a.save();return state;
}
function checked(f,{assistant=f.a,task=f.task,phase='result'}={}){
 const s=grounding.snapshot(assistant,task),seen=new Set();
 grounding.observe(seen,{artifacts:[f.draft],contextReads:[{result:{sourceId:f.source.id,version:s.sources[0].version,content:f.source.content}}]});
 grounding.observe(seen,grounding.context(assistant,task,{},'verify'));
 const claims=f.claimTexts.map((text,i)=>({id:f.claimIds?.[i]||'p'+(i+1),artifactId:f.draft.id,text,kind:'proposal',supported:true,citationIds:['e1']}));
 return grounding.finish(assistant,task,{passed:true,summary:'OFFLINE: independent verifier supports the bound notice',gaps:[],groundingReview:{format:'compact-v3',scannedArtifactIds:[f.draft.id],citations:[{id:'e1',sourceId:f.source.id,quote:f.source.content,start:0}],requirements:s.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:claims.map(c=>c.id)})),claims,unsupportedClaims:[],conflicts:[]}},{seen,phase});
}
const command=(f,action)=>f.a.dispatch('uiCommand',{action,input:{id:f.task.id,expectedReportHash:f.task.grounding.reportHash}});
async function confirmAndRecheck(f){await command(f,'confirmGroundingMarkers');await command(f,'recheckGroundingMarkers');await f.a.runPromise;}

test('result check enters explicit waiting without passed cache or automatic acceptance',async t=>{
 const f=fixture(t),original=f.draft.content;await f.a.advance(f.task.id);
 assert.equal(f.checks,1);assert.equal(f.task.status,'waiting');assert.equal(f.task.verification.passed,false);assert.equal(f.task.grounding.passed,false);
 assert.equal(f.task.grounding.reviewDisposition,'marker_confirmation');assert.ok(f.task.markerReviewHold);assert.match(f.task.waitingOn,/人工|确认/);assert.equal(f.task.nextCheckAt,null);
 assert.equal(f.task.verificationCheckpoint,undefined);assert.equal(grounding.reusable(f.a,f.task),null);assert.equal(f.task.acceptedAt,undefined);assert.equal(f.draft.content,original);
 assert.throws(()=>grounding.assertDelivery(f.a,f.task),{code:'GROUNDING_REQUIRED'});
});

test('ordinary advance, content check, retry and planner cannot turn marker waiting into automatic work',async t=>{
 const f=fixture(t,{linked:true});t.mock.method(require('../desktop/relation-obligations.cjs'),'validateCoverage',(_a,_j,_t,result)=>({result,receipts:[]}));
 await f.a.advance(f.task.id);const before=f.checks;
 await assert.rejects(f.a.advance(f.task.id),{code:'MARKER_CONFIRMATION_REQUIRED'});
 await assert.rejects(f.a.dispatch('advance',{id:f.task.id}),{code:'MARKER_CONFIRMATION_REQUIRED'});
 await assert.rejects(control.verifyContent(f.a,f.job,f.task),{code:'MARKER_CONFIRMATION_REQUIRED'});
 assert.equal(facts.candidateActions(f.a,f.job).length,0);assert.equal(control.peek(f.a,f.job),null);
 // Even a stale scheduler's status or planning flag cannot bypass the hold.
 f.task.status='todo';f.task.needsReplan='旧恢复动作';assert.equal(facts.taskPhase(f.task),'waiting');assert.equal(facts.candidateActions(f.a,f.job).length,0);
 await assert.rejects(f.a.advance(f.task.id),{code:'MARKER_CONFIRMATION_REQUIRED'});assert.equal(f.checks,before);
});

test('UI confirmation itself invokes no model and persists an unpassed waiting state across restart',async t=>{
 const f=fixture(t);await f.a.advance(f.task.id);const before=f.checks;
 await command(f,'confirmGroundingMarkers');assert.equal(f.checks,before);assert.equal(f.task.status,'waiting');assert.equal(f.task.verification.passed,false);assert.equal(f.task.grounding.passed,false);
 const context=f.a.context(f.task,{verification:true}),serialized=JSON.stringify(context);
 assert.equal(context.task.waitingOn,'');assert.equal(serialized.includes(f.task.waitingOn),false);assert.equal(serialized.includes('markerReviewHold'),false);assert.equal(serialized.includes('groundingMarkerConfirmation'),false);
 const view=f.a.publicState({summary:true}).tasks.find(t=>t.id===f.task.id);assert.ok(view.markerReviewHold);assert.ok(view.groundingMarkerConfirmation);
 const restored=new Assistant({dir:f.dir,chat:f.prohibited,webRequest:f.prohibited,connectorRequest:f.prohibited});f.assistants.push(restored);const task=restored.task(f.task.id);
 assert.ok(task.markerReviewHold);assert.ok(task.groundingMarkerConfirmation);assert.equal(task.status,'waiting');assert.equal(task.verification.passed,false);
 await assert.rejects(restored.advance(task.id),{code:'MARKER_CONFIRMATION_REQUIRED'});assert.equal(f.checks,before);
});

test('pause/resume and independent scheduling retain the explicit human hold',async t=>{
 const f=fixture(t);await f.a.advance(f.task.id);const before=f.checks;
 await f.a.dispatch('taskAction',{id:f.task.id,command:'pause'});assert.equal(f.task.status,'paused');
 await f.a.dispatch('taskAction',{id:f.task.id,command:'resume'});assert.equal(f.task.status,'waiting');assert.ok(f.task.markerReviewHold);
 f.task.status='todo';assert.equal(f.a.parallelTasks(),false);assert.equal(f.a.executions.size,0);assert.equal(f.checks,before);
});

test('an explicit criteria edit invalidates marker hold and confirmation without blocking ordinary fresh checking',async t=>{
 const f=fixture(t);await f.a.advance(f.task.id);await command(f,'confirmGroundingMarkers');
 const oldConfirmation=f.task.groundingMarkerConfirmation.recordHash;
 await f.a.dispatch('updateTask',{id:f.task.id,criteria:f.task.criteria+'另须保持通知简短。'});
 assert.equal(f.task.verification,null);assert.equal(f.task.markerReviewHold,undefined);
 await assert.rejects(command(f,'confirmGroundingMarkers'));
 await assert.rejects(command(f,'recheckGroundingMarkers'));
 await f.a.advance(f.task.id);
 assert.equal(f.checks,2);assert.equal(f.task.verification.passed,false);assert.equal(f.task.status,'waiting');assert.equal(f.task.grounding.reviewDisposition,'marker_confirmation');
 assert.equal(f.task.grounding.humanMarkerConfirmation,undefined);assert.equal(f.task.groundingMarkerConfirmation.recordHash,oldConfirmation);
 assert.equal(marker.confirmedFor(f.task,grounding.snapshot(f.a,f.task)),null);
});

test('explicit feedback repeating existing criteria clears a stale hold even when deduplicated grounding basis is unchanged',async t=>{
 const f=fixture(t);await f.a.advance(f.task.id);await command(f,'confirmGroundingMarkers');
 const before=grounding.snapshot(f.a,f.task).basis,confirmation=f.task.groundingMarkerConfirmation.recordHash;
 await f.a.dispatch('taskAction',{id:f.task.id,command:'feedback',note:f.task.criteria});
 assert.equal(grounding.snapshot(f.a,f.task).basis,before);assert.equal(f.task.verification,null);assert.equal(f.task.markerReviewHold,undefined);assert.equal(f.task.status,'todo');
 assert.equal(f.task.groundingMarkerConfirmation.recordHash,confirmation);assert.equal(marker.requiresManualAcceptance(f.a,f.task),true);
 await f.a.advance(f.task.id);assert.equal(f.checks,2);assert.equal(f.task.verification.passed,true,f.task.lastError);assert.equal(f.task.status,'review');assert.equal(f.task.acceptedAt,undefined);
 assert.throws(()=>acceptance.acceptTask(f.a,{id:f.task.id},{actor:'policy'}),{code:'MANUAL_ACCEPTANCE_REQUIRED'});
});

test('explicit revision clears only the obsolete hold; the recheck command cannot generate a new draft',async t=>{
 const f=fixture(t);await f.a.advance(f.task.id);await command(f,'confirmGroundingMarkers');
 await f.a.dispatch('taskAction',{id:f.task.id,command:'revise',note:'修改通知表达，并保持原安排与条件。'});
 assert.equal(f.task.markerReviewHold,undefined);assert.equal(f.task.status,'todo');assert.ok(f.task.steps.some(s=>!s.done));assert.ok(f.task.groundingMarkerConfirmation);
 await assert.rejects(command(f,'recheckGroundingMarkers'));assert.equal(f.checks,1);
 assert.doesNotThrow(()=>marker.assertRunnable(f.a,f.task));assert.equal(marker.requiresManualAcceptance(f.a,f.task),true);
});

test('explicit recheck can pass but policy auto-completion stays disabled and user acceptance remains required',async t=>{
 const f=fixture(t);await f.a.advance(f.task.id);await confirmAndRecheck(f);
 assert.equal(f.checks,2);assert.equal(f.task.verification.passed,true,f.task.lastError);assert.equal(f.task.status,'review');assert.equal(f.task.acceptedAt,undefined);
 assert.ok(f.task.grounding.humanMarkerConfirmation);assert.equal(marker.requiresManualAcceptance(f.a,f.task),true);assert.equal(f.task.markerReviewHold,undefined);
 assert.throws(()=>acceptance.acceptTask(f.a,{id:f.task.id},{actor:'policy'}),{code:'MANUAL_ACCEPTANCE_REQUIRED'});assert.equal(f.task.status,'review');
 acceptance.acceptOne(f.a,{id:f.task.id});assert.equal(f.task.status,'completed');assert.equal(f.task.acceptedBy,'user');assert.equal(f.checks,2);
});

test('all 21 marker issues survive result persistence so confirmation and explicit recheck remain usable',async t=>{
 const f=fixture(t,{noticeCount:21}),original=f.draft.content;assert.ok(f.source.content.length<=1200);
 await f.a.advance(f.task.id);assert.equal(f.task.status,'waiting');assert.equal(f.task.grounding.markerReview.length,21);
 assert.deepEqual(f.task.verification.gaps,f.task.grounding.markerReview.map(r=>r.issue));assert.equal(f.task.verification.gaps.length,21);
 await command(f,'confirmGroundingMarkers');assert.equal(f.checks,1);assert.equal(f.task.groundingMarkerConfirmation.claims.length,21);assert.equal(f.task.verification.passed,false);
 await command(f,'recheckGroundingMarkers');await f.a.runPromise;
 assert.equal(f.checks,2);assert.equal(f.task.status,'review');assert.equal(f.task.verification.passed,true,f.task.lastError);assert.equal(f.task.acceptedAt,undefined);assert.equal(f.task.markerReviewHold,undefined);assert.equal(f.draft.content,original);
 assert.throws(()=>acceptance.acceptTask(f.a,{id:f.task.id},{actor:'policy'}),{code:'MANUAL_ACCEPTANCE_REQUIRED'});
});

test('a marker issue with a claim ID over 1000 characters remains byte-exact through confirmation',async t=>{
 const f=fixture(t);f.claimIds=['claim-'+ 'x'.repeat(1001)];
 await f.a.advance(f.task.id);assert.equal(f.task.status,'waiting');
 const issue=f.task.grounding.markerReview[0].issue;assert.ok(issue.length>1000);assert.equal(f.task.verification.gaps[0],issue);assert.ok(issue.endsWith(f.claimIds[0]));
 await command(f,'confirmGroundingMarkers');assert.equal(f.checks,1);assert.equal(f.task.groundingMarkerConfirmation.claims[0].id,f.claimIds[0]);assert.equal(f.task.verification.passed,false);
 await command(f,'recheckGroundingMarkers');await f.a.runPromise;
 assert.equal(f.checks,2);assert.equal(f.task.verification.passed,true,f.task.lastError);assert.equal(f.task.status,'review');assert.equal(f.task.acceptedAt,undefined);
});

test('manual-complete escape hatch cannot substitute for marker confirmation and full checking',async t=>{
 const f=fixture(t);await f.a.advance(f.task.id);
 assert.throws(()=>acceptance.markManualComplete(f.a,{id:f.task.id,confirmation:{summary:'我确认完成'}}),{code:'MANUAL_ACCEPTANCE_REQUIRED'});
 await confirmAndRecheck(f);
 assert.throws(()=>acceptance.markManualComplete(f.a,{id:f.task.id,confirmation:{summary:'我确认完成'}}),{code:'MANUAL_ACCEPTANCE_REQUIRED'});
 assert.equal(f.task.status,'review');assert.equal(f.task.acceptedAt,undefined);
});

test('Agent complete performs its overall check and leaves confirmed-marker work for user acceptance even with autoAccept',async t=>{
 const f=fixture(t,{linked:true});t.mock.method(require('../desktop/relation-obligations.cjs'),'validateCoverage',(_a,_j,_t,result)=>({result,receipts:[]}));
 await f.a.advance(f.task.id);await confirmAndRecheck(f);assert.equal(f.task.status,'review');
 let overallChecks=0;t.mock.method(f.a,'callModel',async (_provider,_key,_messages,options)=>{assert.equal(options.stage,'goal_verify');overallChecks++;return {passed:true,summary:'OFFLINE: overall task scope checked',gaps:[]};});
 const result=await require('../desktop/agent.cjs').act(f.a,f.job,'complete',{});
 assert.equal(overallChecks,1);assert.equal(result.awaitingReview,true);assert.equal(result.completed,false);assert.equal(f.job.status,'review');assert.equal(f.task.status,'review');assert.equal(f.task.acceptedAt,undefined);
 assert.throws(()=>acceptance.acceptPolicy(f.a,f.job),{code:'MANUAL_ACCEPTANCE_REQUIRED'});
 acceptance.acceptOne(f.a,{id:f.task.id});assert.equal(f.task.status,'completed');assert.equal(f.task.acceptedBy,'user');assert.equal(f.job.status,'completed');
});

test('content verification sets waiting before continuation can activate automatic repair',async t=>{
 const f=fixture(t,{linked:true});t.mock.method(require('../desktop/relation-obligations.cjs'),'validateCoverage',(_a,_j,_t,result)=>({result,receipts:[]}));
 const observed=[];t.mock.method(require('../desktop/continuation-control.cjs'),'noteCheck',(_a,_j,task,check)=>{observed.push({status:task.status,passed:check.passed,hold:!!task.markerReviewHold});});
 const result=await control.verifyContent(f.a,f.job,f.task);
 assert.equal(result.verification.passed,false);assert.equal(f.task.status,'waiting');assert.ok(f.task.markerReviewHold);assert.deepEqual(observed,[{status:'waiting',passed:false,hold:true}]);
 assert.equal(control.peek(f.a,f.job),null);assert.equal(f.checks,1);
});

test('an existing repair episode settles its check without counting a human marker question as another failed repair',async t=>{
 const f=fixture(t,{linked:true}),cont=require('../desktop/continuation-control.cjs'),pending=require('../desktop/pending-check.cjs'),hash=require('../desktop/evidence-basis.cjs').hash;
 t.mock.method(require('../desktop/relation-obligations.cjs'),'validateCoverage',(_a,_j,_t,result)=>({result,receipts:[]}));
 const basis=cont.basis(f.a,f.job,f.task),episode={taskId:f.task.id,basis,intentBasis:hash({contract:f.job.goal,requirements:null}),cycles:2,cycleLimit:3,hops:1,executions:4,revisionPending:true};
 require('../desktop/operation-ledger.cjs').state(f.job).continuation={version:1,activeTaskId:f.task.id,activeBasis:basis,episodes:{[basis]:episode}};
 require('../desktop/step-evidence.cjs').record(f.a,f.task,f.task.steps[0]);
 f.a.activeAgentRun={id:'original-local-generation',steps:[{tool:'advance_task',args:{taskId:f.task.id},at:new Date().toISOString(),continuation:{basis}}]};
 pending.recordGenerated(f.a,f.job,f.task,f.task.steps[0],f.draft);f.a.activeAgentRun=null;assert.equal(episode.pendingCheck.status,'pending');
 const result=await control.verifyContent(f.a,f.job,f.task);
 assert.equal(result.verification.passed,false);assert.equal(episode.pendingCheck.status,'settled');assert.ok(episode.pendingCheck.settledCheckId);
 assert.equal(episode.cycles,2);assert.equal(episode.revisionPending,true);assert.equal(episode.blocked,undefined);assert.equal(f.task.status,'waiting');
 cont.settled(f.a,f.job,{tool:'verify_content',args:{taskId:f.task.id},result});
 assert.equal(episode.cycles,2);assert.equal(episode.blocked,undefined);assert.equal(f.task.status,'waiting');assert.notEqual(f.job.status,'blocked');assert.equal(f.checks,1);
});

for(const phase of ['result','content'])test('later relation coverage failure remains a hard block during '+phase+' verification',async t=>{
 const f=fixture(t,{linked:true});t.mock.method(require('../desktop/relation-obligations.cjs'),'validateCoverage',(_a,_j,_t,result)=>({result:{...result,passed:false,gaps:[...result.gaps,'业务关联缺少有效依据']},receipts:[]}));
 // Only continuation accounting is isolated; both real routing consumers see
 // the additional hard failure added after grounding.finish.
 t.mock.method(require('../desktop/continuation-control.cjs'),'noteCheck',()=>{});
 if(phase==='result')await f.a.advance(f.task.id);else await control.verifyContent(f.a,f.job,f.task);
 assert.equal(f.task.markerReviewHold,undefined);assert.notEqual(f.task.status,'waiting');
 const check=phase==='result'?f.task.verification:f.task.contentVerification;assert.equal(check.passed,false);assert.ok(check.gaps.includes('业务关联缺少有效依据'));assert.equal(f.checks,1);
});
