'use strict';
// Real application/read/verification pipelines with controlled model transport.
// These are development fixtures, never evidence of real-model decision quality.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),input=require('../desktop/model-input.cjs'),ground=require('../desktop/grounding.cjs'),tool=require('../desktop/tool-evidence.cjs');
const scenarios=[
 ['sum','批甲 0.15 kg；批乙 0.35 kg。',['0.15','0.35'],'kg',{unit:'kg'},'0.50'],
 ['ratio','完成 21 件；总量 28 件。',['21','28'],'件',{scale:2,rounding:'half_even'},'0.75'],
 ['convert_unit','重量 1.25 kg。',['1.25'],'kg',{to:'g',scale:0,rounding:'half_even'},'1250'],
 ['date_days','开始 2028-02-28；结束 2028-03-01。',['2028-02-28','2028-03-01'],null,{},'2'],
 ['elapsed','开始 2024-03-10T01:30:00-05:00；结束 2024-03-10T03:30:00-04:00。',['2024-03-10T01:30:00-05:00','2024-03-10T03:30:00-04:00'],null,{timeZone:'America/New_York',unit:'h'},'1.000000'],
 ['timezone','时刻 2028-01-01T00:00:00Z。',['2028-01-01T00:00:00Z'],null,{timeZone:'UTC'},'2028-01-01'],
 ['count','名称,数量\n甲,12\n乙,7',[],null,{format:'csv'},'2'],
];
const {fixture,review}=require('./helpers/evidence-workflow.cjs');
for(const [operation,body,values,unit,args,expected] of scenarios)test('C actual '+operation+' request, replayable receipt and final independent audit',async t=>{
 let task,source,request;
 const f=await fixture(t,({a,context,role})=>{
  const receipt=context.toolEvidence?.find(r=>r.operation===operation);
  if(role==='execute')return receipt?{kind:'artifact',title:'求证结果',content:'工具结果：'+receipt.output.value+' '+receipt.output.unit}:{kind:'read_context',requests:[request]};
  assert.ok(receipt,'verifier must see the actual receipt');const artifact=context.artifacts[0];
  return review(a,task,context,[{id:'c',artifactId:artifact.id,field:'content',text:artifact.content,kind:'fact',supported:true,citationIds:['e']}],[{id:'e',sourceId:receipt.id,quote:receipt.resultText}]);
 });
 f.a.addSources([{title:'当前记录',content:body}]);source=f.a.data.sources[0];task=f.a.createTask({title:'确定性求证',description:'按当前原文计算并保留单位。',criteria:'结果符合明确口径。',sourceIds:[source.id],generationMode:'single',steps:[{title:'形成结果',kind:'draft'}]});
 request={tool:'compute_evidence',operation,inputs:operation==='count'?[{sourceId:source.id,whole:true}]:values.map(v=>({sourceId:source.id,start:body.indexOf(v),end:body.indexOf(v)+v.length,...(unit?{unit}:{})})),args};
 await f.a.advance(task.id);assert.equal(task.status,'review',task.lastError);assert.equal(task.verification.passed,true);assert.equal(task.toolEvidence.length,1);assert.ok(task.toolEvidence[0].output.value.startsWith(expected));assert.equal(tool.valid(f.a,task,task.toolEvidence[0]),true);
 assert.deepEqual(f.calls.map(c=>c.role),['execute','execute','verify']);assert.equal(task.grounding.claims[0].citations[0].evidenceType,'tool');ground.assertDelivery(f.a,task);
 source.content+=' 修订后';assert.equal(tool.valid(f.a,task,task.toolEvidence[0]),false);assert.throws(()=>ground.assertDelivery(f.a,task),e=>e.code==='GROUNDING_REQUIRED');
});
test('C actual local status readback expires, and changed output prevents stale delivery',async t=>{
 let task,action;
 const f=await fixture(t,({a,context,role})=>{
  const receipt=context.toolEvidence?.find(r=>r.operation==='action_status');if(role==='execute')return receipt?{kind:'artifact',title:'回读记录',content:'已回读并核对文件。'}:{kind:'read_context',requests:[{tool:'compute_evidence',operation:'action_status',actionId:action.id}]};
  const artifact=context.artifacts[0];return review(a,task,context,[{id:'c',artifactId:artifact.id,field:'content',text:artifact.content,kind:'fact',supported:true,citationIds:['e']}],[{id:'e',sourceId:receipt.id,quote:receipt.resultText}]);
 });
 f.a.addSources([{title:'交付要求',content:'核对现有本地文件。'}]);task=f.a.createTask({title:'回读核对',description:'核对已有文件。',sourceIds:[f.a.data.sources[0].id],steps:[{title:'记录',kind:'draft'}]});
 const job={id:'j',taskIds:[task.id],sourceIds:task.sourceIds,outputFolder:fs.realpathSync(f.a.dir),fileMode:'auto',status:'ready',feedback:[],followups:[],history:[]};f.a.data.delegations.push(job);task.agentJobId=job.id;
 const artifact={id:'written',taskId:task.id,stepId:task.steps[0].id,title:'已写文件',content:'原始结果'};f.a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(f.a,'artifact',artifact,{task});task.steps[0].done=true;task.steps[0].artifactId=artifact.id;task.primaryArtifactId=artifact.id;
 const target=path.join(job.outputFolder,'existing.txt');fs.writeFileSync(target,artifact.content);action={id:'act',jobId:job.id,taskId:task.id,tool:'write_file',status:'done',artifactId:artifact.id,content:artifact.content,target,result:{path:target,verified:true},finishedAt:'2020-01-01T00:00:00Z'};f.a.data.agentActions.push(action);
 // Exercise the same read wrapper used by generation without issuing any write.
 const batch=await tool.readRequests(f.a,task,[{tool:'compute_evidence',operation:'action_status',actionId:action.id}],()=>{throw Error('unexpected reader');});assert.equal(batch.toolEvidence[0].output.status,'readback_verified');
 const result=await require('../desktop/generation-context.cjs').call(f.a,task,'核对回执',f.a.context(task,{verification:true}),'verify');assert.equal(result.passed,true,result.summary);
 const saved=task.toolEvidence[0],now=Date.now();t.mock.method(Date,'now',()=>now+61000);assert.equal(tool.valid(f.a,task,saved),false);t.mock.restoreAll();fs.writeFileSync(target,'被外部改变');assert.equal(tool.valid(f.a,task,saved),false);
});
test('C expired and provenance-unknown memory never authorizes a current factual claim',async t=>{
 const f=await fixture(t,()=>{throw Error('no model needed');}),memory=require('../desktop/memory.cjs');f.a.addSources([{title:'现状',content:'当前仍处于试验阶段。'}]);const source=f.a.data.sources[0];
 const task=f.a.createTask({title:'现状',description:'核对现状。',sourceIds:[source.id],steps:[{title:'现状',kind:'draft'}]});
 await memory.dispatch(f.a,'memorySave',{kind:'fact',title:'阶段',content:source.content,sourceId:source.id,expiresAt:new Date(Date.now()+60000).toISOString()});
 const before=ground.snapshot(f.a,task).basis;f.a.data.memories[0].expiresAt=new Date(Date.now()-1).toISOString();assert.equal(memory.validity(f.a.data,f.a.data.memories[0]).effective,false);assert.notEqual(ground.snapshot(f.a,task).basis,before);
 f.a.data.memories.push({id:'legacy',kind:'fact',version:1,title:'旧事实',content:'已经正式上线',enabled:true,confirmedBy:'user'});memory.initialize(f.a);assert.equal(memory.validity(f.a.data,f.a.data.memories.at(-1)).effective,false);assert.equal(f.a.data.memories.at(-1).content,'已经正式上线');
});

