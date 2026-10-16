function bound(a,task){
  if(!task.primaryArtifactId)return null;
  const rows=(a.data.artifacts||[]).filter(r=>r.id===task.primaryArtifactId);
  const job=a.data.delegations?.find(j=>j.id===task.agentJobId);
  return rows.length===1&&owned(rows[0],task,job)&&require('./protocol-access.cjs').allowedObject(a,'artifact',rows[0],job,task)?rows[0]:null;
}
function owned(row,task,job){return row.taskId===task.id&&!row.stale&&(!row.projectId||row.projectId===(task.projectId||job?.projectId||null))&&(!row.agentJobId||row.agentJobId===task.agentJobId);}
function current(a,task){
 const rows=a.data.artifacts||[],counts=new Map(),job=a.data.delegations?.find(j=>j.id===task.agentJobId);
 for(const row of rows)counts.set(row.id,(counts.get(row.id)||0)+1);
 return rows.filter(r=>counts.get(r.id)===1&&owned(r,task,job)&&(task.primaryArtifactId===r.id||task.steps.some(s=>s.done&&s.artifactId===r.id&&(!r.stepId||s.id===r.stepId)))&&require('./protocol-access.cjs').allowedObject(a,'artifact',r,job,task));
}
function primary(a,task){
  if(Object.hasOwn(task,'primaryArtifactId'))return bound(a,task);
  const list=current(a,task),explicit=task.steps.filter(s=>s.outputRole==='primary'),draft=task.steps.filter(s=>s.kind==='draft'&&s.outputRole!=='supporting');
  // A later analysis/check report must never replace the business draft.
  const steps=explicit.length?explicit:draft.length?draft:task.steps.filter(s=>s.kind==='analysis'&&s.outputRole!=='supporting');
  for(const step of steps.slice().reverse()){const item=list.find(r=>step.done&&step.artifactId===r.id);if(item)return item;}return null;
}
function select(a,task,id){
  const item=id?current(a,task).find(r=>r.id===id):primary(a,task);
  if(!item)throw Error('请先生成当前主稿，再执行写入或修订；辅助报告不能替代主稿');
  return item;
}
function role(a,task,artifact){return primary(a,task)?.id===artifact.id?'primary':'supporting';}
function bind(a,task,id){
  const rows=(a.data.artifacts||[]).filter(r=>r.id===id);
  const job=a.data.delegations?.find(j=>j.id===task.agentJobId);
  if(rows.length!==1||!owned(rows[0],task,job)||!require('./protocol-access.cjs').allowedObject(a,'artifact',rows[0],job,task))throw Error('主稿必须是当前事项中可读取的唯一稿件');
  task.primaryArtifactId=id;return rows[0];
}
function record(a,task,step,artifact,{previousPrimary}={}){
  artifact.outputRole=step.outputRole||(step.kind==='draft'||primary(a,task)?.id===artifact.id?'primary':'supporting');
  if(step.outputRole==='supporting'){
    if(!Object.hasOwn(task,'primaryArtifactId')&&previousPrimary)bind(a,task,previousPrimary.id);
  }else if(step.outputRole==='primary'||step.kind==='draft')bind(a,task,artifact.id);
  if(step.targetArtifactId)step.targetArtifactId=artifact.id;
}
module.exports={current,primary,select,role,bind,record};
