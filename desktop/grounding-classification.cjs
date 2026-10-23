'use strict';
// A report/body classification mismatch warrants one fresh independent check,
// never a local relabelling or an exception to evidence validation.
const instruction='\n这是一次有界分类复核。groundingClassificationReview仅报告上次检查的分类或限定作用域缺口，不预设应该通过。重新完整核对当前稿、标题、要求及本次实际提供的原文，返回完整核验报告。每个目标结论须在新claims中保留artifactId、field、start（结论位置）、actionId（如有）和完整精确text，可换ID或添加符合规则的qualification。unknown/inference/proposal均须判断限定是否约束该完整结论；已有明确限定但未绑定时补齐qualification，text自身表达限制可用自身作quote。直接同义复述与实质推理按原规则区分；真实推断未标注、依据不足或无法完成核验，必须passed:false。不得仅为消除错误而改标签、删掉结论或改变正文。只返回检查结论，不再请求资料。';
function request(result,checked){
 if(result?.passed!==true||typeof result.summary!=='string'||!result.summary.trim()||!Array.isArray(result.gaps)||result.gaps.length||checked?.grounding?.reused||checked?.grounding?.passed!==false)return null;
 const report=checked.grounding,issues=report.classificationIssues;
 if(report.classificationOnly===false)return null;
 if(!Array.isArray(issues)||!issues.length||issues.length>8)return null;
 const claims=[];
 for(const issue of issues){
  const claim=report.claims.find(c=>c.id===issue.claimId);
  if(!['QUALIFICATION_MISSING','INFERENCE_MARKER_MISSING'].includes(issue.code)||!claim||!['inference','unknown','proposal'].includes(claim.kind)||claim.kind==='inference'&&!claim.citations.length||claim.artifactId!==issue.artifactId||claim.text!==issue.text)return null;
  if(!claim.field||!Number.isSafeInteger(claim.start))return null;
  const original=result.groundingReview?.claims?.find(c=>c.id===claim.id);
  claims.push({claimId:claim.id,artifactId:claim.artifactId,field:claim.field,start:claim.start,actionId:claim.actionId,allowImplicitField:original?.field===undefined,allowImplicitStart:original?.start===undefined,text:claim.text,reportedKind:claim.kind,issue:'当前结论片段或绑定限定范围未通过本地标注检查，需独立核对实际标注、原文及分类'});
 }
 return {claims};
}
function retain(result,request){
 const claims=(Array.isArray(result?.groundingReview?.claims)?result.groundingReview.claims:[]).map(c=>{const target=request.claims.find(t=>t.artifactId===c?.artifactId&&t.text===c?.text&&t.actionId===c?.actionId);return {...c,...(target?.allowImplicitField&&c.field===undefined?{field:target.field}:{}),...(target?.allowImplicitStart&&c.start===undefined?{start:target.start}:{})};});
 if(!result||result.retryFull===true||result.kind==='read_context'||result.tool==='read_context'||request.claims.some(target=>!claims.some(c=>c?.artifactId===target.artifactId&&c.field===target.field&&c.start===target.start&&c.actionId===target.actionId&&c.text===target.text)))return {...result,retryFull:false,passed:false,gaps:[...(Array.isArray(result?.gaps)?result.gaps:[]),'分类复核未保留完整目标结论或未返回完整检查结果']};
 return {...result,groundingReview:{...result.groundingReview,claims}};
}
module.exports={request,retain,instruction};
