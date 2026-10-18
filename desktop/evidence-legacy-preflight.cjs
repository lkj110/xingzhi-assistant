'use strict';
const {hash}=require('./evidence-basis.cjs');
const {canonicalQuery}=require('./platform-boundaries.cjs');
const rows=v=>Array.isArray(v)?v:[];
const items=require('./evidence-item-lifecycle.cjs');
const EVENT='evidence_preflight_reclassified_v1';
const BASELINE=Object.freeze({
 'desktop/dispatch-lifecycle.cjs':'bf3fed5ca261fb7e593cb6c0b8e911aef7cc36bf34b351a47559f898dcca82fe',
 'desktop/operation-ledger.cjs':'07f89c4ca0d5f6f4b7ac7b66ed8e11d907b21b2f1869f3719d7cc81cadd8e85e',
 'desktop/agent.cjs':'7cafd23f4d843028a20c859cc1693ea2ce0a313a27063535edb45db5fc7482b5',
 'desktop/data-platform.cjs':'aa3fb8cdf4d7aa2db04649535c88efa02fe524aa4120d028771f64fb84302eee',
 'desktop/evidence-recovery.cjs':'08863dce3b1b5981534364d0f14906c21ac975c48374b1a5e2db5546f605c94b',
 'desktop/platform-result.cjs':'546af17cf3bef551fbac9526f63c5e6af9a6ca62280ee340c3569dc776248dd0'
});
const adapters=new WeakMap();
function registerBuiltInAdapter(a){adapters.set(a,BASELINE);return {version:'0.41.3',adapterHash:hash(BASELINE)};}
function baselineFor(a){return adapters.get(a);}
function verifyBaseline(manifest){return !!manifest&&Object.entries(BASELINE).every(([p,h])=>manifest[p]===h);}
const same=(a,b)=>!!a&&!!b&&hash(canonicalQuery(a))===hash(canonicalQuery(b));
function scope(job,task){return {jobId:job.id,taskId:task.id,principal:job.platformPrincipal||null,permissionRevision:job.executionState?.permissionRevision||0,projectId:job.projectId||null,scope:job.dataPlatform,intent:require('./continuation-control.cjs').intentBasis(job,task)};}
function relevantHistory(a,job,task,query){return {operations:items.operations(job).filter(o=>same(o.requestedQuery||o.query,query)),claims:Object.values(job.executionState?.evidenceMethodAttempts||{}).filter(c=>same(c.query,query)),results:rows(a.data.agentRuns).filter(r=>r.jobId===job.id).flatMap(r=>rows(r.steps).filter(s=>s.args?.taskId===task.id).flatMap(s=>rows(s.result?.results).filter(v=>same(v.query,query)).map(result=>({runId:r.id,stepId:s.id,at:s.at,result}))))};}
function buildProof(a,job,task,{runId,stepId,query,manifest=baselineFor(a)}={}){
 const rejected=reason=>({eligible:false,reason,runId,stepId,query:structuredClone(query)});
 if(!verifyBaseline(manifest))return rejected('SOURCE_ADAPTER_MISMATCH');
 const runs=rows(a.data.agentRuns).filter(r=>r.id===runId&&r.jobId===job.id);
 if(runs.length!==1)return rejected('RUN_MISSING_OR_AMBIGUOUS');
 const run=runs[0],steps=rows(run.steps).filter(s=>s.id===stepId);
 if(steps.length!==1)return rejected('STEP_MISSING_OR_AMBIGUOUS');
 const step=steps[0],d=step.dispatch,ac=step.evidenceAcquisition;
 if(!d||d.id!==step.id||d.stepId!==step.id||d.runId!==run.id||d.jobId!==job.id||d.taskId!==task.id||step.args?.taskId!==task.id||ac?.taskId!==task.id||step.tool!=='platform_query'||d.tool!==step.tool||d.argsHash!==hash(step.args))return rejected('DISPATCH_IDENTITY_MISMATCH');
 if(rows(a.data.agentRuns).flatMap(r=>rows(r.steps)).filter(s=>s.dispatch?.id===d.id).length!==1)return rejected('DISPATCH_AMBIGUOUS');
 if(!['done','failed','paused','interrupted'].includes(run.status)||!run.finishedAt)return rejected('RUN_NOT_TERMINAL');
 const requests=d.requests;
 if(!Array.isArray(requests)||requests.length!==1||requests[0]?.query?.op!=='identity')return rejected('IDENTITY_ONLY_BOUNDARY_UNPROVEN');
 const f=d.failure;
 if(!f||f.dispatchId!==d.id||f.runId!==run.id||f.stepId!==step.id||f.phase!=='dispatch_started'||f.requestId&&f.requestId!==requests[0].requestId)return rejected('FAILURE_REQUEST_MISMATCH');
 if(!['TRANSIENT','ABORTED'].includes(f.code)&&f.stopped!==true)return rejected('TYPED_PREFLIGHT_FAILURE_MISSING');
 if(f.message!==step.error||f.message!==run.error||f.code==='TRANSIENT'&&step.errorCode!=='TRANSIENT')return rejected('TERMINAL_ERROR_MISMATCH');
 const times=[run.startedAt,step.at,d.preparedAt,requests[0].at,f.at,run.finishedAt].map(Date.parse);
 if(times.some(v=>!Number.isFinite(v))||times.some((v,i)=>i&&v<times[i-1]))return rejected('TIME_ORDER_INVALID');
 const targets=rows(ac.targets),queries=rows(step.args.queries);
 if(!targets.length||targets.length!==queries.length||new Set(queries.map(q=>hash(canonicalQuery(q)))).size!==queries.length||targets.some(n=>queries.filter(q=>same(q,n.query)).length!==1))return rejected('TARGETS_NOT_BIJECTIVE');
 const target=targets.filter(n=>same(n.query,query));if(target.length!==1)return rejected('TARGET_MISSING_OR_AMBIGUOUS');
 const ep=job.executionState?.continuation?.episodes?.[ac.episodeBasis],k=require('./evidence-storage-method.cjs').attemptKey(target[0]),attempt=ep?.evidenceAcquisition?.attempts?.[k];
 const attemptTimes=[attempt?.at,attempt?.finishedAt].map(Date.parse);
 if(attemptTimes.some(v=>!Number.isFinite(v))||attemptTimes[1]<attemptTimes[0]||attemptTimes[0]<times[2]||attemptTimes[0]>times[3]||attemptTimes[1]<times[4]||attemptTimes[1]>times[5])return rejected('ORIGINAL_ATTEMPT_TIME_INVALID');
 if(ep?.taskId!==task.id||!ac.requestBasis||ep?.evidenceAcquisition?.requestBasis!==ac.requestBasis||!attempt||attempt.status!=='failed'||!same(attempt.query,query)||attempt.error!==step.error||attempt.sourceId||attempt.methodClaimKey)return rejected('ORIGINAL_ATTEMPT_MISMATCH');
 const h=relevantHistory(a,job,task,query);
 if(h.operations.length||h.results.length||h.claims.length)return rejected('CONTRADICTORY_OPERATION_RECEIPT_OR_CLAIM');
 // 0.41.3 did not persist scope in every dispatch. Never synthesize it from
 // today's account or a missing log. Such snapshots receive a precise rejection.
 if(!d.scopeHash||!d.policyHash)return rejected('HISTORICAL_SCOPE_POLICY_UNPROVEN');
 const binding=scope(job,task),check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[query]}),policy=hash({policyId:check.policyId,grantRevision:check.grantRevision});
 if(d.scopeHash!==hash(binding)||d.policyHash!==policy||ep.intentBasis!==binding.intent)return rejected('SCOPE_POLICY_CHANGED');
 const originalAttemptHash=hash(attempt),key=hash({version:1,jobId:job.id,taskId:task.id,dispatchId:d.id,stepId:step.id,canonicalTarget:canonicalQuery(query),originalAttemptHash});
 return {eligible:true,reason:'PROVEN_ZERO_BUSINESS_DISPATCH',key,version:1,runId,stepId,dispatchId:d.id,episodeBasis:ep.basis,attemptKey:k,originalAttemptHash,dispatchHash:hash(d),historyHash:hash(h),expectedOwner:task.agentJobId,scope:binding,policy,intent:ep.intentBasis,query:structuredClone(query),adapterHash:hash(BASELINE)};
}
function rowsForTask(a,job,task,options={}){return rows(a.data.agentRuns).filter(r=>r.jobId===job.id).flatMap(r=>rows(r.steps).filter(s=>s.evidenceAcquisition?.taskId===task.id&&s.error).flatMap(s=>rows(s.evidenceAcquisition.targets).map(n=>buildProof(a,job,task,{...options,runId:r.id,stepId:s.id,query:n.query}))));}
function corrected(job,attempt,task,a){return Object.values(job.executionState?.evidencePreflightCorrections||{}).some(p=>{
 if(p.originalAttemptHash!==hash(attempt)||p.expectedOwner!==job.id||task&&(p.scope.taskId!==task.id||hash(p.scope)!==hash(scope(job,task))))return false;
 if(a){const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[attempt.query]});return check.allowed&&p.policy===hash({policyId:check.policyId,grantRevision:check.grantRevision});}return true;
});}
function guard(a,job,task,proof){
 require('./execution-gate.cjs').assert(a,{job,task});require('./spend.cjs').check(a);
 require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[proof.query]});
 if(task.agentJobId!==proof.expectedOwner||hash(scope(job,task))!==hash(proof.scope))throw Object.assign(Error('迁移当前范围已变化'),{code:'STATE_STALE'});
}
function prepare(a,job,task,proof,{manifest=baselineFor(a)}={}){
 if(!proof?.eligible)throw Object.assign(Error('旧批次没有足够的未派发证明'),{code:'EVIDENCE_PREFLIGHT_UNPROVEN'});
 const journal=require('./work-journal.cjs'),commitId=EVENT+':'+proof.key;
 const existing=journal.read(a).events.find(e=>e.commitId===commitId);
 if(existing){if(!job.executionState?.evidencePreflightCorrections?.[proof.key])journal.replay(a);return {committed:true,reused:true,key:proof.key};}
 guard(a,job,task,proof);
 const fresh=buildProof(a,job,task,{...proof,manifest});
 if(!fresh.eligible||hash(fresh)!==hash(proof))throw Object.assign(Error('旧批次证明已变化'),{code:'STATE_STALE'});
 guard(a,job,task,fresh);
 return journal.commit(a,[{type:EVENT,entityKind:'job',entityId:job.id,actor:'system',workRevision:job.workRevision??1,payload:fresh}],{commitId,expectedEntities:[{kind:'job',id:job.id,workRevision:job.workRevision??1},{kind:'task',id:task.id,workRevision:task.workRevision??1}]});
}
require('./work-journal.cjs').registerProjector(EVENT,(a,job,event)=>{
 if(!job)return;
 const p=event.payload,task=a.data.tasks?.find(t=>t.id===p.scope.taskId);
 if(!task||task.agentJobId!==p.expectedOwner)return;
 const table=job.executionState.evidencePreflightCorrections ||= {};
 if(table[p.key]){if(hash(table[p.key].proof)!==hash(p))throw Object.assign(Error('旧纠正身份冲突'),{code:'WORK_JOURNAL_CONFLICT'});return;}
 table[p.key]={...structuredClone(p),proof:structuredClone(p),eventId:event.eventId};
});
function pendingCommands(a,job,task,options={}){
 const commands=[];
 for(const run of rows(a.data.agentRuns).filter(r=>r.jobId===job.id))for(const step of rows(run.steps)){
  const d=step.dispatch,f=d?.failure;
  // The normal policy scan can reject these rows without examining every
  // operation/receipt. Explicit audit still calls rowsForTask for each reason.
  if(step.evidenceAcquisition?.taskId!==task.id||!step.error||!d?.scopeHash||!d.policyHash||!f||!['TRANSIENT','ABORTED'].includes(f.code)&&f.stopped!==true)continue;
  for(const target of rows(step.evidenceAcquisition.targets)){
   const proof=buildProof(a,job,task,{...options,runId:run.id,stepId:step.id,query:target.query});
   if(proof.eligible&&!job.executionState?.evidencePreflightCorrections?.[proof.key])commands.push({command:EVENT,proof});
  }
 }
 return commands;
}
module.exports={registerBuiltInAdapter,baselineFor,pendingCommands,EVENT,BASELINE,verifyBaseline,scope,buildProof,rowsForTask,prepare,corrected};
