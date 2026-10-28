'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {load,validate,checkReview}=require('./validate.cjs');
// Test-only approvals exercise identity rejection, not semantic judgment.
function approval(v){return {schema:1,reviewer:'independent-subagent',identity:v.identity,approved:true,coverageComplete:true,inputRequirementsComplete:true,references:v.references.map(r=>({...r,qualified:!r.negative,reason:'TEST ONLY: not an actual semantic approval'}))};}

test('complete offline coverage keeps fixed errors invalid and runtime checks unexecuted',()=>{
 const d=load(),v=validate(d);assert.equal(v.requirements,174);assert.equal(v.references.length,8);
 assert.equal(v.semanticProof,false);assert.ok(v.processOnly>=50);
 const r=approval(v);assert.equal(r.references.filter(r=>!r.qualified).length,2);
 assert.equal(checkReview(v,r).readyForLive,false);
});
test('missing description-object binding or a missing stage cannot silently pass',()=>{
 const d=load(),row=d.coverage.bindings.find(r=>r.requirementId==='P01-R02');assert.ok(row);
 d.coverage.bindings=d.coverage.bindings.filter(r=>r!==row);assert.throws(()=>validate(d),/Missing requirement\/stage/);
 const e=load(),stage=e.coverage.bindings.find(r=>r.caseId.startsWith('P03')&&r.stage==='final');e.coverage.bindings=e.coverage.bindings.filter(r=>r!==stage);assert.throws(()=>validate(e),/Missing requirement\/stage/);
});
test('restoring the old object-omitting reference invalidates its bound coverage',()=>{
 const d=load(),r=d.references.find(r=>r.caseId==='P01-qingjia-notice');
 r.title=r.title.replaceAll('低温柜','');r.content=r.content.replaceAll('低温柜','');
 assert.throws(()=>validate(d),/Reference span mismatch|assert/);
});
test('editing the inventory and its bindings together still needs a new independent review',()=>{
 const d=load(),review=approval(validate(d)),c=d.requirements.cases.find(c=>c.id==='P01-qingjia-notice');
 c.requirements=c.requirements.filter(r=>r.id!=='P01-R02');d.coverage.bindings=d.coverage.bindings.filter(r=>r.requirementId!=='P01-R02');
 const changed=validate(d);assert.equal(changed.structuralPassed,true);assert.throws(()=>checkReview(changed,review),/Stale semantic review/);
});
test('input changes and altered coverage reasons invalidate semantic review',()=>{
 for(const change of [d=>{d.inputs[0].fields.description+='不得对外发送。';},d=>{d.coverage.bindings[0].reason+=' changed';}]){
  const d=load(),review=approval(validate(d));change(d);assert.throws(()=>checkReview(validate(d),review),/Stale semantic review/);
 }
});
test('keyword presence and valid spans do not replace an explicit whole-draft approval',()=>{
 const d=load(),v=validate(d),review=approval(v);review.approved=false;assert.throws(()=>checkReview(v,review),/did not approve/);
 const missing=approval(v);missing.references.pop();assert.throws(()=>checkReview(v,missing),/Each whole reference/);
 const wrong=approval(v);wrong.references.find(r=>!r.qualified).qualified=true;assert.throws(()=>checkReview(v,wrong));
});
test('revision obligations cannot be applied to the initial draft',()=>{
 const d=load(),r=d.requirements.cases.find(c=>c.id.startsWith('P03')).requirements.find(r=>r.field==='revision.note');
 r.stages=['initial','final'];assert.throws(()=>validate(d),/retrospectively/);
});
test('textual requirements cannot be hidden as runtime checks or duplicate bindings',()=>{
 const d=load(),row=d.coverage.bindings.find(r=>r.requirementId==='P01-R02');row.disposition='process_only';row.spans=[];
 assert.throws(()=>validate(d),/Unresolved textual coverage/);
 const e=load();e.coverage.bindings.push(structuredClone(e.coverage.bindings[0]));assert.throws(()=>validate(e),/duplicate coverage/);
});
