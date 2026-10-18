'use strict';
// I1 regression: real Assistant/policy/strategy/dispatch/journal/authority.
// Only the clock, model output and platform transport are controlled.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,deny}=require('./root-relation-fixture.cjs');
const agent=require('../desktop/agent.cjs'),identity=require('../desktop/evidence-identity-preflight.cjs');
const policy=require('../desktop/execution-policy.cjs'),work=require('../desktop/work-efficiency.cjs');
const authority=require('../desktop/access-policy-store.cjs');
const dispose=a=>require('../desktop/deadline-scheduler.cjs').dispose(a);
const clone=structuredClone;
function setup(t,code='TRANSIENT',{replaceMarker=false}={}){
 t.mock.timers.enable({apis:['Date']});
 const f=fixture(t),{a,job,task}=f,counters={models:0,identity:0};
 for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])t.mock.method(require('node:child_process'),name,deny);
 task.needsReplan='按当前已批准范围补证';job.maxActions=6;
 let current=a,currentJob=job,atRequest;
 const chat=async()=>{counters.models++;return {tool:'platform_query',args:{queries:[{op:'projects'}]}};};
 const request=async args=>{
  assert.deepEqual(args,require('../desktop/data-platform.cjs').command({op:'identity'}),'Business transport forbidden');
  counters.identity++;
  const active=currentJob.executionState.workEfficiency.active;
  if(replaceMarker)active.inFlight={...active.inFlight,at:'2000-01-01T00:00:00.000Z'};
  atRequest=clone(currentJob.executionState.workEfficiency);
  throw Object.assign(Error('controlled identity '+code),{code});
 };
 a.chat=chat;a.platformRequest=request;
 work.request(a,job,{code:'NO_NEW_EVIDENCE',message:'controlled existing strategy recovery',taskId:task.id});a.save();
 return {
  counters,get a(){return current;},get job(){return currentJob;},get atRequest(){return atRequest;},
  run:()=>agent.run(current,currentJob.id),
  restart(){dispose(current);current=new (require('../desktop/core.cjs').Assistant)({dir:f.dir,chat,connectorRequest:deny,webRequest:deny});current.platformRequest=request;t.after(()=>dispose(current));currentJob=current.data.delegations.find(j=>j.id===job.id);},
  observe(){return clone({work:currentJob.executionState.workEfficiency,identity:currentJob.executionState.identityPreflights,runs:current.data.agentRuns,calls:currentJob.callsUsed,budget:current.spendLedger,authority:authority.describePlatformIdentity(current,currentJob),operations:currentJob.executionState.operations,attempts:require('../desktop/evidence-item-lifecycle.cjs').allAttempts(currentJob)});}
 };
}
for(const cold of [false,true])test('I1 '+(cold?'cold':'warm')+' terminal identity failure preserves strategy and exact bounded retry',async t=>{
 const f=setup(t);await f.run();
 assert.deepEqual(f.counters,{models:1,identity:1});
 const expectedWork=clone(f.atRequest);delete expectedWork.active.inFlight;
 assert.deepEqual(f.job.executionState.workEfficiency,expectedWork,'Only the completed step marker is cleared');
 const first=f.observe(),retryAt=policy.inspect(f.a,f.job).resumeAt;
 assert.equal(Date.parse(retryAt)-Date.now(),15000);assert.equal(first.runs[0].steps.length,1);
 assert.equal(first.runs[0].steps[0].strategyRecovery.id,first.work.active.id);
 assert.equal(Object.values(first.identity).flat()[0].status,'failed');
 if(cold)f.restart();
 assert.deepEqual(f.observe(),first,'Cold load preserves history, authority, budget, attempts and runs');
 assert.equal(policy.inspect(f.a,f.job).resumeAt,retryAt);
 await f.run();t.mock.timers.tick(14999);await f.run();
 assert.deepEqual(f.observe(),first,'Before retryAt no planning, request, run or attempt is created');
 t.mock.timers.tick(1);await f.run();
 assert.deepEqual(f.counters,{models:2,identity:2});
 const second=f.observe(),rows=Object.values(second.identity).flat();
 assert.deepEqual(rows[0],Object.values(first.identity).flat()[0]);
 assert.deepEqual(second.runs.map(r=>[r.status,r.steps.length]),[['retry',1],['retry',1]]);
 assert.equal(second.work.active.id,first.work.active.id);assert.equal(second.work.active.basis,first.work.active.basis);
 assert.equal(second.work.active.inFlight,undefined);assert.deepEqual(second.work.history,first.work.history);
 assert.deepEqual(second.work.tried,first.work.tried);assert.equal(second.work.attempts,first.work.attempts);
 assert.deepEqual(second.work.active.actionKeys.slice(0,1),first.work.active.actionKeys);
 assert.equal(second.calls,first.calls+1);assert.deepEqual(second.authority,first.authority);
 const budget1=first.budget.scopes['job:'+f.job.id],budget2=second.budget.scopes['job:'+f.job.id];
 for(const k of ['id','limitUSD','approvals'])assert.deepEqual(budget2[k],budget1[k]);
 // The existing meter explicitly acknowledges each zero-priced fixture call.
 assert.equal(budget2.unknownAcknowledged,budget1.unknownAcknowledged+1);
 assert.equal(budget2.usage.unknownCalls,budget1.usage.unknownCalls+1);assert.ok(budget2.spentUSD>=budget1.spentUSD);
 assert.equal(Date.parse(policy.inspect(f.a,f.job).resumeAt)-Date.now(),60000);
 t.mock.timers.tick(59999);await f.run();assert.deepEqual(f.observe(),second);
 t.mock.timers.tick(1);await f.run();assert.deepEqual(f.counters,{models:3,identity:3});
 assert.equal(identity.inspect(f.a,f.job).decision.failureCount,3);assert.equal(policy.inspect(f.a,f.job).eligible,false);
 const capped=f.observe();if(cold)f.restart();t.mock.timers.tick(86400000);await f.run();await f.run();
 assert.deepEqual(f.counters,{models:3,identity:3});assert.deepEqual(f.observe(),capped);
 assert.equal(f.job.executionState.workEfficiency.active.id,first.work.active.id);
 assert.equal(f.job.executionState.workEfficiency.history.length,0);
});
test('I1 permanent terminal identity remains blocked across cold restart without consuming its strategy',async t=>{
 const f=setup(t,'AUTH_REQUIRED');await f.run();const before=f.observe();
 assert.equal(before.work.active.inFlight,undefined);assert.equal(identity.inspect(f.a,f.job).decision.action,'diagnose');
 f.restart();t.mock.timers.tick(86400000);await f.run();
 assert.deepEqual(f.observe(),before);assert.deepEqual(f.counters,{models:1,identity:1});
});
test('I1 real unresolved identity dispatch retains inFlight and cold interrupted protection without resend',async t=>{
 // A transport/storage uncertainty after the real dispatch boundary has no
 // durable terminal. Do not reinterpret it as a completed step or grant retry.
 const f=setup(t,'EIO');await f.run();const before=f.observe();
 assert.ok(before.work.active.inFlight);assert.deepEqual(before.work,f.atRequest);
 assert.equal(Object.values(before.identity).flat()[0].status,'dispatched');
 assert.equal(identity.inspect(f.a,f.job).decision.action,'reconcile');
 f.restart();assert.equal(f.job.executionState.workEfficiency.active,undefined);
 const history=f.job.executionState.workEfficiency.history;
 assert.equal(history.at(-1).outcome,'interrupted');assert.deepEqual(history.at(-1).inFlight,before.work.active.inFlight);
 t.mock.timers.tick(86400000);await f.run();await f.run();
 assert.deepEqual(f.counters,{models:1,identity:1});assert.equal(identity.inspect(f.a,f.job).decision.action,'reconcile');
 const after=f.observe();for(const k of ['identity','runs','budget','authority','operations','attempts'])assert.deepEqual(after[k],before[k]);
});
test('I1 terminal failure never clears a replacement strategy inFlight marker',async t=>{
 const f=setup(t,'TRANSIENT',{replaceMarker:true});await f.run();
 assert.deepEqual(f.job.executionState.workEfficiency,f.atRequest);
 assert.equal(identity.inspect(f.a,f.job).decision.action,'wait_until');
 assert.equal(Object.values(f.job.executionState.identityPreflights).flat()[0].status,'failed');
});
