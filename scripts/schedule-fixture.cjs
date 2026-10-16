const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated data required');
let clock=Date.parse('2026-10-05T08:00:00Z');Date.now=()=>clock;
const core=require('../desktop/core.cjs'),Base=core.Assistant,s=require('../desktop/stewardship.cjs'),agent=require('../desktop/agent.cjs'),calls={models:0,requests:0,messages:0};
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async()=>{calls.models++;return {ok:true};},agentRequest:async()=>{calls.requests++;throw Error('Fixture forbids external requests');},connectorRequest:async()=>{calls.messages++;throw Error('Fixture forbids external messages');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureScheduleCounters')return {...calls};
  if(action==='fixtureScheduleClock'){clock=Date.parse(input.at);if(input.reconcile)s.reconcile(this);this.save();return this.publicState();}
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});a.data.stewardship.timeZone='UTC';await a.dispatch('stewardshipSettings',{dailyCallLimit:10});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'隔离模型',model:'fixture',baseUrl:'https://example.invalid/v1'});const j=agent.buildJob(a,{goal:'人工暂停的事项不能被全局定时恢复唤醒'});j.status='paused';a.data.delegations.push(j);await a.dispatch('ruleSave',{name:'手动暂停规则',goal:'保持暂停',trigger:'daily',time:'09:00',allowWeb:false});a.save();const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');})().catch(error=>{console.error(error);require('electron').app.exit(1);});
