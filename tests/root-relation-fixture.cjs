const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),links=require('../desktop/evidence-links.cjs');
const relations=require('../desktop/relation-obligations.cjs'),plans=require('../desktop/agent-plan.cjs'),requests=require('../desktop/evidence-request.cjs');
const deny=()=>{throw Error('Fixture forbids real network/model/connector');};
function fixture(t,{roots=['123'],kinds='SQL读写'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-relation-contract-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const [object,key] of [[globalThis,'fetch'],[require('node:net').Socket.prototype,'connect']])t.mock.method(object,key,deny);
 const a=new Assistant({dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',type:'openai',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const job=agent.buildJob(a,{goal:'入口 IDs: '+roots.join(',')+'\n\n范围：\n核对'+kinds,dataPlatform:'sg-readonly'});a.data.delegations.push(job);
 require('../desktop/operation-ledger.cjs').state(job);
 const task=a.createTask({title:'修订原稿',description:'核对原明确缺口',criteria:kinds,steps:[{title:'正文',kind:'draft'}]});
 Object.assign(task,{agentJobId:job.id,agentKey:'report',planVersion:1,planHistory:[]});task.steps[0].key='draft';job.taskIds=[task.id];
 let n=0;
 function source(op='code',data={taskId:123,sql:'SELECT a FROM orders'},query={taskId:123},meta={},bind=true){
  const s=agent.source(a,job,'relation-fixture-'+(++n),op,JSON.stringify({operation:op,region:'sg',query:{op,...query},data}),{platformSnapshot:true,platformPrincipal:job.platformPrincipal||null,...meta});
  if(bind)links.setInputs(a,task,[...task.sourceIds,s.id]);return s;
 }
 function need({gaps=['入口123 SQL缺失'],requirements,kind='needs_evidence',artifactId}={}){
  task.evidenceRequest=requests.normalize(a,task,{kind,summary:'原缺口需要新证据',gaps,requirements:requirements||[],...(artifactId?{artifactId}:{})},'request-'+(++n));return task.evidenceRequest;
 }
 function plan(ids,extra={}){
  return plans.planTask(a,job,{key:'report',title:task.title,criteria:task.criteria,sourceIds:ids,reason:'关联原缺口证据',...extra});
 }
 function resolve(ids,extra={}){
  return plan(ids,{evidenceResolution:{basis:task.evidenceRequest.basis,sourceIds:ids,reason:'处理原缺口',...extra}});
 }
 function check(ids,{kind='sql_read_write',...delta}={}){
  const o=relations.required(a,job,task).find(o=>o.kind===kind);
  return relations.validateCoverage(a,job,task,{passed:true,summary:'已核对',gaps:[],relationCoverage:[{obligationId:o.id,status:'analyzed',coverage:'complete',rootIds:o.rootIds,sourceIds:ids,summary:'对应类型的具体核对结果',...delta}]},'check-'+(++n));
 }
 return {a,job,task,dir,source,need,plan,resolve,check};
}
module.exports={fixture,deny};
