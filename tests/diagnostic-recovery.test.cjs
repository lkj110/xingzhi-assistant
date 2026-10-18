const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),plan=require('../desktop/agent-plan.cjs'),strategy=require('../desktop/strategy-recovery.cjs'),work=require('../desktop/work-efficiency.cjs'),control=require('../desktop/execution-control.cjs'),efficiency=require('../desktop/efficiency.cjs'),outputs=require('../desktop/deliverables.cjs');
const deny=async()=>{throw Error('Unexpected real model/network');};
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-diagnostics-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat:deny,connectorRequest:deny,webRequest:deny});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',type:'openai',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const job=agent.buildJob(a,{goal:'核实订单并交付报告',autoAccept:false,...options});a.data.delegations.push(job);
 const task=a.createTask({title:'订单报告',criteria:'有真实来源和正确主稿',steps:[{key:'draft',title:'生成报告',kind:'draft'},{key:'deliver',title:'保存文件',kind:'external',tool:'write_file'}]});
 task.steps[0].key='draft';Object.assign(task.steps[1],{key:'deliver',tool:'write_file'});
 task.agentJobId=job.id;task.agentKey='report';job.taskIds=[task.id];
 const source=agent.source(a,job,'initial','初始信息','订单于周五发布');task.sourceIds=[source.id];require('../desktop/protocol-access.cjs').retain(a,'source',source,{task,job});return {a,job,task,source,dir};
}
function artifact(f,id,step=f.task.steps[0]){const r={id,taskId:f.task.id,stepId:step.id,title:id,content:'订单正文 '+id};f.a.data.artifacts.push(r);Object.assign(step,{done:true,artifactId:id});require('../desktop/protocol-access.cjs').retain(f.a,'artifact',r,{task:f.task,job:f.job});return r;}
function args(f,extra={}){return {key:'report',existingTaskId:f.task.id,title:f.task.title,criteria:f.task.criteria,reason:'按检查缺口调整',steps:f.task.steps.map(s=>({...s})),...extra};}
function recovering(f){work.before(f.a,f.job);const state=f.job.executionState.workEfficiency;state.phase='recovering';state.active={id:'replan',title:'重新诊断',basis:strategy.inputBasis(f.a,f.job),queue:[],planning:true};return state;}
test('failed verification diagnostics persist before an efficiency yield, including historical artifact references',t=>{
 const f=fixture(t),main=artifact(f,'main');artifact(f,'aux');
 t.mock.method(work,'observe',()=>({allowed:false,phase:'recovery_pending'}));
 const check={passed:false,summary:'需补证',gaps:['主稿错绑且缺真实映射'],gapDetails:[{requirementId:'goal',text:'主稿错绑且缺真实映射',kind:'binding',artifactId:main.id,sourceIds:[main.id,f.source.id]}]};
 efficiency.checkProgress(f.a,f.job,{tool:'verify_content',args:{taskId:f.task.id},result:{verification:check}},'before');f.a.save();
 const reopened=new Assistant({dir:f.dir,chat:deny}),job=reopened.data.delegations.find(j=>j.id===f.job.id),gap=job.executionState.gaps[0];
 assert.equal(gap.requirementId,'task:'+f.task.id);assert.equal(gap.artifactId,'main');assert.deepEqual(gap.artifactRefs,['main']);assert.deepEqual(gap.evidenceRefs,[f.source.id]);assert.equal(gap.kind,'binding');assert.equal(gap.count,1);
});
test('compact planner context retains failed checks and explicit main binding',t=>{
 const f=fixture(t);artifact(f,'main');outputs.bind(f.a,f.task,'main');artifact(f,'aux');
 f.task.contentVerification={passed:false,summary:'需补证',gaps:['缺目标映射'],gapDetails:[{text:'缺目标映射',kind:'evidence',artifactId:'main'}]};
 f.task.evidenceRequest={kind:'needs_evidence',summary:'查询目标',gaps:['缺目标映射'],basis:'current'};
 const c=agent.context(f.a,f.job),task=c.tasks[0];assert.deepEqual(task.contentVerification,f.task.contentVerification);assert.deepEqual(task.evidenceRequest,f.task.evidenceRequest);assert.equal(task.primaryArtifactId,'main');assert.ok(task.artifacts.some(r=>r.id==='main'));assert.ok(!task.artifactHistory.some(r=>r.id==='main'));
});
test('plan validation failure never enqueues generation and external stages cannot be advanced as waiting',async t=>{
 const f=fixture(t);artifact(f,'main');const state=recovering(f),response={tool:'plan_task',args:args(f,{resetSteps:['nonexistent']})};
 strategy.acceptPlan(f.a,f.job,response);assert.deepEqual(state.active.queue,[]);
 try{await agent.act(f.a,f.job,response.tool,response.args);assert.fail('must reject');}catch(e){response.error=e.message;strategy.settled(f.a,f.job,response);}
 assert.deepEqual(state.active.queue,[]);assert.equal(strategy.next(f.a,f.job),null);
 await assert.rejects(agent.act(f.a,f.job,'advance_task',{taskId:f.task.id}),e=>e.code==='EXTERNAL_TOOL_REQUIRED');assert.notEqual(f.task.status,'waiting');
});
test('successful plan schedules only current text; current external step returns to planner',async t=>{
 for(const external of [false,true]){const f=fixture(t);if(external)artifact(f,'main');const state=recovering(f),step={tool:'plan_task',args:args(f)};
 strategy.acceptPlan(f.a,f.job,step);assert.equal(state.active.queue.length,0);step.result=await agent.act(f.a,f.job,step.tool,step.args);strategy.settled(f.a,f.job,step);
 assert.equal(state.active.queue.length,external?0:1);assert.equal(state.active.planning,external);}
});
test('binding a historical main and supporting role survives a same-plan repeat and failed foreign binding',t=>{
 const f=fixture(t);artifact(f,'main');artifact(f,'aux');
 const input=args(f,{primaryArtifactId:'main',steps:f.task.steps.map((s,i)=>i?{...s}:{...s,outputRole:'supporting'}),resetSteps:['draft']});plan.planTask(f.a,f.job,input);
 assert.equal(outputs.primary(f.a,f.task).id,'main');assert.equal(f.task.steps[0].outputRole,'supporting');const version=f.task.planVersion;
 assert.equal(plan.planTask(f.a,f.job,input).planVersion,version);assert.equal(f.task.planVersion,version);
 assert.throws(()=>plan.planTask(f.a,f.job,{...input,primaryArtifactId:'foreign'}));assert.equal(outputs.primary(f.a,f.task).id,'main');assert.equal(f.task.planVersion,version);
});
test('legacy draft converted to supporting preserves its prior primary even before generation',t=>{
 const f=fixture(t);artifact(f,'main');plan.planTask(f.a,f.job,args(f,{steps:f.task.steps.map((s,i)=>i?{...s}:{...s,outputRole:'supporting'})}));assert.equal(outputs.primary(f.a,f.task).id,'main');
});
test('new content diagnosis permits exactly one reset; identical checks and timestamps cannot renew it',t=>{
 const f=fixture(t);artifact(f,'main');const input=args(f,{resetSteps:['draft']}),reset=()=>plan.planTask(f.a,f.job,input),first=reset();assert.deepEqual(reset(),first);
 assert.throws(()=>plan.planTask(f.a,f.job,{...input,reason:'另一条重复调整命令'}),e=>e.code==='PLAN_ALREADY_RECONCILED');
 const check={passed:false,basis:'new-check',gaps:['需补消费者'],at:'first'};f.task.contentVerification=check;const second=reset();assert.equal(second.planVersion,first.planVersion+1);assert.equal(f.task.contentVerification,null);
 f.task.contentVerification={...check,at:'second'};assert.deepEqual(reset(),second);
});
test('evidence or binding diagnoses route to planner before rewriting or generic frontier queries',t=>{
 const f=fixture(t);artifact(f,'main');f.task.contentVerification={passed:false,gaps:['缺消费者'],gapDetails:[{text:'缺消费者',kind:'evidence',artifactId:'main'}]};
 assert.equal(control.next(f.a,f.job),null);const c=strategy.candidates(f.a,f.job);assert.equal(c.length,1);assert.equal(c[0].planning,true);assert.deepEqual(c[0].queue,[]);
 const before=strategy.inputBasis(f.a,f.job);f.task.contentVerification.at='changed';assert.equal(strategy.inputBasis(f.a,f.job),before);
});
test('worker evidence request blocks repeat generation and clears only after explicit current evidence resolution',async t=>{
 const f=fixture(t),request=require('../desktop/evidence-request.cjs');f.task.evidenceRequest=request.normalize(f.a,f.task,{kind:'needs_evidence',summary:'查询消费者',gaps:['缺消费者']},'request-basis');
 await assert.rejects(agent.act(f.a,f.job,'advance_task',{taskId:f.task.id}),e=>e.code==='EVIDENCE_REQUIRED');
 const resolve={basis:'request-basis',sourceIds:[f.source.id],reason:'查到消费者'};assert.throws(()=>plan.planTask(f.a,f.job,args(f,{evidenceResolution:resolve})),/尚无新依据/);assert.ok(f.task.evidenceRequest);
 const fresh=agent.source(f.a,f.job,'consumer','消费者','消费者为系统A');plan.planTask(f.a,f.job,args(f,{sourceIds:[fresh.id],evidenceResolution:{...resolve,sourceIds:[fresh.id]}}));
 assert.equal(f.task.evidenceRequest,undefined);assert.deepEqual(f.task.lastEvidenceResolution.sourceIds,[fresh.id]);assert.ok(f.task.sourceIds.includes(fresh.id));assert.equal(f.a.data.decisions.length,0);
});
test('a needs_replan request can resolve through an actual primary binding change without pretending new facts',t=>{
 const f=fixture(t);artifact(f,'main');artifact(f,'aux');f.task.evidenceRequest=require('../desktop/evidence-request.cjs').normalize(f.a,f.task,{kind:'needs_replan',summary:'选回业务主稿',gaps:['辅助稿错绑']},'binding-request');
 plan.planTask(f.a,f.job,args(f,{primaryArtifactId:'main',evidenceResolution:{basis:'binding-request',reason:'将已有业务稿绑定为主稿'}}));assert.equal(f.task.evidenceRequest,undefined);assert.equal(outputs.primary(f.a,f.task).id,'main');
});
test('real Agent loop hands off missing evidence, executes an authorized query, associates it, then generates once',async t=>{
 const f=fixture(t,{dataPlatform:'sg-readonly'});f.task.steps.pop();f.task.generationMode='single';f.job.maxActions=12;
 require('./helpers/platform-fixture.cjs').install(f.a);let queries=0,workers=0,planners=0;
 f.a.platformRequest=async()=>{queries++;return {taskId:123,owner:'fixture',consumer:'系统A'};};
 f.a.chat=async(p,k,m,o)=>{
  o.onUsage({inputTokens:10,outputTokens:5});
  if(m[0].content.includes('动作格式')){
   planners++;
   if(planners===1)return {tool:'advance_task',args:{taskId:f.task.id}};
   if(planners===2){assert.ok(f.task.evidenceRequest);return {tool:'platform_query',args:{queries:[{op:'task',taskId:123}]}};}
   if(planners===3){const source=f.a.data.sources.find(s=>s.platformSnapshot);return {tool:'plan_task',args:args(f,{sourceIds:[source.id],evidenceResolution:{basis:f.task.evidenceRequest.basis,sourceIds:[source.id],reason:'已取得实际消费者详情'}})};}
   return {tool:'advance_task',args:{taskId:f.task.id}};
  }
  if(o.role==='verify')return {passed:true,summary:'实际来源支持当前正文',gaps:[]};
  workers++;return workers===1?{kind:'needs_evidence',summary:'取得实际消费者详情',gaps:['消费者未核实']}:{kind:'artifact',title:'订单报告',content:'订单于周五发布，消费者为系统A。',summary:'已按实际来源完成'};
 };
 await agent.run(f.a,f.job.id);
 assert.equal(queries,1,JSON.stringify({planners,workers,status:f.job.status,error:f.job.lastError,steps:f.a.data.agentRuns[0]?.steps}));assert.equal(workers,2);assert.equal(f.task.evidenceRequest,undefined);assert.equal(f.task.status,'review');assert.equal(f.job.status,'review');
 assert.equal(f.a.data.artifacts.length,1);assert.equal(f.a.data.decisions.length,0);assert.ok(f.a.data.agentRuns[0].steps.some(s=>s.tool==='platform_query'));assert.match(outputs.primary(f.a,f.task).content,/系统A/);
});
test('revoked or ambiguous artifacts cannot be selected through explicit IDs or legacy draft fallback',async t=>{
 const f=fixture(t),r=artifact(f,'main'),policies=require('../desktop/access-policy-store.cjs');
 f.job.outputFolder=path.join(f.dir,'output');fs.mkdirSync(f.job.outputFolder);f.job.fileMode='ask';policies.syncTrustedJob(f.a,f.job,{trusted:true,actor:'user_command',command:'fixture_output'});
 policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:main',jobId:f.job.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture_revoke'});
 assert.equal(outputs.primary(f.a,f.task),null);assert.deepEqual(outputs.current(f.a,f.task),[]);assert.throws(()=>outputs.select(f.a,f.task,'main'));
 await assert.rejects(require('../desktop/agent-writes.cjs').prepare(f.a,f.job,'write_file',{taskId:f.task.id,artifactId:'main',filename:'support.md'}));assert.equal(f.a.data.agentActions.length,0);
 f.task.primaryArtifactId=r.id;assert.equal(outputs.primary(f.a,f.task),null);assert.throws(()=>outputs.select(f.a,f.task,'main'));
});
test('binding application failure rolls back the whole plan and live task references',t=>{
 const f=fixture(t);artifact(f,'main');const before=JSON.stringify(f.task),original=outputs.bind;let binds=0;
 t.mock.method(outputs,'bind',(...args)=>{if(++binds===2)throw Error('fixture binding apply failure');return original(...args);});
 assert.throws(()=>plan.planTask(f.a,f.job,args(f,{title:'changed',steps:f.task.steps.map((s,i)=>i?{...s}:{...s,outputRole:'supporting'})})),/fixture binding/);
 assert.equal(JSON.stringify(f.task),before);assert.equal(f.a.task(f.task.id),f.task);f.a.save();assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(f.a.file)).tasks.find(t=>t.id===f.task.id)),before);
});
test('removing an unchanged source does not satisfy an evidence request or journal a partial withdrawal',t=>{
 const f=fixture(t),old=agent.source(f.a,f.job,'second','旧来源','旧事实');plan.planTask(f.a,f.job,args(f,{sourceIds:[old.id]}));
 f.task.evidenceRequest=require('../desktop/evidence-request.cjs').normalize(f.a,f.task,{kind:'needs_evidence',summary:'需要新事实',gaps:['仍缺消费者']},'current-request');const before=JSON.stringify(f.task);
 assert.throws(()=>plan.planTask(f.a,f.job,args(f,{removeSourceIds:[old.id],evidenceResolution:{basis:'current-request',sourceIds:[f.source.id],reason:'保留原事实'}})),/尚无新依据/);
 assert.equal(JSON.stringify(f.task),before);assert.ok(f.task.sourceIds.includes(old.id));
});
test('plan input preflight reports source/artifact confusion and external-only field errors together without mutation',t=>{
 const f=fixture(t);artifact(f,'main');const before=JSON.stringify(f.task);
 for(const sourceIds of [['main'],['main','main'],'main'])assert.throws(()=>plan.planTask(f.a,f.job,args(f,{sourceIds,primaryArtifactId:'main',steps:f.task.steps.map(s=>({...s,outputRole:'primary',targetArtifactId:'main'}))})),e=>{
  assert.equal(e.code,'PLAN_INPUT_INVALID');assert.equal(e.planInputInvalid,true);assert.equal(e.issues.length,2);assert.match(e.message,/sourceIds/);assert.match(e.message,/steps\[1\]/);return true;
 });
 assert.equal(JSON.stringify(f.task),before);assert.equal(f.task.primaryArtifactId,undefined);
});
for(const duplicate of [false,true])test(`a recovery plan argument failure returns to planner and proceeds only after a corrected commit (duplicate=${duplicate})`,async t=>{
 const f=fixture(t);f.task.steps.pop();f.task.generationMode='single';f.task.needsReplan='用户补充了要求';f.job.maxActions=8;recovering(f);
 let planners=0,workers=0;
 f.a.chat=async(p,k,m,o)=>{
  o.onUsage({inputTokens:10,outputTokens:5});
  if(m[0].content.includes('动作格式')){
   planners++;
   if(planners===1)return {tool:'plan_task',args:args(f,{sourceIds:duplicate?['artifact-mixed-into-sources','artifact-mixed-into-sources']:['artifact-mixed-into-sources']})};
   if(planners===2){assert.equal(work.view(f.a,f.job).phase,'recovering');assert.equal(f.task.needsReplan,'用户补充了要求');assert.equal(work.view(f.a,f.job).strategy.instruction.includes('sourceIds'),true);return {tool:'plan_task',args:args(f,{sourceIds:[f.source.id]})};}
   return {tool:'advance_task',args:{taskId:f.task.id}};
  }
  if(o.role==='verify')return {passed:true,summary:'实际材料支持正文',gaps:[]};
  workers++;return {kind:'artifact',title:'订单报告',content:'订单于周五发布。',summary:'完成报告'};
 };
 await agent.run(f.a,f.job.id);
 const steps=f.a.data.agentRuns[0].steps;
 assert.equal(steps[0].errorCode,'PLAN_INPUT_INVALID');assert.equal(steps[1].tool,'plan_task');assert.ok(steps[1].result);assert.equal(steps[2].tool,'advance_task');
 assert.equal(workers,1);assert.equal(f.task.status,'review');assert.equal(f.a.data.decisions.length,0);assert.equal(f.task.needsReplan,null);
});
test('plan correction allowance is bounded and never applies to access or uncertain-write failures',t=>{
 const f=fixture(t),state=recovering(f);
 for(let i=0;i<3;i++){
  const step={tool:'plan_task',args:{existingTaskId:f.task.id},error:'invalid sourceIds',errorCode:'PLAN_INPUT_INVALID'};
  strategy.settled(f.a,f.job,step,{planInputInvalid:true});assert.deepEqual(state.active.queue,[]);assert.equal(state.active.planning,i<2);
  if(i<2){assert.equal(work.observe(f.a,f.job,step).phase,'recovering');assert.equal(state.active.inputCorrections,i+1);}
  else assert.equal(work.observe(f.a,f.job,step).phase,'recovery_pending');
 }
 for(const step of [{tool:'plan_task',error:'access denied',errorCode:'AUTH_REQUIRED'},{tool:'lark_update',error:'unknown side effect',errorCode:'PLAN_INPUT_INVALID'}]){
  const s=recovering(f);strategy.settled(f.a,f.job,step,{planInputInvalid:true});assert.equal(s.active.planning,false);assert.deepEqual(s.active.queue,[]);
 }
});
test('a pending user plan change is diagnosed before generic boundary exploration',t=>{
 const f=fixture(t,{dataPlatform:'sg-readonly'});f.task.needsReplan='用户已给出具体参数修正';
 const c=strategy.candidates(f.a,f.job);assert.equal(c.length,1);assert.equal(c[0].id,'diagnose:'+f.task.id);assert.equal(c[0].planning,true);assert.deepEqual(c[0].queue,[]);
});
