const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),spend=require('../desktop/spend.cjs');
async function setup(t,chat){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-cost-only-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:1});return a;}
test('More than 40 useful calls automatically continue across batches and share the same dollar ledger',async t=>{
 let n=0;const a=await setup(t,async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});return {tool:'platform_query',args:{queries:[{op:'task',taskId:++n}]}};});
 require('./helpers/platform-fixture.cjs').install(a);
 a.platformRequest=async args=>({id:args[args.indexOf('--task-id')+1],owner:'fixture'});
 await a.dispatch('agentCreate',{goal:'梳理多个任务',dataPlatform:'sg-readonly',maxCalls:5,maxActions:1});await a.runPromise;const j=a.data.delegations[0];j.maxCalls=5; // simulate a legacy record
 for(let i=1;i<45;i++){j.nextRunAt=null;assert.equal(agent.tick(a),true);await a.runPromise;assert.equal(j.status,'ready');}
 assert.equal(n,45);assert.equal(j.callsUsed,45);assert.equal(j.sourceIds.length,45);assert.equal(a.data.agentRuns.length,45);
 const s=a.spendLedger.scopes['job:'+j.id];assert.equal(s.limitUSD,100);assert.equal(s.usage.reportedCalls,45);assert.ok(s.spentUSD<.01);assert.equal(s.heldUSD,0);assert.equal('remainingCalls' in agent.context(a,j).budget,false);
 assert.equal(a.publicState().delegations[0].continuation,null);
});
test('Reserved unknown usage permits continued work with the original cost ledger',async t=>{
 let calls=0;const a=await setup(t,async()=>{calls++;return {tool:'plan_task',args:{key:'draft',title:'原事项',criteria:'交付',steps:[{title:'文稿',kind:'draft'}]}};});await a.dispatch('agentCreate',{goal:'检查中断用量',maxActions:1});await a.runPromise;const j=a.data.delegations[0],s=a.spendLedger.scopes['job:'+j.id];
 assert.equal(j.status,'ready');assert.ok(s.heldUSD>0);const held=s.heldUSD;assert.equal(a.publicState().delegations[0].continuation,null);
 a.chat=async(p,k,m,o)=>{calls++;o.onUsage({inputTokens:100,outputTokens:20});return {tool:'ask',args:{question:'请补充验收标准'}};};
 await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(calls,2);assert.equal(j.status,'needs_input');assert.ok(Math.abs(s.heldUSD-held)<1e-12);assert.equal(s.limitUSD,100);assert.equal(s.approvals.length,0);
});
test('Unreserved historical usage remains actionable without launching empty runs',async t=>{
 const a=await setup(t,async()=>{throw Error('No paid request allowed');}),j=agent.buildJob(a,{goal:'历史消耗'});a.data.delegations.push(j);a.activeAgentJob=j;const s=spend.scope(a);s.usage.unknownCalls=1;s.unreservedCalls=1;a.activeAgentJob=null;
 assert.equal(a.publicState().delegations[0].continuation.kind,'unknown');for(let i=0;i<3;i++)await assert.rejects(a.dispatch('agentRun',{id:j.id}),/原上限内继续/);assert.equal(a.data.agentRuns.length,0);assert.equal(j.callsUsed,0);
});
test('Budget exhaustion and unanswered decisions give actionable errors without pretending to start',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});return {tool:'ask',args:{question:'选择输出格式'}};});await a.dispatch('agentCreate',{goal:'等待选择'});await a.runPromise;const j=a.data.delegations[0],s=a.spendLedger.scopes['job:'+j.id];
 assert.equal(a.publicState().delegations[0].continuation.target,'decisions');await assert.rejects(a.dispatch('agentRun',{id:j.id}),/选择输出格式/);assert.equal(a.data.decisions[0].status,'open');
 s.spentUSD=100;assert.equal(a.publicState().delegations[0].continuation.kind,'budget');await assert.rejects(a.dispatch('agentRun',{id:j.id}),/费用上限/);assert.equal(j.callsUsed,1);
});
test('Legacy count-limited jobs migrate without resetting usage, dollars, manual pauses, questions or approvals',async t=>{
 const a=await setup(t,async()=>({}));const make=(id,status,reason)=>({...agent.buildJob(a,{goal:id}),id,status,limitReason:reason,maxCalls:5,callsUsed:5,summary:'已达到模型调用上限'});
 a.data.delegations=[make('count','limited','job'),make('rule','limited','rule_daily'),make('paused','paused','job'),make('money','limited','spend'),make('question','limited','job'),make('approval','limited','job')];
 a.data.decisions.push({id:'question',jobId:'question',status:'open',kind:'question',question:'需要确认'});a.data.agentActions.push({id:'action',jobId:'approval',status:'pending'});
 const before=JSON.stringify(a.spendLedger);require('../desktop/agent-continuation.cjs').migrate(a);
 assert.deepEqual(a.data.delegations.map(j=>j.status),['ready','ready','paused','limited','needs_input','approval']);assert.ok(a.data.delegations.every(j=>j.callsUsed===5));assert.equal(JSON.stringify(a.spendLedger),before);
});
test('Only isolated evaluation fixtures retain their own sample-size bound, not production jobs',async t=>{
 const parent=await setup(t,async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});return {ok:true};});
 const child=new Assistant({dir:path.join(parent.dir,'isolated'),chat:parent.chat,modelBudgetOwner:parent});child.evaluationCallLimit=2;child.data.providers=structuredClone(parent.data.providers);child.data.settings.roles={...parent.data.settings.roles};child.activeAgentJob=agent.buildJob(child,{goal:'受控验收'});
 const request=()=>child.callModel(child.data.providers[0],'',[{role:'user',content:'fixture'}],{role:'execute'});
 await request();await request();await assert.rejects(request(),e=>e.code==='EVALUATION_LIMIT');assert.equal(parent.data.modelCalls.length,2);assert.equal(child.activeAgentJob.callsUsed,2);
});
test('A cost blocker never offers original-limit continuation when the held and known sum is exhausted',async t=>{
 const a=await setup(t,async()=>({})),j=agent.buildJob(a,{goal:'检查恢复条件'});a.data.delegations.push(j);a.activeAgentJob=j;const s=spend.scope(a);a.activeAgentJob=null;s.usage.unknownCalls=1;s.spentUSD=99;s.heldUSD=1;
 const blocker=a.publicState().delegations[0].continuation;assert.equal(blocker.label,'处理费用额度');assert.match(blocker.message,/追加额度/);assert.doesNotMatch(blocker.message,/原上限内继续/);
 s.usage.unknownCalls=0;s.spentUSD=0;s.heldUSD=0;s.blocked={kind:'pricing',message:'旧配置缺单价'};assert.equal(a.publicState().delegations[0].continuation,null);
});
