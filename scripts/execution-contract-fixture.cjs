// Isolated UI fixture; no real models, accounts or workspace files.
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
let a;
app.whenReady().then(async()=>{
 if(!process.env.ASSISTANT_TEST_DATA_DIR)throw Error('Test directory required');
 a=new Assistant({dir:process.env.ASSISTANT_TEST_DATA_DIR,chat:async()=>{throw Error('No paid model in UI fixture');},connectorRequest:async args=>{if(args[1]!=='status')throw Error('No external writes in UI fixture');return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'fixture-user',userName:'测试账号',scope:require('../desktop/access.cjs').scopes('my_library').join(' ')}}};}});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 const j=agent.buildJob(a,{goal:'原始范围：全站调查'});a.data.delegations.push(j);
 await agent.act(a,j,'plan_task',{key:'handover',title:'隔离测试交接',criteria:'按确认范围交接',steps:[{key:'draft',kind:'draft',title:'主稿'},{key:'report',kind:'analysis',title:'辅助检查'}]});
 const task=a.task(j.taskIds[0]);for(const [i,step] of task.steps.entries()){step.done=true;step.artifactId='artifact-'+i;a.data.artifacts.push({id:step.artifactId,taskId:task.id,stepId:step.id,title:step.title,content:i?'辅助检查内容':'当前交接主稿',createdAt:new Date().toISOString()});}
 const beforeGrant=structuredClone(j);j.status='paused';j.larkCreateGrant={target:'my_library',openId:'fixture-user',userName:'测试账号'};require('../desktop/access-policy-store.cjs').syncTrustedJob(a,j,{before:beforeGrant,trusted:true,actor:'user_command',command:'fixture_grant'});a.save();require('../desktop/onboarding.cjs').dismiss(a);
 ipcMain.handle('assistant:call',async(_e,action,input)=>{try{return {data:await a.dispatch(action,input)};}catch(e){return {error:e.message};}});
 const window=new BrowserWindow({width:1300,height:950,webPreferences:{preload:path.join(__dirname,'../desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false}});await window.loadFile(path.join(__dirname,'../dist/index.html'));
});
app.on('before-quit',()=>a?.stop());
