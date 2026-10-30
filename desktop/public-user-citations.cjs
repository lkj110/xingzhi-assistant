'use strict';
// User inputs are task-scoped evidence, not source rows. Authorize only exact
// citations in the canonical task report; never whitelist the user:* namespace.
const {hash}=require('./evidence-basis.cjs');
const access=require('./protocol-access.cjs');
const rows=value=>Array.isArray(value)?value:[];
function readable(a,state){
 const allowed=new WeakSet(),tasks=new Map(rows(a.data.tasks).map(t=>[t.id,t]));
 const artifacts=new Map(rows(a.data.artifacts).map(r=>[r.id,r]));
 const sourceIds=new Set(rows(a.data.sources).map(r=>r.id));
 for(const projected of rows(state?.tasks)){
  const task=tasks.get(projected?.id),report=projected?.grounding;
  if(!task||task.projectExcluded||!access.readTaskContext(a,task)||!report||!task.grounding||hash(report)!==hash(task.grounding))continue;
  const inputs=new Map(rows(task.groundingUserInputs).filter(r=>r?.origin==='user'&&['description','objective'].includes(r.field)&&typeof r.text==='string'&&r.text.trim()&&task[r.field]===r.text).map(r=>['user:'+r.field,r.text]));
  for(const claim of rows(report.claims)){
   const artifact=artifacts.get(claim?.artifactId);
   if(!artifact||artifact.taskId!==task.id||!access.canReadSnapshot(a,'artifact',artifact,{task}))continue;
   for(const citation of rows(claim.citations)){
    const body=inputs.get(citation?.sourceId);
    if(typeof body!=='string'||sourceIds.has(citation.sourceId)||(citation.field!==undefined&&citation.field!=='content'))continue;
    const {quote,start,end,version}=citation;
    if(typeof quote!=='string'||!quote.trim()||quote.length>1200||!Number.isSafeInteger(start)||start<0||end!==start+quote.length||body.slice(start,end)!==quote||version!==hash(body))continue;
    allowed.add(citation);
   }
  }
 }
 return allowed;
}
module.exports={readable};
