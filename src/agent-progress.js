export function recoveryNotice(job,tasks){
  if(job.projectionPending)return '验收记录已保存，界面正在恢复。';
  if(['completed','finalizing','deleted','cancelled'].includes(job.workState?.phase||job.status))return '';
  if(!['ready','running','retry'].includes(job.workState?.phase||job.status))return '';
  if(job.progressSummary?.recovery?.code==='AUTOMATIC_STRATEGY_REPAIR')return job.progressSummary.recovery.message;
  const r=job.autoRecovery;
  if(r&&['scheduled','recovering'].includes(r.status)){
    const when=r.status==='scheduled'&&r.nextRetryAt?`，下次尝试 ${new Date(r.nextRetryAt).toLocaleString('zh-CN')}`:'';
    return `自动恢复：${r.status==='scheduled'?'等待重试':'正在恢复'}${when}。已有产出保留，沿用原费用上限。`;
  }
  const task=tasks.find(t=>t.agentJobId===job.id&&!t.deletedAt&&!t.agentCancelled&&['todo','running'].includes(t.status)&&t.autoRepair?.attempt&&t.verification?.passed!==true);
  return task?`正在按第 ${task.autoRepair.attempt} 轮检查意见修订并复检，已有稿件已保存。`:'';
}
