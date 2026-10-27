// A bounded dispatcher for direct preconditions. Facts remain on tasks, sources,
// checks and action receipts; this module owns only routing and attempt accounting.
const {hash}=require('./evidence-basis.cjs');
const now=()=>new Date().toISOString();
const VERSION=1,MAX_HOPS=4,MAX_CYCLES=3;
const validation=()=>require('./repair-validation.cjs');
const acquisition=()=>require('./evidence-recovery.cjs');
const rows=x=>Array.isArray(x)?x:[];
const tasks=(a,j)=>rows(a.data.tasks).filter(t=>rows(j.taskIds).includes(t.id)&&t.agentJobId===j.id&&!t.deletedAt&&!t.agentCancelled);
const ROUTABLE=new Set(['PLAN_ALREADY_RECONCILED','CONTENT_REPAIR_REQUIRED','EXTERNAL_TOOL_REQUIRED']);
function intentBasis(job,task){return hash({contract:job.executionContract?.text||job.goal,requirements:task.userRequirement?Object.fromEntries(['description','objective','criteria'].map(k=>[k,task.userRequirement[k]])):null});}
function factKeys(a,job,task){const relations=require('./relation-obligations.cjs');return [...new Set(rows(relations.recoveryFacts?.(a,job,task)).map(hash))].sort();}
function basis(a,job,task,fresh){return hash({taskId:task.id,intent:intentBasis(job,task),facts:fresh||factKeys(a,job,task)});}
function state(job){return job.executionState?.continuation;}
function episode(a,job,task){if(!task)return null;const s=state(job);return s?.activeTaskId===task.id&&s.episodes?.[s.activeBasis]||s?.episodes?.[basis(a,job,task)]||Object.values(s?.episodes||{}).filter(e=>e.taskId===task.id&&!e.complete).at(-1);}
function allowed(a,job,task,{actionId,followupKey,allowReview=false,automatic=a.automaticExecution!==false}={}){
 const work=require('./execution-facts.cjs');
 if(!work.gate(a,job,task,{automatic}).automaticAllowed||work.dispatchBlockers(a,job,task,{automatic}).some(r=>r.id!==actionId&&!(followupKey&&r.code==='followup'&&r.id===followupKey))||job.deletedAt||task.deletedAt||task.agentCancelled||['completed','paused','waiting',...(!allowReview?['review']:[])].includes(task.status))return false;
 if(require('./projects.cjs').relatedActions(a,job).some(r=>(!actionId||r.id!==actionId)&&['pending','running','uncertain'].includes(r.status)&&require('./execution-facts.cjs').blocksTask(r,task)))return false;
 if(require('./spend-guard.cjs').inspect(a,job,task))return false;
 const access=require('./protocol-access.cjs');
 return rows(task.sourceIds).filter(id=>!rows(task.supersededSourceIds).includes(id)).every(id=>{const source=rows(a.data.sources).find(s=>s.id===id);return source&&access.allowedObject(a,'source',source,job,task);});
}
// Existing side effects have a separate entry from dispatching new work. A
// reconciliation never grants a second write; pending approvals retain all gates.
function actionInspect(a,job,{automatic=false,currentExecutionId,now=Date.now()}={}) {
 const work=require('./execution-facts.cjs');
 if(work.inFlight(a,job,{currentExecutionId}))return {kind:'running',eligible:false};
 const related=require('./projects.cjs').relatedActions(a,job);
 const uncertain=related.find(r=>['running','uncertain'].includes(r.status));
 if(uncertain){
  const task=tasks(a,job).find(t=>t.id===uncertain.taskId),gate=work.gate(a,job,task,{readOnly:true,automatic});
  const key=hash({id:uncertain.id,permissionRevision:job.executionState?.permissionRevision||0});
  const permission=gate.automaticAllowed&&work.actionGuard(a,job,uncertain,{readOnly:true,now});
  const eligible=!!task&&['request_confirmation',...require('./agent-writes.cjs').actions].includes(uncertain.tool)&&uncertain.jobId===job.id&&gate.automaticAllowed&&!permission&&!(automatic&&uncertain.automaticReconciliation?.basis===key);
  return {kind:'reconcile',eligible,action:uncertain,basis:key,reason:!gate.automaticAllowed?gate.reason:permission?.code||(eligible?'RECONCILE_EXISTING':'EXTERNAL_EFFECT_UNRESOLVED')};
 }
 const pending=related.find(r=>r.jobId===job.id&&r.status==='pending');if(!pending)return null;
 const task=tasks(a,job).find(t=>t.id===pending.taskId),e=task&&episode(a,job,task);
 const titled=task&&require('./verification-titles.cjs').identity(a,task).actionTitles.some(r=>r.actionId===pending.id);
 const authorized=pending.approvedAt||(['lark_create','lark_update'].includes(pending.tool)||titled)&&require('./agent-writes.cjs').mode(job,pending.tool,pending.taskId)==='auto';
 if(!authorized)return {kind:'approval',eligible:false,action:pending,reason:'AWAIT_APPROVAL'};
 const permission=work.actionGuard(a,job,pending,{now});
 const review=!permission&&task&&require('./verification-titles.cjs').actionReview(a,task,pending);
 if(review)return {kind:'check_content',action:pending,eligible:review==='required'&&!e?.blocked&&allowed(a,job,task,{actionId:pending.id,allowReview:true,automatic}),reason:review==='blocked'?'PREPARED_TITLE_REVIEW_FAILED':'PREPARED_TITLE_REVIEW_REQUIRED'};
 return {kind:'approved',action:pending,eligible:!permission&&!!task&&!e?.blocked&&allowed(a,job,task,{actionId:pending.id,followupKey:pending.tool==='request_confirmation'?pending.followupKey:null,allowReview:true,automatic}),reason:permission?.code||'EXECUTE_APPROVED_EXISTING'};
}
function existingAction(a,job,options={}){const r=actionInspect(a,job,options);return r?.eligible?r:null;}
function inspect(a,job,task,{ignoreExhaustion=false,automatic=a.automaticExecution!==false}={}){
 const e=task&&episode(a,job,task),goalCheck=!!e&&task?.status==='review'&&task.verification?.passed===true;
 if(!task||!allowed(a,job,task,{allowReview:goalCheck,automatic}))return {phase:'guarded',action:null};
 if(!ignoreExhaustion&&e?.blocked)return {phase:'blocked',reason:e.reason,action:null};
 if(goalCheck)return {phase:'goal_check',action:{tool:'complete',args:{},reason:'修复后的事项检查已通过，沿原授权完成整体委托检查'}};
 if(task.needsReplan||require('./recovery-diagnostics.cjs').planning(a,job,task))return {phase:'reconcile',action:null};
 const outputs=require('./deliverables.cjs'),control=require('./execution-control.cjs'),current=outputs.primary(a,task),step=rows(task.steps).find(s=>!s.done);
 if(step&&['draft','analysis'].includes(step.kind))return {phase:'revise',action:{tool:'advance_task',args:{taskId:task.id},reason:'接续当前已协调的文本步骤'}};
 if(!step)return {phase:'verify',action:{tool:'advance_task',args:{taskId:task.id},reason:'核对当前已完成步骤及交付'}};
 if(step.kind==='external'&&current){
  const b=control.contentBasis(a,job,task),check=task.contentVerification;
  if(check?.basis!==b)return {phase:'check_content',action:{tool:'verify_content',args:{taskId:task.id},reason:'交付前核对当前主稿和证据'}};
  if(check.passed===false){
   const target=require('./revision-protocol.cjs').target(a,task,check);
   if(target)return {phase:'repair',action:{tool:'revise_task',args:{taskId:task.id,artifactId:target.id,note:'针对当前检查修订原稿，保留已核实事实和原交付目标：\n'+rows(check.gaps).join('\n')},reason:'内容尚未通过，直接修订明确目标'}};
   return {phase:'reconcile',action:null};
  }
  if(check.passed===true)return {phase:'deliver',action:{tool:step.tool,args:{taskId:task.id},reason:'当前主稿已检查，沿原目标与授权完成交付'}};
 }
 return {phase:'reconcile',action:null};
}
function peek(a,job,task,{automatic=a.automaticExecution!==false,now=Date.now()}={}) {
 const e=task&&episode(a,job,task);if(!e||e.complete)return null;
 const owned={owner:'continuation',ownerEpisodeId:e.basis,taskId:task.id};
 if(!allowed(a,job,task,{allowReview:task.status==='review'&&task.verification?.passed===true,automatic}))return {...owned,eligible:false,phase:'guarded',reason:'TASK_GUARDED'};
 const pending=require('./pending-check.cjs').inspect(a,job,{taskId:task.id});
 if(pending.repairBlocked)return {...owned,eligible:false,phase:'blocked',reason:pending.reason,message:'原稿检查的修正许可未决或已失效；保留原请求与费用，等待核对。'};
 if(pending.eligible)return {...owned,...pending,owner:'continuation',phase:pending.prepareRequired?'prepare_pending':'check_content',command:pending.prepareRequired?'pending_check':null};
 if(e.suspendedBy&&state(job)?.activeTaskId!==task.id){
  // A trusted UI grant can expose its exact remaining evidence dispatch only.
  // Normal owner_select performs takeover; suspension history/counters remain.
  if(require('./storage-method-resume.cjs').candidates(a,job,task,e).length)return {...owned,...acquisition().inspect(a,job,task,e,{now})};
  return {...owned,eligible:false,phase:'blocked',reason:'CONTINUATION_SUSPENDED'};
 }
 const consumption=require('./evidence-consumption.cjs').inspect(a,job,task);
 if(consumption){
  // A failed draft owns its generation step, not the remaining evidence work.
  // Continue a genuinely executable typed gap without reissuing that draft.
  if(consumption.reason==='EVIDENCE_CONSUMPTION_FAILED'&&!e.blocked&&acquisition().hasWork(a,job,task,e))return {...owned,...acquisition().inspect(a,job,task,e,{now})};
  return {...owned,...consumption};
 }
 if((e.validationGrantId||e.fromValidationGrantId)&&acquisition().hasWork(a,job,task,e))return {...owned,...acquisition().inspect(a,job,task,e,{now})};
 if(e.blocked)return {...owned,eligible:false,phase:'blocked',reason:'CONTINUATION_EXHAUSTED',message:e.reason};
 const r=inspect(a,job,task,{automatic});
 if(r.phase==='reconcile'&&!e.validationGrantId)return {...owned,eligible:true,phase:'reconcile',reason:'CONTINUATION_PLAN_REQUIRED',action:{tool:'planner',args:{taskId:task.id}}};
 if(e.validationGrantId&&r.action){const v=validation().allowedAction(a,job,r.action);if(!v.allowed){
  const proof=v.reason==='CLAIMED_RESULT_UNKNOWN'&&validation().unknownClaimProof(a,job,task,e);
  return {...owned,eligible:false,phase:proof?'prepare_pending':'blocked',reason:v.reason,...(proof?{command:'validation_finish',proof}:{})};
 }}
 return {...owned,...r,eligible:!!r.action,reason:r.action?'CONTINUATION_READY':'CONTINUATION_PATH_UNRESOLVED'};
}
function preparation(a,job) {
 const old=job.executionState?.workEfficiency,grant=validation().active(job),s=state(job);
 const repairBlocked=t=>t&&require('./pending-check.cjs').repairBarrier(a,job,t);
 if(grant&&!s?.validationHandoffs?.[grant.grantId]){
  const t=tasks(a,job).find(t=>t.id===grant.taskId),e=s?.episodes?.['validation:'+grant.grantIdentity];
  if(t&&!e&&!repairBlocked(t)&&allowed(a,job,t)&&validation().allowedAction(a,job,{tool:'advance_task',args:{taskId:t.id}}).allowed)return {command:'continuation_validation',taskId:t.id,proof:{grantIdentity:grant.grantIdentity,grantId:grant.grantId,basis:'validation:'+grant.grantIdentity,intentBasis:intentBasis(job,t),factKeys:factKeys(a,job,t),cycles:grant.knownFailures,cycleLimit:grant.knownFailures+1}};
 }
 if(!grant&&old?.phase==='awaiting_change'&&old.lastFailure?.code==='PLAN_ALREADY_RECONCILED')for(const t of tasks(a,job)){
  if(repairBlocked(t)||!allowed(a,job,t)||!inspect(a,job,t,{ignoreExhaustion:true}).action)continue;
  const imported=require('./continuation-migration.cjs').inspect(a,job,t);
  if(imported.eligible&&Number.isInteger(imported.cycles))return {command:'continuation_migrate',taskId:t.id,proof:{...imported,basis:basis(a,job,t),intentBasis:intentBasis(job,t),factKeys:factKeys(a,job,t)}};
 }
 for(const t of tasks(a,job)){
  const e=episode(a,job,t);if(!e||e.validationGrantId||repairBlocked(t)||!allowed(a,job,t))continue;
  // A suspended legacy read route can use the upgraded local read method once
  // in the original episode. No cycle, hop, failure or reading counter resets.
  if(e.suspendedBy?.code==='CONTEXT_INVALID_REQUEST'&&!e.blocked&&!s.activeTaskId&&s.activeBasis===e.basis&&e.intentBasis===intentBasis(job,t)&&Number.isInteger(e.cycles)&&e.cycles<(e.cycleLimit||MAX_CYCLES)&&Number.isInteger(e.hops)&&e.hops<MAX_HOPS){
   const strategy=require('./strategy-recovery.cjs'),method=strategy.candidates(a,job).find(c=>c.id.startsWith('read_check:')&&c.queue?.[0]?.args?.taskId===t.id),input=strategy.inputBasis(a,job);
   if(method&&!e.readingResumes?.[method.id]&&!old?.tried?.[input+':'+method.id])return {command:'continuation_read_resume',taskId:t.id,proof:{basis:e.basis,methodId:method.id,inputBasis:input,title:method.title,contentBasis:require('./execution-control.cjs').contentBasis(a,job,t),suspendedBy:structuredClone(e.suspendedBy),cycles:e.cycles,hops:e.hops}};
  }
  const fresh=factKeys(a,job,t),key=basis(a,job,t,fresh),intent=intentBasis(job,t),used=consumedFactKeys(job,t,intent);
  if(key!==e.basis&&(e.intentBasis&&intent!==e.intentBasis||fresh.some(k=>!used.has(k))))return {command:'continuation_refresh',taskId:t.id,proof:{basis:key,previousBasis:e.basis,intentBasis:intent,factKeys:fresh,cycles:0,fromValidationGrantId:e.fromValidationGrantId||null,evidenceAcquisition:e.evidenceAcquisition||null}};
 }
 return null;
}
function applyPrepared(a,job,p,at) {
 const t=tasks(a,job).find(t=>t.id===p.taskId);if(!t)return;
 if(require('./pending-check.cjs').repairBarrier(a,job,t))return;
 require('./operation-ledger.cjs').state(job);const s=job.executionState.continuation ||= {version:VERSION,episodes:{},migrations:{}};
 const v=p.proof;
 if(p.command==='continuation_read_resume'){
  const e=s.episodes[v.basis];if(!e||e.taskId!==t.id||e.blocked||e.cycles!==v.cycles||e.hops!==v.hops||hash(e.suspendedBy)!==hash(v.suspendedBy))return;
  (e.readingResumes ||= {})[v.methodId] ||= {at,inputBasis:v.inputBasis};s.activeTaskId=t.id;s.activeBasis=e.basis;
  const old=job.executionState.workEfficiency;if(old){(old.tried ||= {})[v.inputBasis+':'+v.methodId] ||= {at,title:v.title,ownerEpisodeId:e.basis};old.phase='working';}
  if(job.status!=='running')job.status='ready';job.nextRunAt=at;job.summary='沿原检查身份使用已升级的读取方法，历史次数和累计费用保留';return;
 }
 s.episodes[v.basis] ||= {taskId:t.id,basis:v.basis,intentBasis:v.intentBasis,factKeys:structuredClone(v.factKeys),hops:0,cycles:v.cycles,executions:0,redirects:{},startedAt:at,...(v.cycleLimit?{cycleLimit:v.cycleLimit,validationGrantId:v.grantId}:{}),...(v.previousBasis?{previousBasis:v.previousBasis}:{}),...(v.fromValidationGrantId?{fromValidationGrantId:v.fromValidationGrantId}:{}),...(v.evidenceAcquisition?{evidenceAcquisition:structuredClone(v.evidenceAcquisition)}:{})};
 if(v.migrationId)s.migrations[v.migrationId] ||= {at,taskId:t.id,code:'PLAN_ALREADY_RECONCILED',cycles:v.cycles,proof:structuredClone(v.proof)};
 s.activeTaskId=t.id;s.activeBasis=v.basis;
 if(v.grantId){const g=validation().active(job);if(g?.grantId===v.grantId){g.takeoverPending=false;g.takenOverAt ||= at;}}
 const old=job.executionState.workEfficiency;
 if(old){if(old.active){old.history=[...rows(old.history),{...old.active,queue:undefined,outcome:'continuation_handoff',finishedAt:at}].slice(-24);delete old.active;}old.phase='working';}
 if(job.status!=='running')job.status='ready';job.nextRunAt=at;job.summary='已按原身份准备接续；原失败记录和累计费用保留';
}
function activate(a,job,task,{code,legacyCycles=0,migrationId}={}){
 require('./operation-ledger.cjs').state(job);const s=job.executionState.continuation ||= {version:VERSION,episodes:{},migrations:{}};
 const key=basis(a,job,task);s.episodes[key] ||= {taskId:task.id,basis:key,intentBasis:intentBasis(job,task),factKeys:factKeys(a,job,task),hops:0,cycles:Math.min(legacyCycles,MAX_CYCLES),executions:0,redirects:{},startedAt:now()};
 s.activeTaskId=task.id;s.activeBasis=key;s.version=VERSION;if(migrationId)s.migrations[migrationId]={at:now(),taskId:task.id,code};
 const old=job.executionState.workEfficiency;
 if(old){if(old.active){old.history=[...rows(old.history),{...old.active,queue:undefined,outcome:'continuation_handoff',finishedAt:now()}].slice(-24);delete old.active;}old.phase='working';}
 return s.episodes[key];
}
function activateValidation(a,job,task,grant){
 require('./operation-ledger.cjs').state(job);const s=job.executionState.continuation ||= {version:VERSION,episodes:{},migrations:{}};
 const key='validation:'+grant.grantIdentity;
 s.episodes[key] ||= {taskId:task.id,basis:key,validationGrantId:grant.grantId,intentBasis:intentBasis(job,task),factKeys:factKeys(a,job,task),hops:0,cycles:grant.knownFailures,cycleLimit:grant.knownFailures+1,executions:0,redirects:{},startedAt:now()};
 s.activeTaskId=task.id;s.activeBasis=key;
 const e=s.episodes[key];
 if(grant.outcome==='failed'){block(a,job,e,'一次修复验证已停止：'+grant.outcomeReason+'。已有结果、历史尝试和累计费用均保留。');return e;}
 const old=job.executionState.workEfficiency;if(old){if(old.active){old.history=[...rows(old.history),{...old.active,queue:undefined,outcome:'validation_handoff',finishedAt:now()}].slice(-24);delete old.active;}old.phase='working';}
 return e;
}
function takeoverValidation(a,job,grant){
 const s=state(job),key='validation:'+grant.grantIdentity;
 if(s?.episodes?.[key])return false; // A later pause/terminal fact always wins.
 const task=tasks(a,job).find(t=>t.id===grant.taskId);
 const choice=task&&{tool:'advance_task',args:{taskId:task.id}};
 if(!task||!allowed(a,job,task)||!validation().allowedAction(a,job,choice).allowed){grant.takeoverPending=true;return false;}
 activateValidation(a,job,task,grant);grant.takeoverPending=false;grant.takenOverAt ||= now();
 job.status='ready';job.nextRunAt=now();job.summary='已记录一次原稿修复验证，将在当前权限和累计额度内接续';return true;
}
function noteGoalCheck(a,job,check){
 const grant=validation().active(job),s=state(job),e=grant&&s?.episodes?.['validation:'+grant.grantIdentity];
 if(grant&&s?.validationHandoffs?.[grant.grantId])return;
 if(!grant||!e||!validation().noteGoalCheck?.(a,job,check,{basis:check.basis}))return;
 if(grant.outcome==='failed')block(a,job,e,'一次修复验证的整体检查未通过：'+rows(check.gaps).join('；')+'。已有结果保留，不重复修订。');
 else if(check.passed)e.complete=true;
}
function validationFailure(a,job,e,reason){
 validation().finish(a,job,reason);block(a,job,e,'一次修复验证已停止：'+reason+'。已有结果、历史尝试和累计费用均保留。');
}
function engaged(a,job){const s=state(job),task=tasks(a,job).find(t=>t.id===s?.activeTaskId);return !!task&&!!episode(a,job,task)&&!episode(a,job,task).complete;}
function block(a,job,e,message){
 state(job).activeTaskId=e.taskId;
 e.blocked=true;e.reason=message;e.stoppedAt=now();job.status='blocked';job.nextRunAt=null;job.lastError=message;job.lastErrorCode='CONTINUATION_EXHAUSTED';job.summary=message;
 const old=job.executionState.workEfficiency;if(old){old.phase='awaiting_change';old.waitBasis=require('./strategy-recovery.cjs').inputBasis(a,job);old.lastFailure={code:'CONTINUATION_EXHAUSTED',message,taskId:e.taskId,scope:'task'};}
 job.executionState.recovery={code:'CONTINUATION_EXHAUSTED',message,at:now()};
}
function redirect(a,job,step,error){
 if(error.gateClosed)return false;
 if(!ROUTABLE.has(error.code))return false;
 const id=error.taskId||step.args?.taskId||step.args?.existingTaskId,task=tasks(a,job).find(t=>t.id===id);
 if(!task||!allowed(a,job,task))return false;
 const next=inspect(a,job,task);if(!next.action)return false;
 const e=validation().active(job)?currentEpisode(a,job,task):activate(a,job,task,{code:error.code});
 const key=hash({code:error.code,action:next.action,revision:task.planVersion,artifact:require('./deliverables.cjs').primary(a,task)?.id});
 // Repeated identical hops consume the same finite budget, but are not executions.
 if(e.hops>=MAX_HOPS){if(e.validationGrantId)validation().finish(a,job,'PREREQUISITE_HOPS_EXHAUSTED');step.continuation={handled:true,kind:'redirect'};block(a,job,e,'同一要求的前置条件接续已达到有限次数：'+error.message+'。需要新的有效证据或具体执行条件，已有结果和费用保留。');return true;}
 e.hops++;e.redirects[key]={count:(e.redirects[key]?.count||0)+1,at:now()};e.lastError={code:error.code,message:error.message};
 step.continuation={handled:true,kind:'redirect',next:next.action.tool};
 if(e.hops>MAX_HOPS)block(a,job,e,'同一要求的前置条件接续仍未收敛：'+error.message+'。需要新的有效证据或具体执行条件，已有结果和费用保留。');
 else job.executionState.recovery={code:error.code,message:next.action.reason,taskId:task.id,at:now(),allowedTools:[next.action.tool]};
 return true;
}
function next(a,job){
 if(!engaged(a,job))return null;const task=tasks(a,job).find(t=>t.id===state(job).activeTaskId),e=episode(a,job,task),choice=inspect(a,job,task);
 const consumption=require('./evidence-consumption.cjs').inspect(a,job,task);if(consumption?.eligible)return {...consumption.action,controlled:true,continuation:true};if(consumption)return null;
 if(allowed(a,job,task,{allowReview:task.status==='review'&&task.verification?.passed===true})&&(e.validationGrantId||e.fromValidationGrantId)){const evidence=acquisition().next(a,job,task,e);if(evidence)return evidence;}
 if(e.blocked)return null;
 if(e.validationGrantId){const decision=choice.action&&validation().allowedAction(a,job,choice.action);if(!decision?.allowed){const reason=decision?.reason||'VALIDATION_PATH_UNRESOLVED';validationFailure(a,job,e,reason);throw Object.assign(Error(job.summary),{code:reason,noProgress:true});}}
 return choice.action?{...choice.action,controlled:true,continuation:true}:null;
}
function started(a,job,step){
 const id=step.args?.taskId||step.args?.existingTaskId||(step.tool==='complete'?state(job)?.activeTaskId:null),task=tasks(a,job).find(t=>t.id===id),e=task&&episode(a,job,task);if(!e||e.complete)return;
 if((e.validationGrantId||e.fromValidationGrantId)&&acquisition().started(a,job,task,e,step)){step.continuation={handled:true,tracked:true,kind:'evidence',basis:e.basis};return;}
 if(e.blocked)throw Object.assign(Error(e.reason),{code:'CONTINUATION_EXHAUSTED',noProgress:true});
 if(e.validationGrantId)try{validation().before(a,job,step);}catch(error){validationFailure(a,job,e,error.code||'VALIDATION_GUARDED');throw error;}
 e.executions++;e.lastDispatch={tool:step.tool,at:now()};step.continuation={handled:engaged(a,job),tracked:true,kind:'execution',basis:e.basis};
 if(step.tool==='advance_task'&&!require('./evidence-consumption.cjs').selectedStep(a,job,task)&&rows(task.steps).some(s=>!s.done&&['analysis','draft'].includes(s.kind)))e.revisionPending=true;
}
function currentEpisode(a,job,task){const s=state(job);return s?.activeTaskId===task.id&&s.episodes?.[s.activeBasis]||episode(a,job,task);}
// Called inside the same saved-state transition as the check. Replaying a
// committed check or settling its run after restart cannot count it twice.
function noteCheck(a,job,task,check,{phase='content'}={}){
 if(!job||!check||typeof check.passed!=='boolean')return;
 require('./pending-check.cjs').noteCheck(a,job,task,check,{phase});
 validation().noteCheck(a,job,task,check,{phase});
 let e=currentEpisode(a,job,task);
 if(!e&&!check.passed&&allowed(a,job,task))e=activate(a,job,task,{code:'CONTENT_REPAIR_REQUIRED'});
 if(!e||e.complete)return;
 const key=hash({taskId:task.id,phase,basis:check.basis||require('./execution-control.cjs').contentBasis(a,job,task)});
 e.checks ||= {};if(e.checks[key])return;
 const consumed=check.passed===false&&e.revisionPending===true;
 e.checks[key]={at:check.at||now(),passed:check.passed,consumed};
 if(consumed)e.cycles++;
 e.revisionPending=false;
 if(e.validationGrantId&&validation().active(job)?.outcome==='failed'){block(a,job,e,'一次修复验证未通过：'+rows(check.gaps).join('；')+'。已保留检查结果，不自动重写。');return;}
 if(e.cycles>=(e.cycleLimit||MAX_CYCLES))block(a,job,e,'同一未解决要求已完成 '+MAX_CYCLES+' 次修订检查仍未收敛：'+rows(check.gaps).join('；')+'。需要补齐具体事实或修正执行条件。');
}
function settled(a,job,step){
 if(step.gateClosed||step.errorCode==='EXECUTION_GATE_CLOSED')return;
 if(!engaged(a,job)&&step.result?.verification?.passed===false){
  const t=tasks(a,job).find(t=>t.id===step.args?.taskId);if(t&&allowed(a,job,t))activate(a,job,t,{code:'CONTENT_REPAIR_REQUIRED'});
 }
 const id=step.args?.taskId||step.args?.existingTaskId||(step.tool==='complete'?state(job)?.activeTaskId:null),task=tasks(a,job).find(t=>t.id===id),e=task&&(state(job)?.episodes?.[step.continuation?.basis]||currentEpisode(a,job,task));if(!e||e.complete)return;
 step.continuation ||= {handled:engaged(a,job),tracked:true,kind:'execution'};
 if(acquisition().settled(a,job,task,e,step))return;
 if(e.validationGrantId){const outcome=validation().after(a,job,step);if(outcome?.outcome==='failed'){block(a,job,e,'一次修复验证已停止：'+outcome.outcomeReason+'。已有结果和累计费用保留。');return;}}
 const check=step.result?.verification;
 if(step.error&&step.continuation.kind!=='redirect'){
  e.lastError={code:step.errorCode,message:step.error};
  if(['MODEL_INVALID_RESPONSE','EVIDENCE_NOT_INTEGRATED'].includes(step.errorCode)){const key=hash({tool:step.tool,at:step.at,basis:step.continuation?.basis,dispatch:e.lastDispatch});e.failedAttempts ||= {};if(!e.failedAttempts[key]){e.failedAttempts[key]={code:step.errorCode,at:step.at};e.cycles++;}e.revisionPending=false;}
  else if(['PLAN_INPUT_INVALID','PLAN_RECONCILE_REQUIRED','REVISION_TARGET_REQUIRED','EVIDENCE_REQUIRED'].includes(step.errorCode)){if(e.hops>=MAX_HOPS)block(a,job,e,'同一未满足前置条件反复出现：'+step.error);else e.hops++;}
 }else if(check)noteCheck(a,job,task,check,{phase:step.tool==='verify_content'?'content':'result'});
 if(!e.validationGrantId&&(task.status==='completed'||step.tool==='complete'&&!step.error&&(step.result?.completed||step.result?.awaitingReview||step.result?.serving)))e.complete=true;
 if(e.cycles>=(e.cycleLimit||MAX_CYCLES))block(a,job,e,'同一未解决要求已完成 '+MAX_CYCLES+' 次修订检查仍未收敛：'+(rows(check?.gaps).join('；')||e.lastError?.message||'检查未闭合')+'。请核对缺少的具体事实或执行条件，不能仅改写稿件再次重跑。');
}
function handoff(a,job,error){
 if(error.gateClosed)return false;
 if(!engaged(a,job))return false;const task=tasks(a,job).find(t=>t.id===state(job).activeTaskId),e=episode(a,job,task);
 if(e.validationGrantId){validationFailure(a,job,e,error.code||'VALIDATION_NO_PROGRESS');return true;}
 if(e.hops>=MAX_HOPS){block(a,job,e,'接续后仍未取得有效进展：'+error.message+'。已保存具体失败依据，需要不同的有效执行条件。');return true;}
 e.hops++;e.suspendedBy={code:error.code,message:error.message,at:now()};state(job).activeTaskId=null;return false;
}
function acquiring(a,job){const task=tasks(a,job).find(t=>t.id===state(job)?.activeTaskId),e=task&&episode(a,job,task);return !!e&&!!(e.validationGrantId||e.fromValidationGrantId)&&allowed(a,job,task)&&acquisition().hasWork(a,job,task,e);}
function failure(a,job){const task=tasks(a,job).find(t=>t.id===state(job)?.activeTaskId),e=task&&episode(a,job,task);return e?.blocked?e.reason:null;}
function ready(a,job,{taskId,stage}={}) {
 const selected=tasks(a,job).filter(t=>!taskId||t.id===taskId),owned=selected.filter(t=>{const e=episode(a,job,t);return e&&!e.complete;});
 if(!owned.length)return null;
 return owned.some(t=>{const r=peek(a,job,t);return r?.eligible&&!r.prepareRequired&&(stage!=='planner'||r.action?.tool==='planner');});
}
function consumedFactKeys(job,task,intent){
 return new Set(Object.values(state(job)?.episodes||{}).filter(e=>e.taskId===task.id&&e.intentBasis===intent).flatMap(e=>rows(e.factKeys)));
}
function evidenceHandoffPayload(a,job,task,{pendingResolution}={}){
 const grant=validation().active(job),s=state(job),old=grant&&s?.episodes?.['validation:'+grant.grantIdentity];
 if(!old||s.validationHandoffs?.[grant.grantId]||task.id!==grant.taskId||!allowed(a,job,task))return null;
 const facts=require('./relation-obligations.cjs').recoveryFacts(a,job,task,{pendingResolution}),fresh=[...new Set(facts.map(hash))].sort(),intent=intentBasis(job,task),used=consumedFactKeys(job,task,intent),newFacts=fresh.filter(k=>!used.has(k));
 if(!newFacts.length||intent!==old.intentBasis)return null;
 return {taskId:task.id,grantId:grant.grantId,previousBasis:old.basis,nextBasis:hash({taskId:task.id,intent,facts:fresh}),intentBasis:intent,factKeys:fresh,newFactKeys:newFacts,proofIdentity:hash({taskId:task.id,intentBasis:intent,newFactKeys:newFacts}),at:now(),workRevision:job.workRevision??1,taskWorkRevision:task.workRevision??1,sourceProof:structuredClone(task.lastEvidenceResolution?.recoveryProof||null),facts};
}
function projectEvidenceHandoff(a,job,p){
 const task=tasks(a,job).find(t=>t.id===p.taskId),grant=validation().active(job),s=state(job);if(!task||!s||grant?.grantId!==p.grantId)return;
 s.validationHandoffs ||= {};const prior=s.validationHandoffs[p.grantId];
 if(prior&&prior.proofIdentity!==p.proofIdentity)throw Object.assign(Error('修复验证移交身份冲突'),{code:'WORK_JOURNAL_CONFLICT'});
 s.validationHandoffs[p.grantId] ||= structuredClone(p);
 const handoff=s.validationHandoffs[p.grantId];
 if(handoff.appliedAt)return;
 const facts=factKeys(a,job,task);
 if((job.workRevision??1)!==p.workRevision||(task.workRevision??1)!==p.taskWorkRevision||intentBasis(job,task)!==p.intentBasis||!p.newFactKeys.every(k=>facts.includes(k))||!allowed(a,job,task,{allowReview:task.status==='review'})){handoff.pending=true;return;}
 const e=activate(a,job,task,{code:'RELATED_FACTS_CHANGED'});e.previousBasis=p.previousBasis;e.fromValidationGrantId=p.grantId;e.factProofIdentity=p.proofIdentity;const previous=s.episodes[p.previousBasis];if(previous?.evidenceAcquisition)e.evidenceAcquisition=structuredClone(previous.evidenceAcquisition);if(e.evidenceAcquisition)delete e.evidenceAcquisition.pendingPlan;
 handoff.pending=false;handoff.appliedAt=now();handoff.appliedBasis=e.basis;
 if(e.blocked)block(a,job,e,e.reason);else{job.status='ready';job.nextRunAt=now();job.summary='原缺口已取得合法新事实，先补齐剩余证据再修订原稿；原验证记录和费用保留';}
}
function refresh(a,job){
 const grant=validation().active(job),s=state(job);
 if(grant&&!s?.validationHandoffs?.[grant.grantId]){
  const task=tasks(a,job).find(t=>t.id===grant.taskId);if(!task)return false;const current=s?.episodes?.['validation:'+grant.grantIdentity];
  if(!current){let changed=false;require('./state-transitions.cjs').commit(a,()=>{changed=takeoverValidation(a,job,grant);});return changed;}
  const fresh=factKeys(a,job,task),intent=intentBasis(job,task),used=consumedFactKeys(job,task,intent),newFacts=fresh.filter(k=>!used.has(k));
  if(newFacts.length&&allowed(a,job,task,{allowReview:task.status==='review'})&&intent===current.intentBasis)return acquisition().handoff(a,job,task,current,grant,{factKeys:fresh,intentBasis:intent,nextBasis:basis(a,job,task),newFactKeys:newFacts});
  if(grant.outcome==='failed'&&!current.blocked){require('./state-transitions.cjs').commit(a,()=>activateValidation(a,job,task,grant));return true;}
  return false;
 }
 if(grant&&s?.validationHandoffs?.[grant.grantId]?.pending){require('./state-transitions.cjs').commit(a,()=>projectEvidenceHandoff(a,job,s.validationHandoffs[grant.grantId]));return !s.validationHandoffs[grant.grantId].pending;}
 const task=tasks(a,job).find(t=>t.id===s?.activeTaskId),old=task&&episode(a,job,task);
 if(!old||!task||!allowed(a,job,task))return false;
 const key=basis(a,job,task);if(key===old.basis)return false;
 const fresh=factKeys(a,job,task),intent=intentBasis(job,task),used=consumedFactKeys(job,task,intent),changedIntent=old.intentBasis&&old.intentBasis!==intent;
 if(!changedIntent&&!fresh.some(k=>!used.has(k)))return false;
 require('./state-transitions.cjs').commit(a,()=>{
  const e=activate(a,job,task,{code:'RELATED_FACTS_CHANGED'});e.previousBasis ||= old.basis;if(old.fromValidationGrantId){e.fromValidationGrantId ||= old.fromValidationGrantId;if(old.evidenceAcquisition)e.evidenceAcquisition=structuredClone(old.evidenceAcquisition);}
  if(e.blocked)block(a,job,e,e.reason);else{job.status='ready';job.nextRunAt=now();job.summary='当前缺口已有新的合法相关事实，继续分析并核对原要求';}
 });return true;
}
function migrate(a,job){
 if(validation().active(job))return false;
 const old=job.executionState?.workEfficiency;
 if(old?.phase!=='awaiting_change'||old.lastFailure?.code!=='PLAN_ALREADY_RECONCILED')return false;
 const task=tasks(a,job).find(t=>!t.needsReplan&&!t.evidenceRequest&&rows(t.steps).find(s=>!s.done)?.kind!=='external'&&allowed(a,job,t));
 if(!task)return false;
 if(!inspect(a,job,task,{ignoreExhaustion:true}).action)return false;
 const imported=require('./continuation-migration.cjs').inspect(a,job,task);
 if(!imported.eligible||!Number.isInteger(imported.cycles))return false;
 require('./state-transitions.cjs').commit(a,()=>{
  activate(a,job,task,{code:'PLAN_ALREADY_RECONCILED',legacyCycles:imported.cycles,migrationId:imported.migrationId});
  state(job).migrations[imported.migrationId]={at:now(),taskId:task.id,code:'PLAN_ALREADY_RECONCILED',cycles:imported.cycles,proof:imported.proof};
  job.status='ready';job.nextRunAt=now();job.summary='已修复计划接续前置条件，将沿已保存计划继续当前主稿';
 });
 return true;
}
module.exports={intentBasis,factKeys,peek,preparation,applyPrepared,episode,allowed,actionInspect,VERSION,MAX_HOPS,MAX_CYCLES,inspect,engaged,ready,redirect,next,started,settled,migrate,basis,handoff,failure,existingAction,noteCheck,refresh,activateValidation,takeoverValidation,noteGoalCheck,projectEvidenceHandoff,evidenceHandoffPayload,acquiring};
