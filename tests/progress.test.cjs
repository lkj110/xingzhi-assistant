const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const efficiency=require('../desktop/efficiency.cjs');

const read={tool:'read_file',args:{folderId:'input',name:'notes.md'}};
const plan={tool:'plan_task',args:{key:'report',title:'报告',criteria:'记录发布日',steps:[{key:'draft',title:'编写报告',kind:'draft'}]}};
async function setup(t,{actions,repeat=read,maxActions=12}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-progress-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=path.join(dir,'input');fs.mkdirSync(input);fs.writeFileSync(path.join(input,'notes.md'),'周五发布。');
  let calls=0;
  const a=new Assistant({dir,chat:async(p,k,m)=>{
    if(!m[0].content.includes('动作格式'))throw new Error('此场景只需规划调用');
    calls++;return structuredClone(actions?.shift()||repeat);
  }});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture'});
  a.data.folders=[{id:'input',name:'资料',path:input}];
  const job=agent.buildJob(a,{goal:'获取资料并形成报告',folderIds:['input'],maxCalls:40,maxActions});
  a.data.delegations.push(job);a.save();
  async function run(){await a.dispatch('agentRun',{id:job.id});await a.runPromise;}
  return {a,job,run,input,calls:()=>calls};
}

test('Unchanged repeated reads stop after three attempts and preserve the collected evidence',async t=>{
  const {a,job,run,calls}=await setup(t);await run();
  assert.equal(calls(),4);assert.equal(job.status,'ready');assert.equal(job.progressGuard.count,3);
  assert.equal(job.sourceIds.length,1);assert.equal(a.data.sources[0].content,'周五发布。');assert.match(job.summary,/自动纠偏/);
  assert.equal(job.executionState.workEfficiency.phase,'recovery_pending');assert.equal(a.data.decisions.length,0);
  assert.equal(a.data.agentRuns[0].status,'ready');assert.equal(a.data.agentRuns[0].steps.length,4);
});

test('No-progress detection survives round boundaries and app restart',async t=>{
  const {a,job,run}=await setup(t,{maxActions:1});await run();await run();await run();assert.equal(job.progressGuard.count,2);
  const restored=new Assistant({dir:a.dir,chat:async()=>structuredClone(read)});
  await restored.dispatch('agentRun',{id:job.id});await restored.runPromise;
  assert.equal(restored.data.delegations[0].status,'ready');assert.equal(restored.data.delegations[0].callsUsed,4);
});

test('Repeated unchanged planning cannot consume the whole budget',async t=>{
  const {a,job,run,calls}=await setup(t,{repeat:plan});await run();
  assert.equal(job.status,'ready');assert.equal(calls(),4);assert.equal(a.data.tasks.length,1);assert.equal(job.executionState.workEfficiency.phase,'recovery_pending');const strategy=require('../desktop/strategy-recovery.cjs');strategy.begin(a,job);assert.equal(strategy.next(a,job).tool,'advance_task');
  assert.equal(a.data.tasks[0].planVersion,1);assert.equal(a.data.tasks[0].planHistory.length,0);
});

test('New source content resets the signal even for the same read action',async t=>{
  const {a,job,run,input}=await setup(t,{maxActions:1});await run();await run();await run();
  fs.writeFileSync(path.join(input,'notes.md'),'改为周六发布。');await run();
  assert.equal(job.status,'ready');assert.equal(job.progressGuard,undefined);assert.equal(job.sourceIds.length,2);
  await run();await run();assert.equal(job.status,'ready');assert.equal(job.progressGuard.count,2);
  assert.equal(a.data.sources[0].content,'改为周六发布。');
});

test('External source updates between rounds reset stale comparison state',async t=>{
  const {a,job,run,input}=await setup(t,{maxActions:1});await run();await run();await run();
  fs.writeFileSync(path.join(input,'notes.md'),'最新消息：周六发布。');await agent.checkSources(a,job);
  await run();assert.equal(job.status,'ready');assert.equal(job.progressGuard.count,1);
});

test('Distinct page parameters and JSON key order are handled correctly',async t=>{
  const {job,run}=await setup(t,{maxActions:1,actions:[
    {tool:'list_sources',args:{start:0,limit:1}},
    {tool:'list_sources',args:{start:1,limit:1}},
    {tool:'list_sources',args:{start:2,limit:1}},
    {tool:'list_sources',args:{limit:1,start:2}},
    {tool:'list_sources',args:{start:2,limit:1}},
  ]});
  await run();await run();await run();assert.equal(job.status,'ready');assert.equal(job.progressGuard.count,1);
  await run();assert.equal(job.progressGuard.count,2);await run();assert.equal(job.status,'ready');
});

test('Repeated waits do not treat changing bookkeeping timestamps as progress',async t=>{
  const {a,job}=await setup(t);const result=await agent.act(a,job,read.tool,read.args);
  const step={tool:'wait',args:{key:'release',expected:'确认发布日期',reason:'等待确认',sourceIds:[result.sourceId]}};
  // First wait creates a real waiting condition. Later automatic planning returns the same condition.
  let before=efficiency.progress(a,job);await agent.act(a,job,step.tool,step.args);efficiency.checkProgress(a,job,step,before);
  assert.equal(job.progressGuard,undefined);
  for(let i=1;i<=3;i++){
    before=efficiency.progress(a,job);await agent.act(a,job,step.tool,step.args);
    job.nextRunAt=new Date(Date.now()+i*60000).toISOString();job.followups[0].checkedAt=new Date().toISOString();job.callsUsed++;
    if(i<3)efficiency.checkProgress(a,job,step,before);else assert.throws(()=>efficiency.checkProgress(a,job,step,before),/连续 3 次/);
  }
  assert.equal(job.followups[0].status,'waiting');assert.equal(job.followups[0].sourceIds[0],result.sourceId);
});

test('Failed identical tools are bounded and do not erase earlier evidence',async t=>{
  const {a,job,run}=await setup(t,{actions:[read],repeat:{tool:'read_file',args:{folderId:'input',name:'missing.md'}}});await run();
  assert.equal(job.status,'ready');assert.equal(job.callsUsed,4);assert.equal(job.sourceIds.length,1);
  assert.equal(a.data.agentRuns[0].steps.filter(s=>s.error).length,3);assert.equal(a.data.sources[0].content,'周五发布。');
});

test('Retries and pause preserve failed strategies; real user feedback establishes a new scope',async t=>{
  const {a,job,run}=await setup(t);await run();assert.equal(job.status,'ready');
  job.maxActions=1;await run();assert.equal(job.executionState.workEfficiency.phase,'recovery_pending');
  const tried=structuredClone(job.executionState.workEfficiency.tried);assert.ok(Object.keys(tried).length);
  await a.dispatch('agentPause',{id:job.id});assert.equal(job.status,'paused');await a.dispatch('agentResume',{id:job.id});
  assert.deepEqual(job.executionState.workEfficiency.tried,tried);
  await a.dispatch('agentFeedback',{id:job.id,note:'请增加周六的延期原因'});
  const work=require('../desktop/work-efficiency.cjs');assert.equal(work.before(a,job).allowed,true);assert.deepEqual(job.executionState.workEfficiency.tried,{});
});

test('Rewording a plan is not evidence of actual progress',async t=>{
  const {a,job}=await setup(t);await agent.act(a,job,plan.tool,plan.args);
  const before=efficiency.progress(a,job);const task=a.task(job.taskIds[0]);task.updatedAt='2099-01-01';job.history.push({at:'2099-01-01',tool:'plan_task'});job.callsUsed++;
  assert.equal(efficiency.progress(a,job),before);
  task.criteria='记录发布日期和负责人';assert.equal(efficiency.progress(a,job),before);job.feedback.push({text:'用户补充负责人要求'});assert.notEqual(efficiency.progress(a,job),before);
});
