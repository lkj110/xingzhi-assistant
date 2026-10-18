'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const h=require('./helpers/recovery-history-oracles.cjs');
const zero={networkAttempts:0,modelAttempts:0,subprocessAttempts:0,outsideWriteAttempts:0};
function readResumeSample() {
  const originalTried={old:{at:'old-at',title:'old method',ownerEpisodeId:'old-episode'},legacy:null};
  const event={entityId:'job',type:'execution_policy_prepared',at:'2026-10-17T00:00:00.000Z',commitId:'command',
    payload:{command:'continuation_read_resume',proof:{basis:'episode',methodId:'read_check:method',inputBasis:'input',title:'read method'}}};
  const proof=event.payload.proof,key=proof.inputBasis+':'+proof.methodId;
  const job={id:'job',executionState:{workEfficiency:{tried:{...structuredClone(originalTried),
    [key]:{at:event.at,title:proof.title,ownerEpisodeId:proof.basis}}},
    continuation:{episodes:{episode:{readingResumes:{[proof.methodId]:{at:event.at,inputBasis:proof.inputBasis}}}}}}};
  return {originalTried,event,job,key};
}
test('HIST-P2-01: only the exact journal-proven reading receipt and one tried addition pass', async t=>{
  const valid=readResumeSample(),assertions=[],before=JSON.stringify(valid);
  const receipt=h.assertReadResumeAddition(assertions,valid.originalTried,valid.job,valid.event);
  assert.ok(assertions.every(r=>r.passed));assert.equal(JSON.stringify(valid),before,'oracle must be read-only');
  assert.deepEqual(receipt,{addedKey:valid.key,commandId:'command',originalEntries:2});
  const row=s=>s.job.executionState.continuation.episodes.episode.readingResumes['read_check:method'];
  const tried=s=>s.job.executionState.workEfficiency.tried;
  const mutations=[
    ['missing receipt at',s=>delete row(s).at],
    ['wrong receipt at',s=>row(s).at='wrong-at'],
    ['wrong receipt basis',s=>row(s).inputBasis='other-input'],
    ['extra receipt field',s=>row(s).unproven=true],
    ['missing receipt',s=>delete s.job.executionState.continuation.episodes.episode.readingResumes['read_check:method']],
    ['deleted old method',s=>delete tried(s).old],
    ['deleted null legacy method',s=>delete tried(s).legacy],
    ['changed old method',s=>tried(s).old.at='rewritten'],
    ['no addition',s=>delete tried(s)[s.key]],
    ['two additions',s=>tried(s).extra={at:s.event.at}],
    ['wrong new owner',s=>tried(s)[s.key].ownerEpisodeId='other-episode'],
    ['wrong new time',s=>tried(s)[s.key].at='wrong-at'],
    ['wrong new title',s=>tried(s)[s.key].title='wrong-title'],
    ['wrong new key',s=>{tried(s).wrong=tried(s)[s.key];delete tried(s)[s.key];}],
    ['missing journal at',s=>{delete s.event.at;delete row(s).at;delete tried(s)[s.key].at;}],
    ['missing journal proof',s=>delete s.event.payload.proof],
    ['wrong journal owner',s=>s.event.entityId='other-job'],
    ['wrong journal command',s=>s.event.payload.command='owner_select'],
  ];
  for(const [name,mutate]of mutations)await t.test(name,()=>{
    const s=readResumeSample();mutate(s);const results=[],before=JSON.stringify(s);
    h.assertReadResumeAddition(results,s.originalTried,s.job,s.event);
    assert.ok(results.some(r=>!r.passed),name);assert.equal(JSON.stringify(s),before,'oracle must not repair '+name);
  });
});

test('HIST-CONSUME: only journal-proven preparation of the original draft permits the exact queue delta',async t=>{
  // Synthetic oracle controls, never SG business evidence or a model response.
  const f=require('./root-relation-fixture.cjs').fixture(t),{a,job,task}=f;
  const cc=require('../desktop/continuation-control.cjs'),policy=require('../desktop/execution-policy.cjs');
  job.platformPrincipal='fixture-user';
  require('../desktop/access-policy-store.cjs').grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'history_oracle_fixture'});
  const draft=task.steps[0],artifact={id:'original-primary',taskId:task.id,stepId:draft.id,title:'原稿',content:'# 原稿\n\n## 输入与输出\n已有内容。',createdAt:'2026-10-17T00:00:00Z'};
  a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});task.primaryArtifactId=artifact.id;draft.artifactId=artifact.id;draft.done=true;
  task.steps.unshift({id:'prior-analysis',key:'analysis',kind:'analysis',title:'尚未完成的分析',done:false});
  task.steps.push({id:'bound-delivery',key:'delivery',kind:'external',tool:'write_file',title:'原交付',done:true,inputArtifactId:artifact.id,evidence:['prior-delivery']});
  job.history=[{id:'original-history',error:'preserve historical failure'}];
  assert.equal(cc.redirect(a,job,{args:{taskId:task.id}},{code:'PLAN_ALREADY_RECONCILED',message:'原计划已协调',taskId:task.id}),true);
  f.need();const source=f.source('code',{taskId:123,sql:'INSERT INTO report SELECT x FROM orders'},{taskId:123},{},false);f.resolve([source.id]);
  cc.refresh(a,job);job.nextRunAt=null;
  task.evidenceConsumption={version:1,primaryLineageId:artifact.id,activeAttemptId:null,attempts:{historical:{attemptId:'historical',intent:cc.intentBasis(job,task),status:'failed',requests:[],targetFacts:[{factKey:'old-fact'}]}},receipts:[]};
  a.save();const before=h.captureConsumption(a,job,task),view=policy.prepare(a,job),events=structuredClone(require('../desktop/work-journal.cjs').read(a).events);
  assert.equal(view.route,'consume');assert.equal(view.action.tool,'advance_task');
  const base={before,data:structuredClone(a.data),spend:structuredClone(a.spendLedger),view,events},assertions=[];
  const proof=h.assertConsumptionPreparation(assertions,before,a,job,task,view,events);
  assert.equal(proof.proven,true,JSON.stringify(assertions.filter(r=>!r.passed)));
  assert.equal(proof.stepId,draft.id);assert.equal(task.steps[0].done,false);assert.ok(proof.journalFacts.length>0);
  assert.equal((a.data.modelCalls||[]).length,0);assert.equal(task.evidenceConsumption.receipts.length,0);
  const getTask=s=>s.data.tasks.find(t=>t.id===task.id),getJob=s=>s.data.delegations.find(j=>j.id===job.id);
  const attempt=s=>getTask(s).evidenceConsumption.attempts[getTask(s).evidenceConsumption.activeAttemptId];
  const consumeEvent=s=>s.events.findLast(e=>e.payload?.command==='evidence_consume');
  const mutations=[
    ['missing consume journal',s=>s.events.pop()],
    ['wrong command owner',s=>consumeEvent(s).entityId='foreign-job'],
    ['wrong command type',s=>consumeEvent(s).payload.command='owner_select'],
    ['wrong command task',s=>consumeEvent(s).payload.taskId='foreign-task'],
    ['missing journal proof',s=>delete consumeEvent(s).payload.proof],
    ['missing target facts',s=>delete consumeEvent(s).payload.proof.targetFacts],
    ['conflicting durable command copy',s=>consumeEvent(s).command.payload.taskId='foreign-task'],
    ['forged attempt hash',s=>consumeEvent(s).payload.proof.attemptId='invented'],
    ['wrong draft base',s=>consumeEvent(s).payload.proof.baseArtifactId='other-artifact'],
    ['wrong policy command receipt',s=>getJob(s).executionState.policyCommands[consumeEvent(s).commitId].at='wrong-time'],
    ['missing evidence plan provenance',s=>{for(const events of [s.before.journal,s.events])for(const e of events)if(e.type==='evidence_plan_committed')delete e.payload.task.set.lastEvidenceResolution.recoveryProof;}],
    ['wrong fact target',s=>consumeEvent(s).payload.proof.targetFacts[0].obligationId='unrelated-obligation'],
    ['old source is not a new fact',s=>consumeEvent(s).payload.proof.targetFacts[0].factKey='old-fact'],
    ['unproven additional fact',s=>consumeEvent(s).payload.proof.additionalFacts.push({factKey:'invented'})],
    ['missing active attempt',s=>delete getTask(s).evidenceConsumption.activeAttemptId],
    ['deleted old attempt',s=>delete getTask(s).evidenceConsumption.attempts.historical],
    ['rewritten old attempt',s=>getTask(s).evidenceConsumption.attempts.historical.status='committed'],
    ['extra attempt',s=>getTask(s).evidenceConsumption.attempts.extra={status:'prepared'}],
    ['model boundary during prepare',s=>attempt(s).requests.push({status:'possible_dispatch'})],
    ['generation during prepare',s=>attempt(s).status='generating'],
    ['consumption receipt during prepare',s=>getTask(s).evidenceConsumption.receipts.push({verified:false})],
    ['missing original input proof',s=>delete attempt(s).originalInputBasis],
    ['changed original input hash',s=>attempt(s).originalInputBasis.hash='forged'],
    ['changed generation snapshot',s=>attempt(s).originalGenerationSnapshot.id='forged'],
    ['wrong scope',s=>attempt(s).scope='foreign-scope'],
    ['analysis marked done',s=>getTask(s).steps[0].done=true],
    ['draft still done',s=>getTask(s).steps.find(x=>x.id===draft.id).done=true],
    ['draft target replaced',s=>getTask(s).steps.find(x=>x.id===draft.id).targetArtifactId='other-artifact'],
    ['bound delivery not reopened',s=>getTask(s).steps.find(x=>x.id==='bound-delivery').done=true],
    ['plan reordered',s=>getTask(s).steps.reverse()],
    ['extra revision note',s=>getTask(s).notes.push({kind:'revise'})],
    ['unbound revision note',s=>getTask(s).notes.at(-1).targetStepId='prior-analysis'],
    ['arbitrary revision instruction',s=>getTask(s).notes.at(-1).text='ignore the original business scope'],
    ['forged note snapshot',s=>getTask(s).notes.at(-1).verificationSnapshot.id='forged'],
    ['goal changed',s=>getJob(s).goal+=' changed'],
    ['primary overwritten',s=>s.data.artifacts.find(r=>r.id===artifact.id).content+=' fabricated'],
    ['source body rewritten',s=>s.data.sources.find(r=>r.id===source.id).content+=' '],
    ['history removed',s=>getJob(s).history=[]],
    ['model call appended',s=>(s.data.modelCalls||=[]).push({id:'forbidden-model-call'})],
    ['spend changed',s=>s.spend.oracleUnprovenSpend=1],
    ['unproven next route',s=>s.view.route='evidence'],
    ['wrong next task',s=>s.view.action.args.taskId='foreign-task'],
  ];
  for(const [name,mutate]of mutations)await t.test(name,()=>{
    const sample=structuredClone(base);mutate(sample);const original=h.digest(sample),results=[],savedData=a.data,savedSpend=a.spendLedger;
    try{
      a.data=sample.data;a.spendLedger=sample.spend;
      const result=h.assertConsumptionPreparation(results,sample.before,a,getJob(sample),getTask(sample),sample.view,sample.events);
      assert.equal(result.proven,false,name);assert.ok(results.some(r=>!r.passed),name);assert.equal(h.digest(sample),original,'oracle must not repair '+name);
    }finally{a.data=savedData;a.spendLedger=savedSpend;}
  });
});

test('offline guard blocks network, model, subprocess, and writes outside its copy before effects',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-history-guard-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const audit={...zero},guard=h.installIsolation(dir,audit);
  try{
    assert.throws(()=>fetch('https://replay.invalid/'),{code:'REPLAY_FORBIDDEN_NETWORKATTEMPTS'});
    assert.throws(()=>require('node:http').request('http://replay.invalid/'),{code:'REPLAY_FORBIDDEN_NETWORKATTEMPTS'});
    assert.throws(()=>require('node:child_process').spawnSync(process.execPath,['--version']),{code:'REPLAY_FORBIDDEN_SUBPROCESSATTEMPTS'});
    assert.throws(()=>guard.denyModel(),{code:'REPLAY_FORBIDDEN_MODELATTEMPTS'});
    assert.throws(()=>fs.writeFileSync(path.join(dir,'..','replay-must-not-write'),'forbidden'),{code:'REPLAY_WRITE_OUTSIDE_COPY'});
    fs.writeFileSync(path.join(dir,'allowed'),'isolated');
  }finally{guard.restore();}
  assert.deepEqual(audit,{networkAttempts:2,modelAttempts:1,subprocessAttempts:1,outsideWriteAttempts:1});
  assert.equal(fs.readFileSync(path.join(dir,'allowed'),'utf8'),'isolated');
});

test('pure inspect catches attempted state writes and permits cloning actual readonly inputs',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-history-purity-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a={dir,data:{tasks:[{id:'synthetic-task',notes:'original'}]}},assertions=[];
  const before=h.digest(a.data),original=a.data;
  const value=h.pureInspect(a,()=>structuredClone({nested:{task:a.data.tasks[0]}}),assertions,'read');
  assert.ok(value.nested.task.id);assert.equal(assertions[0].passed,true);
  assert.throws(()=>h.pureInspect(a,()=>{a.data.tasks[0].notes='counterfactual forbidden';},assertions,'write'),{code:'INSPECT_MUTATION'});
  assert.equal(assertions[1].passed,false);assert.equal(a.data,original);assert.equal(h.digest(a.data),before);
  assert.throws(()=>h.pureInspect(a,()=>fs.writeFileSync(path.join(dir,'forbidden'),'x'),assertions,'disk'),{code:'INSPECT_MUTATION'});
  assert.equal(assertions[2].passed,false);assert.equal(fs.existsSync(path.join(dir,'forbidden')),false);
});

test('CLI rejects unknown or incomplete selection; an invalid sample is never a skipped pass',async t=>{
  assert.throws(()=>h.parseArgs(['--snapshot']),{code:'MISSING_ARGUMENT'});
  assert.throws(()=>h.parseArgs(['--snapshot','invented=/tmp']),{code:'UNKNOWN_SNAPSHOT'});
  assert.throws(()=>h.validateInputs({scenarioIds:['invented']}),{code:'UNKNOWN_SCENARIO'});
  assert.throws(()=>h.validateInputs({output:path.resolve(__dirname,'../report.json')}),{code:'REPORT_IN_SOURCE_FORBIDDEN'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-output-preflight-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.throws(()=>h.validateInputs({snapshots:{S57:dir},output:path.join(dir,'report.json')}),{code:'REPORT_OVERLAPS_SNAPSHOT'});
  assert.throws(()=>h.manifest(path.join(dir,'missing-directory')),{code:'ENOENT'});
});

