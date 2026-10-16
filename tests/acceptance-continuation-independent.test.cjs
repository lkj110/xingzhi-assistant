const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const acceptance=require('../desktop/acceptance.cjs');
const journal=require('../desktop/work-journal.cjs');
const control=require('../desktop/execution-control.cjs');
function check(a,job){return acceptance.recordCompletionCheck(a,job,{passed:true,summary:'已核对整体范围',gaps:[]},{basis:acceptance.completionBasis(a,job)});}

async function setup(t,{maxActions=3,response,checked=true}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-acceptance-continuation-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const stages=[];
  const a=new Assistant({dir,agentRequest:()=>{throw Error('network forbidden');},chat:async(_p,_k,m,o)=>{stages.push(o.stage);if(response)return response(o.stage,JSON.parse(m[1].content),stages.length);return {passed:true,summary:'用户验收完成，目标符合',gaps:[]};}});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture'});
  const job=agent.buildJob(a,{goal:'生成并验收一份完整说明',autoAccept:false,allowWeb:false,maxActions});a.data.delegations.push(job);
  const planned=await agent.act(a,job,'plan_task',{key:'draft',title:'完整说明',criteria:'正文完整',steps:[{key:'draft',title:'编写说明',kind:'draft'}]});const task=a.task(planned.taskId);
  task.steps[0].done=true;task.steps[0].artifactId='written';a.data.artifacts.push({id:'written',taskId:task.id,stepId:task.steps[0].id,title:'说明',content:'完整说明正文',createdAt:new Date().toISOString()});task.status='review';task.verification={passed:true,summary:'检查通过',gaps:[],at:new Date().toISOString(),basis:acceptance.basis(a,task)};job.status='review';if(checked)check(a,job);
  const accept=()=>a.dispatch('taskAction',{id:task.id,command:'accept'});const run=async()=>{await a.dispatch('agentRun',{id:job.id});await a.runPromise;};
  return {a,job,task,stages,accept,run,dir};
}
const ask={tool:'ask',args:{key:'reassess',question:'新信息需要补充说明',taskIds:[]}};

test('Acceptance closure: paused review with current overall check finishes locally without resuming work',async t=>{
  const {a,job,task,stages,accept}=await setup(t);await a.dispatch('agentPause',{id:job.id});await accept();
  assert.equal(job.status,'completed');assert.equal(job.finishAfterAcceptance,undefined);assert.equal(task.acceptedBy,'user');assert.deepEqual(stages,[]);assert.equal(agent.tick(a),false);assert.equal(control.next(a,job),null);assert.equal(job.nextRunAt,undefined);assert.equal(a.data.decisions.length,0);
});
test('Acceptance closure: changed source context invalidates final acceptance without changing accepted history',async t=>{
  const {a,job,task,stages,accept}=await setup(t,{response:()=>ask});a.data.sources.push({id:'context',title:'补充依据',content:'原始内容',state:'processed'});job.sourceIds.push('context');task.verification.basis=acceptance.basis(a,task);check(a,job);a.data.sources[0].content='新增约束';
  await assert.rejects(accept(),/整体检查/);assert.deepEqual(stages,[]);assert.equal(job.status,'review');assert.equal(task.acceptedAt,undefined);assert.equal(job.finishAfterAcceptance,undefined);
});
test('Acceptance preflight: failed overall verification allows planning within the remaining action budget',async t=>{
  const {a,job,task,stages,accept,run}=await setup(t,{checked:false,maxActions:2,response:stage=>stage==='goal_verify'?{passed:false,summary:'整体还缺一项结果',gaps:['缺附录']}:ask});await run();
  assert.deepEqual(stages,['goal_verify','planner']);assert.equal(job.status,'needs_input');assert.equal(a.data.agentRuns[0].steps.length,2);assert.equal(job.finishAfterAcceptance,undefined);assert.equal(a.data.agentRuns[0].steps[0].result.complete,false);assert.equal(job.completionCheck.passed,false);await assert.rejects(accept());assert.equal(task.acceptedAt,undefined);
});
test('Acceptance preflight: goal verification consumes one action and cannot exceed maxActions one',async t=>{
  const {a,job,stages,run}=await setup(t,{checked:false,maxActions:1,response:stage=>stage==='goal_verify'?{passed:false,summary:'还缺附录',gaps:['附录']}:ask});await run();assert.deepEqual(stages,['goal_verify']);assert.equal(job.status,'ready');assert.equal(a.data.agentRuns[0].steps.length,1);assert.equal(job.finishAfterAcceptance,undefined);
  await run();assert.deepEqual(stages,['goal_verify','planner']);assert.equal(job.status,'needs_input');assert.equal(job.completionCheck.passed,false);
});
test('Acceptance closure: exhausted legacy count limit does not require another model call',async t=>{
  const {job,stages,accept}=await setup(t);job.maxCalls=40;job.callsUsed=40;await accept();assert.equal(job.status,'completed');assert.equal(job.callsUsed,40);assert.deepEqual(stages,[]);
});
test('Acceptance preflight: transient overall-check failure retains review for a bounded retry',async t=>{
  const {job,task,stages,accept,run}=await setup(t,{checked:false,response:(stage,context,count)=>{assert.equal(stage,'goal_verify');if(count===1)throw Error('temporary fixture outage');return {passed:true,summary:'重试后检查完成',gaps:[]};}});await run();assert.equal(job.status,'retry');assert.equal(task.status,'review');assert.equal(task.acceptedAt,undefined);await run();assert.equal(job.status,'review');await accept();assert.equal(job.status,'completed');assert.deepEqual(stages,['goal_verify','goal_verify']);assert.equal(job.finishAfterAcceptance,undefined);
});
test('Acceptance preflight: late unresolved decision or waiting condition prevents final acceptance',async t=>{
  for(const mutate of [(a,j)=>a.data.decisions.push({id:'late',jobId:j.id,status:'open',taskIds:[]}),(a,j)=>j.followups.push({key:'late',status:'waiting',expected:'新增确认'})]){
    const {a,job,task,stages,accept}=await setup(t,{response:()=>ask});mutate(a,job);await assert.rejects(accept());assert.deepEqual(stages,[]);assert.notEqual(job.status,'completed');assert.equal(task.acceptedAt,undefined);assert.equal(job.finishAfterAcceptance,undefined);
  }
});
test('Acceptance closure: committed tasks and completion survive reload without another acceptance or model request',async t=>{
  const {a,job,task,accept,dir}=await setup(t);await accept();const stages=[];const restored=new Assistant({dir,chat:async(_p,_k,m,o)=>{stages.push(o.stage);throw Error('completed history must not call a model');}});
  assert.equal(restored.task(task.id).acceptedBy,'user');assert.equal(restored.data.delegations[0].status,'completed');assert.deepEqual(stages,[]);assert.equal(restored.data.decisions.length,0);assert.equal(a.data.delegations[0].status,'completed');assert.equal(control.next(restored,restored.data.delegations[0]),null);assert.equal(journal.read(restored).events.filter(e=>e.type==='accepted').length,1);
});
test('Acceptance closure: paused one-shot watcher with current delivery finishes without another source check',async t=>{
  const {a,job,task,stages,accept,dir}=await setup(t);const folder=path.join(dir,'materials');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'input.md'),'已确认的说明材料');a.data.folders.push({id:'folder',path:folder,name:'资料'});const before=structuredClone(job);job.folderIds=['folder'];require('../desktop/access-policy-store.cjs').syncTrustedJob(a,job,{before,trusted:true,actor:'user_command',command:'test-select-folder'});
  await agent.act(a,job,'read_file',{folderId:'folder',name:'input.md'});task.verification.basis=acceptance.basis(a,task);check(a,job);job.status='watching';await a.dispatch('agentPause',{id:job.id});await accept();
  assert.equal(job.status,'completed');assert.deepEqual(stages,[]);assert.equal(job.finishAfterAcceptance,undefined);assert.equal(job.nextRunAt,undefined);assert.equal(control.next(a,job),null);
});
