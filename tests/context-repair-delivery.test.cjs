'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const fixture=require('../scripts/root-delivery-fixture.cjs');
const pending=require('../desktop/pending-check.cjs'),agent=require('../desktop/agent.cjs');
async function setup(t,repairVariant){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-repair-delivery-'));
 const f=await fixture.setup({scenario:'context_authorization_repair',repairVariant,options:{dir}});
 t.after(async()=>{await f.a.runPromise;fixture.dispose(f.a);fs.rmSync(dir,{recursive:true,force:true});});return f;
}
async function repair(f){
 const view=pending.view(f.a,f.job);assert.equal(view?.kind,'internal_context_authorization');
 const input={id:f.job.id,...view};await f.a.dispatch('uiCommand',{action:'agentCheckResume',input});return input;
}
test('controlled/notproduction: persisted false permission cold upgrade -> trusted command -> bounded original check -> same-target delivery',async t=>{
 const f=await setup(t),before=fixture.contextRepairState(f),baseline=f.baseline.contextRepair;
 assert.equal(before.jobStatus,'needs_input');assert.equal(before.lastError,'');assert.equal(before.failedRun.modelCalls,20);
 assert.equal(before.continuation.episodes[baseline.episode.basis].pendingCheck.status,'claimed');
 assert.ok(before.continuation.episodes[baseline.episode.basis].pendingCheck.interruption.at<before.failedRun.startedAt);
 f.reopen();fixture.assertContextRepairRestored(before,fixture.contextRepairState(f));
 const input=await repair(f),after=fixture.contextRepairState(f);
 for(const key of ['primary','efficiency','reads','generationReads','ledger','policies','goal','contract','failedRun','modelCalls','artifacts','contextFinalizations'])assert.deepEqual(after[key],before[key],key);
 assert.equal(after.decision.status,'superseded');assert.equal(after.decision.answer,undefined);assert.equal(after.jobStatus,'ready');
 assert.deepEqual(after.continuation.episodes[baseline.episode.basis].pendingCheck,before.continuation.episodes[baseline.episode.basis].pendingCheck);
 const saved=fs.readFileSync(f.a.file);await f.a.dispatch('uiCommand',{action:'agentCheckResume',input});assert.deepEqual(fs.readFileSync(f.a.file),saved);
 f.reopen();assert.deepEqual(fixture.contextRepairState(f),after,'committed repair must replay without dispatch');
 f.a.automaticExecution=true;await agent.run(f.a,f.job.id);
 fixture.assertComplete(f);
 assert.equal(f.audit.events.filter(e=>e.kind==='context_repair_first_bounded').length,1);
 assert.equal(f.audit.modelInputs[0].role,'verify');
});
test('controlled/notproduction: manual pause survives repair and cold load with zero new requests',async t=>{
 const f=await setup(t,'paused');f.reopen();await repair(f);const before=fixture.contextRepairState(f);
 f.a.tick();await f.a.runPromise;assert.equal(f.audit.modelInputs.length,0);assert.equal(f.audit.connectorCalls.filter(c=>!c.baseline).length,0);
 f.reopen();fixture.assertContextRepairRestored(before,fixture.contextRepairState(f));f.a.tick();await f.a.runPromise;assert.equal(f.audit.modelInputs.length,0);
 assert.equal(f.a.data.stewardship.paused,true);assert.deepEqual(fixture.contextRepairState(f),before);
});
for(const variant of ['consumed','unknown','unknown_before_check','usage_conflict','later_owner'])test('controlled/notproduction: '+variant+' historical failure cannot obtain repair or dispatch',async t=>{
 const f=await setup(t,variant),before=fixture.contextRepairState(f);assert.equal(before.view,null);
 f.reopen();assert.deepEqual(fixture.contextRepairState(f),before);assert.equal(pending.view(f.a,f.job),null);
 await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input:{id:f.job.id,proofId:'unproved',decisionId:before.decision.id,expectedRevision:f.a.data.runtime.revision,expectedWorkRevision:f.job.workRevision??1,expectedTaskRevision:f.task.workRevision??1}}));
 assert.equal(agent.tick(f.a),false);assert.deepEqual(fixture.contextRepairState(f),before);
 assert.equal(f.audit.modelInputs.length,0);assert.equal(f.audit.platformCalls.length,0);assert.equal(f.audit.connectorCalls.filter(c=>!c.baseline).length,0);
});
