'use strict';
// Focused boundary test: real trusted-command context, health checks/validation,
// journal, transitions and recovery. The old failure is a synthetic schema-1
// copy of model-preflight-recovery.test.cjs, never a production workspace.
// A single-job dispatch harness exercises handler CAS; the separate Worker test
// owns full Assistant controller/RPC coverage.
// External ACL/gate/current-input/continuation/model guards are controlled below;
// spend admission remains real. No CLI execution, network, UI or model calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{hash}=require('../desktop/evidence-basis.cjs');
const recovery=require('../desktop/model-preflight-recovery.cjs'),journal=require('../desktop/work-journal.cjs'),transitions=require('../desktop/state-transitions.cjs');
const health=require('../desktop/subscription-health.cjs'),subscription=require('../desktop/subscription.cjs'),view=require('../desktop/workspace-view.cjs');
const clone=v=>structuredClone(v),message='无法确认 Codex 登录状态，请在模型设置中重新检测。';
function seedData(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-health-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const job={id:'job',taskIds:['task'],workRevision:1,status:'blocked',executionState:{continuation:{episodes:{original:{taskId:'task',cycles:2,hops:3}}}},lastErrorAutomaticRetry:false,lastErrorCode:'MODEL_AUTH',lastError:message};
 const call={id:'call',at:'2026-10-18T10:01:00Z',jobId:'job',taskId:'task',runId:'run',taskRunId:'taskrun',requestId:'request',attempt:1,spendTicketId:'ticket',spendScope:'job:job',providerId:'provider',providerType:'codex',model:'model',role:'execute',stage:'task_work',status:'error',errorCode:'MODEL_AUTH',errorMessage:message,usageReported:false,estimatedUSD:null,reservedUSD:1.72002};
 const snap=clone(call);for(const k of ['jobId','taskRunId','reservedUSD'])delete snap[k];
 const step={id:'step-dispatch',tool:'advance_task',args:{taskId:'task'},error:message,errorCode:'MODEL_AUTH'};
 const run={id:'run',jobId:'job',startedAt:'2026-10-18T10:00:00Z',finishedAt:'2026-10-18T10:02:00Z',status:'blocked',steps:[step],modelCalls:1,modelCallsDetail:[clone(snap)],usage:{inputTokens:0,outputTokens:0,totalTokens:0,estimatedUSD:0,reportedCalls:0,unknownCalls:1}};
 const taskRun={id:'taskrun',startedAt:'2026-10-18T10:00:30Z',finishedAt:'2026-10-18T10:01:59Z',status:'blocked',modelCallsDetail:[clone(snap)],usage:clone(run.usage)};
 const request={requestId:'request',attempt:1,runId:'run',callId:'call',spendTicketId:'ticket',status:'unknown',usageReported:false,errorCode:'MODEL_AUTH',responseStatus:'error',at:'2026-10-18T10:00:59Z',finishedAt:'2026-10-18T10:01:58Z'};
 const p={version:1,jobId:'job',taskId:'task',attemptId:'consumption',status:'unknown',runId:'run',intent:'intent',scope:'scope',baseArtifactId:'draft',baseHash:'base',primaryLineageId:'draft',stepId:'draft-step',targetFacts:[{factKey:'one',bindingVersion:'binding'}],additionalFacts:[],originalInputBasis:{hash:'input'},originalGenerationSnapshot:{id:'snapshot'},requests:[request],errorCode:'MODEL_AUTH',error:message};
 const task={id:'task',agentJobId:'job',status:'blocked',workRevision:1,progressRuns:[taskRun],evidenceConsumption:{version:1,activeAttemptId:p.attemptId,attempts:{[p.attemptId]:p},receipts:[]}};
 const a={dir,file:path.join(dir,'workspace.json'),data:{tasks:[task],delegations:[job],agentRuns:[run],modelCalls:[call],runtime:{},decisions:[],agentActions:[],sources:[],artifacts:[],providers:[],settings:{}},save(){fs.writeFileSync(this.file,JSON.stringify(this.data));},dispatch(action,input){assert.equal(action,'agentModelPreflightAttest');return recovery.attest(this,job,input);}};
 a.data.spendMeter={scopes:{'job:job':{limitUSD:200,spentUSD:170.97393881,heldUSD:5.02577550,usage:{unknownCalls:3,unpricedCalls:0},unreservedCalls:0}}};
 return {a,job,task,p,request,call,run,taskRun,step};
}
function identityFiles(dir){
 const home=fs.realpathSync(dir),bin=path.join(home,'codex'),config=path.join(home,'config.toml'),cache=path.join(home,'models_cache.json');
 fs.writeFileSync(bin,'controlled CLI identity; never executed\n',{mode:0o700});fs.writeFileSync(config,'model = "controlled"\n');fs.writeFileSync(cache,'{"models":[]}');
 const env={PATH:home,HOME:home,CODEX_HOME:home,LANG:'en_US.UTF-8'};
 const file=require.resolve('../desktop/subscription.cjs'),localRequire=createRequire(file),source=fs.readFileSync(file,'utf8');
 const controlledFS={...fs};for(const name of ['statSync','realpathSync','accessSync','readFileSync'])controlledFS[name]=(p,...args)=>{
  if(![bin,config,cache].includes(p))throw Object.assign(Error('outside controlled identity files'),{code:'ENOENT'});return fs[name](p,...args);
 };
 function load(legacy){
  // Exact pre-boundary cache metadata producer; no constant identity or auth.
  const current="const config=metadata(path.join(home,'config.toml'));\n  return {cliHash:cli?hash(cli):null,configurationHash:config.code&&config.code!=='ENOENT'?null:hash({env,config})};";
  const old="const config=metadata(path.join(home,'config.toml')),models=metadata(path.join(home,'models_cache.json'));\n  return {cliHash:cli?hash(cli):null,configurationHash:[config,models].some(v=>v.code&&v.code!=='ENOENT')?null:hash({env,config,models})};";
  assert.ok(source.includes(current),'legacy identity adapter must match the reviewed boundary');
  const context={module:{exports:{}},process:{env},require:n=>n==='node:fs'?controlledFS:n==='node:child_process'?{spawn(){assert.fail('real CLI forbidden');}}:localRequire(n)};
  vm.runInNewContext(legacy?source.replace(current,old):source,context,{filename:file});return context.module.exports.identity;
 }
 return {bin,config,cache,env,current:load(false),legacy:load(true)};
}
function legacyHealth(){
 const file=require.resolve('../desktop/subscription-health.cjs'),source=fs.readFileSync(file,'utf8'),marker='return {identityPolicyVersion:2,cliHash:';
 assert.ok(source.includes(marker));
 // The old producer lacked only this marker. All check/valid/receipt/journal
 // logic executes unchanged; the filesystem identity uses the old algorithm.
 const context={module:{exports:{}},require:createRequire(file),structuredClone,Date};
 vm.runInNewContext(source.replace(marker,'return {cliHash:'),context,{filename:file});return context.module.exports;
}
function start(f){f.a.activeAgentJob=f.job;f.a.activeSpendTask=f.task;f.a.activeAgentRun={id:'new-run'};f.p.status='generating';f.p.runId='new-run';return {requestId:'new-request',attempt:1,spendTicket:{id:'new-ticket'},role:'execute',stage:'task_work'};}
function claim(f,meta=start(f)){
 const r={requestId:meta.requestId,attempt:meta.attempt,runId:f.p.runId,spendTicketId:meta.spendTicket.id,status:'possible_dispatch',producerSchema:2};
 transitions.commit(f.a,()=>{f.p.requests.push(r);recovery.claim(f.a,meta,r);});return {r,meta};
}
function upgradeEvents(f){return journal.read(f.a).events.filter(e=>e.type===recovery.HEALTH_UPGRADE);}
function inputFor(f){const v=recovery.view(f.a,f.job);assert.ok(v?.healthUpgrade,'UI must expose upgrade CAS');return {id:f.job.id,taskId:v.taskId,attemptId:v.attemptId,...v.healthUpgrade,executedBy:'supervisor',authorizationNote:'按本人已有授权，以当前配置接续同一原稿；保留未知费用和累计上限。'};}
function original(f){return {health:JSON.stringify(f.g.health),proof:JSON.stringify(f.g.proof),grantId:f.g.id,request:JSON.stringify(f.p.requests[0]),call:JSON.stringify(f.a.data.modelCalls[0]),budget:JSON.stringify(f.a.data.spendMeter),rawBudget:fs.readFileSync(f.budgetFile,'utf8')};}
function preserved(f,old){assert.deepEqual(original(f),old);}
async function fixture(t,{oldClaimed=false,legacy=true}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-18T10:03:00Z')});
 const seeded=seedData(t),f={a:seeded.a,gates:{acl:true,current:true}};
 for(const [key,get]of Object.entries({job:()=>f.a.data.delegations[0],task:()=>f.a.data.tasks[0],p:()=>f.task.evidenceConsumption.attempts.consumption,g:()=>f.p.modelPreflightRecovery,request:()=>f.p.requests[0],run:()=>f.a.data.agentRuns[0]}))Object.defineProperty(f,key,{get});
 f.files=identityFiles(f.a.dir);f.budgetFile=path.join(f.a.dir,'spend-ledger.json');fs.writeFileSync(f.budgetFile,JSON.stringify({format:1,...f.a.data.spendMeter},null,2)+'\n');
 function attach(a){a.dispatch=function(action,input){if(action==='uiCommand')return view.command(this,input);if(action==='subscriptionStatus')return (this.healthModule||health).check(this);const job=this.data.delegations[0];if(action==='agentModelPreflightAttest')return recovery.attest(this,job,input);if(action===recovery.HEALTH_COMMAND)return recovery.upgradeHealth(this,job,input);assert.fail('unexpected command '+action);};return a;}
 attach(f.a);f.ui=(action,input={})=>f.a.dispatch('uiCommand',{action,input});f.check=()=>{t.mock.timers.tick(10);return f.ui('subscriptionStatus');};
 f.upgrade=(input=inputFor(f))=>f.ui(recovery.HEALTH_COMMAND,input);
 f.cold=()=>{f.a=attach({...f.a,data:JSON.parse(fs.readFileSync(f.a.file)),activeAgentJob:null,activeSpendTask:null,activeAgentRun:null,healthModule:health});journal.initialize(f.a,{force:true});return f;};
 // Only external guards are controlled. Real fresh() must call each of them;
 // ACL/current-input negatives flip the guard, budget negatives use real data.
 t.mock.method(require('../desktop/execution-gate.cjs'),'assert',()=>true);
 t.mock.method(require('../desktop/evidence-consumption.cjs'),'current',()=>f.gates.current);
 t.mock.method(require('../desktop/continuation-control.cjs'),'allowed',()=>true);
 t.mock.method(require('../desktop/pending-check.cjs'),'inspect',()=>({eligible:false}));
 t.mock.method(require('../desktop/protocol-access.cjs'),'assertTool',()=>{if(!f.gates.acl)throw Object.assign(Error('controlled ACL revoked'),{code:'ACCESS_DENIED'});return true;});
 t.mock.method(require('../desktop/projects.cjs'),'relatedActions',()=>[]);
 t.mock.method(require('../desktop/execution-facts.cjs'),'modelGuard',()=>null);
 t.mock.method(subscription,'identity',legacy?f.files.legacy:f.files.current);
 t.mock.method(subscription,'status',async()=>({installed:true,loggedIn:true}));
 journal.initialize(f.a,{migrate:true});
 const c=recovery.candidate(f.a,f.job,f.task,{allowUnattested:true});assert.equal(c.eligible,true,c.reason);
 f.ui('agentModelPreflightAttest',{id:f.job.id,taskId:f.task.id,attemptId:f.p.attemptId,evidenceHash:c.evidenceHash,registryId:recovery.REGISTRY.id,executedBy:'supervisor',authorizationNote:'受控历史来源确认',expectedWorkRevision:1,expectedTaskRevision:1});
 const oldHealth=legacy?legacyHealth():health;f.a.healthModule=oldHealth;
 assert.equal((await f.check()).health.status,'success');t.mock.timers.tick(10);
 // Run the real old validator only while producing the authentic old grant.
 const oldValid=legacy?t.mock.method(health,'valid',oldHealth.valid):null;
 try{assert.ok(recovery.prepare(f.a,f.job,f.task));if(oldClaimed)claim(f);}finally{oldValid?.mock.restore();}
 f.a.healthModule=health;subscription.identity.mock.mockImplementation(f.files.current);
 f.a.activeAgentJob=null;f.a.activeSpendTask=null;f.a.activeAgentRun=null;f.a.save();
 return f;
}

test('old prepared -> UI health -> UI upgrade -> latest same-identity health -> claim -> cold replay preserves original bytes and budget',async t=>{
 const f=await fixture(t),old=original(f);assert.equal(f.g.health.identityPolicyVersion,undefined);f.cold();
 assert.equal(health.valid(f.a,{after:f.run.finishedAt}),null);await f.check();assert.equal(health.receipt(f.a).identityPolicyVersion,2);
 assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'MODEL_PREFLIGHT_HEALTH_CHANGED');
 const input=inputFor(f),v=f.upgrade(input);assert.equal(v.id,f.p.modelPreflightHealthUpgrade.id);assert.equal(upgradeEvents(f).length,1);
 assert.equal(v.oldHealthHash,hash(f.g.health));assert.equal(v.health.identityPolicyVersion,2);assert.equal(f.p.requests.length,1);assert.equal(f.a.data.agentRuns.length,1);preserved(f,old);
 f.cold();assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,true);assert.equal(recovery.view(f.a,f.job).healthUpgrade,null);
 t.mock.timers.tick(health.TTL_MS+1);assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'MODEL_PREFLIGHT_HEALTH_REQUIRED');
 await f.check();const latest=health.receipt(f.a);assert.notEqual(latest.checkId,v.health.checkId);
 const {meta}=claim(f);assert.equal(f.g.status,'claimed');assert.deepEqual(f.g.claim.health,latest);assert.equal(f.g.claim.healthUpgradeId,v.id);preserved(f,old);
 t.mock.timers.tick(health.TTL_MS+1);f.cold();assert.equal(recovery.grant(f.a,f.job,f.task).status,'claimed');assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);assert.equal(f.p.requests.length,2);
 assert.throws(()=>f.upgrade(input),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});start(f);assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});assert.equal(upgradeEvents(f).length,1);preserved(f,old);
});
test('same confirmation is idempotent under concurrent clicks; changed operator/note cannot create a second upgrade',async t=>{
 const f=await fixture(t);await f.check();const input=inputFor(f),old=original(f);
 const results=await Promise.all([Promise.resolve().then(()=>f.upgrade(input)),Promise.resolve().then(()=>f.upgrade(input))]);assert.deepEqual(results[0],results[1]);assert.equal(upgradeEvents(f).length,1);
 for(const patch of [{executedBy:'user'},{authorizationNote:'different authorization'}])assert.throws(()=>f.upgrade({...input,...patch}),{code:'MODEL_PREFLIGHT_ALREADY_UPGRADED'});
 f.cold();assert.deepEqual(f.upgrade(input),results[0]);assert.equal(upgradeEvents(f).length,1);preserved(f,old);
});
for(const [key,value]of Object.entries({id:'other',taskId:'other',attemptId:'other',grantId:'other',proofHash:'wrong',expectedGrantHash:'wrong',expectedWorkRevision:2,expectedTaskRevision:2}))test('upgrade rejects stale/wrong CAS '+key,async t=>{
 const f=await fixture(t);await f.check();const input=inputFor(f),old=original(f);assert.throws(()=>f.upgrade({...input,[key]:value}),{code:key==='taskId'?'MODEL_PREFLIGHT_SCOPE_CHANGED':'STATE_STALE'});assert.equal(upgradeEvents(f).length,0);assert.equal(f.p.modelPreflightHealthUpgrade,undefined);preserved(f,old);
});
test('upgrade requires exact trusted command, executor and nonempty bounded authorization note',async t=>{
 const f=await fixture(t);await f.check();const input=inputFor(f),old=original(f);
 assert.throws(()=>recovery.upgradeHealth(f.a,f.job,input),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 for(const patch of [{executedBy:'model'},{executedBy:undefined},{authorizationNote:''},{authorizationNote:'  '},{authorizationNote:'x'.repeat(16001)}])assert.throws(()=>f.upgrade({...input,...patch}),{code:'AUTHORIZATION_INPUT_REQUIRED'});
 assert.throws(()=>f.upgrade({...input,health:{}}),{code:'MODEL_PREFLIGHT_UPGRADE_INPUT'});assert.equal(upgradeEvents(f).length,0);preserved(f,old);
});
const negatives={
 'wrong original request':f=>{f.request.spendTicketId='wrong';},
 'wrong original call':f=>{f.a.data.modelCalls[0].model='wrong';},
 'scope changed':f=>{f.p.scope='different';},
 'ACL revoked':f=>{f.gates.acl=false;},
 'current input changed':f=>{f.gates.current=false;},
 'budget exhausted':f=>{f.a.data.spendMeter.scopes['job:job'].limitUSD=175;},
 'CLI replaced':f=>{fs.copyFileSync(f.files.bin,f.files.bin+'.next');fs.renameSync(f.files.bin+'.next',f.files.bin);},
 'intent changed':f=>{f.a.data.tasks.push({id:'other',evidenceConsumption:{attempts:{other:{requests:[{requestId:'other',errorCode:'MODEL_AUTH'}]}}}});},
 'new unknown request':f=>{f.p.requests.push({requestId:'unknown',attempt:1,status:'unknown'});},
 'new execute call':f=>{f.a.data.modelCalls.push({id:'new-call',taskId:f.task.id,role:'execute',stage:'task_work',at:new Date().toISOString()});},
 'retained candidate':f=>{f.p.candidate={content:'unclaimed result'};},
 'active run':f=>{f.a.activeAgentRun={id:'active'};},
};
for(const [name,mutate]of Object.entries(negatives))test('cannot renew after '+name,async t=>{
 const f=await fixture(t);await f.check();const input=inputFor(f),oldHealth=JSON.stringify(f.g.health);mutate(f);await f.check();const beforeRequests=clone(f.p.requests),beforeBudget=JSON.stringify(f.a.data.spendMeter),beforeCalls=clone(f.a.data.modelCalls);
 Object.assign(input,recovery.view(f.a,f.job)?.healthUpgrade);
 const codes={'wrong original request':'MODEL_PREFLIGHT_RECOVERY_USED','wrong original call':'MODEL_PREFLIGHT_RECOVERY_USED','scope changed':'MODEL_PREFLIGHT_RECOVERY_USED','ACL revoked':'ACCESS_DENIED','current input changed':'EVIDENCE_CONSUMPTION_STALE','budget exhausted':'spend_budget','CLI replaced':'MODEL_PREFLIGHT_HEALTH_CHANGED','intent changed':'MODEL_PREFLIGHT_HEALTH_CHANGED','new unknown request':'EVIDENCE_GENERATION_UNRESOLVED','new execute call':'EVIDENCE_GENERATION_UNRESOLVED','retained candidate':'MODEL_PREFLIGHT_PROOF_INVALID','active run':'EXECUTION_RUNNING'};
 assert.throws(()=>f.upgrade(input),{code:codes[name]});assert.equal(upgradeEvents(f).length,0);assert.equal(f.p.modelPreflightHealthUpgrade,undefined);assert.equal(JSON.stringify(f.g.health),oldHealth);assert.deepEqual(f.p.requests,beforeRequests);assert.deepEqual(f.a.data.modelCalls,beforeCalls);assert.equal(JSON.stringify(f.a.data.spendMeter),beforeBudget);
});
test('version-2 prepared has no upgrade UI and rejects fabricated upgrade input',async t=>{
 const f=await fixture(t,{legacy:false});await f.check();assert.equal(recovery.view(f.a,f.job).healthUpgrade,null);
 assert.throws(()=>f.upgrade({id:f.job.id,taskId:f.task.id,attemptId:f.p.attemptId,grantId:f.g.id,proofHash:f.g.proofHash,expectedGrantHash:hash(f.g),expectedWorkRevision:1,expectedTaskRevision:1,executedBy:'user',authorizationNote:'adversarial direct call'}),{code:'MODEL_PREFLIGHT_UPGRADE_NOT_LEGACY'});assert.equal(upgradeEvents(f).length,0);
});
for(const state of ['missing','expired','failed','pending'])test('latest '+state+' health blocks upgrade without adding a request',async t=>{
 const f=await fixture(t),input=inputFor(f);let finish;
 if(state!=='missing')await f.check();
 if(state==='expired')t.mock.timers.tick(health.TTL_MS);
 if(state==='failed'){subscription.status.mock.mockImplementation(async()=>({installed:true,loggedIn:false}));await f.check();}
 if(state==='pending'){subscription.status.mock.mockImplementation(()=>new Promise(r=>{finish=r;}));const checking=f.check();assert.throws(()=>f.upgrade(input),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});finish({installed:true,loggedIn:true});await checking;}
 else assert.throws(()=>f.upgrade(input),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});
 assert.equal(upgradeEvents(f).length,0);assert.equal(f.p.requests.length,1);
});
test('out-of-order old successful health cannot authorize upgrade after a newer failure',async t=>{
 const f=await fixture(t),input=inputFor(f);let finish;subscription.status.mock.mockImplementation(()=>new Promise(r=>{finish=r;}));const old=f.check();
 subscription.status.mock.mockImplementation(async()=>({installed:true,loggedIn:false}));await f.check();finish({installed:true,loggedIn:true});assert.equal((await old).health,null);
 assert.throws(()=>f.upgrade(input),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});assert.equal(upgradeEvents(f).length,0);
});
for(const point of ['append','snapshot','written-snapshot'])test('upgrade '+point+' failure blocks dispatch and cold recovery never duplicates durable confirmation',async t=>{
 const f=await fixture(t);await f.check();const input=inputFor(f),old=original(f),save=f.a.save;
 const hook=point==='append'?t.mock.method(journal,'append',()=>{throw Object.assign(Error('controlled full disk'),{code:'ENOSPC'});}):t.mock.method(f.a,'save',function(){if(point==='written-snapshot')save.call(this);throw Object.assign(Error('controlled full disk'),{code:'ENOSPC'});});
 assert.throws(()=>f.upgrade(input),{code:'ENOSPC'});assert.equal(f.p.requests.length,1);assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,false);hook.mock.restore();preserved(f,old);
 if(point==='append'){assert.equal(upgradeEvents(f).length,0);assert.equal(f.p.modelPreflightHealthUpgrade,undefined);f.upgrade(input);}else {assert.equal(upgradeEvents(f).length,1);f.cold();}
 assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,true);const v=f.upgrade(input);assert.equal(v.id,f.p.modelPreflightHealthUpgrade.id);assert.equal(upgradeEvents(f).length,1);preserved(f,old);
});
test('atomic request+claim save failure restores prepared and permits only one later claim',async t=>{
 const f=await fixture(t);await f.check();f.upgrade();const old=original(f),meta=start(f),hook=t.mock.method(f.a,'save',()=>{throw Object.assign(Error('full disk'),{code:'ENOSPC'});});
 assert.throws(()=>claim(f,meta),{code:'ENOSPC'});assert.equal(f.g.status,'prepared');assert.equal(f.p.requests.length,1);hook.mock.restore();claim(f,meta);assert.equal(f.p.requests.length,2);f.cold();assert.equal(recovery.grant(f.a,f.job,f.task).status,'claimed');preserved(f,old);
});
for(const [name,mutate]of Object.entries({
 'old hash':v=>{v.oldHealthHash='wrong';},'proof hash':v=>{v.proofHash='wrong';},'actor':v=>{v.executedBy='model';},'event identity':v=>{v.eventId='wrong';},'version':v=>{v.version=2;},'policy marker':v=>{delete v.health.identityPolicyVersion;},'time before check':v=>{v.at=new Date(Date.parse(v.health.startedAt)-1).toISOString();},
}))test('forged upgrade '+name+' cannot authorize claim',async t=>{
 const f=await fixture(t);await f.check();f.upgrade();mutate(f.p.modelPreflightHealthUpgrade);assert.equal(recovery.grant(f.a,f.job,f.task),null);const meta=start(f);assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_PROOF_INVALID'});assert.equal(f.p.requests.length,1);
});
test('duplicate durable upgrade event is rejected even with a valid journal checksum',async t=>{
 const f=await fixture(t);await f.check();f.upgrade();const event=upgradeEvents(f)[0];journal.append(f.a,[event.command],{commitId:'adversarial-second-confirmation'});
 assert.equal(journal.read(f.a).events.filter(e=>e.type===recovery.HEALTH_UPGRADE).length,2);assert.equal(recovery.grant(f.a,f.job,f.task),null);assert.throws(()=>f.cold());assert.equal(f.p.requests.length,1);
});
test('snapshot-only upgrade is rejected without its durable journal event',async t=>{
 const f=await fixture(t);await f.check();const before=fs.readFileSync(journal.file(f.a)),snapshot=clone(f.a.data);f.upgrade();const forged=clone(f.p.modelPreflightHealthUpgrade);
 fs.writeFileSync(journal.file(f.a),before);f.a.data=snapshot;f.p.modelPreflightHealthUpgrade=forged;assert.equal(recovery.grant(f.a,f.job,f.task),null);assert.equal(upgradeEvents(f).length,0);const meta=start(f);assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_PROOF_INVALID'});
});
test('old claimed without upgrade remains valid after marker 2, expiry and cold replay; cannot renew or dispatch twice',async t=>{
 const f=await fixture(t,{oldClaimed:true}),old=original(f),claimReceipt=clone(f.g.claim.health);assert.equal(claimReceipt.identityPolicyVersion,undefined);assert.equal(f.g.claim.healthUpgradeId,undefined);
 t.mock.timers.tick(health.TTL_MS+1);await f.check();f.cold();assert.equal(recovery.grant(f.a,f.job,f.task).status,'claimed');assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);assert.equal(recovery.view(f.a,f.job).healthUpgrade,null);
 assert.throws(()=>f.upgrade({id:f.job.id,taskId:f.task.id,executedBy:'user',authorizationNote:'not allowed'}),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});
 const meta=start(f);assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});assert.deepEqual(f.g.claim.health,claimReceipt);assert.equal(f.p.modelPreflightHealthUpgrade,undefined);assert.equal(upgradeEvents(f).length,0);assert.equal(f.p.requests.length,2);preserved(f,old);
});

test('upgrade confirmation CAS binds the displayed health check id and sequence',async t=>{
 const f=await fixture(t);await f.check();const stale=inputFor(f);await f.check();const current=inputFor(f);
 assert.notEqual(current.expectedHealthCheckId,stale.expectedHealthCheckId);assert.ok(current.expectedHealthSequence>stale.expectedHealthSequence);
 for(const input of [stale,{...current,expectedHealthCheckId:stale.expectedHealthCheckId},{...current,expectedHealthSequence:stale.expectedHealthSequence}])assert.throws(()=>f.upgrade(input),{code:'STATE_STALE'});
 assert.equal(upgradeEvents(f).length,0);f.upgrade(current);assert.equal(upgradeEvents(f).length,1);
});
test('missing side record with an existing durable upgrade cannot fall back to old grant health',async t=>{
 const f=await fixture(t);await f.check();f.upgrade();const stored=clone(f.p.modelPreflightHealthUpgrade);delete f.p.modelPreflightHealthUpgrade;
 assert.equal(upgradeEvents(f).length,1);assert.equal(recovery.grant(f.a,f.job,f.task),null);assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,false);
 f.a.save();f.cold();assert.deepEqual(f.p.modelPreflightHealthUpgrade,stored);assert.equal(recovery.grant(f.a,f.job,f.task).status,'prepared');assert.equal(upgradeEvents(f).length,1);
});

for(const upgraded of [false,true])for(const conflict of [false,true])test('duplicate prepare authority fails closed '+JSON.stringify({upgraded,conflict}),async t=>{
 const f=await fixture(t);await f.check();const input=inputFor(f);if(upgraded)f.upgrade(input);
 const e=journal.read(f.a).events.find(e=>e.type===recovery.TYPE),cmd=clone(e.command);
 if(conflict)cmd.payload.grant.id='different-grant';
 journal.append(f.a,[cmd],{commitId:'second-prepare-authority'});
 assert.equal(recovery.grant(f.a,f.job,f.task),null);assert.throws(()=>f.upgrade(input));assert.equal(f.p.requests.length,1);
 try{f.cold();}catch{}assert.equal(recovery.grant(f.a,f.job,f.task),null);
});
test('same prepare commit retry is idempotent and does not revoke original authority',async t=>{
 const f=await fixture(t),e=journal.read(f.a).events.find(e=>e.type===recovery.TYPE);
 journal.append(f.a,[e.command],{commitId:e.commitId});assert.equal(journal.read(f.a).events.filter(e=>e.type===recovery.TYPE).length,1);assert.equal(recovery.grant(f.a,f.job,f.task).status,'prepared');
});
test('claim must follow configuration confirmation while same-millisecond claim remains legal',async t=>{
 const f=await fixture(t);await f.check();t.mock.timers.tick(1000);f.upgrade();const confirmation=f.p.modelPreflightHealthUpgrade;
 claim(f);assert.equal(f.g.claim.at,confirmation.at);assert.equal(recovery.grant(f.a,f.job,f.task).status,'claimed');
 f.g.claim.at=confirmation.health.finishedAt;assert.ok(Date.parse(f.g.claim.at)<Date.parse(confirmation.at));assert.equal(recovery.grant(f.a,f.job,f.task),null);
});
test('historic completed or unknown consumption does not grant a special preflight efficiency permission',async t=>{
 const f=await fixture(t);await f.check();f.upgrade();claim(f);const run={id:'new-run',jobId:f.job.id,status:'running',steps:[]};f.a.activeAgentRun=run;f.a.activeAgentJob=f.job;f.a.data.agentRuns.unshift(run);
 for(const status of ['committed','failed','superseded','unknown']){f.p.status=status;assert.equal(recovery.permits(f.a,f.job,{task:f.task,stage:'dispatch',action:{tool:'advance_task',args:{taskId:f.task.id}}}),false);}
 assert.throws(()=>require('../desktop/evidence-consumption.cjs').assertAdvance(f.a,f.job,f.task),{code:'EVIDENCE_GENERATION_UNRESOLVED'});
});

test('clock rollback before confirmation rejects atomic claim and restores request append',async t=>{
 const f=await fixture(t);await f.check();t.mock.timers.tick(1000);f.upgrade();const confirmation=f.p.modelPreflightHealthUpgrade,meta=start(f),before=clone(f.p.requests);
 t.mock.timers.setTime(Date.parse(confirmation.at)-1);
 assert.throws(()=>claim(f,meta),{code:'MODEL_PREFLIGHT_CLAIM_HEALTH_INVALID'});assert.deepEqual(f.p.requests,before);assert.equal(f.g.status,'prepared');
});
