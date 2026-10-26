'use strict';
// A task name is navigation/intent; the primary draft is the local deliverable.
// Payload titles follow each writer's contract, never the UI action label.
const rows=value=>Array.isArray(value)?value:[];
// Lark overwrite updates only the body. Its record.title is a UI label, not a
// transmitted document title, and preparing it must not stale a content check.
const taskTitleTools=new Set(['github_create','github_update','lark_create']);
function actionTitles(a,task,artifacts,primary){
 const ids=new Set(artifacts.map(r=>r.id)),version=require('./agent-writes.cjs').version(task);
 return rows(a.data.agentActions).filter(r=>r?.taskId===task.id&&(!task.agentJobId||r.jobId===task.agentJobId)&&r.presentationStatus!=='historical'&&['pending','running','uncertain','done'].includes(r.status)&&(!r.artifactId||ids.has(r.artifactId))&&(!r.version||r.status==='done'&&r.presentationStatus==='current'||r.version===version)&&(!r.stepId||rows(task.steps).some(s=>s?.id===r.stepId&&s.tool===r.tool))).flatMap(r=>{
  const mail=['send_mail','mail_draft'].includes(r.tool),title=mail?r.args?.subject:r.tool==='github_update'?r.desired?.title:taskTitleTools.has(r.tool)?r.title:undefined;
  if(typeof title!=='string')return [];
  const body=mail?r.args?.body:undefined,artifactId=r.artifactId||(typeof body==='string'?(primary&&primary.content===body?primary.id:artifacts.find(x=>x.content===body)?.id):null)||null;
  if(mail&&r.status==='done'&&!artifactId)return [];
  return typeof title==='string'?[{actionId:r.id,tool:r.tool,stepId:r.stepId||null,version:r.version||null,artifactId,title,titleSource:mail?'mailSubject':'externalDocumentTitle'}]:[];
 });
}
function identity(a,task){
 const deliverables=require('./deliverables.cjs'),primary=deliverables.primary(a,task),artifacts=Array.isArray(task.steps)&&task.steps.every(s=>s&&typeof s==='object')?deliverables.current(a,task):[];
 return {taskTitle:task.title||'',primaryArtifactId:primary?.id||null,primaryArtifactTitle:primary?.title||null,
  artifactTitles:artifacts.map(r=>({artifactId:r.id,title:r.title||'',role:primary?.id===r.id?'primary':'supporting'})),
  externalTitleBindings:rows(task.steps).filter(s=>s?.kind==='external'&&['github_create','lark_create'].includes(s.tool)).map(s=>({stepId:s.id,tool:s.tool,artifactId:primary?.id||null,title:task.title||'',titleSource:'taskTitle'})),
  actionTitles:actionTitles(a,task,artifacts,primary)};
}
function request(a,task){
 return identity(a,task);
}
function actionReview(a,task,record){
 if(!task||!require('./grounding.cjs').enabled(a)||record?.status!=='pending'||!identity(a,task).actionTitles.some(r=>r.actionId===record.id&&r.artifactId))return null;
 const job=a.data.delegations.find(j=>j.id===task.agentJobId),basis=require('./execution-control.cjs').contentBasis(a,job,task),check=task.contentVerification;
 if(check?.basis===basis&&check.passed===false)return 'blocked';
 return check?.basis===basis&&check.passed===true&&require('./grounding.cjs').reusable(a,task)?null:'required';
}
const instruction='事项名 taskTitle 是导航名称；本地稿件的精确标题要求核对 primaryArtifactTitle，不要求中性事项名同名。externalTitleBindings 仅列已知使用事项名的外部渠道；邮件主题及已准备动作核对 actionTitles，不能猜尚未准备的主题。actionTitles 的结论用 field:actionTitle、actionId 和绑定 artifactId 定位。所有标题的具体事实断言仍须检查，不能因其是导航名而豁免。稿件元数据标题与正文 H1 分别检查；元数据已更新不代表正文标题已更新。新版本正文仍用旧版本标题属于实质矛盾，历史引用或中性章节名不要求机械同名。辅助稿不能替代主稿。';
module.exports={identity,request,actionReview,instruction};
