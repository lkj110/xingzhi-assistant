'use strict';
const {hash}=require('./evidence-basis.cjs');
const proof=require('./platform-operation-proof.cjs');
const platform=require('./data-platform.cjs');
const rows=v=>Array.isArray(v)?v:[];
function action(operation,task){return {tool:'recover_platform_result',args:{operationId:operation.id,...(task?{taskId:task.id}:{})},reason:'从已持久化原响应恢复本地来源，不重新查询平台',controlled:true,continuation:true};}
function candidates(a,job,task,episode){
 if(task.evidenceRequest?.kind!=='needs_evidence'||episode.evidenceAcquisition?.requestBasis!==task.evidenceRequest.basis)return [];
 const attempts=Object.values(episode.evidenceAcquisition?.attempts||{});
 return Object.values(job.executionState?.operations||{}).filter(op=>rows(op.responses).length&&op.status!=='done'&&attempts.some(v=>v.operationId===op.id&&v.attemptId===op.attemptId&&v.logicalKey===op.logicalKey)).flatMap(op=>{
  try{proof.local(a,job,op.id,{taskId:task.id});return [action(op,task)];}catch{return [];}
 });
}
function execute(a,job,args){
 const retained=proof.local(a,job,args.operationId,{taskId:args.taskId}),op=retained.operation;
 if(retained.completed)return {operationId:op.id,sourceId:retained.completed.source.id,localRecovered:true,reused:true,storageValidation:retained.completed.validation,...require('./documents.cjs').summary(retained.completed.source,12000)};
 const snapshot=platform.prepareSnapshot(job,retained.receipt.query,structuredClone(retained.receipt.data),{queriedAt:retained.receipt.receivedAt,storageScope:{operationId:op.id}});
 const stored=platform.splitPlatformSnapshot(snapshot),content=JSON.stringify(stored.snapshot,null,2);
 const requestKey=JSON.stringify(require('./platform-boundaries.cjs').canonicalQuery(snapshot.query)),identity=`platform:${job.platformPrincipal||'unverified'}:${requestKey}`;
 const previous=a.data.sources.find(s=>s.platformSnapshot&&!s.deleted&&!s.projectExcluded&&(s.projectId||null)===(job.projectId||null)&&hash(s.platformPrincipal||null)===hash(job.platformPrincipal||null)&&(()=>{try{return proof.same(JSON.parse(s.content).query,snapshot.query);}catch{return false;}})());
 if(previous&&!require('./protocol-access.cjs').allowedObject(a,'source',previous,job))throw proof.fail('previous_source_access');
 const unchanged=previous&&platform.sameEvidence(previous.content,stored.snapshot,previous,stored.sourceMeta)&&(!JSON.parse(previous.content).platformResult||JSON.parse(previous.content).platformResult.projectionSha256===stored.snapshot.platformResult?.projectionSha256);
 let source;
 // The inherited collection ACL was checked by proof.local. retainCreated
 // therefore adds no separate ACL-file grant that could survive this rollback.
 require('./state-transitions.cjs').commit(a,()=>{
  proof.local(a,job,op.id,{taskId:args.taskId});
  source=unchanged?previous:require('./agent.cjs').source(a,job,previous?.identity||identity,`SG · ${snapshot.query.op} · 本地恢复`,content,{platformSnapshot:true,platformPrincipal:job.platformPrincipal||null,platformQueryKey:requestKey,...stored.sourceMeta});
  if(!job.sourceIds.includes(source.id))job.sourceIds.push(source.id);
  source.lastCheckedAt=retained.receipt.receivedAt;
  if(source.previousSourceId&&!unchanged)require('./evidence-store.cjs').changed(a,job,source);
  op.localRecovery={previousStatus:op.status,previousPhase:op.phase,previousErrorCode:op.errorCode||null,previousError:op.error||null,previousCompletedAt:op.completedAt||null,at:new Date().toISOString()};
  require('./operation-ledger.cjs').finish(a,job,op,source.id);
  require('./recovery.cjs').assertStorageCapacity(a);
 });
 return {operationId:op.id,sourceId:source.id,localRecovered:true,storageValidation:'original_response_verified',...require('./documents.cjs').summary(source,12000)};
}
module.exports={execute,candidates,action};
