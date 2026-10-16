const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const writes=require('../desktop/agent-writes.cjs');
const {fixture}=require('../desktop/agent-eval.cjs');
const attention=require('../desktop/attention.cjs'),calendar=require('../desktop/calendar.cjs'),acceptance=require('../desktop/acceptance.cjs');

// Every external service is an in-memory fixture; files stay in this test's temporary workspace.
async function setup(t,{tool='github_comment'}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v13-audit-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env=fixture({id:'audit'}),calls=[];
  const a=new Assistant({dir,agentRequest:env.request,chat:async(p,k,m)=>{
    calls.push(m);
    if(m[0].content.includes('推进给定事项'))return {kind:'artifact',title:'发布说明',content:'周六发布，预算 6800 元。'};
    return {passed:true,summary:'检查通过',gaps:[]};
  }});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'isolated audit',model:'fixture',baseUrl:'https://example.invalid/v1'});
  await a.dispatch('agentSettings',{githubRepo:'eval/work',githubToken:'fixture-token'});
  const job=agent.buildJob(a,{goal:'按原文交付发布说明并核对结果',folderIds:[],useGithub:true,githubMode:'auto',githubUpdateMode:'auto',githubCommentMode:'auto',fileMode:'off'});
  a.data.delegations.push(job);
  const result=await agent.act(a,job,'plan_task',{key:'delivery',title:'发布说明',criteria:'原文交付成功',steps:[{key:'draft',title:'生成发布说明',kind:'draft'},{key:'deliver',title:'按原文交付',kind:'external',tool}]});
  const task=a.task(result.taskId);
  if(tool==='github_comment')await agent.act(a,job,'github_read',{number:1,taskId:task.id});
  await agent.act(a,job,'advance_task',{taskId:task.id});
  return {a,job,task,env,calls};
}

test('V13 independent audit: GitHub comment readback must match the complete approved body',async t=>{
  const {a,job,task,env}=await setup(t);
  const base=env.request;
  a.agentRequest=async(url,options)=>{
    const response=await base(url,options);
    if(/\/issues\/comments\/\d+$/.test(new URL(url).pathname)){
      const actual=JSON.parse(response.body);
      actual.body=actual.body.replace('请确认周六发布','人工已修改：请暂停发布');
      return {...response,body:JSON.stringify(actual)};
    }
    return response;
  };
  await assert.rejects(agent.act(a,job,'github_comment',{taskId:task.id,number:1,body:'请确认周六发布'}),/回读|不一致|变化/);
  assert.equal(a.data.agentActions[0].status,'uncertain');
  assert.equal(task.steps[1].done,false);
  assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('V13 independent audit: GitHub issue creation readback must match the complete approved body',async t=>{
  const {a,job,task,env}=await setup(t,{tool:'github_create'});
  const base=env.request;
  a.agentRequest=async(url,options)=>{
    const response=await base(url,options);
    if(!options?.method||options.method==='GET'){
      const actual=JSON.parse(response.body);
      if(!Array.isArray(actual)&&actual.number===2){actual.body=actual.body.replace('6800','9800');return {...response,body:JSON.stringify(actual)};}
    }
    return response;
  };
  await assert.rejects(agent.act(a,job,'github_create',{taskId:task.id}),/回读|不一致|变化/);
  assert.equal(a.data.agentActions[0].status,'uncertain');
  assert.equal(task.steps[1].done,false);
  assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('V13 independent audit: final goal verification must re-read a delivered GitHub comment',async t=>{
  const {a,job,task,env,calls}=await setup(t);
  await agent.act(a,job,'github_comment',{taskId:task.id,number:1,body:'请确认周六发布'});
  await agent.act(a,job,'advance_task',{taskId:task.id});
  assert.equal(task.status,'review');
  env.comments[0].body='这条评论已被人工替换';
  const before=calls.length;
  await assert.rejects(agent.act(a,job,'complete',{}),/交付|回读|不一致|变化/);
  assert.notEqual(job.status,'completed');
  assert.equal(calls.length,before,'changed external evidence must stop before a model can approve the stale receipt');
});

test('V13 independent audit: finding an old marker cannot verify modified pre-existing GitHub delivery',async t=>{
  const {a,job,task,env}=await setup(t,{tool:'github_create'});
  const record=await writes.prepare(a,job,'github_create',{taskId:task.id});
  env.issues.push({number:2,title:'被改过的旧交付',body:`其他正文\n\n<!-- xingzhi:${record.key} -->`,state:'open',comments:0,html_url:'https://github.com/eval/work/issues/2'});
  await assert.rejects(writes.execute(a,job,record),/交付|回读|不一致|变化/);
  assert.equal(task.steps[1].done,false);
  assert.equal(env.requests.filter(r=>r.method==='POST').length,0,'an existing marker must never trigger a duplicate POST');
});

test('V13 independent audit: state-only update must not erase the prior body delivery check',async t=>{
  const {a,job,task,env,calls}=await setup(t,{tool:'github_create'});
  await agent.act(a,job,'github_create',{taskId:task.id});
  await agent.act(a,job,'github_read',{number:2,taskId:task.id});
  await agent.act(a,job,'github_update',{taskId:task.id,number:2,updateBody:false,state:'closed'});
  await agent.act(a,job,'advance_task',{taskId:task.id});
  assert.equal(task.status,'review');
  env.issues[1].body='删除了原交付正文';
  const before=calls.length;
  await assert.rejects(agent.act(a,job,'complete',{}),/交付|回读|不一致|变化/);
  assert.equal(calls.length,before);
});

test('V13 independent audit: legacy comment receipt without comment ID uses read-only marker lookup',async t=>{
  const {a,job,task,env}=await setup(t);
  await agent.act(a,job,'github_comment',{taskId:task.id,number:1,body:'请确认周六发布'});
  const receipt=a.data.agentActions[0];delete receipt.result.commentId;
  const before=env.requests.length;
  await writes.verifyDelivery(a,job,task);
  assert.ok(env.requests.slice(before).every(r=>r.method==='GET'));
  assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('V13 independent audit: altered comment remains uncertain across restart with no duplicate POST',async t=>{
  const {a,job,task,env}=await setup(t);
  const base=env.request;
  a.agentRequest=async(url,options)=>{
    const response=await base(url,options);
    if(options?.method==='POST'){env.comments[0].body=env.comments[0].body.replace('请确认周六发布','已撤销');throw new Error('响应丢失');}
    return response;
  };
  await assert.rejects(agent.act(a,job,'github_comment',{taskId:task.id,number:1,body:'请确认周六发布'}),/响应丢失/);
  const restarted=new Assistant({dir:a.dir,agentRequest:base,chat:async()=>{throw new Error('不应调用模型');}});
  await restarted.dispatch('agentRun',{id:job.id});await restarted.runPromise;
  assert.equal(restarted.data.agentActions[0].status,'uncertain');
  assert.equal(restarted.data.delegations[0].status,'needs_input');
  assert.equal(restarted.task(task.id).steps[1].done,false);
  assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('V13 independent audit: matching text from another Issue cannot prove the intended comment delivery',async t=>{
  const {a,job,task,env}=await setup(t);
  const base=env.request;
  a.agentRequest=async(url,options)=>{
    const response=await base(url,options);
    if(/\/issues\/comments\/\d+$/.test(new URL(url).pathname)){
      const actual=JSON.parse(response.body);actual.html_url=actual.html_url.replace('/issues/1#','/issues/99#');
      return {...response,body:JSON.stringify(actual)};
    }
    return response;
  };
  await assert.rejects(agent.act(a,job,'github_comment',{taskId:task.id,number:1,body:'请确认周六发布'}),/目标|回读/);
  assert.equal(a.data.agentActions[0].status,'uncertain');
  assert.equal(task.steps[1].done,false);
});

function localWork(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v13-local-audit-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const forbidden=async()=>{throw new Error('本地关注与日历操作不得调用模型或网络');};
  const a=new Assistant({dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,webRequest:forbidden});
  const task=a.createTask({title:'青禾发布复核',criteria:'核对发布预算与日期'});
  const source={id:'source',title:'需求',content:'预算为 6800 元',createdAt:new Date().toISOString()};
  a.data.sources.push(source);task.sourceIds=[source.id];
  a.data.artifacts.push({id:'artifact',taskId:task.id,title:'发布说明',content:'预算为 6800 元',createdAt:new Date().toISOString()});
  require('../desktop/protocol-access.cjs').retain(a,'source',source,{task,command:'fixture_input'});require('../desktop/protocol-access.cjs').retain(a,'artifact',a.data.artifacts.at(-1),{task,command:'fixture_created_artifact'});
  task.steps=[{id:'draft',kind:'draft',title:'编写说明',done:true,artifactId:'artifact'}];
  task.status='review';task.verification={passed:true,summary:'已核对',gaps:[],at:new Date().toISOString()};task.verification.basis=acceptance.basis(a,task);
  attention.initialize(a);a.save();return {a,task,source};
}

test('V13 independent audit: reading an attention card cannot accept or advance its review task',t=>{
  const {a,task}=localWork(t),card=attention.snapshot(a).items.find(c=>c.id===`review:${task.id}`),before=JSON.stringify(task);
  attention.dispatch(a,'attentionRead',{id:card.id,revision:card.revision});
  assert.equal(JSON.stringify(task),before);assert.equal(task.status,'review');
  assert.equal(attention.snapshot(a).items.find(c=>c.id===card.id).state,'read');
  acceptance.acceptOne(a,{id:task.id});
  assert.equal(attention.snapshot(a).items.some(c=>c.id===card.id),false);
});

test('V13 independent audit: changed source evidence revives attention and blocks stale acceptance',t=>{
  const {a,task,source}=localWork(t),card=attention.snapshot(a).items.find(c=>c.id===`review:${task.id}`);
  attention.dispatch(a,'attentionRead',{id:card.id,revision:card.revision});
  source.content='最新预算为 9800 元';
  const current=attention.snapshot(a).items.find(c=>c.id===card.id);
  assert.equal(current.state,'unread');assert.notEqual(current.revision,card.revision);
  assert.throws(()=>attention.dispatch(a,'attentionRead',{id:card.id,revision:card.revision}),/变化/);
  assert.equal(acceptance.snapshot(a).items.find(r=>r.id===task.id).ready,false);
  assert.throws(()=>acceptance.acceptOne(a,{id:task.id}));assert.equal(task.status,'review');
});

test('V13 independent audit: snooze expiry permits one new notification without changing the deadline',t=>{
  const {a,task}=localWork(t),at=Date.now(),originalNow=Date.now;
  t.after(()=>{Date.now=originalNow;});Date.now=()=>at;
  require('../desktop/deadline-events.cjs').setPolicy(a,{taskId:task.id,input:{dueAt:new Date(at+3600000).toISOString()}});
  t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
  let card=attention.snapshot(a).items.find(c=>c.id===`deadline:${task.id}`);
  const business=()=>JSON.stringify(Object.fromEntries(Object.entries(task).filter(([key])=>key!=='workEvent'))),before=business();
  attention.markNotified(a,attention.pendingNotifications(a).items);
  attention.dispatch(a,'attentionSnooze',{id:card.id,revision:card.revision,minutes:30});
  assert.ok(!attention.pendingNotifications(a).items.some(c=>c.id===card.id));
  Date.now=()=>at+31*60000;
  const next=attention.pendingNotifications(a).items.filter(c=>c.id===card.id);
  assert.equal(next.length,1);attention.markNotified(a,next);
  assert.ok(!attention.pendingNotifications(a).items.some(c=>c.id===card.id));
  assert.equal(business(),before);
});

test('V13 independent audit: attention persistence failure leaves work and reading state unchanged',t=>{
  const {a,task}=localWork(t),card=attention.snapshot(a).items.find(c=>c.id===`review:${task.id}`),before=JSON.stringify(a.data),save=a.save;
  a.save=()=>{throw new Error('模拟磁盘已满');};
  assert.throws(()=>attention.dispatch(a,'attentionSnooze',{id:card.id,revision:card.revision,minutes:30}),/磁盘/);
  a.save=save;assert.equal(JSON.stringify(a.data),before);
});

test('V13 independent audit: scoped calendar and attention never expose another project title',t=>{
  const {a,task}=localWork(t);
  a.data.projects=[{id:'p',name:'青禾'},{id:'q',name:'别的项目'}];task.projectId='q';task.title='其他项目的敏感事项';task.dueAt=new Date(Date.now()+3600000).toISOString();
  const own=a.createTask({title:'青禾事项',criteria:'完成'});own.projectId='p';own.dueAt=new Date(Date.now()+3600000).toISOString();
  const before=JSON.stringify(a.data);
  const cards=attention.snapshot(a,{projectId:'p'}),report=calendar.exportCalendar(a,{projectId:'p'});
  assert.ok(!JSON.stringify(cards).includes('敏感事项'));assert.ok(!report.content.includes('敏感事项'));
  assert.equal(report.eventCount,1);assert.match(report.content,/青禾事项/);assert.equal(JSON.stringify(a.data),before);
});

function completedWork(t){const result=localWork(t);result.task.status='completed';result.task.completedAt=new Date().toISOString();result.task.verification.basis=acceptance.basis(result.a,result.task);return result;}
const completedCards=a=>attention.snapshot(a,{category:'completion'}).items;
test('V13 independent audit: unchanged completion polling and saves reuse the full-data validation result',t=>{
  const {a,task}=completedWork(t),reasons=acceptance.reasons;let calls=0;
  acceptance.reasons=(...args)=>{calls++;return reasons(...args);};t.after(()=>{acceptance.reasons=reasons;});
  const business=()=>{const data=structuredClone(a.data);delete data.runtime?.commitId;delete data.runtime?.revision;return data;};const before=business(),commitBefore=a.data.runtime.commitId,revisionBefore=a.data.runtime.revision;assert.equal(completedCards(a).length,1);assert.equal(calls,1);
  completedCards(a);a.publicState();a.save();assert.equal(calls,1);assert.deepEqual(business(),before);assert.notEqual(a.data.runtime.commitId,commitBefore);assert.ok(a.data.runtime.revision>revisionBefore);
  task.updatedAt=new Date(Date.now()+1000).toISOString();
  assert.equal(completedCards(a).length,1);assert.equal(calls,2,'even an in-place timestamp-only edit changes the full-data cache key');
  completedCards(a);assert.equal(calls,2);
});

test('V13 independent audit: every changed completion dependency invalidates a previously cached card',t=>{
  const variants={
    material:({source})=>{source.content='最新材料已改变，ID 与时间不变';},
    artifact:({a})=>{a.data.artifacts[0].content='实际产出已经改变';},
    receipt:({a,task})=>{a.data.agentActions.push({id:'unknown',taskId:task.id,status:'uncertain'});},
    decision:({a,task})=>{a.data.decisions.push({id:'open',status:'open',taskIds:[task.id]});},
    replacement:({a,source})=>{a.data.sources.push({...source,id:'next-source',previousSourceId:source.id});},
    scope:({source})=>{source.projectId='different-project';},
    verification:({task})=>{task.verification.summary='';},
    step:({task})=>{task.steps[0].artifactId='missing-artifact';}
  };
  for(const [name,change] of Object.entries(variants)){
    const item=completedWork(t);assert.equal(completedCards(item.a).length,1,name+' starts complete');
    change(item);assert.equal(completedCards(item.a).length,0,name+' must invalidate without relying on updatedAt');
  }
});

test('V13 independent audit: cached completion cannot survive a prerequisite or project removal',t=>{
  const {a,task,source}=completedWork(t),dependency=a.createTask({title:'前置事项',criteria:'产生前置结果'});
  dependency.status='completed';dependency.steps=[{id:'dep-step',kind:'draft',title:'前置结果',done:true,artifactId:'dep-artifact'}];
  a.data.artifacts.push({id:'dep-artifact',taskId:dependency.id,content:'前置结果'});dependency.verification={passed:true,summary:'核验通过',gaps:[]};dependency.verification.basis=acceptance.basis(a,dependency);
  task.dependsOn=[dependency.id];task.verification.basis=acceptance.basis(a,task);
  assert.equal(completedCards(a).length,1);
  dependency.verification.passed=false;assert.equal(completedCards(a).length,0);
  delete task.dependsOn;a.data.projects.push({id:'p',name:'项目'});task.projectId='p';source.projectId='p';task.verification.basis=acceptance.basis(a,task);
  assert.equal(completedCards(a).length,1);a.data.projects=[];assert.equal(completedCards(a).length,0);
});

test('V13 independent audit: cached completions still leave the seven-day window without data changes',t=>{
  const {a,task}=completedWork(t),original=Date.now,at=Date.parse(task.completedAt);
  t.after(()=>{Date.now=original;});Date.now=()=>at;
  assert.equal(completedCards(a).length,1);const before=JSON.stringify(a.data);
  Date.now=()=>at+7*86400000+1;
  assert.equal(completedCards(a).length,0);assert.equal(attention.pendingNotifications(a).items.some(r=>r.id===`completion:task:${task.id}`),false);
  assert.equal(JSON.stringify(a.data),before);
});

test('V13 independent audit: reloading a workspace never borrows another instance completion cache',t=>{
  const {a}=completedWork(t);a.save();assert.equal(completedCards(a).length,1);
  const reasons=acceptance.reasons;let calls=0;acceptance.reasons=(...args)=>{calls++;return reasons(...args);};t.after(()=>{acceptance.reasons=reasons;});
  const reopened=new Assistant({dir:a.dir});assert.ok(calls>0);assert.equal(completedCards(reopened).length,1);
  reopened.data.sources[0].content='恢复后的材料变了';assert.equal(completedCards(reopened).length,0);assert.equal(completedCards(a).length,1);
});
