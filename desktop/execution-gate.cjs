// Rechecked at each request boundary, not only when a run starts.
function assert(a,{job=a.activeAgentJob,task,automatic=a.automaticExecution,readOnly=false}={}){
 a.controller?.signal.throwIfAborted();
 const stop=message=>{throw Object.assign(Error(message),{code:'EXECUTION_GATE_CLOSED',gateClosed:true,automaticRetry:false});};
 if(a.suspended||a.data.runtime?.suspended)stop('设备已挂起，恢复后继续');
 if(a.data.runtime?.workJournalError)stop('独立工作记录需要恢复核对，当前仅可查看已有资料');
 if(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||a.data.runtime?.accessPolicyProjectionPending||task?.projectionPending||job?.projectionPending)stop('已提交状态正在恢复，恢复完成后继续');
 if(job){require('./project-lifecycle.cjs').assertJobActive(a.data,job);if(job.executionPaused||['paused','completed'].includes(job.status))stop(job.status==='completed'?'委托已完成':'委托已暂停');if(!require('./work-rules.cjs').canRun(a,job))stop('工作规则或执行范围已变化');}
 if(task&&(task.deletedAt||task.agentCancelled||(task.status==='paused'||task.status==='completed'&&task.acceptedBy==='user')))stop('事项已暂停或结束');
 if(automatic&&a.data.stewardship&&!require('./stewardship.cjs').canAutomate(a))stop(require('./stewardship.cjs').status(a).message);
 if(!readOnly)require('./spend.cjs').check(a);
 return true;
}
module.exports={assert};
