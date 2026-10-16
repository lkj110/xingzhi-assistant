export function workBusy(data,{jobId,taskId,projectId}={}) {
  if(data.exclusiveOperation || (data.operation&&!data.operation.parallel))return true;
  const task=taskId&&data.tasks.find(t=>t.id===taskId);jobId ||= task?.agentJobId;
  projectId ||= task?.projectId||data.delegations.find(j=>j.id===jobId)?.projectId;
  return (data.operations||[]).some(r=>jobId&&r.jobId===jobId||taskId&&r.taskId===taskId||projectId&&r.projectId===projectId);
}
export function readyLabel(data,job){
  const state=workState(data,job);
  if(state.phase!=='ready')return null;
  if(data.stewardship?.paused)return '自动托管已暂停';
  if(workBusy(data,{jobId:job.id}))return '等待当前操作';
  return '即将自动推进';
}

// The backend is authoritative. The small fallback supports old saved publicState
// payloads during rollout and always gives terminal lifecycle precedence.
export function workState(data,entity){
  const projected=entity?.workState||data.workStates?.jobs?.[entity?.id]||data.workStates?.tasks?.[entity?.id];
  const lifecycle=entity?.deletedAt?'deleted':entity?.status;
  if(['completed','deleted','cancelled'].includes(lifecycle))return {...projected,lifecycle,phase:lifecycle,acceptanceState:lifecycle==='completed'?(['manual','accepted'].includes(projected?.acceptanceState)?projected.acceptanceState:'accepted'):'not_ready',nextActions:(projected?.nextActions||[]).filter(action=>['reconcile_external','review_delivery'].includes(action.type)),activeCountKey:null,historyVisible:true,gate:{automaticAllowed:false,reason:'terminal'}};
  return projected||{lifecycle,phase:lifecycle,acceptanceState:lifecycle==='finalizing'?'accepted_pending_check':lifecycle==='review'?'awaiting_acceptance':'not_ready',historyVisible:true,gate:{automaticAllowed:!data.stewardship?.paused,reason:data.stewardship?.paused?'workspace_paused':null}};
}
export function workLabel(data,entity){
  const state=workState(data,entity);
  if(state.projectionPending||entity?.projectionPending)return '记录已保存，界面正在恢复';
  if(state.acceptanceState==='manual')return '人工完成，未经 Agent 核验';
  if(state.acceptanceState==='awaiting_check')return '等待整体检查';
  return ({ready:readyLabel(data,entity),running:'正在工作',watching:'持续跟进',retry:'等待重试',approval:'待确认动作',review:'待验收事项',needs_input:'需要补充',paused:'已暂停',limited:'等待额度确认',blocked:'需要处理',finalizing:'已验收，收尾待检查',completed:'已完成',deleted:'已删除',cancelled:'已取消'})[state.phase]||state.phase;
}
