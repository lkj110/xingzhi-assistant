const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),projects=require('../desktop/projects.cjs');
const connectors=require('../desktop/connectors.cjs'),recovery=require('../desktop/recovery.cjs');

// No network, real model calls, user workspace, or external messages are used here.
async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v14-audit-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let body='预算为 6800 元';
  const forbidden=async()=>{throw new Error('audit must not call a model or public network');};
  const a=new Assistant({dir,chat:forbidden,agentRequest:forbidden,webRequest:forbidden,
    connectorRequest:async()=>({ok:true,data:{document:{content:body,revision_id:1}}})});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  await a.dispatch('projectSave',{name:'独立测试项目'});const project=a.data.projects[0];
  const job=agent.buildJob(a,{projectId:project.id,goal:'根据预算编写计划',fileMode:'off',githubMode:'off'});
  a.data.delegations.push(job);project.jobId=job.id;
  await a.dispatch('connectorSave',{name:'预算材料',kind:'document',target:'https://test.feishu.cn/docx/Abc123',projectId:project.id,enabled:true,intervalMinutes:1440});
  const connection=a.data.connectors[0];
  const sync=async()=>{await a.dispatch('connectorSync',{id:connection.id});await a.runPromise;return a.data.connectorRuns[0];};
  return {a,project,job,connection,sync,set:content=>{body=content;}};
}

test('V14 audit: connector updates cannot invalidate an orphan uncertain external action',async t=>{
  const {a,job,connection,sync,set}=await setup(t);await sync();
  const cursor=structuredClone(connection.cursor),sourceIds=[...job.sourceIds];
  a.data.agentActions.push({id:'lost-pointer',jobId:job.id,status:'uncertain',tool:'write_file'});job.pendingActionId=null;
  set('预算更改为 9800 元');const run=await sync();
  assert.equal(run.status,'error');assert.equal(a.data.connectors[0].health,'merge');
  assert.deepEqual(a.data.connectors[0].cursor,cursor);assert.deepEqual(a.data.delegations[0].sourceIds,sourceIds);assert.equal(a.data.sources.length,1);
});

test('V14 audit: project undo remains excluded across a later connector document update',async t=>{
  const {a,project,job,connection,sync,set}=await setup(t);await sync();
  const source=a.data.sources[0],change=a.data.projectChanges[0];
  await a.dispatch('projectUndo',{id:project.id,changeId:change.id});
  assert.equal(source.projectExcluded,true);assert.equal(job.status,'paused');
  set('预算更改为 9800 元');await sync();
  assert.equal(a.data.sources.length,1,'a withdrawn source must not silently re-enter as a new version');
  assert.equal(a.data.delegations[0].sourceIds.length,0);
  await a.dispatch('projectAttach',{id:project.id,sourceIds:[source.id]});await sync();
  assert.equal(a.data.sources.length,2);assert.equal(a.data.sources[0].version,2);assert.equal(job.status,'paused');
});

test('V14 audit: unchanged connector recheck reconciles later evidence retained by backup restore',async t=>{
  const {a,job,connection,sync,set}=await setup(t);await sync();const first=a.data.sources[0];
  const planned=await agent.act(a,job,'plan_task',{key:'plan',title:'预算计划',criteria:'预算准确',sourceIds:[first.id],steps:[{key:'draft',title:'编写',kind:'draft'}]});
  const backup=recovery.create(a);set('预算更改为 9800 元');await sync();const current=a.data.sources[0];
  await a.dispatch('backupRestore',{id:backup});const restored=a.data.delegations.find(j=>j.id===job.id);
  assert.equal(restored.sourceIds.includes(current.id),true,'durable source observations reconcile current evidence during restore');const feedbackCount=restored.feedback.length;await sync();assert.equal(restored.feedback.length,feedbackCount,'unchanged recheck must not repeat the input event');
  assert.equal(restored.sourceIds.includes(current.id),true,'retained evidence must rejoin the old plan even when remote content is unchanged');
  assert.equal(a.task(planned.taskId).sourceIds.includes(current.id),true);assert.equal(restored.status,'paused');assert.equal(a.data.sources.length,2);
  assert.equal(agent.context(a,restored).sources.filter(s=>s.current).length,1);
});

test('V14 audit: copying a connector source to another project must not become the original version ancestor',async t=>{
  const {a,project,connection,sync,set}=await setup(t);await sync();const original=a.data.sources[0];
  await a.dispatch('projectSave',{name:'另一项目'});const other=a.data.projects[0];
  await a.dispatch('projectAttach',{id:other.id,sourceIds:[original.id]});const copy=a.data.sources[0];assert.equal(copy.copiedFrom,original.id);
  set('预算更改为 9800 元');await sync();const latest=a.data.sources.find(s=>s.projectId===project.id&&s.id!==original.id);
  assert.equal(latest.previousSourceId,original.id);assert.notEqual(latest.previousSourceId,copy.id);assert.equal(latest.version,2);
});

test('V14 audit: connector transient error cannot retry more frequently than its configured daily interval',async t=>{
  const {a,connection,sync}=await setup(t);a.connectorRequest=async()=>{throw new Error('offline');};const started=Date.now();await sync();
  assert.equal(a.data.connectorRuns[0].status,'error');assert.ok(Date.parse(a.data.connectors[0].nextRunAt)>=started+connection.intervalMinutes*60000);
});

test('V14 audit: connector revisions invalidate independent tasks that cite the old material',async t=>{
  const {a,sync,set}=await setup(t);await sync();const original=a.data.sources[0];
  const task=a.createTask({title:'另行核对预算',sourceIds:[original.id]});
  task.status='completed';task.verification={passed:true};task.steps[0].done=true;task.steps[0].artifactId='stale-artifact';
  const paused=a.createTask({title:'暂停中的核对',sourceIds:[original.id]});paused.status='paused';
  set('预算更改为 9800 元');await sync();const current=a.data.sources[0];
  assert.equal(task.status,'blocked');assert.equal(task.verification,null);assert.equal(task.steps[0].done,false);assert.equal(task.steps[0].artifactId,undefined);
  assert.ok(task.sourceIds.includes(current.id));assert.ok(task.supersededSourceIds.includes(original.id));assert.equal(paused.status,'paused');
});

test('V14 audit: connector page save failure restores source history, task evidence and cursor together',async t=>{
  const {a,job,connection,sync}=await setup(t);await sync();const first=a.data.sources[0];
  const planned=await agent.act(a,job,'plan_task',{key:'plan',title:'预算计划',criteria:'预算准确',sourceIds:[first.id],steps:[{key:'draft',title:'编写',kind:'draft'}]});
  const task=a.task(planned.taskId);task.status='completed';task.verification={passed:true};job.status='paused';
  const before=structuredClone(a.data),original=a.save;a.save=()=>{throw new Error('disk unavailable');};
  assert.throws(()=>connectors.commit(a,connection,[{remoteId:connection.target,content:'预算变更'}],{through:new Date().toISOString()}),/disk unavailable/);
  assert.deepEqual(a.data,before);a.save=original;
  const c=a.data.connectors[0];connectors.commit(a,c,[{remoteId:c.target,content:'预算变更'}],{through:new Date().toISOString()});
  assert.equal(a.data.sources.length,2);assert.equal(a.task(task.id).verification,null);assert.equal(a.data.delegations[0].status,'paused');
});

test('V14 audit: restoring a connector-backed confirmed wait reopens it for retained edited evidence',async t=>{
  const {a,job,sync,set}=await setup(t);await sync();const original=a.data.sources[0];
  job.followups.push({key:'budget',expected:'确认预算',status:'resolved',sourceId:original.id,sourceIds:[original.id],watchKeys:[`connector:${original.connectorId}`],resolvedAt:new Date().toISOString(),verification:{quote:'预算为 6800 元',reason:'已确认'}});
  const backup=recovery.create(a);set('此前预算作废，等待重新确认');await sync();await a.dispatch('backupRestore',{id:backup});
  const restored=a.data.delegations.find(j=>j.id===job.id);assert.equal(restored.followups[0].status,'waiting');assert.equal(restored.followups[0].sourceId,undefined);await sync();
  assert.equal(restored.followups[0].status,'waiting');assert.equal(restored.followups[0].sourceId,undefined);assert.equal(restored.status,'paused');
});

test('V14 audit: explicitly disabled connector manual sync never creates an automatic next-run timestamp',async t=>{
  const {a,connection,sync}=await setup(t);await a.dispatch('connectorToggle',{id:connection.id,enabled:false});await sync();
  assert.equal(connection.enabled,false);assert.equal(connection.nextRunAt,null);
  a.connectorRequest=async()=>{throw new Error('offline');};await sync();assert.equal(a.data.connectors[0].nextRunAt,null);
});

for(const relation of ['task-only','related-job-pointer'])test(`V14 audit: connector updates preserve uncertain legacy receipts with ${relation} linkage`,async t=>{
  const {a,job,sync,set}=await setup(t);await sync();const original=a.data.sources[0];
  const task=a.createTask({title:'关联事项',sourceIds:[original.id]});
  const action={id:'legacy-uncertain',status:'uncertain',tool:'write_file'};
  if(relation==='task-only')action.taskId=task.id;
  else{
    const related=agent.buildJob(a,{goal:'另一关联委托',fileMode:'off',githubMode:'off'});
    task.agentJobId=related.id;related.taskIds=[task.id];related.sourceIds=[original.id];related.pendingActionId=action.id;a.data.delegations.push(related);
  }
  a.data.agentActions.push(action);const previousCursor=structuredClone(a.data.connectors[0].cursor);set('预算再次变更');await sync();
  assert.equal(a.data.connectorRuns[0].status,'error');assert.equal(a.data.sources.length,1);assert.deepEqual(a.data.connectors[0].cursor,previousCursor);
  assert.equal(a.data.agentActions[0].status,'uncertain');assert.equal(a.task(task.id).sourceIds.length,1);
});

test('V14 audit: connector change revokes legacy approved actions by task or pending pointer',async t=>{
  const {a,job,sync,set}=await setup(t);await sync();const task=a.createTask({title:'关联事项',sourceIds:[a.data.sources[0].id]});
  a.data.agentActions.push({id:'pointer',status:'pending',approvedAt:new Date().toISOString()},{id:'task-only',taskId:task.id,status:'pending',approvedAt:new Date().toISOString()});job.pendingActionId='pointer';
  set('预算已更新');await sync();
  assert.ok(a.data.agentActions.every(r=>r.status==='stale'&&!r.approvedAt));assert.equal(job.pendingActionId,null);
});

for(const relation of ['task-project','delegation-project','missing-delegation'])test(`V14 audit: an invalid ${relation} blocks the complete connector update`,async t=>{
  const {a,project,sync,set}=await setup(t);await sync();const source=a.data.sources[0];
  await a.dispatch('projectSave',{name:'其他项目'});const foreign=a.data.projects[0];
  const task=a.createTask({title:'错链事项',projectId:relation==='task-project'?foreign.id:project.id,sourceIds:[source.id]});
  if(relation==='delegation-project'){
    const foreignJob=agent.buildJob(a,{projectId:foreign.id,goal:'另一项目的工作',fileMode:'off',githubMode:'off'});
    task.agentJobId=foreignJob.id;foreignJob.taskIds=[task.id];foreignJob.sourceIds=[source.id];a.data.delegations.push(foreignJob);
  }
  if(relation==='missing-delegation')task.agentJobId='missing-job';
  const before=structuredClone(a.data),cursor=structuredClone(a.data.connectors[0].cursor);set('只属于原项目的新资料');await sync();
  assert.equal(a.data.connectorRuns[0].status,'error');assert.match(a.data.connectors[0].error,/跨项目/);
  assert.deepEqual(a.data.sources,before.sources);assert.deepEqual(a.data.tasks,before.tasks);assert.deepEqual(a.data.connectors[0].cursor,cursor);
});
