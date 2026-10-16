const fs=require('node:fs'),path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,capture=require('../desktop/capture.cjs'),agent=require('../desktop/agent.cjs');
core.Assistant=class extends Base{
 constructor(options){let self;super({...options,chat:async(_p,_k,m)=>{if(self?.failOnce){self.failOnce=false;throw new Error('隔离模型暂时不可用');}const input=JSON.parse(m[1].content);return {tasks:[{title:'处理 '+input.sources[0].title,description:'保持来源',criteria:'按材料整理后续行动',sourceIds:input.sources.map(s=>s.id),steps:[{title:'整理',kind:'analysis'}]}],summary:'本次收集已整理'};},webRequest:async url=>({status:200,headers:{'content-type':'text/html'},body:fs.readFileSync(path.join(dir,'web.html'),'utf8'),url}),agentRequest:async()=>{throw new Error('Fixture forbids external tools');},connectorRequest:async()=>{throw new Error('Fixture forbids external messages');}});self=this;}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureBusy')return this.launch('已有事项正在推进',()=>new Promise(resolve=>{this.fixtureRelease=resolve;}));
  if(action==='fixtureRelease'){this.fixtureRelease?.();await this.runPromise;return this.publicState();}
  if(action==='fixtureDrain'){capture.tick(this);await this.runPromise;return this.publicState();}
  if(action==='fixtureFailOnce'){this.failOnce=true;return {ok:true};}
  if(action==='fixtureWebVersion'){fs.writeFileSync(path.join(dir,'web.html'),input.version===1?'<title>公告</title><p>第一版预算4800元</p>':'<title>公告</title><p>第二版预算5200元</p>');return {ok:true};}
  return super.dispatch(action,input);
 }
};
(async()=>{fs.writeFileSync(path.join(dir,'web.html'),'<title>公告</title><p>第一版预算4800元</p>');const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});await a.dispatch('projectSave',{name:'持续工作项目'});const p=a.data.projects[0];await a.dispatch('projectSave',{name:'另一个项目'});const j=agent.buildJob(a,{projectId:p.id,goal:'持续收集新材料',allowWeb:false});j.status='paused';a.data.delegations.push(j);p.jobId=j.id;
 const t=a.createTask({title:'需要核对的事项',projectId:p.id});t.status='blocked';t.lastError='测试原文 /private/secret-folder 应仅在事项里显示';a.save();const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');})().catch(e=>{console.error(e);require('electron').app.exit(1);});
