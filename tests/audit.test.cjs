const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Assistant, modelChat } = require('../desktop/core.cjs');
const { startServer } = require('../desktop/server.cjs');

const input = { title:'撰写方案', criteria:'包含发布日期', steps:[{title:'起草',kind:'draft'}] };
const success = async (_p,_k,m) => JSON.parse(m[1].content).revision?{kind:'patch',edits:[{before:'周五发布',after:'周六发布'}]}: m[0].content.includes('推进给定事项') ? {kind:'artifact',title:'方案',content:'周五发布'} : {passed:true,summary:'满足要求',gaps:[]};
async function setup(t,chat=success){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-audit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'测试',baseUrl:'http://127.0.0.1:1/v1',model:'test'});return a;}
async function run(a,id){await a.dispatch('advance',{id});await a.runPromise;}
async function merge(a,task){await a.dispatch('import',{items:[{title:'补充材料',content:'新的发布日期和内容要求'}]});a.chat=async(_p,_k,m)=>({tasks:[{existingTaskId:task.id,title:task.title,sourceIds:[JSON.parse(m[1].content).sources[0].id],description:'补充信息'}]});await a.dispatch('extract');await a.runPromise;}

test('B01 changing completion criteria invalidates review and completed acceptance',async t=>{
  const a=await setup(t);const task=a.createTask(input);await run(a,task.id);assert.equal(task.status,'review');
  await a.dispatch('updateTask',{id:task.id,criteria:'还必须包含回滚方案'});
  assert.equal(task.status,'todo');assert.equal(task.verification,null);
  await assert.rejects(a.dispatch('taskAction',{id:task.id,command:'accept'}));
  await run(a,task.id);await a.dispatch('taskAction',{id:task.id,command:'accept'});
  await a.dispatch('updateTask',{id:task.id,description:'目标已经变化'});assert.equal(task.status,'todo');assert.equal(task.completedAt,undefined);
});
test('B02 newly merged context invalidates a previously passed review',async t=>{
  const a=await setup(t);const task=a.createTask(input);await run(a,task.id);await merge(a,task);
  assert.equal(task.status,'todo');assert.equal(task.verification,null);
});
test('B03 revising a draft also invalidates downstream execution evidence',async t=>{
  const a=await setup(t);const task=a.createTask({...input,steps:[...input.steps,{title:'发送方案',kind:'external'}]});
  await run(a,task.id);await run(a,task.id);await a.dispatch('taskAction',{id:task.id,command:'externalDone',note:'已发送第一版'});await run(a,task.id);
  await a.dispatch('taskAction',{id:task.id,command:'revise',note:'修改发布时间'});
  assert.equal(task.steps[1].done,false);assert.equal(task.steps[1].evidence,undefined);assert.equal(a.data.artifacts.length,1);
});
test('B04 feedback on a paused task preserves the pause until explicitly resumed',async t=>{
  const a=await setup(t);const task=a.createTask(input);await a.dispatch('taskAction',{id:task.id,command:'pause'});
  await a.dispatch('taskAction',{id:task.id,command:'feedback',note:'补充上下文，不恢复执行'});
  assert.equal(task.status,'paused');await a.dispatch('taskAction',{id:task.id,command:'resume'});assert.equal(task.status,'todo');
});
test('B05 source update resumes the current information-blocked step despite later external steps',async t=>{
  const a=await setup(t,async()=>({kind:'need_input',question:'缺少日期'}));const task=a.createTask({...input,steps:[...input.steps,{title:'发送草稿',kind:'external'}]});
  await run(a,task.id);task.followupDue=true;await merge(a,task);
  assert.equal(task.status,'todo');assert.equal(task.followupDue,false);assert.equal(task.waitingOn,'');assert.equal(task.nextCheckAt,null);
});
test('B06 normal priority is scheduled before low priority',async t=>{
  const a=await setup(t);const normal=a.createTask({...input,priority:'normal'});a.createTask({...input,title:'低优先级',priority:'low'});
  await a.dispatch('settings',{autoExtract:false,maxActions:1});await a.dispatch('cycle');await a.runPromise;assert.equal(normal.status,'review');
});
test('B07 repeated pause is idempotent and completed tasks cannot be silently resumed',async t=>{
  const a=await setup(t);const task=a.createTask(input);await run(a,task.id);await a.dispatch('taskAction',{id:task.id,command:'pause'});await a.dispatch('taskAction',{id:task.id,command:'pause'});await a.dispatch('taskAction',{id:task.id,command:'resume'});assert.equal(task.status,'review');
  await a.dispatch('taskAction',{id:task.id,command:'accept'});await assert.rejects(a.dispatch('taskAction',{id:task.id,command:'resume'}));assert.equal(task.status,'completed');
});
test('B08 editing criteria to empty is rejected without partially changing the title',async t=>{
  const a=await setup(t);const task=a.createTask(input);await assert.rejects(a.dispatch('updateTask',{id:task.id,title:'不应保存',criteria:'   '}));assert.equal(task.title,input.title);assert.equal(task.criteria,input.criteria);
});
test('B09 a contradictory checker response must not auto-complete the task',async t=>{
  const a=await setup(t,async(_p,_k,m)=>m[0].content.includes('推进给定事项')?{kind:'artifact',content:'方案'}:{passed:true,summary:'仍缺少必需信息',gaps:['没有发布日期']});await a.dispatch('settings',{autoComplete:true});const task=a.createTask(input);await run(a,task.id);assert.equal(task.status,'blocked');
});
test('B10 partial model-role changes preserve the other configured roles',async t=>{
  const a=await setup(t);const before={...a.data.settings.roles};await a.dispatch('settings',{roles:{execute:before.execute}});assert.deepEqual(a.data.settings.roles,before);
});
test('B11 context keeps historical versions as metadata without sending obsolete bodies',async t=>{
  const a=await setup(t);const task=a.createTask(input);await run(a,task.id);await a.dispatch('taskAction',{id:task.id,command:'revise',note:'更新版本'});await run(a,task.id);
  const artifacts=a.context(task).artifacts;assert.equal(artifacts.filter(x=>x.current).length,1);assert.equal(artifacts[0].current,true);assert.equal(a.context(task).artifactHistory.length,1);assert.equal(a.context(task).artifactHistory[0].content,undefined);
});
test('B12 UTF-8 text survives an HTTP request split inside a Chinese character',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-http-audit-'));const {server,assistant,origin}=await startServer({dir,port:0});t.after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const session=await fetch(`${origin}/api/session`);const cookie=session.headers.get('set-cookie').split(';')[0];const {token}=await session.json();
  const body=Buffer.from(JSON.stringify({action:'import',input:{items:[{title:'中文资料',content:'中文信息不可损坏'}]}}));const index=body.indexOf(Buffer.from('中文'))+1;
  await new Promise((resolve,reject)=>{const req=http.request(`${origin}/api/call`,{method:'POST',headers:{'x-assistant-token':token,Cookie:cookie}},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.write(body.subarray(0,index));setTimeout(()=>req.end(body.subarray(index)),30);});
  assert.equal(assistant.data.sources[0].title,'中文资料');
});

test('Model keys survive editing, can be explicitly cleared, and are absent from exports',async t=>{
  const a=await setup(t);const p=a.data.providers[0];await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,...p,key:'synthetic-secret'});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,...p,name:'编辑后的名称',key:''});assert.equal(a.vault.open(p.sealedKey),'synthetic-secret');assert.equal(JSON.stringify(await a.dispatch('export')).includes('synthetic-secret'),false);await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,...p,clearKey:true});assert.equal(a.publicState().providers[0].hasKey,false);
});
test('Import limits reject a batch atomically and referenced sources cannot be deleted',async t=>{
  const a=await setup(t);await assert.rejects(a.dispatch('import',{items:[{title:'有效',content:'内容'},{title:'过长',content:'x'.repeat(200001)}]}));assert.equal(a.data.sources.length,0);
  await a.dispatch('import',{items:[{title:'源',content:'唯一内容'}]});const id=a.data.sources[0].id;a.createTask({...input,sourceIds:[id]});await assert.rejects(a.dispatch('deleteSource',{id}));assert.equal(a.data.sources.length,1);
});
test('Scheduler only runs after the configured interval and excludes waiting/paused/completed tasks',async t=>{
  const a=await setup(t);a.createTask(input);await a.dispatch('settings',{automatic:true,autoExtract:false,intervalMinutes:15});a.data.settings.lastCycleAt=new Date().toISOString();a.tick();assert.equal(a.operation,null);
  a.data.settings.lastCycleAt=new Date(Date.now()-16*60000).toISOString();a.tick();await a.runPromise;assert.equal(a.data.tasks[0].status,'review');
  const total=a.data.artifacts.length;a.lastTick=0;a.data.settings.lastCycleAt=null;a.tick();await a.runPromise;assert.equal(a.data.artifacts.length,total);
});
test('Provider errors redact response bodies and JSON mode can be disabled',async t=>{
  let seen;
  const server=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;seen=JSON.parse(body);res.writeHead(401);res.end('SECRET_IN_PROVIDER_ERROR');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  await assert.rejects(modelChat({type:'openai',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'test',jsonMode:false},'key',[]),e=>e.message.includes('401')&&!e.message.includes('SECRET_IN_PROVIDER_ERROR'));
  assert.equal(seen.response_format,undefined);
});
test('Corrupt persistence without a valid backup is reported and preserved',async t=>{
  const a=await setup(t);fs.rmSync(path.join(a.dir,'backups'),{recursive:true,force:true});fs.writeFileSync(a.file,'not valid json');assert.throws(()=>new Assistant({dir:a.dir}));assert.equal(fs.readFileSync(a.file,'utf8'),'not valid json');
});
