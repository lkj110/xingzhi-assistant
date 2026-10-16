const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated data required');
let clock=Date.parse('2030-01-07T09:00:00Z');Date.now=()=>clock;
const core=require('../desktop/core.cjs'),Base=core.Assistant,capture=require('../desktop/capture.cjs'),{httpError,blockedError}=require('../desktop/model-errors.cjs');
const calls={models:0,requests:0,messages:0},attempts=new Map();
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async(_p,_k,m)=>{calls.models++;const context=JSON.parse(m[1].content),title=context.sources[0].title,n=(attempts.get(title)||0)+1;attempts.set(title,n);if(title==='拦截演示')throw blockedError();if(title==='瞬态演示'&&n>1)return {tasks:[],summary:'原材料整理完成'};throw httpError(503);},agentRequest:async()=>{calls.requests++;throw Error('Fixture forbids external requests');},connectorRequest:async()=>{calls.messages++;throw Error('Fixture forbids external messages');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureRetryCounters')return {...calls};
  if(action==='fixtureRetryDue'){const row=this.data.captureQueue.find(r=>r.id===input.id);if(row.autoRetry?.nextRetryAt)clock=Date.parse(row.autoRetry.nextRetryAt);const started=capture.tick(this);if(started)await this.runPromise;return {started,state:this.publicState()};}
  if(action==='fixtureRetryClock'){clock=Date.parse(input.at);return this.publicState();}
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'隔离模型',model:'fixture',baseUrl:'https://example.invalid/v1'});for(const title of ['瞬态演示','上限演示','拦截演示','取消演示']){await a.dispatch('captureEnqueue',{textItems:[{title,content:`需要处理${title}的材料`}],organize:true});await a.runPromise;}const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');})().catch(error=>{console.error(error);require('electron').app.exit(1);});
