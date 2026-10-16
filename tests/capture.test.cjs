const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
async function setup(t,{model=true,chat}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-capture-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const requests=[];
  const a=new Assistant({dir,chat:async(p,k,m,o)=>{requests.push(JSON.parse(m[1].content));return chat?chat(p,k,m,o):{tasks:[],summary:'材料已整理'};}});
  if(model)await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'});
  return {a,requests,save:(extra={})=>a.dispatch('captureSave',{textItems:[{title:'新收集',content:'本次需要整理的会议内容'}],...extra})};
}
test('Quick save needs no model and preserves source without organizing the inbox',async t=>{
  const {a,requests,save}=await setup(t,{model:false});const result=await save();assert.equal(result.sources.length,1);assert.equal(a.data.sources[0].state,'new');assert.equal(requests.length,0);
});
test('Save and organize scopes model input to this capture rather than older inbox material',async t=>{
  const {a,requests,save}=await setup(t);await a.dispatch('import',{items:[{title:'之前的私密材料',content:'本次不能一起整理'}]});const old=a.data.sources[0];await save({organize:true});await a.runPromise;
  assert.equal(requests.length,1);assert.equal(requests[0].sources.length,1);assert.equal(requests[0].sources[0].title,'新收集');assert.equal(old.state,'new');assert.equal(a.data.sources[0].state,'processed');
});
test('Ten files plus one text capture are organized in bounded batches without silently skipping any',async t=>{
  const {a,requests,save}=await setup(t);const files=Array.from({length:10},(_,i)=>({title:`input-${i}.txt`,base64:Buffer.from(`文件 ${i} 的不同内容`).toString('base64')}));await save({items:files,organize:true});await a.runPromise;
  assert.equal(a.data.sources.length,11);assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.sources.length),[6,5]);assert.equal(new Set(requests.flatMap(r=>r.sources.map(s=>s.id))).size,11);assert.ok(a.data.sources.every(s=>s.state==='processed'));
});
test('Duplicate capture neither starts a model nor reprocesses a previously handled source',async t=>{
  const {a,requests,save}=await setup(t);await save({organize:true});await a.runPromise;await save({organize:true});assert.equal(a.data.sources.length,1);assert.equal(requests.length,1);assert.equal(a.operation,null);
});
test('Model failure retains newly saved sources and does not alter older inbox material',async t=>{
  const {a,save}=await setup(t,{chat:async()=>{throw new Error('fixture offline');}});await save({organize:true});await a.runPromise;assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].state,'new');assert.equal(a.data.tasks.length,0);assert.ok(a.data.events.some(e=>e.detail.includes('模型请求失败')));assert.equal(JSON.stringify(a.data.events).includes('fixture offline'),false);assert.equal(a.data.modelCalls[0].errorCode,'MODEL_FAILED');
});
test('Missing organizer or invalid capture fails before saving; mixed invalid file input is atomic',async t=>{
  const {a,save}=await setup(t,{model:false});await assert.rejects(save({organize:true}),/模型/);assert.equal(a.data.sources.length,0);
  await assert.rejects(save({organize:'yes'}),/布尔/);await assert.rejects(save({projectId:'missing'}),/项目不存在/);
  await assert.rejects(save({items:[{title:'ok.txt',base64:Buffer.from('先解析但不保存').toString('base64')},{title:'bad.exe',base64:'aA=='}]}));assert.equal(a.data.sources.length,0);assert.equal(a.operation,null);
});
test('Project capture joins its existing paused job without standalone extraction or duplicate delegation',async t=>{
  const {a,requests,save}=await setup(t);await a.dispatch('projectSave',{name:'项目'});const p=a.data.projects[0],agent=require('../desktop/agent.cjs');const j=agent.buildJob(a,{projectId:p.id,goal:'持续处理'});j.status='paused';a.data.delegations.push(j);p.jobId=j.id;
  await save({projectId:p.id,organize:true});assert.equal(requests.length,0);assert.equal(j.status,'paused');assert.equal(j.sourceIds.length,1);assert.equal(a.data.sources[0].projectId,p.id);assert.equal(a.data.sources[0].state,'processed');assert.equal(a.data.delegations.length,1);
});


test('Withdrawn and superseded material is not selected for automatic extraction or used as current evidence',async t=>{
  const {a,requests}=await setup(t);await a.dispatch('import',{items:[{title:'旧',content:'旧预算8000'},{title:'撤回',content:'撤回预算9000'}]});const old=a.data.sources.find(s=>s.title==='旧'),withdrawn=a.data.sources.find(s=>s.title==='撤回');withdrawn.deleted=true;
  a.data.sources.unshift({id:'current',title:'新',content:'新预算1000',previousSourceId:old.id,state:'new',createdAt:new Date().toISOString()});await a.dispatch('extract');await a.runPromise;assert.deepEqual(requests[0].sources.map(s=>s.id),['current']);
  const task=a.createTask({title:'报告',sourceIds:[withdrawn.id]});const ctx=a.context(task);assert.deepEqual(ctx.sources,[]);assert.doesNotMatch(JSON.stringify(ctx),/撤回预算9000/);const protocol=require('../desktop/task-context.cjs'),scope=protocol.taskScope(task);assert.equal(protocol.buildContext(a,scope).readableCatalog.some(s=>s.id===withdrawn.id),false);const denied=protocol.resolveRead(a,scope,{tool:'read_source',sourceId:withdrawn.id,history:true});assert.equal(denied.code,'CONTEXT_SCOPE_DENIED');assert.doesNotMatch(JSON.stringify(denied),/撤回预算9000/);
});
