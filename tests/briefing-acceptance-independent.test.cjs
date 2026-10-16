const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const acceptance=require('../desktop/acceptance.cjs');
const briefing=require('../desktop/briefing.cjs');
function setup(t,chat=()=>{throw Error('unexpected model call');}) {const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-independent-acceptance-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Assistant({dir,chat});}
function review(a,title='验收文稿') {
  const task=a.createTask({title,criteria:'文稿内容完整',steps:[{title:'编写文稿',kind:'draft'}]});
  task.status='review';task.verification={passed:true,summary:'内容完整',gaps:[],at:new Date().toISOString()};
  const artifact={id:`v-${task.id}`,taskId:task.id,stepId:task.steps[0].id,title,content:'完整文稿内容',createdAt:new Date().toISOString()};a.data.artifacts.push(artifact);Object.assign(task.steps[0],{done:true,artifactId:artifact.id});return task;
}
function attach(a,tasks) {const job={id:'review-job',goal:'交付完整文稿',title:'本周交付',projectId:null,taskIds:tasks.map(t=>t.id),sourceIds:[],feedback:[],followups:[],status:'review',fileMode:'off'};for(const task of tasks)task.agentJobId=job.id;a.data.delegations.push(job);return job;}
function selection(a,tasks){const items=acceptance.snapshot(a).items;return {items:tasks.map(t=>({id:t.id,revision:items.find(v=>v.id===t.id).revision}))};}

test('Independent audit: actual core advance records a stable basis and manual acceptance changes no model usage',async t=>{
  let calls=0;const a=setup(t,async(_provider,_key,messages)=>{calls++;return messages[0].content.includes('推进给定事项')?{kind:'artifact',title:'验收文稿',content:'完整可用的文稿',summary:'文稿完成'}:{passed:true,summary:'标准全部满足',gaps:[]};});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture'});a.data.settings.autoComplete=false;
  const task=a.createTask({title:'实际推进测试',criteria:'有完整正文',steps:[{title:'生成正文',kind:'draft'}]});await a.advance(task.id);
  assert.equal(task.status,'review');assert.ok(task.verification.basis);assert.equal(task.verification.basis,acceptance.basis(a,task));assert.equal(acceptance.snapshot(a).counts.ready,1);
  await a.dispatch('acceptanceAccept',selection(a,[task]));assert.equal(task.status,'completed');assert.equal(calls,2);assert.equal(briefing.snapshot(a).completionCounts.checked,1);
});
test('Independent audit: real Agent plan and file readback produce an acceptable review and truthful briefing',async t=>{
  let calls=0;const actions=[
    ()=>({tool:'plan_task',args:{key:'delivery',title:'交付演示文稿',criteria:'生成完整正文并保存到授权目录',steps:[{title:'编写正文',kind:'draft'},{title:'保存正文',kind:'external',tool:'write_file'}]}}),
    ctx=>({tool:'advance_task',args:{taskId:ctx.tasks[0].id}}),
    ctx=>({tool:'write_file',args:{taskId:ctx.tasks[0].id}}),
    ctx=>({tool:'advance_task',args:{taskId:ctx.tasks[0].id}}),
    ()=>({tool:'complete',args:{summary:'文件已交付，等待人工验收'}})
  ];
  const a=setup(t,async(_provider,_key,messages)=>{
    calls++;const prompt=messages[0].content,ctx=JSON.parse(messages[1].content);
    if(prompt.includes('动作格式')){assert.ok(actions.length,'scripted actions exhausted');return actions.shift()(ctx);}
    return prompt.includes('推进给定事项')?{kind:'artifact',title:'演示文稿',content:'# 演示\n完整可用的正文。',summary:'已生成正文'}:{passed:true,summary:'内容与保存结果完整',gaps:[]};
  });
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture'});const output=path.join(a.dir,'out');fs.mkdirSync(output);a.data.agentSettings.outputFolder=output;
  await a.dispatch('agentCreate',{goal:'生成演示文稿并保存到授权目录，交付之后等待我验收。',useOutputFolder:true,fileMode:'auto',autoAccept:false,allowWeb:false,maxActions:12,maxCalls:40});await a.runPromise;
  const task=a.data.tasks[0],job=a.data.delegations[0];assert.equal(task.status,'review',JSON.stringify({status:job.status,error:job.lastError,history:job.history}));assert.equal(job.status,'review');assert.equal(a.data.agentActions[0].result.verified,true);assert.equal(acceptance.snapshot(a).counts.ready,1);assert.equal(task.verification.basis,acceptance.basis(a,task));
  const before=briefing.snapshot(a);assert.equal(before.counts.deliveries,1);assert.equal(before.counts.completions,0);assert.equal(before.counts.drafts,1);
  const used=calls;await a.dispatch('acceptanceAccept',selection(a,[task]));assert.equal(calls,used);assert.equal(task.status,'completed');assert.equal(job.status,'completed');assert.equal(briefing.snapshot(a).completionCounts.checked,1);assert.ok(fs.readdirSync(output).some(name=>name.endsWith('.md')));
});
test('Independent audit: new job feedback and task notes reject stale verification before user opens center',t=>{
  for(const change of [(task,job)=>job.feedback.push({at:new Date().toISOString(),text:'新增目标'}),(task)=>task.notes.push({at:new Date().toISOString(),text:'更改口径'})]) {
    const a=setup(t),task=review(a),job=attach(a,[task]);task.verification.basis=acceptance.basis(a,task);change(task,job);
    const before=JSON.stringify(a.data);assert.ok(acceptance.snapshot(a).items[0].reasons.some(r=>r.code==='changed'));assert.throws(()=>acceptance.acceptOne(a,{id:task.id}),/变化/);assert.equal(JSON.stringify(a.data),before);
  }
});
test('Independent audit: batch fails atomically after a sibling artifact disappears, even with fresh selections',t=>{
  const a=setup(t),one=review(a,'一'),two=review(a,'二');a.data.artifacts=a.data.artifacts.filter(v=>v.taskId!==two.id);const input=selection(a,[one,two]),before=JSON.stringify(a.data);
  assert.throws(()=>acceptance.accept(a,input),/产出/);assert.equal(JSON.stringify(a.data),before);
});
test('Independent audit: missing verified flag on a structured external receipt cannot be accepted',t=>{
  const a=setup(t),task=review(a);task.steps.push({id:'outside',kind:'external',tool:'write_file',done:true,evidence:'{"actionId":"receipt"}'});
  a.data.agentActions.push({id:'receipt',taskId:task.id,status:'done',tool:'write_file',result:{path:'/tmp/report.md'}});
  assert.ok(acceptance.reasons(a,task).some(r=>r.code==='receipt'));assert.throws(()=>acceptance.acceptOne(a,{id:task.id}),/回执/);
});
test('Independent audit: explicit null scope is invalid and cannot silently expand acceptance to all projects',t=>{
  const a=setup(t);review(a);assert.throws(()=>acceptance.snapshot(a,{projectId:null}));assert.throws(()=>acceptance.accept(a,{projectId:null,items:[]}));
});
test('Independent audit: a foreign source is unavailable evidence and must not expose its title in scoped preview',t=>{
  const a=setup(t),task=review(a);a.data.projects.push({id:'p',name:'项目一'},{id:'q',name:'项目二'});task.projectId='p';task.sourceIds=['foreign'];a.data.sources.push({id:'foreign',projectId:'q',title:'FOREIGN_SECRET_TITLE',content:'other project'});
  const result=acceptance.snapshot(a,{projectId:'p'});assert.equal(result.items[0].ready,false);assert.ok(!JSON.stringify(result).includes('FOREIGN_SECRET_TITLE'));assert.throws(()=>acceptance.acceptOne(a,{id:task.id}));
});
test('Independent audit: previously completed dependency lacking its artifact is not valid prerequisite evidence',t=>{
  const a=setup(t),dep=review(a,'前置'),task=review(a,'后续');dep.status='completed';task.dependsOn=[dep.id];a.data.artifacts=a.data.artifacts.filter(v=>v.taskId!==dep.id);
  assert.ok(acceptance.reasons(a,task).some(r=>r.code==='dependency'));assert.throws(()=>acceptance.acceptOne(a,{id:task.id}),/前置/);
});
test('Independent audit: completion briefing detects accepted output changing after its verified basis',t=>{
  const a=setup(t),task=review(a);task.verification.basis=acceptance.basis(a,task);acceptance.acceptOne(a,{id:task.id});assert.equal(briefing.snapshot(a).completionCounts.checked,1);
  a.data.artifacts[0].content='被改写的内容';const r=briefing.snapshot(a);assert.equal(r.completionCounts.checked,0);assert.equal(r.completionCounts.unverified,1);assert.equal(r.counts.drafts,1);
});
test('Independent audit: committed legacy acceptance remains accepted when workspace projection fails',async t=>{
  const a=setup(t),task=review(a),before=JSON.stringify(a.data);a.save=()=>{throw Error('simulated disk failure');};
  await assert.rejects(a.dispatch('taskAction',{id:task.id,command:'accept'}),e=>/disk failure/.test(e.message)&&e.committed);assert.notEqual(JSON.stringify(a.data),before);assert.equal(task.status,'completed');assert.ok(task.projectionPending);assert.equal(require('../desktop/work-journal.cjs').read(a).events.filter(e=>e.type==='accepted').length,1);
});
