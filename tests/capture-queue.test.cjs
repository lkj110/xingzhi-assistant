const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),capture=require('../desktop/capture.cjs');
const text=(n='新材料')=>({textItems:[{title:n,content:`待处理 ${n} 的内容`} ]});
async function setup(t,{chat,model=true}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-capture-queue-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=[];
  const fn=async(p,k,m,o)=>{const input=JSON.parse(m[1].content);calls.push(input);return chat?chat(input,calls.length,o):{tasks:[],summary:'已整理'};};
  const a=new Assistant({dir,chat:fn});if(model)await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'});
  return {a,dir,calls,chat:fn};
}
function busy(a){a.operation={label:'别的工作仍在执行',startedAt:new Date().toISOString()};a.controller=new AbortController();}
async function drain(a){a.operation=null;a.controller=null;assert.equal(capture.tick(a),true);await a.runPromise;}
const payloadPath=(a,row)=>path.join(a.dir,'capture-payloads',`${row.id}.json`);
test('Busy collection is durable and leaves active operation and model untouched',async t=>{
  const {a,dir,calls}=await setup(t);busy(a);const op=a.operation,controller=a.controller;
  const state=await a.dispatch('captureSave',{...text(),organize:true});const row=a.data.captureQueue[0];
  assert.equal(row.status,'queued');assert.equal(a.operation,op);assert.equal(a.controller,controller);assert.equal(a.data.sources.length,0);assert.equal(calls.length,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'workspace.json'))).captureQueue[0].id,row.id);assert.ok(fs.existsSync(payloadPath(a,row)));
  assert.equal(state.captureQueue[0].payloadHash,undefined);assert.equal(state.captureQueue[0].payloadBytes,undefined);assert.ok(!JSON.stringify(state.captureQueue).includes('base64'));
});
test('Queue drains oldest first and creates accurate receipt IDs while duplicates create zero',async t=>{
  const {a,calls}=await setup(t);busy(a);await a.dispatch('captureEnqueue',{...text('第一份'),organize:true});await a.dispatch('captureEnqueue',{...text('第二份'),organize:true});await a.dispatch('captureEnqueue',{...text('第一份'),organize:true});
  for(let i=0;i<3;i++){await drain(a);assert.equal(a.data.captureQueue[i].status,'completed');assert.ok(a.data.captureQueue.slice(i+1).every(r=>r.status==='queued'));}
  assert.equal(a.data.sources.length,2);assert.deepEqual(a.data.captureQueue.map(r=>r.sourceIds.length),[1,1,0]);assert.deepEqual(calls.map(r=>r.sources[0].title),['第一份','第二份']);
  for(const row of a.data.captureQueue){assert.ok(row.importedAt);assert.ok(!fs.existsSync(payloadPath(a,row)));for(const id of row.sourceIds)assert.equal(a.data.sources.find(s=>s.id===id).captureId,row.id);}
});
test('Queue does not organize older unrelated inbox sources',async t=>{
  const {a,calls}=await setup(t);await a.dispatch('import',{items:[{title:'旧资料',content:'旧内容'}]});const old=a.data.sources[0];await a.dispatch('captureEnqueue',{...text(),organize:true});await a.runPromise;
  assert.equal(calls.length,1);assert.deepEqual(calls[0].sources.map(s=>s.title),['新材料']);assert.equal(old.state,'new');
});
test('Missing organizer fails after import; configure and retry only the remaining organization',async t=>{
  const {a}=await setup(t,{model:false});await a.dispatch('captureEnqueue',{...text(),organize:true});await a.runPromise;const row=a.data.captureQueue[0],ids=[...row.sourceIds];
  assert.equal(row.status,'failed');assert.match(row.lastError,/模型/);assert.ok(row.importedAt);assert.equal(a.data.sources.length,1);assert.ok(!fs.existsSync(payloadPath(a,row)));
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'});await a.dispatch('captureRetry',{id:row.id});await a.runPromise;
  assert.equal(row.status,'completed');assert.equal(row.attempts,2);assert.deepEqual(row.sourceIds,ids);assert.equal(a.data.sources.length,1);
});
test('Failed second batch retries without extracting the six already processed files',async t=>{
  const {a,calls}=await setup(t,{chat:async(input,n)=>{if(n===2)throw new Error('fixture unavailable');return {tasks:[{title:`批次 ${n}`,criteria:'保存分析',sourceIds:input.sources.map(s=>s.id),steps:[{title:'分析',kind:'analysis'}]}]};}});
  const items=Array.from({length:10},(_,i)=>({title:`item-${i}.txt`,base64:Buffer.from(`材料 ${i}`).toString('base64')}));
  await a.dispatch('captureEnqueue',{items,...text(),organize:true});await a.runPromise;const row=a.data.captureQueue[0];
  assert.equal(row.status,'failed');assert.equal(row.sourceIds.length,11);assert.equal(a.data.tasks.length,1);assert.equal(a.data.sources.filter(s=>s.state==='processed').length,6);
  await a.dispatch('captureRetry',{id:row.id});await a.runPromise;
  assert.equal(row.status,'completed');assert.deepEqual(calls.map(c=>c.sources.length),[6,5,5]);assert.equal(a.data.tasks.length,2);assert.equal(a.data.sources.length,11);assert.equal(row.organizedSourceIds.length,11);
});
test('Queued receipt survives restart and an interrupted receipt requires explicit retry',async t=>{
  const {a,dir,chat}=await setup(t);busy(a);await a.dispatch('captureEnqueue',text());const id=a.data.captureQueue[0].id;
  const b=new Assistant({dir,chat});assert.equal(b.data.captureQueue[0].status,'queued');await drain(b);assert.equal(b.data.captureQueue[0].status,'completed');
  busy(b);await b.dispatch('captureEnqueue',{...text('中断资料'),organize:true});const row=b.data.captureQueue[1];row.status='processing';row.attempts=1;b.save();
  const c=new Assistant({dir,chat});const interrupted=c.data.captureQueue.find(r=>r.id===row.id);assert.equal(interrupted.status,'failed');assert.match(interrupted.lastError,/中断/);assert.equal(capture.tick(c),false);
  await c.dispatch('captureRetry',{id:row.id});await c.runPromise;assert.equal(interrupted.status,'completed');assert.equal(c.data.sources.length,2);assert.equal(c.data.captureQueue.find(r=>r.id===id).status,'completed');
});
test('Import receipt and created sources are persisted in the same commit',async t=>{
  const {a,dir}=await setup(t,{model:false});await a.dispatch('captureEnqueue',{...text(),organize:true});await a.runPromise;const row=a.data.captureQueue[0];
  const onDisk=JSON.parse(fs.readFileSync(a.file));assert.ok(onDisk.captureQueue[0].importedAt);assert.equal(onDisk.sources[0].captureId,row.id);assert.deepEqual(onDisk.captureQueue[0].sourceIds,[onDisk.sources[0].id]);
  onDisk.captureQueue[0].status='processing';onDisk.sources[0].state='processed';onDisk.sources[0].processedAt=new Date().toISOString();fs.writeFileSync(a.file,JSON.stringify(onDisk));
  const b=new Assistant({dir});await b.dispatch('captureRetry',{id:row.id});await b.runPromise;assert.equal(b.data.captureQueue[0].status,'completed');assert.equal(b.data.sources.length,1);assert.equal(b.data.tasks.length,0);
});
test('Paused stewardship queues without importing; resumed gate permits drain',async t=>{
  const {a}=await setup(t);await a.dispatch('stewardshipPause');await a.dispatch('captureEnqueue',text());assert.equal(a.data.captureQueue[0].status,'queued');assert.equal(a.data.sources.length,0);assert.equal(capture.tick(a),false);
  await a.dispatch('stewardshipResume');await drain(a);assert.equal(a.data.captureQueue[0].status,'completed');
});


test('Cancel queued and failed receipts releases private payloads without touching active work',async t=>{
  const {a}=await setup(t);busy(a);await a.dispatch('captureEnqueue',text());const row=a.data.captureQueue[0],controller=a.controller;
  await a.dispatch('captureCancel',{id:row.id});assert.equal(row.status,'cancelled');assert.equal(controller.signal.aborted,false);assert.ok(!fs.existsSync(payloadPath(a,row)));await assert.rejects(a.dispatch('captureRetry',{id:row.id}),/只有/);
});
test('Cancelling active organization retains imported material and aborts only that operation',async t=>{
  let entered,release;const started=new Promise(r=>entered=r);const {a}=await setup(t,{chat:async()=>{entered();await new Promise(r=>release=r);return {tasks:[]};}});
  await a.dispatch('captureEnqueue',{...text(),organize:true});await started;const row=a.data.captureQueue[0];await a.dispatch('captureCancel',{id:row.id});assert.equal(a.controller.signal.aborted,true);release();await a.runPromise;
  assert.equal(row.status,'cancelled');assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].state,'new');assert.equal(a.data.tasks.length,0);
});
test('Global stop pauses queued and active capture without silently restarting it',async t=>{
  let entered,release;const started=new Promise(r=>entered=r);const {a}=await setup(t,{chat:async()=>{entered();await new Promise(r=>release=r);return {tasks:[]};}});
  await a.dispatch('captureEnqueue',{...text('一'),organize:true});await started;await a.dispatch('captureEnqueue',text('二'));a.stop();release();await a.runPromise;
  assert.deepEqual(a.data.captureQueue.map(r=>r.status),['failed','failed']);assert.equal(capture.tick(a),false);assert.equal(a.data.sources.length,1);assert.equal(a.data.tasks.length,0);
});
test('Project is revalidated at drain and vanished project never becomes independent material',async t=>{
  const {a}=await setup(t);await a.dispatch('projectSave',{name:'项目'});const projectId=a.data.projects[0].id;busy(a);await a.dispatch('captureEnqueue',{...text(),projectId});a.data.projects=[];await drain(a);
  assert.equal(a.data.captureQueue[0].status,'failed');assert.match(a.data.captureQueue[0].lastError,/项目不存在/);assert.equal(a.data.sources.length,0);
});
test('Busy project collection waits then rejects orphan uncertain action without importing',async t=>{
  const {a}=await setup(t);await a.dispatch('projectSave',{name:'项目'});const p=a.data.projects[0],job=require('../desktop/agent.cjs').buildJob(a,{projectId:p.id,goal:'持续推进'});job.status='paused';a.data.delegations.push(job);p.jobId=job.id;a.data.agentActions.push({id:'uncertain',jobId:job.id,status:'uncertain'});
  busy(a);await a.dispatch('captureEnqueue',{...text(),projectId:p.id,organize:true});await drain(a);const row=a.data.captureQueue[0];assert.equal(row.status,'failed');assert.match(row.lastError,/外部动作待核对/);assert.equal(a.data.sources.length,0);
  a.data.agentActions[0].status='failed';await a.dispatch('captureRetry',{id:row.id});await a.runPromise;assert.equal(row.status,'completed');assert.equal(a.data.sources[0].projectId,p.id);assert.equal(job.status,'paused');
});
test('Mixed invalid input and size limits reject before creating receipts or payload files',async t=>{
  const {a,dir}=await setup(t);busy(a);
  for(const input of [{items:[{title:'ok.txt',base64:'YQ=='},{title:'bad.exe',base64:'YQ=='}]},text('x').textItems,{textItems:[{title:'x',content:'ok',segments:[{text:'bypass'}]}],items:[{title:'x.txt',base64:'!!!!'}]}, {items:[{title:'x.txt',base64:Buffer.alloc(10_000_001,97).toString('base64')}]}, {items:Array.from({length:3},(_,i)=>({title:`x${i}.txt`,base64:Buffer.alloc(9_000_000,97).toString('base64')}))}])await assert.rejects(a.dispatch('captureEnqueue',input));
  assert.equal(a.data.captureQueue.length,0);assert.equal(a.data.sources.length,0);assert.ok(!fs.existsSync(path.join(dir,'capture-payloads')));
});
test('Canonical base64 and no caller-injected source IDs or segment content are accepted',async t=>{
  const {a}=await setup(t);await assert.rejects(a.dispatch('captureEnqueue',{items:[{title:'x.txt',base64:'YR=='}]}),/编码/);
  await a.dispatch('captureEnqueue',{textItems:[{id:'forged',title:'文字',content:'保留文字',projectId:'forged',segments:[{text:'恶意附带内容'}]}]});await a.runPromise;
  const s=a.data.sources[0];assert.notEqual(s.id,'forged');assert.equal(s.projectId,null);assert.equal(s.segments,undefined);assert.equal(s.content,'保留文字');
});
test('Missing or tampered private payload is a visible failure and never empty success',async t=>{
  const {a}=await setup(t);busy(a);await a.dispatch('captureEnqueue',text('缺失'));const first=a.data.captureQueue[0];fs.unlinkSync(payloadPath(a,first));await drain(a);assert.equal(first.status,'failed');assert.match(first.lastError,/缺失/);
  busy(a);await a.dispatch('captureEnqueue',text('篡改'));const second=a.data.captureQueue[1];fs.writeFileSync(payloadPath(a,second),'{}');await drain(a);assert.equal(second.status,'failed');assert.match(second.lastError,/校验/);assert.equal(a.data.sources.length,0);
});
test('Private directory and payload symlinks cannot redirect collection contents',async t=>{
  const {a,dir}=await setup(t);busy(a);const outside=path.join(dir,'outside');fs.mkdirSync(outside);{if(!require('./helpers/symlink.cjs').link(t,outside,path.join(dir,'capture-payloads')))return;}await assert.rejects(a.dispatch('captureEnqueue',text()),/暂存目录无效/);assert.equal(fs.readdirSync(outside).length,0);
  fs.unlinkSync(path.join(dir,'capture-payloads'));await a.dispatch('captureEnqueue',text());const row=a.data.captureQueue[0],file=payloadPath(a,row),target=path.join(outside,'payload.json');fs.renameSync(file,target);{if(!require('./helpers/symlink.cjs').link(t,target,file))return;}await drain(a);assert.equal(row.status,'failed');assert.equal(a.data.sources.length,0);assert.ok(fs.existsSync(target));
});
test('Forged receipt path cannot read outside private payload directory',async t=>{
  const {a}=await setup(t);a.data.captureQueue.push({id:'../../workspace',status:'queued',stage:'import',sourceIds:[],organizedSourceIds:[],organize:false,projectId:null});assert.equal(capture.tick(a),true);await a.runPromise;assert.equal(a.data.captureQueue[0].status,'failed');assert.match(a.data.captureQueue[0].lastError,/编号/);assert.equal(a.data.sources.length,0);
});
test('Held payload count and total budget reject without adding a new receipt',async t=>{
  const {a}=await setup(t);busy(a);for(let i=0;i<50;i++)await a.dispatch('captureEnqueue',text(String(i)));await assert.rejects(a.dispatch('captureEnqueue',text('51')),/暂存已达/);assert.equal(a.data.captureQueue.length,50);
  await a.dispatch('captureCancel',{id:a.data.captureQueue[0].id});await a.dispatch('captureEnqueue',text('释放后'));assert.equal(a.data.captureQueue.length,51);
  a.data.captureQueue=[{id:crypto.randomUUID(),status:'queued',bytes:100_000_000}];await assert.rejects(a.dispatch('captureEnqueue',text('超限')),/暂存已达/);assert.equal(a.data.captureQueue.length,1);
});
test('Backup restore preserves newer completion/cancellation and processed source state',async t=>{
  const {a,calls}=await setup(t,{model:false});await a.dispatch('captureEnqueue',{...text('先导入'),organize:true});await a.runPromise;const row=a.data.captureQueue[0];const backups=await a.dispatch('backupCreate'),backupId=backups.find(b=>b.reason==='manual').id;
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'});await a.dispatch('captureRetry',{id:row.id});await a.runPromise;busy(a);await a.dispatch('captureEnqueue',text('已取消'));await a.dispatch('captureCancel',{id:a.data.captureQueue[1].id});await a.dispatch('captureEnqueue',text('等恢复'));a.operation=null;a.controller=null;
  await a.dispatch('backupRestore',{id:backupId});assert.deepEqual(a.data.captureQueue.map(r=>r.status),['completed','cancelled','failed']);assert.equal(a.data.sources[0].state,'processed');assert.equal(calls.length,1);assert.equal(capture.tick(a),false);
});
test('Ordinary export includes bounded receipts but no queued text or file bytes',async t=>{
  const {a}=await setup(t);busy(a);const secret='仅在暂存侧文件出现的原始内容';await a.dispatch('captureEnqueue',{items:[{title:'input.txt',base64:Buffer.from(secret).toString('base64')}],textItems:[{title:'手动',content:secret}]});const exported=await a.dispatch('export');const json=JSON.stringify(exported);
  assert.equal(exported.captureQueue.length,1);assert.ok(!json.includes(secret));assert.ok(!json.includes(Buffer.from(secret).toString('base64')));assert.ok(!json.includes('payloadHash'));
});
