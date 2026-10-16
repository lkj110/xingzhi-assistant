const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,agent=require('../desktop/agent.cjs'),acceptance=require('../desktop/acceptance.cjs');
core.Assistant=class extends Base{
  constructor(options){super({...options,chat:async()=>{throw new Error('Fixture forbids model calls');},agentRequest:async()=>{throw new Error('Fixture forbids external requests');},connectorRequest:async()=>{throw new Error('Fixture forbids external messages');}});}
  tick(){}
  async dispatch(action,input={}){
    if(action==='fixtureMapResume'){const job=this.data.delegations.find(job=>job.title==='青禾发布委托');job.status='ready';job.nextRunAt=new Date(Date.now()-1000).toISOString();this.event('恢复测试委托','隔离工作地图测试');this.save();return this.publicState();}
    if(action==='fixtureMapChange'){const task=this.data.tasks.find(task=>task.title==='整理青禾事实');this.data.artifacts.find(artifact=>artifact.taskId===task.id).content+=' 新变更';this.event('测试产出发生变更','隔离工作地图测试');this.save();return this.publicState();}
    return super.dispatch(action,input);
  }
};
(async()=>{
  const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});await a.dispatch('projectSave',{name:'青禾项目'});const project=a.data.projects[0];await a.dispatch('projectSave',{name:'未来项目'});const later=a.data.projects.find(project=>project.name==='未来项目');
  const job=agent.buildJob(a,{projectId:project.id,goal:'整理真实青禾预算事实，交付发布说明。',allowWeb:false});job.title='青禾发布委托';job.status='paused';a.data.delegations.push(job);project.jobId=job.id;
  a.addSources([{title:'青禾预算材料',content:'预算已经确认是6800元，负责人林悦。',projectId:project.id}]);const source=a.data.sources.find(source=>source.title==='青禾预算材料');job.sourceIds=[source.id];
  const first=a.createTask({projectId:project.id,title:'整理青禾事实',criteria:'包含真实预算6800元',sourceIds:[source.id],steps:[{title:'整理预算依据',kind:'draft'}]});Object.assign(first,{agentJobId:job.id,dependsOn:[],status:'completed'});first.steps[0].done=true;first.steps[0].artifactId='fixture-artifact';a.data.artifacts.push({id:'fixture-artifact',title:'青禾事实文稿',taskId:first.id,stepId:first.steps[0].id,content:'青禾发布预算为6800元，负责人为林悦。',createdAt:new Date().toISOString()});first.verification={passed:true,summary:'已核对预算与负责人',gaps:[]};
  const next=a.createTask({projectId:project.id,title:'生成青禾发布说明',criteria:'结合确认事实生成说明',sourceIds:[source.id],steps:[{title:'撰写发布说明',kind:'draft'}]});Object.assign(next,{agentJobId:job.id,dependsOn:[first.id]});job.taskIds=[first.id,next.id];for(const task of [first,next])task.steps.forEach((step,index)=>step.key=`step-${index+1}`);first.verification.basis=acceptance.basis(a,first);
  const empty=agent.buildJob(a,{projectId:later.id,goal:'收集新项目材料并拆解待办',allowWeb:false});empty.title='尚未拆解的委托';a.data.delegations.push(empty);later.jobId=empty.id;
  for(let i=0;i<25;i++)a.createTask({title:`独立工作${String(i+1).padStart(2,'0')}`,steps:[{title:'整理草稿',kind:'draft'}]});a.save();
  const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
