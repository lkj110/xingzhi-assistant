const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),access=require('../desktop/access.cjs'),decisions=require('../desktop/decisions.cjs'),writes=require('../desktop/agent-writes.cjs'),lark=require('../desktop/lark-connector.cjs');
const url='https://test.feishu.cn/docx/TestDocument123',body='# 交接说明\n\n请查看 [来源](https://example.com)；负责人：测试人。',scope=access.scopes('my_library').join(' ');
const ready=()=>({verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'ou_fixture',userName:'测试人',scope}}});
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-lark-write-'));const calls=[],state={identity:ready(),body};
 const run=async(args,options={})=>{calls.push({args,options});if(args[1]==='status')return state.identity;if(args[1]==='+create'){if(state.rejected)throw Object.assign(Error('explicit denial'),{connectorCode:'permission',permissionKind:'resource'});if(state.createError)throw Error('network failed after submission');return {ok:true,data:{document:{document_id:'TestDocument123',url:state.url||url}}};}if(args[1]==='+update'){if(state.updateError){state.body=options.input;throw Error('update transport ended');}state.body=options.input;state.revision=2;return {ok:true,data:{result:state.partial?'partial_success':'success',document:{document_id:'TestDocument123',revision_id:2}}};}if(args[1]==='+fetch'){if(state.readError)throw Error('readback unavailable');return {ok:true,data:{document:{content:state.body,revision_id:state.revision||1}}};}if(args.includes('--no-wait'))return {verification_url:'https://accounts.feishu.cn/device?code=FIXTURE',device_code:'SECRET',expires_in:240};if(args.includes('--device-code')){state.identity=ready();return {ok:true};}throw Error('Unexpected operation');};
 const a=new Assistant({dir,connectorRequest:run,chat:async()=>{throw Error('No model calls in connector tests');}});t.after(()=>{access.cancel(a);fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid'});
 const j=agent.buildJob(a,{goal:'将已保存的交接说明创建为飞书文档',fileMode:'off'});a.data.delegations.push(j);
 const {taskId}=await agent.act(a,j,'plan_task',{key:'handover',title:'交接说明',criteria:'创建文档，核对正文与链接',steps:[{key:'draft',kind:'draft',title:'稿件'},{key:'publish',kind:'external',tool:'lark_create',title:'飞书交付'}]});const task=a.task(taskId);task.steps[0].done=true;task.steps[0].artifactId='draft1';a.data.artifacts.push({id:'draft1',taskId,title:task.title,content:body,createdAt:new Date().toISOString()});a.save();
 const authorize=async(target='my_library')=>{const r=access.request(a,j,{kind:'lark_create',target,reason:'需要交付'}),d=a.data.decisions.find(d=>d.id===r.decisionId);await a.dispatch('accessRetry',{id:d.id,revision:decisions.revision(a.data,d)});await a.runPromise;return d;};
 const prepare=()=>writes.prepare(a,j,'lark_create',{taskId});
 return {a,j,task,state,calls,run,authorize,prepare};
}
function approve(f,r){r.approvedAt=new Date().toISOString();require('../desktop/protocol-access.cjs').authorizeAction(f.a,r,'fixture_explicit_action');f.a.save();}
const creates=f=>f.calls.filter(c=>c.args[1]==='+create');
const setPolicy=(f,mode='auto',extra={})=>f.a.dispatch('agentLarkCreatePolicy',{id:f.j.id,taskId:f.task.id,mode,target:f.j.larkCreateGrant?.target,openId:f.j.larkCreateGrant?.openId,...extra});

test('Explicit task policy creates without another approval and persists the scoped authorization receipt',async t=>{
 const f=await setup(t);await f.authorize();await setPolicy(f);
 assert.equal(writes.mode(f.j,'lark_create',f.task.id),'auto');
 assert.equal(writes.mode(f.j,'lark_create','another-task'),'ask');
 const result=await agent.act(f.a,f.j,'lark_create',{taskId:f.task.id});
 assert.equal(result.url,url);assert.equal(creates(f).length,1);
 const r=f.a.data.agentActions.find(r=>r.tool==='lark_create');
 assert.equal(r.approvedAt,undefined);assert.equal(r.authorization.kind,'task_policy');
 assert.equal(r.authorization.taskId,f.task.id);assert.equal(r.authorization.openId,'ou_fixture');
 assert.equal(f.task.steps[1].done,true);
 await agent.act(f.a,f.j,'lark_create',{taskId:f.task.id});assert.equal(creates(f).length,1);
 const b=new Assistant({dir:f.a.dir,connectorRequest:f.run});
 assert.equal(writes.mode(b.data.delegations[0],'lark_create',f.task.id),'auto');access.cancel(b);
});
test('Automatic task creation never bypasses a changed account, destination or missing scope',async t=>{
 for(const change of ['target','identity','scope']){
  const f=await setup(t);await f.authorize();await setPolicy(f);const r=await f.prepare();
  if(change==='target'){f.j.larkCreateGrant.target='folder:Folder123';assert.equal(writes.mode(f.j,'lark_create',f.task.id),'ask');}
  if(change==='identity')f.state.identity.identities.user.openId='ou_other';
  if(change==='scope')f.state.identity.identities.user.scope='docx:document:readonly';
  await assert.rejects(writes.execute(f.a,f.j,r));assert.equal(creates(f).length,0);
 }
});
test('Task policy can revoke automatic creation and cannot be set with stale displayed authorization',async t=>{
 const f=await setup(t);await f.authorize();
 await assert.rejects(setPolicy(f,'auto',{target:'folder:Other123'}),/已变化/);
 await assert.rejects(setPolicy(f,'auto',{openId:'ou_other'}),/已变化/);
 await setPolicy(f);const r=await f.prepare();await setPolicy(f,'ask');
 await assert.rejects(writes.execute(f.a,f.j,r),/确认此具体写入/);assert.equal(creates(f).length,0);
});
test('Changing creation policy keeps unrelated questions and paused work intact',async t=>{
 const f=await setup(t);await f.authorize();
 const q=decisions.ask(f.a,f.j,{question:'哪份附件需要保留？',taskIds:[f.task.id]});f.j.status='paused';
 await setPolicy(f);assert.equal(f.j.status,'paused');
 assert.equal(f.a.data.decisions.find(d=>d.id===q.decisionId).status,'open');
 assert.equal(creates(f).length,0);
});
test('A concrete pending Lark action can resume using task authorization',async t=>{
 const f=await setup(t);await f.authorize();
 const result=await agent.act(f.a,f.j,'lark_create',{taskId:f.task.id});
 assert.equal(result.waitingForApproval,true);assert.equal(f.j.status,'approval');
 await setPolicy(f);assert.equal(f.j.status,'ready');
 assert.equal(decisions.cards(f.a.data).filter(d=>d.kind==='approval').length,0);
 const r=f.a.data.agentActions.find(r=>r.id===f.j.pendingActionId);
 await writes.execute(f.a,f.j,r);assert.equal(creates(f).length,1);
});
test('Automatic creation preserves uncertain-result reconciliation without duplicate writes',async t=>{
 const f=await setup(t);await f.authorize();await setPolicy(f);f.state.readError=true;
 const r=await f.prepare();await assert.rejects(writes.execute(f.a,f.j,r));
 assert.equal(r.status,'uncertain');await assert.rejects(setPolicy(f),/核对外部动作/);
 f.state.readError=false;
 const b=new Assistant({dir:f.a.dir,connectorRequest:f.run}),j=b.data.delegations[0];
 await writes.execute(b,j,b.data.agentActions.find(x=>x.id===r.id));
 assert.equal(creates(f).length,1);access.cancel(b);
});
test('Model supplied policy fields cannot authorize creation',async t=>{
 const f=await setup(t);await f.authorize();
 await agent.act(f.a,f.j,'plan_task',{key:'handover',title:f.task.title,criteria:f.task.criteria,reason:'draft kept',larkCreatePolicies:[{taskId:f.task.id,mode:'auto',openId:'ou_fixture',target:'my_library',approvedAt:'yes'}]});
 assert.equal(writes.mode(f.j,'lark_create',f.task.id),'ask');
 await assert.rejects(agent.act(f.a,f.j,'agentLarkCreatePolicy',{taskId:f.task.id,mode:'auto'}));
});
test('Initial user authorization can include task-scoped automatic creation without a second approval',async t=>{
 const f=await setup(t),r=access.request(f.a,f.j,{kind:'lark_create',target:'my_library',reason:'创建交接文档'}),d=f.a.data.decisions.find(d=>d.id===r.decisionId);
 await f.a.dispatch('accessRetry',{id:d.id,revision:decisions.revision(f.a.data,d),createMode:'auto'});await f.a.runPromise;
 assert.equal(d.status,'resolved');assert.equal(writes.mode(f.j,'lark_create',f.task.id),'auto');
 assert.equal(writes.mode(f.j,'lark_create','future-task'),'ask');assert.equal(creates(f).length,0);
 assert.equal(agent.context(f.a,f.j).permissions.larkCreate.taskModes[f.task.id],'auto');
});
test('The scheduler executes an already prepared action after task authorization, without an extra approval',async t=>{
 const f=await setup(t);await f.authorize();await agent.act(f.a,f.j,'lark_create',{taskId:f.task.id});await setPolicy(f);
 f.a.chat=async()=>({tool:'ask',args:{question:'测试：保留哪份附件？'},reason:'fixture'});
 await agent.run(f.a,f.j.id);
 assert.equal(creates(f).length,1);assert.equal(f.j.pendingActionId,null);
 assert.equal(f.task.steps[1].done,true);
});
test('Restoring a workspace drops automatic creation policies while retaining creation receipts',async t=>{
 const f=await setup(t);await f.authorize();await setPolicy(f);
 await agent.act(f.a,f.j,'lark_create',{taskId:f.task.id});
 require('../desktop/recovery.cjs').pause(f.a.data);
 assert.equal(writes.mode(f.j,'lark_create',f.task.id),'ask');assert.equal(f.j.status,'paused');
 assert.equal(f.a.data.agentActions.find(r=>r.tool==='lark_create').result.url,url);
});
test('Creation requests authorize first; verifying identity does not publish or spend',async t=>{const f=await setup(t),{a,j,task}=f;const result=await agent.act(a,j,'lark_create',{taskId:task.id});assert.equal(result.kind,'lark_create');assert.equal(f.calls.length,0);const before=JSON.stringify(a.spendLedger);const d=await f.authorize();assert.equal(d.status,'resolved');assert.equal(j.larkCreateGrant.target,'my_library');assert.equal(j.larkCreateGrant.openId,'ou_fixture');assert.equal(creates(f).length,0);assert.equal(JSON.stringify(a.spendLedger),before);const r=await f.prepare();assert.equal(r.status,'pending');await assert.rejects(writes.execute(a,j,r),/确认此具体写入/);assert.equal(creates(f).length,0);});
test('Creation imports exactly the approved draft through stdin, returns a verified real link and readback source',async t=>{const f=await setup(t),{a,j,task}=f;await f.authorize();const r=await f.prepare();approve(f,r);const result=await writes.execute(a,j,r);assert.equal(result.url,url);assert.equal(result.verified,true);assert.equal(result.contentVerified,false);assert.equal(a.data.sources.find(s=>s.id===result.sourceId).content,body);assert.equal(task.steps[1].done,true);assert.equal(creates(f).length,1);const call=creates(f)[0];assert.equal(call.options.input,body);assert.ok(!call.args.includes(body));assert.ok(call.args.includes('my_library'));assert.equal((await f.prepare()).id,r.id);await writes.verifyDelivery(a,j,task);assert.equal(creates(f).length,1);assert.ok(!f.calls.some(c=>c.args.includes('permissions')));});
test('Changed draft, target or user invalidates the prior write confirmation',async t=>{for(const changed of ['draft','target','user']){const f=await setup(t);await f.authorize();const r=await f.prepare();approve(f,r);if(changed==='draft')f.a.data.artifacts[0].content+=' revised';if(changed==='target')f.j.larkCreateGrant.target='folder:Folder123';if(changed==='user')f.state.identity.identities.user.openId='ou_other';await assert.rejects(writes.execute(f.a,f.j,r));assert.equal(creates(f).length,0);}});
test('Missing create scopes expose a real official OAuth session and do not grant on mere intent',async t=>{const f=await setup(t);f.state.identity.identities.user.scope='docx:document:readonly';const d=await f.authorize();assert.equal(d.access.stage,'scope');assert.equal(f.j.larkCreateGrant,undefined);await f.a.dispatch('accessStart',{id:d.id,revision:decisions.revision(f.a.data,d)});await f.a.runPromise;assert.equal(d.access.stage,'waiting_login');const auth=f.calls.find(c=>c.args.includes('--no-wait'));assert.equal(auth.args[auth.args.indexOf('--scope')+1],scope);assert.equal(f.a.publicState().accessSessions[0].url,'https://accounts.feishu.cn/device?code=FIXTURE');assert.ok(!fs.readFileSync(f.a.file,'utf8').includes('SECRET'));const s=f.a.accessSessions.get(d.id);access.opening(f.a,{id:d.id}).start();await s.promise;access.tick(f.a);await f.a.runPromise;assert.equal(d.status,'resolved');assert.equal(creates(f).length,0);});
test('Verified needs_refresh identity is usable; unverified refresh state is not',async()=>{const value=ready();value.identities.user.status='needs_refresh';assert.equal((await lark.status(async()=>value)).loggedIn,true);value.identities.user.verified=false;assert.equal((await lark.status(async()=>value)).loggedIn,false);});
test('Generic create authorization and questions migrate without fabricating grants or links',async t=>{const f=await setup(t);const d={id:'legacy',jobId:f.j.id,kind:'permission',status:'open',taskIds:[f.task.id],sourceIds:[],access:{kind:'external',target:'在用户的飞书空间创建交接文档，并生成文档链接',reason:'尚未接入创建工具'}};f.a.data.decisions.push(d);f.a.save();const b=new Assistant({dir:f.a.dir,connectorRequest:async()=>{throw Error('no network on restart');}});assert.equal(b.data.decisions.find(x=>x.id==='legacy').access.kind,'lark_create');assert.equal(b.data.delegations[0].larkCreateGrant,undefined);assert.equal(b.accessSessions.size,0);f.j.urls=[url];const r=access.fromQuestion(f.a,f.j,{question:'需要授权在飞书创建文档'});assert.equal(r.kind,'lark_create');access.cancel(b);});
test('Uncertain submission never creates a second document during retry',async t=>{const f=await setup(t);await f.authorize();const r=await f.prepare();approve(f,r);f.state.createError=true;await assert.rejects(writes.execute(f.a,f.j,r));assert.equal(r.status,'uncertain');await assert.rejects(writes.execute(f.a,f.j,r),/没有返回链接/);assert.equal(creates(f).length,1);assert.equal((await f.prepare()).id,r.id);});
test('Readback failure persists the real receipt and recovers with reads only after restart',async t=>{const f=await setup(t);await f.authorize();const r=await f.prepare();approve(f,r);f.state.readError=true;await assert.rejects(writes.execute(f.a,f.j,r));assert.equal(r.status,'uncertain');assert.equal(r.result.url,url);f.state.readError=false;const b=new Assistant({dir:f.a.dir,connectorRequest:f.run});const j=b.data.delegations[0],record=b.data.agentActions.find(x=>x.id===r.id);const result=await writes.execute(b,j,record);assert.equal(result.verified,true);assert.equal(record.status,'done');assert.equal(creates(f).length,1);access.cancel(b);});
test('Untrusted receipt URL remains uncertain; remotely changed content cannot pass delivery checking',async t=>{for(const bad of [true,false]){const f=await setup(t);await f.authorize();const r=await f.prepare();approve(f,r);if(bad){f.state.url='https://evil.invalid/docx/TestDocument123';await assert.rejects(writes.execute(f.a,f.j,r));assert.equal(r.status,'uncertain');assert.equal(r.result,undefined);}else{await writes.execute(f.a,f.j,r);f.state.body='Remote human edit';await assert.rejects(writes.verifyDelivery(f.a,f.j,f.task),/已变化/);}assert.equal(creates(f).length,1);}});
test('Folder destination stays exact and must be approved before sending',async t=>{const f=await setup(t);await f.authorize('folder:Folder123');const r=await f.prepare();approve(f,r);await writes.execute(f.a,f.j,r);assert.ok(creates(f)[0].args.includes('--parent-token'));assert.ok(creates(f)[0].args.includes('Folder123'));assert.ok(!creates(f)[0].args.includes('my_library'));});

test('An explicit create permission denial opens a specific actionable permission request',async t=>{const f=await setup(t);await f.authorize();const r=await f.prepare();approve(f,r);f.state.rejected=true;let caught;try{await writes.execute(f.a,f.j,r);}catch(e){caught=e;}assert.equal(r.status,'failed');const result=access.recover(f.a,f.j,'lark_create',{},caught);const d=f.a.data.decisions.find(d=>d.id===result.decisionId);assert.equal(d.access.kind,'lark_create');assert.equal(d.access.stage,'resource');assert.match(d.access.message,/文件夹所有者/);assert.equal(creates(f).length,1);});
async function revision(f){await f.authorize();await setPolicy(f,'auto',{allowUpdate:true});await agent.act(f.a,f.j,'lark_create',{taskId:f.task.id});const step=f.task.steps[0];f.a.data.artifacts.push({id:'draft2',taskId:f.task.id,stepId:step.id,title:'修订主稿',content:body+'\n\n修订说明'});step.artifactId='draft2';f.task.steps[1]={...f.task.steps[1],tool:'lark_update',done:false};delete f.task.steps[1].evidence;f.a.requeue(f.task);f.a.save();}
test('Updates use the same created document with exact revision and separate scoped policy, never duplicate creation',async t=>{const f=await setup(t);await revision(f);assert.equal(writes.mode(f.j,'lark_update',f.task.id),'auto');const result=await agent.act(f.a,f.j,'lark_update',{taskId:f.task.id});assert.equal(result.url,url);assert.equal(creates(f).length,1);const calls=f.calls.filter(c=>c.args[1]==='+update');assert.equal(calls.length,1);assert.equal(calls[0].args[calls[0].args.indexOf('--revision-id')+1],'1');assert.equal(calls[0].options.input,body+'\n\n修订说明');assert.equal(f.task.steps[1].done,true);const ctx=f.a.context(f.task,{verification:true});assert.match(ctx.deliveryEvidence.find(r=>r.tool==='lark_update').readback.content,/修订说明/);await writes.verifyDelivery(f.a,f.j,f.task);await assert.rejects(writes.prepare(f.a,f.j,'lark_create',{taskId:f.task.id}),/lark_update/);});
test('Updating foreign URLs and edited or embedded original documents is rejected before submission',async t=>{for(const mutation of ['foreign','human','revision','embedded']){const f=await setup(t);await revision(f);if(mutation==='foreign'){await assert.rejects(writes.prepare(f.a,f.j,'lark_update',{taskId:f.task.id,url:'https://test.feishu.cn/docx/OtherDocument'}),/只能更新/);}else{const r=await writes.prepare(f.a,f.j,'lark_update',{taskId:f.task.id});if(mutation==='human')f.state.body+=' human change';if(mutation==='revision')f.state.revision=3;if(mutation==='embedded')f.state.body+=' ![image](x)';await assert.rejects(writes.execute(f.a,f.j,r));assert.equal(r.status,'failed');}assert.equal(f.calls.filter(c=>c.args[1]==='+update').length,0);}});
test('Creation policy alone cannot authorize automatic update; revocation invalidates an unsent update',async t=>{const f=await setup(t);await revision(f);await setPolicy(f);assert.equal(writes.mode(f.j,'lark_update',f.task.id),'ask');const result=await agent.act(f.a,f.j,'lark_update',{taskId:f.task.id});assert.equal(result.waitingForApproval,true);assert.equal(f.calls.filter(c=>c.args[1]==='+update').length,0);});
test('An interrupted update reconciles the actual body after restart without submitting twice',async t=>{const f=await setup(t);await revision(f);const r=await writes.prepare(f.a,f.j,'lark_update',{taskId:f.task.id});f.state.updateError=true;await assert.rejects(writes.execute(f.a,f.j,r));assert.equal(r.status,'uncertain');const b=new Assistant({dir:f.a.dir,connectorRequest:f.run}),j=b.data.delegations[0];await writes.execute(b,j,b.data.agentActions.find(x=>x.id===r.id));assert.equal(f.calls.filter(c=>c.args[1]==='+update').length,1);access.cancel(b);});
test('Partial update cannot be treated as a successful delivery without readback proving exact intended body',async t=>{const f=await setup(t);await revision(f);const r=await writes.prepare(f.a,f.j,'lark_update',{taskId:f.task.id});f.state.partial=true;await assert.rejects(writes.execute(f.a,f.j,r),/完整成功/);f.state.body='only a fragment';await assert.rejects(writes.execute(f.a,f.j,r),/无法精确证明/);assert.equal(r.status,'uncertain');assert.equal(f.calls.filter(c=>c.args[1]==='+update').length,1);});
