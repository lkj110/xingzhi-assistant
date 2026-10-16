// Local-only context protocol. Scope/options come from the App, never from model arguments.
const links=require('./evidence-links.cjs');
const evidence=require('./evidence-basis.cjs');
const {contextError,contextResult}=require('./model-errors.cjs');
const documents=require('./documents.cjs');
const {state:operationState,freeze}=require('./context-operation-state.cjs');
const {isDeepStrictEqual}=require('node:util');
const hash=evidence.hash;
const readTools=Object.freeze(['read_source','search_source','read_section','read_artifact']);
const taskScope=task=>({kind:'task',taskId:task.id,...(task.agentJobId?{jobId:task.agentJobId}:{})});
const same=(a,b)=>hash(a??null)===hash(b??null);
const firstById=rows=>{const map=new Map();for(const row of rows)if(!map.has(row.id))map.set(row.id,row);return map;};
function ownership(a,scope){
 if(!scope||!['job','task'].includes(scope.kind))throw contextError('CONTEXT_INVALID_REQUEST');
 const task=scope.kind==='task'?a.data.tasks.find(t=>t.id===scope.taskId):null;
 const jobId=scope.kind==='task'?task?.agentJobId:scope.jobId;
 const job=(a.data.delegations||[]).find(j=>j.id===jobId);
 if(scope.kind==='task'&&(!task||task.deletedAt||task.agentCancelled||scope.jobId&&scope.jobId!==jobId)||jobId&&(!job||job.deletedAt)||scope.kind==='job'&&!job||task&&job&&(!job.taskIds?.includes(task.id)||(task.projectId||null)!==(job.projectId||null)))throw contextError('CONTEXT_SCOPE_DENIED');
 const taskSet=scope.kind==='job'?(job.taskIds||[]).map(id=>{const t=a.data.tasks.find(t=>t.id===id&&t.agentJobId===job.id);return {id,missing:!t,deleted:!!t?.deletedAt,cancelled:!!t?.agentCancelled,workRevision:t?.workRevision??1,requirementRevision:t?.requirementRevision??null,criteria:t?.criteria,status:t?.status};}):undefined;
 return {task,job,projectId:task?.projectId??job?.projectId??null,taskSet};
}
function sections(source){
 const body=source.content||'',rows=[...body.matchAll(/^\s{0,3}(#{1,6})\s+([^\n]+)$/gm)].map(m=>({title:m[2].trim(),level:m[1].length,start:m.index}));
 return rows.map((r,i)=>({...r,end:rows.slice(i+1).find(n=>n.level<=r.level)?.start??body.length}));
}
const absentSnapshotPolicy=result=>result?.decision==='unknown'&&result.code==='ACCESS_POLICY_UNKNOWN'&&result.policyId===null&&result.grantRevision===0&&!result.reason;
function historicalRetention(a,owner,object,binding,result,options){
 // ownsSnapshot in the policy store recognizes only input IDs/active bindings.
 // Supply the missing ownership proof here, without projecting history as active
 // or creating a grant. Explicit object decisions always precede inheritance.
 if(options.checkAccess||!a.dir||!a.requireContextAccessPolicy||!absentSnapshotPolicy(result)||!links.historicalDelivery(a,binding,object))return null;
 const policies=require('./access-policy-store.cjs'),scope={jobId:owner.job.id,taskId:binding.taskId},checks=[];
 for(const operation of ['local_retention','local_read']){
  const request={principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+object.id,...scope},operation};
  let checked=policies.check(a,request);
  if(absentSnapshotPolicy(checked))checked=policies.check(a,{...request,resourceScope:{kind:'snapshot_collection',key:'app',...scope}});
  if(checked.decision!=='allow')return null;
  checks.push({operation,policyId:checked.policyId,grantRevision:checked.grantRevision});
 }
 return {allowed:true,revision:hash(checks)};
}
function permitted(a,scope,owner,object,binding,options={}){
 if(links.withdrawn(object)||(object.projectId||null)!==owner.projectId||(object.jobId||object.agentJobId)&&(object.jobId||object.agentJobId)!==owner.job?.id||object.taskId&&binding.type!=='artifact'&&object.taskId!==binding.taskId)return {allowed:false,revision:null};
 if(binding.principalScope!=null&&!same(binding.principalScope,links.principal(object)))return {allowed:false,revision:null};
 const check=options.checkAccess||a.contextAccessCheck;
 if(!check)return {allowed:!(options.requireAccessPolicy||a.requireContextAccessPolicy),revision:'legacy_local'};
 try{
  // The policy adapter must be synchronous and return an explicit allow. It must not grant access.
  const result=check({scope:{...scope},objectType:binding.type||'source',objectId:object.id,taskId:binding.taskId||owner.task?.id||null,jobId:owner.job?.id||null,projectId:owner.projectId,resourceKey:binding.resourceKey||links.resource(object),principalScope:binding.principalScope??links.principal(object),purpose:binding.purpose,operation:'local_retention'});
  if(result?.decision!=='allow'&&binding.purpose==='delivery_readback'&&binding.state==='historical'){
   const retained=historicalRetention(a,owner,object,binding,result,options);if(retained)return retained;
  }
  return {allowed:result?.decision==='allow',revision:structuredClone(result?.revision??result?.grantRevision??null)};
 }catch{return {allowed:false,revision:null};}
}
function sourceBindings(a,owner){
 if(owner.task)return links.bindings(a,owner.task);
 const tasks=a.data.tasks.filter(t=>t.agentJobId===owner.job.id&&owner.job.taskIds?.includes(t.id)&&!t.deletedAt&&!t.agentCancelled&&(t.projectId||null)===owner.projectId);
 const rows=tasks.flatMap(t=>links.bindings(a,t));
 for(const id of owner.job.sourceIds||[]){
  if(rows.some(b=>b.sourceId===id))continue;
  const s=a.data.sources.find(s=>s.id===id);
  if(!s||links.isDelivery(s))continue;
  rows.push({bindingId:'job:'+id,sourceId:id,resourceKey:links.resource(s),revisionId:links.revision(s),principalScope:links.principal(s),purpose:'input',state:'active',provenance:{kind:'job_source'}});
 }
 return rows;
}
function version(object){return hash({id:object.id,resourceKey:links.resource(object),revision:links.revision(object),principal:links.principal(object),content:object.content,segments:object.segments,coverage:object.coverage});}
function entries(a,scope,options={}){
 const owner=ownership(a,scope),rows=[],bindings=sourceBindings(a,owner);
 const sources=firstById(a.data.sources),actions=firstById(a.data.agentActions||[]);
 const scopedIds=new Set(owner.job?.sourceIds||bindings.map(b=>b.sourceId)),children=new Map(),versions=new Map();
 const objectVersion=object=>{if(!versions.has(object))versions.set(object,version(object));return versions.get(object);};
 for(const source of a.data.sources){if(!children.has(source.previousSourceId))children.set(source.previousSourceId,[]);children.get(source.previousSourceId).push(source);}
 for(let binding of bindings){
  if(binding.state==='withdrawn')continue;
  const object=sources.get(binding.sourceId);
  if(!object||typeof object.content!=='string'||!scopedIds.has(object.id)||object.jobId&&object.jobId!==owner.job?.id)continue;
  let state=binding.state;
  if(binding.purpose==='delivery_readback'){
   const record=actions.get(binding.provenance?.actionId),spec=record&&links.deliverySpec(a,record,object);
   if(!spec||record.taskId!==binding.taskId||['artifactId','target','resourceKey','revisionId','principalScope'].some(key=>!same(binding[key],spec[key])))continue;
   if(spec.state==='historical')state='historical';
  }
  // Descendants are considered only inside the owned job/task relation, never all null-project sources.
  const newer=(children.get(object.id)||[]).some(s=>scopedIds.has(s.id)&&(s.projectId||null)===owner.projectId&&same(links.principal(s),links.principal(object))&&!s.copiedFrom);
  if(newer||binding.revisionId!=null&&String(binding.revisionId)!==links.revision(object))state='historical';
  binding={...binding,state};
  const delivery=state==='historical'&&binding.purpose==='delivery_readback'?links.historicalDelivery(a,binding,object):null;
  if(state==='historical'&&binding.purpose==='delivery_readback'&&!delivery)continue;
  const policy=permitted(a,scope,owner,object,binding,options);if(!policy.allowed)continue;
  if(delivery&&!same(delivery,links.historicalDelivery(a,binding,object)))continue;
  const v=delivery?hash({sourceVersion:objectVersion(object),delivery}):objectVersion(object),ref='s:'+hash({scope,id:object.id,purpose:binding.purpose,state,version:v}).slice(0,20);
  rows.push({object,binding,policy,ref,version:v,type:'source',...(delivery?{delivery}:{})});
 }
 // Forks and cycles cannot silently choose a current head. Resolve only explicit history
 // until a trusted owner reconciles the chain. Restrict ancestry to this scope throughout.
 const scoped=a.data.sources.filter(s=>scopedIds.has(s.id)&&(s.projectId||null)===owner.projectId&&(!(s.jobId||s.agentJobId)||(s.jobId||s.agentJobId)===owner.job?.id));
 const byId=new Map(scoped.map(s=>[s.id,s])),roots=new Map();
 const root=s=>{const path=new Set();let key;while(true){if(roots.has(s.id)){key=roots.get(s.id);break;}if(path.has(s.id)){key=null;break;}path.add(s.id);const previous=byId.get(s.previousSourceId);if(!previous||!same(links.principal(previous),links.principal(s))){key=s.id;break;}s=previous;}for(const id of path)roots.set(id,key);return key;};
 const heads=new Map();
 for(const s of scoped){const key=root(s);if(!heads.has(key))heads.set(key,[]);if(!(children.get(s.id)||[]).some(n=>byId.has(n.id)&&same(links.principal(n),links.principal(s))))heads.get(key).push(s.id);}
 for(let i=rows.length-1;i>=0;i--){
  const row=rows[i];
  const key=root(row.object);
  if(key===null||(heads.get(key)||[]).length>1){
   row.binding.state='historical';row.ambiguous=true;
   if(row.binding.purpose==='delivery_readback'&&!row.delivery){
    const delivery=links.historicalDelivery(a,row.binding,row.object);
    if(!delivery){rows.splice(i,1);continue;}
    row.delivery=delivery;row.version=hash({sourceVersion:objectVersion(row.object),delivery});
   }
   row.ref='s:'+hash({scope,id:row.object.id,purpose:row.binding.purpose,state:'historical',version:row.version}).slice(0,20);
  }
 }
 const tasks=owner.task?[owner.task]:a.data.tasks.filter(t=>t.agentJobId===owner.job.id&&owner.job.taskIds?.includes(t.id)&&!t.deletedAt&&!t.agentCancelled&&(t.projectId||null)===owner.projectId);
 for(const task of tasks)for(const object of a.data.artifacts||[]){
  if(object.taskId!==task.id||typeof object.content!=='string')continue;
  const binding={type:'artifact',taskId:task.id,purpose:'artifact',state:task.primaryArtifactId===object.id||task.steps?.some(s=>s.artifactId===object.id)?'active':'historical'};
  // Artifacts inherit their owning task's project; a contradictory explicit project is denied.
  const policy=permitted(a,scope,owner,{...object,projectId:object.projectId??task.projectId??null},binding,options);if(!policy.allowed)continue;
  const v=version(object),ref='a:'+hash({scope,id:object.id,state:binding.state,version:v}).slice(0,20);
  rows.push({object,binding,policy,ref,version:v,type:'artifact'});
 }
 return {owner,rows};
}
function describe(row,sectionCache=new Map()){
 const {object,binding,ref,type,version}=row;
 if(type==='source'&&!sectionCache.has(object))sectionCache.set(object,sections(object).map(({title,start,end})=>({title,start,characters:end-start})));
 return {id:object.id,ref,type,title:object.title,purpose:binding.purpose,state:binding.state,ambiguous:!!row.ambiguous,taskId:binding.taskId||null,version,policyRevision:row.policy.revision,revisionId:links.revision(object),resourceKey:binding.resourceKey||links.resource(object),characters:object.content.length,...(row.delivery?{delivery:row.delivery}:{}),...(type==='source'?{sections:sectionCache.get(object)}:{stepId:object.stepId}),readTool:type==='artifact'?'read_artifact':'read_source'};
}
function contextFrom(scope,purpose,owner,rows){
 const sectionCache=new Map(),catalog=rows.map(row=>describe(row,sectionCache)),current=rows.filter(r=>r.binding.state==='active');
 const requirements=owner.task?hash({intent:evidence.intent(owner.job,owner.task),criteria:owner.task.criteria,objective:owner.task.objective}):hash({goal:owner.job?.executionContract?.text||owner.job?.goal,directives:owner.job?.userDirectives,feedback:evidence.feedback(owner.job?.feedback),taskSet:owner.taskSet});
 const requirementRevision=owner.task?.requirementRevision??owner.job?.requirementRevision??requirements;
 const bases=new Map();
 const basis=r=>{
  if(!bases.has(r.object)){
   const object=r.object,contentHash=hash(evidence.facts(object,owner.task,owner.job));
   bases.set(object,{resourceKey:links.resource(object),principal:links.principal(object),version:evidence.version({...object,fullContentHash:object.fullContentHash||contentHash},owner.task,owner.job),contentHash});
  }
  return {...bases.get(r.object),purpose:r.binding.purpose};
 };
 const unique=rows=>[...new Set(rows.map(r=>hash(basis(r))))].sort();
 const inputBasis=hash(unique(current.filter(r=>r.binding.purpose==='input')));
 // Association identity is not a business input. Delivery checks retain action + original draft/target.
 const deliveryBasis=hash(current.filter(r=>r.binding.purpose==='delivery_readback').map(r=>hash({...basis(r),actionId:r.binding.provenance?.actionId,artifactId:r.binding.artifactId,target:r.binding.target})).sort());
 return {scope:{...scope},purpose,contextRevision:hash(rows.map(r=>({ref:r.ref,binding:r.binding.bindingId,state:r.binding.state,policy:r.policy.revision})).sort((x,y)=>x.ref.localeCompare(y.ref))),readableCatalog:catalog.filter(r=>r.state==='active'),historyCatalog:catalog.filter(r=>r.state==='historical'),currentArtifact:catalog.filter(r=>r.type==='artifact'&&r.state==='active'),requirementRevision,inputBasis,deliveryBasis,workRevision:owner.task?.workRevision??owner.job?.workRevision??null,guard:hash({requirements,requirementRevision,workRevision:owner.task?.workRevision??owner.job?.workRevision,status:owner.task?.status,jobTerminal:owner.job&&['completed','cancelled'].includes(owner.job.status),inputBasis,policies:current.filter(r=>r.binding.purpose==='input'||r.type==='artifact').map(r=>[r.ref,r.policy.revision]).sort(),artifacts:current.filter(r=>r.type==='artifact').map(r=>r.version).sort()})};
}
// A snapshot belongs to one synchronous operation only. Policy adapters are
// callbacks: recheck their decisions, then fence all structural/body mutations
// before exposing any data. This constructs the catalog and hashes only once.
function snapshotFor(a,scope,options){
 const accessCheck=a.contextAccessCheck,requireAccess=a.requireContextAccessPolicy;
 const before=structuredClone(operationState(a)),{owner,rows}=entries(a,scope,options);
 for(const row of rows){
  const object=row.type==='artifact'?{...row.object,projectId:row.object.projectId??a.data.tasks.find(t=>t.id===row.binding.taskId)?.projectId??null}:row.object;
  const policy=permitted(a,scope,owner,object,row.binding,options);
  if(!policy.allowed||!same(policy.revision,row.policy.revision))throw contextError('CONTEXT_VERSION_CHANGED');
 }
 if(accessCheck!==a.contextAccessCheck||requireAccess!==a.requireContextAccessPolicy||!isDeepStrictEqual(before,operationState(a)))throw contextError('CONTEXT_VERSION_CHANGED');
 const context=freeze(structuredClone(contextFrom(scope,options.purpose||'read',owner,rows)));
 const objects={source:new Map(a.data.sources.map((s,i)=>[s,before.sources[i]])),artifact:new Map((a.data.artifacts||[]).map((s,i)=>[s,before.artifacts[i]]))};
 const frozen=freeze(rows.map(({object,...row})=>({...structuredClone(row),object:objects[row.type].get(object)})));
 const refs=new Map(),ids=new Map(),sources=firstById(before.sources.map(s=>freeze(s))),sourceHashes=new Map(),segments=new Map(),queries=new Map();
 for(const row of frozen){for(const [map,key] of [[refs,row.ref],[ids,row.type+':'+row.object.id]]){if(!map.has(key))map.set(key,[]);map.get(key).push(row);}}
 const sourceSegments=id=>{if(!segments.has(id)){const s=sources.get(id);segments.set(id,freeze(s?.segments?.length?s.segments:documents.paragraphs(s?.content||'')));}return segments.get(id);};
 const sectionLists=new Map([...context.readableCatalog,...context.historyCatalog].filter(r=>r.type==='source').map(r=>[r.id,r.sections])),sectionIndexes=new Map();
 return {owner,context,refs,ids,sources,sourceSegments,sectionLists,
  sectionMatches(id,title){
   if(!sectionIndexes.has(id)){
    const byTitle=new Map();for(const s of sectionLists.get(id)||[]){if(!byTitle.has(s.title))byTitle.set(s.title,[]);byTitle.get(s.title).push({...s,end:s.start+s.characters});}
    sectionIndexes.set(id,byTitle);
   }
   return sectionIndexes.get(id).get(title)||[];
  },
  sourceHash(id){if(!sourceHashes.has(id))sourceHashes.set(id,hash(sources.get(id)?.content));return sourceHashes.get(id);},
  excerpt(object,request){
   const terms=String(request.tool==='search_source'?request.query:'').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0,10),key=JSON.stringify([object.id,terms]);
   const all=sourceSegments(object.id);
   if(!queries.has(key)){
    let selected=all.map((s,index)=>({...s,index}));
    if(terms.length)selected=selected.map(s=>({...s,score:terms.reduce((n,t)=>n+(s.text.toLowerCase().includes(t)?1:0),0)})).filter(s=>s.score).sort((a,b)=>b.score-a.score||a.index-b.index);
    queries.set(key,selected);
   }
   const selected=queries.get(key),start=request.start??0,limit=request.limit??6;
   return {sourceId:object.id,title:object.title,totalSegments:all.length,totalMatches:selected.length,start,segments:selected.slice(start,start+limit).map(s=>({...s,text:s.text.slice(0,8000),truncated:s.text.length>8000})),more:selected.length>start+limit};
  }
 };
}
/** Trusted synchronous composition only. Never retain the operation, await in
 * its callback, or mutate workspace/policy state without boundary(callback).
 * boundary invalidates even when the callback throws. Public bulk consumers
 * should prefer validateReads(), which cannot leak a reusable capability. */
function withContext(a,scope,callback,options={}){
 let active=true,snapshot,error;const reads=new Map();
 const check=()=>{if(!active)throw contextError('CONTEXT_INVALID_REQUEST',{message:'上下文操作已结束，须重新校验'});};
 const get=()=>{check();if(error)throw error;if(!snapshot)try{snapshot=snapshotFor(a,scope,options);}catch(e){error=e;throw e;}return snapshot;};
 const invalidate=()=>{check();snapshot=undefined;error=undefined;reads.clear();};
 const operation={
  snapshot:get,invalidate,
  context:()=>get().context,
  source:id=>get().sources.get(id),sourceHash:id=>get().sourceHash(id),sourceSegments:id=>get().sourceSegments(id),
  resolveRead:(request,revision,readOptions={})=>{check();return resolveFrom(a,scope,request,revision,{...options,...readOptions},operation);},
  validRead:row=>{check();return validFrom(operation,row,reads);},
  validateReads:rows=>{const context=get().context,valid=rows.map(row=>operation.validRead(row));return {context,valid,reads:rows.filter((_,i)=>valid[i])};},
  assertCurrent:(previous,assertOptions={})=>assertSnapshot(get().context,previous,assertOptions),
  readContextBatch:(requests,batchOptions={})=>{check();return require('./context-batch.cjs').readInContext(a,scope,requests,batchOptions,operation);},
  boundary:callback=>{check();try{const value=callback();if(value&&typeof value.then==='function')throw contextError('CONTEXT_INVALID_REQUEST',{message:'上下文回调必须同步完成'});return value;}finally{invalidate();}}
 };
 try{const result=callback(operation);if(result&&typeof result.then==='function')throw contextError('CONTEXT_INVALID_REQUEST',{message:'上下文操作必须同步完成'});return result;}
 finally{active=false;snapshot=undefined;reads.clear();}
}
function buildContext(a,scope,purpose='read',options={}){return withContext(a,scope,op=>op.context(),{...options,purpose});}
// Returns one immutable catalog plus a positional validity mask and the original
// valid receipts. Every invocation starts fresh, including after await/save/edit.
function validateReads(a,scope,rows,options={}){return withContext(a,scope,op=>op.validateReads(rows),options);}
// Re-enter after every await or mutating callback; checks guard AND all supplied
// historical dependencies against one new snapshot. Never accepts a cached one.
function assertReadsCurrent(a,scope,snapshot,rows,options={}){
 return withContext(a,scope,operation=>{
  const current=operation.assertCurrent(snapshot,options);
  if(rows.some(row=>!operation.validRead(row)))throw contextError('CONTEXT_VERSION_CHANGED',{stale:true,contextRevision:current.contextRevision});
  return current;
 },{...options,purpose:snapshot.purpose});
}
function validateRequest(request){
 if(!request||typeof request!=='object'||Array.isArray(request)||!readTools.includes(request.tool))throw contextError('CONTEXT_INVALID_REQUEST',{message:'只支持 read_source、search_source、read_section、read_artifact'});
 const allowed=new Set(['tool','ref','sourceId','artifactId','start','history','version','contextRevision',...(['read_source','search_source'].includes(request.tool)?['limit']:[]),...(request.tool==='search_source'?['query']:[]),...(request.tool==='read_section'?['title']:[])]);
 if(Object.keys(request).some(k=>!allowed.has(k)))throw contextError('CONTEXT_INVALID_REQUEST',{message:'读取作用域由 App 固定，不能通过工具参数改变'});
 const ids=[request.ref,request.sourceId,request.artifactId].filter(v=>v!==undefined);
 if(ids.length!==1||ids.some(v=>typeof v!=='string'||!v||v.length>500)||request.tool==='read_artifact'&&request.sourceId||request.tool!=='read_artifact'&&request.artifactId)throw contextError('CONTEXT_INVALID_REQUEST');
 if(request.start!==undefined&&(!Number.isSafeInteger(request.start)||request.start<0)||request.limit!==undefined&&(!Number.isSafeInteger(request.limit)||request.limit<1||request.limit>10)||request.history!==undefined&&typeof request.history!=='boolean'||request.version!==undefined&&typeof request.version!=='string'||request.contextRevision!==undefined&&typeof request.contextRevision!=='string')throw contextError('CONTEXT_INVALID_REQUEST',{message:'start 须为非负整数，limit 须为 1–10 的整数'});
 if(request.tool==='search_source'&&(typeof request.query!=='string'||!request.query.trim()||request.query.length>300))throw contextError('CONTEXT_INVALID_REQUEST',{message:'检索关键词须为 1–300 字符'});
 if(request.tool==='read_section'&&(typeof request.title!=='string'||!request.title.trim()||request.title.length>1000))throw contextError('CONTEXT_INVALID_REQUEST',{message:'请提供目录中的准确章节标题'});
 return request;
}
function alternatives(context){return [...context.readableCatalog,...context.historyCatalog].map(({ref,id,type,purpose,state,version})=>({ref,id,type,purpose,state,version}));}
function resolveRead(a,scope,request,contextRevision,options={}){
 return withContext(a,scope,op=>op.resolveRead(request,contextRevision),options);
}
function resolveFrom(a,scope,request,contextRevision,options,operation){
 try{
  validateRequest(request); // Before even looking up the scope or target.
  const snapshot=operation.snapshot(),{owner,context}=snapshot;
  const id=request.sourceId||request.artifactId;
  let candidates=(request.ref?snapshot.refs.get(request.ref):snapshot.ids.get((request.tool==='read_artifact'?'artifact':'source')+':'+id))||[];
  if(!candidates.length){
   // Only a proven, accessible action relationship may disclose that a link is missing.
   const source=request.sourceId&&a.data.sources.find(s=>s.id===id);
   const proofs=source?(a.data.agentActions||[]).filter(r=>r.jobId===owner.job?.id&&(owner.task?r.taskId===owner.task.id:owner.job?.taskIds?.includes(r.taskId))&&links.deliverySpec(a,r,source)):[];
   const record=proofs.length===1?proofs[0]:null,repairTask=record&&a.data.tasks.find(t=>t.id===record.taskId);
   // A failed existing binding is not a missing link. Rebinding it could erase a
   // withdrawal, a version mismatch, or an integrity failure in historical proof.
   const hasDeliveryBinding=repairTask?.contextBindings?.some(b=>b.sourceId===id&&b.purpose==='delivery_readback');
   if(record&&repairTask&&!hasDeliveryBinding&&!repairTask.deletedAt&&!repairTask.agentCancelled&&(repairTask.projectId||null)===owner.projectId&&owner.job?.sourceIds?.includes(id)&&operation.boundary(()=>permitted(a,scope,owner,source,{...links.deliverySpec(a,record,source),taskId:record.taskId},options)).allowed){
    if(options.repairLinks!==false){const repaired=operation.boundary(()=>links.repairDelivery(a,repairTask,id));if(repaired)return {...operation.resolveRead(request,undefined,{repairLinks:false}),repaired:true};}
    throw contextError('CONTEXT_LINK_MISSING');
   }
   const ownBinding=owner.task&&links.bindings(a,owner.task).some(b=>b.sourceId===id&&b.state!=='withdrawn');
   if(ownBinding&&!source)throw contextError('CONTEXT_LINK_MISSING');
   // An expired opaque handle gives no information about foreign IDs.
   throw contextError(request.ref?'CONTEXT_VERSION_CHANGED':'CONTEXT_SCOPE_DENIED',{safeAlternatives:alternatives(context),contextRevision:context.contextRevision});
  }
  const active=candidates.filter(r=>r.binding.state==='active');
  if(!request.history&&active.length)candidates=active;
  // A dual input/readback binding is the same body; prefer the explicit input purpose.
  if(new Set(candidates.map(r=>r.version)).size>1)throw contextError('CONTEXT_VERSION_CHANGED',{safeAlternatives:alternatives(context)});
  const row=candidates.find(r=>r.binding.purpose==='input')||candidates[0];
  if((request.tool==='read_artifact')!==(row.type==='artifact'))throw contextError('CONTEXT_INVALID_REQUEST');
  // Legacy artifactId already explicitly selects a saved draft. Historical sources require history:true.
  if(row.binding.state==='historical'&&!request.history&&row.type!=='artifact')throw contextError('CONTEXT_VERSION_CHANGED',{safeAlternatives:alternatives(context),contextRevision:context.contextRevision});
  if((contextRevision||request.contextRevision)&&(contextRevision||request.contextRevision)!==context.contextRevision||request.version&&request.version!==row.version)throw contextError('CONTEXT_VERSION_CHANGED',{safeAlternatives:alternatives(context),contextRevision:context.contextRevision});
  const object=row.object,start=request.start??0;
  let result;
  if(request.tool==='read_artifact'||request.tool==='read_section'){
   const matches=request.tool==='read_section'?snapshot.sectionMatches(object.id,request.title):[];
   if(request.tool==='read_section'&&matches.length!==1)throw contextError('CONTEXT_INVALID_REQUEST',{message:'章节不存在或标题重复，请使用目录中的章节位置按全文读取',safeAlternatives:snapshot.sectionLists.get(object.id)});
   const body=matches.length?object.content.slice(matches[0].start,matches[0].end):object.content;
   if(start>body.length)throw contextError('CONTEXT_INVALID_REQUEST',{message:'读取位置超过正文长度'});
   const pageSize=row.type==='artifact'&&scope.kind==='job'?12000:24000;
   result={...(row.type==='artifact'?{artifactId:object.id}:{sourceId:object.id,section:matches[0].title}),title:object.title,start,content:body.slice(start,start+pageSize),next:start+pageSize<body.length?start+pageSize:null,total:body.length};
  }else{
   result=snapshot.excerpt(object,request);
   if(start>result.totalMatches)throw contextError('CONTEXT_INVALID_REQUEST',{message:'读取位置超过段落范围'});
   result.next=result.more?start+(request.limit??6):null;
  }
  // There are no callbacks between snapshot validation and this projection.
  return {...result,ok:true,ref:row.ref,purpose:row.binding.purpose,state:row.binding.state,version:row.version,policyRevision:row.policy.revision,...(row.delivery?{delivery:row.delivery}:{}),contextRevision:context.contextRevision,cursor:result.next,coverage:{unit:['read_section','read_artifact'].includes(request.tool)?'characters':'segments',start,next:result.next,reachesEnd:result.next===null,complete:start===0&&result.next===null&&request.tool!=='search_source'&&!result.segments?.some(s=>s.truncated),source:object.coverage||null}};
 }catch(error){if(error.contextFailure)return contextResult(error);throw error;}
}
function readBatch(a,scope,requests,contextRevision,options={}){
 if(!Array.isArray(requests)||requests.length<1||requests.length>4)return [{request:null,result:contextResult(contextError('CONTEXT_INVALID_REQUEST',{message:'读取资料请求须包含 1–4 项'}))}];
 return withContext(a,scope,op=>requests.map(request=>({request,result:op.resolveRead(request,contextRevision)})),options);
}
function assertCurrent(a,scope,snapshot,{delivery=snapshot.purpose==='verify'||snapshot.purpose==='delivery',...options}={}){
 const current=buildContext(a,scope,snapshot.purpose,options);
 return assertSnapshot(current,snapshot,{delivery});
}
function assertSnapshot(current,snapshot,{delivery=snapshot.purpose==='verify'||snapshot.purpose==='delivery'}={}){
 if(current.guard!==snapshot.guard||delivery&&current.deliveryBasis!==snapshot.deliveryBasis)throw contextError('CONTEXT_VERSION_CHANGED',{stale:true,contextRevision:current.contextRevision,safeAlternatives:alternatives(current)});
 return current;
}
function validRead(a,scope,row,options={}){
 return withContext(a,scope,op=>op.validRead(row),options);
}
function validFrom(operation,row,reads){
 if(!row||row.result?.ok===false)return false;
 try{
  const request={...row.request};delete request.contextRevision;
  validateRequest(request);
  const key=JSON.stringify(request);
  if(!reads.has(key))reads.set(key,operation.resolveRead(request,undefined,{repairLinks:false}));
  const result=reads.get(key);
  return result.ok&&(row.result?.version?result.version===row.result.version&&same(result.policyRevision,row.result.policyRevision):row.sourceHash===operation.sourceHash(request.sourceId));
 }catch{return false;}
}
function recoveryBasis(a,scope,request,options={}){
 try{validateRequest(request);}catch{return hash({scope,request});}
 const {owner,rows}=entries(a,scope,options),id=request.sourceId||request.artifactId;
 const own=rows.filter(r=>request.ref?r.ref===request.ref:r.object.id===id);
 const actions=owner.task?(a.data.agentActions||[]).filter(r=>r.taskId===owner.task.id&&r.result?.sourceId===id).map(r=>({id:r.id,status:r.status,effectStatus:r.effectStatus,artifactId:r.artifactId,sourceId:r.result.sourceId})):[];
 return hash({scope,request:normalizeRequest(request),rows:own.map(r=>({version:r.version,purpose:r.binding.purpose,state:r.binding.state,policy:r.policy.revision})),actions});
}
function normalizeRequest(request){
 validateRequest(request);
 const normalized={...request,start:request.start??0,history:request.history??false};delete normalized.contextRevision;
 if(['read_source','search_source'].includes(request.tool))normalized.limit=request.limit??6;
 if(request.tool==='search_source')normalized.query=request.query.trim().toLowerCase().split(/\s+/).slice(0,10).join(' ');
 return normalized;
}
function readFingerprint(row){
 const request=normalizeRequest(row.request);delete request.ref;delete request.sourceId;delete request.artifactId;delete request.version;
 return hash({request,ref:row.result.ref,version:row.result.version,cursor:row.result.cursor});
}
// Opt-in automatic pagination; existing single-page and readBatch semantics stay intact.
function readContextBatch(a,scope,requests,options={},pageRows){return require('./context-batch.cjs').readContextBatch(a,scope,requests,options,pageRows);}
module.exports={buildContext,validateReads,assertReadsCurrent,withContext,resolveRead,readBatch,readContextBatch,assertCurrent,validRead,recoveryBasis,taskScope,sections,validateRequest,normalizeRequest,readFingerprint,readTools};
