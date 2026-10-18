'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture:rootFixture}=require('./root-relation-fixture.cjs');
const agent=require('../desktop/agent.cjs'),identity=require('../desktop/evidence-identity-preflight.cjs'),policy=require('../desktop/execution-policy.cjs'),authority=require('../desktop/access-policy-store.cjs'),journal=require('../desktop/work-journal.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
async function fixture(t,scenario='unknown'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'identity-assistant-'));
 const f=await require('../scripts/identity-scheduling-worker-fixture.cjs').setup({options:{dir:path.join(dir,'workspace')},reportFile:path.join(dir,'audit.json'),scenario});
 t.after(()=>{f.dispose();fs.rmSync(dir,{recursive:true,force:true});});return f;
}
for(const scenario of ['permanent','unknown','transient'])test('A1-A3 direct real Assistant: '+scenario+' no-growth projection and inspect purity',async t=>{
 const f=await fixture(t,scenario),{a,job,task}=f;let s=await a.dispatch('controlledIdentityTick',{});
 const before=hash(a.data),events=hash(journal.read(a).events),saved=fs.readFileSync(a.file),counts=[s.runCount,s.stepCount,s.attemptCount];
 const state=require('../desktop/work-state.cjs');for(let i=0;i<3;i++){
  const p=policy.inspect(a,job),j=state.workState(a,job),v=state.workState(a,task);assert.equal(p.eligible,false);assert.equal(j.phase,p.phase);assert.equal(v.phase,p.phase);assert.equal(j.executionPolicy.resumeAt,p.resumeAt);if(p.phase==='blocked'){assert.equal(j.error.code,p.reasonCode);assert.equal(v.error.code,p.reasonCode);}
 }
 assert.equal(hash(a.data),before);assert.equal(hash(journal.read(a).events),events);assert.deepEqual(fs.readFileSync(a.file),saved);
 s=await a.dispatch('controlledIdentityRun');assert.deepEqual([s.runCount,s.stepCount,s.attemptCount],counts);
});
test('A8 real ordinary planner identity failure stops once without repeated planner or business request',async t=>{
 const f=rootFixture(t),{a,job}=f;job.taskIds=[];a.data.tasks=[];job.maxActions=6;let models=0,requests=0;
 a.chat=async()=>{models++;return {tool:'platform_query',args:{queries:[{op:'projects'}]}};};a.platformRequest=async()=>{requests++;throw Object.assign(Error('controlled permanent'),{code:'INVALID_PLATFORM_RESPONSE'});};a.save();
 await agent.run(a,job.id);assert.equal(requests,1);assert.equal(models,1);assert.equal(a.data.agentRuns[0].steps.length,1);assert.equal(a.data.agentRuns[0].status,'blocked',JSON.stringify(a.data.agentRuns[0]));assert.equal(policy.inspect(a,job).eligible,false);
 const before=a.data.agentRuns.length;await agent.run(a,job.id);assert.equal(a.data.agentRuns.length,before);assert.equal(models,1);assert.equal(requests,1);
});
test('A8 ordinary business INVALID_PLATFORM_RESPONSE has no identity origin',async t=>{
 const f=rootFixture(t),{a,job}=f;job.taskIds=[];a.data.tasks=[];job.maxActions=1;let models=0;
 a.chat=async()=>{models++;return {tool:'platform_query',args:{queries:[{op:'projects'}]}};};a.platformRequest=async args=>{if(JSON.stringify(args)===JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'})))return {username:'fixture-user'};throw Object.assign(Error('business invalid response'),{code:'INVALID_PLATFORM_RESPONSE',preflight:true,identityPreflight:{origin:'platform_identity'}});};a.save();
 await agent.run(a,job.id);assert.equal(models,1);assert.equal(Object.values(job.executionState.identityPreflights).flat()[0].status,'done');assert.equal(a.data.agentRuns[0].steps[0].identityPreflight,undefined);assert.equal(identity.inspect(a,job).decision.action,'execute');
});
test('A9 policy select then history changes: claim rejects and never falls back to planner',async t=>{
 const f=await fixture(t,'permanent'),{a,job}=f;policy.prepare(a,job,{mode:'manual'});assert.equal(policy.inspect(a,job,{mode:'manual'}).eligible,true);
 const row=identity.begin(a,job);identity.dispatched(a,row);const before=f.observe();assert.throws(()=>policy.claim(a,job,{mode:'manual'}),{code:'POLICY_ADMISSION_CHANGED'});
 const after=await a.dispatch('controlledIdentityRun');assert.equal(after.runCount,before.runCount);assert.equal(after.stepCount,before.stepCount);assert.equal(after.attemptCount,before.attemptCount);assert.equal(after.audit.models,0);assert.equal(after.audit.identity,0);
});
test('A9 request-boundary race after real prepared sees another unknown, sends zero',async t=>{
 const f=await fixture(t,'permanent'),{a,job}=f,save=a.save.bind(a);let injected=false;
 a.save=()=>{const result=save(),row=Object.values(job.executionState.identityPreflights||{}).flat().find(r=>r.status==='prepared');if(row&&!injected){injected=true;job.executionState.identityPreflights['controlled-racing-old']=[{id:'controlled-unknown',key:'controlled-racing-old',status:'unknown',startedAt:new Date().toISOString()}];save();}return result;};
 const s=await a.dispatch('controlledIdentityTick');assert.equal(injected,true);assert.equal(s.audit.identity,0);assert.equal(s.audit.models,0);assert.equal(s.policy.phase,'blocked');assert.equal(s.identityDecision.action,'reconcile');const n=s.stepCount;const after=await a.dispatch('controlledIdentityTick',{advanceMs:60000});assert.equal(after.stepCount,n);
});
test('A10/A11 same-job independent local draft bypasses old nextRunAt, blocked deadline remains pending',async t=>{
 const f=await fixture(t),{a,job,task}=f;
 const result=await agent.act(a,job,'plan_task',{key:'independent-local',title:'独立本地文本',criteria:'本地生成一段文字',steps:[{key:'draft',kind:'draft',title:'独立本地草稿'}]});const sibling=a.task(result.taskId);sibling.generationMode='single';
 job.status='retry';job.nextRunAt=new Date(Date.now()+86400000).toISOString();job.maxActions=1;
 const deadline=require('../desktop/deadline-events.cjs'),scheduler=require('../desktop/deadline-scheduler.cjs');
 for(const t of [task,sibling])deadline.setPolicy(a,{taskId:t.id,input:{dueAt:new Date(Date.now()-1000).toISOString()}});
 scheduler.reconcile(a);a.save();
 const choices=policy.inspect(a,job).choices;assert.equal(choices.find(c=>c.taskId===task.id).eligible,false);assert.equal(choices.find(c=>c.taskId===sibling.id).eligible,true,JSON.stringify(choices));
 const wake=Object.values(deadline.state(a).wakeIntents).find(w=>w.taskId===task.id&&w.status==='pending');assert.ok(wake);assert.equal(scheduler.eligibility(a,wake).allowed,false);
 const claims=scheduler.claimJob(a,job,'controlled-independent');assert.ok(claims.every(c=>c.taskId!==task.id));assert.equal(deadline.state(a).wakeIntents[wake.id].status,'pending');scheduler.releaseClaims(a,claims);
 let models=0;a.chat=async(_p,_key,m,o)=>{models++;return o.role==='verify'?{passed:false,summary:'保留独立文本供核对，不声明整体血缘完整',gaps:['尚未核对整体血缘'],gapDetails:[]} :m[0].content.includes('动作格式')?{tool:'advance_task',args:{taskId:sibling.id}}:{kind:'artifact',title:'独立草稿',content:'受控的独立本地文本。'};};
 await a.dispatch('controlledIdentityTick');assert.equal(models,3,JSON.stringify(a.data.agentRuns[0]));assert.deepEqual(a.data.agentRuns[0].modelCallsDetail.map(c=>c.stage),['planner','task_work','task_verify']);assert.ok(a.data.artifacts.some(r=>r.taskId===sibling.id),JSON.stringify({task:sibling,runs:a.data.agentRuns[0]}));assert.equal(f.observe().audit.identity,0);assert.equal(identity.inspect(a,job).decision.action,'reconcile');assert.equal(deadline.state(a).wakeIntents[wake.id].status,'pending');
});
test('A11 independent deadline cannot release identity backoff before its exact due time',async t=>{
 const f=await fixture(t,'transient'),{a,job,task}=f;const first=await a.dispatch('controlledIdentityTick');
 const deadline=require('../desktop/deadline-events.cjs'),scheduler=require('../desktop/deadline-scheduler.cjs');deadline.setPolicy(a,{taskId:task.id,input:{dueAt:new Date(Date.now()-1000).toISOString()}});scheduler.reconcile(a);a.save();
 const before=f.observe();const state=await a.dispatch('controlledIdentityTick');assert.equal(state.stepCount,before.stepCount);assert.equal(state.audit.identity,1);assert.equal(state.policy.resumeAt,first.policy.resumeAt);assert.deepEqual(scheduler.claimJob(a,job,'blocked-deadline'),[]);
});
for(const gate of ['paused','budget','revoked'])test('A12 current '+gate+' gate wins over identity wait and creates no work',async t=>{
 const f=await fixture(t),{a,job}=f;if(gate==='paused')job.executionPaused=true;
 if(gate==='budget'){job.status='limited';job.limitReason='controlled budget';}
 if(gate==='revoked'){const request=authority.requestsForTool(a,job,'model_request',{})[0];authority.revoke(a,{...request,operations:[request.operation]},{trusted:true,actor:'user_command',command:'controlled'});}
 a.save();const before=f.observe(),after=await a.dispatch('controlledIdentityTick');assert.equal(after.runCount,before.runCount);assert.equal(after.stepCount,before.stepCount);assert.equal(after.audit.identity,0);assert.equal(after.audit.models,0);assert.equal(policy.inspect(a,job).eligible,false);
});
test('A10/A13 existing source consumption proceeds under identity unknown; real incomplete coverage cannot check or deliver',async t=>{
 const f=await fixture(t,'local_recovery'),{a,job,task}=f;
 await a.dispatch('controlledIdentityTick');const before=f.observe();assert.equal(before.recovery.source.associated,true);const originalIdentity=hash(job.executionState.identityPreflights),episode=job.executionState.continuation.episodes[before.episode.basis],cycles=episode.cycles,hops=episode.hops;
 job.maxActions=1;a.chat=f.controlledLocalModel;await agent.run(a,job.id);
 const draft=require('../desktop/deliverables.cjs').primary(a,task);assert.equal(draft.draftOnly,true);assert.equal(task.evidenceConsumption.receipts.length,1);assert.equal(hash(job.executionState.identityPreflights),originalIdentity);assert.equal(f.observe().audit.identity,0);
 const count=job.callsUsed;await assert.rejects(agent.act(a,job,'verify_content',{taskId:task.id}),e=>e.code==='EVIDENCE_REQUIRED');assert.equal(job.callsUsed,count);
 await assert.rejects(agent.act(a,job,'lark_update',{taskId:task.id}));assert.equal(require('../desktop/acceptance.cjs').completionCandidate(a,job).ready,false);assert.equal(task.acceptedAt,undefined);assert.equal(episode.cycles,cycles);assert.equal(episode.hops,hops);
});
test('A10 invalid retained response cannot become a local alternative to unknown identity',async t=>{
 const f=await fixture(t,'local_recovery'),{a,job}=f,op=Object.values(job.executionState.operations).find(o=>o.responses?.length);op.responses[0].dataHash='controlled-corruption';a.save();const before=f.observe();
 const s=await a.dispatch('controlledIdentityTick');assert.equal(s.audit.identity,0);assert.equal(s.audit.business,0);assert.equal(s.recovery.source,undefined);assert.notEqual(s.recovery.operation.status,'done');assert.ok(!s.runs.flatMap(r=>r.steps).slice(0,s.stepCount-before.stepCount).some(s=>s.tool==='recover_platform_result'&&!s.errorCode));
});
test('A12 unresolved external side effect retains its original reconciliation priority over identity',async t=>{
 const f=await fixture(t),{a,job}=f,action=a.data.agentActions.find(r=>r.status==='done');assert.ok(action);
 // Explicit historical uncertain side effect, keeping its actual target,
 // original request identity and real permission record intact.
 action.status='uncertain';job.pendingActionId=action.id;a.save();const p=policy.inspect(a,job,{mode:'manual'});assert.equal(p.mode,'reconcile_existing');assert.equal(p.action.actionId,action.id);assert.equal(identity.inspect(a,job).decision.action,'reconcile');
});
test('A8 task-scoped planner query without taskId still binds its selected owner and stops',async t=>{
 const {a,job,task}=rootFixture(t);task.needsReplan='核对原要求并选择下一动作';job.maxActions=6;let models=0,requests=0;
 a.chat=async()=>{models++;return {tool:'platform_query',args:{queries:[{op:'projects'}]}};};a.platformRequest=async()=>{requests++;throw Object.assign(Error('controlled identity deny'),{code:'AUTH_REQUIRED'});};a.save();
 await agent.run(a,job.id);assert.equal(requests,1);assert.equal(models,1);assert.equal(a.data.agentRuns[0].steps.length,1);assert.equal(a.data.agentRuns[0].steps[0].identityPreflight.ownerTaskId,task.id);assert.equal(policy.inspect(a,job).eligible,false);await agent.run(a,job.id);assert.equal(models,1);
});
test('A4 real queued evidence resumes after transient identity success without erasing the first attempt',async t=>{
 const f=await fixture(t,'transient'),{a,job}=f,first=await a.dispatch('controlledIdentityTick');assert.equal(first.policy.phase,'retry');const failures=structuredClone(first.identityRecords.filter(r=>r.status==='failed')),attempts=structuredClone(first.attempts);job.maxActions=1;
 let identityCalls=0,business=0;const subject=identity.inspect(a,job).context.principalScope.subject,command=JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'}));
 Object.defineProperty(a,'platformRequest',{configurable:true,value:async args=>{if(JSON.stringify(args)===command){identityCalls++;return {username:subject};}assert.equal(args[args.indexOf('--table-name')+1],'leaf');business++;return require('./root-relation-physical-fixture.cjs').data('leaf',['tail']);}});
 const next=await a.dispatch('controlledIdentityTick',{advanceMs:15000});assert.equal(identityCalls,1,JSON.stringify(next));assert.equal(business,1,JSON.stringify(next));assert.equal(next.audit.models,0);assert.deepEqual(next.identityRecords.filter(r=>r.status==='failed'),failures);assert.equal(next.identityRecords.at(-1).status,'done');assert.equal(next.identityDecision.failureCount,1);assert.equal(next.attemptCount,first.attemptCount+1);assert.deepEqual(next.attempts.filter(r=>attempts.some(o=>o.attemptId===r.attemptId)),attempts);assert.equal(next.attempts.find(r=>!attempts.some(o=>o.attemptId===r.attemptId)).status,'done');assert.deepEqual(next.episode,first.episode);assert.deepEqual(next.budget,first.budget);
});
