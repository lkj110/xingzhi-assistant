'use strict';
// Human acknowledgement concerns expression only. It never supplies evidence,
// changes a verdict to passed, or starts a check as a side effect of confirmation.
const {hash}=require('./evidence-basis.cjs');
const rows=v=>Array.isArray(v)?v:[];
const rechecks=new WeakMap();
const explicitRecheck=(a,task)=>rechecks.get(a)===task.id;
const reportValid=r=>r&&r.reportHash===hash({...r,reportHash:undefined});
function confirmedFor(task,s){
 const c=task.groundingMarkerConfirmation;
 return c?.actor==='user'&&c.basis===s.basis&&c.confirmedAt&&c.claims?.length>0&&c.recordHash===hash({...c,recordHash:undefined})?c.recordHash:null;
}
function authorizes(task,s,claim){
 // Model-local claim IDs may change between checks; exact artifact/text plus
 // the complete evidence basis is the stable identity of the human decision.
 return claim.kind==='proposal'&&!!confirmedFor(task,s)&&task.groundingMarkerConfirmation.claims.some(c=>c.artifactId===claim.artifactId&&c.text===claim.text);
}
function pendingResult(result){
 const r=result?.grounding;
 if(result?.passed!==false||r?.passed!==false||r.reviewDisposition!=='marker_confirmation'||!reportValid(r)||!rows(r.markerReview).length)return false;
 const issues=r.markerReview.map(c=>c.issue);
 // Coverage validation can add hard gaps AFTER grounding.finish. Such a result
 // must never be downgraded to a human expression question.
 return rows(r.issues).length===issues.length&&r.issues.every(i=>issues.includes(i))&&Array.isArray(result.gaps)&&result.gaps.length===issues.length&&result.gaps.every(g=>issues.includes(g));
}
function route(a,task,result){
 const prior=task.markerReviewHold;
 if(!pendingResult(result)){
  delete task.markerReviewHold;
  if(prior){task.waitingOn='';if(task.status==='waiting')task.status=result.passed?'todo':'blocked';}
  return false;
 }
 const r=result.grounding;
 if(r.basis!==require('./grounding.cjs').snapshot(a,task).basis)return false;
 task.markerReviewHold={reportHash:r.reportHash,phase:r.phase};
 task.markerManualAcceptance=true;
 task.status='waiting';task.waitingOn='表达标记待人工确认；确认后仍须重新核验和手动验收。';
 task.nextCheckAt=null;task.followupDue=false;
 return true;
}
function assertRunnable(a,task){
 if(task.markerReviewHold&&!explicitRecheck(a,task))throw Object.assign(Error('表达标记待人工确认，请在事项详情确认后使用“重新核验”；不会自动重试或修稿'),{code:'MARKER_CONFIRMATION_REQUIRED',automaticRetry:false,taskId:task.id});
}
// Keep the affected task manual even after a later revision or settings change.
// This also prevents the separate manual-completion shortcut bypassing checks.
function requiresManualAcceptance(_a,task){return !!(task.markerManualAcceptance||task.markerReviewHold||task.groundingMarkerConfirmation||task.grounding?.humanMarkerConfirmation);}
function invalidateForUserEdit(_a,task){
 // Called only by an explicit user edit/feedback after requeue. Even feedback
 // repeating an existing requirement clears the saved check, so release its
 // hold unconditionally; the evidence basis still governs any later reuse.
 if(task.markerReviewHold){
  delete task.markerReviewHold;task.waitingOn='';
 }
}
function commandState(a,input,action,{allowStale=false}={}){
 if(!require('./workspace-view.cjs').trustedCommand(a,action))throw Error('表达确认与重新核验只能由事项详情中的明确操作发起');
 a.ensureIdle({taskId:input.id});
 const task=a.task(input.id);require('./project-lifecycle.cjs').assertTaskActive(a.data,task);
 const job=a.data.delegations.find(j=>j.id===task.agentJobId);
 if(task.agentCancelled||task.acceptedAt||['completed','paused'].includes(task.status)||job&&(job.status==='paused'||job.executionPaused))throw Error('事项或委托已暂停或结束，请先核对状态');
 if(!require('./grounding.cjs').enabled(a))throw Error('请先开启严格证据核验');
 const report=task.grounding,hold=task.markerReviewHold;
 if(!hold||hold.reportHash!==input.expectedReportHash||report?.reportHash!==hold.reportHash||!reportValid(report))throw Error('待确认报告已变化，请刷新后核对');
 const s=require('./grounding.cjs').snapshot(a,task);
 const check=hold.phase==='content'?task.contentVerification:task.verification;
 // Ordinary user edits invalidate the saved check. A stale, hash-bound hold
 // may request a fresh check, but can never authorize the old expression.
 if(!(allowStale&&s.basis!==report.basis)&&!pendingResult({...check,grounding:report}))throw Error('当前还有其他核验缺口，不能仅确认表达标记');
 if(!allowStale&&s.basis!==report.basis)throw Error('稿件、要求或证据已变化，请先重新核验');
 return {task,job,report,s};
}
function confirm(a,input){
 const {task,report,s}=commandState(a,input,'confirmGroundingMarkers');
 if(confirmedFor(task,s)&&task.groundingMarkerConfirmation.reportHash===report.reportHash)return a.publicState();
 return a.commitOrdinary(()=>{
  const previous=confirmedFor(task,s)?task.groundingMarkerConfirmation.claims:[],seen=new Set();
  const claims=[...previous,...report.markerReview.map(c=>({id:c.claimId,artifactId:c.artifactId,text:c.text}))].filter(c=>{const key=JSON.stringify([c.artifactId,c.text]);if(seen.has(key))return false;seen.add(key);return true;});
  const confirmation={actor:'user',basis:s.basis,reportHash:report.reportHash,claims,confirmedAt:new Date().toISOString()};
  confirmation.recordHash=hash({...confirmation,recordHash:undefined});task.groundingMarkerConfirmation=confirmation;
  task.status='waiting';task.waitingOn='已记录表达确认，仍须点击“重新核验”，通过后手动验收。';task.nextCheckAt=null;task.followupDue=false;
  a.event('已记录表达标记确认','仅确认所列片段的表达方式；事实依据、执行状态和验收结论仍须核验。',task.id);
 });
}
function recheck(a,input){
 const {task,job,report,s}=commandState(a,input,'recheckGroundingMarkers',{allowStale:true});
 if(s.basis===report.basis&&!(confirmedFor(task,s)&&report.markerReview.every(c=>authorizes(task,s,{id:c.claimId,artifactId:c.artifactId,text:c.text,kind:'proposal'}))))throw Error('请先逐项核对并确认表达标记，或修改稿件后重新核验');
 if(report.phase==='content'&&!job)throw Error('内容检查所属委托已变化，请刷新');
 if(report.phase!=='content'&&(!task.steps.length||task.steps.some(s=>!s.done)))throw Error('当前仍有未完成步骤，请先完成已安排的修订；重新核验不会生成或改写正文');
 a.available('verify');
 if(report.phase!=='content')a.available('execute');
 return require('./execution.cjs').launch(a,{taskId:task.id,automatic:false},'人工请求重新核验 · '+task.title,async view=>{
  rechecks.set(view,task.id);
  const prior=view.activeAgentJob;
  try{
   if(report.phase==='content'){view.activeAgentJob=job;return await require('./execution-control.cjs').verifyContent(view,job,task);}
   return await view.advance(task.id);
  }finally{view.activeAgentJob=prior;rechecks.delete(view);}
 });
}
module.exports={confirmedFor,authorizes,pendingResult,route,assertRunnable,requiresManualAcceptance,invalidateForUserEdit,explicitRecheck,confirm,recheck};
