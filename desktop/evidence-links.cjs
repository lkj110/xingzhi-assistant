const {hash}=require('./evidence-basis.cjs');
const {contextError}=require('./model-errors.cjs');
const purposes=new Set(['input','delivery_readback']);
const states=new Set(['active','historical','withdrawn']);
const principal=s=>s.principalScope??s.platformPrincipal??s.larkOpenId??null;
const resource=s=>s.resourceKey||s.identity||s.url||s.remoteId||s.id;
const revision=s=>String(s.revisionId??s.remoteRevision??s.version??hash(s.content));
const withdrawn=s=>!s||!!(s.deleted||s.deletedAt||s.withdrawn||s.withdrawnAt||s.projectExcluded||s.contentDeleted);
const withdrawalKey=(sourceId,purpose)=>hash({sourceId,purpose});
const bindingWithdrawn=(task,b)=>task.withdrawnBindingIds?.includes(b.bindingId)||(task.contextWithdrawals||[]).some(w=>w.key===withdrawalKey(b.sourceId,b.purpose));
function valid(a,job,id){const s=a.data.sources.find(s=>s.id===id);return s&&job.sourceIds.includes(id)&&!withdrawn(s)&&(s.projectId||null)===(job.projectId||null)&&(!(s.jobId||s.agentJobId)||(s.jobId||s.agentJobId)===job.id);}
function isDelivery(s){return s?.purpose==='delivery_readback'||!!s?.deliveryActionId||typeof s?.identity==='string'&&s.identity.startsWith('lark-delivery:');}
function binding(task,source,spec){
 const purpose=spec.purpose||'input',provenance=spec.provenance||{kind:'legacy_input'};
 return {bindingId:'binding:'+hash({taskId:task.id,sourceId:source.id,purpose,actionId:provenance.actionId||null,revisionId:spec.revisionId??revision(source)}),taskId:task.id,sourceId:source.id,resourceKey:spec.resourceKey||resource(source),revisionId:String(spec.revisionId??revision(source)),purpose,state:spec.state||'active',provenance:structuredClone(provenance),principalScope:spec.principalScope??principal(source),contentHash:hash(source.content),...(spec.artifactId?{artifactId:spec.artifactId}:{}),...(spec.target?{target:spec.target}:{}),createdAt:new Date().toISOString(),bindingRevision:1};
}
// Read-only compatibility view. Typed records win over legacy projections, including tombstones.
function bindings(a,task){
 const rows=(task.contextBindings||[]).filter(b=>b.taskId===task.id).map(b=>({...b,...(bindingWithdrawn(task,b)?{state:'withdrawn'}:{})}));
 for(const id of task.sourceIds||[]){
  const s=a.data.sources.find(s=>s.id===id);
  if(rows.some(b=>b.sourceId===id)||isDelivery(s))continue;
  const b=binding(task,s||{id,content:undefined},{purpose:'input',state:withdrawn(s)?'withdrawn':task.supersededSourceIds?.includes(id)?'historical':'active'});
  if(bindingWithdrawn(task,b))b.state='withdrawn';rows.push(b);
 }
 return rows;
}
function project(task){
 const inputs=(task.contextBindings||[]).filter(b=>b.purpose==='input'&&b.state!=='withdrawn'&&!bindingWithdrawn(task,b));
 task.sourceIds=[...new Set(inputs.map(b=>b.sourceId))];
 task.supersededSourceIds=[...new Set(inputs.filter(b=>b.state==='historical'&&!inputs.some(n=>n.sourceId===b.sourceId&&n.state==='active')).map(b=>b.sourceId))];
}
function assertSource(a,task,source,{metadataOnly=false}={}){
 const job=(a.data.delegations||[]).find(j=>j.id===task.agentJobId),projectId=task.projectId??job?.projectId??null;
 if(!source||!metadataOnly&&withdrawn(source)||task.deletedAt||task.agentCancelled||(source.projectId||null)!==projectId||source.taskId&&source.taskId!==task.id||(source.jobId||source.agentJobId)&&(source.jobId||source.agentJobId)!==task.agentJobId||task.agentJobId&&(!job||job.deletedAt||!job.taskIds?.includes(task.id)||(task.projectId||null)!==(job.projectId||null)||!job.sourceIds?.includes(source.id)))throw contextError('CONTEXT_SCOPE_DENIED');
 return job;
}
// Pure workspace mutation; caller commits/saves with the surrounding domain operation.
function bind(a,task,spec){
 if(!spec||!purposes.has(spec.purpose)||!states.has(spec.state||'active')||!spec.sourceId)throw contextError('CONTEXT_INVALID_REQUEST');
 const source=a.data.sources.find(s=>s.id===spec.sourceId);assertSource(a,task,source);
 if(spec.principalScope!=null&&principal(source)!=null&&hash(spec.principalScope)!==hash(principal(source)))throw contextError('CONTEXT_SCOPE_DENIED');
 if(spec.purpose==='input'&&isDelivery(source)&&spec.provenance?.kind!=='explicit_input')throw contextError('CONTEXT_INVALID_REQUEST',{message:'自身交付只有经明确输入绑定才能成为新要求的依据'});
 if(spec.purpose==='delivery_readback'&&(!spec.provenance?.actionId||!spec.artifactId||!spec.target||spec.principalScope==null))throw contextError('CONTEXT_LINK_MISSING');
 if(spec.purpose==='delivery_readback'){
  const record=(a.data.agentActions||[]).find(r=>r.id===spec.provenance.actionId&&r.taskId===task.id),proof=record&&deliverySpec(a,record,source);
  if(!proof||proof.artifactId!==spec.artifactId||proof.target!==spec.target||hash(proof.principalScope)!==hash(spec.principalScope)||spec.revisionId!=null&&String(spec.revisionId)!==proof.revisionId)throw contextError('CONTEXT_LINK_MISSING');
  if(proof.state==='historical'&&spec.state!=='withdrawn')spec={...spec,state:'historical'};
 }
 const rows=bindings(a,task),next=binding(task,source,spec);
 if(bindingWithdrawn(task,next)&&next.state!=='withdrawn')throw contextError('CONTEXT_SCOPE_DENIED');
 if(rows.some(b=>b.sourceId===source.id&&b.purpose===spec.purpose&&b.state==='withdrawn')&&next.state!=='withdrawn')throw contextError('CONTEXT_SCOPE_DENIED');
 const old=rows.find(b=>b.bindingId===next.bindingId);
 if(old){
  const semantic=b=>({...b,createdAt:undefined,bindingRevision:undefined});
  if(hash(semantic(old))!==hash(semantic(next)))Object.assign(old,next,{createdAt:old.createdAt,bindingRevision:(old.bindingRevision||1)+1});
 }else rows.push(next);
 task.contextBindings=rows;task.evidenceLinksVersion=3;project(task);
 return old||next;
}
function setInputs(a,task,sourceIds,supersededSourceIds=[],provenance={kind:'plan_task'}){
 if(!Array.isArray(sourceIds)||new Set(sourceIds).size!==sourceIds.length)throw contextError('CONTEXT_INVALID_REQUEST');
 const draft={...task,contextBindings:bindings(a,task)};
 for(const id of sourceIds){
  if(bindingWithdrawn(task,{sourceId:id,purpose:'input'}))throw contextError('CONTEXT_SCOPE_DENIED');
  const source=a.data.sources.find(s=>s.id===id),historical=supersededSourceIds.includes(id);
  if(source&&withdrawn(source)&&historical){
   const job=assertSource(a,draft,source,{metadataOnly:true}),ids=new Set(job?.sourceIds||sourceIds),seen=new Set();let head=source;
   while(true){
    if(seen.has(head.id))throw contextError('CONTEXT_VERSION_CHANGED');
    seen.add(head.id);const next=a.data.sources.filter(s=>ids.has(s.id)&&s.previousSourceId===head.id&&!s.copiedFrom&&(s.projectId||null)===(source.projectId||null)&&hash(principal(s))===hash(principal(source)));
    if(!next.length)break;if(next.length!==1)throw contextError('CONTEXT_VERSION_CHANGED');head=next[0];
   }
   // Keep only a historical relation to the tombstone. Reading the old body remains denied.
   if(head.id===id||!sourceIds.includes(head.id)||withdrawn(head)||isDelivery(source)||(task.contextBindings||[]).some(b=>b.sourceId===id&&b.purpose==='input'&&b.state==='withdrawn'))throw contextError('CONTEXT_SCOPE_DENIED');
   assertSource(a,draft,head);
   const next=binding(task,source,{purpose:'input',state:'historical',provenance}),old=draft.contextBindings.find(b=>b.bindingId===next.bindingId);
   if(old)Object.assign(old,next,{createdAt:old.createdAt,bindingRevision:old.state==='historical'?old.bindingRevision:(old.bindingRevision||1)+1});else draft.contextBindings.push(next);
   continue;
  }
  const explicit=draft.contextBindings.find(b=>b.sourceId===id&&b.purpose==='input'&&b.provenance?.kind==='explicit_input');bind(a,draft,{sourceId:id,purpose:'input',state:historical?'historical':'active',provenance:explicit?.provenance||provenance});
 }
 for(const b of draft.contextBindings)if(b.purpose==='input'&&!sourceIds.includes(b.sourceId)&&b.state!=='withdrawn'){b.state='withdrawn';b.bindingRevision=(b.bindingRevision||1)+1;}
 task.contextBindings=draft.contextBindings;task.evidenceLinksVersion=3;project(task);return task.contextBindings;
}
// Trusted command adapter. setInputs/initialize remain pure workspace projections.
// A source+purpose tombstone also covers legacy backups with no typed binding or
// with an older revision-derived binding ID. It never revokes another task's input.
function withdrawalEvents(a,task,sourceIds,{purpose='input',actor='user',reason,command='source_withdrawal'}={}){
 if(!a.data.tasks.some(t=>t.id===task?.id)||!Array.isArray(sourceIds)||new Set(sourceIds).size!==sourceIds.length||sourceIds.some(id=>typeof id!=='string'||!id)||!['input','delivery_readback','all'].includes(purpose)||!['user','agent','system'].includes(actor)||typeof reason!=='string'||!reason.trim()||reason.length>2000)throw contextError('CONTEXT_INVALID_REQUEST');
 const rows=bindings(a,task),selected=[];
 for(const sourceId of sourceIds){
  const matches=rows.filter(b=>b.sourceId===sourceId&&(purpose==='all'||b.purpose===purpose));
  if(!matches.length&&!(task.contextWithdrawals||[]).some(w=>w.sourceId===sourceId&&(purpose==='all'||w.purpose===purpose)))throw contextError('CONTEXT_SCOPE_DENIED');
  for(const b of matches)if(!bindingWithdrawn(task,b))selected.push(b);
 }
 if(!selected.length)return [];
 const base={entityKind:'task',entityId:task.id,workRevision:task.workRevision??1,actor,basisRefs:{command,reason:reason.trim(),jobId:task.agentJobId||null}};
 const records=selected.map(({bindingId,sourceId,purpose})=>({bindingId,sourceId,purpose}));
 return [...records.map(b=>({...base,type:'binding_withdrawn',payload:{bindingId:b.bindingId,...(b.purpose==='input'?{sourceId:b.sourceId}:{}),purpose:b.purpose}})),{...base,type:'context_bindings_withdrawn',payload:{bindings:records}}];
}
function projectWithdrawals(_a,task,event){
 if(!task)return;
 for(const b of event.payload.bindings){
  const key=withdrawalKey(b.sourceId,b.purpose);
  task.contextWithdrawals ||= [];
  if(!task.contextWithdrawals.some(w=>w.key===key))task.contextWithdrawals.push({...b,key,eventId:event.eventId,sequence:event.sequence});
  task.withdrawnBindingIds=[...new Set([...(task.withdrawnBindingIds||[]),b.bindingId])];
  for(const row of task.contextBindings||[])if(row.sourceId===b.sourceId&&row.purpose===b.purpose&&row.state!=='withdrawn'){row.state='withdrawn';row.bindingRevision=(row.bindingRevision||1)+1;}
  if(b.purpose==='input'){task.sourceIds=(task.sourceIds||[]).filter(id=>id!==b.sourceId);task.supersededSourceIds=(task.supersededSourceIds||[]).filter(id=>id!==b.sourceId);}
 }
}
function withdrawSources(a,task,sourceIds,options={}){
 const events=withdrawalEvents(a,task,sourceIds,options);
 return events.length?require('./work-journal.cjs').commit(a,events,{commitId:options.commitId,save:options.save!==false}):null;
}
// A repair requires structured action/source identity, never titles, body IDs, or job membership alone.
function deliverySpec(a,record,source){
 const task=a.data.tasks.find(t=>t.id===record?.taskId),job=(a.data.delegations||[]).find(j=>j.id===record?.jobId);
 if(!task||!job||task.agentJobId!==job.id||!job.taskIds?.includes(task.id)||withdrawn(source)||source.deliveryActionId!==record.id||record.effectStatus&&record.effectStatus!=='applied'||!record.effectStatus&&record.status!=='done')return null;
 const artifact=a.data.artifacts.find(r=>r.id===record.artifactId&&r.taskId===task.id);
 const account=record.principalScope??record.larkOpenId??record.result?.principalScope;
 const target=record.result?.resourceKey||record.result?.url||record.resourceKey||record.target;
 if(withdrawn(artifact)||account==null||principal(source)==null||hash(account)!==hash(principal(source))||!target||target!==resource(source)||source.remoteRevision==null&&source.revisionId==null||record.result?.sourceId&&record.result.sourceId!==source.id||record.result?.revision!=null&&String(record.result.revision)!==revision(source))return null;
 const historical=record.presentationStatus==='historical'||['completed','cancelled'].includes(task.status)||record.workRevision!=null&&record.workRevision!==task.workRevision||!task.steps?.some(s=>s.artifactId===artifact.id)||record.content!=null&&record.content!==artifact.content;
 return {sourceId:source.id,purpose:'delivery_readback',state:historical?'historical':'active',provenance:{kind:'action_readback',actionId:record.id},artifactId:artifact.id,target,principalScope:account,resourceKey:resource(source),revisionId:revision(source)};
}
// A historical read is evidence of its original delivery, never of the current
// draft. This proof is read-only and cannot recreate a withdrawn association.
function historicalDelivery(a,b,source){
 const task=a.data.tasks.find(t=>t.id===b.taskId);
 if(!task||b.purpose!=='delivery_readback'||b.state!=='historical'||b.sourceId!==source?.id||b.provenance?.kind!=='action_readback'||bindingWithdrawn(task,b))return null;
 const saved=(task.contextBindings||[]).find(row=>row.bindingId===b.bindingId&&row.sourceId===source.id&&row.taskId===task.id&&row.purpose===b.purpose);
 if(!saved||saved.state==='withdrawn'||(task.contextBindings||[]).some(row=>row.sourceId===source.id&&row.purpose===b.purpose&&row.state==='withdrawn')||source.state==='withdrawn'||source.retention==='deleted'||(a.data.sourceDeletions||[]).some(row=>row.sourceId===source.id))return null;
 let job;try{job=assertSource(a,task,source);}catch{return null;}
 const lifecycle=require('./project-lifecycle.cjs');
 if(!job||task.archivedAt||job.archivedAt||['cancelled','archived'].includes(task.status)||['cancelled','archived'].includes(job.status)||!lifecycle.isTaskActive(a.data,task)||!lifecycle.isJobActive(a.data,job))return null;
 if([source.jobId,source.agentJobId].some(id=>id&&id!==job.id))return null;
 const records=(a.data.agentActions||[]).filter(r=>r.id===b.provenance.actionId||r.result?.sourceId===source.id);
 if(records.length!==1)return null;
 const record=records[0],spec=deliverySpec(a,record,source);
 if(!spec||record.taskId!==task.id||record.jobId!==job.id||record.id!==b.provenance.actionId||record.status!=='done'||record.result?.verified!==true||record.result.sourceId!==source.id||record.result.revision==null||record.deliveryConflict)return null;
 if(source.identity&&source.identity!=='lark-delivery:'+record.id)return null;
 if(record.tool&&!['lark_create','lark_update'].includes(record.tool))return null;
 if(record.result.principalScope!=null&&hash(record.result.principalScope)!==hash(spec.principalScope))return null;
 if(record.larkOpenId&&record.larkOpenId!==(typeof spec.principalScope==='string'?spec.principalScope:spec.principalScope.subject||spec.principalScope.openId))return null;
 if(record.tenantId&&record.tenantId!==spec.principalScope.tenantId)return null;
 for(const key of ['artifactId','target','resourceKey','revisionId','principalScope'])if(hash(b[key])!==hash(spec[key])||hash(saved[key])!==hash(b[key]))return null;
 if(saved.contentHash!==b.contentHash||b.contentHash!==hash(source.content))return null;
 const artifact=a.data.artifacts.find(row=>row.id===spec.artifactId&&row.taskId===task.id);
 if(artifact.projectId!=null&&artifact.projectId!==(task.projectId??null))return null;
 return {actionId:record.id,artifactId:spec.artifactId,target:spec.target,revisionId:spec.revisionId,principalScope:spec.principalScope,workRevision:record.workRevision??null,
  submittedContentHash:typeof record.content==='string'?hash(record.content):null,savedArtifactMatchesSubmission:typeof record.content==='string'?record.content===artifact.content:null};
}
function bindDelivery(a,record,source){
 if((a.data.sourceDeletions||[]).some(e=>e.sourceId===source?.id)){
  a.data.sources=a.data.sources.filter(s=>s.id!==source.id);return null;
 }
 const stored=a.data.sources.find(s=>s.id===source?.id);
 const spec=stored&&deliverySpec(a,record,stored);if(!spec)return null;
 const task=a.data.tasks.find(t=>t.id===record.taskId);return bind(a,task,spec);
}
function repairDelivery(a,task,sourceId){
 const source=a.data.sources.find(s=>s.id===sourceId);
 const candidates=(a.data.agentActions||[]).filter(r=>r.taskId===task.id&&r.jobId===task.agentJobId&&deliverySpec(a,r,source));
 return candidates.length===1?bindDelivery(a,candidates[0],source):null;
}
function migrateDelivery(a){
 const migrated=[],skipped=[];
 for(const source of a.data.sources){
  if(withdrawn(source))continue;
  const candidates=(a.data.agentActions||[]).filter(r=>r.status==='done'&&r.result?.verified===true&&r.result.sourceId===source.id);
  if(candidates.length!==1)continue;
  const record=candidates[0],task=a.data.tasks.find(t=>t.id===record.taskId),job=a.data.delegations.find(j=>j.id===record.jobId);
  const artifact=a.data.artifacts.find(r=>r.id===record.artifactId&&r.taskId===record.taskId);
  if(!task||!job||task.deletedAt||task.agentCancelled||job.deletedAt||task.agentJobId!==job.id||!job.taskIds?.includes(task.id)||!valid(a,job,source.id)||withdrawn(artifact)||record.effectStatus&&record.effectStatus!=='applied'||!record.larkOpenId||!record.result.url||record.result.revision==null||source.identity!=='lark-delivery:'+record.id||(source.url||source.remoteId)!==record.result.url||String(source.remoteRevision)!==String(record.result.revision)||source.deliveryActionId&&source.deliveryActionId!==record.id||principal(source)!=null&&hash(principal(source))!==hash(record.larkOpenId)) {skipped.push(source.id);continue;}
  const enriched={...source,deliveryActionId:record.id,purpose:'delivery_readback',principalScope:record.larkOpenId,resourceKey:record.result.url};
  // Scope preflight must also precede enrichment: corrupt legacy task/project
  // ownership is a diagnostic gap, not a reason to partially migrate or fail startup.
  try{assertSource(a,task,enriched);}catch{skipped.push(source.id);continue;}
  if(!deliverySpec(a,record,enriched)){skipped.push(source.id);continue;}
  Object.assign(source,{deliveryActionId:record.id,purpose:'delivery_readback',principalScope:record.larkOpenId,resourceKey:record.result.url});
  if(task.contextBindings)task.contextBindings=task.contextBindings.filter(b=>!(b.sourceId===source.id&&b.purpose==='input'&&b.provenance?.kind==='legacy_input'&&b.state!=='withdrawn'));
  if(!bindingWithdrawn(task,{sourceId:source.id,purpose:'delivery_readback'})&&!task.contextBindings?.some(b=>b.sourceId===source.id&&b.purpose==='delivery_readback'&&b.state==='withdrawn')){
   const linked=bindDelivery(a,record,source);if(linked)migrated.push(linked.bindingId);
  }
 }
 return {migrated,skipped};
}
function latest(a,job,id){
  const seen=new Set();while(valid(a,job,id)&&!seen.has(id)){seen.add(id);const next=a.data.sources.filter(s=>s.previousSourceId===id&&valid(a,job,s.id));if(next.length>1)return null;if(!next.length)return id;id=next[0].id;}return null;
}
function initialize(a){
  require('./source-deletions.cjs').replay(a);
  migrateDelivery(a);
  for(const task of a.data.tasks){
    if(task.evidenceLinksVersion>=1)continue;task.evidenceLinksVersion=1;
    const job=a.data.delegations.find(j=>j.id===task.agentJobId);
    if(!job||!require('./project-lifecycle.cjs').isJobActive(a.data,job)||a.data.agentActions.some(r=>(r.taskId===task.id||r.jobId===job.id)&&['uncertain','running'].includes(r.status))||task.sourceIds?.length||task.deletedAt||task.agentCancelled||task.status==='completed')continue;
    const prior=[...(task.planHistory||[])].reverse().find(p=>p.sourceIds?.length);
    if(!prior)continue;
    const restored=[...new Set(prior.sourceIds.map(id=>latest(a,job,id)).filter(id=>id&&!isDelivery(a.data.sources.find(s=>s.id===id))))];
    if(!restored.length)continue;task.sourceIds=restored;task.supersededSourceIds=[];
    task.needsReplan='已恢复升级前被空列表清除的证据关联，请沿用现有成果核对计划';a.requeue(task);
    a.event('证据关联已恢复',`已恢复 ${restored.length} 份本事项原有材料，原始资料未改动。`,task.id);
  }
  for(const task of a.data.tasks){task.contextBindings=bindings(a,task);task.evidenceLinksVersion=3;project(task);}
}
function merge(task,args){
  const old=task?.sourceIds||[];
  // Empty/omitted lists are common on replans. Removal requires explicit IDs.
  const requested=args.sourceIds===undefined?old:args.sourceIds;
  if(!Array.isArray(requested)||new Set(requested).size!==requested.length)throw Error('来源列表必须为不重复的来源 ID');
  const remove=args.removeSourceIds||[];
  if(!Array.isArray(remove)||remove.some(id=>!old.includes(id))||new Set(remove).size!==remove.length)throw Error('只能显式移除本事项已关联的来源');
  if(remove.length&&(!args.reason||!String(args.reason).trim()))throw Error('移除证据必须说明原因');
  return [...new Set([...old,...requested])].filter(id=>!remove.includes(id));
}
module.exports={initialize,merge,bind,bindDelivery,repairDelivery,deliverySpec,historicalDelivery,migrateDelivery,setInputs,withdrawalEvents,withdrawSources,bindings,project,principal,resource,revision,withdrawn,isDelivery};
// Loaded by core before work-journal replay; registration performs no I/O.
require('./work-journal.cjs').registerProjector('context_bindings_withdrawn',projectWithdrawals);
