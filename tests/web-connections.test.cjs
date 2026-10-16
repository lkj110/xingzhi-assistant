const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PassThrough}=require('node:stream');
const {EventEmitter}=require('node:events');
const {Assistant}=require('../desktop/core.cjs');
const web=require('../desktop/web-connections.cjs');
const tools=require('../desktop/agent-tools.cjs');
const agent=require('../desktop/agent.cjs');
const projects=require('../desktop/projects.cjs');
const followup=require('../desktop/agent-followup.cjs');
const recovery=require('../desktop/recovery.cjs');
async function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-web-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let response={status:200,headers:{'content-type':'text/html; charset=utf-8'},body:'<title>公告</title><article>第一版</article>',url:'https://example.com/news'},requestCount=0;
  const request=async(url,options)=>{requestCount++;assert.equal(options.allowedOrigin,new URL(url).origin);return typeof response==='function'?response(url,options):structuredClone(response);};
  const a=new Assistant({dir:path.join(root,'workspace'),chat:async()=>{throw new Error('unexpected model call');},webRequest:request});
  const project=async(name='发布项目')=>{await a.dispatch('projectSave',{name});return a.data.projects[0];};
  const p=await project();
  const add=async(config={})=>{await a.dispatch('webConnectionSave',{name:'发布公告',url:'https://example.com/news',projectId:p.id,intervalMinutes:30,enabled:true,...config});return a.data.webConnections.at(-1);};
  const sync=async(c)=>{await a.dispatch('webConnectionSync',{id:c.id});await a.runPromise;return a.data.webConnectionRuns[0];};
  const job=async()=>{await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'mock',type:'ollama',baseUrl:'http://127.0.0.1:9',model:'mock'});const j=agent.buildJob(a,{projectId:p.id,goal:'跟进发布',allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.unshift(j);p.jobId=j.id;projects.ingest(a,p);return j;};
  return {a,p,project,add,sync,job,set:value=>{response=typeof value==='string'?{...response,body:`<title>公告</title><article>${value}</article>`}:value;},requests:()=>requestCount};
}
test('Creating a subscription validates exact scope and never fetches or calls a model',async t=>{
  const {a,p,add,requests}=await setup(t);const c=await add({url:'https://example.com/news#section'});assert.equal(c.url,'https://example.com/news');assert.equal(c.projectId,p.id);assert.equal(requests(),0);assert.equal(a.data.sources.length,0);assert.equal((a.data.modelCalls||[]).length,0);
  assert.equal(a.publicState().webConnections.length,1);
});
test('Invalid credentials, protocols, ports, local URLs, names, projects and intervals reject atomically',async t=>{
  const {a,add}=await setup(t);
  for(const url of ['file:///tmp/a','https://u:p@example.com/','https://example.com:3000/','http://127.0.0.1/','http://169.254.169.254/','http://[::1]/','https://demo.local/','http://localhost/','not a url'])await assert.rejects(add({url}));
  for(const config of [{name:''},{projectId:'missing'},{intervalMinutes:4},{intervalMinutes:1441},{intervalMinutes:6.5},{enabled:'yes'}])await assert.rejects(add(config));
  assert.equal(a.data.webConnections.length,0);assert.equal(a.data.sources.length,0);
});
test('Duplicate normalized URL within a project rejects; another project is isolated; edits cannot change scope',async t=>{
  const {a,add,project}=await setup(t);const c=await add();await assert.rejects(add({url:c.url+'#x'}),/同一网页/);const p=await project('另一个项目');await add({projectId:p.id});
  const before=structuredClone(c);await assert.rejects(a.dispatch('webConnectionSave',{...c,projectId:p.id}),/新建订阅/);await assert.rejects(a.dispatch('webConnectionSave',{...c,url:'https://example.com/other'}),/新建订阅/);assert.deepEqual(c,before);assert.equal(a.data.webConnections.length,2);
});
test('Public HTML creates durable provenance without scripts, comments or implicit permissions',async t=>{
  const {a,p,add,sync,set,job}=await setup(t);const j=await job();assert.equal(j.allowWeb,false);
  const c=await add();set({status:200,headers:{'content-type':'text/html'},url:c.url,body:'<title>计划 &amp; 发布</title><!-- secret --><script>doSomething()</script><style>.secret{}</style><p>期限 &#x4e8c; 月</p><template>hidden</template>'});await sync(c);
  const s=a.data.sources[0];assert.equal(s.projectId,p.id);assert.equal(s.origin,c.url);assert.equal(s.resolvedUrl,c.url);assert.equal(s.webConnectionId,c.id);assert.match(s.identity,/^web:/);assert.equal(s.title,'计划 & 发布');assert.equal(s.version,1);assert.match(s.content,/期限 二 月/);assert.doesNotMatch(s.content,/secret|doSomething|hidden/);assert.equal(s.format,'txt');assert.ok(s.segments.length);assert.equal((a.data.modelCalls||[]).length,0);assert.equal(j.allowWeb,false);assert.equal(j.fileMode,'off');assert.equal(j.githubMode,'off');
});
test('Unchanged reads including script-only changes do not duplicate material or wake project',async t=>{
  const {a,add,sync,job,set,requests}=await setup(t);const j=await job(),c=await add();await sync(c);j.status='completed';j.completedAt='2026-01-01';set({status:200,headers:{'content-type':'text/html'},url:c.url,body:'<title>公告</title><article>第一版</article><script>newTimestamp()</script>'});const r=await sync(c);assert.equal(r.status,'unchanged');assert.equal(a.data.sources.length,1);assert.equal(j.status,'completed');assert.equal(j.completedAt,'2026-01-01');assert.equal(requests(),2);assert.equal((a.data.modelCalls||[]).length,0);
});
test('A→B→A preserves a continuous three-version history and does not create a second job',async t=>{
  const {a,add,sync,job,set}=await setup(t);const j=await job(),c=await add();for(const body of ['甲','乙','甲']){set(body);await sync(c);}assert.equal(a.data.sources.length,3);assert.deepEqual(a.data.sources.map(s=>s.version),[3,2,1]);assert.equal(a.data.sources[0].previousSourceId,a.data.sources[1].id);assert.equal(a.data.sources[1].previousSourceId,a.data.sources[2].id);assert.equal(a.data.delegations.length,1);assert.equal(j.sourceIds.length,3);assert.equal(c.imported,3);assert.equal(j.status,'ready');
});
test('Changed material invalidates acceptance and stale approvals while preserving paused jobs',async t=>{
  const {a,add,sync,job,set}=await setup(t);const j=await job(),c=await add();await sync(c);const source=a.data.sources[0];const planned=await agent.act(a,j,'plan_task',{key:'brief',title:'写简报',criteria:'根据发布公告',sourceIds:[source.id],steps:[{key:'draft',title:'写简报',kind:'draft'}]});const task=a.task(planned.taskId);task.status='completed';task.verification={passed:true};j.status='paused';a.data.agentActions.push({id:'pending',jobId:j.id,status:'pending',approvedAt:'old'});j.pendingActionId='pending';set('新版');await sync(c);assert.equal(j.status,'paused');assert.equal(task.verification,null);assert.match(task.needsReplan,/更新/);assert.equal(task.sourceIds.length,2);assert.equal(a.data.agentActions[0].status,'stale');assert.equal(a.data.agentActions[0].approvedAt,undefined);assert.equal(j.pendingActionId,null);
});
test('Orphan uncertain action blocks changing sources and retains fingerprints for retry',async t=>{
  const {a,add,sync,job,set}=await setup(t);const j=await job(),c=await add();await sync(c);a.data.agentActions.push({id:'orphan',jobId:j.id,status:'uncertain'});set('新版');assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.match(c.error,/外部动作待核对/);a.data.agentActions=[];await sync(c);assert.equal(a.data.sources.length,2);assert.equal(c.failures,0);
});
test('HTTP failures, empty, binary, invalid encoding and oversized responses never delete old evidence',async t=>{
  const {a,add,sync,set}=await setup(t);const c=await add();await sync(c);const id=a.data.sources[0].id;
  for(const response of [{status:404,body:'not found'},{status:500,body:'error'},{status:200,body:'<script>x</script>',headers:{'content-type':'text/html'}},{status:200,body:'binary',headers:{'content-type':'application/pdf'}},{status:200,body:'有文字',headers:{'content-type':'text/html;charset=gbk'}},{status:200,body:'x'.repeat(500001),headers:{'content-type':'text/plain'}},{status:200,body:'x'.repeat(2_000_001)}]){set({url:c.url,headers:{'content-type':'text/plain'},...response});assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].id,id);assert.equal(a.data.sources[0].deleted,undefined);}assert.ok(c.nextRunAt);assert.ok(c.lastSuccessAt);
});
test('Full body changes past the legacy 30k extraction boundary create a new version',async t=>{
  const {a,add,sync,set}=await setup(t);const c=await add();set('正'.repeat(35000)+'第一版');await sync(c);set('正'.repeat(35000)+'第二版');await sync(c);assert.equal(a.data.sources.length,2);assert.ok(a.data.sources[0].content.endsWith('第二版'));assert.ok(a.data.sources[0].content.length>35000);
});
test('A title-only update also versions while JSON and plain text remain literal',async t=>{
  const {a,add,sync,set}=await setup(t);const c=await add();await sync(c);set({status:200,headers:{'content-type':'text/html'},url:c.url,body:'<title>新标题</title><article>第一版</article>'});await sync(c);assert.equal(a.data.sources[0].version,2);set({status:200,headers:{'content-type':'application/json; charset=UTF-8'},url:c.url,body:'{"instruction":"<script>literal</script>"}'});await sync(c);assert.equal(a.data.sources[0].content,'{"instruction":"<script>literal</script>"}');
});
test('Pausing skips background read; manual check works once without enabling subscription',async t=>{
  const {a,add,sync,requests}=await setup(t);const c=await add({enabled:false});assert.equal(web.tick(a),false);assert.equal(requests(),0);await sync(c);assert.equal(requests(),1);assert.equal(c.enabled,false);assert.equal(c.nextRunAt,null);await a.dispatch('webConnectionToggle',{id:c.id,enabled:true});assert.ok(c.nextRunAt);await assert.rejects(a.dispatch('webConnectionToggle',{id:c.id,enabled:1}));
});
test('Tick respects global pause, suspension, work window, due time and current operation',async t=>{
  const {a,add,requests}=await setup(t);const c=await add();a.data.stewardship.paused=true;assert.equal(web.tick(a),false);a.data.stewardship.paused=false;a.suspended=true;assert.equal(web.tick(a),false);a.suspended=false;a.operation={label:'other'};assert.equal(web.tick(a),false);a.operation=null;c.nextRunAt=new Date(Date.now()+3600000).toISOString();assert.equal(web.tick(a),false);
  c.nextRunAt=new Date(Date.now()-1000).toISOString();const minute=new Date().getUTCHours()*60+new Date().getUTCMinutes(),clock=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;a.data.stewardship.timeZone='UTC';a.data.stewardship.window={enabled:true,start:clock((minute+60)%1440),end:clock((minute+120)%1440)};assert.equal(web.tick(a),false);a.data.stewardship.window.enabled=false;assert.equal(requests(),0);assert.equal(web.tick(a),true);await a.runPromise;assert.equal(requests(),1);assert.equal(a.operation,null);
});
test('In-flight stop leaves no partial source and disables later background fetch',async t=>{
  const {a,add,set}=await setup(t);const c=await add();let release;set(()=>new Promise(resolve=>{release=resolve;}));await a.dispatch('webConnectionSync',{id:c.id});assert.ok(a.operation);await assert.rejects(a.dispatch('webConnectionDelete',{id:c.id}),/正在处理/);a.stop();release({status:200,headers:{'content-type':'text/plain'},body:'未完整读取',url:c.url});await a.runPromise;assert.equal(a.data.sources.length,0);assert.equal(a.operation,null);assert.equal(c.enabled,false);assert.equal(c.nextRunAt,null);assert.equal(a.data.webConnectionRuns[0].status,'paused');
});
test('Project undo exclusions remain excluded until user explicitly attaches material',async t=>{
  const {a,p,add,sync,set}=await setup(t);const c=await add();await sync(c);const first=a.data.sources[0];first.projectExcluded=true;set('新版');assert.equal((await sync(c)).status,'excluded');assert.equal(a.data.sources.length,1);await a.dispatch('projectAttach',{id:p.id,sourceIds:[first.id]});await sync(c);assert.equal(a.data.sources.length,2);assert.equal(a.data.sources[0].version,2);
});
test('Removal revokes all future subscription reads and keeps stored evidence',async t=>{
  const {a,add,sync,requests}=await setup(t);const c=await add();await sync(c);await a.dispatch('webConnectionDelete',{id:c.id});assert.equal(web.tick(a),false);await assert.rejects(a.dispatch('webConnectionSync',{id:c.id}),/已移除/);assert.equal(requests(),1);assert.equal(a.data.sources.length,1);assert.equal(a.data.webConnections.length,0);
});
test('Independent tasks referencing old web material invalidate artifacts but preserve pause',async t=>{
  const {a,add,sync,set}=await setup(t);const c=await add();await sync(c);const id=a.data.sources[0].id,task=a.createTask({title:'简报',sourceIds:[id]}),paused=a.createTask({title:'暂停简报',sourceIds:[id]});task.status='completed';task.verification={passed:true};task.steps[0].done=true;task.steps[0].artifactId='old';paused.status='paused';set('新版');await sync(c);assert.equal(task.status,'blocked');assert.equal(task.verification,null);assert.equal(task.steps[0].done,false);assert.equal(task.steps[0].artifactId,undefined);assert.equal(paused.status,'paused');assert.equal(task.sourceIds.length,2);
});
test('Current source context and waits use one stable web subscription key; removing connection prevents resolution',async t=>{
  const {a,add,sync,job,set}=await setup(t);const j=await job(),c=await add();await sync(c);const first=a.data.sources[0];assert.equal(agent.context(a,j).sources[0].current,true);followup.wait(a,j,{key:'result',expected:'网页正式发布',sourceIds:[first.id],reason:'等发布'});set('正式发布');await sync(c);const current=a.data.sources[0],choices=followup.sources(a,j);assert.equal(choices.length,1);assert.equal(choices[0].sourceId,current.id);assert.deepEqual(j.followups[0].watchKeys,[choices[0].key]);assert.equal(agent.context(a,j).sources.filter(s=>s.current).length,1);await a.dispatch('webConnectionDelete',{id:c.id});assert.equal(followup.sources(a,j).length,0);await assert.rejects(followup.resolve(a,j,{key:'result',sourceId:current.id,evidence:'正式发布'}),/对应来源/);
});
test('Backup restore retains current scope and newer web evidence, pauses read, and reconciles same-content source',async t=>{
  const {a,add,sync,job,set}=await setup(t);const j=await job(),c=await add();await sync(c);const backup=recovery.create(a);set('第二版');await sync(c);const later=a.data.sources[0];await a.dispatch('backupRestore',{id:backup});const restored=a.data.webConnections.find(w=>w.id===c.id);assert.equal(restored.enabled,false);assert.equal(restored.nextRunAt,null);assert.ok(a.data.sources.some(s=>s.id===later.id));const restoredJob=a.data.delegations.find(x=>x.id===j.id);assert.equal(restoredJob.sourceIds.includes(later.id),true,'restore replays durable source evidence');const feedbackCount=restoredJob.feedback.length;await sync(restored);assert.equal(restoredJob.feedback.length,feedbackCount,'unchanged recheck does not replay business input');const currentJob=a.data.delegations.find(x=>x.id===j.id);assert.equal(a.data.sources.length,2);assert.equal(currentJob.sourceIds.includes(later.id),true);assert.equal(currentJob.status,'paused');assert.equal(currentJob.sourceIds.length,2);
});
test('Backup restore never resurrects revoked subscription',async t=>{
  const {a,add,sync}=await setup(t);const c=await add();await sync(c);const backup=recovery.create(a);await a.dispatch('webConnectionDelete',{id:c.id});await a.dispatch('backupRestore',{id:backup});assert.equal(a.data.webConnections.length,0);assert.equal(a.data.sources.length,1);
});
test('Restart recovers interrupted history and persisted successful versions without duplicates',async t=>{
  const {a,add,sync}=await setup(t);const c=await add();await sync(c);a.data.webConnectionRuns.unshift({id:'inflight',webConnectionId:c.id,status:'running',startedAt:new Date().toISOString()});a.save();const next=new Assistant({dir:a.dir,webRequest:a.webRequest});assert.equal(next.data.webConnectionRuns[0].status,'interrupted');await next.dispatch('webConnectionSync',{id:c.id});await next.runPromise;assert.equal(next.data.sources.length,1);assert.equal(next.data.webConnectionRuns[0].status,'unchanged');
});
function transport(t,steps,addresses){
  let calls=0,lookups=0;const dns=require('node:dns/promises'),https=require('node:https');
  t.mock.method(dns,'lookup',async()=>{const list=addresses?.[lookups++]||[{address:'93.184.216.34',family:4}];return list;});
  t.mock.method(https,'request',(url,options,callback)=>{calls++;const step=steps.shift();assert.ok(step,'unexpected HTTP request');const req=new EventEmitter();req.write=()=>{};req.end=()=>{queueMicrotask(()=>{const res=new PassThrough();res.statusCode=step.status;res.headers=step.headers||{'content-type':'text/plain'};callback(res);res.end(step.body||'正文');});};return req;});
  return {calls:()=>calls,lookups:()=>lookups};
}
test('Scoped publicRequest rejects cross-origin redirect before DNS lookup or second connection',async t=>{
  const request=transport(t,[{status:302,headers:{location:'https://other.example/path'}}]);await assert.rejects(tools.publicRequest('https://example.com/news',{allowedOrigin:'https://example.com'}),/超出已授权/);assert.equal(request.calls(),1);
});
test('Scoped publicRequest permits same-origin redirects and rechecks DNS, pinning each request',async t=>{
  const request=transport(t,[{status:302,headers:{location:'/final'}},{status:200,body:'最终正文'}]);const result=await tools.publicRequest('https://example.com/news',{allowedOrigin:'https://example.com'});assert.equal(result.url,'https://example.com/final');assert.equal(result.body,'最终正文');assert.equal(request.calls(),2);
});
test('DNS rebinding to private address on same-origin redirect is rejected before second connection',async t=>{
  const request=transport(t,[{status:302,headers:{location:'/private'}}],[[{address:'93.184.216.34',family:4}],[{address:'127.0.0.1',family:4}]]);await assert.rejects(tools.publicRequest('https://example.com/news',{allowedOrigin:'https://example.com'}),/只访问公网/);assert.equal(request.calls(),1);assert.equal(request.lookups(),2);
});
test('Mixed public/private DNS and cross-origin initial scoped URLs fail before a socket opens',async t=>{
  const request=transport(t,[],[[{address:'93.184.216.34',family:4},{address:'10.0.0.2',family:4}]]);await assert.rejects(tools.publicRequest('https://example.com/',{allowedOrigin:'https://example.com'}),/只访问公网/);await assert.rejects(tools.publicRequest('https://other.example/',{allowedOrigin:'https://example.com'}),/超出已授权/);assert.equal(request.calls(),0);
});
test('Mock transport cannot bypass final URL scope validation or local address check',async t=>{
  const {a,add,sync,set}=await setup(t);const c=await add();for(const url of ['https://other.example/page','http://127.0.0.1/']){set({status:200,headers:{'content-type':'text/plain'},body:'越界',url});assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,0);}
});
test('Project merge failure rolls back new source, acceptance and approvals as one transaction',async t=>{
  const {a,add,sync,set,job}=await setup(t);const j=await job(),c=await add();await sync(c);j.status='completed';const prior=structuredClone(j);set('第二版');const original=projects.ingest;t.mock.method(projects,'ingest',(...args)=>{original(...args);throw new Error('模拟归并失败');});const run=await sync(c);assert.equal(run.status,'error');assert.equal(a.data.sources.length,1);assert.deepEqual(a.data.delegations.find(x=>x.id===j.id),prior);assert.equal(a.data.webConnections.find(x=>x.id===c.id).imported,1);assert.equal(a.data.webConnectionRuns[0].status,'error');
});
test('Equal timestamps cannot reverse the explicit web version chain after restart',async t=>{
  const {a,add,sync,set,job}=await setup(t);const j=await job(),c=await add();for(const body of ['甲','乙','甲']){set(body);await sync(c);for(const s of a.data.sources)s.createdAt='2026-10-01T00:00:00.000Z';}a.save();const restarted=new Assistant({dir:a.dir,webRequest:a.webRequest});await restarted.dispatch('webConnectionSync',{id:c.id});await restarted.runPromise;assert.deepEqual(restarted.data.sources.map(s=>s.version),[3,2,1]);assert.equal(restarted.data.sources[0].previousSourceId,restarted.data.sources[1].id);assert.equal(restarted.data.delegations.find(x=>x.id===j.id).sourceIds.length,3);
});
test('Updated web evidence invalidates resolved waits and source-backed memory',async t=>{
  const {a,add,sync,set,job}=await setup(t);const j=await job(),c=await add();await sync(c);const s=a.data.sources[0];j.followups.push({key:'approved',expected:'发布日期确定',status:'resolved',sourceId:s.id,sourceIds:[s.id],watchKeys:[`webConnection:${c.id}`],resolvedAt:new Date().toISOString(),verification:{quote:'第一版',reason:'已确认'}});await a.dispatch('memorySave',{title:'发布日期',content:'第一版',kind:'fact',sourceId:s.id,projectId:s.projectId});set('第二版');await sync(c);assert.equal(j.followups[0].status,'waiting');assert.equal(j.followups[0].sourceId,undefined);assert.equal(j.followups[0].previousResolutions[0].sourceId,s.id);assert.equal(a.publicState().memories[0].effective,false);
});
test('Failed reads back off without polling more frequently than the saved interval',async t=>{
  const {a,add,sync,set}=await setup(t);const c=await add({intervalMinutes:1440});set(()=>{throw new Error('网络断开');});const start=Date.now();await sync(c);assert.equal(a.data.webConnectionRuns[0].status,'error');assert.ok(Date.parse(c.nextRunAt)>=start+1440*60000);assert.equal(c.imported,0);
});
test('Stopping while DNS is pending releases the request without opening a late socket',async t=>{
  const dns=require('node:dns/promises'),https=require('node:https');let resolveDNS,sockets=0;t.mock.method(dns,'lookup',()=>new Promise(resolve=>{resolveDNS=resolve;}));t.mock.method(https,'request',()=>{sockets++;throw new Error('must not connect');});const controller=new AbortController(),pending=tools.publicRequest('https://example.com/',{signal:controller.signal,allowedOrigin:'https://example.com'});controller.abort();await assert.rejects(pending,/停止|abort/i);resolveDNS([{address:'93.184.216.34',family:4}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(sockets,0);
});

test('Legacy uncertain receipts identified by pending pointer or affected task block webpage replacement',async t=>{
 for(const linkage of ['pending','task']){
  const {a,add,sync,job,set}=await setup(t),c=await add(),j=await job();await sync(c);
  const task=a.createTask({title:'已交付事项',sourceIds:[a.data.sources[0].id]});task.agentJobId=j.id;j.taskIds.push(task.id);task.status='completed';
  const action={id:'legacy-receipt',status:'uncertain'};if(linkage==='pending')j.pendingActionId=action.id;else action.taskId=task.id;a.data.agentActions.push(action);
  set('需要重新交付的新内容');const before=structuredClone(task);assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.deepEqual(a.task(task.id),before);assert.equal(action.status,'uncertain');
 }
});

test('A webpage source wrongly referenced from a different project cannot replan that project',async t=>{
 const {a,add,sync,job,set,project}=await setup(t),c=await add();await job();await sync(c);const source=a.data.sources[0],other=await project('其他项目');const task=a.createTask({title:'其他项目成果',sourceIds:[source.id]});task.projectId=other.id;task.status='completed';const before=structuredClone(task);
 set('更新资料');assert.equal((await sync(c)).status,'error');assert.match(a.data.webConnections[0].error,/其他项目/);assert.equal(a.data.sources.length,1);assert.deepEqual(a.task(task.id),before);
});
