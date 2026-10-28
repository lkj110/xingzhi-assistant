'use strict';
// Bottom layer: facts only. Never import policy or a command/controller entry.
const rows=value=>Array.isArray(value)?value:[];
const terminal=new Set(['completed','cancelled','deleted']);
function taskPhase(task) {
  if(task.deletedAt) return 'deleted';
  if(task.status==='completed') return 'completed';
  if(task.agentCancelled) return 'cancelled';
  if(task.status==='paused') return 'paused';
  if(task.markerReviewHold) return 'waiting';
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
  for(const held of rows(a.data.tasks).filter(t=>!t.deletedAt&&!t.agentCancelled&&t.markerReviewHold&&(task?t.id===task.id:job&&rows(job.taskIds).includes(t.id))))reasons.push({code:'marker_confirmation',id:held.id,scope:'task',needsHuman:true,message:held.waitingOn||'表达标记待人工确认及显式重新核验'});
  const spend=require('./spend-guard.cjs').inspect(a,job,task);if(spend)reasons.push(spend);
  for(const d of rows(a.data.decisions).filter(r=>r.status==='open'&&r.blocking!==false&&belongs(r)&&(!task||blocksTask(r,task)))) reasons.push({code:'decision',id:d.id,scope:d.scope|| (d.taskId||d.taskIds?.length?'task':'job'),needsHuman:true,message:d.question||'待处理决定'});
  for(const f of rows(job?.followups).filter(r=>r.status==='waiting'&&(!task||blocksTask(r,task)))) reasons.push({code:'followup',id:f.key,scope:f.scope||(f.taskId?'task':'job'),needsHuman:false,message:f.expected||'等待结果'});
  for(const r of rows(a.data.agentActions).filter(r=>['pending','uncertain','running'].includes(r.status)&&belongs(r)&&(!task||blocksTask(r,task)))) reasons.push({code:r.status==='uncertain'?'uncertain':'action',id:r.id,scope:r.scope||(r.taskId?'task':'job'),needsHuman:r.status!=='running',message:r.status==='uncertain'?'外部结果待核对':'动作尚未结束'});
  if(task) for(const id of rows(task.dependsOn)) { const dependency=rows(a.data.tasks).find(t=>t.id===id);if(!dependency||dependency.status!=='completed'||dependency.agentCancelled) reasons.push({code:'dependency',id,scope:'dependency',needsHuman:false,message:'前置事项未完成'}); }
  return reasons;
}
function dispatchBlockers(a,job,task,{automatic=true}={}) {
 // The legacy manual Continue command permits replanning after an unscoped
 // question when the job has already left needs_input. Explicit scopes and
 // automatic admission remain blocking; this grants no tool permission.
 return blockingReasons(a,job,task).filter(r=>{
  if(automatic||job.status==='needs_input'||r.code!=='decision')return true;
  const d=rows(a.data.decisions).find(d=>d.id===r.id);
  return !(d?.kind==='question'&&!d.scope&&!d.taskId&&Array.isArray(d.taskIds)&&!d.taskIds.length);
 });
}
function gate(a, job, task, {now=Date.now(),readOnly=false,automatic=true}={}) {
  const data=a.data, project=rows(data.projects).find(p=>p.id===(task?.projectId||job?.projectId));
  const runtime=data.runtime||{};
  let reason=job?.deletedAt||terminal.has(job?.status)||task&&terminal.has(taskPhase(task))?'terminal':
    task?.projectionPending||job?.projectionPending||runtime.projectionPending||runtime.workJournal?.projectionPending||runtime.accessPolicyProjectionPending?'projection_pending':
    runtime.workJournalError||a.readOnlyRecovery||a.spendError?'storage':project?.archivedAt?'archived':
    task?.executionPaused||task?.status==='paused'||job?.status==='paused'||job?.executionPaused?'paused':
    a.suspended||runtime.suspended?'suspended':automatic&&data.stewardship?.paused?'workspace_paused':
    !readOnly&&(job?.status==='limited'||job?.limitReason)?'budget':null;
  let resumeAt=null,message=null;
  if(!reason&&automatic&&data.stewardship?.window&&data.stewardship?.usage) {
    const status=require('./stewardship.cjs').status(a,Number(new Date(now)));
    if(!status.automaticAllowed){reason=status.reason;message=status.message;resumeAt=status.nextAllowedAt;}
  }
  if(!reason&&automatic&&data.stewardship?.automaticAllowed===false)reason=data.stewardship.reason||'workspace_paused';
  if(!reason&&!readOnly){const spend=require('./spend-guard.cjs').inspect(a,job,task);if(spend){reason=spend.reason;message=spend.message;}}
  if(!reason&&job&&!require('./work-rules.cjs').canRun(a,job))reason='rule_guarded';
  if(!reason&&job&&(job.projectId&&require('./chat-streams.cjs').hasPending(a,job.projectId)||rows(data.connectors).some(c=>(c.jobId===job.id||job.projectId&&c.projectId===job.projectId||rows(job.connectorIds).includes(c.id))&&(c.cursor?.token||['partial','blocked'].includes(c.syncWindow?.status)))))reason='source_batch_pending';
  const messages={terminal:'工作已结束',projection_pending:'已提交状态正在恢复，恢复完成后继续',storage:'独立工作记录需要恢复核对，当前仅可查看已有资料',archived:'所属项目已归档',paused:'事项或委托已暂停',suspended:'设备已挂起，恢复后继续',workspace_paused:'自动托管已暂停，恢复后按原计划继续',budget:'当前累计额度不允许新调用',rule_guarded:'工作规则或执行范围已变化',source_batch_pending:'关联资料仍在同步，完成后继续'};
  return {automaticAllowed:!reason,reason,message:message||messages[reason]||reason,resumeAt,localAcceptanceAllowed:true};
}
function modelGuard(a,job,task,{role}={}) {
  if(a.data.settings?.roles&&['organize','execute','verify'].filter(r=>!role||r===role).some(r=>!rows(a.data.providers).some(p=>p.id===a.data.settings.roles[r])))return {code:'model_config',message:'请配置当前阶段的模型'};
  if(a.requireContextAccessPolicy){const access=require('./access-policy-store.cjs').checkTool(a,job,'model_request',{}, {taskId:task?.id});if(!access.allowed)return {code:access.code||'permission',message:'当前模型操作未授权、权限未知或已撤销'};}
  if(task&&rows(task.sourceIds).filter(id=>!rows(task.supersededSourceIds).includes(id)).some(id=>!require('./protocol-access.cjs').allowedObject(a,'source',rows(a.data.sources).find(s=>s.id===id),job,task)))return {code:'context_scope_denied',message:'当前事项的材料读取权限已变化'};
  return null;
}
// Existing writes and receipt reads retain their original permission scope.
// checkTool is the pure half of the same guard used by the concrete executor.
function actionGuard(a,job,record,{readOnly=false,now=Date.now()}={}) {
 if(typeof record?.tool!=='string'||!record.tool.trim())return {code:'ACTION_IDENTITY_INCOMPLETE',message:'原外部动作缺少有效工具身份，请先核对原执行记录'};
 if(!a.dir)return null;
 const deny=(code,message)=>({code,message}),access=require('./access-policy-store.cjs');
 let tool=record.tool,args=record.args||{},opts={taskId:record.taskId};
 if(tool==='request_confirmation'){
  const c=rows(a.data.connectors).find(c=>c.id===record.connectorId&&c.projectId===job.projectId&&c.kind==='chat');
  if(!c||c.target!==record.target||!record.larkOpenId||c.sendPolicy?.openId!==record.larkOpenId)return deny('ACTION_SCOPE_CHANGED','原消息的账号或会话授权已变化');
  if(readOnly){tool='read_message';args={connectorId:c.id};opts.principalScope={kind:'account',provider:'lark',subject:record.larkOpenId};}
  else {if(c.sendPolicy.mode==='off'||!Number.isFinite(Date.parse(c.sendPolicy.expiresAt))||Date.parse(c.sendPolicy.expiresAt)<=Number(new Date(now)))return deny('ACTION_PERMISSION_EXPIRED','会话发送授权已停止或到期');opts.action=record;}
 }else{
  if(record.tool==='write_file'&&require('node:path').dirname(record.target||'')!==job.outputFolder||record.tool.startsWith('github_')&&record.target!==job.githubRepo)return deny('ACTION_SCOPE_CHANGED','原交付目标已不在当前授权范围');
  const mode=require('./agent-writes.cjs').mode(job,record.tool,record.taskId);
  if(!readOnly&&mode==='off')return deny('ACTION_PERMISSION_REVOKED','此委托未允许该写入工具');
  if(readOnly)tool='prepare_'+tool;else opts.action=record;
 }
 const allowed=access.checkTool(a,job,tool,args,opts);
 return allowed.allowed?null:deny(allowed.code||'ACTION_PERMISSION_REQUIRED','当前操作未授权、权限未知或已撤销，请核对原授权范围');
}
// Structural candidates remain available to recovery planning even when the
// current controller cannot dispatch them. Keep permission/external gates here.
function candidateActions(a, job, opts={}) {
  if(!gate(a,job,null,opts).automaticAllowed||job.deletedAt) return [];
  return rows(job.taskIds).map(id=>rows(a.data.tasks).find(t=>t.id===id)).filter(Boolean).filter(t=>t.status!=='blocked'||t.needsReplan||t.verification?.passed===false||retryTask(a,job,t)||legacyRetryTask(a,job,t)).filter(t=>!terminal.has(taskPhase(t))&&!['review','paused','waiting'].includes(taskPhase(t))&&!dispatchBlockers(a,job,t,opts).length&&gate(a,job,t,opts).automaticAllowed).map(t=>({taskId:t.id,phase:taskPhase(t),tool:taskPhase(t)==='deliver'?'verify_content':'advance_task'}));
}

function legacyRetryTask(a,job,task){
 if(!['retry','running'].includes(job?.status)||!(job.failures>0&&job.failures<=2)||task.status!=='blocked')return false;
 const run=rows(a.data.agentRuns).find(r=>r.jobId===job.id&&r.finishedAt);
 return !!run?.steps?.some(s=>s.error&&!s.gateClosed&&(s.args?.taskId||s.args?.existingTaskId)===task.id);
}
function retryTask(a,job,task){const r=job?.autoRecovery;return !!r&&['scheduled','recovering'].includes(r.status)&&r.taskId===task.id&&!task.deletedAt&&!task.agentCancelled&&!task.needsReplan&&!['paused','completed','review','waiting'].includes(task.status)&&r.basis===require('./acceptance.cjs').basis(a,task);}
function tasks(a,job){return rows(job?.taskIds).map(id=>rows(a.data.tasks).find(t=>t.id===id&&(!t.agentJobId||t.agentJobId===job.id))).filter(t=>t&&!t.deletedAt&&!t.agentCancelled);}
function conflict(a,job,{currentExecutionId}={}) {
 const owner=a.executionOwner||a;
 if(owner.exclusiveOperation)return owner.exclusiveOperation;
 if(!owner.executions&&owner.operation)return owner.operation;
 const own=r=>currentExecutionId&&(r.key===currentExecutionId||r.id===currentExecutionId)&&r.context?.controller&&r.context.controller===a.controller;
 const row=[...(owner.executions?.values()||[])].find(r=>!own(r)&&(r.jobId===job.id||job.projectId&&r.projectId===job.projectId));
 if(row)return row;
 if(a.activeAgentJob?.id===job.id&&a.activeAgentRun?.status==='running'&&!a.activeAgentRun.finishedAt&&(!currentExecutionId||a.activeAgentRun.id!==currentExecutionId)&&![...(owner.executions?.values()||[])].some(own))return {jobId:job.id,id:a.activeAgentRun.id};
 return null;
}
function inFlight(a,job,opts){return !!conflict(a,job,opts);}
// A job-level history is not apportioned between tasks. Only the explicit
// continuation exhaustion receipt proves that the legacy stop belongs to A.
function legacyRecoveryApplies(a,job,task){
 const s=job.executionState?.workEfficiency;if(!s)return false;
 const f=s.lastFailure||s.blocker?.lastFailure;
 if(f?.scope==='job'||s.blocker?.scope==='job'||f?.code!=='CONTINUATION_EXHAUSTED')return true;
 const stopped=Object.values(job.executionState?.continuation?.episodes||{}).filter(e=>e.blocked&&(!f.taskId||e.taskId===f.taskId)&&(!f.message||e.reason===f.message));
 const ids=[...new Set(stopped.map(e=>e.taskId))];
 return ids.length!==1||!task||task.id===ids[0];
}
function deadlineClaimed(a,job,{deadlineClaims=[],operationId}={}) {
 if(!operationId||!deadlineClaims.length)return false;
 const wakes=require('./deadline-events.cjs').state(a).wakeIntents||{};
 return deadlineClaims.every(c=>{const w=wakes[c.id];return w&&['claimed','attached'].includes(w.status)&&w.operationId===operationId&&w.jobId===job.id&&w.taskId===c.taskId;});
}
function deadlinePending(a,job,at=Date.now()) {
 const events=require('./deadline-events.cjs');
 return Object.values(events.state(a).wakeIntents||{}).filter(w=>w.status==='pending'&&w.jobId===job.id).filter(w=>{
   const t=tasks(a,job).find(t=>t.id===w.taskId);if(!t||!gate(a,job,t,{now:at}).automaticAllowed)return false;
   const view=events.context(a.data,t,at),next=view.waiting?require('./deadline-scheduler.cjs').sourceCheck(a,t,job,at):null;
   return !view.terminal&&!view.paused&&!view.review&&!view.invalidScope&&!view.archived&&(view.hasNextStep||!!next);
 });
}
module.exports={actionGuard,dispatchBlockers,legacyRetryTask,deadlineClaimed,retryTask,rows,terminal,taskPhase,blocksTask,blockingReasons,gate,modelGuard,candidateActions,tasks,conflict,inFlight,legacyRecoveryApplies,deadlinePending};
