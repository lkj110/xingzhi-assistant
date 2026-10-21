'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),local=require('../desktop/agent-local.cjs'),writes=require('../desktop/agent-writes.cjs');
const ui=(a,action,input)=>a.dispatch('uiCommand',{action,input});
async function setup(t,tool,args={},mode='auto'){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-agent-local-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const queue=[ctx=>({tool:'plan_task',args:{key:'tool',title:'真实工具验收',description:'使用新增工具产出',criteria:'存在可验证的交付回执',sourceIds:[],steps:[{key:'execute',title:'执行实际工具',kind:'external',tool}]}}),ctx=>({tool,args:{taskId:ctx.tasks[0].id,...args}}),()=>({tool:'ask',args:{key:'test-finish',question:'测试停靠'}})];
 const chat=async(p,k,m)=>{if(m[0].content.includes('动作格式')){const f=queue.shift();if(!f)throw Error('测试动作已用完');return f(JSON.parse(m[1].content));}return {passed:true,summary:'工具结果满足测试条件',gaps:[]};};
 const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{name:'fixture',baseUrl:'https://example.com/v1',model:'fixture',inputPrice:0,outputPrice:0});
 const output=path.join(dir,'output');fs.mkdirSync(output);a.data.agentSettings.outputFolder=output;a.save();
 const localTools=Object.fromEntries(['codeMode','draftMode','mediaMode','mailMode','deployMode'].map(k=>[k,mode]));
 return {a,queue,output,dir,chat,create:async(extra={})=>{await a.dispatch('agentCreate',{goal:'执行工具并保留结果',folderIds:[],allowWeb:false,useOutputFolder:true,fileMode:'off',localTools,maxActions:3,autoAccept:false,...extra});await a.runPromise;return a.data.delegations[0];}};
}
test('Agent plans and automatically executes real JavaScript and persists hashed outputs',async t=>{
 const {a,create,dir}=await setup(t,'run_code',{language:'javascript',code:'require("fs").writeFileSync("结果.txt","自动调用 7200");console.log("真实执行");'});const j=await create();
 const r=a.data.agentActions[0];assert.ok(r,j.lastError);assert.equal(r.status,'done',r.error||j.lastError);assert.equal(a.task(j.taskIds[0]).steps[0].done,true);assert.match(r.result.stdout,/真实执行/);assert.equal(fs.readFileSync(path.join(r.outputFolder,'结果.txt'),'utf8'),'自动调用 7200');assert.ok(r.result.files.length>=2);
 const file=r.result.files.find(f=>path.basename(f.path)==='结果.txt');assert.equal(file.sha256,require('node:crypto').createHash('sha256').update(Buffer.from('自动调用 7200')).digest('hex'));
 const restored=new Assistant({dir});assert.equal(restored.data.agentActions[0].status,'done');local.verify(restored.data.agentActions[0]);
 const task=a.task(r.taskId),context=a.context(task,{verification:true}),receipt=context.deliveryEvidence.find(v=>v.actionId===r.id);assert.equal(receipt.current,true);assert.ok(receipt.readback.some(v=>v.filename==='结果.txt'&&v.content==='自动调用 7200'));assert.ok(require('../desktop/revision-protocol.cjs').snapshot(a,task).receipts.some(v=>v.actionId===r.id));
 fs.writeFileSync(path.join(r.outputFolder,'结果.txt'),'changed');assert.throws(()=>local.verify(r),/改变/);
 assert.throws(()=>a.context(task,{verification:true}),/改变/);
});
test('Agent draft tool creates an unsent email without network access',async t=>{const {a,create}=await setup(t,'mail_draft',{to:'test@example.com',subject:'验收',body:'仅本地草稿'});a.localExternalRequest=()=>{throw Error('Must not send');};const j=await create(),r=a.data.agentActions[0];assert.equal(r?.status,'done',j.lastError);assert.equal(r.result.sent,false);assert.match(fs.readFileSync(r.result.path,'utf8'),/X-Unsent: 1/);});

test('Image call rejected by the call budget releases its unsubmitted spend reservation',async t=>{
 const {a,create}=await setup(t,'generate_image',{prompt:'a test circle'});await a.dispatch('saveProvider',{name:'image fixture',type:'codex',model:'fixture',inputPrice:0,outputPrice:0});
 const charge=agent.chargeCall;t.mock.method(agent,'chargeCall',(a,options)=>{if(options?.persist===false)return charge(a,options);throw Error('Call budget exhausted');});let called=false;t.mock.method(require('../desktop/local-media.cjs'),'image',async()=>{called=true;throw Error('Must not submit');});
 await create();assert.equal(called,false);assert.equal(a.data.agentActions[0]?.status,'failed');for(const s of Object.values(a.spendLedger.scopes))assert.equal(Object.keys(s.pending||{}).length,0);
});

test('Verification reads the actual EML and excludes superseded tool receipts from its snapshot',async t=>{
 const {a,create}=await setup(t,'mail_draft',{to:'test@example.com',subject:'真实主题',body:'真实正文 5050'}),j=await create(),r=a.data.agentActions[0],task=a.task(r.taskId),context=a.context(task,{verification:true});const receipt=context.deliveryEvidence.find(v=>v.actionId===r.id);
 assert.equal(receipt.current,true);assert.deepEqual(receipt.readback[0].mail,{to:'test@example.com',subject:'真实主题',body:'真实正文 5050',unsent:true});const snap=require('../desktop/revision-protocol.cjs').snapshot(a,task);assert.equal(snap.receipts.length,1);
 task.steps[0].done=false;assert.equal(local.current(a,task,r),false);assert.equal(require('../desktop/revision-protocol.cjs').snapshot(a,task).receipts.length,0);assert.notEqual(require('../desktop/revision-protocol.cjs').snapshot(a,task).id,snap.id);
 assert.equal(local.current(a,{...task,agentJobId:'another-job'},r),false);
});

test('Local result reading pages real content and rejects cross-task, traversal and modified outputs',async t=>{
 const {a,create}=await setup(t,'run_code',{language:'javascript',code:'require("fs").writeFileSync("结果.txt","测".repeat(17000));'}),j=await create(),r=a.data.agentActions[0];assert.equal(r?.status,'done',j.lastError);
 const args={taskId:r.taskId,actionId:r.id,filename:'结果.txt'},first=local.read(a,j,args),second=local.read(a,j,{...args,start:first.next});assert.equal(first.content.length,16000);assert.equal(first.next,16000);assert.equal(second.content.length,1000);assert.equal(second.next,null);
 assert.throws(()=>local.read(a,{...j,taskIds:[]},args),/不属于/);assert.throws(()=>local.read(a,j,{...args,filename:'../结果.txt'}),/不在/);assert.throws(()=>local.read(a,j,{...args,start:-1}),/分页/);
 fs.writeFileSync(path.join(r.outputFolder,'结果.txt'),'tampered');assert.throws(()=>local.read(a,j,args),/改变/);
});
test('Code approval survives restart and executes the exact reviewed version once',async t=>{
 const {a,create,dir,chat}=await setup(t,'run_code',{language:'javascript',code:'console.log("approved-once")'},'ask');const j=await create(),r=a.data.agentActions[0];assert.equal(j.status,'approval',j.lastError);assert.equal(r.status,'pending');assert.ok(!r.outputFolder);await ui(a,'agentApprove',{id:j.id,actionId:r.id,version:r.version});
 const restored=new Assistant({dir,chat});await restored.dispatch('agentRun',{id:j.id});await restored.runPromise;const done=restored.data.agentActions[0];assert.equal(done.status,'done',done.error||restored.data.delegations[0].lastError);assert.match(done.result.stdout,/approved-once/);assert.equal(fs.readdirSync(restored.data.agentSettings.outputFolder).length,1);
});
test('Unknown tools, cross-task access, off modes and untrusted permission changes are denied',async t=>{
 const {a,create}=await setup(t,'mail_draft',{to:'test@example.com',subject:'s',body:'b'},'off');const j=await create();assert.equal(a.data.agentActions.length,0);await assert.rejects(a.dispatch('agentLocalSettings',{id:j.id,localTools:{codeMode:'auto'}}),/界面/);
 await assert.rejects(agent.act(a,j,'run_code',{taskId:'missing',language:'javascript',code:'console.log(1)'}));assert.throws(()=>require('../desktop/tool-registry.cjs').get('shell_anything'),/未声明/);
});
test('Changing reviewed permissions invalidates the pending approval',async t=>{const {a,create}=await setup(t,'run_code',{language:'javascript',code:'console.log(1)'},'ask');const j=await create(),r=a.data.agentActions[0];await ui(a,'agentLocalSettings',{id:j.id,localTools:{codeMode:'off'}});assert.equal(r.status,'stale');assert.equal(j.pendingActionId,null);await assert.rejects(ui(a,'agentApprove',{id:j.id,actionId:r.id,version:r.version}),/失效|没有/);});
test('Outlook Agent send prepares exact preview and sends only after approval',async t=>{
 const {a,create}=await setup(t,'send_mail',{connectorId:'mail',to:'test@example.com',subject:'明确主题',body:'明确正文'},'ask');a.data.connectors.push({id:'mail',provider:'outlook',projectId:null,enabled:true,allowSend:true,name:'测试邮箱',sealedToken:await a.vault.seal('fixture-token')});a.save();let posts=0;a.localExternalRequest=async(url,o)=>{posts++;assert.match(url,/graph.microsoft.com/);assert.equal(JSON.parse(o.body).message.subject,'明确主题');return {status:202};};const j=await create(),r=a.data.agentActions[0];assert.equal(j.status,'approval',j.lastError);assert.equal(posts,0);assert.match(r.content,/明确正文/);await ui(a,'agentApprove',{id:j.id,actionId:r.id,version:r.version});await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(posts,1);assert.equal(r.status,'done',r.error||j.lastError);assert.equal(r.result.status,'accepted');assert.match(r.result.message,/不代表/);
});
test('Ambiguous network result blocks retries and a replacement plan',async t=>{
 const {a,create}=await setup(t,'github_deploy',{workflow:'deploy.yml',ref:'main'},'ask');await a.dispatch('agentSettings',{githubRepo:'acme/test',githubToken:'fixture'});let posts=0;a.localExternalRequest=async()=>{posts++;throw Error('timeout');};const j=await create({useGithub:true,githubMode:'off'}),r=a.data.agentActions[0];assert.equal(j.status,'approval',j.lastError);await ui(a,'agentApprove',{id:j.id,actionId:r.id,version:r.version});await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(r.status,'uncertain',r.error);assert.equal(posts,1);await assert.rejects(writes.execute(a,j,r),/核清/);await assert.rejects(local.prepare(a,j,'github_deploy',{taskId:r.taskId,workflow:'different.yml',ref:'main'}),/核清/);assert.equal(posts,1);
});
test('Code process failure is recorded without marking the task step complete',async t=>{const {a,create}=await setup(t,'run_code',{language:'javascript',code:'process.exit(7)'});const j=await create(),r=a.data.agentActions[0];assert.equal(r.status,'failed',j.lastError);assert.equal(r.result.exitCode,7);assert.equal(a.task(j.taskIds[0]).steps[0].done,false);});
test('Agent autonomously executes Python and completes task and goal verification',async t=>{const {a,create,queue}=await setup(t,'run_code',{language:'python',code:'from pathlib import Path\nPath("answer.txt").write_text(str(17*23),encoding="utf-8")\nprint(17*23)'});queue.pop();queue.push(ctx=>({tool:'advance_task',args:{taskId:ctx.tasks[0].id}}),()=>({tool:'complete',args:{summary:'实际文件已核对'}}));const j=await create({autoAccept:true,maxActions:5});assert.equal(a.data.agentActions[0]?.status,'done',j.lastError);assert.equal(j.status,'completed',j.lastError||JSON.stringify(a.task(j.taskIds[0])));assert.equal(fs.readFileSync(path.join(a.data.agentActions[0].outputFolder,'answer.txt'),'utf8'),'391');});
test('Agent invokes Windows speech and validates actual WAV bytes',{skip:process.platform!=='win32'},async t=>{const {a,create}=await setup(t,'synthesize_speech',{text:'行知助手，自动语音测试。'});const j=await create(),r=a.data.agentActions[0];assert.equal(r?.status,'done',j.lastError||r?.error);assert.equal(fs.readFileSync(r.result.file).toString('ascii',8,12),'WAVE');});
