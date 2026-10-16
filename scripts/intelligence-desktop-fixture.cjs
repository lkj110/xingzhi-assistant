const path=require('node:path'),core=require('../desktop/core.cjs'),Base=core.Assistant,electron=require('electron');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated test data required');let fail=true,calls=0;
electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async()=>{calls++;if(fail)throw require('../desktop/model-errors.cjs').httpError(503);return {tasks:[],summary:'保留已收背景资料'};},agentRequest:async()=>{throw Error('External requests forbidden');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureIntelligenceRetry'){fail=false;for(const row of this.data.captureQueue)if(row.status==='failed'&&row.autoRetry?.nextRetryAt)row.autoRetry.nextRetryAt=new Date(Date.now()-1000).toISOString();this.save();for(let n=0;n<4;n++){Base.prototype.tick.call(this);await this.runPromise;}return this.publicState();}
  if(action==='fixtureIntelligenceStats')return {calls};
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'临时故障测试模型',model:'fixture',baseUrl:'https://fixture.invalid/v1'});require('../desktop/main.cjs');})().catch(error=>{console.error(error);electron.app.exit(1);});
