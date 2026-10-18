const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),decisions=require('../desktop/decisions.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-library-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Assistant({dir});}
test('Full-text search finds evidence beyond previews and excludes credentials',async t=>{
 const a=setup(t);await a.dispatch('import',{items:[{title:'完整材料',content:'前言'.repeat(20000)+'独特发布预算',origin:'测试'}]});
 await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'secret-marker',model:'m',baseUrl:'https://example.invalid',key:'secret-marker'});
 const r=await a.dispatch('librarySearch',{query:'独特发布预算'});assert.equal(r.total,1);assert.match(r.items[0].excerpt,/独特发布预算/);assert.ok(r.items[0].excerpt.length<280);
 assert.equal((await a.dispatch('librarySearch',{query:'secret-marker',history:true})).total,0);
});
test('Search filters current source versions, exclusions, withdrawals and projects',async t=>{
 const a=setup(t);await a.dispatch('projectSave',{name:'P'});const p=a.data.projects[0];
 await a.dispatch('import',{items:[{title:'版本',content:'旧预算',projectId:p.id}]});const old=a.data.sources[0];
 a.data.sources.unshift({...old,id:'next',content:'新预算',previousSourceId:old.id,version:2});
 require('../desktop/protocol-access.cjs').retain(a,'source',a.data.sources[0],{command:'test_explicit_material',actor:'user_command'});
 a.data.sources.push({...old,id:'withdrawn',content:'撤回预算',deleted:true},{...old,id:'excluded',projectExcluded:true});
 const r=await a.dispatch('librarySearch',{type:'source',projectId:p.id});assert.deepEqual(r.items.map(s=>s.id),['next']);
 // History preserves readable versions, but cannot list withdrawn/excluded snapshots as readable material.
 assert.deepEqual(new Set((await a.dispatch('librarySearch',{type:'source',history:true})).items.map(s=>s.id)),new Set([old.id,'next']));
 await assert.rejects(a.dispatch('librarySearch',{projectId:'missing'}),/项目不存在/);
});
test('Current deliverables require live step references; replaced and cancelled artifacts are historical',async t=>{
 const a=setup(t);await a.dispatch('createTask',{title:'交付',criteria:'真实结果',steps:[{title:'生成',kind:'draft'}]});const task=a.data.tasks[0];
 a.data.artifacts.push({id:'old',taskId:task.id,title:'旧结果',content:'old',createdAt:'2026-01-01'},{id:'new',taskId:task.id,title:'新结果',content:'new',createdAt:'2026-01-02'});
 task.steps[0].done=true;task.steps[0].artifactId='new';task.status='completed';
 a.data.agentActions.push({id:'receipt',taskId:task.id,artifactId:'new',status:'done',tool:'write_file',result:{latestPath:'/output/new.md',verified:true}});
 let r=await a.dispatch('librarySearch',{type:'artifact'});assert.equal(r.total,1);assert.equal(r.items[0].status,'已验收产出');assert.equal(r.items[0].deliveries[0].target,'/output/new.md');
 task.needsReplan='新要求';assert.equal((await a.dispatch('librarySearch',{type:'artifact'})).total,0);
 assert.equal((await a.dispatch('librarySearch',{type:'artifact',history:true})).total,2);
});
test('Search pagination is stable, bounded, case insensitive and validates input',async t=>{
 const a=setup(t);for(let i=0;i<37;i++)a.data.projects.push({id:`p${i}`,name:`ALPHA ${i}`,background:'项目正文'});
 const first=await a.dispatch('librarySearch',{query:'alpha',limit:30}),second=await a.dispatch('librarySearch',{query:'alpha',offset:30,limit:30});
 assert.equal(first.total,37);assert.equal(first.more,true);assert.equal(second.items.length,7);assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,37);
 for(const input of [{limit:101},{offset:-1},{history:'true'},{query:'a'.repeat(201)},{type:'provider'}])await assert.rejects(a.dispatch('librarySearch',input));
});
test('Read-only search has no model calls or workspace mutations',async t=>{
 const a=setup(t),before=JSON.stringify(a.data);a.chat=()=>{throw new Error('不得调用模型');};await a.dispatch('librarySearch',{});assert.equal(JSON.stringify(a.data),before);
});
test('Reimporting an older project document creates a new current version, even before delegation',async t=>{
 const a=setup(t);await a.dispatch('projectSave',{name:'版本项目'});const projectId=a.data.projects[0].id;
 for(const content of ['第一版','第二版','第一版'])await a.dispatch('import',{items:[{title:'需求.md',content,projectId}]});
 assert.equal(a.data.sources.length,3);assert.equal(a.data.sources[0].version,3);assert.equal(a.data.sources[0].content,'第一版');
 const found=await a.dispatch('librarySearch',{type:'source',projectId});assert.equal(found.total,1);assert.equal(found.items[0].id,a.data.sources[0].id);
 await a.dispatch('import',{items:[{title:'需求.md',content:'第一版',projectId}]});assert.equal(a.data.sources.length,3);
 await a.dispatch('import',{items:[{title:'另一个文件.md',content:'第一版',projectId}]});assert.equal(a.data.sources.length,4);
});
async function jobSetup(t){
 const a=setup(t);await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'测试',model:'fixture',baseUrl:'https://example.invalid'});const j=agent.buildJob(a,{goal:'推进计划',fileMode:'off',allowWeb:false});a.data.delegations.push(j);
 const {taskId}=await agent.act(a,j,'plan_task',{key:'task',title:'交付材料',criteria:'包括日期',steps:[{key:'draft',title:'写作',kind:'draft'}]});
 const task=a.task(taskId);task.status='waiting';decisions.ask(a,j,{key:`task:${taskId}`,question:'哪天交付？',taskIds:[taskId]});
 return {a,j,task};
}
test('Task drawer feedback answers its decision and wakes the existing delegation',async t=>{
 const {a,j,task}=await jobSetup(t);await a.dispatch('taskAction',{id:task.id,command:'feedback',note:'10 月 12 日'});
 assert.equal(j.status,'ready');assert.equal(task.status,'todo');assert.equal(a.data.decisions[0].status,'answered');assert.match(j.feedback.at(-1).text,/10 月 12 日/);assert.equal(a.data.delegations.length,1);
 const answer=decisions.ask(a,j,{key:`task:${task.id}`,question:'哪天交付？',taskIds:[task.id]});assert.equal(answer.answer,'10 月 12 日');assert.equal(a.data.decisions.filter(d=>d.status==='open').length,0);
});
test('Delegation feedback also reuses its answer while the question basis is unchanged',async t=>{
 const {a,j,task}=await jobSetup(t);await a.dispatch('agentFeedback',{id:j.id,note:'周六交付'});
 const answer=decisions.ask(a,j,{key:`task:${task.id}`,question:'哪天交付？',taskIds:[task.id]});assert.equal(answer.answer,'周六交付');assert.equal(j.status,'ready');
});
test('Task feedback respects paused jobs and other unanswered decisions',async t=>{
 const {a,j,task}=await jobSetup(t);j.status='paused';await a.dispatch('taskAction',{id:task.id,command:'feedback',note:'周六'});assert.equal(j.status,'paused');
 decisions.ask(a,j,{key:'unrelated',question:'另一项选择？',taskIds:[]});await a.dispatch('taskAction',{id:task.id,command:'feedback',note:'周日'});assert.equal(j.status,'needs_input');
});
test('Task mutations cannot hide an uncertain external action',async t=>{
 const {a,j,task}=await jobSetup(t);a.data.agentActions.push({id:'uncertain',jobId:j.id,status:'uncertain'});j.pendingActionId='uncertain';const before=JSON.stringify(a.data);
 await assert.rejects(a.dispatch('taskAction',{id:task.id,command:'feedback',note:'继续'}),/核对/);
 await assert.rejects(a.dispatch('updateTask',{id:task.id,title:'改变目标'}),/核对/);assert.equal(JSON.stringify(a.data),before);
});
test('Retry invalidates stale approvals and clears old no-progress guard',async t=>{
 const {a,j,task}=await jobSetup(t);a.data.decisions=[];task.status='blocked';j.status='blocked';j.progressGuard={stoppedAt:new Date().toISOString()};
 a.data.agentActions.push({id:'pending',jobId:j.id,status:'pending',approvedAt:'old'});j.pendingActionId='pending';
 await a.dispatch('taskAction',{id:task.id,command:'retry'});assert.equal(j.status,'ready');assert.equal(a.data.agentActions[0].status,'stale');assert.equal(j.pendingActionId,null);assert.ok(!j.progressGuard?.stoppedAt);
});
