const now=()=>new Date().toISOString();
const unsettled=(a,job)=>require('./projects.cjs').relatedActions(a,job).some(r=>['running','uncertain'].includes(r.status));
function initialize(a){
  a.data.runtime ||= {};const state=a.data.runtime;
  for(const id of new Set([...(state.interruptedJobIds||[]),state.interruptedJobId].filter(Boolean))){const job=a.data.delegations.find(j=>j.id===id);if(state.suspended&&job?.status==='paused'&&require('./project-lifecycle.cjs').isJobActive(a.data,job)&&!unsettled(a,job)){job.status='ready';job.nextRunAt=now();}}
  for(const id of state.interruptedTaskIds||[]){const task=a.data.tasks.find(t=>t.id===id);if(state.suspended&&task?.status==='blocked'&&require('./project-lifecycle.cjs').isTaskActive(a.data,task))a.requeue(task);}delete state.interruptedTaskIds;
  delete state.interruptedJobIds;delete state.interruptedJobId;state.startedAt=now();state.suspended=false;a.suspended=false;
  for(const row of a.data.modelCalls||[])if(row.status==='running'){row.status='stopped';row.errorCode='app_interrupted';}
}
function connectivity(a,online){
  const was=a.data.runtime.online;a.data.runtime.online=online;
  if(was===false&&online){a.data.runtime.reconnectedAt=now();for(const c of a.data.connectors)if(c.enabled&&c.health==='connection')c.nextRunAt=now();a.save();}
}

function suspend(a){
  a.suspended=true;a.data.runtime.suspended=true;a.data.runtime.suspendedAt=now();
  a.data.runtime.interruptedJobId=a.activeAgentJob?.id||null;
  a.data.runtime.interruptedJobIds=[...new Set([a.activeAgentJob?.id,...require('./execution.cjs').snapshot(a).filter(r=>r.jobId&&a.data.delegations.find(j=>j.id===r.jobId)?.status!=='paused').map(r=>r.jobId)].filter(Boolean))];
  a.data.runtime.interruptedTaskIds=require('./execution.cjs').snapshot(a).filter(r=>r.taskId&&!r.jobId&&a.data.tasks.find(t=>t.id===r.taskId)?.status!=='paused').map(r=>r.taskId);
  require('./execution.cjs').abortAll(a);a.save();
}
async function resume(a){
  await a.runPromise;
  const state=a.data.runtime,ids=[...new Set([...(state.interruptedJobIds||[]),state.interruptedJobId].filter(Boolean))];delete state.interruptedJobId;delete state.interruptedJobIds;
  a.suspended=false;state.suspended=false;state.resumedAt=now();
  for(const id of ids){const job=a.data.delegations.find(j=>j.id===id);
  if(job?.status==='paused'&&require('./project-lifecycle.cjs').isJobActive(a.data,job)){
    const uncertain=unsettled(a,job);
    if(!uncertain){job.status='ready';job.nextRunAt=now();job.failures=0;job.summary='电脑已唤醒，将从已保存的步骤继续';}
    else{job.summary='休眠前的外部执行结果需要核对，请先处理后恢复';a.event('运行恢复需要处理',job.summary,null,'warning');}
  }
  }
  for(const id of state.interruptedTaskIds||[]){const task=a.data.tasks.find(t=>t.id===id);if(task&&['blocked','todo'].includes(task.status)&&require('./project-lifecycle.cjs').isTaskActive(a.data,task))a.requeue(task);}delete state.interruptedTaskIds;
  // Due times are preserved. The scheduler coalesces missed intervals into one check.
  state.catchupAt=now();a.save();a.tick();
}
module.exports={initialize,suspend,resume,connectivity};
