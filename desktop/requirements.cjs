// User edits are authoritative. Agent-generated plan wording is a projection.
const crypto=require('node:crypto');
const basis=()=>require('./evidence-basis.cjs');
function edit(task,changes,origin='user_edit') {
 const fields=['description','objective','criteria'];
 if(!fields.some(k=>Object.hasOwn(changes,k)&&changes[k]!==task[k]))return false;
 const previous=task.userRequirement;
 if(previous)(task.requirementHistory ||= []).push(structuredClone(previous));
 task.userRequirement={revision:crypto.randomUUID(),origin,at:new Date().toISOString(),...Object.fromEntries(fields.map(k=>[k,Object.hasOwn(changes,k)?changes[k]:task[k]||'']))};
 return true;
}
function text(task){return task.userRequirement?.criteria??task.criteria;}
function directives(job){
 const rows=[...(job.userDirectives||[]),...(job.feedback||[])];
 const accepted=rows.filter(f=>f.text&&!['authorization','user_lark_policy','source_update'].includes(f.origin)&&(!job.executionContract?.updatedAt||f.at>job.executionContract.updatedAt));
 return [...new Map(accepted.map(f=>[basis().hash([f.at,f.text]),{text:f.text,kind:f.kind,taskId:f.taskId}])).values()];
}
function intent(job,task){
 return {contract:job?.executionContract?.revision||job?.goal,user:job?directives(job):[],edit:task?.userRequirement?.revision||null};
}
function retain(current,restored){
 for(const task of restored.tasks||[]){const live=current.tasks?.find(t=>t.id===task.id);if(live?.userRequirement){task.userRequirement=structuredClone(live.userRequirement);task.requirementHistory=structuredClone(live.requirementHistory||[]);Object.assign(task,Object.fromEntries(['description','objective','criteria'].map(k=>[k,task.userRequirement[k]])));}}
 for(const job of restored.delegations||[]){const live=current.delegations?.find(j=>j.id===job.id);if(live){for(const key of ['executionContract','contractHistory','userDirectives','executionState'])if(live[key])job[key]=structuredClone(live[key]);}}
}
module.exports={edit,text,intent,directives,retain};
