'use strict';
// Read-only proof for one repaired storage path. No transport, claims, migration,
// retry policy or generation accounting lives here. Caller names grant nothing.
const {hash,taskSources}=require('./evidence-basis.cjs');
const boundaries=require('./platform-boundaries.cjs');
const METHOD='coral-structural-v1';
const LEGACY_SIZE_ERROR='结果超过材料上限，请减小查询深度或分页读取';
const rows=v=>Array.isArray(v)?v:[];
const canonical=q=>boundaries.canonicalQuery(q);
const sameQuery=(x,y)=>!!x&&!!y&&hash(canonical(x))===hash(canonical(y));
const time=v=>Date.parse(v);
const fail=reason=>({eligible:false,reason});
const attemptKey=n=>hash({obligationId:n.obligationId,rootIds:[...rows(n.rootIds)].sort(),direction:n.direction||null,query:canonical(n.query)});
function sameTarget(x,y){return x?.obligationId===y?.obligationId&&x?.direction===y?.direction&&hash(x?.identity)===hash(y?.identity)&&sameQuery(x?.query,y?.query)&&rows(x?.rootIds).some(r=>rows(y?.rootIds).includes(r));}
function scope(job){return {jobId:job.id,projectId:job.projectId||null,scope:job.dataPlatform,principal:job.platformPrincipal||null};}
function sameScope(job,op){return op&&hash(op.principal)===hash(job.platformPrincipal)&&op.scope===job.dataPlatform&&op.projectId===(job.projectId||null)&&(op.permissionRevision??0)===(job.executionState?.permissionRevision||0);}
function consumed(job,query){return Object.values(job.executionState?.evidenceMethodAttempts||{}).find(c=>[METHOD,'platform-chunks-v2'].includes(c.method)&&hash(c.scope)===hash(scope(job))&&sameQuery(c.query,query));}
function ownerAllowed(a,job,task){
 return !!job.executionState&&!!job.platformPrincipal&&job.dataPlatform==='sg-readonly'&&a.data.delegations?.find(j=>j.id===job.id)===job&&a.data.tasks?.find(t=>t.id===task.id)===task&&task.agentJobId===job.id&&rows(job.taskIds).includes(task.id)&&require('./continuation-control.cjs').allowed(a,job,task);
}
function checkQuery(a,job,query){
 const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[query]});
 return check?.allowed?check:null;
}
function permitted(a,job,task,query){return ownerAllowed(a,job,task)?checkQuery(a,job,query):null;}
const policyProof=check=>hash({policyId:check.policyId,grantRevision:check.grantRevision});
function context(a,job,task,check){
 return hash({scope:scope(job),permissionRevision:job.executionState?.permissionRevision||0,policy:policyProof(check),workRevision:job.workRevision??1,taskWorkRevision:task.workRevision??1,owner:task.agentJobId,
  intent:require('./requirements.cjs').intent(job,task),intentBasis:require('./continuation-control.cjs').intentBasis(job,task),sources:taskSources(a,task)});
}
// A projection is local to this synchronous call. Never retain it across a
// commit/await, and never accept a caller-provided set of supposedly typed gaps.
function currentNeeds(a,job,task){
 const relation=require('./relation-obligations.cjs'),needs=structuredClone(relation.evidenceNeeds(a,job,task));
 const physical=relation.physicalContext(a,job,task);
 for(const gap of physical.frontier||[]){
  const output=gap.reason==='root_output_mapping_missing'&&gap.queryBlockedReason==='observed_outputs_failure';
  if(gap.status==='accepted_boundary'||!output&&(gap.status!=='failed'||gap.reason!=='missing_own_center'))continue;
  const operation=output?require('./evidence-item-lifecycle.cjs').operations(job).find(o=>o.id===gap.attempt?.operationId):null;
  const query=output?(operation?.requestedQuery||operation?.query):gap.attempt?.query;
  if(!query||output&&(query.op!=='outputs'||String(query.taskId)!==String(gap.rootId)))continue;
  const need={obligationId:physical.obligationId,kind:'physical_lineage',rootIds:[gap.rootId],direction:output?null:gap.direction,identity:output?null:gap.identity,reason:gap.reason,query,proofSourceIds:gap.proofSourceIds};
  const prior=needs.find(n=>n.obligationId===need.obligationId&&n.direction===need.direction&&sameQuery(n.query,need.query));
  if(prior){prior.rootIds=[...new Set([...prior.rootIds,...need.rootIds])];prior.proofSourceIds=[...new Set([...prior.proofSourceIds,...need.proofSourceIds])];}else needs.push(need);
 }
 return needs;
}
function projection(a,job,task){
 const needs=currentNeeds(a,job,task);
 return {needs,allowed:ownerAllowed(a,job,task),intent:require('./continuation-control.cjs').intentBasis(job,task),
  operations:Object.values(job.executionState?.operations||{}),history:rows(job.executionState?.history),
  steps:rows(a.data.agentRuns).filter(r=>r.jobId===job.id).flatMap(run=>rows(run.steps).map((step,stepIndex)=>({run,step,stepIndex}))),
  migration:boundaries.planMigration(job,{sources:[],isOperationCurrent:boundaries.currentOperation})};
}
function evaluateLegacy(a,job,task,episode,need,view){
 const q=need?.query,cq=q&&canonical(q);
 if(!q||cq.op!=='table_lineage'||cq.entityType!=='HiveTable'||cq.region!=='sg'||need.kind!=='physical_lineage'||need.reason!=='missing_own_center')return fail('UNSUPPORTED_STORAGE_METHOD');
 if(consumed(job,q))return fail('EVIDENCE_METHOD_ALREADY_CLAIMED');
 const check=view.allowed&&checkQuery(a,job,q);if(!check)return fail('EVIDENCE_METHOD_GUARDED');
 if(!view.needs.some(n=>sameTarget(n,need)&&rows(need.rootIds).every(r=>n.rootIds.includes(r))))return fail('CURRENT_TYPED_GAP_MISSING');
 const intent=view.intent;
 if(episode?.taskId!==task.id||episode.intentBasis!==intent)return fail('REQUIREMENT_CHANGED');
 const attempts=Object.entries(episode.evidenceAcquisition?.attempts||{}).filter(([,v])=>sameQuery(v.query,q)&&v.obligationId===need.obligationId&&rows(v.rootIds).some(r=>need.rootIds.includes(r)));
 // A new method's failure can never become another legacy failure.
 if(attempts.some(([,v])=>v.method||v.methodClaimKey||v.previousAttempt||v.status!=='failed'||v.error!==LEGACY_SIZE_ERROR||v.errorCode!=='EVIDENCE_RESULT_UNAVAILABLE'))return fail('NOT_LEGACY_SIZE_FAILURE');
 if(!attempts.length)return fail('LEGACY_ATTEMPT_MISSING');
 const ledger=require('./operation-ledger.cjs'),ops=view.operations.filter(o=>sameScope(job,o)&&sameQuery(o.actualQuery||o.query,q));
 if(ops.length!==1)return fail('OPERATION_AMBIGUOUS');
 const op=ops[0];
 const legacyKey=hash({...scope(job),request:require('./data-platform.cjs').command(q)});
 if(!op.id||op.status!=='interrupted'||op.error||op.errorCode||op.sourceId||!sameQuery(op.query,q)||!sameQuery(op.requestedQuery,q)||!sameQuery(op.actualQuery,q)||![ledger.key(job,q),legacyKey].includes(op.key)||job.executionState.operations[op.key]!==op||!ledger.valid(job,op,a)||op.policy!==policyProof(check))return fail('ORIGINAL_INTERRUPTED_OPERATION_MISSING');
 if([...view.history,...ops].some(o=>o.id!==op.id&&sameScope(job,o)&&sameQuery(o.actualQuery||o.query,q)&&(!Number.isFinite(time(o.startedAt))||time(o.startedAt)>=time(op.startedAt))))return fail('LATER_OPERATION_EXISTS');
 if(boundaries.inspect(job,q,{sources:[],isOperationCurrent:boundaries.currentOperation,migration:view.migration,records:view.migration.records}).status==='accepted_boundary')return fail('ACCEPTED_BOUNDARY');
 const proofs=[];
 for(const [key,attempt] of attempts){
  if(!(time(attempt.at)<=time(op.startedAt)&&time(op.startedAt)<=time(attempt.finishedAt)))continue;
  for(const {run,step,stepIndex} of view.steps){
   if(!run.id||run.status!=='done')continue;
   const acquisition=step.evidenceAcquisition,old=job.executionState.continuation?.episodes?.[acquisition?.episodeBasis];
   if(step.tool!=='platform_query'||step.error||step.errorCode||step.args?.taskId!==task.id||step.args?.retry===true||acquisition?.taskId!==task.id||!acquisition.requestBasis||old?.taskId!==task.id||old.intentBasis!==intent||hash(old.evidenceAcquisition?.attempts?.[key])!==hash(attempt))continue;
   if(!(time(run.startedAt)<=time(step.at)&&time(step.at)<=time(attempt.at)&&time(attempt.finishedAt)<=time(run.finishedAt)))continue;
   const targets=rows(acquisition.targets).filter(n=>attemptKey(n)===key&&sameTarget(n,need));
   const results=rows(step.result?.results).filter(r=>sameQuery(r.query,q));
   if(targets.length!==1||rows(step.args.queries).filter(x=>sameQuery(x,q)).length!==1||results.length!==1)continue;
   const result=results[0];
   if(result.error!==LEGACY_SIZE_ERROR||result.errorCode||result.sourceId||result.reused||result.receipt||result.operationId&&result.operationId!==op.id)continue;
   proofs.push({attemptKey:key,previousAttempt:structuredClone(attempt),operation:structuredClone(op),runId:run.id,stepIndex,stepAt:step.at,episodeBasis:old.basis,requestBasis:acquisition.requestBasis,target:structuredClone(targets[0]),result:structuredClone(result)});
  }
 }
 if(proofs.length!==1)return fail('LEGACY_RUN_PROOF_MISSING_OR_AMBIGUOUS');
 const proof=proofs[0];
 // Later real results outrank the old exception even when a stale ledger slot
 // still contains the interrupted operation. Prompt/error prose is never proof.
 if(view.steps.some(({step:s})=>s.tool==='platform_query'&&time(s.at)>time(proof.previousAttempt.finishedAt)&&rows(s.result?.results).some(v=>sameQuery(v.query,q))))return fail('LATER_QUERY_RESULT_EXISTS');
 const claimKey=hash({...scope(job),operationId:op.id,query:cq,method:METHOD});
 return {eligible:true,reason:'REPAIRED_STORAGE_METHOD',method:METHOD,familyKey:require('./evidence-storage-family.cjs').familyKey(job,op),originOperationId:op.id,claimKey,proof};
}
function evaluate(a,job,task,episode,need,view){
 const next=require('./evidence-storage-family.cjs').evaluate(a,job,task,episode,need,view);
 if(next.eligible||['STORAGE_FAMILY_UNRESOLVED','STORAGE_FAMILY_METHOD_CONSUMED','LATER_FAMILY_OPERATION_EXISTS','LOCAL_REPROCESS_REQUIRED','LOCAL_RESULT_INTEGRITY','COMPLETE_SOURCE_REUSABLE'].includes(next.reason))return next;
 const old=evaluateLegacy(a,job,task,episode,need,view);return old.eligible?old:next;
}
function eligibility(a,job,task,episode,need){return require('./projection-cache.cjs').scope(()=>evaluate(a,job,task,episode,need,projection(a,job,task)));}
function project(a,job,task,episode){return require('./projection-cache.cjs').scope(()=>{const view=projection(a,job,task);return view.needs.map(need=>({need,...evaluate(a,job,task,episode,need,view)}));});}
// This validates the original request and inputs, not whether the fetched
// center is still missing: a successful response may itself close that gap.
function currentClaims(a,job,task,claims){
 const allowed=ownerAllowed(a,job,task),contexts=new Map(),requestHash=hash(task.evidenceRequest);
 return claims.map(claim=>{
  const check=allowed&&claim&&checkQuery(a,job,claim.query);
  if(!check)return false;
  const policy=policyProof(check);if(!contexts.has(policy))contexts.set(policy,context(a,job,task,check));
  return [METHOD,'platform-chunks-v2'].includes(claim.method)&&claim.taskId===task.id&&claim.requestBasis===task.evidenceRequest?.basis&&claim.context===contexts.get(policy)&&hash(claim.request)===requestHash&&sameQuery(claim.query,claim.proof?.previousAttempt?.query);
 });
}
function currentClaim(a,job,task,claim){return currentClaims(a,job,task,[claim])[0];}
module.exports={currentNeeds,METHOD,V2_METHOD:'platform-chunks-v2',familyKey:(job,operation)=>require('./evidence-storage-family.cjs').familyKey(job,operation),localSnapshot:operation=>require('./evidence-storage-family.cjs').localSnapshot(operation),LEGACY_SIZE_ERROR,eligibility,project,consumed,scope,context,currentClaim,currentClaims,permitted,sameQuery,attemptKey};
