'use strict';
// A local time anchor is necessary, not semantic proof. The independent model
// still checks object, predicate, source and the scope of the whole assertion.
const qualification=require('./claim-qualification.cjs');
const boundary=()=>/(?:[。！？!?；;\r\n\u2028\u2029]|[.](?=\s|$))/gu;
const blank=value=>' '.repeat(value.length);
function maskLiterals(value){
 // Only literal file-content reports, never arbitrary quoted assertions. Keep
 // indices so the original, unmasked scope still goes through exact binding.
 return value.replace(/((?:文件(?:正文|内容)|正文|原文|内容)(?:中)?(?:为|是|写着|记载(?:为)?|记录(?:为)?)[：:\s]*)("(?:[^"\\]|\\.)*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』)/gu,(_all,prefix,literal)=>prefix+blank(literal));
}
function maskLimits(value){
 const lead='(?:(?:不能|无法|不可|不足以)(?:据此)?(?:证明|确认|认定)|(?:不|并不)(?:代表|表示|证明|意味着))';
 const time='(?:当前|现在|此刻|目前)',subject='(?:旧文件|文件|主稿|文稿)';
 const state='(?:'+time+subject+'?|'+subject+time+'?)?(?:已(?:经)?)?(?:交付|发送|送达|收件|部署(?:完成)?|(?:仍(?:然)?)?(?:存在|一致|有效)|状态)';
 const limitation=new RegExp('^\\s*'+lead+state+'[。！？.!?]?\\s*$','u');
 // A whole comma clause only: negation must not swallow an appended positive.
 return value.replace(/[^，,；;\r\n\u2028\u2029]+/gu,part=>limitation.test(part)?blank(part):part);
}
function anchored(scope,observedAt){
 const value=maskLimits(maskLiterals(scope)).trim().replace(/[。！？.!?]$/u,'');
 // Do not let an observation prefix authorize a subsequent current-state or
 // delivery assertion. Such assertions need separate fresh evidence.
 if(boundary().test(value)||/(?:现在|当前|此刻|目前|交付时|验收时)|已(?:经)?(?:交付|发送|送达|收件|部署)/u.test(value))return false;
 const prefix=/^(?:本轮|本次)(?:只读)?(?:核验|回读|观察|检查|比较)时[，,:：\s]/u;
 return prefix.test(value)||typeof observedAt==='string'&&value.startsWith('在'+observedAt+'时，');
}
function bind(claim,artifact,task,seen,body,observedAt,actionTitles=[]){
 if(typeof body!=='string'||!Number.isSafeInteger(claim.start))return null;
 let candidate=claim.qualification;
 if(candidate===undefined){
  // Only the containing sentence; never borrow an earlier paragraph, title,
  // another record or an observation after the target proposition.
  let start=0,end=body.length;for(const m of maskLiterals(body).matchAll(boundary())){
   if(m.index+m[0].length<=claim.start)start=m.index+m[0].length;
   else if(m.index+m[0].length>=claim.start+claim.text.length){end=m.index+m[0].length;break;}
  }
  const raw=body.slice(start,end),left=raw.length-raw.trimStart().length;
  candidate={field:claim.field,quote:raw.trim(),start:start+left};
 }
 const scope=qualification.validate({...claim,qualification:candidate},artifact,task,seen,actionTitles);
 return scope&&anchored(scope.quote,observedAt)?scope:null;
}
const instruction='仅时点证据的每条结论（含fact）用qualification绑定同句的观察时点与完整结论；可写“本轮只读核验时，…”或“在<observedAt>时，…”。该时点之外的当前状态、交付须另有新鲜证据，不能借时点前缀放行后续肯定断言。';
module.exports={bind,anchored,instruction};
