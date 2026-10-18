'use strict';
// A continuation receipt belongs to a particular generated output. It carries
// no permission, new retry allowance or business-completion assertion.
const {hash}=require('./evidence-basis.cjs');
const rows=x=>Array.isArray(x)?x:[];
const TYPE='continuation_check_restored';
const CONTEXT_REPAIR='internal_context_authorization';
const DEFERRED_ACTIVATION='deferred_evidence_ready';
const finished=p=>!p||['settled','superseded'].includes(p.status);
const now=()=>new Date().toISOString();
function intent(job,task){return hash({contract:job.executionContract?.text||job.goal,requirements:task.userRequirement?Object.fromEntries(['description','objective','criteria'].map(k=>[k,task.userRequirement[k]])):null});}
function taskFor(a,j,id){return rows(a.data.tasks).find(t=>t.id===id&&t.agentJobId===j.id&&rows(j.taskIds).includes(t.id));}
function current(a,j,t,receipt){
 const artifact=require('./deliverables.cjs').primary(a,t),step=rows(t.steps).find(s=>s.done&&s.artifactId===artifact?.id&&s.id===artifact?.stepId);
 if(!artifact||!step||artifact.origin==='user_import'||artifact.stale||step.kind!=='draft'||step.outputHash!==hash(artifact.content))return null;
 const inputHash=require('./step-evidence.cjs').snapshot(a,t,step).hash;
 if(step.inputBasis?.hash!==inputHash&&receipt?.activationInputBasis!==inputHash)return null;
 return {artifact,step,checkBasis:require('./execution-control.cjs').contentBasis(a,j,t)};
}
function valid(a,j,t,e,p){
 if(!p||p.taskId!==t.id||p.taskWorkRevision!==(t.workRevision??1)||p.ownerEpisodeId!==e.basis||p.intentBasis!==intent(j,t)||e.intentBasis!==p.intentBasis||e.blocked||e.complete||e.cycles>=(e.cycleLimit||3))return false;
 const c=current(a,j,t,p);
 return !!c&&c.artifact.id===p.artifactId&&hash(c.artifact.content)===p.artifactHash&&c.step.id===p.stepId&&c.step.inputBasis.hash===p.inputBasis&&c.checkBasis===p.checkBasis&&!t.needsReplan&&!t.evidenceRequest;
}
// A never-started check can wait for typed evidence without owning the next
// action. Activating it refreshes only the check basis, never the draft's input
// receipt. Additive sources are admitted only after every current fact has an
// integration receipt; changed original inputs still require coordination.
function deferredCandidate(a,j,t,e,{checkGuards=true}={}){
 const p=e.pendingCheck;
 if(p?.status!=='deferred_evidence'||p.taskId!==t.id||p.ownerEpisodeId!==e.basis||p.taskWorkRevision!==(t.workRevision??1)||p.intentBasis!==intent(j,t)||e.intentBasis!==p.intentBasis||e.blocked||e.complete||e.cycles>=(e.cycleLimit||3))return null;
 if(p.claimId||p.claimedByRunId||p.claimedAt||p.interruption||rows(p.claimHistory).length)return {reason:'CHECK_REQUEST_UNRESOLVED'};
 if(t.needsReplan||t.evidenceRequest)return {reason:'CHECK_EVIDENCE_PENDING'};
 const consumption=require('./evidence-consumption.cjs'),progress=consumption.view(a,j,t);
 if(progress?.remaining>0)return {reason:'CHECK_EVIDENCE_NOT_INTEGRATED'};
 if(!consumption.coverage(a,j,t))return {reason:'CHECK_EVIDENCE_PENDING'};
 const artifact=require('./deliverables.cjs').primary(a,t),step=rows(t.steps).find(s=>s.id===artifact?.stepId&&s.artifactId===artifact?.id&&s.done&&s.kind==='draft');
 if(!step?.inputBasis)return {reason:'CHECK_DEFERRED_INPUT_CHANGED',needsReconcile:true};
 const input=require('./step-evidence.cjs').snapshot(a,t,step),oldInput=step.inputBasis;
 if(input.hash!==oldInput.hash){
  const {hash:oldHash,sources:oldSources,...oldRest}=oldInput,{hash:newHash,sources:newSources,...newRest}=input;
  const additive=Array.isArray(oldSources)&&Array.isArray(newSources)&&hash(oldRest)===hash(newRest)&&oldSources.every(s=>newSources.some(n=>hash(n)===hash(s)))&&newSources.length>oldSources.length;
  if(!additive||!progress||progress.remaining!==0||progress.obtained<=0)return {reason:'CHECK_DEFERRED_INPUT_CHANGED',needsReconcile:true};
 }
 const activationInputBasis=input.hash,c=current(a,j,t,{activationInputBasis});
 if(!c||c.artifact.id!==p.artifactId||hash(c.artifact.content)!==p.artifactHash||c.step.id!==p.stepId||c.step.inputBasis.hash!==p.inputBasis)return {reason:'CHECK_DEFERRED_INPUT_CHANGED',needsReconcile:true};
 if(rows(t.steps).slice(0,t.steps.indexOf(c.step)).some(s=>!s.done))return {reason:'CHECK_PREREQUISITES_PENDING'};
 if(checkGuards){const reason=guards(a,j,t,{activationInputBasis});if(reason)return {reason};}
 const state=j.executionState.continuation;
 const proof={kind:DEFERRED_ACTIVATION,pendingHash:hash(p),artifactId:p.artifactId,artifactHash:p.artifactHash,inputBasis:p.inputBasis,activationInputBasis,checkBasis:c.checkBasis,ownerEpisodeId:e.basis,taskWorkRevision:t.workRevision??1,intentBasis:p.intentBasis,expectedOwner:{taskId:state.activeTaskId||null,basis:state.activeBasis||null}};
 return {eligible:true,proof,pending:{...structuredClone(p),status:'pending',activationInputBasis,checkBasis:c.checkBasis},commandId:hash({type:TYPE,proof})};
}
function recordGenerated(a,job,task,step,artifact){
 const run=a.activeAgentRun,dispatch=rows(run?.steps).at(-1),state=job?.executionState?.continuation;
 const e=state?.episodes?.[dispatch?.continuation?.basis];
 if(!e||e.taskId!==task.id||e.blocked||e.complete||dispatch?.tool!=='advance_task'||dispatch.args?.taskId!==task.id||step.kind!=='draft'||require('./deliverables.cjs').primary(a,task)?.id!==artifact.id)return null;
 const generationAttemptId=hash({runId:run.id,index:run.steps.length-1,at:dispatch.at,taskId:task.id,stepId:step.id});
 artifact.generationAttemptId=generationAttemptId;
 const p={ownerEpisodeId:e.basis,generationAttemptId,agentRunId:run.id,taskId:task.id,stepId:step.id,intentBasis:intent(job,task),taskWorkRevision:task.workRevision??1,artifactId:artifact.id,artifactHash:hash(artifact.content),inputBasis:step.inputBasis.hash,checkPhase:'content',checkBasis:require('./execution-control.cjs').contentBasis(a,job,task),status:'pending',createdAt:artifact.createdAt};
 if(e.pendingCheck?.generationAttemptId===generationAttemptId){const old=e.pendingCheck;if(['taskId','stepId','artifactId','artifactHash','inputBasis','checkBasis','intentBasis','taskWorkRevision'].some(key=>old[key]!==p[key]))throw Object.assign(Error('同一生成尝试对应不同产出，需核对原执行记录'),{code:'CHECK_RECEIPT_CONFLICT'});return old;}
 if(require('./evidence-consumption.cjs').draftOnly(a,task)){
  const prior=Object.values(state.episodes||{}).filter(v=>v.taskId===task.id&&!finished(v.pendingCheck));
  if(prior.some(v=>v.pendingCheck.status!=='deferred_evidence'||v.pendingCheck.claimId||v.pendingCheck.claimedByRunId||v.pendingCheck.claimedAt||v.pendingCheck.interruption||rows(v.pendingCheck.claimHistory).length))throw Object.assign(Error('原稿仍有未结算的检查，不能以增量草稿替换原请求'),{code:'CHECK_REQUEST_UNRESOLVED',taskId:task.id});
  for(const v of prior){const old=v.pendingCheck;old.status='superseded';old.supersededAt=artifact.createdAt;old.supersededBy=artifact.id;if(v!==e)(v.checkReceipts ||= []).push(structuredClone(old));}
  const consumption=require('./evidence-consumption.cjs');
  if(!consumption.coverage(a,job,task)||consumption.view(a,job,task)?.remaining>0||rows(task.steps).slice(0,task.steps.indexOf(step)).some(s=>!s.done))p.status='deferred_evidence';
 }
 if(e.pendingCheck&&e.pendingCheck.generationAttemptId!==generationAttemptId)(e.checkReceipts ||= []).push(structuredClone(e.pendingCheck));
 e.pendingCheck=p;return p;
}
function ownerAllows(job,taskId,basis){const s=job.executionState?.continuation;return !!s&&(!s.activeTaskId&&(!s.activeBasis||s.activeBasis===basis)||s.activeTaskId===taskId&&s.activeBasis===basis);}
function requestHistory(a,run,{since,taskId,allowInput=false,requireCalls=false,wholeRun=false}={}){
 if(!run||!Array.isArray(run.modelCallsDetail))return null;
 const details=run.modelCallsDetail,byId=new Map(details.map(r=>[r.id,r]));
 if(byId.size!==details.length||details.some(r=>!r.id)||Number.isInteger(run.modelCalls)&&run.modelCalls!==details.length)return null;
 // Join by durable call identity before selecting the run: a conflicting
 // recent runId is counter-evidence, not an unrelated row to filter away.
 const recent=rows(a.data.modelCalls).filter(r=>byId.has(r.id)||r.runId===run.id);
 if(new Set(recent.map(r=>r.id)).size!==recent.length||details.some(r=>r.runId&&r.runId!==run.id)||recent.some(r=>r.runId&&r.runId!==run.id||!byId.has(r.id)||['at','status','requestId','usageReported'].some(k=>r[k]!==byId.get(r.id)[k])||['taskId','runId','spendScope','spendTicketId','stage','role'].some(k=>r[k]!=null&&byId.get(r.id)[k]!=null&&r[k]!==byId.get(r.id)[k])))return null;
 const calls=details.filter(r=>(r.at||r.startedAt)>=since);
 if(requireCalls&&!calls.length)return null;
 for(const c of calls){const original=recent.find(r=>r.id===c.id);if((c.taskId||original?.taskId)!==taskId||c.stage&&!['task_verify','json_repair'].includes(c.stage)||c.role&&c.role!=='verify'||!c.requestId||!c.usageReported||!(c.status==='done'||allowInput&&c.status==='error'&&c.errorCode==='MODEL_CONFIG'&&c.diagnostic?.kind==='input_too_large'))return null;}
 if(calls.some(c=>c.spendTicketId&&a.spendLedger?.scopes?.[c.spendScope]?.pending?.[c.spendTicketId]))return null;
 if(wholeRun){
  if(!Number.isInteger(run.modelCalls)||run.modelCalls<0||run.modelCalls!==details.length)return null;
  const start=Date.parse(run.startedAt),end=Date.parse(run.finishedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return null;
  const usageKeys=['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','cacheWrite1hTokens','totalTokens','estimatedUSD','usage','cost','pricing','providerId','model','attempt','fallbackFrom','routing','errorCode','diagnostic'];
  for(const c of details){
   const at=Date.parse(c.at||c.startedAt),r=recent.find(r=>r.id===c.id);
   if(!Number.isFinite(at)||at<start||at>end||c.status!=='done'||c.usageReported!==true||!c.requestId||!Number.isFinite(c.inputTokens)||c.inputTokens<0||!Number.isFinite(c.outputTokens)||c.outputTokens<0||!Number.isFinite(c.estimatedUSD)||c.estimatedUSD<0)return null;
   const usage=require('./spend.cjs').usage(c);if(!usage||c.totalTokens!=null&&c.totalTokens!==usage.totalTokens)return null;
   if(r&&(!require('./spend.cjs').usage(r)||usageKeys.some(k=>Object.hasOwn(r,k)&&Object.hasOwn(c,k)&&hash(r[k])!==hash(c[k]))))return null;
   const scope=c.spendScope&&a.spendLedger?.scopes?.[c.spendScope];
   if(c.spendScope&&!scope||c.spendTicketId&&(!scope||!scope.pending||scope.pending[c.spendTicketId]))return null;
  }
  return details.map(c=>({id:c.id,requestId:c.requestId,status:c.status,at:c.at||c.startedAt,taskId:c.taskId||null,role:c.role||null,stage:c.stage||null,spendTicketId:c.spendTicketId||null,spendScope:c.spendScope||null,usageHash:hash(Object.fromEntries(usageKeys.filter(k=>Object.hasOwn(c,k)).map(k=>[k,c[k]])))}));
 }
 return calls.map(c=>({id:c.id,requestId:c.requestId,status:c.status,spendTicketId:c.spendTicketId||null,spendScope:c.spendScope||null}));
}
// A typed repair records the proven classification defect. It never stands in
// for a pause receipt, user permission or permission to repeat a request.
function scopeBasis(a,j,t){
 try{
 const protocol=require('./task-context.cjs'),context=protocol.buildContext(a,protocol.taskScope(t),'verify');
 const catalog=[...context.readableCatalog,...context.historyCatalog];
 const required=rows(t.sourceIds).filter(id=>!rows(t.supersededSourceIds).includes(id));
 if(!catalog.some(r=>r.type==='artifact'&&r.id===t.primaryArtifactId)||required.some(id=>!catalog.some(r=>r.type==='source'&&r.id===id)))return null;
 return hash(catalog.map(r=>({id:r.id,type:r.type,version:r.version,policyRevision:r.policyRevision,state:r.state,purpose:r.purpose})).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y))));
 }catch{return null;}
}
function finalization(a,t){
 try{return require('./generation-context.cjs').finalizationState(a,t,{phase:'content'});}catch{return null;}
}
function contextFailureCandidate(a,j,t){
 const state=j.executionState?.continuation;
 if(!state||!['needs_input','paused'].includes(j.status)||t.needsReplan||t.evidenceRequest)return null;
 const runs=rows(a.data.agentRuns).filter(r=>r.jobId===j.id).sort((x,y)=>String(y.startedAt).localeCompare(String(x.startedAt))),run=runs[0];
 if(!run?.finishedAt||run.status!=='needs_input')return null;
 const checks=rows(run.steps).filter(s=>s.tool==='verify_content'&&s.args?.taskId===t.id);
 if(checks.length!==1||checks[0]!==rows(run.steps).at(-1))return null;
 const check=checks[0],e=state.episodes?.[check.continuation?.basis],p=e?.pendingCheck;
 if(check.errorCode!=='CONTEXT_INVALID_REQUEST'||!check.continuation?.tracked||!check.continuation?.handled||check.result?.needsAuthorization!==true||check.result.kind!=='external'||check.result.target!=='verify_content')return null;
 if(!e||!valid(a,j,t,e,p)||!ownerAllows(j,t.id,e.basis)||p.status!=='claimed'||p.claimedByRunId!==run.id||!p.claimId||p.claimId!==hash({generationAttemptId:p.generationAttemptId,phase:'content'})||p.checkPhase!=='content'||p.claimedAt<check.at||p.claimedAt>run.finishedAt||e.checkRepairs?.[p.generationAttemptId]||t.contentVerification?.basis===p.checkBasis)return null;
 const ds=rows(a.data.decisions).filter(d=>d.jobId===j.id&&d.status==='open'&&d.kind==='permission'&&d.key==='access:external:verify_content'&&rows(d.taskIds).includes(t.id));
 if(ds.length!==1)return null;const decision=ds[0];
 if(decision.id!==check.result.decisionId||decision.access?.kind!=='external'||decision.access?.target!=='verify_content'||decision.access?.stage!=='requested'||decision.createdAt<check.at||decision.createdAt>run.finishedAt)return null;
 if(j.status==='needs_input'&&j.summary!==decision.question&&j.summary!==check.error)return null;
 const calls=requestHistory(a,run,{since:check.at,taskId:t.id,requireCalls:true,wholeRun:true});if(!calls)return null;
 const f=finalization(a,t),policies=scopeBasis(a,j,t);if(!f?.available||!policies)return null;
 const proof={kind:CONTEXT_REPAIR,runId:run.id,finishedAt:run.finishedAt,checkAt:check.at,stepHash:hash(check),requestProof:calls,
  generationAttemptId:p.generationAttemptId,claimId:p.claimId,claimedByRunId:p.claimedByRunId,claimedAt:p.claimedAt,pendingHash:hash(p),
  semanticCheckId:f.semanticCheckId,legacyKey:f.legacyKey,checkBasis:p.checkBasis,policyBasis:policies,
  expectedOwner:{taskId:state.activeTaskId||null,basis:state.activeBasis||null},artifactId:p.artifactId,artifactHash:p.artifactHash,inputBasis:p.inputBasis,episodeBasis:e.basis,
  jobWorkRevision:j.workRevision??1,taskWorkRevision:t.workRevision??1,cycles:e.cycles,hops:e.hops,executions:e.executions,
  failureMessage:check.error,lifecycle:{status:j.status,summary:j.summary,lastError:j.lastError??''},decisionId:decision.id,decisionHash:hash(decision)};
 const proofId=hash(proof);
 return {kind:CONTEXT_REPAIR,task:t,episode:e,pending:structuredClone(p),proof,decision,proofId};
}
function repairCurrent(a,j,t,e,p,repair){
 if(!repair||repair.kind!==CONTEXT_REPAIR||!['ready','claimed'].includes(repair.status)||!valid(a,j,t,e,p)||!ownerAllows(j,t.id,e.basis))return false;
 const proof=repair.proof,state=j.executionState.continuation;
 if((state.activeTaskId||null)!==proof.expectedOwner.taskId||(state.activeBasis||null)!==proof.expectedOwner.basis)return false;
 const d=rows(a.data.decisions).find(d=>d.id===proof.decisionId),run=rows(a.data.agentRuns).find(r=>r.id===proof.runId);
 if(!d||d.status!=='superseded'||d.recoveryCommandId!==repair.commandId||hash(d)!==repair.supersededDecisionHash||!run?.finishedAt||run.finishedAt!==proof.finishedAt)return false;
 const checks=rows(run.steps).filter(s=>s.tool==='verify_content'&&s.args?.taskId===t.id);
 if(checks.length!==1||hash(checks[0])!==proof.stepHash||p.generationAttemptId!==proof.generationAttemptId||p.claimId!==proof.claimId||p.checkBasis!==proof.checkBasis||(j.workRevision??1)!==proof.jobWorkRevision||(t.workRevision??1)!==proof.taskWorkRevision)return false;
 const calls=requestHistory(a,run,{since:proof.checkAt,taskId:t.id,requireCalls:true,wholeRun:true});
 if(!calls||hash(calls)!==hash(proof.requestProof)||scopeBasis(a,j,t)!==proof.policyBasis)return false;
 const f=finalization(a,t);return !!f&&f.semanticCheckId===proof.semanticCheckId&&f.available;
}
function repairBlock(a,j,t,e,p){
 const repair=e.checkRepairs?.[p.generationAttemptId];if(!repair)return null;
 if(repair.status==='claimed'&&repair.claimedByRunId!==a.activeAgentRun?.id)return 'CHECK_REQUEST_UNRESOLVED';
 if(!repairCurrent(a,j,t,e,p,repair))return 'CHECK_REPAIR_STALE';
 return null;
}
function repairBarrier(a,j,t){
 for(const e of Object.values(j.executionState?.continuation?.episodes||{})){
  const p=e.pendingCheck;if(finished(p)||p.status==='deferred_evidence'||!valid(a,j,t,e,p))continue;
  const reason=repairBlock(a,j,t,e,p);if(reason)return reason;
 }
 return null;
}
function legacy(a,j,t){
 const state=j.executionState?.continuation;
 if(!state||t.needsReplan||t.evidenceRequest)return null;
 const runs=rows(a.data.agentRuns).filter(r=>r.jobId===j.id).sort((x,y)=>String(y.startedAt).localeCompare(String(x.startedAt)));
 const run=runs[0];if(!run?.finishedAt)return null;
 const checks=rows(run.steps).filter(s=>s.tool==='verify_content'&&s.args?.taskId===t.id&&s.errorCode==='WORK_STRATEGY_CHANGE'&&!s.result&&s.continuation?.tracked&&s.continuation?.handled);
 if(checks.length!==1)return null;const check=checks[0],e=state.episodes?.[check.continuation.basis];
 const c=current(a,j,t);if(!c||t.contentVerification?.basis===c.checkBasis||!ownerAllows(j,t.id,e?.basis))return null;
 if(!e||e.taskId!==t.id||e.blocked||e.complete||!e.revisionPending||e.cycles>=(e.cycleLimit||3)||e.intentBasis!==intent(j,t)||e.suspendedBy?.code!=='WORK_STRATEGY_CHANGE')return null;
 const candidates=rows(run.steps).filter(s=>s.tool==='advance_task'&&s.args?.taskId===t.id&&!s.error&&s.result?.taskId===t.id&&!s.result?.evidenceRequest&&s.result?.status==='todo'&&s.continuation?.tracked&&s.continuation?.basis===e.basis&&s.at<c.artifact.createdAt&&c.artifact.createdAt<check.at);
 if(candidates.length!==1)return null;const generated=candidates[0];
 const outputs=rows(a.data.artifacts).filter(r=>r.taskId===t.id&&r.stepId===c.step.id&&r.createdAt>generated.at&&r.createdAt<check.at);
 if(outputs.length!==1||outputs[0].id!==c.artifact.id)return null;
 const snapshot=c.artifact.generationSnapshot;
 if(!snapshot||snapshot.intent!==c.step.inputBasis.intent||snapshot.sourcesHash!==hash(require('./evidence-basis.cjs').taskSources(a,t)))return null;
 const guardEvents=rows(a.data.events).filter(ev=>['自动托管已暂停','自动托管已恢复','定时暂停已结束','托管策略已更新'].includes(ev.title)&&ev.at>check.at&&ev.at<=e.suspendedBy.at).sort((x,y)=>x.at.localeCompare(y.at));
 const pause=guardEvents.at(-1);if(guardEvents.some(ev=>ev.title==='托管策略已更新'))return null;if(pause?.title!=='自动托管已暂停'||pause.at>run.finishedAt||guardEvents.some((ev,i)=>i&&ev.at===guardEvents[i-1].at))return null;
 const calls=requestHistory(a,run,{since:check.at,taskId:t.id,requireCalls:true});if(!calls)return null;
 const generationAttemptId=hash({runId:run.id,index:run.steps.indexOf(generated),at:generated.at,taskId:t.id,stepId:c.step.id});
 const p={ownerEpisodeId:e.basis,generationAttemptId,agentRunId:run.id,taskId:t.id,stepId:c.step.id,intentBasis:intent(j,t),taskWorkRevision:t.workRevision??1,artifactId:c.artifact.id,artifactHash:hash(c.artifact.content),inputBasis:c.step.inputBasis.hash,checkPhase:'content',checkBasis:c.checkBasis,status:'interrupted',claimId:hash({generationAttemptId,phase:'content'}),claimedByRunId:run.id,interruption:{code:'EXECUTION_GATE_CLOSED',at:e.suspendedBy.at,legacyCode:'WORK_STRATEGY_CHANGE',requestProof:calls},createdAt:c.artifact.createdAt};
 const proof={runId:run.id,generationAt:generated.at,checkAt:check.at,pauseEventId:pause.id,pauseAt:pause.at,finishedAt:run.finishedAt,callIds:calls.map(x=>x.id),requestProof:calls,guardEvents:guardEvents.map(x=>({id:x.id,title:x.title,at:x.at})),expectedOwner:{taskId:state.activeTaskId||null,basis:state.activeBasis||null},stepHash:hash({generated,check}),artifactId:c.artifact.id,artifactHash:p.artifactHash,inputBasis:p.inputBasis,episodeBasis:e.basis,cycles:e.cycles,hops:e.hops,failureMessage:check.error};
 return {task:t,episode:e,pending:p,proof,commandId:hash({type:TYPE,generationAttemptId,checkAt:check.at,pause:pause.id})};
}
function guards(a,j,t,receipt){
 const work=require('./execution-facts.cjs');
 if(a.readOnlyRecovery||j.deletedAt||t.deletedAt||t.agentCancelled||t.acceptedAt||['completed','paused','waiting','review'].includes(t.status))return 'TASK_GUARDED';
 if(!work.gate(a,j,t).automaticAllowed)return 'EXECUTION_GATE_CLOSED';
 if(work.blockingReasons(a,j,t).length)return 'WORK_BLOCKED';
 if(!require('./work-rules.cjs').canRun(a,j))return 'WORK_RULE_GUARDED';
 if(rows(t.sourceIds).some(id=>!rows(t.supersededSourceIds).includes(id)&&!require('./protocol-access.cjs').allowedObject(a,'source',rows(a.data.sources).find(s=>s.id===id),j,t)))return 'CONTEXT_SCOPE_DENIED';
 const c=current(a,j,t,receipt);if(!c||!require('./protocol-access.cjs').allowedObject(a,'artifact',c.artifact,j,t))return 'CONTEXT_SCOPE_DENIED';
 return null;
}
function inspect(a,job,{taskId}={}){
 let deferred=null;
 for(const id of taskId?[taskId]:rows(job.taskIds)){
  const task=taskFor(a,job,id);if(!task)continue;
  for(const e of Object.values(job.executionState?.continuation?.episodes||{})){
   const p=e.pendingCheck;
   if(finished(p)||p.status==='deferred_evidence'||!valid(a,job,task,e,p))continue;
   const repairReason=repairBlock(a,job,task,e,p);if(repairReason)return {eligible:false,repairBlocked:true,reason:repairReason,taskId:task.id,ownerEpisodeId:e.basis,pendingCheck:structuredClone(p)};
   const reason=guards(a,job,task,p);
   return {eligible:!reason,reason,taskId:task.id,ownerEpisodeId:e.basis,pendingCheck:structuredClone(p),action:{tool:'verify_content',args:{taskId:task.id}},restored:true};
  }
  for(const e of Object.values(job.executionState?.continuation?.episodes||{})){
   const d=deferredCandidate(a,job,task,e);if(!d)continue;
   if(!d.eligible){deferred ||= {eligible:false,deferred:true,reason:d.reason,needsReconcile:!!d.needsReconcile,taskId:task.id,ownerEpisodeId:e.basis};continue;}
   return {eligible:true,taskId:task.id,ownerEpisodeId:e.basis,proof:d.proof,commandId:d.commandId,pendingCheck:d.pending,prepareRequired:true,action:{tool:'verify_content',args:{taskId:task.id}}};
  }
  const c=legacy(a,job,task);if(c){const reason=guards(a,job,task);return {eligible:!reason,reason,taskId:task.id,ownerEpisodeId:c.episode.basis,proof:c.proof,commandId:c.commandId,pendingCheck:c.pending,prepareRequired:true,action:{tool:'verify_content',args:{taskId:task.id}}};}
 }
 return deferred||{eligible:false,reason:'NO_PROVEN_PENDING_CHECK'};
}
function project(a,job,event){
 const p=event.payload,task=taskFor(a,job,p.taskId),e=job.executionState?.continuation?.episodes?.[p.ownerEpisodeId];
 if(p.proof?.kind===DEFERRED_ACTIVATION){
  if(!task||!e||e.checkRestorations?.[event.commitId])return;
  const d=deferredCandidate(a,job,task,e,{checkGuards:false});
  if(!d?.eligible||hash(d.proof)!==hash(p.proof)||hash(d.pending)!==hash(p.pendingCheck))return;
  e.checkRestorations ||= {};e.checkRestorations[event.commitId]={proof:structuredClone(p.proof),at:event.at};
  e.pendingCheck={...structuredClone(d.pending),activatedAt:event.at,activationCommitId:event.commitId};
  job.executionState.continuation.activeTaskId=task.id;job.executionState.continuation.activeBasis=e.basis;return;
 }
 if(p.repairKind===CONTEXT_REPAIR){projectContextRepair(a,job,event);return;}
 if(p.decision){
  const d=rows(a.data.decisions).find(d=>d.id===p.decision.id&&d.jobId===job.id);
  if(!d||d.status!=='open'&&d.recoveryCommandId!==event.commitId||d.status==='open'&&hash(d)!==p.decision.hash)return;
 }

 if(!task||!e||!ownerAllows(job,task.id,e.basis))return;
 const old=e.checkRestorations?.[event.commitId];if(old)return;
 if(!valid(a,job,task,e,p.pendingCheck))return;
 // A committed restore may replay while paused; it restores identity only. The
 // shared policy still denies dispatch. Later user edits/terminal facts win.
 if(task.deletedAt||task.agentCancelled||task.acceptedAt||job.deletedAt||['completed','cancelled'].includes(job.status))return;
 e.checkRestorations ||= {};e.checkRestorations[event.commitId]={proof:structuredClone(p.proof),at:event.at};
 e.pendingCheck=structuredClone(p.pendingCheck);
 job.executionState.continuation.activeTaskId=task.id;job.executionState.continuation.activeBasis=e.basis;
 if(p.decision){
  const d=a.data.decisions.find(d=>d.id===p.decision.id);
  Object.assign(d,{status:'answered',origin:'execution_recovery',answer:'继续原稿核验；原范围、缺口、费用与次数保持',answeredAt:event.at,recoveryCommandId:event.commitId,recoveryProofId:p.proofId});
  delete d.answerBasis;delete d.selectedOption;
  // Only the proven technical lifecycle block is reconciled. Explicit pauses,
  // other decisions, unknown effects and all business limits remain untouched.
  if(['needs_input','blocked'].includes(job.status)&&job.lastError===p.proof.failureMessage){job.status='ready';job.nextRunAt=null;job.summary='已记录原稿检查接续；执行条件允许后继续核验';}
 }
}

function projectContextRepair(a,job,event){
 const payload=event.payload,task=taskFor(a,job,payload.taskId),e=job.executionState?.continuation?.episodes?.[payload.ownerEpisodeId];
 if(!task||!e||job.deletedAt||task.deletedAt||task.agentCancelled||task.acceptedAt||['completed','cancelled'].includes(job.status))return;
 const previous=e.checkRepairs?.[payload.pendingCheck?.generationAttemptId];if(previous)return;
 const c=contextFailureCandidate(a,job,task);
 if(!c||c.proofId!==payload.proofId||hash(c.pending)!==hash(payload.pendingCheck)||hash(c.decision)!==payload.decision.hash)return;
 const d=c.decision;
 Object.assign(d,{status:'superseded',origin:'execution_recovery',supersededAt:event.at,recoveryCommandId:event.commitId,recoveryProofId:c.proofId,recoveryReason:'内部资料读取错误被旧版本误分类为外部授权；仅恢复原稿检查结论'});
 // This is a technical reclassification, not an authorization answer.
 delete d.answer;delete d.answerBasis;delete d.selectedOption;delete d.answeredAt;
 e.checkRepairs ||= {};
 e.checkRepairs[c.pending.generationAttemptId]={kind:CONTEXT_REPAIR,status:'ready',commandId:event.commitId,at:event.at,proof:structuredClone(c.proof),supersededDecisionHash:hash(d)};
 // Do not touch original pending/interruption, owners, budgets or counters.
 // Only the one proven lifecycle obstruction is removed. Independent questions
 // and every explicit pause continue to own their status.
 if(job.status==='needs_input'&&!rows(a.data.decisions).some(x=>x.jobId===job.id&&x.status==='open')){
  job.status='ready';job.nextRunAt=null;job.summary='内部读取错误已纠正；将对原稿形成一次有依据的检查结论';
 }
}

function prepare(a,job){
 const r=inspect(a,job);if(!r.eligible||!r.prepareRequired)return false;
 if(require('./execution.cjs').conflict(a,{jobId:job.id}))return false;
 const payload={taskId:r.taskId,ownerEpisodeId:r.ownerEpisodeId,pendingCheck:r.pendingCheck,proof:r.proof};
 const event={type:TYPE,entityKind:'job',entityId:job.id,workRevision:job.workRevision??1,actor:'upgrade',basisRefs:{generationAttemptId:r.pendingCheck.generationAttemptId},payload};
 require('./state-transitions.cjs').commit(a,receipt=>require('./work-journal.cjs').project(a,receipt),{expectedRevision:a.data.runtime?.revision||0,commitId:r.commandId,workEvents:[event]});return true;
}
function locate(a,job,task){
 const s=job?.executionState?.continuation;
 return Object.values(s?.episodes||{}).find(e=>!finished(e.pendingCheck)&&e.pendingCheck.status!=='deferred_evidence'&&valid(a,job,task,e,e.pendingCheck));
}
function claim(a,job,task,{phase='content'}={}){
 if(!job||phase!=='content')return null;
 const e=locate(a,job,task);
 if(!e){
  const deferred=Object.values(job.executionState?.continuation?.episodes||{}).find(v=>v.pendingCheck?.taskId===task.id&&v.pendingCheck?.artifactId===require('./deliverables.cjs').primary(a,task)?.id&&v.pendingCheck.status==='deferred_evidence');
  if(deferred){const d=deferredCandidate(a,job,task,deferred);throw Object.assign(Error(d?.needsReconcile?'原稿输入已变化，请先协调当前稿再检查':'增量草稿检查尚未激活，请先补齐证据并由执行策略准备原稿检查'),{code:d?.reason==='CHECK_EVIDENCE_PENDING'?'EVIDENCE_REQUIRED':'PLAN_RECONCILE_REQUIRED',taskId:task.id});}
  return null;
 }
 const p=e.pendingCheck,runId=a.activeAgentRun?.id;
 if(!runId)return null;
 require('./execution-gate.cjs').assert(a,{job,task});
 if(guards(a,job,task,p))throw Object.assign(Error('原稿检查的权限或执行条件发生变化'),{code:'EXECUTION_GATE_CLOSED',gateClosed:true});
 if(p.status==='unknown')throw Object.assign(Error('原核验结果未知，须先核对原请求与用量'),{code:'CHECK_REQUEST_UNRESOLVED',requiresInput:true});
 if(['claimed','interrupted'].includes(p.status)&&p.claimedByRunId&&p.claimedByRunId!==runId){
  const oldRun=rows(a.data.agentRuns).find(r=>r.id===p.claimedByRunId);
  const upgraded=Object.values(job.executionState?.inputRecovery?.attempts||{}).find(x=>x.status==='ready'&&x.previousRunId===p.claimedByRunId&&x.preflight?.taskId===task.id&&x.preflight?.artifactId===p.artifactId&&x.preflight?.contentBasis===p.checkBasis);
  const repair=e.checkRepairs?.[p.generationAttemptId],typed=repair?.status==='ready'&&repair.proof.claimedByRunId===p.claimedByRunId&&repairCurrent(a,job,task,e,p,repair);
  if(repair&&!typed)throw Object.assign(Error('原检查修正许可已认领或依据变化，不重复发起结论请求'),{code:'CHECK_REQUEST_UNRESOLVED',requiresInput:true});
  const failure=rows(oldRun?.steps).at(-1),diagnostic=upgraded?.previousDiagnostic;
  const localInput=!!upgraded&&diagnostic?.source==='codex_cli'&&diagnostic.kind==='input_too_large'&&diagnostic.actualChars>diagnostic.maxChars&&failure?.tool==='verify_content'&&failure.args?.taskId===task.id&&failure.errorCode==='MODEL_CONFIG'&&!failure.result&&failure.errorDiagnostic&&hash(failure.errorDiagnostic)===hash(diagnostic)&&oldRun.error===upgraded.previousError&&!Object.keys(a.spendLedger?.scopes?.['job:'+job.id]?.pending||{}).length;
  const interrupted=p.status==='interrupted'&&p.interruption?.code==='EXECUTION_GATE_CLOSED';
  const calls=requestHistory(a,oldRun,{since:p.claimedAt||p.createdAt,taskId:task.id,allowInput:!!upgraded,requireCalls:!interrupted&&!localInput});
  if(!oldRun?.finishedAt||(!interrupted&&!upgraded&&!typed)||!calls||interrupted&&(!p.interruption.requestProof||hash(calls)!==hash(p.interruption.requestProof)))throw Object.assign(Error('原核验请求中断，须先核对原请求与用量，不重新分配检查机会'),{code:'CHECK_REQUEST_UNRESOLVED',requiresInput:true});

 }
 if(p.status!=='claimed'||p.claimedByRunId!==runId){require('./state-transitions.cjs').commit(a,()=>{p.claimId ||= hash({generationAttemptId:p.generationAttemptId,phase});if(p.claimedByRunId)(p.claimHistory ||= []).push({runId:p.claimedByRunId,claimedAt:p.claimedAt,interruption:structuredClone(p.interruption||null)});p.status='claimed';p.claimedByRunId=runId;p.claimedAt=now();const repair=e.checkRepairs?.[p.generationAttemptId];if(repair?.status==='ready'){repair.status='claimed';repair.claimedByRunId=runId;repair.claimedAt=p.claimedAt;}});}
 const repair=e.checkRepairs?.[p.generationAttemptId];
 if(repair&&(!repairCurrent(a,job,task,e,p,repair)||repair.status!=='claimed'||repair.claimedByRunId!==runId))throw Object.assign(Error('内部读取修正的依据已变化或结论机会已消费'),{code:'CHECK_REPAIR_STALE',requiresInput:true});
 return {taskId:task.id,ownerEpisodeId:e.basis,claimId:p.claimId,checkPhase:phase,...(repair?{forceFinalization:{semanticCheckId:repair.proof.semanticCheckId,repairCommandId:repair.commandId,reason:repair.proof.failureMessage}}:{})};
}
function permits(a,job,{task,phase,claim:receipt}={}){
 if(!task||phase!=='content'||!receipt)return false;
 const e=locate(a,job,task),p=e?.pendingCheck;
 return !!p&&p.status==='claimed'&&p.claimedByRunId===a.activeAgentRun?.id&&p.claimId===receipt.claimId&&p.ownerEpisodeId===receipt.ownerEpisodeId&&!guards(a,job,task,p);
}
function interrupt(a,job,task,error){
 if(!error.gateClosed)return;
 const e=locate(a,job,task),p=e?.pendingCheck;
 if(p?.status==='claimed'&&p.claimedByRunId===a.activeAgentRun?.id){p.status='interrupted';p.interruption={code:error.code,at:now(),requestProof:requestHistory(a,a.activeAgentRun,{since:p.claimedAt||p.createdAt,taskId:task.id})};}
}
function noteCheck(a,job,task,check,{phase='content'}={}){
 if(phase!=='content')return;
 const e=locate(a,job,task),p=e?.pendingCheck;
 if(!p||check.basis!==p.checkBasis)return;
 p.status='settled';p.settledCheckId=hash({taskId:task.id,phase,basis:check.basis});p.settledAt=check.at||now();
}

function recoveryCandidate(a,job){
 for(const id of rows(job.taskIds)){
  const task=taskFor(a,job,id);if(!task||task.deletedAt||task.agentCancelled||task.acceptedAt)continue;
  const fixed=contextFailureCandidate(a,job,task);if(fixed)return fixed;
  const c=legacy(a,job,task);if(!c)continue;
  const ds=rows(a.data.decisions).filter(d=>d.jobId===job.id&&d.status==='open'&&d.kind==='question'&&d.key?.startsWith('progress:')&&d.context===String(c.proof.failureMessage).slice(0,1500)&&rows(d.taskIds).includes(task.id)&&d.createdAt>=c.episode.suspendedBy.at&&d.createdAt<=c.proof.finishedAt);
  if(ds.length!==1)continue;
  const decision=ds[0],proofId=hash({proof:c.proof,decisionId:decision.id,decisionHash:hash(decision)});
  return {...c,decision,proofId};
 }
 return null;
}
function view(a,job){
 const c=recoveryCandidate(a,job);if(!c)return null;
 return {kind:c.kind||'legacy_pause',proofId:c.proofId,decisionId:c.decision.id,taskId:c.task.id,artifactId:c.pending.artifactId,expectedRevision:a.data.runtime?.revision||0,expectedWorkRevision:job.workRevision??1,expectedTaskRevision:c.task.workRevision??1,paused:!!a.data.stewardship?.paused||job.status==='paused'||job.executionPaused||c.task.status==='paused'};
}
function resume(a,job,input={}){
 if(!require('./workspace-view.cjs').summaryRequested()||a.activeAgentRun||require('./execution.cjs').conflict(a,{jobId:job.id}))throw Object.assign(Error('检查接续只能由应用界面在当前轮次结束后提交'),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 if(typeof input.proofId!=='string'||typeof input.decisionId!=='string'||!Number.isSafeInteger(input.expectedRevision)||!Number.isSafeInteger(input.expectedWorkRevision)||!Number.isSafeInteger(input.expectedTaskRevision))throw Error('需要当前核验接续依据');
 const journal=require('./work-journal.cjs'),commandId=hash({type:TYPE,jobId:job.id,proofId:input.proofId,decisionId:input.decisionId});
 const log=journal.read(a),old=log.events.find(e=>e.type===TYPE&&e.commitId===commandId);
 if(old){if(a.data.runtime?.workJournal?.projectionPending||(a.data.runtime?.workJournal?.appliedSequence||0)<log.events.length)journal.replay(a);return a.publicState();}
 require('./project-lifecycle.cjs').assertJobActive(a.data,job);
 if(job.deletedAt||['completed','cancelled'].includes(job.status)||a.readOnlyRecovery||a.data.runtime?.workJournalError||a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||a.data.runtime?.accessPolicyProjectionPending)throw Error('当前状态尚不可提交检查接续');
 const c=recoveryCandidate(a,job);
 if(!c||input.proofId!==c.proofId||input.decisionId!==c.decision.id||input.expectedWorkRevision!==(job.workRevision??1)||input.expectedTaskRevision!==(c.task.workRevision??1))throw Object.assign(Error('原稿、问题或接续依据已变化，请刷新'),{code:'STATE_STALE'});
 const payload={...(c.kind?{repairKind:c.kind}:{}),taskId:c.task.id,ownerEpisodeId:c.episode.basis,pendingCheck:c.pending,proof:c.proof,proofId:c.proofId,decision:{id:c.decision.id,hash:hash(c.decision)}};
 const event={type:TYPE,entityKind:'job',entityId:job.id,workRevision:job.workRevision??1,actor:'user',basisRefs:{proofId:c.proofId,decisionId:c.decision.id},payload};
 require('./state-transitions.cjs').commit(a,receipt=>journal.project(a,receipt),{expectedRevision:input.expectedRevision,commitId:commandId,workEvents:[event]});
 return a.publicState();
}

require('./work-journal.cjs').registerProjector(TYPE,project);
module.exports={TYPE,inspect,prepare,recordGenerated,claim,permits,interrupt,noteCheck,view,resume,repairBarrier};
