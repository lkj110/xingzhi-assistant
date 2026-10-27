'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Assistant}=require('../../desktop/core.cjs'),tool=require('../../desktop/tool-evidence.cjs'),ground=require('../../desktop/grounding.cjs');
async function setup(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'observation-time-')));
 t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5});});
 const prohibited=async()=>{throw Error('Network/model forbidden in offline regression');};
 const a=new Assistant({dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited});a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;a.data.settings.autoComplete=false;a.contextOptimizationOverrides={B:false};
 await a.dispatch('saveProvider',{name:'offline',model:'offline',baseUrl:'http://127.0.0.1:1',key:'offline',inputPrice:0,outputPrice:0});
 a.addSources([{title:'记录',content:'旧文件用于留档；说明须按实际观察时点表述。'}]);
 const task=a.createTask({title:'文件核对',description:'只读核对旧文件，保留时点。',criteria:'不把历史观察当作当前交付。',sourceIds:[a.data.sources[0].id],generationMode:'single',steps:[{title:'说明',kind:'draft'}]});
 const ids=await require('../../scripts/readiness/fixtures.cjs').install(a,task,{fixture:{existingAction:{fileName:'record.txt',title:'旧稿',content:'旧稿正文。'}}},path.resolve(__dirname,'../..'));
 const action=a.data.agentActions.find(r=>r.id===ids.__EXISTING_ACTION_ID__),job=a.data.delegations[0];
 const request={tool:'compute_evidence',operation:'action_status',actionId:action.id};
 function draft(content){
  let artifact=a.data.artifacts.find(r=>r.id==='observation-draft');
  if(!artifact){artifact={id:'observation-draft',taskId:task.id,stepId:task.steps[0].id,title:'只读说明',content};a.data.artifacts.push(artifact);require('../../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});}
  artifact.content=content;Object.assign(task.steps[0],{done:true,artifactId:artifact.id});task.primaryArtifactId=artifact.id;return artifact;
 }
 function report(receipt,content='本轮只读核验时，旧文件存在且正文与历史记录一致。'){
  const artifact=draft(content),seen=new Set();ground.observe(seen,{artifacts:[artifact],toolEvidence:[tool.project(receipt,task)]});
  const result={passed:true,summary:'按观察时点核对',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[artifact.id],requirements:ground.requirements(a,task).map(r=>({id:r.id,status:'satisfied',claimIds:['c']})),claims:[{id:'c',artifactId:artifact.id,field:'content',text:content,kind:'fact',supported:true,citationIds:['e']}],citations:[{id:'e',sourceId:receipt.id,quote:receipt.resultText}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}};
  return {result,seen,artifact,finish:()=>ground.finish(a,task,result,{seen})};
 }
 return {a,task,job,action,request,report,draft,dir};
}
module.exports={setup};
