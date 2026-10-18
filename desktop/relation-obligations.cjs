// Typed coverage and recovery share current source/type/scope checks.
// Reads and acquisitions never close business obligations.
const evidence=require('./evidence-basis.cjs'),links=require('./evidence-links.cjs'),boundaries=require('./platform-boundaries.cjs'),requirements=require('./relation-requirements.cjs');
const cache=require('./projection-cache.cjs');
const rows=x=>Array.isArray(x)?x:[],unique=x=>[...new Set(x)].sort(),nonempty=v=>typeof v==='string'&&!!v.trim();
const id=x=>/^\d+$/.test(String(x))&&Number.isSafeInteger(Number(x))&&Number(x)>0?String(Number(x)):null;
const TYPES={
 sql_read_write:{label:'SQL读写关系',pattern:/SQL\s*读写|SQL.*输入输出/i,need:/SQL|读写关系/i,ops:['sql','code','task'],boundaryOps:['sql','code']},
 configured_outputs:{label:'任务产出配置',pattern:/产出配置|输出配置/,need:/产出配置|输出配置/,ops:['outputs','task'],boundaryOps:['outputs']},
 physical_lineage:{label:'物理表生产和消费关系',pattern:/物理表血缘|Coral.*血缘/i,need:/物理表|Coral|生产.*消费/i,ops:['table_lineage','table_tasks'],boundaryOps:['table_lineage','table_tasks']},
 dataset_mapping:{label:'最终风神/Aeolus数据集映射',pattern:/风神|Aeolus/i,need:/风神|Aeolus|数据集映射/i,ops:['dataset','dataset_mapping'],boundaryOps:['dataset','dataset_mapping']}
};
function required(a,job,task,options={}){
 return cache.memo(required,[a,a.data,job,task,evidence.lineageOnly(task,job),evidence.hash(options)],()=>computeRequired(a,job,task,options));
}
function computeRequired(a,job,task,options){
 if(job.dataPlatform!=='sg-readonly')return [];
 const scope=require('./lineage-scope.cjs').resolve(job);
 const sources=scopeSources(snapshotsFor(a,job,sourceRows(a,job,task,task.sourceIds)));
 // Most typed demands already carry a current contract confirmation. Compute
 // expensive check bases only if inspect actually needs a legacy basis match.
 let checkBases;
 const currentCheckBases={includes(value){checkBases ||= [require('./execution-control.cjs').contentBasis(a,job,task),require('./acceptance.cjs').basis(a,task)];return checkBases.includes(value);}};
 return requirements.inspect(job,task,scope,{...options,currentCheckBases}).map(d=>{
  const targets=d.kind==='physical_lineage'||scope.status!=='ready'?{entities:[],unresolvedRootIds:[]}:cache.memo(requirements.targets,[sources,evidence.hash(scope),evidence.hash(d.kind==='dataset_mapping'?d:{priorEntities:d.priorEntities})],()=>requirements.targets(d,scope,sources));
  const entities=targets.entities.map(e=>({...e,id:'relation-entity:'+evidence.hash({taskId:task.id,kind:d.kind,rootId:e.rootId,direction:e.direction,nodeId:e.nodeId,region:e.region,projectId:e.projectId})}));
  const {priorEntities,...descriptor}=d;
  const legacyId='relation:'+evidence.hash({taskId:task.id,kind:d.kind,roots:scope.rootIds,revision:scope.revision});
  // Physical aggregate decisions historically bind the scope revision. Keep
  // that public ID so a stable internal type cannot broaden an old exemption.
  return {...descriptor,id:d.kind==='physical_lineage'?legacyId:d.id,typeId:d.id,...(scope.status!=='ready'?{confirmationState:'scope_unresolved',scopeReason:scope.reason}:{}),entities,unresolvedRootIds:targets.unresolvedRootIds,unprovenTargetTaskIds:targets.unprovenTargetTaskIds||[],legacyIds:[legacyId],label:TYPES[d.kind].label,requirementRevision:scope.revision,status:'unqueried',required:true};
 });
}
function sameObligation(o,id){return o.id===id||rows(o.legacyIds).includes(id);}
function sourceRows(a,job,task,ids){
 return cache.memo(sourceRows,[a,a.data,job,task,JSON.stringify(unique(rows(ids)))],()=>computeSourceRows(a,job,task,ids));
}
function computeSourceRows(a,job,task,ids){
 if(task.deletedAt||task.agentCancelled||job.deletedAt||task.agentJobId!==job.id||!rows(job.taskIds).includes(task.id)||(task.projectId||null)!==(job.projectId||null))return [];
 // Recheck prospective plan bindings against the existing ACL, never grant one.
 const view={...a,data:{...a.data,tasks:rows(a.data.tasks).map(t=>t.id===task.id?task:t)}};
 if(a.requireContextAccessPolicy)require('./protocol-access.cjs').initialize(view);
 const bindings=links.bindings(a,task);
 const sources=cache.memo(computeSourceRows,[a.data.sources],()=>{
  const map=new Map();for(const s of rows(a.data.sources)){if(!map.has(s.id))map.set(s.id,[]);map.get(s.id).push(s);}return map;
 });
 return unique(rows(ids)).flatMap(key=>{
  const matches=sources.get(key)||[];if(matches.length!==1)return [];
  const s=matches[0],b=bindings.find(b=>b.sourceId===key&&b.purpose==='input'&&b.state==='active');
  if(!rows(task.sourceIds).includes(key)||!rows(job.sourceIds).includes(key)||rows(task.supersededSourceIds).includes(key)||links.withdrawn(s)||!b||
   b.contentHash!==links.contentHash(s)||b.revisionId!==links.revision(s)||evidence.hash(b.principalScope)!==evidence.hash(links.principal(s))||
   (s.projectId||null)!==(job.projectId||null)||(s.agentJobId||s.jobId)&&(s.agentJobId||s.jobId)!==job.id||s.taskId&&s.taskId!==task.id||
   s.platformSnapshot&&evidence.hash(s.platformPrincipal||null)!==evidence.hash(job.platformPrincipal||null)||
   links.currentSourceId(a.data,s)!==s.id||!require('./protocol-access.cjs').allowedObject(view,'source',s,job,task))return [];
  return [s];
 });
}
function platformRaw(s){
 return cache.memo(platformRaw,[s,s.content,s.platformArchive],()=>{
  let raw;try{raw=JSON.parse(s.content);}catch{if(s.platformArchive!==undefined)throw Object.assign(Error('归档来源正文无法解析'),{code:'LOCAL_RESULT_INTEGRITY'});return null;}
  // Restoration is conditional on archive metadata, never on a tiny/empty
  // data directory. Integrity errors must escape, not become missing centers.
  if(raw.platformResult!==undefined||s.platformArchive!==undefined||raw.platformArchive!==undefined)
   raw={...raw,data:require('./data-platform.cjs').restorePlatformData(raw,s)};
  return raw;
 });
}
function snapshotsFor(a,job,refs){return cache.memo(snapshotsFor,[a,a.data,job,refs],()=>refs.map(s=>snapshot(a,job,s)).filter(Boolean));}
// Scheduling scope readers need Dorado nodes/consumer configurations, not
// Coral adjacency. Keep every envelope/project conflict field they inspect;
// the physical projector below always consumes the complete restored data.
// Archived scheduling/configuration sources are expanded here as well, so a
// manifest directory can never masquerade as their complete graph.
function scopeSources(snaps){
 return cache.memo(scopeSources,[snaps],()=>snaps.map(({source,raw,op,d})=>{
  if(!source.platformSnapshot)return source;
  if(op!=='table_lineage'&&raw.platformResult===undefined)return source;
  const {platformResult,platformArchive,...envelope}=raw;
  const data=op==='table_lineage'?Object.fromEntries(['region','taskId','root','id','projectId'].filter(k=>d&&Object.hasOwn(d,k)).map(k=>[k,d[k]])):d;
  const {platformArchive:archive,...metadata}=source;
  return {...metadata,content:JSON.stringify({...envelope,data})};
 }));
}
function snapshot(a,job,s){return cache.memo(snapshot,[a,a.data,job,s],()=>computeSnapshot(a,job,s));}
function computeSnapshot(a,job,s){
 let raw=platformRaw(s);if(!raw)return null;
 if(!s.platformSnapshot){
  const cap=rows(a.data.capabilities).find(c=>c.id===s.capabilityId&&c.enabled&&!c.removedAt);
  const run=rows(a.data.capabilityRuns).find(r=>r.id===s.lastObservationId&&r.jobId===job.id&&r.capabilityId===cap?.id&&r.status==='done'&&r.resultHash===evidence.hash(raw));
  if(!cap||!run||!rows(job.capabilityGrants).some(g=>g.id===cap.id&&g.revision===cap.revision)||!rows(cap.allowedTools).includes(run.tool))return null;
  raw=raw.structuredContent||raw;
 }
 const q=raw.query||{},d=raw.data,op=raw.operation;
 if(!op||q.op!==op||d===undefined||raw.error||raw.status==='failed')return null;
 if(['table_lineage','table_tasks'].includes(op)&&(!table(q)||s.platformSnapshot&&boundaries.entityType(q.entityType||'HiveTable')!=='HiveTable'))return null;
 if(op==='table_lineage'&&d?.baseEntityGuid){
  const base=d.guidEntityMap?.[d.baseEntityGuid],attr=base?.attributes||{};
  if(!base||base.typeName&&boundaries.entityType(base.typeName)!==boundaries.entityType(q.entityType||'HiveTable')||attr.name&&attr.name!==q.table||[attr.dbName,attr.parentName].some(db=>db&&db!==q.database))return null;
 }
 const regions=unique([raw.region,q.region,d?.region].filter(Boolean).map(r=>String(r).toLowerCase()));
 if(regions.length>1||regions[0]&&regions[0]!=='sg')return null;
 const taskId=id(q.taskId);
 if(q.taskId!=null&&!taskId||d?.taskId!=null&&id(d.taskId)!==taskId||d?.root?.id!=null&&id(d.root.id)!==taskId||op==='task'&&d?.id!=null&&id(d.id)!==taskId)return null;
 if(q.projectId!=null&&d?.projectId!=null&&id(q.projectId)!==id(d.projectId))return null;
 return {source:s,raw,op,q,d,region:regions[0]||'sg'};
}
function limited({source:s,raw,q,d,op}){
 // Only proof in the persisted platform payload can establish closure. A
 // checker saying "complete" (or a finite depth by itself) proves neither.
 const closures=[d?.closure?.input,d?.closure?.output];
 for(const v of [s,raw,d,d?.pagination,...closures].filter(v=>v&&typeof v==='object')){
  if(['partial','truncated','incomplete'].includes(v.coverage)||v.complete===false||v.truncated===true||v.hasMore===true||v.has_more===true||v.noMore===false||v.next!=null||v.nextPage!=null||v.next_page!=null||v.nextCursor)return true;
 }
 if([q.page,d?.page].some(page=>Number(page)>1))return true;
 const list=Array.isArray(d)?d:rows(d?.rows||d?.nodes||d?.tasks||d?.mappings||d?.outputs);
 if(d?.total!=null&&Number(d.total)>list.length)return true;
 if(op==='table_lineage'&&d?.guidEntityMap){
  // Coral counts describe the returned levels, not global completeness; they
  // can disprove a complete claim but cannot establish one on their own.
  for(const direction of ['input','output']){
   const guids=d[direction+'EntityGuids'],count=d[direction+'EntityCount'];
   if(Array.isArray(guids)){
    const ids=unique(guids.flat(Infinity));
    if(ids.some(g=>typeof g!=='string'||!d.guidEntityMap[g])||count!=null&&Number(count)!==ids.length)return true;
   }
  }
 }
 return false; // Physical closure is exclusively computed by physicalContext.
}
function content({op,d},kind){
 if(!TYPES[kind].ops.includes(op))return null;
 if(kind==='sql_read_write'){
  const operator=d?.conf?.configuration?.operator;
  const doradoSql=[d?.type,operator?.type].some(v=>/^(hsql|sql|hive_sql|spark_sql|hivesql|sparksql)$/i.test(v||''))?operator?.parameter?.code:null;
  const sql=typeof d==='string'&&op!=='task'?d:[d?.sql,d?.code,d?.task?.sql,d?.task?.code,d?.config?.sql,doradoSql].find(nonempty);
  return nonempty(sql)?{sql}:null;
 }
 if(kind==='configured_outputs'){
  const outputs=Array.isArray(d)&&op==='outputs'?d:d?.outputs??d?.outputTables??d?.config?.outputs??d?.conf?.configuration?.operator?.parameter?.targets;
  return Array.isArray(outputs)?{outputs}:null;
 }
 if(kind==='physical_lineage'){
  const graph=d?.guidEntityMap||d?.relations||d?.edges||d?.nodes||d?.tasks||(Array.isArray(d)?d:null);
  return graph&&typeof graph==='object'?{[op==='table_tasks'?'tasks':'lineage']:graph}:null;
 }
 const mappings=d?.mappings||d?.datasets;return Array.isArray(mappings)?{mappings}:null;
}
function table(value,fallback={}){
 if(typeof value==='string'){const m=value.match(/^([\w]+)\.([\w]+)$/);return m?{database:m[1],table:m[2],entityType:boundaries.entityType(fallback.entityType||'HiveTable')}:null;}
 if(!value||typeof value!=='object')return null;
 const database=value.database||value.databaseName||value.dbName||value.db,name=value.table||value.tableName;
 // Dorado output targets identify Hive tables as type=partition. Do not
 // reinterpret explicitly different stores or cross-region output targets.
 if(value.storageRegion&&String(value.storageRegion).toLowerCase()!==String(fallback.region||'sg').toLowerCase())return null;
 const type=value.entityType||value.typeName||(value.type==='partition'?'HiveTable':value.type)||fallback.entityType||'HiveTable';
 return nonempty(database)&&nonempty(name)?{database,table:name,entityType:boundaries.entityType(type)}:null;
}
function queryRoots(q,snaps,scope){
 if(q.region&&String(q.region).toLowerCase()!==scope.region)return [];
 // Table APIs are addressed by table identity, not an extra taskId supplied
 // alongside the query. Only an explicit current output mapping can link them.
 if(['table_lineage','table_tasks'].includes(q.op))q={...q,taskId:undefined};
 const taskId=id(q.taskId),result=[];
 const projects=boundaries.projectEvidence(scopeSources(snaps)).filter(p=>p.taskId===taskId&&p.region===scope.region);
 if(unique(projects.map(p=>p.projectId)).length>1||q.projectId!=null&&projects.some(p=>p.projectId!==id(q.projectId)))return [];
 for(const root of scope.rootIds){
  if(taskId){
   if(taskId===root){result.push({rootId:root,proofSourceIds:[]});continue;}
   // Build once per root: a node reachable from two roots must prove both.
   const paths=cache.memo(queryRoots,[snaps,evidence.hash({...scope,rootIds:[root]})],()=>require('./lineage-frontier.cjs').build(scopeSources(snaps),{...scope,rootIds:[root]},snaps.map(s=>({sourceId:s.source.id}))));
   const path=paths.find(p=>p.nodeId===taskId&&p.scopeProven&&!p.crossRegion&&p.region===scope.region&&(!q.projectId||!p.projectId||p.projectId===id(q.projectId)));
   if(path)result.push({rootId:root,proofSourceIds:path.proofSourceIds});
  }else{
   const target=table(q);if(!target)continue;
   for(const s of snaps){
    const outputs=content(s,'configured_outputs');if(!outputs||limited(s)||!id(s.q.taskId))continue;
    if(!outputs.outputs.some(x=>evidence.hash(table(x,s.q))===evidence.hash(target)))continue;
    const path=queryRoots(s.q,snaps,{...scope,rootIds:[root]})[0];
    if(path){result.push({rootId:root,proofSourceIds:unique([s.source.id,...path.proofSourceIds])});break;}
   }
  }
 }
 return result;
}
const metadata=new Set(['sourceId','sourceIds','queriedAt','checkedAt','observedAt','lastCheckedAt','createdAt','updatedAt','createTime','updateTime','sourceCreateTime','sourceUpdateTime','lastModifiedTime','method','planVersion','requestId','operationId']);
const physicalObservations=new Set(['latestPartitionName','latestPartitionCreateTime','tableSize','physicalSize','savePhysicalSize','assetRank','produceTime','produceTimeLast7Days','viewCount']);
function semantic(v,kind){
 if(Array.isArray(v))return [...new Map(v.map(x=>semantic(x,kind)).map(x=>[evidence.hash(x),x])).values()].sort((a,b)=>evidence.hash(a).localeCompare(evidence.hash(b)));
 return v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!metadata.has(k)&&!(kind==='physical_lineage'&&(physicalObservations.has(k)||/^(queryCount|queryUserNumber|adhocQueryCount|totalQueryCount)\d*(Days)?$/.test(k)))).map(([k,x])=>[k,semantic(x,kind)])):v;
}
function obligationKey(o){return evidence.hash({...o,rootIds:unique(rows(o.rootIds))});}
function facts(a,job,task,o,ids=task.sourceIds){
 return cache.memo(facts,[a,a.data,job,task,evidence.lineageOnly(task,job),obligationKey(o),JSON.stringify(unique(rows(ids)))],()=>computeFacts(a,job,task,o,ids));
}
function computeFacts(a,job,task,o,ids){
 if(o.kind==='physical_lineage')return physicalFacts(a,job,task,o,ids);
 const refs=sourceRows(a,job,task,ids),snaps=snapshotsFor(a,job,refs),scope={rootIds:o.rootIds,region:o.region,revision:o.requirementRevision},result=[];
 for(const s of snaps){
  const payload=content(s,o.kind);if(!payload)continue;
  const projects=unique(boundaries.projectEvidence(scopeSources(snaps)).filter(p=>p.taskId===id(s.q.taskId)&&p.region===s.region).map(p=>p.projectId));
  const entity=table(s.q)||{taskId:id(s.q.taskId),projectId:id(s.q.projectId??s.d?.projectId)??(projects.length===1?projects[0]:null)};
  if(!entity.taskId&&!entity.table)continue;
  if(entity.table){const declared=table(s.d,s.q);if(declared&&evidence.hash(declared)!==evidence.hash(entity)||entity.entityType==='DummyTable')continue;}
  for(const root of queryRoots(s.q,snaps,scope)){
   const fact={taskId:task.id,kind:o.kind,rootId:root.rootId,scope:{region:s.region,projectId:job.projectId||null,entity,principal:links.principal(s.source)},contentHash:evidence.hash(semantic(payload,o.kind))};
   result.push({fact,sourceId:s.source.id,proofSourceIds:root.proofSourceIds,complete:!limited(s)});
  }
 }
 return result;
}
const referenceBasis=(sources,task,job)=>evidence.hash(evidence.versions(sources,task,job));
function boundaryDecisions(job,o){return rows(job.executionState?.gaps).filter(g=>sameObligation(o,g.obligationId)&&(!g.taskId||g.taskId===o.taskId)&&g.status==='accepted_gap'&&g.acceptedBy==='user'&&g.decisionId);}
function accepted(job,o){return o.confirmationState==='confirmed'&&boundaryDecisions(job,o).find(g=>
 o.kind==='physical_lineage'||g.contractBasis===o.contractBasis&&!o.unresolvedRootIds.length&&!o.unprovenTargetTaskIds.length&&o.entities.length&&o.entities.every(e=>e.scopeProven)&&evidence.hash(unique(rows(g.entityIds)))===evidence.hash(unique(o.entities.map(e=>e.id))));}
function outputMappings(snaps,o){return cache.memo(outputMappings,[snaps,obligationKey(o)],()=>computeOutputMappings(snaps,o));}
function computeOutputMappings(snaps,o){
 const result=[];
 for(const rootId of o.rootIds){
  // Every required root needs its own output mapping; another reachable task's
  // output does not stand in for a missing root output configuration.
  const maps=snaps.filter(s=>id(s.q.taskId)===rootId&&content(s,'configured_outputs')&&queryRoots(s.q,snaps,{rootIds:[rootId],region:o.region}).length);
  const proofSourceIds=unique(maps.map(s=>s.source.id));
  if(!maps.length){result.push({rootId,reason:'root_output_mapping_missing',proofSourceIds});continue;}
  const parsed=maps.map(s=>({s,outputs:content(s,'configured_outputs').outputs.map(v=>table(v,s.q))}));
  if(parsed.some(p=>limited(p.s)||p.outputs.some(v=>!v))){result.push({rootId,reason:'root_output_mapping_incomplete',proofSourceIds});continue;}
  const sets=parsed.map(p=>semantic(p.outputs,'configured_outputs'));
  if(unique(sets.map(evidence.hash)).length!==1){result.push({rootId,reason:'root_output_mapping_conflict',proofSourceIds});continue;}
  result.push({rootId,valid:true,outputs:sets[0],maps,proofSourceIds,...(!sets[0].length?{reason:'root_output_mapping_incomplete'}:{})});
 }
 return result;
}
function physicalContext(a,job,task,{sourceIds=task.sourceIds,obligation}={}){
 const o=obligation||required(a,job,task).find(o=>o.kind==='physical_lineage');
 return cache.memo(physicalContext,[a,a.data,job,task,evidence.lineageOnly(task,job),JSON.stringify(unique(rows(sourceIds))),o?obligationKey(o):null],()=>computePhysicalContext(a,job,task,{sourceIds,obligation:o&&{...o,rootIds:unique(rows(o.rootIds))}}));
}
function computePhysicalContext(a,job,task,{sourceIds,obligation}){
 const projector=require('./physical-lineage-coverage.cjs'),o=obligation;
 if(!o)return {...projector.project(),required:false,obligationId:null,rootIds:[]};
 if(o.confirmationState!=='confirmed')return {...projector.project(),required:true,obligationId:o.id,rootIds:o.rootIds,satisfied:false,closureProven:false,status:'unresolved',scopeReason:o.scopeReason||o.confirmationState};
 const refs=sourceRows(a,job,task,sourceIds),snaps=snapshotsFor(a,job,refs);
 const roots=outputMappings(snaps,o).flatMap(m=>m.reason?[{rootId:m.rootId,reason:m.reason,proofSourceIds:m.proofSourceIds}]:m.outputs.map(entity=>({rootId:m.rootId,entity:{...entity,region:o.region,cid:6},proofSourceIds:m.proofSourceIds})));
 const snapshots=[];
 for(const s of refs){
  // Preserve invalid native centers as diagnostics instead of mistaking them
  // for absent centers and scheduling the same query again.
  const raw=s.platformSnapshot?platformRaw(s):snapshot(a,job,s)?.raw;
  if(raw?.query?.op==='table_lineage')snapshots.push({...raw,sourceId:s.id,principal:links.principal(s),sourceFlags:s});
 }
 const options={sources:refs,isOperationCurrent:(j,op)=>boundaries.currentOperation(j,op)&&require('./operation-ledger.cjs').valid({...j,executionState:j.executionState||{permissionRevision:0}},op,a)};
 const migration=boundaries.planMigration(job,options),acceptedBoundaries=[];
 for(const b of migration.records){
  if(!projector.queryEntity(b.query))continue;
  const inspected=boundaries.inspect(job,b.query,{...options,records:migration.records,migration});
  if(inspected.status==='accepted_boundary')acceptedBoundaries.push(structuredClone(inspected.acceptedBoundary));
 }
 const failures=[...rows(job.executionState?.history),...Object.values(job.executionState?.operations||{})].filter(op=>op.status==='failed'&&op.id&&op.errorCode&&Date.parse(op.completedAt)&&projector.queryEntity(op.actualQuery||op.query)&&options.isOperationCurrent(job,op)).map(op=>({operationId:op.id,query:op.actualQuery||op.query,errorCode:op.errorCode,reason:op.error||op.reason||op.errorCode,completedAt:op.completedAt}));
 const projection=projector.project({roots,snapshots,acceptedBoundaries,failures});
 // The explicit root contract is authority to request its output configuration;
 // no old source is promoted into typed identity to bootstrap this request.
 const inScope=!task.deletedAt&&!task.agentCancelled&&!job.deletedAt&&task.agentJobId===job.id&&rows(job.taskIds).includes(task.id)&&(task.projectId||null)===(job.projectId||null);
 const projects=boundaries.projectEvidence(scopeSources(snaps));
 for(const gap of projection.frontier){
  if(!inScope||gap.reason!=='root_output_mapping_missing'||!o.rootIds.includes(gap.rootId)||!id(gap.rootId))continue;
  const proof=projects.filter(p=>p.taskId===gap.rootId&&p.region===o.region),projectIds=unique(proof.map(p=>p.projectId));
  if(projectIds.length>1){gap.queryBlockedReason='root_project_conflict';continue;}
  const query={op:'outputs',taskId:gap.rootId,...(projectIds.length?{projectId:projectIds[0]}:{})};
  gap.proofSourceIds=unique([...gap.proofSourceIds,...proof.map(p=>p.sourceId)]);
  const boundary=boundaries.inspect(job,query,{...options,records:migration.records,migration});
  if(boundary.status==='accepted_boundary'){gap.queryBlockedReason='accepted_outputs_boundary';gap.boundary=boundary.acceptedBoundary;continue;}
  if(boundary.status!=='ready'){gap.queryBlockedReason=boundary.reason||boundary.status;continue;}
  const failed=[...rows(job.executionState?.history),...Object.values(job.executionState?.operations||{})].find(op=>op.status==='failed'&&op.id&&op.errorCode&&Date.parse(op.completedAt)&&options.isOperationCurrent(job,op)&&evidence.hash(boundaries.canonicalQuery(op.actualQuery||op.query))===evidence.hash(boundaries.canonicalQuery(query)));
  if(failed){gap.queryBlockedReason='observed_outputs_failure';gap.attempt={operationId:failed.id,errorCode:failed.errorCode,reason:failed.error||failed.reason||failed.errorCode,completedAt:failed.completedAt};continue;}
  gap.query=query;
 }
 const whole=accepted(job,o);
 if(whole&&!projection.closureProven){
  for(const gap of projection.frontier){gap.status='accepted_boundary';gap.boundary={obligationId:o.id,decisionId:whole.decisionId,authority:'user'};delete gap.query;}
  for(const root of projection.roots)for(const direction of Object.values(root.directions))direction.satisfied=true;
  projection.satisfied=true;projection.status='accepted_boundary';
 }
 // A candidate is not a new authorization. Remote scope is checked again by
 // the App immediately before dispatch; here a revoked/unknown grant yields a
 // context gap only. Old sources with unknown remote principals never qualify.
 for(const gap of projection.frontier){
  if(!gap.query||!a.dir)continue;
  const allowed=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[gap.query]},{taskId:task.id});
  if(!allowed.allowed){gap.queryBlockedReason=allowed.code||'current_platform_scope_not_authorized';delete gap.query;}
 }
 projection.queries=[...new Map(projection.frontier.filter(g=>g.query).map(g=>[evidence.hash(g.query),g.query])).values()];
 return {...projection,required:true,obligationId:o.id,rootIds:o.rootIds};
}
// Typed exact root-output and missing-center requests. No scheduling, read,
// grant, or mutation. Root outputs use direction:null and identity:null.
// Direction is proof metadata, NOT a Coral query parameter (the API uses BOTH).
function evidenceNeeds(a,job,task){
 if(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||task.projectionPending)return [];
 const p=physicalContext(a,job,task),needs=[];
 for(const gap of p.frontier)if(gap.query&&(gap.status==='unexpanded'||gap.reason==='root_output_mapping_missing')){
  const identity=gap.identity,direction=gap.query.op==='outputs'?null:gap.direction,key=evidence.hash({direction,identity,query:gap.query});
  const existing=needs.find(n=>n.key===key);
  if(existing){existing.rootIds=unique([...existing.rootIds,gap.rootId]);existing.proofSourceIds=unique([...existing.proofSourceIds,...gap.proofSourceIds]);}
  else needs.push({key,obligationId:p.obligationId,kind:'physical_lineage',rootIds:[gap.rootId],direction,query:gap.query,identity,reason:gap.reason,proofSourceIds:gap.proofSourceIds});
 }
 return needs.map(({key,...need})=>need);
}
function physicalFacts(a,job,task,o,ids){
 const projection=physicalContext(a,job,task,{sourceIds:ids,obligation:o});
 const refs=sourceRows(a,job,task,ids),snaps=snapshotsFor(a,job,refs);
 const mappings=outputMappings(snaps,o).filter(m=>m.valid).flatMap(m=>m.maps.map(s=>({fact:{taskId:task.id,kind:o.kind,factType:'root_output_mapping',rootId:m.rootId,scope:{region:o.region,projectId:job.projectId||null,entity:{entityType:'DoradoTask',taskId:m.rootId},principal:links.principal(s.source)},contentHash:evidence.hash(m.outputs)},sourceId:s.source.id,proofSourceIds:m.proofSourceIds,complete:false})));
 return [...mappings,...projection.observations.map(p=>({fact:{taskId:task.id,kind:o.kind,rootId:p.rootId,direction:p.direction,scope:{region:o.region,projectId:job.projectId||null,entity:p.identity,principal:p.principal},contentHash:evidence.hash(p.adjacency)},sourceId:p.sourceId,proofSourceIds:p.proofSourceIds,complete:projection.closureProven}))];
}
function boundaryRoots(a,job,task,o,refs){
 const snaps=snapshotsFor(a,job,refs),scope={rootIds:o.rootIds,region:o.region,revision:o.requirementRevision};
 const options={sources:refs,isOperationCurrent:(j,op)=>boundaries.currentOperation(j,op)&&require('./operation-ledger.cjs').valid({...j,executionState:j.executionState||{permissionRevision:0}},op,a)};
 const records=boundaries.planMigration(job,options).records,result=[];
 for(const b of records){
  if(!TYPES[o.kind].boundaryOps.includes(b.query?.op))continue;
  const current=boundaries.inspect(job,b.query,{...options,records});if(current.status!=='accepted_boundary')continue;
  for(const root of queryRoots(b.query,snaps,scope))result.push({rootId:root.rootId,nodeId:id(current.query.taskId),projectId:id(current.query.projectId),boundaryId:current.acceptedBoundary.id,query:current.query,proofSourceIds:root.proofSourceIds});
 }
 return result;
}
function coverageProof(a,job,task,o,c){
 if(o.confirmationState!=='confirmed'||o.unresolvedRootIds.length||o.unprovenTargetTaskIds.length)return null;
 const claimed=rows(c?.sourceIds),refs=sourceRows(a,job,task,claimed);
 if(refs.length!==new Set(claimed).size||!o.rootIds.every(r=>rows(c?.rootIds).map(String).includes(r)))return null;
 if(o.kind==='physical_lineage'){
  // A model cannot hide a conflicting current center/mapping by citing only
  // its preferred subset. Recompute against all lawful bound evidence, then
  // require the claimed receipt to actually carry the resulting proof.
  const physicalCoverage=physicalContext(a,job,task,{obligation:o});
  if(!physicalCoverage.satisfied||physicalCoverage.proofSourceIds.some(id=>!claimed.includes(id)))return null;
  return {facts:physicalFacts(a,job,task,o,task.sourceIds),boundaries:physicalCoverage.frontier.filter(g=>g.status==='accepted_boundary'),limitedSourceIds:[],physicalCoverage};
 }
 const matched=facts(a,job,task,o,claimed),boundaries=boundaryRoots(a,job,task,o,refs);
 const entityCoverage=o.entities.map(entity=>{
  const scoped=entity.scopeProven&&entity.proofSourceIds.every(id=>claimed.includes(id));
  const fact=scoped&&matched.find(f=>f.complete&&f.fact.rootId===entity.rootId&&f.fact.scope.entity.taskId===entity.nodeId&&(!entity.projectId||f.fact.scope.entity.projectId===entity.projectId));
  const boundary=scoped&&boundaries.find(b=>b.rootId===entity.rootId&&b.nodeId===entity.nodeId&&(!entity.projectId||b.projectId===entity.projectId));
  return {entityId:entity.id,rootId:entity.rootId,nodeId:entity.nodeId,direction:entity.direction,status:fact?'analyzed':boundary?'accepted_boundary':'unqueried',...(fact?{sourceId:fact.sourceId}:boundary?{boundaryId:boundary.boundaryId}:{})};
 });
 if(!entityCoverage.length||entityCoverage.some(e=>e.status==='unqueried'))return null;
 return {facts:matched.filter(f=>f.complete),boundaries,entityCoverage,limitedSourceIds:refs.filter(s=>{const snap=snapshot(a,job,s);return snap&&limited(snap);}).map(s=>s.id)};
}
// Typed evidence admission for a content check, not a semantic check result.
// Deliberately avoid validateCoverage/requirements.prepare and receipt writes.
function coverageReady(a,job,task){
 if(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||task.projectionPending||requirements.contractIssue(job))return false;
 const obligations=required(a,job,task);
 if(!obligations.length||obligations.some(o=>o.confirmationState!=='confirmed'))return false;
 const sourceIds=sourceRows(a,job,task,task.sourceIds).map(s=>s.id);
 return obligations.every(o=>!!accepted(job,o)||!!coverageProof(a,job,task,o,{status:'analyzed',coverage:'complete',rootIds:o.rootIds,sourceIds,summary:'用于检查准入'}));
}
function validReceipt(a,job,task,o,r){
 if(!r?.validated||r.proofVersion!==2||r.taskId!==task.id)return null;
 const refs=sourceRows(a,job,task,r.sourceIds);
 if(refs.length!==r.sourceIds.length||r.evidenceBasis!==referenceBasis(refs,task,job))return null;
 const proof=coverageProof(a,job,task,o,{sourceIds:r.sourceIds,rootIds:r.rootIds});
 return proof&&evidence.hash(unique(proof.facts.map(p=>evidence.hash(p.fact))))===evidence.hash(r.factKeys)?proof:null;
}
function observedFailures(a,job,task,o,ids){
 const refs=sourceRows(a,job,task,task.sourceIds),snaps=snapshotsFor(a,job,refs);
 return unique(rows(ids)).flatMap(id=>{
  const op=Object.values(job.executionState?.operations||{}).find(op=>op.id===id&&op.status==='failed');
  return op&&boundaries.currentOperation(job,op)&&TYPES[o.kind].ops.includes(op.query?.op)&&queryRoots(op.actualQuery||op.query,snaps,{rootIds:o.rootIds,region:o.region,revision:o.requirementRevision}).length?[op]:[];
 });
}
function context(a,job,task){
 const saved=rows(job.executionState?.relations?.receipts);
 return required(a,job,task).map(required=>{
  // Preserve the original binding even when a legacy aggregate acceptance has
  // no exact entity scope. Such a decision changes the context version, but
  // cannot silently exempt new entities or a different relation type.
  const boundary=accepted(job,required),o={...required,boundaryDecisions:boundaryDecisions(job,required).map(g=>({obligationId:g.obligationId,taskId:g.taskId||required.taskId,decisionId:g.decisionId,contractBasis:g.contractBasis||null,entityIds:rows(g.entityIds),status:g===boundary?'accepted_boundary':'requires_entity_confirmation'}))};
  const physical=o.kind==='physical_lineage'?{physicalCoverage:physicalContext(a,job,task,{obligation:o})}:{};
  if(boundary)return {...o,...physical,status:'accepted_boundary',decisionId:boundary.decisionId};
  const r=saved.findLast(r=>sameObligation(o,r.obligationId)),proof=validReceipt(a,job,task,o,r);
  const observed=r?.observed&&rows(r.operationIds).length>0&&observedFailures(a,job,task,o,r.operationIds).length===r.operationIds.length;
  return {...o,...physical,status:proof||observed?r.status:r?'acquired':'unqueried',...(proof?{lastReceipt:{checkBasis:r.checkBasis,sourceIds:r.sourceIds,summary:r.summary,boundaries:proof.boundaries,limitedSourceIds:proof.limitedSourceIds,...(proof.entityCoverage?{entityCoverage:proof.entityCoverage}:{})}}:{})};
 });
}
function validateCoverage(a,job,task,result,checkBasis){
 const obligations=required(a,job,task,{check:{...result,basis:checkBasis}});
 result={...result,relationRequirementBasis:requirements.contractBasis(job)};
 const coverage=rows(result.relationCoverage),receipts=[],missing=[];
 if(requirements.contractIssue(job))missing.push({text:'结构化关系要求格式未确认，不能按空义务集合通过',kind:'evidence',requirementId:'task:'+task.id,relationDemandOrigin:'program_projection'});
 for(const o of obligations){
  const boundary=accepted(job,o);if(boundary){receipts.push({obligationId:o.id,taskId:task.id,kind:o.kind,status:'accepted_boundary',validated:true,checkBasis,sourceIds:[],decisionId:boundary.decisionId,evidenceBasis:evidence.hash({decisionId:boundary.decisionId,obligationId:o.id}),summary:'用户已明确接受此具体关系缺口'});continue;}
  const c=coverage.find(r=>sameObligation(o,r.obligationId)),refs=sourceRows(a,job,task,c?.sourceIds),proof=c?.status==='analyzed'&&c.coverage==='complete'&&nonempty(c.summary)&&coverageProof(a,job,task,o,c);
  if(proof)receipts.push({obligationId:o.id,taskId:task.id,kind:o.kind,status:proof.physicalCoverage&&!proof.physicalCoverage.closureProven||!proof.facts.length?'accepted_boundary':'analyzed',validated:true,proofVersion:2,factKeys:unique(proof.facts.map(p=>evidence.hash(p.fact))),rootIds:o.rootIds,checkBasis,sourceIds:refs.map(s=>s.id),evidenceBasis:referenceBasis(refs,task,job),summary:c.summary.slice(0,1500),boundaries:proof.boundaries,limitedSourceIds:proof.limitedSourceIds,...(proof.entityCoverage?{entityCoverage:proof.entityCoverage}:{}),...(proof.physicalCoverage?{closureProven:proof.physicalCoverage.closureProven,directObserved:proof.physicalCoverage.directObserved}: {})});
  else {
   const failed=observedFailures(a,job,task,o,c?.operationIds);
   if(failed.length&&failed.length===new Set(c.operationIds).size&&['failed','unsupported'].includes(c.status))receipts.push({obligationId:o.id,taskId:task.id,kind:o.kind,status:failed.every(op=>['UNSUPPORTED_ENTITY','UNSUPPORTED_CAPABILITY'].includes(op.errorCode))?'unsupported':'failed',validated:false,observed:true,checkBasis,sourceIds:[],operationIds:failed.map(op=>op.id),summary:nonempty(c.summary)?c.summary.slice(0,1500):'实际查询尚未取得所需证据'});
   missing.push({text:o.label+'尚无当前逐实体核对回执：'+(o.confirmationState!=='confirmed'?'合同依据变化或范围未决，须确认原typed要求；':'')+'须逐项核对入口及同方向范围内每个要求对象，相关路径或单个下游不能替代完整覆盖',kind:'evidence',requirementId:'task:'+task.id,obligationId:o.id,relationKind:o.kind,relationDemandOrigin:'program_projection',rootIds:o.rootIds,entityRequirements:o.entities,sourceIds:refs.map(s=>s.id)});
  }
 }
 requirements.prepare(job,task,obligations,receipts);
 if(!missing.length)return {result,receipts};
 return {result:{...result,passed:false,gaps:unique([...rows(result.gaps),...missing.map(r=>r.text)]),gapDetails:[...rows(result.gapDetails),...missing],summary:(result.summary||'')+'；关系核对尚未全部完成'},receipts};
}
function record(job,receipts){requirements.record(job,receipts);if(!receipts.length)return;job.executionState ||= {};job.executionState.relations ||= {version:2,receipts:[]};for(const r of receipts){const list=job.executionState.relations.receipts;if(!list.some(old=>old.obligationId===r.obligationId&&old.checkBasis===r.checkBasis&&old.evidenceBasis===r.evidenceBasis))list.push({...r,at:new Date().toISOString()});}job.executionState.relations.receipts=job.executionState.relations.receipts.slice(-256);}
function requestProof(a,job,task,result){
 const obligations=required(a,job,task),targets=[];
 for(const o of obligations){
  const details=[...rows(task.contentVerification?.gapDetails),...rows(task.verification?.gapDetails)].filter(d=>sameObligation(o,d.obligationId)&&rows(result.gaps).includes(d.text));
  const explicit=rows(result.requirements).some(id=>sameObligation(o,id))||details.length>0;
  const named=rows(result.gaps).filter(g=>TYPES[o.kind].need.test(g)).flatMap(g=>g.match(/\d+/g)||[]);
  const rootIds=explicit?o.rootIds:o.rootIds.filter(r=>named.includes(r));
  if(rootIds.length){
   const target={obligationId:o.id,kind:o.kind,rootIds};
   if(o.kind==='physical_lineage'){
    const gaps=physicalContext(a,job,task,{obligation:{...o,rootIds}}).frontier.filter(g=>g.status!=='accepted_boundary').map(g=>({rootId:g.rootId,direction:g.reason==='root_output_mapping_missing'?null:g.direction,identity:g.identity,reason:g.reason}));
    target.physicalGaps=[...new Map(gaps.map(g=>[evidence.hash(g),g])).values()];
   }
   targets.push(target);
  }
 }
 const priorFacts=targets.flatMap(target=>facts(a,job,task,{...obligations.find(o=>o.id===target.obligationId),rootIds:target.rootIds}).map(p=>evidence.hash(p.fact)));
 return {version:1,taskId:task.id,workRevision:task.workRevision??1,contractRevision:require('./lineage-scope.cjs').resolve(job).revision,artifactId:result.artifactId||null,targets,priorFacts:unique(priorFacts)};
}
function requestedFact(target,proof){
 if(target.kind!=='physical_lineage')return true;
 if(proof.fact.factType==='root_output_mapping')return rows(target.physicalGaps).some(g=>g.rootId===proof.fact.rootId&&!g.identity&&g.reason==='root_output_mapping_missing');
 // Physical facts are authorized by the original concrete direction/entity
 // gap, not by each newly associated source. Legacy broad request anchors do
 // not acquire this additional authority on replay.
 return rows(target.physicalGaps).some(g=>g.rootId===proof.fact.rootId&&g.direction===proof.fact.direction&&
  (g.identity&&evidence.hash(g.identity)===evidence.hash(proof.fact.scope.entity)||!g.identity&&g.reason==='root_output_mapping_missing'));
}
// Pending authority is process-local and never serialized. Only the exact
// proof minted while resolving the task's actual request can participate in
// preparation of the SAME atomic plan commit. JSON-shaped proofs are inert.
const preparedProofs=new WeakMap();
function computeResolutionProof(a,job,task,next,request,sourceIds){
 const anchor=request.recoveryRequest,obligations=required(a,job,next);
 if(request.kind!=='needs_evidence'||anchor?.version!==1||anchor.taskId!==task.id||anchor.workRevision!==(task.workRevision??1)||anchor.contractRevision!==require('./lineage-scope.cjs').resolve(job).revision)return null;
 const proofs=[];
 for(const target of rows(anchor.targets)){
  const o=obligations.find(o=>sameObligation(o,target.obligationId)&&o.kind===target.kind);if(!o||!target.rootIds.every(id=>o.rootIds.includes(id)))continue;
  for(const proof of facts(a,job,next,{...o,rootIds:target.rootIds}))if(requestedFact(target,proof)&&sourceIds.includes(proof.sourceId)&&!anchor.priorFacts.includes(evidence.hash(proof.fact)))proofs.push(proof);
 }
 return proofs.length?{version:1,request:{...structuredClone(anchor),basis:request.basis},facts:proofs.map(({fact,sourceId,proofSourceIds})=>({fact,sourceId,proofSourceIds}))}:null;
}
function resolutionProof(a,job,task,next,request,sourceIds){
 const proof=computeResolutionProof(a,job,task,next,request,sourceIds);
 if(proof&&request===task.evidenceRequest)preparedProofs.set(proof,{task,request,requestHash:evidence.hash(request),proofHash:evidence.hash(proof),sourceIds:structuredClone(sourceIds),jobId:job.id,dir:a.dir});
 return proof;
}
function pendingProof(a,job,task,resolution){
 const p=resolution?.recoveryProof,prepared=p&&preparedProofs.get(p);
 if(!prepared||resolution!==task.lastEvidenceResolution||task.evidenceRequest||prepared.dir!==a.dir||prepared.jobId!==job.id||prepared.task.id!==task.id||
  prepared.task.evidenceRequest!==prepared.request||prepared.task.deletedAt||prepared.task.agentCancelled||
  evidence.hash(prepared.request)!==prepared.requestHash||evidence.hash(p)!==prepared.proofHash||
  evidence.hash(resolution.sourceIds)!==evidence.hash(prepared.sourceIds)||resolution.basis!==prepared.request.basis)return null;
 const recomputed=computeResolutionProof(a,job,prepared.task,task,prepared.request,prepared.sourceIds);
 return recomputed&&evidence.hash(recomputed)===prepared.proofHash?resolution:null;
}
function currentFactIndex(a,job,task,o){
 return cache.memo(currentFactIndex,[a,a.data,job,task,evidence.lineageOnly(task,job),obligationKey(o),JSON.stringify(unique(rows(task.sourceIds)))],()=>{
  const index=new Map();for(const p of facts(a,job,task,o)){if(!index.has(p.sourceId))index.set(p.sourceId,new Set());index.get(p.sourceId).add(evidence.hash(p.fact));}return index;
 });
}
function resolutionFacts(a,job,task,obligations,resolution){
 const p=resolution?.recoveryProof,anchor=p?.request,result=[];
 if(p?.version!==1||anchor?.version!==1||anchor.taskId!==task.id||anchor.workRevision!==(task.workRevision??1)||anchor.basis!==resolution.basis||anchor.contractRevision!==require('./lineage-scope.cjs').resolve(job).revision)return result;
 for(const target of rows(anchor.targets)){
  const o=obligations.find(o=>sameObligation(o,target.obligationId)&&o.kind===target.kind);if(!o||!rows(target.rootIds).every(id=>o.rootIds.includes(id)))continue;
  const current=currentFactIndex(a,job,task,{...o,rootIds:target.rootIds}),prior=new Set(rows(anchor.priorFacts));
  for(const saved of rows(p.facts)){
   const key=evidence.hash(saved.fact);
   if(requestedFact(target,saved)&&!prior.has(key)&&current.get(saved.sourceId)?.has(key))result.push(saved.fact);
  }
 }
 return result;
}
// Public IR4 seam: sorted semantic fact objects, suitable for hashing. The caller
// owns seen-fact accounting and budgets. No observation or receipt IDs are tokens.
// pendingResolution is ONLY for atomic commit preparation with the exact minted
// next.lastEvidenceResolution object. Replay/projectors use the default durable
// path; neither a clone nor a restored snapshot conveys pending authority.
function recoveryFacts(a,job,task,{pendingResolution}={}){
 return cache.memo(recoveryFacts,[a,a.data,job,task,pendingResolution,evidence.lineageOnly(task,job)],()=>computeRecoveryFacts(a,job,task,{pendingResolution}));
}
function computeRecoveryFacts(a,job,task,{pendingResolution}){
 if(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||task.projectionPending)return [];
 const obligations=required(a,job,task),result=[];
 for(const o of obligations){
  const receipt=rows(job.executionState?.relations?.receipts).findLast(r=>sameObligation(o,r.obligationId)&&r.taskId===task.id),proof=validReceipt(a,job,task,o,receipt);
  if(proof)result.push(...proof.facts.map(p=>p.fact));
 }
 let events=[];try{events=require('./work-journal.cjs').read(a).events;}catch{return [];}
 for(const event of events){
  if(event.type!=='evidence_plan_committed'||event.entityId!==task.id||event.workRevision!==(task.workRevision??1))continue;
  result.push(...resolutionFacts(a,job,task,obligations,event.payload?.task?.set?.lastEvidenceResolution));
 }
 const pending=pendingProof(a,job,task,pendingResolution);
 if(pending)result.push(...resolutionFacts(a,job,task,obligations,pending));
 return [...new Map(result.map(f=>[evidence.hash(f),f])).entries()].sort(([x],[y])=>x.localeCompare(y)).map(([,f])=>structuredClone(f));
}
const instruction='对 businessObligations 中每个要求，返回 relationCoverage:[{obligationId,status:"analyzed",coverage:"complete",rootIds:["已逐项核对的入口ID"],sourceIds:["当前绑定的对应类型来源及映射证明ID"],summary:"具体核对结论及准确受限边界"}]。逐项核对entities中的每个本类型对象：根或同方向下游的路径只证明范围，每个对象仍须自身真实SQL/代码、配置产出或数据集映射。不能用一个下游替代入口或兄弟。confirmationState不是confirmed时保持明确待确认；明确原合同typed缺口可在gapDetails注明relationKind、rootIds与requirementId，不得新增范围。有限深度、分页、截断不能证明完整，可另引完整来源；准确已接受的具体边界保留尝试和影响，不视为新内容或扩大豁免。';
// Mutable public projections must not expose any of the private memo values.
const pure=fn=>(...args)=>cache.scope(()=>structuredClone(fn(...args)));
module.exports={coverageReady:pure(coverageReady),required:pure(required),context:pure(context),validateCoverage,record,instruction,recoveryFacts:pure(recoveryFacts),requestProof:pure(requestProof),resolutionProof,sourceRows:pure(sourceRows),physicalContext:pure(physicalContext),evidenceNeeds:pure(evidenceNeeds)};

