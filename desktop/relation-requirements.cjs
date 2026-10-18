// Stable demand identities, independent of verification receipts. Readers are
// pure; confirmations are committed by relation-obligations.record with the
// existing check transaction, including checks that produce no valid receipts.
const {hash}=require('./evidence-basis.cjs');
const rows=x=>Array.isArray(x)?x:[],unique=x=>[...new Set(x)].sort();
const kinds=['sql_read_write','configured_outputs','physical_lineage','dataset_mapping'];
function contractBasis(job){return hash({contract:job.executionContract||null,goal:job.executionContract?null:job.goal});}
function scopeKey(scope){return hash({region:scope.region,roots:[...scope.rootIds].sort()});}
function typeId(task,scope,kind){return 'relation:'+hash({taskId:task.id,kind,scope:scopeKey(scope)});}
function contractIssue(job){
 const value=job.executionContract?.relationRequirements;
 if(value===undefined)return null;
 return Array.isArray(value)&&value.every(r=>kinds.includes(typeof r==='string'?r:r?.kind)&&(typeof r==='string'||r.taskIds===undefined||Array.isArray(r.taskIds)&&r.taskIds.every(id=>/^\d+$/.test(String(id))&&Number.isSafeInteger(Number(id))&&Number(id)>0)))?null:'invalid_typed_relation_contract';
}
function extract(text){
 // Legacy import only. Confirmed structured demands below, not this spelling,
 // own the lifetime of the requirement. Missing a keyword never removes one.
 const s=String(text||'');return kinds.filter(kind=>({
  sql_read_write:/SQL[^。；\n]{0,80}(?:读写|读表|写表|输入输出|输入.*输出|read|write)/i,
  configured_outputs:/(?:产出|输出)[^。；\n]{0,16}配置|配置[^。；\n]{0,16}(?:产出|输出)/,
  physical_lineage:/物理表[^。；\n]{0,30}(?:血缘|生产|消费)|Coral[^。；\n]{0,30}血缘/i,
  dataset_mapping:/风神|Aeolus|数据集[^。；\n]{0,20}映射/i
 })[kind].test(s));
}
function typedGaps(task,scope,checks,{incoming,basis,currentCheckBases=[]}={}){
 return checks.flatMap(check=>check?.passed===false?rows(check.gapDetails).filter(g=>g.relationDemandOrigin!=='program_projection'&&kinds.includes(g.relationKind)&&rows(check.gaps).includes(g.text)&&
  (!g.requirementId||['goal','task:'+task.id].includes(g.requirementId))&&
  (!rows(g.rootIds).length||g.rootIds.every(id=>scope.rootIds.includes(String(id))))).map(g=>({kind:g.relationKind,targetTaskIds:rows(g.targetTaskIds).map(String),current:check===incoming||check.relationRequirementBasis===basis||!!check.basis&&currentCheckBases.includes(check.basis),origin:{type:'check_gap',basis:check.basis||null,contractBasis:check.relationRequirementBasis||null,textHash:hash(g.text)}})):[]);
}
function inspect(job,task,scope,{check,currentCheckBases}={}){
 const basis=contractBasis(job),key=scopeKey(scope),saved=rows(job.executionState?.relations?.requirements).filter(r=>r.version===1&&r.taskId===task.id);
 const structured=job.executionContract?.relationRequirements;
 const explicit=Array.isArray(structured)&&!contractIssue(job);
 const declared=explicit?unique(structured.map(r=>typeof r==='string'?r:r.kind)):extract(job.executionContract?.text||job.goal);
 const confirmations=declared.map(kind=>({kind,origin:{type:explicit?'structured_contract':'legacy_contract',basis}}));
 const gaps=typedGaps(task,scope,[task.contentVerification,task.verification,...rows(task.invalidatedChecks).map(r=>r.check||r),check],{incoming:check,basis,currentCheckBases});
 // An explicitly replaced typed contract is the authority to withdraw a type;
 // an omitted word, ordinary feedback, or a new check omitting a gap is not.
 const active=explicit?declared:unique([...declared,...saved.map(r=>r.kind),...gaps.map(g=>g.kind)]);
 return active.map(kind=>{
  const prior=saved.findLast(r=>r.kind===kind&&r.scopeKey===key)||saved.findLast(r=>r.kind===kind),fresh=[...confirmations,...gaps.filter(g=>g.current)].filter(r=>r.kind===kind),confirmed=explicit||fresh.length>0||prior?.contractBasis===basis&&prior?.confirmationState==='confirmed';
  const declaredTargets=explicit?structured.filter(r=>r?.kind===kind).flatMap(r=>rows(r.taskIds).map(String)):[];
  const targetTaskIds=unique(explicit?declaredTargets:[...rows(prior?.targetTaskIds),...gaps.filter(g=>g.kind===kind).flatMap(g=>g.targetTaskIds)]);
  return {id:typeId(task,scope,kind),version:1,taskId:task.id,kind,scopeKey:key,contractBasis:basis,rootIds:scope.rootIds,region:scope.region,
   confirmationState:confirmed&&!contractIssue(job)?'confirmed':'requires_confirmation',origins:unique([...rows(prior?.origins).map(JSON.stringify),...fresh.map(r=>JSON.stringify(r.origin))]).map(JSON.parse),
   targetTaskIds,priorEntities:rows(prior?.entities)};
 });
}
function entityKey(e){return hash({rootId:e.rootId,direction:e.direction,nodeId:e.nodeId,region:e.region});}
function entities(scope,sources,prior=[]){
 const frontier=require('./lineage-frontier.cjs'),result=new Map();
 for(const rootId of scope.rootIds){
  const paths=frontier.build(sources,{...scope,rootIds:[rootId]},sources.map(s=>({sourceId:s.id})));
  for(const p of paths){
   if(p.region!==scope.region&&p.region!=='unknown')continue;
   const e={rootId,direction:p.nodeId===rootId?'root':p.direction,nodeId:p.nodeId,region:p.region,projectId:p.projectId||null,
    scopeProven:p.scopeProven&&!p.crossRegion,proofSourceIds:unique(p.proofSourceIds),projectIds:p.projectIds};
   result.set(entityKey(e),e);
  }
 }
 // Losing a binding cannot erase an already confirmed obligation. It only
 // removes its current path proof; no query/authority is minted from history.
 for(const e of prior)if(scope.rootIds.includes(e.rootId)&&!result.has(entityKey(e)))result.set(entityKey(e),{...e,scopeProven:false,proofSourceIds:[],reason:'scope_evidence_missing'});
 return [...result.values()].sort((a,b)=>entityKey(a).localeCompare(entityKey(b)));
}
function targets(d,scope,sources){
 const all=entities(scope,sources,d.priorEntities);
 if(d.kind!=='dataset_mapping')return {entities:all,unresolvedRootIds:[]};
 // A terminal scheduling node is not evidence of a final consumer. Only a
 // typed mapping observation, an actual Hive2CH/consumer configuration, or an
 // explicit contract/check target selects a dataset-mapping entity.
 const candidates=new Map();
 for(const source of sources){
  let raw;try{raw=JSON.parse(source.content);raw=raw.structuredContent||raw;}catch{continue;}
  const data=raw.data||{},q=raw.query||{},operator=data.conf?.configuration?.operator||{};
  const configured=[data.type,data.taskType,operator.type].some(type=>/^(hive2ch|hive_to_clickhouse|hivetoclickhouse|aeolus|aeolus_dataset)$/i.test(type||''));
  const outputs=rows(data.outputs||data.outputTables||data.config?.outputs||operator.parameter?.targets);
  const consumer=outputs.some(x=>['ClickhouseTable','AeolusDataset'].includes(require('./platform-boundaries.cjs').entityType(x?.entityType||x?.typeName||x?.type)));
  if(!['dataset','dataset_mapping'].includes(raw.operation)&&!(raw.operation==='task'&&configured)&&!(['task','outputs'].includes(raw.operation)&&consumer))continue;
  const taskId=String(q.taskId);if(!candidates.has(taskId))candidates.set(taskId,[]);candidates.get(taskId).push(source.id);
 }
 const selected=all.filter(e=>d.targetTaskIds.includes(e.nodeId)||candidates.has(e.nodeId)||rows(d.priorEntities).some(old=>entityKey(old)===entityKey(e))).map(e=>{
  const explicit=d.targetTaskIds.includes(e.nodeId),proof=candidates.get(e.nodeId)||[],current=explicit||proof.length>0;
  return {...e,scopeProven:e.scopeProven&&current,proofSourceIds:unique([...e.proofSourceIds,...proof]),targetOrigin:explicit?'explicit_requirement':'final_consumer_evidence',...(!current?{reason:'target_evidence_missing'}:{})};
 });
 return {entities:selected,unresolvedRootIds:scope.rootIds.filter(root=>!selected.some(e=>e.rootId===root)),unprovenTargetTaskIds:d.targetTaskIds.filter(id=>!selected.some(e=>e.nodeId===id))};
}
const prepared=new WeakMap();
function prepare(job,task,requirements,receipts){
 prepared.set(receipts,{job,task,workRevision:task.workRevision??1,basis:contractBasis(job),requirements:requirements.map(r=>({version:1,id:r.typeId,taskId:task.id,kind:r.kind,scopeKey:r.scopeKey,contractBasis:r.contractBasis,rootIds:r.rootIds,region:r.region,confirmationState:r.confirmationState,origins:r.origins,targetTaskIds:r.targetTaskIds||[],entities:r.entities||[]}))});
}
function record(job,receipts){
 const p=prepared.get(receipts);if(!p)return;
 if(p.job!==job||p.basis!==contractBasis(job)||(p.task.workRevision??1)!==p.workRevision)throw Object.assign(Error('关系要求确认期间合同已变化'),{code:'PLAN_RECONCILE_REQUIRED'});
 job.executionState ||= {};job.executionState.relations ||= {version:2,receipts:[]};
 const state=job.executionState.relations;state.requirements ||= [];
 // Replace the active task set, including explicit withdrawals. Older scopes
 // must not resurrect a type explicitly removed by a later typed contract.
 state.requirements=state.requirements.filter(r=>r.taskId!==p.task.id);
 state.requirements.push(...structuredClone(p.requirements));
 prepared.delete(receipts);
}
const synchronized=new WeakMap();
function syncSignature(a){
 const jobs=rows(a.data.delegations).filter(j=>j.dataPlatform==='sg-readonly'&&!j.deletedAt),taskIds=new Set(jobs.flatMap(j=>rows(j.taskIds)));
 if(!jobs.length)return 'no_relation_jobs';
 // One linear hash, no snapshot parsing or per-root graph construction. Include
 // actual persisted requirements, not just inputs: a failed atomic save may
 // restore them in place, and that rollback MUST invalidate a cached result.
 return hash({jobs:jobs.map(j=>({id:j.id,goal:j.goal,executionContract:j.executionContract,projectId:j.projectId,taskIds:j.taskIds,sourceIds:j.sourceIds,platformPrincipal:j.platformPrincipal,capabilityGrants:j.capabilityGrants,requirements:j.executionState?.relations?.requirements})),
  tasks:rows(a.data.tasks).filter(t=>taskIds.has(t.id)).map(t=>({id:t.id,agentJobId:t.agentJobId,projectId:t.projectId,deletedAt:t.deletedAt,agentCancelled:t.agentCancelled,workRevision:t.workRevision,sourceIds:t.sourceIds,supersededSourceIds:t.supersededSourceIds,contextBindings:t.contextBindings,withdrawnBindingIds:t.withdrawnBindingIds,contextWithdrawals:t.contextWithdrawals,contentVerification:t.contentVerification,verification:t.verification,invalidatedChecks:t.invalidatedChecks,criteria:t.criteria,notes:t.notes,requirementRevision:t.requirementRevision})),
  sources:a.data.sources,capabilities:a.data.capabilities,capabilityRuns:a.data.capabilityRuns,
  requireContextAccessPolicy:a.requireContextAccessPolicy,accessPolicy:a.data.runtime?.accessPolicy,authorizationMigration:a.data.runtime?.authorizationMigration,policyProjection:a.data.runtime?.accessPolicyProjectionPending});
}
// Explicit save hook, after execution-contract.initialize. Constructor's final
// save covers startup. No recursive save, grant, adapter, or receipt creation.
function synchronize(a){
 const signature=syncSignature(a),cached=synchronized.get(a);
 if(cached?.signature===signature&&cached.accessCheck===a.contextAccessCheck)return false;
 let changed=false;
 for(const job of rows(a.data.delegations)){
  if(job.dataPlatform!=='sg-readonly'||job.deletedAt)continue;
  for(const taskId of rows(job.taskIds)){
   const task=rows(a.data.tasks).find(t=>t.id===taskId);
   if(!task||task.deletedAt||task.agentCancelled||task.agentJobId!==job.id||(task.projectId||null)!==(job.projectId||null))continue;
   const demands=require('./relation-obligations.cjs').required(a,job,task),receipts=[];prepare(job,task,demands,receipts);
   const before=hash(rows(job.executionState?.relations?.requirements).filter(r=>r.taskId===task.id));
   if(before===hash(prepared.get(receipts).requirements)){prepared.delete(receipts);continue;}
   record(job,receipts);changed=true;
  }
 }
 synchronized.set(a,{signature:changed?syncSignature(a):signature,accessCheck:a.contextAccessCheck});
 return changed;
}
module.exports={kinds,contractBasis,contractIssue,scopeKey,typeId,inspect,entities,targets,prepare,record,synchronize};
