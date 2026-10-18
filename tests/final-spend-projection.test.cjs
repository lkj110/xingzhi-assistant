const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs');
const state=require('../desktop/work-state.cjs'),control=require('../desktop/continuation-control.cjs'),agent=require('../desktop/agent.cjs');
for(const reason of ['storage','budget','unknown'])test('UI and dispatcher agree on real '+reason+' spend guard without mutation',t=>{
 const v=fixture(t);require('../desktop/work-efficiency.cjs').before(v.a,v.job);
 control.redirect(v.a,v.job,{tool:'plan_task',args:{existingTaskId:v.task.id}},{code:'PLAN_ALREADY_RECONCILED',taskId:v.task.id,message:'已协调'});
 if(reason==='storage')v.a.spendError='模拟账本无法读取';
 else{v.a.activeAgentJob=v.job;const s=require('../desktop/spend.cjs').scope(v.a);v.a.activeAgentJob=null;if(reason==='budget')s.spentUSD=s.limitUSD;else s.unreservedCalls=1;}
 const before=JSON.stringify([v.a.data,v.a.spendLedger]);const projected=state.view(v.a,v.job);
 assert.equal(control.ready(v.a,v.job),false);assert.equal(projected.gate.automaticAllowed,false);assert.equal(projected.phase,'blocked');assert.deepEqual(projected.nextActions,[]);assert.ok(projected.error.message);assert.equal(JSON.stringify([v.a.data,v.a.spendLedger]),before);
 assert.equal(agent.tick(v.a),false);
});
test('one task scope budget does not block independent sibling; user pause remains first',t=>{
 const v=fixture(t),other=v.a.createTask({title:'other',description:'x',criteria:'x',steps:[{title:'正文',kind:'draft'}]});other.agentJobId=v.job.id;v.job.taskIds.push(other.id);
 v.a.spendLedger.scopes['task:'+v.task.id]={spentUSD:100,heldUSD:0,limitUSD:100,unreservedCalls:0};
 assert.equal(state.gate(v.a,v.job,v.task).automaticAllowed,false);assert.equal(state.gate(v.a,v.job,other).automaticAllowed,true);
 v.job.status='paused';assert.equal(state.gate(v.a,v.job,v.task).reason,'paused');assert.equal(state.view(v.a,v.job).phase,'paused');
});
