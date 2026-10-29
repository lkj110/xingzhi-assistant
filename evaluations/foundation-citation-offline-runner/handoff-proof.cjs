'use strict';
// Read-only evaluator proof. Never adds an authorization or changes product state.
const assert=require('node:assert/strict'),{hash}=require('../../desktop/evidence-basis.cjs');
const clone=v=>JSON.parse(JSON.stringify(v));
function before(task){return clone({taskId:task.id,report:task.grounding,finalizations:task.contextFinalizations||{},authorizations:task.markerRechecks||{}});}
function after(prior,task){
 const c=task.groundingMarkerConfirmation,r=prior.report;assert.equal(task.id,prior.taskId);assert.equal(c.actor,'user');assert.equal(c.basis,r.basis);assert.equal(c.reportHash,r.reportHash);assert.equal(c.recordHash,hash({...c,recordHash:undefined}));
 assert.equal(task.grounding.passed,true);assert.equal(task.verification.passed,true);assert.equal(task.grounding.basis,r.basis);assert.equal(task.grounding.humanMarkerConfirmation,c.recordHash);
 const binding={taskId:task.id,phase:r.phase,basis:r.basis,reportHash:r.reportHash,confirmationHash:c.recordHash},id=hash(binding),record=task.markerRechecks?.[id];assert.ok(record);for(const [k,v]of Object.entries(binding))assert.equal(record[k],v);assert.equal(record.id,id);assert.ok(['started','finished'].includes(record.status));
 for(const [k,v]of Object.entries(prior.authorizations))assert.deepEqual(task.markerRechecks[k],v,'Old authorization changed');
 assert.deepEqual(Object.keys(task.markerRechecks).filter(k=>!Object.hasOwn(prior.authorizations,k)),[id],'More than one authorization for one confirmation');
 const now=task.contextFinalizations||{};for(const [k,v]of Object.entries(prior.finalizations))assert.deepEqual(now[k],v,'Old bounded record changed');
 const added=Object.entries(now).filter(([k])=>!Object.hasOwn(prior.finalizations,k)).map(([,r])=>r);assert.ok(added.length<=1);for(const r of added)assert.equal(r.basis.markerRecheck,id);
 const ordinary=b=>{const v={...b};delete v.markerRecheck;return hash(v);};
 const collision=added.some(n=>Object.values(prior.finalizations).some(o=>o.basis&&ordinary(o.basis)===ordinary(n.basis)));
 return {authorizationId:id,newAuthorizationCount:1,oldRecordsPreserved:true,boundedFinalizationObserved:added.length===1,priorBoundedSameBasisObserved:collision,phase:r.phase};
}
module.exports={before,after};
