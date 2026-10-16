const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,{httpError,blockedError}=require('../desktop/model-errors.cjs');
const counters={models:0,requests:0,messages:0},seen=[];let failure='transient';
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async(p,_key,messages,opts)=>{counters.models++;seen.push({providerId:p.id,attempt:opts.attempt,role:opts.role,stage:opts.stage});if(p.name==='主模型')throw failure==='refusal'?blockedError():httpError(503);return {ok:true};},agentRequest:async()=>{counters.requests++;throw Error('Fixture forbids external requests');},connectorRequest:async()=>{counters.messages++;throw Error('Fixture forbids external messages');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureFallbackCounters')return {...counters,seen};
  if(action==='fixtureFallbackMode'){failure=input.mode;return {ok:true};}
  if(action==='fixtureFallbackRun')return this.call(input.role||'execute','测试独立推理',{note:'隔离测试上下文'});
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});for(const name of ['主模型','备用模型','另一个模型'])await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name,model:name,baseUrl:`https://${a.data.providers.length}.example.invalid/v1`});const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');})().catch(error=>{console.error(error);require('electron').app.exit(1);});
