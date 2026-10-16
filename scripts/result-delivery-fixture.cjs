// Isolated result presentation; all actions are local fixtures, never external writes.
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),acceptance=require('../desktop/acceptance.cjs');
let a,modelCalls=0,externalCalls=0;const opened=[];
app.whenReady().then(async()=>{
 if(!process.env.ASSISTANT_TEST_DATA_DIR)throw Error('Isolated directory required');
 a=new Assistant({dir:process.env.ASSISTANT_TEST_DATA_DIR,chat:async()=>{modelCalls++;throw Error('No model in fixture');},connectorRequest:async()=>{externalCalls++;throw Error('No external connection in fixture');}});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 for(const [i,tool] of ['lark_create','github_create','write_file'].entries()){
  const title=['飞书交付测试','GitHub 交付测试','文件交付测试'][i],job=agent.buildJob(a,{goal:title});a.data.delegations.push(job);
  await agent.act(a,job,'plan_task',{key:'result',title,criteria:'交付主稿并验收',steps:[{key:'draft',kind:'draft',title:'文稿'},{key:'delivery',kind:'external',tool,title:'交付'}]});
  const task=a.task(job.taskIds[0]),artifact={id:'artifact-'+i,taskId:task.id,stepId:task.steps[0].id,title:'本地文稿 '+i,content:'这是完整的当前业务文稿。',createdAt:new Date().toISOString()};a.data.artifacts.push(artifact);Object.assign(task.steps[0],{done:true,artifactId:artifact.id});
  const hash=crypto.createHash('sha256').update(artifact.content).digest('hex'),result=tool==='lark_create'?{url:'https://fixture.feishu.cn/docx/Result123',documentId:'Result123',submittedHash:hash,readbackHash:'readback',verified:true}:tool==='github_create'?{url:'https://github.com/fixture/work/issues/42',number:42,verified:true}:{path:path.join(a.dir,'version.md'),latestPath:path.join(a.dir,'final.md'),hash,latestHash:hash,format:'md',verified:true};
  const action={id:'action-'+i,jobId:job.id,taskId:task.id,artifactId:artifact.id,title:task.title,content:artifact.content,tool,status:'done',target:tool==='lark_create'?'my_library':tool==='github_create'?'fixture/work':result.path,result,finishedAt:new Date().toISOString()};a.data.agentActions.push(action);Object.assign(task.steps[1],{done:true,evidence:JSON.stringify({actionId:action.id})});
  if(tool==='write_file')job.outputFolder=a.dir;
  require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{job,task});
  task.status='review';task.verification={passed:true,summary:'内容和实际交付已核对，等待用户验收。',gaps:[],at:new Date().toISOString()};task.verification.basis=acceptance.basis(a,task);job.status='review';
 }
 for(const job of a.data.delegations){const task=a.task(job.taskIds[0]);task.verification.basis=acceptance.basis(a,task);acceptance.recordCompletionCheck(a,job,{passed:true,summary:'隔离样例交付完整',gaps:[]},{basis:acceptance.completionBasis(a,job)});}
 require('../desktop/onboarding.cjs').dismiss(a);a.save();
 ipcMain.handle('assistant:call',async(_e,action,input)=>{try{
  // Match native interceptions through both legacy calls and the UI envelope.
  // Keep the original envelope below so core still applies its UI projection.
  const requestedAction=action==='uiCommand'?input?.action:action,requestedInput=action==='uiCommand'?input?.input:input;
  if(requestedAction==='agentOpenResult'){const record=a.data.agentActions.find(r=>r.id===requestedInput?.actionId);if(!record||record.status!=='done')throw Error('执行记录不存在');opened.push(record.id);return {data:{ok:true}};}
  if(requestedAction==='fixtureOpened')return {data:opened};
  if(requestedAction==='fixtureStats')return {data:{modelCalls,externalCalls}};
  if(requestedAction==='fixtureRevise'){const task=a.data.tasks.find(t=>t.title==='飞书交付测试');a.data.artifacts.find(r=>r.taskId===task.id).content+=' 尚未重新发布的修改';a.save();return {data:a.publicState()};}
  return {data:await a.dispatch(action,input)};
 }catch(error){return {error:error.message};}});
 const window=new BrowserWindow({width:1100,height:900,webPreferences:{preload:path.join(__dirname,'../desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false}});await window.loadFile(path.join(__dirname,'../dist/index.html'));
});
app.on('before-quit',()=>a?.stop());
