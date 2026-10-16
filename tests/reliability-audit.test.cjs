const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs');

async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-reliability-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env={issue:null,hide:false,posts:0,reads:0,models:0,requests:[]};
  const request=async(url,options={})=>{
    env.requests.push({url,method:options.method||'GET'});
    if(options.method==='POST'){
      env.posts++;env.issue={number:7,...JSON.parse(options.body),state:'open',html_url:'https://github.com/test/work/issues/7'};
      throw new Error('发送已到达，但响应丢失');
    }
    env.reads++;
    return {body:JSON.stringify(url.includes('/issues?')?(env.hide?[]:env.issue?[env.issue]:[]):env.issue)};
  };
  const chat=async(p,k,m)=>{env.models++;return m[0].content.includes('核对新来源')?{satisfied:true,quote:'周六发布',reason:'明确事实'}:{tool:'ask',args:{question:'下一步安排？'}};};
  const a=new Assistant({dir,chat,agentRequest:request,connectorRequest:async()=>{throw Error('Unexpected connector request');}});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'});
  await a.dispatch('agentSettings',{githubRepo:'test/work',githubToken:'fixture'});
  const j=agent.buildJob(a,{goal:'整理计划并创建 Issue',useGithub:true,githubMode:'auto',fileMode:'off',maxCalls:40});a.data.delegations.push(j);
  const {taskId}=await agent.act(a,j,'plan_task',{key:'launch',title:'发布计划',criteria:'形成 Issue',steps:[{key:'draft',kind:'draft',title:'写计划'},{key:'create',kind:'external',tool:'github_create',title:'创建 Issue'}]});
  const task=a.task(taskId);a.data.artifacts.push({id:'artifact-1',taskId,content:'周六发布',title:'计划',createdAt:new Date().toISOString()});Object.assign(task.steps[0],{done:true,artifactId:'artifact-1'});a.save();
  const lose=async()=>{await assert.rejects(agent.act(a,j,'github_create',{taskId}),/响应丢失/);return a.data.agentActions[0];};
  const source=()=>{const s={id:`source-${a.data.sources.length}`,content:'周六发布',title:'最新安排',createdAt:new Date(Date.now()+10).toISOString()};a.data.sources.push(s);j.sourceIds.push(s.id);return s;};
  return {a,j,task,env,request,chat,lose,source};
}

test('Uncertain automatic writes are durable and visible in the decision center after restart',async t=>{
  const {a,j,env,request,chat,lose}=await setup(t);const r=await lose();
  assert.equal(r.status,'uncertain');assert.equal(j.pendingActionId,r.id);assert.equal(a.publicState().decisionCards[0].kind,'uncertain');
  const b=new Assistant({dir:a.dir,agentRequest:request,chat});assert.equal(b.data.delegations[0].pendingActionId,r.id);assert.equal(env.posts,1);
});

test('Version changes cannot turn an uncertain external effect stale or resend it',async t=>{
  const {a,j,task,env,lose}=await setup(t);const r=await lose();task.criteria='新的验收标准';task.needsReplan='已收到新要求';
  const start=env.requests.length;await writes.execute(a,j,r);
  assert.equal(r.status,'done');assert.equal(env.posts,1);assert.ok(env.requests.slice(start).every(x=>x.method==='GET'));
  assert.equal(task.steps[1].done,false,'old receipt cannot finish the revised step');assert.equal(task.needsReplan,'已收到新要求');
});

test('A missing uncertain result requires human resolution and does not spend model calls',async t=>{
  const {a,j,env,lose}=await setup(t);const r=await lose();env.hide=true;
  await a.dispatch('agentRun',{id:j.id});await a.runPromise;
  assert.equal(j.status,'needs_input');assert.equal(r.status,'uncertain');assert.equal(j.pendingActionId,r.id);assert.equal(env.posts,1);assert.equal(env.models,0);
  await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(env.posts,1);assert.equal(r.status,'uncertain');
});

test('Read-only reconciliation runs before changed memory invalidates the plan',async t=>{
  const {a,j,env,lose}=await setup(t);const r=await lose();j.memorySignature='older-memory-context';
  const start=env.requests.length;await a.dispatch('agentRun',{id:j.id});await a.runPromise;
  assert.equal(r.status,'done');assert.equal(env.posts,1);assert.ok(env.requests.slice(start).every(x=>x.method==='GET'));assert.notEqual(j.memorySignature,'older-memory-context');
});

test('Revoked write permission still permits read-only inspection of the authorized repository',async t=>{
  const {a,j,env,lose}=await setup(t);const r=await lose();j.githubMode='off';await writes.execute(a,j,r);
  assert.equal(r.status,'done');assert.equal(env.posts,1);
});

test('A changed repository scope preserves uncertainty without inspecting or writing the old repo',async t=>{
  const {a,j,env,lose}=await setup(t);const r=await lose();j.githubRepo='test/other';const reads=env.reads;
  await assert.rejects(writes.execute(a,j,r),/授权范围/);assert.equal(r.status,'uncertain');assert.equal(env.reads,reads);assert.equal(env.posts,1);
});

test('An uncertain local file is checked without creating missing output files',async t=>{
  const {a,j,task}=await setup(t);const output=path.join(a.dir,'output');fs.mkdirSync(output);j.outputFolder=output;
  const r={id:'uncertain-file',jobId:j.id,taskId:task.id,tool:'write_file',target:path.join(output,'missing.md'),latestName:'latest.md',content:'原报告',status:'uncertain'};a.data.agentActions.push(r);
  await assert.rejects(writes.execute(a,j,r));assert.equal(r.status,'uncertain');assert.deepEqual(fs.readdirSync(output),[]);
});

test('Fact resolution cannot partially close a decision while another action is uncertain',async t=>{
  const {a,j,task,env,source}=await setup(t);await agent.act(a,j,'ask',{key:'date',question:'发布日？',decisionType:'information',taskIds:[task.id]});const d=a.data.decisions[0],s=source();
  a.data.agentActions.push({id:'orphan-uncertain',jobId:j.id,status:'uncertain'});j.pendingActionId=null;
  await assert.rejects(agent.act(a,j,'resolve_question',{decisionId:d.id,sourceId:s.id}),/核对外部/);
  assert.equal(d.status,'open');assert.equal(d.answer,undefined);assert.equal(env.models,0);assert.equal(j.feedback.length,0);
  const card=a.publicState().decisionCards.find(c=>c.id===d.id);
  await assert.rejects(a.dispatch('decisionAnswer',{id:d.id,revision:card.revision,answer:'周六'}),/核对外部/);assert.equal(d.status,'open');
});

test('Repeating the same fact question keeps newly arrived evidence usable',async t=>{
  const {a,j,source}=await setup(t);const args={key:'date',question:'发布日？',decisionType:'information'};
  await agent.act(a,j,'ask',args);const d=a.data.decisions[0],baseline=[...d.baselineIds],since=d.evidenceAfter;
  const s=source();await agent.act(a,j,'ask',args);assert.deepEqual(d.baselineIds,baseline);assert.equal(d.evidenceAfter,since);
  await agent.act(a,j,'resolve_question',{decisionId:d.id,sourceId:s.id});assert.equal(d.status,'resolved');assert.equal(d.answer,'周六发布');
});

test('A substantively changed fact question establishes a new evidence checkpoint',async t=>{
  const {a,j,source}=await setup(t);await agent.act(a,j,'ask',{key:'date',question:'发布日？',decisionType:'information'});const d=a.data.decisions[0],s=source();
  await agent.act(a,j,'ask',{key:'date',question:'维护日？',decisionType:'information'});assert.ok(d.baselineIds.includes(s.id));
  await assert.rejects(agent.act(a,j,'resolve_question',{decisionId:d.id,sourceId:s.id}),/新来源/);assert.equal(d.status,'open');
});

test('A message from another sender cannot be accepted as the current user’s send receipt',async t=>{
  const {a,j,task}=await setup(t);await a.dispatch('projectSave',{name:'会话核对'});const p=a.data.projects[0];j.projectId=p.id;p.jobId=j.id;
  await a.dispatch('connectorSave',{name:'会话',projectId:p.id,kind:'chat',target:'oc_test',enabled:false});const c=a.data.connectors[0];
  let sends=0;
  a.connectorRequest=async args=>{
    if(args[0]==='auth')return {verified:true,identities:{user:{available:true,status:'ready',openId:'ou_self'}}};
    if(args[1]==='+messages-send'){sends++;return {data:{message_id:'om_confirm',chat_id:'oc_test'}};}
    return {data:{messages:[{message_id:'om_confirm',chat_id:'oc_test',msg_type:'text',content:'请确认日期',sender:{id:'ou_other'}}]}};
  };
  await a.dispatch('communicationPolicy',{connectorId:c.id,mode:'auto',template:'请确认日期',intervalMinutes:1440,maxSends:3,expiresAt:new Date(Date.now()+86400000).toISOString()});
  const args={taskId:task.id,connectorId:c.id,key:'confirm',body:'请确认日期',expected:'明确日期',respondentId:'ou_owner'};
  await assert.rejects(agent.act(a,j,'request_confirmation',{...args,reminder:'false'}),/布尔/);assert.equal(sends,0);
  await assert.rejects(agent.act(a,j,'request_confirmation',args),/发送者/);assert.equal(sends,1);assert.equal(a.data.agentActions[0].status,'uncertain');assert.equal(a.data.agentActions[0].senderId,'ou_self');
});
