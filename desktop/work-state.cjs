// Authoritative read-only projection. publicState serializes this for every UI.
const rows=value=>Array.isArray(value)?value:[];
const terminal=new Set(['completed','cancelled','deleted']);
function taskPhase(task) {
  if(task.deletedAt) return 'deleted';
  if(task.status==='completed') return 'completed';
  if(task.agentCancelled) return 'cancelled';
  if(task.status==='paused') return 'paused';
  if(task.needsReplan) return 'reconcile';
  if(task.status==='review'&&task.verification?.passed) return 'review';
  if(task.status==='waiting') return 'waiting';
  const step=rows(task.steps).find(s=>!s?.done);
  return step?(step.kind==='external'?'deliver':'work'):task.verification?.passed===false?'repair':'verify';
}
function blocksTask(record, task) {
  const ids=[...rows(record.taskIds)]; if(record.taskId) ids.push(record.taskId);
  if(record.scope==='workspace'||record.scope==='job') return true;
  if(record.scope==='dependency') return ids.includes(task.id)||rows(task.dependsOn).some(id=>ids.includes(id));
  if(record.scope==='resource') return !!record.resourceKey&&rows(task.steps).some(s=>!s.done&&s.resourceKey===record.resourceKey);
  return ids.length?ids.includes(task.id):true;
}
function blockingReasons(a, job, task) {
  const reasons=[], belongs=r=>r.scope==='workspace'||job&&r.jobId===job.id||task&&(r.taskId===task.id||rows(r.taskIds).includes(task.id));
  for(const d of rows(a.data.decisions).filter(r=>r.status==='open'&&r.blocking!==false&&belongs(r)&&(!task||blocksTask(r,task)))) reasons.push({code:'decision',id:d.id,scope:d.scope|| (d.taskId||d.taskIds?.length?'task':'job'),needsHuman:true,message:d.question||'待处理决定'});
  for(const f of rows(job?.followups).filter(r=>r.status==='waiting'&&(!task||blocksTask(r,task)))) reasons.push({code:'followup',id:f.key,scope:f.scope||(f.taskId?'task':'job'),needsHuman:false,message:f.expected||'等待结果'});
  for(const r of rows(a.data.agentActions).filter(r=>['pending','uncertain','running'].includes(r.status)&&belongs(r)&&(!task||blocksTask(r,task)))) reasons.push({code:r.status==='uncertain'?'uncertain':'action',id:r.id,scope:r.scope||(r.taskId?'task':'job'),needsHuman:r.status!=='running',message:r.status==='uncertain'?'外部结果待核对':'动作尚未结束'});
  if(task) for(const id of rows(task.dependsOn)) { const dependency=rows(a.data.tasks).find(t=>t.id===id);if(!dependency||dependency.status!=='completed'||dependency.agentCancelled) reasons.push({code:'dependency',id,scope:'dependency',needsHuman:false,message:'前置事项未完成'}); }
  return reasons;
}
function gate(a, job, task) {
  const data=a.data, lifecycle=task?taskPhase(task):job?.status;
  const project=rows(data.projects).find(p=>p.id===(task?.projectId||job?.projectId));
  let reason=terminal.has(lifecycle)||terminal.has(job?.status)?'terminal':task?.projectionPending||job?.projectionPending||data.runtime?.projectionPending?'projection_pending':data.runtime?.workJournalError?'storage':project?.archivedAt?'archived':task?.status==='paused'||(job?.status==='paused'||job?.executionPaused)?'paused':a.suspended||data.runtime?.suspended?'suspended':data.stewardship?.paused?'workspace_paused':job?.status==='limited'||job?.limitReason?'budget':null;
  if(!reason&&data.stewardship?.window&&data.stewardship?.usage) {const status=require('./stewardship.cjs').status(a);if(!status.automaticAllowed) reason=status.reason;}
  if(!reason&&data.stewardship?.automaticAllowed===false) reason=data.stewardship.reason||'workspace_paused';
  return {automaticAllowed:!reason,reason,localAcceptanceAllowed:true};
}
function runnableActions(a, job) {
  if(!gate(a,job).automaticAllowed||job.deletedAt) return [];
  return rows(job.taskIds).map(id=>rows(a.data.tasks).find(t=>t.id===id)).filter(Boolean).filter(t=>t.status!=='blocked'||t.needsReplan||t.verification?.passed===false).filter(t=>!terminal.has(taskPhase(t))&&!['review','paused','waiting'].includes(taskPhase(t))&&!blockingReasons(a,job,t).length&&gate(a,job,t).automaticAllowed).map(t=>({taskId:t.id,phase:taskPhase(t),tool:taskPhase(t)==='deliver'?'verify_content':'advance_task'}));
}
function deadlineStage(data,target,isJob){
  const tasks=isJob?rows(data.tasks).filter(t=>rows(target.taskIds).includes(t.id)):[target];
  const stages=tasks.map(t=>require('./deadline-state.cjs').evaluate(t).stage).filter(s=>s!=='resolved');
  return ['overdue','imminent','soon','scheduled','none'].find(s=>stages.includes(s))||'none';
}
function workState(a, target) {
  if(!a.data) a={data:a};
  if(typeof target==='string') target=rows(a.data.tasks).find(t=>t.id===target)||rows(a.data.delegations).find(j=>j.id===target);
  if(!target) return null;
  const isJob=rows(a.data.delegations).some(j=>j.id===target.id),task=isJob?null:target,job=isJob?target:rows(a.data.delegations).find(j=>j.id===target.agentJobId);
  const pendingType=target.projectionPending?.type;
  const lifecycle=target.deletedAt?'deleted':['accepted','completed','manual_completed'].includes(pendingType)?'completed':target.status==='completed'?'completed':target.agentCancelled?'cancelled':target.status;
  const finished=terminal.has(lifecycle), blockers=blockingReasons(a,job,task), actions=isJob?runnableActions(a,job):[];
  if(task&&lifecycle==='completed'){
    const delivery=target.finalDelivery,refs=delivery?.artifactId?[delivery.artifactId]:rows(task.steps).map(s=>s.artifactId).filter(Boolean);
    if(refs.some(id=>!rows(a.data.artifacts).some(r=>r.id===id&&r.taskId===task.id))||delivery?.artifactHash&&rows(a.data.artifacts).some(r=>r.id===delivery.artifactId&&require('./evidence-basis.cjs').hash(r.content)!==delivery.artifactHash))blockers.push({code:'delivery_review',id:`delivery:${task.id}`,scope:'task',needsHuman:true,message:'历史已验收，交付资料需核对'});
  }
  let phase=finished?lifecycle:isJob?lifecycle:taskPhase(task);
  if(isJob&&!finished&&!['finalizing','paused','limited'].includes(lifecycle)) {
    if(lifecycle==='running'||rows(a.data.operations).some(o=>o.jobId===job.id)) phase='running';
    else if(actions.length) phase='ready';
    else if(blockers.length) phase=blockers.some(b=>b.needsHuman)?'needs_input':'watching';
  }
  const accepted=!!target.acceptedAt||lifecycle==='completed';
  const acceptance=require('./acceptance.cjs');
  const waitingCheck=phase==='review'&&job&&(isJob||acceptance.activeTasks(a,job).every(t=>t.status==='completed'||t.id===task.id))&&!acceptance.currentCompletionCheck(a,job);
  const acceptanceState=target.completionMode==='manual'?'manual':accepted?'accepted':phase==='finalizing'?'accepted_pending_check':waitingCheck?'awaiting_check':phase==='review'?'awaiting_acceptance':'not_ready';
  const pendingNodeIds=[...new Set(blockers.filter(r=>r.needsHuman&&(!finished||['uncertain','delivery_review'].includes(r.code))).map(r=>r.id).filter(Boolean))];
  const nextActions=isJob&&!finished&&job.executionPaused?[{type:'resume_execution',action:'agentResume'}]:finished?pendingNodeIds.map(id=>({type:id.startsWith('delivery:')?'review_delivery':'reconcile_external',id})):phase==='finalizing'||waitingCheck?[{type:'check_completion'}]:phase==='review'?[{type:'accept'}]:actions.length?actions.map(r=>({type:'advance',...r})):[];
  return {lifecycle,phase,gate:gate(a,job,task),blockingReasons:blockers,nextActions,needsHuman:pendingNodeIds.length>0||phase==='review'&&!waitingCheck,acceptanceState,
    deadlineStage:finished?null:deadlineStage(a.data,target,isJob),finalDelivery:target.finalDelivery||null,activeCountKey:finished?null:`${isJob?'job':'task'}:${target.id}:${target.workRevision??1}`,pendingNodeIds,historyVisible:true,
    revision:{workRevision:target.workRevision??1,sequence:target.workEvent?.sequence||0},projectionPending:!!target.projectionPending,runnableActions:actions};
}
function project(a) {return {tasks:Object.fromEntries(rows(a.data.tasks).map(t=>[t.id,workState(a,t)])),jobs:Object.fromEntries(rows(a.data.delegations).map(j=>[j.id,workState(a,j)]))};}
module.exports={workState,view:workState,project,taskPhase,gate,blockingReasons,runnableActions};
