const evidence=require('./evidence-basis.cjs');
const platform=require('./data-platform.cjs');
const boundaries=require('./platform-boundaries.cjs');
const items=require('./evidence-item-lifecycle.cjs');
const commit=(a,fn)=>require('./state-transitions.cjs').commit(a,fn);
const now=()=>new Date().toISOString();
const freshMs=15*60000;
const processes=new WeakMap();
function unverifiedScope(a){if(!processes.has(a))processes.set(a,require('node:crypto').randomUUID());return processes.get(a)+':'+(a.activeAgentRun?.id||'direct');}
function state(job){return job.executionState ||= {version:2,permissionRevision:0,operations:{},requirements:[],gaps:[],reads:{},recoveries:{},events:[]};}
function epoch(job){return evidence.hash({goal:job.executionContract?.revision||job.goal,feedback:evidence.feedback(job.feedback),permissionRevision:job.executionState?.permissionRevision||0});}
function key(job,query){return evidence.hash({jobId:job.id,projectId:job.projectId||null,scope:job.dataPlatform,principal:job.platformPrincipal||null,request:boundaries.canonicalQuery(query)});}
function legacyKey(job,query){try{return evidence.hash({jobId:job.id,projectId:job.projectId||null,scope:job.dataPlatform,principal:job.platformPrincipal||null,request:platform.command(query)});}catch{return null;}}
function classify(error){
 if(['ENOSPC','EDQUOT','EIO','EROFS'].includes(error.code))return 'LOCAL_RESULT_STORAGE';
 if(['LOCAL_RESULT_STORAGE','LOCAL_RESULT_INTEGRITY','STORAGE_ERROR','AUTH_REQUIRED','TRANSIENT','INVALID_PLATFORM_RESPONSE','INVALID_ARGUMENT','NOT_FOUND','UNSUPPORTED_ENTITY','UNSUPPORTED_CAPABILITY','SCOPE_UNRESOLVED'].includes(error.code))return error.code;
 const code=Number(error.providerCode||error.status||error.statusCode||error.code);
 if(code===429||code>=500&&code<=599)return 'TRANSIENT';
 if(code===401||code===403)return 'AUTH_REQUIRED';
 if(error.connectorCode==='permission'||/没有.*读取权限|没有.*访问权限|权限不足|无访问权限|无权限|无权|permission denied|access denied/i.test(error.message))return 'AUTH_REQUIRED';
 if(['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN'].includes(error.code))return 'TRANSIENT';
 if(/未返回成功的结构化结果/.test(error.message))return 'INVALID_PLATFORM_RESPONSE';
 if(code===404)return 'NOT_FOUND';
 if(code===400||/参数|argument|invalid input/i.test(error.message))return 'INVALID_ARGUMENT';
 return 'INVALID_PLATFORM_RESPONSE';
}
const permissionFailure=operation=>operation?.status==='failed'&&operation.errorCode==='AUTH_REQUIRED';
const stableFailure=operation=>operation?.status==='failed'&&operation.errorCode!=='TRANSIENT';
// A typed denial or missing-resource response is a negative fact, not a
// successful evidence cache or an acceptance decision. Business feedback/work
// revisions cannot change it. All failures match exact query parameters;
// accepting a direction is a separate, explicitly evidenced user decision.
// V2 records omitted permissionRevision: only revision zero is provable there.
function valid(job,operation,a){
 if(!operation||evidence.hash(operation.principal||null)!==evidence.hash(job.platformPrincipal||null)||(operation.scope!==undefined&&operation.scope!==job.dataPlatform)||(operation.projectId!==undefined&&operation.projectId!==(job.projectId||null)))return false;
 if(stableFailure(operation)){
  if((operation.permissionRevision??0)!==(state(job).permissionRevision||0))return false;
  if(operation.scope===undefined&&job.dataPlatform!=='sg-readonly')return false;
  if(operation.scope===undefined&&operation.key&&![key(job,operation.query),legacyKey(job,operation.query)].includes(operation.key))return false;
  if(a?.dir&&job.platformPrincipal){const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[operation.query]});if(!check.allowed||(operation.policy?policyProof(check)!==operation.policy:check.grantRevision!==1))return false;}
  return true;
 }
 return (!operation.epoch?state(job).permissionRevision===0:operation.epoch===epoch(job))&&(operation.workRevision===undefined||operation.workRevision===(job.workRevision??1));
}
const sameRequest=(a,b)=>evidence.hash(boundaries.canonicalQuery(a))===evidence.hash(boundaries.canonicalQuery(b));
const unsettledStatuses=new Set(['prepared','running','interrupted','unknown','receipt']);
function unsettledForQuery(job,query){
 const s=job.executionState,records=[...Object.values(s?.operations||{}),...(Array.isArray(s?.history)?s.history:[])];
 const scopedKeys=[key(job,query),legacyKey(job,query)].filter(Boolean);
 return [...new Map(records.filter(o=>{
  if(!o||!unsettledStatuses.has(o.status))return false;
  // The persisted key already binds this account/project/scope/query. Missing
  // or contradictory old metadata cannot prove that its dispatch is unrelated.
  if(scopedKeys.includes(o.key))return true;
  if(evidence.hash(o.principal||null)!==evidence.hash(job.platformPrincipal||null))return false;
  if(o.scope!==undefined&&o.scope!==job.dataPlatform||o.projectId!==undefined&&o.projectId!==(job.projectId||null))return false;
  const queries=[o.requestedQuery,o.query,o.actualQuery].filter(Boolean);
  if(!queries.some(q=>sameRequest(q,query)))return false;
  return o.scope!==undefined&&o.projectId!==undefined||queries.some(q=>[key(job,q),legacyKey(job,q)].includes(o.key));
 }).map(o=>[evidence.hash(o),o])).values()];
}
function eligibility(job,operation,time=Date.now()){
 if(operation&&['running','prepared','interrupted','unknown','receipt'].includes(operation.status))return {action:'reconcile',reason:'OPERATION_RESULT_UNKNOWN'};
 if(!valid(job,operation))return {action:'execute',reason:'scope_changed'};
 if(operation.status==='failed'){
  if(operation.errorCode==='AUTH_REQUIRED')return {action:'request_access',reason:operation.error};
  if(['INVALID_ARGUMENT','NOT_FOUND'].includes(operation.errorCode))return {action:'repair_input',reason:operation.error};
  if(operation.errorCode!=='TRANSIENT')return {action:'diagnose',reason:operation.error};
  const count=operation.logicalKey?items.transientCount(job,operation.logicalKey):Math.max(operation.attempt||1,items.operations(job).filter(o=>o.errorCode==='TRANSIENT'&&sameRequest(o.query,operation.query)).length);
  const decision=items.retryDecision(count,operation.completedAt,time);
  if(count<3&&Number.isFinite(Date.parse(operation.retryAt)))return Date.parse(operation.retryAt)>time?{action:'wait_until',reason:'TRANSIENT_BACKOFF',retryAt:operation.retryAt}:{action:'execute',reason:'retry_due'};
  return decision;
 }
 return {action:operation.status==='done'&&time-Date.parse(operation.completedAt)<freshMs?'reuse':'execute'};
}
function activeFailure(job,query,a){
 const operation=Object.values(state(job).operations).reverse().filter(o=>o.query&&sameRequest(o.actualQuery||o.query,query)&&valid(job,o,a)).sort((x,y)=>(Date.parse(y.startedAt||y.completedAt)||0)-(Date.parse(x.startedAt||x.completedAt)||0))[0];
 return operation?.status==='failed'&&eligibility(job,operation).action!=='execute'?operation:null;
}
function lookup(a,job,query){
 let operation=state(job).operations[key(job,query)];
 if(!operation||!valid(job,operation,a)){
  const old=state(job).operations[legacyKey(job,query)];
  if(old?.query&&sameRequest(old.actualQuery||old.query,query)&&valid(job,old,a))operation=old;
  else {const failure=activeFailure(job,query,a);operation=stableFailure(failure)?failure:null;}
 }
 if(!operation||!valid(job,operation,a)||!stableFailure(operation)&&operation.epoch!==epoch(job)||!job.platformPrincipal&&operation.unverifiedScope!==unverifiedScope(a))return null;
 if(operation.status==='done'){
  try{
   const checked=require('./platform-operation-proof.cjs').source(a,job,operation);
   if(!checked)return null;
   // Expiration permits a refresh of intact evidence, never a silent repair.
   if(Date.now()-Date.parse(operation.completedAt)>=freshMs)return null;
   return {snapshot:checked.snapshot,operation,reused:true,storageValidation:checked.validation,...(checked.compatibility?{compatibility:checked.compatibility}:{})};
  }catch(cause){throw Object.assign(Error('缓存来源完整性校验失败'),{code:'LOCAL_RESULT_INTEGRITY',stopBatch:true,cause});}
 }
 if(operation.status==='failed'&&eligibility(job,operation).action!=='execute')return failureResult(operation,query,true);
 return null;
}
const batches=new WeakSet();
const boundary=job=>evidence.hash({id:job.id,projectId:job.projectId||null,scope:job.dataPlatform,principal:job.platformPrincipal||null,epoch:epoch(job),workRevision:job.workRevision??1});
const stale=()=>Object.assign(Error('查询期间账号、权限或执行范围已变化；旧结果保留为历史，不作为当前证据'),{code:'OPERATION_STALE'});
function policyProof(result){return evidence.hash({policyId:result?.policyId,grantRevision:result?.grantRevision});}
function boundaryOptions(a,job){
 const sources=(a.data.sources||[]).filter(s=>(job.sourceIds||[]).includes(s.id)&&!s.deleted&&!s.projectExcluded&&require('./protocol-access.cjs').allowedObject(a,'source',s,job));
 const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[{op:'projects'}]});
 const policy=policyProof(check),isOperationCurrent=(_job,o)=>valid(job,o,a);
 const migration=boundaries.planMigration(job,{sources,isOperationCurrent});
 const records=migration.records.filter(b=>check.allowed&&(b.policy?b.policy===policy:check.grantRevision===1));
 return {sources,records,policy,isOperationCurrent,migration};
}
// Normal startup/commit integration may call this too. No production files are
// opened here; persistence uses the caller's existing save boundary.
function migrateBoundaries(a,job){
 const options=boundaryOptions(a,job),migration=boundaries.planMigration(job,options);
 if(migration.changed){state(job).acceptedBoundaries=migration.records;a.save();}
 return migration;
}
const summaries={AUTH_REQUIRED:'当前账号没有该资源或项目的读取权限。',NOT_FOUND:'平台明确返回资源不存在；不能据此断言资源已删除或没有上下游。',TRANSIENT:'平台暂时不可用，将按明确的瞬时错误退避。',INVALID_ARGUMENT:'平台请求参数无效，请核对原始请求。',INVALID_PLATFORM_RESPONSE:'平台返回未知或无效响应；须诊断原始请求，不能自动盲重试。',UNSUPPORTED_ENTITY:'当前连接器不支持该实体类型；不能以 Hive 查询替代。',UNSUPPORTED_CAPABILITY:'当前连接器没有所需执行能力。',LOCAL_RESULT_STORAGE:'平台结果未完整保存；请恢复本地存储后核对原回执。',LOCAL_RESULT_INTEGRITY:'平台结果完整性校验失败；不能重发查询或使用部分数据。',STORAGE_ERROR:'本地持久化失败；请先恢复存储。',SCOPE_UNRESOLVED:'项目范围不明确；须解析真实项目，不能猜测请求。'};
function failureResult(operation,requestedQuery,reused,extra={}){
 const receipt=operation.receipt||{version:1,operationId:operation.id||operation.key,requestedQuery:boundaries.requestQuery(operation.requestedQuery||operation.query),originalQuery:boundaries.requestQuery(operation.query),actualQuery:boundaries.requestQuery(operation.actualQuery||operation.query),observedAt:operation.completedAt,classification:operation.errorCode,classificationBasis:'legacy_record',diagnostics:{},diagnosticsUnavailable:true,summary:summaries[operation.errorCode]||summaries.INVALID_PLATFORM_RESPONSE};
 return {operation,operationId:operation.id||operation.key,requestedQuery:boundaries.requestQuery(requestedQuery),originalQuery:boundaries.requestQuery(operation.query),cachedQuery:reused?boundaries.requestQuery(operation.actualQuery||operation.query):undefined,originalObservedAt:operation.completedAt,receipt,error:summaries[operation.errorCode]||summaries.INVALID_PLATFORM_RESPONSE,errorCode:operation.errorCode,reused,...extra};
}
function acceptedResult(row){
 const b=row.acceptedBoundary,operation={id:b.operationId,query:b.originalQuery,actualQuery:b.query,status:'failed',errorCode:b.errorCode,error:summaries[b.errorCode],completedAt:b.originalObservedAt,receipt:b.receipt};
 return failureResult(operation,row.requestedQuery,true,{status:'accepted_boundary',acceptedBoundary:b,cacheReason:'user_accepted_boundary',resolvedQuery:row.query,projectResolution:row.proof});
}
function assertCurrent(a,job,batch,query){
 if(!batches.has(batch)||batch.a!==a||batch.job!==job||boundary(job)!==batch.boundary||a.data.delegations?.find(j=>j.id===job.id)!==job)throw stale();
 require('./execution-gate.cjs').assert(a,{job,readOnly:true});
 const check=require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[query]});
 if(policyProof(check)!==batch.policy)throw stale();
 return check;
}
async function prepareBatch(a,job){
 const policy=require('./access-policy-store.cjs');
 require('./execution-gate.cjs').assert(a,{job,readOnly:true});
 // Only the authority can prove a pending explicit bootstrap intent. A field
 // restored from workspace, a cached identity, or a CLI credential cannot do so.
 const token=policy.beginPlatformIdentity(a,job);
 const initial=boundary(job),preflights=require('./evidence-identity-preflight.cjs');
 const preflight=preflights.begin(a,job,null,{bindingToken:token});
 let identity,changed;
 try{
  identity=await platform.query(job,{op:'identity'},{signal:a.controller?.signal,request:a.platformRequest,beforeRequest:()=>{
   require('./execution-gate.cjs').assert(a,{job,readOnly:true});
   if(boundary(job)!==initial)throw stale();
   preflights.dispatched(a,preflight);
  },afterResponse:(_query,data)=>preflights.received(a,preflight,data)});
  require('./execution-gate.cjs').assert(a,{job,readOnly:true});
  changed=boundary(job)!==initial;
  preflights.complete(a,preflight,identity.data);
 }catch(error){
  let routed;try{routed=preflights.finish(a,preflight,error);}catch(settlement){routed=preflights.routed(a,job,settlement,preflight);}throw routed;
 }
 if(changed)throw stale();
 const check=require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[{op:'projects'}]});
 const s=state(job);s.principalRun=a.activeAgentRun?.id||null;s.principalCheckedAt=now();
 const batch=Object.freeze({a,job,boundary:boundary(job),policy:policyProof(check),identity});batches.add(batch);migrateBoundaries(a,job);a.save();return batch;
}
function preserveHistorical(a,job,operation,observations){
 Object.assign(operation,{status:'superseded',presentationStatus:'historical',completedAt:now()});
 const policy=require('./access-policy-store.cjs');
 const liveJob=a.data.delegations?.find(j=>j.id===job.id);
 const retained=!!a.dir&&liveJob&&!liveJob.deletedAt&&policy.check(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',jobId:job.id},operation:'local_retention'}).allowed;
 operation.observations=observations.map(({query,data})=>({query,principal:operation.principal,observedAt:now(),contentHash:evidence.hash(data),...(retained?{data}:{bodyOmitted:true})}));
 // Recovery can replace the in-memory job while the CLI is outstanding. Keep
 // its fact in the current workspace, without reattaching a deleted job.
 if(liveJob!==job){
  const current=liveJob&&state(liveJob),copy=structuredClone(operation);
  if(current?.operations[operation.key]?.id===operation.id)Object.assign(current.operations[operation.key],copy);
  else {
   const owner=current||(a.data.runtime ||= {}),key=current?'history':'platformOperationHistory';
   const history=owner[key] ||= [],prior=history.find(r=>r.id===operation.id);
   if(prior)Object.assign(prior,copy);else history.push({...copy,jobId:job.id});
  }
 }
 a.save();
}
async function fetch(a,job,query,{batch,retry=false}={}){
 const requestedQuery=boundaries.requestQuery(query);query=requestedQuery;let localFailure;
 try{platform.command(query);}catch(e){if(!['UNSUPPORTED_ENTITY','UNSUPPORTED_CAPABILITY'].includes(e.code))throw e;localFailure=e;}
 // Authenticate once for each batch, even when every result will be cached.
 batch ||= await prepareBatch(a,job);
 assertCurrent(a,job,batch,query);
 migrateBoundaries(a,job);
 const scope=boundaries.inspect(job,query,boundaryOptions(a,job));
 if(scope.status==='scope_unresolved'&&scope.reason!=='missing_project')localFailure=Object.assign(Error(summaries.SCOPE_UNRESOLVED),{code:'SCOPE_UNRESOLVED'});
 if(scope.status!=='scope_unresolved')query=scope.query;
 // retry is an explicit caller option, never inferred from feedback or passed
 // through model query arguments. It still runs identity/policy/gate checks.
 const ledger=state(job),requestKey=key(job,query),unsettled=[...new Set([...unsettledForQuery(job,query),...unsettledForQuery(job,requestedQuery)])];
 const prior=ledger.operations[requestKey]||Object.values(ledger.operations).find(o=>o.query&&sameRequest(o.actualQuery||o.query,query)&&valid(job,o,a))||unsettled[0];
 let attempt=items.activeAttempt(a,job,requestedQuery);
 const method=require('./evidence-storage-method.cjs');
 const methodClaim=attempt?.methodClaimKey?ledger.evidenceMethodAttempts?.[attempt.methodClaimKey]:null;
 const runtimeStep=require('./dispatch-lifecycle.cjs').currentStep(a,job);let resumeClaim=null;
 if(runtimeStep?.storageMethodResume){
  const task=a.data.tasks.find(t=>t.id===runtimeStep.dispatch.taskId),episode=ledger.continuation?.episodes?.[ledger.continuation.activeBasis];
  const resumed=require('./storage-method-resume.cjs').currentDispatch(a,job,task,episode,runtimeStep);
  if(!resumed.allowed)throw Object.assign(Error(resumed.reason),{code:resumed.reason,stopBatch:true});
  resumeClaim=runtimeStep.storageMethodResume.claimKeys.map(k=>ledger.evidenceMethodAttempts[k]).find(c=>method.sameQuery(c.query,requestedQuery));
  if(!resumeClaim)throw Object.assign(Error('恢复派发没有对应的原领取'),{code:'RESUME_DISPATCH_LINK_CHANGED',stopBatch:true});
 }
 const permitsMethod=op=>methodClaim&&(!methodClaim.operationId||methodClaim.operationId===op?.id)&&op?.id===methodClaim.proof?.operation?.id||resumeClaim&&op?.id===resumeClaim.proof.operation.id;
 const unsent=[];
 for(const old of unsettled){
  if(permitsMethod(old))continue;
  const original=items.allAttempts(job).find(v=>v.attemptId===old.attemptId&&v.operationId===old.id),check=items.zeroBoundaryProof(a,job,original,old);
  if(!check.eligible)throw Object.assign(Error(check.reason||'原查询尚未结算'),{code:'OPERATION_RECONCILIATION_REQUIRED',decision:{action:'reconcile',reason:check.reason,operationId:old.id},stopBatch:true});
  unsent.push({old,original,proof:check.proof});
 }
 const retireUnsentInCommit=replacement=>{
  for(const {old,original,proof} of unsent){
   const fresh=items.zeroBoundaryProof(a,job,original,old);
   if(!fresh.eligible||evidence.hash(fresh.proof)!==evidence.hash(proof))throw stale();
   Object.assign(old,{status:'superseded',phase:'not_dispatched',completedAt:now(),resolvedBy:replacement.id,zeroBoundaryResolution:{reason:'PROVEN_ZERO_BUSINESS_DISPATCH',proof,replacementOperationId:replacement.id}});
   if(old!==prior)(ledger.history ||= []).push(structuredClone(old));
  }
 };
 if(!localFailure&&scope.status==='accepted_boundary'&&!retry)return acceptedResult(scope);
 const found=query.op==='identity'||retry===true||methodClaim||resumeClaim?null:lookup(a,job,query);
 if(found&&!(found.errorCode==='SCOPE_UNRESOLVED'&&!localFailure)&&(!found.operation.policy||found.operation.policy===batch.policy)){
  commit(a,()=>{retireUnsentInCommit(found.operation);if(attempt)items.settleReuseInCommit(a,job,attempt,found.operation);ledger.reusedQueries=(ledger.reusedQueries||0)+1;});return {...found,requestedQuery};
 }
 const allowedMethod=permitsMethod(prior);
 if(prior&&!allowedMethod&&!unsent.some(v=>v.old===prior)&&(valid(job,prior,a)||unsettledStatuses.has(prior.status))&&!(retry&&prior.status==='failed'&&!['TRANSIENT','LOCAL_RESULT_STORAGE','LOCAL_RESULT_INTEGRITY'].includes(prior.errorCode))){const d=eligibility(job,prior);if(d.action!=='execute'&&d.action!=='reuse')throw Object.assign(Error(d.reason||'原查询尚未结算'),{code:'OPERATION_RECONCILIATION_REQUIRED',decision:d,stopBatch:true});}
 if(attempt?.operationId&&!allowedMethod)throw Object.assign(Error('本逐项身份已绑定操作；须核对原回执或领取下次合法尝试'),{code:'EVIDENCE_ATTEMPT_ALREADY_BOUND',stopBatch:true});
 const task=a.data.tasks.find(t=>t.id===(methodClaim?.taskId||require('./dispatch-lifecycle.cjs').currentStep(a,job)?.dispatch?.taskId));
 const operation={id:require('node:crypto').randomUUID(),key:requestKey,query:structuredClone(query),requestedQuery,projectResolution:scope.proof,epoch:epoch(job),permissionRevision:ledger.permissionRevision||0,scope:job.dataPlatform,projectId:job.projectId||null,workRevision:job.workRevision??1,principal:structuredClone(job.platformPrincipal||null),policy:batch.policy,unverifiedScope:job.platformPrincipal?null:unverifiedScope(a),status:'prepared',phase:'prepared',taskId:task?.id||null,attemptId:attempt?.attemptId||require('node:crypto').randomUUID(),logicalKey:attempt?.logicalKey||items.logicalKey(job,task,requestedQuery),...(methodClaim?{methodClaimId:methodClaim.key,originOperationId:methodClaim.originOperationId||methodClaim.proof.operation.id,familyKey:methodClaim.familyKey||method.familyKey(job,methodClaim.proof.operation),method:methodClaim.method}:{}),attempt:(prior?.attempt||0)+1,startedAt:now(),previousSourceId:prior?.sourceId||null};
 // The legacy explicit-resume adapter expects a live running slot. Its phase
 // stays prepared until the durable request boundary; the old claim is immutable.
 if(resumeClaim)Object.assign(operation,{status:'running',originOperationId:resumeClaim.proof.operation.id,method:resumeClaim.method});
 commit(a,()=>{
 retireUnsentInCommit(operation);
 if(prior){(ledger.history ||= []).push(structuredClone(prior));if(prior.key!==requestKey)Object.assign(prior,{status:'superseded',resolvedBy:operation.id});}
 if(retry===true)for(const old of Object.values(ledger.operations))if(permissionFailure(old)&&valid(job,old,a)&&sameRequest(old.actualQuery||old.query,query))Object.assign(old,{status:'superseded',resolvedBy:operation.id});
 ledger.operations[requestKey]=operation;if(attempt)items.bindOperationInCommit(job,attempt,operation);if(methodClaim)methodClaim.operationId=operation.id;
 });
 const observations=[];let lastRequest;
 try{
  if(localFailure)throw localFailure;
  const snapshot=query.op==='identity'?structuredClone(batch.identity):await platform.query(job,query,{signal:a.controller?.signal,request:a.platformRequest,storageScope:{operationId:operation.id},
   beforeRequest:child=>{assertCurrent(a,job,batch,child);const check=boundaries.inspect(job,child,boundaryOptions(a,job));if(check.status==='accepted_boundary'&&!retry)throw Object.assign(Error('已接受边界不再自动查询'),{code:'ACCEPTED_BOUNDARY',boundaryResult:check});lastRequest=require('./dispatch-lifecycle.cjs').boundary(a,job,child,{operation,attempt,operationId:operation.id,attemptId:operation.attemptId,parentRequestId:lastRequest?.requestId||null,parentQuery:requestedQuery});
    if(!lastRequest)commit(a,()=>{lastRequest={requestId:require('node:crypto').randomUUID(),operationId:operation.id,attemptId:operation.attemptId,parentRequestId:operation.requests?.at(-1)?.requestId||null,parentQuery:requestedQuery,query:structuredClone(child),startedAt:now(),phase:'dispatch_started'};(operation.requests ||= []).push(lastRequest);operation.status='running';operation.phase='dispatched';});},
   afterResponse:(child,data)=>{observations.push({query:structuredClone(child),data});assertCurrent(a,job,batch,child);
    try{commit(a,()=>{(operation.responses ||= []).push({requestId:lastRequest.requestId,query:structuredClone(child),data:structuredClone(data),dataHash:evidence.hash(data),retained:true,receivedAt:now()});operation.phase='receipt';if(attempt)attempt.phase='receipt';require('./recovery.cjs').assertStorageCapacity(a);});}catch(error){throw Object.assign(error,{code:'LOCAL_RESULT_STORAGE',stopBatch:true,dispatchFailure:true});}}
  });
  assertCurrent(a,job,batch,query);
  if(query.op==='identity')require('./platform-operation-proof.cjs').retainIdentity(a,job,operation,batch.identity);
  if(!valid(job,operation)||ledger.operations[requestKey]!==operation)throw stale();
  commit(a,()=>{operation.actualQuery=structuredClone(snapshot.query);});
  return {snapshot,operation,reused:false};
 }catch(error){
  // A response already observed before a pause/revocation remains historical
  // evidence. Preserve it before propagating the local stop-batch signal.
  if(observations.length&&(error.dispatchFailure||error.gateClosed)){
   let changed=false;try{assertCurrent(a,job,batch,query);}catch{changed=true;}
   if(changed){preserveHistorical(a,job,operation,observations);throw Object.assign(stale(),{gateClosed:error.gateClosed===true,dispatchFailure:error.dispatchFailure===true,...(error.gateReason?{gateReason:error.gateReason}:{})});}
  }
  if(error.dispatchFailure||error.gateClosed||error.stopBatch)throw error;
  let changed=false;try{assertCurrent(a,job,batch,query);}catch{changed=true;}
  if(error.code==='OPERATION_STALE'||changed){preserveHistorical(a,job,operation,observations);throw stale();}
  a.controller?.signal.throwIfAborted();
  if(error.code==='ACCEPTED_BOUNDARY'){Object.assign(operation,{status:'superseded',completedAt:now(),boundaryId:error.boundaryResult.acceptedBoundary.id});a.save();return acceptedResult({...error.boundaryResult,requestedQuery});}
  const errorCode=classify(error);commit(a,()=>{Object.assign(operation,{status:'failed',error:summaries[errorCode],errorCode,completedAt:now(),actualQuery:boundaries.requestQuery(error.actualQuery||query)});
  if(operation.errorCode==='TRANSIENT'){
   const delay=items.BACKOFF[Math.min(2,items.transientCount(job,operation.logicalKey)-1)],providerDelay=Number(error.retryAfterMs);
   operation.retryAt=new Date(Date.now()+Math.max(delay,Number.isFinite(providerDelay)?Math.max(0,providerDelay):0)).toISOString();
  }
  if(Number.isFinite(Number(error.providerCode)))operation.providerCode=Number(error.providerCode);
  const knownBasis=['explicit_permission_response','typed_missing_response','numeric_provider_status','unknown_symbolic_response','invalid_response_format','transport_timeout'];
  operation.receipt={version:1,operationId:operation.id,requestedQuery,originalQuery:operation.query,actualQuery:operation.actualQuery,parameters:localFailure?[]:platform.command(operation.actualQuery),observedAt:operation.completedAt,classification:errorCode,classificationBasis:knownBasis.includes(error.classificationBasis)?error.classificationBasis:(['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN'].includes(error.code)?'transport_code':errorCode==='INVALID_PLATFORM_RESPONSE'?'unknown_response':'typed_error'),diagnostics:platform.safeDiagnostics(error),summary:operation.error,...(localFailure?.limitation?{limitation:localFailure.limitation}:{}),...(localFailure?{dispatched:false}:{dispatched:true})};
  items.settleInCommit(a,job,operation);
  });if(['LOCAL_RESULT_STORAGE','LOCAL_RESULT_INTEGRITY','STORAGE_ERROR'].includes(errorCode))throw Object.assign(error,{code:errorCode,stopBatch:true});
  return failureResult(operation,requestedQuery,false);
 }
}
function reuseInCommit(a,job,attempt,operation){
 if(operation.status!=='done')throw Object.assign(Error('缓存来源尚未成功保存'),{code:'LOCAL_RESULT_INTEGRITY',stopBatch:true});
 return items.settleReuseInCommit(a,job,attempt,operation);
}
function finish(a,job,operation,sourceId){
 require('./dispatch-lifecycle.cjs').guard(a,job);
 require('./execution-gate.cjs').assert(a,{job,task:a.data.tasks.find(t=>t.id===operation.taskId)});
 require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[operation.requestedQuery||operation.query]});
 if(!valid(job,operation,a)||state(job).operations[operation.key]!==operation)throw stale();
 const source=a.data.sources.find(s=>s.id===sourceId);if(!source)throw Object.assign(Error('完整来源未保存'),{code:'LOCAL_RESULT_STORAGE'});
 const checked=require('./platform-operation-proof.cjs').source(a,job,operation,{sourceId,completion:true});
 if(!checked)throw Object.assign(Error('完整来源未在当前范围可读'),{code:'LOCAL_RESULT_INTEGRITY',stopBatch:true});
 const binding=source.platformArchive?.binding;
 operation.responseProof=checked.proof;
 source.platformOperationId ||= binding?.operationId||operation.id;
 source.platformScope ||= operation.scope;
 source.platformPermissionRevision ??= binding?.permissionRevision??operation.permissionRevision;
 operation.sourceVersion=source.version||1;operation.sourceOperationId=source.platformOperationId;
 operation.sourceIntegrityHash=evidence.hash({content:source.content,archive:source.platformArchive||null,version:source.version||1});
 if(operation.receipt)(operation.receiptHistory ||= []).push(structuredClone(operation.receipt));
 operation.receipt={version:2,operationId:operation.id,attemptId:operation.attemptId,logicalKey:operation.logicalKey,sourceId,sourceVersion:operation.sourceVersion,sourceOperationId:operation.sourceOperationId,retained:true,storageValidated:true,responseProof:structuredClone(checked.proof),observedAt:now()};
 Object.assign(operation,{status:'done',phase:'persisted',sourceId,completedAt:now()});items.settleInCommit(a,job,operation,{sourceId});
 delete operation.errorCode;delete operation.error;delete operation.retryAt;
 delete operation.responses;delete operation.identityResponse;const s=state(job);
 for(const old of Object.values(s.operations))if(old!==operation&&old.status==='failed'&&valid(job,old)){
  if(sameRequest(old.actualQuery||old.query,operation.actualQuery||operation.query))Object.assign(old,{status:'superseded',resolvedBy:operation.id});
 }
 s.operations[key(job,operation.query)]=operation;
}
function snapshot(job){return Object.values(state(job).operations).map(o=>({operationId:o.id||o.key,query:o.query,requestedQuery:o.requestedQuery,actualQuery:o.actualQuery,receipt:o.receipt,status:o.status,sourceId:o.sourceId,errorCode:o.errorCode,error:o.error,completedAt:o.completedAt,retryAt:o.retryAt,decision:eligibility(job,o)}));}
function normalize(tool,args={}){
 const value=require('./tool-registry.cjs').parameters(tool,args);delete value.reason;
 if(tool==='platform_query')return {tool,queries:(value.queries||[]).map(q=>{try{return platform.command(q);}catch(e){if(!['UNSUPPORTED_ENTITY','UNSUPPORTED_CAPABILITY'].includes(e.code))throw e;return {unsupported:boundaries.canonicalQuery(q)};}}).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
 if(['read_source','search_source','read_artifact','read_platform','list_sources','read_work_state','platform_inventory'].includes(tool)){
  value.start=Number(value.start||0);if(tool==='read_source'||tool==='search_source')value.limit=Number(value.limit||6);
  if(tool==='read_platform')value.limit=Number(value.limit||50);
  if(tool==='list_sources'||tool==='read_work_state')value.limit=Number(value.limit||40);
  if(tool==='platform_inventory'){value.limit=Number(value.limit||100);value.queryStart=Number(value.queryStart||0);}
 }
 if(Array.isArray(value.sourceIds))value.sourceIds=[...new Set(value.sourceIds)].sort();
 if(tool==='plan_task'){delete value.title;delete value.description;delete value.reason;value.steps=value.steps?.map(s=>({key:s.key,kind:s.kind,tool:s.tool}));}
 return {tool,args:value};
}
function event(job,row){const s=state(job);s.events=[...s.events,structuredClone({...row,at:now()})].slice(-150);}
module.exports={reuseInCommit,storageFailure:items.storageFailure,settleItemInCommit:items.settleInCommit,logicalKey:items.logicalKey,state,epoch,key,lookup,prepareBatch,fetch,finish,snapshot,normalize,event,freshMs,classify,valid,eligibility,unsettledForQuery,activeFailure,migrateBoundaries,boundaryOptions};
