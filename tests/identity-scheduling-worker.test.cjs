'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EngineClient}=require('../desktop/engine-client.cjs');
async function fixture(t,scenario){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'identity-scheduling-worker-')),workspace=path.join(dir,'workspace'),reportFile=path.join(dir,'audit.json'),module=path.join(dir,'fixture.cjs');fs.mkdirSync(workspace);
 fs.writeFileSync(module,`exports.create=async({Assistant,options})=>(await require(${JSON.stringify(path.resolve(__dirname,'../scripts/identity-scheduling-worker-fixture.cjs'))}).setup({Assistant,options,reportFile:${JSON.stringify(reportFile)},scenario:${JSON.stringify(scenario)},restoreAudit:true})).a;`);
 let engine;const start=async()=>{engine=new EngineClient({dir:workspace,fixtureModule:module,safeStorage:{isEncryptionAvailable:()=>false},native:async()=>({supported:false})});await engine.ready;};await start();
 t.after(async()=>{await engine.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});
 return {get engine(){return engine;},restart:async()=>{await engine.close();await start();}};
}
const counts=s=>[s.runCount,s.stepCount,s.attemptCount,s.audit.identity,s.audit.business,s.audit.models];
for(const scenario of ['permanent','unknown','transient'])test('A1-A3/A11/A14 formal Worker audit counterexample: '+scenario+' converges, including cold restart',async t=>{
 const f=await fixture(t,scenario),seed=await f.engine.dispatch('controlledIdentityObserve'),stages=[seed];
 let state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:0});stages.push(state);
 assert.equal(state.audit.identity,scenario==='unknown'?0:1,JSON.stringify(state));assert.equal(state.policy.eligible,false);assert.equal(state.policy.phase,scenario==='transient'?'retry':'blocked');
 assert.equal(state.runCount-seed.runCount,scenario==='unknown'?0:1);assert.equal(state.stepCount-seed.stepCount,scenario==='unknown'?0:1);
 const frozen=counts(state);state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:0});assert.deepEqual(counts(state),frozen);
 if(scenario==='transient'){
  const firstDue=Date.parse(state.policy.resumeAt);assert.equal(firstDue-state.clock,15000);
  state=await f.engine.dispatch('controlledIdentityRun');assert.deepEqual(counts(state),frozen,'manual entry cannot bypass backoff');
  const backoffThread=state.threadId;await f.restart();state=await f.engine.dispatch('controlledIdentityObserve');assert.notEqual(state.threadId,backoffThread);assert.deepEqual(counts(state),frozen);assert.equal(Date.parse(state.policy.resumeAt),firstDue);stages.push(state);
  state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:-1000});assert.deepEqual(counts(state),frozen);
  state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:16000});assert.equal(state.audit.identity,2);assert.equal(Date.parse(state.policy.resumeAt)-state.clock,60000);stages.push(state);
  state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:59000});assert.equal(state.audit.identity,2);
  state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:1000});assert.equal(state.audit.identity,3);assert.equal(state.identityDecision.reason,'TRANSIENT_EXHAUSTED');assert.equal(state.policy.phase,'blocked');stages.push(state);
 }
 const settled=counts(state),oldThread=state.threadId;await f.restart();state=await f.engine.dispatch('controlledIdentityObserve');assert.notEqual(state.threadId,oldThread);assert.deepEqual(counts(state),settled);stages.push(state);
 for(let i=0;i<5;i++){state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:16000});assert.deepEqual(counts(state),settled);}
 state=await f.engine.dispatch('controlledIdentityRun');assert.deepEqual(counts(state),settled);assert.equal(state.policy.resumeAt,null);assert.equal(state.audit.business,0);assert.equal(state.audit.models,0);assert.deepEqual(state.audit.forbidden,[]);assert.equal(state.executions,0);
 assert.deepEqual(state.budget,seed.budget);assert.deepEqual(state.episode,seed.episode);assert.deepEqual(state.identityRecords.slice(0,seed.identityRecords.length),seed.identityRecords);
 if(scenario!=='unknown')assert.equal(state.runs[0].status,'blocked');stages.push(state);
 if(process.env.IDENTITY_SCHEDULING_OUTPUT){fs.mkdirSync(process.env.IDENTITY_SCHEDULING_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.IDENTITY_SCHEDULING_OUTPUT,scenario+'.json'),JSON.stringify({passed:true,scenario,stages},null,2)+'\n');}
});
test('A10/A11 formal Worker: unresolved identity permits retained local recovery and source association',async t=>{
 const f=await fixture(t,'local_recovery'),seed=await f.engine.dispatch('controlledIdentityObserve');assert.equal(seed.identityDecision.action,'reconcile');assert.equal(seed.policy.action.tool,'recover_platform_result');
 const state=await f.engine.dispatch('controlledIdentityTick',{advanceMs:0});assert.equal(state.audit.identity,0);assert.equal(state.audit.business,0);assert.equal(state.audit.models,0);assert.deepEqual(state.audit.forbidden,[]);
 assert.equal(state.recovery.operation.status,'done',JSON.stringify(state));assert.equal(state.recovery.source.associated,true);assert.ok(state.runs[0].steps.some(s=>s.tool==='recover_platform_result'));assert.ok(state.runs[0].steps.some(s=>s.tool==='plan_task'));
 assert.deepEqual(state.identityRecords,seed.identityRecords);assert.equal(state.episode.cycles,seed.episode.cycles);
 await f.restart();const cold=await f.engine.dispatch('controlledIdentityObserve');assert.deepEqual(counts(cold),counts(state));assert.equal(cold.recovery.source.associated,true);
 if(process.env.IDENTITY_SCHEDULING_OUTPUT){fs.mkdirSync(process.env.IDENTITY_SCHEDULING_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.IDENTITY_SCHEDULING_OUTPUT,'local_recovery.json'),JSON.stringify({passed:true,scenario:'local_recovery',boundary:'local recovery and source association, then cold-load observation only; later legal consumption is tested separately',stages:[seed,state,cold]},null,2)+'\n');}
});
