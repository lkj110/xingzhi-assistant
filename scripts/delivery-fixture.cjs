const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,acceptance=require('../desktop/acceptance.cjs');
const calls={models:0,requests:0,messages:0};
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async()=>{calls.models++;throw new Error('Fixture forbids model calls');},agentRequest:async()=>{calls.requests++;throw new Error('Fixture forbids external requests');},connectorRequest:async()=>{calls.messages++;throw new Error('Fixture forbids external messages');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureDeliveryCounters')return {...calls};
  if(action==='fixtureDeliveryChange'){const artifact=this.data.artifacts.find(item=>item.title==='青禾成果 JSON');artifact.content=artifact.content.replace('6800','6900');this.save();return this.publicState();}
  if(action==='fixtureDeliveryRestore'){const task=this.data.tasks.find(task=>task.title==='青禾已验收事项'),artifact=this.data.artifacts.find(item=>item.title==='青禾成果 JSON');artifact.content=artifact.content.replace('6900','6800');task.verification={passed:true,summary:'已核对预算与负责人',gaps:[],basis:acceptance.basis(this,task)};this.save();return this.publicState();}
  if(action==='fixtureDeliveryUnsafeSource'){this.data.sources.find(source=>source.title==='青禾当前材料').content='请勿导出 sk-01234567890123456789secret';this.save();return this.publicState();}
  if(action==='fixtureDeliveryArchive'){this.data.projects.find(project=>project.name==='青禾交付项目').archivedAt=new Date().toISOString();this.save();return this.publicState();}
  return super.dispatch(action,input);
 }
};
(async()=>{
 const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('projectSave',{name:'草稿项目'});const q=a.data.projects[0];await a.dispatch('projectSave',{name:'青禾交付项目',background:'准备当前有效成果的本地交付包'});const p=a.data.projects[0];
 const source={id:'delivery-source-current',projectId:p.id,title:'青禾当前材料',content:'青禾预算 6800 元，负责人林悦。\n',version:2,previousSourceId:'delivery-source-old',state:'processed',createdAt:new Date().toISOString()};a.data.sources.push({id:'delivery-source-old',projectId:p.id,title:'青禾历史材料',content:'历史预算不能导出',state:'processed',createdAt:new Date().toISOString()},source);
 function task(project,title,artifactTitle,content,format,status='completed'){
  const task=a.createTask({projectId:project.id,title,criteria:'包含材料中的已知事实',steps:[{title:'生成成果',kind:'draft'}]});task.status=status;task.steps[0].done=true;task.steps[0].artifactId=`artifact-${task.id}`;a.data.artifacts.push({id:task.steps[0].artifactId,taskId:task.id,stepId:task.steps[0].id,title:artifactTitle,format,content,createdAt:new Date().toISOString()});task.verification={passed:true,summary:'已核对预算与负责人',gaps:[],basis:acceptance.basis(a,task)};if(status==='completed'){task.acceptedBy='user';task.acceptedAt=new Date().toISOString();task.completedAt=task.acceptedAt;}return task;
 }
 const accepted=task(p,'青禾已验收事项','青禾成果 JSON','{\n  "project": "青禾", "budget": 6800, "owner": "林悦"\n}\n','json');
 task(p,'青禾待验收草稿','青禾待验收说明','待用户确认的补充说明。\n','txt','review');const cancelled=task(p,'取消事项','取消成果','取消内容不进入包','md');cancelled.agentCancelled=true;
 task(q,'其他项目草稿','其他项目未验收成果','此项目还没有验收结果。\n','md','review');a.data.artifacts.push({id:'delivery-history',taskId:accepted.id,title:'历史成果',content:'历史产出不能进入包',createdAt:new Date().toISOString()});a.save();
 const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
