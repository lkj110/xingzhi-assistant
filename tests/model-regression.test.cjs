const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {Assistant,modelChat}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const {blockedError}=require('../desktop/model-errors.cjs');

async function setup(t,chat) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-model-fix-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'test',baseUrl:'https://example.invalid/v1',model:'test',key:'PRIVATE_MODEL_KEY'});
  const output=path.join(dir,'output');fs.mkdirSync(output);a.data.agentSettings.outputFolder=output;
  const job=agent.buildJob(a,{goal:'写明星桥发布安排，保存到指定目录并跟进客户确认',useOutputFolder:true,fileMode:'auto',maxActions:12});
  a.data.delegations.push(job);
  const planned=await agent.act(a,job,'plan_task',{key:'report',title:'发布方案',criteria:'包含发布日期并保存',steps:[{key:'draft',title:'编写方案',kind:'draft'},{key:'save',title:'保存方案',kind:'external',tool:'write_file'}]});
  return {a,job,task:a.task(planned.taskId),output};
}

test('Execution receives the goal, configured destination and matching waits; receipts stay in verification context',async t=>{
  const inputs=[];
  const {a,job,task,output}=await setup(t,async(p,k,m)=>{inputs.push(JSON.parse(m[1].content));return m[0].content.includes('推进给定事项')?{kind:'artifact',content:'# 发布方案\n周五发布，客户确认待取得。'}:{passed:true,summary:'文件回读通过',gaps:[]};});
  job.feedback.push({text:'客户确认仍需跟进'});
  job.followups.push({key:'client',taskId:task.id,status:'resolved',expected:'客户回复',evidence:'已收到客户回复',sourceId:'reply'}, {key:'other',taskId:'different-task',status:'waiting'});
  task.planHistory.push({steps:[{evidence:'OLD_RECEIPT_INTERNAL'}]});
  await a.dispatch('advance',{id:task.id});await a.runPromise;
  assert.equal(inputs[0].delegation.output.folder,output);assert.equal(inputs[0].delegation.goal,job.goal);assert.deepEqual(inputs[0].delegation.userDirectives.map(r=>r.text),['客户确认仍需跟进']);
  assert.deepEqual(inputs[0].delegation.followups.map(f=>f.key),['client']);assert.equal(inputs[0].deliveryEvidence,undefined);assert.ok(!JSON.stringify(inputs[0]).includes('OLD_RECEIPT_INTERNAL'));
  const saved=await agent.act(a,job,'write_file',{taskId:task.id});
  await a.dispatch('advance',{id:task.id});await a.runPromise;
  const checked=inputs.at(-1);assert.equal(checked.deliveryEvidence[0].result.latestPath,saved.latestPath);assert.equal(checked.deliveryEvidence[0].current,true);assert.equal(checked.delegation.followups[0].status,'resolved');
  assert.ok(checked.task.steps[1].evidence.includes('verified'));assert.equal(task.status,'review');assert.equal(task.acceptedAt,undefined);assert.equal(job.callsUsed,2);
  assert.ok(!JSON.stringify(inputs).includes('PRIVATE_MODEL_KEY'));assert.ok(!JSON.stringify(a.context(task)).includes(saved.hash));
  await agent.act(a,job,'revise_task',{taskId:task.id,note:'调整日期'});
  assert.equal(a.context(task,{verification:true}).deliveryEvidence[0].current,false);
});

test('Invalid planning criteria fail atomically with the expected parameter type',async t=>{
  const {a,job}=await setup(t,async()=>({}));const before=JSON.stringify(a.data.tasks);
  await assert.rejects(agent.act(a,job,'plan_task',{key:'report',title:'变更',criteria:['标准'],steps:[{title:'生成',kind:'draft'}]}),/完成标准必须.*字符串.*不能是数组/);
  assert.equal(JSON.stringify(a.data.tasks),before);
});

for(const stage of ['planner','draft','verification','overall'])test(`A service block in ${stage} stops the delegation immediately and survives restart`,async t=>{
  let calls=0;const {a,job,task}=await setup(t,async(p,k,m)=>{
    calls++;const planning=m[0].content.includes('动作格式');
    if(stage==='planner'||!planning)throw new Error('This content was flagged for possible cybersecurity risk.');
    return {tool:stage==='overall'?'complete':'advance_task',args:{taskId:task.id}};
  });
  if(['verification','overall'].includes(stage)){
    const artifact={id:'draft-1',taskId:task.id,stepId:task.steps[0].id,title:'方案',content:'周五发布',createdAt:new Date().toISOString()};a.data.artifacts.push(artifact);Object.assign(task.steps[0],{done:true,artifactId:artifact.id});
    await agent.act(a,job,'write_file',{taskId:task.id});
    if(stage==='overall'){task.status='review';task.verification={passed:true,summary:'事项已通过检查',gaps:[],basis:require('../desktop/acceptance.cjs').basis(a,task)};}
  }
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;
  assert.equal(job.status,'blocked');assert.equal(job.nextRunAt,null);assert.equal(calls,stage==='draft'?2:1);assert.match(job.lastError,/模型服务拦截/);
  assert.equal(agent.tick(a),false);assert.equal(a.data.agentRuns[0].status,'blocked');
  const restored=new Assistant({dir:a.dir});assert.equal(restored.data.delegations[0].status,'blocked');assert.equal(agent.tick(restored),false);assert.equal(restored.publicState().agentDigest.attention[0].status,'blocked');
  if(['verification','overall'].includes(stage))assert.equal(fs.readFileSync(a.data.agentActions[0].result.latestPath,'utf8'),'周五发布');
});

test('Manual task advancement cannot leave its delegation scheduled after a blocked model request',async t=>{
  const {a,job,task}=await setup(t,async()=>{throw blockedError();});
  await a.dispatch('advance',{id:task.id});await a.runPromise;
  assert.equal(task.status,'blocked');assert.equal(job.status,'blocked');assert.equal(agent.tick(a),false);assert.equal(a.activeAgentJob,undefined);
});

test('Transient draft failures stop the current run and exhaust bounded retries without extra planner calls',async t=>{
  let calls=0;const {a,job,task}=await setup(t,async(p,k,m)=>{calls++;if(m[0].content.includes('动作格式'))return {tool:'advance_task',args:{taskId:task.id}};throw new Error('temporary model outage');});
  for(let i=0;i<3;i++){await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,i<2?'retry':'blocked');}
  assert.equal(calls,6);assert.equal(job.failures,3);assert.equal(a.data.artifacts.length,0);
});

test('Provider refusal shapes are classified without exposing raw provider text; normal and transient responses still work',async t=>{
  let answer;const server=http.createServer((req,res)=>{res.writeHead(answer.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(answer.body));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const config={type:'openai',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture'};
  for(const value of [
    {body:{choices:[{message:{refusal:'PRIVATE_PROVIDER_TEXT',content:null}}]}},
    {body:{choices:[{finish_reason:'content_filter',message:{content:'PRIVATE_PROVIDER_TEXT'}}]}},
    {status:400,body:{error:{code:'content_policy_violation',message:'PRIVATE_PROVIDER_TEXT'}}},
    {status:403,body:{error:{code:'content_filter',message:'PRIVATE_PROVIDER_TEXT'}}}
  ]){answer=value;await assert.rejects(modelChat(config,'',[]),e=>e.code==='MODEL_BLOCKED'&&e.automaticRetry===false&&!e.message.includes('PRIVATE_PROVIDER_TEXT'));}
  for(const status of [401,403,404]){answer={status,body:{error:{message:'PRIVATE_PROVIDER_TEXT'}}};await assert.rejects(modelChat(config,'',[]),e=>e.automaticRetry===false&&e.message.includes(String(status))&&!e.message.includes('PRIVATE_PROVIDER_TEXT'));}
  answer={status:503,body:{error:{message:'PRIVATE_PROVIDER_TEXT'}}};await assert.rejects(modelChat(config,'',[]),e=>e.automaticRetry===true);
  answer={body:{choices:[{message:{content:'{"ok":true}',refusal:null},finish_reason:'stop'}]}};assert.deepEqual(await modelChat(config,'',[]),{ok:true});
});
