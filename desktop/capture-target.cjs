const crypto=require('node:crypto');
const provenance=require('./capture-provenance.cjs');
const now=()=>new Date().toISOString();
function eligible(a,t){return t&&!t.deletedAt&&!t.agentCancelled&&!['completed','cancelled'].includes(t.status)&&!a.data.projects.some(p=>p.id===t.projectId&&p.archivedAt);}
function normalize(a,value){
 if(value===undefined||value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||!['new','task'].includes(value.kind))throw Error('请选择新建事项或补充已有事项');
 if(value.kind==='new')return {kind:'new'};
 if(typeof value.taskId!=='string')throw Error('请选择要补充的事项');
 const task=a.data.tasks.find(t=>t.id===value.taskId);if(!eligible(a,task))throw Error('目标事项已完成、删除、取消或归档，请选择推进中的事项');
 if(value.note!==undefined&&(typeof value.note!=='string'||value.note.length>9000))throw Error('补充说明最多 9000 字符');
 return {kind:'task',taskId:task.id,...(value.note?.trim()?{note:value.note.trim()}: {})};
}
function list(a){return (a.data.tasks||[]).filter(t=>eligible(a,t)).map(t=>({id:t.id,title:t.title,status:t.status,projectId:t.projectId||null,projectName:a.data.projects.find(p=>p.id===t.projectId)?.name||'',agent:!!t.agentJobId}));}
const stop=new Set(['这个','那个','我们','你们','需要','进行','工作','事项','内容','补充','整理','任务','信息','一个','相关','目前','现在','完成','结果','推进','the','and','for','with','this','that','task']);
function tokens(text){return new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(String(text).toLowerCase().slice(0,60000))].filter(x=>x.isWordLike).map(x=>x.segment).filter(x=>x.length>=2&&!stop.has(x)));}
function identifiers(text){return [...new Set(String(text).match(/\b\d{6,}\b|\b[a-z][a-z0-9_]{2,}\.[a-z][a-z0-9_]{2,}\b|\b[a-f0-9]{8}-[a-f0-9-]{27,}\b/ig)||[])].map(x=>x.toLowerCase());}
function suggest(a,input){
 if(!input||typeof input.text!=='string'||input.text.length>500000)throw Error('推荐材料文字无效');
 const p=provenance.normalize(input.provenance),text=input.text.toLowerCase(),terms=tokens(text),ids=identifiers(text);
 const candidates=[];
 for(const task of a.data.tasks.filter(t=>eligible(a,t))){
  const sources=a.data.sources.filter(s=>task.sourceIds?.includes(s.id)&&!task.supersededSourceIds?.includes(s.id)&&!s.deleted&&!s.projectExcluded);
  const hay=[task.id,task.title,task.description,task.objective,task.criteria,...sources.map(s=>s.content?.slice(0,25000))].join('\n').toLowerCase();
  let score=0;const reasons=[];
  const knownIds=new Set(identifiers(hay));const matchedIds=ids.filter(id=>knownIds.has(id));if(matchedIds.length){score+=80;reasons.push(`相同标识：${matchedIds.slice(0,3).join('、')}`);}
  if(p?.url&&sources.some(s=>s.provenance?.url===p.url||s.captureOrigins?.some(o=>o.url===p.url)||s.origin===p.url)){score+=75;reasons.push('与已有材料来自同一链接');}
  if(task.title?.length>=4&&text.includes(task.title.toLowerCase())){score+=60;reasons.push('包含事项标题');}
  const taskTerms=tokens(hay);const shared=[...terms].filter(x=>taskTerms.has(x));
  if(shared.length>=2){score+=Math.min(40,shared.length*5);reasons.push(`共同关键词：${shared.slice(0,5).join('、')}`);}
  if(p?.windowTitle?.length>=5&&sources.some(s=>s.provenance?.windowTitle===p.windowTitle&&s.provenance?.appName===p.appName)){score+=15;reasons.push('来自相同来源窗口');}
  if(score>=15)candidates.push({taskId:task.id,title:task.title,status:task.status,projectId:task.projectId||null,score,reasons});
 }
 candidates.sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title));
 const top=candidates[0],confident=top&&top.score>=55&&(!candidates[1]||top.score-candidates[1].score>=15);
 return {recommendation:confident?'task':top?'choose':'new',taskId:confident?top.taskId:null,reason:confident?'这份信息更像现有事项的后续补充。':top?'存在可能相关的事项，请核对后选择。':'暂未找到明确关联，建议新建事项；也可手动选择已有事项。',candidates:candidates.slice(0,5),local:true,modelCalls:0};
}
function apply(a,row){
 if(row.target?.kind!=='task'||row.attachedAt)return;
 const {taskId}=normalize(a,row.target),task=a.task(taskId);
 if((task.projectId||null)!==row.projectId||(task.agentJobId||null)!==(row.targetAgentJobId||null))throw Error('排队期间事项的项目或 Agent 归属已变化，请重新选择目标事项');
 a.assertTaskChange(task);
 const before=structuredClone(a.data);
 try{
  const additions=row.sourceIds.filter(id=>!task.sourceIds.includes(id));
  task.sourceIds=[...new Set([...task.sourceIds,...row.sourceIds])];
  const requirements=[row.target.note,row.advancement?.goal,row.advancement?.criteria].filter(Boolean).join('\n');
  const note=`补充了 ${row.sourceIds.length} 份材料${requirements?`。用户补充要求：${requirements}`:''}`;
  task.notes.push({id:crypto.randomUUID(),kind:'source',text:note,at:now(),sourceIds:[...row.sourceIds],captureId:row.id,...(row.provenance?{provenance:row.provenance}:{})});
  if(additions.length||requirements){task.needsReplan='收到新的补充材料，请先核对变化、矛盾及受影响的步骤，沿用原事项继续推进。';a.requeue(task);if(task.agentJobId)require('./agent-plan.cjs').invalidateDependents(a,task);}
  let job=a.data.delegations.find(j=>j.id===task.agentJobId);
  if(!job&&row.advancement){
   if(a.spendLedger?.scopes['task:'+task.id])throw Error('该事项已有独立推进费用记录。请先仅补充材料，并从事项详情沿用原推进方式，避免重置累计额度');
   const project=task.projectId&&a.data.projects.find(p=>p.id===task.projectId),projectJob=project&&require('./projects.cjs').job(a,project);
   const rule=project&&a.data.workRules.find(r=>r.config.projectId===project.id&&r.status!=='archived');
   if(projectJob)job=projectJob;
   else if(!rule){job=require('./agent.cjs').buildJob(a,{goal:`继续已有事项「${task.title}」。先核对新增材料，沿用 existingTaskId=${task.id} 更新计划和产出。完成标准：${task.criteria||task.description||task.title}`,projectId:task.projectId||null,allowWeb:false,folderIds:[],useOutputFolder:false,useGithub:false,fileMode:'off',githubMode:'off',autoAccept:false,capabilityIds:[],maxCalls:40});a.data.delegations.unshift(job);if(project)project.jobId=job.id;}
   if(job){task.agentJobId=job.id;task.agentKey ||= `capture-${task.id}`;task.planVersion ||= 1;task.planHistory ||= [];task.dependsOn ||= [];task.steps.forEach(s=>s.key ||= s.id);job.taskIds=[...new Set([...job.taskIds,task.id])];}
  }
  if(job){
   require('./projects.cjs').assertSettled(a,job);job.sourceIds=[...new Set([...job.sourceIds,...row.sourceIds])];
   for(const id of additions){const s=a.data.sources.find(s=>s.id===id);if(s)require('./agent-followup.cjs').invalidateEvidence(a,job,s);}
   require('./capability-binding.cjs').bind(a,job,requirements);
   // Keep open questions and approvals; added material is evidence, not an answer or grant.
   job.feedback.push({at:now(),taskId:task.id,kind:'task_material',text:`事项「${task.title}」${note}。材料 ID：${row.sourceIds.join('、')}。先检查这些材料；保留矛盾与来源，不重复创建事项，不扩大工具授权。${row.advancement?'继续原事项；客观信息问题可依据材料解决，需要用户选择的问题仍保留。':'用户仅保存补充材料，维持原委托的运行或暂停状态。'}`});job.feedback=job.feedback.slice(-30);
   const status=job.status,nextRunAt=job.nextRunAt,spendBlocked=!!a.spendLedger?.scopes['job:'+job.id]?.blocked;a.continueTaskJob(task);
   if(!row.advancement||task.status==='paused'){job.status=status;job.nextRunAt=nextRunAt;}
   else if(job.status!=='paused'){if(spendBlocked){job.status='limited';job.limitReason='spend';job.nextRunAt=null;}else{job.status='ready';job.nextRunAt=now();}}
   row.jobId=job.id;
  }else a.invalidateTaskApprovals(task);
  row.taskId=task.id;row.attachedAt=now();if(row.advancement)row.advancedAt=row.attachedAt;
  row.advanceMessage=`已补充到「${task.title}」；${!row.advancement?'材料已保存。':task.status==='paused'||job?.status==='paused'?'原事项或委托暂停中，请恢复后继续。':job?.limitReason==='spend'?'原费用额度需核对确认，补充不会解除费用限制。':job?'将沿用原委托和累计额度继续。':'由原项目规则检查后推进。'}`;
  for(const id of row.sourceIds){const s=a.data.sources.find(s=>s.id===id);if(s){s.state='processed';s.processedAt=now();}}
  task.updatedAt=now();a.event('已补充事项材料',row.advanceMessage,task.id);a.save();
 }catch(e){a.data=before;throw e;}
}
module.exports={normalize,list,suggest,apply,eligible};
