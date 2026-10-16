const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const lifecycle=require('../desktop/project-lifecycle.cjs');
const agent=require('../desktop/agent.cjs');
const recovery=require('../desktop/recovery.cjs');
const capture=require('../desktop/capture.cjs');
async function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-project-lifecycle-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const deny=async()=>{throw new Error('unexpected network or model');},a=new Assistant({dir:path.join(root,'workspace'),chat:deny,webRequest:deny,feedRequest:deny,connectorRequest:deny,agentRequest:deny});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'test',type:'ollama',baseUrl:'http://127.0.0.1:9',model:'test'});
  await a.dispatch('projectSave',{name:'收尾项目'});const p=a.data.projects[0];await a.dispatch('projectSave',{name:'保留项目'});const other=a.data.projects[0];
  const j=agent.buildJob(a,{projectId:p.id,goal:'交付并归档',allowWeb:false,fileMode:'auto',githubMode:'off'});j.outputFolder=path.join(root,'outputs');fs.mkdirSync(j.outputFolder);require('../desktop/access-policy-store.cjs').syncTrustedJob(a,j,{trusted:true,actor:'user_command',command:'fixture_output_scope'});p.jobId=j.id;a.data.delegations.push(j);
  const task=a.createTask({title:'待推进事项',projectId:p.id});task.agentJobId=j.id;j.taskIds.push(task.id);
  const completed=a.createTask({title:'已完成成果',projectId:p.id});completed.status='completed';completed.completedAt='2026-10-01T00:00:00.000Z';completed.verification={passed:true,summary:'历史检查',basis:'old'};
  const otherTask=a.createTask({title:'其他项目事项',projectId:other.id});
  a.data.artifacts.push({id:'artifact-1',taskId:completed.id,title:'成果',content:'交付正文',createdAt:'2026-10-01T00:00:00.000Z'});
  a.data.sources.push({id:'source-1',projectId:p.id,title:'来源',content:'完整来源',origin:'测试材料',hash:'test',state:'processed',createdAt:'2026-10-01T00:00:00.000Z'});
  const connection=kind=>({id:kind,projectId:p.id,name:kind,enabled:true,nextRunAt:'2026-01-01T00:00:00.000Z',health:'healthy'});
  a.data.folders.push({...connection('folder'),path:root,manifest:{}});
  a.data.webConnections.push({...connection('web'),url:'https://example.com/page',intervalMinutes:30});
  a.data.feedConnections.push({...connection('feed'),url:'https://example.com/feed',intervalMinutes:30});
  a.data.connectors.push({...connection('chat'),kind:'chat',target:'oc_lifecycle',sendPolicy:{mode:'auto',revision:'grant',expiresAt:'2026-12-01T00:00:00.000Z',template:'test',maxSends:1,intervalMinutes:1440}});
  a.data.intakeRoutingRules.push({id:'routing',name:'归类',projectId:p.id,enabled:true,field:'title',match:'any',keywords:['归档'],revision:'routing-r1'});
  a.data.workRules.push({id:'rule',revision:1,status:'enabled',activeJobId:j.id,nextRunAt:'2026-01-01T00:00:00.000Z',config:{projectId:p.id,name:'持续规则',fileMode:'auto'},usage:{day:'2026-10-01',calls:0,starts:0},pending:[],fingerprints:{}});
  Object.assign(a.data.briefingSchedule,{projectId:p.id,enabled:true,nextRunAt:'2026-01-01T00:00:00.000Z'});
  a.data.stewardship.paused=true;
  await capture.dispatch(a,'captureEnqueue',{projectId:p.id,textItems:[{title:'排队资料',content:'归档后保留的材料'}],organize:false});
  const queued=a.data.captureQueue[0];a.save();
  const preview=()=>lifecycle.preview(a,{id:p.id}),archive=()=>lifecycle.dispatch(a,'projectLifecycleArchive',{id:p.id,revision:preview().revision}),reopen=()=>lifecycle.dispatch(a,'projectLifecycleReopen',{id:p.id,revision:preview().revision});
  return {a,p,j,task,completed,other,otherTask,queued,root,preview,archive,reopen};
}
test('Project archive preview lists each affected channel without changing state or invoking models',async t=>{
  const {a,preview}=await setup(t),before=JSON.stringify(a.data),p=preview();
  for(const key of ['jobs','tasks','rules','folders','webConnections','feedConnections','connectors','routing','capture','writeModes','sendPolicies','briefing'])assert.equal(p.groups.find(g=>g.key===key).count,1,key);
  assert.deepEqual(p.preserved,{tasks:2,sources:1,artifacts:1,receipts:0});assert.equal(p.modelCalls,0);assert.equal(p.networkRequests,0);assert.equal(JSON.stringify(a.data),before);assert.equal(p.revision,preview().revision);
});
test('Archive stops all project work, preserves completed evidence and does not touch another project',async t=>{
  const {a,p,j,task,completed,otherTask,queued,archive}=await setup(t),completedBefore=structuredClone(completed),otherBefore=structuredClone(otherTask),sources=structuredClone(a.data.sources),artifacts=structuredClone(a.data.artifacts);
  archive();assert.ok(p.archivedAt);assert.equal(j.status,'paused');assert.equal(j.nextRunAt,null);assert.equal(j.fileMode,'ask');assert.equal(task.status,'paused');assert.equal(task.previousStatus,'todo');assert.deepEqual(completed,completedBefore);assert.deepEqual(otherTask,otherBefore);
  for(const key of ['folders','webConnections','feedConnections','connectors','intakeRoutingRules'])assert.equal(a.data[key][0].enabled,false,key);
  assert.equal(a.data.connectors[0].sendPolicy.mode,'off');assert.equal(a.data.workRules[0].status,'paused');assert.equal(a.data.workRules[0].config.fileMode,'ask');assert.equal(a.data.briefingSchedule.enabled,false);assert.equal(queued.status,'failed');assert.equal(queued.sourceIds.length,0);assert.match(queued.lastError,/归档/);
  assert.deepEqual(a.data.sources,sources);assert.deepEqual(a.data.artifacts,artifacts);assert.ok(fs.existsSync(path.join(a.dir,'capture-payloads',queued.id+'.json')));
});
test('Archive preserves running and uncertain receipts and legacy pending pointer while expiring approvals',async t=>{
  const {a,j,task,preview,archive}=await setup(t);
  a.data.agentActions.push({id:'uncertain-legacy',status:'uncertain',title:'未知写入'},{id:'running',jobId:j.id,taskId:task.id,status:'running',result:{messageId:'receipt'}},{id:'pending',jobId:j.id,status:'pending',approvedAt:'approved',content:'具体动作'},{id:'done',jobId:j.id,status:'done',result:{verified:true}});j.pendingActionId='uncertain-legacy';
  const evidence=structuredClone(a.data.agentActions.filter(r=>r.status!=='pending'));assert.equal(preview().unresolved.length,2);archive();assert.equal(j.pendingActionId,'uncertain-legacy');assert.deepEqual(a.data.agentActions.filter(r=>r.id!=='pending'),evidence);assert.equal(a.data.agentActions.find(r=>r.id==='pending').status,'stale');assert.equal(a.data.agentActions.find(r=>r.id==='pending').approvedAt,undefined);
});
test('Archive attaches orphan uncertain job receipt without losing a historical completed job',async t=>{
  const {a,j,archive}=await setup(t);j.status='completed';j.completedAt='2026-10-01T00:00:00.000Z';a.data.agentActions.push({id:'orphan',jobId:j.id,status:'uncertain'});archive();assert.equal(j.status,'completed');assert.equal(j.completedAt,'2026-10-01T00:00:00.000Z');assert.equal(j.pendingActionId,'orphan');
});
test('Archive revision rejects changed tasks, added channels and changed external receipts before mutation',async t=>{
  const {a,p,task,preview}=await setup(t);
  for(const mutate of [()=>task.title='新标题',()=>a.data.feedConnections.push({id:'later-feed',projectId:p.id,enabled:true}),()=>a.data.agentActions.push({id:'later-receipt',projectId:p.id,status:'uncertain'})]){
    const revision=preview().revision;mutate();const expected=structuredClone(a.data);assert.throws(()=>lifecycle.dispatch(a,'projectLifecycleArchive',{id:p.id,revision}),/变化/);assert.deepEqual(a.data,expected);assert.equal(p.archivedAt,undefined);
  }
});
test('Archive revision does not expire from independent project changes',async t=>{
  const {a,p,otherTask,preview}=await setup(t),revision=preview().revision;otherTask.title='另一个项目更新';lifecycle.dispatch(a,'projectLifecycleArchive',{id:p.id,revision});assert.ok(p.archivedAt);
});
test('Archive and reopen preserve a durable commit after a post-rename failure',async t=>{
  const {a,p,archive,reopen}=await setup(t);a.operation={label:'忙'};assert.throws(archive,/正在/);a.operation=null;
  const save=a.save.bind(a);a.save=()=>{save();throw new Error('ledger failed after rename');};
  assert.throws(archive,/ledger failed/);assert.ok(p.archivedAt);assert.deepEqual(JSON.parse(fs.readFileSync(a.file,'utf8')),a.data);
  a.save=save;a.operation={label:'busy'};assert.throws(reopen);a.operation=null;
  a.save=()=>{save();throw new Error('post-commit failure');};assert.throws(reopen,/post-commit/);
  assert.equal(p.archivedAt,undefined);assert.deepEqual(JSON.parse(fs.readFileSync(a.file,'utf8')),a.data);
});
test('Reopen only lifts project archive; work remains paused, pending queue retained and grants revoked',async t=>{
  const {a,p,j,task,queued,archive,reopen}=await setup(t);archive();const revision=lifecycle.preview(a,{id:p.id}).revision;reopen();assert.equal(p.archivedAt,undefined);assert.ok(p.reopenedAt);assert.equal(j.status,'paused');assert.equal(task.status,'paused');assert.equal(queued.status,'failed');assert.equal(j.fileMode,'ask');assert.equal(a.data.connectors[0].sendPolicy.mode,'off');assert.equal(a.data.feedConnections[0].enabled,false);assert.equal(a.data.briefingSchedule.enabled,false);assert.equal(lifecycle.isActive(a.data,p.id),true);assert.throws(()=>lifecycle.dispatch(a,'projectLifecycleReopen',{id:p.id,revision}),/变化/);
});
test('Persisted archive remains closed on restart and startup repairs accidentally enabled channels',async t=>{
  const {a,p,j,task,archive}=await setup(t);archive();a.data.feedConnections[0].enabled=true;a.data.connectors[0].sendPolicy.mode='auto';j.status='ready';task.status='todo';a.save();
  const next=new Assistant({dir:a.dir});assert.ok(next.data.projects.find(r=>r.id===p.id).archivedAt);assert.equal(next.data.delegations.find(r=>r.id===j.id).status,'paused');assert.equal(next.data.tasks.find(r=>r.id===task.id).status,'paused');assert.equal(next.data.feedConnections[0].enabled,false);assert.equal(next.data.connectors[0].sendPolicy.mode,'off');
});
test('Restore old backup retains current archive and later receipt, and old archived backup does not undo explicit reopen',async t=>{
  const {a,p,j,archive,reopen}=await setup(t),before=recovery.create(a);archive();a.data.agentActions.push({id:'late-receipt',jobId:j.id,status:'uncertain',result:{path:'/saved/history'}});a.save();recovery.restore(a,before);assert.ok(a.data.projects.find(r=>r.id===p.id).archivedAt);assert.equal(a.data.agentActions.find(r=>r.id==='late-receipt').status,'uncertain');assert.equal(a.data.delegations.find(r=>r.id===j.id).pendingActionId,'late-receipt');
  const archived=recovery.create(a);reopen();recovery.restore(a,archived);assert.equal(a.data.projects.find(r=>r.id===p.id).archivedAt,undefined);assert.ok(a.data.projects.find(r=>r.id===p.id).reopenedAt);assert.equal(a.data.feedConnections[0].enabled,false);assert.equal(a.data.delegations.find(r=>r.id===j.id).status,'paused');
});
test('Only project-specific briefing is disabled; global briefing and other project channels remain active',async t=>{
  const {a,other,archive}=await setup(t);a.data.briefingSchedule.projectId='';a.data.feedConnections.push({id:'other-feed',projectId:other.id,enabled:true,nextRunAt:'2026-01-01T00:00:00Z'});archive();assert.equal(a.data.briefingSchedule.enabled,true);assert.equal(a.data.feedConnections.find(r=>r.id==='other-feed').enabled,true);
});
test('Active checks include legacy reverse ownership and conflicting project associations',async t=>{
  const {a,p,j,task,other,archive}=await setup(t);j.projectId=null;task.projectId=null;archive();assert.equal(lifecycle.isJobActive(a.data,j),false);assert.equal(lifecycle.isTaskActive(a.data,task),false);assert.throws(()=>lifecycle.assertJobActive(a.data,j),/归档/);assert.throws(()=>lifecycle.assertTaskActive(a.data,task),/归档/);
  j.projectId=other.id;task.projectId=other.id;assert.equal(lifecycle.isJobActive(a.data,j),false);assert.equal(lifecycle.isTaskActive(a.data,task),false);task.agentJobId=null;assert.equal(lifecycle.isTaskActive(a.data,task),false);assert.equal(lifecycle.isActive(a.data,null),true);assert.equal(lifecycle.isActive(a.data,'missing'),false);assert.throws(()=>lifecycle.assertActive(a.data,'missing'),/不存在/);assert.equal(lifecycle.isActive(a.data,p.id),false);
});
test('Dispatch guard blocks archived mutation across all channels and whole batches without blocking read or revoke',async t=>{
  const {a,p,j,task,queued,otherTask,archive}=await setup(t);archive();
  const blocked=[['projectSave',{id:p.id}],['projectFeedback',{id:p.id}],['createTask',{projectId:p.id}],['import',{items:[{projectId:p.id}]}],['extract',{ids:['source-1']}],['deleteSource',{id:'source-1'}],['updateTask',{id:task.id}],['taskAction',{id:task.id,command:'resume'}],['agentResume',{id:j.id}],['ruleResume',{id:'rule'}],['connectorSync',{id:'chat'}],['folderSync',{id:'folder'}],['feedConnectionToggle',{id:'feed',enabled:true}],['webConnectionSave',{id:'web'}],['captureRetry',{id:queued.id}],['captureEnqueue',{projectId:p.id}],['intakeRoutingSave',{projectId:p.id}],['communicationPolicy',{connectorId:'chat',mode:'auto'}],['briefingScheduleRun',{}],['operationsSchedule',{items:[{id:otherTask.id},{id:task.id}]}],['acceptanceAccept',{items:[{id:task.id}]}]];
  for(const [action,input] of blocked)assert.throws(()=>lifecycle.assertDispatch(a,action,input),/归档/,action);
  for(const [action,input] of [['projectReport',{id:p.id}],['projectLifecyclePreview',{id:p.id}],['deliveryBundlePreview',{projectId:p.id}],['readSource',{id:'source-1'}],['agentPause',{id:j.id}],['folderRemove',{id:'folder'}],['feedConnectionToggle',{id:'feed',enabled:false}],['captureCancel',{id:queued.id}],['communicationPolicy',{connectorId:'chat',mode:'off'}],['updateTask',{id:otherTask.id}],['state',{}]])assert.doesNotThrow(()=>lifecycle.assertDispatch(a,action,input),action);
});
test('Guard resolves IDs only in each action table and leaves independent tasks usable',async t=>{
  const {a,p,archive}=await setup(t),independent=a.createTask({title:'独立事项'});a.data.connectors.push({id:independent.id,projectId:p.id,enabled:false});archive();assert.doesNotThrow(()=>lifecycle.assertDispatch(a,'updateTask',{id:independent.id}));assert.throws(()=>lifecycle.assertDispatch(a,'connectorSync',{id:independent.id}),/归档/);
});
function markVerified(a,task){
  const acceptance=require('../desktop/acceptance.cjs'),step=task.steps[0];if(task.agentJobId){task.dependsOn ||= [];task.steps.forEach((s,i)=>s.key ||= `step-${i+1}`);}step.done=true;step.artifactId=`accepted-${task.id}`;
  a.data.artifacts.push({id:step.artifactId,taskId:task.id,stepId:step.id,title:task.title,content:'已核对成果',createdAt:'2026-10-01T00:00:00.000Z'});
  require('../desktop/protocol-access.cjs').retain(a,'artifact',a.data.artifacts.at(-1),{task,command:'fixture_created_artifact'});
  task.status='completed';task.acceptedBy='user';task.acceptedAt='2026-10-01T00:00:00.000Z';task.completedAt=task.acceptedAt;
  task.verification={passed:true,summary:'此前已通过核对',gaps:[],at:'2026-10-01T00:00:00.000Z',basis:acceptance.basis(a,task)};
}
test('Archive preserves current accepted dependency evidence and its goal checkpoint under permission restriction',async t=>{
  const {a,p,j,task,archive}=await setup(t),acceptance=require('../desktop/acceptance.cjs');
  const middle=a.createTask({title:'中间成果',projectId:p.id}),last=a.createTask({title:'最终成果',projectId:p.id});
  for(const child of [middle,last]){child.agentJobId=j.id;j.taskIds.push(child.id);}middle.dependsOn=[task.id];last.dependsOn=[middle.id];
  markVerified(a,task);markVerified(a,middle);markVerified(a,last);
  // Reverse display order must not control dependency migration order.
  a.data.tasks=[last,middle,...a.data.tasks.filter(t=>![last.id,middle.id].includes(t.id))];
  j.status='completed';j.finishAfterAcceptance=true;j.acceptanceCheckpoint={at:'2026-10-01T00:00:00.000Z',taskIds:[task.id,middle.id,last.id],basis:acceptance.completionBasis(a,j)};
  const oldCheckpoint=j.acceptanceCheckpoint.basis,oldBasis=task.verification.basis;archive();
  for(const child of [task,middle,last]){assert.deepEqual(acceptance.reasons(a,child,{completed:true}),[]);assert.equal(child.verification.basis,acceptance.basis(a,child));assert.equal(child.verification.at,'2026-10-01T00:00:00.000Z');assert.equal(child.verification.summary,'此前已通过核对');assert.equal(child.verification.policyOnlyMigration,undefined);assert.equal(child.acceptedAt,'2026-10-01T00:00:00.000Z');}
  assert.equal(task.verification.basis,oldBasis);assert.equal(j.acceptanceCheckpoint.basis,oldCheckpoint);assert.equal(j.acceptanceCheckpoint.basis,acceptance.completionBasis(a,j));assert.equal(j.acceptanceCheckpoint.at,'2026-10-01T00:00:00.000Z');
  const next=new Assistant({dir:a.dir}),persisted=next.data.tasks.find(t=>t.id===last.id);assert.equal(persisted.verification.basis,acceptance.basis(next,persisted));assert.deepEqual(acceptance.reasons(next,persisted,{completed:true}),[]);assert.deepEqual(persisted.verification,last.verification);
});
test('Permission migration does not upgrade stale evidence, unchecked legacy results, incomplete work or goal checkpoints',async t=>{
  const {a,p,j,task,archive}=await setup(t),acceptance=require('../desktop/acceptance.cjs');markVerified(a,task);const oldBasis=task.verification.basis;
  a.data.artifacts.find(r=>r.id===task.steps[0].artifactId).content='已被用户修改';
  const unchecked=a.createTask({title:'缺依据旧成果',projectId:p.id});unchecked.agentJobId=j.id;j.taskIds.push(unchecked.id);markVerified(a,unchecked);delete unchecked.verification.basis;
  const incomplete=a.createTask({title:'未验收事项',projectId:p.id});incomplete.agentJobId=j.id;j.taskIds.push(incomplete.id);markVerified(a,incomplete);incomplete.status='review';
  j.acceptanceCheckpoint={basis:acceptance.completionBasis(a,j),at:'old'};const checkpoint=structuredClone(j.acceptanceCheckpoint),incompleteVerification=structuredClone(incomplete.verification);archive();
  assert.equal(task.verification.basis,oldBasis);assert.equal(task.verification.policyOnlyMigration,undefined);assert.equal(unchecked.verification.basis,undefined);assert.deepEqual(incomplete.verification,incompleteVerification);assert.deepEqual(j.acceptanceCheckpoint,checkpoint);assert.ok(acceptance.reasons(a,task,{completed:true}).length);
});
test('Unknown external action blocks all permission verification migration including legacy unscoped receipt',async t=>{
  const {a,j,task,archive}=await setup(t);markVerified(a,task);const before=structuredClone(task.verification);j.pendingActionId='legacy';a.data.agentActions.push({id:'legacy',status:'uncertain'});archive();assert.deepEqual(task.verification,before);assert.equal(j.pendingActionId,'legacy');assert.equal(a.data.agentActions[0].status,'uncertain');
});
test('Restoring before archive after reopen cannot resurrect automatic rule grants or archived rules',async t=>{
  const {a,p,archive,reopen}=await setup(t),rule=a.data.workRules[0];Object.assign(rule.config,{fileMode:'auto',githubMode:'auto',githubUpdateMode:'auto',githubCommentMode:'auto'});const before=recovery.create(a);archive();reopen();rule.status='archived';recovery.restore(a,before);
  const restored=a.data.workRules.find(r=>r.id===rule.id);assert.equal(a.data.projects.find(r=>r.id===p.id).archivedAt,undefined);assert.equal(restored.status,'archived');assert.equal(restored.nextRunAt,null);for(const key of ['fileMode','githubMode','githubUpdateMode','githubCommentMode'])assert.equal(restored.config[key],'ask',key);
});
test('Lifecycle retain restricts old-only rule grants and does not silently enable current explicit grants',async t=>{
  const {a,p,archive,reopen}=await setup(t);archive();reopen();const current=structuredClone(a.data),restored=structuredClone(a.data);restored.workRules.push({id:'old-only',status:'enabled',config:{projectId:p.id,fileMode:'auto',githubMode:'auto',githubUpdateMode:'auto',githubCommentMode:'auto'}});current.workRules[0].config.fileMode='off';restored.workRules[0].config.fileMode='auto';
  lifecycle.retain(current,restored);assert.equal(restored.workRules[0].config.fileMode,'off');assert.equal(restored.workRules[0].status,'paused');for(const key of ['fileMode','githubMode','githubUpdateMode','githubCommentMode'])assert.equal(restored.workRules[1].config[key],'ask',key);assert.equal(restored.workRules[1].status,'paused');
});
