// One explanation for both the button and dispatch; inspecting never grants consent.
function blocker(a,job) {
  const spend=require('./spend.cjs'),s=a.spendLedger?.scopes?.['job:'+job.id];
  const result=(kind,label,message,target)=>({kind,label,message,target});
  if(a.spendError)return result('storage','检查费用账本',a.spendError,'spend');
  if(s&&spend.unsettled(s)){const remaining=s.spentUSD+s.heldUSD<s.limitUSD;return result('unknown',remaining?'核对用量并继续':'处理费用与未知用量',`有 ${spend.unsettled(s)} 次历史请求缺少完整用量或价格，且没有费用预留。已报告 $${s.spentUSD.toFixed(4)}，预留 $${s.heldUSD.toFixed(4)}，上限 $${s.limitUSD.toFixed(2)}。请在「推进用量与额度」${remaining?'知悉未知消耗后，在原上限内继续':'核对未知消耗并确认追加额度后继续'}。`,'spend');}
  if(s&&(s.spentUSD+s.heldUSD>=s.limitUSD||s.blocked?.kind==='budget'))return result('budget','处理费用额度',s.blocked?.message||'本次推进已达到费用上限，请在「推进用量与额度」确认追加额度后继续。','spend');
  if(s?.blocked?.kind==='pricing'&&a.data.providers.some(p=>Object.values(a.data.settings.roles).includes(p.id)&&!spend.pricing(p)))return result('pricing','检查模型价格',s.blocked.message,'settings');
  const decision=a.data.decisions?.find(d=>d.jobId===job.id&&d.status==='open');
  if(decision&&job.status==='needs_input')return result('decision','处理待补充问题',`请先在「待我处理」回答：${decision.question}`,'decisions');
  if(!require('./work-rules.cjs').canRun(a,job))return result('rule','查看推进条件','关联项目已归档、工作规则已暂停或材料等待规则检查，请先处理后继续。','rules');
  if(job.status==='approval')return result('approval','处理待确认动作','请先核对并批准具体动作，助手才能继续。','decisions');
  return null;
}
function migrate(a) {
  for(const job of a.data.delegations) {
    const countLimited=job.status==='limited'&&(job.limitReason==='job'||job.limitReason==='rule_daily'||!job.limitReason&&/调用上限|调用额度/.test(job.summary||''));
    if(!countLimited)continue;
    const pending=a.data.agentActions.some(r=>r.jobId===job.id&&r.status==='pending'&&!r.approvedAt);
    const question=a.data.decisions?.some(d=>d.jobId===job.id&&d.status==='open');
    // Costs are checked again before any request. Do not clear questions or approvals.
    job.status=pending?'approval':question?'needs_input':'ready';
    job.nextRunAt=job.status==='ready'?new Date().toISOString():null;
    job.summary='已取消调用次数上限，后续推进沿用原有费用额度和确认要求';job.lastError='';delete job.limitReason;
  }
}
module.exports={blocker,migrate};
