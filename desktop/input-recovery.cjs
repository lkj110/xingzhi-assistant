// Upgrade recovery is restricted to a proven local input-size failure.
const {POLICY_VERSION}=require('./model-input.cjs');
const rows=v=>Array.isArray(v)?v:[];
function candidate(a,job){
 if(job.status!=='blocked'||job.lastErrorAutomaticRetry!==false||job.lastErrorCode!=='MODEL_CONFIG'||job.executionState?.inputRecovery?.attempts?.[POLICY_VERSION])return null;
 const run=rows(a.data.agentRuns).find(r=>r.jobId===job.id);
 if(!run?.finishedAt||run.status!=='blocked'||run.error!==job.lastError)return null;
 const step=rows(run.steps).at(-1),task=rows(a.data.tasks).find(t=>t.id===step?.args?.taskId&&t.agentJobId===job.id&&rows(job.taskIds).includes(t.id));
 if(step?.tool!=='verify_content'||step.errorCode!=='MODEL_CONFIG'||step.error!==job.lastError||!task||!task.primaryArtifactId)return null;
 if(task.needsReplan||rows(task.steps).find(s=>!s.done)?.kind!=='external')return null;
 const call=rows(a.data.modelCalls).find(r=>r.runId===run.id&&r.jobId===job.id&&r.taskId===task.id&&r.status==='error'&&r.errorCode==='MODEL_CONFIG');
 const diagnostic=step.errorDiagnostic||call?.diagnostic;
 if(diagnostic?.source!=='codex_cli'||diagnostic.kind!=='input_too_large'||!(diagnostic.actualChars>diagnostic.maxChars)||diagnostic.inputPolicyVersion===POLICY_VERSION)return null;
 return {run,task,diagnostic};
}
function allowed(a,job,task){
 const work=require('./work-state.cjs');
 return !a.readOnlyRecovery&&!a.data.runtime?.accessPolicyProjectionPending&&!job.deletedAt&&!task.deletedAt&&!task.agentCancelled&&!task.acceptedAt&&
  !['completed','review','paused','waiting'].includes(task.status)&&!task.executionPaused&&
  work.gate(a,job,task).automaticAllowed&&!work.blockingReasons(a,job,task).length&&
  require('./work-rules.cjs').canRun(a,job)&&!require('./continuation-control.cjs').failure(a,job)&&
  !work.recoveryBlocked(work.recoveryState(job));
}
function eligible(a,job){const c=candidate(a,job);return !!c&&allowed(a,job,c.task);}
function preflight(a,job,task){
 require('./execution-gate.cjs').assert(a,{job,task,automatic:true,readOnly:true});
 if(!allowed(a,job,task))throw Error('当前事项的权限、费用或接续条件尚未允许恢复');
 require('./agent-plan.cjs').assertReady(a,task);
 require('./protocol-access.cjs').assertTool(a,job,'model',{taskId:task.id},{taskId:task.id});
 require('./access-policy-store.cjs').assertTool(a,job,'model_request',{}, {taskId:task.id});
 const control=require('./execution-control.cjs'),generation=require('./generation-context.cjs');
 const request=control.contentRequest(a,job,task),context=generation.prepare(a,task,request.context);
 const readable=new Set(rows(context.readableCatalog).filter(r=>!r.ambiguous).map(r=>r.id));
 if(!readable.has(task.primaryArtifactId)||rows(task.sourceIds).filter(id=>!rows(task.supersededSourceIds).includes(id)).some(id=>!readable.has(id)))throw Error('当前主稿或关联材料的读取权限已变化，不能沿用旧失败恢复');
 const input=require('./model-input.cjs').prepare({...context,workEfficiency:require('./work-efficiency.cjs').inspect(job)},{stage:'task_verify'});
 const provider=require('./model-routing.cjs').select(a,a.available('verify'),{role:'verify',stage:'task_verify',routingContext:input}).provider;
 const messages=a.modelMessages(generation.systemPrompt(task,request.system,'verify'),input);
 // A new provider alone is not proof of a repaired input. Keep the CLI ceiling.
 const serialized=require('./subscription.cjs').validateInput(messages);
 return {inputChars:Array.from(serialized).length,maxChars:require('./subscription.cjs').maxInputChars,providerId:provider.id,
  taskId:task.id,artifactId:task.primaryArtifactId,contentBasis:control.contentBasis(a,job,task),policyVersion:POLICY_VERSION};
}
function restore(a,job){
 const c=candidate(a,job);if(!c||!allowed(a,job,c.task))return false;
 const state=(job.executionState ||= {}).inputRecovery ||= {attempts:{}};
 const attempt={policyVersion:POLICY_VERSION,previousRunId:c.run.id,taskId:c.task.id,previousError:job.lastError,previousDiagnostic:structuredClone(c.diagnostic),startedAt:new Date().toISOString(),status:'checking'};
 state.attempts[POLICY_VERSION]=attempt;
 // Persist before trying: crashes/restarts must not mint another attempt.
 a.save();
 try{
  attempt.preflight=preflight(a,job,c.task);
  if(!allowed(a,job,c.task))throw Error('预检期间推进条件变化，保留当前断点');
  attempt.status='ready';attempt.finishedAt=new Date().toISOString();
  job.status='ready';job.nextRunAt=attempt.finishedAt;job.lastErrorAutomaticRetry=true;
  job.summary='新版输入预检通过，将从已保存的内容检查接续；原费用和失败历史保留';
  a.event('升级后恢复预检通过',job.summary,c.task.id,'success');a.save();return true;
 }catch(error){
  attempt.status='blocked';attempt.reason=error.message;attempt.finishedAt=new Date().toISOString();
  job.status='blocked';job.nextRunAt=null;job.summary='升级后恢复预检未通过：'+error.message;
  a.event('升级后恢复仍需处理',job.summary,c.task.id,'warning');a.save();return false;
 }
}
module.exports={candidate,eligible,preflight,restore,POLICY_VERSION};
