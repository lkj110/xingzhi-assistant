export function recoveryNotice(job,tasks,state=job.workState){
  if(job.projectionPending||state?.projectionPending)return '记录已保存，界面正在恢复。';
  const phase=state?.phase||job.status,recovery=state?.recovery;
  if(['completed','finalizing','deleted','cancelled'].includes(phase))return '';
  if(phase==='blocked'&&state?.error)return `恢复失败：${state.error.message}`;
  if(!['ready','running','retry','recovery_pending'].includes(phase)||state?.gate?.automaticAllowed===false)return '';
  if(recovery?.phase==='recovery_pending')return '等待恢复调度；已有材料和费用记录保留。';
  if(recovery?.phase==='recovering')return phase==='running'?'正在恢复：按当前未满足要求继续执行。':'等待恢复调度；已有材料和费用记录保留。';
  const r=job.autoRecovery;
  if(r&&['scheduled','recovering'].includes(r.status)){
    const running=phase==='running'&&r.status==='recovering';
    const when=!running&&r.nextRetryAt?`，下次尝试 ${new Date(r.nextRetryAt).toLocaleString('zh-CN')}`:'';
    return `自动恢复：${running?'正在恢复':'等待重试'}${when}。已有产出保留，沿用原费用上限。`;
  }
  const task=tasks.find(t=>t.agentJobId===job.id&&!t.deletedAt&&!t.agentCancelled&&['todo','running'].includes(t.status)&&t.autoRepair?.attempt&&t.verification?.passed!==true);
  return phase==='running'&&task?`正在按第 ${task.autoRepair.attempt} 轮检查意见修订并复检，已有稿件已保存。`:'';
}
