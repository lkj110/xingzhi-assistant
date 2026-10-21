const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Assistant, modelChat, endpoint } = require('../desktop/core.cjs');
const { startServer } = require('../desktop/server.cjs');
const { syncFolders } = require('../desktop/folders.cjs');

function workspace(t, chat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Assistant({ dir, chat });
}
async function provider(a, extra = {}) {
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: '测试模型', model: 'test-model', baseUrl: 'http://localhost:9000/v1', key: 'secret-do-not-export', ...extra });
}
const taskInput = { title: '整理发布方案', description: '已知发布时间为周五，目标是写一份摘要。', criteria: '包含周五发布时间', steps: [{ title: '起草发布摘要', kind: 'draft' }] };
async function advance(a, id) { await a.dispatch('advance', { id }); await a.runPromise; }

test('end-to-end: source → extracted plan → artifact → verified result → user acceptance, survives restart', async t => {
  const calls = [];
  const a = workspace(t, async (config, key, messages) => {
    calls.push(config.model); assert.equal(key, 'secret-do-not-export');
    const prompt = messages[0].content; const payload = JSON.parse(messages[1].content);
    if (prompt.includes('从材料提取')) return { tasks: [{ ...taskInput, sourceIds: [payload.sources[0].id] }], summary: '提取发布方案事项' };
    if (prompt.includes('推进给定事项')) return { kind: 'artifact', title: '发布摘要', content: '# 发布摘要\n计划周五发布。', summary: '已生成草稿' };
    return { passed: true, summary: '草稿包含指定的发布时间', gaps: [] };
  });
  await provider(a);
  await a.dispatch('import', { items: [{ title: '发布会议', content: '周五发布，需要写摘要。' }] });
  await a.dispatch('extract'); await a.runPromise;
  const task = a.data.tasks[0]; assert.equal(task.status, 'todo'); assert.equal(a.data.sources[0].state, 'processed'); assert.equal(task.sourceIds.length, 1);
  await advance(a, task.id);
  assert.equal(task.status, 'review'); assert.equal(a.data.artifacts.length, 1); assert.equal(task.steps[0].done, true);
  await a.dispatch('taskAction', { id: task.id, command: 'accept' });
  assert.equal(task.status, 'completed'); assert.equal(calls.length, 3);
  const restored = new Assistant({ dir: a.dir }); assert.equal(restored.data.tasks[0].status, 'completed'); assert.equal(restored.data.artifacts[0].content, '# 发布摘要\n计划周五发布。');
  assert.equal(JSON.stringify(a.publicState()).includes('secret-do-not-export'), false);
  assert.equal(JSON.stringify(await a.dispatch('export')).includes('sealedKey'), false);
  assert.equal(fs.readFileSync(a.file, 'utf8').includes('secret-do-not-export'), false);
});

test('external steps cannot be auto-completed; evidence resumes the plan and due followups do not call a model', async t => {
  let calls = 0;
  const a = workspace(t, async () => { calls++; return { passed: true, summary: '用户提供了发送结果', gaps: [] }; }); await provider(a);
  const task = a.createTask({ ...taskInput, steps: [{ title: '将方案发给同事', kind: 'external' }] });
  await advance(a, task.id); assert.equal(task.status, 'waiting'); assert.equal(task.steps[0].done, false); assert.equal(calls, 0);
  task.nextCheckAt = new Date(Date.now() - 1000).toISOString(); a.tick(); a.tick();
  assert.equal(task.followupDue, true); assert.equal(a.data.events.filter(e => e.title === '到了跟进时间').length, 1); assert.equal(calls, 0);
  await a.dispatch('taskAction', { id: task.id, command: 'feedback', note: '还没有发出' });
  await advance(a, task.id); assert.equal(task.status, 'waiting'); assert.equal(task.steps[0].done, false);
  await a.dispatch('taskAction', { id: task.id, command: 'externalDone', note: '已于 10:30 手动发送，对方确认收到。' });
  await advance(a, task.id); assert.equal(task.status, 'review'); assert.equal(calls, 1);
});

test('feedback revises saved artifacts and verification cannot fabricate acceptance', async t => {
  let version = 0;
  const a = workspace(t, async (_p,_k,m) => JSON.parse(m[1].content).revision ? {kind:'patch',edits:[{before:`正文 ${version}`,after:`正文 ${++version}`}]} : m[0].content.includes('推进给定事项') ? { kind: 'artifact', title: '版本', content: `正文 ${++version}` } : { passed: version > 1, summary: version > 1 ? '满足要求' : '缺少日期', gaps: version > 1 ? [] : ['补充日期'] }); await provider(a);
  const task = a.createTask(taskInput); await advance(a, task.id);
  assert.equal(task.status, 'blocked'); await assert.rejects(a.dispatch('taskAction', { id: task.id, command: 'accept' }), /检查/);
  await a.dispatch('taskAction', { id: task.id, command: 'revise', note: '请补充周五的日期' }); await advance(a, task.id);
  assert.equal(task.status, 'review'); assert.equal(a.data.artifacts.length, 2); assert.equal(a.data.artifacts[0].content, '正文 1');
});

test('invalid extraction batch is atomic and sources remain available for retry', async t => {
  const a = workspace(t, async (_p,_k,m) => ({ tasks: [{ ...taskInput, sourceIds:[JSON.parse(m[1].content).sources[0].id] }, { title:'错误的第二条', sourceIds:['missing'] }] })); await provider(a);
  await a.dispatch('import', { items: [{ title:'记录',content:'会议内容' }] }); await a.dispatch('extract'); await a.runPromise;
  assert.equal(a.data.tasks.length,0); assert.equal(a.data.sources[0].state,'new'); assert.match(a.data.events[0].detail,/引用无效/);
});

test('new source merges with existing task instead of duplicating or losing steps', async t => {
  const a = workspace(t, async (_p,_k,m) => { const c = JSON.parse(m[1].content); return {tasks:[{existingTaskId:c.existingTasks[0].id,title:'更新',description:'时间变化',sourceIds:[c.sources[0].id]}]}; }); await provider(a);
  const task = a.createTask(taskInput); const stepId = task.steps[0].id;
  await a.dispatch('import',{items:[{title:'补充',content:'时间改到周六'}]}); await a.dispatch('extract'); await a.runPromise;
  assert.equal(a.data.tasks.length,1); assert.equal(task.steps[0].id,stepId); assert.equal(task.sourceIds.length,1); assert.equal(task.notes.length,1);
});

test('same-task runs reject duplicate execution; interruption saves blocked state and can recover on restart', async t => {
  const a = workspace(t, (_p,_k,_m,{signal}) => new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('操作已停止')),{once:true}))); await provider(a);
  const task = a.createTask(taskInput); await a.dispatch('advance',{id:task.id});
  await assert.rejects(a.dispatch('advance',{id:task.id}),/正在推进/); await a.dispatch('stop'); await a.runPromise;
  assert.equal(task.status,'blocked'); assert.equal(a.data.artifacts.length,0);
  task.status='running'; a.data.sources.push({id:'source',state:'processing'}); a.save();
  const restored = new Assistant({dir:a.dir}); assert.equal(restored.data.tasks[0].status,'blocked'); assert.equal(restored.data.sources[0].state,'new');
});

test('failed verification keeps its real artifact; retry verifies without regenerating the artifact', async t => {
  let verify = 0;
  const a = workspace(t, async (_p,_k,m)=> {
    if(m[0].content.includes('推进给定事项')) return {kind:'artifact',content:'真实产出',title:'草稿'};
    if(verify++===0)throw new Error('网络中断');return {passed:true,summary:'检查通过',gaps:[]};
  }); await provider(a); const task=a.createTask(taskInput);await advance(a,task.id);assert.equal(task.status,'blocked');assert.equal(a.data.artifacts.length,1);
  await advance(a,task.id);assert.equal(task.status,'review');assert.equal(a.data.artifacts.length,1);
});

test('independent tasks advance together, respect opt-in acceptance, and invalid settings do not mutate working state', async t => {
  const a = workspace(t,async (_p,_k,m)=>m[0].content.includes('推进给定事项')?{kind:'artifact',title:'草稿',content:'已给出日期'}:{passed:true,summary:'通过',gaps:[]});
  await assert.rejects(a.dispatch('settings',{automatic:true}),/选择模型/);assert.equal(a.data.settings.automatic,false);
  await provider(a);a.createTask(taskInput);a.createTask({...taskInput,title:'第二件事'});
  await a.dispatch('settings',{autoExtract:false,maxActions:1,autoComplete:true});await a.dispatch('cycle');await a.runPromise;
  assert.equal(a.data.tasks.filter(t=>t.status==='completed').length,2);assert.equal(a.data.tasks.filter(t=>t.status==='todo').length,0);
  assert.ok(a.data.settings.lastCycleAt);
});

test('folders only ingest allowed regular files; same content is deduplicated and changes preserve history', t=>{
  const a=workspace(t);const dir=path.join(a.dir,'materials');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'note.md'),'第一次内容');fs.writeFileSync(path.join(dir,'secret.env'),'IGNORE');{if(!require('./helpers/symlink.cjs').link(t,path.join(dir,'secret.env'),path.join(dir,'link.txt')))return;}
  a.data.folders.push({id:'folder',path:fs.realpathSync(dir)});syncFolders(a);syncFolders(a);assert.equal(a.data.sources.length,1);
  fs.writeFileSync(path.join(dir,'note.md'),'更新后的内容');syncFolders(a);assert.equal(a.data.sources.length,2);assert.equal(a.data.sources[1].content,'第一次内容');
});

test('OpenAI-compatible and Ollama adapters use configured endpoint, auth, and JSON options',async t=>{
  const requests=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url,auth:req.headers.authorization,body:JSON.parse(raw)});res.setHeader('Content-Type','application/json');res.end(req.url==='/api/chat'?JSON.stringify({message:{content:'{"ok":true}'}}):JSON.stringify({choices:[{message:{content:'```json\n{"ok":true}\n```'}}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await modelChat({type:'openai',baseUrl:`${base}/v1`,model:'my-model'},'abc',[{role:'user',content:'test'}]),{ok:true});
  assert.deepEqual(await modelChat({type:'ollama',baseUrl:base,model:'local'},'',[{role:'user',content:'test'}]),{ok:true});
  assert.equal(requests[0].url,'/v1/chat/completions');assert.equal(requests[0].auth,'Bearer abc');assert.deepEqual(requests[0].body.response_format,{type:'json_object'});assert.equal(requests[1].body.format,'json');assert.equal(requests[1].body.stream,false);
  assert.equal(endpoint({type:'openai',baseUrl:`${base}/v1/chat/completions`}),`${base}/v1/chat/completions`);
  assert.throws(()=>endpoint({baseUrl:'file:///tmp/test'}));
});

test('local preview rejects cross-origin/host requests, requires a session and never returns stored keys',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-http-'));const {server,assistant,origin}=await startServer({dir,port:0});t.after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});await provider(assistant);
  assert.equal((await fetch(`${origin}/api/session`,{headers:{Origin:'https://evil.invalid'}})).status,403);
  const hostileHost = await new Promise((resolve,reject)=>http.get(`${origin}/api/session`,{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(hostileHost,403);
  assert.equal((await fetch(`${origin}/api/call`,{method:'POST',body:'{"action":"state"}'})).status,403);
  const session=await fetch(`${origin}/api/session`);const cookie=session.headers.get('set-cookie').split(';')[0];const {token}=await session.json();
  const response=await fetch(`${origin}/api/call`,{method:'POST',headers:{'Content-Type':'application/json','x-assistant-token':token,Cookie:cookie},body:'{"action":"state"}'});const body=await response.text();assert.equal(response.status,200);assert.equal(body.includes('secret-do-not-export'),false);assert.equal(body.includes('sealedKey'),false);
});
