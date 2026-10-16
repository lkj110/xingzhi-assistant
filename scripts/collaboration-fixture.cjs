// Isolated desktop fixture. Never included in a release package.
const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Test directory required');
const core=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),followup=require('../desktop/agent-followup.cjs');
const messages=[];
const request=async args=>{const get=k=>args[args.indexOf(k)+1];
  if(args[0]==='auth')return {verified:true,identities:{user:{available:true,status:'ready',openId:'ou_self'}}};
  if(args[1]==='+messages-send'){const m={message_id:'om_ui_sent',chat_id:get('--chat-id'),content:get('--text'),msg_type:'text',sender:{id:'ou_self'}};messages.push(m);return {data:{message_id:m.message_id,chat_id:m.chat_id}};}
  if(args[1]==='+messages-mget')return {data:{messages}};
  return {data:{messages:[],has_more:false}};
};
const Base=core.Assistant;
core.Assistant=class extends Base{constructor(opts){super({...opts,connectorRequest:request,chat:async()=>({tool:'ask',args:{question:'测试停靠'}})});}tick(){}};
(async()=>{
  const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'测试模型',model:'fixture',baseUrl:'https://example.invalid/v1'});
  async function project(name){await a.dispatch('projectSave',{name});const p=a.data.projects[0];const j=agent.buildJob(a,{projectId:p.id,goal:name,allowWeb:false,fileMode:'off'});p.jobId=j.id;a.data.delegations.push(j);const r=await agent.act(a,j,'plan_task',{key:'work',title:name,criteria:'明确结果',steps:[{key:'confirm',kind:'external',tool:'request_confirmation',title:'确认信息'}]});await a.dispatch('connectorSave',{name:name+'会话',kind:'chat',target:'oc_'+p.id.replaceAll('-',''),projectId:p.id,enabled:false});return {j,c:a.data.connectors.at(-1),taskId:r.taskId};}
  const one=await project('发布预算');await agent.act(a,one.j,'ask',{key:'budget',question:'发布预算采用哪个版本？',suggestion:'采用最近确认的 4500 元，并保留旧版记录。',taskIds:[one.taskId]});
  const two=await project('确认发布日期');await a.dispatch('communicationPolicy',{connectorId:two.c.id,mode:'ask',intervalMinutes:60,maxSends:3,expiresAt:new Date(Date.now()+86400000).toISOString()});await agent.act(a,two.j,'request_confirmation',{taskId:two.taskId,connectorId:two.c.id,key:'date',body:'请确认是否周六发布。',expected:'负责人明确确认日期',respondentId:'ou_owner'});
  const three=await project('审核交付结果');await agent.act(a,three.j,'wait',{key:'reply',taskId:three.taskId,reason:'等审核回复',expected:'审核负责人确认交付结果',sourceIds:[],connectorIds:[three.c.id],respondentId:'ou_reviewer',deadlineAt:new Date(Date.now()-1000).toISOString()});followup.due(a,three.j);a.save();
  const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
