const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs');
const plans=require('../desktop/agent-plan.cjs');
const paragraph='下周交接项目，请把下面的记录整理成一页说明：小林负责验收，周五发布，目前需要确认回滚联系人。';
const input=()=>({text:paragraph,requestId:crypto.randomUUID()});
function plan(ctx){const task=ctx.tasks[0];return {key:task.agentKey,existingTaskId:task.id,title:'整理项目交接说明',description:'项目计划周五发布，小林负责验收，回滚联系人尚待确认。',objective:'为下周交接准备一页可读说明。',criteria:'列出负责人、发布时间和回滚联系人缺口。',sourceIds:task.sourceIds,reason:'从用户原文提炼背景和目标',steps:[{title:'编写一页交接说明',kind:'draft',key:'write'}]};}
async function mock(_p,_k,messages,options){
 options?.onUsage?.({inputTokens:100,outputTokens:40,cachedInputTokens:20});
 const system=messages[0].content,ctx=JSON.parse(messages[1].content);
 if(system.includes('动作格式')){const task=ctx.tasks[0];return task.intake?.status==='pending'?{tool:'plan_task',args:plan(ctx)}:task.status==='review'?{tool:'complete',args:{summary:'交接稿已备好'}}:{tool:'advance_task',args:{taskId:task.id}};}
 if(system.includes('推进给定事项'))return {kind:'artifact',title:'项目交接说明',content:'# 项目交接\n- 验收负责人：小林\n- 发布：周五\n- 待确认：回滚联系人。'};
 return {passed:true,summary:'原文信息已覆盖，缺口已标注',gaps:[]};
}
async function fixture(t,{configured=true,chat=mock}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-intake-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});
 if(configured)await a.dispatch('saveProvider',{name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture',inputPrice:1,outputPrice:2,cachedInputPrice:0.1});
 return a;
}
test('one paragraph automatically becomes a structured task, progresses and awaits human acceptance',async t=>{
 const a=await fixture(t),p=input();const result=await a.dispatch('taskIntake',p);assert.equal(result.captureQueue[0].intakeRequestId,p.requestId);await a.runPromise;
 assert.equal(a.data.settings.automatic,false);assert.equal(a.data.tasks.length,1);assert.equal(a.data.delegations.length,1);
 a.tick();await a.runPromise;const task=a.data.tasks[0],job=a.data.delegations[0];
 assert.equal(task.intake.status,'organized',job.lastError);assert.equal(task.title,'整理项目交接说明');assert.match(task.description,/小林/);assert.match(task.objective,/一页/);
 assert.equal(task.status,'review',job.lastError);assert.equal(job.status,'review',job.lastError);assert.equal(a.data.artifacts.length,1);assert.equal(task.agentJobId,job.id);assert.equal(a.data.sources[0].content,paragraph);
 assert.equal(job.autoAccept,false);assert.equal(job.allowWeb,false);assert.deepEqual(job.folderIds,[]);assert.deepEqual(job.capabilityGrants,[]);assert.equal(job.fileMode,'off');
 assert.ok(a.data.modelCalls.length>=5);assert.ok(a.data.modelCalls.every(c=>c.jobId===job.id));assert.equal(Object.keys(a.spendLedger.scopes).filter(k=>k==='job:'+job.id).length,1);
});
test('missing role configuration never silently creates a manual task',async t=>{
 const a=await fixture(t,{configured:false});await assert.rejects(a.dispatch('taskIntake',input()),/模型/);assert.equal(a.data.tasks.length,0);assert.equal(a.data.captureQueue.length,0);
 await a.dispatch('createTask',{title:'明确选择手动创建',description:paragraph});assert.equal(a.data.tasks.length,1);assert.equal(a.data.delegations.length,0);
});
test('busy queue survives restart and identical request never creates a new job or budget',async t=>{
 let a=await fixture(t),p=input();a.operation={label:'busy'};await a.dispatch('taskIntake',p);await a.dispatch('taskIntake',p);assert.equal(a.data.captureQueue.length,1);
 a=new Assistant({dir:a.dir,chat:mock});a.tick();await a.runPromise;await a.dispatch('taskIntake',p);a.tick();await a.runPromise;
 assert.equal(a.data.tasks.length,1);assert.equal(a.data.delegations.length,1);assert.equal(a.data.tasks[0].status,'review');await assert.rejects(a.dispatch('taskIntake',{...p,text:paragraph+'新增要求'}),/变化/);
});
test('global pause persists the request and source is not lost when the model fails',async t=>{
 const a=await fixture(t,{chat:async()=>{throw Error('model offline');}});await a.dispatch('stewardshipPause');await a.dispatch('taskIntake',input());assert.equal(a.data.captureQueue[0].status,'queued');assert.equal(a.data.tasks.length,0);
 // Resume using the public action, without manually advancing a task or job.
 await a.dispatch('stewardshipResume');a.tick();await a.runPromise;a.tick();await a.runPromise;
 assert.equal(a.data.tasks.length,1);assert.equal(a.data.tasks[0].intake.status,'pending');assert.equal(a.data.sources[0].content,paragraph);assert.equal(a.data.delegations.length,1);assert.ok(a.data.delegations[0].lastError);
});
test('first plan must fill all fields, retain the original source and reuse the recorded task',async t=>{
 const a=await fixture(t);await a.dispatch('taskIntake',input());await a.runPromise;const job=a.data.delegations[0],args=plan({tasks:a.data.tasks});
 for(const bad of [{...args,objective:undefined},{...args,description:''},{...args,sourceIds:[],removeSourceIds:args.sourceIds,reason:'试图移除初始来源'},{...args,key:'new',existingTaskId:undefined}])assert.throws(()=>plans.planTask(a,job,bad));
 assert.equal(a.data.tasks.length,1);assert.equal(a.data.tasks[0].intake.status,'pending');plans.planTask(a,job,args);assert.equal(a.data.tasks[0].intake.status,'organized');
});
test('quick capture accepts only source material and infers omitted goal and criteria',async t=>{
 const a=await fixture(t);const p=require('../desktop/quick-capture.cjs').submissionInput({requestId:crypto.randomUUID(),textItems:[{title:'选中文字',content:paragraph}],advancement:{infer:true}});
 await a.dispatch('captureEnqueue',p.payload);await a.runPromise;a.tick();await a.runPromise;assert.equal(a.data.tasks[0].status,'review');assert.equal(a.data.tasks[0].intake.status,'organized');
});

async function mountedRepo(a){const root=path.join(a.dir,'repo');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'SKILL.md'),'# Testing skills\nUse the supplied material.');const preview=await a.dispatch('capabilityInspect',{kind:'repository',path:root,name:'测试仓库'});await a.dispatch('capabilitySave',{token:preview.token,allowedTools:preview.tools.map(t=>t.name)});return a.data.capabilities[0];}
test('intake selection grants only the chosen repository and survives a restart',async t=>{
 let a=await fixture(t);const c=await mountedRepo(a),p={...input(),capabilityIds:[c.id]};a.operation={label:'busy'};await a.dispatch('taskIntake',p);
 a=new Assistant({dir:a.dir,chat:mock});await a.dispatch('taskIntake',p);a.tick();await a.runPromise;
 assert.equal(a.data.captureQueue.length,1);assert.deepEqual(a.data.delegations[0].capabilityGrants,[{id:c.id,revision:c.revision}]);assert.equal(a.data.tasks.length,1);
 await assert.rejects(a.dispatch('taskIntake',{...p,capabilityIds:[]}),/变化/);
});
test('no selection never inherits a mounted repository and invalid selection never enters queue',async t=>{
 const a=await fixture(t);await mountedRepo(a);await a.dispatch('taskIntake',input());await a.runPromise;assert.deepEqual(a.data.delegations[0].capabilityGrants,[]);
 const count=a.data.captureQueue.length;await assert.rejects(a.dispatch('taskIntake',{...input(),capabilityIds:['missing']}),/不存在/);assert.equal(a.data.captureQueue.length,count);
});
test('queued intake stops if selected repository authorization changes',async t=>{
 const a=await fixture(t),c=await mountedRepo(a);a.operation={label:'busy'};await a.dispatch('taskIntake',{...input(),capabilityIds:[c.id]});a.operation=null;
 await a.dispatch('capabilityToggle',{id:c.id,enabled:false});a.tick();await a.runPromise;assert.equal(a.data.captureQueue[0].status,'failed');assert.equal(a.data.delegations.length,0);assert.equal(a.data.tasks.length,0);assert.equal(a.data.sources.length,1);
});
