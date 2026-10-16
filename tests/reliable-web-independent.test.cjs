const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),tools=require('../desktop/agent-tools.cjs');
async function setup(t,webRequest){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-web-audit-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,webRequest,chat:async()=>{throw new Error('unexpected model');}});await a.dispatch('projectSave',{name:'独立审查项目'});const p=a.data.projects[0];await a.dispatch('webConnectionSave',{name:'公开公告',url:'https://example.com/news',projectId:p.id,intervalMinutes:5,enabled:true});return {a,p,c:a.data.webConnections[0]};}
const response=(body='版本A')=>({status:200,url:'https://example.com/news',headers:{'content-type':'text/plain; charset=utf-8'},body});
test('Stopping during DNS must release the operation without waiting for DNS and never open a socket',async t=>{
  const dns=require('node:dns/promises'),https=require('node:https');let resolveDNS,sockets=0;const controller=new AbortController();
  t.mock.method(dns,'lookup',()=>new Promise(resolve=>{resolveDNS=resolve;}));t.mock.method(https,'request',()=>{sockets++;throw new Error('unexpected socket');});
  let finished=false;const operation=tools.publicRequest('https://example.com/news',{signal:controller.signal,allowedOrigin:'https://example.com'}).then(()=>{finished=true;},()=>{finished=true;});
  controller.abort();await new Promise(resolve=>setTimeout(resolve,30));const cancelledPromptly=finished;resolveDNS([{address:'93.184.216.34',family:4}]);await operation;
  assert.equal(cancelledPromptly,true,'DNS lookup must not hold the operation after cancellation');assert.equal(sockets,0);
});
test('Queue submissions during web read survive subscription rollback and restart exactly once',async t=>{
  let finish;const {a,c}=await setup(t,()=>new Promise(resolve=>finish=resolve));await a.dispatch('webConnectionSync',{id:c.id});await a.dispatch('captureEnqueue',{textItems:[{title:'读取期间收集',content:'这段输入不能被网页回滚丢掉'}]});const receipt=a.data.captureQueue[0];
  const projects=require('../desktop/projects.cjs'),original=projects.ingest;t.mock.method(projects,'ingest',(...args)=>{original(...args);throw new Error('forced project rollback');});finish(response());await a.runPromise;
  assert.equal(a.data.webConnectionRuns[0].status,'error');assert.equal(a.data.captureQueue[0].id,receipt.id);assert.equal(a.data.captureQueue[0].status,'queued');assert.equal(a.data.sources.length,0);
  const b=new Assistant({dir:a.dir,webRequest:async()=>response()});require('../desktop/capture.cjs').tick(b);await b.runPromise;assert.equal(b.data.captureQueue[0].status,'completed');assert.equal(b.data.sources.length,1);assert.equal(b.data.sources[0].title,'读取期间收集');
});
test('Global stop during a web read cancels commit and retains newly queued input for explicit retry',async t=>{
  let finish;const {a,c}=await setup(t,()=>new Promise(resolve=>finish=resolve));await a.dispatch('webConnectionSync',{id:c.id});await a.dispatch('captureSave',{textItems:[{title:'稍后整理',content:'已接受但尚未导入'}]});a.stop();finish(response('不应归并'));await a.runPromise;
  assert.equal(a.data.sources.length,0);assert.equal(a.data.captureQueue[0].status,'failed');assert.equal(a.data.webConnections[0].enabled,false);assert.equal(a.data.webConnectionRuns[0].status,'paused');assert.ok(fs.existsSync(path.join(a.dir,'capture-payloads',a.data.captureQueue[0].id+'.json')));
});
test('Paused subscriptions and cancelled collection do not resurrect after two older backup restores',async t=>{
  const {a,c}=await setup(t,async()=>response());const recovery=require('../desktop/recovery.cjs');const first=recovery.create(a);await a.dispatch('webConnectionSync',{id:c.id});await a.runPromise;await a.dispatch('stewardshipPause');await a.dispatch('captureEnqueue',{textItems:[{title:'待取消',content:'不能恢复执行'}]});const row=a.data.captureQueue[0],second=recovery.create(a);await a.dispatch('captureCancel',{id:row.id});await a.dispatch('webConnectionDelete',{id:c.id});
  for(const id of [first,second]){await a.dispatch('backupRestore',{id});assert.equal(a.data.webConnections.length,0);assert.equal(a.data.captureQueue[0].status,'cancelled');assert.equal(a.data.sources.length,1);assert.equal(require('../desktop/capture.cjs').tick(a),false);}
});
test('Same page in separate projects versions independently and does not modify the other project',async t=>{
  let body='初始';const {a,c,p}=await setup(t,async()=>response(body));await a.dispatch('projectSave',{name:'第二项目'});const other=a.data.projects[0];await a.dispatch('webConnectionSave',{name:'另一个订阅',url:c.url,projectId:other.id,intervalMinutes:5,enabled:true});const second=a.data.webConnections[1];
  for(const row of [c,second]){await a.dispatch('webConnectionSync',{id:row.id});await a.runPromise;}
  const old=a.data.sources.find(s=>s.projectId===other.id);body='更新';await a.dispatch('webConnectionSync',{id:c.id});await a.runPromise;
  assert.equal(a.data.sources.filter(s=>s.projectId===p.id).length,2);assert.deepEqual(a.data.sources.filter(s=>s.projectId===other.id),[old]);assert.equal(old.version,1);
});
