'use strict';
// A receipt for incorporating already-authorized facts into the original draft.
// It grants neither evidence access nor a new legacy recovery/model allowance.
const {hash}=require('./evidence-basis.cjs');
const rows=x=>Array.isArray(x)?x:[],now=()=>new Date().toISOString();
const LIMIT=24;
const runIdentity=a=>a.activeAgentRun?.id||a.activeSpendRun?.id||null;
const fail=(code,message)=>Object.assign(Error(message),{code,taskId:null,noProgress:true});
const primary=(a,t)=>require('./deliverables.cjs').primary(a,t);
const intent=(j,t)=>require('./continuation-control.cjs').intentBasis(j,t);
// Bind the effective grants for every actual input. The store sequence only
// invalidates a read cache; an unrelated permission event is not a new basis.
function permissions(a,j,t){
 const store=require('./access-policy-store.cjs'),requests=store.requestsForTool(a,j,'model_request',{}, {taskId:t.id});
 const sourceIds=rows(t.sourceIds).filter(id=>!rows(t.supersededSourceIds).includes(id));
 const artifactIds=[...new Set([primary(a,t)?.id,...rows(t.steps).map(s=>s.artifactId),...rows(t.steps).map(s=>s.targetArtifactId)].filter(Boolean))];
 for(const id of sourceIds)requests.push(...store.requestsForTool(a,j,'read_source',{sourceId:id},{taskId:t.id}));
 for(const id of artifactIds)requests.push(...store.requestsForTool(a,j,'read_artifact',{artifactId:id},{taskId:t.id}));
 return requests.map(request=>{const c=store.check(a,request);return {request,allowed:c.allowed,decision:c.decision,code:c.code,policyId:c.policyId,grantRevision:c.grantRevision};}).sort((x,y)=>hash(x.request).localeCompare(hash(y.request)));
}
function scope(a,j,t){return hash({job:j.id,task:t.id,intent:intent(j,t),principal:j.platformPrincipal,platform:j.dataPlatform,permissionRevision:j.executionState?.permissionRevision||0,workRevision:j.workRevision??1,taskRevision:t.workRevision??1,permissions:permissions(a,j,t)});}
function pendingBarrier(j,t){
 return Object.values(j?.executionState?.continuation?.episodes||{}).flatMap(e=>e.taskId===t.id&&e.pendingCheck?[e.pendingCheck]:[]).find(p=>!['settled','superseded'].includes(p.status)&&!(p.status==='deferred_evidence'&&!p.claimId&&!p.claimedByRunId&&!p.claimedAt&&!p.interruption&&!rows(p.claimHistory).length));
}
// Response finality is separate from metering. A successful, retained result may
// keep its original unknown-usage reservation; only the spend guard admits B.
const receiptIdentity=r=>r&&Object.fromEntries(['attemptId','artifactId','artifactHash','baseArtifactId','baseHash','integration','originalInputHash','generationSnapshotId','scope','at'].map(k=>[k,r[k]]));
const requestIdentity=r=>({requestId:r.requestId,attempt:r.attempt,runId:r.runId,callId:r.callId,spendTicketId:r.spendTicketId});
function completedResponse(a,t,p,r){
 const proof=p.completionProof;
 if(!proof||proof.version!==1||!['result_retained','committed'].includes(p.status)||r.status!=='observed'||r.responseStatus!=='done'||r.errorCode||!r.callId||!r.spendTicketId||r.runId!==p.runId)return false;
 if(proof.attemptId!==p.attemptId||hash(proof.request)!==hash(requestIdentity(r))||proof.candidateHash!==p.candidateHash||proof.scope!==p.scope||proof.originalInputHash!==p.originalInputBasis?.hash||proof.generationSnapshotId!==p.originalGenerationSnapshot?.id)return false;
 if(p.status==='result_retained')return hash(p.candidate)===proof.candidateHash&&hash(p.candidate.content)===proof.contentHash&&hash(p.candidate.evidenceIntegration)===proof.integrationHash;
 const receipt=p.receipt,artifact=rows(a.data.artifacts).find(v=>v.id===receipt?.artifactId),receipts=rows(state(t)?.receipts).filter(v=>v.attemptId===p.attemptId);
 return !!artifact&&receipts.length===1&&hash(receiptIdentity(receipts[0]))===hash(receiptIdentity(receipt))&&receipt.attemptId===p.attemptId&&receipt.scope===proof.scope&&receipt.originalInputHash===proof.originalInputHash&&receipt.generationSnapshotId===proof.generationSnapshotId&&receipt.artifactHash===proof.contentHash&&hash(artifact.content)===proof.contentHash&&hash(receipt.integration)===proof.integrationHash;
}
const unresolved=(a,t,p)=>p.status==='unknown'||rows(p.requests).some(r=>r.status!=='observed'||r.usageReported!==true&&!completedResponse(a,t,p,r));
function assertAdvance(a,j,t,{model=false}={}){
 if(!j)return;
 if(pendingBarrier(j,t))throw fail('CHECK_REQUEST_UNRESOLVED','原稿仍有未结算的检查，须先核对原请求后再生成');
 const p=active(t),attempts=Object.values(state(t)?.attempts||{});
 // A retained response can be committed locally, but cannot issue another call.
 if(attempts.some(v=>(v!==p||v.status!=='result_retained'||model)&&unresolved(a,t,v))||p?.status==='generating'&&p.runId!==runIdentity(a))throw fail('EVIDENCE_GENERATION_UNRESOLVED','原模型请求或用量尚未核清，不能再次调用');
 if(!p)return;
 if(p.status==='failed')throw fail('EVIDENCE_CONSUMPTION_FAILED','本次证据修订未成功；须先取得新的补证依据，不能退回普通生成重试');
 if(['prepared','generating','result_retained'].includes(p.status)){
  if(!allowed(a,j,t)||!current(a,j,t,p)||permissions(a,j,t).some(c=>!c.allowed))throw fail('EVIDENCE_CONSUMPTION_STALE','原稿增量修订的原始输入或有效授权已变化');
  if(model&&p.status!=='generating')throw fail('EVIDENCE_GENERATION_UNRESOLVED','当前增量尝试只能按原状态接续，不能另发模型请求');
 }
}

function state(t){return t.evidenceConsumption;}
function active(t){const s=state(t);return s?.attempts?.[s.activeAttemptId];}
function owned(a,j,t){return !!j&&t.agentJobId===j.id&&rows(j.taskIds).includes(t.id)&&a.data.tasks.includes(t)&&a.data.delegations.includes(j);}
function allowed(a,j,t){return owned(a,j,t)&&require('./continuation-control.cjs').allowed(a,j,t)&&!t.needsReplan&&!t.evidenceRequest;}
function facts(a,j,t){
 return require('./projection-cache.cjs').memo('consumptionFacts',[a,j,t],()=>{
  const valid=new Set(require('./relation-obligations.cjs').recoveryFacts(a,j,t).map(hash)),out=new Map();
  let events;try{events=require('./work-journal.cjs').read(a).events;}catch{return [];}
  const sources=new Map(require('./relation-obligations.cjs').sourceRows(a,j,t,t.sourceIds).map(s=>[s.id,s]));
  for(const e of events){
   if(e.type!=='evidence_plan_committed'||e.entityId!==t.id||e.workRevision!==(t.workRevision??1))continue;
   const p=e.payload?.task?.set?.lastEvidenceResolution?.recoveryProof;
   for(const f of rows(p?.facts)){
    const key=hash(f.fact),s=sources.get(f.sourceId);if(!valid.has(key)||!s)continue;
    const targets=rows(p.request?.targets).filter(v=>v.kind===f.fact.kind&&rows(v.rootIds).includes(f.fact.rootId));
    if(!targets.length)continue;
    out.set(key,{factKey:key,obligationId:targets[0].obligationId,sourceId:s.id,semanticVersion:f.fact.contentHash,bindingVersion:require('./projection-cache.cjs').memo('consumptionBinding',[s,s.content,s.platformPrincipal,s.version,s.platformArchive],()=>hash({content:s.content,principal:s.platformPrincipal,version:s.version,archive:s.platformArchive})),fact:structuredClone(f.fact)});
   }
  }
  return [...out.values()].sort((x,y)=>x.factKey.localeCompare(y.factKey));
 });
}
function outstanding(a,j,t){const tried=new Set(Object.values(state(t)?.attempts||{}).filter(v=>v.intent===intent(j,t)).flatMap(v=>rows(v.targetFacts).map(f=>f.factKey)));return facts(a,j,t).filter(f=>!tried.has(f.factKey));}
function coverage(a,j,t){
 return require('./relation-obligations.cjs').coverageReady(a,j,t);
}
function current(a,j,t,p){
 const r=primary(a,t),step=rows(t.steps).find(s=>s.id===p?.stepId);
 const originalMatches=!p?.status||!!p.originalInputBasis?.hash&&!!p.originalGenerationSnapshot?.id&&step&&p.originalInputBasis.hash===require('./step-evidence.cjs').snapshot(a,t,step).hash&&p.originalGenerationSnapshot?.id===require('./revision-protocol.cjs').snapshot(a,t).id;
 return originalMatches&&!!p&&owned(a,j,t)&&p.intent===intent(j,t)&&p.scope===scope(a,j,t)&&r?.id===p.baseArtifactId&&hash(r.content)===p.baseHash&&rows(t.steps).some(s=>s.id===p.stepId&&s.kind==='draft')&&[...p.targetFacts,...rows(p.additionalFacts)].every(f=>facts(a,j,t).some(v=>v.factKey===f.factKey&&v.bindingVersion===f.bindingVersion));
}
function pendingPlan(a,j,t){return !!require('./continuation-control.cjs').episode(a,j,t)?.evidenceAcquisition?.pendingPlan;}
function inspect(a,j,t){
 if(!owned(a,j,t)||!allowed(a,j,t)||pendingPlan(a,j,t))return null;
 const episode=require('./continuation-control.cjs').episode(a,j,t);
 if(!episode||episode.blocked||episode.complete||episode.validationGrantId)return null;
 const p=active(t);
 if(require('./pending-check.cjs').inspect(a,j,{taskId:t.id}).eligible)return null;
 if(pendingBarrier(j,t))return {phase:'blocked',reason:'CHECK_REQUEST_UNRESOLVED',eligible:false,message:'旧检查请求尚未结算，不能以新输入绕过原请求。'};
 if(Object.values(state(t)?.attempts||{}).some(v=>(v!==p||v.status!=='result_retained')&&unresolved(a,t,v)))return {phase:'blocked',reason:'EVIDENCE_GENERATION_UNRESOLVED',eligible:false,message:'原模型请求或用量尚未核清，不能再次调用。'};
 if(p&&!['committed','failed','superseded'].includes(p.status)){
  if(!current(a,j,t,p))return {phase:'blocked',reason:'EVIDENCE_CONSUMPTION_STALE',eligible:false,message:'增量修订的原稿、来源或授权已变化，原尝试保留待核对。'};
  if(p.status==='unknown'||p.status==='generating'&&p.runId!==runIdentity(a))return {phase:'blocked',reason:'EVIDENCE_GENERATION_UNRESOLVED',eligible:false,message:'原增量生成可能已调用模型，须先核对原请求；不会因重启重复调用。'};
  return {eligible:true,phase:'consume',route:'consume',action:{tool:'advance_task',args:{taskId:t.id},reason:'将已取得的新证据纳入原主稿，保持原交付目标'}};
 }
 if(require('./pending-check.cjs').inspect(a,j,{taskId:t.id}).eligible)return null;
 if(permissions(a,j,t).some(c=>!c.allowed))return {phase:'blocked',reason:'CONTEXT_SCOPE_DENIED',eligible:false,message:'原稿或实际输入的授权尚未满足，不能领取增量生成。'};
 const r=primary(a,t),step=r&&rows(t.steps).find(s=>s.id===r.stepId&&s.kind==='draft');if(!step)return null;
 const targetFacts=outstanding(a,j,t).slice(0,LIMIT);if(!targetFacts.length)return p?.status==='failed'?{phase:'blocked',reason:'EVIDENCE_CONSUMPTION_FAILED',eligible:false,message:'本次证据修订没有成功，等待新的补证依据；不会再次生成相同事实。'}:null;
 const integrated=new Set(rows(state(t)?.receipts).flatMap(r=>rows(r.integration).map(f=>f.factKey)));
 const additionalFacts=facts(a,j,t).filter(f=>!integrated.has(f.factKey)&&!targetFacts.some(n=>n.factKey===f.factKey)).slice(0,Math.max(0,LIMIT-targetFacts.length));
 const proof={version:1,jobId:j.id,taskId:t.id,intent:intent(j,t),scope:scope(a,j,t),primaryLineageId:state(t)?.primaryLineageId||r.id,baseArtifactId:r.id,baseHash:hash(r.content),stepId:step.id,targetFacts,additionalFacts};
 proof.attemptId=hash(proof);
 return {eligible:false,phase:'prepare_pending',command:'evidence_consume',proof,reason:'EVIDENCE_READY_FOR_DRAFT'};
}
function applyPrepared(a,j,t,p,event){
 if(!owned(a,j,t)||!current(a,j,t,p)||state(t)?.attempts?.[p.attemptId]||permissions(a,j,t).some(c=>!c.allowed)||pendingBarrier(j,t)||Object.values(state(t)?.attempts||{}).some(v=>unresolved(a,t,v)))return;
 const s=t.evidenceConsumption ||= {version:1,primaryLineageId:p.primaryLineageId,attempts:{},receipts:[]};
 const prior=active(t);if(prior&&!['committed','failed','superseded'].includes(prior.status))return;
 require('./revision-protocol.cjs').queue(a,t,{artifactId:p.baseArtifactId,origin:'evidence_consumption',note:'将本轮已关联证据局部纳入当前主稿及其附录，保留已核实内容、读者可读性和真实受限边界。正文不写内部执行记录。具体新增事实与修改位置通过 evidenceIntegration 返回，整体完整性由后续独立检查判断。'});
 s.activeAttemptId=p.attemptId;s.attempts[p.attemptId]={...structuredClone(p),status:'prepared',preparedAt:event.at,commandId:event.commitId,requests:[],originalInputBasis:require('./step-evidence.cjs').snapshot(a,t,rows(t.steps).find(s=>s.id===p.stepId)),originalGenerationSnapshot:require('./revision-protocol.cjs').snapshot(a,t)};
 const e=require('./continuation-control.cjs').episode(a,j,t);if(e)e.revisionPending=false;
}
function selectedStep(a,j,t){const p=active(t);return p&&['prepared','generating','result_retained'].includes(p.status)&&current(a,j,t,p)?rows(t.steps).find(s=>s.id===p.stepId):null;}
function begin(a,j,t,step){
 assertAdvance(a,j,t);
 const p=active(t);if(!p||p.stepId!==step.id||!['prepared','result_retained'].includes(p.status))return null;
 if(!allowed(a,j,t)||!current(a,j,t,p))throw fail('EVIDENCE_CONSUMPTION_STALE','原稿增量修订依据已变化');
 if(p.status==='prepared')require('./state-transitions.cjs').commit(a,()=>{p.status='generating';p.runId=runIdentity(a);p.startedAt=now();});
 return p;
}
function prompt(a,j,t){const p=active(t);return p&&['generating','result_retained'].includes(p.status)?{attemptId:p.attemptId,draftOnly:true,targetFacts:p.targetFacts.map(({bindingVersion,...v})=>v),additionalFacts:rows(p.additionalFacts).map(({bindingVersion,...v})=>v),instruction:'针对targetFacts修订原主稿/附录；可在同一次调用中一并纳入additionalFacts中此前未纳入的证据，但必须至少纳入一项targetFacts。响应必须附 evidenceIntegration:[{factKey,obligationId,sectionId,quote}]，quote是修订后该章节中实际新增或修改的证据文字（至少8字符），sectionId来自原稿的稳定章节ID。没有纳入的事实不列入。该记录仅用于独立核验，不能写入业务正文；不要声称整体已完成。'}:null;}
function modelGuard(a){if(a.activeSpendTask)assertAdvance(a,a.activeAgentJob,a.activeSpendTask,{model:true});}
function beforeModel(a,{requestId,attempt,spendTicket,role,stage}){
 if(role==='execute')modelGuard(a);
 const t=a.activeSpendTask,j=a.activeAgentJob,p=t&&active(t);if(!p||p.status!=='generating'||!['execute'].includes(role)||stage==='task_verify')return;
 if(role!=='execute'||!current(a,j,t,p)||p.runId!==runIdentity(a)||!allowed(a,j,t))throw fail('EVIDENCE_CONSUMPTION_STALE','增量生成的当前身份已变化');
 if(p.requests.some(r=>r.status==='possible_dispatch'||r.status==='unknown'||r.usageReported!==true))throw fail('EVIDENCE_GENERATION_UNRESOLVED','已有模型请求结果未知，不能再次调用');
 require('./state-transitions.cjs').commit(a,()=>p.requests.push({requestId,attempt,spendTicketId:spendTicket?.id||null,runId:p.runId,status:'possible_dispatch',at:now()}));
}
function afterModel(a,meta,error){
 const p=a.activeSpendTask&&active(a.activeSpendTask),r=p?.requests?.findLast(r=>r.requestId===meta.requestId&&r.attempt===meta.attempt);if(!r)return;
 const call=rows(a.activeAgentRun?.modelCallsDetail).findLast(c=>c.requestId===meta.requestId&&c.attempt===meta.attempt)||rows(a.data.modelCalls).find(c=>c.requestId===meta.requestId&&c.attempt===meta.attempt);
 require('./state-transitions.cjs').commit(a,()=>{r.status=error&&!call?.usageReported?'unknown':'observed';r.callId=call?.id||null;r.usageReported=call?.usageReported===true;r.errorCode=error?.code||null;r.responseStatus=call?.status||null;r.finishedAt=now();});
}
function sections(content){const rows=require('./generation-context.cjs').sections({content});return rows.length?rows:[{id:'section:'+hash({identity:'document',occurrence:1}).slice(0,20),title:'全文',start:0,end:content.length}];}
function validateIntegration(a,j,t,p,result){
 if(!current(a,j,t,p))throw fail('EVIDENCE_CONSUMPTION_STALE','提交前原稿或证据发生变化');
 const before=primary(a,t).content,after=result.content;
 if(typeof after!=='string'||after===before)throw fail('EVIDENCE_NOT_INTEGRATED','原稿未产生有效证据修订，未记录消费成功');
 const afterSections=sections(after),old=sections(before);
 const entries=rows(result.evidenceIntegration),seen=new Set();if(!entries.length)throw fail('EVIDENCE_NOT_INTEGRATED','修订缺少新增事实与实际修改位置的对应，未记录消费成功');
 if(!entries.some(v=>p.targetFacts.some(f=>f.factKey===v.factKey)))throw fail('EVIDENCE_NOT_INTEGRATED','修订未纳入本轮新增事实，不能仅借旧事实取得进展');
 return entries.map(v=>{
  const f=[...p.targetFacts,...rows(p.additionalFacts)].find(f=>f.factKey===v.factKey&&f.obligationId===v.obligationId),section=afterSections.find(s=>s.id===v.sectionId),prior=old.find(s=>s.id===v.sectionId);
  const changed=section&&(!prior||before.slice(prior.start,prior.end)!==after.slice(section.start,section.end));
  if(!f||seen.has(v.factKey)||!changed||typeof v.quote!=='string'||v.quote.trim().length<8||v.quote.length>2000||!after.slice(section.start,section.end).includes(v.quote)||before.slice(prior?.start||0,prior?.end||0).includes(v.quote))throw fail('EVIDENCE_NOT_INTEGRATED','证据对应的修改位置或文字无效，未记录消费成功');
  seen.add(v.factKey);return {factKey:v.factKey,obligationId:v.obligationId,sourceId:f.sourceId,semanticVersion:f.semanticVersion,bindingVersion:f.bindingVersion,sectionId:v.sectionId,quote:v.quote};
 });
}
function retain(a,j,t,step,result){
 const p=active(t);if(!p||p.stepId!==step.id||p.status!=='generating'||result.kind!=='artifact')return;
 const integration=validateIntegration(a,j,t,p,result);
 require('./state-transitions.cjs').commit(a,()=>{p.candidate={...structuredClone(result),evidenceIntegration:integration};p.candidateHash=hash(p.candidate);p.status='result_retained';p.retainedAt=now();
  const r=rows(p.requests).at(-1);
  if(r?.status==='observed'&&r.responseStatus==='done'&&!r.errorCode&&r.callId&&r.spendTicketId&&r.runId===p.runId)p.completionProof={version:1,attemptId:p.attemptId,request:requestIdentity(r),candidateHash:p.candidateHash,contentHash:hash(p.candidate.content),integrationHash:hash(integration),scope:p.scope,originalInputHash:p.originalInputBasis.hash,generationSnapshotId:p.originalGenerationSnapshot.id,at:p.retainedAt};});
}
function candidate(a,j,t,step){assertAdvance(a,j,t);const p=active(t);if(!p||p.stepId!==step.id||p.status!=='result_retained')return null;if(!current(a,j,t,p)||hash(p.candidate)!==p.candidateHash)throw fail('EVIDENCE_CONSUMPTION_STALE','已保留的增量稿依据或完整性不符');return structuredClone(p.candidate);}
function validateCommit(a,j,t,step){const p=active(t);if(!p||p.stepId!==step.id||p.status==='committed')return;assertAdvance(a,j,t);if(p.status!=='result_retained'||hash(p.candidate)!==p.candidateHash)throw fail('EVIDENCE_CONSUMPTION_STALE','原增量候选尚未通过保存核验');}
function committed(a,j,t,step,artifact){
 const p=active(t);if(!p||p.stepId!==step.id||p.status!=='result_retained')return null;
 if(hash(p.candidate)!==p.candidateHash||p.candidate.content!==artifact.content)throw fail('EVIDENCE_CONSUMPTION_STALE','增量提交与原候选不一致');
 artifact.baseArtifactId=p.baseArtifactId;artifact.baseHash=p.baseHash;artifact.primaryLineageId=p.primaryLineageId;artifact.draftOnly=true;
 const receipt={attemptId:p.attemptId,artifactId:artifact.id,artifactHash:hash(artifact.content),baseArtifactId:p.baseArtifactId,baseHash:p.baseHash,integration:structuredClone(p.candidate.evidenceIntegration),originalInputHash:p.originalInputBasis.hash,generationSnapshotId:p.originalGenerationSnapshot.id,scope:p.scope,at:now(),verified:false};
 state(t).receipts.push(receipt);p.status='committed';p.receipt=receipt;delete p.candidate;p.committedAt=receipt.at;
 // A partial draft does not spend a failed-check cycle. Once its eventual
 // content check actually fails, it must count like every other real revision.
 const e=require('./continuation-control.cjs').episode(a,j,t);if(e)e.revisionPending=true;
 return receipt;
}
function failed(a,t,error){const p=active(t);if(!p||p.status!=='generating')return;p.status=p.requests.some(r=>r.status==='possible_dispatch'||r.status==='unknown'||r.usageReported!==true)?'unknown':'failed';p.errorCode=error?.code||'EVIDENCE_NOT_INTEGRATED';p.error=error?.message||'本次没有产生可提交的证据修订';p.finishedAt=now();}
function draftOnly(a,t){return primary(a,t)?.draftOnly===true;}
function assertDelivery(a,j,t){if(draftOnly(a,t))throw Object.assign(fail('DRAFT_EVIDENCE_INCOMPLETE','当前是增量草稿，须完成证据覆盖和当前稿检查后才能交付'),{taskId:t.id});}
function view(a,j,t){const s=state(t);if(!s)return null;const all=facts(a,j,t),integrated=new Set(rows(s.receipts).flatMap(r=>r.integration.map(f=>f.factKey))),p=active(t);return {obtained:all.length,incorporatedAwaitingCheck:!draftOnly(a,t)&&t.contentVerification?.passed&&t.contentVerification.basis===require('./execution-control.cjs').contentBasis(a,j,t)?0:all.filter(f=>integrated.has(f.factKey)).length,remaining:all.filter(f=>!integrated.has(f.factKey)).length,draftOnly:draftOnly(a,t),status:p?.status||null,lastDraftAt:rows(s.receipts).at(-1)?.at||null};}
module.exports={assertAdvance,pendingBarrier,validateCommit,active,LIMIT,sections,facts,coverage,inspect,applyPrepared,selectedStep,begin,prompt,modelGuard,beforeModel,afterModel,retain,candidate,committed,failed,draftOnly,assertDelivery,view,current};
