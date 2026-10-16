const path=require('node:path'),fs=require('node:fs'),core=require('../desktop/core.cjs'),Base=core.Assistant,electron=require('electron');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated data required');let models=0,requests=0,loseReply=false;
const response=(tool,args={})=>({tool,args,reason:'托管向导界面验证'});
core.Assistant=class extends Base{
 constructor(options){super({...options,feedRequest:async url=>{requests++;return {status:200,url,headers:{'content-type':'application/rss+xml'},body:'<rss version="2.0"><channel><item><guid>cedar</guid><title>青禾公告</title><description>青禾项目预算7200元</description></item></channel></rss>'};},webRequest:async url=>{requests++;return {status:200,url,headers:{'content-type':'text/html'},body:'<title>青禾进展</title><p>已确定预算7200元</p>'};},agentRequest:async()=>{throw Error('External Agent calls disabled');},connectorRequest:async()=>{throw Error('External connectors disabled');},chat:async(_p,_k,messages)=>{models++;const prompt=messages[0].content,ctx=JSON.parse(messages[1].content);if(prompt.includes('动作格式')){const task=ctx.tasks[0];if(!task)return response('plan_task',{key:'cedar',title:'青禾资料整理',criteria:'说明确定的预算',sourceIds:ctx.sources.filter(s=>s.current!==false).map(s=>s.id),steps:[{key:'draft',title:'编写摘要',kind:'draft'}]});if(task.status==='completed')return response('complete');return response('advance_task',{taskId:task.id});}if(prompt.includes('推进给定事项'))return {kind:'artifact',title:'青禾摘要',content:'青禾项目预算7200元，材料已核对。'};return {passed:true,summary:'引用和预算检查通过',gaps:[]};}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureFlowStats')return {models,requests};
  if(action==='fixtureFlowBusy'){this.operation=input.enabled?{label:'其他工作正在推进',startedAt:new Date().toISOString()}:null;return this.publicState();}
  if(action==='fixtureFlowProvider')return super.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'隔离模型',model:'fixture',baseUrl:'https://fixture.invalid/v1'});
  if(action==='fixtureFlowLoseReply'){loseReply=true;return {ok:true};}
  if(action==='fixtureFlowOutput'){const output=path.join(dir,input.changed?'output-changed':'output');fs.mkdirSync(output,{recursive:true});this.data.agentSettings.outputFolder=output;this.save();return this.publicState();}
  if(action==='fixtureFlowIdle'){await this.runPromise;return this.publicState();}
  if(action==='fixtureFlowTick'){Base.prototype.tick.call(this);await this.runPromise;return this.publicState();}
  const result=await super.dispatch(action,input);if(action==='projectSetupCreate'&&loseReply){loseReply=false;throw Error('创建回执传输中断，请重试原请求');}return result;
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('projectSave',{name:'已有项目'});const unassigned=path.join(dir,'unassigned'),owned=path.join(dir,'owned');fs.mkdirSync(unassigned);fs.mkdirSync(owned);fs.writeFileSync(path.join(unassigned,'青禾资料.txt'),'青禾项目预算7200元。');a.data.folders.push({id:'unassigned',name:'未分配资料目录',path:unassigned,enabled:false},{id:'owned',name:'其他项目目录',path:owned,enabled:false,projectId:a.data.projects[0].id});a.save();electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};electron.dialog.showOpenDialog=async()=>{const selected=path.join(dir,'new-selection');fs.mkdirSync(selected,{recursive:true});return {canceled:false,filePaths:[selected]};};require('../desktop/main.cjs');})().catch(e=>{console.error(e);electron.app.exit(1);});
