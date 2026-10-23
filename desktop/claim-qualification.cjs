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
const instruction='非 fact 结论若其 text 未包含限定语，可附 field:"content|artifactTitle|taskTitle|actionTitle"（actionTitle 另带 actionId） 和 qualification:{field:"同一字段",quote:"包含完整结论及限定语的当前稿逐字作用域",start:可选}；text 自身完整表达限制时 quote 可等于 text。正文范围限同一普通段落或连续结构记录，不跨空段、标题、列表项或重复字段；标题范围须是完整标题。重复 text 用 claim.start 定位，重复 quote 用 qualification.start。独立判断该范围确实限定该条完整结论，不能借另一对象的未知，不能把混合肯定断言藏进 unknown/inference；不成立则 supported:false 并指出缺口。原文锚点只证明位置，不能证明语义成立。';
module.exports={observe,validate,sameRecord,instruction};
