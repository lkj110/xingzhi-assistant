'use strict';
// Only reached from the offline fixture. Historical bytes are never cleaned up.
const assert=require('node:assert/strict'),historical=require('../../tests/fixtures/foundation-title-contract-f05-20261102.json');
const faults=['title-real-patch','title-corrected-patch'];
function response(call,{corrected=false}={}){
 assert.equal(call.context.id,'F05-jianping-revision');
 for(const source of historical.input.sources){const current=call.context.sources.find(s=>s.title===source.title);assert.ok(current);assert.equal(current.content,source.content);}
 assert.equal(call.context.sources.length,historical.input.sources.length);
 if(call.role==='execute'){
  if(!call.context.revised)return {kind:'artifact',title:historical.initialDraft.title,content:historical.initialDraft.content,summary:'OFFLINE HISTORICAL DRAFT REPLAY'};
  assert.equal(call.payload.revision.originalContent,historical.initialDraft.content);assert.equal(call.payload.revision.note,historical.revisionNote);
  const patch=structuredClone(historical.patch);if(corrected)patch.edits.push({before:'# '+historical.initialDraft.title+'\n\n',after:''});return patch;
 }
 assert.equal(call.role,'verify');const stage=call.context.revised?'revision':'initial',ids=call.payload.groundingReviewRequest.artifactIds;assert.equal(ids.length,1);
 const map=new Map([[historical.originalArtifactIds[stage],ids[0]]]);for(const [id,title]of Object.entries(historical.originalSourceIds))map.set(id,call.context.sources.find(s=>s.title===title).id);
 const replace=v=>Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):map.get(v)||v;
 const result=replace(structuredClone(stage==='initial'?historical.initialVerifier:historical.revisionVerifier));
 assert.deepEqual(result.groundingReview.requirements.map(r=>r.id).sort(),call.payload.groundingChecklist.requirements.map(r=>r.id).sort());return result;
}
// A blocked draft may undergo the same first-load legacy_input v3 projection.
// Reuse the existing exact field/hash/time validator, without widening review-state restart rules.
function blockedRestartPreserved(before,after,options){
 assert.equal(options.mode,'offline');assert.equal(options.stage,'blocked-title-replay');
 for(const value of [before,after]){assert.equal(value.task.status,'blocked');assert.equal(value.task.verification.passed,false);assert.equal(value.task.grounding.passed,true);assert.equal(value.task.verification.bodyStructure.reason,'duplicate-leading-title');assert.equal(value.task.acceptedAt,undefined);}
 const checked=require('../foundation-citation-business-runner/restart-proof.cjs').preserved(before,after,{...options,stage:'before-advance'});
 return {...checked,actualStage:options.stage,projectionContract:'existing-exact-legacy-input-v3-initialization',projectionValidatorStageOnly:'before-advance'};
}
module.exports={response,faults,historical,blockedRestartPreserved};
