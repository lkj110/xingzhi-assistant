'use strict';
// One recovery of a failed consumption attempt, never a model/fee/ACL grant.
// Integration: inspect.command -> prepare; claim INSIDE the request append
// commit; afterModel AFTER the ordinary request observation commit. Load this
// module before journal.initialize/replay so its projectors are registered.
const {hash}=require('./evidence-basis.cjs');
const journal=require('./work-journal.cjs');
const rows=v=>Array.isArray(v)?v:[];
const copy=v=>structuredClone(v);
const own=(o,k)=>!!o&&Object.hasOwn(o,k);
const same=(a,b)=>hash(a)===hash(b);
const fail=(code,message=code)=>Object.assign(Error(message),{code,automaticRetry:false,noProgress:true});
const need=(ok,code='MODEL_PREFLIGHT_PROOF_INVALID')=>{if(!ok)throw fail(code);};
const now=()=>new Date().toISOString();
const ATTEST='model_preflight_producer_attested',TYPE='model_preflight_recovery';
const HEALTH_UPGRADE='model_preflight_health_upgraded',HEALTH_COMMAND='agentModelPreflightHealthUpgrade';
const REGISTRY=Object.freeze({
 id:'codex-0.42.0-r7',version:1,producerVersion:'0.42.0',schema:1,
 manifestHash:'6f895c7935f33b6788479eef05175ca7eb8b6e5872a14ac379d48bf8b5ee8f8d',
 installedAt:'2026-10-18T17:26:00.755580+08:00',
 sourceDigest:'29495f3f68884807d1e202c7ec701a2f6f124094706932405bd5b11279109077',
 packageDigest:'45a4e36d6eaf35e652ef67e0bfb60363c847c3baa0ba0f12b514075974df1f71',
 asarHash:'4304e9d892dfd34f0260dc4e4d9bc2342f553e1f1c1c0ddb9d65f8039ba66f92',
 writers:Object.freeze({subscription:'ddf5b3f1573e7c7ef50c00955279a4f99e59080fb5f7a29c20affee8ce6dc147',efficiency:'72914549626dd13ed1b51e666bb890133232ced9d94ae413ceb5db49555c2258',runModels:'1bba26b7812d803329e48d8809fe591fdafd5f1e8bee871260106b3c17061320',consumption:'2d6ca03b8aebea77197e41877a75351a07f7a28485e689078df9a6b4c79deea6'})
});
const MESSAGES=new Set(['无法确认 Codex 登录状态，请在模型设置中重新检测。','Codex 尚未使用 ChatGPT 登录，请在模型设置中重新检测']);
// Frozen r7's run-models snapshot fields. The diagnostic schema marker is also
// compared if present; missing fields are distinct from explicit null values.
const CALL_FIELDS=['id','at','taskId','runId','spendScope','spendTicketId','providerId','providerName','providerType','model','reasoning','role','stage','status','requestId','attempt','fallbackFrom','errorCode','errorMessage','diagnostic','producerSchema','inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','cacheWrite1hTokens','totalTokens','usageReported','estimatedUSD','routing','pricing'];
const TOKEN_FIELDS=['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','cacheWrite1hTokens','totalTokens'];
const STABLE=['version','jobId','taskId','attemptId','intent','scope','primaryLineageId','baseArtifactId','baseHash','stepId','targetFacts','additionalFacts','originalInputBasis','originalGenerationSnapshot','commandId','preparedAt'];
const pick=(o,fields)=>Object.fromEntries(fields.filter(k=>own(o,k)).map(k=>[k,o[k]]));
const tuple=r=>pick(r,['requestId','attempt','runId','callId','spendTicketId']);
const active=t=>require('./evidence-consumption.cjs').active(t);
const taskFor=(a,j,id)=>rows(a.data.tasks).find(t=>t.id===id&&t.agentJobId===j.id&&rows(j.taskIds).includes(id));
function owned(a,j,t){need(j&&t&&taskFor(a,j,t.id)===t&&rows(a.data.delegations).includes(j),'MODEL_PREFLIGHT_SCOPE_CHANGED');}
function instant(value){const n=Date.parse(value);need(Number.isFinite(n));return n;}
function noResult(value){for(const key of ['candidate','candidateHash','completionProof','receipt','result','results','response','output','artifactId','committedAt'])need(!own(value,key));}
function typed(d){return require('./model-errors.cjs').isPreflightDiagnostic(d);}
function diagnostics(value,native,expected,dispatch=false){
 for(const key of ['modelDispatched','execEntered'])if(own(value,key))need(value[key]===false);
 if(own(value,'phase'))need(value.phase===(dispatch?'prepared':'preflight'));
 for(const key of ['diagnostic','errorDiagnostic'])if(own(value,key))need(native&&typed(value[key])&&same(value[key],expected));
 if(own(value,'producerSchema'))need(native&&value.producerSchema===2);
}
function failureEvidence(a,j,t,old){
 owned(a,j,t);
 need(t.evidenceConsumption?.version===1&&old?.attemptId&&old.jobId===j.id&&old.taskId===t.id);
 need(['unknown','failed'].includes(old.status)&&rows(old.requests).length===1);
 noResult(old);
 const r=old.requests[0];
 need(['unknown','observed'].includes(r.status)&&r.responseStatus==='error'&&typeof r.errorCode==='string');
 need(typeof r.requestId==='string'&&r.requestId&&Number.isSafeInteger(r.attempt)&&r.attempt>0&&r.runId===old.runId&&r.callId&&r.spendTicketId);noResult(r);
 const matches=c=>c.id===r.callId||c.requestId===r.requestId&&c.attempt===r.attempt;
 const raw=rows(a.data.modelCalls).filter(matches);need(raw.length===1);
 const c=raw[0],runs=rows(a.data.agentRuns).filter(v=>v.id===r.runId);need(runs.length===1);
 const run=runs[0];
 need(run.jobId===j.id&&['blocked','error','failed'].includes(run.status)&&instant(run.finishedAt)>=instant(run.startedAt));
 need(c.id===r.callId&&c.requestId===r.requestId&&c.attempt===r.attempt&&c.runId===r.runId&&c.jobId===j.id&&c.taskId===t.id&&c.spendTicketId===r.spendTicketId&&c.spendScope==='job:'+j.id);
 need(c.providerType==='codex'&&c.providerId&&c.model&&c.role==='execute'&&c.stage==='task_work'&&c.status==='error'&&c.errorCode===r.errorCode&&typeof c.errorMessage==='string'&&!c.fallbackFrom);
 need(old.errorCode===c.errorCode&&old.error===c.errorMessage);
 need(instant(c.at)>=instant(run.startedAt)&&instant(c.at)<=instant(run.finishedAt)&&instant(r.finishedAt)<=instant(run.finishedAt));
 const allRunCopies=rows(a.data.agentRuns).flatMap(v=>rows(v.modelCallsDetail).filter(matches).map(call=>({run:v,call})));
 need(allRunCopies.length===1&&allRunCopies[0].run===run);
 const taskCopies=rows(a.data.tasks).flatMap(task=>rows(task.progressRuns).flatMap(v=>rows(v.modelCallsDetail).filter(matches).map(call=>({task,run:v,call}))));
 const taskRuns=rows(a.data.tasks).flatMap(task=>rows(task.progressRuns).filter(v=>v.id===c.taskRunId).map(run=>({task,run})));
 let taskRun=null;
 if(c.taskRunId||taskCopies.length){
  need(c.taskRunId&&taskRuns.length===1&&taskRuns[0].task===t&&taskCopies.length===1&&taskCopies[0].task===t&&taskCopies[0].run===taskRuns[0].run);
  taskRun=taskRuns[0].run;need(['blocked','error','failed'].includes(taskRun.status)&&instant(taskRun.startedAt)<=instant(c.at)&&instant(taskRun.finishedAt)<=instant(run.finishedAt));
 }
 const calls=[c,allRunCopies[0].call,...taskCopies.map(v=>v.call)];
 const steps=rows(run.steps).filter(s=>s.tool==='advance_task'&&s.args?.taskId===t.id);need(steps.length===1);
 const step=steps[0];need(step.id&&step.error===c.errorMessage&&step.errorCode===c.errorCode);noResult(step);
 for(const [key,value] of Object.entries({runId:run.id,jobId:j.id,taskId:t.id,requestId:r.requestId,attempt:r.attempt,callId:c.id,spendTicketId:r.spendTicketId}))if(own(step,key))need(step[key]===value);
 need(rows(run.modelCallsDetail).filter(v=>v.taskId===t.id&&v.role==='execute'&&v.stage==='task_work').length===1);
 if(step.dispatch){const d=step.dispatch;need(d.id===step.id&&d.stepId===step.id&&d.runId===run.id&&d.taskId===t.id&&d.jobId===j.id&&d.tool==='advance_task'&&d.argsHash===hash(step.args)&&d.phase==='prepared'&&!rows(d.requests).length);if(d.failure)need(d.failure.dispatchId===d.id&&d.failure.stepId===step.id&&d.failure.runId===run.id&&d.failure.code===c.errorCode&&d.failure.message===c.errorMessage&&d.failure.phase==='prepared'&&!d.failure.requestId);}
 const marked=[r,...calls,step,run,taskRun].filter(Boolean).some(v=>own(v,'producerSchema')||own(v,'phase')||own(v,'modelDispatched')||own(v,'execEntered')||v.diagnostic?.kind==='model_preflight'||v.errorDiagnostic?.kind==='model_preflight');
 const native=marked;
 if(native){
  need(r.producerSchema===2&&calls.every(v=>typed(v.diagnostic))&&typed(step.errorDiagnostic));
  need(['MODEL_AUTH','MODEL_CONFIG'].includes(c.errorCode));
  need(r.usageReported===true&&calls.every(v=>v.usageReported===true&&TOKEN_FIELDS.every(k=>!own(v,k)||v[k]===0)&&v.inputTokens===0&&v.outputTokens===0&&v.estimatedUSD===0));
  need(calls.every(v=>same(v.diagnostic,c.diagnostic))&&same(step.errorDiagnostic,c.diagnostic));
 }else{
  need(c.errorCode==='MODEL_AUTH'&&MESSAGES.has(c.errorMessage)&&r.usageReported===false);
  need(calls.every(v=>v.usageReported===false&&TOKEN_FIELDS.every(k=>!own(v,k))&&v.estimatedUSD===null));
  need(instant(c.at)>instant(REGISTRY.installedAt));
 }
 for(const v of [old,r,...calls,step,run,taskRun,step.dispatch?.failure].filter(Boolean)){diagnostics(v,native,c.diagnostic,v===step.dispatch?.failure);noResult(v);}
 for(const v of calls){need(same(pick(v,CALL_FIELDS),pick(c,CALL_FIELDS)));if(own(v,'jobId'))need(v.jobId===j.id);if(own(v,'taskRunId'))need(v.taskRunId===c.taskRunId);}
 for(const v of [run,taskRun].filter(Boolean))if(v.usage){need(TOKEN_FIELDS.every(k=>!own(v.usage,k)||v.usage[k]===0)&&(!own(v.usage,'estimatedUSD')||v.usage.estimatedUSD===0));if(!native)need(v.usage.reportedCalls===0);}
 return {version:1,mode:native?'native':'legacy',jobId:j.id,taskId:t.id,attemptId:old.attemptId,oldRunId:run.id,failedAt:run.finishedAt,
  originalRequest:copy(r),tuple:tuple(r),stable:copy(pick(old,STABLE)),call:copy(c),runCall:copy(allRunCopies[0].call),step:copy(step),
  run:copy(pick(run,['id','jobId','startedAt','finishedAt','status','error','diagnostic','errorDiagnostic','usage','modelCalls'])),
  taskRun:taskRun?{...copy(pick(taskRun,['id','startedAt','finishedAt','status','diagnostic','errorDiagnostic','usage'])),call:copy(taskCopies[0].call)}:null};
}
function attestationValid(a,p,evidenceHash){
 const v=p.modelPreflightAttestation;if(!v||v.version!==1||v.evidenceHash!==evidenceHash||!same(v.registry,REGISTRY)||v.attemptId!==p.attemptId||!['user','supervisor'].includes(v.executedBy)||!v.authorizationNote)return false;
 try{return journal.read(a).events.some(e=>e.type===ATTEST&&e.entityId===v.jobId&&e.actor===v.executedBy&&same(e.payload.attestation,v));}catch{return false;}
}
function candidate(a,j,t,{allowUnattested=false}={}){
 try{
  const p=active(t);need(p&&!p.modelPreflightRecovery,'MODEL_PREFLIGHT_RECOVERY_USED');
  need(!rows(t.evidenceConsumption.receipts).some(r=>r.attemptId===p.attemptId));
  const proof=failureEvidence(a,j,t,p),evidenceHash=hash(proof),attested=proof.mode==='native'||attestationValid(a,p,evidenceHash);
  return {eligible:attested||allowUnattested,reason:attested?null:'MODEL_PREFLIGHT_ATTESTATION_REQUIRED',mode:proof.mode,proof,evidenceHash,attested};
 }catch(e){return {eligible:false,reason:e.code||'MODEL_PREFLIGHT_PROOF_INVALID'};}
}
function fresh(a,j,t,p,{request=null,manual=false}={}){
 owned(a,j,t);
 // Only this exact failure may precede the normal nonretryable-error gate.
 // Agent.run clears its error after admission; it does not clear an unrelated
 // nonretryable failure on our behalf.
 if(j.lastErrorAutomaticRetry===false)need(j.lastErrorCode===p.modelPreflightRecovery?.oldAttempt.errorCode||!p.modelPreflightRecovery&&j.lastErrorCode===p.errorCode,'MODEL_PREFLIGHT_FAILURE_CHANGED');
 if(j.lastErrorAutomaticRetry===false)need(j.lastError===(p.modelPreflightRecovery?.oldAttempt.error||p.error),'MODEL_PREFLIGHT_FAILURE_CHANGED');
 require('./execution-gate.cjs').assert(a,{job:j,task:t,readOnly:true,...(manual?{automatic:false}:{})});
 need(!a.readOnlyRecovery&&!j.projectionPending&&!t.projectionPending&&!a.data.runtime?.projectionPending&&!a.data.runtime?.workJournal?.projectionPending,'WORK_PROJECTION_PENDING');
 const c=require('./evidence-consumption.cjs');
 need(require('./continuation-control.cjs').allowed(a,j,t,manual?{automatic:false}:{})&&!t.needsReplan&&!t.evidenceRequest&&c.current(a,j,t,p),'EVIDENCE_CONSUMPTION_STALE');
 need(!c.pendingBarrier(j,t),'CHECK_REQUEST_UNRESOLVED');
 need(!require('./pending-check.cjs').inspect(a,j,{taskId:t.id}).eligible,'CHECK_REQUEST_UNRESOLVED');
 const blocked=require('./spend-guard.cjs').inspect(a,j,t);need(!blocked,blocked?.code||'SPEND_LIMIT');
 const model=require('./execution-facts.cjs').modelGuard(a,j,t);need(!model,model?.code||'MODEL_CONFIGURATION_INVALID');
 require('./protocol-access.cjs').assertTool(a,j,'model',{taskId:t.id},{taskId:t.id});
 need(!require('./projects.cjs').relatedActions(a,j).some(v=>['pending','running','uncertain'].includes(v.status)||['unknown','uncertain'].includes(v.effectStatus)),'EXTERNAL_EFFECT_UNRESOLVED');
 need(!require('./execution-facts.cjs').blockingReasons(a,j,t).length,'EXECUTION_GATE_CLOSED');
 for(const other of Object.values(t.evidenceConsumption?.attempts||{})){
  if(other===p){const old=p.modelPreflightRecovery?.proof.originalRequest||p.requests[0];need(rows(p.requests).every(r=>r===request||same(r,old)),'EVIDENCE_GENERATION_UNRESOLVED');}
  else need(!['unknown','generating','result_retained','prepared'].includes(other.status)&&rows(other.requests).every(r=>r.status==='observed'&&r.usageReported===true||resolvedRequest(a,t,other,r)),'EVIDENCE_GENERATION_UNRESOLVED');
 }
}
function healthy(a,proof,expected){
 const health=require('./subscription-health.cjs');
 const verdict=health.valid(a,{after:proof.failedAt});
 need(verdict===true||verdict?.valid===true,'MODEL_PREFLIGHT_HEALTH_REQUIRED');
 const receipt=health.receipt?health.receipt(a):a.data.subscriptionHealth||a.data.runtime?.subscriptionHealth;
 need(receipt&&(!expected||['cliHash','configurationHash','intentHash'].every(k=>typeof receipt[k]==='string'&&receipt[k]===expected[k])),'MODEL_PREFLIGHT_HEALTH_CHANGED');
 return copy(receipt);
}
function healthUpgrade(a,j,t,p,g){
 const v=p.modelPreflightHealthUpgrade;
 const events=journal.read(a).events.filter(e=>e.type===HEALTH_UPGRADE&&e.payload?.upgrade?.grantId===g.id);
 if(!v){need(events.length===0,'MODEL_PREFLIGHT_UPGRADE_INVALID');return null;}
 need(v.version===1&&v.grantId===g.id&&v.jobId===j.id&&v.taskId===t.id&&v.attemptId===p.attemptId&&v.proofHash===g.proofHash&&v.oldHealthHash===hash(g.health)&&v.prepareEventId===g.eventId,'MODEL_PREFLIGHT_UPGRADE_INVALID');
 need(g.health.identityPolicyVersion===undefined&&v.health?.identityPolicyVersion===2&&['user','supervisor'].includes(v.executedBy)&&typeof v.authorizationNote==='string'&&v.authorizationNote.trim(),'MODEL_PREFLIGHT_UPGRADE_INVALID');
 need(['cliHash','intentHash'].every(k=>v.health[k]===g.health[k])&&require('./subscription-health.cjs').validAtClaim(a,v.health,{after:g.preparedAt,at:v.at}),'MODEL_PREFLIGHT_UPGRADE_INVALID');
 need(Number.isSafeInteger(v.workRevision)&&v.workRevision>=1&&Number.isSafeInteger(v.taskRevision)&&v.taskRevision>=1,'MODEL_PREFLIGHT_UPGRADE_INVALID');
 need(events.length===1&&events[0].commitId===v.id&&events[0].eventId===v.eventId&&events[0].entityKind==='job'&&events[0].entityId===j.id&&events[0].actor===v.executedBy&&events[0].workRevision===v.workRevision&&same(events[0].payload.upgrade,{...v,eventId:undefined}),'MODEL_PREFLIGHT_UPGRADE_INVALID');
 need(v.id===HEALTH_UPGRADE+':'+hash({grantId:g.id,attemptId:p.attemptId}),'MODEL_PREFLIGHT_UPGRADE_INVALID');
 const ordered=journal.read(a).events,prepareIndex=ordered.findIndex(e=>e.type===TYPE&&e.eventId===g.eventId),upgradeIndex=ordered.findIndex(e=>e.eventId===v.eventId);
 need(prepareIndex>=0&&upgradeIndex>prepareIndex&&instant(g.preparedAt)<instant(v.at),'MODEL_PREFLIGHT_UPGRADE_INVALID');
 return v;
}
function effectiveHealth(a,j,t,p,g){return healthUpgrade(a,j,t,p,g)?.health||g.health;}
function upgradeHealth(a,j,input={}){
 need(require('./workspace-view.cjs').trustedCommand(a,HEALTH_COMMAND),'TRUSTED_UI_COMMAND_REQUIRED');
 need(Object.keys(input).every(k=>['id','taskId','attemptId','grantId','proofHash','expectedGrantHash','expectedWorkRevision','expectedTaskRevision','expectedHealthCheckId','expectedHealthSequence','executedBy','authorizationNote'].includes(k)),'MODEL_PREFLIGHT_UPGRADE_INPUT');
 need(['user','supervisor'].includes(input.executedBy)&&typeof input.authorizationNote==='string'&&input.authorizationNote.trim()&&input.authorizationNote.length<=16000,'AUTHORIZATION_INPUT_REQUIRED');
 const t=taskFor(a,j,input.taskId);owned(a,j,t);const p=active(t),g=grant(a,j,t);
 need(g&&g.status==='prepared'&&p.status==='prepared'&&!g.claim,'MODEL_PREFLIGHT_RECOVERY_USED');
 need(input.id===j.id&&input.attemptId===p.attemptId&&input.grantId===g.id&&input.proofHash===g.proofHash&&input.expectedGrantHash===hash(g)&&input.expectedWorkRevision===(j.workRevision??1)&&input.expectedTaskRevision===(t.workRevision??1),'STATE_STALE');
 const existing=healthUpgrade(a,j,t,p,g);if(existing){need(existing.executedBy===input.executedBy&&existing.authorizationNote===input.authorizationNote.trim()&&existing.health.checkId===input.expectedHealthCheckId&&existing.health.sequence===input.expectedHealthSequence,'MODEL_PREFLIGHT_ALREADY_UPGRADED');return copy(existing);}
 need(g.health.identityPolicyVersion===undefined,'MODEL_PREFLIGHT_UPGRADE_NOT_LEGACY');
 need(!a.activeAgentRun&&!require('./work-state.cjs').inFlight(a,j),'EXECUTION_RUNNING');
 need(p.requests.length===1&&same(p.requests[0],g.proof.originalRequest),'EVIDENCE_GENERATION_UNRESOLVED');noResult(p);
 need(!rows(a.data.modelCalls).some(c=>c.taskId===t.id&&c.role==='execute'&&c.stage==='task_work'&&Date.parse(c.at)>=Date.parse(g.preparedAt)),'EVIDENCE_GENERATION_UNRESOLVED');
 fresh(a,j,t,p,{manual:true});
 const receipt=require('./subscription-health.cjs').valid(a,{after:g.preparedAt});
 need(receipt?.valid===true&&receipt.identityPolicyVersion===2,'MODEL_PREFLIGHT_HEALTH_REQUIRED');
 const health=require('./subscription-health.cjs').receipt(a);
 need(health.checkId===input.expectedHealthCheckId&&health.sequence===input.expectedHealthSequence,'STATE_STALE');
 need(['cliHash','intentHash'].every(k=>health[k]===g.health[k]),'MODEL_PREFLIGHT_HEALTH_CHANGED');
 const upgrade={version:1,id:HEALTH_UPGRADE+':'+hash({grantId:g.id,attemptId:p.attemptId}),jobId:j.id,taskId:t.id,attemptId:p.attemptId,grantId:g.id,prepareEventId:g.eventId,proofHash:g.proofHash,oldHealthHash:hash(g.health),health,executedBy:input.executedBy,authorizationNote:input.authorizationNote.trim(),workRevision:j.workRevision??1,taskRevision:t.workRevision??1,at:now()};
 journal.commit(a,[{type:HEALTH_UPGRADE,entityKind:'job',entityId:j.id,workRevision:j.workRevision??1,actor:input.executedBy,payload:{upgrade}}],{commitId:upgrade.id,expectedRevision:a.data.runtime?.revision||0});
 return copy(healthUpgrade(a,j,t,p,g));
}
function inspect(a,j,t){
 const g=grant(a,j,t);
 if(g){
  if(g.status!=='prepared')return {eligible:false,phase:g.status,reason:'MODEL_PREFLIGHT_RECOVERY_USED',grant:g};
  try{
   need(active(t).status==='prepared','MODEL_PREFLIGHT_RECOVERY_USED');fresh(a,j,t,active(t));healthy(a,g.proof,effectiveHealth(a,j,t,active(t),g));
   return {eligible:true,phase:'consume',route:'consume',grant:g,action:{tool:'advance_task',args:{taskId:t.id},reason:'接续已证明未派发的原稿修订',controlled:true,continuation:true}};
  }catch(e){return {eligible:false,phase:'blocked',reason:e.code||'MODEL_PREFLIGHT_GUARDED',grant:g};}
 }
 const c=candidate(a,j,t);if(!c.eligible)return {...c,phase:'blocked'};
 try{fresh(a,j,t,active(t));const health=healthy(a,c.proof);return {...c,eligible:true,phase:'prepare_pending',command:TYPE,health};}catch(e){return {...c,eligible:false,phase:'blocked',reason:e.code||'MODEL_PREFLIGHT_GUARDED'};}
}
function resumeAction(a,j,t){const v=inspect(a,j,t);return v.eligible&&v.action?v.action:null;}
function view(a,j){
 for(const id of rows(j.taskIds)){
  const t=taskFor(a,j,id),p=t&&active(t);if(!p)continue;
  const g=grant(a,j,t);if(g)return {taskId:t.id,attemptId:p.attemptId,oldRunId:g.proof?.oldRunId,grant:{id:g.id,status:g.status},candidate:false,
   healthUpgrade:g.status==='prepared'&&p.status==='prepared'&&g.health.identityPolicyVersion===undefined&&!p.modelPreflightHealthUpgrade?{grantId:g.id,proofHash:g.proofHash,expectedGrantHash:hash(g),expectedWorkRevision:j.workRevision??1,expectedTaskRevision:t.workRevision??1,expectedHealthCheckId:require('./subscription-health.cjs').receipt(a)?.checkId||null,expectedHealthSequence:require('./subscription-health.cjs').receipt(a)?.sequence||null}:null};
  const c=candidate(a,j,t,{allowUnattested:true});if(!c.eligible)continue;
  return {candidate:true,taskId:t.id,attemptId:p.attemptId,oldRunId:c.proof.oldRunId,evidenceHash:c.evidenceHash,registry:copy(REGISTRY),attested:c.attested,native:c.mode==='native',expectedWorkRevision:j.workRevision??1,expectedTaskRevision:t.workRevision??1};
 }
 return null;
}
function attest(a,j,input={}){
 need(require('./workspace-view.cjs').trustedCommand(a,'agentModelPreflightAttest'),'TRUSTED_UI_COMMAND_REQUIRED');
 need(Object.keys(input).every(k=>['id','taskId','attemptId','evidenceHash','registryId','executedBy','authorizationNote','expectedWorkRevision','expectedTaskRevision'].includes(k)),'MODEL_PREFLIGHT_ATTESTATION_INPUT');
 need(['user','supervisor'].includes(input.executedBy)&&typeof input.authorizationNote==='string'&&input.authorizationNote.trim()&&input.authorizationNote.length<=16000,'AUTHORIZATION_INPUT_REQUIRED');
 const t=taskFor(a,j,input.taskId);owned(a,j,t);
 need(input.id===j.id&&input.registryId===REGISTRY.id&&input.expectedWorkRevision===(j.workRevision??1)&&input.expectedTaskRevision===(t.workRevision??1),'STATE_STALE');
 need(!a.activeAgentRun&&!require('./work-state.cjs').inFlight(a,j),'EXECUTION_RUNNING');
 const p=active(t),c=candidate(a,j,t,{allowUnattested:true});need(c.eligible&&c.mode==='legacy',c.reason||'MODEL_PREFLIGHT_PROOF_INVALID');
 need(input.attemptId===p.attemptId&&input.evidenceHash===c.evidenceHash,'STATE_STALE');
 const existing=p.modelPreflightAttestation;
 if(existing){need(attestationValid(a,p,c.evidenceHash),'MODEL_PREFLIGHT_ATTESTATION_INVALID');return copy(existing);}
 const attestation={version:1,jobId:j.id,taskId:t.id,attemptId:p.attemptId,evidenceHash:c.evidenceHash,tuple:c.proof.tuple,registry:copy(REGISTRY),executedBy:input.executedBy,authorizationNote:input.authorizationNote.trim(),at:now()};
 journal.commit(a,[{type:ATTEST,entityKind:'job',entityId:j.id,workRevision:j.workRevision??1,actor:input.executedBy,payload:{attestation}}],{commitId:ATTEST+':'+hash({jobId:j.id,attemptId:p.attemptId,evidenceHash:c.evidenceHash})});
 return copy(p.modelPreflightAttestation);
}
function prepare(a,j,t,expected){
 const existing=grant(a,j,t);if(existing)return existing;
 const c=inspect(a,j,t);need(c.eligible,c.reason||'MODEL_PREFLIGHT_PROOF_INVALID');
 if(expected)need(same(expected.proof||expected,c.proof),'STATE_STALE');
 const p=active(t),proof=c.proof,id=TYPE+':'+hash({jobId:j.id,taskId:t.id,attemptId:p.attemptId});
 const g={version:1,id,jobId:j.id,taskId:t.id,attemptId:p.attemptId,status:'prepared',proof,proofHash:hash(proof),oldAttempt:copy(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='modelPreflightAttestation'))),health:c.health,attestation:p.modelPreflightAttestation?copy(p.modelPreflightAttestation):null,preparedAt:now()};
 journal.commit(a,[{type:TYPE,entityKind:'job',entityId:j.id,workRevision:j.workRevision??1,actor:'system',payload:{grant:g}}],{commitId:id});
 return grant(a,j,t);
}
function apply(a,j,t,g,event){
 owned(a,j,t);const p=t.evidenceConsumption?.attempts?.[g.attemptId];need(p?.attemptId===g.attemptId&&g.jobId===j.id&&g.taskId===t.id&&g.version===1&&g.status==='prepared'&&g.proofHash===hash(g.proof));
 if(p.modelPreflightRecovery){need(p.modelPreflightRecovery.id===g.id);return;}
 need(same(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='modelPreflightAttestation')),g.oldAttempt),'MODEL_PREFLIGHT_REPLAY_STALE');
 need(same(failureEvidence(a,j,t,g.oldAttempt),g.proof));
 if(g.proof.mode==='legacy')need(attestationValid(a,p,g.proofHash)&&same(p.modelPreflightAttestation,g.attestation),'MODEL_PREFLIGHT_ATTESTATION_REQUIRED');
 // Replay records the historical decision; current gates/health are rechecked
 // at claim, and an expired receipt cannot cause replay to mint a newer one.
 p.modelPreflightRecovery=copy(g);p.status='prepared';
 p.modelPreflightRecovery.eventId=event.eventId;
}
function grant(a,j,t,p=active(t)){
 try{
  owned(a,j,t);need(p&&t.evidenceConsumption?.attempts?.[p.attemptId]===p);const g=p.modelPreflightRecovery;
  need(g&&g.version===1&&g.jobId===j.id&&g.taskId===t.id&&g.attemptId===p.attemptId&&['prepared','claimed','terminal'].includes(g.status));
  need(g.proofHash===hash(g.proof)&&same(pick(p,STABLE),g.proof.stable));
  need(rows(p.requests).filter(r=>same(r,g.proof.originalRequest)).length===1);
  need(same(failureEvidence(a,j,t,g.oldAttempt),g.proof));
  const prepares=journal.read(a).events.filter(e=>e.type===TYPE&&(e.entityId===j.id||e.payload?.grant?.jobId===j.id)&&e.payload?.grant?.taskId===t.id&&e.payload?.grant?.attemptId===p.attemptId),event=prepares[0];
  need(prepares.length===1&&event.commitId===g.id&&event.eventId===g.eventId&&event.entityKind==='job'&&event.entityId===j.id&&same(event.payload.grant,{...g,status:'prepared',eventId:undefined,claim:undefined,terminal:undefined}));
  if(g.proof.mode==='legacy')need(attestationValid(a,p,g.proofHash)&&same(g.attestation,p.modelPreflightAttestation));
  const upgraded=healthUpgrade(a,j,t,p,g),boundHealth=upgraded?.health||g.health;
  if(g.status!=='prepared'){
   need(g.claim&&g.claim.requestId!==g.proof.tuple.requestId&&g.claim.runId!==g.proof.oldRunId);
   const found=rows(p.requests).filter(r=>r.requestId===g.claim.requestId&&r.attempt===g.claim.attempt);
   need(found.length===1&&found[0].runId===g.claim.runId&&found[0].spendTicketId===g.claim.spendTicketId&&found[0].producerSchema===2);
   if(g.claim.callId)need(found[0].callId===g.claim.callId);
   need((g.claim.healthUpgradeId||null)===(upgraded?.id||null)&&g.claim.health&&['cliHash','configurationHash','intentHash'].every(k=>g.claim.health[k]===boundHealth[k])&&require('./subscription-health.cjs').validAtClaim(a,g.claim.health,{after:g.proof.failedAt,at:g.claim.at}),'MODEL_PREFLIGHT_CLAIM_HEALTH_INVALID');
   if(upgraded)need(instant(g.claim.at)>=instant(upgraded.at),'MODEL_PREFLIGHT_CLAIM_HEALTH_INVALID');
  }
  return g;
 }catch{return null;}
}
function resolvedRequest(a,t,p,r){
 const j=rows(a.data.delegations).find(j=>j.id===t.agentJobId),g=grant(a,j,t,p);
 if(!g||!rows(p.requests).includes(r)||!same(r,g.proof.originalRequest)||!same(tuple(r),g.proof.tuple))return false;
 try{if(g.status==='prepared')healthy(a,g.proof,effectiveHealth(a,j,t,p,g));return true;}catch{return false;}
}
// The policy-selected recovery owns one exact action, not the legacy planner.
// Keep this ownership through the final efficiency guard without resetting its
// historical failure counters. Model dispatch still requires atomic claim.
function permits(a,j,{task,stage,action}={}){
 if(!task||!(stage==='dispatch'&&action?.tool==='advance_task'&&action.args?.taskId===task.id||stage==='task_work'&&!action))return false;
 const run=a.activeAgentRun,p=active(task);
 if(a.activeAgentJob!==j||!run||run.jobId!==j.id||run.status!=='running'||run.finishedAt||!rows(a.data.agentRuns).includes(run)||!p?.modelPreflightRecovery||!['prepared','generating'].includes(p.status))return false;
 const g=grant(a,j,task);need(g,'MODEL_PREFLIGHT_PROOF_INVALID');
 need(g.status==='prepared','MODEL_PREFLIGHT_RECOVERY_USED');
 if(stage==='task_work'){
  need(a.activeSpendTask===task,'MODEL_PREFLIGHT_SCOPE_CHANGED');
  assertBeforeModel(a,{role:'execute',stage:'task_work'});
 }else{
  need(p.status==='prepared','MODEL_PREFLIGHT_RECOVERY_USED');
  fresh(a,j,task,p);healthy(a,g.proof,effectiveHealth(a,j,task,p,g));
 }
 return true;
}
function assertBeforeModel(a,meta={},request=null){
 const t=a.activeSpendTask,j=a.activeAgentJob,p=t&&active(t);if(!p?.modelPreflightRecovery)return null;
 const g=grant(a,j,t);need(g,'MODEL_PREFLIGHT_PROOF_INVALID');
 need(g.status==='prepared','MODEL_PREFLIGHT_RECOVERY_USED');
 need(meta.role==='execute'&&meta.stage==='task_work'&&p.status==='generating'&&p.runId===(a.activeAgentRun?.id||a.activeSpendRun?.id)&&p.runId!==g.proof.oldRunId,'MODEL_PREFLIGHT_REQUEST_INVALID');
 fresh(a,j,t,p,{request});healthy(a,g.proof,effectiveHealth(a,j,t,p,g));
 return g;
}
// MUTATION ONLY. Caller appends `request` and calls this in ONE synchronous
// state-transitions.commit. A failed append/claim save must never call chat.
function claim(a,meta,request){
 const g=assertBeforeModel(a,meta,request);if(!g)return null;
 const p=active(a.activeSpendTask);
 need(request&&p.requests.includes(request)&&request.status==='possible_dispatch'&&request.producerSchema===2&&request.requestId===meta.requestId&&request.attempt===meta.attempt&&request.runId===p.runId&&request.spendTicketId===meta.spendTicket?.id&&request.spendTicketId&&request.requestId!==g.proof.tuple.requestId&&request.spendTicketId!==g.proof.tuple.spendTicketId,'MODEL_PREFLIGHT_REQUEST_INVALID');
 need(rows(a.data.modelCalls).every(c=>c.requestId!==request.requestId),'MODEL_PREFLIGHT_REQUEST_REUSED');
 const health=healthy(a,g.proof,effectiveHealth(a,a.activeAgentJob,a.activeSpendTask,p,g)),at=now();
 need(require('./subscription-health.cjs').validAtClaim(a,health,{after:g.proof.failedAt,at}),'MODEL_PREFLIGHT_CLAIM_HEALTH_INVALID');
 if(p.modelPreflightHealthUpgrade)need(instant(at)>=instant(p.modelPreflightHealthUpgrade.at),'MODEL_PREFLIGHT_CLAIM_HEALTH_INVALID');
 g.status='claimed';g.claim={...tuple(request),callId:null,producerSchema:2,at,health,...(p.modelPreflightHealthUpgrade?{healthUpgradeId:p.modelPreflightHealthUpgrade.id}:{})};return g;
}
function afterModel(a,meta,error){
 const t=a.activeSpendTask,j=a.activeAgentJob,p=t&&active(t);if(!p?.modelPreflightRecovery)return null;
 const g=grant(a,j,t);need(g,'MODEL_PREFLIGHT_PROOF_INVALID');
 if(g.status==='terminal')return g;
 need(g.status==='claimed'&&g.claim.requestId===meta.requestId&&g.claim.attempt===meta.attempt,'MODEL_PREFLIGHT_REQUEST_INVALID');
 const r=p.requests.find(r=>r.requestId===meta.requestId&&r.attempt===meta.attempt);
 const calls=rows(a.data.modelCalls).filter(c=>c.requestId===meta.requestId&&c.attempt===meta.attempt);
 // A missing call is still an unknown claimed request, never another grant.
 if(calls.length!==1||!r?.callId||calls[0].id!==r.callId)return g;
 const c=calls[0];need(c.runId===g.claim.runId&&c.spendTicketId===g.claim.spendTicketId&&c.taskId===t.id&&c.jobId===j.id,'MODEL_PREFLIGHT_REQUEST_INVALID');
 need(['done','error','stopped','interrupted'].includes(c.status),'MODEL_PREFLIGHT_RESULT_PENDING');
 require('./state-transitions.cjs').commit(a,()=>{g.status='terminal';g.claim.callId=c.id;g.terminal={at:now(),callId:c.id,status:c.status,errorCode:error?.code||r.errorCode||null};});
 return g;
}
journal.registerProjector(ATTEST,(a,j,event)=>{
 if(!j)return;const v=event.payload.attestation,t=taskFor(a,j,v.taskId),p=t?.evidenceConsumption?.attempts?.[v.attemptId];need(p?.attemptId===v.attemptId&&v.jobId===j.id&&same(v.registry,REGISTRY));
 if(p.modelPreflightAttestation){need(same(p.modelPreflightAttestation,v));return;}
 const c=candidate(a,j,t,{allowUnattested:true});need(c.eligible&&c.mode==='legacy'&&c.evidenceHash===v.evidenceHash&&same(c.proof.tuple,v.tuple));
 need(event.actor===v.executedBy&&['user','supervisor'].includes(v.executedBy)&&v.authorizationNote);p.modelPreflightAttestation=copy(v);
});
journal.registerProjector(TYPE,(a,j,event)=>{if(j)apply(a,j,taskFor(a,j,event.payload.grant.taskId),event.payload.grant,event);});
journal.registerProjector(HEALTH_UPGRADE,(a,j,event)=>{
 need(j,'MODEL_PREFLIGHT_UPGRADE_INVALID');const v=event.payload.upgrade,t=taskFor(a,j,v.taskId),p=t?.evidenceConsumption?.attempts?.[v.attemptId],g=p?.modelPreflightRecovery;
 need(g&&g.id===v.grantId,'MODEL_PREFLIGHT_UPGRADE_INVALID');
 if(p.modelPreflightHealthUpgrade){need(same(p.modelPreflightHealthUpgrade,{...v,eventId:event.eventId}),'MODEL_PREFLIGHT_UPGRADE_INVALID');healthUpgrade(a,j,t,p,g);return;}
 need(g.status==='prepared'&&p.status==='prepared'&&!g.claim&&p.requests.length===1&&same(p.requests[0],g.proof.originalRequest),'MODEL_PREFLIGHT_RECOVERY_USED');
 p.modelPreflightHealthUpgrade={...copy(v),eventId:event.eventId};healthUpgrade(a,j,t,p,g);
});
module.exports={TYPE,ATTEST,REGISTRY,HEALTH_UPGRADE,HEALTH_COMMAND,candidate,inspect,view,preview:view,attest,upgradeHealth,prepare,apply,grant,resumeAction,assertBeforeModel,claim,resolvedRequest,afterModel,permits};
