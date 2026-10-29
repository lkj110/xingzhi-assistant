'use strict';
const assert=require('node:assert/strict');
const {sha}=require('./identity.cjs');
const digest=draft=>sha(JSON.stringify({id:draft.id,title:draft.title,content:draft.content}));
function current(data,id){const task=data.tasks.find(t=>t.id===id);assert.ok(task,'Task disappeared');const draft=data.artifacts.find(a=>a.id===(task.primaryArtifactId||task.steps[0].artifactId));assert.ok(draft&&typeof draft.content==='string','Draft disappeared');return {task,draft};}
function marker(task){return task.status==='waiting'&&task.grounding?.reviewDisposition==='marker_confirmation'&&task.grounding.passed===false&&!!task.markerReviewHold;}
function confirmation(task,report,basis){const c=task.groundingMarkerConfirmation;return !!(c&&c.actor==='user'&&c.reportHash===report&&c.basis===basis&&c.recordHash&&c.confirmedAt);}
function assertReady(task){assert.equal(task.status,'review',task.lastError||'Not at review');assert.equal(task.grounding?.passed,true);assert.equal(task.verification?.passed,true);assert.equal(task.acceptedAt,undefined);}
function createPhases({snapshot}){
 let phase={kind:'closed'},lastResponse;
 return {
  get value(){return {...phase};},get response(){return lastResponse;},
  open(kind,context,extra={}){assert.ok(['work','recheck','closed'].includes(kind));phase={kind,caseId:context.id,taskId:context.taskId,...extra};context.evaluationPhase=extra.stage||kind;lastResponse=undefined;},
  async admit(call,context){
   assert.equal(context.id,phase.caseId,'Unplanned case');assert.notEqual(phase.kind,'closed','Unplanned model call while waiting for a person');
   if(phase.generated)assert.equal(call.role,'verify','Unplanned second generation');
   if(phase.kind==='recheck'){
    assert.equal(call.role,'verify','Human recheck cannot generate a draft');
    const {task,draft}=current(await snapshot(),phase.taskId);assert.equal(digest(draft),phase.draftHash,'Draft changed during human handoff');
    assert.ok(confirmation(task,phase.reportHash,phase.basis),'Recheck requires a current user confirmation');
   }
  },
  observed(response,call){
   lastResponse=response;
   if(call.role==='execute'&&['artifact','patch'].includes(response.kind))phase={...phase,generated:true};
   if(call.role==='verify'&&typeof response.passed==='boolean')phase={...phase,kind:'closed'};
   if(call.role==='execute'&&['wait','need_input','needs_evidence','needs_replan'].includes(response.kind))phase={...phase,kind:'closed'};
  }
 };
}
async function waitForHuman({read,check,deadline,guard,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 assert.ok(Number.isFinite(deadline));let last=now();
 const clock=()=>{const time=now();assert.ok(time>=last,'Clock moved backwards');last=time;if(time>=deadline)throw Object.assign(Error('Human action was not completed before the original round deadline'),{code:'HUMAN_PENDING'});return time;};
 for(;;){clock();await guard();const value=await read(),done=await check(value);await guard();const time=clock();if(done)return value;await pause(Math.min(200,deadline-time));}
}
module.exports={digest,current,marker,confirmation,assertReady,createPhases,waitForHuman};
