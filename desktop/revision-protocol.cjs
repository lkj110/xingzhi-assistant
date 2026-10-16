// A correction owns one artifact version. It is not a structural replan.
const {randomUUID}=require('node:crypto');
const evidence=require('./evidence-basis.cjs');
const outputs=require('./deliverables.cjs');
const now=()=>new Date().toISOString();
function target(a,task,check){
 if(check?.snapshot&&check.snapshot.id!==snapshot(a,task).id)return null;
 const job=a.data.delegations?.find(j=>j.id===task.agentJobId);
 if(check?.basis&&check===task.contentVerification&&check.basis!==require('./execution-control.cjs').contentBasis(a,job,task))return null;
 if(check?.basis&&check===task.verification&&check.basis!==require('./acceptance.cjs').basis(a,task))return null;
 const current=outputs.current(a,task),ids=new Set();
 for(const d of check?.gapDetails||[]){
  if(d.artifactId&&!current.some(r=>r.id===d.artifactId))return null;
  if((d.sourceIds||[]).some(id=>a.data.artifacts.some(r=>r.id===id)&&!current.some(r=>r.id===id)))return null;
  for(const id of [d.artifactId,...(d.sourceIds||[])])if(current.some(r=>r.id===id))ids.add(id);
  if(d.stepId){const r=current.find(r=>r.stepId===d.stepId);if(r)ids.add(r.id);}
 }
 // Legacy checks often put the exact artifact ID/title in their gap text.
 if(!ids.size)for(const gap of check?.gaps||[])for(const r of current)if(gap.includes(r.id)||(r.title?.length>=4&&gap.includes(r.title)))ids.add(r.id);
 if(ids.size===1)return current.find(r=>ids.has(r.id));
 if(ids.size>1)return null; // Planner must split a multi-artifact repair explicitly.
 return current.length===1?current[0]:null;
}
function snapshot(a,task){
 const job=a.data.delegations?.find(j=>j.id===task.agentJobId);
 const artifacts=outputs.current(a,task).map(r=>({artifactId:r.id,stepId:r.stepId,hash:evidence.hash(r.content)}));
 const receipts=(a.data.agentActions||[]).filter(r=>r.taskId===task.id&&r.status==='done'&&artifacts.some(v=>v.artifactId===r.artifactId)).map(r=>({actionId:r.id,artifactId:r.artifactId,tool:r.tool,sourceId:r.result?.sourceId||null,hash:evidence.hash(r.result)}));
 const value={intent:evidence.intent(job,task),artifacts,receipts,sourcesHash:evidence.hash(evidence.taskSources(a,task)),...(task.primaryArtifactId?{primaryArtifactId:task.primaryArtifactId}:{})};
 return {id:evidence.hash(value),...value};
}
function queue(a,task,{artifactId,note,origin='agent',check,existingNote}={}){
 a.assertTaskChange?.(task);
 if(task.deletedAt||task.agentCancelled||['paused','completed'].includes(task.status))throw Error('当前事项不能自动修订');
 const artifact=outputs.select(a,task,artifactId),step=task.steps.find(s=>s.done&&s.artifactId===artifact.id)|| (task.primaryArtifactId===artifact.id?task.steps.find(s=>s.id===artifact.stepId):null);
 if(!step)throw Error('没有可以修订的产出');
 const primary=outputs.primary(a,task),basis=snapshot(a,task);
 const affected=[step];
 for(const s of task.steps.filter(s=>s.kind==='external')){
  const records=(a.data.agentActions||[]).filter(r=>r.taskId===task.id&&r.tool===s.tool&&s.evidence?.includes(r.id));
  const bound=s.inputArtifactId||s.args?.artifactId;
  if(bound===artifact.id||records.some(r=>r.artifactId===artifact.id)||(!bound&&!records.length&&primary?.id===artifact.id))affected.push(s);
 }
 const record=existingNote||{id:randomUUID(),at:now(),kind:'revise',text:note};
 if(task.primaryArtifactId===artifact.id){step.outputRole='primary';step.targetArtifactId=artifact.id;}
 Object.assign(record,{origin,targetArtifactId:artifact.id,targetStepId:step.id,baseHash:evidence.hash(artifact.content),verificationSnapshot:basis,gapDetails:structuredClone(check?.gapDetails||[]),affectedStepIds:affected.map(s=>s.id)});
 if(!existingNote)(task.notes ||= []).push(record);
 for(const s of affected){s.done=false;delete s.artifactId;delete s.evidence;}
 task.needsReplan=null;delete task.contentVerification;a.requeue(task);
 // Other task dependencies still require review; same-task sibling text is retained.
 require('./agent-plan.cjs').invalidateDependents(a,task);
 return {targetArtifactId:artifact.id,targetStepId:step.id,affectedStepIds:record.affectedStepIds};
}
function source(a,task,step){
 if(step.targetArtifactId){
  const rows=a.data.artifacts.filter(r=>r.id===step.targetArtifactId&&r.taskId===task.id&&!r.stale),job=a.data.delegations?.find(j=>j.id===task.agentJobId);
  if(rows.length!==1||!require('./protocol-access.cjs').allowedObject(a,'artifact',rows[0],job,task))throw require('./model-errors.cjs').contextError('CONTEXT_SCOPE_DENIED',{message:'修订原稿当前不可读取，请重新协调绑定。'});
  const note=[...(task.notes||[])].reverse().find(n=>n.kind==='revise'&&n.targetArtifactId===rows[0].id)||{text:[step.title,task.criteria].filter(Boolean).join('\n')};
  return {artifact:rows[0],note};
 }
 for(const note of [...(task.notes||[])].reverse().filter(n=>n.kind==='revise')){
  if(note.legacyTargetUnresolved)continue;
  let targetStep=note.targetStepId,artifact;
  if(note.targetArtifactId){artifact=a.data.artifacts.find(r=>r.id===note.targetArtifactId&&r.taskId===task.id);targetStep ||= artifact?.stepId;}
  if(!targetStep){
   // Recover explicit targets from old run records. Never spread a task-wide legacy
   // note across every subsequent step. Only a single unfinished text step is safe.
   const runStep=(a.data.agentRuns||[]).flatMap(r=>r.steps||[]).findLast(s=>s.tool==='revise_task'&&s.args?.taskId===task.id&&s.args?.note===note.text&&s.args?.artifactId);
   artifact=runStep&&a.data.artifacts.find(r=>r.id===runStep.args.artifactId&&r.taskId===task.id);
   targetStep=artifact?.stepId;
   if(!targetStep){const text=task.steps.filter(s=>['analysis','draft'].includes(s.kind)),pending=text.filter(s=>!s.done);if(pending.length===1)targetStep=pending[0].id;else if(text.length===1)targetStep=text[0].id;}
   artifact ||= a.data.artifacts.findLast(r=>r.taskId===task.id&&r.stepId===targetStep&&!r.stale);
   if(targetStep&&artifact){Object.assign(note,{targetStepId:targetStep,targetArtifactId:artifact.id,baseHash:evidence.hash(artifact.content),legacyBoundAt:now()});}
   else note.legacyTargetUnresolved=true;
   a.save?.();
  }
  if(targetStep!==step.id)continue;
  artifact ||= a.data.artifacts.findLast(r=>r.taskId===task.id&&r.stepId===step.id);
  if(!artifact?.content||artifact.stepId!==step.id||Date.parse(note.at)<Date.parse(artifact.createdAt))continue;
  if(note.baseHash&&note.baseHash!==evidence.hash(artifact.content))continue;
  // A completed replacement consumes the note even when later work reopens the step.
  if(a.data.artifacts.some(r=>r.taskId===task.id&&r.stepId===step.id&&!r.stale&&Date.parse(r.createdAt)>Date.parse(note.at)))continue;
  const job=a.data.delegations?.find(j=>j.id===task.agentJobId);
  if(!require('./protocol-access.cjs').allowedObject(a,'artifact',artifact,job,task))throw require('./model-errors.cjs').contextError('CONTEXT_SCOPE_DENIED',{message:'修订原稿当前不可读取，已保留原稿；请恢复原授权或选择可读取的稿件。'});
  return {artifact,note};
 }
 return null;
}
function assertRevision(a,task,step,original){
 const current=source(a,task,step);
 if(!current||current.artifact.id!==original.artifact.id||evidence.hash(current.artifact.content)!==original.hash)throw require('./model-errors.cjs').contextError('CONTEXT_VERSION_CHANGED',{message:'修订原稿或权限在生成期间变化，候选修改未应用。'});
}
const verificationInstruction='检查仅针对 verificationSnapshot 固定的要求、稿件版本和回执。辅助核验说明是生成时点的记录，不要求它预言随后发生的保存、发布或检查结果；历史内部状态变化本身不能作为业务缺口。当前交付事实以应用回执为准，verified=true 仅证明工具动作成功，contentVerified=false 不能当成正文一致性已核实。对每项文稿缺口在 gapDetails 填入当前 artifactId 和 stepId，以及 kind=text（可直接改文）、evidence（须查询新事实）、binding（主稿或修订对象错误）、delivery（交付缺口）。分别指出应修订的稿件，不将辅助说明的问题归给主稿。用户目标及最新补充优先于 Agent 自拟的步骤和检查口径，不得把内部修复指令当成新增交付要求。';
function deliveryContext(a,task,record,protocol){
 const artifact=outputs.current(a,task).find(r=>r.id===record.artifactId);
 const beingRevised=task.steps.some(s=>!s.done&&s.targetArtifactId===record.artifactId);
 const row=[...protocol.readableCatalog,...protocol.historyCatalog].find(r=>r.id===record.result?.sourceId);
 const current=record.tool==='request_confirmation'?task.steps.some(s=>s.done&&s.tool===record.tool&&s.evidence?.includes(record.id)):!!artifact&&!beingRevised&&record.content===artifact.content&&record.presentationStatus!=='historical'&&(record.workRevision==null||record.workRevision===(task.workRevision??1))&&(!record.result?.sourceId||row?.state==='active');
 const saved=row&&a.data.sources.find(s=>s.id===row.id&&!s.deleted&&!s.projectExcluded);
 return {tool:record.tool,artifactId:record.artifactId,current,result:record.result,...(saved?{readback:{...require('./documents.cjs').summary(saved,30000),state:row.state,version:row.version,delivery:row.delivery||null,current}}:{})};
}
module.exports={queue,source,target,snapshot,verificationInstruction,deliveryContext,assertRevision};
