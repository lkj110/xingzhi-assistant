const electron=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=process.env.ASSISTANT_TEST_DATA_DIR;if(!root)throw Error('Isolated profile required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,streams=require('../desktop/chat-streams.cjs'),create=streams.create;
const clients=new Map();let models=0,network=0;
streams.create=a=>create(a,{createClient(c,secret,handlers){const client={connect(){handlers.status('connected');},disconnect(){},handlers};clients.set(c.id,client);return client;}});
const screenshots=require('../desktop/screenshot.cjs'),nativeCreate=screenshots.create;
screenshots.create=options=>nativeCreate({...options,clipboard:{readImage:()=>electron.nativeImage.createFromPath(path.join(root,'images/synthetic.png'))},run(bin,args,opts,cb){fs.copyFileSync(path.join(root,'images/synthetic.png'),args.at(-1));cb(null);}});
core.Assistant=class extends Base{
 constructor(options){super({...options,officeRequest:async()=>{network++;return {status:200,headers:{},body:JSON.stringify({version:1,items:[{id:'remote-one',title:'自动化来源',content:'请核对项目计划'}],hasMore:false})};},chat:async(_provider,_key,messages)=>{models++;const prompt=messages[0].content,ctx=JSON.parse(messages[1].content);if(prompt.includes('从材料提取'))return {tasks:[{title:'核对截图中的7200元预算',criteria:'明确截图预算为7200元',sourceIds:ctx.sources.map(s=>s.id),steps:[{title:'核对预算',kind:'analysis'}]}],summary:'已识别预算事项'};return {tool:'ask',args:{question:'等待用户配置执行目标'}};}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureIdle'){await this.runPromise;return this.publicState();}
  if(action==='fixtureTick'){Base.prototype.tick.call(this);await this.runPromise;return this.publicState();}
  if(action==='fixtureBotMessage'){const c=this.data.connectors.find(c=>c.id===input.id);clients.get(c.id).handlers.message(c.provider==='wecom'?{msgid:input.messageId||'wecom-1',msgtype:'text',text:{content:input.content||'请整理发布计划'},from:{userid:'test-user'},chatid:'test-chat'}:{msgId:'ding-1',msgtype:'text',text:{content:'钉钉需求'},senderStaffId:'test-staff',conversationId:'test-chat'});return this.publicState();}
  if(action==='fixtureStats')return {models,network};
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(root,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'隔离模型',model:'fixture',baseUrl:'https://fixture.invalid/v1'});await a.dispatch('projectSave',{name:'机器人测试项目'});electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');})().catch(e=>{console.error(e);electron.app.exit(1);});
