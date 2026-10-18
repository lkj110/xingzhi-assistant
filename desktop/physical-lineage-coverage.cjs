'use strict';
// Pure Coral projection. Callers supply ONLY currently readable, bound, typed
// snapshots and currently valid acceptance records. This module grants no ACL,
// performs no reads/queries, and never treats incidental leaf attributes as a
// center expansion. Coral's installed adapter returns one BOTH layer.
const {hash}=require('./evidence-basis.cjs');
const array=Array.isArray,rows=v=>array(v)?v:[],uniq=v=>[...new Set(v)].sort();
const name=v=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(v);
const key=v=>hash(v),dedupe=v=>[...new Map(v.map(x=>[key(x),x])).entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,x])=>x);
const directions=['input','output'];
function queryEntity(q={}){
 if(q.op!=='table_lineage'||q.entityType!=null&&q.entityType!=='HiveTable'||q.region!=null&&q.region!=='sg'||q.direction!=null&&q.direction!=='BOTH'||['depth','page','pageSize'].some(k=>q[k]!=null)||!name(q.database)||!name(q.table))return null;
 return {entityType:'HiveTable',region:'sg',cid:6,database:q.database,table:q.table};
}
const queryFor=e=>({op:'table_lineage',database:e.database,table:e.table});
const matchesQuery=(query,identity)=>key(require('./platform-boundaries.cjs').canonicalQuery(query))===key(require('./platform-boundaries.cjs').canonicalQuery(queryFor(identity)));
function entity(node,guid){
 if(!node||node.guid!==guid||typeof guid!=='string'||!guid||typeof node.typeName!=='string')return {status:'unresolved',reason:'entity_identity_missing',identity:{guid:guid||null}};
 const a=node.attributes||{},type=node.typeName;
 const identity={entityType:type,guid,...(typeof a.qualifiedName==='string'?{qualifiedName:a.qualifiedName}:{})};
 if(type!=='HiveTable')return {status:'unsupported',reason:'entity_type_unsupported',identity};
 const q=typeof a.qualifiedName==='string'&&a.qualifiedName.match(/^HiveTable:\/\/\/([^/]+)\/([^/@]+)@(\d+)$/);
 if(!q||!name(a.parentName)||!name(a.name)||q[1]!==a.parentName||q[2]!==a.name||a.dbName!=null&&a.dbName!==a.parentName||a.cid==null||String(a.cid)!==q[3])return {status:'unresolved',reason:'entity_address_conflict_or_missing',identity};
 if(q[3]!=='6')return {status:'unresolved',reason:'entity_region_outside_sg',identity};
 return {status:'resolved',identity:{entityType:type,region:'sg',cid:6,database:a.parentName,table:a.name},guid};
}
function limitation(s){
 for(const v of [s.sourceFlags,s,s.data,s.data?.pagination].filter(v=>v&&typeof v==='object')){
  if(v.error||v.status==='failed'||['partial','truncated','incomplete'].includes(v.coverage)||v.complete===false||v.truncated===true||v.hasMore===true||v.has_more===true||v.noMore===false||v.next!=null||v.nextPage!=null||v.next_page!=null||v.nextCursor!=null||v.page!=null&&v.page!==1)return 'snapshot_incomplete';
 }
 return null;
}
function processIdentity(p){
 const a=p?.attributes,q=typeof a?.qualifiedName==='string'&&a.qualifiedName.match(/^DoradoTask:\/\/\/(\d+)@(\d+)$/);
 if(p?.typeName!=='DoradoTask'||!q||q[2]!=='6'||!/^\d+$/.test(String(a.id))||Number(a.id)<=0||!Number.isSafeInteger(Number(a.id))||String(Number(a.id))!==q[1]||a.errorMessage)return null;
 // process.inputs/outputs are incidental and usually empty in real responses.
 return {entityType:'DoradoTask',region:'sg',cid:6,taskId:q[1]};
}
function directionView(s,direction){
 const d=s.data,count=d[direction+'EntityCount'],layers=d[direction+'EntityGuids'],depth=d[direction+'EntityDepth'];
 const processes=d.guidEntityMap[d.baseEntityGuid].attributes?.[direction==='input'?'outputFromProcesses':'inputToProcesses'];
 const fail=reason=>({reason});
 if(!Number.isSafeInteger(count)||count<0||!array(layers)||!layers.every(array)||!array(processes))return fail('direction_fields_missing_or_invalid');
 // The real adapter is fixed depth=1. Deeper/unknown nonempty enumerations
 // cannot establish a complete first layer. An explicitly empty center is
 // terminal independently of an omitted depth field.
 if(layers.length>1||count>0&&depth!==1||depth!=null&&![0,1].includes(depth))return fail('first_layer_completeness_unknown');
 const ids=layers[0]||[];
 if(ids.some(g=>typeof g!=='string'||!g)||uniq(ids).length!==ids.length||count!==ids.length)return fail('direction_count_conflict');
 if(count===0&&processes.length||count>0&&!processes.length)return fail('direction_process_conflict');
 const typedProcesses=processes.map(processIdentity);
 if(typedProcesses.some(p=>!p))return fail('process_identity_unresolved');
 const neighbors=ids.map(g=>entity(d.guidEntityMap[g],g));
 if(ids.some(g=>!d.guidEntityMap[g]))return fail('neighbor_entity_missing');
 return {neighbors:dedupe(neighbors),processes:dedupe(typedProcesses),terminal:count===0};
}
function center(s){
 const target=queryEntity(s.query),d=s.data;
 if(!target)return null;
 let reason=limitation(s);
 if(s.operation!=='table_lineage'||s.region!=null&&s.region!=='sg'||d?.region!=null&&d.region!=='sg'||!d||!d.baseEntityGuid||!d.guidEntityMap)reason ||= 'center_fields_missing_or_conflicting';
 const base=entity(d?.guidEntityMap?.[d?.baseEntityGuid],d?.baseEntityGuid);
 if(base.status!=='resolved'||key(base.identity)!==key(target))reason ||= 'center_identity_conflict_or_missing';
 return {target,sourceId:s.sourceId,principal:s.principal||null,guid:d?.baseEntityGuid,views:Object.fromEntries(directions.map(dir=>[dir,reason?{reason}:directionView(s,dir)]))};
}
function choose(candidates,direction){
 if(!candidates.length)return {reason:'missing_own_center',status:'unexpanded'};
 const invalid=candidates.filter(c=>c.views[direction].reason);
 // Current contradictory or incomplete sources cannot be silently superseded
 // by timestamps or a model claim. The caller must withdraw/replace them.
 if(invalid.length)return {reason:invalid[0].views[direction].reason,status:'unresolved',sourceIds:uniq(candidates.map(c=>c.sourceId))};
 const semantics=candidates.map(c=>({guid:c.guid,...c.views[direction]}));
 if(dedupe(semantics).length!==1)return {reason:'current_centers_conflict',status:'unresolved',sourceIds:uniq(candidates.map(c=>c.sourceId))};
 return {view:candidates[0].views[direction],centers:candidates,sourceIds:uniq(candidates.map(c=>c.sourceId))};
}
// roots: [{rootId, entity: {entityType,region,cid,database,table},
//          proofSourceIds, reason?}]. A root lacking an output mapping is an
// explicit reason row, never omitted. snapshots: [{sourceId,operation,query,
// data,region,principal,sourceFlags,...envelope limitation fields}].
function project({roots=[],snapshots=[],acceptedBoundaries=[],failures=[]}={}){
 const centers=new Map();
 for(const s of snapshots){const c=center(s);if(c){const k=key(c.target);if(!centers.has(k))centers.set(k,[]);centers.get(k).push(c);}}
 const frontier=[],observations=[],proofs=new Set(),rootResults=[];
 for(const root of roots){
  const rootResult={rootId:String(root.rootId),entity:root.entity||null,proofSourceIds:uniq(rows(root.proofSourceIds)),directions:{}};
  for(const direction of directions){
   const gaps=[],proofIds=new Set(rootResult.proofSourceIds),visited=new Set();let directObserved=false;
   const add=(entry,extra)=>{const gap={rootId:rootResult.rootId,direction,identity:entry.identity||null,proofSourceIds:uniq(entry.proofSourceIds||[]),...extra};gaps.push(gap);frontier.push(gap);};
   const queue=[{identity:root.entity,proofSourceIds:rootResult.proofSourceIds,root:true}];
   for(let cursor=0;cursor<queue.length;cursor++){
    const entry=queue[cursor],identity=entry.identity;
    if(entry.root&&root.reason){add(entry,{status:'unresolved',reason:root.reason});continue;}
    if(!identity||key(queryEntity({...queryFor(identity),entityType:identity.entityType,region:identity.region}))!==key(identity)){
     add(entry,{status:identity?.entityType&&identity.entityType!=='HiveTable'?'unsupported':'unresolved',reason:'root_identity_unresolved'});continue;
    }
    const k=key(identity),candidates=centers.get(k)||[];
    // Check the addressed remote GUID even on a revisit: visited must not
    // conceal two current sources identifying different entities as one table.
    if(entry.guid&&candidates.some(c=>c.guid!==entry.guid)){add(entry,{status:'unresolved',reason:'neighbor_center_identity_conflict'});continue;}
    if(visited.has(k))continue;visited.add(k);
    const expanded=choose(candidates,direction);
    if(!expanded.view){
     const accepted=acceptedBoundaries.find(b=>queryEntity(b.query)&&matchesQuery(b.query,identity)&&(!b.direction||b.direction===direction));
     const failure=failures.find(f=>queryEntity(f.query)&&matchesQuery(f.query,identity));
     const proofSourceIds=uniq([...entry.proofSourceIds,...rows(expanded.sourceIds)]);
     if(accepted)add({...entry,proofSourceIds},{status:'accepted_boundary',reason:expanded.reason,boundary:structuredClone(accepted),impact:'该实体此方向以明确用户决定保留未知；未证明物理闭合'});
     else if(failure)add({...entry,proofSourceIds},{status:'failed',reason:expanded.reason,attempt:structuredClone(failure)});
     else add({...entry,proofSourceIds},{status:expanded.status,reason:expanded.reason,...(expanded.status==='unexpanded'?{query:queryFor(identity)}:{})});
     continue;
    }
    if(entry.root)directObserved=true;
    const path=uniq([...entry.proofSourceIds,...expanded.sourceIds]);path.forEach(id=>proofIds.add(id));
    for(const c of expanded.centers)observations.push({rootId:rootResult.rootId,direction,identity,sourceId:c.sourceId,principal:c.principal,proofSourceIds:path,
     adjacency:{neighbors:dedupe(expanded.view.neighbors.map(n=>n.identity)),processes:expanded.view.processes}});
    for(const n of expanded.view.neighbors){
     if(n.status!=='resolved')add({identity:n.identity,proofSourceIds:path},{status:n.status,reason:n.reason});
     else queue.push({identity:n.identity,guid:n.guid,proofSourceIds:path});
    }
   }
   const closureProven=gaps.length===0,satisfied=gaps.every(g=>g.status==='accepted_boundary');
   gaps.flatMap(g=>g.proofSourceIds).forEach(id=>proofIds.add(id));proofIds.forEach(id=>proofs.add(id));
   rootResult.directions[direction]={directObserved,closureProven,satisfied,proofSourceIds:uniq([...proofIds]),frontier:gaps};
  }
  rootResults.push(rootResult);
 }
 const all=rootResults.flatMap(r=>Object.values(r.directions)),closureProven=all.length>0&&all.every(d=>d.closureProven),satisfied=all.length>0&&all.every(d=>d.satisfied);
 return {version:1,status:closureProven?'closed':satisfied?'accepted_boundary':'unclosed',directObserved:all.length>0&&all.every(d=>d.directObserved),closureProven,satisfied,roots:rootResults,proofSourceIds:uniq([...proofs]),frontier:dedupe(frontier),queries:dedupe(frontier.filter(g=>g.query).map(g=>g.query)),observations:dedupe(observations)};
}
module.exports={project,queryEntity};
