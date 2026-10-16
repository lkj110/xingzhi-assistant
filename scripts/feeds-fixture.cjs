const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,agent=require('../desktop/agent.cjs');
let revision='甲',requests=0;
const request=async(url,options)=>{
  if(url!=='https://example.com/feed.xml'||options.allowedOrigin!=='https://example.com')throw new Error('Unexpected fixture scope');
  requests++;
  return {status:200,url,headers:{'content-type':'application/rss+xml'},body:`<rss version="2.0"><channel><title>测试订阅</title><item><guid>stable-release</guid><title>发布公告</title><link>https://example.com/release</link><description>版本${revision}：准备预算6800元的发布工作。</description></item></channel></rss>`};
};
core.Assistant=class extends Base{
  constructor(options){super({...options,chat:async()=>{throw new Error('Unexpected fixture model call');},feedRequest:request,agentRequest:async()=>{throw new Error('Unexpected external request');},connectorRequest:async()=>{throw new Error('Unexpected external message');}});}
  tick(){}
  async dispatch(action,input={}){
    if(action==='fixtureFeedRevision'){revision=input.revision;return {revision};}
    if(action==='fixtureFeedDrain'){await this.runPromise;return this.publicState();}
    if(action==='fixtureFeedCount')return {requests};
    if(action==='fixtureFeedDue'){const c=this.data.feedConnections[0];c.nextRunAt=new Date(Date.now()-1000).toISOString();require('../desktop/feeds.cjs').tick(this);await this.runPromise;return this.publicState();}
    return super.dispatch(action,input);
  }
};
(async()=>{
  const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  await a.dispatch('projectSave',{name:'青禾项目'});const p=a.data.projects[0];
  const j=agent.buildJob(a,{projectId:p.id,goal:'按订阅变化推进青禾工作',allowWeb:false});j.status='paused';a.data.delegations.push(j);p.jobId=j.id;a.save();
  const electron=require('electron');electron.Notification=class {static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(e=>{console.error(e);require('electron').app.exit(1);});
