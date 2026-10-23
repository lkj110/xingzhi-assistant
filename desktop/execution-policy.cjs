'use strict';
// Inspect has no command calls. Prepare/claim are the only mutation boundary.
const facts=require('./execution-facts.cjs');
const {hash}=require('./evidence-basis.cjs');
const continuation=require('./continuation-control.cjs');
const strategy=require('./strategy-recovery.cjs');
const control=require('./execution-control.cjs');
const journal=require('./work-journal.cjs');
const rows=facts.rows;
const TYPE='execution_policy_prepared';
const preflightMessages={
 MODEL_PREFLIGHT_HEALTH_REQUIRED:'本次接续尚无有效的订阅检测记录。请在模型预检恢复中重新检测订阅状态后继续；原失败、稿件和累计费用保留。',
 MODEL_PREFLIGHT_HEALTH_CHANGED:'当前配置与原恢复绑定的身份不一致，请核对配置与恢复记录。若页面提供旧版健康身份确认入口，可按已有授权确认；重新检测本身不会替换原恢复记录。'
};
function options(a,opts={}){return {now:Date.now(),mode:'automatic',...opts};}
function diagnostics(a,job){
 const recovery=job.executionState?.workEfficiency,episodes=Object.values(job.executionState?.continuation?.episodes||{});
 const unmetObligations=facts.tasks(a,job).flatMap(t=>[t.contentVerification,t.verification].filter(c=>c?.passed===false).flatMap(c=>rows(c.gaps).map(text=>({taskId:t.id,text}))));
 for(const gap of rows(job.executionState?.gaps).filter(g=>g.status==='open'))if(gap.text)unmetObligations.push({taskId:gap.taskId||null,text:gap.text,requirementId:gap.requirementId||null});
 const attemptedMethods=[...new Set([...Object.values(recovery?.tried||{}).map(r=>r.title),...rows(recovery?.history).map(r=>r.title),...episodes.filter(e=>e.blocked).map(e=>e.cycles+' 次原稿修订检查')].filter(Boolean))];
 return {unmetObligations,attemptedMethods,lastFailure:recovery?.lastFailure||recovery?.blocker?.lastFailure||null,retryConditions:['补齐与当前未满足义务相关的新事实','用户通过正常入口明确修改要求或恢复所缺权限','未使用过且与原失败对应的读取方法升级；原历史及累计额度保留']};
}
function inspect(a,job,opts={}) {return require('./projection-cache.cjs').scope(()=>inspectPure(a,job,opts));}
function inspectPure(a,job,opts={}) {
 opts=options(a,opts);const automatic=opts.mode!=='manual',at=Number(new Date(opts.now));
 const base={phase:'blocked',eligible:false,mode:opts.mode,reasonCode:null,reason:null,taskIds:[],action:null,resumeAt:null,owner:null,choices:[],commands:[],basisRefs:{jobId:job.id,workRevision:job.workRevision??1},diagnostics:diagnostics(a,job)};
 const result=(phase,code,extra={})=>({...base,phase,reasonCode:code,reason:code,...extra});
 const gate=facts.gate(a,job,null,{now:at,automatic,readOnly:true});
 if(!gate.automaticAllowed)return result(['terminal','paused','workspace_paused','suspended'].includes(gate.reason)?(gate.reason==='terminal'?job.deletedAt?'deleted':job.status:'paused'):'blocked',gate.reason,{reason:gate.message,resumeAt:gate.resumeAt});
 const live=facts.conflict(a,job,opts);
 if(live)return result(live.jobId===job.id?'running':'blocked',live.jobId===job.id?'EXECUTION_RUNNING':'EXECUTION_CONFLICT');
 const existing=continuation.actionInspect(a,job,{automatic,...opts});let externalBlock=null;
 if(existing&&existing.kind!=='check_content'){
  const r=existing.action,mode=existing.kind==='reconcile'?'reconcile_existing':existing.kind==='approved'?'execute_approved_existing':'await_approval';
  if(r&&existing.kind==='reconcile'&&!r.jobId&&facts.tasks(a,job).some(t=>t.id===r.taskId)&&job.pendingActionId!==r.id)return result('prepare_pending','EXTERNAL_ATTENTION',{commands:[{command:'external_attention',taskId:r.taskId,proof:{actionId:r.id,status:r.status}}]});
  const task=facts.tasks(a,job).find(t=>t.id===r?.taskId),g=facts.gate(a,job,task,{now:at,automatic,readOnly:existing.kind==='reconcile'});
  const external=result(existing.eligible&&g.automaticAllowed?'ready':mode==='await_approval'?'needs_input':'blocked',g.automaticAllowed?existing.reason:g.reason,{eligible:existing.eligible&&g.automaticAllowed,mode,taskIds:task?[task.id]:[],owner:{kind:'external',actionId:r?.id},action:r?{tool:r.tool,args:{taskId:r.taskId},actionId:r.id,target:r.target,version:r.version}:null,basisRefs:{...base.basisRefs,actionId:r?.id,target:r?.target,version:r?.version,reconciliationBasis:existing.basis}});
  if(external.eligible||!task||r?.scope==='job'||r?.scope==='workspace')return external;
  externalBlock=external;
 }
 const paid=facts.gate(a,job,null,{now:at,automatic});
 if(!paid.automaticAllowed)return result(job.status==='limited'?'limited':'blocked',paid.reason,{reason:paid.message,resumeAt:paid.resumeAt});
 const identity=require('./evidence-identity-preflight.cjs');
 const hasIdentityHistory=Object.keys(job.executionState?.identityPreflights||{}).length>0&&identity.inspect(a,job,{now:at}).decision.action!=='execute';
 const deadlineClaim=facts.deadlineClaimed(a,job,opts),currentRun=opts.operationId&&a.activeAgentJob?.id===job.id&&a.activeAgentRun?.id===opts.operationId&&a.activeAgentRun.status==='running'&&!a.activeAgentRun.finishedAt;
 if(!hasIdentityHistory&&automatic&&!currentRun&&!deadlineClaim&&job.nextRunAt&&Date.parse(job.nextRunAt)>at&&(job.status==='retry'||!facts.deadlinePending(a,job,at).length))return result(job.status==='retry'?'retry':'watching','NOT_DUE',{resumeAt:job.nextRunAt});
 const config=facts.modelGuard(a,job);if(config)return result('blocked',config.code,{reason:config.message});
 if(job.memorySignature){const current=require('./memory.cjs').signature(a,job.projectId);if(current!==job.memorySignature)return result('prepare_pending','MEMORY_CHANGED',{commands:[{command:'memory_reconcile',proof:{previous:job.memorySignature,current}}]});}
 if(job.status==='blocked'&&!job.executionState?.workEfficiency&&!job.executionState?.continuation&&job.lastError)return result('blocked',job.lastErrorCode||'UNRESOLVED_FAILURE',{reason:job.lastError});
 const pending=require('./pending-check.cjs').inspect(a,job);
 if(pending.eligible&&pending.prepareRequired)return result('prepare_pending','PENDING_CHECK_RESTORE',{commands:[{command:'pending_check',taskId:pending.taskId,proof:pending.proof}],taskIds:[pending.taskId]});
 const preflightBlocks=new Map();
 for(const task of facts.tasks(a,job)){
  if(!facts.gate(a,job,task,{now:at,automatic}).automaticAllowed||facts.dispatchBlockers(a,job,task,{automatic}).length)continue;
  const recovery=require('./model-preflight-recovery.cjs').inspect(a,job,task);
  if(recovery.eligible&&recovery.command)return result('prepare_pending','MODEL_PREFLIGHT_RECOVERY',{commands:[{command:recovery.command,taskId:task.id,proof:recovery.proof}],taskIds:[task.id]});
  if(recovery.eligible&&recovery.action){
   const episode=continuation.episode(a,job,task),owner={kind:'continuation',taskId:task.id,basis:episode?.basis||null},saved=job.executionState?.policyOwner,state=job.executionState?.continuation;
   // Recovery must hand its existing episode back to the same scheduler before
   // dispatch, so the resulting draft can reach its normal check afterwards.
   if(episode&&(state.activeTaskId!==task.id||state.activeBasis!==episode.basis||saved&&(saved.taskId!==owner.taskId||saved.kind!==owner.kind||saved.basis!==owner.basis)))return result('prepare_pending','OWNER_SELECTION',{commands:[{command:'owner_select',taskId:task.id,proof:{owner,previous:saved||null}}],taskIds:[task.id],owner});
   return result('ready','MODEL_PREFLIGHT_RECOVERY',{eligible:true,action:recovery.action,route:'consume',taskIds:[task.id],owner});
  }
  // Only a proved candidate/prepared grant can replace the old failure's
  // explanation. Finish the loop so another independent recovery can run.
  if(!recovery.eligible&&(recovery.proof||recovery.grant)&&preflightMessages[recovery.reason])preflightBlocks.set(task.id,{code:recovery.reason,message:preflightMessages[recovery.reason]});
 }
 for(const task of facts.tasks(a,job)){
  if(!facts.gate(a,job,task,{now:at,automatic}).automaticAllowed)continue;
  const command=require('./evidence-recovery.cjs').legacyPreflightCommands(a,job,task)[0];
  if(command)return result('prepare_pending','EVIDENCE_PREFLIGHT_PROVEN',{commands:[{...command,taskId:task.id}],taskIds:[task.id]});
 }
 const preparation=continuation.preparation(a,job);
 if(preparation)return result('prepare_pending','CONTINUATION_PREPARATION',{commands:[preparation],taskIds:[preparation.taskId]});
 const input=require('./input-recovery.cjs');
 if(input.eligible(a,job))return result('prepare_pending','INPUT_RECOVERY_PREPARATION',{commands:[{command:'input_recovery',proof:{policyVersion:input.POLICY_VERSION,runId:input.candidate(a,job).run.id}}]});
 if(job.lastErrorAutomaticRetry===false){const entry=preflightBlocks.entries().next().value;return entry?result('blocked',entry[1].code,{reason:entry[1].message,taskIds:[entry[0]]}):result('blocked',job.lastErrorCode||'MANUAL_RECOVERY_REQUIRED',{reason:job.lastError||'当前错误需要明确恢复条件'});}
 const legacy=job.executionState?.workEfficiency;if(job.status==='blocked'&&legacy?.phase==='working'&&legacy.lastFailure&&!legacy.progressVersion&&!legacy.lastProgressAt&&!legacy.active&&!job.executionState?.continuation)return result('blocked',legacy.lastFailure.code||'UNPROVEN_RECOVERY',{reason:legacy.lastFailure.message});
 // A prepared payload is new input to the ordinary paid checker. It cannot
 // bypass due times, failed-call recovery, pending checks or explicit no-retry.
 if(existing?.kind==='check_content'){
  const r=existing.action,task=facts.tasks(a,job).find(t=>t.id===r.taskId),g=facts.gate(a,job,task,{now:at,automatic}),config=facts.modelGuard(a,job,task,{role:'verify'}),action={tool:'verify_content',args:{taskId:r.taskId},reason:'核对已准备动作的实际标题与当前文稿'};
  const blocked=existing.eligible&&g.automaticAllowed&&!config?identity.action(a,job,action,{now:at}):null,eligible=existing.eligible&&g.automaticAllowed&&!config&&!blocked;
  const review=result(eligible?'ready':'blocked',g.automaticAllowed?config?.code||blocked?.reasonCode||existing.reason:g.reason,{eligible,mode:'verify_prepared_existing',taskIds:[r.taskId],owner:{kind:'prepared_action',actionId:r.id,taskId:r.taskId},action,basisRefs:{...base.basisRefs,actionId:r.id,version:r.version},...(blocked?{identity:blocked.identity}:{} )});
  if(eligible)return review;externalBlock=review;
 }
 const choices=[];
 for(const task of facts.tasks(a,job)){
  const g=facts.gate(a,job,task,{now:at,automatic}),blockers=facts.dispatchBlockers(a,job,task,{automatic});
  const c={taskId:task.id,owner:'ordinary',ownerEpisodeId:null,phase:facts.taskPhase(task),eligible:false,action:null,blockers};
  if(!g.automaticAllowed||blockers.length||['waiting','review','completed','paused','cancelled','deleted'].includes(c.phase)){
   // A stale review is coordinated before another model or write.
   if(g.automaticAllowed&&!blockers.length&&c.phase==='review'&&!task.acceptedAt){const p=control.peek(a,job,{taskId:task.id,automatic});if(p?.command){c.command=p.command;c.proof=p.proof;c.phase='prepare_pending';}}
   choices.push({...c,reasonCode:g.reason||blockers[0]?.code||c.phase});continue;
  }
  const permission=facts.modelGuard(a,job,task);if(permission){choices.push({...c,reasonCode:permission.code});continue;}
  const preflightBlock=preflightBlocks.get(task.id);if(preflightBlock){choices.push({...c,phase:'blocked',reasonCode:preflightBlock.code,message:preflightBlock.message});continue;}
  const direct=continuation.peek(a,job,task,{automatic,now:at});
  if(direct){choices.push({...c,...direct,reasonCode:direct.reason});continue;}
  if(job.executionState?.workEfficiency&&!facts.legacyRecoveryApplies(a,job,task)){
   // Only a proven task-scoped continuation exhaustion can admit an untouched
   // sibling's own episode. It neither partitions nor clears legacy counters.
   const prior=Object.values(job.executionState?.continuation?.episodes||{}).filter(e=>e.taskId===task.id);
   if(!prior.length){choices.push({...c,phase:'prepare_pending',command:'continuation_independent',proof:{basis:continuation.basis(a,job,task),intentBasis:hash({contract:job.executionContract?.text||job.goal,requirements:task.userRequirement?Object.fromEntries(['description','objective','criteria'].map(k=>[k,task.userRequirement[k]])):null}),factKeys:continuation.factKeys(a,job,task),cycles:0,scope:'new_independent_task'}});continue;}
  }
  const recovery=strategy.inspect(a,job,{taskId:task.id,automatic});
  if(!recovery.eligible){choices.push({...c,...recovery,reasonCode:recovery.reason});continue;}
  const action=recovery.action||control.peek(a,job,{taskId:task.id,automatic});
  choices.push({...c,owner:recovery.owner||c.owner,eligible:!!action&&!action.command,action:action?.command?null:action,command:action?.command,proof:action?.proof,reasonCode:action?'TASK_READY':'NO_TASK_ACTION'});
 }
 // Gate concrete actions only after the original task/authority controls.
 for(const c of choices)if(c.eligible){const blocked=identity.action(a,job,c.action?.tool==='planner'?{...c.action,args:{...c.action.args,taskId:c.taskId}}:c.action,{now:at});if(blocked)Object.assign(c,blocked);}
 base.choices=choices;
 base.diagnostics.identity=choices.filter(c=>c.identity).map(c=>({taskId:c.taskId,decision:c.identity.decision,key:c.identity.key,retryConditions:c.retryConditions}));
 // Stable task order, not activeTaskId, chooses among independent episodes.
 const selected=choices.find(c=>c.eligible);
 if(selected){
  const owner={kind:selected.owner,taskId:selected.taskId,basis:selected.ownerEpisodeId||null};
  const saved=job.executionState?.policyOwner;
  if(selected.owner==='continuation'&&(job.executionState?.continuation?.activeTaskId!==selected.taskId||job.executionState?.continuation?.activeBasis!==selected.ownerEpisodeId)||saved&&(saved.taskId!==owner.taskId||saved.kind!==owner.kind||saved.basis!==owner.basis))return result('prepare_pending','OWNER_SELECTION',{commands:[{command:'owner_select',taskId:selected.taskId,proof:{owner,previous:saved||null}}],taskIds:[selected.taskId],owner});
  return result('ready','TASK_READY',{eligible:true,taskIds:[selected.taskId],action:structuredClone(selected.action),owner,route:selected.route||null,basisRefs:{...base.basisRefs,taskId:selected.taskId,episode:selected.ownerEpisodeId||null}});
 }
 const command=choices.find(c=>c.command);if(command)return result(command.command.startsWith('strategy_')?'recovery_pending':'prepare_pending',command.reasonCode||'TASK_PREPARATION',{commands:[{command:command.command,taskId:command.taskId,proof:command.proof}],taskIds:[command.taskId]});
 if(externalBlock)return externalBlock;
 const identityChoices=choices.filter(c=>c.identity);
 if(identityChoices.length){
  const waiting=identityChoices.filter(c=>c.phase==='retry').sort((a,b)=>Date.parse(a.resumeAt)-Date.parse(b.resumeAt));
  const stopped=waiting[0]||identityChoices[0];
  return result(stopped.phase,stopped.reasonCode,{reason:stopped.message,resumeAt:stopped.resumeAt,identity:stopped.identity,diagnostics:{...base.diagnostics,retryConditions:stopped.retryConditions},taskIds:identityChoices.map(c=>c.taskId)});
 }
 const acceptance=require('./acceptance.cjs'),all=facts.tasks(a,job),candidate=acceptance.completionCandidate(a,job);
 const allAccepted=all.length&&all.every(t=>t.status==='completed');
 if(allAccepted){const desired=candidate.checked?(acceptance.mode(job)==='continuous'?'watching':'completed'):'finalizing';if(job.status!==desired)return result('prepare_pending','ACCEPTED_ARCHIVE',{commands:[{command:'accepted_archive',proof:{basis:candidate.basis,desired}}]});}
 const requested=job.executionState?.completionRequested;
 const retryCompletion=requested?.workRevision===(job.workRevision??1)&&requested.tasks===hash(all.map(t=>[t.id,t.workRevision??1]).sort());
 if(candidate.ready&&!candidate.checked&&!(job.completionCheck?.basis===candidate.basis&&job.completionCheck.passed===false)&&!(job.completionOperation?.basis===candidate.basis&&job.completionOperation.status==='running')&&!job.executionState?.goalFailure&&(acceptance.mode(job)!=='continuous'||job.status==='finalizing'||retryCompletion))return result('ready','COMPLETION_CHECK',{eligible:true,action:{tool:'complete',args:{},completionBasis:candidate.basis,controlled:true},owner:job.executionState?.continuation?.activeTaskId?{kind:'continuation',taskId:job.executionState.continuation.activeTaskId,basis:job.executionState.continuation.activeBasis}:{kind:'completion'},taskIds:candidate.taskIds});
 if(candidate.checked&&all.every(t=>['review','completed'].includes(t.status))&&acceptance.mode(job)!=='continuous')return result('review','AWAIT_ACCEPTANCE');
 const blockers=facts.dispatchBlockers(a,job,null,{automatic});
 const reviews=all.filter(t=>t.status==='review'&&!t.acceptedAt&&facts.gate(a,job,t,{now:at,automatic}).automaticAllowed&&!facts.dispatchBlockers(a,job,t,{automatic}).length&&!facts.modelGuard(a,job,t));
 const repair=reviews.length&&candidate.blockers.every(r=>r.code==='delivery'||r.code==='decision'&&!automatic&&!blockers.some(b=>b.code==='decision'))||reviews.length&&candidate.ready&&(job.executionState?.goalFailure||job.completionCheck?.basis===candidate.basis&&job.completionCheck.passed===false);
 if(repair){
  const t=reviews[0],owned=continuation.episode(a,job,t),recovery=owned&&!owned.complete?continuation.peek(a,job,t,{automatic}):strategy.inspect(a,job,{taskId:t.id,automatic});
  if(recovery.command)return result('prepare_pending',recovery.reason,{commands:[{command:recovery.command,taskId:t.id,proof:recovery.proof}],taskIds:[t.id]});
  if(recovery.eligible)return result('ready','COMPLETION_REPAIR',{eligible:true,action:{tool:'planner',args:{taskId:t.id}},owner:{kind:owned&&!owned.complete?'continuation':'ordinary',taskId:t.id,basis:owned?.basis||null},taskIds:reviews.map(t=>t.id)});
 }
 if(job.status==='watching'&&!!(job.watchers?.length||job.followups?.some(f=>f.status==='waiting')))return result('watching','WATCH_DUE',{eligible:true,mode:'watch',action:{tool:'check_sources',args:{}},resumeAt:job.nextRunAt||null});
 if(!all.length&&['ready','retry','running'].includes(job.status)&&!blockers.length){
  const recovery=strategy.inspect(a,job,{automatic});
  if(recovery.command)return result('prepare_pending',recovery.reason,{commands:[{command:recovery.command,proof:recovery.proof}]});
  if(recovery.eligible){const blocked=identity.action(a,job,recovery.action||{tool:'planner',args:{}},{now:at});if(blocked)return result(blocked.phase,blocked.reasonCode,{...blocked,reason:blocked.message,diagnostics:{...base.diagnostics,retryConditions:blocked.retryConditions}});}
  if(recovery.eligible)return result('ready','PLANNER_REQUIRED',{eligible:true,action:recovery.action||{tool:'planner',args:{}},owner:{kind:recovery.owner||'planner'}});
  return result('blocked',recovery.reason);
 }
 if(job.status==='finalizing')return result('finalizing','ACCEPTED_PENDING_CHECK',{reason:candidate.blockers[0]?.message||'已验收事项等待整体检查'});
 const failed=choices.find(c=>['blocked','guarded'].includes(c.phase));
 return result(blockers.length?blockers.some(r=>r.needsHuman)?'needs_input':'watching':failed||job.status==='blocked'?'blocked':job.status==='review'?'review':'watching',failed?.reasonCode||blockers[0]?.code||'NO_EXECUTABLE_ACTION',{reason:failed?.message||blockers[0]?.message||job.lastError||'当前条件下没有可执行动作'});
}
function project(a,job,event){
 if(!job)return;const p=event.payload;
 require('./operation-ledger.cjs').state(job);const applied=job.executionState.policyCommands ||= {};
 if(applied[event.commitId])return;
 if(p.command==='owner_select'){
  job.executionState.policyOwner={...structuredClone(p.proof.owner),commandId:event.commitId};
  if(p.proof.owner.kind==='continuation'){const s=job.executionState.continuation;if(!s?.episodes?.[p.proof.owner.basis]||s.episodes[p.proof.owner.basis].taskId!==p.taskId)throw Error('选中接续身份不存在');s.activeTaskId=p.taskId;s.activeBasis=p.proof.owner.basis;}
 }else if(p.command==='memory_reconcile'){
  if(job.memorySignature===p.proof.previous&&require('./memory.cjs').signature(a,job.projectId)===p.proof.current)require('./memory.cjs').reconcile(a,job);
 }else if(p.command==='external_attention'){
  const r=rows(a.data.agentActions).find(r=>r.id===p.proof.actionId);if(r&&!r.jobId&&r.taskId===p.taskId&&r.status===p.proof.status){job.pendingActionId=r.id;job.status='needs_input';job.summary='原外部动作的委托关联不完整，请先人工核对执行结果';}
 }else if(p.command==='evidence_consume'){
  const t=facts.tasks(a,job).find(t=>t.id===p.taskId);if(t)require('./evidence-consumption.cjs').applyPrepared(a,job,t,p.proof,event);
 }else if(p.command.startsWith('strategy_'))strategy.applyPrepared(a,job,p,event.at);
 else if(p.command.startsWith('continuation_'))continuation.applyPrepared(a,job,p,event.at);
 else if(p.command==='review_reopen'){
  const t=facts.tasks(a,job).find(t=>t.id===p.taskId);
  if(t?.status==='review'&&!t.acceptedAt&&t.verification?.basis===p.proof.basis){t.status='todo';t.verification=null;}
 }else throw Error('未知调度准备命令');
 applied[event.commitId]={command:p.command,proof:structuredClone(p.proof),at:event.at};
}
journal.registerProjector(TYPE,project);
function prepare(a,job,opts={}) {return require('./projection-cache.cjs').without(()=>prepareFresh(a,job,opts));}
function prepareFresh(a,job,opts={}) {
 const fixedTime=opts.now!==undefined;opts=options(a,opts);
 if(opts.expectedRevision!==undefined&&opts.expectedRevision!==(a.data.runtime?.revision||0))throw Object.assign(Error('资料已变化，请刷新后重试'),{code:'STATE_STALE'});
 let changed=false;const preparedCommands=[];
 // All commands are synchronous; there is no yield between guard, append and
 // projection. Execution.launch remains the final process-level exclusion.
 for(let n=0;n<8;n++){
  if(facts.conflict(a,job,opts))return {...inspect(a,job,opts),changed,preparedCommands};
  const g=facts.gate(a,job,null,{automatic:opts.mode!=='manual',now:opts.now});
  if(!g.automaticAllowed)return {...inspect(a,job,opts),changed,preparedCommands};
  const p=inspect(a,job,opts),command=p.commands[0];if(!command)return {...p,changed,preparedCommands};
  if(command.command==='pending_check'){if(!require('./pending-check.cjs').prepare(a,job))return {...p,changed,preparedCommands};}
  else if(command.command==='model_preflight_recovery'){
   const task=facts.tasks(a,job).find(t=>t.id===command.taskId);
   require('./model-preflight-recovery.cjs').prepare(a,job,task,command.proof);
  }
  else if(command.command==='evidence_preflight_reclassified_v1'){
   const task=facts.tasks(a,job).find(t=>t.id===command.taskId);
   require('./evidence-recovery.cjs').prepareLegacyPreflight(a,job,task,command.proof);
  }
  else if(command.command==='input_recovery'){if(!require('./input-recovery.cjs').restore(a,job))return {...inspect(a,job,opts),changed:true};}
  else if(command.command==='validation_finish'){
   const validation=require('./repair-validation.cjs'),task=facts.tasks(a,job).find(t=>t.id===command.taskId),episode=task&&continuation.episode(a,job,task);
   const proof=validation.unknownClaimProof(a,job,task,episode);
   if(!proof||hash(proof)!==hash(command.proof))return {...inspect(a,job,opts),changed,preparedCommands};
   // Reuse the grant's own durable failure event; no nested policy projection,
   // new generation claim, or job-wide failure that could block a sibling.
   validation.finish(a,job,'CLAIMED_RESULT_UNKNOWN');
  }
  else if(command.command==='accepted_archive')require('./acceptance.cjs').reconcileJobCompletion(a,job);
  else {
   const commitId=TYPE+':'+hash({jobId:job.id,revision:job.workRevision??1,...command});
   const event={type:TYPE,entityKind:'job',entityId:job.id,workRevision:job.workRevision??1,actor:'system',basisRefs:p.basisRefs,payload:command,at:new Date(opts.now).toISOString()};
   journal.commit(a,[event],{commitId,expectedRevision:a.data.runtime?.revision||0});
  }
  changed=true;preparedCommands.push(command.command);if(!fixedTime)opts.now=Date.now();
 }
 return {...inspect(a,job,opts),changed,preparedCommands};
}
function claim(a,job,opts={}) {return require('./projection-cache.cjs').without(()=>claimFresh(a,job,opts));}
function claimFresh(a,job,opts={}) {
 const p=inspect(a,job,opts);if(!p.eligible)throw Object.assign(Error(p.reason||'动作准入已变化'),{code:'POLICY_ADMISSION_CHANGED',policyAdmission:p});
 if(['reconcile_existing','execute_approved_existing','watch'].includes(p.mode))return {...p.action,policyMode:p.mode};
 const task=p.action?.tool==='complete'?null:facts.tasks(a,job).find(t=>t.id===p.taskIds[0]);
 require('./execution-gate.cjs').assert(a,{job,task,automatic:opts.mode!=='manual'});
 if(p.action?.tool==='planner')return null;
 if(p.owner?.kind==='continuation'){
  if(p.route==='evidence'){const action=continuation.next(a,job);if(!action)throw Object.assign(Error('证据候选已经变化'),{code:'POLICY_ADMISSION_CHANGED',policyAdmission:inspect(a,job,opts)});return action;}
  return {...p.action,controlled:true,continuation:true};
 }
 if(p.owner?.kind==='strategy')return strategy.next(a,job);
 return control.claim(a,job,p.action);
}
module.exports={TYPE,inspect,prepare,claim,project};
