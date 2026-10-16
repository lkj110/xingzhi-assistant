const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const trash=require('../desktop/task-trash.cjs');
const agent=require('../desktop/agent.cjs');
const plans=require('../desktop/agent-plan.cjs');
const recovery=require('../desktop/recovery.cjs');
const journal=require('../desktop/work-journal.cjs');
async function setup(t,{linked=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-task-trash-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const deny=async()=>{throw Error('unexpected model or network call');};
  const a=new Assistant({dir,chat:deny,webRequest:deny,agentRequest:deny});
  const task=a.createTask({title:'待删除的测试事项',description:'原始背景',criteria:'保留历史与费用',steps:[{title:'草稿',kind:'draft'}]});
  task.notes.push({id:'note',at:new Date().toISOString(),kind:'feedback',text:'保留反馈'});
  let job;
  if(linked){await a.dispatch('saveProvider',{name:'test',type:'ollama',baseUrl:'http://127.0.0.1:9',model:'test',inputPrice:0,outputPrice:0});job=agent.buildJob(a,{goal:'测试生命周期',allowWeb:false,fileMode:'off'});a.data.delegations.push(job);job.taskIds.push(task.id);task.agentJobId=job.id;task.agentKey='original';}
  a.save();return {a,task,job,dir,deny};
}
const remove=async(a,task)=>a.dispatch('taskTrashDelete',{id:task.id,revision:trash.preview(a,{id:task.id}).revision});
const restore=async(a,task)=>a.dispatch('taskTrashRestore',{id:task.id,revision:task.trashRevision});

test('delete hides a task and preserves materials, output, feedback and cost across restart',async t=>{
  const {a,task,dir,deny}=await setup(t);
  a.data.artifacts.push({id:'output',taskId:task.id,title:'历史成果',content:'保留正文',createdAt:new Date().toISOString()});
  a.activeSpendTask=task;const meter=require('../desktop/spend.cjs').scope(a);meter.spentUSD=70;meter.heldUSD=3;meter.limitUSD=100;a.activeSpendTask=null;
  const cost=structuredClone(a.spendLedger),notes=structuredClone(task.notes),output=structuredClone(a.data.artifacts);
  task.dueAt='2020-01-01T00:00:00Z';task.followupDue=true;
  const state=await remove(a,task);
  assert.equal(state.tasks.length,0);assert.equal(state.deletedTasks[0].id,task.id);assert.equal(task.status,'paused');assert.equal(task.followupDue,false);
  assert.deepEqual(a.spendLedger,cost);assert.deepEqual(task.notes,notes);assert.deepEqual(a.data.artifacts,output);
  assert.equal(state.resultOverview.groups[0].status,'deleted');assert.equal(state.resultOverview.counts.current,0);assert.equal(state.resultOverview.counts.history,1);
  const restarted=new Assistant({dir,chat:deny});assert.equal(restarted.publicState().tasks.length,0);assert.equal(restarted.publicState().deletedTasks.length,1);
  const next=await restore(restarted,restarted.task(task.id));assert.equal(next.tasks[0].status,'paused');assert.equal(next.deletedTasks.length,0);assert.deepEqual(next.tasks[0].notes,notes);
});

test('linked deletion pauses its job, cancels follow-up, invalidates approvals and replans dependents',async t=>{
  const {a,task,job}=await setup(t,{linked:true});
  const other=a.createTask({title:'依赖事项'});other.agentJobId=job.id;other.dependsOn=[task.id];job.taskIds.push(other.id);
  job.followups.push({key:'f',taskId:task.id,status:'waiting'});
  job.rulePausedState={status:'ready'};
  a.data.agentActions.push({id:'approval',taskId:task.id,jobId:job.id,status:'pending',approvedAt:'old'});job.pendingActionId='approval';
  a.data.decisions.push({id:'question',jobId:job.id,status:'open',kind:'question',question:'旧问题'});
  await remove(a,task);
  assert.equal(job.status,'paused');assert.equal(job.nextRunAt,null);assert.equal(job.pendingActionId,null);assert.equal(job.rulePausedState,undefined);
  assert.equal(job.followups[0].status,'cancelled');assert.equal(a.data.agentActions[0].status,'stale');assert.equal(a.data.agentActions[0].approvedAt,undefined);assert.equal(a.data.decisions[0].status,'cancelled');
  assert.match(other.needsReplan,/前置事项/);assert.match(plans.dependencyIssues(a,other)[0].reason,/已删除/);
  assert.ok(!agent.context(a,job).tasks.some(t=>t.id===task.id));
  await restore(a,task);assert.equal(job.status,'paused');assert.equal(task.status,'paused');assert.equal(task.agentCancelled,false);assert.match(task.needsReplan,/恢复/);
});

test('deletion never hides unsettled external writes or interrupts an active operation',async t=>{
  const {a,task,job}=await setup(t,{linked:true});
  for(const status of ['running','uncertain']){a.data.agentActions=[{id:status,status,jobId:job.id}];assert.equal(trash.preview(a,{id:task.id}).unresolved,true);await assert.rejects(remove(a,task),/外部动作结果/);assert.ok(!task.deletedAt);}
  a.data.agentActions=[];a.operation={label:'推进中'};await assert.rejects(remove(a,task));assert.ok(!task.deletedAt);
});

test('stale confirmation cannot delete a changed plan or restore a changed lifecycle',async t=>{
  const {a,task}=await setup(t);const preview=trash.preview(a,{id:task.id});task.criteria='新的要求';
  await assert.rejects(a.dispatch('taskTrashDelete',preview),/已变化/);assert.ok(!task.deletedAt);
  await remove(a,task);await assert.rejects(a.dispatch('taskTrashRestore',{id:task.id,revision:'old'}),/已变化/);assert.ok(task.deletedAt);
});

test('stale clients, Agent planning and tools cannot modify or revive deleted tasks',async t=>{
  const {a,task,job}=await setup(t,{linked:true});await remove(a,task);
  for(const [action,input] of [['updateTask',{title:'hijack'}],['taskAction',{command:'resume'}],['taskAction',{command:'pause'}],['advance',{}],['adoptArtifact',{}],['restoreGenerationCheckpoint',{}]])await assert.rejects(a.dispatch(action,{id:task.id,...input}),/已删除/);
  const args={key:'original',title:task.title,criteria:task.criteria,steps:[{title:'新步骤',kind:'draft'}]};
  assert.throws(()=>plans.planTask(a,job,args),/已删除/);
  assert.throws(()=>plans.planTask(a,job,{...args,key:'new',existingTaskId:task.id}),/已删除/);
  assert.throws(()=>plans.planTask(a,job,{...args,key:'new'}),/已由用户删除/);
  const saved=JSON.stringify(task);a.requeue(task);assert.equal(JSON.stringify(task),saved);
  await a.dispatch('agentFeedback',{id:job.id,note:'更新其他事项'});assert.equal(JSON.stringify(task),saved);
  assert.throws(()=>require('../desktop/capture-target.cjs').normalize(a,{kind:'task',taskId:task.id}),/删除/);
});

test('deleted tasks leave actionable lists and capture recommendations',async t=>{
  const {a,task}=await setup(t);await remove(a,task);
  assert.equal((await a.dispatch('operationsAgenda',{})).rows.some(r=>r.taskId===task.id),false);
  assert.equal(require('../desktop/capture-target.cjs').list(a).length,0);
  assert.equal(require('../desktop/attention.cjs').snapshot(a).items.some(r=>r.route.taskId===task.id),false);
  assert.equal((await a.dispatch('librarySearch',{query:task.title})).items.some(r=>r.type==='task'),false);
});

test('queued supplements stop retrying and keep their saved materials',async t=>{
  const {a,task}=await setup(t);const row={id:'q',target:{kind:'task',taskId:task.id},status:'queued',sourceIds:['source'],autoRetry:{enabled:true,nextRetryAt:new Date().toISOString()}};a.data.captureQueue.push(row);
  await remove(a,task);assert.equal(row.status,'failed');assert.equal(row.autoRetry.enabled,false);assert.equal(row.autoRetry.nextRetryAt,null);assert.deepEqual(row.sourceIds,['source']);
});

test('backup restore retains newer deletion and newer explicit restoration',async t=>{
  const {a,task}=await setup(t);const original=recovery.create(a);await remove(a,task);const deletedBackup=recovery.create(a);
  recovery.restore(a,original);assert.ok(a.task(task.id).deletedAt);assert.equal(a.publicState().tasks.length,0);
  await restore(a,a.task(task.id));recovery.restore(a,deletedBackup);assert.ok(!a.task(task.id).deletedAt);assert.equal(a.publicState().tasks[0].status,'paused');
});

test('save failure keeps committed task, job and approval facts and restart replays them together',async t=>{
  const {a,task,job,dir,deny}=await setup(t,{linked:true});
  a.data.agentActions.push({id:'approval',jobId:job.id,taskId:task.id,status:'pending',approvedAt:'old'});job.pendingActionId='approval';
  a.save();const saved=fs.readFileSync(a.file,'utf8');a.save=()=>{throw Error('disk full');};
  await assert.rejects(remove(a,task),e=>e.committed&&e.projectionPending&&/disk full/.test(e.message));
  assert.ok(task.deletedAt);assert.equal(job.status,'paused');assert.equal(a.data.agentActions[0].status,'stale');assert.ok(task.projectionPending);assert.ok(job.projectionPending);assert.equal(fs.readFileSync(a.file,'utf8'),saved);
  const committed=journal.read(a).events.filter(e=>['deleted','task_scope_changed'].includes(e.type));assert.equal(new Set(committed.map(e=>e.commitId)).size,1);
  const restarted=new Assistant({dir,chat:deny});assert.ok(restarted.task(task.id).deletedAt);assert.equal(restarted.data.delegations[0].status,'paused');assert.equal(restarted.data.agentActions[0].status,'stale');assert.equal(restarted.data.agentActions[0].approvedAt,undefined);assert.equal(restarted.task(task.id).projectionPending,undefined);
});

test('restoring completed or cancelled tasks preserves terminal history without completing a sibling',async t=>{
  const {a,task,job}=await setup(t,{linked:true});const other=a.createTask({title:'独立事项'});
  task.status='completed';task.acceptedAt='2026-01-01';task.acceptedBy='user';task.verification={passed:true,summary:'旧检查'};job.status='completed';
  await remove(a,task);await restore(a,task);assert.equal(task.status,'completed');assert.equal(task.acceptedAt,'2026-01-01');assert.equal(task.acceptedBy,'user');assert.equal(task.verification.passed,true);assert.equal(task.previousStatus,undefined);assert.equal(task.needsReplan,undefined);assert.equal(job.status,'completed');assert.equal(other.status,'todo');
  task.agentCancelled=true;task.cancelReason='原取消原因';await remove(a,task);await restore(a,task);assert.equal(task.agentCancelled,true);assert.equal(task.cancelReason,'原取消原因');
});

test('retrying a failed initial intake or supplement cannot bring a deleted task back',async t=>{
 const {a,task}=await setup(t);
 a.data.captureQueue.push({id:'initial',taskId:task.id,status:'failed',sourceIds:[],autoRetry:{enabled:true,nextRetryAt:null}});
 a.data.captureQueue.push({id:'supplement',target:{kind:'task',taskId:task.id},status:'failed',sourceIds:[],autoRetry:{enabled:true,nextRetryAt:null}});
 await remove(a,task);
 for(const row of a.data.captureQueue){assert.equal(row.autoRetry.enabled,false);await assert.rejects(a.dispatch('captureRetry',{id:row.id}),/已删除/);}
 assert.equal(a.data.tasks.length,1);assert.equal(a.publicState().tasks.length,0);
});

test('other job questions render correctly with a deleted task still in the historical plan',async t=>{
 const {a,task,job}=await setup(t,{linked:true});const other=a.createTask({title:'仍在推进的事项'});other.agentJobId=job.id;job.taskIds.push(other.id);
 await remove(a,task);
 const decisions=require('../desktop/decisions.cjs');
 assert.throws(()=>decisions.ask(a,job,{question:'旧问题',taskIds:[task.id]}),/已删除/);
 decisions.ask(a,job,{question:'剩余范围如何推进？',taskIds:[other.id]});
 const state=a.publicState();assert.equal(state.decisionCards.length,1);assert.deepEqual(state.decisionCards[0].tasks,[{id:other.id,title:other.title}]);
 assert.equal(agent.context(a,job).deletedTasks[0].id,task.id);
 assert.equal((await a.dispatch('workmapSnapshot',{})).items.some(r=>r.taskId===task.id),false);
});

test('a crash during projection replays every scoped effect once, with stable work revisions',async t=>{
  const {a,task,job,dir,deny}=await setup(t,{linked:true});
  const dependent=a.createTask({title:'依赖事项'}),accepted=a.createTask({title:'已验收依赖'}),unrelated=a.createTask({title:'无关事项'});
  dependent.agentJobId=job.id;dependent.dependsOn=[task.id];accepted.agentJobId=job.id;accepted.dependsOn=[dependent.id];accepted.status='completed';accepted.acceptedAt='old';accepted.acceptedBy='user';job.taskIds.push(dependent.id,accepted.id);
  job.followups.push({key:'waiting',taskId:task.id,status:'waiting'});
  a.data.decisions.push({id:'decision',jobId:job.id,status:'open'});
  a.data.captureQueue.push({id:'capture',taskId:task.id,status:'queued',autoRetry:{enabled:true}});
  a.data.sourceObservations.push({observationId:'observation',scope:{taskId:task.id},state:'pending',decisionId:'observation-decision'});
  a.save();const unrelatedBefore=structuredClone(unrelated),project=trash.projectEvent;
  trash.projectEvent=(view,target,event)=>{if(event.entityKind==='job')throw Error('projection interrupted');return project(view,target,event);};
  try{await assert.rejects(remove(a,task),e=>e.committed&&e.projectionPending);}finally{trash.projectEvent=project;}
  const restarted=new Assistant({dir,chat:deny});const events=journal.read(restarted).events.filter(e=>['deleted','task_scope_changed'].includes(e.type));
  assert.deepEqual(new Set(events.map(e=>e.entityId)),new Set([task.id,job.id,dependent.id,accepted.id]));assert.ok(events.every(e=>e.workRevision===1));assert.equal(new Set(events.map(e=>e.commitId)).size,1);
  assert.equal(restarted.data.delegations[0].followups[0].status,'cancelled');assert.equal(restarted.data.captureQueue[0].autoRetry.enabled,false);assert.equal(restarted.data.decisions.find(d=>d.id==='decision').status,'cancelled');assert.match(restarted.task(dependent.id).needsReplan,/前置事项/);assert.equal(restarted.task(accepted.id).status,'completed');assert.equal(restarted.task(accepted.id).acceptedAt,'old');assert.equal(restarted.data.sourceObservations[0].state,'closed');assert.deepEqual(Object.fromEntries(Object.keys(unrelatedBefore).map(key=>[key,restarted.task(unrelated.id)[key]])),unrelatedBefore);assert.ok(!events.some(e=>e.entityId===unrelated.id));
  const feedbackCount=restarted.data.delegations[0].feedback.length;journal.replay(restarted,{force:true});assert.equal(restarted.data.delegations[0].feedback.length,feedbackCount);
  await restore(restarted,restarted.task(task.id));assert.equal(restarted.task(task.id).workRevision,1);assert.equal(restarted.task(accepted.id).workRevision,1);assert.equal(restarted.task(accepted.id).status,'completed');assert.equal(restarted.data.sourceObservations[0].state,'closed');
});

test('old backup cannot undo committed delete or restored acceptance even when timestamps go backwards',async t=>{
  const {a,task,job}=await setup(t,{linked:true});task.status='completed';task.acceptedAt='old';task.acceptedBy='user';job.status='completed';a.save();const backup=recovery.create(a);
  await remove(a,task);const deletedRevision=task.trashRevision;recovery.restore(a,backup);assert.ok(a.task(task.id).deletedAt);assert.equal(a.task(task.id).trashRevision,deletedRevision);assert.equal(a.data.delegations[0].status,'completed');
  await restore(a,a.task(task.id));const restoredRevision=a.task(task.id).trashRevision;recovery.restore(a,backup);assert.equal(a.task(task.id).deletedAt,undefined);assert.equal(a.task(task.id).status,'completed');assert.equal(a.task(task.id).acceptedBy,'user');assert.equal(a.task(task.id).trashRevision,restoredRevision);assert.equal(a.data.delegations[0].status,'completed');
});
