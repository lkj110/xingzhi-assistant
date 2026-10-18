'use strict';
// Runtime ownership is never reconstructed from workspace fields or model args.
const {randomUUID}=require('node:crypto');
const {hash}=require('./evidence-basis.cjs');
const {commit}=require('./state-transitions.cjs');
const preparing=new WeakMap(),active=new WeakMap();
const now=()=>new Date().toISOString();
const stale=()=>Object.assign(Error('本次派发身份或输入已经变化，保留原记录并停止发送'),{code:'DISPATCH_STALE',gateClosed:true});
function prepared(a,step){return preparing.get(a)===step;}
function prepare(a,job,record,step,claim){
 const id=randomUUID();step.id=id;
 step.dispatch={id,runId:record.id,stepId:id,jobId:job.id,taskId:step.args?.taskId||step.args?.existingTaskId||null,tool:step.tool,argsHash:hash(step.args),requestSchema:2,requests:[],phase:'prepared',preparedAt:now()};
 commit(a,()=>{record.steps.push(step);preparing.set(a,step);try{claim();}finally{preparing.delete(a);}});
 const token={job,record,step,id,phase:'prepared',taskId:step.dispatch.taskId,argsHash:hash(step.args)};
 active.set(a,token);return token;
}
function current(a,job){
 const t=active.get(a);if(!t)return null;
 const {record,step}=t,d=step.dispatch;
 if(t.job!==job||a.activeAgentRun!==record||a.data.delegations?.find(j=>j.id===job.id)!==job||!record.steps.includes(step)||d.id!==t.id||d.taskId!==t.taskId||d.runId!==record.id||d.stepId!==step.id||d.jobId!==job.id||d.tool!==step.tool||d.argsHash!==t.argsHash||hash(step.args)!==t.argsHash)throw stale();
 return t;
}
function guard(a,job){
 const token=current(a,job);if(!token)return null;
 const task=a.data.tasks.find(t=>t.id===token.step.dispatch.taskId);
 require('./execution-gate.cjs').assert(a,{job,task});
 require('./spend.cjs').check(a);
 const claims=Object.values(job.executionState?.evidenceMethodAttempts||{}).filter(c=>c.dispatch?.id===token.step.dispatch.id);
 if(claims.length&&!require('./evidence-storage-method.cjs').currentClaims(a,job,task,claims).every(Boolean))throw stale();
 if(token.step.storageMethodResume){const episode=job.executionState?.continuation?.episodes?.[job.executionState.continuation.activeBasis],check=require('./storage-method-resume.cjs').currentDispatch(a,job,task,episode,token.step);if(!check.allowed)throw Object.assign(stale(),{code:check.reason});}
 return token;
}
function boundary(a,job,query,metadata={}){
 let t;try{t=guard(a,job);}catch(error){error.dispatchFailure=true;throw error;}if(!t)return null;
 const {step}=t;
 if(step.tool==='platform_query'){
  if(step.evidenceAcquisition&&query.op!=='identity'&&!step.args.queries.some(q=>require('./evidence-storage-method.cjs').sameQuery(q,metadata.parentQuery||query)))throw stale();
  require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[query]});
 }
 // Persist before entering any potentially external boundary, including identity.
 let request;
 try{commit(a,()=>{
  if(step.storageMethodResume){const task=a.data.tasks.find(t=>t.id===step.dispatch.taskId),episode=job.executionState.continuation.episodes[job.executionState.continuation.activeBasis];require('./storage-method-resume.cjs').markExternalInCommit(a,job,task,episode,step,query);}
  const d=step.dispatch;d.phase='dispatch_started';d.startedAt ||= now();
  request={requestId:metadata.requestId||randomUUID(),dispatchId:d.id,runId:d.runId,stepId:d.stepId,attemptId:metadata.attemptId||null,operationId:metadata.operationId||null,parentRequestId:metadata.parentRequestId||null,parentTarget:query.op==='identity'?'batch':null,parentQuery:metadata.parentQuery?structuredClone(metadata.parentQuery):null,query:structuredClone(query),at:now(),startedAt:now(),phase:'dispatch_started'};
  (d.requests ||= []).push(request);
  if(metadata.operation){(metadata.operation.requests ||= []).push(structuredClone(request));metadata.operation.status='running';metadata.operation.phase='dispatched';}
  if(metadata.attempt)Object.assign(metadata.attempt,{phase:'dispatched',operationId:metadata.operationId});
  for(const c of Object.values(job.executionState?.evidenceMethodAttempts||{}))if(c.dispatch?.id===d.id&&query.op!=='identity'&&require('./evidence-storage-method.cjs').sameQuery(c.query,query))Object.assign(c.dispatch,{phase:'dispatch_started',startedAt:now()});
 });t.phase='dispatch_started';return request;}catch(error){error.dispatchFailure=true;error.gateClosed=true;error.code ||= 'DISPATCH_PERSISTENCE_FAILED';throw error;}
}
function failed(a,job,error){
 // Diagnostics use the runtime-held identity; never re-admit a stale action or
 // throw a second error while recording the original failure.
 const t=active.get(a);if(!t||t.job!==job)return;
 const failure={dispatchId:t.id,runId:t.record.id,stepId:t.step.id,phase:t.phase,requestId:t.step.dispatch?.requests?.at(-1)?.requestId||null,code:error.code||null,stopped:error.name==='AbortError'||error.code==='ABORTED',message:error.message,at:now()};
 if(t.step.dispatch)t.step.dispatch.failure=failure;
 const live=a.data.agentRuns?.find(r=>r.id===t.record.id);
 if(live&&!live.steps?.includes(t.step))(live.dispatchFailures ||= []).push(failure);
}
function clear(a,job){if(active.get(a)?.job===job)active.delete(a);}
module.exports={prepared,prepare,guard,boundary,failed,clear,currentStep:(a,job)=>current(a,job)?.step||null};
