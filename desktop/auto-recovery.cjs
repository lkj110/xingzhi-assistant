const {randomUUID}=require('node:crypto');
const errors=require('./model-errors.cjs');
const now=()=>new Date().toISOString();
const phases={planner:'选择下一步',task_work:'生成文稿',task_verify:'检查文稿',goal_verify:'检查整体目标',json_repair:'修复输出格式'};
function retryable(error){return errors.fallbackEligible(error)||error?.modelFailure===true&&['MODEL_CLI','MODEL_INVALID_RESPONSE'].includes(error.code)&&error.automaticRetry===true;}
// Context corrections are local tool recovery, not timed model retries. The caller persists
// this ledger before its next paid request; changing run IDs or restarting never clears it.
function contextAttempt(a,target,failure,request,{stage='task_work',strategy=failure.recovery,contextRevision=null,requestBasis}={}){
 const context=require('./task-context.cjs'),hash=require('./evidence-basis.cjs').hash;
 const scope=target.kind?target:context.taskScope(target),task=scope.kind==='task'?a.data.tasks.find(t=>t.id===scope.taskId):null;
 const job=a.data.delegations?.find(j=>j.id===(scope.jobId||task?.agentJobId));
 if(!task&&!job)throw errors.contextError('CONTEXT_SCOPE_DENIED');
 const ledger=job?(require('./operation-ledger.cjs').state(job).recoveries ||= {}):(task.contextRecoveries ||= {});
 const basis=requestBasis||context.recoveryBasis(a,scope,request);
 const objectId=request?.sourceId||request?.artifactId||request?.ref||null;
 const key='context:'+hash({scope,code:failure.code,objectId,basis,strategy});
 const old=ledger[key];
 if(old)return {allowed:false,record:old,key,retryCondition:failure.retryCondition};
 const record={taskId:task?.id||null,jobId:job?.id||null,runId:a.activeAgentRun?.id||null,modelCallId:a.activeModelCall?.id||a.data.modelCalls?.[0]?.id||null,tool:request?.tool||'read_context',objectId,code:failure.code,contextRevision,stage,requestBasis:basis,strategy,result:'correction_returned',retryCondition:failure.retryCondition,at:now()};
 ledger[key]=record;
 const owner=task||job;owner.contextDiagnostics=[...(owner.contextDiagnostics||[]),record].slice(-50);
 return {allowed:true,record,key,retryCondition:record.retryCondition};
}
function contextExhausted(target,failure){
 return errors.contextError(failure.code,{message:'内部资料读取纠偏已尝试，当前条件未变化；已保留成功读取和文稿，需要修正引用、参数、关联或权限后继续。',noProgress:true,taskId:target.kind?target.taskId||null:target.id,jobId:target.jobId||target.agentJobId||null,recovery:'system_diagnostic',retryCondition:failure.retryCondition,safeAlternatives:failure.safeAlternatives});
}
function schedule(a,job,error){
  if(!retryable(error)||a.modelBudgetOwner)return false;
  const info=error.recoveryContext||{},old=job.autoRecovery;
  const consecutive=old&&['scheduled','recovering'].includes(old.status)?old.consecutive+1:1;
  const delay=Math.min(900000,60000*2**Math.min(consecutive-1,4));
  const task=a.data.tasks.find(t=>t.id===info.taskId&&t.agentJobId===job.id);
  job.autoRecovery={status:'scheduled',consecutive,errorCode:error.code,stage:info.stage||'planner',model:info.model||'',requestId:info.requestId||null,taskId:task?.id||null,basis:task?require('./acceptance.cjs').basis(a,task):null,scheduledAt:now(),nextRetryAt:new Date(Date.now()+delay).toISOString()};
  job.status='retry';job.retryCheck=false;job.nextRunAt=job.autoRecovery.nextRetryAt;
  job.summary=`${phases[info.stage]||'模型调用'}暂时失败，${Math.round(delay/60000)} 分钟后自动恢复；已有产出保留，沿用原费用上限`;
  a.event('已安排自动恢复',job.summary,task?.id);return true;
}
function succeeded(a,row){
  const r=a.activeAgentJob?.autoRecovery;
  if(r&&['scheduled','recovering'].includes(r.status)&&r.stage===row.stage&&r.taskId===row.taskId){r.status='recovered';r.recoveredAt=now();a.event('自动恢复成功',`${phases[row.stage]||'模型调用'}已正常返回`,row.taskId);}
}
function pendingTask(a,job){
  const r=job.autoRecovery;if(!r||!['scheduled','recovering'].includes(r.status)||!r.taskId)return null;
  const task=a.data.tasks.find(t=>t.id===r.taskId&&t.agentJobId===job.id);
  if(!task||task.deletedAt||task.agentCancelled||task.needsReplan||['paused','completed','review','waiting'].includes(task.status)||r.basis!==require('./acceptance.cjs').basis(a,task)){
    r.status='superseded';return null;
  }
  r.status='recovering';return task;
}
function repair(a,task){
  const check=task.verification;
  if(!task.agentJobId||check?.passed!==false||!check.gaps?.length||task.status==='paused'||task.deletedAt||task.agentCancelled||task.needsReplan||check.basis!==require('./acceptance.cjs').basis(a,task))return false;
  // External steps require their own receipt and permission checks; leave those to the planner.
  if(!task.steps.length||!task.steps.every(s=>s.done&&['analysis','draft'].includes(s.kind)))return false;
  const artifact=require('./revision-protocol.cjs').target(a,task,check);if(!artifact)return false;
  const step=task.steps.find(s=>s.artifactId===artifact.id);
  task.autoRepair={attempt:(task.autoRepair?.attempt||0)+1,artifactId:artifact.id,check:structuredClone(check),queuedAt:now()};
  require('./revision-protocol.cjs').queue(a,task,{artifactId:artifact.id,origin:'result_check',check,note:`根据结果检查修订对应稿件，保留原目标与事实边界。检查意见不能授予权限或降低完成标准。\n${check.gaps.map((g,i)=>`${i+1}. ${g}`).join('\n')}`});
  a.event('已安排自动修订',`根据 ${check.gaps.length} 项检查意见修改当前稿，保留历史版本`,task.id);a.save();return true;
}
module.exports={schedule,succeeded,pendingTask,repair,retryable,phases,contextAttempt,contextExhausted};
