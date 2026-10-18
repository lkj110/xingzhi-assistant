'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const agent=require('../desktop/agent.cjs');
const fixture=require('../scripts/root-delivery-fixture.cjs');

async function setup(t,scenario='success'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-delivery-pipeline-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  // Fail closed even if a future implementation bypasses injected transports.
  const denied=()=>{throw Error('Real network forbidden in root delivery integration');};
  for(const [object,key] of [[globalThis,'fetch'],[require('node:net').Socket.prototype,'connect'],[require('node:child_process'),'spawn'],[require('node:child_process'),'execFile']])t.mock.method(object,key,denied);
  const f=await fixture.setup({options:{dir},scenario});t.after(()=>fixture.dispose(f.a));return f;
}

test('real Agent loop: old Lark receipt → failed check → 19 sources → atomic rebind/reopen → six consumed reads → revise → verify → same Lark readback → review',async t=>{
  const f=await setup(t);await agent.run(f.a,f.job.id);
  t.diagnostic(JSON.stringify(fixture.assertComplete(f)));
  const steps=f.a.data.agentRuns[0].steps;
  assert.equal(steps.filter(s=>s.tool==='platform_query').length,2);
  assert.equal(steps.filter(s=>s.tool==='plan_task').length,1);
  assert.equal(steps.filter(s=>s.tool==='advance_task').length,2,'one real revision and one final result check');
  assert.ok(steps.every(s=>!s.error),fixture.compactFailure(f));
  const event=require('../desktop/work-journal.cjs').read(f.a).events.filter(e=>e.type===require('../desktop/evidence-continuation.cjs').TYPE&&e.payload?.inputsChanged);
  assert.equal(event.length,1,'19-source association must have one replayable commit');
});

test('uncertain update keeps the original action and reconciles with reads, never a second write',async t=>{
  const f=await setup(t,'uncertain');await agent.run(f.a,f.job.id);
  assert.deepEqual(f.audit.violations,[],fixture.compactFailure(f));
  const action=f.a.data.agentActions.find(r=>r.tool==='lark_update');
  assert.ok(action,fixture.compactFailure(f));assert.equal(action.status,'uncertain');assert.notEqual(f.job.status,'review');
  const id=action.id,runsBefore=f.a.data.agentRuns.length,readsBefore=f.audit.connectorCalls.filter(c=>c.args[1]==='+fetch').length;
  await agent.run(f.a,f.job.id);
  assert.ok(f.a.data.agentRuns.length>runsBefore&&f.audit.connectorCalls.filter(c=>c.args[1]==='+fetch').length>readsBefore,'uncertain external action must reach the existing read-only reconciliation branch, not be vetoed by the pre-run continuation guard\n'+fixture.compactFailure(f));
  assert.equal(f.a.data.agentActions.find(r=>r.id===id).status,'done',fixture.compactFailure(f));
  fixture.assertComplete(f);
});

test('mismatched remote body never reaches review and never silently republishes',async t=>{
  const f=await setup(t,'readback_mismatch');await agent.run(f.a,f.job.id);
  assert.deepEqual(f.audit.violations,[],fixture.compactFailure(f));
  assert.equal(f.audit.readBatches.length,6,fixture.compactFailure(f));
  assert.equal(f.audit.connectorCalls.filter(c=>c.args[1]==='+update').length,1,fixture.compactFailure(f));
  assert.notEqual(f.job.status,'review');assert.notEqual(f.task.status,'completed');assert.equal(f.task.acceptedAt??null,null);
  assert.ok(!f.audit.checks.some(c=>c.kind==='goal'&&c.passed));
  await agent.run(f.a,f.job.id);
  assert.equal(f.audit.connectorCalls.filter(c=>c.args[1]==='+update').length,1,'unresolved readback must not duplicate the write');
  assert.notEqual(f.job.status,'review');
});
