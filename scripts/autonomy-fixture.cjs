const fs=require('node:fs'),path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,agent=require('../desktop/agent.cjs'),capture=require('../desktop/capture.cjs');
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async(_p,_k,m)=>m[0].content.includes('推进给定事项')?{kind:'artifact',title:'验收报告',content:'这份报告已经整理了指定事实，预算5200元。'}:{passed:true,summary:'已核对预算和完成标准',gaps:[]},agentRequest:async()=>{throw new Error('Fixture forbids external tools');},connectorRequest:async()=>{throw new Error('Fixture forbids external messages');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureBusy')return this.launch('已有事项正在推进',()=>new Promise(resolve=>{this.fixtureRelease=resolve;}));
  if(action==='fixtureRelease'){this.fixtureRelease?.();await this.runPromise;return this.publicState();}
  if(action==='fixtureDrain'){capture.tick(this);await this.runPromise;return this.publicState();}
  if(action==='fixtureChangeArtifact'){const t=this.task(input.id);this.data.artifacts.find(v=>v.id===t.steps[0].artifactId).content+=' 新增变更';this.save();return this.publicState();}
  return super.dispatch(action,input);
 }
};
(async()=>{
 const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
 await a.dispatch('projectSave',{name:'青禾项目'});const p=a.data.projects[0];await a.dispatch('projectSave',{name:'财务项目'});
 const j=agent.buildJob(a,{projectId:p.id,goal:'按最新信息推进青禾工作',allowWeb:false});j.status='paused';a.data.delegations.push(j);p.jobId=j.id;
 for(const title of ['验收报告甲','验收报告乙','变更后须重新检查']){const task=a.createTask({title,criteria:'包含预算5200元',steps:[{title:'生成报告',kind:'draft'}]});await a.dispatch('advance',{id:task.id});await a.runPromise;}
 const late=a.createTask({title:'未来截止事项',dueAt:new Date(Date.now()+86400000).toISOString()});late.status='paused';a.save();
 const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(e=>{console.error(e);require('electron').app.exit(1);});
