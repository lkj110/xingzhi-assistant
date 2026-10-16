const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const revision=require('../desktop/revision-protocol.cjs'),evidence=require('../desktop/evidence-basis.cjs');
const policy=require('../desktop/protocol-access.cjs'),policies=require('../desktop/access-policy-store.cjs');
const context=require('../desktop/task-context.cjs'),acceptance=require('../desktop/acceptance.cjs');
const oldAt='2026-01-01T00:00:00Z',noteAt='2026-02-01T00:00:00Z',replacementAt='2026-02-01T00:00:01Z';

function fixture(t,{supporting=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-revision-safety-'));
 let unexpectedCalls=0;
 const prohibited=async()=>{unexpectedCalls++;throw Error('Unexpected network/model call');};
 const options={dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited,platformRequest:prohibited};
 t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});assert.equal(unexpectedCalls,0,'all model/network calls must use explicit mocks');});
 const a=new Assistant(options);
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const job=agent.buildJob(a,{goal:'保留事实，简明交接',autoAccept:false,maxActions:1});a.data.delegations.push(job);
 const task=a.createTask({title:'交接稿',criteria:'按用户要求修订，保留事实',steps:[...(supporting?[{title:'辅助说明',kind:'analysis'}]:[]),{title:'正文',kind:'draft'}]});
 task.agentJobId=job.id;task.generationMode='single';job.taskIds=[task.id];
 const f={a,job,task,dir,options};
 for(const step of task.steps)saveDraft(f,step,step.kind==='draft'?'PUBLIC\nDENIED_BODY_SENTINEL':'辅助说明原文');
 a.save();return f;
}
function saveDraft(f,step,content,{createdAt=oldAt,stale=false,bind=true}={}){
 const artifact={id:randomUUID(),taskId:f.task.id,stepId:step.id,title:step.title,content,createdAt,...(stale?{stale:true}:{})};
 f.a.data.artifacts.push(artifact);
 if(!stale)policy.retain(f.a,'artifact',artifact,{task:f.task,job:f.job});
 if(bind){Object.assign(step,{done:true,artifactId:artifact.id});require('../desktop/step-evidence.cjs').record(f.a,f.task,step);}
 return artifact;
}
function restore(f){
 const a=new Assistant(f.options),job=a.data.delegations.find(j=>j.id===f.job.id),task=a.task(f.task.id);
 return {...f,a,job,task};
}
function reopen(step){step.done=false;delete step.artifactId;}
function original(f){return f.a.data.artifacts.find(r=>r.id===f.task.steps.at(-1).artifactId);}
function revoke(f,artifact){
 policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+artifact.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command',command:'revision_safety_test'});
 assert.equal(policy.allowedObject(f.a,'artifact',artifact,f.job,f.task),false);
}
async function queue(f,artifact){
 await agent.act(f.a,f.job,'revise_task',{taskId:f.task.id,artifactId:artifact.id,note:'把 PUBLIC 改为 PUBLIC2，其余原样保留'});
}
function assertNotPublished(f,ids){
 assert.deepEqual(f.a.data.artifacts.map(r=>r.id),ids,'failed revision must not save a new readable copy');
 assert.equal(f.task.steps.at(-1).done,false);assert.equal(f.task.steps.at(-1).artifactId,undefined);
 assert.notEqual(f.task.status,'review');assert.notEqual(f.task.status,'completed');
 assert.notEqual(f.task.verification?.passed,true);assert.ok(f.task.lastError);
 assert.equal(f.a.data.agentActions.length,0);
}

test('revoked original cannot be copied into a newly retained draft before generation',async t=>{
 const f=fixture(t),artifact=original(f);await queue(f,artifact);const ids=f.a.data.artifacts.map(r=>r.id);
 revoke(f,artifact);
 assert.throws(()=>revision.source(f.a,f.task,f.task.steps[0]),{code:'CONTEXT_SCOPE_DENIED'});
 await agent.act(f.a,f.job,'advance_task',{taskId:f.task.id});assertNotPublished(f,ids);
 assert.equal((f.a.data.modelCalls||[]).length,0);
 assert.equal(context.buildContext(f.a,context.taskScope(f.task)).historyCatalog.some(r=>r.id===artifact.id),false);
 f.a.save();const restored=restore(f);
 assert.throws(()=>revision.source(restored.a,restored.task,restored.task.steps[0]),{code:'CONTEXT_SCOPE_DENIED'});
});

for(const route of ['patch','full_rewrite','patch_fallback'])test(`revocation during ${route} generation rejects the returned candidate`,async t=>{
 const f=fixture(t),artifact=original(f);await queue(f,artifact);const ids=f.a.data.artifacts.map(r=>r.id);
 require('../desktop/work-efficiency.cjs').before(f.a,f.job);
 if(route==='full_rewrite')Object.assign(f.job.executionState.workEfficiency,{phase:'recovering',active:{id:'full_rewrite:'+f.task.id,queue:[],reads:0}});
 let calls=0;
 f.a.chat=async(_p,_k,m,o)=>{
  calls++;o.onUsage({inputTokens:1,outputTokens:1});assert.equal(o.stage,'task_work','a revoked candidate must not reach verification');
  const c=JSON.parse(m[1].content);assert.equal(c.revision.artifactId,artifact.id);
  if(route==='patch_fallback'&&calls===1)return {kind:'patch',edits:[{before:'not in the original',after:'replacement'}],summary:'触发完整稿回退'};
  revoke(f,artifact);
  return route==='patch'?{kind:'patch',edits:[{before:'PUBLIC',after:'PUBLIC2'}],summary:'修改前缀'}:{kind:'artifact',title:'修订稿',content:'PUBLIC2\nDENIED_BODY_SENTINEL',summary:'完整改写'};
 };
 await agent.act(f.a,f.job,'advance_task',{taskId:f.task.id});
 assert.equal(calls,route==='patch_fallback'?2:1);assertNotPublished(f,ids);
 assert.equal(policy.allowedObject(f.a,'artifact',artifact,f.job,f.task),false);
});

test('a same-ID original changed during generation cannot receive a patch from its previous version',async t=>{
 const f=fixture(t),artifact=original(f);await queue(f,artifact);const ids=f.a.data.artifacts.map(r=>r.id);let calls=0;
 f.a.chat=async(_p,_k,_m,o)=>{calls++;o.onUsage({inputTokens:1,outputTokens:1});assert.equal(o.stage,'task_work');artifact.content='PUBLIC\n另一个版本的原稿';return {kind:'patch',edits:[{before:'PUBLIC',after:'PUBLIC2'}],summary:'旧版本补丁'};};
 await agent.act(f.a,f.job,'advance_task',{taskId:f.task.id});assert.equal(calls,1);assertNotPublished(f,ids);
 assert.equal(artifact.content,'PUBLIC\n另一个版本的原稿');
});

test('legacy fallback binds once and never moves from supporting report to main after restart',t=>{
 let f=fixture(t,{supporting:true});const support=f.task.steps[0],main=f.task.steps[1],supportId=support.artifactId,mainId=main.artifactId;
 reopen(support);f.task.notes.push({kind:'revise',at:noteAt,text:'只更正辅助说明'});
 assert.equal(revision.source(f.a,f.task,support).artifact.id,supportId);
 // source() must persist the initial decision itself, not merely remember it in memory.
 f=restore(f);assert.equal(f.task.notes.at(-1).targetArtifactId,supportId);
 saveDraft(f,f.task.steps[0],'辅助说明已修正',{createdAt:replacementAt});reopen(f.task.steps[1]);f.a.save();f=restore(f);
 assert.equal(revision.source(f.a,f.task,f.task.steps[1]),null);
 assert.equal(revision.source(f.a,f.task,f.task.steps[0]),null);
 assert.equal(f.task.notes.at(-1).targetArtifactId,supportId);
 assert.equal(f.a.data.artifacts.find(r=>r.id===mainId).content,'PUBLIC\nDENIED_BODY_SENTINEL');
});

test('an unresolved legacy target remains unresolved when later only one step is unfinished',t=>{
 let f=fixture(t,{supporting:true}),mainId=f.task.steps[1].artifactId;
 f.task.steps.forEach(reopen);f.task.notes.push({kind:'revise',at:noteAt,text:'旧备注没有可靠目标'});
 assert.equal(revision.source(f.a,f.task,f.task.steps[0]),null);
 f=restore(f);assert.equal(f.task.notes.at(-1).legacyTargetUnresolved,true);
 Object.assign(f.task.steps[1],{done:true,artifactId:mainId});f.a.save();f=restore(f);
 assert.equal(revision.source(f.a,f.task,f.task.steps[0]),null);
 assert.equal(f.task.notes.at(-1).targetArtifactId,undefined);
});

test('a stale candidate does not consume a revision note, but a valid replacement does',t=>{
 let f=fixture(t),step=f.task.steps[0],artifact=original(f);
 reopen(step);f.task.notes.push({kind:'revise',at:noteAt,text:'修订指定原稿',targetStepId:step.id,targetArtifactId:artifact.id,baseHash:evidence.hash(artifact.content)});
 assert.equal(revision.source(f.a,f.task,step).artifact.id,artifact.id);
 saveDraft(f,step,'生成期间失效的候选稿',{createdAt:replacementAt,stale:true,bind:false});f.a.save();f=restore(f);step=f.task.steps[0];
 assert.equal(revision.source(f.a,f.task,step).artifact.id,artifact.id);
 saveDraft(f,step,'有效替换稿',{createdAt:'2026-02-01T00:00:02Z'});reopen(step);
 assert.equal(revision.source(f.a,f.task,step),null);
});

test('legacy requirement projections refresh without invalidating unchanged gaps',t=>{
 const f=fixture(t),obligations=require('../desktop/work-obligations.cjs');
 f.job.executionContract={text:'交接',revision:'contract-1',updatedAt:oldAt};
 f.job.feedback=[{at:noteAt,kind:'user_feedback',text:'主文最多两页'}];
 f.task.criteria='当前步骤口径';
 const state=require('../desktop/operation-ledger.cjs').state(f.job);
 state.requirements=[{id:'goal',text:'交接',revision:evidence.hash({id:'goal',intent:evidence.intent(f.job,null)})},{id:'task:'+f.task.id,taskId:f.task.id,text:'旧步骤口径',revision:evidence.hash({id:'task:'+f.task.id,intent:evidence.intent(f.job,f.task)})}];
 const goalRevision=state.requirements[0].revision,taskRevision=state.requirements[1].revision;
 state.gaps=[{id:'open',requirementId:'goal',requirementRevision:goalRevision,status:'open',text:'尚未简明'},{id:'accepted',requirementId:'goal',requirementRevision:goalRevision,status:'accepted_gap',text:'权限边界',acceptedRequirementText:'交接'},{id:'task-open',requirementId:'task:'+f.task.id,requirementRevision:taskRevision,status:'open',text:'仍需核对'}];
 const gaps=structuredClone(state.gaps),requirements=obligations.requirements(f.a,f.job);
 assert.equal(requirements[0].authority,'user');assert.ok(requirements[0].userDirectives.some(d=>d.text==='主文最多两页'));
 assert.equal(requirements[1].authority,'agent_projection');assert.equal(requirements[1].text,'当前步骤口径');
 assert.deepEqual(requirements.map(r=>r.revision),[goalRevision,taskRevision]);assert.deepEqual(state.gaps,gaps);
 f.a.save();const restored=restore(f);assert.deepEqual(restored.job.executionState.gaps,gaps);
 assert.equal(obligations.requirements(restored.a,restored.job)[1].authority,'agent_projection');
 restored.job.feedback.push({at:'2026-03-01T00:00:00Z',kind:'user_feedback',text:'新增要求：说明延期原因'});
 obligations.requirements(restored.a,restored.job);
 assert.equal(restored.job.executionState.gaps.find(g=>g.id==='open').status,'superseded');
 assert.equal(restored.job.executionState.gaps.find(g=>g.id==='accepted').status,'accepted_gap');
});

test('accepted tasks reject revision and automatic recovery without reopening or changing their delivery',async t=>{
 const f=fixture(t),artifact=original(f);
 const other=f.a.createTask({title:'尚未完成的其他事项',criteria:'另行处理',steps:[{title:'正文',kind:'draft'}]});other.agentJobId=f.job.id;f.job.taskIds.push(other.id);
 f.task.status='review';f.task.verification={passed:true,summary:'符合用户要求',gaps:[],basisVersion:2,basis:acceptance.basis(f.a,f.task)};
 acceptance.acceptTask(f.a,{id:f.task.id});assert.equal(f.task.acceptedBy,'user');assert.equal(f.task.status,'completed');
 const before=structuredClone(f.task),artifacts=structuredClone(f.a.data.artifacts);
 assert.throws(()=>revision.queue(f.a,f.task,{artifactId:artifact.id,note:'自动重开'}),/不能自动修订/);
 await assert.rejects(agent.act(f.a,f.job,'revise_task',{taskId:f.task.id,artifactId:artifact.id,note:'自动重开'}));
 const recovery=require('../desktop/auto-recovery.cjs');assert.equal(recovery.repair(f.a,f.task),false);
 f.job.autoRecovery={status:'scheduled',taskId:f.task.id,basis:acceptance.basis(f.a,f.task)};
 assert.equal(recovery.pendingTask(f.a,f.job),null);
 assert.deepEqual(f.task,before);assert.deepEqual(f.a.data.artifacts,artifacts);assert.equal((f.a.data.modelCalls||[]).length,0);
 f.a.save();const restored=restore(f);assert.equal(restored.task.status,'completed');assert.deepEqual(restored.task.finalDelivery,before.finalDelivery);
});
