// App-owned output metadata. Reading it never requires an external connection.
const crypto=require('node:crypto');
const now=()=>new Date().toISOString();
function tasks(a,j,taskId){
  require('./project-lifecycle.cjs').assertJobActive(a.data,j);
  const ids=taskId?[taskId]:j.taskIds.filter(id=>!a.task(id).deletedAt);
  return ids.map(id=>{const t=a.task(id);require('./task-trash.cjs').assertTask(t);if(!j.taskIds.includes(id)||t.agentJobId!==j.id)throw Error('只能读取本委托的事项状态');return t;}).filter(t=>!t.agentCancelled);
}
function read(a,j,args={}){
  const selected=tasks(a,j,args.taskId),groups=require('./results.cjs').overview(a).groups;
  return {source:'app_workspace',externalAuthorizationRequired:false,readAt:now(),tasks:selected.map(t=>{
    const group=groups.find(g=>g.taskId===t.id),artifacts=a.data.artifacts.filter(r=>r.taskId===t.id).map(r=>({id:r.id,title:r.title,stepId:r.stepId,createdAt:r.createdAt,characters:r.content.length,contentHash:crypto.createHash('sha256').update(r.content).digest('hex'),current:!!group?.current.some(x=>x.id===r.id),referencedByDoneStep:t.steps.some(s=>s.done&&s.artifactId===r.id),historyReason:group?.history.find(x=>x.id===r.id)?.reason||null}));
    const state={taskId:t.id,title:t.title,status:t.status,needsReplan:t.needsReplan||null,primaryId:group?.primaryId||null,steps:t.steps.map(({id,key,title,kind,done,artifactId})=>({id,key,title,kind,done,artifactId})),artifacts};
    return {...state,revision:crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex')};
  }),guidance:'current 与历史标记来自应用实际状态；needsReplan 时暂不展示当前成果，不等于旧稿已被替代。不要将用户陈述当作版本变更证据。已被完整新稿替代的独立分析步骤，可核对全文后用 retire_output 归入历史；其他变更用 plan_task / revise_task，再检查结果。'};
}
// Consolidate a superseded analysis step into an existing complete draft. Both
// documents and the previous plan remain available; no external files are edited.
function retire(a,j,args){
  if(typeof args.taskId!=='string'||!args.taskId)throw Error('请指定本委托的事项');
  const t=tasks(a,j,args.taskId)[0];if(!t)throw Error('事项已取消');
  if(j.status==='paused'||['paused','completed'].includes(t.status))throw Error('已暂停或验收的事项不能自动调整产出');
  require('./decisions.cjs').assertNoUncertain(a,j);
  if(a.data.decisions.some(d=>d.jobId===j.id&&d.status==='open'))throw Error('请先处理未解决的决定');
  const state=read(a,j,{taskId:t.id}).tasks[0];
  if(args.revision!==state.revision)throw Error('产出状态已变化，请重新读取后再调整');
  const old=t.steps.find(s=>s.done&&s.artifactId===args.artifactId&&s.kind==='analysis');
  const replacement=t.steps.find(s=>s.done&&s.artifactId===args.replacementArtifactId&&s.kind==='draft');
  const r=a.data.artifacts.find(r=>r.id===replacement?.artifactId&&r.taskId===t.id&&r.stepId===replacement.id&&r.content.trim());
  if(!old||!replacement||!r||t.steps.indexOf(old)>=t.steps.indexOf(replacement))throw Error('只能归档已被后续完整文稿替代的分析步骤；必须保留当前文稿');
  if(typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>2000)throw Error('请说明新稿如何完整覆盖旧分析的要求');
  t.planHistory=[...(t.planHistory||[]),{at:now(),reason:args.reason,version:t.planVersion||1,steps:structuredClone(t.steps),dependsOn:t.dependsOn||[],title:t.title,criteria:t.criteria,sourceIds:[...t.sourceIds],supersededArtifactId:args.artifactId,replacementArtifactId:r.id}].slice(-20);
  t.steps=t.steps.filter(s=>s!==old);t.planVersion=(t.planVersion||1)+1;t.updatedAt=now();
  a.invalidateTaskApprovals(t);a.requeue(t);require('./agent-plan.cjs').invalidateDependents(a,t);
  a.event('旧分析稿已归入历史',args.reason,t.id);a.save();return read(a,j,{taskId:t.id});
}
module.exports={read,retire};
