'use strict';
// One admission decision for policy, the request boundary and failure routing.
// Claims are process-local ownership of an existing row, not retry grants.
const {hash}=require('./evidence-basis.cjs');
const {randomUUID}=require('node:crypto');
const items=require('./evidence-item-lifecycle.cjs');
const access=require('./access-policy-store.cjs');
const commit=(a,fn)=>require('./state-transitions.cjs').commit(a,fn);
const claims=new WeakMap(),errors=new WeakMap();
const now=()=>new Date().toISOString();
const unresolved=new Set(['prepared','dispatched','unknown']);
const transient=new Set(['TRANSIENT','ABORTED']);
function context(a,job){
 const {request,proof}=access.describePlatformIdentity(a,job);
 return {context:{jobId:job.id,platformScope:job.dataPlatform,projectId:job.projectId||null,authorityKind:request.operation==='platform_identity'?'bootstrap':'bound',...request,policyId:proof.policyId,grantRevision:proof.grantRevision},proof};
}
function key(job,authority){return hash({identityContextVersion:2,context:authority?.principalScope?authority:{jobId:job.id,platformScope:job.dataPlatform,projectId:job.projectId||null,policy:authority}});}
function legacyKey(job,policy){return hash({jobId:job.id,principal:job.platformPrincipal||null,permissionRevision:job.executionState?.permissionRevision||0,scope:job.dataPlatform,projectId:job.projectId||null,epoch:require('./operation-ledger.cjs').epoch(job),policy});}
function independent(x,y){
 // Bootstrap -> bound is one authority evolution, never an exclusion proof.
 return x.jobId===y.jobId&&(x.platformScope!==y.platformScope||x.authorityKind==='bound'&&y.authorityKind==='bound'&&hash(x.principalScope)!==hash(y.principalScope));
}
function history(a,job,current){
 const check=access.checkTool(a,job,'platform_query',{queries:[{op:'identity'}]});
 const oldKey=legacyKey(job,hash({policyId:check.policyId,grantRevision:check.grantRevision}));
 const records=[],excluded=[],store=job.executionState?.identityPreflights;
 if(store!==undefined&&(!store||typeof store!=='object'||Array.isArray(store)))return {records:[{row:{},ambiguous:true}],excluded};
 const all=Object.values(store||{}).filter(Array.isArray).flat();
 // A successful bootstrap binding connects its original authority to the
 // exact bound grant. It never hides an unresolved row on either side.
 const boundFrom=new Set(all.filter(r=>r?.contextVersion===2&&r.context?.authorityKind==='bootstrap'&&r.status==='done'&&r.completion?.requestId===r.requestId&&r.completion?.binding?.committed===true&&hash(r.completion.principalScope)===hash(current.principalScope)&&r.completion.binding.events?.some(e=>e.policyId===current.policyId&&e.grantRevision===current.grantRevision)&&access.identityAuthorityRecorded(a,r.context)).map(r=>hash(r.context)));
 for(const [bucket,values] of Object.entries(store||{})){
  if(!Array.isArray(values)){records.push({row:{status:'invalid'},ambiguous:true});continue;}
  for(const row of values){
   const c=row?.context;
   const verified=row?.contextVersion===2&&c?.jobId===job.id&&c.platformScope===c.resourceScope?.key&&c.resourceScope?.jobId===job.id&&c.authorityKind===(c.operation==='platform_identity'?'bootstrap':'bound')&&row.key===key(job,c)&&bucket===row.key&&access.identityAuthorityRecorded(a,c);
   if(verified&&independent(c,current)){excluded.push({id:row.id,key:bucket,reason:'VERIFIED_INDEPENDENT_AUTHORITY'});continue;}
   // An exact old key is read-only reconstruction. Other old buckets retain
   // their constraints but cannot provide a new transient retry allowance.
   records.push({row:row||{status:'invalid'},ambiguous:verified?row.status==='failed'&&hash(c)!==hash(current)&&!boundFrom.has(hash(c)):!(row?.contextVersion===undefined&&bucket===oldKey&&row.key===bucket)});
  }
 }
 return {records,excluded};
}
function aggregate(entries,time,self){
 let conflict=false;
 const records=[],ids=new Map(),requests=new Map();
 for(const entry of entries){
  const r=entry.row;
  if(r.contextVersion===2&&r.status==='done'&&(!r.requestId||r.completion?.requestId!==r.requestId||!r.completion?.responseHash||!r.completion?.binding||hash(r.completion.principalScope)!==hash(r.completion.binding.principalScope)))conflict=true;
  if(typeof r.id!=='string'||!r.id||r.requestId!==undefined&&(typeof r.requestId!=='string'||!r.requestId)||!['prepared','dispatched','unknown','failed','done'].includes(r.status)){conflict=true;continue;}
  const existing=ids.get(r.id)||r.requestId&&requests.get(r.requestId),prior=existing?.row;
  if(prior){
   // Exact facts can be represented in old and new buckets without double
   // charging. Different request ownership or terminal outcomes are unknown.
   const fact=v=>hash({id:v.id,requestId:v.requestId||null,status:v.status,startedAt:v.startedAt,finishedAt:v.finishedAt,errorCode:v.errorCode||null});
   if(fact(prior)!==fact(r)||prior.context&&r.context&&hash(prior.context)!==hash(r.context))conflict=true;
   else existing.ambiguous &&= entry.ambiguous;
   continue;
  }
  const saved={...entry};ids.set(r.id,saved);if(r.requestId)requests.set(r.requestId,saved);records.push(r);
 }
 if(conflict||records.some(r=>r!==self&&unresolved.has(r.status)))return {action:'reconcile',reason:conflict?'IDENTITY_HISTORY_CONFLICT':'IDENTITY_RESULT_UNKNOWN'};
 const failures=records.filter(r=>r.status==='failed');
 const permanent=failures.filter(r=>!transient.has(r.errorCode));
 if(permanent.length)return {action:'diagnose',reason:permanent.map(r=>r.errorCode||'IDENTITY_FAILURE_UNKNOWN').sort()[0],failureCount:failures.length};
 if([...ids.values()].some(v=>v.ambiguous)||records.some(r=>typeof r.startedAt!=='string'||!Number.isFinite(Date.parse(r.startedAt))||['failed','done'].includes(r.status)&&(typeof r.finishedAt!=='string'||!Number.isFinite(Date.parse(r.finishedAt))||Date.parse(r.finishedAt)<Date.parse(r.startedAt))))return {action:'diagnose',reason:'IDENTITY_HISTORY_UNPROVEN'};
 if(failures.length){const last=failures.reduce((a,b)=>Date.parse(a.finishedAt)>Date.parse(b.finishedAt)?a:b);return {...items.retryDecision(failures.length,last.finishedAt,time),failureCount:failures.length};}
 return {action:'execute'};
}
function decision(job,k,time=Date.now()){
 // Compatibility callers have no authority to exclude another bucket.
 return aggregate(Object.entries(job.executionState?.identityPreflights||{}).flatMap(([bucket,rs])=>Array.isArray(rs)?rs.map(row=>({row:row||{},ambiguous:bucket!==k})):[{row:{},ambiguous:true}]),time);
}
function inspect(a,job,{now:time=Date.now(),selfClaim}={}){
 const c=context(a,job),h=history(a,job,c.context),claim=selfClaim&&claims.get(selfClaim);
 const self=claim&&claim.a===a&&claim.job===job&&claim.row===selfClaim?selfClaim:null;
 const d=aggregate(h.records,time,self);
 return {key:key(job,c.context),context:c.context,authority:c.proof,records:h.records.map(v=>v.row),excluded:h.excluded,decision:!c.proof.allowed?{action:'diagnose',reason:c.proof.code||'ACCESS_POLICY_UNKNOWN'}:d};
}
function routed(a,job,error,row){
 if(!(error instanceof Error))error=Error(String(error));
 const view=inspect(a,job);errors.set(error,{a,job,row,key:row?.key||view.key});
 error.identityPreflight={origin:'platform_identity',key:row?.key||view.key,recordId:row?.id||null,requestId:row?.requestId||null,decision:view.decision};
 return error;
}
function isError(a,job,error){const v=errors.get(error);return !!v&&v.a===a&&v.job===job;}
function denied(a,job,view){return routed(a,job,Object.assign(Error('平台身份前置需要等待或核对：'+view.decision.reason),{code:view.decision.reason,retryAt:view.decision.retryAt}),null);}
function assertNew(a,job){const v=inspect(a,job);if(v.decision.action!=='execute')throw denied(a,job,v);return v;}
function scope(a,job){
 const step=require('./dispatch-lifecycle.cjs').currentStep(a,job);
 if(a.activeAgentRun&&!step)throw Object.assign(Error('身份请求缺少本次派发领取'),{code:'IDENTITY_CLAIM_INVALID'});
 return {runId:a.activeAgentRun?.id||null,dispatchId:step?.dispatch.id||null,stepId:step?.id||null};
}
function begin(a,job,_legacyPolicy,options={}){
 const v=assertNew(a,job),bindingToken=options.bindingToken||access.beginPlatformIdentity(a,job),owner=scope(a,job);
 access.assertPlatformIdentityToken(a,job,bindingToken);
 const row={id:randomUUID(),key:v.key,contextVersion:2,context:structuredClone(v.context),status:'prepared',startedAt:now(),...owner,invocationId:owner.runId?null:randomUUID()};
 commit(a,()=>{const s=require('./operation-ledger.cjs').state(job);((s.identityPreflights ||= {})[row.key] ||= []).push(row);});
 claims.set(row,{a,dir:a.dir,job,row,bindingToken,owner,preparedHash:hash(row),preparedCommitId:a.data.runtime?.commitId||null,phase:'prepared',requestId:randomUUID()});return row;
}
function own(a,row){
 const c=claims.get(row);
 if(!c||c.a!==a||c.dir!==a.dir||c.row!==row||a.data.delegations?.find(j=>j.id===c.job.id)!==c.job||!c.job.executionState?.identityPreflights?.[row.key]?.includes(row))throw Object.assign(Error('身份请求领取无效或已丢失；须核对原请求'),{code:'IDENTITY_CLAIM_INVALID'});
 if(c.phase==='dispatched'&&hash(row)!==c.dispatchedHash||['done','failed'].includes(c.phase)&&hash(row)!==c.terminalRowHash)throw Object.assign(Error('原身份请求或终局记录已变化'),{code:'IDENTITY_CLAIM_INVALID'});
 return c;
}
function dispatched(a,row){
 const c=own(a,row);
 if(c.phase!=='prepared'||row.status!=='prepared'||hash(row)!==c.preparedHash||hash(scope(a,c.job))!==hash(c.owner))throw routed(a,c.job,Object.assign(Error('身份请求不能重复或跨领取派发'),{code:'IDENTITY_CLAIM_INVALID'}),row);
 c.stage='request_admission';
 const v=inspect(a,c.job,{selfClaim:row});
 if(v.key!==row.key||v.decision.action!=='execute')throw denied(a,c.job,v.key===row.key?v:{...v,decision:{action:'diagnose',reason:'ACCESS_POLICY_CONFLICT'}});
 require('./execution-gate.cjs').assert(a,{job:c.job,readOnly:true});
 access.assertTool(a,c.job,'platform_query',{queries:[{op:'identity'}]});
 access.assertPlatformIdentityToken(a,c.job,c.bindingToken);
 // The private request ID is bound before either persistence boundary. A failed
 // save cannot mint a second entry or allow the transport to run.
 c.phase='dispatching';
 const request=require('./dispatch-lifecycle.cjs').boundary(a,c.job,{op:'identity'},{requestId:c.requestId});
 commit(a,()=>{row.status='dispatched';row.requestId=c.requestId;row.dispatchedAt=now();if(request)row.request=structuredClone(request);});
 c.phase='dispatched';c.stage='transport';c.dispatchedHash=hash(row);return row.requestId;
}
function received(a,row,data){
 const c=own(a,row);c.stage='response_validation';
 const username=data?.username||data?.user_id;
 if(typeof username!=='string'||!username.trim()||username.length>4096||/[\x00-\x1f\x7f]/.test(username))throw Object.assign(Error('无法验证当前平台账号；请核对原身份响应'),{code:'AUTH_REQUIRED'});
 c.stage='binding';
 const current=context(a,c.job);
 if(!current.proof.allowed||key(c.job,current.context)!==row.key)throw Object.assign(Error('身份响应返回时原授权已经变化'),{code:'ACCESS_POLICY_CONFLICT'});
}
function complete(a,row,identity){
 const c=own(a,row);if(c.phase==='done'&&row.completion?.responseHash===hash({...identity,username:typeof identity?.username==='string'?identity.username.trim():identity?.username}))return c.binding;
 if(c.phase!=='dispatched')throw Object.assign(Error('身份响应不属于待结算请求'),{code:'IDENTITY_CLAIM_INVALID'});
 c.stage='response_validation';
 const username=identity?.username;
 if(typeof username!=='string'||!username.trim()||username.length>4096||/[\x00-\x1f\x7f]/.test(username))throw Object.assign(Error('无法验证当前平台账号；请核对原身份响应'),{code:'AUTH_REQUIRED'});
 const validated={...identity,username:username.trim()};
 c.stage='binding';
 const receipt=access.bindPlatformIdentity(a,c.job,validated,c.bindingToken);
 c.stage='terminal_save';c.binding=receipt;
 const proof={responseHash:hash(validated),requestId:row.requestId,principalScope:receipt.principalScope,binding:structuredClone(receipt)};
 commit(a,()=>Object.assign(row,{status:'done',finishedAt:now(),completion:proof}));
 c.phase='done';c.terminal=hash(proof);c.terminalRowHash=hash(row);return receipt;
}
function finish(a,row,error){
 const c=own(a,row);
 if(!error)throw Object.assign(Error('身份完成必须具有验证及绑定证明'),{code:'IDENTITY_COMPLETION_UNPROVEN'});
 const failure={code:error.code||null,message:error.message,stage:c.stage||'transport',zeroBoundary:c.phase==='prepared'&&row.status==='prepared'&&!row.requestId};
 if(c.phase==='failed'){
  failure.zeroBoundary=row.failure.zeroBoundary;
  if(c.terminal===hash(failure))return;
  throw Object.assign(Error('身份终局冲突'),{code:'IDENTITY_TERMINAL_CONFLICT'});
 }
 if(c.phase==='done')throw Object.assign(Error('已完成身份不能改写失败'),{code:'IDENTITY_TERMINAL_CONFLICT'});
 const cancelled=error.name==='AbortError'||error.code==='ABORTED';
 // A lost binding/terminal commit or post-boundary cancellation is unresolved.
 // No existing access receipt uniquely proves a cold request association.
 const uncertain=c.stage==='terminal_save'||error.committed||error.dispatchFailure||cancelled&&c.phase!=='prepared'||['ENOSPC','EDQUOT','EIO','EROFS','STORAGE_ERROR'].includes(error.code);
 if(!uncertain){
  const code=cancelled?'ABORTED':c.stage==='binding'||String(error.code||'').startsWith('ACCESS_')?error.code||'ACCESS_POLICY_UNKNOWN':require('./operation-ledger.cjs').classify(error);
  commit(a,()=>Object.assign(row,{status:'failed',finishedAt:now(),errorCode:code,error:error.message,failure}));c.phase='failed';c.terminal=hash(failure);c.terminalRowHash=hash(row);
 }
 return routed(a,c.job,error,row);
}
function recoveryConditions(view){
 const d=view.decision;
 if(d.action==='wait_until')return ['到原 retryAt 后重新核对权限、预算与终局；三次失败总额不变。'];
 if(d.action==='reconcile')return ['仅用原请求及可信持久回执核对终局；证据不足保持停止，不重新发送。'];
 return ['核对原身份响应、真实授权与历史归属；本轮不提供清除失败或无条件重试入口。','仅可证明独立的新授权上下文重新评估；业务改稿、换 episode、刷新和冷启均不增加次数。'];
}
function action(a,job,candidate,options){
 if(candidate?.tool!=='platform_query'){
  if(candidate?.tool!=='planner')return null;
  const taskId=candidate.args?.taskId||candidate.args?.existingTaskId||null;
  const prior=(a.data.agentRuns||[]).filter(r=>r.jobId===job.id).flatMap(r=>r.steps||[]).some(s=>s.tool==='platform_query'&&s.identityPreflight?.origin==='platform_identity'&&(s.identityPreflight.ownerTaskId||s.args?.taskId||s.args?.existingTaskId||null)===taskId);
  if(!prior)return null;
 }
 const v=inspect(a,job,options);if(v.decision.action==='execute')return null;
 return {retryConditions:recoveryConditions(v),phase:v.decision.action==='wait_until'?'retry':'blocked',eligible:false,identity:v,reasonCode:v.decision.reason,reason:v.decision.reason,message:'平台身份前置'+(v.decision.action==='wait_until'?'等待退避到期':'需要核对或诊断')+'：'+v.decision.reason,resumeAt:v.decision.retryAt||null};
}
module.exports={key,legacyKey,context,decision,inspect,assertNew,begin,dispatched,received,complete,finish,routed,isError,action,recoveryConditions};
