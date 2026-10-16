const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const acceptance=require('../desktop/acceptance.cjs');
const journal=require('../desktop/work-journal.cjs');
const transitions=require('../desktop/state-transitions.cjs');
const control=require('../desktop/execution-control.cjs');
const state=require('../desktop/work-state.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
function fixture(t,{count=1,mode='one_shot'}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lifecycle-v3-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const job={id:'job',mode,status:'review',goal:'交付当前说明',workRevision:1,taskIds:[],sourceIds:[],feedback:[],followups:[],watchers:[],history:[],fileMode:'off',autoAccept:true};
  const a={dir,file:path.join(dir,'workspace.json'),data:{runtime:{},tasks:[],delegations:[job],projects:[],sources:[],artifacts:[],agentActions:[],decisions:[],events:[],connectors:[],agentRuns:[],settings:{autoComplete:true},stewardship:{paused:false}},save(){journal.beforeSave(this);fs.writeFileSync(this.file,JSON.stringify(this.data));},event(title,detail,taskId){this.data.events.push({title,detail,taskId});},ensureIdle(){},task(id){return this.data.tasks.find(t=>t.id===id);}};
  for(let i=0;i<count;i++) {
    const task={id:`t${i}`,title:`事项${i}`,criteria:'完整说明',description:'完成说明',agentJobId:'job',status:'review',workRevision:1,sourceIds:[],steps:[{id:`s${i}`,kind:'draft',done:true,artifactId:`a${i}`}],notes:[],dependsOn:[]};
    job.taskIds.push(task.id);a.data.tasks.push(task);a.data.artifacts.push({id:`a${i}`,taskId:task.id,stepId:`s${i}`,content:`完整正文${i}`});
  }
  for(const task of a.data.tasks) task.verification={passed:true,summary:'符合范围',gaps:[],basis:acceptance.basis(a,task)};
  a.save();return {a,job,task:a.data.tasks[0],tasks:a.data.tasks,dir};
}
function check(a,job){return acceptance.recordCompletionCheck(a,job,{passed:true,summary:'整体满足要求',gaps:[]},{basis:acceptance.completionBasis(a,job)});}
function select(a,tasks){return {items:tasks.map(t=>({id:t.id,revision:acceptance.revision(a,t)}))};}

test('final acceptance closes task and one-shot job locally even with pause and exhausted budget',t=>{
  const {a,job,task}=fixture(t);check(a,job);const basis=acceptance.completionBasis(a,job);
  a.data.stewardship.paused=true;job.status='limited';job.limitReason='budget';job.nextRunAt='2099-01-01';job.autoRecovery={status:'scheduled'};
  const result=acceptance.accept(a,select(a,[task]));
  assert.equal(task.status,'completed');assert.equal(job.status,'completed');assert.equal(job.nextRunAt,undefined);assert.equal(job.autoRecovery,undefined);
  assert.equal(acceptance.completionBasis(a,job),basis);assert.equal(result.modelCalls,0);assert.equal(result.networkRequests,0);
  assert.equal(journal.read(a).events.filter(e=>['accepted','completed'].includes(e.type)).every(e=>e.commitId===result.commitId),true);
  assert.equal(JSON.parse(fs.readFileSync(a.file)).delegations[0].status,'completed');
});
test('last acceptance requires current overall check and current delivery; batch preflight writes nothing',t=>{
  const {a,job,tasks}=fixture(t,{count:2});const before=JSON.stringify(a.data);
  assert.throws(()=>acceptance.accept(a,select(a,tasks)),e=>e.code==='COMPLETION_REQUIRED');assert.equal(JSON.stringify(a.data),before);
  check(a,job);a.data.artifacts[1].content='changed';
  assert.throws(()=>acceptance.accept(a,select(a,tasks)),/依据已变化/);assert.ok(tasks.every(t=>t.status==='review'));
});
test('partial acceptance permits remaining work; accepted siblings participate in final check',t=>{
  const {a,job,tasks}=fixture(t,{count:2});
  acceptance.acceptOne(a,{id:tasks[0].id});assert.equal(tasks[0].status,'completed');assert.equal(job.status,'review');
  assert.equal(control.next(a,job).tool,'complete');check(a,job);acceptance.acceptOne(a,{id:tasks[1].id});assert.equal(job.status,'completed');
});
test('continuous service accepts the current batch and stays watching',t=>{
  const {a,job,task}=fixture(t,{mode:'continuous'});job.followups.push({key:'future',workRevision:2,required:false,status:'waiting',expected:'未来服务'});
  task.verification.basis=acceptance.basis(a,task);check(a,job);acceptance.acceptOne(a,{id:task.id});
  assert.equal(task.status,'completed');assert.equal(job.status,'watching');assert.equal(job.followups[0].status,'waiting');
  assert.equal(control.next(a,job),null);
});
test('legacy accepted work becomes finalizing without rewriting or requesting acceptance',t=>{
  const {a,job,task}=fixture(t);task.status='completed';task.acceptedAt='2020-01-01';task.acceptedBy='user';task.verification=null;
  acceptance.reconcileJobCompletion(a,job);assert.equal(job.status,'finalizing');assert.equal(task.acceptedAt,'2020-01-01');
  assert.equal(control.stage(a,task),'completed');assert.equal(control.next(a,job),null);assert.equal(task.status,'completed');
  assert.equal(state.workState(a,job).acceptanceState,'accepted_pending_check');
});
test('terminal state outranks stale repair, review, pause and retries in shared projection',async t=>{
  const {a,job,task}=fixture(t);task.status='completed';task.needsReplan=true;job.status='completed';a.data.stewardship.paused=true;job.nextRunAt='2099-01-01';
  assert.equal(control.stage(a,task),'completed');const backend=state.workState(a,job);assert.equal(backend.phase,'completed');assert.equal(backend.activeCountKey,null);assert.equal(backend.gate.reason,'terminal');
  const ui=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../src/execution-state.js'))).toString('base64'));
  const data={...a.data,workStates:state.project(a)};assert.equal(ui.workState(data,job).phase,backend.phase);assert.equal(ui.readyLabel(data,job),null);assert.equal(ui.workLabel(data,job),'已完成');
});
test('task-scoped wait and decision do not block independent sibling; job scope does',t=>{
  const {a,job,tasks}=fixture(t,{count:2});for(const task of tasks){task.status='todo';task.verification=null;}
  a.data.decisions.push({id:'d',jobId:job.id,scope:'task',taskIds:[tasks[0].id],status:'open'});job.status='needs_input';
  job.followups.push({key:'wait',taskId:tasks[0].id,status:'waiting'});
  assert.deepEqual(control.runnableActions(a,job).map(r=>r.taskId),[tasks[1].id]);assert.equal(control.next(a,job).args.taskId,tasks[1].id);
  assert.equal(state.workState(a,job).phase,'ready');assert.deepEqual(state.workState(a,job).pendingNodeIds,['d']);
  a.data.decisions[0].scope='job';assert.deepEqual(control.runnableActions(a,job),[]);
});
test('unrelated task events do not stale the selected acceptance revision',t=>{
  const {a,tasks}=fixture(t,{count:2});const revision=acceptance.revision(a,tasks[0]);tasks[1].status='todo';tasks[1].updatedAt='later';
  a.data.agentActions.push({id:'other-action',jobId:'job',taskId:tasks[1].id,status:'uncertain'});
  assert.equal(acceptance.revision(a,tasks[0]),revision);acceptance.acceptOne(a,{id:tasks[0].id,revision});assert.equal(tasks[0].status,'completed');
});
test('journal committed then workspace failure never rolls back acceptance; replay is idempotent',t=>{
  const {a,job,task}=fixture(t);check(a,job);const backup=JSON.parse(fs.readFileSync(a.file));const save=a.save;a.save=()=>{throw Error('projection disk failure');};
  assert.throws(()=>acceptance.acceptOne(a,{id:task.id}),e=>e.committed&&e.projectionPending);
  assert.equal(task.status,'completed');assert.equal(job.status,'completed');assert.ok(a.data.runtime.projectionPending);assert.ok(task.projectionPending);
  const count=journal.read(a).events.length;a.save=save;journal.replay(a);assert.equal(a.data.runtime.projectionPending,undefined);assert.equal(task.acceptanceHistory.length,1);
  a.data=backup;journal.replay(a,{force:true});assert.equal(a.data.tasks[0].status,'completed');assert.equal(a.data.delegations[0].status,'completed');
  journal.replay(a,{force:true});assert.equal(a.data.tasks[0].acceptanceHistory.length,1);assert.equal(journal.read(a).events.length,count);
});
test('pre-commit journal write failure leaves all business state and references unchanged',t=>{
  const {a,job,task}=fixture(t);check(a,job);a.workJournalFile=path.join(a.dir,'missing','journal.json');const before=JSON.stringify(a.data);
  assert.throws(()=>acceptance.acceptOne(a,{id:task.id}));assert.equal(JSON.stringify(a.data),before);assert.equal(task.status,'review');
});
test('causal sequence beats clock time; explicit reopen wins later than acceptance after restore',t=>{
  const {a,job,task}=fixture(t);check(a,job);const backup=structuredClone(a.data);
  acceptance.acceptTask(a,{id:task.id},{at:'2099-01-01T00:00:00Z'});
  journal.recordReopen(a,{id:task.id,requirementRevision:'new-requirement'});assert.equal(task.workRevision,2);assert.equal(task.status,'todo');
  a.data=backup;journal.replay(a,{force:true});const restored=a.data.tasks[0];assert.equal(restored.workRevision,2);assert.equal(restored.status,'todo');assert.equal(restored.acceptanceHistory.length,1);assert.equal(restored.acceptanceHistory[0].acceptedAt,'2099-01-01T00:00:00Z');
});
test('corrupt and causally forked logs fail closed, never fall back to an old review snapshot',t=>{
  const {a,job,task}=fixture(t);check(a,job);acceptance.acceptOne(a,{id:task.id});const log=journal.read(a);log.events.at(-1).previousEventId='fork';log.checksum=hash(log.events);fs.writeFileSync(journal.file(a),JSON.stringify(log));
  const before=JSON.stringify(a.data);assert.throws(()=>journal.replay(a),/因果/);assert.equal(JSON.stringify(a.data),before);
});
test('delete and withdrawal replay never revive the business object or withdrawn binding',t=>{
  const {a,task}=fixture(t);task.contextBindings=[{bindingId:'binding',state:'active'}];task.sourceIds=['s'];
  journal.recordWithdraw(a,{id:task.id,bindingId:'binding',sourceId:'s'});journal.recordDelete(a,{id:task.id});
  task.contextBindings[0].state='active';task.sourceIds=['s'];delete task.deletedAt;journal.replay(a,{force:true});
  assert.equal(task.contextBindings[0].state,'withdrawn');assert.deepEqual(task.sourceIds,[]);assert.ok(task.deletedAt);
  a.data.tasks=[];journal.replay(a,{force:true});assert.equal(a.data.tasks.length,0);assert.ok(a.data.recoveryReviews.length);
});
test('ordinary saves do not invent user intent or reopen events',t=>{
  const {a,job,task}=fixture(t);check(a,job);acceptance.acceptOne(a,{id:task.id});const count=journal.read(a).events.length;
  task.updatedAt='later';job.callsUsed=200;journal.observeCommittedState(a);a.save();assert.equal(journal.read(a).events.length,count);
  assert.throws(()=>journal.recordUserEdit(a,{id:task.id,requirementRevision:'new'}),e=>e.code==='WORK_REOPEN_REQUIRED');
});
test('policy acceptance uses same current completion preflight and records policy actor',t=>{
  const {a,job,task}=fixture(t);assert.throws(()=>acceptance.acceptTask(a,{id:task.id},{actor:'policy'}),e=>e.code==='COMPLETION_REQUIRED');
  check(a,job);job.autoAccept=false;assert.throws(()=>acceptance.acceptTask(a,{id:task.id},{actor:'policy'}),/未启用/);
  job.autoAccept=true;acceptance.acceptTask(a,{id:task.id},{actor:'policy'});assert.equal(task.acceptedBy,'policy');assert.equal(job.status,'completed');
});
test('late completion check and mismatched current artifact receipt are rejected',t=>{
  const {a,job,task}=fixture(t);const old=acceptance.completionBasis(a,job);job.feedback.push({text:'新增要求'});
  assert.throws(()=>acceptance.recordCompletionCheck(a,job,{passed:true,summary:'passed',gaps:[]},{basis:old}),e=>e.code==='COMPLETION_STALE');
  task.steps.push({id:'write',kind:'external',tool:'write_file',done:true,evidence:JSON.stringify({actionId:'write'})});
  a.data.agentActions.push({id:'write',taskId:task.id,jobId:job.id,tool:'write_file',status:'done',artifactId:'obsolete',result:{verified:true}});task.verification.basis=acceptance.basis(a,task);
  assert.equal(acceptance.completionCandidate(a,job).ready,false);
});
test('state-transitions preserves a supplied durable receipt through projection exceptions',t=>{
  const {a,task}=fixture(t);const receipt=journal.append(a,[{entityKind:'task',entityId:task.id,type:'accepted',workRevision:1,payload:{},actor:'user'}]);
  assert.throws(()=>transitions.commit(a,()=>{task.status='completed';throw Error('partial projection');},{commitReceipt:receipt}),e=>e.committed);
  assert.equal(task.status,'completed');assert.ok(a.data.runtime.projectionPending);journal.replay(a);assert.equal(task.acceptedBy,'user');
});

test('normal restart skips already-applied baseline and preserves subsequent review progress',t=>{
  const {a,job,task}=fixture(t);task.status='todo';task.verification=null;delete job.mode;
  journal.initialize(a,{migrate:true});assert.equal(job.mode,'one_shot');const initialSequence=task.workEvent.sequence;
  task.status='review';task.verification={passed:true,summary:'new check',gaps:[],basis:acceptance.basis(a,task)};a.save();
  a.data=JSON.parse(fs.readFileSync(a.file));journal.initialize(a);assert.equal(a.data.tasks[0].status,'review');assert.equal(a.data.tasks[0].verification.summary,'new check');assert.equal(a.data.tasks[0].workEvent.sequence,initialSequence);
});
test('empty workspace initialization persists an empty authority and survives restart',t=>{
  const {a}=fixture(t);a.data.tasks=[];a.data.delegations=[];journal.initialize(a,{migrate:true});assert.equal(journal.read(a).events.length,0);
  a.data=JSON.parse(fs.readFileSync(a.file));journal.initialize(a);assert.equal(a.data.runtime.workJournal.initialized,true);
  fs.unlinkSync(journal.file(a));assert.throws(()=>journal.initialize(a,{migrate:true}),/缺失/);
});
test('registered domain projection advances entity sequence without reverting normal progress at restart',t=>{
  const {a,task}=fixture(t);journal.initialize(a,{migrate:true});task.status='review';
  journal.registerProjector('test_domain_marker',(_a,target,event)=>{target.domainMarker=event.payload.marker;});
  journal.commit(a,[{entityKind:'task',entityId:task.id,type:'test_domain_marker',workRevision:1,payload:{marker:'observed'},actor:'system'}]);const sequence=task.workEvent.sequence;
  task.status='waiting';a.save();a.data=JSON.parse(fs.readFileSync(a.file));journal.initialize(a);
  assert.equal(a.data.tasks[0].status,'waiting');assert.equal(a.data.tasks[0].domainMarker,'observed');assert.equal(a.data.tasks[0].workEvent.sequence,sequence);
});
test('owning policy batch skips its own operation lock but never skips policy or stale-check checks',t=>{
  const {a,job,tasks}=fixture(t,{count:2});check(a,job);a.ensureIdle=()=>{throw Error('busy');};a.activeAgentJob=job;
  assert.throws(()=>acceptance.acceptOne(a,{id:tasks[0].id}),/busy/);job.autoAccept=false;assert.throws(()=>acceptance.acceptPolicy(a,job),/未启用/);
  job.autoAccept=true;const result=acceptance.acceptPolicy(a,job);assert.equal(result.acceptedIds.length,2);assert.ok(tasks.every(t=>t.acceptedBy==='policy'));assert.equal(job.status,'completed');
  const events=journal.read(a).events.filter(e=>e.type==='accepted'||e.type==='completed');assert.equal(new Set(events.map(e=>e.commitId)).size,1);
});
test('double-click batch acceptance reuses the recorded acceptance instead of appending events',t=>{
  const {a,job,task}=fixture(t);check(a,job);const input=select(a,[task]);acceptance.accept(a,input);const count=journal.read(a).events.length;
  assert.equal(acceptance.accept(a,input).replayed,true);assert.equal(journal.read(a).events.length,count);
});
test('legacy task without workRevision keeps exact check basis when acceptance initializes revision',t=>{
  const {a,job,task}=fixture(t);delete task.workRevision;task.verification.basis=acceptance.basis(a,task);check(a,job);const before=acceptance.completionBasis(a,job);
  acceptance.acceptOne(a,{id:task.id});assert.equal(task.workRevision,1);assert.equal(task.verification.basis,acceptance.basis(a,task));assert.equal(acceptance.completionBasis(a,job),before);
});

test('explicit user-command retry with the same commitId cannot create a second work revision',t=>{
  const {a,job,task}=fixture(t);check(a,job);acceptance.acceptOne(a,{id:task.id});const input={id:task.id,expectedWorkRevision:1,commitId:'reopen-once'};
  journal.recordReopen(a,input);const count=journal.read(a).events.length;journal.recordReopen(a,input);
  assert.equal(task.workRevision,2);assert.equal(job.workRevision,2);assert.equal(journal.read(a).events.length,count);
  assert.throws(()=>journal.recordReopen(a,{...input,requirementRevision:'other'}),e=>e.code==='WORK_JOURNAL_CONFLICT');
});
test('replaying an older idempotent commit cannot move the applied cursor backwards',t=>{
  const {a,task}=fixture(t);const first=journal.commit(a,[{entityKind:'task',entityId:task.id,type:'user_edited',payload:{requirementRevision:'v2'}}],{commitId:'first'});
  journal.recordUserEdit(a,{id:task.id,requirementRevision:'v3'});const sequence=a.data.runtime.workJournal.appliedSequence;
  journal.project(a,first);assert.equal(a.data.runtime.workJournal.appliedSequence,sequence);assert.equal(task.requirementRevision,'v3');
});
test('accepted delivery missing after backup restore stays completed with a separate review node',t=>{
  const {a,job,task}=fixture(t);check(a,job);acceptance.acceptOne(a,{id:task.id});a.data.artifacts=[];
  journal.replay(a,{force:true});const view=state.workState(a,task);assert.equal(view.phase,'completed');assert.equal(view.acceptanceState,'accepted');assert.deepEqual(view.nextActions,[{type:'review_delivery',id:`delivery:${task.id}`}]);assert.equal(a.data.artifacts.length,0);
});
test('durable completion records store artifact and receipt references without business body copies',t=>{
  const {a,job,task}=fixture(t);a.data.agentActions.push({id:'receipt',jobId:job.id,taskId:task.id,tool:'write_file',status:'done',artifactId:'a0',result:{verified:true,content:'SECRET_BUSINESS_BODY'}});task.verification.basis=acceptance.basis(a,task);check(a,job);acceptance.acceptOne(a,{id:task.id});
  assert.ok(!fs.readFileSync(journal.file(a),'utf8').includes('SECRET_BUSINESS_BODY'));assert.ok(!fs.readFileSync(journal.file(a),'utf8').includes('完整正文0'));
});

test('standalone core policy acceptance skips only its own active task lock',t=>{
  const {a,task}=fixture(t);delete task.agentJobId;a.data.delegations=[];task.verification.basis=acceptance.basis(a,task);a.ensureIdle=()=>{throw Error('busy');};
  assert.throws(()=>acceptance.acceptTask(a,{id:task.id},{actor:'policy'}),/busy/);a.activeSpendTask=task;acceptance.acceptTask(a,{id:task.id},{actor:'policy'});assert.equal(task.acceptedBy,'policy');assert.equal(task.status,'completed');
});

test('manual completion records the user confirmation without manufacturing a passed model check',t=>{
  const {a,task}=fixture(t);delete task.agentJobId;a.data.delegations=[];task.status='todo';task.verification=null;
  acceptance.markManualComplete(a,{id:task.id,confirmation:{summary:'已人工完成，凭据保存在本地',evidenceRefs:['user-receipt']}});
  assert.equal(task.status,'completed');assert.equal(task.completionMode,'manual');assert.equal(task.verification,null);assert.equal(state.workState(a,task).acceptanceState,'manual');assert.equal(task.manualConfirmation.origin,'user');
});

test('a self-consistent but truncated journal cannot override a newer committed workspace cursor',t=>{
  const {a,job,task}=fixture(t);check(a,job);acceptance.acceptOne(a,{id:task.id});const log=journal.read(a);log.events=log.events.slice(0,1);log.checksum=hash(log.events);fs.writeFileSync(journal.file(a),JSON.stringify(log));
  assert.throws(()=>journal.replay(a),/落后|分叉/);assert.equal(task.status,'completed');assert.equal(job.status,'completed');
});

test('explicit whole-job reopen advances every active task once and retains all accepted snapshots',t=>{
  const {a,job,tasks}=fixture(t,{count:2});check(a,job);acceptance.accept(a,select(a,tasks));const before=structuredClone(a.data);
  journal.recordUserEdit(a,{kind:'job',id:job.id,reopen:true,requirementRevision:'new-goal',commitId:'new-job-round'});
  assert.equal(job.workRevision,2);assert.ok(tasks.every(t=>t.workRevision===2&&t.status==='todo'&&t.acceptanceHistory.length===1));
  const events=journal.read(a).events.filter(e=>e.commitId==='new-job-round');assert.equal(events.length,3);assert.ok(events.every(e=>e.type==='reopened'));
  a.data=before;journal.replay(a,{force:true});assert.ok(a.data.tasks.every(t=>t.workRevision===2&&t.status==='todo'&&t.acceptanceHistory.length===1));assert.equal(a.data.delegations[0].status,'ready');
});

test('nonblocking observation decisions stay visible without blocking independent progress or final acceptance',t=>{
  const {a,job,task}=fixture(t);const before=acceptance.basis(a,task);check(a,job);
  a.data.decisions.push({id:'observation',kind:'source_classification',jobId:job.id,taskIds:[task.id],status:'open',blocking:false});
  assert.equal(acceptance.basis(a,task),before);assert.deepEqual(acceptance.reasons(a,task),[]);assert.deepEqual(state.blockingReasons(a,job),[]);assert.equal(acceptance.completionCandidate(a,job).ready,true);
  acceptance.acceptOne(a,{id:task.id});assert.equal(job.status,'completed');assert.equal(a.data.decisions[0].status,'open');
});

test('job feedback reopens accepted scopes exactly once and only invalidates unfinished task requirements',t=>{
  const {a,job,tasks}=fixture(t,{count:2});acceptance.acceptOne(a,{id:tasks[0].id});
  const request={id:job.id,requirementRevision:'new-requirements',commitId:'feedback'};
  journal.recordJobFeedback(a,request);journal.recordJobFeedback(a,request);
  assert.equal(job.workRevision,2);assert.equal(tasks[0].workRevision,2);assert.equal(tasks[1].workRevision,1);assert.equal(tasks[0].acceptedAt,undefined);assert.equal(tasks[0].acceptanceHistory.length,1);
  assert.ok(tasks.every(t=>t.requirementRevision==='new-requirements'&&t.verification===null&&t.needsReplan));
  const events=journal.read(a).events.filter(e=>e.commitId==='feedback');assert.equal(events.length,3);assert.deepEqual(events.map(e=>e.type),['reopened','reopened','user_edited']);
});

async function realLifecycle(t,{count=1,chat}={}) {
  const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lifecycle-app-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls=[];const a=new Assistant({dir,agentRequest:async()=>{throw Error('network forbidden');},chat:chat||(async(_p,_k,_m,o)=>{calls.push(o.stage);if(o.stage==='goal_verify')return {passed:true,summary:'整体符合要求',gaps:[]};throw Error('unexpected model stage '+o.stage);})});
  await a.dispatch('saveProvider',{name:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',inputPrice:0,outputPrice:0});
  const job=agent.buildJob(a,{goal:'交付说明',allowWeb:false,fileMode:'off',autoAccept:false});a.data.delegations.push(job);
  const tasks=[];for(let i=0;i<count;i++){
    const task=a.createTask({title:'说明'+i,criteria:'正文完整',steps:[{title:'说明',kind:'draft'}]});task.agentJobId=job.id;task.dependsOn=[];task.steps[0].key='draft';job.taskIds.push(task.id);tasks.push(task);
    task.steps[0].done=true;task.steps[0].artifactId='a'+i;a.data.artifacts.push({id:'a'+i,taskId:task.id,stepId:task.steps[0].id,content:'正文'+i});task.status='review';task.verification={passed:true,summary:'已检查',gaps:[],basis:acceptance.basis(a,task)};
  }
  job.status='review';a.save();return {a,job,tasks,task:tasks[0],dir,calls,agent};
}

test('paused legacy finalization requires explicit resume, survives restart, and checks only the whole goal',async t=>{
  const {a,job,task,dir,calls,agent}=await realLifecycle(t);task.status='completed';task.acceptedAt='legacy';task.acceptedBy='user';job.status='paused';
  acceptance.reconcileJobCompletion(a,job);assert.equal(job.status,'finalizing');assert.equal(job.executionPaused,true);assert.equal(agent.tick(a),false);assert.deepEqual(state.workState(a,job).nextActions,[{type:'resume_execution',action:'agentResume'}]);
  await assert.rejects(a.dispatch('agentRun',{id:job.id}),/暂停/);assert.deepEqual(calls,[]);
  await a.dispatch('agentResume',{id:job.id});assert.equal(job.status,'finalizing');assert.equal(job.executionPaused,undefined);assert.equal(task.status,'completed');
  const {Assistant}=require('../desktop/core.cjs');const restarted=new Assistant({dir,chat:a.chat,agentRequest:a.agentRequest});const current=restarted.data.delegations[0];assert.equal(current.executionPaused,undefined);assert.equal(current.status,'finalizing');
  await restarted.dispatch('agentRun',{id:job.id});await restarted.runPromise;assert.equal(current.status,'completed');assert.equal(restarted.task(task.id).acceptedAt,'legacy');assert.deepEqual(calls,['goal_verify']);assert.equal(agent.tick(restarted),false);
});

test('tick schedules a runnable sibling in needs_input or blocked, while respecting scopes, due time and pause',async t=>{
  const {a,job,tasks,agent}=await realLifecycle(t,{count:2});for(const task of tasks){task.status='todo';task.steps[0].done=false;task.verification=null;}
  a.data.decisions.push({id:'d',jobId:job.id,status:'open',scope:'task',taskIds:[tasks[0].id]});job.status='needs_input';job.nextRunAt=null;
  const execution=require('../desktop/execution.cjs'),launch=execution.launch,launched=[];execution.launch=(_a,input)=>{launched.push(input);return {};};
  try{
    assert.equal(agent.tick(a),true);assert.deepEqual(launched.map(r=>r.jobId),[job.id]);assert.equal(control.next(a,job).args.taskId,tasks[1].id);
    job.status='blocked';assert.equal(agent.tick(a),true);
    a.data.decisions[0].scope='job';assert.equal(agent.tick(a),false);a.data.decisions[0].scope='task';
    job.status='retry';job.nextRunAt='2099-01-01';assert.equal(agent.tick(a),false);job.nextRunAt=null;
    job.executionPaused=true;assert.equal(agent.tick(a),false);delete job.executionPaused;
    job.lastErrorAutomaticRetry=false;assert.equal(agent.tick(a),false);delete job.lastErrorAutomaticRetry;
    a.data.stewardship.paused=true;assert.equal(agent.tick(a),false);
  }finally{execution.launch=launch;}
});

test('real completed feedback advances task and job revisions without silently lifting pause',async t=>{
  const {a,job,tasks}=await realLifecycle(t,{count:2});check(a,job);acceptance.accept(a,select(a,tasks));job.executionPaused=true;
  await a.dispatch('agentFeedback',{id:job.id,note:'请按新范围补充说明'});
  assert.equal(job.workRevision,2);assert.equal(job.executionPaused,true);assert.equal(job.nextRunAt,null);assert.ok(tasks.every(t=>t.workRevision===2&&t.status==='todo'&&!t.acceptedAt&&t.acceptanceHistory.length===1&&t.needsReplan));
});

test('committed user edits replay the new criteria and replaced requirement identity after workspace loss',t=>{
  const {a,job,task}=fixture(t);task.userRequirement={revision:'old-requirement',origin:'user_edit',criteria:task.criteria,description:task.description,objective:''};task.verification.basis=acceptance.basis(a,task);check(a,job);acceptance.acceptOne(a,{id:task.id});
  const old=structuredClone(a.data),save=a.save;
  a.save=()=>{throw Error('lost workspace projection');};
  assert.throws(()=>journal.recordUserEdit(a,{id:task.id,reopen:true,requirementRevision:'new-requirement',changes:{criteria:'新版范围：必须包含附录',description:'新的背景'},note:'按新版范围补充附录'}),e=>e.committed&&e.projectionPending);
  a.data=old;a.save=save;journal.replay(a);
  const restored=a.task(task.id);assert.equal(restored.workRevision,2);assert.equal(restored.criteria,'新版范围：必须包含附录');assert.equal(restored.userRequirement.criteria,restored.criteria);assert.equal(restored.userRequirement.revision,'new-requirement');assert.deepEqual(restored.withdrawnRequirementIds,['old-requirement']);assert.equal(restored.requirementHistory[0].revision,'old-requirement');assert.equal(restored.acceptanceHistory.length,1);assert.equal(restored.acceptedAt,undefined);assert.equal(restored.notes.filter(n=>n.text==='按新版范围补充附录').length,1);assert.equal(a.data.delegations[0].feedback.filter(n=>n.text==='按新版范围补充附录').length,1);
  journal.replay(a,{force:true});assert.equal(restored.notes.filter(n=>n.text==='按新版范围补充附录').length,1);assert.equal(restored.requirementHistory.length,1);
});

test('contract and job feedback survive failed projection with stable directives and no duplicate notes',t=>{
  const {a,job,tasks}=fixture(t,{count:2});job.executionContract={text:'原执行范围',revision:'contract-old',updatedAt:'2026-01-01'};for(const task of tasks)task.verification.basis=acceptance.basis(a,task);check(a,job);acceptance.accept(a,select(a,tasks));
  const old=structuredClone(a.data),save=a.save,request={id:job.id,requirementRevision:'scope-new',commitId:'contract-command',note:'下一轮执行新范围',executionContract:{text:'新执行范围，明确不做旧附加项',revision:'contract-new',updatedAt:'2025-01-01'}};
  a.save=()=>{throw Error('workspace lost');};assert.throws(()=>journal.recordJobFeedback(a,request),e=>e.committed);a.data=old;a.save=save;journal.replay(a);journal.recordJobFeedback(a,request);
  const current=a.data.delegations[0];assert.equal(current.executionContract.text,request.executionContract.text);assert.equal(current.executionContract.revision,'contract-new');assert.deepEqual(current.withdrawnRequirementIds,['contract-old']);assert.equal(current.contractHistory.length,1);assert.equal(current.feedback.filter(n=>n.text===request.note).length,1);assert.equal(current.userDirectives.filter(n=>n.text===request.note).length,1);assert.ok(a.data.tasks.every(t=>t.workRevision===2&&t.notes.filter(n=>n.text===request.note).length===1&&t.acceptanceHistory.length===1));
});

test('delegated auto acceptance releases dependencies but leaves the last task for the whole check',async t=>{
  const {a,job,tasks}=await realLifecycle(t,{count:2,chat:async()=>({passed:true,summary:'事项符合标准',gaps:[]})});job.autoAccept=true;
  for(const task of tasks){task.status='todo';task.verification=null;}
  tasks[1].dependsOn=[tasks[0].id];a.save();
  await assert.rejects(a.advance(tasks[1].id),/前置/);
  await a.advance(tasks[0].id);assert.equal(tasks[0].status,'completed');assert.equal(tasks[0].acceptedBy,'policy');assert.equal(job.completionCheck,undefined);
  await a.advance(tasks[1].id);assert.equal(tasks[1].status,'review');assert.equal(tasks[1].acceptedAt,undefined);assert.notEqual(job.status,'completed');
  assert.throws(()=>acceptance.acceptTask(a,{id:tasks[1].id},{actor:'policy'}),e=>e.code==='COMPLETION_REQUIRED');
  check(a,job);acceptance.acceptPolicy(a,job);assert.equal(job.status,'completed');
  const manual=await realLifecycle(t,{count:2,chat:async()=>({passed:true,summary:'事项符合标准',gaps:[]})});manual.task.status='todo';manual.task.verification=null;
  await manual.a.advance(manual.task.id);assert.equal(manual.task.status,'review');assert.equal(manual.task.acceptedAt,undefined);
});

test('continuous review reaches the planner so it can establish its wait before completing a batch',async t=>{
  const calls=[];
  const {a,job,task}=await realLifecycle(t,{chat:async(_p,_k,m)=>{calls.push(m[0].content);assert.match(m[0].content,/动作格式/);return {tool:'wait',args:{key:'reply',reason:'等待确认',expected:'收到确认回复',connectorIds:['follow']}};}});
  job.mode='continuous';job.status='ready';a.data.connectors.push({id:'follow',projectId:job.projectId});task.verification.basis=acceptance.basis(a,task);a.save();
  assert.equal(acceptance.completionCandidate(a,job).ready,true);assert.equal(control.next(a,job),null);
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;
  assert.equal(calls.length,1);assert.equal(job.status,'watching',job.lastError);assert.equal(job.followups[0].status,'waiting');assert.equal(task.status,'review');assert.equal(job.completionCheck,undefined);
});

test('continuous completion intent survives a required recheck but never carries into a reopened batch',t=>{
  const {a,job,task}=fixture(t,{mode:'continuous'});job.followups=[{key:'reply',taskId:task.id,status:'waiting'}];task.verification.basis=acceptance.basis(a,task);
  job.followups[0].status='resolved';control.next(a,job);assert.equal(task.status,'todo');
  assert.equal(control.recover(a,job,{tool:'complete',args:{}},Error('关联事项尚未全部通过结果检查')),true);
  assert.equal(control.next(a,job).tool,'advance_task');task.status='review';task.verification={passed:true,summary:'按新等待状态复核',gaps:[],basis:acceptance.basis(a,task)};
  assert.equal(control.next(a,job).tool,'complete');job.workRevision=2;assert.equal(control.next(a,job),null);
});

test('resuming a checked continuous batch remains watching across restart without rechecking or reopening',async t=>{
  const {a,job,task,dir,calls}=await realLifecycle(t);job.mode='continuous';task.verification.basis=acceptance.basis(a,task);check(a,job);acceptance.acceptOne(a,{id:task.id});
  const workRevision=task.workRevision,acceptedAt=task.acceptedAt;
  await a.dispatch('agentPause',{id:job.id});assert.equal(job.status,'paused');
  await a.dispatch('agentResume',{id:job.id});assert.equal(job.status,'watching');assert.equal(job.executionPaused,undefined);assert.equal(task.workRevision,workRevision);assert.equal(task.acceptedAt,acceptedAt);assert.deepEqual(calls,[]);
  const {Assistant}=require('../desktop/core.cjs');const restored=new Assistant({dir,chat:a.chat,agentRequest:a.agentRequest});assert.equal(restored.data.delegations[0].status,'watching');assert.equal(restored.task(task.id).acceptedAt,acceptedAt);assert.deepEqual(calls,[]);
});

test('scoped job feedback durably changes only selected tasks and preserves noteKind and sibling checks',t=>{
  const {a,job,tasks}=fixture(t,{count:3});check(a,job);acceptance.accept(a,select(a,tasks));const old=structuredClone(a.data),sibling=structuredClone(tasks[1]),siblingBasis=acceptance.basis(a,tasks[1]);
  const request={id:job.id,taskIds:[tasks[0].id,tasks[2].id],requirementRevision:'decision-answer',note:'只补充选中事项',noteKind:'task_revision',commitId:'scoped-answer'};
  const save=a.save;a.save=()=>{throw Error('projection unavailable');};assert.throws(()=>journal.recordJobFeedback(a,request),e=>e.committed&&e.projectionPending);a.data=old;a.save=save;journal.replay(a);journal.recordJobFeedback(a,request);
  assert.deepEqual(a.task(tasks[1].id),sibling);assert.equal(acceptance.basis(a,a.task(tasks[1].id)),siblingBasis);
  for(const id of request.taskIds){const task=a.task(id);assert.equal(task.workRevision,2);assert.equal(task.status,'todo');assert.equal(task.notes.length,1);assert.equal(task.notes[0].text,request.note);assert.equal(task.notes[0].kind,'task_revision');assert.equal(task.acceptanceHistory.length,1);}
  assert.equal(a.data.delegations[0].completionCheck,undefined);assert.equal(journal.read(a).events.filter(e=>e.commitId===request.commitId).length,3);
  const before=JSON.stringify(a.data),count=journal.read(a).events.length;
  for(const taskIds of [[],['missing'],[tasks[0].id,tasks[0].id]])assert.throws(()=>journal.recordJobFeedback(a,{...request,taskIds,commitId:undefined}),/范围/);
  assert.throws(()=>journal.recordJobFeedback(a,{...request,commitId:undefined,executionContract:{revision:'new',text:'全局约定'}}),/整体/);
  assert.equal(JSON.stringify(a.data),before);assert.equal(journal.read(a).events.length,count);
});

test('project rule reopen is causal, respects pause, and survives a committed projection failure',async t=>{
  const {a}=await realLifecycle(t);await a.dispatch('projectSave',{name:'规则项目'});const project=a.data.projects[0];
  await a.dispatch('import',{items:[{title:'规则需求',content:'原范围',projectId:project.id}]});const source=a.data.sources[0];
  await a.dispatch('ruleSave',{name:'持续核对项目',goal:'按新资料继续交付',projectId:project.id,trigger:'project_changes',enabled:true,includeExisting:true,intervalMinutes:15,folderIds:[],urls:[],useGithub:false,allowWeb:false,fileMode:'off',githubMode:'off'});
  const rule=a.data.workRules[0],run=async()=>{await a.dispatch('ruleRun',{id:rule.id});await a.runPromise;return a.data.ruleRuns[0];};assert.equal((await run()).status,'created');
  const job=a.data.delegations.find(j=>j.id===rule.activeJobId),agent=require('../desktop/agent.cjs');
  const {taskId}=await agent.act(a,job,'plan_task',{key:'rule-task',title:'规则交付',criteria:'符合当前范围',sourceIds:[source.id],steps:[{title:'正文',kind:'draft'}]});const task=a.task(taskId);
  task.steps[0].done=true;task.steps[0].artifactId='rule-artifact';a.data.artifacts.push({id:'rule-artifact',taskId,stepId:task.steps[0].id,content:'原范围正文'});task.status='review';task.verification={passed:true,summary:'已检查',gaps:[],basis:acceptance.basis(a,task)};check(a,job);acceptance.acceptOne(a,{id:taskId});const backup=structuredClone(a.data);
  await a.dispatch('import',{items:[{title:'规则需求',content:'新的范围',projectId:project.id}]});job.executionPaused=true;const before=journal.read(a).events.length;
  assert.equal((await run()).status,'queued');assert.equal(journal.read(a).events.length,before);delete job.executionPaused;
  const save=a.save.bind(a);let failed=false;a.save=()=>{if(!failed&&journal.read(a).events.some(e=>e.type==='reopened'&&e.actor==='policy')){failed=true;throw Error('projection write failed');}save();};
  const failedRun=await run();assert.equal(failedRun.status,'error',JSON.stringify({failed,job:job.status,task:task.status,events:journal.read(a).events.map(e=>[e.type,e.actor])}));a.save=save;assert.equal(task.workRevision,2);assert.equal(job.workRevision,2);assert.equal(task.status,'todo');assert.equal(task.acceptedAt,undefined);
  const events=journal.read(a).events.filter(e=>e.type==='reopened'&&e.actor==='policy');assert.equal(events.length,2);assert.equal(events[0].commitId,events[1].commitId);assert.ok(events.every(e=>e.basisRefs.ruleId===rule.id&&e.basisRefs.triggerId));
  assert.equal((await run()).status,'merged');assert.equal(task.workRevision,2);assert.equal(job.workRevision,2);
  a.data=backup;journal.replay(a,{force:true});assert.equal(a.task(taskId).status,'todo');assert.equal(a.task(taskId).workRevision,2);assert.equal(a.task(taskId).acceptanceHistory.length,1);assert.equal(a.task(taskId).acceptedAt,undefined);
});
