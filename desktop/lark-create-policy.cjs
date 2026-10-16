const now=()=>new Date().toISOString();

// OAuth proves API access. A user's task policy separately authorizes creation
// for that task, account and destination. Model output cannot set this policy.
function policy(job,taskId){
  const grant=job.larkCreateGrant;
  return (job.larkCreatePolicies||[]).find(p=>p.taskId===taskId&&p.mode==='auto'&&p.openId===grant?.openId&&p.target===grant?.target&&p.approvedAt);
}
function mode(job,taskId){return !job.larkCreateGrant?'off':policy(job,taskId)?'auto':'ask';}
async function set(a,job,input){
  require('./project-lifecycle.cjs').assertJobActive(a.data,job);
  const task=a.task(input.taskId);require('./task-trash.cjs').assertTask(task);
  if(task.agentJobId!==job.id||!job.taskIds.includes(task.id)||task.agentCancelled)throw Error('只能设置此委托中的有效事项');
  if(!['ask','auto'].includes(input.mode))throw Error('请选择有效的飞书创建方式');
  const grant=job.larkCreateGrant;
  if(!grant||grant.target!==input.target||grant.openId!==input.openId)throw Error('飞书账号或保存位置已变化，请刷新后核对');
  require('./decisions.cjs').assertNoUncertain(a,job);
  if(input.mode==='auto')await require('./lark-publish.cjs').checkGrant(a,job,{target:grant.target,larkOpenId:grant.openId});
  a.ensureIdle({jobId:job.id});
  require('./project-lifecycle.cjs').assertJobActive(a.data,job);
  require('./task-trash.cjs').assertTask(task);
  require('./decisions.cjs').assertNoUncertain(a,job);
  // Recheck after the asynchronous identity lookup before persisting authority.
  if(job.larkCreateGrant!==grant)throw Error('飞书授权已变化，请重新核对');
  const before=structuredClone(job);
  const entry={taskId:task.id,mode:input.mode,allowUpdate:input.allowUpdate===true,target:grant.target,openId:grant.openId,approvedAt:now()};
  job.larkCreatePolicies=[...(job.larkCreatePolicies||[]).filter(p=>p.taskId!==task.id),entry];
  const note=input.mode==='auto'?`用户已授权事项「${task.title}」按目标自动创建飞书文档，账号 ${grant.userName||grant.openId}，位置 ${grant.target}。请直接使用 lark_create；无需再询问创建确认，也不要用 request_confirmation 向聊天发送确认消息。仍须核对已保存稿件、创建回执及正文，不改变分享权限。`:`事项「${task.title}」已改为每次创建飞书文档前确认。`;
  job.feedback.push({at:now(),text:note+(entry.allowUpdate?' 同时授权更新本事项由 App 创建且未被他人修改的飞书文档，更新正文并保留文档链接；使用 lark_update，不重复创建。':''),origin:'user_lark_policy'});job.feedback=job.feedback.slice(-30);
  // A concrete approval already waiting for this task can now be executed by
  // the scheduler. Unrelated questions and approvals remain untouched.
  const pending=a.data.agentActions.find(r=>r.id===job.pendingActionId&&r.taskId===task.id&&['lark_create','lark_update'].includes(r.tool)&&r.status==='pending');
  if(pending&&input.mode==='auto'&&(pending.tool==='lark_create'||entry.allowUpdate)&&job.status==='approval'){job.status='ready';job.nextRunAt=now();}
  if(a.dir)require('./access-policy-store.cjs').syncTrustedJob(a,job,{before,command:'agentLarkCreatePolicy',actor:'user_command',trusted:true});
  job.updatedAt=now();a.event('飞书创建方式已更新',note,task.id);a.save();
}
module.exports={mode,policy,set};
