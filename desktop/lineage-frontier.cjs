// Pure, read-only projection. Node identity includes region. Only explicit
// parent relations in current readable snapshots prove traversal edges.
const id=value=>/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0?String(Number(value)):null;
const region=value=>typeof value==='string'&&value.trim()?value.trim().toLowerCase():null;
const key=(r,n)=>r+':'+n;
const boundaries=require('./platform-boundaries.cjs');
function build(sources,scope,currentQueries){
 const valid=new Set(currentQueries.map(q=>q.sourceId)),nodes=new Map(),up=new Map(),down=new Map(),queried=new Map();
 const projects=new Map();
 for(const proof of boundaries.projectEvidence(sources.filter(s=>valid.has(s.id)))){const k=key(proof.region,proof.taskId);if(!projects.has(k))projects.set(k,[]);projects.get(k).push(proof);}
 const touch=(r,n)=>{const k=key(r,n);if(!nodes.has(k))nodes.set(k,{nodeId:n,region:r});return k;};
 const link=(map,from,to,sourceId)=>{if(!map.has(from))map.set(from,new Map());const edges=map.get(from);if(!edges.has(to))edges.set(to,new Set());edges.get(to).add(sourceId);};
 const records=[];
 for(const source of sources){
  if(!valid.has(source.id))continue;
  let snap;try{snap=JSON.parse(source.content);}catch{continue;}
  if(!['upstream','downstream'].includes(snap.operation)||snap.query?.op!==snap.operation)continue;
  const origin=id(snap.query.taskId),data=snap.data||{},sourceRegions=[...new Set([region(snap.region),region(snap.query.region),region(data.region)].filter(Boolean))];
  // Contradictory source envelopes cannot establish even one SG edge.
  if(sourceRegions.length>1)continue;
  const sr=sourceRegions[0]||scope.region,rootId=data.root?.id??data.root?.taskId;
  if(!origin||data.taskId!=null&&id(data.taskId)!==origin||rootId!=null&&id(rootId)!==origin||!Array.isArray(data.nodes))continue;
  const explicitRegion=row=>{
   const values=[...new Set([region(row.region),region(row.taskRegion),region(row.location)].filter(Boolean))];
   if(values.length>1||row.crossRegion&&values[0]===sr)return 'unknown';
   return values[0]||(row.crossRegion?'unknown':null);
  };
  const local=new Map();
  for(const row of data.nodes){const n=id(row.id??row.taskId);if(!n)continue;const r=explicitRegion(row)||sr;if(!local.has(n))local.set(n,new Set());local.get(n).add(r);touch(r,n);}
  const nodeRegion=(n,row={})=>{const explicit=explicitRegion(row);if(explicit)return explicit;const known=local.get(n);return known?.size===1?[...known][0]:known?.size>1?'unknown':sr;};
  const qr=nodeRegion(origin,data.root||{}),qk=snap.operation+':'+touch(qr,origin);
  if(!queried.has(qk))queried.set(qk,[]);queried.get(qk).push({sourceId:source.id,at:source.lastCheckedAt||snap.queriedAt||source.createdAt||'',depth:snap.query.depth});
  for(const row of data.nodes){
   const child=id(row.id??row.taskId);if(!child||!Array.isArray(row.parentRelation))continue;
   const childKey=touch(nodeRegion(child,row),child);
   for(const parent of row.parentRelation){const p=typeof parent==='object'&&parent!==null?parent:{id:parent},pid=id(p.id??p.taskId);if(!pid)continue;const parentKey=touch(nodeRegion(pid,p),pid);link(up,childKey,parentKey,source.id);link(down,parentKey,childKey,source.id);}
  }
 }
 for(const direction of ['upstream','downstream']){
  const paths=new Map(scope.rootIds.map(root=>[touch(scope.region,root),{rootId:root,proofSourceIds:[],path:[{region:scope.region,nodeId:root}]}])),graph=direction==='upstream'?up:down;
  for(const [nk,proof] of paths){
   const node=nodes.get(nk);if(node.region!==scope.region||new Set((projects.get(nk)||[]).map(p=>p.projectId)).size>1)continue;
   for(const [next,proofIds] of graph.get(nk)||[]){if(paths.has(next))continue;const n=nodes.get(next);paths.set(next,{rootId:proof.rootId,proofSourceIds:[...new Set([...proof.proofSourceIds,...proofIds])],path:[...proof.path,n]});}
  }
  for(const [nk,proof] of paths){
   const node=nodes.get(nk),queries=(queried.get(direction+':'+nk)||[]).sort((a,b)=>b.at.localeCompare(a.at));
   const projectProof=projects.get(nk)||[],projectIds=[...new Set(projectProof.map(p=>p.projectId))].sort();
   records.push({...node,...(projectIds.length===1?{projectId:projectIds[0]}:{}),projectIds,projectProof,direction,...proof,scopeRevision:scope.revision,scopeProven:node.region!=='unknown'&&projectIds.length<=1,crossRegion:node.region!==scope.region,sourceId:queries[0]?.sourceId,querySourceIds:queries.map(q=>q.sourceId),queried:queries.length>0});
  }
 }
 return records;
}
// Integration seam for work-obligations: call project after build, then select
// candidates from the returned rows. An accepted decision wins over queried.
function queryFor(job,row,options={}){
 const query={op:row.direction,taskId:row.nodeId,depth:1,region:row.region,...(row.projectId?{projectId:row.projectId}:{})};
 if(row.crossRegion||row.region!=='sg'||row.scopeProven===false||row.projectIds?.length>1)return {status:'scope_unresolved',query:null,reason:'unproven_lineage_scope'};
 return boundaries.inspect(job,query,options);
}
function project(job,rows,options={}){
 const migration=options.migration||boundaries.planMigration(job,options),records=options.records||migration.records;
 return rows.map(row=>{
  const result=queryFor(job,row,{...options,records,migration});
  const hash=require('./evidence-basis.cjs').hash;
  const latest=result.query&&Object.values(job.executionState?.operations||{}).filter(o=>o.query&&(options.isOperationCurrent||boundaries.currentOperation)(job,o)&&hash(boundaries.canonicalQuery(o.actualQuery||o.query))===hash(boundaries.canonicalQuery(result.query))).sort((a,b)=>(Date.parse(b.startedAt||b.completedAt)||0)-(Date.parse(a.startedAt||a.completedAt)||0))[0];
  const blocked=latest?.status==='failed'&&!(latest.errorCode==='SCOPE_UNRESOLVED'&&result.status==='ready')&&(latest.errorCode!=='TRANSIENT'||Date.parse(latest.retryAt)>(options.time??Date.now()));
  const status=row.crossRegion&&row.region!=='unknown'?'cross_region':result.status==='scope_unresolved'?'scope_unresolved':result.status==='accepted_boundary'?'accepted_boundary':row.queried?'queried':blocked?'blocked':'unexpanded';
  return {...row,status,query:result.status==='scope_unresolved'?null:result.query,scopeProven:row.scopeProven&&result.status!=='scope_unresolved',projectResolution:result.proof||[],...(result.query?.projectId?{projectId:String(result.query.projectId)}:{}),...(blocked?{errorCode:latest.errorCode,error:latest.error,operationId:latest.id||latest.key}:{}),...(result.acceptedBoundary?{acceptedBoundary:result.acceptedBoundary}:{}),...(result.reason?{scopeReason:result.reason}:{})};
 });
}
function candidates(job,rows,options={}){return project(job,rows,options).filter(r=>r.status==='unexpanded'&&r.scopeProven&&r.query);}
module.exports={build,queryFor,project,candidates};
