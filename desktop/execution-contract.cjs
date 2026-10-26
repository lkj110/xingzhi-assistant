const crypto=require('node:crypto');
const now=()=>new Date().toISOString();
function initialize(a){
  for(const job of a.data.delegations||[]){
    for(const entry of job.feedback||[])remember(job,entry);
  }
}
function remember(job,entry){
  if(!entry?.text?.trim())return;
  job.userDirectives ||= [];
  const id=entry.originEventId||entry.eventId||crypto.createHash('sha256').update(JSON.stringify([entry.at,entry.text])).digest('hex');
  if(!job.userDirectives.some(x=>x.id===id))job.userDirectives.push({id,at:entry.at||now(),text:entry.text,origin:entry.origin||'user_feedback',kind:entry.kind,taskId:entry.taskId,eventId:entry.originEventId||entry.eventId,workSequence:entry.workSequence,contractRevision:entry.contractRevision});
}
function context(job,{task,tasks}={}){
  if(!job)return null;
  const c=job.executionContract;
  const projection=require('./requirement-projection.cjs').project(job,task||((tasks?.length===1)?tasks[0]:null));
  return {...projection,executionContract:c?{revision:c.revision,text:c.text,updatedAt:c.updatedAt,authority:'user'}:null,
    ...(tasks?{taskRequirementOverrides:tasks.filter(t=>t.userRequirement).map(t=>({taskId:t.id,revision:t.userRequirement.revision,currentFieldsRef:'tasks:'+t.id}))}:{}),
    instruction:c?'以当前执行约定为范围与验收依据；它已替代旧目标及此前冲突的计划/反馈。约定后的用户补充按时间继续生效。未被用户要求的新范围不得加入验收。':'后续用户补充优先于原目标中的冲突条目。userDirectives 持续保留用户决定，不能因最近反馈截断而恢复已被替代的要求。'};
}
function set(a,job,input){
  require('./project-lifecycle.cjs').assertJobActive(a.data,job);
  require('./decisions.cjs').assertNoUncertain(a,job);
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>16000)throw Error('当前执行约定须为 1–16000 字符');
  if((job.executionContract?.revision||null)!==(input.revision||null))throw Error('执行约定已变化，请刷新后再保存');
  if(job.executionContract?.text===input.text.trim())return;
  const at=now(),executionContract={text:input.text.trim(),revision:crypto.randomUUID(),updatedAt:at};
  require('./work-journal.cjs').recordJobFeedback(a,{id:job.id,requirementRevision:crypto.randomUUID(),executionContract});
  require('./efficiency.cjs').resetProgress(job);
  delete job.repairProgress;
  for(const id of job.taskIds){const task=a.task(id);if(task.deletedAt||task.agentCancelled)continue;task.needsReplan='当前执行约定已更新，请沿用成果核对范围、证据和交付步骤';a.requeue(task);}
  for(const r of a.data.agentActions.filter(r=>r.jobId===job.id&&r.status==='pending')){r.status='stale';delete r.approvedAt;}
  job.pendingActionId=null;job.completedAt=null;job.resumeWatching=false;
  if(job.status!=='paused')job.status='ready';job.nextRunAt=at;
  a.event('当前执行约定已更新','规划、写作与检查将使用同一份用户范围。',null);a.save();
}
module.exports={initialize,remember,context,set};
