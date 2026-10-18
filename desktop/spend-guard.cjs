// Pure eligibility projection shared by the dispatcher and UI. Never calls scope()
// or check(): those may allocate or persist a ledger entry during a read.
function inspect(a,job,task){
 if(a.spendError)return {code:'spend_storage',reason:'storage',message:a.spendError,needsHuman:false,scope:'workspace'};
 const scopes=a.spendLedger?.scopes||a.data.spendMeter?.scopes||{};
 for(const key of [...(job?['job:'+job.id]:[]),...(task?['task:'+task.id]:[])]){
  if(!Object.hasOwn(scopes,key))continue;
  const s=scopes[key],valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  if(!s||!s.usage||![s.limitUSD,s.spentUSD,s.heldUSD].every(valid)||
    (s.unreservedCalls!==undefined?!Number.isSafeInteger(s.unreservedCalls)||s.unreservedCalls<0:![s.usage.unknownCalls,s.usage.unpricedCalls,s.unknownAcknowledged].every(n=>Number.isSafeInteger(n)&&n>=0)))return {code:'spend_storage',reason:'storage',message:'费用账本记录不完整，需核对后继续；不会重置已发生费用。',needsHuman:false,scope:key.startsWith('job:')?'job':'task',id:key};
  const unsettled=require('./spend.cjs').unsettled(s);
  const pricing=s.blocked?.kind==='pricing'&&(a.data.providers||[]).some(p=>Object.values(a.data.settings?.roles||{}).includes(p.id)&&!require('./spend.cjs').pricing(p));
  const kind=unsettled>0?'unknown':s.spentUSD+s.heldUSD>=s.limitUSD||s.blocked?.kind==='budget'?'budget':pricing?'pricing':s.blocked?.kind==='storage'?'storage':null;
  if(kind)return {code:'spend_'+kind,reason:'budget',message:s.blocked?.message||(kind==='unknown'?'历史调用缺少完整用量与预留，需要核对后继续。':'本次推进已达到累计费用上限，需要人工确认额度。'),needsHuman:true,scope:key.startsWith('job:')?'job':'task',id:key};
 }
 return null;
}
module.exports={inspect};
