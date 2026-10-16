const fs=require('node:fs'),path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,agent=require('../desktop/agent.cjs'),capture=require('../desktop/capture.cjs');
const deny=async()=>{throw new Error('Lifecycle fixture forbids model and network calls');};
core.Assistant=class extends Base{
  constructor(options){super({...options,chat:deny,agentRequest:deny,connectorRequest:deny,webRequest:deny,feedRequest:deny});}
  tick(){}
  async dispatch(action,input={}){
    if(action==='fixtureChangeLifecycleTask'){this.data.tasks.find(t=>t.projectId===input.projectId).title+=' 已更新';this.save();return this.publicState();}
    if(action==='fixtureBusy')return this.launch('已有事项正在推进',()=>new Promise(resolve=>{this.fixtureRelease=resolve;}));
    if(action==='fixtureRelease'){this.fixtureRelease?.();await this.runPromise;return this.publicState();}
    return super.dispatch(action,input);
  }
};
(async()=>{
  const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  await a.dispatch('projectSave',{name:'生命周期项目',background:'检查归档与重开，不进行实际外部操作'});const p=a.data.projects[0];await a.dispatch('projectSave',{name:'其他持续项目'});
  a.addSources([{title:'项目历史资料',content:'阶段目标与完成依据。',projectId:p.id}]);
  a.data.agentSettings.outputFolder=a.dir;
  const j=agent.buildJob(a,{projectId:p.id,goal:'持续推进项目资料',allowWeb:false,useOutputFolder:true,fileMode:'auto'});a.data.delegations.push(j);p.jobId=j.id;j.sourceIds=a.data.sources.filter(s=>s.projectId===p.id).map(s=>s.id);
  const task=a.createTask({title:'待收尾事项',projectId:p.id});task.agentJobId=j.id;j.taskIds.push(task.id);task.dependsOn=[];task.steps.forEach((s,i)=>s.key=`step-${i+1}`);
  a.data.agentActions.push({id:'unknown-result',jobId:j.id,taskId:task.id,tool:'write_file',title:'需要核对的历史写入',status:'uncertain',createdAt:new Date().toISOString(),content:'历史正文'});j.pendingActionId='unknown-result';
  a.data.feedConnections.push({id:'lifecycle-feed',projectId:p.id,name:'项目公告订阅',url:'https://example.com/feed',intervalMinutes:30,enabled:true,nextRunAt:new Date().toISOString(),health:'healthy'});
  a.data.connectors.push({id:'lifecycle-chat',projectId:p.id,kind:'chat',name:'项目会话',target:'oc_testproject',enabled:true,nextRunAt:new Date().toISOString(),sendPolicy:{mode:'auto',revision:'old-grant',expiresAt:new Date(Date.now()+86400000).toISOString(),maxSends:1,intervalMinutes:1440,template:'固定文案'}});
  a.data.stewardship.paused=true;
  // Queue before introducing the unknown result, retaining the real payload on disk.
  const unsettled=a.data.agentActions.splice(0);await capture.dispatch(a,'captureEnqueue',{projectId:p.id,textItems:[{title:'暂存资料',content:'项目队列内容'}]});a.data.agentActions.push(...unsettled);a.save();
  const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(e=>{console.error(e);require('electron').app.exit(1);});
