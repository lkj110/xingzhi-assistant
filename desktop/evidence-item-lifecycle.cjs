'use strict';
const {randomUUID}=require('node:crypto');
const {hash}=require('./evidence-basis.cjs');
const {canonicalQuery}=require('./platform-boundaries.cjs');
const rows=v=>Array.isArray(v)?v:[];
const now=()=>new Date().toISOString();
const same=(a,b)=>!!a&&!!b&&hash(canonicalQuery(a))===hash(canonicalQuery(b));
const selected=new WeakMap();
const BACKOFF=Object.freeze([15000,60000,180000]);
function logicalKey(job,task,query){return hash({jobId:job.id,taskId:task?.id||null,principal:job.platformPrincipal||null,permissionRevision:job.executionState?.permissionRevision||0,intent:task?require('./continuation-control.cjs').intentBasis(job,task):require('./operation-ledger.cjs').epoch(job),query:canonicalQuery(query)});}
function allAttempts(job){return Object.values(job.executionState?.continuation?.episodes||{}).flatMap(e=>[...rows(e.evidenceAcquisition?.attemptHistory),...Object.values(e.evidenceAcquisition?.attempts||{})]);}
function operations(job){const map=new Map();for(const o of [...rows(job.executionState?.history),...Object.values(job.executionState?.operations||{})])if(o.id)map.set(o.id,o);return [...map.values()];}
function transientCount(job,key){return operations(job).filter(o=>o.logicalKey===key&&o.status==='failed'&&o.errorCode==='TRANSIENT').length;}
function retryDecision(count,at,time=Date.now()){
 if(count>=BACKOFF.length)return {action:'diagnose',reason:'TRANSIENT_EXHAUSTED'};
 const retryAt=Date.parse(at)+BACKOFF[Math.max(0,count-1)];
 return retryAt>time?{action:'wait_until',reason:'TRANSIENT_BACKOFF',retryAt:new Date(retryAt).toISOString()}:{action:'execute',reason:'retry_due'};
}
function activeAttempt(a,job,query){
 const live=selected.get(a),step=require('./dispatch-lifecycle.cjs').currentStep(a,job)||(live?.job===job?live.step:null),ac=step?.evidenceAcquisition;
 if(!ac)return null;
 const work=job.executionState?.continuation?.episodes?.[ac.episodeBasis]?.evidenceAcquisition;
 const found=Object.values(work?.attempts||{}).filter(v=>v.attemptId&&rows(ac.attemptIds).includes(v.attemptId)&&same(v.query,query));
 if(new Set(found.map(v=>v.attemptId)).size>1||new Set(found.map(v=>v.operationId).filter(Boolean)).size>1)throw Object.assign(Error('请求对应多个逐项领取身份'),{code:'EVIDENCE_IDENTITY_CONFLICT'});
 return found[0]||null;
}
function claimInCommit(job,task,entry,step){
 const key=logicalKey(job,task,entry.query),identities=step.evidenceAcquisition.identities ||= {};
 const identity=identities[key] ||= {attemptId:randomUUID(),logicalKey:key,rootIds:[],obligationIds:[]};
 identity.rootIds=[...new Set([...identity.rootIds,...rows(entry.rootIds)])];
 identity.obligationIds=[...new Set([...identity.obligationIds,entry.obligationId].filter(Boolean))];
 Object.assign(entry,{attemptId:identity.attemptId,logicalKey:key,phase:'prepared',status:'started',dispatchId:step.dispatch?.id||null,runId:step.dispatch?.runId||null,stepId:step.id||null});
 step.evidenceAcquisition.attemptIds=[...new Set([...rows(step.evidenceAcquisition.attemptIds),entry.attemptId])];
}
function bindOperationInCommit(job,attempt,operation){
 const targets=Object.values(job.executionState?.continuation?.episodes||{}).flatMap(e=>Object.values(e.evidenceAcquisition?.attempts||{})).filter(v=>v.attemptId===attempt.attemptId);
 if(!targets.includes(attempt)||targets.some(v=>v.logicalKey!==attempt.logicalKey||!same(v.query,attempt.query)||v.operationId&&v.operationId!==operation.id))throw Object.assign(Error('逐项准备操作身份冲突'),{code:'EVIDENCE_IDENTITY_CONFLICT',stopBatch:true});
 for(const target of targets)target.operationId=operation.id;
}
function readableSource(a,job,op){
 if(!op)return null;
 return require('./platform-operation-proof.cjs').source(a,job,op)?.source||null;
}

// A dispatch can be durable before its operation replacement commits. Keep
// the exact prepared predecessor as a recoverable handoff, never as a generic
// exception for unsettled operations. Recheck every retained boundary proof on
// a cold start; a changed proof, missing link or business request closes it.
function retainedPreparedPredecessor(a,job,attempt,claim,operation,seen){
 let current=attempt;
 const visited=new Set();
 while(current.continuedFromAttemptId){
  const id=current.continuedFromAttemptId;
  if(visited.has(id)||seen.has(id))return false;
  visited.add(id);
  const entries=allAttempts(job).filter(v=>v.attemptId===id),previous=entries[0];
  const links=rows(claim.preparedContinuations).filter(v=>v.attemptId===id),link=links[0];
  if(!previous||links.length!==1||previous.methodClaimKey!==claim.key||previous.logicalKey!==attempt.logicalKey||!same(previous.query,attempt.query)||link.dispatch?.id!==previous.dispatchId)return false;
  const matches=operations(job).filter(o=>o.id===link.proof?.operationId),old=matches[0];
  if((link.proof?.operationId?matches.length!==1:matches.length!==0)||(link.operationId||null)!==(old?.id||null))return false;
  const fresh=zeroBoundaryProof(a,job,previous,old,new Set([...seen,attempt.attemptId]));
  if(!fresh.eligible||hash(fresh.proof)!==hash(link.proof))return false;
  if(old?.id===operation.id)return true;
  current=previous;
 }
 return false;
}
function zeroBoundaryProof(a,job,attempt,op,seen=new Set()){ 
 const reject=(reason,phase='unresolved')=>({eligible:false,phase,reason,op});
 if(!attempt?.attemptId||!attempt.logicalKey||!attempt.runId||!attempt.stepId||!attempt.dispatchId)return reject('ATTEMPT_IDENTITY_UNPROVEN');
 if(seen.has(attempt.attemptId))return reject('PREPARED_HANDOFF_CYCLE');
 const entries=allAttempts(job).filter(v=>v.attemptId===attempt.attemptId);
 const operationId=attempt.operationId||op?.id;
 if(!entries.length||entries.some(v=>v.logicalKey!==attempt.logicalKey||v.runId!==attempt.runId||v.stepId!==attempt.stepId||v.dispatchId!==attempt.dispatchId||!same(v.query,attempt.query)||v.operationId&&v.operationId!==operationId))return reject('ATTEMPT_IDENTITY_CONFLICT');
 if(entries.some(v=>!['prepared','queued'].includes(v.phase)||v.sourceId||v.reusedOperationId))return reject('ATTEMPT_STATE_UNPROVEN','unknown');
 const ledger=require('./operation-ledger.cjs'),allOps=[...rows(job.executionState?.history),...Object.values(job.executionState?.operations||{})];
 const related=allOps.filter(o=>operationId&&o.id===operationId||o.attemptId===attempt.attemptId);
 if(op){
  if(op.status!=='prepared'||op.phase!=='prepared'||op.id!==operationId||!entries.some(v=>v.operationId===op.id)||op.attemptId!==attempt.attemptId||op.logicalKey!==attempt.logicalKey||op.key!==ledger.key(job,op.query)||!same(op.requestedQuery||op.query,attempt.query)||!ledger.valid(job,op,a))return reject('OPERATION_IDENTITY_UNPROVEN');
  if(related.some(o=>hash(o)!==hash(op))||Object.values(job.executionState?.operations||{}).filter(o=>o.id===op.id).length!==1||job.executionState.operations[op.key]!==op)return reject('OPERATION_HISTORY_CONFLICT');
  if(op.requests!==undefined&&!Array.isArray(op.requests)||rows(op.requests).length||op.responses!==undefined||op.receipt||op.sourceId||op.actualQuery)return reject('RECONCILE_ORIGINAL_REQUEST','unknown');
  const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[attempt.query]});
  if(!check.allowed||op.policy!==hash({policyId:check.policyId,grantRevision:check.grantRevision}))return reject('OPERATION_POLICY_MISMATCH');
 }else if(attempt.operationId||related.length)return reject('OPERATION_IDENTITY_UNPROVEN');
 const method=require('./evidence-storage-method.cjs'),claim=attempt.methodClaimKey&&job.executionState?.evidenceMethodAttempts?.[attempt.methodClaimKey],task=claim&&a.data.tasks?.find(t=>t.id===claim.taskId);
 const claimDispatch=claim?.dispatch?.id===attempt.dispatchId||rows(claim?.preparedContinuations).some(c=>c.attemptId===attempt.attemptId&&c.dispatch?.id===attempt.dispatchId&&c.proof?.operationId===(op?.id||null)&&c.proof.operationHash===(op?hash(op):null));
 const claimedOrigin=claim?.status==='started'&&task&&claim.key===attempt.methodClaimKey&&claimDispatch&&hash(claim.scope)===hash(method.scope(job))&&same(claim.query,attempt.query)&&method.currentClaim(a,job,task,claim)&&(!op||op.methodClaimId===claim.key&&op.originOperationId===(claim.originOperationId||claim.proof?.operation?.id))?claim.proof?.operation:null;
 if(ledger.unsettledForQuery(job,attempt.query).some(o=>o.id!==op?.id&&(!claimedOrigin||hash(o)!==hash(claimedOrigin)&&!retainedPreparedPredecessor(a,job,attempt,claim,o,seen))))return reject('CONTRADICTORY_UNSETTLED_OPERATION','unknown');
 const runs=rows(a.data.agentRuns).filter(r=>r.id===attempt.runId),steps=runs.flatMap(r=>rows(r.steps)).filter(s=>s.id===attempt.stepId),step=steps[0],d=step?.dispatch,ac=step?.evidenceAcquisition;
 if(runs.length!==1||runs[0].jobId!==job.id||steps.length!==1||d?.id!==attempt.dispatchId||d.id!==step.id||d.stepId!==step.id||d.runId!==runs[0].id||d.jobId!==job.id||d.taskId!==ac?.taskId||d.taskId!==step.args?.taskId||step.tool!=='platform_query'||d.tool!==step.tool||d.argsHash!==hash(step.args)||d.requestSchema!==2||!Array.isArray(d.requests))return reject('BOUNDARY_LOG_UNPROVEN');
 const identity=ac.identities?.[attempt.logicalKey];
 if(!identity||identity.attemptId!==attempt.attemptId||identity.logicalKey!==attempt.logicalKey||rows(ac.attemptIds).filter(id=>id===attempt.attemptId).length!==1||!rows(step.args.queries).some(q=>same(q,attempt.query))||!rows(ac.targets).some(n=>same(n.query,attempt.query))||op&&op.taskId!==d.taskId)return reject('DISPATCH_ATTEMPT_MISMATCH');
 const allSteps=rows(a.data.agentRuns).flatMap(r=>rows(r.steps));
 if(allSteps.filter(s=>s.dispatch?.id===d.id||rows(s.evidenceAcquisition?.attemptIds).includes(attempt.attemptId)).length!==1)return reject('DISPATCH_AMBIGUOUS');
 for(const s of allSteps)for(const r of rows(s.dispatch?.requests)){
  if(r.attemptId===attempt.attemptId||op&&r.operationId===op.id||s===step&&r.query?.op!=='identity'&&same(r.parentQuery||r.query,attempt.query))return reject('RECONCILE_ORIGINAL_REQUEST','unknown');
 }
 const requestIds=new Set();
 for(const r of d.requests){
  if(!r.requestId||requestIds.has(r.requestId)||r.dispatchId!==d.id||r.runId!==d.runId||r.stepId!==d.stepId||!r.query?.op||r.phase!=='dispatch_started'||!Number.isFinite(Date.parse(r.at||r.startedAt)))return reject('BOUNDARY_LOG_UNPROVEN');
  requestIds.add(r.requestId);
  if(r.query.op!=='identity'&&(!r.attemptId||!r.operationId||!rows(ac.attemptIds).includes(r.attemptId)))return reject('BOUNDARY_LOG_UNPROVEN');
 }
 return {eligible:true,phase:'queued',reason:'DURABLE_PREPARED_WITH_ZERO_BOUNDARIES',op,proof:{version:1,jobId:job.id,taskId:d.taskId,runId:d.runId,stepId:step.id,dispatchId:d.id,attemptId:attempt.attemptId,logicalKey:attempt.logicalKey,operationId:op?.id||null,dispatchHash:hash(d),attemptsHash:hash(entries),operationHash:op?hash(op):null}};
}
function inspect(a,job,attempt){
 if(!attempt.attemptId)return {phase:'unresolved',reason:'LEGACY_ATTEMPT_ID_MISSING'};
 const reused=attempt.reusedOperationId;
 const matched=operations(job).filter(o=>reused?o.id===reused:o.attemptId===attempt.attemptId&&o.logicalKey===attempt.logicalKey);
 if(matched.length>1)return {phase:'unresolved',reason:'MULTIPLE_OPERATIONS'};
 const op=matched[0];
 if(reused&&!op)return {phase:'unresolved',reason:'REUSED_OPERATION_MISSING'};
 if(reused&&!['done','failed'].includes(op.status))return {phase:'unknown',op,reason:'REUSED_OPERATION_UNSETTLED'};
 if(op&&attempt.operationId&&op.id!==attempt.operationId)return {phase:'unresolved',reason:'OPERATION_ID_MISMATCH'};
 if(op&&job.executionState.operations?.[op.key]!==op&&op.status!=='superseded')return {phase:'unresolved',reason:'OPERATION_SLOT_MISMATCH'};
 if(op&&op.key!==require('./operation-ledger.cjs').key(job,op.query))return {phase:'unresolved',reason:'OPERATION_KEY_MISMATCH'};
 if(op&&!same(op.requestedQuery||op.query,attempt.query)&&!(reused&&same(op.actualQuery||op.query,attempt.query)))return {phase:'unresolved',reason:'OPERATION_QUERY_MISMATCH'};
 if(reused&&attempt.sourceId&&attempt.sourceId!==op.sourceId)return {phase:'unresolved',reason:'REUSED_SOURCE_MISMATCH'};
 if(op&&!require('./operation-ledger.cjs').valid(job,op,a))return {phase:'unresolved',reason:'OPERATION_SCOPE_CHANGED'};
 if(op&&a.dir){const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[attempt.query]});if(!check.allowed||op.policy!==hash({policyId:check.policyId,grantRevision:check.grantRevision}))return {phase:'unresolved',reason:'OPERATION_POLICY_MISMATCH'};}
 if(op?.status==='done'){
  try{const source=readableSource(a,job,op);if(source)return {phase:'persisted',op,source};}catch(error){return {phase:'unresolved',op,reason:error.code||'LOCAL_RESULT_INTEGRITY'};}
  return {phase:'unresolved',op,reason:'SOURCE_UNAVAILABLE'};
 }
 if(op?.status==='failed')return {phase:'failed',op};
 if(rows(op?.requests).length||['dispatched','receipt','unknown'].includes(attempt.phase))return {phase:'unknown',op,reason:'RECONCILE_ORIGINAL_REQUEST'};
 return zeroBoundaryProof(a,job,attempt,op);
}
function candidate(a,job,task,query,time=Date.now()){
 const key=logicalKey(job,task,query),attempts=allAttempts(job).filter(v=>v.logicalKey===key);
 const unique=[...new Map(attempts.map(v=>[v.attemptId,v])).values()];
 if(!unique.length)return {action:'execute'};
 const latest=unique.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0],result=inspect(a,job,latest);
 if(result.source)return {action:'reuse',...result};
 if(result.phase==='queued')return {action:'execute',...result};
 if(result.op?.status==='failed')return require('./operation-ledger.cjs').eligibility(job,result.op,time);
 return {action:'reconcile',...result};
}
function settleInCommit(a,job,operation,{sourceId,errorCode,error}={}){
 if(!operation.attemptId)return false;
 const attempts=Object.values(job.executionState?.continuation?.episodes||{}).flatMap(e=>Object.values(e.evidenceAcquisition?.attempts||{})).filter(v=>v.attemptId===operation.attemptId&&v.logicalKey===operation.logicalKey);
 for(const attempt of attempts){
  if(attempt.operationId&&attempt.operationId!==operation.id)throw Object.assign(Error('逐项结算身份冲突'),{code:'EVIDENCE_IDENTITY_CONFLICT'});
  Object.assign(attempt,{operationId:operation.id,finishedAt:operation.completedAt||now()});
  if(sourceId){Object.assign(attempt,{status:'done',phase:'persisted',sourceId});delete attempt.error;delete attempt.errorCode;}
  else Object.assign(attempt,{status:'failed',phase:'failed',errorCode:errorCode||operation.errorCode,error:error||operation.error});
 }
 return attempts.length>0;
}
function settleReuseInCommit(a,job,attempt,operation){
 const targets=Object.values(job.executionState?.continuation?.episodes||{}).flatMap(e=>Object.values(e.evidenceAcquisition?.attempts||{})).filter(v=>v.attemptId===attempt.attemptId&&v.logicalKey===attempt.logicalKey);
 if(!attempt.attemptId||!targets.includes(attempt)||targets.some(v=>!same(v.query,attempt.query)||v.operationId&&v.operationId!==operation.id||v.reusedOperationId&&v.reusedOperationId!==operation.id||v.sourceId&&v.sourceId!==operation.sourceId))throw Object.assign(Error('缓存逐项身份冲突'),{code:'EVIDENCE_IDENTITY_CONFLICT',stopBatch:true});
 if(targets.some(v=>['unknown','dispatched','receipt'].includes(v.phase)&&v.operationId!==operation.id))throw Object.assign(Error('原逐项派发结果仍需核对'),{code:'OPERATION_RECONCILIATION_REQUIRED',stopBatch:true});
 const result=inspect(a,job,{...attempt,reusedOperationId:operation.id,sourceId:operation.status==='done'?operation.sourceId:null});
 if(!['persisted','failed'].includes(result.phase))throw Object.assign(Error('缓存回执无法证明当前逐项结果'),{code:'LOCAL_RESULT_INTEGRITY',reason:result.reason,stopBatch:true});
 for(const target of targets){
  Object.assign(target,{reusedOperationId:operation.id,finishedAt:operation.completedAt});
  if(result.source){Object.assign(target,{status:'done',phase:'persisted',sourceId:result.source.id});delete target.error;delete target.errorCode;}
  else {Object.assign(target,{status:'failed',phase:'failed',errorCode:operation.errorCode,error:operation.error});delete target.sourceId;}
 }
 return result.source||null;
}
function storageFailure(a,job,operation,error){
 const code=error.code==='LOCAL_RESULT_INTEGRITY'?'LOCAL_RESULT_INTEGRITY':'LOCAL_RESULT_STORAGE';
 require('./state-transitions.cjs').commit(a,()=>{
  Object.assign(operation,{status:'failed',phase:'failed',errorCode:code,error:error.message,completedAt:now()});
  operation.receipt={version:2,operationId:operation.id,attemptId:operation.attemptId,logicalKey:operation.logicalKey,classification:code,classificationBasis:'local_storage',diagnostics:require('./data-platform.cjs').safeDiagnostics(error),dispatched:!!operation.requests?.length,observedAt:operation.completedAt};
  settleInCommit(a,job,operation);
 });
 return Object.assign(error,{code,stopBatch:true});
}
module.exports={registerStep:(a,job,step)=>selected.set(a,{job,step}),BACKOFF,logicalKey,allAttempts,operations,transientCount,retryDecision,activeAttempt,claimInCommit,bindOperationInCommit,readableSource,zeroBoundaryProof,inspect,candidate,settleInCommit,settleReuseInCommit,storageFailure};
