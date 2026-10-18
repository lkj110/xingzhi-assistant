'use strict';
const {hash}=require('./evidence-basis.cjs');
const items=require('./evidence-item-lifecycle.cjs');
const rows=v=>Array.isArray(v)?v:[];
const METHOD='platform-chunks-v2';
const fail=reason=>({eligible:false,reason});
function familyKey(job,operation){
 const ops=items.operations(job),seen=new Set();let root=operation;
 while(root?.originOperationId||root?.previousOperationId){
  if(seen.has(root.id))return null;seen.add(root.id);
  const id=root.originOperationId||root.previousOperationId,next=ops.find(o=>o.id===id);
  if(!next)return root.familyKey||null;root=next;
 }
 return root?.id?hash({version:1,jobId:job.id,originOperationId:root.id,principal:root.principal||null,scope:root.scope,projectId:root.projectId||null,permissionRevision:root.permissionRevision??0,query:require('./platform-boundaries.cjs').canonicalQuery(root.requestedQuery||root.query)}):null;
}
function claims(job,op){const key=familyKey(job,op);return Object.values(job.executionState?.evidenceMethodAttempts||{}).filter(c=>c.familyKey===key||c.proof?.operation?.id===op.id||c.originOperationId===op.id);}
function localSnapshot(op){
 const response=rows(op.responses).findLast(r=>r.retained&&r.data&&require('./evidence-storage-method.cjs').sameQuery(r.query,op.actualQuery||op.query));
 if(!response)return null;
 if(hash(response.data)!==response.dataHash)throw Object.assign(Error('原回执完整性校验失败'),{code:'LOCAL_RESULT_INTEGRITY'});
 return {operation:response.query.op,region:response.query.region||'sg',query:structuredClone(response.query),queriedAt:response.receivedAt,data:structuredClone(response.data)};
}
function evaluate(a,job,task,episode,need,view){
 const method=require('./evidence-storage-method.cjs'),q=need?.query;
 if(!q||need.kind!=='physical_lineage'||need.reason!=='missing_own_center'||q.op!=='table_lineage')return fail('UNSUPPORTED_STORAGE_METHOD');
 const check=method.permitted(a,job,task,q);if(!check)return fail('EVIDENCE_METHOD_GUARDED');
 if(episode?.taskId!==task.id||episode.intentBasis!==view.intent)return fail('REQUIREMENT_CHANGED');
 if(!view.needs.some(n=>method.sameQuery(n.query,q)&&n.obligationId===need.obligationId&&rows(need.rootIds).every(r=>n.rootIds.includes(r))))return fail('CURRENT_TYPED_GAP_MISSING');
 const ops=items.operations(job).filter(o=>method.sameQuery(o.requestedQuery||o.query,q)&&hash(o.principal||null)===hash(job.platformPrincipal||null)&&o.scope===job.dataPlatform&&o.projectId===(job.projectId||null)&&(o.permissionRevision??0)===(job.executionState?.permissionRevision||0));
 for(const op of ops){if(op.status==='done'){try{const source=items.readableSource(a,job,op);if(source)return {...fail('COMPLETE_SOURCE_REUSABLE'),mode:'reuse',sourceId:source.id,operationId:op.id};}catch{return fail('LOCAL_RESULT_INTEGRITY');}}}
 const origins=ops.filter(o=>!o.originOperationId&&!o.familyKey&&!o.methodClaimId&&!o.method&&o.status==='failed'&&['INVALID_PLATFORM_RESPONSE','LOCAL_RESULT_STORAGE'].includes(o.errorCode)&&o.receipt?.diagnostics?.stage==='storage'&&['structural_limit','snapshot_limit','archive_limit'].includes(o.receipt.diagnostics.reason));
 if(origins.length!==1)return fail('TYPED_STORAGE_ORIGIN_MISSING_OR_AMBIGUOUS');
 const op=origins[0],d=op.receipt.diagnostics,family=familyKey(job,op);
 if(claims(job,op).some(c=>!['done','failed'].includes(c.status)))return fail('STORAGE_FAMILY_UNRESOLVED');
 if(claims(job,op).some(c=>c.method===METHOD))return fail('STORAGE_FAMILY_METHOD_CONSUMED');
 if(ops.some(o=>o.id!==op.id&&Date.parse(o.startedAt)>=Date.parse(op.startedAt)))return fail('LATER_FAMILY_OPERATION_EXISTS');
 if(!Number.isSafeInteger(d.rawBytes)||d.rawBytes<=0||d.rawBytes>16000000||!(/^[a-f0-9]{64}$/).test(d.rawSha256)||d.stdoutComplete===false||op.receipt.dispatched!==true||op.receipt.operationId!==op.id||op.sourceId)return fail('COMPLETE_RESPONSE_UNPROVEN');
 if(op.policy!==hash({policyId:check.policyId,grantRevision:check.grantRevision})||!require('./operation-ledger.cjs').valid(job,op,a))return fail('STORAGE_ORIGIN_SCOPE_CHANGED');
 try{const snapshot=localSnapshot(op);if(snapshot)return {...fail('LOCAL_REPROCESS_REQUIRED'),mode:'local',operationId:op.id,familyKey:family};}catch{return fail('LOCAL_RESULT_INTEGRITY');}
 if(op.responses?.length||op.observations?.some(o=>o.data)||op.responseReceipt?.retained)return fail('RETAINED_CONTENT_REQUIRES_RECONCILIATION');
 if(!require('./evidence-legacy-preflight.cjs').verifyBaseline(require('./evidence-legacy-preflight.cjs').baselineFor(a)))return fail('SOURCE_ADAPTER_MISMATCH');
 const matches=[];
 for(const {run,step} of view.steps){
  const dispatch=step.dispatch,ac=step.evidenceAcquisition;
  if(!dispatch||run.jobId!==job.id||dispatch.runId!==run.id||dispatch.jobId!==job.id||dispatch.id!==step.id||dispatch.stepId!==step.id||dispatch.taskId!==task.id||step.args?.taskId!==task.id||dispatch.argsHash!==hash(step.args)||ac?.taskId!==task.id||!['done','paused','failed','interrupted'].includes(run.status))continue;
  const old=job.executionState.continuation?.episodes?.[ac.episodeBasis];if(old?.intentBasis!==view.intent)continue;
  const requests=rows(dispatch.requests).filter(r=>method.sameQuery(r.query,q));
  if(requests.length!==1||!(Date.parse(op.startedAt)<=Date.parse(requests[0].at)&&Date.parse(requests[0].at)<=Date.parse(op.completedAt)&&Date.parse(op.completedAt)<=Date.parse(run.finishedAt)))continue;
  const results=rows(step.result?.results).filter(r=>r.operationId===op.id&&method.sameQuery(r.query,q));
  if(results.length!==1||results[0].sourceId||results[0].reused||hash(results[0].receipt)!==hash(op.receipt))continue;
  const targets=rows(ac.targets).filter(n=>method.sameQuery(n.query,q));if(targets.length!==1)continue;
  const previousAttempt=old.evidenceAcquisition?.attempts?.[method.attemptKey(targets[0])];
  if(!previousAttempt||previousAttempt.status!=='failed'||Date.parse(previousAttempt.at)>Date.parse(op.startedAt)||Date.parse(previousAttempt.finishedAt)<Date.parse(op.completedAt))continue;
  matches.push({operation:structuredClone(op),previousAttempt:structuredClone(previousAttempt),runId:run.id,stepId:step.id,dispatchHash:hash(dispatch),episodeBasis:old.basis,requestBasis:ac.requestBasis,target:structuredClone(targets[0]),result:structuredClone(results[0])});
 }
 if(matches.length!==1)return fail('STORAGE_BOUNDARY_PROOF_MISSING_OR_AMBIGUOUS');
 return {eligible:true,reason:'TYPED_STORAGE_METHOD',method:METHOD,familyKey:family,originOperationId:op.id,claimKey:hash({familyKey:family,method:METHOD}),proof:matches[0]};
}
module.exports={METHOD,familyKey,claims,localSnapshot,evaluate};
