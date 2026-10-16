// A public projection must not expose a denied snapshot through its cached copies.
const bodyFields=new Set(['content','body','readbackContent','segments','preview','tail','quote','excerpt','text','raw','chunks','outline']);
function sanitize(a,state){
 if(!a.requireContextAccessPolicy)return state;
 const denied=new Set();
 const known={sourceId:new Set((a.data.sources||[]).map(r=>r.id)),artifactId:new Set((a.data.artifacts||[]).map(r=>r.id))};
 function missingReferences(value){
  if(!value||typeof value!=='object')return;
  for(const [key,child]of Object.entries(value)){
   // Deletion removes the canonical row, but action/history copies can remain.
   // A missing original cannot authorize exposing a cached body.
   if(known[key]&&typeof child==='string'&&!known[key].has(child))denied.add(child);
   else if(child&&typeof child==='object')missingReferences(child);
  }
 }
 missingReferences(state);
 for(const [kind,rows]of [['source',a.data.sources||[]],['artifact',a.data.artifacts||[]]])for(const row of rows){
  const scopes=[{}];
  for(const task of a.data.tasks)if(kind==='artifact'?row.taskId===task.id:(task.sourceIds||[]).includes(row.id)||(task.contextBindings||[]).some(b=>b.sourceId===row.id))scopes.push({taskId:task.id,...(task.agentJobId?{jobId:task.agentJobId}:{})});
  for(const job of a.data.delegations)if(row.agentJobId===job.id||(job.sourceIds||[]).includes(row.id))scopes.push({jobId:job.id});
  if(!scopes.some(scope=>a.contextAccessCheck({objectType:kind,objectId:row.id,...scope}).allowed))denied.add(row.id);
 }
 function visit(value,inherited=false){
  if(Array.isArray(value)){for(const row of value)visit(row,inherited);return;}
  if(!value||typeof value!=='object')return;
  const refs=[value.id,value.sourceId,value.artifactId,value.args?.sourceId,value.args?.artifactId,value.result?.sourceId,value.result?.artifactId];
  const blocked=inherited||refs.some(id=>id&&denied.has(id));
  const prior=value.priorActionId&&a.data.agentActions.find(row=>row.id===value.priorActionId);
  const baselineBlocked=!!(value.baseline&&(denied.has(value.baseline.sourceId)||denied.has(prior?.result?.sourceId)));
  for(const [key,child]of Object.entries(value)){
   if(blocked&&bodyFields.has(key))value[key]=Array.isArray(child)?[]:typeof child==='string'?'':null;
   else visit(child,blocked||key==='baseline'&&baselineBlocked);
  }
  if(blocked&&(Object.hasOwn(value,'content')||Object.hasOwn(value,'body')))value.accessPolicyQuarantined=true;
 }
 visit(state);return state;
}
module.exports={sanitize};
