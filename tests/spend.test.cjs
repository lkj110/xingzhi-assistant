const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant,modelChat}=require('../desktop/core.cjs'),spend=require('../desktop/spend.cjs'),agent=require('../desktop/agent.cjs'),errors=require('../desktop/model-errors.cjs'),recovery=require('../desktop/recovery.cjs');
async function setup(t,chat){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-spend-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{name:'测试计价模型',model:'priced',baseUrl:'https://fixture.invalid/v1',inputPrice:1,cachedInputPrice:.1,outputPrice:1});return a;}
function task(a){const t=a.createTask({title:'交付',generationMode:'single',steps:[{title:'报告',kind:'draft'}]});a.activeSpendTask=t;return t;}
const request=a=>a.callModel(a.data.providers[0],'',[{role:'user',content:'input'}],{role:'execute',stage:'task_work'});
const summary=a=>spend.summaries(a).scopes[0];
const report=(o,inputTokens=100,outputTokens=20,cachedInputTokens=0)=>o.onUsage?.({inputTokens,outputTokens,cachedInputTokens});
const approve=(a,extra={})=>{const s=summary(a);return a.dispatch('approveSpend',{id:s.id,revision:s.revision,confirmed:true,additionalUSD:100,...extra});};

test('Pricing uses separate cached rates and the full-request long-context threshold',()=>{
 const p=spend.pricing({type:'codex',model:'gpt-6.1-sol'}),u=spend.usage({inputTokens:300000,cachedInputTokens:200000,outputTokens:1000});
 assert.equal(spend.cost(u,p),.455);assert.equal(spend.cost(spend.usage({inputTokens:272000,outputTokens:1000}),p),.554);
 assert.equal(spend.pricing({type:'openai',baseUrl:'https://proxy.invalid',model:'gpt-6.1-sol'}),null);
 assert.equal(spend.pricing({type:'codex',model:'unknown'}),null);
 assert.equal(spend.pricing({type:'ollama',model:'local'}).output,0);
 assert.equal(spend.cost(spend.usage({inputTokens:1000,cacheWriteTokens:500,outputTokens:0}),p),.00225);
 for(const invalid of [{inputTokens:-1,outputTokens:0},{inputTokens:1,outputTokens:NaN},{inputTokens:1,outputTokens:0,cachedInputTokens:2}])assert.equal(spend.usage(invalid),null);
});
test('Every paid request records exact reported tokens, price snapshot and settled cost',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{report(o,1000,200,500);return {ok:true};});task(a);await request(a);
 const r=a.data.modelCalls[0],s=summary(a);assert.equal(r.totalTokens,1200);assert.equal(r.cachedInputTokens,500);assert.equal(s.spentUSD,.00075);assert.equal(s.heldUSD,0);assert.equal(s.limitUSD,100);assert.equal(s.usage.reportedCalls,1);
 await a.dispatch('saveProvider',{...a.data.providers[0],inputPrice:20});assert.equal(r.pricing.input,1);assert.equal(summary(a).spentUSD,.00075);
});
test('Unknown price blocks before sending or consuming a call, then configuration allows retry',async t=>{
 let calls=0;const a=await setup(t,async(p,k,m,o)=>{calls++;report(o);return {};});task(a);a.data.providers[0].inputPrice=null;a.data.providers[0].outputPrice=null;
 await assert.rejects(request(a),e=>e.spendKind==='pricing');assert.equal(calls,0);assert.equal(a.publicState().stewardshipStatus.used,0);
 await assert.rejects(approve(a),/配置模型单价/);
 a.data.providers[0].inputPrice=1;a.data.providers[0].outputPrice=1;await request(a);assert.equal(calls,1);
});
test('Admission reserves the next call and requires explicit, fresh, non-replayable approval',async t=>{
 let calls=0;const a=await setup(t,async(p,k,m,o)=>{calls++;report(o,99950000,0);return {};});task(a);await request(a);await assert.rejects(request(a),e=>e.spendKind==='budget');assert.equal(calls,1);
 const s=summary(a),input={id:s.id,revision:s.revision,confirmed:true,additionalUSD:100};
 await assert.rejects(a.dispatch('approveSpend',{...input,confirmed:false}),/人工/);
 await assert.rejects(a.dispatch('approveSpend',{...input,additionalUSD:1000}),/100/);
 await a.dispatch('approveSpend',input);assert.equal(summary(a).limitUSD,200);assert.equal(summary(a).spentUSD,99.95);
 await assert.rejects(a.dispatch('approveSpend',input),/变化/);assert.equal(summary(a).limitUSD,200);
});
test('Failed and malformed responses still charge reported usage; retry shares the same budget',async t=>{
 let calls=0;const a=await setup(t,async(p,k,m,o)=>{report(o,1000000,0);if(++calls===1)throw errors.transportError();return {};});task(a);a.data.providers[0].requestPolicy.retries=1;
 await request(a);assert.equal(calls,2);assert.equal(summary(a).spentUSD,2);assert.equal(a.data.modelCalls[0].requestId,a.data.modelCalls[1].requestId);assert.equal(a.data.modelCalls[1].status,'error');
});
test('Missing usage retains reservations while retries share the original budget',async t=>{
 let calls=0;const a=await setup(t,async()=>{calls++;throw errors.transportError();});task(a);a.data.providers[0].requestPolicy.retries=1;
 await assert.rejects(request(a),e=>!e.spendLimit);assert.equal(calls,2);const held=summary(a).heldUSD;assert.ok(held>0);assert.equal(summary(a).usage.unknownCalls,2);assert.equal(summary(a).unsettledCalls,0);
 a.chat=async(p,k,m,o)=>{report(o);return {};};await request(a);assert.ok(Math.abs(summary(a).heldUSD-held)<1e-12);assert.equal(summary(a).limitUSD,100);assert.equal(summary(a).approvals.length,0);
});
test('Reported overrun preserves the artifact, stops verification and retains costs through feedback/restart',async t=>{
 let calls=0;const chat=async(p,k,m,o)=>{report(o,++calls===1?101000000:100,0);return calls===1?{kind:'artifact',content:'已生成的内容'}:{passed:true,summary:'满足要求',gaps:[]};};
 const a=await setup(t,chat),tt=task(a);a.activeSpendTask=null;await a.advance(tt.id);assert.equal(calls,1);assert.equal(tt.steps[0].done,true);assert.equal(tt.status,'blocked');assert.equal(tt.progressRuns[0].usage.inputTokens,101000000);
 a.requeue(tt);await a.advance(tt.id);assert.equal(calls,1);a.save();const b=new Assistant({dir:a.dir,chat});assert.equal(summary(b).spentUSD,101);await approve(b);await b.advance(tt.id);assert.equal(calls,2);assert.equal(b.task(tt.id).status,'review');assert.equal(summary(b).limitUSD,200);
});
test('Job planning and its child tasks share one budget; increasing call count does not bypass it',async t=>{
 let calls=0;const a=await setup(t,async(p,k,m,o)=>{report(o,101000000,0);calls++;return {tool:'ask',args:{question:'不应执行'}};});
 await a.dispatch('agentCreate',{goal:'测试共享额度',maxActions:1});await a.runPromise;const j=a.data.delegations[0];assert.equal(j.status,'limited');assert.equal(j.limitReason,'spend');assert.equal(a.data.decisions.length,0);assert.equal(a.data.agentRuns[0].usage.inputTokens,101000000);
 await assert.rejects(a.dispatch('agentBudget',{id:j.id,maxCalls:100}),/取消调用次数/);await assert.rejects(a.dispatch('agentRun',{id:j.id}),/费用上限/);assert.equal(calls,1);assert.equal(j.limitReason,'spend');
 const tt=task(a);tt.agentJobId=j.id;j.taskIds.push(tt.id);a.activeAgentJob=j;assert.equal(spend.scope(a).key,'job:'+j.id);assert.equal(Object.keys(a.spendLedger.scopes).length,1);
 await assert.rejects(agent.act(a,j,'approveSpend',{additionalUSD:100,confirmed:true}),/不可用/);
});
test('Paused work stays paused after human approval',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{report(o,101000000,0);return {tool:'ask',args:{question:'x'}};});await a.dispatch('agentCreate',{goal:'暂停测试',maxActions:1});await a.runPromise;const j=a.data.delegations[0];await a.dispatch('agentPause',{id:j.id});await approve(a);assert.equal(j.status,'paused');assert.equal(summary(a).limitUSD,200);
});
test('A pending reservation survives interruption and permits work within the same budget',async t=>{
 const a=await setup(t,async()=>({})),tt=task(a);const ticket=spend.reserve(a,a.data.providers[0],[]);a.save();
 const b=new Assistant({dir:a.dir,chat:async()=>({})});b.activeSpendTask=b.task(tt.id);assert.equal(summary(b).heldUSD,ticket.reservedUSD);assert.equal(summary(b).usage.unknownCalls,1);await request(b);assert.ok(summary(b).heldUSD>ticket.reservedUSD);assert.equal(summary(b).limitUSD,100);assert.equal(summary(b).unsettledCalls,0);
});
test('Restoring an older snapshot cannot restore a spent allowance or erase approval history',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{report(o,1000000,0);return {};});task(a);await request(a);const backup=recovery.create(a,'before-more-spend');await request(a);await approve(a);recovery.restore(a,backup);assert.equal(summary(a).spentUSD,2);assert.equal(summary(a).limitUSD,200);assert.equal(summary(a).approvals.length,1);
 const b=new Assistant({dir:a.dir});assert.equal(summary(b).spentUSD,2);
});
test('Ledger corruption and a missing established ledger fail closed',async t=>{
 for(const remove of [false,true]){const a=await setup(t,async(p,k,m,o)=>{report(o);return {};});const tt=task(a);await request(a);if(remove)fs.unlinkSync(path.join(a.dir,'spend-ledger.json'));else fs.writeFileSync(path.join(a.dir,'spend-ledger.json'),'broken');const b=new Assistant({dir:a.dir});b.activeSpendTask=b.task(tt.id);await assert.rejects(request(b),e=>e.spendKind==='storage');assert.ok(b.publicState().spendStatus.error);}
});
test('Historical reported usage is migrated, missing calls remain visible and require confirmation',async t=>{
 const a=await setup(t,async()=>({}));const j=agent.buildJob(a,{goal:'历史委托'});a.data.delegations.push(j);j.callsUsed=3;a.data.providers[0].type='codex';a.data.providers[0].model='gpt-6.1-sol';a.data.providers[0].inputPrice=null;a.data.providers[0].outputPrice=null;
 a.data.modelCalls=[{jobId:j.id,providerId:a.data.providers[0].id,model:'gpt-6.1-sol',inputTokens:1000000,outputTokens:0,cachedInputTokens:0}];delete a.data.spendMeter;fs.unlinkSync(path.join(a.dir,'spend-ledger.json'));a.save();const b=new Assistant({dir:a.dir});b.activeAgentJob=b.data.delegations[0];assert.equal(summary(b).spentUSD,4);assert.equal(summary(b).unsettledCalls,2);assert.throws(()=>spend.check(b),e=>e.spendKind==='unknown');
});
test('A free local model can continue even when its token usage is absent',async t=>{
 const a=await setup(t,async()=>({}));task(a);Object.assign(a.data.providers[0],{type:'ollama',inputPrice:null,outputPrice:null});await request(a);await request(a);assert.equal(summary(a).spentUSD,0);assert.equal(summary(a).unsettledCalls,0);assert.equal(summary(a).usage.unknownCalls,2);
});
test('API usage is recorded before rejecting malformed application JSON',async t=>{
 const prior=global.fetch;t.after(()=>global.fetch=prior);global.fetch=async()=>new Response(JSON.stringify({usage:{prompt_tokens:120,completion_tokens:30,prompt_tokens_details:{cached_tokens:20}},choices:[{message:{content:'not JSON'}}]}));let u;
 await assert.rejects(modelChat({type:'openai',baseUrl:'https://fixture.invalid/v1',model:'test'},'',[{role:'user',content:'x'}],{onUsage:v=>u=v}),e=>e.code==='MODEL_INVALID_RESPONSE');assert.equal(u.inputTokens,120);assert.equal(u.cachedInputTokens,20);
});
test('Fallback uses each actual model price and never receives a fresh allowance',async t=>{
 const fallback=require('../desktop/model-fallback.cjs');let calls=0;
 const a=await setup(t,async(p,k,m,o)=>{calls++;report(o,1000000,0);if(p.model==='priced')throw errors.transportError();return {};});task(a);
 await a.dispatch('saveProvider',{name:'备用',model:'backup',baseUrl:'https://fixture.invalid/v1',inputPrice:3,outputPrice:5});const backup=a.data.providers[1];let f=fallback.snapshot(a);f.roles.execute={...f.roles.execute,enabled:true,providerId:backup.id};await a.dispatch('modelFallbackSave',{revision:f.revision,roles:f.roles});
 await request(a);assert.equal(calls,2);assert.equal(summary(a).spentUSD,4);assert.equal(a.data.modelCalls[0].pricing.input,3);assert.equal(a.data.modelCalls[1].pricing.input,1);
});
test('A storage failure before reservation prevents the model request and future calls',async t=>{
 let calls=0;const a=await setup(t,async()=>{calls++;return {};});task(a);fs.mkdirSync(path.join(a.dir,'spend-ledger.json.tmp'));
 await assert.rejects(request(a),e=>e.spendKind==='storage');await assert.rejects(request(a),e=>e.spendKind==='storage');assert.equal(calls,0);assert.equal(a.publicState().stewardshipStatus.used,0);
});
test('Rejected approval and provider edits cannot reset an existing budget',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{report(o,101000000,0);return {};});const tt=task(a);await request(a);
 await a.dispatch('saveProvider',{...a.data.providers[0],inputPrice:0,outputPrice:0});await assert.rejects(request(a),e=>e.spendKind==='budget');
 a.requeue(tt);assert.equal(summary(a).spentUSD,101);assert.equal(summary(a).limitUSD,100);
});
test('Per-run statistics persist independently of the bounded recent-call list',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{report(o,100,30,40);return {tool:'ask',args:{question:'请补充'}};});await a.dispatch('agentCreate',{goal:'统计测试',maxActions:1});await a.runPromise;const run=a.data.agentRuns[0];
 assert.equal(run.usage.totalTokens,130);assert.equal(run.usage.cachedInputTokens,40);a.data.modelCalls=[];a.save();const b=new Assistant({dir:a.dir});assert.equal(b.data.agentRuns[0].usage.totalTokens,130);assert.equal(summary(b).usage.totalTokens,130);
});
test('Reserved unknown usage cannot demand acknowledgement but still counts toward the limit',async t=>{
 const a=await setup(t,async()=>({}));task(a);await request(a);const held=summary(a).heldUSD;
 assert.equal(summary(a).limitUSD,100);assert.equal(summary(a).heldUSD,held);assert.equal(summary(a).unsettledCalls,0);assert.equal(summary(a).approvals.length,0);
 await assert.rejects(approve(a,{additionalUSD:0,acknowledgeUnknown:true}),/未知用量/);
 a.chat=async(p,k,m,o)=>{report(o,101000000,0);return {};};await request(a);await assert.rejects(request(a),e=>e.spendKind==='budget');assert.equal(summary(a).limitUSD,100);
});

test('Reserved unknown usage eventually stops before a further request exceeds the allowance',async t=>{
 let calls=0;const a=await setup(t,async()=>{calls++;return {};});task(a);a.data.providers[0].outputPrice=400;
 await request(a);const held=summary(a).heldUSD;assert.ok(held>50&&held<100);await assert.rejects(request(a),e=>e.spendKind==='budget');assert.equal(calls,1);assert.equal(summary(a).heldUSD,held);assert.equal(summary(a).limitUSD,100);
});
test('Upgrade clears old reserved-unknown blocks without losing charges or reviving paused work',async t=>{
 for(const status of ['limited','paused']){const a=await setup(t,async()=>({}));const j=agent.buildJob(a,{goal:'恢复原事项'});a.data.delegations.push(j);a.activeAgentJob=j;await request(a);const s=spend.scope(a);delete s.unreservedCalls;s.blocked={kind:'unknown',message:'old rule'};spend.persist(a);j.status=status;j.limitReason='spend';a.save();
 const b=new Assistant({dir:a.dir});const restored=b.data.delegations[0];assert.equal(restored.status,status==='limited'?'ready':'paused');assert.equal(summary(b).blocked,undefined);assert.equal(summary(b).heldUSD,s.heldUSD);assert.equal(summary(b).usage.unknownCalls,1);assert.equal(summary(b).limitUSD,100);}
});
