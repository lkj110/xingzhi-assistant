// Authoritative read-only projection. All job admission comes from policy.
const facts=require('./execution-facts.cjs');
const {rows,terminal,taskPhase,gate,blockingReasons,candidateActions,inFlight}=facts;
function recoveryState(job) {
  const state=job?.executionState?.workEfficiency;
  if(!state)return null;
  const failure=state.lastFailure||state.blocker?.lastFailure;
  return {phase:state.phase,error:failure?.message?{code:failure.code||state.blocker?.code||null,message:failure.message}:null};
}
function recoveryBlocked(recovery) {return ['awaiting_change','exhausted'].includes(recovery?.phase);}
function runnableActions(a, job, opts) {
  const p=require('./execution-policy.cjs').inspect(a,job,opts);
  return actionsFromPolicy(p);
}
function actionsFromPolicy(p) {
  return p.eligible?p.choices.filter(c=>c.eligible&&c.taskId).map(c=>({taskId:c.taskId,phase:c.phase,tool:c.phase==='deliver'?'verify_content':'advance_task'})):[];
}
function deadlineStage(data,target,isJob){
  const tasks=isJob?rows(data.tasks).filter(t=>rows(target.taskIds).includes(t.id)):[target];
  const stages=tasks.map(t=>require('./deadline-state.cjs').evaluate(t).stage).filter(s=>s!=='resolved');
  return ['overdue','imminent','soon','scheduled','none'].find(s=>stages.includes(s))||'none';
}
function workState(a, target) {
  return require('./projection-cache.cjs').run(()=>projectState(a,target));
}
function projectState(a, target) {
  if(!a.data) a={data:a};
  if(typeof target==='string') target=rows(a.data.tasks).find(t=>t.id===target)||rows(a.data.delegations).find(j=>j.id===target);
  if(!target) return null;
  const isJob=rows(a.data.delegations).some(j=>j.id===target.id),task=isJob?null:target,job=isJob?target:rows(a.data.delegations).find(j=>j.id===target.agentJobId);
  const pendingType=target.projectionPending?.type;
  const lifecycle=target.deletedAt?'deleted':['accepted','completed','manual_completed'].includes(pendingType)?'completed':target.status==='completed'?'completed':target.agentCancelled?'cancelled':target.status;
  const finished=terminal.has(lifecycle), blockers=blockingReasons(a,job,task);
  const jobPolicy=job?require('./execution-policy.cjs').inspect(a,job):null,policy=isJob?jobPolicy:null;
  const identityChoice=task&&jobPolicy?.choices.find(c=>c.taskId===task.id&&c.identity);
  const actions=policy?actionsFromPolicy(policy):[],recovery=recoveryState(job);
  const spendBlock=require('./spend-guard.cjs').inspect(a,job,task);
  const stopped=!finished&&(isJob?policy.phase==='blocked':identityChoice?.phase==='blocked'||lifecycle==='blocked'||spendBlock&&!['paused','limited'].includes(lifecycle));
  const currentPreflight=isJob&&(policy?.identity||['MODEL_PREFLIGHT_HEALTH_REQUIRED','MODEL_PREFLIGHT_HEALTH_CHANGED'].includes(policy?.reasonCode))?{code:policy.reasonCode,message:policy.reason}:identityChoice?{code:identityChoice.reasonCode,message:identityChoice.message}:null;
  const error=stopped?(spendBlock?{code:spendBlock.code,message:spendBlock.message}:currentPreflight||(isJob&&recoveryBlocked(recovery)?recovery?.error:null)||{code:target.lastErrorCode||job?.executionState?.workEfficiency?.blocker?.code||blockers[0]?.code||null,message:target.lastError||blockers[0]?.message||'没有可执行的恢复路径，等待执行条件变化'}):null;
  if(isJob&&!finished&&stopped)blockers.push({code:'recovery_blocked',id:`recovery:${job.id}`,scope:'job',needsHuman:false,message:error.message,errorCode:error.code});
  if(identityChoice&&!finished)blockers.push({code:'identity_preflight',id:`identity:${task.id}`,scope:'task',needsHuman:false,message:identityChoice.message,errorCode:identityChoice.reasonCode,resumeAt:identityChoice.resumeAt});
  if(task&&lifecycle==='completed'){
    const delivery=target.finalDelivery,refs=delivery?.artifactId?[delivery.artifactId]:rows(task.steps).map(s=>s.artifactId).filter(Boolean);
    if(refs.some(id=>!rows(a.data.artifacts).some(r=>r.id===id&&r.taskId===task.id))||delivery?.artifactHash&&rows(a.data.artifacts).some(r=>r.id===delivery.artifactId&&require('./evidence-basis.cjs').hash(r.content)!==delivery.artifactHash))blockers.push({code:'delivery_review',id:`delivery:${task.id}`,scope:'task',needsHuman:true,message:'历史已验收，交付资料需核对'});
  }
  let phase=finished?lifecycle:isJob?lifecycle:taskPhase(task);
  if(isJob&&!finished)phase=policy.phase;
  if(identityChoice&&!finished)phase=identityChoice.phase;
  const accepted=!!target.acceptedAt||lifecycle==='completed';
  const acceptance=require('./acceptance.cjs');
  const waitingCheck=phase==='review'&&job&&(isJob||acceptance.activeTasks(a,job).every(t=>t.status==='completed'||t.id===task.id))&&!acceptance.currentCompletionCheck(a,job);
  const acceptanceState=target.completionMode==='manual'?'manual':accepted?'accepted':phase==='finalizing'?'accepted_pending_check':waitingCheck?'awaiting_check':phase==='review'?'awaiting_acceptance':'not_ready';
  const pendingNodeIds=[...new Set(blockers.filter(r=>r.needsHuman&&(!finished||['uncertain','delivery_review'].includes(r.code))).map(r=>r.id).filter(Boolean))];
  const nextActions=isJob&&!finished&&job.executionPaused?[{type:'resume_execution',action:'agentResume'}]:finished?pendingNodeIds.map(id=>({type:id.startsWith('delivery:')?'review_delivery':'reconcile_external',id})):phase==='finalizing'||waitingCheck?[{type:'check_completion'}]:phase==='review'?[{type:'accept'}]:phase!=='blocked'&&actions.length?actions.map(r=>({type:'advance',...r})):[];
  return {lifecycle,phase,...(policy?{executionPolicy:policy}:{}),gate:gate(a,job,task),blockingReasons:blockers,nextActions,needsHuman:pendingNodeIds.length>0||phase==='review'&&!waitingCheck,acceptanceState,recovery,error,
    deadlineStage:finished?null:deadlineStage(a.data,target,isJob),finalDelivery:target.finalDelivery||null,activeCountKey:finished?null:`${isJob?'job':'task'}:${target.id}:${target.workRevision??1}`,pendingNodeIds,historyVisible:true,
    revision:{workRevision:target.workRevision??1,sequence:target.workEvent?.sequence||0},projectionPending:!!target.projectionPending,runnableActions:actions};
}
function project(a) {return {tasks:Object.fromEntries(rows(a.data.tasks).map(t=>[t.id,workState(a,t)])),jobs:Object.fromEntries(rows(a.data.delegations).map(j=>[j.id,workState(a,j)]))};}
module.exports={workState,view:workState,project,taskPhase,gate,blockingReasons,candidateActions,runnableActions,inFlight,recoveryState,recoveryBlocked};
