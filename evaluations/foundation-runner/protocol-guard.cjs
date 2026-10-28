'use strict';
const assert=require('node:assert/strict');
const modelJSON=require('../../desktop/model-json.cjs');
const {evidenceProtocol}=require('./evidence-protocol.cjs');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v),text=v=>typeof v==='string'&&v.trim().length>0;
function request(messages,payload,context){
 assert.deepEqual(messages.map(m=>m.role),['system','user'],'Unplanned repair messages');
 assert.ok(messages.every(m=>typeof m.content==='string'));
 assert.equal(payload.task.id,context.taskId);assert.equal(payload.task.title,context.title);
 assert.equal(payload.task.description,context.description);assert.equal(payload.task.criteria,context.criteria);
 assert.ok(!payload.revisionRecovery,'Unplanned revision recovery');
 if(payload.task.sourceIds!==undefined)assert.deepEqual([...payload.task.sourceIds].sort(),context.sources.map(s=>s.id).sort());
 const allowed=new Map(context.sources.map(s=>[s.id,s]));
 for(const s of payload.sources||[]){assert.ok(allowed.has(s.id),'Foreign source');if(s.content!==undefined)assert.equal(s.content,allowed.get(s.id).content);}
 for(const s of payload.sourceCatalog||[]){if(s.type==='source'&&s.purpose==='input')assert.ok(allowed.has(s.id),'Foreign source catalog');}
 for(const r of payload.contextReads||[]){const s=r.result;if(s?.sourceId){assert.ok(allowed.has(s.sourceId),'Foreign context read');if(typeof s.content==='string')assert.ok(allowed.get(s.sourceId).content.includes(s.content),'Source text changed');}}
 if(payload.revision){assert.equal(context.revised,true);assert.equal(payload.revision.note,context.revisionNote);}
}
function response(raw,{payload,role}){
 const envelope=modelJSON.parse(raw);assert.ok(object(envelope));assert.deepEqual(Object.keys(envelope),['response_json']);assert.equal(typeof envelope.response_json,'string');
 const r=modelJSON.subscription(raw);assert.ok(object(r),'Application JSON object required');
 if(r.kind==='read_context'||r.tool==='read_context'){
  const requests=r.requests??r.args?.requests;assert.ok(Array.isArray(requests)&&requests.length>=1&&requests.length<=4);
  for(const q of requests)assert.ok(object(q)&&['read_source','search_source','read_section','read_artifact','read_segment','list_sources'].includes(q.tool),'Unsupported context action');return r;
 }
 if(role==='verify'){
  if(r.retryFull===true){assert.ok(payload.previousCheck,'Full expansion only after incremental request');return r;}
  assert.equal(typeof r.passed,'boolean');assert.equal(typeof r.summary,'string');assert.ok(Array.isArray(r.gaps)&&r.gaps.every(s=>typeof s==='string'));
  assert.ok(r.summary.trim());assert.ok(!r.passed||r.gaps.every(s=>!s.trim()),'Contradictory verification result');
  if(payload.groundingReviewRequest?.reused===true)return r;
  evidenceProtocol(r.groundingReview);
  // Semantic support, exact quotes and active evidence bindings remain owned by the frozen verifier.
  return r;
 }
 if(['need_input','wait','needs_evidence','needs_replan'].includes(r.kind))return r;
 if(payload.revision){
  assert.equal(r.kind,'patch','Unplanned full rewrite');assert.ok(Array.isArray(r.edits)&&r.edits.length>=1&&r.edits.length<=12);
  const original=payload.revision.originalContent;
  const ranges=r.edits.map(e=>{assert.ok(object(e)&&text(e.before)&&e.before.length<=12000&&typeof e.after==='string'&&e.after.length<=25000&&e.before!==e.after);const start=original.indexOf(e.before);assert.ok(start>=0&&original.indexOf(e.before,start+1)<0,'Patch must uniquely bind original');return {start,end:start+e.before.length,after:e.after};}).sort((a,b)=>a.start-b.start);
  assert.ok(ranges.every((r,i)=>!i||r.start>=ranges[i-1].end),'Overlapping patch');let value=original;for(const r of [...ranges].reverse())value=value.slice(0,r.start)+r.after+value.slice(r.end);assert.ok(text(value)&&value.length<=100000);return r;
 }
 assert.equal(r.kind,'artifact');assert.ok(text(r.content)&&text(r.title));return r;
}
module.exports={request,response};
