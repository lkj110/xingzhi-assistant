const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),models=require('../desktop/run-models.cjs'),errors=require('../desktop/model-errors.cjs'),fallback=require('../desktop/model-fallback.cjs');
async function setup(t,chat){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-run-models-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});for(const model of ['worker','reviewer'])await a.dispatch('saveProvider',{name:model+' config',model,baseUrl:'https://fixture.invalid/v1',inputPrice:0,outputPrice:0});return a;}
const usage=o=>o.onUsage?.({inputTokens:100,outputTokens:20,cachedInputTokens:10});
test('Advancement records actual execution and review models, even after configuration changes and recent-call pruning',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{usage(o);return o.role==='verify'?{passed:true,summary:'ok',gaps:[]}:{kind:'artifact',content:'result'};});
 await a.dispatch('settings',{roles:{execute:a.data.providers[0].id,verify:a.data.providers[1].id}});
 const task=a.createTask({title:'test',generationMode:'single',steps:[{title:'report',kind:'draft'}]});await a.advance(task.id);
 const r=task.progressRuns[0];assert.deepEqual(r.modelCallsDetail.map(c=>[c.model,c.role,c.status]),[['worker','execute','done'],['reviewer','verify','done']]);assert.equal(r.usage.totalTokens,240);assert.ok(a.data.modelCalls.every(c=>c.taskRunId===r.id));
 a.data.providers[0].model='changed';a.data.modelCalls=[];a.save();const b=new Assistant({dir:a.dir});assert.equal(b.task(task.id).progressRuns[0].modelCallsDetail[0].model,'worker');assert.equal(b.task(task.id).progressRuns[0].modelCallsDetail[0].providerName,'worker config');
});
test('Each retry and fallback is attached once to both the Agent run and child advancement',async t=>{
 let workerCalls=0;const a=await setup(t,async(p,k,m,o)=>{usage(o);if(p.model==='worker'){workerCalls++;throw errors.transportError();}return {};});
 const [worker,backup]=a.data.providers;worker.requestPolicy.retries=1;
 const run={id:'agent-run',modelCallsDetail:[]},child={id:'child-run',modelCallsDetail:[]};a.activeAgentRun=run;a.activeSpendRun=child;
 await assert.rejects(a.callModel(worker,'',[],{role:'execute',stage:'task_work'}));
 const f=fallback.snapshot(a);f.roles.execute={enabled:true,providerId:backup.id};await a.dispatch('modelFallbackSave',{revision:f.revision,roles:f.roles});
 await a.callModel(worker,'',[],{role:'execute',stage:'task_work'});
 assert.equal(workerCalls,3);assert.deepEqual(run.modelCallsDetail.map(c=>c.model),['worker','worker','worker','reviewer']);assert.deepEqual(run.modelCallsDetail.map(c=>c.status),['error','error','error','done']);assert.deepEqual(run.modelCallsDetail.map(c=>c.attempt),[1,2,1,2]);assert.equal(run.modelCallsDetail[3].fallbackFrom,worker.id);assert.deepEqual(child.modelCallsDetail,run.modelCallsDetail);assert.equal(run.usage.totalTokens,480);assert.equal(child.usage.totalTokens,480);
});
test('Running model is visible and persisted before a slow request completes',async t=>{
 let resolve,started;const entered=new Promise(r=>started=r);const a=await setup(t,async(p,k,m,o)=>{started();return new Promise(r=>resolve=()=>{usage(o);r({});});});
 const run={id:'r',modelCallsDetail:[]};a.data.agentRuns.push(run);a.activeAgentRun=run;
 const request=a.callModel(a.data.providers[0],'',[],{role:'organize'});await entered;
 assert.equal(a.publicState().agentRuns[0].modelCallsDetail[0].status,'running');const saved=JSON.parse(fs.readFileSync(a.file));assert.equal(saved.agentRuns[0].modelCallsDetail[0].model,'worker');resolve();await request;assert.equal(run.modelCallsDetail[0].status,'done');
});
test('Legacy recovery only associates exact run IDs or unambiguous job/time matches and never exposes call bodies',()=>{
 const r={id:'r',jobId:'j',startedAt:'2026-10-12T10:00:00Z',finishedAt:'2026-10-12T10:01:00Z',modelCalls:3};const data={agentRuns:[r],tasks:[],modelCalls:[{id:'1',jobId:'j',at:'2026-10-12T10:00:30Z',model:'historical',prompt:'secret'},{id:'2',jobId:'other',at:'2026-10-12T10:00:30Z',model:'unrelated'},{id:'3',jobId:'j',runId:'different',at:'2026-10-12T10:00:30Z',model:'different'}]};
 models.initialize({data});assert.deepEqual(r.modelCallsDetail.map(c=>c.model),['historical']);assert.equal(r.modelUsageSource,'legacy');assert.ok(!JSON.stringify(r).includes('secret'));data.modelCalls=[];models.initialize({data});assert.equal(r.modelCallsDetail.length,1);
 const overlap={data:{agentRuns:[{...r,id:'a',modelCallsDetail:undefined},{...r,id:'b',modelCallsDetail:undefined}],tasks:[],modelCalls:[{jobId:'j',at:'2026-10-12T10:00:30Z',model:'ambiguous'}]}};models.initialize(overlap);assert.ok(overlap.data.agentRuns.every(r=>r.modelCallsDetail.length===0));
});
test('Budget rejection records no model invocation',async t=>{
 let invoked=0;const a=await setup(t,async()=>{invoked++;return {};});const task=a.createTask({title:'budget',steps:[{title:'report',kind:'draft'}]});a.data.providers[0].inputPrice=null;a.data.providers[0].outputPrice=null;await a.advance(task.id);assert.equal(invoked,0);assert.deepEqual(task.progressRuns[0].modelCallsDetail,[]);
});
test('Restoring an older backup keeps the latest task model and usage history',async t=>{
 const a=await setup(t,async(p,k,m,o)=>{usage(o);return o.role==='verify'?{passed:true,summary:'ok',gaps:[]}:{kind:'artifact',content:'result'};});const task=a.createTask({title:'restore',generationMode:'single',steps:[{title:'report',kind:'draft'}]});const recovery=require('../desktop/recovery.cjs'),backup=recovery.create(a);await a.advance(task.id);const history=structuredClone(task.progressRuns);recovery.restore(a,backup);assert.deepEqual(a.task(task.id).progressRuns,history);
});
test('An interrupted process is not shown as a still-running model after restart',()=>{
 const run={id:'r',startedAt:new Date().toISOString(),modelCallsDetail:[{model:'worker',status:'running'}]};models.initialize({data:{agentRuns:[],tasks:[{id:'t',progressRuns:[run]}]}});assert.equal(run.modelCallsDetail[0].status,'interrupted');assert.equal(run.status,'interrupted');assert.ok(run.finishedAt);
});
test('Routing reasons and original pricing survive recent-call trimming; migration matches exact call IDs',()=>{
 const row={id:'one',model:'old-model',routing:{mode:'auto',reason:'original reason'},pricing:{input:2,output:10},estimatedUSD:.12};
 const run={modelCallsDetail:[]};const sync=models.start(row,[run]);row.routing.reason='final reason';sync();
 row.pricing.input=99;assert.equal(run.modelCallsDetail[0].pricing.input,2);
 const legacy={modelCallsDetail:[{id:'two',model:'historical',estimatedUSD:.55},{model:'unidentified'}]};
 const data={agentRuns:[run,legacy],tasks:[],modelCalls:[{id:'two',routing:{reason:'recorded choice'},pricing:{input:1,output:5},estimatedUSD:100},{pricing:{input:99}}]};
 models.initialize({data});assert.equal(legacy.modelCallsDetail[0].pricing.input,1);assert.equal(legacy.modelCallsDetail[0].estimatedUSD,.55);assert.equal(legacy.modelCallsDetail[1].pricing,undefined);
 data.modelCalls=[];models.initialize({data});assert.equal(run.modelCallsDetail[0].routing.reason,'final reason');assert.equal(legacy.modelCallsDetail[0].routing.reason,'recorded choice');
});
