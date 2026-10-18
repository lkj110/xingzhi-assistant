'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const h=require('./helpers/consumption-scale.cjs');
const c=require('../desktop/evidence-consumption.cjs'),cache=require('../desktop/projection-cache.cjs');
const projector=require('../desktop/physical-lineage-coverage.cjs');

for(const targets of [1,12,24])for(const proofs of [1,13,26,52])test(`${targets} targets x ${proofs} proofs: direct current is one real graph and visits every proof`,t=>{
  const f=h.scaleFixture(t,targets,proofs), old=h.oldCurrentWithActiveDependencies();
  const original=projector.project,spy=t.mock.method(projector,'project',(...args)=>original(...args));
  const before=JSON.stringify(f.a.data);f.resetVisits();
  assert.equal(c.current(f.a,f.job,f.task,f.p),true);assert.equal(spy.mock.callCount(),1);
  // One full pass in recoveryFacts and one in consumptionFacts. Distinct event
  // indexes prove the last proof was reached; aggregate counts alone cannot.
  assert.deepEqual(f.visits(),[...Array(proofs).keys(),...Array(proofs).keys()]);
  const oldBefore=spy.mock.callCount();f.resetVisits();
  assert.equal(old.current(f.a,f.job,f.task,f.p),true);assert.equal(spy.mock.callCount()-oldBefore,targets);
  assert.equal(f.visits().length,2*proofs*targets);assert.equal(JSON.stringify(f.a.data),before);
  t.diagnostic(JSON.stringify({targets,proofs,newProjects:1,oldProjects:targets,proofVisits:2*proofs,transport:f.memory.transport}));
});

for(const change of ['last-target','last-additional','missing-key-undefined','empty'])test(`Map preserves r7 some semantics: ${change}`,t=>{
  const f=h.scaleFixture(t,24,52),old=h.oldCurrentWithActiveDependencies();
  if(change==='last-target')f.p.targetFacts.at(-1).bindingVersion='wrong';
  if(change==='last-additional'){f.p.additionalFacts=f.p.targetFacts.splice(12);f.p.additionalFacts.at(-1).bindingVersion='wrong';}
  if(change==='missing-key-undefined')Object.assign(f.p.targetFacts.at(-1),{factKey:'missing-key',bindingVersion:undefined});
  if(change==='empty'){f.p.targetFacts=[];f.p.additionalFacts=[];}
  const original=projector.project,spy=t.mock.method(projector,'project',(...args)=>original(...args));
  const actual=c.current(f.a,f.job,f.task,f.p);assert.equal(actual,change==='empty');assert.equal(spy.mock.callCount(),change==='empty'?0:1);
  assert.equal(old.current(f.a,f.job,f.task,f.p),actual);
});

test('invalid earlier proofs cannot conceal a last-proof source/prior/request corruption',t=>{
  const f=h.scaleFixture(t,24,52),old=h.oldCurrentWithActiveDependencies();
  for(const e of f.events.slice(0,-1))e.payload.task.set.lastEvidenceResolution.recoveryProof.facts.forEach(p=>p.sourceId='absent');
  const last=f.events.at(-1).payload.task.set.lastEvidenceResolution,original=structuredClone(last);
  assert.equal(c.current(f.a,f.job,f.task,f.p),true);
  for(const mutate of [r=>r.recoveryProof.facts.find(p=>require('../desktop/evidence-basis.cjs').hash(p.fact)===f.p.targetFacts.at(-1).factKey).sourceId='absent',r=>r.recoveryProof.request.priorFacts=r.recoveryProof.facts.map(p=>require('../desktop/evidence-basis.cjs').hash(p.fact)),r=>r.recoveryProof.request.workRevision++]){
    const changed=structuredClone(original);mutate(changed);f.events.at(-1).payload.task.set.lastEvidenceResolution=changed;
    assert.equal(c.current(f.a,f.job,f.task,f.p),false);assert.equal(old.current(f.a,f.job,f.task,f.p),false);
  }
});

function admissionFixture(t){
  const memory=h.memoryStorage(),f=require('./root-relation-fixture.cjs').fixture(t,{roots:Array.from({length:12},(_,i)=>String(123+i)),kinds:'物理表血缘'});
  t.after(()=>memory.restore());
  const {a,job,task}=f,store=require('../desktop/access-policy-store.cjs'),cc=require('../desktop/continuation-control.cjs'),r=require('../desktop/relation-obligations.cjs');
  job.platformPrincipal='controlled-admission';
  store.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'fixture'});
  const artifact={id:'admission-original',taskId:task.id,stepId:task.steps[0].id,title:'交接',content:'# 交接\n\n## 输入\n已有事实。',createdAt:new Date().toISOString()};
  a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});task.primaryArtifactId=artifact.id;task.steps[0].artifactId=artifact.id;task.generationMode='single';
  cc.redirect(a,job,{args:{taskId:task.id}},{code:'PLAN_ALREADY_RECONCILED',message:'同一计划已协调',taskId:task.id});
  for(let i=0;i<12;i++)f.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123+i});
  f.need({gaps:['各入口的物理表血缘缺失'],requirements:r.required(a,job,task).map(o=>o.id)});
  const center=f.source('table_lineage',require('./root-relation-physical-fixture.cjs').data('out'),{database:'db',table:'out'},{},false);
  f.resolve([...task.sourceIds,center.id]);cc.refresh(a,job);job.nextRunAt=null;a.save();
  const policy=require('../desktop/execution-policy.cjs'),action=policy.prepare(a,job);assert.equal(action.eligible,true,JSON.stringify(action));assert.equal(action.action.tool,'advance_task');
  const p=c.active(task);assert.equal(p.targetFacts.length,24);
  const dispatch=policy.claim(a,job);dispatch.at=new Date().toISOString();
  const run={id:require('node:crypto').randomUUID(),jobId:job.id,startedAt:dispatch.at,status:'running',steps:[dispatch],modelCalls:0,modelCallsDetail:[]};
  a.data.agentRuns.unshift(run);a.activeAgentJob=job;a.activeAgentRun=run;cc.started(a,job,dispatch);a.save();
  return {...f,artifact,p,memory,center};
}

test('24 physical facts traverse real agent/core/beforeModel into one controlled model and draft receipt',async t=>{
  const f=admissionFixture(t),{performance}=require('node:perf_hooks'),metrics=h.profile(h.ROOT),stages=[];
  t.after(()=>metrics.restore());
  for(const name of ['assertAdvance','selectedStep','begin','candidate','modelGuard','beforeModel']){
    const original=c[name];t.mock.method(c,name,(...args)=>{const row=metrics.measure(()=>original(...args));stages.push({stage:name,...row,value:undefined});return row.value;});
  }
  let calls=0,boundary;const start=performance.now();
  f.a.chat=async(_p,_key,m,o)=>{
    calls++;boundary={elapsedMs:performance.now()-start,...metrics.totals};
    assert.equal(o.role,'execute');assert.equal(JSON.parse(m[1].content).evidenceConsumption.targetFacts.length,24);
    assert.ok(stages.some(s=>s.stage==='beforeModel'));
    o.onUsage?.({inputTokens:10,outputTokens:10,cachedInputTokens:0});
    const section=c.sections(f.artifact.content).find(s=>s.title==='输入'),quote='受控夹具已核对本批物理血缘事实并将对应证据纳入原稿。';
    return {kind:'patch',edits:[{before:f.artifact.content.slice(section.start,section.end),after:f.artifact.content.slice(section.start,section.end)+'\n'+quote+'\n'}],summary:'受控证据修订',evidenceIntegration:f.p.targetFacts.map(v=>({factKey:v.factKey,obligationId:v.obligationId,sectionId:section.id,quote}))};
  };
  await require('../desktop/agent.cjs').act(f.a,f.job,'advance_task',{taskId:f.task.id});
  assert.equal(calls,1);assert.equal(f.task.evidenceConsumption.receipts.length,1);assert.equal(f.task.evidenceConsumption.receipts[0].integration.length,24);
  assert.ok(Object.values(f.job.executionState.continuation.episodes).some(e=>e.pendingCheck));
  assert.equal(require('../desktop/deliverables.cjs').primary(f.a,f.task).baseArtifactId,f.artifact.id);
  assert.ok(boundary.projects<30,JSON.stringify(boundary));
  assert.ok(stages.filter(s=>['assertAdvance','selectedStep','modelGuard'].includes(s.stage)).every(s=>s.projects<=1));
  t.diagnostic(JSON.stringify({scope:'synthetic-physical-fixture-not-SG-recovery',totalMs:performance.now()-start,boundary,stages,stubModels:calls,transport:f.memory.transport,delivery:'not_verified'}));
});

test('prepare to begin and save to beforeModel retain fresh input gates',t=>{
  const f=admissionFixture(t),old=f.center.content;
  cache.scope(()=>{assert.equal(c.current(f.a,f.job,f.task,f.p),true);f.center.content+='changed';assert.throws(()=>c.begin(f.a,f.job,f.task,f.task.steps[0]),{code:'EVIDENCE_CONSUMPTION_STALE'});});
  f.center.content=old;c.begin(f.a,f.job,f.task,f.task.steps[0]);f.a.activeSpendTask=f.task;f.a.save();
  cache.scope(()=>{assert.equal(c.current(f.a,f.job,f.task,f.p),true);f.center.content+='changed-after-save';assert.throws(()=>c.beforeModel(f.a,{requestId:'blocked',attempt:1,spendTicket:{id:'blocked-ticket'},role:'execute'}),{code:'EVIDENCE_CONSUMPTION_STALE'});});
  assert.equal(f.p.requests.length,0);
});

for(const mutation of ['content','version','principal','archive','withdrawal','replacement','sourceIds','root','primary','acl'])test(`fresh current rejects ${mutation} after caller cache warmup`,t=>{
  const f=h.scaleFixture(t,24,13),original=projector.project,spy=t.mock.method(projector,'project',(...args)=>original(...args));
  cache.scope(()=>{
    const first=c.facts(f.a,f.job,f.task);assert.ok(first.length>=24);assert.equal(c.current(f.a,f.job,f.task,f.p),true);
    const prior=spy.mock.callCount();
    if(mutation==='content')f.center.content+=' ';
    if(mutation==='version')f.center.version='changed';
    if(mutation==='principal')f.center.platformPrincipal='other';
    if(mutation==='archive')f.center.platformArchive={invalid:true};
    if(mutation==='withdrawal')f.task.contextBindings.find(b=>b.sourceId===f.center.id).state='withdrawn';
    if(mutation==='replacement')f.a.data.sources.push({...f.center,id:'replacement',previousSourceId:f.center.id});
    if(mutation==='sourceIds')f.task.sourceIds=f.task.sourceIds.filter(id=>id!==f.center.id);
    if(mutation==='root')f.job.goal=f.job.goal.replace('123','999');
    if(mutation==='primary')f.artifact.content+='changed';
    if(mutation==='acl'){
      const revision=f.a.data.runtime.revision,store=require('../desktop/access-policy-store.cjs');
      store.revoke(f.a,{principalScope:store.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+f.center.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'revoke'});
      assert.equal(f.a.data.runtime.revision,revision);
    }
    if(mutation==='archive')assert.throws(()=>c.current(f.a,f.job,f.task,f.p),{code:'LOCAL_RESULT_INTEGRITY'});
    else assert.equal(c.current(f.a,f.job,f.task,f.p),false);
    // Some changes invalidate the scope before graph construction, which is a
    // valid short circuit. Changed binding versions must build a fresh graph.
    if(mutation==='version')assert.equal(spy.mock.callCount()-prior,1);
  });
});

test('inspection shares pure reads, public current revalidates each call, async does not retain cache',async t=>{
  const f=h.scaleFixture(t,24,13);
  c.applyPrepared(f.a,f.job,f.task,f.p,{at:new Date().toISOString(),commitId:'controlled-prepare'});
  const p=c.active(f.task);assert.ok(p);assert.equal(p.status,'prepared');
  const original=projector.project,spy=t.mock.method(projector,'project',(...args)=>original(...args));
  const data=JSON.stringify(f.a.data);
  cache.scope(()=>{assert.equal(c.inspect(f.a,f.job,f.task).eligible,true);assert.equal(c.inspect(f.a,f.job,f.task).eligible,true);});
  assert.equal(spy.mock.callCount(),1);assert.equal(JSON.stringify(f.a.data),data);
  assert.equal(c.current(f.a,f.job,f.task,p),true);assert.equal(c.current(f.a,f.job,f.task,p),true);assert.equal(spy.mock.callCount(),3);
  await cache.scope(async()=>{assert.equal(c.current(f.a,f.job,f.task,p),true);await Promise.resolve();f.center.content+='changed';assert.equal(c.current(f.a,f.job,f.task,p),false);});
});
