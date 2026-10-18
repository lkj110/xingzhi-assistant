const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs');
const spend=require('../desktop/spend.cjs'),guard=require('../desktop/spend-guard.cjs'),work=require('../desktop/work-state.cjs'),control=require('../desktop/continuation-control.cjs');
function ready(t){const f=fixture(t);require('../desktop/work-efficiency.cjs').before(f.a,f.job);control.redirect(f.a,f.job,{tool:'plan_task',args:{existingTaskId:f.task.id}},{code:'PLAN_ALREADY_RECONCILED',taskId:f.task.id,message:'coordinated'});f.a.activeAgentJob=f.job;const s=spend.scope(f.a);f.a.activeAgentJob=null;return {...f,s};}

test('spend review: correcting provider pricing removes a stale pricing guard without spending',t=>{
 const {a,job,s}=ready(t),p=a.data.providers.find(p=>p.id==='fixture');
 p.inputPrice=null;p.outputPrice=null;a.activeAgentJob=job;
 assert.throws(()=>spend.reserve(a,p,[]),e=>e.spendKind==='pricing');
 p.inputPrice=0;p.outputPrice=0;
 assert.doesNotThrow(()=>spend.check(a));a.activeAgentJob=null;
 assert.equal(require('../desktop/agent-continuation.cjs').blocker(a,job),null);
 const before=JSON.stringify([a.data,a.spendLedger]),projected=work.view(a,job),blocked=guard.inspect(a,job),allowed=control.ready(a,job);
 assert.equal(JSON.stringify([a.data,a.spendLedger]),before,'inspection must not change ledger');
 // Prove the real reservation accepts the same repaired configuration locally.
 a.activeAgentJob=job;const ticket=spend.reserve(a,p,[]);spend.cancel(a,ticket);a.activeAgentJob=null;
 t.diagnostic(JSON.stringify({blocked,phase:projected.phase,allowed,spent:s.spentUSD}));
 assert.equal(blocked,null,'stale pricing diagnosis must not freeze a valid continuation');
 assert.equal(allowed,true);assert.equal(projected.phase,'ready');
});

const corruptions={
 'missing usage':s=>{delete s.usage;},'null usage':s=>{s.usage=null;},
 'NaN spent':s=>{s.spentUSD=NaN;},'null held':s=>{s.heldUSD=null;},
 'NaN unreserved':s=>{s.unreservedCalls=NaN;},'negative unreserved':s=>{s.unreservedCalls=-1;},'fractional unreserved':s=>{s.unreservedCalls=.5;},
 'legacy missing unknown counter':s=>{delete s.unreservedCalls;delete s.usage.unknownCalls;},
 'legacy null unknown counter':s=>{delete s.unreservedCalls;s.usage.unknownCalls=null;},
 'legacy NaN acknowledgement':s=>{delete s.unreservedCalls;s.unknownAcknowledged=NaN;},
};
for(const [name,mutate] of Object.entries(corruptions))test('spend review: '+name+' fails closed without allocating or clearing a ledger',t=>{
 const {a,job,s}=ready(t);mutate(s);const before=structuredClone([a.data,a.spendLedger]);
 const result=guard.inspect(a,job);assert.deepEqual([a.data,a.spendLedger],before);
 assert.equal(result?.code,'spend_storage');assert.equal(work.gate(a,job).automaticAllowed,false);assert.equal(control.ready(a,job),false);
});
test('spend review: a present null scope is corrupt, not a new unmetered scope',t=>{
 const {a,job,s}=ready(t);a.spendLedger.scopes[s.key]=null;const before=structuredClone(a.spendLedger);
 assert.equal(guard.inspect(a,job)?.code,'spend_storage');assert.deepEqual(a.spendLedger,before);
});
test('spend review: healthy unused scope and reserved unknown usage remain eligible and pure',t=>{
 const {a,job,s}=ready(t);s.usage.unknownCalls=1;s.heldUSD=1;s.unreservedCalls=0;
 const before=structuredClone([a.data,a.spendLedger]);assert.equal(guard.inspect(a,job),null);assert.equal(work.gate(a,job).automaticAllowed,true);assert.deepEqual([a.data,a.spendLedger],before);
 delete a.spendLedger.scopes[s.key];assert.equal(guard.inspect(a,job),null);assert.equal(Object.keys(a.spendLedger.scopes).length,0);
});
