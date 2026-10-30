'use strict';
// Observe the original packaged Electron handler. Never replace its business
// result or synthesize a human command in live mode.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {hash}=require('../../desktop/evidence-basis.cjs');
async function install(app,{file,output,deadline,phase,taskId,runId,mode}){
 await app.evaluate(({ipcMain,app,BrowserWindow},options)=>{
  const fs=process.getBuiltinModule('node:fs'),crypto=process.getBuiltinModule('node:crypto'),path=process.getBuiltinModule('node:path');
  const handler=ipcMain._invokeHandlers.get('assistant:call');if(typeof handler!=='function')throw Error('Native IPC observer unavailable');
  const config={...options,profile:app.getPath('userData'),asar:app.getAppPath()};globalThis.__minimalReceiptConfig=config;
  const title='[候选复测 '+options.phase+' '+options.runId.slice(0,8)+'] 行知助手';
  for(const window of BrowserWindow.getAllWindows()){window.on('page-title-updated',e=>e.preventDefault());window.setTitle(title);if(options.mode==='offline'){window.webContents.setBackgroundThrottling(false);window.hide();}}
  const append=value=>{const fd=fs.openSync(config.file,'a');try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const stop=reason=>{const f=path.join(config.output,'stopped.json');try{fs.writeFileSync(f,JSON.stringify({error:reason,at:new Date().toISOString()}),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}};
  ipcMain.removeHandler('assistant:call');
  ipcMain.handle('assistant:call',async(event,action,input)=>{
   const command=action==='uiCommand'?input?.action:action,args=action==='uiCommand'?input?.input||{}:input||{};
   const readOnly=['state','stateView','export','viewDetail','acceptanceSnapshot','groundingStatus','readSource','readArtifact','quickCaptureDetectionStatus'].includes(command);
   const acceptance=action==='uiCommand'&&command==='taskAction'&&args.command==='accept'&&args.id===config.taskId;
   const workflow=config.phase==='business'&&(['settings','saveProvider','captureSave','createTask','advance','stop'].includes(command)||command==='taskAction'&&args.command==='revise'&&args.id===config.taskId||action==='uiCommand'&&['confirmGroundingMarkers','recheckGroundingMarkers'].includes(command)&&args.id===config.taskId);
   const timed=Date.now()>=config.deadline||fs.existsSync(path.join(config.output,'STOP'))||fs.existsSync(path.join(config.output,'stopped.json'));
   if(!readOnly&&(timed||!acceptance&&!workflow)){
    append({kind:'denied',action,command,input:args,at:Date.now(),taskId:config.taskId,profile:config.profile});stop('NATIVE_COMMAND_REFUSED');return {error:'复测入口已停止：命令或身份不匹配',code:'NATIVE_COMMAND_REFUSED'};
   }
   const startedAt=Date.now(),invocationId=crypto.randomUUID();let result;
   if(!readOnly)append({kind:'received',invocationId,action,command,input:args,startedAt,senderId:event.sender.id,senderUrl:event.sender.getURL(),profile:config.profile,asar:config.asar});
   try{result=await handler(event,action,input);}catch(error){if(!readOnly)append({kind:'native-exception',invocationId,action,command,input:args,startedAt,finishedAt:Date.now(),error:error.message,code:error.code||null,committed:error.committed===true});stop('NATIVE_HANDLER_EXCEPTION');throw error;}
   if(!readOnly){
    const task=result?.data?.tasks?.find(t=>t.id===args.id),record={kind:'native-command',invocationId,action,command,input:args,startedAt,finishedAt:Date.now(),senderId:event.sender.id,senderUrl:event.sender.getURL(),profile:config.profile,asar:config.asar,resultSha256:crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),error:result?.error||null,code:result?.code||null,committed:result?.committed||false,task:task?{id:task.id,status:task.status,acceptedAt:task.acceptedAt||null,acceptedBy:task.acceptedBy||null,acceptanceHistory:task.acceptanceHistory||[]}:null};append(record);
    if(result?.error)stop('NATIVE_COMMAND_ERROR');
   }
   return result;
  });
 },{file,output,deadline,phase,taskId,runId,mode});
}
async function select(app,taskId){await app.evaluate((_electron,id)=>{globalThis.__minimalReceiptConfig.taskId=id;},taskId);}
function records(file){return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(v=>JSON.parse(v)):[];}
function verify({file,profile,taskId,exported}){
 const commands=records(file);assert.equal(commands.filter(r=>r.kind==='denied').length,0);
 const accepted=commands.filter(r=>r.kind==='native-command'&&r.command==='taskAction'&&r.input?.command==='accept'&&r.input.id===taskId);assert.equal(accepted.length,1,'Exactly one native accept receipt per task');
 const receipt=accepted[0];assert.equal(receipt.action,'uiCommand');assert.equal(receipt.error,null);assert.equal(receipt.profile,profile);assert.equal(receipt.task?.status,'completed');assert.equal(receipt.task.acceptedBy,'user');
 assert.equal(commands.filter(r=>r.kind==='received'&&r.invocationId===receipt.invocationId).length,1);assert.equal(commands.filter(r=>r.kind==='native-exception').length,0);
 const dir=path.join(profile,'workspace'),workspace=JSON.parse(fs.readFileSync(path.join(dir,'workspace.json'))),journal=JSON.parse(fs.readFileSync(path.join(dir,'work-journal.json')));
 const raw=workspace.tasks.find(t=>t.id===taskId),visible=exported.tasks.find(t=>t.id===taskId),events=journal.events.filter(e=>e.entityId===taskId&&e.type==='accepted');assert.equal(events.length,1);
 const event=events[0];assert.equal(raw.status,'completed');assert.equal(raw.acceptedBy,'user');assert.equal(raw.acceptedAt,receipt.task.acceptedAt);assert.ok(raw.acceptanceHistory.some(r=>r.eventId===event.eventId));assert.ok(receipt.task.acceptanceHistory.some(r=>r.eventId===event.eventId));
 assert.ok(Date.parse(event.at)>=receipt.startedAt&&Date.parse(event.at)<=receipt.finishedAt);assert.equal(visible.acceptedAt,raw.acceptedAt);assert.deepEqual(visible.grounding,raw.grounding);assert.equal(raw.grounding.reportHash,hash({...raw.grounding,reportHash:undefined}));
 return {taskId,profile,eventId:event.eventId,commitId:event.commitId,acceptedAt:raw.acceptedAt,nativeReceipt:receipt,reportHash:raw.grounding.reportHash,rawExportEqual:true};
}
module.exports={install,select,records,verify};
