'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EngineClient}=require('../desktop/engine-client.cjs');
const packageContract=require('../scripts/system-package-worker.cjs');
async function setup(t,scenario){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'generic-delivery-worker-')),workspace=path.join(dir,'workspace'),reportFile=path.join(dir,'audit.json'),module=path.join(dir,'fixture.cjs');fs.mkdirSync(workspace);
 fs.writeFileSync(module,`exports.create=async({Assistant,options})=>{const deny=()=>{throw Error('Actual transport forbidden')};global.fetch=deny;require('node:net').Socket.prototype.connect=deny;require('node:child_process').spawn=deny;require('node:child_process').execFile=deny;return (await require(${JSON.stringify(path.resolve(__dirname,'../scripts/generic-consumption-worker-fixture.cjs'))}).setup({Assistant,options,reportFile:${JSON.stringify(reportFile)},restoreAudit:true,scenario:${JSON.stringify(scenario)}})).a;};`);
 let engine;async function start(){engine=new EngineClient({dir:workspace,fixtureModule:module,safeStorage:{isEncryptionAvailable:()=>false},native:async()=>({supported:false})});await engine.ready;}
 await start();t.after(async()=>{await engine.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});return {get engine(){return engine;},restart:async()=>{await engine.close();await start();}};
}
for(const scenario of ['success','uncertain','mismatch'])test('G06/G08/G09 controlled formal Worker: two fact batches original draft cold restart and '+scenario+' same-target delivery',async t=>{
 const f=await setup(t,scenario);let state=await f.engine.dispatch('controlledRun');assert.equal(state.audit.patches.length,1,JSON.stringify(state));assert.equal(state.primary.draftOnly,true);assert.equal(state.audit.writes,0);assert.equal(state.audit.checks.length,0);const first=state.primary.id;
 await f.restart();state=await f.engine.dispatch('controlledObserve');assert.equal(state.primary.id,first);assert.equal(state.audit.patches.length,1);
 for(let i=0;i<6&&state.jobStatus!=='review';i++){state=await f.engine.dispatch('controlledRun');if(state.audit.writes&&scenario!=='success')await f.restart();}
 assert.deepEqual(state.audit.violations,[],JSON.stringify(state));assert.deepEqual(state.audit.queries,['leaf','tail']);assert.equal(state.audit.patches.length,2);assert.equal(state.audit.writes,1);assert.equal(state.audit.creates,1);assert.equal(state.accepted,false);assert.equal(state.oldCycles,state.originalCycles);assert.equal(state.budget.limitUSD,200);assert.ok(state.budget.spentUSD>=17);assert.ok(state.threadId>0);
 if(scenario==='mismatch'){assert.notEqual(state.jobStatus,'review');assert.ok(!state.audit.checks.includes('goal'));}else{assert.equal(state.jobStatus,'review',JSON.stringify(state));assert.equal(state.primary.draftOnly,false);assert.equal(state.deliveries[0].result.url,require('../scripts/generic-consumption-worker-fixture.cjs').url);assert.equal(state.deliveries[0].result.verified,true);}
});
const recoveryCases=[
 ['preflight_recovery','COV-1 B2 controlled formal Worker: legacy identity-only correction cold restart two batches same-target verified delivery'],
 ['v2_recovery','COV-1 B4 controlled formal Worker: platform-chunks-v2 family cold restart two batches same-target verified delivery'],
 ['local_recovery','COV-1 ACQ-3 controlled formal Worker: retained ENOSPC local recovery cold restart zero redispatch two batches same-target verified delivery']
];
for(const [scenario,name]of recoveryCases)test(name,async t=>{
 const f=await setup(t,scenario),seed=await f.engine.dispatch('controlledObserve');
 const stages=[{stage:'failed_recovery_start',state:seed}];
 assert.ok(seed.threadId>0);assert.equal(seed.audit.patches.length,0);assert.equal(seed.audit.writes,0);assert.deepEqual(seed.audit.checks,[]);
 assert.equal(seed.recovery.initial.kind,scenario);assert.equal(seed.recovery.claims.length,0);assert.equal(seed.recovery.corrections.length,0);
 packageContract.assertGenericRecoverySeed(seed);
 if(scenario==='local_recovery'){assert.equal(seed.recovery.initial.failureCode,'LOCAL_RESULT_STORAGE');assert.equal(seed.recovery.operation.id,seed.recovery.initial.operationId);assert.equal(seed.recovery.source,undefined);}
 else {assert.equal(seed.recovery.initial.proof.eligible,true);assert.equal(seed.recovery.oldAttemptPreserved,true);assert.equal(seed.recovery.oldRunHash,seed.recovery.initial.runHash);}
 await f.restart();let state=await f.engine.dispatch('controlledObserve');
 assert.notEqual(state.threadId,seed.threadId);stages.push({stage:'failed_start_cold_restore',state});
 const comparable=s=>{const v=JSON.parse(JSON.stringify(s));delete v.threadId;return v;};assert.deepEqual(comparable(state),comparable(seed),'the failed recovery start must survive an actual Worker cold restart');
 state=await f.engine.dispatch('controlledRun');assert.equal(state.audit.patches.length,1,JSON.stringify(state));assert.equal(state.primary.draftOnly,true);assert.equal(state.audit.writes,0);assert.deepEqual(state.audit.checks,[]);
 packageContract.assertGenericRecoveryProgress(state);
 stages.push({stage:'first_batch_consumed',state});const first=state.primary.id,firstThread=state.threadId;await f.restart();state=await f.engine.dispatch('controlledObserve');assert.notEqual(state.threadId,firstThread);assert.equal(state.primary.id,first);assert.equal(state.consumption.receipts.length,1);stages.push({stage:'partial_draft_cold_restore',state});
 for(let i=0;i<8&&state.jobStatus!=='review';i++)state=await f.engine.dispatch('controlledRun');
 assert.equal(state.jobStatus,'review',JSON.stringify(state));assert.deepEqual(state.audit.violations,[]);assert.deepEqual(state.audit.queries,['leaf','tail']);assert.equal(state.audit.patches.length,2);assert.equal(state.audit.writes,1);assert.equal(state.audit.creates,1);
 assert.deepEqual(state.audit.checks,['content','result','goal']);assert.equal(state.primary.draftOnly,false);assert.equal(state.contentCheck.passed,true);assert.equal(state.resultCheck.passed,true);assert.equal(state.oldCycles,seed.oldCycles);assert.equal(state.budget.limitUSD,200);assert.ok(state.budget.spentUSD>=seed.budget.spentUSD);assert.equal(state.accepted,false);
 const [r1,r2]=state.consumption.receipts;assert.equal(r1.baseArtifactId,'generic-original');assert.equal(r1.artifactId,first);assert.equal(r2.baseArtifactId,first);assert.equal(r2.artifactId,state.primary.id);
 const r=state.recovery;assert.equal(r.source.associated,true);assert.equal(r.source.readAllowed,true);assert.equal(r.operation.status,'done');
 packageContract.assertGenericRecoveryProgress(state);
 assert.ok(r.steps.some(s=>s.tool==='plan_task'&&s.args.evidenceResolution?.sourceIds.includes(r.source.id)),'real plan_task must associate the recovered source');
 assert.ok(r.steps.filter(s=>s.tool==='advance_task').length>=2,'real advance_task must drive both consumption receipts');
 assert.ok(r.steps.some(s=>s.tool==='verify_content'));assert.ok(r.steps.some(s=>s.tool==='lark_update'));
 if(scenario==='preflight_recovery'){
  assert.equal(r.corrections.length,1);assert.equal(r.corrections[0].payload.originalAttemptHash,r.initial.attemptHash);assert.equal(r.oldAttemptPreserved,true);assert.equal(r.oldRunHash,r.initial.runHash);assert.equal(r.claims.length,0);
  assert.ok(r.steps.some(s=>s.tool==='platform_query'&&s.dispatch.requests.some(q=>q.query.table==='leaf')));
 }else if(scenario==='v2_recovery'){
  assert.equal(r.claims.length,1);const claim=r.claims[0];assert.equal(claim.method,'platform-chunks-v2');assert.equal(claim.status,'done');assert.equal(claim.familyKey,r.initial.familyKey);assert.equal(claim.originOperationId,r.initial.operationId);
  assert.equal(r.operation.originOperationId,r.initial.operationId);assert.equal(r.operation.familyKey,claim.familyKey);assert.equal(r.operation.methodClaimId,claim.key);assert.equal(r.originalOperationHash,r.initial.operationHash);assert.equal(r.source.format,'platform-chunks-v2');assert.equal(r.oldRunHash,r.initial.runHash);
 }else{
  assert.deepEqual(r.localCompletion.counts,r.initial.counts,'local recovery must use zero new identity/platform/model/method claim');assert.equal(r.claims.length,0);
  assert.equal(r.operation.id,r.initial.operationId);assert.equal(r.operation.attemptId,r.initial.attemptId);assert.equal(r.operation.logicalKey,r.initial.logicalKey);assert.deepEqual(r.operation.requests,r.initial.requests);assert.equal(r.operation.responseProof.dataHash,r.initial.responseHash);assert.equal(r.source.restoredHash,r.initial.responseHash);
  const step=r.steps.find(s=>s.tool==='recover_platform_result');assert.equal(step.result.sourceId,r.source.id);assert.equal(step.result.storageValidation,'original_response_verified');assert.deepEqual(step.dispatch.requests,[]);
 }
 assert.equal(state.deliveries.length,1);assert.equal(state.deliveries[0].status,'done');assert.equal(state.deliveries[0].result.verified,true);assert.equal(state.deliveries[0].result.url,require('../scripts/generic-consumption-worker-fixture.cjs').url);
 stages.push({stage:'two_batches_checked_and_same_target_readback',state});await f.restart();const final=await f.engine.dispatch('controlledObserve');assert.notEqual(final.threadId,state.threadId);assert.deepEqual(comparable(final),comparable(state),'verified delivery survives cold restart without reissuing recovery');stages.push({stage:'verified_delivery_cold_restore',state:final});
 if(process.env.SYSTEM_RELEASE_OUTPUT){
  const out=process.env.SYSTEM_RELEASE_OUTPUT;assert.ok(path.isAbsolute(out));fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'controlled-worker-generic_'+scenario+'.json'),JSON.stringify({scenario:'generic_'+scenario,testName:name,layer:'controlled',productionDelivery:'not_verified',userAccepted:false,passed:true,stages},null,2)+'\n',{flag:'wx'});
 }
});
