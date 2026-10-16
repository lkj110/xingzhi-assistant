const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),access=require('../desktop/access.cjs'),decisions=require('../desktop/decisions.cjs'),lark=require('../desktop/lark-connector.cjs');
const target='https://fixture.my.larkoffice.com/docx/TestDocument';
const ready={verified:true,identities:{user:{available:true,status:'ready',openId:'fixture-user'},bot:{available:true,status:'ready'}}};
const absent={verified:true,identities:{user:{available:false,status:'missing'},bot:{available:true,status:'ready'}}};
const document={ok:true,data:{document:{content:'# 当前现状\n有据可查的正文',revision_id:12}}};
async function setup(t,run=async args=>args[0]==='auth'?ready:document){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-access-'));const a=new Assistant({dir,connectorRequest:run});t.after(()=>{access.cancel(a);fs.rmSync(dir,{recursive:true,force:true});});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  const j=agent.buildJob(a,{goal:`精简${target}中的内容`,allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.push(j);
  await agent.act(a,j,'plan_task',{key:'summary',title:'精简文档',criteria:'保留事实并突出规划',steps:[{key:'draft',kind:'draft',title:'编写'}]});
  return {a,j};
}
function card(a,j){access.request(a,j,{kind:'lark_document',target,reason:'获取需要精简的原文'});return a.data.decisions.find(d=>d.jobId===j.id&&d.kind==='permission'&&d.status==='open');}
async function action(a,d,name='accessRetry'){await a.dispatch(name,{id:d.id,revision:decisions.revision(a.data,d)});await a.runPromise;}
test('LarkOffice URLs are accepted without accepting lookalike domains, credentials or arbitrary paths',()=>{
  assert.equal(lark.docTarget(target+'?from=share'),target);assert.deepEqual(access.docURLs(`精简${target}中的内容`),[target]);
  for(const value of ['https://larkoffice.com.evil.test/docx/Test','https://evil.test/docx/T','https://u:p@a.larkoffice.com/docx/T','http://a.larkoffice.com/docx/T','https://a.larkoffice.com/docx/T/extra'])assert.throws(()=>lark.docTarget(value));
  for(const value of ['file:///tmp/a','javascript:alert(1)','https://feishu.cn.evil.test/auth','https://u:p@accounts.feishu.cn/auth'])assert.throws(()=>lark.authURL(value));
});
test('Private document read asks for exact scoped permission before any CLI or model calls',async t=>{
  let calls=0;const {a,j}=await setup(t,async()=>{calls++;return ready;});
  const r=await agent.act(a,j,'read_url',{url:target+'?share=1'});assert.equal(r.needsAuthorization,true);assert.equal(calls,0);assert.equal(j.status,'needs_input');assert.equal(j.allowWeb,false);assert.deepEqual(j.documentGrants||[],[]);
  const second=await agent.act(a,j,'read_lark_document',{url:target});assert.equal(second.decisionId,r.decisionId);assert.equal(a.data.decisions.filter(d=>d.status==='open').length,1);
  await assert.rejects(decisions.resolveInformation(a,j,{decisionId:r.decisionId,sourceId:'x'}),/只能依据/);
});
test('Bot login never counts as user authorization; no plaintext grant can bypass it',async t=>{
  const calls=[];const {a,j}=await setup(t,async args=>{calls.push(args);return absent;});const d=card(a,j);await action(a,d);
  assert.equal(d.access.stage,'login');assert.equal(d.status,'open');assert.deepEqual(j.documentGrants||[],[]);assert.equal(a.data.sources.length,0);assert.equal(calls.length,1);
  await assert.rejects(a.dispatch('decisionAnswer',{id:d.id,revision:decisions.revision(a.data,d),answer:'同意授权'}),/未知决定/);
});
test('Verified standalone document attaches to original task and resumes within original ledger scope',async t=>{
  const {a,j}=await setup(t);j.callsUsed=9;const before=JSON.stringify(a.spendLedger),taskId=j.taskIds[0],d=card(a,j);await action(a,d);
  assert.equal(d.status,'resolved');assert.equal(j.status,'ready');assert.equal(j.callsUsed,9);assert.equal(JSON.stringify(a.spendLedger),before);assert.deepEqual(j.taskIds,[taskId]);assert.equal(j.documentGrants[0].target,target);assert.equal(j.allowWeb,false);assert.equal(j.projectId,null);assert.equal(a.data.sources.length,1);assert.ok(a.task(taskId).sourceIds.includes(a.data.sources[0].id));assert.equal(a.data.sources[0].remoteRevision,12);
  await agent.act(a,j,'read_lark_document',{url:target});assert.equal(a.data.sources.length,1);
});
test('OAuth split flow is ephemeral, readonly and resumes only after a real user identity and successful fetch',async t=>{
  let authorized=false;const calls=[];const {a,j}=await setup(t,async args=>{calls.push(args);if(args[1]==='status')return authorized?ready:absent;if(args.includes('--no-wait'))return {verification_url:'https://accounts.feishu.cn/device?code=LOGIN',device_code:'DEVICE_SECRET',expires_in:240};if(args.includes('--device-code')){authorized=true;return {ok:true};}return document;});
  const d=card(a,j);await action(a,d,'accessStart');assert.equal(d.access.stage,'waiting_login');assert.equal(calls.length,2);assert.deepEqual(calls[1],['auth','login','--scope','docx:document:readonly','--no-wait','--json']);
  assert.ok(a.publicState().accessSessions[0].url);assert.equal(JSON.stringify(a.publicState()).includes('DEVICE_SECRET'),false);assert.equal(fs.readFileSync(a.file,'utf8').includes('DEVICE_SECRET'),false);assert.equal(fs.readFileSync(a.file,'utf8').includes('code=LOGIN'),false);assert.equal(JSON.stringify(agent.context(a,j)).includes('code=LOGIN'),false);
  const session=a.accessSessions.get(d.id);access.opening(a,{id:d.id}).start();await session.promise;assert.equal(d.access.stage,'authorized');assert.equal(access.tick(a),true);await a.runPromise;assert.equal(d.status,'resolved');assert.equal(a.accessSessions.size,0);assert.equal(j.status,'ready');
});
test('Untrusted OAuth URLs cannot reach the shell opener or grant document access',async t=>{
  const {a,j}=await setup(t,async args=>args[1]==='status'?absent:{verification_url:'https://attacker.test/oauth',device_code:'SECRET'});const d=card(a,j);await action(a,d,'accessStart');assert.equal(d.access.stage,'retry');assert.equal(a.accessSessions.size,0);assert.deepEqual(j.documentGrants||[],[]);assert.throws(()=>access.opening(a,{id:d.id}));
});
test('Document ACL and missing scopes remain distinct actionable errors, not successful authorization',async t=>{
  for(const kind of ['resource','scope']){const {a,j}=await setup(t,async args=>{if(args[1]==='status')return ready;throw Object.assign(Error('SECRET diagnostics'),{connectorCode:'permission',permissionKind:kind});});const d=card(a,j);await action(a,d);assert.equal(d.access.stage,kind);assert.equal(d.status,'open');assert.equal(j.status,'needs_input');assert.equal(j.documentGrants[0].target,target);assert.equal(j.documentGrants[0].openId,'fixture-user');assert.equal(a.data.sources.length,0);assert.equal(fs.readFileSync(a.file,'utf8').includes('SECRET'),false);assert.equal(access.tick(a),false);}
});
test('Successful authorization preserves a paused job and unrelated unanswered questions',async t=>{
  const {a,j}=await setup(t);decisions.ask(a,j,{question:'希望交给谁阅读？'});const d=card(a,j);j.status='paused';await action(a,d);assert.equal(j.status,'paused');assert.equal(d.status,'resolved');assert.ok(a.data.decisions.some(d=>d.kind==='question'&&d.status==='open'));
});
test('Stale requests, uncertain side effects and deleted tasks cannot be authorized',async t=>{
  const {a,j}=await setup(t);const d=card(a,j);await assert.rejects(a.dispatch('accessRetry',{id:d.id,revision:'stale'}),/变化/);
  a.data.agentActions.push({id:'uncertain',jobId:j.id,taskId:j.taskIds[0],status:'uncertain'});await assert.rejects(action(a,d),/核对/);a.data.agentActions=[];a.task(j.taskIds[0]).deletedAt=new Date().toISOString();await assert.rejects(action(a,d),/删除|取消/);
});
test('Restart converts the old Lark question without approving or replaying an OAuth session',async t=>{
  const {a,j}=await setup(t);a.data.decisions.push({id:'old-question',jobId:j.id,kind:'question',status:'open',question:'请提供 Lark 授权地址',key:'lark-authorize',taskIds:[...j.taskIds],sourceIds:[],createdAt:new Date().toISOString()});a.save();
  const b=new Assistant({dir:a.dir,connectorRequest:async()=>{throw Error('No CLI allowed at startup');}});const d=b.data.decisions.find(d=>d.kind==='permission');assert.ok(d);assert.equal(d.access.stage,'requested');assert.equal(b.data.decisions.find(d=>d.id==='old-question').status,'superseded');assert.deepEqual(b.data.delegations[0].documentGrants||[],[]);assert.equal(b.accessSessions.size,0);access.cancel(b);
});
test('Cancellation ignores late OAuth success and never wakes paused work',async t=>{
  let finish;const {a,j}=await setup(t,async args=>args[1]==='status'?absent:args.includes('--no-wait')?{verification_url:'https://accounts.feishu.cn/device?code=CANCEL',device_code:'SECRET',expires_in:240}:new Promise(resolve=>finish=resolve));const d=card(a,j);await action(a,d,'accessStart');const s=a.accessSessions.get(d.id);access.opening(a,{id:d.id}).start();await action(a,d,'accessCancel');finish({ok:true});await s.promise;assert.equal(d.access.stage,'deferred');assert.equal(d.status,'open');assert.deepEqual(j.documentGrants||[],[]);assert.equal(access.tick(a),false);
});
test('A model permission failure creates one authorization request and stops the loop',async t=>{
  const {a,j}=await setup(t);a.chat=async()=>({tool:'read_url',args:{url:'https://example.com'}});await agent.run(a,j.id);assert.equal(j.callsUsed,1);assert.equal(j.status,'needs_input');const d=a.data.decisions.find(d=>d.kind==='permission');assert.equal(d.access.kind,'web');assert.equal(j.allowWeb,false);await action(a,d,'accessRetry');assert.equal(j.allowWeb,true);assert.equal(j.status,'ready');
});
test('Changed document versions invalidate finished analysis; unchanged reads do not duplicate sources',async t=>{
  let content='初始正文';const {a,j}=await setup(t,async args=>args[1]==='status'?ready:{ok:true,data:{document:{content,revision_id:content}}});const d=card(a,j);await action(a,d);const task=a.task(j.taskIds[0]),first=j.sourceIds[0];task.needsReplan=null;content='新正文';await agent.act(a,j,'read_lark_document',{url:target});assert.equal(a.data.sources.length,2);assert.equal(a.data.sources[0].previousSourceId,first);assert.match(task.needsReplan,/新内容/);await agent.act(a,j,'read_lark_document',{url:target});assert.equal(a.data.sources.length,2);
});
test('Authorization URL is excluded from export and an expired link requires a fresh session',async t=>{
  const {a,j}=await setup(t,async args=>args[1]==='status'?absent:{verification_url:'https://accounts.feishu.cn/device?code=PRIVATE',device_code:'SECRET',expires_in:240});const d=card(a,j);await action(a,d,'accessStart');const exported=await a.dispatch('export');assert.equal(JSON.stringify(exported).includes('code=PRIVATE'),false);a.accessSessions.get(d.id).expiresAt=0;assert.throws(()=>access.opening(a,{id:d.id}),/失效/);access.tick(a);assert.equal(d.access.stage,'login');assert.deepEqual(j.documentGrants||[],[]);
});

test('missing built-in tool claims are checked locally and resume a text checkpoint without asking the user',async t=>{const {a,j}=await setup(t);const result=await agent.act(a,j,'ask',{question:'应用当前没有提供推进事项或读取稿件的工具，请恢复这些应用工具后重试。',taskIds:[j.taskIds[0]]});assert.ok(result.availableApplicationTools.includes('advance_task'));assert.equal(a.data.decisions.length,0);assert.equal(j.status,'retry');assert.equal(j.autoRecovery.taskId,j.taskIds[0]);assert.equal(j.callsUsed,0);assert.equal(j.allowWeb,false);});
test('saved false tool claims self-correct after restart without changing budgets or manual pauses',async t=>{const {a,j}=await setup(t);const question='应用当前没有提供推进事项或读取稿件的工具，请恢复这些应用工具后重试。';a.data.decisions.push({id:'old-tool-question',kind:'question',jobId:j.id,status:'open',question,taskIds:[j.taskIds[0]],sourceIds:[],createdAt:new Date().toISOString()});j.status='needs_input';a.save();const b=new Assistant({dir:a.dir}),job=b.data.delegations[0];assert.equal(b.data.decisions.find(d=>d.id==='old-tool-question').status,'resolved');assert.equal(job.status,'retry');assert.equal(job.autoRecovery.taskId,j.taskIds[0]);assert.equal(job.callsUsed,0);assert.equal(b.spendLedger.scopes['job:'+j.id]?.limitUSD||100,100);job.status='paused';b.data.decisions.find(d=>d.id==='old-tool-question').status='open';b.save();const c=new Assistant({dir:a.dir});assert.equal(c.data.delegations[0].status,'paused');});
test('tool correction preserves real permissions, user choices, foreign scopes and unavailable external tools',async t=>{const {a,j}=await setup(t);for(const q of ['应用没有提供推进事项的工具，是否要先发布？','应用没有提供读取稿件的工具，需要飞书权限','应用没有提供仓库工具，请连接仓库','应用没有提供推进事项工具，预算是否增加？']){const r=await agent.act(a,j,'ask',{question:q});assert.equal(r.availableApplicationTools,undefined);assert.ok(a.data.decisions.some(d=>d.status==='open'));}await assert.rejects(agent.act(a,j,'ask',{question:'应用没有提供推进事项工具，请恢复。',taskIds:['foreign']}),/本委托/);});

test('Changing the current Lark account blocks the document fetch and keeps the saved source',async t=>{
 let subject='fixture-user',fetches=0;const {a,j}=await setup(t,async args=>args[0]==='auth'?{verified:true,identities:{user:{available:true,status:'ready',openId:subject}}}:(fetches++,document));
 await action(a,card(a,j));assert.equal(fetches,1);subject='another-user';
 const result=await agent.act(a,j,'read_lark_document',{url:target});assert.equal(result.needsAuthorization,true);assert.equal(fetches,1);assert.equal(a.data.sources.length,1);
});
test('Missing authority reauthorizes only the explicit document without reviving old job scopes',async t=>{
 const {a,j}=await setup(t);const policies=require('../desktop/access-policy-store.cjs');fs.unlinkSync(policies.locations(a).store);
 const d=card(a,j);await action(a,d);assert.equal(d.status,'resolved');assert.equal(a.data.sources.length,1);
 assert.equal(policies.checkTool(a,j,'read_lark_document',{url:target}).allowed,true);
 assert.equal(policies.checkTool(a,j,'model_request').allowed,false);assert.equal(policies.checkTool(a,j,'read_url',{url:'https://example.invalid'}).allowed,false);
});
