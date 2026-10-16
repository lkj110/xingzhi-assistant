const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),execution=require('../desktop/execution.cjs'),runtime=require('../desktop/runtime.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const until=async fn=>{for(let i=0;i<1000;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}assert.fail('expected observable progress');};
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-parallel-')),calls=[];
  const a=new Assistant({dir,chat:async(p,k,m,o)=>{
    const call={context:JSON.parse(m[1].content),options:o,gate:deferred()};calls.push(call);
    await Promise.race([call.gate.promise,new Promise((_,reject)=>{if(o.signal.aborted)reject(o.signal.reason);else o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true});})]);
    o.onUsage({inputTokens:call.tokens||100,outputTokens:20});return {tool:'ask',args:{question:'请选择 '+call.context.goal}};
  }});
  t.after(async()=>{a.stop();await a.runPromise;fs.rmSync(dir,{recursive:true,force:true});});
  await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:1,outputPrice:2});
  return {a,calls};
}
async function start(a,goal){await a.dispatch('agentCreate',{goal,allowWeb:false,maxActions:1});return a.data.delegations.find(j=>j.goal===goal);}
test('Independent jobs overlap, retain their own models/tokens/budgets, and settle out of order',async t=>{
  const {a,calls}=await fixture(t),one=await start(a,'first'),two=await start(a,'second');await until(()=>calls.length===2);
  assert.equal(a.publicState().operations.length,2);assert.equal(a.operation.count,2);assert.equal(a.activeAgentJob,undefined);
  calls[1].tokens=200;calls[1].gate.resolve();await until(()=>two.status==='needs_input');
  assert.equal(one.status,'running');assert.equal(a.spendLedger.scopes['job:'+two.id].usage.inputTokens,200);assert.ok(a.spendLedger.scopes['job:'+one.id].heldUSD>0);
  calls[0].tokens=300;calls[0].gate.resolve();await a.runPromise;
  for(const [j,n] of [[one,300],[two,200]]){const scope=a.spendLedger.scopes['job:'+j.id];assert.equal(scope.usage.inputTokens,n);assert.equal(scope.limitUSD,100);assert.equal(scope.heldUSD,0);assert.equal(j.callsUsed,1);const row=a.data.modelCalls.find(r=>r.jobId===j.id);assert.equal(row.spendScope,scope.key);assert.equal(row.inputTokens,n);assert.equal(a.data.agentRuns.find(r=>r.jobId===j.id).modelCallsDetail[0].inputTokens,n);}
  assert.equal(a.operation,null);assert.equal(a.controller,null);
});
test('Automatic scheduler starts all due independent jobs and never starts the same job twice',async t=>{
  const {a,calls}=await fixture(t);a.data.delegations.push(...['a','b','c'].map(goal=>agent.buildJob(a,{goal,maxActions:1})));
  a.tick();await until(()=>calls.length===3);a.tick();assert.equal(calls.length,3);await assert.rejects(a.dispatch('agentRun',{id:a.data.delegations[0].id}),/正在推进/);
  calls.forEach(c=>c.gate.resolve());await a.runPromise;assert.ok(a.data.delegations.every(j=>j.status==='needs_input'));
});
test('Pausing one job aborts only its request; answering another job is available while work continues',async t=>{
  const {a,calls}=await fixture(t),one=await start(a,'a'),two=await start(a,'b');await until(()=>calls.length===2);
  await a.dispatch('agentPause',{id:one.id});await until(()=>a.data.agentRuns.find(r=>r.jobId===one.id).finishedAt);
  assert.equal(one.status,'paused');assert.equal(calls[1].options.signal.aborted,false);assert.equal(two.status,'running');
  await a.dispatch('agentFeedback',{id:one.id,note:'保留暂停并补充要求'});assert.equal(one.status,'paused');
  calls[1].gate.resolve();await a.runPromise;assert.equal(two.status,'needs_input');
});
test('A blocked budget cannot block unrelated work or inherit its budget',async t=>{
  const {a,calls}=await fixture(t),one=agent.buildJob(a,{goal:'budget',maxActions:1}),two=agent.buildJob(a,{goal:'normal',maxActions:1});a.data.delegations.push(one,two);
  a.activeAgentJob=one;const scope=require('../desktop/spend.cjs').scope(a);scope.spentUSD=100;a.activeAgentJob=null;
  a.tick();await until(()=>calls.length===1);assert.equal(one.status,'limited');assert.equal(calls[0].context.goal,'normal');calls[0].gate.resolve();await a.runPromise;assert.equal(two.status,'needs_input');assert.equal(scope.spentUSD,100);
});
test('Global pause drains current parallel batches and sleep restores every interrupted job except manual pauses',async t=>{
  const {a,calls}=await fixture(t),one=await start(a,'a'),two=await start(a,'b');await until(()=>calls.length===2);
  await a.dispatch('stewardshipPause');assert.ok(calls.every(c=>!c.options.signal.aborted));runtime.suspend(a);await a.runPromise;
  assert.equal(one.status,'paused');assert.equal(two.status,'paused');await a.dispatch('agentPause',{id:two.id});await runtime.resume(a);
  assert.equal(one.status,'ready');assert.equal(two.status,'paused');assert.equal(a.data.stewardship.paused,true);assert.equal(a.operation,null);
});
test('Shared project and same task are excluded while independent task scopes can run together',async t=>{
  const {a}=await fixture(t);const p={id:'project',name:'same'};a.data.projects.push(p);const first=deferred(),second=deferred();
  const one=agent.buildJob(a,{goal:'one',projectId:p.id}),two=agent.buildJob(a,{goal:'two',projectId:p.id});a.data.delegations.push(one,two);
  execution.launch(a,{jobId:one.id},'one',()=>first.promise);assert.throws(()=>execution.launch(a,{jobId:two.id},'two',()=>{}),/正在推进/);
  a.createTask({title:'独立',steps:[{title:'草稿',kind:'draft'}]});const task=a.data.tasks[0];execution.launch(a,{taskId:task.id},'task',()=>second.promise);assert.equal(a.publicState().operations.length,2);
  assert.throws(()=>execution.launch(a,{taskId:task.id},'again',()=>{}),/正在推进/);first.resolve();second.resolve();await a.runPromise;
});
test('Writes to one destination serialize, another destination proceeds, and a cancelled waiter never writes',async t=>{
  const {a}=await fixture(t),gate=deferred(),events=[];const one=execution.withWrite(a,'same',async()=>{events.push('first');await gate.promise;});
  await until(()=>events.length===1);const two=execution.withWrite(a,'same',()=>events.push('second')),three=execution.withWrite(a,'other',()=>events.push('other'));await three;assert.deepEqual(events,['first','other']);gate.resolve();await Promise.all([one,two]);assert.deepEqual(events,['first','other','second']);
  const hold=deferred(),entered=deferred();const waiting=execution.withWrite(a,'same',()=>{entered.resolve();return hold.promise;});await entered.promise;a.controller=new AbortController();const cancelled=execution.withWrite(a,'same',()=>events.push('must not write'));a.controller.abort();hold.resolve();await waiting;await assert.rejects(cancelled);a.controller=null;assert.ok(!events.includes('must not write'));
});
test('Stopping everything cancels all workers and preserves per-job reservations through restart',async t=>{
  const {a,calls}=await fixture(t);await start(a,'a');await start(a,'b');await until(()=>calls.length===2);const original=Object.values(a.spendLedger.scopes).map(s=>({key:s.key,held:s.heldUSD}));a.stop();await a.runPromise;
  assert.ok(a.data.delegations.every(j=>j.status==='paused'));assert.equal(a.operation,null);const b=new Assistant({dir:a.dir});for(const s of original){assert.equal(b.spendLedger.scopes[s.key].heldUSD,s.held);assert.equal(b.spendLedger.scopes[s.key].limitUSD,100);}assert.equal(b.data.stewardship.paused,true);
});
test('Newly due information collection drains current batches instead of starving behind endless continuations',async t=>{
  const {a,calls}=await fixture(t);await start(a,'first');await until(()=>calls.length===1);
  const next=agent.buildJob(a,{goal:'later',maxActions:1});a.data.delegations.push(next);
  a.data.webConnections.push({id:'due',enabled:true,nextRunAt:new Date(0).toISOString()});a.tick();assert.equal(next.status,'ready');assert.equal(calls.length,1);
  a.data.webConnections=[];a.tick();await until(()=>calls.length===2);calls.forEach(c=>c.gate.resolve());await a.runPromise;
});
test('A launch that cannot persist does not issue a model request after the caller sees a failure',async t=>{
  const {a,calls}=await fixture(t),job=agent.buildJob(a,{goal:'no send'});a.data.delegations.push(job);
  const save=a.save.bind(a);let failed=false;a.save=()=>{if(!failed){failed=true;throw Error('disk failure');}return save();};
  assert.throws(()=>execution.launch(a,{jobId:job.id},'test',view=>agent.run(view,job.id)),/disk failure/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);assert.equal(a.operation,null);
});
