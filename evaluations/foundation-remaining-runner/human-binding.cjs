'use strict';
const assert=require('node:assert/strict'),binding=require('../foundation-business-runner/binding.cjs');
function selection(data,taskId,kind,{caseId,stage}){
 const task=data.tasks.find(t=>t.id===taskId);assert.ok(task);
 const value={kind,taskId,caseId,stage,contentHash:binding.content(data,taskId),reportHash:task.grounding.reportHash,basis:task.grounding.basis};
 validate(data,value);return value;
}
function validate(data,value){
 assert.ok(['confirm','recheck','accept'].includes(value.kind));assert.ok(['F05-jianping-revision','F06-yunshu-restart'].includes(value.caseId));assert.ok(['initial','revision'].includes(value.stage));
 const task=data.tasks.find(t=>t.id===value.taskId);assert.ok(task);assert.ok(!task.acceptedAt);
 binding.unchanged(value.contentHash,data,value.taskId);assert.equal(task.grounding.reportHash,value.reportHash);assert.equal(task.grounding.basis,value.basis);
 if(value.kind==='accept'){assert.equal(task.status,'review');assert.equal(task.grounding.passed,true);assert.equal(task.verification.passed,true);}
 else{assert.equal(task.status,'waiting');assert.equal(task.markerReviewHold.reportHash,value.reportHash);assert.equal(task.grounding.reviewDisposition,'marker_confirmation');
  if(value.kind==='recheck'){const c=task.groundingMarkerConfirmation;assert.equal(c.actor,'user');assert.equal(c.reportHash,value.reportHash);assert.equal(c.basis,value.basis);assert.ok(c.recordHash&&c.confirmedAt);}
 }
 return true;
}
module.exports={selection,validate};
