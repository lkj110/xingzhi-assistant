const crypto = require('node:crypto');
const rows = value => Array.isArray(value) ? value : [];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scope(a,id) {
  const task=a.data.tasks.find(t=>t.id===id);
  if(!task)throw Error('事项不存在');
  const jobs=rows(a.data.delegations).filter(j=>j.id===task.agentJobId||rows(j.taskIds).includes(id));
  const jobIds=new Set(jobs.map(j=>j.id));
  const dependentIds=new Set([id]);let changed=true;while(changed){changed=false;for(const t of a.data.tasks)if(!t.deletedAt&&!dependentIds.has(t.id)&&rows(t.dependsOn).some(d=>dependentIds.has(d))){dependentIds.add(t.id);changed=true;}}
  return {task,jobs,actions:rows(a.data.agentActions).filter(r=>r.taskId===id||jobIds.has(r.jobId)||jobs.some(j=>j.pendingActionId===r.id)),
    dependents:a.data.tasks.filter(t=>t.id!==id&&dependentIds.has(t.id)),
    captures:rows(a.data.captureQueue).filter(r=>r.target?.taskId===id||r.taskId===id),
    decisions:rows(a.data.decisions).filter(d=>jobIds.has(d.jobId)||(d.kind==='task_question'&&rows(d.taskIds).includes(id)))};
}
function permission(a,s){
 const execution=require('./execution.cjs');
 const resources=[{taskId:s.task.id},...s.jobs.map(j=>({jobId:j.id})),...s.dependents.map(t=>({taskId:t.id}))];
 const conflicts=resources.flatMap(r=>{const active=execution.conflict(a,r);return active?[{...r,label:active.label}]:[];});
 const unresolved=s.actions.some(r=>['running','uncertain'].includes(r.status));
 return {allowed:!conflicts.length&&!unresolved,reason:conflicts.length?'此事项或关联工作正在执行，请等待本轮结束':unresolved?'外部动作结果待核对，请先核对再操作':'',conflictingResources:conflicts};
}
function preview(a,input) {
  const s=scope(a,input.id);
  return {...permission(a,s),id:s.task.id,title:s.task.title,deletedAt:s.task.deletedAt||null,revision:hash(s),
    jobs:s.jobs.map(j=>({id:j.id,title:j.title})),dependents:s.dependents.map(t=>({id:t.id,title:t.title})),
    pendingActions:s.actions.filter(r=>r.status==='pending').length,
    captures:s.captures.filter(r=>['queued','processing','failed'].includes(r.status)).length,
    unresolved:s.actions.some(r=>['running','uncertain'].includes(r.status)),
    artifacts:rows(a.data.artifacts).filter(r=>r.taskId===s.task.id).length};
}
function sanitize(state,a) {
  state.deletedTasks=state.tasks.filter(t=>t.deletedAt).map(t=>({...permission(a||{data:state},scope(a||{data:state},t.id)),id:t.id,title:t.title,deletedAt:t.deletedAt,projectId:t.projectId||null,agentJobId:t.agentJobId||null,revision:t.trashRevision,artifactCount:rows(state.artifacts).filter(r=>r.taskId===t.id).length})).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt));
  state.tasks=state.tasks.filter(t=>!t.deletedAt);
}
function assertTask(task) {if(task?.deletedAt)throw Error('事项已删除，请先到工作台的「已删除」中恢复');}
function assertDispatch(a,action,input) {
  if(['advance','updateTask','taskAction','adoptArtifact','restoreGenerationCheckpoint'].includes(action))assertTask(a.data.tasks.find(t=>t.id===input.id));
}
function retain(current,restored) {
  // Undoing a project edit or restoring a backup must not undo a later deletion
  // or restoration. Keep the full task so its saved output and feedback survive.
  for(const task of rows(current.tasks).filter(t=>t.trashRevision)) {
    const index=restored.tasks.findIndex(t=>t.id===task.id);
    if(index>=0)restored.tasks[index]=structuredClone(task);else restored.tasks.push(structuredClone(task));
  }
}
const terminal = row => row.status==='completed' || !!row.acceptedAt;
const pick = (row,names) => Object.fromEntries(names.filter(key=>row[key]!==undefined).map(key=>[key,structuredClone(row[key])]));
const terminalFields=['acceptedAt','acceptedBy','acceptedRevision','acceptedInputRevision','completedAt','completionMode','finalDelivery','acceptanceHistory'];
function projectEvent(a,target,event) {
  const p=event.payload,at=event.at,restore=p.restore;
  if(event.type==='task_scope_changed') {
    if(!target)return;
    if(event.entityKind==='job') {
      // Deleting or restoring a child never reopens a completed delegation.
      if(p.terminal)Object.assign(target,p.terminal);
      else {target.status='paused';target.executionPaused=true;}
      target.nextRunAt=null;target.resumeWatching=false;target.pendingActionId=null;
      delete target.rulePausedState;delete target.acceptanceCheckpoint;delete target.completionCheck;
      target.updatedAt=at;
      if(!p.terminal)target.summary=restore?'事项已恢复，核对计划后可手动恢复委托':'事项已删除，委托已暂停；核对剩余范围后可手动恢复委托';
      target.feedback ||= [];
      if(!target.feedback.some(row=>row.eventId===event.eventId))target.feedback.push({eventId:event.eventId,at,kind:'task_lifecycle',taskId:p.taskId,text:restore?`用户恢复事项 ${p.taskId}；沿用原事项并核对现有成果，不自动重开已验收工作。`:`用户删除事项 ${p.taskId}；保留历史，不得自动恢复或重建此事项。`});
      target.feedback=target.feedback.slice(-30);
      for(const f of rows(target.followups))if(p.followupKeys.includes(f.key)&&f.status==='waiting'){f.status='cancelled';f.cancelledAt=at;f.cancelReason='事项范围已变化，继续前需重新安排跟进';}
    } else if(p.terminal) {
      Object.assign(target,p.terminal);
      target.recoveryReview={code:'DEPENDENCY_CHANGED',eventId:event.eventId,taskId:p.taskId};
    } else {
      target.needsReplan='前置事项发生删除或恢复，请核对计划与当前成果';
      target.verification=null;delete target.completedAt;delete target.acceptedAt;delete target.acceptedBy;
      if(target.status==='paused')target.previousStatus='todo';else target.status='todo';
      target.waitingOn='';target.nextCheckAt=null;target.followupDue=false;
    }
    return;
  }
  // The IDs were preflighted at the commit boundary; replay never broadens scope
  // to a newly created approval, decision or independent task.
  for(const action of rows(a.data.agentActions))if(p.actionIds.includes(action.id)&&action.status==='pending'){action.status='stale';delete action.approvedAt;action.staleReason='事项已删除或恢复，请重新准备动作';}
  for(const decision of rows(a.data.decisions))if(p.decisionIds.includes(decision.id)&&decision.status==='open'){decision.status='cancelled';decision.cancelledAt=at;decision.cancelReason='事项范围变化，恢复委托后重新核对';}
  for(const row of rows(a.data.captureQueue))if(p.captureIds.includes(row.id)&&['queued','processing','failed'].includes(row.status)){
    row.status='failed';row.updatedAt=at;row.lastError='目标事项已删除；材料保留。恢复事项后可手动重试。';
    row.autoRetry={...(row.autoRetry||{}),enabled:false,nextRetryAt:null,retryable:false};
  }
  for(const observation of rows(a.data.sourceObservations))if(p.observationIds.includes(observation.observationId)){
    observation.state='closed';observation.closeReason='事项已删除或恢复，历史观察不自动重开';observation.reason=observation.closeReason;observation.closedByWorkEvent=event.eventId;
    const decision=rows(a.data.decisions).find(d=>d.id===observation.decisionId);
    if(decision){decision.status='closed';decision.answer=observation.closeReason;decision.answeredAt=at;}
  }
  a.data.events ||= [];
  if(!a.data.events.some(row=>row.id===`work:${event.eventId}`))a.data.events.unshift({id:`work:${event.eventId}`,at,title:restore?'事项已恢复':'事项已删除',detail:restore?'保留原验收状态；未完成工作核对后再继续。':'材料、成果与费用记录保留，可在已删除列表恢复。',taskId:event.entityId,kind:'info'});
  a.data.events=a.data.events.slice(0,2000);
  if(!target)return;
  const original=p.trash;
  if(restore){
    delete target.deletedAt;delete target.trashState;target.restoredAt=at;
    target.agentCancelled=original.agentCancelled;
    if(original.cancelReason===undefined)delete target.cancelReason;else target.cancelReason=original.cancelReason;
    if(original.status==='completed'||original.acceptedAt){Object.assign(target,original);target.status='completed';delete target.needsReplan;delete target.previousStatus;}
    else {target.status='paused';target.previousStatus='todo';if(target.agentJobId&&!target.agentCancelled)target.needsReplan='事项从已删除中恢复，请核对计划与当前成果';}
    target.recoveryReview={code:'RESTORED_WORK',eventId:event.eventId};
  } else {
    target.trashState=structuredClone(original);target.deletedAt=at;target.agentCancelled=true;target.cancelReason='用户删除事项';
    target.status=original.status==='completed'||original.acceptedAt?'completed':'paused';
  }
  require('./work-journal.cjs').clearSchedule(target);
  target.nextCheckAt=null;target.updatedAt=at;target.trashRevision=p.trashRevision;
}
function change(a,input,restore) {
  require('./work-journal.cjs').beforeSave(a);
  const s=scope(a,input.id),{task}=s,permit=permission(a,s);if(!permit.allowed)throw Error(permit.reason);
  if(restore) {
    if(!task.deletedAt)throw Error('事项未删除，请刷新列表');
    if(input.revision!==task.trashRevision)throw Error('事项已变化，请刷新已删除列表');
  } else {
    if(task.deletedAt)throw Error('事项已经删除');
    if(input.revision!==hash(s))throw Error('事项或关联推进已变化，请重新打开删除确认');
  }
  const at=new Date().toISOString(),workEvents=[];
  const make=(target,kind,type,payload)=>({entityKind:kind,entityId:target.id,workRevision:target.workRevision??1,type,actor:'user',at,payload});
  const trash=restore?structuredClone(task.trashState||{status:task.acceptedAt?'completed':'todo',agentCancelled:false}):{status:task.status,agentCancelled:task.agentCancelled===true,...pick(task,['cancelReason',...terminalFields])};
  workEvents.push(make(task,'task',restore?'restored':'deleted',{restore,trash,trashRevision:crypto.randomUUID(),actionIds:s.actions.filter(r=>r.status==='pending').map(r=>r.id),decisionIds:s.decisions.filter(d=>d.status==='open').map(d=>d.id),captureIds:restore?[]:s.captures.map(r=>r.id),observationIds:rows(a.data.sourceObservations).filter(o=>o.scope?.taskId===task.id).map(o=>o.observationId)}));
  for(const job of s.jobs)workEvents.push(make(job,'job','task_scope_changed',{restore,taskId:task.id,followupKeys:rows(job.followups).filter(f=>f.taskId===task.id&&f.status==='waiting').map(f=>f.key),terminal:terminal(job)?{status:'completed',...pick(job,terminalFields)}:null}));
  for(const dependent of s.dependents.filter(t=>!t.agentCancelled))workEvents.push(make(dependent,'task','task_scope_changed',{restore,taskId:task.id,terminal:terminal(dependent)?{status:'completed',...pick(dependent,terminalFields)}:null}));
  require('./work-journal.cjs').commit(a,workEvents);
  return a.publicState();
}
function dispatch(a,action,input={}) {
  if(action==='taskTrashPreview')return preview(a,input);
  if(action==='taskTrashDelete')return change(a,input,false);
  if(action==='taskTrashRestore')return change(a,input,true);
  throw Error('未知事项删除操作');
}
module.exports={permission,scope,preview,sanitize,assertTask,assertDispatch,retain,dispatch,projectEvent};
