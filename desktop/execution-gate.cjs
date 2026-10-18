// Request boundaries share the same pure hard facts as UI and scheduling.
function assert(a,{job=a.activeAgentJob,task,automatic=a.automaticExecution,readOnly=false}={}){
 a.controller?.signal.throwIfAborted();
 const gate=require('./execution-facts.cjs').gate(a,job,task,{automatic:automatic===true,readOnly:true});
 if(!gate.automaticAllowed){
  // Preserve the ledger's typed storage error for budget recovery and UI.
  if(gate.reason==='storage'&&a.spendError&&!readOnly)require('./spend.cjs').check(a);
  const messages={terminal:'事项或委托已结束',paused:'事项或委托已暂停',workspace_paused:'自动托管已暂停，恢复后从已保存断点继续',suspended:'设备已挂起，恢复后继续',projection_pending:'已提交状态正在恢复，恢复完成后继续',storage:'独立工作记录需要恢复核对，当前仅可查看已有资料',archived:'所属项目已归档',rule_guarded:'工作规则或执行范围已变化',source_batch_pending:'来源分页正在同步，当前批次提交后继续'};
  throw Object.assign(Error(messages[gate.reason]||gate.message||'当前执行条件不允许继续'),{code:'EXECUTION_GATE_CLOSED',gateClosed:true,gateReason:gate.reason,automaticRetry:false});
 }
 if(!readOnly)require('./spend.cjs').check(a);
 return true;
}
module.exports={assert};
