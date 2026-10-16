const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PassThrough}=require('node:stream');
const {EventEmitter}=require('node:events');
const {Assistant}=require('../desktop/core.cjs');
const feeds=require('../desktop/feeds.cjs');
const projects=require('../desktop/projects.cjs');
const agent=require('../desktop/agent.cjs');
const followup=require('../desktop/agent-followup.cjs');
const recovery=require('../desktop/recovery.cjs');
const tools=require('../desktop/agent-tools.cjs');
const item=(id='1',body='第一版',title='发布公告')=>`<item><guid>${id}</guid><title>${title}</title><link>https://example.com/post/${id}</link><description><![CDATA[${body}]]></description></item>`;
const rss=(content=item())=>`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>公告</title>${content}</channel></rss>`;
const atom=content=>`<feed xmlns="http://www.w3.org/2005/Atom">${content}</feed>`;
async function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-feeds-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let response={status:200,headers:{'content-type':'application/rss+xml;charset=utf-8'},url:'https://example.com/feed.xml',body:rss()},requests=0;
  const request=async(url,options)=>{requests++;assert.equal(options.allowedOrigin,new URL(url).origin);return typeof response==='function'?response(url,options):structuredClone(response);};
  const a=new Assistant({dir:path.join(root,'workspace'),chat:async()=>{throw new Error('unexpected model call');},webRequest:request});feeds.initialize(a,request);
  await a.dispatch('projectSave',{name:'订阅项目'});const p=a.data.projects[0];
  const add=async(config={})=>{await feeds.dispatch(a,'feedConnectionSave',{name:'发布订阅',url:'https://example.com/feed.xml',projectId:p.id,intervalMinutes:30,...config});return a.data.feedConnections.at(-1);};
  const sync=async c=>{await feeds.dispatch(a,'feedConnectionSync',{id:c.id});await a.runPromise;return a.data.feedConnectionRuns[0];};
  const job=async()=>{await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'mock',type:'ollama',baseUrl:'http://127.0.0.1:9',model:'mock'});const j=agent.buildJob(a,{projectId:p.id,goal:'跟进发布',allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.unshift(j);projects.byId(a,p.id).jobId=j.id;projects.ingest(a,projects.byId(a,p.id));return j;};
  return {a,p,add,sync,job,row:c=>a.data.feedConnections.find(r=>r.id===c.id),set:next=>{response=typeof next==='string'?{status:200,headers:{'content-type':'application/xml'},url:'https://example.com/feed.xml',body:next}:next;},requests:()=>requests};
}
test('RSS subscription saves paused by default, normalizes URL, binds project, and reads only on manual check',async t=>{
  const {a,p,add,sync,requests}=await setup(t),c=await add({url:'https://EXAMPLE.com:443/feed.xml#section'});
  assert.equal(c.url,'https://example.com/feed.xml');assert.equal(c.enabled,false);assert.equal(c.nextRunAt,null);assert.equal(feeds.tick(a),false);assert.equal(requests(),0);
  await sync(c);assert.equal(requests(),1);assert.equal(c.enabled,false);assert.equal(c.nextRunAt,null);assert.equal(a.data.sources[0].projectId,p.id);assert.equal((a.data.modelCalls||[]).length,0);
});
test('Subscription validation rejects credentials, private hosts, nonstandard ports, invalid projects and settings',async t=>{
  const {a,add}=await setup(t);
  for(const url of ['file:///tmp/feed','https://u:p@example.com/feed','https://example.com:8000/','http://127.0.0.1/','http://169.254.169.254/','http://[::1]/','https://demo.internal/','http://localhost/','invalid'])await assert.rejects(add({url}));
  for(const config of [{name:''},{name:'x'.repeat(101)},{projectId:'missing'},{intervalMinutes:4},{intervalMinutes:1441},{intervalMinutes:6.5},{enabled:'yes'}])await assert.rejects(add(config));
  assert.equal(a.data.feedConnections.length,0);assert.equal(a.data.sources.length,0);
});
test('Same normalized subscription in one project rejects; another project is isolated; scope is immutable',async t=>{
  const {a,add}=await setup(t),c=await add();await assert.rejects(add({url:c.url+'#x'}),/同一 RSS/);await a.dispatch('projectSave',{name:'其他项目'});const p=a.data.projects[0];await add({projectId:p.id});
  await assert.rejects(feeds.dispatch(a,'feedConnectionSave',{...c,projectId:p.id}),/新建 RSS/);await assert.rejects(feeds.dispatch(a,'feedConnectionSave',{...c,url:'https://example.com/other'}),/新建 RSS/);assert.equal(a.data.feedConnections.length,2);
});
test('RSS content namespace, HTML text, metadata and provenance import without fetching article links',async t=>{
  const {a,add,sync,set,job,requests}=await setup(t),j=await job(),c=await add();
  set(rss('<item xmlns:content="http://purl.org/rss/1.0/modules/content/"><guid>stable</guid><title>版本 &amp; 发布</title><link>/post#part</link><pubDate>Thu, 01 Oct 2026 10:00:00 GMT</pubDate><description>摘要</description><content:encoded><![CDATA[<p>新内容 &#x4e8c;</p><script>bad()</script><style>secret</style>]]></content:encoded></item>'));
  assert.equal((await sync(c)).status,'updated');const s=a.data.sources[0];assert.equal(requests(),1);assert.equal(s.origin,'https://example.com/post');assert.equal(s.feedUrl,c.url);assert.equal(s.title,'版本 & 发布');assert.match(s.content,/新内容 二/);assert.doesNotMatch(s.content,/摘要|bad|secret/);assert.equal(s.remoteCreatedAt,'2026-10-01T10:00:00.000Z');assert.ok(s.feedEntryKey);assert.match(s.identity,/^feed:/);assert.equal(s.version,1);assert.ok(s.segments.length);assert.equal(j.sourceIds[0],s.id);assert.equal(j.allowWeb,false);assert.equal(j.fileMode,'off');
});
test('Atom accepts scoped namespace, relative alternate links, XHTML and text summaries without content-src fetch',()=>{
  const parsed=feeds.parse(atom('<entry xml:base="/news/"><id>tag:example.com,2026:1</id><title type="html">Hello &amp;amp; news</title><link rel="self" href="/api/1"/><link href="one#x"/><updated>2026-10-01T12:00:00Z</updated><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>正文</p><script>bad()</script></div></content></entry><entry><id>2</id><title>外部正文</title><content src="https://evil.invalid/private"/><summary type="text">只用摘要 &lt;原文&gt;</summary></entry>'),'https://example.com/feed.xml');
  assert.equal(parsed.format,'atom');assert.equal(parsed.entries.length,2);assert.equal(parsed.entries[0].url,'https://example.com/news/one');assert.equal(parsed.entries[0].title,'Hello & news');assert.doesNotMatch(parsed.entries[0].content,/bad/);assert.match(parsed.entries[1].content,/只用摘要 <原文>/);
});
test('RSS fallback link identity is canonical and explicit IDs separate different entries with equal bodies',()=>{
  const p=feeds.parse(rss('<item><link>HTTPS://EXAMPLE.COM:443/post#top</link><description>A</description></item><item><link>https://example.com/post</link><description>A</description></item>'+item('x','相同')+item('y','相同')),'https://example.com/feed');assert.equal(p.entries.length,3);assert.equal(p.entries[0].url,'https://example.com/post');assert.notEqual(p.entries[1].key,p.entries[2].key);
});
test('Invalid Atom dates and timezone-free timestamps preserve original text without fabricated publication times',()=>{
  for(const date of ['2026-02-30T12:00:00Z','2026-10-01T12:00:00','2026-10-01','invalid']){const row=feeds.parse(atom(`<entry><id>1</id><title>日期</title><updated>${date}</updated></entry>`),'https://example.com/feed').entries[0];assert.equal(row.publishedAt,null);assert.match(row.content,/未能识别/);assert.ok(row.warnings.length);assert.ok(row.content.includes(date));}
  const good=feeds.parse(atom('<entry><id>1</id><title>日期</title><updated>2026-10-01T12:00:00+08:00</updated></entry>'),'https://example.com/feed').entries[0];assert.equal(good.publishedAt,'2026-10-01T04:00:00.000Z');
  const badRSS=feeds.parse(rss('<item><guid>1</guid><title>日期</title><pubDate>Mon, 30 Feb 2026 12:00:00 GMT</pubDate></item>'),'https://example.com/feed').entries[0];assert.equal(badRSS.publishedAt,null);assert.match(badRSS.content,/30 Feb/);
});
test('Malformed, unknown format, DTD, entities, bad namespace, unknown Atom text and missing stable identity reject',()=>{
  for(const body of ['<rss version="2.0"><channel><item></channel></rss>','<rss version="2.0"><channel>&unknown;</channel></rss>','<html><body>login</body></html>','<rss version="1.0"><channel/></rss>','<feed><entry/></feed>','<!DOCTYPE rss [<!ENTITY test SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel/></rss>','<?xml version="1.0" encoding="GBK"?>'+rss(),rss('<item><title>没有ID</title></item>'),rss('<item><guid>x</guid></item>'),atom('<entry><id>x</id><content type="application/json">{}</content></entry>'),rss('<item><guid>x</guid><title>X</title><link>file:///tmp/secret</link></item>')])assert.throws(()=>feeds.parse(body,'https://example.com/feed'));
});
test('Excess entry count, byte length, text length, title length and deep XML reject before importing',()=>{
  for(const body of [rss(Array.from({length:101},(_,i)=>item(String(i))).join('')),rss(item('1','x'.repeat(500001))),rss(item('1','x','x'.repeat(301))),rss('<item><guid>1</guid><description>'+ '<a>'.repeat(45)+'深'+'</a>'.repeat(45)+'</description></item>'),'x'.repeat(2_000_001)])assert.throws(()=>feeds.parse(body,'https://example.com/feed'));
});
test('Duplicate stable ID with conflicting content rejects entire response rather than guessing latest',async t=>{
  const {a,add,sync,set}=await setup(t),c=await add();set(rss(item('a','A')+item('a','B')));assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,0);set(rss(item('a','A')+item('a','A')));assert.equal((await sync(c)).added,1);
});
test('RSS missing old entries does not delete material; empty feed is a successful unchanged check',async t=>{
  const {a,add,sync,set}=await setup(t),c=await add();set(rss(item('1')+item('2')));await sync(c);set(rss(''));const run=await sync(c);assert.equal(run.status,'unchanged');assert.equal(run.entries,0);assert.equal(a.data.sources.length,2);assert.equal(a.data.sources.some(s=>s.deleted),false);
});
test('Unchanged entries, order changes and duplicate entries do not duplicate or reawaken a completed project',async t=>{
  const {a,add,sync,set,job}=await setup(t),j=await job(),c=await add();set(rss(item('1')+item('2')));await sync(c);j.status='completed';j.completedAt='2026-10-01';set(rss(item('2')+item('1')+item('1')));const run=await sync(c);assert.equal(run.added,0);assert.equal(a.data.sources.length,2);assert.equal(j.status,'completed');assert.equal(j.completedAt,'2026-10-01');
});
test('A to B to A creates a continuous revision chain and keeps one project job across restart',async t=>{
  const {a,add,sync,set,job}=await setup(t),j=await job(),c=await add();for(const body of ['甲','乙','甲']){set(rss(item('same',body)));await sync(c);for(const s of a.data.sources)s.createdAt='2026-10-01T00:00:00.000Z';}
  assert.deepEqual(a.data.sources.map(s=>s.version),[3,2,1]);assert.equal(a.data.sources[0].previousSourceId,a.data.sources[1].id);assert.equal(a.data.delegations.length,1);assert.equal(j.sourceIds.length,3);a.save();const restarted=new Assistant({dir:a.dir,webRequest:a.feedRequest});feeds.initialize(restarted,a.feedRequest);await feeds.dispatch(restarted,'feedConnectionSync',{id:c.id});await restarted.runPromise;assert.equal(restarted.data.sources.length,3);
});
test('Changed feed material invalidates acceptance and approvals without restoring paused project execution',async t=>{
  const {a,add,sync,set,job,row}=await setup(t),j=await job(),c=await add();await sync(c);const source=a.data.sources[0],plan=await agent.act(a,j,'plan_task',{key:'brief',title:'简报',criteria:'依照RSS',sourceIds:[source.id],steps:[{key:'draft',title:'编写',kind:'draft'}]}),task=a.task(plan.taskId);
  task.status='completed';task.verification={passed:true};j.status='paused';a.data.agentActions.push({id:'pending',jobId:j.id,status:'pending',approvedAt:'old'});j.pendingActionId='pending';set(rss(item('1','更新内容')));await sync(c);assert.equal(j.status,'paused');assert.equal(task.verification,null);assert.ok(task.needsReplan);assert.equal(task.sourceIds.length,2);assert.equal(a.data.agentActions[0].status,'stale');assert.equal(j.pendingActionId,null);assert.equal(row(c).imported,2);
});
test('Orphan uncertain external action blocks whole batch and resumes without duplicates after reconciliation',async t=>{
  const {a,add,sync,set,job,row}=await setup(t),j=await job(),c=await add();await sync(c);a.data.agentActions.push({id:'orphan',jobId:j.id,status:'uncertain'});set(rss(item('1','新版本')+item('2')));assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.match(row(c).error,/待核对/);a.data.agentActions=[];assert.equal((await sync(c)).added,2);assert.equal(a.data.sources.length,3);
});
test('Legacy pending action without jobId and standalone task receipt also block source replacement',async t=>{
  const {a,add,sync,set,job}=await setup(t),j=await job(),c=await add();await sync(c);j.pendingActionId='legacy';a.data.agentActions.push({id:'legacy',status:'uncertain'});set(rss(item('1','新版')));assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);a.data.agentActions=[];a.data.delegations[0].pendingActionId=null;
  const task=a.createTask({title:'独立交付',sourceIds:[a.data.sources[0].id]});a.data.agentActions.push({id:'independent',taskId:task.id,status:'running'});assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);a.data.agentActions=[];assert.equal((await sync(c)).added,1);
});
test('Independent task referencing old entry invalidates generated evidence and keeps paused task paused',async t=>{
  const {a,add,sync,set}=await setup(t),c=await add();await sync(c);const source=a.data.sources[0],task=a.createTask({title:'独立简报',sourceIds:[source.id]}),paused=a.createTask({title:'暂停简报',sourceIds:[source.id]});task.status='completed';task.verification={passed:true};task.steps[0].done=true;task.steps[0].artifactId='old';paused.status='paused';set(rss(item('1','改变')));await sync(c);assert.equal(task.status,'blocked');assert.equal(task.steps[0].done,false);assert.equal(task.steps[0].artifactId,undefined);assert.equal(task.verification,null);assert.equal(paused.status,'paused');
});
test('Explicit foreign task project blocks the whole feed batch without injecting sources or changing either project',async t=>{
  const {a,add,sync,set,job,row}=await setup(t),j=await job(),c=await add();await sync(c);await a.dispatch('projectSave',{name:'另一个项目'});const other=a.data.projects[0];
  const task=a.createTask({title:'错误跨项目引用',sourceIds:[a.data.sources[0].id]});task.projectId=other.id;task.status='completed';task.verification={passed:true};j.status='paused';const priorTask=structuredClone(task),priorJob=structuredClone(j);
  set(rss(item('1','新版')+item('new','新增另一条')));assert.equal((await sync(c)).status,'error');assert.match(row(c).error,/其他项目|归属/);assert.equal(a.data.sources.length,1);assert.equal(row(c).imported,1);assert.deepEqual(a.task(task.id),priorTask);assert.deepEqual(a.data.delegations.find(r=>r.id===j.id),priorJob);
});
test('Conflicting task and job projects or missing job reject before changing evidence and paused jobs',async t=>{
  const {a,p,add,sync,set,job}=await setup(t),j=await job(),c=await add();await sync(c);await a.dispatch('projectSave',{name:'其他项目'});const other=a.data.projects[0],foreign=agent.buildJob(a,{projectId:other.id,goal:'其他项目目标',allowWeb:false});foreign.status='paused';a.data.delegations.push(foreign);other.jobId=foreign.id;
  const task=a.createTask({title:'归属冲突',sourceIds:[a.data.sources[0].id]});set(rss(item('1','新版')));
  for(const [projectId,agentJobId] of [[other.id,j.id],[p.id,foreign.id],[null,'missing-job']]){
    const current=a.task(task.id);Object.assign(current,{projectId,agentJobId});const prior=structuredClone(current),jobs=structuredClone(a.data.delegations);assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.deepEqual(a.task(task.id),prior);assert.deepEqual(a.data.delegations,jobs);
  }
});
test('Excluded entry stays withdrawn during updates while other feed entries continue to arrive',async t=>{
  const {a,p,add,sync,set}=await setup(t),c=await add();await sync(c);const first=a.data.sources[0];first.projectExcluded=true;set(rss(item('1','更新')+item('2')));const run=await sync(c);assert.equal(run.added,1);assert.equal(run.excluded,1);assert.equal(a.data.sources.length,2);await a.dispatch('projectAttach',{id:p.id,sourceIds:[first.id]});await sync(c);assert.equal(a.data.sources.length,3);assert.equal(a.data.sources[0].version,2);
});
test('HTTP, content type, encoding, invalid response and cross-origin redirect errors preserve all evidence',async t=>{
  const {a,add,sync,set,row}=await setup(t),c=await add({enabled:true});await sync(c);const id=a.data.sources[0].id;
  for(const response of [{status:404},{status:200,headers:{'content-type':'application/pdf'}},{status:200,headers:{'content-type':'text/html'}},{status:200,headers:{'content-type':'application/rss+xml;charset=gbk'}},{status:200,body:'malformed'},{status:200,url:'https://other.example/feed'},{status:200,url:'http://127.0.0.1/'}]){set({status:200,url:c.url,headers:{'content-type':'application/xml'},body:rss(),...response});assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].id,id);assert.ok(row(c).lastSuccessAt);assert.ok(row(c).nextRunAt);}
});
test('Failure backoff never polls faster than configured daily interval',async t=>{
  const {add,sync,set,row}=await setup(t),c=await add({enabled:true,intervalMinutes:1440});set(()=>{throw new Error('network offline');});const start=Date.now();await sync(c);assert.ok(Date.parse(row(c).nextRunAt)>=start+1440*60000);assert.equal(row(c).imported,0);
});
test('Repeated identical RSS failures preserve attention acknowledgment and keep endpoint details out of notification projections',async t=>{
  const {a,add,sync,set}=await setup(t),c=await add();set(()=>{throw new Error('Remote failure https://example.com/feed?token=private-key');});await sync(c);
  const attention=require('../desktop/attention.cjs'),first=attention.snapshot(a).items.find(r=>r.id===`collection:feed:${c.id}`);assert.ok(first);assert.doesNotMatch(JSON.stringify(first),/private-key|token=/);const pending=attention.pendingNotifications(a);attention.markNotified(a,pending.items);await sync(c);
  const second=attention.snapshot(a).items.find(r=>r.id===first.id);assert.equal(second.revision,first.revision);assert.equal(attention.pendingNotifications(a).items.some(r=>r.id===first.id),false);assert.doesNotMatch(JSON.stringify(require('../desktop/health.cjs').snapshot(a)),/private-key|token=/);
  set(rss());await sync(c);assert.equal(attention.snapshot(a).items.some(r=>r.id===first.id),false);
});
test('Tick honors stewardship pause, suspend, window and current operation; explicit resume starts next sync',async t=>{
  const {a,add,requests}=await setup(t),c=await add({enabled:true});a.data.stewardship.paused=true;assert.equal(feeds.tick(a),false);a.data.stewardship.paused=false;a.suspended=true;assert.equal(feeds.tick(a),false);a.suspended=false;a.operation={label:'other'};assert.equal(feeds.tick(a),false);a.operation=null;c.nextRunAt=new Date(Date.now()+60000).toISOString();assert.equal(feeds.tick(a),false);await feeds.dispatch(a,'feedConnectionToggle',{id:c.id,enabled:false});assert.equal(feeds.tick(a),false);assert.equal(requests(),0);await feeds.dispatch(a,'feedConnectionToggle',{id:c.id,enabled:true});assert.equal(feeds.tick(a),true);await a.runPromise;assert.equal(requests(),1);
});
test('Cancelling an in-flight check creates no partial sources and pauses subsequent automatic reads',async t=>{
  const {a,add,set,requests}=await setup(t),c=await add({enabled:true});let release;set(()=>new Promise(resolve=>{release=resolve;}));await feeds.dispatch(a,'feedConnectionSync',{id:c.id});await assert.rejects(feeds.dispatch(a,'feedConnectionDelete',{id:c.id}),/正在处理/);feeds.pauseAll(a);a.stop();release({status:200,url:c.url,headers:{'content-type':'application/xml'},body:rss()});await a.runPromise;assert.equal(a.data.sources.length,0);assert.equal(a.data.feedConnectionRuns[0].status,'paused');assert.equal(a.data.feedConnections[0].enabled,false);assert.equal(feeds.tick(a),false);assert.equal(requests(),1);
});
test('Removing a subscription revokes reads and preserves imported entries plus run history',async t=>{
  const {a,add,sync,requests}=await setup(t),c=await add();await sync(c);await feeds.dispatch(a,'feedConnectionDelete',{id:c.id});await assert.rejects(feeds.dispatch(a,'feedConnectionSync',{id:c.id}),/已移除/);assert.equal(feeds.tick(a),false);assert.equal(a.data.sources.length,1);assert.equal(a.data.feedConnectionRuns.length,1);assert.equal(requests(),1);
});
test('Restart marks interrupted run, keeps successful entries, and explicit manual recheck deduplicates',async t=>{
  const {a,add,sync}=await setup(t),c=await add();await sync(c);a.data.feedConnectionRuns.unshift({id:'running',feedConnectionId:c.id,status:'running'});a.save();const next=new Assistant({dir:a.dir,webRequest:a.feedRequest});feeds.initialize(next,a.feedRequest);assert.equal(next.data.feedConnectionRuns[0].status,'interrupted');await feeds.dispatch(next,'feedConnectionSync',{id:c.id});await next.runPromise;assert.equal(next.data.sources.length,1);
});
test('Restoring older project state then same-content read reconnects newer feed evidence without new versions',async t=>{
  const {a,add,sync,set,job}=await setup(t),j=await job(),c=await add();await sync(c);const old=structuredClone(a.data);set(rss(item('1','新版')));await sync(c);const latest=a.data.sources[0];const current=structuredClone(a.data);old.sources.unshift(structuredClone(latest));feeds.retain(current,old);a.data=old;const restored=a.data.feedConnections[0];assert.equal(restored.enabled,false);assert.equal(restored.nextRunAt,null);a.data.delegations[0].status='paused';assert.equal(a.data.delegations[0].sourceIds.includes(latest.id),false);await sync(restored);assert.equal(a.data.sources.length,2);assert.ok(a.data.delegations.find(r=>r.id===j.id).sourceIds.includes(latest.id));assert.equal(a.data.delegations[0].status,'paused');
});
test('Retain never resurrects removed subscription and preserves newer source withdrawal flags',async t=>{
  const {a,add,sync}=await setup(t),c=await add();await sync(c);const old=structuredClone(a.data);a.data.sources[0].projectExcluded=true;await feeds.dispatch(a,'feedConnectionDelete',{id:c.id});feeds.retain(a.data,old);assert.equal(old.feedConnections.length,0);assert.equal(old.sources[0].projectExcluded,true);assert.equal(old.feedConnectionRuns.length,1);
});
test('Core routing and real backup restore retain current subscriptions, pause reads, and never resurrect revoked scope',async t=>{
  const {a,add,sync}=await setup(t),c=await add({enabled:true});await sync(c);const backup=recovery.create(a);await a.dispatch('feedConnectionDelete',{id:c.id});await a.dispatch('backupRestore',{id:backup});assert.equal(a.data.feedConnections.length,0);assert.equal(a.data.sources.length,1);
  await a.dispatch('feedConnectionSave',{name:'恢复测试',url:'https://example.com/second.xml',projectId:a.data.projects[0].id,enabled:true,intervalMinutes:30});const next=a.data.feedConnections[0];await a.dispatch('backupRestore',{id:backup});assert.equal(a.data.feedConnections.length,1);assert.equal(a.data.feedConnections[0].id,next.id);assert.equal(a.data.feedConnections[0].enabled,false);assert.equal(a.data.feedConnections[0].nextRunAt,null);
});
test('Feed entries are current agent context and independent stable followup sources, revoked subscription cannot resolve',async t=>{
  const {a,add,sync,set,job}=await setup(t),j=await job(),c=await add();set(rss(item('1')+item('2')));await sync(c);const first=a.data.sources.find(s=>s.origin.endsWith('/1'));
  assert.equal(agent.context(a,j).sources.every(s=>s.current),true);const sources=followup.sources(a,j);assert.equal(sources.length,2);assert.notEqual(sources[0].key,sources[1].key);followup.wait(a,j,{key:'result',expected:'正式发布',sourceIds:[first.id],reason:'等正式发布'});set(rss(item('1','已正式发布')+item('2')));await sync(c);const current=a.data.sources[0];assert.equal(followup.sources(a,j).length,2);assert.ok(j.followups[0].watchKeys.includes(followup.sources(a,j).find(s=>s.sourceId===current.id).key));assert.equal(agent.context(a,j).sources.filter(s=>s.current).length,2);
  await a.dispatch('feedConnectionDelete',{id:c.id});assert.equal(followup.sources(a,j).length,0);await assert.rejects(followup.resolve(a,j,{key:'result',sourceId:current.id,evidence:'已正式发布'}),/对应来源/);
});
test('Feed updates invalidate resolved followup evidence and source-backed memory',async t=>{
  const {a,add,sync,set,job}=await setup(t),j=await job(),c=await add();await sync(c);const source=a.data.sources[0];j.followups.push({key:'approved',expected:'发布日期确定',status:'resolved',sourceId:source.id,sourceIds:[source.id],watchKeys:[followup.sources(a,j)[0].key],resolvedAt:new Date().toISOString(),verification:{quote:'第一版',reason:'已确认'}});await a.dispatch('memorySave',{title:'发布日期',content:'第一版',kind:'fact',sourceId:source.id,projectId:source.projectId});set(rss(item('1','新版日期')));await sync(c);assert.equal(j.followups[0].status,'waiting');assert.equal(j.followups[0].sourceId,undefined);assert.equal(a.publicState().memories[0].effective,false);
});
test('Project merge failure rolls back every new entry, plan and approval for retry',async t=>{
  const {a,add,sync,set,job,row}=await setup(t),j=await job(),c=await add();await sync(c);const prior=structuredClone(j);set(rss(item('1','修改')+item('2')));const original=projects.ingest;t.mock.method(projects,'ingest',(...args)=>{original(...args);throw new Error('merge failed');});assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.deepEqual(a.data.delegations.find(r=>r.id===j.id),prior);assert.equal(row(c).imported,1);
});
test('Final persistence failure rolls back sources and imported counters; next read retries whole batch once',async t=>{
  const {a,add,sync,set,row}=await setup(t),c=await add();await sync(c);set(rss(item('1','新版')+item('2')));const original=a.save.bind(a);let saves=0;t.mock.method(a,'save',()=>{if(++saves===2)throw new Error('disk full');return original();});assert.equal((await sync(c)).status,'error');assert.equal(a.data.sources.length,1);assert.equal(row(c).imported,1);assert.equal((await sync(c)).added,2);assert.equal(a.data.sources.length,3);
});
test('Initial run persistence failure does not fetch or leave a permanently running RSS record',async t=>{
  const {a,add,requests}=await setup(t),c=await add();const original=a.save.bind(a);let attempts=0;t.mock.method(a,'save',()=>{if(++attempts===1)throw new Error('first write failed');return original();});await a.dispatch('feedConnectionSync',{id:c.id});await a.runPromise;assert.equal(requests(),0);assert.equal(a.data.feedConnectionRuns.length,0);assert.equal(a.operation,null);assert.equal(a.data.sources.length,0);
});
test('Failed configuration save rolls back newly created subscription',async t=>{
  const {a,add}=await setup(t);t.mock.method(a,'save',()=>{throw new Error('disk full');});await assert.rejects(add(),/disk full/);assert.equal(a.data.feedConnections.length,0);
});
function transport(t,steps,addresses){
  let calls=0,lookups=0;const dns=require('node:dns/promises'),https=require('node:https');
  t.mock.method(dns,'lookup',async()=>addresses?.[lookups++]||[{address:'93.184.216.34',family:4}]);
  t.mock.method(https,'request',(url,options,callback)=>{calls++;const step=steps.shift();assert.ok(step);const req=new EventEmitter();req.write=()=>{};req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.statusCode=step.status;res.headers=step.headers||{'content-type':'application/xml'};callback(res);res.end(step.body||rss());});return req;});
  return {calls:()=>calls,lookups:()=>lookups};
}
test('Real public request transport permits same-origin redirect with DNS revalidation for RSS',async t=>{
  const request=transport(t,[{status:302,headers:{location:'/final'}},{status:200}]);const result=await tools.publicRequest('https://example.com/feed',{allowedOrigin:'https://example.com'});assert.equal(result.url,'https://example.com/final');assert.equal(feeds.parse(result.body,result.url).entries.length,1);assert.equal(request.calls(),2);
});
test('Redirect outside approved origin is rejected before second connection',async t=>{
  const request=transport(t,[{status:302,headers:{location:'https://other.example/feed'}}]);await assert.rejects(tools.publicRequest('https://example.com/feed',{allowedOrigin:'https://example.com'}),/超出已授权/);assert.equal(request.calls(),1);
});
test('RSS DNS rebinding to private address is rejected before redirected connection',async t=>{
  const request=transport(t,[{status:302,headers:{location:'/private'}}],[[{address:'93.184.216.34',family:4}],[{address:'127.0.0.1',family:4}]]);await assert.rejects(tools.publicRequest('https://example.com/feed',{allowedOrigin:'https://example.com'}),/只访问公网/);assert.equal(request.calls(),1);assert.equal(request.lookups(),2);
});
