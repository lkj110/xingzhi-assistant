// A trusted UI command grants one explicitly authorized repair. Continuation
// owns dispatch and hop/cycle accounting; this module owns admission and facts.
const {randomUUID}=require('node:crypto');
const {hash}=require('./evidence-basis.cjs');
const journal=require('./work-journal.cjs');
const rows=v=>Array.isArray(v)?v:[];
const now=()=>new Date().toISOString();
const TYPE='repair_validation';
const IMPLEMENTATION_VERSION='repair-validation-1';
const UNKNOWN=new Set(['BUDGET_HISTORY_TRUNCATED','PRIOR_BUDGET_ATTRIBUTION_UNKNOWN']);
const fail=(code,message=code)=>Object.assign(Error(message),{code,automaticRetry:false});
const clone=v=>v==null?v:structuredClone(v);
const revision=t=>t?.workRevision??1;
const taskFor=(a,j,id)=>rows(a.data.tasks).find(t=>t.id===id&&t.agentJobId===j.id&&rows(j.taskIds).includes(t.id));
function active(job){const s=job?.executionState?.repairValidation;return s?.grants?.[s.activeGrantId]||null;}

// No Assistant, sources, runs, journal, ACL or preview access in publicState.
// Passing an already located task fills pre-grant UI fields without any scan.
function view(job,task){
 const g=active(job),old=job?.executionState?.workEfficiency;
 const taskId=g?.taskId||old?.lastFailure?.taskId||(job?.taskIds?.length===1?job.taskIds[0]:null);
 const selected=task?.id===taskId?task:null;
 return {candidate:!g&&old?.phase==='awaiting_change'&&old?.lastFailure?.code==='PLAN_ALREADY_RECONCILED',taskId,
  target:clone(g?.originalRepairTarget|| (selected?.primaryArtifactId?{artifactId:selected.primaryArtifactId}:null)),
  expectedWorkRevision:revision(job),expectedTaskRevision:selected?revision(selected):g?.expectedTaskRevision??null,
  grant:g?{grantId:g.grantId,grantIdentity:g.grantIdentity,outcome:g.outcome,claimedAttemptId:g.claimedAttemptId,
   knownFailures:g.knownFailures,handedOff:!!job.executionState?.continuation?.validationHandoffs?.[g.grantId]?.appliedAt,historyUnknown:true,repairAttemptLimit:1,prerequisiteHopLimit:4,reason:g.outcomeReason||null}:null};
}
function guard(a,job,task,{admission=false,allowReview=false}={}){
 if(!task||job.deletedAt||task.agentCancelled||task.deletedAt||task.acceptedAt||task.executionPaused||['completed','paused','waiting'].includes(task.status)||task.status==='review'&&!allowReview)throw fail('EXECUTION_GATE_CLOSED');
 require('./execution-gate.cjs').assert(a,{job,task,readOnly:true});
 const work=require('./work-state.cjs');
 if(a.readOnlyRecovery||!work.gate(a,job,task).automaticAllowed||work.blockingReasons(a,job,task).length)throw fail('EXECUTION_GATE_CLOSED');
 if(admission&&(a.activeAgentRun||work.inFlight(a,job)))throw fail('TRUSTED_UI_COMMAND_REQUIRED');
 if(require('./projects.cjs').relatedActions(a,job).some(r=>['pending','running','uncertain'].includes(r.status)||['unknown','uncertain'].includes(r.effectStatus)))throw fail('EXTERNAL_EFFECT_UNRESOLVED');
 if(a.spendError)throw fail('SPEND_STORAGE_ERROR');
 const scopes=a.spendLedger?.scopes||a.data.spendMeter?.scopes||{};
 for(const key of ['job:'+job.id,'task:'+task.id]){
  const s=scopes[key];if(!s)continue;
  if(s.blocked||require('./spend.cjs').unsettled(s)>0||s.spentUSD+s.heldUSD>=s.limitUSD)throw fail('SPEND_LIMIT');
 }
 require('./protocol-access.cjs').assertTool(a,job,'model',{taskId:task.id},{taskId:task.id});
 const ids=rows(task.sourceIds).filter(id=>!rows(task.supersededSourceIds).includes(id));
 // Local read authorization is distinct from typed platform proof. A retained
 // legacy snapshot may be readable without proving its original remote identity.
 // It remains ineligible for typed closure/new-fact credit in relation-obligations.
 const context=require('./task-context.cjs').buildContext(a,require('./task-context.cjs').taskScope(task),'repair-validation');
 const readable=new Set(context.readableCatalog.filter(r=>r.purpose==='input'&&!r.ambiguous).map(r=>r.id));
 if(ids.some(id=>!readable.has(id)))throw fail('CONTEXT_SCOPE_DENIED');
 // Durable withdrawal tombstones are checked on a detached read-only view.
 const blocked=require('./evidence-continuation.cjs').inspect(a,job,task).blocked;
 if(blocked)throw fail(blocked.code,blocked.message);
}
function permissionBasis(job){return hash({revision:job.executionState?.permissionRevision||0,folderIds:job.folderIds,outputFolder:job.outputFolder,fileMode:job.fileMode,documentGrants:job.documentGrants,larkCreateGrant:job.larkCreateGrant,platformPrincipal:job.platformPrincipal,capabilityGrants:job.capabilityGrants,githubRepo:job.githubRepo,githubMode:job.githubMode});}
function requirementBasis(job,task){return hash({contract:job.executionContract||job.goal,requirement:task.userRequirement,requirementRevision:task.requirementRevision,description:task.description,objective:task.objective,criteria:task.criteria});}
function inputBasis(a,task){return hash(require('./evidence-links.cjs').bindings(a,task).filter(b=>b.purpose==='input'&&b.state==='active').map(b=>({id:b.sourceId,revision:b.revisionId,hash:b.contentHash,principal:b.principalScope})).sort((x,y)=>x.id.localeCompare(y.id)));}
function deliveryPlan(task){return rows(task.steps).filter(s=>s.kind==='external').map(s=>({id:s.id,tool:s.tool,args:s.args||null,resourceKey:s.resourceKey||null}));}
function preview(a,job){
 const g=active(job),v=view(job),task=taskFor(a,job,v.taskId);
 const result={eligibility:false,taskId:v.taskId,originalMigrationId:g?.originalMigrationId||null,grantIdentity:g?.grantIdentity||null,target:clone(g?.originalRepairTarget||null),proof:null,reason:null};
 if(g)return {...result,reason:'GRANT_ALREADY_EXISTS'};
 try{
  guard(a,job,task,{admission:true});
  const m=require('./continuation-migration.cjs').inspect(a,job,task);
  result.originalMigrationId=m.migrationId;result.proof=m.proof;
  if(m.eligible||m.reason!=='LEGACY_HISTORY_INCOMPLETE'||m.cycles!==null||!m.migrationId||!m.proof.precondition?.attemptId||m.proof.precondition.code!=='PLAN_ALREADY_RECONCILED')throw fail('LEGACY_PROOF_NOT_ELIGIBLE');
  if(!Number.isSafeInteger(m.proof.knownCycles)||m.proof.knownCycles>=3)throw fail('KNOWN_FAILURES_EXHAUSTED');
  if(!m.proof.unknown.length||m.proof.unknown.some(u=>!UNKNOWN.has(u.code)))throw fail('UNKNOWN_REASON_NOT_ALLOWED');
  if(Object.values(job.executionState?.continuation?.episodes||{}).some(e=>e.taskId===task.id&&(e.cycles>=3||e.blocked&&!e.validationGrantId)))throw fail('CONTINUATION_EXHAUSTED');
  const artifact=require('./deliverables.cjs').primary(a,task),step=rows(task.steps).find(s=>!s.done);
  if(!artifact||!step||!['draft','analysis'].includes(step.kind)||artifact.stepId!==step.id||step.targetArtifactId&&step.targetArtifactId!==artifact.id)throw fail('ORIGINAL_REPAIR_TARGET_UNKNOWN');
  const target={artifactId:artifact.id,artifactHash:hash(artifact.content),stepId:step.id};
  const stableObligationRefs=[...new Set(require('./relation-obligations.cjs').required(a,job,task).map(r=>r.id))].sort();
  // A generic task requirement is still a stable obligation; draft/plan/version
  // changes never become a new grant identity.
  if(!stableObligationRefs.length)stableObligationRefs.push('task:'+task.id);
  result.target=target;result.stableObligationRefs=stableObligationRefs;
  result.grantIdentity=hash({originalMigrationId:m.migrationId,originalWaitRef:m.proof.episodeId,taskId:task.id,stableObligationRefs,originalRepairTarget:{artifactId:target.artifactId,stepId:target.stepId}});
  result.eligibility=true;return result;
 }catch(e){result.reason=e.code||'REPAIR_VALIDATION_GUARDED';return result;}
}
function event(job,kind,payload){return {entityKind:'job',entityId:job.id,type:TYPE,actor:kind==='grant'?'user':'system',workRevision:revision(job),payload:{kind,...payload}};}
function persist(a,job,kind,payload,options={}){return journal.commit(a,[event(job,kind,payload)],options);}
function authorize(a,job,input={}){
 if(!['user','supervisor'].includes(input.executedBy)||typeof input.authorizationNote!=='string'||!input.authorizationNote.trim()||input.authorizationNote.length>16000||!input.taskId||!input.artifactId||!Number.isSafeInteger(input.expectedWorkRevision)||!Number.isSafeInteger(input.expectedTaskRevision))throw fail('AUTHORIZATION_INPUT_REQUIRED');
 if(a.activeAgentRun||require('./work-state.cjs').inFlight(a,job))throw fail('TRUSTED_UI_COMMAND_REQUIRED');
 const commandId=input.commandId||randomUUID(),requestHash=hash({jobId:job.id,input:{...input,commandId:undefined}});
 const events=journal.read(a).events,prior=events.find(e=>e.type===TYPE&&e.payload.kind==='grant'&&e.payload.grant.commandId===commandId);
 if(prior&&(prior.entityId!==job.id||prior.payload.grant.requestHash!==requestHash))throw fail('WORK_JOURNAL_CONFLICT');
 const committed=prior||events.find(e=>e.type===TYPE&&e.entityId===job.id&&e.payload.kind==='grant');
 if(committed){
  if(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||(job.workEvent?.sequence||0)<committed.sequence)journal.replay(a);
  const existing=active(job);if(!existing||existing.grantId!==committed.payload.grant.grantId)throw fail('WORK_JOURNAL_CONFLICT');
  return clone(existing);
 }
 if(active(job))throw fail('WORK_JOURNAL_CONFLICT');
 const p=preview(a,job);if(!p.eligibility)throw fail(p.reason);
 const task=taskFor(a,job,p.taskId);
 if(input.taskId!==task.id||input.artifactId!==p.target.artifactId||input.expectedWorkRevision!==revision(job)||input.expectedTaskRevision!==revision(task))throw fail('STATE_STALE');
 const g={grantId:'repair-validation:'+p.grantIdentity,grantIdentity:p.grantIdentity,commandId,requestHash,jobId:job.id,taskId:task.id,
  originalMigrationId:p.originalMigrationId,originalWaitRef:p.proof.episodeId,stableObligationRefs:p.stableObligationRefs,originalRepairTarget:p.target,
  expectedWorkRevision:revision(job),expectedTaskRevision:revision(task),permissionBasis:permissionBasis(job),requirementBasis:requirementBasis(job,task),inputBasis:inputBasis(a,task),deliveryPlan:deliveryPlan(task),
  proof:clone(p.proof),proofHash:hash(p.proof),legacyWorkEfficiency:clone(job.executionState.workEfficiency),knownFailures:p.proof.knownCycles,unknownReasons:[...new Set(p.proof.unknown.map(u=>u.code))],
  authorizationRef:{note:input.authorizationNote.trim(),hash:hash(input.authorizationNote.trim())},authorizedBy:'user',executedBy:input.executedBy,implementationVersion:IMPLEMENTATION_VERSION,
  repairAttemptLimit:1,prerequisiteHopLimit:4,authorizedAt:now(),claimedAttemptId:null,outcome:null,committedCheckRef:null,goalCheckRef:null};
 persist(a,job,'grant',{grant:g},{commitId:g.grantId,expectedEntities:[{kind:'job',id:job.id,workRevision:input.expectedWorkRevision},{kind:'task',id:task.id,workRevision:input.expectedTaskRevision}]});
 return clone(active(job));
}
function generated(a,job,task,g){
 if(!g.claim)return null;
 const matches=rows(a.data.artifacts).filter(r=>r.taskId===task.id&&r.stepId===g.originalRepairTarget.stepId&&!g.claim.artifactIds.includes(r.id)&&r.origin!=='user_import'&&r.generationSnapshot?.id===g.claim.snapshot.id&&hash(r.generationSnapshot)===hash(g.claim.snapshot)&&Date.parse(r.createdAt)>=Date.parse(g.claim.at));
 if(matches.length!==1)return null;
 const artifact=require('./deliverables.cjs').primary(a,task),step=rows(task.steps).find(s=>s.id===g.originalRepairTarget.stepId);
 return artifact?.id===matches[0].id&&step?.done&&step.artifactId===artifact.id?artifact:null;
}
function allowedAction(a,job,step){
 const g=active(job);if(!g)return {allowed:false,reason:'NO_VALIDATION_GRANT'};
 const task=taskFor(a,job,g.taskId);
 try{
  if(job.executionState?.continuation?.validationHandoffs?.[g.grantId])throw fail('VALIDATION_HANDED_OFF');
  if(g.outcome==='failed')throw fail('VALIDATION_EXHAUSTED');
  const goal=step?.tool==='complete';
  guard(a,job,task,{allowReview:goal});
  if(!step?.args||Array.isArray(step.args)||(goal?Object.keys(step.args).length:step.args.taskId!==task.id||Object.keys(step.args).some(k=>!['taskId','artifactId','note'].includes(k))))throw fail('VALIDATION_ACTION_DENIED');
  if(revision(job)!==g.expectedWorkRevision||revision(task)!==g.expectedTaskRevision||requirementBasis(job,task)!==g.requirementBasis||permissionBasis(job)!==g.permissionBasis||inputBasis(a,task)!==g.inputBasis||hash(deliveryPlan(task))!==hash(g.deliveryPlan))throw fail('VALIDATION_BASIS_CHANGED');
  const next=rows(task.steps).find(s=>!s.done);
  if(!g.claimedAttemptId){
   const primary=require('./deliverables.cjs').primary(a,task),target=g.originalRepairTarget;
   if(primary?.id!==target.artifactId||hash(primary.content)!==target.artifactHash)throw fail('ORIGINAL_REPAIR_TARGET_CHANGED');
   if(step.tool==='revise_task'&&step.args.artifactId===target.artifactId)return {allowed:true,kind:'prerequisite',grantId:g.grantId};
   if(step.tool==='advance_task'&&next?.id===target.stepId&&['draft','analysis'].includes(next.kind))return {allowed:true,kind:'generation',grantId:g.grantId};
   throw fail('VALIDATION_ACTION_DENIED');
  }
  const artifact=generated(a,job,task,g);if(!artifact)throw fail('CLAIMED_RESULT_UNKNOWN');
  if(goal){
   const final=g.committedCheckRef,acceptance=require('./acceptance.cjs');
   if(task.status!=='review'||final?.phase!=='final'||!final.passed||final.artifactId!==artifact.id||final.artifactHash!==hash(artifact.content)||!task.verification?.passed||rows(task.verification.gaps).length||task.verification.basis!==acceptance.basis(a,task)||task.verification.snapshot?.id!==require('./revision-protocol.cjs').snapshot(a,task).id||acceptance.completionBlockers(a,job).length)throw fail('VALIDATION_FINAL_CHECK_REQUIRED');
   const basis=acceptance.completionBasis(a,job);
   if(g.goalCheckRef?.basis===basis)throw fail('VALIDATION_GOAL_ALREADY_CHECKED');
   return {allowed:true,kind:'goal_check',grantId:g.grantId,artifactId:artifact.id,basis};
  }
  if(step.args.artifactId&&step.args.artifactId!==artifact.id)throw fail('VALIDATION_ACTION_DENIED');
  if(step.tool==='verify_content'&&!g.committedCheckRef||step.tool==='advance_task'&&!next&&g.committedCheckRef?.phase!=='final')return {allowed:true,kind:'check',grantId:g.grantId,artifactId:artifact.id};
  const check=g.committedCheckRef;
  if(check?.passed&&check.artifactId===artifact.id&&check.artifactHash===hash(artifact.content)&&next?.kind==='external'&&next.tool===step.tool&&['write_file','lark_update','lark_create'].includes(step.tool))return {allowed:true,kind:'delivery',grantId:g.grantId,artifactId:artifact.id};
  throw fail('VALIDATION_ACTION_DENIED');
 }catch(e){return {allowed:false,reason:e.code||'REPAIR_VALIDATION_GUARDED',grantId:g.grantId};}
}
// A consumed legacy claim without its exact saved generation may only settle
// its original grant. Inspection never writes or awards another attempt.
function unknownClaimProof(a,job,task,episode){
 const g=active(job);
 if(!g||g.outcome!=null||!g.claimedAttemptId||g.claim?.attemptId!==g.claimedAttemptId||g.taskId!==task?.id||g.jobId!==job.id||!episode||episode.taskId!==task.id||episode.validationGrantId!==g.grantId||episode.basis!=='validation:'+g.grantIdentity||job.executionState?.continuation?.episodes?.[episode.basis]!==episode||job.executionState?.continuation?.validationHandoffs?.[g.grantId])return null;
 if(allowedAction(a,job,{tool:'advance_task',args:{taskId:task.id}}).reason!=='CLAIMED_RESULT_UNKNOWN')return null;
 return {taskId:task.id,grantId:g.grantId,grantIdentity:g.grantIdentity,claimedAttemptId:g.claimedAttemptId,episodeBasis:episode.basis,workRevision:revision(job),taskRevision:revision(task)};
}
function before(a,job,step){
 const decision=allowedAction(a,job,step);if(!decision.allowed)throw fail(decision.reason);
 const g=active(job),task=taskFor(a,job,g.taskId);
 if(decision.kind==='generation'){
  const claim={attemptId:randomUUID(),at:now(),snapshot:require('./revision-protocol.cjs').snapshot(a,task),artifactIds:rows(a.data.artifacts).filter(r=>r.taskId===task.id).map(r=>r.id)};
  persist(a,job,'claim',{grantId:g.grantId,claim},{commitId:g.grantId+':claim'});
 }
 step.repairValidation={grantId:g.grantId,attemptId:active(job).claimedAttemptId,kind:decision.kind};
 return {...decision,attemptId:active(job).claimedAttemptId};
}
function finish(a,job,reason='VALIDATION_EXHAUSTED'){
 const g=active(job);if(!g||g.outcome==='failed')return clone(g);
 persist(a,job,'failed',{grantId:g.grantId,reason,at:now()},{commitId:g.grantId+':failed'});return clone(active(job));
}
function after(a,job,step){
 const g=active(job);if(!g||step.repairValidation?.grantId!==g.grantId)return null;
 if(g.outcome==='failed')return clone(g);
 // Delivery has its own durable action/effect authority. A lost write response
 // must keep the passed repair fact so that the ORIGINAL action can reconcile
 // read-only and proceed to final verification, without another repair/write.
 if(step.repairValidation.kind==='delivery')return clone(g);
 if(step.error||step.errorCode||step.result?.error)return finish(a,job,step.errorCode||'VALIDATION_EXECUTION_FAILED');
 if(step.repairValidation.kind==='generation'&&!generated(a,job,taskFor(a,job,g.taskId),g))return finish(a,job,'CLAIMED_RESULT_UNKNOWN');
 return clone(g);
}
// Must run inside the caller's SAME save/commit as the content/final check.
// It performs no save, increments no cycle counter, and never changes old history.
function noteCheck(a,job,task,check,{phase='content'}={}){
 if(phase==='result')phase='final';
 const g=active(job);if(!g||job.executionState?.continuation?.validationHandoffs?.[g.grantId]||g.taskId!==task.id||!g.claimedAttemptId||g.outcome==='failed')return false;
 const artifact=generated(a,job,task,g);
 if(!['content','final'].includes(phase)||!artifact||typeof check?.passed!=='boolean'||check.snapshot?.id!==require('./revision-protocol.cjs').snapshot(a,task).id||!check.snapshot?.artifacts?.some(r=>r.artifactId===artifact.id&&r.hash===hash(artifact.content)))return false;
 const ref={phase,basis:check.basis||check.snapshot.id,at:check.at||now(),artifactId:artifact.id,artifactHash:hash(artifact.content),passed:check.passed};
 g.committedCheckRef=ref;g.outcome=check.passed?'passed':'failed';g.outcomeReason=check.passed?null:'VALIDATION_CHECK_FAILED';
 return true;
}
// The completion_checked journal projector calls this in the same projection.
// Its input is a trusted persisted check, never model/planner authorization.
function noteGoalCheck(a,job,check,{basis=check?.basis}={}){
 const g=active(job);if(!g||!g.claimedAttemptId||g.outcome==='failed'||typeof check?.passed!=='boolean'||typeof basis!=='string'||!basis||g.goalCheckRef?.basis===basis)return false;
 // Ignore an older completion event when replaying a log containing a later
 // grant. Version and task refs also prevent a new user batch rewriting it.
 if(check.workRevision!==g.expectedWorkRevision||!(Date.parse(check.at)>=Date.parse(g.claim.at))||!rows(check.taskVerificationRefs).some(r=>r.taskId===g.taskId&&r.workRevision===g.expectedTaskRevision))return false;
 const passed=check.passed&&!rows(check.gaps).length;
 g.goalCheckRef={basis,passed,at:check.at,summary:check.summary||'',gaps:clone(rows(check.gaps))};
 g.outcome=passed?'passed':'failed';g.outcomeReason=passed?null:'VALIDATION_GOAL_CHECK_FAILED';
 return true;
}
journal.registerProjector(TYPE,(a,job,event)=>{
 if(!job)return;
 job.executionState ||= {};
 const s=job.executionState.repairValidation ||= {version:1,grants:{},activeGrantId:null},p=event.payload;
 if(p.kind==='grant'){
  if(s.activeGrantId&&s.activeGrantId!==p.grant.grantId)throw fail('WORK_JOURNAL_CONFLICT');
  s.grants[p.grant.grantId] ||= clone(p.grant);s.activeGrantId=p.grant.grantId;
  // Lazy reciprocal require: the grant must be visible before takeover reads
  // it. The helper is a synchronous, idempotent projection and never saves.
  require('./continuation-control.cjs').takeoverValidation(a,job,s.grants[p.grant.grantId]);return;
 }
 const g=s.grants[p.grantId];if(!g)throw fail('WORK_JOURNAL_CONFLICT');
 if(p.kind==='claim'){
  if(g.claimedAttemptId&&g.claimedAttemptId!==p.claim.attemptId)throw fail('WORK_JOURNAL_CONFLICT');
  g.claimedAttemptId=p.claim.attemptId;g.claim ||= clone(p.claim);
 }else if(p.kind==='failed'){g.outcome='failed';g.outcomeReason=p.reason;g.finishedAt=p.at;}
 else throw fail('WORK_JOURNAL_CONFLICT');
});
module.exports={TYPE,IMPLEMENTATION_VERSION,preview,authorize,active,view,allowedAction,unknownClaimProof,before,after,noteCheck,noteGoalCheck,finish};
