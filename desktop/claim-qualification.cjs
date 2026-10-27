'use strict';
// Local checks prove an exact, visible scope. The independent reviewer must
// still judge whether that scope semantically qualifies THIS entire claim.
const fields=new Set(['content','artifactTitle','taskTitle','actionTitle']);
const key=(id,field,actionId)=>field==='taskTitle'?'taskTitle':field==='actionTitle'?'action:'+actionId:id+':'+field;
function observe(seen,input){
 seen.claimFields ||= new Map();
 const add=(id,field,body,start,actionId)=>{if(typeof body!=='string'||!body)return;const k=key(id,field,actionId),rows=seen.claimFields.get(k)||[];rows.push({body,start});seen.claimFields.set(k,rows);};
 for(const r of [...(input.artifacts||[]),...(input.workingDraft?[input.workingDraft]:[])]){add(r.id,'content',r.content);add(r.id,'artifactTitle',r.title);}
 if(input.revision){add(input.revision.artifactId,'content',input.revision.originalContent);add(input.revision.artifactId,'artifactTitle',input.revision.originalTitle);}
 for(const r of [...(input.contextReads||[]).map(r=>r.result),...(input.generationEvidence||[])])if(r?.artifactId)add(r.artifactId,'content',r.content,r.start);
 const request=input.groundingReviewRequest;
 add(null,'taskTitle',request?.taskTitle);add(null,'taskTitle',input.task?.title);
 for(const r of request?.artifactTitles||[])add(r.artifactId,'artifactTitle',r.title);
 for(const r of request?.actionTitles||[])add(r.artifactId,'actionTitle',r.title,undefined,r.actionId);
}
function span(body,quote,start){
 if(typeof quote!=='string'||!quote.trim())return null;
 const first=body.indexOf(quote);
 if(start===undefined){if(first<0||body.indexOf(quote,first+1)>=0)return null;start=first;}
 if(!Number.isSafeInteger(start)||start<0||body.slice(start,start+quote.length)!==quote)return null;
 return {start,end:start+quote.length};
}
// Empty lines, headings, list items and a repeated record field divide scopes.
// This deliberately supports only plain paragraphs / unambiguous keyed records.
function sameRecord(body,start,end){
 const lines=body.split('\n');let offset=0,boundary=0;const labels=new Set();let first=true;
 for(const line of lines){const trimmed=line.trim(),heading=/^#{1,6}\s|^[-*+]\s|^\d+[.)、]\s*/.test(trimmed),raw=trimmed.match(/^([^:：\n]{1,30})[:：]/)?.[1]?.normalize('NFKC').replace(/\s+/g,'').toLowerCase(),field=['答案','结论','answer','conclusion'].includes(raw)?'answer':raw;
  if(!trimmed||heading||field&&labels.has(field)){if(start<offset&&end>offset)return false;boundary=offset;labels.clear();}
  if(field)labels.add(field);
  if(offset<=start&&start<offset+line.length+1)first=false;
  if(!first&&end<=offset+line.length)return start>=boundary;
  offset+=line.length+1;
 }
 return false;
}
function validate(claim,artifact,task,seen,actionTitles=[]){
 const q=claim.qualification;
 if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['field','quote','start'].includes(k))||!fields.has(claim.field)||q.field!==claim.field||typeof q.quote!=='string'||q.quote.length>3000||!artifact)return null;
 const action=actionTitles.find(r=>r.actionId===claim.actionId&&r.artifactId===artifact.id);
 const body=claim.field==='content'?artifact.content:claim.field==='artifactTitle'?artifact.title:claim.field==='taskTitle'?task.title:action?.title;
 if(typeof body!=='string')return null;
 const scope=span(body,q.quote,q.start);if(!scope)return null;
 // The full claim occurs exactly once in its scope unless explicitly located.
 const within=q.quote.indexOf(claim.text);
 const start=claim.start??(within>=0&&q.quote.indexOf(claim.text,within+1)<0?scope.start+within:undefined);
 if(start===undefined)return null;
 const target=span(body,claim.text,start);if(!target||target.start<scope.start||target.end>scope.end)return null;
 if(claim.field==='content'?!sameRecord(body,scope.start,scope.end):scope.start!==0||scope.end!==body.length)return null;
 const ranges=[];for(const part of seen.claimFields?.get(key(artifact.id,claim.field,claim.actionId))||[]){const located=span(body,part.body,part.start);if(located)ranges.push(located);}
 let cursor=scope.start;for(const r of ranges.sort((a,b)=>a.start-b.start)){if(r.end<=cursor)continue;if(r.start>cursor)break;cursor=Math.max(cursor,r.end);}
 if(cursor<scope.end)return null;
 return {field:claim.field,artifactId:artifact.id,...(action?{actionId:action.actionId}:{}),claimStart:target.start,claimEnd:target.end,start:scope.start,end:scope.end,quote:q.quote};
}
// Recognize complete epistemic-limit clauses, not a keyword anywhere in a
// paragraph. This supplies an exact visible binding, never semantic support.
function explicitUnknown(text){
 if(typeof text!=='string'||text.length>600)return false;
 const body='[^，。！？；,.;!?\\r\\n\\u2028\\u2029]',clause=body+'+',end='[。！？.!?]?';
 return [
  `^(?:现|目前|当前|本轮)?(?:无|没有|尚无)(?:材料|资料|证据)(?:足以|能够|可)?(?:决定取舍|选定唯一答案|确定唯一结果)${end}$`,
  `^(?:(?:现有|已有|当前|本轮)的?)?(?:资料|记录|证据)(?:中)?(?:尚)?未(?:进一步)?(?:说明|提供|给出|记载|证实|表明)${clause}${end}$`,
  `^(?:目前|现阶段|据此|仍)?(?:不能|无法|不足以)(?:认定|证明|确认|断定)${clause}${end}$`,
  `^${clause}未在(?:(?:现有|当前|本轮)(?:的)?)?(?:资料|记录|证据)中(?:提供|说明|给出|记载)(?:，(?:不据此|不能据此)(?:确认|认定)(?:已完成|已执行|已经完成))?${end}$`,
  `^(?:上述|该|本次|这些)${body}{0,60}(?:范围|安排|时间|状态|清单)(?:仅)?(?:是|为)(?:计划|拟定|预定|待办)${body}*，不(?:表示|代表|证明)${clause}${end}$`
 ].some(pattern=>new RegExp(pattern,'u').test(text));
}
function implicit(claim,artifact,task,seen,actionTitles=[]){
 if(claim.kind!=='unknown'||claim.qualification!==undefined||!explicitUnknown(claim.text))return null;
 return validate({...claim,qualification:{field:claim.field,quote:claim.text,start:claim.start}},artifact,task,seen,actionTitles);
}
function instructionFor({structured=false}={}){return `首次报告中每条非 fact 结论都提供${structured?'qualification绑定同一字段中包含完整结论及限定语的当前稿逐字作用域':'qualification:{field:"同一字段",quote:"包含完整结论及限定语的当前稿逐字作用域",start:可选}'}；正文必须有真实限定，text已完整表达限制时quote就用text（标题须完整），不能省略绑定或仅在reason解释。相邻限定和不常见表达也按同一规则绑定，语义不要求固定提示词。确定性标签用于限定结论，无独立业务断言时不另造claim。${structured?'claim.field明确正文或对应标题，actionTitle另带actionId':'claim用field:"content|artifactTitle|taskTitle|actionTitle"（actionTitle另带actionId）'}；正文范围限同一普通段落或连续结构记录，不跨空段、标题、列表项或重复字段；标题范围须是完整标题。重复text用claim.start定位，重复quote用qualification.start。独立判断该范围确实限定该条完整结论，不能借另一对象的未知，不能把混合肯定断言藏进unknown/inference；不成立则supported:false并指出缺口。原文锚点只证明位置，不能证明语义成立。`;}
const instruction=instructionFor();
module.exports={observe,validate,implicit,explicitUnknown,sameRecord,instruction,instructionFor};
