const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),access=require('../desktop/access.cjs'),decisions=require('../desktop/decisions.cjs');
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-output-access-'));const a=new Assistant({dir,connectorRequest:async()=>{throw Error('No external requests');}});t.after(()=>{access.cancel(a);fs.rmSync(dir,{recursive:true,force:true});});
  await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
  const j=agent.buildJob(a,{goal:'保留完整修订稿，将旧核对稿归入历史',allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.push(j);
  await agent.act(a,j,'plan_task',{key:'output',title:'精简文档',criteria:'完整保留要求',steps:[{key:'a',kind:'analysis',title:'核对'},{key:'d',kind:'draft',title:'完整修订稿'}]});
  const task=a.task(j.taskIds[0]);for(const [i,s] of task.steps.entries()){s.done=true;s.artifactId='artifact-'+i;a.data.artifacts.push({id:s.artifactId,taskId:task.id,stepId:s.id,title:s.title,content:'完整正文'+i,createdAt:new Date(i*1000).toISOString()});}
  return {a,j,task};
}
const local={kind:'external',target:'当前事项的产出版本状态记录（旧核对稿的 current/archive 状态）',reason:'请启用应用中的状态记录只读连接'};
function pending(a,j){const d={id:'bad-access',jobId:j.id,kind:'permission',status:'open',question:'需要授权：检查外部访问权限',taskIds:[...j.taskIds],sourceIds:[],access:{...local,stage:'requested'}};a.data.decisions.unshift(d);j.status='needs_input';j.nextRunAt=null;return d;}
test('Local output access and questions return actual metadata without permission or network calls',async t=>{
  const {a,j,task}=await fixture(t),before=JSON.stringify(a.spendLedger);
  const r=await agent.act(a,j,'request_access',local);assert.equal(r.needsAuthorization,false);assert.equal(r.source,'app_workspace');assert.equal(r.tasks[0].artifacts[0].current,true);assert.equal(a.data.decisions.length,0);assert.equal(j.status,'ready');assert.equal(JSON.stringify(a.spendLedger),before);
  const q=decisions.ask(a,j,{question:'请提供应用中的产出版本状态记录，需要读取授权',key:'version'});assert.equal(q.externalAuthorizationRequired,false);assert.equal(q.tasks[0].taskId,task.id);assert.equal(a.data.decisions.length,0);
});
test('Output metadata is scoped, retains history and distinguishes replan from retirement',async t=>{
  const {a,j,task}=await fixture(t);task.needsReplan='用户补充';
  const r=await agent.act(a,j,'read_output_state',{});assert.equal(r.tasks[0].artifacts[0].current,false);assert.equal(r.tasks[0].artifacts[0].referencedByDoneStep,true);
  const other=agent.buildJob(a,{goal:'other'});a.data.delegations.push(other);
  await assert.rejects(agent.act(a,other,'read_output_state',{taskId:task.id}),/本委托/);
  task.deletedAt=new Date().toISOString();assert.equal((await agent.act(a,j,'read_output_state',{})).tasks.length,0);await assert.rejects(agent.act(a,j,'read_output_state',{taskId:task.id}),/删除/);
});
test('Real external document authorization is not swallowed by local metadata detection',async t=>{
  const {a,j}=await fixture(t);for(const args of [{kind:'lark_document',target:'https://a.larkoffice.com/docx/Version',reason:'读取应用中的版本状态记录'},{kind:'external',target:'https://a.larkoffice.com/docx/Version',reason:'获取事项产出版本状态记录'},{kind:'external',target:'GitHub repository',reason:'访问权限不足'}])assert.equal(access.request(a,j,args).needsAuthorization,true);
});
test('Startup corrects mistaken local access once, keeps costs and truthful output state',async t=>{
  const {a,j}=await fixture(t);pending(a,j);j.callsUsed=63;const budget=JSON.stringify(a.spendLedger);a.save();
  const b=new Assistant({dir:a.dir});t.after(()=>access.cancel(b));const d=b.data.decisions.find(d=>d.id==='bad-access'),job=b.data.delegations[0];assert.equal(d.status,'resolved');assert.equal(d.access.stage,'local');assert.equal(d.localEvidence.tasks[0].artifacts[0].current,true);assert.equal(job.status,'ready');assert.equal(job.callsUsed,63);assert.equal(JSON.stringify(b.spendLedger),budget);assert.equal(job.feedback.at(-1).origin,'app_recovery');const count=job.feedback.length;access.initialize(b);assert.equal(job.feedback.length,count);
});
test('Correcting local access preserves pauses, other questions and uncertain action barriers',async t=>{
  for(const mode of ['paused','question','uncertain']){
    const {a,j}=await fixture(t);pending(a,j);
    if(mode==='paused')j.status='paused';
    if(mode==='question')a.data.decisions.push({id:'choice',jobId:j.id,kind:'question',question:'由谁验收？',status:'open',taskIds:j.taskIds,sourceIds:[]});
    if(mode==='uncertain')a.data.agentActions.push({id:'uncertain',jobId:j.id,taskId:j.taskIds[0],status:'uncertain'});
    access.initialize(a);assert.equal(j.status,mode==='paused'?'paused':mode==='question'?'needs_input':'ready');
    if(mode==='uncertain')assert.throws(()=>decisions.assertNoUncertain(a,j),/核对/);
  }
});
test('Retiring superseded analysis preserves drafts, history and criteria and invalidates verification',async t=>{
  const {a,j,task}=await fixture(t);task.verification={passed:true};const before=JSON.stringify(a.data.artifacts),criteria=task.criteria,budget=JSON.stringify(a.spendLedger);
  const state=await agent.act(a,j,'read_output_state',{taskId:task.id});await agent.act(a,j,'retire_output',{taskId:task.id,artifactId:'artifact-0',replacementArtifactId:'artifact-1',revision:state.tasks[0].revision,reason:'用户要求归档旧核对稿，已核对完整修订稿覆盖全部要求'});
  const result=await agent.act(a,j,'read_output_state',{taskId:task.id});assert.equal(result.tasks[0].artifacts[0].current,false);assert.equal(result.tasks[0].artifacts[0].referencedByDoneStep,false);assert.equal(result.tasks[0].artifacts[1].current,true);assert.equal(task.steps.length,1);assert.equal(task.steps[0].done,true);assert.equal(task.criteria,criteria);assert.equal(task.verification,null);assert.equal(task.status,'todo');assert.equal(task.planHistory.at(-1).steps.length,2);assert.equal(JSON.stringify(a.data.artifacts),before);assert.equal(JSON.stringify(a.spendLedger),budget);
});
test('Retirement rejects stale state, reversed replacements, and paused or accepted work',async t=>{
  const {a,j,task}=await fixture(t),state=(await agent.act(a,j,'read_output_state',{taskId:task.id})).tasks[0];const args={taskId:task.id,artifactId:'artifact-0',replacementArtifactId:'artifact-1',revision:state.revision,reason:'替代'};
  await assert.rejects(agent.act(a,j,'retire_output',{...args,revision:'stale'}),/已变化/);
  await assert.rejects(agent.act(a,j,'retire_output',{...args,artifactId:'artifact-1',replacementArtifactId:'artifact-0'}),/分析步骤/);
  for(const status of ['paused','completed']){task.status=status;await assert.rejects(agent.act(a,j,'retire_output',args),/不能自动/);}assert.equal(task.steps.length,2);
});
test('Generic permission retry does not claim verified authorization',async t=>{
  const {a,j}=await fixture(t);const r=access.request(a,j,{kind:'external',target:'GitHub'}),d=a.data.decisions.find(d=>d.id===r.decisionId);
  await a.dispatch('accessRetry',{id:d.id,revision:decisions.revision(a.data,d)});assert.equal(d.access.stage,'recheck_requested');assert.ok(a.data.events.some(e=>e.title==='已安排重新检查权限'));assert.ok(!a.data.events.some(e=>e.title==='授权检查已完成'));
});
