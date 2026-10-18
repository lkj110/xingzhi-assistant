const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs');
const followup=require('../desktop/agent-followup.cjs'),workmap=require('../desktop/workmap.cjs');

async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v14-workflow-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const forbidden=async()=>{throw new Error('No real service calls in this test');};
  const a=new Assistant({dir,chat:forbidden,agentRequest:forbidden,webRequest:forbidden});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  await a.dispatch('projectSave',{name:'发布项目'});const project=a.data.projects[0];
  const job=agent.buildJob(a,{projectId:project.id,goal:'跟进发布并保存结果',fileMode:'off',githubMode:'off'});
  a.data.delegations.push(job);project.jobId=job.id;
  return {a,project,job};
}
async function feedSetup(t){
  const env=await setup(t),{a,project}=env;
  let entries=[];a.feedRequest=async url=>({status:200,url,headers:{'content-type':'application/rss+xml'},body:`<rss version="2.0"><channel><title>产品公告</title>${entries.map(([id,body])=>`<item><guid>${id}</guid><title>发布公告</title><description>${body}</description></item>`).join('')}</channel></rss>`});
  await a.dispatch('feedConnectionSave',{name:'产品公告',url:'https://example.com/feed.xml',projectId:project.id,intervalMinutes:30,enabled:false});const connection=a.data.feedConnections[0];
  let calls=0;a.chat=async()=>{calls++;return {satisfied:true,quote:'产品已经正式发布',reason:'明确宣布正式发布'};};
  return {...env,connection,set:value=>{entries=value;},calls:()=>calls,sync:async()=>{await a.dispatch('feedConnectionSync',{id:connection.id});await a.runPromise;}};
}

test('V14 cross audit: an already approved current write is actionable in the work map',async t=>{
  const {a,project,job}=await setup(t);job.outputFolder=path.join(a.dir,'outputs');fs.mkdirSync(job.outputFolder);job.fileMode='ask';require('../desktop/access-policy-store.cjs').syncTrustedJob(a,job,{trusted:true,actor:'user_command',command:'fixture_output_scope'});
  const planned=await agent.act(a,job,'plan_task',{key:'delivery',title:'发布说明',criteria:'成功保存',steps:[{key:'draft',title:'编写说明',kind:'draft'},{key:'save',title:'保存文件',kind:'external',tool:'write_file'}]});
  const task=a.task(planned.taskId);task.steps[0].done=true;task.steps[0].artifactId='current-artifact';
  a.data.artifacts.push({id:'current-artifact',taskId:task.id,stepId:task.steps[0].id,title:'发布说明',content:'正式发布'});
  const record=await writes.prepare(a,job,'write_file',{taskId:task.id});job.pendingActionId=record.id;job.status='approval';
  await a.dispatch('agentApprove',{id:job.id,actionId:record.id,version:record.version});
  assert.ok(record.approvedAt);assert.equal(job.status,'ready');
  const item=workmap.snapshot(a,{projectId:project.id}).items.find(row=>row.taskId===task.id);
  assert.equal(item.gates.some(g=>['approval','permission_ask'].includes(g.code)),false,'a valid approval must not ask the user to approve again');
  assert.equal(item.state,'actionable');
});

test('V14 cross audit: RSS followup can use a newly published entry from the authorized feed',async t=>{
  const {a,project,job}=await setup(t);
  const rss=(id,body)=>`<rss version="2.0"><channel><title>产品公告</title><item><guid>${id}</guid><title>发布公告</title><description>${body}</description></item></channel></rss>`;
  let body=rss('draft-notice','发布日期待定');a.feedRequest=async url=>({status:200,url,headers:{'content-type':'application/rss+xml'},body});
  await a.dispatch('feedConnectionSave',{name:'产品公告',url:'https://example.com/feed.xml',projectId:project.id,intervalMinutes:30,enabled:false});const connection=a.data.feedConnections[0];
  const sync=async()=>{await a.dispatch('feedConnectionSync',{id:connection.id});await a.runPromise;};
  await sync();const first=a.data.sources[0];followup.wait(a,job,{key:'launch',reason:'等待正式发布公告',expected:'产品已经正式发布',sourceIds:[],feedConnectionIds:[connection.id]});
  body=rss('formal-launch','产品已经正式发布');await sync();const current=a.data.sources[0];assert.notEqual(current.feedEntryKey,first.feedEntryKey);
  let modelCalls=0;a.chat=async()=>{modelCalls++;return {satisfied:true,quote:'产品已经正式发布',reason:'新公告明确宣布正式发布'};};
  const result=await followup.resolve(a,job,{key:'launch',sourceId:current.id,evidence:'新公告明确说产品已经正式发布'});
  assert.equal(result.status,'resolved');assert.equal(modelCalls,1);assert.equal(job.followups[0].sourceId,current.id);
});

test('V14 cross audit: feed-wide wait starts before its first entry and repeated wording retains newly arrived evidence',async t=>{
  const {a,job,connection,set,sync,calls}=await feedSetup(t);
  const args={key:'launch',reason:'等待公告',expected:'产品已经正式发布',feedConnectionIds:[connection.id]};
  followup.wait(a,job,args);const started=job.followups[0].createdAt;assert.deepEqual(job.followups[0].baselineIds,[]);
  set([['launch','产品已经正式发布']]);await sync();const source=a.data.sources[0];
  followup.wait(a,job,{...args,reason:'再核对正式公告'});assert.equal(job.followups[0].createdAt,started);assert.deepEqual(job.followups[0].baselineIds,[]);
  await followup.resolve(a,job,{key:'launch',sourceId:source.id,evidence:'明确发布'});assert.equal(job.followups[0].status,'resolved');assert.equal(calls(),1);
});

test('V14 cross audit: entry-specific wait cannot be satisfied by a different RSS entry',async t=>{
  const {a,job,set,sync,calls}=await feedSetup(t);set([['draft','发布日期待定']]);await sync();const old=a.data.sources[0];
  followup.wait(a,job,{key:'launch',reason:'等这条公告更新',expected:'产品已经正式发布',sourceIds:[old.id]});
  set([['other','产品已经正式发布']]);await sync();const other=a.data.sources[0];
  await assert.rejects(followup.resolve(a,job,{key:'launch',sourceId:other.id,evidence:'发布'}),/对应来源/);assert.equal(calls(),0);
  set([['draft','产品已经正式发布']]);await sync();await followup.resolve(a,job,{key:'launch',sourceId:a.data.sources[0].id,evidence:'原公告更新为正式发布'});
  assert.equal(job.followups[0].status,'resolved');assert.equal(calls(),1);
});

test('V14 cross audit: RSS wait rejects other-project or removed subscriptions without changing job state',async t=>{
  const {a,job,connection}=await feedSetup(t);await a.dispatch('projectSave',{name:'其他项目'});const other=a.data.projects[0];
  await a.dispatch('feedConnectionSave',{name:'其他公告',url:'https://example.com/other.xml',projectId:other.id,intervalMinutes:30,enabled:false});const foreign=a.data.feedConnections.at(-1);
  const before=structuredClone(job);
  for(const feedConnectionIds of [[foreign.id],['missing'],'bad'])assert.throws(()=>followup.wait(a,job,{reason:'等发布',expected:'正式发布',feedConnectionIds}),/本项目/);
  assert.deepEqual(job,before);
  await a.dispatch('feedConnectionDelete',{id:connection.id});assert.throws(()=>followup.wait(a,job,{reason:'等发布',expected:'正式发布',feedConnectionIds:[connection.id]}),/本项目/);assert.deepEqual(job,before);
});

test('V14 cross audit: feed-wide wait requires post-wait evidence and an active matching subscription',async t=>{
  const {a,job,connection,set,sync,calls}=await feedSetup(t);set([['old','产品已经正式发布']]);await sync();const old=a.data.sources[0];
  followup.wait(a,job,{key:'launch',reason:'等待下一次发布',expected:'产品已经正式发布',feedConnectionIds:[connection.id]});
  await assert.rejects(followup.resolve(a,job,{key:'launch',sourceId:old.id,evidence:'旧公告'}),/新取得/);assert.equal(calls(),0);
  set([['new','产品已经正式发布']]);await sync();const current=a.data.sources[0];await a.dispatch('feedConnectionDelete',{id:connection.id});
  await assert.rejects(followup.resolve(a,job,{key:'launch',sourceId:current.id,evidence:'新公告'}),/对应来源/);assert.equal(calls(),0);assert.equal(job.followups[0].status,'waiting');
});

test('V14 cross audit: feed wait still needs a verified exact quote before marking resolved',async t=>{
  const {a,job,connection,set,sync}=await feedSetup(t);followup.wait(a,job,{key:'launch',reason:'等发布',expected:'产品已经正式发布',feedConnectionIds:[connection.id]});
  set([['notice','计划下个月发布']]);await sync();const source=a.data.sources[0];
  a.chat=async()=>({satisfied:true,quote:'产品已经正式发布',reason:'模型声称发布'});
  const result=await followup.resolve(a,job,{key:'launch',sourceId:source.id,evidence:'模型说明不算原文证据'});
  assert.equal(result.resolved,false);assert.equal(job.followups[0].status,'waiting');
});

test('V14 cross audit: a newly collected historical RSS publication cannot resolve a feed-wide wait',async t=>{
  const {a,job,connection,calls,sync}=await feedSetup(t);followup.wait(a,job,{key:'launch',reason:'等最新发布',expected:'产品已经正式发布',feedConnectionIds:[connection.id]});
  const body='<rss version="2.0"><channel><title>公告</title><item><guid>historical</guid><title>过去的公告</title><pubDate>Thu, 01 Oct 2020 10:00:00 GMT</pubDate><description>产品已经正式发布</description></item></channel></rss>';
  a.feedRequest=async url=>({status:200,url,headers:{'content-type':'application/rss+xml'},body});await sync();const source=a.data.sources[0];
  assert.equal(source.remoteCreatedAt,'2020-10-01T10:00:00.000Z');
  await assert.rejects(followup.resolve(a,job,{key:'launch',sourceId:source.id,evidence:'导入时间虽新，但原文是历史公告'}),/历史公告/);assert.equal(calls(),0);assert.equal(job.followups[0].status,'waiting');
});

test('V14 cross audit: an edited existing RSS entry can resolve despite an unchanged original publication date',async t=>{
  const {a,job,connection,calls,sync}=await feedSetup(t);let content='原公告说发布日期待定';
  a.feedRequest=async url=>({status:200,url,headers:{'content-type':'application/rss+xml'},body:`<rss version="2.0"><channel><item><guid>existing</guid><title>公告</title><pubDate>Thu, 01 Oct 2020 10:00:00 GMT</pubDate><description>${content}</description></item></channel></rss>`});
  await sync();const old=a.data.sources[0];followup.wait(a,job,{key:'launch',reason:'等原公告编辑确认',expected:'产品已经正式发布',feedConnectionIds:[connection.id]});
  content='产品已经正式发布';await sync();const current=a.data.sources[0];assert.equal(current.previousSourceId,old.id);assert.equal(current.remoteCreatedAt,old.remoteCreatedAt);
  await followup.resolve(a,job,{key:'launch',sourceId:current.id,evidence:'旧公告的本次修订确认发布'});assert.equal(calls(),1);assert.equal(job.followups[0].status,'resolved');
});

test('V14 cross audit: plan normalization preserves old/current provenance and invalidates verification on later reference edits',async t=>{
  const {a,job,project}=await setup(t);const at=new Date().toISOString();
  a.data.sources.push({id:'old',projectId:project.id,title:'预算',content:'6800',createdAt:at},{id:'current',projectId:project.id,title:'预算',content:'7200',previousSourceId:'old',createdAt:at});job.sourceIds=['old','current'];
  const args={key:'budget',title:'预算核对',criteria:'按当前预算',sourceIds:['old','current'],steps:[{key:'draft',title:'写说明',kind:'draft'}]};
  const planned=await agent.act(a,job,'plan_task',args),task=a.task(planned.taskId);
  assert.deepEqual(task.supersededSourceIds,['old']);task.status='completed';task.verification={passed:true,basis:require('../desktop/acceptance.cjs').basis(a,task)};
  const revised={...args,sourceIds:['current'],removeSourceIds:['old'],reason:'只保留当前资料引用'};
  await assert.rejects(agent.act(a,job,'plan_task',revised),{code:'EXECUTION_GATE_CLOSED'});
  await a.dispatch('updateTask',{id:task.id,criteria:'用户重开：按当前预算复核引用'});
  await agent.act(a,job,'plan_task',revised);
  assert.equal(task.verification,null);assert.equal(task.status,'todo');assert.deepEqual(task.supersededSourceIds,[]);assert.deepEqual(task.planHistory.at(-1).supersededSourceIds,['old']);
});

test('V14 cross audit: a restored file version can supersede a historical deletion marker during replanning',async t=>{
  const {a,job,project}=await setup(t);const at=new Date().toISOString(),base={projectId:project.id,title:'恢复后的资料',createdAt:at};
  a.data.sources.push({...base,id:'original',content:'原预算'},{...base,id:'removed',content:'已移除',deleted:true,previousSourceId:'original'},{...base,id:'restored',content:'恢复后的新预算',previousSourceId:'removed'});job.sourceIds=['original','removed','restored'];
  const planned=await agent.act(a,job,'plan_task',{key:'restored-budget',title:'按恢复资料核对',criteria:'仅采用恢复后的最新资料',sourceIds:job.sourceIds,steps:[{key:'draft',title:'写说明',kind:'draft'}]});
  const task=a.task(planned.taskId);assert.deepEqual(new Set(task.supersededSourceIds),new Set(['original','removed']));
  assert.equal(require('../desktop/acceptance.cjs').reasons(a,task).some(row=>['source','source_version'].includes(row.code)),false);
});

test('V14 cross audit: invalid Atom calendar dates and missing zones are preserved without inventing a publication instant',()=>{
  const feeds=require('../desktop/feeds.cjs');
  for(const date of ['2026-02-30T12:00:00Z','2026-10-03T09:00:00']){
    const parsed=feeds.parse(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>invalid-date</id><title>公告</title><updated>${date}</updated><summary>资料</summary></entry></feed>`,'https://example.com/feed.xml');
    assert.equal(parsed.entries[0].publishedAt,null);assert.ok(parsed.entries[0].content.includes(date));assert.ok(parsed.entries[0].warnings.length>0);
  }
});
