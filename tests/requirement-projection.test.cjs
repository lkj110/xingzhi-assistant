'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),ground=require('../desktop/grounding.cjs'),projection=require('../desktop/requirement-projection.cjs');
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'requirement-projection-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));
 const a=new Assistant({dir,chat:async()=>{throw Error('No real calls');}});a.data.settings.evidenceGrounding=true;
 a.data.providers.push({id:'offline',name:'offline',model:'offline',baseUrl:'http://127.0.0.1:1',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'offline',execute:'offline',verify:'offline'};
 const task=a.createTask({title:'介绍',description:'按方案 Q1 撰写完整说明。',criteria:'保持四节并保留未知边界。',steps:[{title:'稿件',kind:'draft'}]});
 const job=agent.buildJob(a,{goal:task.description+'\n不得发送通知。',autoAccept:false});job.taskIds=[task.id];task.agentJobId=job.id;a.data.delegations.push(job);a.save();return {a,task,job,dir};
}
test('trusted task update retires exact old goal line, retains common obligations and survives restart',async t=>{
 const f=setup(t),old=f.task.description;
 await f.a.dispatch('updateTask',{id:f.task.id,description:'现改选方案 Q2，完整修订。'});
 const list=ground.requirements(f.a,f.task);assert.ok(!list.some(r=>r.text===old));assert.ok(list.some(r=>r.text==='不得发送通知。'));
 assert.ok(list.some(r=>r.text===f.task.criteria));assert.equal(f.job.goal,old+'\n不得发送通知。');
 assert.ok(f.task.requirementHistory.some(r=>r.description===old));assert.equal(projection.project(f.job,f.task).requirementPrecedence.supersededGoalLines.length,1);
 const a=new Assistant({dir:f.dir});assert.deepEqual(ground.requirements(a,a.task(f.task.id)),list);
});
test('editing one task cannot retire a shared goal or another task directive',async t=>{
 const f=setup(t),other=f.a.createTask({title:'第二项',description:f.task.description,criteria:'另一个范围',steps:[{title:'稿件',kind:'draft'}]});other.agentJobId=f.job.id;f.job.taskIds.push(other.id);
 f.job.feedback.push({taskId:other.id,kind:'task_feedback',at:'2030-01-01',text:'只给第二项增加附录。'});
 await f.a.dispatch('updateTask',{id:f.task.id,description:'现改选方案 Q2。'});
 assert.ok(ground.requirements(f.a,f.task).some(r=>r.text===other.description));assert.ok(!ground.requirements(f.a,f.task).some(r=>r.text==='只给第二项增加附录。'));
 assert.ok(ground.requirements(f.a,other).some(r=>r.text==='只给第二项增加附录。'));
});
test('revision event and its legacy display wrapper appear once without mutating event history',async t=>{
 const f=setup(t),note='采用 Q2，保留共享边界。';await f.a.dispatch('taskAction',{id:f.task.id,command:'revise',note});
 const raw=structuredClone(f.job.feedback);f.job.feedback.push({taskId:f.task.id,kind:'task_revision',at:f.job.feedback.at(-1).at,text:'事项「介绍」收到补充：'+note});
 const before=JSON.stringify(f.job.feedback),list=ground.requirements(f.a,f.task);
 assert.equal(list.filter(r=>r.text===note).length,1);assert.ok(!list.some(r=>r.text.startsWith('事项「')));assert.equal(JSON.stringify(f.job.feedback),before);assert.ok(raw.length);
});
test('same directive reasserted later keeps its latest precedence',()=>{
 const job={feedback:[{at:'1',text:'选 Q1'},{at:'2',text:'选 Q2'},{at:'3',text:'选 Q1'}]};
 assert.deepEqual(projection.directives(job).map(r=>[r.at,r.text]),[['2','选 Q2'],['3','选 Q1']]);
});
test('new explicit execution contract retains its goal and retires earlier notes',async t=>{
 const f=setup(t);f.task.notes.push({kind:'revise',text:'旧补充',at:'2020-01-01'});
 await f.a.dispatch('updateTask',{id:f.task.id,description:'选择 Q2。'});
 f.job.executionContract={revision:'new',text:'按方案 Q1 撰写完整说明。',updatedAt:'2090-01-01'};
 const list=ground.requirements(f.a,f.task);assert.ok(list.some(r=>r.text===f.job.executionContract.text));assert.ok(!list.some(r=>r.text==='旧补充'));
});
