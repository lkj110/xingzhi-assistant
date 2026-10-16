const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const work=require('../desktop/work-efficiency.cjs'),efficiency=require('../desktop/efficiency.cjs'),repair=require('../desktop/repair-progress.cjs');
const protocol=require('../desktop/protocol-access.cjs');
const prohibited=async()=>{throw Error('Network/model access prohibited');};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-work-efficiency-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited,platformRequest:prohibited});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const job=agent.buildJob(a,{goal:'核对订单发布日期并形成报告',maxActions:1});a.data.delegations.push(job);
 const task=a.createTask({title:'报告',criteria:'记录订单发布日期',steps:[{title:'正文',kind:'draft'}]});task.agentJobId=job.id;job.taskIds=[task.id];
 const source=agent.source(a,job,'orders','订单','订单在周五发布');task.sourceIds=[source.id];protocol.retain(a,'source',source,{task,job});
 a.save();return {a,job,task,source,dir};
}
function artifact(f,content='订单在周五发布。'){
 const step=f.task.steps[0],r={id:require('node:crypto').randomUUID(),taskId:f.task.id,stepId:step.id,title:'正文',content};
 f.a.data.artifacts.push(r);step.done=true;step.artifactId=r.id;protocol.retain(f.a,'artifact',r,{task:f.task,job:f.job});return r;
}
function idle(f,tool='read_source'){return work.observe(f.a,f.job,{tool,args:{sourceId:f.source.id,start:1}});}
test('new page cursors, plan state changes and explanations cannot renew a durable budget',t=>{
 const f=fixture(t);work.before(f.a,f.job);const budget={maxCalls:f.job.maxCalls,maxSpendUSD:f.job.maxSpendUSD,callsUsed:f.job.callsUsed};
 for(let i=1;i<=work.LIMITS.stopAt;i++){
  f.task.criteria='模型重写说明 '+i;f.task.status=i%2?'todo':'blocked';f.task.waitingOn='重写解释 '+i;f.task.verification={passed:i%2===0};
  f.task.steps[0].done=i%2===0;f.job.executionContract={text:f.job.goal,revision:String(i)};
  const result=idle(f,['read_source','plan_task','revise_task'][i%3]);
  assert.equal(result.attempts,i);if(i===work.LIMITS.suggestAt)assert.equal(result.phase,'change_strategy');
 }
 assert.equal(f.job.status,'ready');assert.notEqual(f.job.executionPaused,true);assert.equal(work.inspect(f.job).phase,'recovery_pending');
 assert.equal(f.a.data.decisions.length,0);assert.deepEqual({maxCalls:f.job.maxCalls,maxSpendUSD:f.job.maxSpendUSD,callsUsed:f.job.callsUsed},budget);
 f.a.save();const restored=new Assistant({dir:f.dir,chat:prohibited}),job=restored.data.delegations.find(j=>j.id===f.job.id);
 efficiency.resetProgress(job);job.status='ready';job.executionPaused=false;
 assert.equal(work.before(restored,job).allowed,false);assert.throws(()=>work.assertAllowed(restored,job),{code:'WORK_STRATEGY_CHANGE'});
 assert.equal(job.executionState.workEfficiency.attempts,work.LIMITS.stopAt);
});
test('real new requirements renew the work context; repeated feedback timestamps and authorization do not',t=>{
 const f=fixture(t);work.before(f.a,f.job);for(let i=0;i<work.LIMITS.stopAt;i++)idle(f);
 f.job.feedback.push({text:'已授权',origin:'authorization'});assert.equal(work.before(f.a,f.job).allowed,false);
 f.job.feedback.push({text:'新增要求：增加周六延期原因',kind:'user_feedback'});assert.equal(work.before(f.a,f.job).allowed,true);
 assert.notEqual(f.job.executionPaused,true);assert.equal(f.job.executionState.workEfficiency.attempts,0);idle(f);
 f.job.feedback.push({text:'新增要求：增加周六延期原因',kind:'user_feedback',at:'2099-01-01'});assert.equal(work.before(f.a,f.job).attempts,1);
});
test('fresh scoped facts and valid completed output reset; replays, deletion and unrelated sources do not',t=>{
 const f=fixture(t);work.before(f.a,f.job);idle(f);idle(f);
 agent.source(f.a,f.job,'unrelated','体育','无关比赛结果');assert.equal(work.before(f.a,f.job).attempts,2);
 f.source.content='订单改为周六发布';assert.equal(work.before(f.a,f.job).attempts,0);idle(f);
 f.source.content='订单在周五发布';assert.equal(work.before(f.a,f.job).attempts,1);
 const r=artifact(f);assert.equal(work.before(f.a,f.job).attempts,0);idle(f);
 f.task.steps[0].done=false;assert.equal(work.before(f.a,f.job).attempts,1);f.task.steps[0].done=true;assert.equal(work.before(f.a,f.job).attempts,1);
 f.a.data.artifacts.push({...r,id:'same-content'});f.task.steps[0].artifactId='same-content';protocol.retain(f.a,'artifact',f.a.data.artifacts.at(-1),{task:f.task,job:f.job});assert.equal(work.before(f.a,f.job).attempts,1);
});
test('linking preexisting source pages through repeated plans is not new business output',t=>{
 const f=fixture(t);work.before(f.a,f.job);
 const unrelated=agent.source(f.a,f.job,'another','另一资料','仅改变关联');f.task.sourceIds.push(unrelated.id);protocol.retain(f.a,'source',unrelated,{task:f.task,job:f.job});
 assert.equal(idle(f,'plan_task').attempts,1);assert.equal(work.before(f.a,f.job).attempts,1);
});
test('stale, denied, unfinished artifacts and unverified receipts never count as results',t=>{
 const f=fixture(t);work.before(f.a,f.job);idle(f);
 const r=artifact(f);r.stale=true;assert.equal(work.before(f.a,f.job).attempts,1);r.stale=false;f.task.steps[0].done=false;assert.equal(work.before(f.a,f.job).attempts,1);
 f.a.data.agentActions.push({id:'unverified',taskId:f.task.id,jobId:f.job.id,status:'done',artifactId:r.id,content:r.content,result:{verified:false,path:'/unused'}});
 assert.equal(work.before(f.a,f.job).attempts,1);f.task.steps[0].done=true;f.a.contextAccessCheck=()=>({decision:'deny'});assert.equal(work.before(f.a,f.job).attempts,1);
});
test('efficiency hooks yield alternating unique actions to automatic strategy correction',t=>{
 const f=fixture(t);
 for(let i=0;i<work.LIMITS.stopAt;i++){
  const step={tool:'read_source',args:{sourceId:f.source.id,start:i}},before=efficiency.progress(f.a,f.job);
  efficiency.action(f.a,f.job,step);efficiency.checkProgress(f.a,f.job,step,before);
 }
 assert.notEqual(f.job.status,'paused');assert.equal(f.a.data.decisions.length,0);assert.equal(work.next(f.a,f.job).action,null);
});
test('repair checks with wholly different gap text remain bounded across restarts',t=>{
 const f=fixture(t);work.before(f.a,f.job);const labels=['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima'];
 for(let i=0;i<work.LIMITS.stopAt;i++){
  const run=()=>repair.check(f.a,f.job,{tool:'complete',args:{},result:{complete:false,gaps:[labels[i]]}});
  if(i<work.LIMITS.stopAt-1)run();else assert.throws(run,e=>e.noProgress);
 }
 assert.equal(f.job.repairProgress.goal.attempts,12);assert.ok(f.job.repairProgress.goal.suggestion);assert.notEqual(f.job.status,'paused');assert.equal(f.a.data.decisions.length,0);
});
test('worker read_context loop stops within one action, persists across restart, and view is read-only',t=>{
 const f=fixture(t),data=JSON.stringify(f.a.data);assert.equal(work.view(f.a,f.job).attempts,0);assert.equal(JSON.stringify(f.a.data),data);
 work.before(f.a,f.job);
 for(let n=1;n<=work.LIMITS.stopAt;n++){
  const result=work.observeCall(f.a,f.job,{taskId:f.task.id,role:'verify',result:{kind:'read_context',requests:[{tool:'read_source',sourceId:f.source.id,start:n}]}});
  assert.equal(result.attempts,n);assert.equal(result.allowed,n<work.LIMITS.stopAt);
 }
 f.a.save();const a=new Assistant({dir:f.dir,chat:prohibited}),job=a.data.delegations.find(j=>j.id===f.job.id);
 assert.equal(work.before(a,job).allowed,false);assert.throws(()=>work.assertAllowed(a,job),e=>e.workEfficiency&&e.requiresConfirmation===false);
 assert.equal(a.data.decisions.length,0);assert.equal((a.data.modelCalls||[]).length,0);
});
test('a terminal model claim is not effective output; readAttempt validates ownership',t=>{
 const f=fixture(t);work.before(f.a,f.job);work.readAttempt(f.a,f.job,{taskId:f.task.id});
 const result=work.observeCall(f.a,f.job,{taskId:f.task.id,result:{kind:'artifact',content:'not saved'}});assert.equal(result.attempts,1);
 assert.throws(()=>work.readAttempt(f.a,f.job,{taskId:'foreign'}));assert.equal(work.view(f.a,f.job).attempts,1);
});
test('inspect is a detached read-only projection suitable for parent context',t=>{
 const f=fixture(t),before=JSON.stringify(f.a.data);assert.equal(work.inspect(f.job).allowed,true);assert.equal(JSON.stringify(f.a.data),before);
 work.before(f.a,f.job);for(let n=0;n<work.LIMITS.suggestAt;n++)idle(f);
 const result=work.inspect(f.job);result.suggestion.message='external mutation';assert.notEqual(work.inspect(f.job).suggestion.message,'external mutation');
});
