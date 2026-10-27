'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),prepare=require('../desktop/goal-evidence.cjs'),modelInput=require('../desktop/model-input.cjs');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goal-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));const inputs=[];
 const a=new Assistant({dir,chat:async(p,k,m,o)=>{inputs.push(modelInput.materialize(JSON.parse(m[1].content)));o.onUsage?.({inputTokens:10,outputTokens:5});return {passed:false,summary:'独立检查仍需判断',gaps:['测试不批准交付']};}});
 a.data.settings.evidenceGrounding=true;await a.dispatch('saveProvider',{name:'offline',model:'mock',baseUrl:'http://127.0.0.1:1',key:'offline',inputPrice:0,outputPrice:0});
 a.addSources([{title:'完整手册',content:'# 常规规则\n成员可借用器材。\n\n'+('无关记录。'.repeat(2000))+'# 末尾例外\n危险器材仅限取得资格者。'},{title:'资格说明',content:'资格需本季度确认；上季度资格不可代用。'}]);
 const job=agent.buildJob(a,{goal:'核对借用安排及全部例外',autoAccept:false});job.sourceIds=a.data.sources.map(s=>s.id);a.data.delegations.push(job);
 const task=a.createTask({title:'安排',description:job.goal,criteria:'保留例外',sourceIds:job.sourceIds,steps:[{title:'说明',kind:'draft'}]});task.agentJobId=job.id;job.taskIds=[task.id];
 for(const s of a.data.sources)require('../desktop/protocol-access.cjs').retain(a,'source',s,{job});a.save();
 return {a,job,task,inputs,run:()=>agent.model(a,job,'独立检查',agent.context(a,job,{full:true}),'verify')};
}
test('first whole-goal transport receives original middle/tail rules with no preliminary model read',async t=>{
 const f=await setup(t);const result=await f.run();assert.equal(result.passed,false);assert.equal(f.inputs.length,1);
 const input=f.inputs[0],body=JSON.stringify(input.contextReads);assert.match(body,/成员可借用器材/);assert.ok(body.includes('危险器材仅限取得资格者'),'tail exception must be actually supplied');assert.match(body,/上季度资格不可代用/);
 assert.ok(input.contextReads.every(r=>r.result.coverage.complete));assert.equal(f.job.completionCheck,undefined);
 const before=f.job.contextReads.length;await f.run();assert.equal(f.job.contextReads.length,before,'unchanged complete source is not read again');assert.equal(f.inputs.length,2);
});
test('bounded preparation exposes partial coverage and a continuation, never a full-evidence claim',async t=>{
 const f=await setup(t),r=prepare.prepare(f.a,f.job,{contextReads:[]},{maxChars:100});assert.ok(r.diagnostic.characters<=100);
 assert.ok(r.rows.some(row=>row.result.complete===false));
 const text=JSON.stringify(r.rows);assert.doesNotMatch(text,/危险器材仅限取得资格者/);
 const row=r.rows.find(row=>!row.result.complete);assert.notEqual(row.result.next,null);assert.equal(row.result.coverage.complete,false);
});
test('model input projection cannot preserve complete coverage for omitted prepared bodies',async t=>{
 const f=await setup(t),r=prepare.prepare(f.a,f.job,{contextReads:[]}),projected=modelInput.navigation({contextReads:r.rows,goalEvidencePreparation:r.diagnostic},2);
 // Further projection can select only recent reads; preparation metadata never claims provided completeness.
 assert.ok(projected.contextReads.length<=2);assert.equal(projected.goalEvidencePreparation.complete,undefined);
 assert.match(projected.goalEvidencePreparation.note,/不代表模型已完整阅读/);
});
for(const mutation of ['permission','version'])test(`source ${mutation} change before transport cannot reuse prepared proof`,async t=>{
 const f=await setup(t),original=f.a.save.bind(f.a);let changed=false;
 f.a.save=()=>{original();if(!changed){changed=true;if(mutation==='permission')f.a.contextAccessCheck=()=>({allowed:false,decision:'deny',revision:2});else f.a.data.sources[0].content+=' changed';}};
 await assert.rejects(f.run());assert.equal(f.inputs.length,0);
});
test('a previous positive goal verdict cannot replace source reads or authorize this run',async t=>{
 const f=await setup(t);f.job.completionCheck={passed:true,summary:'旧结论',basis:'old'};
 const result=await f.run();assert.equal(result.passed,false);assert.ok(JSON.stringify(f.inputs[0].contextReads).includes('危险器材仅限取得资格者'));
});
