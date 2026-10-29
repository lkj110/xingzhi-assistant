'use strict';
const {hash}=require('./evidence-basis.cjs');
// Compatibility identity is deliberately frozen. Policy changes cannot grant a call.
const READ_POLICY_VERSION='useful-siblings-final-check-1';
const transportPermits=new WeakMap();
function identity(a,task,context,snapshot,phase){
 const job=a.data.delegations.find(j=>j.id===task.agentJobId);
 const primary=require('./deliverables.cjs').primary(a,task);
 const ids=[task.primaryArtifactId||primary?.id,context.revision?.artifactId,context.workingDraft?.id].filter(Boolean);
 const artifacts=[...new Set(ids)].sort().map(id=>{
  const artifact=a.data.artifacts.find(r=>r.id===id&&r.taskId===task.id);
  if(!artifact||![...snapshot.readableCatalog,...snapshot.historyCatalog].some(r=>r.type==='artifact'&&r.id===id))throw require('./model-errors.cjs').contextError('CONTEXT_SCOPE_DENIED');
  return {artifactId:id,contentHash:hash(artifact.content)};
 });
 const basis={taskId:task.id,phase,inputBasis:snapshot.inputBasis,deliveryBasis:phase==='result'?snapshot.deliveryBasis:null,artifacts,
  checkBasis:phase==='content'?require('./execution-control.cjs').contentBasis(a,job,task):require('./acceptance.cjs').basis(a,task)};
 const sourceTitles=require('./grounding.cjs').enabled(a)?require('./citation-fields.cjs').titleBasis(snapshot.readableCatalog):undefined;
 if(sourceTitles)basis.sourceTitles=sourceTitles;
 const markerRecheck=require('./marker-confirmation.cjs').checkAuthorization(a,task,phase);
 if(markerRecheck)basis.markerRecheck=markerRecheck;
 const compatibility={policy:READ_POLICY_VERSION,role:'verify',checkPhase:phase,taskId:task.id,input:snapshot.inputBasis,delivery:phase==='result'?snapshot.deliveryBasis:undefined,artifact:context.artifacts,revision:context.revision,workingDraft:context.workingDraft,...(markerRecheck?{markerRecheck}:{})};
 const compatibilityKey=hash(compatibility),legacyKey=sourceTitles?hash({...compatibility,sourceTitles}):compatibilityKey;
 return {semanticCheckId:hash(basis),legacyKey,...(sourceTitles?{compatibilityKey}:{}),phase,basis};
}
function state(task,identity){
 const {semanticCheckId,legacyKey,compatibilityKey,phase,basis}=identity;
 const result=(available,reason)=>({semanticCheckId,legacyKey,available,reason});
 const records=Object.entries(task.contextFinalizations||{});
 if(records.some(([key,r])=>key===legacyKey||r?.legacyKey===legacyKey))return result(false,'legacy_consumed');
 if(!basis.sourceTitles&&records.some(([,r])=>r?.compatibilityKey===legacyKey))return result(false,'legacy_consumed');
 // An older record cannot prove which title was consumed. A protocol upgrade
 // alone never grants another request; only new records bind exact title bytes.
 if(compatibilityKey&&records.some(([key,r])=>(key===compatibilityKey||r?.legacyKey===compatibilityKey||r?.compatibilityKey===compatibilityKey)&&!r?.basis?.sourceTitles))return result(false,'legacy_consumed');
 if(records.some(([,r])=>r?.semanticCheckId===semanticCheckId))return result(false,'semantic_consumed');
 for(const [,r] of records){
  const recordedPhase=r?.phase||r?.checkPhase,consistent=!r?.phase||!r?.checkPhase||r.phase===r.checkPhase;
  if(!consistent)return result(false,'ambiguous_consumed');
  if(consistent&&['content','result'].includes(recordedPhase)&&recordedPhase!==phase)continue;
  // A semantic id or complete basis is evidence of a different check. An opaque
  // old hash, status or policy name alone cannot prove a different input/draft.
  if(r?.semanticCheckId&&r.phase===phase&&r.basis&&hash(r.basis)===r.semanticCheckId&&r.basis.taskId===basis.taskId)continue;
  if(r?.basis&&r.basis.taskId===basis.taskId&&r.basis.phase===phase&&typeof r.basis.inputBasis==='string'&&typeof r.basis.checkBasis==='string'&&Array.isArray(r.basis.artifacts)&&r.basis.artifacts.every(x=>typeof x.artifactId==='string'&&typeof x.contentHash==='string')&&hash(r.basis)!==semanticCheckId)continue;
  return result(false,'ambiguous_consumed');
 }
 return result(true,'available');
}
function reserve(task,identity,details={}){
 const available=state(task,identity);
 if(!available.available)throw require('./model-errors.cjs').contextError('CONTEXT_INVALID_REQUEST',{message:'本检查的有界结论已登记或旧记录身份不明；请核对原请求，不能再次调用。',noProgress:true,finalizationReason:available.reason});
 const record={...identity,...details,policy:READ_POLICY_VERSION,checkPhase:identity.phase,startedAt:new Date().toISOString(),status:'started'};
 (task.contextFinalizations ||= {})[identity.legacyKey]=record;
 return record;
}
// App-only capability, issued after generation has saved its reservation. It is
// never accepted from the model payload or serialized into a transport request.
function transportPermit(a,task,record){
 const token=Object.freeze({});
 if(task.contextFinalizations?.[record?.legacyKey]!==record||record.status!=='started'||record.transport)throw require('./model-errors.cjs').contextError('CONTEXT_INVALID_REQUEST',{message:'有界结论的请求登记不可再次使用。',noProgress:true});
 transportPermits.set(token,{a,task,record,used:false});
 return token;
}
function transportGuard(a,token){
 if(token===undefined)return null;
 const permit=transportPermits.get(token);
 const valid=()=>permit?.a===a&&a.data.tasks.includes(permit.task)&&permit.task.contextFinalizations?.[permit.record.legacyKey]===permit.record&&permit.record.status==='started'&&!permit.used&&!permit.record.transport;
 const reject=()=>require('./model-errors.cjs').contextError('CONTEXT_INVALID_REQUEST',{message:'有界结论只允许已登记的一次模型请求，不能修复、重试或切换模型再次发送。',noProgress:true});
 if(!valid())throw reject();
 return requestId=>{
  if(!valid())throw reject();
  permit.used=true;
  // The ordinary model-call save persists this before efficiency invokes chat.
  permit.record.transport={requestId,attempt:1,startedAt:new Date().toISOString()};
 };
}
module.exports={identity,state,reserve,transportPermit,transportGuard,READ_POLICY_VERSION};
