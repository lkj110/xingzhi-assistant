const {modelError}=require('./model-errors.cjs');
const kinds=new Set(['needs_evidence','needs_replan']);
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
function normalize(a,task,result,basis){
 if(!kinds.has(result?.kind))return null;
 const gaps=result.gaps,requirements=result.requirements||[];
 if(!text(result.summary,3000)||!Array.isArray(gaps)||!gaps.length||gaps.length>20||gaps.some(g=>!text(g,2000))||!Array.isArray(requirements)||requirements.length>20||requirements.some(r=>!text(r,500)))throw modelError('MODEL_INVALID_RESPONSE','补证请求必须包含明确缺口和接续原因',true);
 if(result.artifactId){
  const rows=a.data.artifacts.filter(r=>r.id===result.artifactId&&r.taskId===task.id&&!r.stale);
  const job=a.data.delegations.find(j=>j.id===task.agentJobId);
  if(rows.length!==1||!require('./protocol-access.cjs').allowedObject(a,'artifact',rows[0],job,task))throw modelError('MODEL_INVALID_RESPONSE','补证请求引用了不可读取或不属于本事项的稿件',true);
 }
 const evidence=require('./evidence-basis.cjs'),inputFacts=evidence.taskSources(a,task).map(v=>evidence.hash(v));
 return {kind:result.kind,summary:result.summary.trim(),gaps:gaps.map(g=>g.trim()),requirements:requirements.map(r=>r.trim()),...(result.artifactId?{artifactId:result.artifactId}:{}),at:new Date().toISOString(),basis,inputFacts};
}
function resolution(a,job,task,next,args,{structural=false,bindingChanged=false}={}){
 const requested=args.evidenceResolution;
 if(requested===undefined)return null;
 const current=task?.evidenceRequest,evidence=require('./evidence-basis.cjs');
 if(!current||requested?.basis!==current.basis||!text(requested.reason,2000))throw Error('补证接续需要当前 evidenceRequest.basis 和具体说明');
 const ids=requested.sourceIds||[],keys=requested.operationKeys||[];
 if(!Array.isArray(ids)||!Array.isArray(keys)||ids.length>20||keys.length>20||ids.some(id=>typeof id!=='string'||!next.sourceIds.includes(id))||keys.some(k=>typeof k!=='string'))throw Error('补证回执必须引用已关联的来源或真实操作 key');
 const sources=ids.map(id=>a.data.sources.find(s=>s.id===id));
 if(sources.some(s=>!s||!require('./protocol-access.cjs').allowedObject(a,'source',s,job)))throw Error('补证来源不可读取');
 const sourceChanged=Array.isArray(current.inputFacts)&&sources.some(s=>!current.inputFacts.includes(evidence.hash(evidence.version(s,next,job))));
 const operations=keys.map(k=>job.executionState?.operations?.[k]);
 if(operations.some(o=>!o||!['done','failed'].includes(o.status)||!require('./operation-ledger.cjs').valid(job,o,a)||!(Date.parse(o.completedAt)>=Date.parse(current.at))))throw Error('补证操作回执无效、已过期或早于请求');
 if(!sourceChanged&&!operations.length&&!(current.kind==='needs_replan'&&(structural||bindingChanged)))throw Error('补证尚无新依据；请先取得并关联证据，或修正明确的计划/主稿绑定');
 return {basis:current.basis,reason:requested.reason,sourceIds:ids,operationKeys:keys,at:new Date().toISOString()};
}
function view(request){if(!request)return request;const {inputFacts,inputSourceBasis,...result}=request;return result;}
const prompt='\n对于 Agent 委托，若缺少必须由平台/网页/扩展能力取得的新证据，返回 {"kind":"needs_evidence","summary":"下一步需要取得什么","gaps":["具体证据缺口"],"requirements":["对应要求ID"],"artifactId":"需要补证的已有稿件ID（可省略）"}；若当前步骤或主稿绑定与业务目标不符，返回 kind=needs_replan、summary、gaps。App 会交回上层 Agent 选择已授权工具。此返回不授予权限、不执行外部动作、不生成代替结果的缺证报告，也不要求用户代查。已有资料仍先read_context；真正需要用户决定、授权或提供无法自动取得的信息才need_input。';
module.exports={kinds,normalize,resolution,view,prompt};
