const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const health=require('../desktop/subscription-health.cjs'),subscription=require('../desktop/subscription.cjs'),journal=require('../desktop/work-journal.cjs'),view=require('../desktop/workspace-view.cjs');
const good={installed:true,loggedIn:true,version:'controlled'},bad={installed:true,loggedIn:false};
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subscription-health-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const failedAt=new Date(Date.now()-60000).toISOString(),request={requestId:'request',attempt:1,runId:'run',callId:'call',spendTicketId:'ticket',status:'unknown',responseStatus:'error',usageReported:false,errorCode:'MODEL_AUTH',finishedAt:failedAt};
 const p={attemptId:'attempt',status:'unknown',runId:'run',finishedAt:failedAt,baseArtifactId:'artifact',baseHash:'body',scope:'scope',targetFacts:[{factKey:'fact'}],requests:[request]};
 const data={tasks:[{id:'task',agentJobId:'job',progressRuns:[],evidenceConsumption:{attempts:{attempt:p}}}],delegations:[{id:'job'}],providers:[{id:'provider',type:'codex',model:'controlled',reasoning:'medium'}],settings:{roles:{execute:'provider'}},modelCalls:[{id:'call',requestId:'request',attempt:1,status:'error',errorCode:'MODEL_AUTH',errorMessage:'PRIVATE_ERROR'}],agentRuns:[{id:'run',finishedAt:failedAt,steps:[]}],runtime:{}};
 const install=data=>({dir,file:path.join(dir,'workspace.json'),data,save(){fs.writeFileSync(this.file,JSON.stringify(this.data));},dispatch(action){assert.equal(action,'subscriptionStatus');return health.check(this);}});
 const a=install(data);journal.initialize(a,{migrate:true});
 t.mock.method(subscription,'identity',()=>({cliHash:'cli',configurationHash:'public-config'}));
 t.mock.method(subscription,'status',async()=>good);
 return {a,p,request,failedAt,run:()=>view.command(a,{action:'subscriptionStatus'}),restart:()=>{const b=install(JSON.parse(fs.readFileSync(a.file)));journal.initialize(b);return b;}};
}
test('only the trusted UI command can journal a health check; no inference or secrets',async t=>{
 const f=fixture(t);let calls=0;t.mock.method(subscription,'status',async()=>{calls++;assert.equal(health.receipt(f.a).status,'pending');assert.equal(health.valid(f.a,{after:f.failedAt}),null);assert.equal(journal.read(f.a).events.at(-1).payload.health.status,'pending');return good;});
 await assert.rejects(health.check(f.a),e=>e.code==='SUBSCRIPTION_HEALTH_UNTRUSTED');assert.equal(calls,0);
 const result=await f.run();assert.equal(result.health.status,'success');assert.equal(calls,1);assert.equal(health.valid(f.a,{after:f.failedAt}).valid,true);
 assert.ok(!JSON.stringify(health.receipt(f.a)).includes('PRIVATE'));assert.ok(!JSON.stringify(journal.read(f.a)).includes('PRIVATE'));
 const copy=health.receipt(f.a);copy.status='failed';assert.equal(health.receipt(f.a).status,'success');
 assert.equal(health.valid(f.restart(),{after:f.failedAt}).checkId,result.health.checkId);
});
test('out-of-order older success cannot overwrite a newer failed or pending check',async t=>{
 const f=fixture(t),first=defer(),second=defer();let calls=0;t.mock.method(subscription,'status',()=>++calls===1?first.promise:second.promise);
 const old=f.run(),newer=f.run();assert.equal(health.receipt(f.a).sequence,2);second.resolve(bad);await newer;first.resolve(good);assert.equal((await old).health,null);assert.equal(health.receipt(f.a).status,'failed');assert.equal(health.valid(f.a,{after:f.failedAt}),null);
});
test('a new pending check revokes prior success even across cold replay',async t=>{
 const f=fixture(t);await f.run();const pending=defer();t.mock.method(subscription,'status',()=>pending.promise);const check=f.run();
 assert.equal(health.valid(f.a,{after:f.failedAt}),null);assert.equal(health.valid(f.restart(),{after:f.failedAt}),null);
 pending.resolve(good);await check;assert.equal(health.receipt(f.a).sequence,2);
});
for(const point of ['start','finish','after-written-finish'])test(`save failure at ${point} leaves no valid success, including restart`,async t=>{
 const f=fixture(t);await f.run();const save=f.a.save.bind(f.a);let calls=0;t.mock.method(subscription,'status',async()=>{calls++;return good;});
 t.mock.method(f.a,'save',()=>{const r=health.receipt(f.a);if(point==='start'&&r.status==='pending'||point!=='start'&&r.status==='success'){if(point==='after-written-finish')save();throw Object.assign(Error('PRIVATE_DISK'),{code:'ENOSPC'});}save();});
 await assert.rejects(f.run(),e=>e.code==='MODEL_STORAGE'&&!e.message.includes('PRIVATE'));assert.equal(calls,point==='start'?0:1);assert.equal(health.valid(f.a,{after:f.failedAt}),null);assert.equal(health.valid(f.restart(),{after:f.failedAt}),null);
});
test('CLI exceptions and cancellation persist failure and revoke older success',async t=>{
 const f=fixture(t);await f.run();t.mock.method(subscription,'status',async()=>{throw Object.assign(Error('PRIVATE_CLI'),{name:'AbortError'});});
 await assert.rejects(f.run(),e=>e.code==='MODEL_CANCELLED');assert.equal(health.receipt(f.a).status,'failed');assert.equal(health.valid(f.restart(),{after:f.failedAt}),null);
});
test('journal append failure revokes older success across restart and a fresh UI check can recover',async t=>{
 const f=fixture(t);await f.run();let calls=0;t.mock.method(subscription,'status',async()=>{calls++;return good;});
 const append=t.mock.method(journal,'append',()=>{throw Object.assign(Error('PRIVATE_JOURNAL'),{code:'ENOSPC'});});
 await assert.rejects(f.run(),e=>e.code==='MODEL_STORAGE');assert.equal(calls,0);assert.equal(health.valid(f.a,{after:f.failedAt}),null);
 append.mock.restore();assert.equal(health.valid(f.restart(),{after:f.failedAt}),null);await f.run();assert.equal(health.valid(f.a,{after:f.failedAt}).valid,true);
});
for(const mutation of ['cli','public-config','provider','reasoning','roles','routing','failed-request','run-finish','call-error'])test(`${mutation} mutation during await invalidates the completed check`,async t=>{
 const f=fixture(t),waiting=defer();t.mock.method(subscription,'status',()=>waiting.promise);const check=f.run();
 if(mutation==='cli')t.mock.method(subscription,'identity',()=>({cliHash:'changed',configurationHash:'public-config'}));
 if(mutation==='public-config')t.mock.method(subscription,'identity',()=>({cliHash:'cli',configurationHash:'changed'}));
 if(mutation==='provider')f.a.data.providers.push({id:'second',type:'codex',model:'different'});
 if(mutation==='reasoning')f.a.data.providers[0].reasoning='high';
 if(mutation==='roles')f.a.data.settings.roles.execute='different';
 if(mutation==='routing')f.a.data.modelRouting={enabled:true,economyId:'different'};
 if(mutation==='failed-request')f.request.spendTicketId='other';
 if(mutation==='run-finish')f.a.data.agentRuns[0].finishedAt=new Date().toISOString();
 if(mutation==='call-error')f.a.data.modelCalls[0].errorMessage='different';
 waiting.resolve(good);assert.equal((await check).health,null);assert.equal(health.valid(f.a,{after:f.failedAt}),null);
});
test('claim validation rechecks configuration, intent, latest check and time bounds',async t=>{
 const f=fixture(t);await f.run();const r=health.receipt(f.a);assert.equal(health.valid(f.a,{after:f.failedAt,intent:r.intentHash}).valid,true);assert.equal(health.valid(f.a,{after:f.failedAt,intent:'wrong'}),null);
 assert.equal(health.valid(f.a,{after:r.startedAt}),null);assert.equal(health.valid(f.a,{}),null);
 const base=Date.parse(r.startedAt);let clock=base+health.TTL_MS;t.mock.method(Date,'now',()=>clock);assert.equal(health.valid(f.a,{after:f.failedAt}),null);clock=base-1;assert.equal(health.valid(f.a,{after:f.failedAt}),null);
 clock=base+10;f.a.data.providers[0].model='changed';assert.equal(health.valid(f.a,{after:f.failedAt}),null);
});
test('grant/status/run transitions preserve intent; changed original tuples and new requests do not',async t=>{
 const f=fixture(t);await f.run();const initial=health.identity(f.a).intentHash;
 Object.assign(f.p,{status:'prepared',runId:'new-run',startedAt:new Date().toISOString(),preflightRecovery:{status:'prepared'}});assert.equal(health.identity(f.a).intentHash,initial);assert.equal(health.valid(f.a,{after:f.failedAt}).valid,true);
 f.p.status='generating';f.p.preflightRecovery.status='claimed';assert.equal(health.identity(f.a).intentHash,initial);
 f.p.requests.push({requestId:'new-request',attempt:1,runId:'new-run',spendTicketId:'new-ticket',status:'possible_dispatch'});assert.notEqual(health.identity(f.a).intentHash,initial);assert.equal(health.valid(f.a,{after:f.failedAt}),null);
});
test('atomic recovery claim binds live original evidence and tolerates only its intent selection',async t=>{
 const f=fixture(t);await f.run();const initial=health.identity(f.a).intentHash;
 f.p.modelPreflightRecovery={status:'prepared',proof:{originalRequest:structuredClone(f.request)}};f.p.status='generating';f.p.runId='new-run';
 f.p.requests.push({requestId:'new-request',attempt:1,runId:'new-run',spendTicketId:'new-ticket',status:'possible_dispatch'});
 assert.equal(health.identity(f.a).intentHash,initial);assert.equal(health.valid(f.a,{after:f.failedAt}).valid,true);
 f.p.modelPreflightRecovery.status='claimed';assert.equal(health.identity(f.a).intentHash,initial);
 f.request.errorCode='MODEL_NETWORK';assert.notEqual(health.identity(f.a).intentHash,initial);assert.equal(health.valid(f.a,{after:f.failedAt}),null);
});
test('external status success and snapshot-only forged receipts cannot mint health',async t=>{
 const f=fixture(t);await subscription.status();assert.equal(health.valid(f.a,{after:f.failedAt}),null);
 f.a.data.runtime.subscriptionHealth={version:1,status:'success',checkId:'forged',sequence:1,...health.identity(f.a),installed:true,loggedIn:true,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};assert.equal(health.valid(f.a,{after:f.failedAt}),null);
});
test('unavailable CLI identity or public metadata cannot mint health despite reported login',async t=>{
 const f=fixture(t);let identity={cliHash:null,configurationHash:'config'};t.mock.method(subscription,'identity',()=>identity);
 assert.equal((await f.run()).health,null);identity={cliHash:'cli',configurationHash:null};assert.equal((await f.run()).health,null);assert.equal(health.valid(f.a,{after:f.failedAt}),null);
});
test('real Assistant integration requires uiCommand and replays the health journal on cold start',async t=>{
 const {Assistant}=require('../desktop/core.cjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'subscription-health-core-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 t.mock.method(subscription,'identity',()=>({cliHash:'cli',configurationHash:'public-config'}));let checks=0;t.mock.method(subscription,'status',async()=>{checks++;return good;});
 const chat=async()=>{throw Error('inference prohibited');},a=new Assistant({dir,chat});
 await assert.rejects(a.dispatch('subscriptionStatus'),e=>e.code==='SUBSCRIPTION_HEALTH_UNTRUSTED');assert.equal(checks,0);
 const empty=await a.dispatch('uiCommand',{action:'subscriptionStatus'});assert.equal(empty.health,null);
 await a.dispatch('createTask',{title:'controlled health subject',description:'local fixture'});
 const after=new Date(Date.now()-60000).toISOString(),result=await a.dispatch('uiCommand',{action:'subscriptionStatus'});assert.equal(result.health.status,'success');
 const restarted=new Assistant({dir,chat});assert.equal(health.valid(restarted,{after}).checkId,result.health.checkId);assert.equal(checks,2);
});
