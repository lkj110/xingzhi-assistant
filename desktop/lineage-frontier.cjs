// Pure, read-only projection. Node identity includes region. Only explicit
// parent relations in current readable snapshots prove traversal edges.
const id=value=>/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0?String(Number(value)):null;
const region=value=>typeof value==='string'&&value.trim()?value.trim().toLowerCase():null;
const key=(r,n)=>r+':'+n;
function build(sources,scope,currentQueries){
 const valid=new Set(currentQueries.map(q=>q.sourceId)),nodes=new Map(),up=new Map(),down=new Map(),queried=new Map();
 const touch=(r,n)=>{const k=key(r,n);if(!nodes.has(k))nodes.set(k,{nodeId:n,region:r});return k;};
 const link=(map,from,to,sourceId)=>{if(!map.has(from))map.set(from,new Map());const edges=map.get(from);if(!edges.has(to))edges.set(to,new Set());edges.get(to).add(sourceId);};
 const records=[];
 for(const source of sources){
  if(!valid.has(source.id))continue;
  let snap;try{snap=JSON.parse(source.content);}catch{continue;}
  if(!['upstream','downstream'].includes(snap.operation)||snap.query?.op!==snap.operation)continue;
  const origin=id(snap.query.taskId),data=snap.data||{},sourceRegions=[...new Set([region(snap.region),region(data.region)].filter(Boolean))];
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
   const node=nodes.get(nk);if(node.region!==scope.region)continue;
   for(const [next,proofIds] of graph.get(nk)||[]){if(paths.has(next))continue;const n=nodes.get(next);paths.set(next,{rootId:proof.rootId,proofSourceIds:[...new Set([...proof.proofSourceIds,...proofIds])],path:[...proof.path,n]});}
  }
  for(const [nk,proof] of paths){
   const node=nodes.get(nk),queries=(queried.get(direction+':'+nk)||[]).sort((a,b)=>b.at.localeCompare(a.at));
   records.push({...node,direction,...proof,scopeRevision:scope.revision,scopeProven:node.region!=='unknown',crossRegion:node.region!==scope.region,sourceId:queries[0]?.sourceId,querySourceIds:queries.map(q=>q.sourceId),queried:queries.length>0});
  }
 }
 return records;
}
module.exports={build};
