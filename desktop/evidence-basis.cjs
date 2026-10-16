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
const statistics=new Set(['latestPartitionName','latestPartitionCreateTime','tableSize','physicalSize','assetRank','produceTime','sourceUpdateTime']);
function lineageOnly(task,job){
 const scope=[job?.executionContract?.text||job?.goal||'',...(job?.userDirectives||[]).map(f=>f.text),task?.criteria||''].join('\n');
 return /血缘|上下游|lineage/i.test(scope)&&!/大小|容量|存储量|分区|新鲜度|更新时间|更新时刻|数据时效|table.?size|partition|freshness/i.test(scope);
}
function facts(s,task,job){
 if(!s?.platformSnapshot)return s?.content;
 try{
  const {queriedAt,query,...snapshot}=JSON.parse(s.content);
  const narrow=lineageOnly(task,job)&&snapshot.operation==='table_lineage';
  const clean=v=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!narrow||!statistics.has(k)).map(([k,x])=>[k,clean(x)])):v;
  return {...clean(snapshot),query:require('./data-platform.cjs').command(query)};
 }catch{return s.content;}
}
function version(s,task,job){if(!s)return {missing:true};return {key:sourceKey(s),content:s.fullContentHash||hash(facts(s,task,job)),deleted:!!s.deleted,excluded:!!s.projectExcluded,projectId:s.projectId||null,coverage:s.coverage||null,scope:s.platformPrincipal||null};}
function versions(sources,task,job){return [...new Map(sources.map(s=>{const v=version(s,task,job);return [hash(v),v];})).values()].sort((a,b)=>hash(a).localeCompare(hash(b)));}
function relevantChange(previous,current,task,job){return hash(version(previous,task,job))!==hash(version(current,task,job));}
function taskSources(a,task){
 const job=a.data.delegations?.find(j=>j.id===task.agentJobId);
 return [...new Map((task.sourceIds||[]).filter(id=>!task.supersededSourceIds?.includes(id)).map(id=>{
  const s=a.data.sources.find(x=>x.id===id)||{id,missing:true};return [sourceKey(s),s.missing?s:version(s,task,job)];
 })).values()].sort((x,y)=>String(x.key||x.id).localeCompare(String(y.key||y.id)));
}
function intent(job,task){return hash({...require('./requirements.cjs').intent(job,task),notes:notes(task?.notes).filter(n=>n.origin!=='result_check'&&n.kind!=='revise'),criteria:job?undefined:task?.criteria,objective:job?undefined:task?.objective});}
module.exports={canonical,hash,source,step,notes,feedback,version,versions,sourceKey,facts,taskSources,relevantChange,intent,lineageOnly};
