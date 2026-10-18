'use strict';
// One trusted UI grant for the four legacy UNKNOWN claims. This module never
// infers non-delivery, runs transport, changes the original claim or gives back
// a consumed reservation. The engine's single writer owns atomic step commits.
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {hash,taskSources}=require('./evidence-basis.cjs');
const method=require('./evidence-storage-method.cjs');
const boundaries=require('./platform-boundaries.cjs');
const ledger=require('./operation-ledger.cjs');
const rows=v=>Array.isArray(v)?v:[];
const clone=v=>v==null?v:structuredClone(v);
const now=()=>new Date().toISOString();
const fail=(code,message=code)=>Object.assign(Error(message),{code,automaticRetry:false});
const assert=(condition,code)=>{if(!condition)throw fail(code);};
const owners=new WeakMap();
const ACTION='agentStorageMethodResume',PREVIEW=ACTION+'Preview',VERSION=1;
const active=job=>{const s=job.executionState?.storageMethodResume;return s?.grants?.[s.activeGrantId]||null;};
const legacy=job=>Object.values(job.executionState?.evidenceMethodAttempts||{}).filter(c=>c.method===method.METHOD);
const unknown=c=>c?.status==='started'&&c.errorCode==='EVIDENCE_METHOD_RESULT_UNKNOWN'&&!c.dispatch&&!c.dispatchId&&!c.runId&&!c.stepId;
function view(job,task){
 const g=active(job),claims=legacy(job),candidate=!g&&claims.length===4&&claims.every(unknown);
 return {candidate,taskId:g?.taskId||claims[0]?.taskId||null,historyUnknown:true,maxNewDispatchesPerClaim:1,
  grant:g?{grantId:g.grantId,failedRunId:g.binding.failedRunId,executedBy:g.executedBy,authorizedAt:g.authorizedAt,claimCount:g.binding.claims.length,
   claims:g.binding.claims.map(c=>({claimKey:c.key,claimHash:c.hash,phase:g.receipts?.[c.key]?'settled':g.reservations[c.key]?.phase||'authorized',status:g.receipts?.[c.key]?.status||null,sourceId:g.receipts?.[c.key]?.sourceId||null,dispatchId:g.reservations[c.key]?.dispatchId||null}))}:null};
}
function trusted(a,action){assert(require('./workspace-view.cjs').trustedCommand(a,action),'TRUSTED_UI_COMMAND_REQUIRED');}
function disk(a){try{return JSON.parse(fs.readFileSync(a.file,'utf8'));}catch{throw fail('RESUME_DURABLE_STATE_UNAVAILABLE');}}
function owner(a,job,task,episode){
 assert(a.data.delegations?.find(j=>j.id===job.id)===job&&a.data.tasks?.find(t=>t.id===task?.id)===task&&task?.agentJobId===job.id&&rows(job.taskIds).includes(task.id),'RESUME_OWNER_CHANGED');
 assert(episode&&job.executionState?.continuation?.episodes?.[episode.basis]===episode&&job.executionState.continuation.activeBasis===episode.basis&&(job.executionState.continuation.activeTaskId==null||job.executionState.continuation.activeTaskId===task.id)&&episode.taskId===task.id,'RESUME_EPISODE_CHANGED');
 assert(!a.readOnlyRecovery&&!a.controller?.signal.aborted&&require('./continuation-control.cjs').allowed(a,job,task),'RESUME_EXECUTION_GUARDED');
 assert(!require('./pending-check.cjs').repairBarrier(a,job,task),'RESUME_PENDING_CHECK_UNRESOLVED');
}
function coreBinding(a,job,task,episode){
 // Acquisition and lastDispatch legitimately advance during this grant. All
 // remaining episode fields (including pending checks and exhausted counters)
 // remain bound. Original acquisition entries are separately pinned below.
 const {evidenceAcquisition,lastDispatch,...stableEpisode}=episode;
 const artifact=require('./deliverables.cjs').primary(a,task);
 return {jobId:job.id,taskId:task.id,scope:clone(method.scope(job)),permissionRevision:job.executionState.permissionRevision||0,
  workRevision:job.workRevision??1,taskWorkRevision:task.workRevision??1,
  permissions:hash({folderIds:job.folderIds,documentGrants:job.documentGrants,capabilityGrants:job.capabilityGrants,fileMode:job.fileMode,githubMode:job.githubMode,larkCreateGrant:job.larkCreateGrant}),
  request:clone(task.evidenceRequest),intent:require('./requirements.cjs').intent(job,task),intentBasis:require('./continuation-control.cjs').intentBasis(job,task),sources:taskSources(a,task),
  episode:clone(stableEpisode),ownerSelection:{activeBasis:job.executionState.continuation.activeBasis,taskId:task.id},planVersion:task.planVersion,steps:clone(task.steps),primary:artifact?{id:artifact.id,hash:hash(artifact.content)}:null,
  pendingChecks:clone(job.executionState.pendingChecks||null)};
}
function oldProof(a,job,task,claim,checks){
 const p=claim.proof,old=p?.operation,q=claim.query;
 assert(unknown(claim)&&claim.key===hash({...method.scope(job),operationId:old?.id,query:boundaries.canonicalQuery(q),method:method.METHOD}),'RESUME_LEGACY_CLAIM_INVALID');
 assert(hash(claim.scope)===hash(method.scope(job))&&claim.taskId===task.id&&hash(claim.previousAttempt)===hash(p.previousAttempt),'RESUME_CLAIM_BINDING_CHANGED');
 const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[q]}),policyHash=hash({policyId:check?.policyId,grantRevision:check?.grantRevision});
 assert(check?.allowed&&job.dataPlatform==='sg-readonly'&&job.platformPrincipal,'RESUME_CONTEXT_CHANGED');
 if(!checks.has(policyHash))checks.set(policyHash,method.context(a,job,task,check));
 assert(claim.context===checks.get(policyHash)&&claim.requestBasis===task.evidenceRequest?.basis&&hash(claim.request)===hash(task.evidenceRequest),'RESUME_CONTEXT_CHANGED');
 assert(old&&old.status==='interrupted'&&old.attempt===1&&!old.error&&!old.errorCode&&!old.sourceId&&old.policy===hash({policyId:check.policyId,grantRevision:check.grantRevision})&&ledger.valid(job,old,a),'RESUME_ORIGINAL_OPERATION_INVALID');
 assert([ledger.key(job,q),hash({...method.scope(job),request:require('./data-platform.cjs').command(q)})].includes(old.key)&&[old.query,old.actualQuery,old.requestedQuery,p.previousAttempt?.query].every(v=>method.sameQuery(v,q)),'RESUME_ORIGINAL_QUERY_CHANGED');
 const previous=p.previousAttempt,target=p.target,cq=boundaries.canonicalQuery(q);
 assert(cq.op==='table_lineage'&&cq.entityType==='HiveTable'&&cq.region==='sg'&&target?.kind==='physical_lineage'&&target.reason==='missing_own_center'&&method.sameQuery(target.query,q)&&method.attemptKey(target)===p.attemptKey,'RESUME_TYPED_TARGET_INVALID');
 assert(previous?.status==='failed'&&previous.error===method.LEGACY_SIZE_ERROR&&previous.errorCode==='EVIDENCE_RESULT_UNAVAILABLE'&&!previous.method&&!previous.methodClaimKey&&!previous.previousAttempt,'RESUME_ORIGINAL_FAILURE_INVALID');
 const runs=rows(a.data.agentRuns).filter(r=>r.id===p.runId&&r.jobId===job.id),run=runs[0],step=run?.steps?.[p.stepIndex],acq=step?.evidenceAcquisition;
 const oldEpisode=job.executionState.continuation.episodes[p.episodeBasis];
 assert(runs.length===1&&run.status==='done'&&step?.tool==='platform_query'&&!step.error&&!step.errorCode&&step.at===p.stepAt&&step.args?.taskId===task.id&&step.args?.retry!==true&&acq?.taskId===task.id&&acq.episodeBasis===p.episodeBasis&&acq.requestBasis===p.requestBasis&&oldEpisode?.taskId===task.id&&oldEpisode.intentBasis===require('./continuation-control.cjs').intentBasis(job,task),'RESUME_ORIGINAL_RUN_PROOF_INVALID');
 assert(hash(oldEpisode.evidenceAcquisition?.attempts?.[p.attemptKey])===hash(previous),'RESUME_ORIGINAL_ATTEMPT_CHANGED');
 const targets=rows(acq.targets).filter(t=>method.attemptKey(t)===p.attemptKey),results=rows(step.result?.results).filter(r=>method.sameQuery(r.query,q));
 assert(targets.length===1&&hash(targets[0])===hash(target)&&rows(step.args.queries).filter(v=>method.sameQuery(v,q)).length===1&&results.length===1&&hash(results[0])===hash(p.result)&&p.result.error===method.LEGACY_SIZE_ERROR&&!p.result.errorCode&&!p.result.sourceId&&!p.result.receipt&&!p.result.reused&&(!p.result.operationId||p.result.operationId===old.id),'RESUME_ORIGINAL_RESULT_CHANGED');
 const times=[run.startedAt,step.at,previous.at,old.startedAt,previous.finishedAt,run.finishedAt].map(Date.parse);
 assert(times.every(Number.isFinite)&&times.every((t,i)=>!i||t>=times[i-1]),'RESUME_ORIGINAL_TIMELINE_INVALID');
 return {run,step,oldEpisode,check};
}
function failedRun(a,job,claims,episode){
 assert(episode.cycles===3&&episode.blocked===true&&typeof episode.reason==='string'&&episode.reason.startsWith('同一未解决要求已完成 3 次修订检查仍未收敛：'),'RESUME_EXHAUSTED_EPISODE_REQUIRED');
 const found=rows(a.data.agentRuns).filter(r=>r.jobId===job.id&&Number.isFinite(Date.parse(r.startedAt))&&Number.isFinite(Date.parse(r.finishedAt))&&claims.every(c=>Date.parse(c.at)>=Date.parse(r.startedAt)&&Date.parse(c.at)<=Date.parse(r.finishedAt)));
 assert(found.length===1,'RESUME_FAILED_RUN_AMBIGUOUS');
 const run=found[0];
 assert(run.id&&run.status==='ready'&&Array.isArray(run.steps)&&run.steps.length===0&&run.modelCalls===0&&Array.isArray(run.modelCallsDetail)&&run.modelCallsDetail.length===0&&run.usage&&Object.values(run.usage).length>0&&Object.values(run.usage).every(v=>v===0)&&run.recovery?.reason==='正在自动纠偏：'+episode.reason&&!run.error,'RESUME_FAILED_RUN_INVALID');
 // These are filters for UI authorization, never proof of historical non-send.
 assert(legacy(job).filter(c=>Date.parse(c.at)>=Date.parse(run.startedAt)&&Date.parse(c.at)<=Date.parse(run.finishedAt)).length===4,'RESUME_BATCH_CHANGED');
 return run;
}
function operationState(a,job,task,claim,durable,{allowLive=false,reservation}={}){
 const old=claim.proof.operation,q=claim.query,saved=durable.delegations?.find(j=>j.id===job.id);
 const sameScope=o=>hash(o.principal)===hash(claim.scope.principal)&&o.scope===claim.scope.scope&&o.projectId===claim.scope.projectId&&(o.permissionRevision??0)===(old.permissionRevision??0);
 const relevant=o=>sameScope(o)&&[o.query,o.actualQuery,o.requestedQuery].some(v=>v&&method.sameQuery(v,q));
 const ops=Object.values(job.executionState.operations||{}).filter(o=>o.status!=='superseded'&&relevant(o));
 assert(ops.length===1,'RESUME_OPERATION_AMBIGUOUS');
 const op=ops[0],history=rows(job.executionState.history).filter(relevant),savedHistory=rows(saved?.executionState?.history).filter(relevant);
 assert(hash(savedHistory)===hash(history)&&hash(saved?.executionState?.operations?.[op.key])===hash(op),'RESUME_OPERATION_NOT_DURABLE');
 if(op.id===old.id){
  assert(hash(op)===hash(old),'RESUME_ORIGINAL_OPERATION_CHANGED');
  assert(!history.some(o=>o.id!==old.id&&(!Number.isFinite(Date.parse(o.startedAt))||Date.parse(o.startedAt)>=Date.parse(old.startedAt))),'RESUME_LATER_OPERATION_EXISTS');
  return {mode:'dispatch',historyHash:hash(history)};
 }
 const live=allowLive&&reservation&&op.status==='running';
 assert(live||['done','failed'].includes(op.status),'RESUME_LIVE_OR_UNKNOWN_OPERATION');
 if(reservation?.operationId)assert(reservation.operationId===op.id,'RESUME_LIVE_OPERATION_CONFLICT');
 assert(op.key===ledger.key(job,q)&&job.executionState.operations[op.key]===op&&op.attempt===old.attempt+1&&op.policy===old.policy&&ledger.valid(job,op,a)&&[op.query,op.requestedQuery,...(!live||op.actualQuery?[op.actualQuery]:[])].every(v=>method.sameQuery(v,q))&&Date.parse(op.startedAt)>=Date.parse(claim.at)&&(live||Date.parse(op.completedAt)>=Date.parse(op.startedAt)),'RESUME_RECEIPT_INVALID');
 assert(history.some(o=>hash(o)===hash(old))&&!history.some(o=>o.id!==old.id&&(!Number.isFinite(Date.parse(o.startedAt))||Date.parse(o.startedAt)>=Date.parse(old.startedAt))),'RESUME_RECEIPT_HISTORY_CONFLICT');
 if(live){
  assert(Date.parse(op.startedAt)>=Date.parse(reservation.preparedAt)&&(!reservation.operationId||reservation.operationId===op.id),'RESUME_LIVE_OPERATION_CONFLICT');
  return {mode:'inflight',operationId:op.id,historyHash:hash(history)};
 }
 if(op.status==='failed'){
  assert(op.receipt?.operationId===op.id&&op.receipt.classification===op.errorCode&&method.sameQuery(op.receipt.actualQuery,q),'RESUME_FAILURE_RECEIPT_MISSING');
  return {mode:'associate',receipt:{op:clone(op)},historyHash:hash(history)};
 }
 const source=a.data.sources.find(s=>s.id===op.sourceId);
 assert(source&&hash(source)===hash(durable.sources?.find(s=>s.id===source.id))&&rows(job.sourceIds).includes(source.id)&&hash(source.platformPrincipal)===hash(op.principal)&&require('./protocol-access.cjs').allowedObject(a,'source',source,job,null)&&!a.data.sources.some(s=>s.previousSourceId===source.id&&!s.deleted&&!s.projectExcluded),'RESUME_SOURCE_RECEIPT_INVALID');
 try{const snapshot=JSON.parse(source.content);assert(snapshot.operation==='table_lineage'&&method.sameQuery(snapshot.query,q),'RESUME_SOURCE_QUERY_CHANGED');require('./platform-result.cjs').restore(snapshot,source);}catch{throw fail('RESUME_SOURCE_RECEIPT_INVALID');}
 return {mode:'associate',receipt:{op:clone(op),source:clone(source)},historyHash:hash(history)};
}
function currentNeed(needs,claim){
 const target=claim.proof.target;
 return needs.find(n=>n.kind==='physical_lineage'&&n.reason==='missing_own_center'&&n.obligationId===target.obligationId&&n.direction===target.direction&&hash(n.identity)===hash(target.identity)&&method.sameQuery(n.query,claim.query)&&rows(target.rootIds).every(r=>rows(n.rootIds).includes(r)));
}
function inspect(a,job,{taskId,grant=active(job),liveStep=null}={}){
 const claims=legacy(job).sort((x,y)=>x.key.localeCompare(y.key));
 assert(claims.length===4&&claims.every(unknown)&&new Set(claims.map(c=>hash(boundaries.canonicalQuery(c.query)))).size===4,'RESUME_EXACT_FOUR_UNKNOWN_REQUIRED');
 const task=rows(a.data.tasks).find(t=>t.id===(taskId||claims[0].taskId)),episode=job.executionState?.continuation?.episodes?.[claims[0].episodeBasis];
 owner(a,job,task,episode);
 assert(claims.every(c=>c.taskId===task.id&&c.episodeBasis===episode.basis&&c.requestBasis===task.evidenceRequest?.basis)&&task.evidenceRequest?.kind==='needs_evidence','RESUME_REQUEST_CHANGED');
 const durable=disk(a),saved=durable.delegations?.find(j=>j.id===job.id),savedTask=durable.tasks?.find(t=>t.id===task.id);
 assert(hash(savedTask?.evidenceRequest)===hash(task.evidenceRequest),'RESUME_REQUEST_NOT_DURABLE');
 const run=failedRun(a,job,claims,episode);
 assert(hash(durable.agentRuns?.find(r=>r.id===run.id))===hash(run),'RESUME_FAILED_RUN_NOT_DURABLE');
 const needs=require('./relation-obligations.cjs').evidenceNeeds(a,job,task),entries=[],checks=new Map();
 for(const claim of claims){
  assert(hash(saved?.executionState?.evidenceMethodAttempts?.[claim.key])===hash(claim),'RESUME_CLAIM_NOT_DURABLE');
  oldProof(a,job,task,claim,checks);
  const reservation=grant?.reservations?.[claim.key],allowLive=!!liveStep&&owners.get(a)?.step===liveStep&&reservation?.dispatchId===liveStep.dispatch?.id;
  const operation=operationState(a,job,task,claim,durable,{allowLive,reservation}),need=currentNeed(needs,claim);
  if(operation.mode==='dispatch'&&!reservation)assert(need,'RESUME_CURRENT_TYPED_GAP_MISSING');
  const attempt=episode.evidenceAcquisition?.attempts?.[claim.proof.attemptKey];
  if(!reservation&&operation.mode==='dispatch')assert(attempt?.methodClaimKey===claim.key&&attempt.status==='started'&&attempt.method===method.METHOD&&method.sameQuery(attempt.query,claim.query)&&hash(attempt.previousAttempt)===hash(claim.previousAttempt),'RESUME_CURRENT_ATTEMPT_CHANGED');
  const migration=boundaries.planMigration(job,{sources:[],isOperationCurrent:boundaries.currentOperation});
  assert(boundaries.inspect(job,claim.query,{sources:[],isOperationCurrent:boundaries.currentOperation,migration,records:migration.records}).status!=='accepted_boundary','RESUME_ACCEPTED_BOUNDARY');
  for(const later of rows(a.data.agentRuns).filter(r=>r.jobId===job.id))for(const step of rows(later.steps)){
   if(preparing?.a===a&&preparing.run===later&&preparing.step===step)continue;
   // started() re-reads candidates after the outer transaction inserts the
   // selected step. Only its runtime prepare marker can exclude this local,
   // not-yet-committed step from historical query evidence.
   if(require('./dispatch-lifecycle.cjs').prepared(a,step)&&a.activeAgentRun===later){dispatchIdentity(a,job,task,step,later);continue;}
   if(step.tool!=='platform_query'||!(Date.parse(step.at)>=Date.parse(claim.at))||!rows(step.args?.queries).some(q=>method.sameQuery(q,claim.query)))continue;
   const owned=reservation&&later.id===reservation.runId&&step.id===reservation.stepId&&step.dispatch?.id===reservation.dispatchId;
   const receipts=rows(step.result?.results).filter(r=>method.sameQuery(r.query,claim.query));
   assert(owned||operation.mode==='associate'&&receipts.length===1&&receipts[0].operationId===operation.receipt.op.id,'RESUME_LATER_QUERY_EXISTS');
  }
  entries.push({claim,need:clone(need||claim.proof.target),...operation});
 }
 if(grant)for(const entry of entries){
  const receipt=grant.receipts?.[entry.claim.key];if(!receipt)continue;
  const persisted=saved?.executionState?.storageMethodResume?.grants?.[grant.grantId]?.receipts?.[entry.claim.key];
  assert(hash(receipt)===hash(persisted)&&entry.mode==='associate'&&(receipt.operationId||receipt.opId)===entry.receipt.op.id&&receipt.status===entry.receipt.op.status&&(receipt.sourceId||null)===(entry.receipt.source?.id||null),'RESUME_RECORDED_RECEIPT_CONFLICT');
 }
 const binding={...coreBinding(a,job,task,episode),failedRunId:run.id,failedRunHash:hash(run),claims:entries.map(({claim,historyHash})=>({key:claim.key,hash:hash(claim),historyHash,attemptHash:hash(episode.evidenceAcquisition?.attempts?.[claim.proof.attemptKey])}))};
 if(grant){
  const {claims:oldClaims,...oldCore}=grant.binding,{claims:newClaims,...newCore}=binding;
  assert(grant.version===VERSION&&grant.jobId===job.id&&grant.taskId===task.id&&hash(oldCore)===hash(newCore)&&hash(oldClaims.map(c=>({key:c.key,hash:c.hash})))===hash(newClaims.map(c=>({key:c.key,hash:c.hash}))),'RESUME_GRANT_CONTEXT_CHANGED');
  const persisted=saved?.executionState?.storageMethodResume?.grants?.[grant.grantId];
  assert(persisted&&hash(persisted.binding)===hash(grant.binding)&&persisted.authorizationRef?.hash===grant.authorizationRef?.hash,'RESUME_GRANT_NOT_DURABLE');
  for(const entry of entries){const original=oldClaims.find(c=>c.key===entry.claim.key);if(!grant.reservations[entry.claim.key]&&entry.mode==='dispatch')assert(entry.historyHash===original.historyHash&&hash(episode.evidenceAcquisition?.attempts?.[entry.claim.proof.attemptKey])===original.attemptHash,'RESUME_ORIGINAL_HISTORY_CHANGED');}
 }
 return {task,episode,claims,entries,binding,bindingId:hash(binding),durable};
}
function preview(a,job,input={}){
 try{assert(!job.executionState?.storageMethodResume||active(job),'RESUME_GRANT_STATE_INVALID');assert(!a.activeAgentRun&&!require('./execution-facts.cjs').inFlight(a,job),'RESUME_RUN_ACTIVE');const p=inspect(a,job,{taskId:input.taskId});
  return {eligible:!active(job),reason:active(job)?'RESUME_ALREADY_AUTHORIZED':null,bindingId:p.bindingId,taskId:p.task.id,failedRunId:p.binding.failedRunId,historyUnknown:true,
   claims:p.entries.map(e=>({claimKey:e.claim.key,claimHash:hash(e.claim),query:clone(e.claim.query),mode:e.mode}))};
 }catch(e){return {eligible:false,reason:e.code||'RESUME_GUARDED',historyUnknown:true};}
}
function authorize(a,job,input={}){
 trusted(a,ACTION);
 assert(['user','supervisor'].includes(input.executedBy)&&typeof input.authorizationNote==='string'&&input.authorizationNote.trim()&&input.authorizationNote.length<=16000&&typeof input.bindingId==='string'&&/^[a-f0-9]{64}$/.test(input.bindingId)&&typeof input.taskId==='string'&&(!input.commandId||typeof input.commandId==='string'&&input.commandId.length<=200),'RESUME_AUTHORIZATION_INPUT_REQUIRED');
 assert(!a.activeAgentRun&&!require('./execution-facts.cjs').inFlight(a,job),'RESUME_RUN_ACTIVE');
 const old=active(job);
 if(old){assert(old.bindingId===input.bindingId&&old.taskId===input.taskId,'RESUME_ALREADY_AUTHORIZED');const saved=disk(a).delegations?.find(j=>j.id===job.id)?.executionState?.storageMethodResume?.grants?.[old.grantId];assert(hash(saved)===hash(old),'RESUME_GRANT_NOT_DURABLE');return clone(old);}
 assert(!job.executionState?.storageMethodResume,'RESUME_GRANT_STATE_INVALID');
 const p=inspect(a,job,{taskId:input.taskId,grant:null});assert(p.bindingId===input.bindingId,'STATE_STALE');
 const grantId='storage-method-resume:'+hash(p.binding.claims.map(c=>({key:c.key,hash:c.hash}))),note=input.authorizationNote.trim();
 const grant={version:VERSION,grantId,jobId:job.id,taskId:p.task.id,bindingId:p.bindingId,binding:p.binding,authorizedAt:now(),authorizedBy:'user',executedBy:input.executedBy,authorizationRef:{note,hash:hash(note)},commandId:input.commandId||randomUUID(),historyUnknown:true,maxNewDispatchesPerClaim:1,reservations:{},receipts:{}};
 require('./state-transitions.cjs').commit(a,()=>{
  assert(!active(job),'RESUME_ALREADY_AUTHORIZED');
  job.executionState.storageMethodResume={version:VERSION,activeGrantId:grantId,grants:{[grantId]:grant}};
 });
 return clone(grant);
}
function candidates(a,job,task,episode){
 const grant=active(job);if(!grant||grant.taskId!==task?.id)return [];
 try{const p=inspect(a,job,{taskId:task.id,grant});if(p.episode!==episode)return [];
  return p.entries.filter(e=>!grant.receipts?.[e.claim.key]&&(e.mode==='associate'||!grant.reservations[e.claim.key])).map(e=>({grantId:grant.grantId,claimKey:e.claim.key,claimHash:hash(e.claim),query:clone(e.claim.query),need:clone(e.need),mode:e.mode,...(e.receipt?{receipt:clone(e.receipt)}:{})}));
 }catch{return [];}
}
function dispatchIdentity(a,job,task,step,run){
 const d=step?.dispatch;
 assert(run&&a.activeAgentRun===run&&run.jobId===job.id&&a.data.agentRuns?.includes(run)&&run.steps?.includes(step)&&typeof step.id==='string'&&step.id&&d&&typeof d.id==='string'&&d.id&&d.runId===run.id&&d.stepId===step.id&&d.jobId===job.id&&d.taskId===task.id&&d.tool===step.tool&&d.argsHash===hash(step.args)&&step.tool==='platform_query'&&step.args?.taskId===task.id&&Object.keys(step.args).every(k=>['taskId','queries'].includes(k)),'RESUME_DISPATCH_IDENTITY_INVALID');
 return d;
}
function claimInCommit(a,job,task,episode,step,run=a.activeAgentRun){
 assert(require('./dispatch-lifecycle.cjs').prepared(a,step),'RESUME_TRUSTED_TRANSACTION_REQUIRED');
 const d=dispatchIdentity(a,job,task,step,run);assert(d.phase==='prepared','RESUME_DISPATCH_NOT_PREPARED');
 const grant=active(job);assert(grant,'RESUME_AUTHORIZATION_REQUIRED');
 // The just-inserted prepared step is local, has made no request, and is not
 // later query history. It is excluded only for this exact in-memory step.
 const p=inspectPrepared(a,job,task,episode,step,run),queries=rows(step.args.queries);
 assert(queries.length>0&&new Set(queries.map(q=>hash(boundaries.canonicalQuery(q)))).size===queries.length,'RESUME_QUERY_BATCH_INVALID');
 const selected=queries.map(q=>p.entries.find(e=>method.sameQuery(e.claim.query,q)));
 assert(selected.every(e=>e&&e.mode==='dispatch'&&!grant.reservations[e.claim.key]),'RESUME_CLAIM_ALREADY_USED_OR_RECEIPT_EXISTS');
 const at=now(),claimKeys=selected.map(e=>e.claim.key);
 for(const e of selected)grant.reservations[e.claim.key]={claimKey:e.claim.key,claimHash:hash(e.claim),dispatchId:d.id,runId:run.id,stepId:step.id,tool:step.tool,argsHash:d.argsHash,phase:'prepared',preparedAt:at};
 step.storageMethodResume={grantId:grant.grantId,claimKeys,runId:run.id,stepId:step.id,dispatchId:d.id,argsHash:d.argsHash};
 owners.set(a,{job,run,step,dispatchId:d.id,argsHash:d.argsHash});
 return clone(step.storageMethodResume);
}
// No mutation, not even temporarily removing a live step. The pure inspection
// accepts this private, synchronous marker only while claiming the owner step.
let preparing=null;
function inspectPrepared(a,job,task,episode,step,run){
 assert(!preparing,'RESUME_REENTRANT_CLAIM');preparing={a,step,run};
 try{const p=inspect(a,job,{taskId:task.id});assert(p.episode===episode,'RESUME_EPISODE_CHANGED');return p;}finally{preparing=null;}
}
function currentDispatch(a,job,task,episode,step){
 try{
  const run=a.activeAgentRun,d=dispatchIdentity(a,job,task,step,run),g=active(job),link=step.storageMethodResume;
  assert(g&&link?.grantId===g.grantId&&link.runId===run.id&&link.stepId===step.id&&link.dispatchId===d.id&&link.argsHash===d.argsHash,'RESUME_DISPATCH_LINK_CHANGED');
  const runtime=owners.get(a);assert(runtime?.job===job&&runtime.run===run&&runtime.step===step&&runtime.dispatchId===d.id&&runtime.argsHash===d.argsHash,'RESUME_RUNTIME_OWNER_REQUIRED');
  const p=inspect(a,job,{taskId:task.id,liveStep:step});assert(p.episode===episode,'RESUME_EPISODE_CHANGED');
  const saved=p.durable.delegations.find(j=>j.id===job.id).executionState.storageMethodResume.grants[g.grantId];
  assert(rows(link.claimKeys).length===rows(step.args.queries).length&&new Set(link.claimKeys).size===link.claimKeys.length,'RESUME_DISPATCH_LINK_CHANGED');
  const persistedStep=p.durable.agentRuns?.find(r=>r.id===run.id)?.steps?.find(s=>s.id===step.id);
  assert(persistedStep&&hash(persistedStep.storageMethodResume)===hash(link)&&persistedStep.dispatch?.id===d.id&&hash(persistedStep.args)===hash(step.args),'RESUME_DISPATCH_NOT_DURABLE');
  for(const key of link.claimKeys){
   const r=g.reservations[key],persisted=saved.reservations[key],entry=p.entries.find(e=>e.claim.key===key);
   assert(r&&persisted&&entry&&step.args.queries.some(q=>method.sameQuery(q,entry.claim.query))&&r.dispatchId===d.id&&r.runId===run.id&&r.stepId===step.id&&r.argsHash===d.argsHash&&r.claimHash===hash(entry.claim)&&['prepared','dispatch_started'].includes(r.phase)&&['prepared','dispatch_started'].includes(persisted.phase)&&hash(r)===hash(persisted),'RESUME_DISPATCH_NOT_CURRENT');
  }
  return {allowed:true,grantId:g.grantId,claimKeys:clone(link.claimKeys),dispatchId:d.id,receiptClaimKeys:p.entries.filter(e=>link.claimKeys.includes(e.claim.key)&&e.mode==='associate').map(e=>e.claim.key)};
 }catch(e){return {allowed:false,reason:e.code||'RESUME_GUARDED'};}
}
function reservation(job,claimKey){return active(job)?.reservations?.[claimKey]||null;}
function assertDispatch(a,job,task,step){
 const grant=active(job),episode=job.executionState?.continuation?.episodes?.[grant?.binding?.episode?.basis];
 const result=currentDispatch(a,job,task,episode,step);assert(result.allowed,result.reason);return result;
}
function markExternalInCommit(a,job,task,episode,step,query={op:'identity'}){
 const result=currentDispatch(a,job,task,episode,step);assert(result.allowed,result.reason);
 const g=active(job),at=now(),isIdentity=query.op==='identity';
 const selected=result.claimKeys.filter(k=>isIdentity||method.sameQuery(job.executionState.evidenceMethodAttempts[k].query,query));
 assert(selected.length>0,'RESUME_QUERY_OUTSIDE_DISPATCH');
 assert(!selected.some(k=>result.receiptClaimKeys.includes(k)),'RESUME_RECEIPT_REQUIRES_ASSOCIATION');
 for(const key of selected){
  const r=g.reservations[key];
  if(isIdentity){assert(!r.identityStartedAt,'RESUME_EXTERNAL_ALREADY_STARTED');r.identityStartedAt=at;}
  else {assert(!r.queryStartedAt,'RESUME_EXTERNAL_ALREADY_STARTED');r.queryStartedAt=at;const q=job.executionState.evidenceMethodAttempts[key].query,op=job.executionState.operations[ledger.key(job,q)];assert(op?.status==='running','RESUME_LIVE_OPERATION_REQUIRED');r.operationId=op.id;}
  r.phase='dispatch_started';r.externalAt ||= at;
 }
 return result;
}
module.exports={ACTION,PREVIEW,VERSION,view,preview,authorize,active,reservation,candidates,claimInCommit,currentDispatch,assertDispatch,markExternalInCommit};
