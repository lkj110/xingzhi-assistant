const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const journal=require('../desktop/work-journal.cjs');
const state=require('../desktop/work-state.cjs');
const spend=require('../desktop/spend.cjs');
const errors=require('../desktop/model-errors.cjs');

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-resume-'));
  const calls=[];
  const a=new Assistant({dir,agentRequest:async()=>{throw Error('unexpected network request');},chat:async(_p,_k,_m,o)=>{
    calls.push(o.stage);o.onUsage({inputTokens:10,outputTokens:5});
    return {tool:'ask',args:{question:'请确认下一步范围'},reason:'恢复后已经实际推进'};
  }});
  t.after(async()=>{require('../desktop/execution.cjs').abortAll(a);await a.runPromise;fs.rmSync(dir,{recursive:true,force:true});});
  await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
  const job=agent.buildJob(a,{goal:'整理说明',allowWeb:false,fileMode:'off',autoAccept:false,maxActions:1});
  a.data.delegations.push(job);a.save();
  return {a,job,calls,dir};
}
function cancelled(job){Object.assign(job,{lastError:'操作已停止',lastErrorCode:'MODEL_CANCELLED',lastErrorAutomaticRetry:false,failures:1});}
function assertCleared(job){assert.ok(!job.lastError);assert.equal(job.lastErrorCode,undefined);assert.equal(job.lastErrorAutomaticRetry,undefined);}

test('pause during a model request, resume, restart and tick actually launch the next run',{timeout:10000},async t=>{
  const {a,job,dir,calls}=await fixture(t),chat=a.chat,entered=Promise.withResolvers();
  a.chat=async(_p,_k,_m,o)=>new Promise((_resolve,reject)=>{
    o.signal.addEventListener('abort',()=>reject(errors.cancelledError()),{once:true});entered.resolve();
  });
  await a.dispatch('agentRun',{id:job.id});await entered.promise;
  await a.dispatch('agentPause',{id:job.id});await a.runPromise;
  assert.equal(job.status,'paused');assert.equal(job.lastErrorCode,'MODEL_CANCELLED');assert.equal(job.lastErrorAutomaticRetry,false);
  const ledger=structuredClone(a.spendLedger),callsUsed=job.callsUsed,oldRun=structuredClone(a.data.agentRuns[0]);
  assert.equal(agent.tick(a),false);
  await a.dispatch('agentResume',{id:job.id});
  assert.equal(job.status,'ready');assert.ok(Date.parse(job.nextRunAt)<=Date.now());assertCleared(job);
  assert.deepEqual(a.spendLedger,ledger);assert.deepEqual(a.data.agentRuns[0],oldRun);assert.equal(job.callsUsed,callsUsed);
  const b=new Assistant({dir,chat,agentRequest:a.agentRequest}),restored=b.data.delegations[0];
  t.after(async()=>{require('../desktop/execution.cjs').abortAll(b);await b.runPromise;});
  assertCleared(restored);assert.equal(agent.tick(b),true);await b.runPromise;
  assert.deepEqual(calls,['planner']);assert.equal(restored.callsUsed,callsUsed+1);assert.equal(b.data.agentRuns.length,2);
  assert.equal(restored.status,'needs_input');assert.equal(b.data.agentRuns[0].steps[0].tool,'ask');
});

test('a committed resume clears cancellation on crash replay and remains idempotent',async t=>{
  const {a,job}=await fixture(t);await a.dispatch('agentPause',{id:job.id});cancelled(job);a.save();
  const backup=structuredClone(a.data),save=a.save;
  a.save=()=>{throw Error('workspace write interrupted');};
  try{assert.throws(()=>journal.recordResume(a,{kind:'job',id:job.id,status:'ready'}),e=>e.committed&&e.projectionPending);}
  finally{a.save=save;}
  assert.ok(journal.read(a).events.some(e=>e.type==='execution_resumed'&&e.actor==='user'));
  a.data=backup;journal.replay(a,{force:true});
  const restored=a.data.delegations[0];assert.equal(restored.status,'ready');assertCleared(restored);
  const count=journal.read(a).events.length,nextRunAt=restored.nextRunAt;
  journal.replay(a,{force:true});assertCleared(restored);assert.equal(restored.nextRunAt,nextRunAt);assert.equal(journal.read(a).events.length,count);
  assert.equal(agent.tick(a),true);await a.runPromise;assert.equal(a.data.agentRuns[0].steps[0].tool,'ask');
});

test('explicit continue can run an already-ready job with a stale cancellation gate',async t=>{
  const {a,job,calls}=await fixture(t);cancelled(job);a.save();
  assert.equal(agent.tick(a),false);await a.dispatch('agentRun',{id:job.id});await a.runPromise;
  assertCleared(job);assert.deepEqual(calls,['planner']);assert.equal(job.status,'needs_input');
});

test('resume preserves permanent errors even when their message resembles cancellation',async t=>{
  for(const code of ['MODEL_AUTH','MODEL_QUOTA','MODEL_CONFIG','MODEL_BLOCKED','MODEL_HTTP','MODEL_STORAGE'])await t.test(code,async t=>{
    const {a,job,calls}=await fixture(t);await a.dispatch('agentPause',{id:job.id});
    cancelled(job);job.lastErrorCode=code;a.save();await a.dispatch('agentResume',{id:job.id});
    assert.equal(job.lastErrorCode,code);assert.equal(job.lastErrorAutomaticRetry,false);assert.equal(job.lastError,'操作已停止');
    assert.equal(agent.tick(a),false);assert.deepEqual(calls,[]);
  });
});

test('resuming cancellation preserves an unresolved permission request and grants no access',async t=>{
  const {a,job,calls}=await fixture(t);
  require('../desktop/access.cjs').request(a,job,{kind:'lark_document',target:'https://example.larkoffice.com/docx/Fixture'});
  await a.dispatch('agentPause',{id:job.id});cancelled(job);a.save();
  const decisions=structuredClone(a.data.decisions);
  await a.dispatch('agentResume',{id:job.id});assertCleared(job);
  assert.deepEqual(a.data.decisions,decisions);assert.equal(job.documentGrants,undefined);assert.equal(job.allowWeb,false);
  assert.ok(state.blockingReasons(a,job).some(r=>r.code==='decision'&&r.needsHuman));
  assert.equal(agent.tick(a),false);assert.deepEqual(calls,[]);
});

test('resume and continue cannot bypass budget or unknown usage accounting',async t=>{
  for(const kind of ['budget','unknown'])await t.test(kind,async t=>{
    const {a,job,calls}=await fixture(t);
    a.activeAgentJob=job;const scope=spend.scope(a);a.activeAgentJob=null;
    if(kind==='budget')scope.spentUSD=scope.limitUSD;else scope.unreservedCalls=1;
    scope.blocked={kind,message:'需要人工核对费用'};spend.persist(a);
    job.limitReason='spend';await a.dispatch('agentPause',{id:job.id});cancelled(job);a.save();
    const ledger=structuredClone(a.spendLedger);
    await a.dispatch('agentResume',{id:job.id});assertCleared(job);
    assert.equal(job.limitReason,'spend');assert.deepEqual(a.spendLedger,ledger);assert.equal(agent.tick(a),false);
    await assert.rejects(a.dispatch('agentRun',{id:job.id}),/费用|用量/);assert.deepEqual(a.spendLedger,ledger);assert.deepEqual(calls,[]);
  });
});

test('resume does not settle external results or approve pending writes',async t=>{
  for(const status of ['uncertain','pending','running'])await t.test(status,async t=>{
    const {a,job,calls}=await fixture(t);
    const action={id:'external',jobId:job.id,status,tool:'lark_update'};
    a.data.agentActions.push(action);job.pendingActionId=action.id;
    await a.dispatch('agentPause',{id:job.id});cancelled(job);a.save();
    const actions=structuredClone(a.data.agentActions);
    await a.dispatch('agentResume',{id:job.id});assertCleared(job);
    assert.deepEqual(a.data.agentActions,actions);assert.equal(action.status,status);assert.equal(action.approvedAt,undefined);assert.equal(job.pendingActionId,action.id);
    assert.equal(agent.tick(a),false);assert.deepEqual(calls,[]);
  });
});

test('automatic material ingestion and ticks preserve user pause and the cancellation gate',async t=>{
  const {a,job,calls}=await fixture(t);
  await a.dispatch('projectSave',{name:'恢复回归项目',background:'测试资料'});
  const project=a.data.projects[0];project.jobId=job.id;job.projectId=project.id;
  await a.dispatch('agentPause',{id:job.id});cancelled(job);a.save();
  await a.dispatch('import',{items:[{projectId:project.id,title:'新增证据',content:'测试材料已更新',origin:'测试'}]});
  assert.ok(job.sourceIds.length);assert.equal(job.status,'paused');assert.equal(job.lastErrorCode,'MODEL_CANCELLED');assert.equal(job.lastErrorAutomaticRetry,false);
  assert.equal(journal.read(a).events.some(e=>e.type==='execution_resumed'),false);
  assert.equal(agent.tick(a),false);assert.deepEqual(calls,[]);
  await assert.rejects(a.dispatch('agentRun',{id:job.id}),/暂停/);
});
