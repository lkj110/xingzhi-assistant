'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EngineClient}=require('../desktop/engine-client.cjs');
const root=path.resolve(__dirname,'..');
async function setup(t,scenario,repairVariant){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'system-controlled-worker-'))),workspace=path.join(dir,'workspace'),auditFile=path.join(dir,'audit.json'),module=path.join(dir,'transport.cjs');
 fs.mkdirSync(workspace);
 fs.writeFileSync(module,`exports.create=async({Assistant,options})=>{
 const fs=require('node:fs');const deny=()=>{throw Error('Real external transport forbidden');};globalThis.fetch=deny;require('node:net').Socket.prototype.connect=deny;require('node:child_process').spawn=deny;require('node:child_process').execFile=deny;
 const common=require(${JSON.stringify(path.join(root,scenario.startsWith('storage_method_recovery')?'scripts/storage-method-worker-fixture.cjs':'scripts/root-delivery-fixture.cjs'))});
 const f=await common.setup({Assistant,options,scenario:${JSON.stringify(scenario)},repairVariant:${JSON.stringify(repairVariant)},reportFile:${JSON.stringify(auditFile)},restoreAudit:fs.existsSync(${JSON.stringify(auditFile)})}).catch(e=>{console.error(e.stack);throw e;});
 if(${JSON.stringify(scenario)}==='context_authorization_repair'||${JSON.stringify(scenario)}.startsWith('storage_method_recovery')){
  const {parentPort}=require('node:worker_threads');
  parentPort.on('message',m=>{if(m.type!=='controlledObservation')return;try{if(!['snapshot','complete','checkpoint','blocked'].includes(m.action))throw Error('read-only observation');f.saveAudit();parentPort.postMessage({type:'controlledObservationResult',id:m.id,result:{state:common.state?common.state(f):common.contextRepairState(f),runs:f.a.data.agentRuns.length,busy:!!f.a.operation,...(m.action==='complete'?{complete:common.assertComplete(f)}:m.action==='checkpoint'?{checkpoint:common.assertCheckpoint(f)}:m.action==='blocked'?{blocked:common.assertBlocked(f)}:{})}});}catch(e){parentPort.postMessage({type:'controlledObservationResult',id:m.id,error:e.stack});}});
  return f.a;
 }
 const dispatch=f.a.dispatch.bind(f.a);f.a.dispatch=async(action,input)=>{
  if(action==='fixtureRun'){f.a.automaticExecution=true;await require(${JSON.stringify(path.join(root,'desktop/agent.cjs'))}).run(f.a,f.job.id);f.saveAudit();return {status:f.job.status,taskStatus:f.task.status,paused:f.a.data.stewardship.paused,error:f.job.lastError,primary:f.task.primaryArtifactId};}
  if(action==='fixtureAssert')return common.assertComplete(f);
  return dispatch(action,input);
 };return f.a;
 };`);
 // Diagnostics race with the Worker's non-atomic fixture audit writes. A partial
 // snapshot must never replace the test error or prevent teardown.
 const auditSnapshot=()=>{try{const audit=JSON.parse(fs.readFileSync(auditFile));return {lastEvents:audit.events.slice(-6).map(e=>e.kind),modelInputs:audit.modelInputs.length};}catch(error){return {auditUnavailable:error.code||error.name};}};
 let engine;const stages=[],started=performance.now(),stage=(name,detail={})=>{stages.push({name,ms:performance.now()-started,...detail});if(stages.length>256)stages.shift();};
 const start=async()=>{stage('worker-start');engine=new EngineClient({dir:workspace,fixtureModule:module,safeStorage:{isEncryptionAvailable:()=>false},native:async()=>({supported:false})});await engine.ready;stage('worker-ready',{threadId:engine.worker.threadId});return engine;};
 await start();t.after(async()=>{try{t.diagnostic(JSON.stringify({scenario,...auditSnapshot()}));}finally{try{await engine.close().catch(()=>{});}finally{fs.rmSync(dir,{recursive:true,force:true});}}});
 let sequence=0;
 t.after(()=>t.diagnostic(JSON.stringify({scenario,stages})));
 const observe=(action='snapshot')=>new Promise((resolve,reject)=>{const id=++sequence;stage('observe-send',{id,action});const timer=setTimeout(()=>{engine.worker.off('message',listener);stage('observe-timeout',{id,action,...auditSnapshot()});reject(Error('observation timeout: '+JSON.stringify(stages)));},15000),listener=m=>{if(m.type!=='controlledObservationResult'||m.id!==id)return;clearTimeout(timer);engine.worker.off('message',listener);stage('observe-reply',{id,action});m.error?reject(Error(m.error)):resolve(m.result);};engine.worker.on('message',listener);engine.worker.postMessage({type:'controlledObservation',id,action});});
 return {get engine(){return engine;},audit:()=>JSON.parse(fs.readFileSync(auditFile)),observe,restart:async()=>{const old=engine.worker.threadId;await engine.close();await start();assert.notEqual(engine.worker.threadId,old,'must start a distinct formal Worker');},workspace};
}
for(const [scenario,title] of [['success','full-delivery check-revise'],['read_reorder','read-reorder'],['read_mixed','read-mixed']])test('controlled formal Worker: '+title,async t=>{
 const f=await setup(t,scenario);const result=await f.engine.dispatch('fixtureRun');assert.equal(result.status,'review',JSON.stringify(result));const verified=await f.engine.dispatch('fixtureAssert');assert.ok(verified.workerThreadId>0);assert.equal(verified.updates,1);assert.equal(verified.consumedReadBatches,6);
});
for(const [scenario,title] of [['pause_during_check','restart-content'],['pause_during_result','restart-result']])test('controlled formal Worker: '+title+' retains checkpoint and resumes same delivery',async t=>{
 const f=await setup(t,scenario),first=await f.engine.dispatch('fixtureRun');assert.equal(first.paused,true);assert.notEqual(first.status,'review');const before=f.audit(),generated=before.events.filter(e=>e.kind==='revision_generated').length;
 await f.restart();assert.equal(f.audit().modelInputs.length,before.modelInputs.length,'cold loading makes zero model requests');const state=await f.engine.dispatch('state');assert.equal(state.stewardship.paused,true);assert.equal(f.audit().events.filter(e=>e.kind==='cold_worker_loaded').length,1);
 await f.engine.dispatch('stewardshipResume');const result=await f.engine.dispatch('fixtureRun');assert.equal(result.status,'review',JSON.stringify(result));await f.engine.dispatch('fixtureAssert');assert.equal(f.audit().events.filter(e=>e.kind==='revision_generated').length,generated,'restart must not regenerate');
});
test('controlled formal Worker: write-response-lost reconciles original action after process restart',async t=>{
 const f=await setup(t,'uncertain');await f.engine.dispatch('fixtureRun');const state=await f.engine.dispatch('state'),action=state.agentActions.find(x=>x.tool==='lark_update');assert.equal(action.status,'uncertain');await f.restart();await f.engine.dispatch('fixtureRun');await f.engine.dispatch('fixtureAssert');const after=await f.engine.dispatch('state');assert.equal(after.agentActions.find(x=>x.id===action.id).status,'done');assert.equal(f.audit().connectorCalls.filter(c=>c.args[1]==='+update').length,1);
});
test('controlled formal Worker: readback-mismatch stays unaccepted across restart without duplicate write',async t=>{
 const f=await setup(t,'readback_mismatch');await f.engine.dispatch('fixtureRun');await f.restart();const result=await f.engine.dispatch('fixtureRun');assert.notEqual(result.status,'review');assert.notEqual(result.taskStatus,'completed');assert.equal(f.audit().connectorCalls.filter(c=>c.args[1]==='+update').length,1);assert.ok(!f.audit().checks.some(c=>c.kind==='goal'&&c.passed));assert.deepEqual(f.audit().violations,[]);
});
async function repairCommand(f){const {state}=await f.observe();assert.equal(state.view?.kind,'internal_context_authorization');const input={action:'agentCheckResume',input:{id:state.jobId,...state.view}};await f.engine.dispatch('uiCommand',input);return input;}
async function completeRepair(f,before){
 await f.engine.control('resume');
  // Individual RPCs retain their 15 s deadline. A full 19-source delivery is a
  // different budget; keep it bounded within the original outer 60 s test.
  const until=Date.now()+45000;let observedBusy=false;
  while(Date.now()<until){const s=await f.observe();observedBusy ||= s.busy;if(s.runs>before&&!s.busy){assert.ok(observedBusy,'observation port must respond during repair');return f.observe('complete');}await new Promise(r=>setTimeout(r,25));}
 assert.fail('normal Worker RPC did not settle: '+JSON.stringify(await f.observe()));
}
test('controlled/notproduction formal Worker: context authorization repair uses normal RPC across upgrade and committed-repair cold restarts',async t=>{
 const f=await setup(t,'context_authorization_repair'),original=await f.observe();
 await f.restart();require('../scripts/root-delivery-fixture.cjs').assertContextRepairRestored(original.state,(await f.observe()).state);
 const input=await repairCommand(f),ready=await f.observe();assert.equal(ready.state.decision.status,'superseded');assert.equal(ready.state.decision.answer,undefined);assert.equal(f.audit().modelInputs.length,0);
 await f.engine.dispatch('uiCommand',input);assert.deepEqual(await f.observe(),ready);
 await f.restart();assert.deepEqual((await f.observe()).state,ready.state);
 const done=await completeRepair(f,ready.runs);assert.equal(done.complete.status,'review');assert.equal(done.complete.updates,1);assert.ok(done.complete.workerThreadId>0);
 assert.equal(f.audit().events.filter(e=>e.kind==='context_repair_first_bounded').length,1);
 await f.restart();await f.observe('complete');
});
test('controlled/notproduction formal Worker: paused repair records intent but normal resume RPC cannot dispatch',async t=>{
 const f=await setup(t,'context_authorization_repair','paused');await f.restart();await repairCommand(f);const before=await f.observe();
 await f.engine.control('resume');assert.deepEqual(await f.observe(),before);await f.restart();assert.deepEqual((await f.observe()).state,before.state);
 await f.engine.control('resume');assert.equal((await f.observe()).runs,before.runs);assert.equal(f.audit().modelInputs.length,0);
 const after=await f.observe();assert.equal(after.state.paused,true);assert.deepEqual(after.state,before.state);assert.equal(f.audit().connectorCalls.filter(c=>!c.baseline).length,0);
});
for(const variant of ['consumed','unknown','unknown_before_check','usage_conflict','later_owner'])test('controlled/notproduction formal Worker: '+variant+' denies repair and normal runtime dispatch',async t=>{
 const f=await setup(t,'context_authorization_repair',variant),before=await f.observe();assert.equal(before.state.view,null);await f.restart();assert.deepEqual((await f.observe()).state,before.state);
 await f.engine.dispatch('uiCommand',{action:'agentCheckResume',input:{id:before.state.jobId,proofId:'unproved',decisionId:before.state.decision.id,expectedRevision:0,expectedWorkRevision:1,expectedTaskRevision:1}}).then(()=>assert.fail('unproved repair accepted'),()=>{});
 await f.engine.control('resume');const after=await f.observe();assert.deepEqual(after.state,before.state);assert.equal(after.runs,before.runs);assert.equal(f.audit().modelInputs.length,0);assert.equal(f.audit().platformCalls.length,0);assert.equal(f.audit().connectorCalls.filter(c=>!c.baseline).length,0);
});

async function storageRun(f){
 const before=await f.observe();await f.engine.control('resume');
 const until=Date.now()+20000;
 while(Date.now()<until){const s=await f.observe();if(s.runs>before.runs&&!s.busy){assert.deepEqual(f.audit().violations,[]);return s;}await new Promise(r=>setTimeout(r,25));}
 assert.fail('normal storage Worker did not settle: '+JSON.stringify({observation:await f.observe(),audit:f.audit()}));
}
for(const negative of [false,true])test('controlled/notproduction formal Worker: storage method '+(negative?'changed revised body remains false and exhausts without publication':'large result claim, association, original revision and same-target delivery survive cold restarts'),async t=>{
 const f=await setup(t,negative?'storage_method_recovery_false':'storage_method_recovery'),original=await f.observe();
 assert.equal(original.state.view?.route,'evidence');assert.equal(original.state.view.eligible,true);assert.equal(original.state.jobStatus,'blocked');assert.equal(Object.values(original.state.continuation.episodes)[0].cycles,3);assert.deepEqual(original.state.methodAttempts,{});
 await f.restart();assert.deepEqual((await f.observe()).state,original.state,'cold historical import is read-only');
 await storageRun(f);const checkpoint=await f.observe('checkpoint');assert.ok(f.audit().workerThreadId>0);
 await f.restart();assert.deepEqual((await f.observe()).state,checkpoint.state,'claim, request receipt, original cycles, ACL and budget survive cold restart');
 await f.engine.control('resume');assert.deepEqual((await f.observe()).state,checkpoint.state,'paused normal RPC cannot issue another request');
 await f.engine.dispatch('stewardshipResume');await storageRun(f);const final=await f.observe(negative?'blocked':'complete');
 assert.equal(f.audit().platformCalls.length,1);assert.equal(f.audit().events.filter(e=>e.kind==='claim_before_network').length,1);
 if(negative){assert.equal(final.blocked.newCycles,3);assert.equal(final.blocked.updates,0);}else{assert.equal(final.complete.status,'review');assert.equal(final.complete.updates,1);}
 await f.restart();assert.deepEqual((await f.observe()).state,final.state);await f.observe(negative?'blocked':'complete');
 await f.engine.control('resume');assert.deepEqual((await f.observe()).state,final.state,'terminal state must not reacquire old failure');
});
