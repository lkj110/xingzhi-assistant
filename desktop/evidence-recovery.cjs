// Deterministic acquisition for an explicit typed gap. This owns no generation
// budget: it can only query a named current gap and atomically bind its receipt.
const {hash}=require('./evidence-basis.cjs');
const items=require('./evidence-item-lifecycle.cjs');
const legacy=require('./evidence-legacy-preflight.cjs');
const storageMethod=require('./evidence-storage-method.cjs');
const methodResume=require('./storage-method-resume.cjs');
const commit=(a,fn)=>require('./state-transitions.cjs').commit(a,fn);
const rows=x=>Array.isArray(x)?x:[];
const rel=()=>require('./relation-obligations.cjs');
const now=()=>new Date().toISOString();
function needs(a,job,task){return rows(rel().evidenceNeeds?.(a,job,task));}
function store(episode){return episode.evidenceAcquisition ||= {version:1,attempts:{}};}
function key(n){return hash({obligationId:n.obligationId,rootIds:[...rows(n.rootIds)].sort(),direction:n.direction||null,query:require('./platform-boundaries.cjs').canonicalQuery(n.query)});}
function queuedMethod(a,job,task,episode,need){
 const attempt=episode.evidenceAcquisition?.attempts?.[key(need)],claim=attempt?.methodClaimKey&&job.executionState?.evidenceMethodAttempts?.[attempt.methodClaimKey];
 if(!claim||claim.status!=='started'||!attempt.attemptId||claim.dispatch?.id!==attempt.dispatchId||!storageMethod.currentClaim(a,job,task,claim))return null;
 const result=items.inspect(a,job,attempt);
 return result.eligible&&result.phase==='queued'&&(claim.operationId||null)===(result.op?.id||null)?{claimKey:claim.key,attemptId:attempt.attemptId,proof:result.proof}:null;
}
function candidates(a,job,task,episode){
 const request=task.evidenceRequest,g=require('./repair-validation.cjs').active(job);
 if(request&&request.kind!=='needs_evidence'||episode.validationGrantId&&g?.claimedAttemptId&&!request)return [];
 const resumed=methodResume.candidates(a,job,task,episode).filter(r=>r.mode==='dispatch').map(r=>({need:r.need,resume:r}));
 const ordinary=storageMethod.project(a,job,task,episode).filter(({need:n})=>n.query&&n.obligationId&&rows(n.rootIds).length&&['code','outputs','table_lineage','table_tasks'].includes(n.query.op))
  .filter(({need:n})=>!request||rows(request.recoveryRequest?.targets).some(t=>t.obligationId===n.obligationId&&n.rootIds.some(r=>rows(t.rootIds).includes(r))&&(n.kind!=='physical_lineage'||rows(t.physicalGaps).some(g=>(n.query.op==='outputs'&&n.reason==='root_output_mapping_missing'&&g.reason===n.reason&&n.rootIds.includes(g.rootId)||g.direction===n.direction&&hash(g.identity)===hash(n.identity))))))
  .map(row=>({...row,continuedClaim:row.eligible?null:queuedMethod(a,job,task,episode,row.need)}))
  .filter(({need:n,eligible,continuedClaim})=>{
   if(eligible||continuedClaim)return true;
   if(storageMethod.consumed(job,n.query))return false;
   const current=Object.values(episode.evidenceAcquisition?.attempts||{}).filter(v=>storageMethod.sameQuery(v.query,n.query));
   if(current.some(v=>v.logicalKey&&v.logicalKey!==items.logicalKey(job,task,n.query)))return false;
   const decision=items.candidate(a,job,task,n.query);
   if(decision.action!=='execute')return false;
   const historical=items.allAttempts(job).filter(v=>!v.attemptId&&storageMethod.sameQuery(v.query,n.query));
   return historical.every(v=>legacy.corrected(job,v,task,a));
  });
 return resumed.length?resumed:ordinary;
}
function methodOrdinal(job,claim,op){
 const original=claim.proof.operation.attempt;
 if(!Number.isSafeInteger(original)||!Number.isSafeInteger(op.attempt)||op.attempt<=original)return false;
 const history=items.operations(job).filter(o=>o.methodClaimId===claim.key&&o.originOperationId===claim.proof.operation.id&&o.id!==op.id);
 if(history.length!==op.attempt-original-1)return false;
 for(let number=original+1;number<op.attempt;number++){
  const matches=history.filter(o=>o.attempt===number),old=matches[0],resolution=old?.zeroBoundaryResolution,p=resolution?.proof;
  if(matches.length!==1||old.status!=='superseded'||old.phase!=='not_dispatched'||!p||p.operationId!==old.id||p.attemptId!==old.attemptId||rows(old.requests).length||old.responses||old.receipt||old.sourceId)return false;
  const prepared=structuredClone(old);for(const k of ['completedAt','resolvedBy','zeroBoundaryResolution'])delete prepared[k];prepared.status='prepared';prepared.phase='prepared';
  if(hash(prepared)!==p.operationHash||!rows(claim.preparedContinuations).some(c=>c.attemptId===old.attemptId&&hash(c.proof)===hash(p)))return false;
  const successor=number+1===op.attempt?op:history.find(o=>o.attempt===number+1);
  if(!successor||old.resolvedBy!==successor.id||resolution.replacementOperationId!==successor.id)return false;
 }
 return true;
}
function receiptView(a,job,task,keys){
 const claims=keys.map(k=>job.executionState?.evidenceMethodAttempts?.[k]);
 const valid=storageMethod.currentClaims(a,job,task,claims);
 return {durable:durableState(a),current:new Set(keys.filter((k,i)=>valid[i]))};
}
function methodReceipt(a,job,task,attempt,view){
 const claim=job.executionState?.evidenceMethodAttempts?.[attempt.methodClaimKey];
 if(!claim||!view.current.has(claim.key))return {};
 const durable=view.durable;
 const persisted=durable?.delegations?.find(j=>j.id===job.id),savedClaim=persisted?.executionState?.evidenceMethodAttempts?.[claim.key];
 if(!savedClaim||savedClaim.context!==claim.context||savedClaim.requestBasis!==claim.requestBasis)return {};
 // A legacy slot remains as superseded after the ledger creates its canonical
 // successor. Other principals/scopes also retain their own slots. Neither is
 // a competing receipt for this claim; two live same-scope successors still are.
 if(attempt.attemptId){const exact=items.inspect(a,job,attempt);if(exact.op&&exact.op.methodClaimId===claim.key&&exact.op.originOperationId===(claim.originOperationId||claim.proof.operation.id)&&methodOrdinal(job,claim,exact.op)&&exact.op.policy===claim.proof.operation.policy&&hash(persisted.executionState?.operations?.[exact.op.key])===hash(exact.op)&&(!exact.source||hash(durable.sources?.find(s=>s.id===exact.source.id))===hash(exact.source)))return exact;return {};}
 const old=claim.proof.operation;
 const ops=Object.values(job.executionState?.operations||{}).filter(o=>o.status!=='superseded'&&hash(o.principal)===hash(claim.scope.principal)&&o.scope===claim.scope.scope&&o.projectId===claim.scope.projectId&&(o.permissionRevision??0)===(old.permissionRevision??0)&&storageMethod.sameQuery(o.query,claim.query)&&storageMethod.sameQuery(o.actualQuery||o.query,claim.query));
 if(ops.length!==1)return {};
 const op=ops[0];
 if(!['done','failed'].includes(op.status)||op.id===old.id||op.key!==require('./operation-ledger.cjs').key(job,claim.query)||job.executionState.operations[op.key]!==op||!(Date.parse(op.startedAt)>=Date.parse(claim.at))||op.attempt!==old.attempt+1||op.policy!==old.policy||(op.permissionRevision??0)!==(old.permissionRevision??0)||!require('./operation-ledger.cjs').valid(job,op,a))return {};
 if(hash(persisted.executionState?.operations?.[op.key])!==hash(op)||!rows(job.executionState.history).some(o=>o.id===old.id&&hash(o)===hash(old)))return {};
 if(op.status==='failed')return {op};
 const source=a.data.sources.find(s=>s.id===op.sourceId);
 if(!source||hash(durable.sources?.find(s=>s.id===source.id))!==hash(source)||!rows(job.sourceIds).includes(source.id)||hash(source.platformPrincipal)!==hash(op.principal)||!require('./protocol-access.cjs').allowedObject(a,'source',source,job,null)||a.data.sources.some(s=>s.previousSourceId===source.id&&!s.deleted&&!s.projectExcluded))return {};
 try{const snapshot=JSON.parse(source.content);if(snapshot.operation!=='table_lineage'||!storageMethod.sameQuery(snapshot.query,claim.query))return {};require('./platform-result.cjs').restore(snapshot,source);}catch{return {};}
 return {op,source};
}
function durableState(a){try{return JSON.parse(require('node:fs').readFileSync(a.file,'utf8'));}catch{return null;}}
function receipt(a,job,attempt){
 return items.inspect(a,job,attempt);
}
function recoverable(a,job,task,episode){
 const work=episode.evidenceAcquisition;
 if(!task.evidenceRequest||task.evidenceRequest.basis!==work?.requestBasis)return [];
 const attempts=Object.values(work.attempts||{}).filter(attempt=>['started','unknown','done','failed'].includes(attempt.status)&&(!attempt.methodClaimKey||job.executionState?.evidenceMethodAttempts?.[attempt.methodClaimKey]?.status==='started')&&attempt.phase!=='associated'&&!(attempt.sourceId&&rows(task.sourceIds).includes(attempt.sourceId))),keys=attempts.map(v=>v.methodClaimKey).filter(Boolean),view=keys.length?receiptView(a,job,task,keys):null;
 return attempts.map(attempt=>({attempt,...(attempt.methodClaimKey?methodReceipt(a,job,task,attempt,view):receipt(a,job,attempt))}));
}
function recover(a,job,task,episode){
 const work=episode.evidenceAcquisition;if(!work)return false;
 const recovered=recoverable(a,job,task,episode).filter(r=>r.source||r.op?.status==='failed');
 if(!recovered.length)return false;
 const apply=()=>{
  const pending=work.pendingPlan?.requestBasis===task.evidenceRequest?.basis?work.pendingPlan:null;
  const ids=[...rows(pending?.sourceIds)],methodClaims=[...rows(pending?.methodClaims)];
  for(const {attempt,op,source} of recovered){
   if(source){attempt.status='done';attempt.phase='persisted';attempt.sourceId=source.id;ids.push(source.id);}
   else {attempt.status='failed';attempt.errorCode=op.errorCode;attempt.error=op.error;}
   if(attempt.methodClaimKey){
    const claim=job.executionState.evidenceMethodAttempts[attempt.methodClaimKey];
    const resolution={status:attempt.status,operationId:op.id,sourceId:source?.id||null,errorCode:attempt.errorCode||null,error:attempt.error||null,finishedAt:op.completedAt};
    const grant=methodResume.active(job);
    if(grant?.binding.claims.some(c=>c.key===claim.key)){(grant.receipts ||= {})[claim.key]=resolution;}
    else Object.assign(claim,resolution);
    if(source)methodClaims.push(claim.key);
   }
  }
  if(ids.length)work.pendingPlan={...plan(task,ids),...(methodClaims.length?{methodClaims}:{})};
 };
 commit(a,apply);return true;
}
function plan(task,ids){return {requestBasis:task.evidenceRequest.basis,sourceIds:[...new Set(ids)],commandId:'typed-evidence:'+hash({taskId:task.id,request:task.evidenceRequest.basis,sourceIds:[...new Set(ids)].sort()})};}
function pendingCurrent(a,job,task,p){
 if(!p||p.requestBasis!==task.evidenceRequest?.basis)return false;
 if(!p.methodClaims?.length)return true;
 const view=receiptView(a,job,task,p.methodClaims);
 return p.methodClaims.every(k=>{
  const claim=job.executionState?.evidenceMethodAttempts?.[k],all=items.allAttempts(job).filter(v=>v.methodClaimKey===k);
  // Current receipts retain their real per-item identity. Falling back to the
  // legacy +1 rule loses valid prepared-only replacements, while accepting any
  // ordinal would hide gaps or an actual earlier dispatch.
  const current=all.filter(v=>v.attemptId&&(v.dispatchId||null)===(claim?.dispatch?.id||null));
  if(all.some(v=>v.attemptId)&&new Set(current.map(v=>v.attemptId)).size!==1)return false;
  const r=methodReceipt(a,job,task,current[0]||{methodClaimKey:k},view);
  return r.source&&p.sourceIds.includes(r.source.id);
 });
}
// Read-only counterpart of recover(): share the receipt selection and plan
// construction, without settling a claim just to render or select work.
function recoveredPlan(a,job,task,episode){
 const saved=episode.evidenceAcquisition?.pendingPlan;
 const recovered=recoverable(a,job,task,episode).filter(r=>r.source);
 if(!recovered.length)return saved;
 const ids=[...rows(saved?.requestBasis===task.evidenceRequest?.basis?saved.sourceIds:[]),...recovered.map(r=>r.source.id)];
 const methodClaims=[...rows(saved?.methodClaims),...recovered.map(r=>r.attempt.methodClaimKey).filter(Boolean)];
 return {...plan(task,ids),...(methodClaims.length?{methodClaims:[...new Set(methodClaims)]}:{})};
}
function select(a,job,task,episode,available){
 const local=require('./platform-local-recovery.cjs').candidates(a,job,task,episode)[0];
 if(local)return {action:local};
 available ||= candidates(a,job,task,episode);
 const continuing=available.filter(p=>p.continuedClaim).slice(0,10);
 // Preserve the original claimed-batch ordering. Partial receipts do not
 // authorize early association of an unfinished method batch.
 if(continuing.length)return {selected:continuing,action:queryAction(task,continuing.map(p=>p.need))};
 const pending=recoveredPlan(a,job,task,episode);
 if(pending)return pendingCurrent(a,job,task,pending)?{action:planAction(a,task,pending)}:{};
 const selected=available.slice(0,10);
 return selected.length?{selected,action:queryAction(task,selected.map(p=>p.need))}:{};
}
function inspect(a,job,task,episode,options){
 const candidate=select(a,job,task,episode),block=require('./evidence-identity-preflight.cjs').action(a,job,candidate.action,options);
 return {...candidate,eligible:!!candidate.action,phase:'evidence',route:'evidence',...(block||{})};
}
function hasWork(a,job,task,episode){return !!select(a,job,task,episode).action;}

function request(a,job,task,episode,targets){
 if(task.evidenceRequest){store(episode).requestBasis=task.evidenceRequest.basis;return task.evidenceRequest;}
 const value={kind:'needs_evidence',summary:'先补齐当前明确关系缺口，再修订原稿',gaps:targets.map(n=>n.reason||n.obligationId),requirements:[...new Set(targets.map(n=>n.obligationId))],artifactId:require('./deliverables.cjs').primary(a,task)?.id};
 const basis=hash({taskId:task.id,workRevision:task.workRevision??1,targets:targets.map(key),sources:require('./evidence-continuation.cjs').inputRefs?.(a,task)||task.sourceIds});
 const r=require('./evidence-request.cjs').normalize(a,task,value,basis);
 require('./state-transitions.cjs').commit(a,()=>{task.evidenceRequest=r;store(episode).requestBasis=r.basis;});return r;
}
function planAction(a,task,p){return {tool:'plan_task',args:{existingTaskId:task.id,key:task.agentKey,title:task.title,criteria:task.criteria,reason:'关联当前明确缺口的实际证据，保留原主稿与交付步骤',sourceIds:p.sourceIds,primaryArtifactId:require('./deliverables.cjs').primary(a,task)?.id,evidenceResolution:{basis:p.requestBasis,sourceIds:p.sourceIds,reason:'将原明确关系缺口的实际查询回执关联到原事项，再重新核对剩余缺口'},commandId:p.commandId},reason:'把针对原缺口取得的事实一次关联到原事项',controlled:true,continuation:true};}
function queryAction(task,targets){const queries=[...new Map(targets.map(n=>[hash(require('./platform-boundaries.cjs').canonicalQuery(n.query)),n.query])).values()];return {tool:'platform_query',args:{taskId:task.id,queries},reason:'补查原明确关系缺口，当前阶段不生成或发布稿件',controlled:true,continuation:true};}
function prepare(a,job,task,episode){
 const view=inspect(a,job,task,episode);
 if(view.identity)require('./evidence-identity-preflight.cjs').assertNew(a,job);
 if(!view.action)return {};
 // Reuse only this synchronous inspection when recovery made no commit.
 // A recovered receipt changes claims/plans and requires fresh selection.
 const selected=recover(a,job,task,episode)?select(a,job,task,episode):view;
 if(selected.action?.tool==='platform_query')request(a,job,task,episode,selected.selected.map(p=>p.need));
 return selected;
}
function next(a,job,task,episode){return prepare(a,job,task,episode).action||null;}
function started(a,job,task,episode,step){
 if(step.tool==='recover_platform_result'){
  const action=require('./platform-local-recovery.cjs').candidates(a,job,task,episode).find(v=>hash(v.args)===hash(step.args));
  if(!action)throw Object.assign(Error('本地恢复的原回执或当前权限已变化'),{code:'LOCAL_RESULT_INTEGRITY',stopBatch:true});
  step.evidenceAcquisition={taskId:task.id,episodeBasis:episode.basis,requestBasis:task.evidenceRequest.basis,local:true,operationId:step.args.operationId};return true;
 }
 // Preparing is a command owned by the selected evidence route (next). A
 // different dispatch, especially a pending original check, cannot create a
 // request or reconcile a receipt while merely asking whether we own it.
 if(!['platform_query','plan_task'].includes(step.tool))return false;
 const authorizedResume=step.tool==='platform_query'?methodResume.candidates(a,job,task,episode).filter(r=>r.mode==='dispatch'):[];
 const available=step.tool==='platform_query'?candidates(a,job,task,episode):[];
 if(step.tool==='platform_query'&&rows(step.args?.queries).some(q=>storageMethod.consumed(job,q)&&!available.some(p=>(p.eligible||p.continuedClaim)&&storageMethod.sameQuery(p.need.query,q))&&!authorizedResume.some(r=>storageMethod.sameQuery(r.query,q))))throw Object.assign(Error('修复后的存储方法已领取；未取得可核对的持久回执时不得自动重发'),{code:'EVIDENCE_METHOD_ALREADY_CLAIMED'});
 const saved=episode.evidenceAcquisition;
 if(task.evidenceRequest?.kind!=='needs_evidence'||saved?.requestBasis!==task.evidenceRequest.basis)return false;
 // The guard above and this selection share one fresh synchronous projection;
 // nothing has committed between them. Dispatch still recomputes after next().
 const selection=select(a,job,task,episode,step.tool==='platform_query'?available:undefined),expected=selection.action,proofs=selection.selected||[];
 if(!expected)return false;
 if(step.tool==='platform_query')require('./evidence-identity-preflight.cjs').assertNew(a,job);
 if(step.tool!==expected.tool||hash(step.args)!==hash(expected.args))return false;
 const selected=proofs.map(p=>p.need);
 if(proofs.some(p=>p.resume)){
  if(!proofs.every(p=>p.resume))throw Object.assign(Error('技术恢复须独立于普通查询批次'),{code:'RESUME_MIXED_BATCH'});
  methodResume.claimInCommit(a,job,task,episode,step,a.activeAgentRun);
 }
 // All platform queries share this job's account grant. Hash the original
 // inputs once per grant in this synchronous dispatch; never across requests.
 const contexts=new Map();
 const claimContext=n=>{const check=storageMethod.permitted(a,job,task,n.query),key=hash(check);if(!contexts.has(key))contexts.set(key,storageMethod.context(a,job,task,check));return contexts.get(key);};
 const apply=()=>{
 const work=store(episode);step.evidenceAcquisition={taskId:task.id,episodeBasis:episode.basis,requestBasis:task.evidenceRequest?.basis};
 if(step.tool==='platform_query'){
  for(const p of proofs.filter(p=>p.continuedClaim)){const fresh=queuedMethod(a,job,task,episode,p.need);if(!fresh||hash(fresh)!==hash(p.continuedClaim))throw Object.assign(Error('未派发方法领取证明已变化'),{code:'STATE_STALE'});}
  step.evidenceAcquisition.targets=structuredClone(selected);
  for(const [i,n] of selected.entries()){
   const old=work.attempts[key(n)],proof=proofs[i],at=now();
   if(proof.resume){
    old.resumeGrantId=proof.resume.grantId;old.resumeDispatchId=step.dispatch.id;
   }else if(proof.continuedClaim){
    const claim=job.executionState.evidenceMethodAttempts[proof.continuedClaim.claimKey];
    (claim.preparedContinuations ||= []).push({attemptId:old.attemptId,operationId:claim.operationId||null,dispatch:structuredClone(claim.dispatch),proof:structuredClone(proof.continuedClaim.proof)});
    delete claim.operationId;
    claim.dispatch=structuredClone(step.dispatch);
    work.attempts[key(n)]={query:structuredClone(n.query),obligationId:n.obligationId,rootIds:[...n.rootIds],status:'started',at,method:claim.method,methodClaimKey:claim.key,previousAttempt:structuredClone(old.previousAttempt),continuedFromAttemptId:old.attemptId};
   }else if(proof.eligible){
    const claim={key:proof.claimKey,method:proof.method||storageMethod.METHOD,familyKey:proof.familyKey,originOperationId:proof.originOperationId,scope:storageMethod.scope(job),query:structuredClone(n.query),proof:proof.proof,previousAttempt:structuredClone(proof.proof.previousAttempt),taskId:task.id,episodeBasis:episode.basis,requestBasis:task.evidenceRequest.basis,request:structuredClone(task.evidenceRequest),context:claimContext(n),status:'started',at,...(step.dispatch?{dispatch:structuredClone(step.dispatch)}:{}),errorCode:'EVIDENCE_METHOD_RESULT_UNKNOWN',error:'存储方法已领取，须取得同一请求的持久回执；结果未知时不得自动重发'};
    (job.executionState.evidenceMethodAttempts ||= {})[claim.key]=claim;
    work.attempts[key(n)]={query:structuredClone(n.query),obligationId:n.obligationId,rootIds:[...n.rootIds],status:'started',at,method:proof.method||storageMethod.METHOD,methodClaimKey:claim.key,previousAttempt:structuredClone(proof.proof.previousAttempt)};
   }else work.attempts[key(n)]={query:structuredClone(n.query),obligationId:n.obligationId,rootIds:[...n.rootIds],status:'started',at};
   if(!proof.resume){if(old)(work.attemptHistory ||= []).push(structuredClone(old));items.claimInCommit(job,task,work.attempts[key(n)],step);}
  }
 }
 };
 // The request is already durable. The claim and its original proof must be
 // durable before even the platform identity query can start. Roll back live
 // references on save failure using the framework's synchronous transaction.
 if(!require('./dispatch-lifecycle.cjs').prepared(a,step)){
  try{commit(a,apply);}catch(error){delete step.evidenceAcquisition;throw error;}
 }else apply();
 items.registerStep(a,job,step);
 return true;
}
function settled(a,job,task,episode,step){
 if(!step.evidenceAcquisition)return false;
 const work=store(episode);
 if(step.tool==='plan_task'){
  if(step.error){work.lastError={code:step.errorCode,message:step.error};work.failedPlan=work.pendingPlan;}
  if(!step.error)for(const entry of Object.values(work.attempts||{}))if(rows(work.pendingPlan?.sourceIds).includes(entry.sourceId))entry.phase='associated';
  delete work.pendingPlan;return true;
 }
 for(const n of rows(step.evidenceAcquisition.targets)){
  const entry=work.attempts[key(n)];if(!entry||entry.methodClaimKey||!rows(step.evidenceAcquisition.attemptIds).includes(entry.attemptId))continue;
  const r=receipt(a,job,entry);
  if(r.source){Object.assign(entry,{status:'done',phase:'persisted',sourceId:r.source.id,finishedAt:r.op.completedAt});}
  else if(r.op?.status==='failed'){Object.assign(entry,{status:'failed',phase:'failed',errorCode:r.op.errorCode,error:r.op.error,finishedAt:r.op.completedAt});}
  else if(r.phase==='queued'){Object.assign(entry,{status:'queued',phase:'queued'});}
  else Object.assign(entry,{status:r.phase==='unknown'?'unknown':'unresolved',phase:r.phase||'unresolved',recoveryReason:r.reason||'PERSISTENT_RECEIPT_REQUIRED'});
 }
 recover(a,job,task,episode);
 return true;
}
module.exports={registerBuiltInAdapter:legacy.registerBuiltInAdapter,legacyPreflightCommands:legacy.pendingCommands,inspectItem:items.inspect,settleItemInCommit:items.settleInCommit,buildLegacyPreflightProof:legacy.buildProof,inspectLegacyPreflights:legacy.rowsForTask,prepareLegacyPreflight:legacy.prepare,needs,hasWork,inspect,next,started,settled};

const HANDOFF='continuation_evidence_handoff';
const journal=require('./work-journal.cjs');
function handoff(a,job,task,old,grant,{factKeys,intentBasis,nextBasis,newFactKeys}){
 const proofIdentity=hash({taskId:task.id,intentBasis,newFactKeys:[...newFactKeys].sort()});
 const payload={taskId:task.id,grantId:grant.grantId,previousBasis:old.basis,nextBasis,intentBasis,factKeys,newFactKeys,proofIdentity,at:now(),workRevision:job.workRevision??1,taskWorkRevision:task.workRevision??1,sourceProof:structuredClone(task.lastEvidenceResolution?.recoveryProof||null),facts:rel().recoveryFacts(a,job,task)};
 journal.commit(a,[{type:HANDOFF,entityKind:'job',entityId:job.id,actor:'system',workRevision:job.workRevision??1,payload}],{commitId:HANDOFF+':'+proofIdentity,expectedEntities:[{kind:'job',id:job.id,workRevision:job.workRevision??1},{kind:'task',id:task.id,workRevision:task.workRevision??1}]});return true;
}
journal.registerProjector(HANDOFF,(a,job,event)=>require('./continuation-control.cjs').projectEvidenceHandoff(a,job,event.payload));
function handoffEvent(a,job,task){
 const payload=require('./continuation-control.cjs').evidenceHandoffPayload(a,job,task,{pendingResolution:task.lastEvidenceResolution});
 return payload?{type:HANDOFF,entityKind:'job',entityId:job.id,actor:'system',workRevision:job.workRevision??1,payload}:null;
}
Object.assign(module.exports,{HANDOFF,handoff,handoffEvent});
