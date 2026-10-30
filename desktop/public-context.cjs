// A public projection must not expose a denied snapshot through its cached copies.
const bodyFields=new Set(['content','body','readbackContent','segments','preview','tail','quote','excerpt','text','raw','chunks','outline']);
// Archive bodies are internal storage even when the source is readable. Do not
// let full state, details, histories or exports expose encoded platform data.
function excludePlatformArchives(value){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value)){for(const row of value)excludePlatformArchives(row);return value;}
 if(Object.hasOwn(value,'platformArchive')){delete value.platformArchive;value.platformArchiveOmitted=true;}
 if(value.platformResult&&typeof value.platformResult==='object')delete value.platformResult.archive;
 for(const child of Object.values(value))excludePlatformArchives(child);
 return value;
}
function sanitize(a,state){
 if(!a.requireContextAccessPolicy)return excludePlatformArchives(state);
 return require('./protocol-access.cjs').derivedRead(a,()=>sanitizeOnce(a,state));
}
function sanitizeOnce(a,state){
 excludePlatformArchives(state);
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
  if(!require('./protocol-access.cjs').canReadSnapshot(a,kind,row))denied.add(row.id);
 }
 const userCitations=require('./public-user-citations.cjs').readable(a,state);
 function visit(value,inherited=false){
  if(Array.isArray(value)){for(const row of value)visit(row,inherited);return;}
  if(!value||typeof value!=='object')return;
  const refs=[value.id,userCitations.has(value)?undefined:value.sourceId,value.artifactId,value.args?.sourceId,value.args?.artifactId,value.result?.sourceId,value.result?.artifactId];
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
module.exports={sanitize,excludePlatformArchives};
