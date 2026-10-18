// Content and scope determine validity. Observation/scheduler metadata never does.
const crypto=require('node:crypto');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))??'null').digest('hex');
const observationFields=new Set(['state','processedAt','lastCheckedAt','checkedAt','observedAt','observation','observations','lastAccessedAt']);
function source(value){return Object.fromEntries(Object.entries(value).filter(([key])=>!observationFields.has(key)));}
function step(value){if(!value||typeof value!=='object')return value;const {title,checkpoint,checkpointHistory,inputBasis,outputHash,...rest}=value;return rest;}
function notes(values=[]){return values.filter(n=>n.kind!=='authorization');}
function feedback(values=[]){return values.filter(n=>!['authorization','user_lark_policy','source_update'].includes(n.origin));}
function sourceKey(s){return s.resourceKey||s.identity||s.id;}
function sourceTitle(s){return String(s?.title||'').normalize('NFC').trim().replace(/\s+/g,' ');}
function sourceSemanticVersion(s){return hash({title:sourceTitle(s),content:s?.content,deleted:!!s?.deleted});}
const statistics=new Set(['latestPartitionName','latestPartitionCreateTime','tableSize','physicalSize','assetRank','produceTime','sourceUpdateTime']);
function lineageOnly(task,job){
 const scope=[job?.executionContract?.text||job?.goal||'',...(job?.userDirectives||[]).map(f=>f.text),task?.criteria||''].join('\n');
 return /血缘|上下游|lineage/i.test(scope)&&!/大小|容量|存储量|分区|新鲜度|更新时间|更新时刻|数据时效|table.?size|partition|freshness/i.test(scope);
}
function facts(s,task,job){
 if(!s?.platformSnapshot)return s?.content;
 let parsed;try{parsed=JSON.parse(s.content);}catch{if(s.platformArchive)throw require('./platform-chunks.cjs').integrity('archive_invalid');return s.content;}
 const data=require('./platform-result.cjs').restore(parsed,s);
 const {queriedAt,query,platformResult,platformArchive,...snapshot}=parsed;
 const narrow=lineageOnly(task,job)&&snapshot.operation==='table_lineage';
 const clean=v=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!narrow||!statistics.has(k)).map(([k,x])=>[k,clean(x)])):v;
 // Keep the established semantic query representation so upgrading storage
 // does not invalidate every historical inline check/step receipt.
 let semanticQuery;
 try{semanticQuery=require('./data-platform.cjs').command(query);}catch{
  // Stored mappings may come from a capability outside this platform adapter.
  // Preserve the old opaque inline identity without treating it as executable.
  // Archive validation above remains mandatory and is never caught here.
  if(!platformResult&&!s.platformArchive)return s.content;
  semanticQuery=require('./platform-boundaries.cjs').canonicalQuery(query);
 }
 return {...clean({...snapshot,data}),query:semanticQuery};
}
// Business validity is deliberately independent of encoding and observation
// time. Readers still use storageIntegrityVersion to fence corruption/rewrites.
function semanticFactVersion(s,task,job){
 return require('./projection-cache.cjs').memo(semanticFactVersion,[s?.content,s?.title,s?.semanticFactSchema,s?.platformSnapshot,s?.platformArchive,s?.platformPrincipal,s?.projectId,s?.platformOperationId,s?.platformScope,s?.platformPermissionRevision,s?.id,s?.version,s?.fullContentHash,lineageOnly(task,job)],()=>{
  if(s?.platformSnapshot)return hash(facts(s,task,job));
  if(s?.semanticFactSchema!==undefined&&s.semanticFactSchema!==2)throw Object.assign(Error('来源事实编码版本无效或不受支持，请核对来源；原记录已保留。'),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
  const content=s?.fullContentHash||hash(facts(s,task,job));
  return s?.semanticFactSchema===2?hash({title:sourceTitle(s),content}):content;
 });
}
function storageIntegrityVersion(s){return require('./platform-result.cjs').storageIntegrityVersion(s);}
function version(s,task,job){if(!s)return {missing:true};return {key:sourceKey(s),content:semanticFactVersion(s,task,job),deleted:!!s.deleted,excluded:!!s.projectExcluded,projectId:s.projectId||null,coverage:s.coverage||null,scope:s.platformPrincipal||null};}
// Catalog/read guards may change when storage changes. They do not issue
// new business facts or retry grants, and must not inflate data for a catalog.
function readBasisVersion(s,task,job){
 let archived=!!s?.platformArchive;
 if(s?.platformSnapshot)try{archived ||= !!JSON.parse(s.content).platformResult;}catch{}
 if(!archived)return version(s,task,job);
 return {key:sourceKey(s),content:storageIntegrityVersion(s),deleted:!!s.deleted,excluded:!!s.projectExcluded,projectId:s.projectId||null,coverage:s.coverage||null,scope:s.platformPrincipal||null};
}
function versions(sources,task,job){return [...new Map(sources.map(s=>{const v=version(s,task,job);return [hash(v),v];})).values()].sort((a,b)=>hash(a).localeCompare(hash(b)));}
function relevantChange(previous,current,task,job){return hash(version(previous,task,job))!==hash(version(current,task,job));}
function taskSources(a,task){
 const job=a.data.delegations?.find(j=>j.id===task.agentJobId);
 return [...new Map((task.sourceIds||[]).filter(id=>!task.supersededSourceIds?.includes(id)).map(id=>{
  const s=a.data.sources.find(x=>x.id===id)||{id,missing:true};return [sourceKey(s),s.missing?s:version(s,task,job)];
 })).values()].sort((x,y)=>String(x.key||x.id).localeCompare(String(y.key||y.id)));
}
function intent(job,task){return hash({...require('./requirements.cjs').intent(job,task),notes:notes(task?.notes).filter(n=>n.origin!=='result_check'&&n.kind!=='revise'),criteria:job?undefined:task?.criteria,objective:job?undefined:task?.objective});}
module.exports={readBasisVersion,semanticFactVersion,storageIntegrityVersion,canonical,hash,source,step,notes,feedback,version,versions,sourceKey,sourceTitle,sourceSemanticVersion,facts,taskSources,relevantChange,intent,lineageOnly};
