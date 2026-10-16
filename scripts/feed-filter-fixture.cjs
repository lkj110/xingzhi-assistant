const path=require('node:path'),fs=require('node:fs'),core=require('../desktop/core.cjs'),Base=core.Assistant;
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated data required');let phase='initial';const calls={feedRequests:0,models:0,external:0};
const item=(id,title,body)=>`<item><guid>${id}</guid><title><![CDATA[${title}]]></title><link>https://example.com/metadata/${id}</link><pubDate>Sun, 04 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[${body}]]></description></item>`;
const bodies={initial:item('tracked','ＡＩ发布','第一版：预算6800元')+item('ad','AI广告','推广信息')+item('ordinary','普通新闻','行业观察'),revision:item('tracked','普通更新','第二版：预算7200元')+item('new','AI发布','新项目资料')+item('ordinary','普通新闻','行业观察'),withdrawn:item('tracked','AI回归','第三版预算7500元')+item('new','AI发布','新项目资料'),metadata:item('body-no','metadata标题词','正文没有关键字')+item('body-yes','普通标题','真实摘要资料'),many:Array.from({length:35},(_,i)=>item(`many-${i}`,`普通条目${i+1}`,'普通正文')).join('')};
core.Assistant=class extends Base{
 constructor(options){super({...options,feedRequest:async(url,options)=>{if(url!=='https://example.com/feed.xml'||options.allowedOrigin!=='https://example.com')throw Error('Fixture scope mismatch');calls.feedRequests++;return {status:200,url,headers:{'content-type':'application/rss+xml'},body:`<rss version="2.0"><channel>${bodies[phase]}</channel></rss>`};},chat:async()=>{calls.models++;throw Error('Models forbidden');},agentRequest:async()=>{calls.external++;throw Error('External requests forbidden');},connectorRequest:async()=>{calls.external++;throw Error('External writes forbidden');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureFilterStats')return {...calls,file:fs.readFileSync(this.file,'utf8')};
  if(action==='fixtureFilterPhase'){phase=input.phase;return {phase};}
  if(action==='fixtureFilterDrain'){await this.runPromise;return this.publicState();}
  if(action==='fixtureFilterWithdraw'){const source=this.data.sources.find(s=>s.version===2);source.projectExcluded=true;this.save();return this.publicState();}
  if(action==='fixtureFilterChange'){const row=this.data.feedConnections[0];return super.dispatch('feedConnectionSave',{...row,filter:{include:['外部新规则'],exclude:[],scope:'title',match:'all'}});}
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('projectSave',{name:'内容筛选项目'});const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');})().catch(e=>{console.error(e);require('electron').app.exit(1);});
