const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const state=require('../desktop/work-state.cjs');
const uiPromise=import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../src/execution-state.js'))).toString('base64'));
const progressPromise=import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../src/agent-progress.js'))).toString('base64'));

// No Assistant, persistence, model, platform adapter or network is instantiated.
function fixture({status='ready',phase='working',count=1}={}) {
  const job={id:'job',status,taskIds:[],sourceIds:[],followups:[],history:[],nextRunAt:null,
    executionState:{workEfficiency:{phase,history:[],tried:{}}}};
  const tasks=Array.from({length:count},(_,index)=>({id:`task-${index}`,agentJobId:job.id,title:`事项${index}`,status:'todo',sourceIds:[],dependsOn:[],steps:[{id:`draft-${index}`,kind:'draft',done:false}]}));
  job.taskIds=tasks.map(t=>t.id);
  const a={data:{tasks,delegations:[job],projects:[],sources:[],artifacts:[],decisions:[],agentActions:[],agentRuns:[],operations:[],runtime:{},stewardship:{paused:false}}};
  return {a,job,task:tasks[0],tasks};
}
function publicJob(a,job) {
  const projected={...structuredClone(job),workState:state.view(a,job)};
  delete projected.executionState;
  return projected;
}

test('SG exhausted recovery keeps structural candidates but exposes no runnable action or fake ready',async()=>{
  const {a,job}=fixture({status:'blocked',phase:'awaiting_change'});
  Object.assign(job,{lastError:'',summary:'正在自动纠偏',progressSummary:{recovery:{code:'AUTOMATIC_STRATEGY_REPAIR',message:'正在自动纠偏'}}});
  Object.assign(job.executionState.workEfficiency,{waitBasis:'plan57-210-sources',blocker:{code:'NO_EXECUTABLE_ALTERNATIVE'},lastFailure:{code:'PLAN_ALREADY_RECONCILED',message:'同一依据已调整过计划，请执行未完成步骤'}});
  const before=JSON.stringify(a.data),projection=state.view(a,job);
  assert.equal(state.candidateActions(a,job).length,1);
  assert.deepEqual(state.runnableActions(a,job),[]);
  assert.equal(projection.lifecycle,'blocked');
  assert.equal(projection.phase,'blocked');
  assert.deepEqual(projection.nextActions,[]);
  assert.equal(projection.error.code,'PLAN_ALREADY_RECONCILED');
  assert.equal(projection.error.message,job.executionState.workEfficiency.lastFailure.message);
  assert.equal(projection.needsHuman,false,'recovery failure is not a new authorization request');
  assert.equal(projection.gate.automaticAllowed,true,'permission gate remains distinct from recovery eligibility');
  assert.ok(projection.blockingReasons.some(r=>r.code==='recovery_blocked'&&r.errorCode==='PLAN_ALREADY_RECONCILED'));
  const ui=await uiPromise,{recoveryNotice}=await progressPromise,visible=publicJob(a,job);
  assert.equal(ui.readyLabel(a.data,visible),null);
  assert.equal(ui.workLabel(a.data,visible),'需要处理');
  assert.equal(recoveryNotice(visible,a.data.tasks),'恢复失败：同一依据已调整过计划，请执行未完成步骤');
  assert.equal(JSON.stringify(a.data),before,'projection and candidate inspection are read-only');
});

test('controller awaiting_change or exhausted prevents ready even if lifecycle lags behind',()=>{
  for(const phase of ['awaiting_change','exhausted'])for(const status of ['ready','running']) {
    const {a,job}=fixture({status,phase});
    job.executionState.workEfficiency.blocker={code:'RECOVERY_EXHAUSTED',lastFailure:{code:'CONTENT_REPAIR_REQUIRED',message:'仍缺少SQL读写核对'}};
    const view=state.view(a,job);
    assert.equal(state.candidateActions(a,job).length,1);
    assert.deepEqual(state.runnableActions(a,job),[]);
    assert.equal(view.phase,'blocked');
    assert.equal(view.error.code,'CONTENT_REPAIR_REQUIRED');
    assert.deepEqual(view.nextActions,[]);
  }
});

test('recovery_pending reserves candidates for the recovery dispatcher without ordinary advance',async()=>{
  const {a,job}=fixture({phase:'recovery_pending'});
  const view=state.view(a,job),{recoveryNotice}=await progressPromise,ui=await uiPromise;
  assert.equal(state.candidateActions(a,job).length,1);
  assert.deepEqual(state.runnableActions(a,job),[]);
  assert.equal(view.phase,'recovery_pending');
  assert.deepEqual(view.nextActions,[]);
  assert.equal(ui.readyLabel(a.data,{...job,workState:view}),null);
  assert.match(recoveryNotice({...job,workState:view},a.data.tasks),/^等待恢复调度/);
});

test('only an explicit eligible state transition restores dispatch; restart does not clear exhaustion',()=>{
  const {a,job}=fixture({status:'blocked',phase:'awaiting_change'});
  job.executionState.workEfficiency.lastFailure={code:'MODEL_INVALID_RESPONSE',message:'章节缺失'};
  const restarted={data:structuredClone(a.data)},restored=restarted.data.delegations[0];
  assert.equal(state.view(restarted,restored).phase,'blocked');
  assert.deepEqual(state.runnableActions(restarted,restored),[]);
  job.executionState.workEfficiency.phase='working';
  assert.equal(state.view(a,job).phase,'blocked','projection must not wake a blocked lifecycle');
  job.status='ready';
  assert.equal(state.view(a,job).phase,'ready');
  assert.deepEqual(state.runnableActions(a,job),state.candidateActions(a,job));
  assert.equal(state.view(a,job).error,null,'old failure history is not a current blocker');
});

test('structural task filters remain unchanged for paused, waiting, reviewed and blocked tasks',()=>{
  const {a,job,tasks}=fixture({count:7});
  tasks[1].status='paused';tasks[2].status='waiting';tasks[3].status='review';tasks[3].verification={passed:true};
  tasks[4].status='blocked';tasks[5].status='blocked';tasks[5].needsReplan='新要求';
  tasks[6].status='blocked';tasks[6].verification={passed:false};
  assert.deepEqual(state.candidateActions(a,job).map(r=>r.taskId),[tasks[0].id,tasks[5].id,tasks[6].id]);
  assert.deepEqual(state.runnableActions(a,job),state.candidateActions(a,job));
  tasks[0].steps[0].kind='external';
  assert.equal(state.candidateActions(a,job)[0].tool,'verify_content');
});

test('candidate and runnable paths retain terminal, pause, storage and budget gates',()=>{
  const guards=[
    f=>{f.job.status='completed';},f=>{f.job.deletedAt='2026-10-16';},
    f=>{f.job.status='paused';},f=>{f.job.executionPaused=true;},
    f=>{f.a.data.stewardship.paused=true;},f=>{f.a.suspended=true;},
    f=>{f.job.status='limited';f.job.limitReason='budget';},
    f=>{f.a.data.runtime.projectionPending={commitId:'pending'};},
    f=>{f.a.data.runtime.workJournalError={code:'STORAGE_FAILURE'};},
    f=>{f.job.projectId='project';f.a.data.projects.push({id:'project',archivedAt:'now'});},
    f=>{f.task.status='paused';}
  ];
  for(const apply of guards) {
    const f=fixture();apply(f);const before=JSON.stringify(f.a.data);
    assert.deepEqual(state.candidateActions(f.a,f.job),[]);
    assert.deepEqual(state.runnableActions(f.a,f.job),[]);
    assert.ok(!state.view(f.a,f.job).nextActions.some(r=>r.type==='advance'));
    assert.equal(JSON.stringify(f.a.data),before);
  }
});

test('pending and uncertain external effects retain their blocker identities and human requirements',()=>{
  for(const status of ['pending','uncertain','running']) {
    const {a,job}=fixture();
    a.data.agentActions.push({id:'original-write',jobId:job.id,scope:'job',status});
    const view=state.view(a,job);
    assert.deepEqual(state.candidateActions(a,job),[]);
    assert.deepEqual(view.runnableActions,[]);
    assert.deepEqual(view.nextActions,[]);
    assert.ok(view.blockingReasons.some(r=>r.id==='original-write'));
    assert.equal(view.needsHuman,status!=='running');
  }
});

test('task-scoped blockers still allow independent siblings while job-scoped blockers stop all',()=>{
  const {a,job,tasks}=fixture({status:'needs_input',count:2});
  a.data.decisions.push({id:'decision',jobId:job.id,scope:'task',taskIds:[tasks[0].id],status:'open'});
  a.data.agentActions.push({id:'write',jobId:job.id,taskId:tasks[0].id,status:'uncertain'});
  assert.deepEqual(state.runnableActions(a,job).map(r=>r.taskId),[tasks[1].id]);
  assert.equal(state.view(a,job).phase,'ready');
  assert.deepEqual(state.view(a,job).pendingNodeIds,['decision','write']);
  job.status='blocked';
  assert.deepEqual(state.runnableActions(a,job).map(r=>r.taskId),[tasks[1].id],'a scoped wait does not stop an independent sibling');
  const projected=state.view(a,job);
  assert.equal(projected.phase,'ready','execution phase reflects the independently runnable sibling');
  assert.equal(projected.lifecycle,'blocked','inspection preserves the historical lifecycle');
  assert.equal(job.status,'blocked');
  assert.deepEqual(projected.nextActions.map(r=>r.taskId),[tasks[1].id]);
  job.executionState.workEfficiency.phase='awaiting_change';
  assert.deepEqual(state.runnableActions(a,job),[],'controller exhaustion stops the whole recovery');
  job.executionState.workEfficiency.phase='working';
  a.data.decisions[0].scope='job';
  assert.deepEqual(state.candidateActions(a,job),[]);
});

test('exhausted job cannot suppress a pending external result requiring human reconciliation',()=>{
  const {a,job}=fixture({status:'blocked',phase:'awaiting_change'});
  a.data.agentActions.push({id:'write',jobId:job.id,status:'uncertain'});
  const view=state.view(a,job);
  assert.equal(view.phase,'blocked');assert.equal(view.needsHuman,true);
  assert.deepEqual(view.pendingNodeIds,['write']);
  assert.deepEqual(view.runnableActions,[]);
});

test('terminal and paused lifecycles outrank stale recovery history',async()=>{
  const {recoveryNotice}=await progressPromise;
  for(const status of ['completed','deleted','cancelled','paused','limited','finalizing']) {
    const {a,job}=fixture({status,phase:'awaiting_change'});
    job.executionState.workEfficiency.lastFailure={code:'OLD',message:'旧失败'};
    const view=state.view(a,job);
    assert.equal(view.phase,status);
    assert.equal(recoveryNotice({...job,workState:view},a.data.tasks),'');
    assert.ok(!view.nextActions.some(r=>r.type==='advance'));
  }
});

test('a finished run or recovery object is not evidence that the job is running or recovering',async()=>{
  const {a,job}=fixture({status:'blocked',phase:'awaiting_change'});
  a.data.agentRuns.push({id:'run',jobId:job.id,status:'done',finishedAt:'2026-10-16T10:00:00Z'});
  assert.equal(state.view(a,job).phase,'blocked');
  job.status='running';job.executionState.workEfficiency.phase='working';
  job.progressSummary={recovery:{code:'AUTOMATIC_STRATEGY_REPAIR',message:'正在恢复旧路径'}};
  const {recoveryNotice}=await progressPromise;
  assert.equal(state.view(a,job).phase,'ready','a stale lifecycle alone is not an in-flight operation');
  assert.equal(recoveryNotice(publicJob(a,job),a.data.tasks),'');
  a.data.operations.push({jobId:job.id,startedAt:'now'});
  assert.equal(state.view(a,job).phase,'ready','a saved operation row cannot prove a live process');
  a.executionOwner={executions:new Map([['job:job',{jobId:job.id}]])};
  assert.equal(state.view(a,job).phase,'running');
  assert.equal(recoveryNotice(publicJob(a,job),a.data.tasks),'','an unrelated recovery record is not active recovery');
  job.executionState.workEfficiency.phase='recovering';
  assert.match(recoveryNotice(publicJob(a,job),a.data.tasks),/^正在恢复：/);
  a.data.operations=[];
  a.executionOwner.executions.clear();
  assert.match(recoveryNotice(publicJob(a,job),a.data.tasks),/^等待恢复调度/);
});

test('live execution-owner and direct Agent run contexts are recognized without loading a controller',()=>{
  const {a,job}=fixture({status:'running',phase:'recovering'});
  a.executionOwner={executions:new Map([['job:job',{jobId:job.id}]])};
  assert.equal(state.view(a,job).phase,'running');
  a.executionOwner.executions.clear();
  a.activeAgentJob=job;a.activeAgentRun={status:'running'};
  assert.equal(state.view(a,job).phase,'running');
  a.activeAgentRun.finishedAt='now';
  assert.equal(state.view(a,job).phase,'ready');
});

test('blocked jobs without a controller retain their actual error without mutating the source',()=>{
  const {a,job}=fixture({status:'blocked'});delete job.executionState;
  job.lastError='保存工作记录失败';job.lastErrorCode='STORAGE_FAILURE';
  const before=JSON.stringify(a.data);
  assert.deepEqual(state.view(a,job).error,{code:'STORAGE_FAILURE',message:'保存工作记录失败'});
  assert.equal(state.candidateActions(a,job).length,1);
  assert.deepEqual(state.runnableActions(a,job),[]);
  assert.equal(JSON.stringify(a.data),before);
});

test('UI respects projected phase and closed gates instead of stale lifecycle and recovery messages',async()=>{
  const {a,job}=fixture(),ui=await uiPromise,{recoveryNotice}=await progressPromise;
  const visible={...job,status:'ready',autoRecovery:{status:'recovering'},workState:{phase:'blocked',gate:{automaticAllowed:true},error:{message:'未完成核对'}}};
  assert.equal(ui.readyLabel(a.data,visible),null);
  assert.equal(recoveryNotice(visible,[]),'恢复失败：未完成核对');
  visible.workState={phase:'ready',gate:{automaticAllowed:false}};
  assert.equal(ui.readyLabel(a.data,visible),'等待执行条件恢复');
  assert.equal(recoveryNotice(visible,[]),'');
  visible.workState={phase:'ready',gate:{automaticAllowed:true}};
  assert.equal(ui.readyLabel(a.data,visible),'即将自动推进');
  assert.match(recoveryNotice(visible,[]),/等待重试/);
  assert.doesNotMatch(recoveryNotice(visible,[]),/正在恢复/);
});

test('one blocked job does not change another job eligibility or its spend and source facts',()=>{
  const {a,job}=fixture({status:'blocked',phase:'awaiting_change'}),other=fixture();
  other.job.id='other';other.task.agentJobId='other';other.task.id='other-task';other.job.taskIds=['other-task'];
  a.data.delegations.push(other.job);a.data.tasks.push(other.task);
  job.sourceIds=['saved-source'];job.usage={estimatedUSD:153.83326746};job.heldUSD=3.30575550;
  const before=JSON.stringify(a.data);
  assert.deepEqual(state.runnableActions(a,job),[]);
  assert.equal(state.runnableActions(a,other.job).length,1);
  state.project(a);
  assert.equal(JSON.stringify(a.data),before);
});
