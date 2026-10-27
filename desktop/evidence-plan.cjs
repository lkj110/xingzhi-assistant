'use strict';
// Plans coordinate reads; they never certify an answer or grant source access.
const protocol=require('./task-context.cjs'),{contextError}=require('./model-errors.cjs');
const localErrors=new WeakSet();
function invalid(field,reason){const error=contextError('CONTEXT_INVALID_REQUEST',{message:`取证计划 ${field}：${reason}`,planField:field,safeAlternatives:['仅修正所列计划字段，保留当前要求、真实证据和未完成读取；正文仍须独立核验。']});localErrors.add(error);throw error;}
function plan(a,task,value){
 if(value===undefined)return null;
 const requirements=require('./grounding.cjs').requirements(a,task),ids=new Set(requirements.map(r=>r.id));
 if(!Array.isArray(value)||value.length>80)invalid('evidencePlan','须为至多 80 项的数组');
 const seen=new Set(),tools=new Set(require('./tool-evidence.cjs').current(a,task).map(r=>r.id));
 return value.map((r,i)=>{
  const at=field=>`evidencePlan[${i}].${field}`;
  if(!r||typeof r!=='object'||Array.isArray(r))invalid(`evidencePlan[${i}]`,'须为对象');
  if(!ids.has(r.requirementId)||seen.has(r.requirementId))invalid(at('requirementId'),'须为当前且不重复的要求 ID');
  const question=r.question===undefined?'':r.question;
  if(typeof question!=='string'||question.length>300)invalid(at('question'),'可省略；提供时须为不超过 300 字符的说明');
  if(typeof r.gap!=='string'||r.gap.length>500)invalid(at('gap'),'须保留缺口说明（无缺口用空串），不超过 500 字符');
  if(!Array.isArray(r.readRequests)||r.readRequests.length>4||r.readRequests.some(q=>!q||typeof q!=='object'||Array.isArray(q)))invalid(at('readRequests'),'须保留至多 4 项读取请求数组，完成时为空数组');
  if(!Array.isArray(r.evidenceIds)||r.evidenceIds.length>16||r.evidenceIds.some(id=>typeof id!=='string'||!id||id.length>300))invalid(at('evidenceIds'),'须为至多 16 个有界引用 ID');
  const evidenceIds=[...new Set(r.evidenceIds)].filter(id=>tools.has(id)||(task.generationReads||[]).some(row=>protocol.validRead(a,protocol.taskScope(task),row)&&[row.result.ref,row.result.sourceId].includes(id)));
  const unverifiedEvidenceIds=r.evidenceIds.filter(id=>!evidenceIds.includes(id));
  const gap=unverifiedEvidenceIds.length?`${r.gap.slice(0,440)}${r.gap?'；':''}存在尚未证明为当前已读的引用，须补读或保留未知。`:r.gap;
  seen.add(r.requirementId);
  return {requirementId:r.requirementId,question,evidenceIds,readRequests:structuredClone(r.readRequests),gap,...(unverifiedEvidenceIds.length?{unverifiedEvidenceIds}:{}),state:r.readRequests.length?'unread':gap?'gap':'read_not_verified'};
 });
}
const repairable=error=>localErrors.has(error);
function retainsReads(original,repaired,allowedIds=[]){
 const hash=require('./evidence-basis.cjs').hash,rows=Array.isArray(original)?original:[];
 const requests=rows.flatMap(r=>Array.isArray(r?.readRequests)?r.readRequests:[]).filter(r=>r&&typeof r==='object'&&!Array.isArray(r));
 const after=repaired.flatMap(r=>Array.isArray(r?.readRequests)?r.readRequests:[]);
 if(!requests.every(request=>after.some(r=>hash(r)===hash(request))))return false;
 // Correct a malformed field without erasing an otherwise valid requirement,
 // its evidence, or its declared gap. Invalid IDs may be mapped to current IDs.
 return rows.filter(r=>allowedIds.includes(r?.requirementId)).every(before=>{
  const next=repaired.find(r=>r?.requirementId===before.requirementId);if(!next)return false;
  if(typeof before.gap==='string'&&before.gap.length<=500&&next.gap!==before.gap)return false;
  const ids=Array.isArray(before.evidenceIds)?before.evidenceIds.filter(id=>typeof id==='string'&&id&&id.length<=300):[];
  if(!ids.every(id=>next.evidenceIds?.includes(id)))return false;
  return (Array.isArray(before.readRequests)?before.readRequests:[]).filter(r=>r&&typeof r==='object'&&!Array.isArray(r)).every(request=>(next.readRequests||[]).some(r=>hash(r)===hash(request)));
 });
}
const repairInstruction='\n仅修复 evidencePlanRepair 指定的取证计划字段，返回 {"evidencePlan":[...]}。question 可省略；requirementId 必须为当前清单，evidenceIds、readRequests、gap 必须保留。只改元数据，原正文由应用原样保留；不增加权限、不捏造引用、不删除未完成读取来宣称完成。不返回正文或工具动作。';
module.exports={plan,repairable,retainsReads,repairInstruction};
