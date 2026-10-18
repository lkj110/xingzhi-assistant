'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const fixture=require('../scripts/root-delivery-fixture.cjs'),agent=require('../desktop/agent.cjs');
test('C13 controlled: pause during revised content check, cold restore, same-target delivery without old-counter handoff',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'system-pause-delivery-'));
 const f=await fixture.setup({options:{dir},scenario:'pause_during_check'});t.after(()=>{fixture.dispose(f.a);fs.rmSync(dir,{recursive:true,force:true});});
 f.a.automaticExecution=true;await agent.run(f.a,f.job.id);
 assert.equal(f.audit.pauseInjected,true,fixture.compactFailure(f));
 assert.equal(f.a.data.stewardship.paused,true);assert.equal(f.a.data.decisions.filter(d=>d.status==='open').length,0,fixture.compactFailure(f));
 const state=f.job.executionState.continuation,e=state.episodes[state.activeBasis],primary=f.task.primaryArtifactId;
 assert.ok(state.activeTaskId,'pause cannot hand off original owner');assert.equal(e.cycles,f.audit.legacyCounters.cycles);assert.equal(e.pendingCheck.status,'interrupted');
 assert.equal(f.job.executionState.workEfficiency.attempts,18);assert.equal(f.audit.connectorCalls.filter(c=>c.args[1]==='+update').length,0);
 const claimId=e.pendingCheck.claimId,generated=f.audit.events.filter(e=>e.kind==='revision_generated').length,calls=f.audit.modelInputs.length;
 f.reopen();f.a.automaticExecution=true;assert.equal(f.a.data.stewardship.paused,true);assert.equal(agent.tick(f.a),false);assert.equal(f.audit.modelInputs.length,calls);
 await f.a.dispatch('stewardshipResume',{});await agent.run(f.a,f.job.id);
 fixture.assertComplete(f);assert.equal(f.task.primaryArtifactId,primary);assert.equal(f.audit.events.filter(e=>e.kind==='revision_generated').length,generated);
 const restored=Object.values(f.job.executionState.continuation.episodes).find(e=>e.pendingCheck?.claimId===claimId);
 assert.equal(restored.pendingCheck.status,'settled');assert.equal(restored.cycles,e.cycles);
 // Successful content and actual delivery can reset consecutive no-progress;
 // pause and cold restoration above demonstrably did not reset the old 18.
 assert.ok(f.audit.checks.some(c=>c.kind==='content'&&c.passed));
});
