const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),c=require('../desktop/continuation-control.cjs'),spend=require('../desktop/spend.cjs');
async function setup(t,{prepare=true}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'root-existing-action-'))),output=path.join(dir,'output');fs.mkdirSync(output);
 const deny=async()=>{throw Error('Network forbidden');};let draft=0;
 const chat=async(_p,_k,m,o)=>{o.onUsage?.({inputTokens:10,outputTokens:10});const prompt=m[0].content;if(prompt.includes('推进给定事项'))return {kind:'artifact',title:'报告',content:'# 报告\n\n真实依据，版本 '+(++draft)};if(prompt.includes('动作格式'))throw Error('No planner needed');return {passed:true,summary:'已核对',gaps:[]};};
 const a=new Assistant({dir,chat,webRequest:deny,connectorRequest:deny,agentRequest:deny});t.after(async()=>{require('../desktop/execution.cjs').abortAll(a);await a.runPromise;fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.agentSettings.outputFolder=output;
 const job=agent.buildJob(a,{goal:'基于事实形成报告并保存文件，等待用户验收',useOutputFolder:true,fileMode:'ask',autoAccept:false,maxActions:1});a.data.delegations.push(job);
 const planned=await agent.act(a,job,'plan_task',{key:'report',title:'报告',criteria:'真实报告保存文件',steps:[{key:'draft',kind:'draft',title:'正文'},{key:'file',kind:'external',tool:'write_file',title:'保存'}]});const task=a.task(planned.taskId);task.generationMode='single';await agent.act(a,job,'advance_task',{taskId:task.id});
 const step={tool:'plan_task',args:{existingTaskId:task.id},at:new Date().toISOString()};assert.equal(c.redirect(a,job,step,{code:'PLAN_ALREADY_RECONCILED',taskId:task.id,message:'计划已协调'}),true);
 if(!prepare){a.save();return {a,job,task,output,dir};}
 await agent.act(a,job,'write_file',{taskId:task.id});const action=a.data.agentActions.find(r=>r.id===job.pendingActionId);assert.equal(action.status,'pending');a.save();return {a,job,task,action,output,dir};
}
test('controller ask → exact approval → same pending action executes through tick',async t=>{const f=await setup(t);await f.a.dispatch('agentApprove',{id:f.job.id});assert.equal(c.existingAction(f.a,f.job).kind,'approved');assert.equal(agent.tick(f.a),true);await f.a.runPromise;assert.equal(f.action.status,'done');assert.equal(f.a.data.agentActions.length,1);assert.equal(fs.readdirSync(f.output).length,2);});
for(const kind of ['paused','exhausted','budget','revoked'])test('approved action respects '+kind+' without a write',async t=>{const f=await setup(t);await f.a.dispatch('agentApprove',{id:f.job.id});if(kind==='paused')f.job.executionPaused=true;if(kind==='exhausted'){const e=Object.values(f.job.executionState.continuation.episodes)[0];e.blocked=true;e.reason='真实周期耗尽';}if(kind==='budget'){f.a.activeAgentJob=f.job;const s=spend.scope(f.a);s.limitUSD=1;s.spentUSD=1;spend.persist(f.a);f.a.activeAgentJob=null;}if(kind==='revoked')f.job.fileMode='off';agent.tick(f.a);await f.a.runPromise;assert.equal(fs.readdirSync(f.output).length,0);assert.notEqual(f.action.status,'done');});
test('exhausted uncertain action is read-only reconciled by tick and stays blocked',async t=>{
 const f=await setup(t);await f.a.dispatch('agentApprove',{id:f.job.id});await require('../desktop/agent-writes.cjs').execute(f.a,f.job,f.action);
 const bytes=fs.readFileSync(f.action.target,'utf8'),e=Object.values(f.job.executionState.continuation.episodes)[0];e.blocked=true;e.reason='真实周期耗尽';f.action.status='uncertain';f.job.pendingActionId=f.action.id;f.job.status='blocked';f.task.status='todo';f.job.nextRunAt=null;f.a.save();
 assert.equal(agent.tick(f.a),true);await f.a.runPromise;assert.equal(f.action.status,'done');assert.equal(f.job.status,'blocked');assert.equal(fs.readFileSync(f.action.target,'utf8'),bytes);assert.equal(f.a.data.agentActions.length,1);assert.equal(f.a.data.agentRuns[0].steps.length,0);assert.equal(agent.tick(f.a),false);
});
test('uncertain mismatch gets one automatic readback attempt and no blind write',async t=>{
 const f=await setup(t);await f.a.dispatch('agentApprove',{id:f.job.id});await require('../desktop/agent-writes.cjs').execute(f.a,f.job,f.action);fs.writeFileSync(f.action.target,'外部人工修改');f.action.status='uncertain';f.job.pendingActionId=f.action.id;f.job.status='needs_input';f.task.status='todo';f.job.nextRunAt=null;f.a.save();assert.equal(agent.tick(f.a),true);await f.a.runPromise;assert.equal(f.action.status,'uncertain');assert.equal(agent.tick(f.a),false);assert.equal(fs.readFileSync(f.action.target,'utf8'),'外部人工修改');const attempts=f.a.data.agentRuns.length;f.a.save();const b=new Assistant({dir:f.dir,chat:async()=>{throw Error('no model');}}),j=b.data.delegations.find(j=>j.id===f.job.id);assert.equal(agent.tick(b),false);j.executionState.permissionRevision=(j.executionState.permissionRevision||0)+1;assert.equal(agent.tick(b),true);await b.runPromise;assert.equal(b.data.agentRuns.length,attempts+1);assert.equal(agent.tick(b),false);assert.equal(fs.readFileSync(f.action.target,'utf8'),'外部人工修改');
});
test('committed failed check counts once across restart before agent settlement',async t=>{
 const f=await setup(t);f.a.data.agentActions=[];f.job.pendingActionId=null;f.job.status='ready';f.task.steps[0].done=false;const step={tool:'advance_task',args:{taskId:f.task.id},at:new Date().toISOString()};c.started(f.a,f.job,step);
 const check={passed:false,basis:'actual-fixed-check',gaps:['消费者不明'],at:new Date().toISOString()};require('../desktop/state-transitions.cjs').commit(f.a,()=>{f.task.contentVerification=check;c.noteCheck(f.a,f.job,f.task,check);});const before=Object.values(f.job.executionState.continuation.episodes)[0];assert.equal(before.cycles,1);
 const b=new Assistant({dir:f.dir,chat:async()=>{throw Error('No model');}}),job=b.data.delegations.find(j=>j.id===f.job.id),task=b.task(f.task.id);c.settled(b,job,{tool:'verify_content',args:{taskId:task.id},result:{verification:check}});assert.equal(Object.values(job.executionState.continuation.episodes)[0].cycles,1);
});

test('three real primary revisions and failed checks stay bounded across restart and new artifact IDs',async t=>{
 let f=await setup(t,{prepare:false});const ids=[f.task.steps[0].artifactId];
 const chat=async(_p,_k,m,o)=>{o.onUsage?.({inputTokens:10,outputTokens:5});const ctx=JSON.parse(m[1].content);if(o.stage==='task_work'){const old=ctx.revision.originalContent;assert.equal(typeof old,'string');const n=Number(old.match(/版本 (\d+)/)[1]);return {kind:'patch',edits:[{before:'版本 '+n,after:'版本 '+(n+1)}]};}return {passed:false,summary:'消费者仍未核实',gaps:['消费者缺失']};};
 f.a.chat=chat;
 for(let i=0;i<3;i++){
  await agent.act(f.a,f.job,'revise_task',{taskId:f.task.id,artifactId:f.task.steps[0].artifactId,note:'补充消费者事实，保留未核实边界'});
  const step={tool:'advance_task',args:{taskId:f.task.id},at:new Date().toISOString()};c.started(f.a,f.job,step);step.result=await agent.act(f.a,f.job,step.tool,step.args);c.settled(f.a,f.job,step);
  ids.push(f.task.steps[0].artifactId);assert.equal(f.task.steps[0].done,true);
  const checked=await agent.act(f.a,f.job,'verify_content',{taskId:f.task.id});c.settled(f.a,f.job,{tool:'verify_content',args:{taskId:f.task.id},result:checked});f.a.save();
  assert.equal(Object.values(f.job.executionState.continuation.episodes)[0].cycles,i+1);
  if(i===1){const b=new Assistant({dir:f.dir,chat});f={...f,a:b,job:b.data.delegations.find(j=>j.id===f.job.id),task:b.task(f.task.id)};}
 }
 assert.equal(new Set(ids).size,4);assert.equal(f.job.status,'blocked');assert.equal(c.next(f.a,f.job),null);assert.equal(f.task.acceptedAt,undefined);
});
