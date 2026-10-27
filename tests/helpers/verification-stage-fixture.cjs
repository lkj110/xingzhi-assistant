'use strict';
// Offline only: real generation, budgeting and visibility, synthetic final transport.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
async function run(root,{mode='read',phase='result',type='codex',search=true,compute=true,incremental=false}={}){
 const req=name=>require(path.join(root,'desktop',name+'.cjs'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verification-stages-')),calls=[];
 const a=new (req('core').Assistant)({dir,chat:async(_p,_key,messages,options)=>{
  const payload=req('model-input').materialize(JSON.parse(messages[1].content));
  calls.push({messages,payload,contract:options.responseContract,schema:options.transportSchema,bytes:options.inputBudget.visibleRequestBytes});
  options.onUsage({inputTokens:1,outputTokens:1}); // Synthetic accounting, never report as real tokens.
  if(mode==='final'&&!payload.checkFinalization)return {kind:'read_context',requests:[{tool:'read_source',sourceId:source.id}]};
  if(mode==='classification'&&calls.length===1)return {kind:'read_context',requests:[{tool:'read_source',sourceId:source.id}]};
  return {passed:true,summary:'离线模拟核验',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[draft.id],citations:[{id:'e1',sourceId:source.id,quote:source.content}],requirements:req('grounding').requirements(a,task).map(r=>({id:r.id,status:'satisfied',claimIds:['c1']})),claims:[{id:'c1',artifactId:draft.id,field:'content',text:draft.content,kind:mode==='classification'&&!payload.groundingClassificationReview?'inference':'fact',supported:true,citationIds:['e1']}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}};
 }});
 let task,source,draft;
 try{
  a.data.settings.evidenceGrounding=true;a.contextOptimizationOverrides={B:search,C:compute};
  a.addSources([{title:'离线工单登记',content:'登记日期为2026年2月11日，工单记录为17项，范围仅限北区。南区未纳入。'}]);source=a.data.sources[0];
  task=a.createTask({title:'工单查询',description:'按登记原文说明北区工单数量。',criteria:'保留统计范围，数量与原文一致。',sourceIds:[source.id],generationMode:'single',steps:[{title:'查询结果',kind:'draft'}]});
  draft={id:'offline-stage-draft',taskId:task.id,stepId:task.steps[0].id,title:'北区登记',content:'北区登记工单为17项。',createdAt:'2026-02-12T00:00:00.000Z'};
  a.data.artifacts.push(draft);req('protocol-access').retain(a,'artifact',draft,{task});Object.assign(task.steps[0],{done:true,artifactId:draft.id});req('deliverables').record(a,task,task.steps[0],draft,{});
  await a.dispatch('saveProvider',{type,name:'offline',baseUrl:'http://127.0.0.1:1/v1',model:'offline',key:type==='codex'?'':'offline-only',inputPrice:0,outputPrice:0});a.save();
  const context={...a.context(task,{verification:true}),verificationPhase:phase,...(incremental?{previousCheck:{summary:'字节未变的片段曾通过检查'}}:{})};
  // Baseline has no extracted prompt module; read the original expression exactly.
  let systemFor;
  if(fs.existsSync(path.join(root,'desktop/verification-instruction.cjs')))systemFor=req('verification-instruction')[phase==='content'?'content':'result'];
  else{
   const {createRequire}=require('node:module'),local=createRequire(path.join(root,'desktop/core.cjs'));
   const file=fs.readFileSync(path.join(root,'desktop',phase==='content'?'execution-control.cjs':'core.cjs'),'utf8').replace(/\r\n/g,'\n');
   const expression=phase==='content'?file.split("system:require('./relation-obligations.cjs').instruction")[1].split('};')[0]:file.split('const verifyPrompt=')[1].split(';\n')[0].replace(/;\r$/,'');
   const text=Function('require','linkedJob','return '+(phase==='content'?"require('./relation-obligations.cjs').instruction"+expression:expression))(local,false);
   systemFor=()=>text;
  }
  const result=await req('generation-context').call(a,task,systemFor(),context,'verify',{systemFor});
  return {result,calls};
 }finally{req('access').cancel(a);req('deadline-scheduler').dispose(a);fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
module.exports={run};
