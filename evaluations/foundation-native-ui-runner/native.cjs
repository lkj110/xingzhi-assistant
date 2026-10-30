'use strict';
const path=require('node:path'),assert=require('node:assert/strict');
const originalProof=require('../foundation-minimal-runner/native-receipts.cjs');
async function install(app,options){
 return app.evaluate(({ipcMain,app,BrowserWindow,session},options)=>{
  const fs=process.getBuiltinModule('node:fs'),crypto=process.getBuiltinModule('node:crypto'),path=process.getBuiltinModule('node:path');
  const requireFile=process.getBuiltinModule('node:module').createRequire(options.policyFile),policy=requireFile(options.policyFile);
  const indexFile=path.join(app.getAppPath(),'dist/index.html');
  const {trustedSender}=requireFile(path.join(app.getAppPath(),'desktop/quick-capture.cjs'));
  const handler=ipcMain._invokeHandlers.get('assistant:call');if(typeof handler!=='function')throw Error('Original IPC handler unavailable');
  const main=BrowserWindow.fromId(options.mainWindowId);if(!main||main.isDestroyed())throw Error('Main window unavailable');
  const captureSession=session.fromPartition('quick-capture');
  if(main.webContents.session===captureSession)throw Error('Capture window cannot be main');
  const config={...options,profile:app.getPath('userData'),asar:app.getAppPath()},seen=new Set(),windows=new Map();let quittingAt=null;
  const append=row=>{const fd=fs.openSync(config.file,'a');try{fs.writeFileSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  app.on('before-quit',()=>{if(quittingAt===null){quittingAt=Date.now();append({kind:'shutdown-observed',at:quittingAt,profile:config.profile,phase:'f04',runId:config.runId});}});
  const stop=reason=>{try{fs.writeFileSync(path.join(config.output,'stopped.json'),JSON.stringify({error:reason,at:new Date().toISOString()})+'\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}};
  const roleOf=w=>w===main?'main':w?.webContents.session===captureSession?'capture':'unknown';
  function attach(w){
   if(!w||w.isDestroyed()||windows.has(w.id))return;
   const role=roleOf(w);windows.set(w.id,w);
   if(role!=='unknown'){
    const title='[F04 '+(role==='main'?'主窗口':'快速收集')+' '+config.runId.slice(0,8)+'] 行知助手';
    w.on('page-title-updated',e=>e.preventDefault());w.setTitle(title);w.webContents.on?.('dom-ready',()=>{if(!w.isDestroyed())w.setTitle(title);});w.on('ready-to-show',()=>{if(!w.isDestroyed())w.setTitle(title);});
    if(config.mode==='offline'){w.webContents.setBackgroundThrottling(false);w.hide();w.on('show',()=>w.hide());}
   }
   append({kind:'window-observed',at:Date.now(),windowId:w.id,senderId:w.webContents.id,role,title:w.getTitle().slice(0,120),profile:config.profile,phase:'f04'});
  }
  for(const w of BrowserWindow.getAllWindows())attach(w);
  app.on('browser-window-created',(_event,w)=>attach(w));
  const urlSummary=value=>{try{const u=new URL(value);if(!['file:','http:','https:'].includes(u.protocol))return '<'+u.protocol+' sha256='+crypto.createHash('sha256').update(value).digest('hex')+'>';u.username='';u.password='';u.search='';u.hash='';return u.href.slice(0,2048);}catch{return '<invalid>';}};
  ipcMain.removeHandler('assistant:call');
  ipcMain.handle('assistant:call',async(event,action,input)=>{
   const w=BrowserWindow.fromWebContents(event.sender);attach(w);
   const role=roleOf(w),trusted=role!=='unknown'&&trustedSender(w,event,indexFile);
   const origin={senderId:event.sender?.id??null,senderUrl:urlSummary(event.sender?.getURL?.()),frameUrl:urlSummary(event.senderFrame?.url),mainFrame:event.senderFrame===event.sender?.mainFrame,windowId:w?.id??null,windowRole:role,windowTitle:w?.getTitle().slice(0,120)||null,trusted,profile:config.profile,asar:config.asar,phase:'f04',runId:config.runId};
   const command=action==='uiCommand'?input?.action:action;
   const actionLabel=v=>typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(v)?v:'<invalid>';
   const labels={action:actionLabel(action),command:actionLabel(command)};
   const closed=Date.now()>=config.deadline||['STOP','f04/STOP','stopped.json'].some(p=>fs.existsSync(path.join(config.output,p)));
   const decision=policy.classify({role,trusted,action,input,taskId:config.taskId,closed});
   if(!decision.allowed){append({kind:'denied',...labels,...origin,at:Date.now(),boundary:'before-original-handler',reason:decision.reason,inputSummary:policy.inputSummary(input)});stop('NATIVE_COMMAND_REFUSED');return {error:'复测入口已停止：命令、窗口或参数不匹配',code:'NATIVE_COMMAND_REFUSED'};}
   const startedAt=Date.now(),invocationId=crypto.randomUUID(),key=event.sender.id+':'+action;
   const record=decision.kind!=='read'||!seen.has(key);seen.add(key);
   const args=decision.kind==='accept'?{id:input.input.id,command:'accept'}:action==='quickCaptureDraft'?{occupied:input.occupied}:undefined;
   const common={...labels,...origin,invocationId,startedAt,kindOfCall:decision.kind,...(args?{input:args}:{inputSummary:policy.inputSummary(input)})};
   if(record)append({kind:'received',...common,boundary:'before-original-handler'});
   let result;
   try{result=await handler(event,action,input);}catch(error){append({kind:'native-exception',...common,finishedAt:Date.now(),boundary:'original-handler-exception',errorName:error.name,code:error.code||null,committed:error.committed===true});stop('NATIVE_HANDLER_EXCEPTION');throw error;}
   const expectedShutdown=quittingAt!==null&&startedAt>=quittingAt&&result?.error==='应用正在退出'&&Object.keys(result).length===1&&(decision.kind==='read'||action==='quickCaptureState');
   if(record||result?.error){
    const task=decision.kind==='accept'?result?.data?.tasks?.find(t=>t.id===config.taskId):null;
    append({kind:'native-command',...common,finishedAt:Date.now(),boundary:'original-handler-returned',resultSha256:crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),error:result?.error?'handler-returned-error':null,expectedShutdown,code:result?.code||null,committed:result?.committed||false,task:task?{id:task.id,status:task.status,acceptedAt:task.acceptedAt||null,acceptedBy:task.acceptedBy||null,acceptanceHistory:task.acceptanceHistory||[]}:null});
   }
   if(result?.error&&!expectedShutdown)stop('NATIVE_COMMAND_ERROR');return result;
  });
  return {mainWindowId:main.id,mainSenderId:main.webContents.id,title:main.getTitle(),profile:config.profile,asar:config.asar};
 },{...options,policyFile:path.join(__dirname,'policy.cjs')});
}
function verify(options){
 const proof=originalProof.verify(options),r=proof.nativeReceipt;
 assert.equal(r.windowRole,'main');assert.equal(r.trusted,true);assert.equal(r.mainFrame,true);assert.equal(r.boundary,'original-handler-returned');
 const start=originalProof.records(options.file).find(x=>x.kind==='received'&&x.invocationId===r.invocationId);
 for(const key of ['senderId','windowId','senderUrl','frameUrl','windowRole','runId'])assert.equal(start[key],r[key]);
 return proof;
}
module.exports={install,verify,records:originalProof.records};
