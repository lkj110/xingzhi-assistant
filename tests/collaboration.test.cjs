const pinnedFixture=require('./helpers/lark-pinned-fixture.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),connectors=require('../desktop/connectors.cjs'),followup=require('../desktop/agent-followup.cjs'),communications=require('../desktop/communications.cjs'),recovery=require('../desktop/recovery.cjs'),lark=require('../desktop/lark-connector.cjs');
const stamp=()=>new Date().toISOString();
async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-collab-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env={requests:[],messages:[],posts:[],satisfied:true,quote:'确认周六发布',document:'原始文档',loseSend:false,failRead:false};
  const request=async args=>{
    env.requests.push(args);const flag=k=>args[args.indexOf(k)+1];
    if(args[0]==='auth')return {verified:true,identities:{user:{available:true,status:'ready',openId:'ou_self'}}};
    if(args[1]==='+messages-send'){
      const m={message_id:`om_sent${env.posts.length+1}`,chat_id:flag('--chat-id'),msg_type:'text',content:flag('--text'),create_time:stamp(),sender:{id:'ou_self'}};env.posts.push(m);
      if(env.loseSend)throw new Error('响应丢失');return {ok:true,data:{message_id:m.message_id,chat_id:m.chat_id}};
    }
    if(args[1]==='+messages-mget'){if(env.failRead)throw new Error('回读失败');return {data:{messages:env.posts.filter(m=>m.message_id===flag('--message-ids'))}};}
    if(args[0]==='docs')return {data:{document:{content:env.document}}};
    return {data:{messages:env.messages,has_more:false}};
  };
  const chat=async(_p,_k,m)=>{
    if(m[0].content.includes('独立判断等待条件')||m[0].content.includes('核对新来源'))return {satisfied:env.satisfied,quote:env.quote,reason:env.satisfied?'明确回答问题':'含糊回复'};
    if(m[0].content.includes('动作格式'))return {tool:'ask',args:{question:'测试结束'}};
    return {passed:true,summary:'完成',gaps:[]};
  };
  const a=new Assistant({dir,chat,connectorRequest:request});await pinnedFixture.attach(t,a,request);await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'测试模型',model:'fixture',baseUrl:'https://example.invalid/v1'});await a.dispatch('projectSave',{name:'发布项目'});
  const p=a.data.projects[0],j=agent.buildJob(a,{projectId:p.id,goal:'等待负责人确认日期，继续推进',fileMode:'off',allowWeb:false,maxCalls:40});a.data.delegations.push(j);p.jobId=j.id;
  const {taskId}=await agent.act(a,j,'plan_task',{key:'launch',title:'确认发布日期',criteria:'负责人确认周六发布',steps:[{key:'send',kind:'external',tool:'request_confirmation',title:'向负责人确认'}]});
  await a.dispatch('connectorSave',{name:'发布会话',kind:'chat',target:'oc_test',projectId:p.id,enabled:false});const c=a.data.connectors[0];await pinnedFixture.bind(a,c);
  const config=more=>a.dispatch('communicationPolicy',{connectorId:c.id,mode:'ask',intervalMinutes:60,maxSends:3,expiresAt:new Date(Date.now()+86400000).toISOString(),...more});
  const args={taskId,connectorId:c.id,key:'date',body:'请确认是否周六发布。',expected:'负责人明确确认周六发布',respondentId:'ou_owner'};
  const send=more=>agent.act(a,j,'request_confirmation',{...args,...more});
  const message=(id,body='确认周六发布',sender='ou_owner',time=stamp())=>({message_id:`om_${id}`,sender:{id:sender,name:'负责人'},create_time:time,content:body,msg_type:'text'});
  const wait=()=>agent.act(a,j,'wait',{key:'date',reason:'等待负责人确认',expected:args.expected,sourceIds:[],connectorIds:[c.id],respondentId:'ou_owner'});
  const importMessage=async m=>{env.messages.push(m);await connectors.sync(a,c.id);return a.data.sources[0];};
  const resolve=s=>agent.act(a,j,'resolve_wait',{key:'date',sourceId:s.id,evidence:'来源明确回答了日期'});
  a.save();return {a,j,p,c,env,request:a.connectorRequest,chat,config,args,send,wait,message,importMessage,resolve,task:a.task(taskId)};
}
test('Connector waits work before first message and unchanged checks consume no model calls',async t=>{
  const {a,j,c,wait}=await setup(t);await wait();assert.deepEqual(j.followups[0].watchKeys,[`connector:${c.id}`]);const used=j.callsUsed;
  await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(j.callsUsed,used);assert.equal(j.status,'watching');
});
test('Feishu sender and timestamp normalization preserve machine-checkable metadata',()=>{
  assert.equal(lark.senderId({id:{open_id:'ou_person'}}),'ou_person');assert.equal(lark.senderId({name:'ou_person'}),null);
  assert.equal(lark.timestamp('1700000000'),lark.timestamp('1700000000000'));assert.equal(lark.messageText('{"text":"正文"}'),'正文');
});
test('New document versions resolve waits only after independent semantic verification',async t=>{
  const {a,j,p,env}=await setup(t);await a.dispatch('connectorSave',{name:'计划',kind:'document',target:'https://test.feishu.cn/docx/Test',projectId:p.id,enabled:false});const c=a.data.connectors.at(-1);await pinnedFixture.bind(a,c);
  await connectors.sync(a,c.id);const first=a.data.sources[0];await agent.act(a,j,'wait',{key:'document',reason:'等确认',expected:'确认周六发布',sourceIds:[first.id]});
  await assert.rejects(agent.act(a,j,'resolve_wait',{key:'document',sourceId:first.id,evidence:'旧证据'}),/新取得|历史消息/);
  env.document='确认周六发布';await connectors.sync(a,c.id);a.activeAgentJob=j;const used=j.callsUsed;await agent.act(a,j,'resolve_wait',{key:'document',sourceId:a.data.sources[0].id,evidence:'新文档确认'});a.activeAgentJob=null;
  assert.equal(j.followups[0].status,'resolved');assert.equal(j.callsUsed,used+1);assert.equal(j.followups[0].verification.quote,env.document);
});
test('Wrong senders, historical imports, deleted and own messages cannot satisfy a wait',async t=>{
  const {a,j,wait,message,importMessage,resolve}=await setup(t);await wait();j.followups[0].createdAt=new Date(Date.now()-1000).toISOString();
  await assert.rejects(resolve(await importMessage(message('wrong','确认周六发布','ou_other'))),/回复人/);
  await assert.rejects(resolve(await importMessage(message('old','确认周六发布','ou_owner','2020-01-01T00:00:00Z'))),/历史消息/);
  await assert.rejects(resolve(await importMessage({...message('deleted'),deleted:true})),/新取得|历史消息/);
  a.data.larkHealth={openId:'ou_owner'};await assert.rejects(resolve(await importMessage(message('own'))),/自己的消息/);
  assert.equal(j.followups[0].status,'waiting');assert.equal(a.data.modelCalls?.length||0,0);
});
test('Vague replies and invented quotations remain waiting; a clear later reply resumes the existing task',async t=>{
  const {a,j,env,wait,message,importMessage,resolve}=await setup(t);await wait();j.followups[0].createdAt=new Date(Date.now()-1000).toISOString();
  const vague=await importMessage(message('vague','收到，晚点确认'));env.satisfied=false;assert.equal((await resolve(vague)).resolved,false);
  env.satisfied=true;assert.equal((await resolve(vague)).resolved,false,'a fabricated model quote must fail');
  const clear=await importMessage(message('clear'));await resolve(clear);assert.equal(j.followups[0].status,'resolved');assert.equal(a.data.tasks.length,1);
});
test('Replies to a different connector cannot release the wait',async t=>{
  const {a,j,p,wait,message,env,resolve}=await setup(t);await wait();await a.dispatch('connectorSave',{name:'其他群',kind:'chat',target:'oc_other',projectId:p.id,enabled:false});await pinnedFixture.bind(a,a.data.connectors.at(-1));env.messages=[message('other')];await connectors.sync(a,a.data.connectors.at(-1).id);await assert.rejects(resolve(a.data.sources[0]),/新取得|历史消息/);assert.equal(j.followups[0].status,'waiting');
});
test('Same question is deduplicated and one answer reaches all associated tasks with a receipt',async t=>{
  const {a,j,task}=await setup(t);const second=await agent.act(a,j,'plan_task',{key:'next',title:'下游',criteria:'完成',steps:[{kind:'draft',title:'写计划'}]});
  const question={key:'date',question:'最终日期？',suggestion:'周六',taskIds:[task.id,second.taskId]};await agent.act(a,j,'ask',question);await agent.act(a,j,'ask',question);assert.equal(a.data.decisions.length,1);
  const d=a.publicState().decisionCards[0];await a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,answer:'周六'});
  assert.equal(j.status,'ready');assert.ok(j.taskIds.every(id=>a.task(id).notes.some(n=>n.text.includes('周六'))));assert.equal(a.data.decisions[0].answer,'周六');
  const reused=await agent.act(a,j,'ask',question);assert.equal(reused.alreadyAnswered,true);assert.equal(a.publicState().decisionCards.length,0);
});
test('Decision answers reject stale revisions, preserve paused jobs and never cross task scope',async t=>{
  const {a,j,task}=await setup(t);await assert.rejects(agent.act(a,j,'ask',{question:'选择',taskIds:['foreign']}),/本委托/);
  await agent.act(a,j,'ask',{question:'选择日期',taskIds:[task.id]});const d=a.publicState().decisionCards[0];task.description='新要求';
  await assert.rejects(a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,answer:'周六'}),/变化/);
  j.status='paused';const current=a.publicState().decisionCards[0];await a.dispatch('decisionAnswer',{id:current.id,revision:current.revision,answer:'周六'});assert.equal(j.status,'paused');
});
test('Timeout is shown once and can be extended without consuming model calls',async t=>{
  const {a,j,wait}=await setup(t);await wait();j.followups[0].deadlineAt=new Date(Date.now()-1000).toISOString();followup.due(a,j);followup.due(a,j);
  assert.equal(a.data.decisions.length,1);const d=a.publicState().decisionCards[0];await a.dispatch('decisionTimeout',{id:d.id,revision:d.revision,choice:'extend',deadlineAt:new Date(Date.now()+3600000).toISOString()});
  assert.equal(j.status,'watching');assert.equal(j.followups[0].timedOutAt,undefined);assert.equal(j.callsUsed,0);assert.equal(a.publicState().decisionCards.length,0);
});
test('Timeout replan retains the old condition and the user reason',async t=>{
  const {a,j,wait}=await setup(t);await wait();j.followups[0].deadlineAt='2020-01-01T00:00:00Z';followup.due(a,j);const d=a.publicState().decisionCards[0];await a.dispatch('decisionTimeout',{id:d.id,revision:d.revision,choice:'replan',note:'先交付已确认部分'});assert.equal(j.followups[0].status,'cancelled');assert.match(j.feedback.at(-1).text,/先交付/);assert.equal(j.status,'ready');
});
test('Sending is off by default, rejects foreign targets and enforces expiry',async t=>{
  const {a,j,c,config,send}=await setup(t);await assert.rejects(send(),/尚未授权/);await config();await assert.rejects(send({connectorId:'other'}),/本项目/);c.sendPolicy.expiresAt='2020-01-01T00:00:00Z';await assert.rejects(send(),/到期/);assert.equal(a.data.agentActions.length,0);
});
test('Preview, edit, version-bound approval, send and receipt verification form one closed loop',async t=>{
  const {a,j,config,send,env,task}=await setup(t);await config();await send();assert.equal(j.status,'approval');assert.equal(env.posts.length,0);
  let r=a.data.agentActions[0];const old=r.version;await a.dispatch('communicationEdit',{actionId:r.id,version:r.version,content:'请确认本周六发布。'});assert.notEqual(r.version,old);
  await assert.rejects(a.dispatch('agentApprove',{id:j.id,actionId:r.id,version:old}),/变化/);
  await a.dispatch('agentApprove',{id:j.id,actionId:r.id,version:r.version});await a.dispatch('agentRun',{id:j.id});await a.runPromise;
  assert.equal(r.status,'done');assert.equal(env.posts.length,1);assert.equal(r.result.verified,true);assert.equal(j.status,'watching');assert.equal(j.followups[0].status,'waiting');assert.equal(task.steps[0].done,true);
  assert.ok(env.requests.filter(x=>x[0]==='im').every(x=>x[x.indexOf('--as')+1]==='user'));assert.ok(env.requests.find(x=>x[1]==='+messages-send').includes('--idempotency-key'));
});
test('Only exact saved text can auto-send, with no repeat on a duplicate request',async t=>{
  const {a,j,config,send,env,args}=await setup(t);await config({mode:'auto',template:args.body});await send();await send();assert.equal(env.posts.length,1);assert.equal(j.status,'watching');
  const {a:b,config:configure,send:other,env:e}=await setup(t);await configure({mode:'auto',template:'仅批准这个文案'});await other();assert.equal(e.posts.length,0);assert.equal(b.data.delegations[0].status,'approval');
});
test('Reminder cooldown and total limit survive grant edits and restarts',async t=>{
  const {a,j,c,config,send,env,args}=await setup(t);await config({mode:'auto',template:args.body,maxSends:2});await send();await assert.rejects(send({reminder:true}),/间隔/);a.data.agentActions[0].startedAt='2020-01-01T00:00:00Z';await send({reminder:true});assert.equal(env.posts.length,2);
  await config({mode:'auto',template:args.body,maxSends:2});await assert.rejects(send({reminder:true}),/上限/);const b=new Assistant({dir:a.dir,connectorRequest:a.connectorRequest});await assert.rejects(agent.act(b,b.data.delegations[0],'request_confirmation',{...args,reminder:true}),/上限/);
});
test('Changing or revoking a grant invalidates pending messages and never sends old content',async t=>{
  const {a,j,config,send,env}=await setup(t);await config();await send();const r=a.data.agentActions[0];await config({mode:'off'});assert.equal(r.status,'stale');assert.equal(j.pendingActionId,null);await assert.rejects(a.dispatch('agentApprove',{id:j.id}),/没有|失效/);assert.equal(env.posts.length,0);
});
test('Lost send response stays uncertain across restart and never blindly resends',async t=>{
  const {a,j,config,send,env,args,request}=await setup(t);await config({mode:'auto',template:args.body});env.loseSend=true;await assert.rejects(send(),/响应丢失/);assert.equal(a.data.agentActions[0].status,'uncertain');
  const b=new Assistant({dir:a.dir,connectorRequest:request});await assert.rejects(agent.act(b,b.data.delegations[0],'request_confirmation',args),/核对/);assert.equal(env.posts.length,1);
  await b.dispatch('communicationCheck',{actionId:b.data.agentActions[0].id,messageId:env.posts[0].message_id});await b.runPromise;assert.equal(b.data.agentActions[0].status,'done');assert.equal(env.posts.length,1);
});
test('A persisted receipt can be reconciled after a read failure using only GET-like CLI commands',async t=>{
  const {a,j,config,send,env,args}=await setup(t);await config({mode:'auto',template:args.body});env.failRead=true;await assert.rejects(send(),/回读/);const r=a.data.agentActions[0];assert.ok(r.messageId);env.failRead=false;j.status='paused';await a.dispatch('communicationCheck',{actionId:r.id});await a.runPromise;assert.equal(r.status,'done');assert.equal(j.status,'paused');assert.equal(env.posts.length,1);
});
test('Restoring a backup preserves send receipts but revokes unattended sends',async t=>{
  const {a,j,c,config,send,env,args}=await setup(t);await config({mode:'auto',template:args.body});const id=recovery.create(a);await send();await a.dispatch('backupRestore',{id});assert.equal(a.data.agentActions[0].status,'done');assert.equal(a.data.connectors[0].sendPolicy.mode,'off');assert.equal(a.data.delegations[0].status,'paused');assert.equal(env.posts.length,1);
});
test('Replies after a timeout close the associated decision without pretending the whole job is done',async t=>{
  const {a,j,wait,message,importMessage,resolve}=await setup(t);await wait();j.followups[0].createdAt=new Date(Date.now()-2000).toISOString();j.followups[0].deadlineAt=new Date(Date.now()-1000).toISOString();followup.due(a,j);assert.equal(a.data.decisions[0].status,'open');await resolve(await importMessage(message('reply')));assert.equal(a.data.decisions[0].status,'resolved');assert.notEqual(j.status,'completed');
});
test('New facts can resolve information questions but cannot grant permissions or choose for the user',async t=>{
  const {a,j,env,message,importMessage}=await setup(t);await agent.act(a,j,'ask',{key:'date',question:'日期是什么',decisionType:'information'});let d=a.data.decisions[0];const s=await importMessage(message('date'));await agent.act(a,j,'resolve_question',{decisionId:d.id,sourceId:s.id});assert.equal(d.status,'resolved');
  await agent.act(a,j,'ask',{key:'permission',question:'是否授权发送',decisionType:'choice'});d=a.data.decisions[0];await assert.rejects(agent.act(a,j,'resolve_question',{decisionId:d.id,sourceId:s.id}),/用户选择/);assert.equal(d.status,'open');
});
test('An edited or recalled confirmation reopens the same wait and invalidates affected work',async t=>{
  const {a,j,env,task,c,wait,message,importMessage,resolve}=await setup(t);await wait();j.followups[0].taskId=task.id;j.followups[0].createdAt=new Date(Date.now()-2000).toISOString();
  const s=await importMessage(message('confirmed'));await resolve(s);assert.ok(task.sourceIds.includes(s.id));assert.equal(j.followups[0].status,'resolved');
  env.messages=[{...message('confirmed'),deleted:true}];await connectors.sync(a,c.id);assert.equal(j.followups[0].status,'waiting');assert.ok(task.needsReplan);assert.equal(j.followups[0].previousResolutions[0].sourceId,s.id);
});
test('Connector-only waiting remains model-free after a manual pause and resume',async t=>{
  const {a,j,wait}=await setup(t);await wait();await a.dispatch('agentPause',{id:j.id});await a.dispatch('agentResume',{id:j.id});assert.equal(j.status,'watching');await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(j.callsUsed,0);
});
test('Core drafting questions appear in the decision center and standalone reviews remain accessible',async t=>{
  const {a,j,task}=await setup(t);await agent.act(a,j,'plan_task',{key:task.agentKey,title:task.title,criteria:task.criteria,reason:'先起草',steps:[{kind:'draft',title:'写计划'}]});
  a.chat=async()=>({kind:'need_input',question:'缺少目标预算'});await a.advance(task.id);assert.ok(a.publicState().decisionCards.some(d=>d.question==='缺少目标预算'));
  const standalone=a.createTask({title:'独立任务'});standalone.status='review';assert.ok(a.publicState().decisionCards.some(d=>d.kind==='task'&&d.taskId===standalone.id));
});
test('Disagreement with a pending external action cannot be overwritten by a decision answer',async t=>{
  const {a,j,config,send}=await setup(t);await config();await send();const r=a.data.agentActions[0];r.status='uncertain';await agent.act(a,j,'ask',{question:'确定新计划？'});const d=a.publicState().decisionCards.find(d=>d.kind==='question');await assert.rejects(a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,answer:'改为周日'}),/核对外部/);assert.equal(a.data.decisions[0].status,'open');assert.equal(r.status,'uncertain');
});
test('Sent requests schedule a future reminder check and a later wait preserves that check',async t=>{
  const {a,j,config,send,args}=await setup(t);await config({mode:'auto',template:args.body});await send();const f=j.followups[0],checkAt=f.checkAt;
  assert.ok(Date.parse(checkAt)>=Date.now()+59*60000);
  await agent.act(a,j,'wait',{key:f.key,taskId:f.taskId,reason:'仍需确认',expected:f.expected,sourceIds:[],connectorIds:[args.connectorId],respondentId:f.respondentId,deadlineAt:f.deadlineAt});assert.equal(f.checkAt,checkAt);
  f.checkAt=new Date(Date.now()-1000).toISOString();assert.equal(followup.due(a,j).wake,true);assert.equal(followup.due(a,j).wake,false);
});
test('Rephrasing an ongoing wait keeps its original checkpoint and deadline',async t=>{
  const {a,j,config,send,args,importMessage,message,resolve}=await setup(t);await config({mode:'auto',template:args.body});await send();const f=j.followups[0];f.createdAt=new Date(Date.now()-5000).toISOString();const start=f.createdAt,deadline=f.deadlineAt,baseline=[...f.baselineIds];
  await agent.act(a,j,'wait',{key:f.key,taskId:f.taskId,reason:'继续等待',expected:'需要明确确认周六发布日期',sourceIds:[],connectorIds:[args.connectorId],respondentId:f.respondentId});
  assert.equal(f.createdAt,start);assert.equal(f.deadlineAt,deadline);assert.deepEqual(f.baselineIds,baseline);
  const reply=await importMessage(message('in_flight','确认周六发布','ou_owner',new Date(Date.now()-2000).toISOString()));await resolve(reply);assert.equal(f.status,'resolved');
});
test('Reconciling a historical message never completes a changed plan or rewrites its waiting checkpoint',async t=>{
  const {a,j,config,send,args,env,task}=await setup(t);await config({mode:'auto',template:args.body});env.failRead=true;
  await assert.rejects(send(),/回读失败/);const r=a.data.agentActions[0],f=j.followups[0];assert.equal(r.status,'uncertain');
  task.criteria='恢复后的计划要求确认周日';task.needsReplan='恢复备份后核对';j.status='paused';const previous=JSON.stringify(f);
  assert.notEqual(r.version,communications.version(a,j,r));env.failRead=false;
  await a.dispatch('communicationCheck',{actionId:r.id});await a.runPromise;
  assert.equal(r.status,'done');assert.equal(r.result.verified,true);assert.equal(env.posts.length,1);assert.equal(task.steps[0].done,false);assert.equal(task.steps[0].evidence,undefined);assert.equal(task.needsReplan,'恢复备份后核对');assert.equal(j.status,'paused');assert.equal(j.pendingActionId,null);assert.equal(JSON.stringify(f),previous);
});
test('Revoked message readback stays uncertain until the same account and conversation are explicitly reauthorized',async t=>{
  const {a,j,config,send,args,env,task}=await setup(t);await config({mode:'auto',template:args.body});env.failRead=true;
  await assert.rejects(send(),/回读失败/);const r=a.data.agentActions[0];await config({mode:'off'});env.failRead=false;
  const reads=env.requests.filter(r=>r[1]==='+messages-mget').length;
  await a.dispatch('communicationCheck',{actionId:r.id});await a.runPromise;
  assert.equal(r.status,'uncertain');assert.equal(env.requests.filter(r=>r[1]==='+messages-mget').length,reads);assert.equal(env.posts.length,1);
  await config({mode:'ask'});await a.dispatch('communicationCheck',{actionId:r.id});await a.runPromise;
  assert.equal(r.status,'done');assert.equal(env.posts.length,1);assert.equal(task.steps[0].done,false);assert.ok(task.needsReplan);assert.equal(j.status,'ready');assert.equal(j.pendingActionId,null);
});

test('Current approved messages stop requesting duplicate approval while stale versions remain visible',async t=>{
  const {a,j,config,send,task}=await setup(t);await config();await send();const r=a.data.agentActions[0];assert.ok(a.publicState().decisionCards.some(d=>d.id===`action:${r.id}`));
  await a.dispatch('agentApprove',{id:j.id,actionId:r.id,version:r.version});assert.equal(r.status,'pending');assert.ok(r.approvedAt);assert.equal(j.status,'ready');assert.ok(!a.publicState().decisionCards.some(d=>d.id===`action:${r.id}`));
  task.criteria='改为确认周日';assert.ok(a.publicState().decisionCards.some(d=>d.id===`action:${r.id}`));await assert.rejects(a.dispatch('agentApprove',{id:j.id,actionId:r.id,version:r.version}),/旧确认失效/);assert.equal(r.status,'stale');assert.equal(j.pendingActionId,null);
});
