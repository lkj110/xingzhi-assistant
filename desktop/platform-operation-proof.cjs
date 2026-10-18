'use strict';
// Shared by completion, cache reads and local recovery. No transport or writes.
const {hash}=require('./evidence-basis.cjs');
const result=require('./platform-result.cjs');
const rows=v=>Array.isArray(v)?v:[];
const same=(a,b)=>!!a&&!!b&&hash(require('./platform-boundaries.cjs').canonicalQuery(a))===hash(require('./platform-boundaries.cjs').canonicalQuery(b));
const fail=reason=>Object.assign(Error('平台原回执与来源完整性证明不一致'),{code:'LOCAL_RESULT_INTEGRITY',stopBatch:true,reason,diagnostics:{stage:'storage',reason:'archive_integrity'}});
const sourceHash=s=>hash({content:s.content,archive:s.platformArchive||null,version:s.version||1});
function retainIdentity(a,job,op,snapshot){
 if(op.query?.op!=='identity'||snapshot.query?.op!=='identity')throw fail('identity_query');
 const at=Date.parse(snapshot.queriedAt),matches=Object.values(job.executionState?.identityPreflights||{}).flat().filter(v=>v.status==='done'&&Date.parse(v.startedAt)<=at&&at<=Date.parse(v.finishedAt)&&Date.parse(v.finishedAt)<=Date.parse(op.startedAt)),preflight=matches[0];
 if(matches.length!==1||!preflight?.requestId)throw fail('identity_preflight_missing_or_ambiguous');
 // Called only with the runtime-held batch.identity by ledger.fetch. This is
 // the already completed identity request, not a synthetic business boundary.
 require('./state-transitions.cjs').commit(a,()=>{
  const data=structuredClone(snapshot.data),dataHash=hash(data);
  preflight.responseHash ||= dataHash;
  if(preflight.responseHash!==dataHash)throw fail('identity_response_changed');
  op.identityResponse={preflightId:preflight.id,requestId:preflight.requestId,data,dataHash,query:structuredClone(snapshot.query),retained:true,receivedAt:snapshot.queriedAt};
  op.status='receipt';op.phase='receipt';require('./recovery.cjs').assertStorageCapacity(a);
 });
}
function identityProof(job,op,receipt=op.identityResponse){
 const p=Object.values(job.executionState?.identityPreflights||{}).flat().find(v=>v.id===receipt?.preflightId);
 if(!p||p.status!=='done'||p.requestId!==receipt.requestId||p.responseHash!==receipt.dataHash||!same(receipt.query,op.query)||op.query.op!=='identity')throw fail('identity_preflight_binding');
 return {version:1,kind:'identity_preflight',operationId:op.id,attemptId:op.attemptId,logicalKey:op.logicalKey,preflightId:p.id,requestId:p.requestId,query:structuredClone(receipt.query),dataHash:receipt.dataHash,requestHash:hash(p),receivedAt:receipt.receivedAt};
}
function response(a,job,op){
 if(!op?.id||!op.attemptId||!op.logicalKey)throw fail('operation_identity_missing');
 if(op.identityResponse){
  const receipt=op.identityResponse;
  if(rows(op.requests).length||rows(op.responses).length||!receipt.retained||receipt.dataHash!==hash(receipt.data))throw fail('identity_response_binding');
  return {receipt,proof:identityProof(job,op)};
 }
 const requests=rows(op.requests),responses=rows(op.responses),seen=new Set();
 if(!requests.length||!responses.length)throw fail('retained_response_missing');
 for(const r of requests){
  if(!r.requestId||seen.has(r.requestId)||r.operationId!==op.id||r.attemptId!==op.attemptId||!r.query||r.phase!=='dispatch_started'||!Number.isFinite(Date.parse(r.startedAt||r.at)))throw fail('request_binding');
  seen.add(r.requestId);
  if(r.parentQuery&&!same(r.parentQuery,op.requestedQuery||op.query))throw fail('parent_query_binding');
  if(r.dispatchId){
   const run=rows(a.data.agentRuns).find(v=>v.id===r.runId),step=rows(run?.steps).find(v=>v.id===r.stepId),d=step?.dispatch;
   if(!run||run.jobId!==job.id||!d||d.id!==r.dispatchId||d.jobId!==job.id||d.runId!==run.id||d.stepId!==step.id||d.argsHash!==hash(step.args)||rows(d.requests).filter(v=>v.requestId===r.requestId&&hash(v)===hash(r)).length!==1)throw fail('dispatch_binding');
  }
 }
 const received=new Set();
 for(const r of responses){
  const request=requests.find(v=>v.requestId===r.requestId);
  if(!request||received.has(r.requestId)||r.retained!==true||r.data===undefined||!same(r.query,request.query)||r.dataHash!==hash(r.data)||!Number.isFinite(Date.parse(r.receivedAt))||Date.parse(r.receivedAt)<Date.parse(request.startedAt||request.at))throw fail('response_binding');
  received.add(r.requestId);
 }
 const request=requests.at(-1),matches=responses.filter(r=>r.requestId===request.requestId&&same(r.query,op.actualQuery||op.query));
 if(matches.length!==1)throw fail('final_response_missing');
 const receipt=matches[0];
 for(const entry of require('./evidence-item-lifecycle.cjs').allAttempts(job).filter(v=>v.attemptId===op.attemptId)){
  if(entry.logicalKey!==op.logicalKey||entry.operationId!==op.id||!same(entry.query,op.requestedQuery||op.query)||entry.dispatchId&&entry.dispatchId!==request.dispatchId)throw fail('item_binding');
 }
 return {receipt,request,proof:{version:1,operationId:op.id,attemptId:op.attemptId,logicalKey:op.logicalKey,requestId:request.requestId,query:structuredClone(receipt.query),dataHash:receipt.dataHash,requestHash:hash(request),receivedAt:receipt.receivedAt}};
}
function source(a,job,op,{sourceId=op.sourceId,completion=false}={}){
 const s=rows(a.data.sources).find(v=>v.id===sourceId);
 if(!s||s.deleted||s.projectExcluded||!rows(job.sourceIds).includes(s.id)||hash(s.platformPrincipal||null)!==hash(job.platformPrincipal||null)||hash(op.principal||null)!==hash(job.platformPrincipal||null)||!require('./protocol-access.cjs').allowedObject(a,'source',s,job,null))return null;
 if(rows(a.data.sources).some(v=>v.previousSourceId===s.id&&!v.deleted&&!v.projectExcluded))return null;
 if((s.projectId||null)!==(job.projectId||null))throw fail('source_scope');
 if(!completion&&op.sourceIntegrityHash&&op.sourceIntegrityHash!==sourceHash(s))throw fail('source_hash');
 if(!completion&&op.sourceVersion!==undefined&&op.sourceVersion!==(s.version||1))throw fail('source_version');
 if(!completion&&op.sourceOperationId&&op.sourceOperationId!==s.platformOperationId)throw fail('source_operation');
 let snapshot;try{snapshot=JSON.parse(s.content);}catch{throw fail('source_json');}
 if(!same(snapshot.query,op.actualQuery||op.query)||snapshot.operation!==snapshot.query?.op)throw fail('source_query');
 const binding=s.platformArchive?.binding;
 if(completion&&binding&&(binding.operationId!==(s.platformOperationId||op.id)||binding.scope!==(s.platformScope||op.scope)||binding.permissionRevision!==(s.platformPermissionRevision??op.permissionRevision??0)))throw fail('archive_operation_binding');
 const digest=result.dataDigest(snapshot,s);
 if(completion){
  const original=response(a,job,op);
  if(original.proof.dataHash!==digest)throw fail('original_response_digest');
  return {source:s,snapshot,digest,proof:original.proof,validation:'original_response_verified'};
 }
 if(op.responseProof){
  if(op.receipt?.responseProof&&hash(op.receipt.responseProof)!==hash(op.responseProof))throw fail('receipt_proof_binding');
  const p=op.responseProof,r=rows(op.requests).filter(v=>v.requestId===p.requestId);
  if(p.kind==='identity_preflight'){
   if(hash(identityProof(job,op,p))!==hash(p)||!same(p.query,snapshot.query)||p.dataHash!==digest)throw fail('identity_source_proof');
  }else if(p.version!==1||p.operationId!==op.id||p.attemptId!==op.attemptId||p.logicalKey!==op.logicalKey||r.length!==1||r[0].operationId!==op.id||r[0].attemptId!==op.attemptId||hash(r[0])!==p.requestHash||!same(p.query,snapshot.query)||!same(r[0].query,snapshot.query)||p.dataHash!==digest)throw fail('original_response_proof');
 }else if(op.receipt?.responseProof)throw fail('missing_original_response_proof');
 return {source:s,snapshot,digest,validation:op.responseProof?'original_response_verified':'legacy_unverified',compatibility:op.responseProof?undefined:'original_response_proof_missing'};
}
function local(a,job,operationId,{taskId}={}){
 const ledger=require('./operation-ledger.cjs'),ops=Object.values(job.executionState?.operations||{}),matched=ops.filter(v=>v.id===operationId);
 if(matched.length!==1)throw fail('operation_missing_or_ambiguous');
 const op=matched[0];
 if(job.executionState.operations[op.key]!==op||!ledger.valid(job,op,a)||op.scope!==job.dataPlatform||(op.projectId||null)!==(job.projectId||null)||(op.permissionRevision??0)!==(job.executionState.permissionRevision||0))throw fail('operation_scope');
 if(!['done','failed','running','receipt','interrupted','unknown'].includes(op.status)||op.status==='failed'&&!['LOCAL_RESULT_STORAGE','STORAGE_ERROR','INVALID_PLATFORM_RESPONSE'].includes(op.errorCode)||op.status!=='done'&&op.sourceId)throw fail('operation_not_recoverable');
 if(op.status==='failed'&&op.errorCode==='INVALID_PLATFORM_RESPONSE'&&!(op.receipt?.diagnostics?.stage==='storage'&&['structural_limit','snapshot_limit','archive_limit'].includes(op.receipt.diagnostics.reason)))throw fail('not_local_storage_failure');
 if(taskId!==undefined&&op.taskId!==taskId)throw fail('task_binding');
 const task=op.taskId&&rows(a.data.tasks).find(t=>t.id===op.taskId&&t.agentJobId===job.id&&!t.deletedAt&&!t.agentCancelled);
 if(op.taskId&&!task)throw fail('task_missing');
 require('./execution-gate.cjs').assert(a,{job,task:task||undefined,readOnly:true});
 const check=require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[op.requestedQuery||op.query]});
 if(a.dir&&(!op.policy||op.policy!==hash({policyId:check?.policyId,grantRevision:check?.grantRevision})))throw fail('policy_changed');
 if(a.dir){const policies=require('./access-policy-store.cjs');for(const operation of ['local_retention','local_read'])policies.assert(a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',jobId:job.id},operation});}
 if(op.status==='done'){
  const completed=source(a,job,op);if(!completed||completed.validation!=='original_response_verified')throw fail('completed_source_unproven');
  return {operation:op,completed};
 }
 const retained=response(a,job,op);
 // Recheck the actual child query as well as the original requested query.
 require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[retained.receipt.query]});
 return {operation:op,...retained};
}
module.exports={source,response,local,retainIdentity,sourceHash,same,fail};
