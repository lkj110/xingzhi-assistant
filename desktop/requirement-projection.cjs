'use strict';
// Project authoritative events; never infer semantic deletion of a shared goal.
const {hash}=require('./evidence-basis.cjs');
const rows=v=>Array.isArray(v)?v:[];
const lines=v=>String(v||'').split(/\n+/).map(s=>s.trim()).filter(Boolean);
function afterContract(entry,contract){
 if(!contract)return true;
 if(Number.isSafeInteger(entry.workSequence)&&Number.isSafeInteger(contract.workSequence))return entry.workSequence>contract.workSequence;
 return entry.at>contract.updatedAt;
}
function compare(a,b){
 if(Number.isSafeInteger(a.workSequence)&&Number.isSafeInteger(b.workSequence))return a.workSequence-b.workSequence;
 return String(a.at||'').localeCompare(String(b.at||''))||(a.workSequence||0)-(b.workSequence||0);
}
function canonicalText(entry){
 const text=String(entry.text||'').trim();
 return entry.taskId&&['task_revision','task_feedback'].includes(entry.kind)?text.replace(/^事项「[^\n]*」收到补充：/u,''):text;
}
function directives(job,{task}={}){
 const contract=job?.executionContract,seen=new Map();
 for(const r of [...rows(job?.userDirectives),...rows(job?.feedback)].filter(r=>r.text&&(!task||!r.taskId||r.taskId===task.id)&&!['authorization','user_lark_policy','source_update'].includes(r.origin)&&afterContract(r,contract)).sort(compare)){
  const text=canonicalText(r),key=hash([r.taskId||null,text]);
  seen.delete(key);seen.set(key,{...r,text,...(r.originEventId||r.eventId?{eventId:r.originEventId||r.eventId}:{})});
 }
 return [...seen.values()];
}
function taskEvents(job,task){
 return [...directives(job,{task}).map(r=>({...r,requirementKind:'directive'})),...rows(task.notes).filter(r=>(!r.kind||['revise','feedback'].includes(r.kind))&&afterContract(r,job?.executionContract)).map(r=>({...r,requirementKind:'note'}))].sort(compare);
}
function project(job,task){
 const goal=job?.executionContract?.text||job?.goal||'',history=rows(task?.requirementHistory);
 const current=new Set(['description','objective','criteria'].flatMap(k=>lines(task?.[k])));
 const replaced=new Set(history.flatMap(r=>['description','objective','criteria'].flatMap(k=>lines(r[k]))).filter(s=>!current.has(s)));
 // Exact old task fields can be retired from a single-task original goal. A
 // shared/compound obligation or a later explicit contract is never guessed away.
 const superseded=!job?.executionContract&&task?.userRequirement&&rows(job?.taskIds).length===1?lines(goal).filter(s=>replaced.has(s)):[];
 return {goal:lines(goal).filter(s=>!superseded.includes(s)).join('\n'),userDirectives:directives(job,{task}),
  requirementPrecedence:{taskId:task?.id||null,currentRevision:task?.userRequirement?.revision||null,supersededGoalLines:superseded.map(text=>({textHash:hash(text)})),
   historyRefs:history.map(r=>({revision:r.revision,textHash:hash([r.description,r.objective,r.criteria])})),
   instruction:'当前事项字段与后续用户补充按版本生效；supersededGoalLines 仅供追溯，不是待满足要求。未明确替代的共享义务、权限和来源限制继续保留；原始委托与补充冲突时仅在补充明确作用的事项范围内采用后者。'}};
}
module.exports={directives,project,canonicalText,afterContract,compare,taskEvents};
