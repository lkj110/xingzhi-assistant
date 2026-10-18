'use strict';
// Pure projections. The ledger commits migration results; readers never mutate
// a contract, a failure, or an acceptance decision.
const {hash}=require('./evidence-basis.cjs');
const id=v=>/^\d+$/.test(String(v))&&Number.isSafeInteger(Number(v))&&Number(v)>0?String(Number(v)):null;
const region=v=>String(v||'sg').trim().toLowerCase();
const lineage=q=>['upstream','downstream'].includes(q?.op);
const table=q=>['table','ddl','table_lineage','table_tasks'].includes(q?.op);
function entityType(value){
 const v=String(value||'').toLowerCase();
 return ['hive','hivetable'].includes(v)?'HiveTable':['ch','clickhouse','clickhousetable'].includes(v)?'ClickhouseTable':['aeolus','aeolusdataset'].includes(v)?'AeolusDataset':value||null;
}
function requestQuery(q={}){
 return Object.fromEntries(['op','taskId','projectId','region','database','table','direction','entityType','depth','page','pageSize'].filter(k=>q[k]!==undefined).map(k=>[k,typeof q[k]==='string'?q[k].slice(0,200):typeof q[k]==='number'||q[k]===null?q[k]:'[invalid]']));
}
// Do not use CLI arguments as identity: some CLI methods cannot pass project,
// page or type, but those fields must never disappear from a boundary/cache key.
function canonicalQuery(q={}){
 const r={op:q.op,region:region(q.region)};
 for(const k of ['taskId','projectId'])if(q[k]!=null)r[k]=id(q[k])||String(q[k]);
 for(const k of ['database','table','direction'])if(q[k]!=null)r[k]=q[k];
 if(table(q)||q.entityType!=null)r.entityType=table(q)&&q.entityType===undefined?'HiveTable':entityType(q.entityType);
 if(lineage(q)||q.depth!=null)r.depth=Number(q.depth??1);
 if(['projects','my_tasks'].includes(q.op)||q.page!=null)r.page=Number(q.page??1);
 if(['projects','my_tasks'].includes(q.op)||q.pageSize!=null)r.pageSize=Number(q.pageSize??100);
 return r;
}
function identity(job,q){
 const r=canonicalQuery(q);delete r.depth;delete r.page;delete r.pageSize;
 return {platform:table(q)?'coral':'dorado',scope:job.dataPlatform,localProjectId:job.projectId||null,principal:job.platformPrincipal||null,permissionRevision:job.executionState?.permissionRevision||0,...r,projectId:r.projectId??null};
}
function currentOperation(job,o){
 return !!o?.query&&hash(o.principal||null)===hash(job.platformPrincipal||null)&&(o.permissionRevision??0)===(job.executionState?.permissionRevision||0)&&(o.scope??'sg-readonly')===job.dataPlatform&&(o.projectId===undefined||o.projectId===(job.projectId||null));
}
function operations(job){return [...(job.executionState?.history||[]),...Object.values(job.executionState?.operations||{})];}
function projectEvidence(sources=[]){
 const result=[],valid=sources.filter(s=>s.platformSnapshot&&!s.deleted&&!s.projectExcluded),superseded=new Set(valid.map(s=>s.previousSourceId).filter(Boolean));
 for(const s of valid){
  if(superseded.has(s.id))continue;
  // Selection remains fresh. Only the pure content projection is reused, and
  // rows are copied so callers cannot alter a later projection's cached result.
  const projected=require('./projection-cache.cjs').memo(projectContent,[s.content],()=>projectContent(s.content));
  for(const row of projected)result.push({...row,sourceId:s.id});
 }
 return result;
}
function projectContent(content){
  const result=[];
  let snap;try{snap=JSON.parse(content);}catch{return result;}
  const q=snap.query||{},d=snap.data||{},regions=[...new Set([snap.region,q.region,d.region].filter(Boolean).map(region))];
  if(regions.length>1)return result;
  const sr=regions[0]||'sg';
  const add=(task,project,r=sr)=>{if(id(task)&&id(project)&&r!=='unknown')result.push({taskId:id(task),projectId:id(project),region:r});};
  // A query project describes its root, never every member of the graph.
  if(d.taskId!=null&&id(d.taskId)!==id(q.taskId)||d.root?.id!=null&&id(d.root.id)!==id(q.taskId)||snap.operation==='task'&&d.id!=null&&id(d.id)!==id(q.taskId))return result;
  add(q.taskId,q.projectId);
  const rows=snap.operation==='task'?[{...d,id:d.id??d.taskId??q.taskId}]:lineage(q)?[d.root||{},...(Array.isArray(d.nodes)?d.nodes:[])]:[];
  for(const row of rows){
   const rs=[...new Set([row.region,row.taskRegion,row.location].filter(Boolean).map(region))];
   if(rs.length>1||row.crossRegion&&(!rs.length||rs[0]===sr))continue;
   add(row.id??row.taskId,row.projectId,rs[0]||sr);
   for(const p of row.parentRelation||[])if(p&&typeof p==='object'){
    const prs=[...new Set([p.region,p.taskRegion,p.location].filter(Boolean).map(region))];
    if(prs.length>1||p.crossRegion&&(!prs.length||prs[0]===sr))continue;
    add(p.id??p.taskId,p.projectId,prs[0]||sr);
   }
  }
 return result;
}
function resolveQuery(job,input,{sources=[],records=job.executionState?.acceptedBoundaries||[],isOperationCurrent=currentOperation}={}){
 const query=requestQuery(input),proof=[];
 if(query.projectId!=null)return {status:id(query.projectId)?'resolved':'scope_unresolved',query,proof:[{kind:'explicit_query',projectId:id(query.projectId)}]};
 if(!lineage(query)&&query.op!=='code')return {status:'resolved',query,proof};
 const taskId=id(query.taskId),r=region(query.region);
 for(const e of projectEvidence(sources))if(e.taskId===taskId&&e.region===r)proof.push({...e,kind:'source'});
 for(const o of operations(job)){
  if(!isOperationCurrent(job,o))continue;
  const q=o.actualQuery||o.query;
  if(id(q.taskId)===taskId&&region(q.region)===r&&id(q.projectId))proof.push({kind:'operation',operationId:o.id||o.key,projectId:id(q.projectId)});
 }
 for(const b of records)if(b.identity&&hash({...b.identity,op:query.op,projectId:null})===hash({...identity(job,query),projectId:null})&&id(b.identity.projectId))proof.push({kind:'accepted_boundary',boundaryId:b.id,projectId:id(b.identity.projectId)});
 const projects=[...new Set(proof.map(p=>p.projectId))].sort();
 if(projects.length===1)return {status:'resolved',query:{...query,projectId:projects[0]},proof};
 return {status:'scope_unresolved',query,reason:projects.length?'ambiguous_project':'missing_project',projectIds:projects,proof};
}
function makeRecord(job,o,decision,options){
 if(o.status!=='failed'||!['AUTH_REQUIRED','NOT_FOUND'].includes(o.errorCode)||!o.id&&!o.key||!Date.parse(o.completedAt))return null;
 if(!(options.isOperationCurrent||currentOperation)(job,o))return null;
 const resolved=resolveQuery(job,o.actualQuery||o.query,options);
 if(resolved.status!=='resolved')return null;
 const coverage=decision.coverage==='direction'&&lineage(resolved.query)?'direction':'query';
 const originalQuery=requestQuery(o.actualQuery||o.query),basis=identity(job,resolved.query);
 const record={version:1,identity:basis,coverage,query:resolved.query,originalQuery,operationId:o.id||o.key,originalObservedAt:o.completedAt,errorCode:o.errorCode,decision:structuredClone(decision),projectResolution:resolved.proof,...(o.receipt?.version===1?{receipt:structuredClone(o.receipt)}:{}),...(o.policy?{policy:o.policy}:{})};
 record.id=hash({identity:basis,coverage,query:coverage==='query'?canonicalQuery(resolved.query):null,decision});
 return record;
}
// These are persisted user directives, not source text or generated summaries.
// An older confirmed set remains frozen when a later contract restates it.
function legacyAcceptance(job,contract){
 const directives=(job.userDirectives||[]).filter(d=>d.id&&['user_feedback','user_decision'].includes(d.origin)&&Date.parse(d.at)&&Date.parse(d.at)<=Date.parse(contract.updatedAt));
 const confirmation=directives.filter(d=>/(?:禁止|不再|不得)重复(?:探测|查询)[^。；\n]{0,12}(?:十三|13)个已(?:确认|接受)权限(?:边界|方向)/.test(d.text||'')).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))[0];
 return {confirmation,directives};
}
function historicalDenial(query,directives,cutoff){
 // Narrow legacy form: one explicit project, one explicit queried direction,
 // enumerated task IDs, an observed denial, and a decision to retain it. It
 // corroborates an actual operation; it never manufactures one from prose.
 return directives.find(d=>{
  if(Date.parse(d.at)>cutoff)return false;
  const prefix=(d.text||'').match(/^(.*?)请把这些列为权限边界[，,]不反复重试/s)?.[1];
  if(!prefix)return false;
  const first=prefix.match(/已独立复现\s*(\d+)\s*的(上游|下游)查询/),projects=[...prefix.matchAll(/项目\s*(\d+)/g)].map(m=>id(m[1]));
  const siblings=prefix.match(/同项目的\s*([\d、,，\s]+)\s*也已查询失败/)?.[1].match(/\d+/g)||[];
  return first&&projects.length===1&&projects[0]===id(query.projectId)&&(first[2]==='上游'?'upstream':'downstream')===query.op&&
   /平台明确返回[^。；\n]*没有项目[^。；\n]*访问权限/.test(prefix)&&
   [first[1],...siblings].includes(String(query.taskId));
 });
}
function planMigration(job,options={}){
 const existing=job.executionState?.acceptedBoundaries||[],records=[...existing],unresolved=[],ops=operations(job),contract=job.executionContract;
 const decisionKey=b=>{const query=canonicalQuery(b.query);if(b.coverage==='direction'){delete query.depth;delete query.page;delete query.pageSize;}return hash({decision:b.decision,coverage:b.coverage,query});};
 // A migrated decision binds the account/grant observed then. The same old
 // selector must not silently accept a new denial after account/regrant changes.
 const append=r=>{if(!records.some(x=>x.id===r.id||decisionKey(x)===decisionKey(r)))records.push(r);};
 const add=(o,d)=>{const r=makeRecord(job,o,d,options);if(r)append(r);else unresolved.push({operationId:o.id||o.key,reason:'failure_scope_unproven'});};
 // Per-operation decisions and UI gap decisions have explicit failure linkage.
 for(const o of ops){
  const d=o.acceptedBoundary;
  if(d&&['user','user_contract'].includes(d.authority)&&d.policy==='document_and_continue'&&(d.decisionId||d.revision))add(o,d);
  for(const g of job.executionState?.gaps||[])if(g.status==='accepted_gap'&&g.acceptedBy==='user'&&g.decisionId&&(g.operationId&&(g.operationId===o.id)||g.operationKey&&g.operationKey===o.key))add(o,{authority:'user',decisionId:g.decisionId,coverage:g.coverage||'query'});
 }
 // Structured contract entries are exact selectors, not a blanket AUTH policy.
 for(const d of contract?.acceptedBoundaries||[]){
  if(!contract.revision)continue;
  const query=d.query;
  if(!query&&!d.operationId){unresolved.push({reason:'acceptance_selector_missing'});continue;}
  for(const o of ops){
   if(d.operationId&&d.operationId!==(o.id||o.key))continue;
   if(query&&hash(canonicalQuery(query))!==hash(canonicalQuery(o.actualQuery||o.query)))continue;
   add(o,{authority:'user_contract',revision:contract.revision,coverage:d.coverage||'query',...(d.decisionId?{decisionId:d.decisionId}:{})});
  }
 }
 // Legacy SG contract: the explicit user choice, its timestamp and actual
 // typed failures identify the frozen set. This recovery's independently
 // confirmed legacy set has thirteen directions, but its contract need not
 // literally contain that count. Current same-direction path proof can exclude
 // unrelated historical probes; a count mismatch is never silently truncated.
 const text=contract?.text||'';
 const legacyDecision=/先保留缺口[，,、 ]*完成可访问部分/.test(text)&&(/用户已选择[“"「]?先保留缺口/.test(text)&&/保留已发现的权限边界/.test(text)||/(?:已接受|已确认|保留历史|沿用)[^\n。；]{0,30}(?:13|十三)\s*个?权限方向/.test(text));
 const frozenLegacy=existing.filter(b=>b.decision?.legacy==='sg-thirteen-directions'&&b.decision.revision===contract?.revision&&b.decision.acceptedAt===contract?.updatedAt).length===13;
 if(contract?.revision&&Date.parse(contract.updatedAt)&&legacyDecision&&!frozenLegacy){
  const cutoff=Date.parse(contract.updatedAt),candidates=new Map(),legacy=legacyAcceptance(job,contract);
  const acceptedAt=legacy.confirmation?.at||contract.updatedAt,acceptedCutoff=Date.parse(acceptedAt);
  const scope=require('./lineage-scope.cjs').resolve(job);
  const sourceRows=(options.sources||[]).filter(s=>s.platformSnapshot&&!s.deleted&&!s.projectExcluded),superseded=new Set(sourceRows.map(s=>s.previousSourceId).filter(Boolean)),currentSources=sourceRows.filter(s=>!superseded.has(s.id));
  const paths=scope.status==='ready'&&sourceRows.length?require('./lineage-frontier.cjs').build(currentSources,scope,currentSources.map(s=>({sourceId:s.id}))):null;
  for(const o of ops){
   if(o.errorCode!=='AUTH_REQUIRED'||!lineage(o.actualQuery||o.query)||Date.parse(o.completedAt)>cutoff)continue;
   const priorDenial=Date.parse(o.completedAt)>acceptedCutoff?historicalDenial(o.actualQuery||o.query,legacy.directives,acceptedCutoff):null;
   if(Date.parse(o.completedAt)>acceptedCutoff&&!priorDenial)continue;
   const r=makeRecord(job,o,{authority:'user_contract',revision:contract.revision,coverage:'direction',acceptedAt:contract.updatedAt,legacy:'sg-thirteen-directions',...(legacy.confirmation?{decisionId:legacy.confirmation.id,setConfirmedAt:acceptedAt}:{} )},options);
   const path=r&&paths?.find(p=>p.scopeProven&&!p.crossRegion&&p.nodeId===r.identity.taskId&&p.direction===r.identity.op&&(!p.projectId||p.projectId===r.identity.projectId));
   if(r&&(!paths||path)){
    if(path)r.scopeProof={revision:scope.revision,rootId:path.rootId,sourceIds:path.proofSourceIds,path:path.path};
    if(priorDenial)r.historicalDenial={directiveId:priorDenial.id,observedBefore:priorDenial.at,origin:priorDenial.origin};
    const key=hash(r.identity),previous=candidates.get(key);
    if(!previous||Date.parse(r.originalObservedAt)<Date.parse(previous.originalObservedAt))candidates.set(key,r);
   }
  }
  if(candidates.size===13)for(const r of candidates.values())append(r);
  else unresolved.push({reason:'legacy_direction_set_unresolved',expected:13,observed:candidates.size,revision:contract.revision});
 }
 return {version:1,records,unresolved,changed:hash(records)!==hash(existing)};
}
function match(job,query,records,{policy}={}){
 return records.find(b=>b.version===1&&b.decision&&(b.decision.decisionId||b.decision.revision)&&hash(b.identity)===hash(identity(job,query))&&(!policy||!b.policy||b.policy===policy)&&(b.coverage==='direction'&&lineage(query)||b.coverage==='query'&&hash(canonicalQuery(b.query))===hash(canonicalQuery(query))))||null;
}
function inspect(job,input,options={}){
 const migration=options.migration||planMigration(job,options),records=options.records||migration.records,resolution=resolveQuery(job,input,{...options,records});
 if(resolution.status!=='resolved')return {...resolution,status:'scope_unresolved',requestedQuery:requestQuery(input)};
 const accepted=match(job,resolution.query,records,options);
 // An explicitly accepted legacy set that cannot be identified is a scope
 // question, never permission to re-probe arbitrary members at another depth.
 if(!accepted&&migration.unresolved.some(r=>r.reason==='legacy_direction_set_unresolved')&&operations(job).some(o=>o.errorCode==='AUTH_REQUIRED'&&Date.parse(o.completedAt)<=Date.parse(job.executionContract?.updatedAt)&&(options.isOperationCurrent||currentOperation)(job,o)&&hash(identity(job,o.actualQuery||o.query))===hash(identity(job,resolution.query))))return {...resolution,status:'scope_unresolved',reason:'acceptance_set_unresolved',requestedQuery:requestQuery(input)};
 return {...resolution,status:accepted?'accepted_boundary':'ready',requestedQuery:requestQuery(input),acceptedBoundary:accepted};
}
module.exports={canonicalQuery,requestQuery,entityType,identity,projectEvidence,resolveQuery,planMigration,match,inspect,currentOperation};
