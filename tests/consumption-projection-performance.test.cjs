'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs'),cc=require('../desktop/continuation-control.cjs'),policy=require('../desktop/execution-policy.cjs'),c=require('../desktop/evidence-consumption.cjs'),cache=require('../desktop/projection-cache.cjs');
function setup(t){
 const roots=Array.from({length:24},(_,i)=>String(123+i)),f=fixture(t,{roots}),{a,job,task}=f;
 job.platformPrincipal='fixture-user';require('../desktop/access-policy-store.cjs').grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'fixture'});
 const artifact={id:'original',taskId:task.id,stepId:task.steps[0].id,title:'交接',content:'# 交接\n\n## 输入\n已有事实。',createdAt:new Date().toISOString()};
 a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});task.primaryArtifactId=artifact.id;task.steps[0].artifactId=artifact.id;task.generationMode='single';
 cc.redirect(a,job,{args:{taskId:task.id}},{code:'PLAN_ALREADY_RECONCILED',message:'同一计划已协调',taskId:task.id});
 f.need({gaps:['各入口SQL读写缺失'],requirements:require('../desktop/relation-obligations.cjs').required(a,job,task).map(o=>o.id)});
 const sources=roots.map(id=>f.source('code',{taskId:Number(id),sql:'INSERT INTO output_'+id+' SELECT x FROM input_'+id},{taskId:Number(id)},{},false));
 f.resolve(sources.slice(0,12).map(s=>s.id));f.need({gaps:['其余入口SQL读写缺失'],requirements:require('../desktop/relation-obligations.cjs').required(a,job,task).map(o=>o.id)});f.plan(sources.map(s=>s.id),{evidenceResolution:{basis:task.evidenceRequest.basis,sourceIds:sources.slice(12).map(s=>s.id),reason:'关联其余入口的新证据'}});cc.refresh(a,job);job.nextRunAt=null;a.save();
 const action=policy.prepare(a,job);assert.equal(action.eligible,true,JSON.stringify(action));assert.equal(action.action.tool,'advance_task');
 const p=c.active(task);assert.ok(p,JSON.stringify({action,inspection:c.inspect(a,job,task),facts:c.facts(a,job,task).length}));assert.equal(p.targetFacts.length,24);
 a.activeAgentJob=job;a.activeAgentRun={id:'real-run'};a.activeSpendTask=task;
 return {...f,artifact,p};
}
test('24-fact admission rebuilds facts once and each boundary revalidates',t=>{
 const f=setup(t),r=require('../desktop/relation-obligations.cjs'),original=r.recoveryFacts;let scans=0;
 t.mock.method(r,'recoveryFacts',(...args)=>{scans++;return original(...args);});
 const measure=fn=>{const before=scans;fn();return scans-before;};
 assert.equal(measure(()=>assert.equal(c.current(f.a,f.job,f.task,f.p),true)),1);
 assert.equal(measure(()=>c.assertAdvance(f.a,f.job,f.task)),1);
 assert.equal(measure(()=>assert.equal(c.selectedStep(f.a,f.job,f.task).id,f.p.stepId)),1);
 assert.ok(measure(()=>c.begin(f.a,f.job,f.task,f.task.steps[0]))<=2);
 assert.equal(measure(()=>c.modelGuard(f.a)),1);
 assert.ok(measure(()=>c.beforeModel(f.a,{requestId:'request',attempt:1,spendTicket:{id:'ticket'},role:'execute'}))<=2);
});
test('current rejects source and ACL mutations even inside caller cache',t=>{
 const f=setup(t),s=f.a.data.sources.find(s=>s.id===f.p.targetFacts[0].sourceId),old=s.content;
 cache.scope(()=>{
  assert.equal(c.current(f.a,f.job,f.task,f.p),true);
  s.content+='changed';assert.equal(c.current(f.a,f.job,f.task,f.p),false);s.content=old;
  assert.equal(c.current(f.a,f.job,f.task,f.p),true);
  const store=require('../desktop/access-policy-store.cjs'),req=store.requestsForTool(f.a,f.job,'read_source',{sourceId:s.id},{taskId:f.task.id})[0];
  store.revoke(f.a,{principalScope:req.principalScope,resourceScope:req.resourceScope,operations:[req.operation]},{trusted:true,actor:'user_command',command:'revoke'});
  assert.equal(c.current(f.a,f.job,f.task,f.p),false);
 });
});
test('missing fact cannot compare equal to undefined and inspection stays pure',t=>{
 const f=setup(t),data=JSON.stringify(f.a.data);
 const r=require('../desktop/relation-obligations.cjs'),original=r.recoveryFacts;let scans=0;t.mock.method(r,'recoveryFacts',(...args)=>{scans++;return original(...args);});
 cache.scope(()=>{c.inspect(f.a,f.job,f.task);c.inspect(f.a,f.job,f.task);});assert.equal(scans,1);assert.equal(JSON.stringify(f.a.data),data);
 const originalFact=f.p.targetFacts[0];f.p.targetFacts[0]={...originalFact,factKey:'missing',bindingVersion:undefined};assert.equal(c.current(f.a,f.job,f.task,f.p),false);
});
test('24 facts traverse real agent/core generation into the original draft and pending check',async t=>{
 const f=setup(t),r=require('../desktop/relation-obligations.cjs'),original=r.recoveryFacts;let scans=0,atModel=0,calls=0;
 startRun(f.a,f.job);
 t.mock.method(r,'recoveryFacts',(...args)=>{scans++;return original(...args);});
 f.a.chat=async(_provider,_key,m,o)=>{
  calls++;atModel=scans;o.onUsage?.({inputTokens:10,outputTokens:10,cachedInputTokens:0});
  assert.equal(o.role,'execute');const payload=JSON.parse(m[1].content);assert.equal(payload.evidenceConsumption.targetFacts.length,24);
  const section=c.sections(f.artifact.content).find(s=>s.title==='输入'),quote='本次已核对24个入口的输入输出证据，详见各入口记录。';
  return {kind:'patch',edits:[{before:f.artifact.content.slice(section.start,section.end),after:f.artifact.content.slice(section.start,section.end)+'\n'+quote+'\n'}],summary:'纳入新的证据',evidenceIntegration:f.p.targetFacts.map(fact=>({factKey:fact.factKey,obligationId:fact.obligationId,sectionId:section.id,quote}))};
 };
 await require('../desktop/agent.cjs').act(f.a,f.job,'advance_task',{taskId:f.task.id});
 assert.equal(calls,1);assert.ok(atModel<30,'a full call must not multiply facts per admission: '+atModel);
 assert.equal(f.task.evidenceConsumption.receipts.length,1);assert.equal(f.task.evidenceConsumption.receipts[0].integration.length,24);
 const draft=require('../desktop/deliverables.cjs').primary(f.a,f.task);assert.equal(draft.baseArtifactId,f.artifact.id);assert.notEqual(draft.content,f.artifact.content);
 const checks=Object.values(f.job.executionState.continuation.episodes).map(e=>e.pendingCheck).filter(Boolean);assert.ok(checks.some(p=>p.artifactId===draft.id));
 t.diagnostic(JSON.stringify({recoveryFactsCalls:scans,recoveryFactsBeforeModel:atModel,facts:24,models:calls}));
});
function rawCandidate(f){
 const section=c.sections(f.artifact.content).find(s=>s.title==='输入'),quote='新增已核对的输入输出证据，仍保留原稿的其他说明。';
 return {kind:'artifact',title:'修订稿',content:f.artifact.content+'\n'+quote+'\n  \n',evidenceIntegration:f.p.targetFacts.map(v=>({factKey:v.factKey,obligationId:v.obligationId,sectionId:section.id,quote}))};
}
function startRun(a,job){
 const dispatch=policy.claim(a,job);assert.equal(dispatch.tool,'advance_task');dispatch.at=new Date().toISOString();
 const run={id:require('node:crypto').randomUUID(),jobId:job.id,startedAt:dispatch.at,status:'running',steps:[dispatch],modelCalls:0,modelCallsDetail:[]};
 a.data.agentRuns.unshift(run);a.activeAgentJob=job;a.activeAgentRun=run;cc.started(a,job,dispatch);a.save();return run;
}
test('cold retained draft preserves trailing whitespace, quote and hash without another model',async t=>{
 const f=setup(t);c.begin(f.a,f.job,f.task,f.task.steps[0]);const result=rawCandidate(f);c.retain(f.a,f.job,f.task,f.task.steps[0],result);
 const {Assistant}=require('../desktop/core.cjs'),a=new Assistant({dir:f.dir,chat:()=>assert.fail('retained output must not call model'),connectorRequest:()=>assert.fail('no connector')});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 const task=a.task(f.task.id),job=a.data.delegations.find(v=>v.id===f.job.id);startRun(a,job);await a.advance(task.id);
 const draft=require('../desktop/deliverables.cjs').primary(a,task),receipt=task.evidenceConsumption.receipts[0];
 assert.equal(draft.content,result.content);assert.equal(receipt.artifactHash,require('../desktop/evidence-basis.cjs').hash(result.content));assert.equal(receipt.integration[0].quote,result.evidenceIntegration[0].quote);
 assert.ok(Object.values(job.executionState.continuation.episodes).some(e=>e.pendingCheck?.artifactId===draft.id));assert.equal((a.data.modelCalls||[]).length,0);
});
for(const invalid of ['blank','raw-too-long'])test('raw consumption output still rejects '+invalid+' before retention',async t=>{
 const f=setup(t),result=rawCandidate(f);result.content=invalid==='blank'?' \n \t ':' '+result.content.padEnd(100000,' ');
 t.mock.method(require('../desktop/generation.cjs'),'run',async()=>result);
 const outcome=await require('../desktop/agent.cjs').act(f.a,f.job,'advance_task',{taskId:f.task.id});assert.match(outcome.error,invalid==='blank'?/不能为空/:/超过 100000/);
 assert.equal(f.task.primaryArtifactId,f.artifact.id);assert.equal(f.task.evidenceConsumption.receipts.length,0);assert.equal(c.active(f.task).candidate,undefined);
});
test('tampered retained whitespace does not bypass candidate integrity',async t=>{
 const f=setup(t);c.begin(f.a,f.job,f.task,f.task.steps[0]);c.retain(f.a,f.job,f.task,f.task.steps[0],rawCandidate(f));c.active(f.task).candidate.content+=' ';
 await assert.rejects(()=>require('../desktop/agent.cjs').act(f.a,f.job,'advance_task',{taskId:f.task.id}),{code:'EVIDENCE_CONSUMPTION_STALE'});assert.equal(f.task.primaryArtifactId,f.artifact.id);assert.equal(f.task.evidenceConsumption.receipts.length,0);
});
