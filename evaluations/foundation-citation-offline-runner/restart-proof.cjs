'use strict';
// Read-only assertion: allow exactly the first-load legacy binding projection,
// while comparing every other task/source/draft field and existing binding.
const assert=require('node:assert/strict'),{hash}=require('../../desktop/evidence-basis.cjs');
const clone=v=>JSON.parse(JSON.stringify(v));
function snapshot(data,id){const task=data.tasks.find(t=>t.id===id);assert.ok(task);return clone({task,sources:task.sourceIds.map(id=>{const s=data.sources.find(s=>s.id===id);assert.ok(s);return s;}),draft:data.artifacts.find(a=>a.id===task.primaryArtifactId)});}
function preserved(before,after,{stage,startedAt,finishedAt}){
 const fields=['evidenceLinksVersion','contextBindings','supersededSourceIds'],normalized=clone(after);let initialization=false;
 if(fields.every(k=>!Object.hasOwn(before.task,k))&&fields.some(k=>Object.hasOwn(after.task,k))){
  assert.equal(stage,'before-advance');assert.equal(after.task.evidenceLinksVersion,3);assert.deepEqual(after.task.supersededSourceIds,[]);assert.equal(after.task.contextBindings.length,before.sources.length);
  assert.ok(!before.task.contextWithdrawals?.length&&!before.task.withdrawnBindingIds?.length);
  before.sources.forEach((s,i)=>{
   assert.ok(!s.deleted&&!s.deletedAt&&!s.withdrawn&&!s.withdrawnAt&&!s.projectExcluded&&!s.contentDeleted&&!s.deliveryActionId&&s.purpose!=='delivery_readback');
   const b=after.task.contextBindings[i],contentHash=hash(s.content),revisionId=String(s.revisionId??s.remoteRevision??s.version??contentHash);
   const expected={bindingId:'binding:'+hash({taskId:before.task.id,sourceId:s.id,purpose:'input',actionId:null,revisionId}),taskId:before.task.id,sourceId:s.id,resourceKey:s.resourceKey||s.identity||s.url||s.remoteId||s.id,revisionId,purpose:'input',state:'active',provenance:{kind:'legacy_input'},principalScope:s.principalScope??s.platformPrincipal??s.larkOpenId??null,contentHash,createdAt:b.createdAt,bindingRevision:1};
   const at=Date.parse(b.createdAt);assert.ok(Number.isFinite(at)&&at>=startedAt&&at<=finishedAt,'New binding timestamp outside restart');assert.deepEqual(b,expected,'Restart initialized a different evidence binding');
  });
  for(const field of fields)delete normalized.task[field];initialization=true;
 }
 assert.deepEqual(normalized,before,'Restart changed task/source/draft/check');return {preserved:true,legacyBindingInitialization:initialization,beforeIdentity:hash(before),afterIdentity:hash(after)};
}
module.exports={snapshot,preserved};
