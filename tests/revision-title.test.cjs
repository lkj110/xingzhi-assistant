'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),generation=require('../desktop/generation.cjs');
function setup(t,{rewrite=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'revision-title-'));
 t.after(()=>{assert.ok(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const a=new Assistant({dir,chat:async()=>{throw Error('Unexpected real model call');}});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const task=a.createTask({title:'统计稿',description:'根据最新范围修订标题和正文',criteria:'范围一致',generationMode:'single',steps:[{title:'统计正文',kind:'draft'}]}),step=task.steps[0];
 const artifact={id:'old',taskId:task.id,stepId:step.id,title:'四月 A 门店统计',content:'# 统计\n四月 A 门店为 12 件。\n\n# 说明\n仅计已验收记录。',createdAt:'2026-01-01T00:00:00Z'};
 a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});
 task.notes.push({id:'revision',kind:'revise',at:'2026-02-01T00:00:00Z',text:'改为五月 B 门店的 18 件，标题和正文均须对应最新范围',targetArtifactId:artifact.id,targetStepId:step.id});
 if(rewrite){const job=require('../desktop/agent.cjs').buildJob(a,{goal:'修订统计稿',autoAccept:false});job.taskIds=[task.id];a.data.delegations.push(job);task.agentJobId=job.id;require('../desktop/work-efficiency.cjs').before(a,job);Object.assign(job.executionState.workEfficiency,{phase:'recovering',active:{id:'full_rewrite:'+task.id,queue:[],reads:0}});}
 const original=structuredClone(artifact),patch={kind:'patch',title:'五月 B 门店统计',edits:[{before:'四月 A 门店为 12 件。',after:'五月 B 门店为 18 件。'}],summary:'同步范围'};
 return {a,task,step,artifact,original,patch,run:()=>generation.run(a,task,step,'',a.context(task))};
}
test('one patch changes title and body together while preserving the saved original',async t=>{
 const f=setup(t);let calls=0;f.a.call=async(_role,prompt,c)=>{calls++;assert.match(prompt,/"title":"可选修订标题"/);assert.match(prompt,/对象、时间、口径一致/);assert.match(prompt,/不能当作正文 edits/);assert.equal(c.revision.title,f.original.title);return f.patch;};
 const result=await f.run();assert.equal(result.title,f.patch.title);assert.equal(result.content,f.original.content.replace(f.patch.edits[0].before,f.patch.edits[0].after));assert.equal(calls,1);assert.deepEqual(f.artifact,f.original);assert.equal(f.a.data.artifacts.length,1);
});
test('title-only patch keeps every body character without another model call',async t=>{
 const f=setup(t);let calls=0;f.a.call=async()=>{calls++;return {...f.patch,edits:[]};};const result=await f.run();assert.equal(result.title,f.patch.title);assert.equal(result.content,f.original.content);assert.equal(calls,1);assert.deepEqual(f.artifact,f.original);
});
test('omitting optional title retains the old title and prior body-patch behavior',async t=>{
 const f=setup(t),{title,...patch}=f.patch;let calls=0;f.a.call=async()=>{calls++;return patch;};const result=await f.run();assert.equal(result.title,f.original.title);assert.match(result.content,/五月 B 门店/);assert.equal(calls,1);assert.deepEqual(f.artifact,f.original);
});
for(const title of ['', '   ', '长'.repeat(201),42,null,[],{}])test(`invalid patch title ${JSON.stringify(title).slice(0,25)} fails without body fallback`,async t=>{
 const f=setup(t);let calls=0;f.a.call=async()=>{calls++;return {...f.patch,title};};await assert.rejects(f.run(),e=>e.code==='MODEL_INVALID_RESPONSE'&&/修订标题/.test(e.message));assert.equal(calls,1);assert.deepEqual(f.artifact,f.original);assert.equal(f.a.data.artifacts.length,1);
});
test('exactly 200 title characters are accepted without truncation',async t=>{
 const f=setup(t),title='新'.repeat(200);f.a.call=async()=>({...f.patch,title,edits:[]});assert.equal((await f.run()).title,title);assert.deepEqual(f.artifact,f.original);
});
for(const title of [undefined,'四月 A 门店统计','  四月 A 门店统计  '])test(`empty edits without an actual title change cannot return a successful patch (${JSON.stringify(title)})`,async t=>{
 const f=setup(t);let calls=0;f.a.call=async()=>{calls++;return calls===1?{kind:'patch',...(title===undefined?{}:{title}),edits:[]}:{kind:'artifact',content:''};};await assert.rejects(f.run(),e=>e.code==='MODEL_INVALID_RESPONSE');assert.equal(calls,2,'existing body-match recovery remains bounded');assert.deepEqual(f.artifact,f.original);
});
for(const route of ['full_rewrite','patch_fallback']){
 for(const title of ['', '长'.repeat(201),42])test(`${route} rejects invalid title ${JSON.stringify(title).slice(0,25)}`,async t=>{
  const f=setup(t,{rewrite:route==='full_rewrite'});let calls=0;f.a.call=async()=>{calls++;if(route==='patch_fallback'&&calls===1)return {kind:'patch',edits:[{before:'不存在',after:'其他'}]};return {kind:'artifact',title,content:f.original.content};};await assert.rejects(f.run(),e=>e.code==='MODEL_INVALID_RESPONSE'&&/修订标题/.test(e.message));assert.equal(calls,route==='full_rewrite'?1:2);assert.deepEqual(f.artifact,f.original);assert.equal(f.a.data.artifacts.length,1);
 });
 test(`${route} accepts a valid new title and preserves omitted-title compatibility`,async t=>{
  const f=setup(t,{rewrite:route==='full_rewrite'});let calls=0;f.a.call=async()=>{calls++;if(route==='patch_fallback'&&calls%2===1)return {kind:'patch',edits:[{before:'不存在',after:'其他'}]};return {kind:'artifact',...(calls<3?{title:f.patch.title}:{}),content:f.original.content};};assert.equal((await f.run()).title,f.patch.title);if(route==='full_rewrite'){f.a.call=async()=>({kind:'artifact',content:f.original.content});}assert.equal((await f.run()).title,f.original.title);assert.deepEqual(f.artifact,f.original);
 });
}
for(const titleOnly of [false,true])for(const mutation of ['permission','body_version','title_version'])test(`${titleOnly?'title-only':'title and body'} patch rejects ${mutation} changes during generation`,async t=>{
 const f=setup(t);let calls=0;f.a.call=async()=>{calls++;if(mutation==='permission')f.a.contextAccessCheck=()=>({allowed:false,decision:'deny',revision:2});if(mutation==='body_version')f.artifact.content+='\n另一个版本';if(mutation==='title_version')f.artifact.title='另一个标题版本';return {...f.patch,edits:titleOnly?[]:f.patch.edits};};await assert.rejects(f.run(),e=>['CONTEXT_SCOPE_DENIED','CONTEXT_VERSION_CHANGED'].includes(e.code));assert.equal(calls,1);assert.equal(f.a.data.artifacts.length,1);assert.notEqual(f.artifact.title,f.patch.title);assert.doesNotMatch(f.artifact.content,/五月 B 门店/);
});
for(const titleOnly of [false,true])test(`${titleOnly?'title-only':'title and body'} revision still requires independent full-draft verification`,async t=>{
 const f=setup(t);let writes=0,checks=0;f.a.call=async(role,_prompt,context)=>{if(role!=='verify'){writes++;return {...f.patch,edits:titleOnly?[]:f.patch.edits};}checks++;const current=context.artifacts.find(row=>row.id!==f.artifact.id);assert.equal(current.title,f.patch.title);assert.equal(current.content,titleOnly?f.original.content:f.original.content.replace(f.patch.edits[0].before,f.patch.edits[0].after));return {passed:false,summary:'保留独立核验入口',gaps:['测试未批准交付']};};await f.a.advance(f.task.id);assert.equal(writes,1);assert.equal(checks,1);assert.equal(f.task.verification.passed,false);assert.notEqual(f.task.status,'review');assert.notEqual(f.task.status,'completed');assert.deepEqual(f.artifact,f.original);assert.equal(f.a.data.artifacts.length,2);
});
