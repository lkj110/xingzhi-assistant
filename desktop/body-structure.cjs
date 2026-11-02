'use strict';
// A deliberately narrow, platform-independent guard for standalone prose.
// Unsupported wording/layout is left to the existing semantic verifier. This
// module never edits prose or removes requirements from the model context.
const {hash}=require('./evidence-basis.cjs');
const VERSION=1;
const instruction='\n标题放在 title 字段，content 仅放正文；修订 originalContent 时同样不要加入重复标题。明确要求的自然段以空行分隔。';
const rows=v=>Array.isArray(v)?v:[];
const numbers=['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
const numeral=s=>s==='两'?2:/^\d+$/.test(s)?Number(s):numbers.indexOf(s);
function extract(value){
 if(typeof value!=='string'||value.length>16000)return [];
 // Context can span blank lines. Decline the whole field rather than treating
 // the middle of a fenced/quoted/example block as an authoritative directive.
 if(/示例|样例|例如|比如|举例|示范|参考|引用|摘录|假设|如果|若|除非|历史|旧稿|旧要求|此前|之前|原来|曾经|不需要|不必|无需|不限|不要求|不强制|可以不|可不|```|~~~/u.test(value)||/^\s*[>#]/m.test(value))return [];
 const unquoted=value.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/gu,' ');
 if(/[“”‘’「」『』"'`]/u.test(unquoted))return [];
 const found=[];
 for(const block of unquoted.replace(/\r\n?/g,'\n').split(/\n\s*\n/)){
  for(const sentence of block.split(/[。；;！？!?\n]+/u).map(s=>s.trim())){
   const match=sentence.match(/^(?:请\s*)?(?:(?:将|把)\s*正文\s*(?:改|调整|修改)为|正文\s*(?:必须|须|应)?\s*(?:改为|为|是|写成)?)\s*恰好\s*([一二三四五六七八九十两零\d]+)\s*个?自然段(?=$|[，,：:])/u);
   if(!match||/但|或者|也可|不必|无需|不限|不要求|不强制/u.test(sentence.slice(match[0].length)))continue;
   const count=numeral(match[1]);
   if(Number.isSafeInteger(count)&&count>=1&&count<=20)found.push({count,quote:match[0]});
  }
 }
 return found;
}
function newerThanEdit(note,edit){
 if(!edit)return true;
 if(Number.isSafeInteger(note.workSequence)&&Number.isSafeInteger(edit.workSequence))return note.workSequence>edit.workSequence;
 const n=Date.parse(note.at),e=Date.parse(edit.at);return Number.isFinite(n)&&Number.isFinite(e)&&n>e;
}
function rule(a,task){
 if(!task||task.agentJobId)return null;
 const steps=rows(task.steps).filter(s=>['draft','analysis'].includes(s.kind));
 if(steps.length!==1||steps[0].kind!=='draft')return null;
 const step=steps[0],notes=rows(task.notes).filter(n=>['revise','feedback'].includes(n.kind)&&newerThanEdit(n,task.userRequirement));
 let inputs,original;
 if(notes.length){
  const note=notes.at(-1);
  // Never infer the target of legacy/agent feedback or resurrect an older note.
  if(note.kind!=='revise'||note.origin!=='user'||note.legacyTargetUnresolved||note.targetStepId!==step.id)return null;
  const matches=rows(a.data.artifacts).filter(r=>r.id===note.targetArtifactId&&r.taskId===task.id&&r.stepId===step.id);
  if(matches.length!==1||note.baseHash!==hash(matches[0].content))return null;
  original=matches[0];
  if(!require('./protocol-access.cjs').allowedObject(a,'artifact',original,undefined,task))return null;
  inputs=[{field:'revision',id:note.id,text:note.text,originalArtifactId:original.id,originalContentHash:note.baseHash}];
 }else{
  inputs=[{field:task.objective?'objective':'description',text:task.objective||task.description},{field:'criteria',text:task.criteria}];
 }
 const parsed=inputs.map(input=>({input,matches:extract(input.text)}));
 // A related but unsupported field may withdraw or qualify another field.
 // Losing it during extraction must not manufacture an unconditional rule.
 if(parsed.some(({input,matches})=>!matches.length&&/自然段|段数|段落|分段|格式|正文[\s\S]*段|[一二三四五六七八九十两零\d]+个?段|paragraph/iu.test(input.text||'')))return null;
 const requirements=parsed.flatMap(({input,matches})=>matches.map(match=>({...input,...match,textHash:hash(input.text)})));
 if(!requirements.length||new Set(requirements.map(r=>r.count)).size!==1)return null;
 return {step,original,expected:requirements[0].count,requirements};
}
function inspect(a,task){
 const declared=rule(a,task);
 if(!declared)return {status:'not-applicable'};
 const {step,original,expected,requirements}=declared;
 const current=require('./deliverables.cjs').current(a,task);
 if(!step.done||current.length!==1||current[0].id!==step.artifactId||current[0].stepId!==step.id)return {status:'unsupported',reason:'current-draft-target-ambiguous'};
 const artifact=current[0];
 if(original&&artifact.id!==original.id&&!rows(artifact.generationSnapshot?.artifacts).some(r=>r.artifactId===original.id&&r.stepId===step.id&&r.hash===hash(original.content)))return {status:'unsupported',reason:'revision-lineage-unproven'};
 const content=artifact.content;
 if(typeof content!=='string')return {status:'unsupported',reason:'non-text-content'};
 const normalized=content.replace(/\r\n?/g,'\n');
 // Plain prose only: do not invent Markdown/list/table/code paragraph rules.
 if(/^[\t ]*(?:#{1,6}\s|>|[-+*]\s|\d+[.)、]\s|`{3}|~{3}|\|)/m.test(normalized)||/^(?: {4}|\t)\S|^[\t ]*(?:=+|-{3,}|\*{3,}|_{3,})[\t ]*$/m.test(normalized)||/<\/?[a-z][^>]*>|[\u2028\u2029]/iu.test(normalized))return {status:'unsupported',reason:'non-prose-layout'};
 const actual=normalized.trim()?normalized.trim().split(/\n[^\S\n]*\n(?:[^\S\n]*\n)*/u).length:0;
 const identity={version:VERSION,taskId:task.id,artifactId:artifact.id,titleHash:hash(artifact.title),contentHash:hash(content),requirementsHash:hash(requirements)};
 return {...identity,basis:hash(identity),status:'checked',expected,actual,passed:actual===expected,requirements:requirements.map(({text,...r})=>r)};
}
function gap(check){return `正文结构未满足要求：须恰好${check.expected}个自然段，当前正文有${check.actual}段。标题字段独立；正文中的重复标题仍计入正文。`;}
function finish(a,task,result){
 const check=inspect(a,task);
 if(check.status!=='checked')return result;
 // This is the verdict AFTER existing evidence validation, not raw model text.
 const bodyStructure={...check,preStructurePassed:result.passed,preStructureSummary:result.summary};
 if(check.passed)return {...result,bodyStructure};
 const message=gap(check);
 return {...result,bodyStructure,passed:false,summary:message,gaps:[...new Set([...rows(result.gaps),message])]};
}
module.exports={VERSION,instruction,extract,rule,inspect,gap,finish};
