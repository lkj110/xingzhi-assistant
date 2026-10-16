const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const ACCELERATOR='CommandOrControl+Shift+Space';
const FLAG='--assistant-quick-capture-supported',WINDOW_FLAG='--assistant-quick-capture-window';
const allowed=new Set(['quickCaptureState','quickCaptureSubmit','quickCaptureRetry','quickCaptureHide','quickCaptureOpenMain','screenshotRegion','screenshotClipboard','quickCaptureExpand','quickCaptureConsume','quickCaptureDraft','quickCaptureSuggest','quickCaptureResolve']);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const rows=value=>Array.isArray(value)?value:[];
function preference(data){const saved=data?.runtime?.quickCapture||{};return {version:2,enabled:saved.enabled===true,accelerator:ACCELERATOR,selectionEnabled:saved.selectionEnabled!==false,screenshotEnabled:saved.screenshotEnabled!==false};}
function retain(current,restored){restored.runtime ||= {};restored.runtime.quickCapture=preference(current);}
function revoke(data){data.runtime ||= {};data.runtime.quickCapture={version:2,enabled:false,selectionEnabled:false,screenshotEnabled:false,accelerator:ACCELERATOR};}
function trustedSender(window,event,indexFile){
 if(!window||window.isDestroyed()||event?.sender!==window.webContents||!event.senderFrame||event.senderFrame!==window.webContents.mainFrame)return false;
 try{const actual=new URL(event.senderFrame.url);actual.hash='';actual.search='';return actual.href===pathToFileURL(indexFile).href;}catch{return false;}
}
function submissionInput(input){
 if(!object(input)||typeof input.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(input.requestId))throw Error('快速收集请求标识无效');
 if(input.projectId!==undefined&&input.projectId!==null&&typeof input.projectId!=='string'||typeof input.projectId==='string'&&input.projectId.length>300)throw Error('所属项目无效');
 if(input.organize!==undefined&&typeof input.organize!=='boolean')throw Error('整理选项无效');
 if(input.autoRetry!==undefined&&typeof input.autoRetry!=='boolean')throw Error('自动重试选项无效');
 const files=input.items??[],texts=input.textItems??[];
 if(!Array.isArray(files)||files.length>10||!Array.isArray(texts)||texts.length>1||!files.length&&!texts.length)throw Error('每次收集1段文字或最多10份文件');
 let bytes=0;
 const items=files.map(file=>{if(!object(file)||typeof file.title!=='string'||!file.title.trim()||file.title.length>300||typeof file.base64!=='string'||file.base64.length>13333336)throw Error('文件名称或大小无效');const size=Math.floor(file.base64.length*3/4)-(file.base64.endsWith('==')?2:file.base64.endsWith('=')?1:0);if(size>10000000)throw Error('单份文件最多10 MB');bytes+=size;return {title:file.title.trim(),base64:file.base64,...(file.provenance?{provenance:require('./capture-provenance.cjs').normalize(file.provenance)}:{})};});
 const textItems=texts.map(item=>{if(!object(item)||typeof item.title!=='string'||!item.title.trim()||item.title.length>300||typeof item.content!=='string'||!item.content.trim()||item.content.length>200000)throw Error('文字材料须有标题，正文最多20万字符');bytes+=Buffer.byteLength(item.content);return {title:item.title.trim(),content:item.content.trim(),origin:'快速收集'};});
 if(bytes>25000000)throw Error('本次材料合计最多25 MB');
 const advancement=require('./capture-advance.cjs').normalize(input.advancement);
 return {requestId:input.requestId,payload:{items,textItems,...(input.target?{target:input.target}:{}),...(input.provenance?{provenance:require('./capture-provenance.cjs').normalize(input.provenance)}:{}),projectId:input.projectId||null,organize:input.organize===true,...(advancement?{advancement}:{}),...(input.autoRetry===true?{autoRetry:true}:{})}};
}
function createController({assistant:a,adapter,BrowserWindow,globalShortcut,preload,indexFile,showMain,screenshot,screen,resolveSelection,platform=process.platform}){
 if((!a&&!adapter)||!BrowserWindow||!globalShortcut||!preload||!indexFile)throw Error('快速收集原生接口未就绪');
 if(!adapter)migratePreference(a);
 const business=adapter||createBusiness(a),config=()=>adapter?adapter.preference():preference(a.data);
 let window=null,quitting=false,wantShow=false,lastError='',ownedShortcut=false,viewRevision=0;
 let captureContext=null,mini=false,draftOccupied=false,resolving=false,draftRevision=0;
 const notify=()=>{if(window&&!window.isDestroyed())window.webContents.send?.('assistant:quick-capture-changed');};

 const registered=()=>{try{return ownedShortcut&&globalShortcut.isRegistered(ACCELERATOR);}catch{return false;}};
 function status(){return {supported:true,enabled:config().enabled,registered:registered(),accelerator:ACCELERATOR,acceleratorLabel:platform==='darwin'?'⌘ ⇧ 空格':'Ctrl + Shift + Space',error:lastError,windowOpen:!!window&&!window.isDestroyed()&&window.isVisible()};}
 function register(){
  if(registered())return true;
  // isRegistered refers only to this application. Never take over or unregister
  // a binding that this controller did not create.
  if(globalShortcut.isRegistered(ACCELERATOR))return false;
  const ok=globalShortcut.register(ACCELERATOR,()=>{try{open();}catch(error){lastError=`快速收集窗口无法打开：${error.message}`;}});
  ownedShortcut=ok===true;
  if(!ok||!registered()){if(ownedShortcut)try{globalShortcut.unregister(ACCELERATOR);}catch{}ownedShortcut=false;return false;}
  return true;
 }
 function unregister(){if(ownedShortcut){globalShortcut.unregister(ACCELERATOR);ownedShortcut=false;}}
 let reconciling=null,configurationTail=Promise.resolve();
 function reconcile(){
  if(quitting||reconciling)return status();
  if(!config().enabled){try{unregister();}catch(error){lastError=`无法释放快捷键：${error.message}`;}return status();}
  try{if(register())return status();throw Error('快捷键已被占用或系统未允许注册');}
  catch(error){lastError=`全局快捷键未启用：${error.message}`;if(adapter){reconciling=adapter.configure({enabled:false}).catch(()=>{lastError+='；设置暂未写入磁盘';}).finally(()=>{reconciling=null;});}else{a.data.runtime.quickCapture={...config(),enabled:false,accelerator:ACCELERATOR};try{a.save();}catch(saveError){lastError+='；设置暂未写入磁盘';}}return status();}
 }
 function configure(input){
  if(!object(input)||typeof input.enabled!=='boolean')throw Error('请明确选择是否启用全局快捷键');
  if(adapter){const job=configurationTail.then(()=>configureAsync(input));configurationTail=job.catch(()=>{});return job;}
  const previous=config(),wasRegistered=registered();lastError='';
  if(input.enabled){
   try{if(!register())throw Error('快捷键已被占用或系统未允许注册');}catch(error){lastError=`全局快捷键未启用：${error.message}`;throw Error(lastError);}
   a.data.runtime.quickCapture={...previous,enabled:true,accelerator:ACCELERATOR};
   try{a.save();}catch(error){a.data.runtime.quickCapture=previous;if(!wasRegistered)try{unregister();}catch{}lastError=`设置保存失败：${error.message}`;throw Error(lastError);}
  }else{
   a.data.runtime.quickCapture={...previous,enabled:false,accelerator:ACCELERATOR};
   try{a.save();}catch(error){a.data.runtime.quickCapture=previous;lastError=`设置保存失败：${error.message}`;throw Error(lastError);}
   try{unregister();}catch(error){lastError=`无法释放快捷键：${error.message}`;throw Error(lastError);}
  }
  return status();
 }
 async function configureAsync(input){
  if(quitting)throw Error('应用正在退出');
  const wasRegistered=registered();lastError='';
  if(input.enabled){try{if(!register())throw Error('快捷键已被占用或系统未允许注册');}catch(error){lastError=`全局快捷键未启用：${error.message}`;throw Error(lastError);}}
  try{await adapter.configure({enabled:input.enabled});}
  catch(error){if(input.enabled&&!wasRegistered)try{unregister();}catch{}lastError=`设置保存失败：${error.message}`;throw Error(lastError);}
  if(!input.enabled)unregister();
  return status();
 }
 function state(input={}){
  const merge=value=>({...value,captureContext,mini,captureVisible:wantShow,draftOccupied});
  const result=business.state(input);return adapter?Promise.resolve(result).then(merge):merge(result);
 }
 const suggest=input=>business.suggest(input),submit=input=>business.submit(input);
 function position(){if(!screen||!window)return;const point=screen.getCursorScreenPoint(),area=screen.getDisplayNearestPoint(point).workArea;window.setBounds({width:mini?288:500,height:mini?38:760,x:Math.max(area.x,Math.min(point.x+12,area.x+area.width-(mini?288:500))),y:Math.max(area.y,Math.min(point.y+12,area.y+area.height-(mini?38:760))) });}
 function openCapture(context,small=false){captureContext={...context,id:crypto.randomUUID()};mini=small;if(window&&!window.isDestroyed())window.setAlwaysOnTop?.(small);open(true);position();notify();return adapter?status():state();}
 // Keep the main application's foreground process type and Dock presence stable.
 // Electron otherwise hides the Dock icon while changing workspace visibility.
 function workspaces(win){win?.setVisibleOnAllWorkspaces?.(mini,{visibleOnFullScreen:mini,skipTransformProcessType:true});}
 function expand(){mini=false;workspaces(window);window?.setAlwaysOnTop?.(false);if(window&&!window.isDestroyed()){window.setMinimumSize(460,560);position();window.show();window.focus();}notify();return state();}
 function open(fromCapture=false){
  if(!fromCapture){mini=false;window?.setAlwaysOnTop?.(false);}
  if(quitting)throw Error('应用正在退出');viewRevision++;wantShow=true;
  if(window&&!window.isDestroyed()){window.setMinimumSize(mini?288:460,mini?38:560);workspaces(window);if(mini)window.showInactive();else {window.setSize(500,760);window.show();window.focus();}return status();}
  const win=new BrowserWindow({width:mini?288:500,height:mini?38:760,minWidth:mini?288:460,minHeight:mini?38:560,alwaysOnTop:mini,show:false,title:'行知 · 快速收集',backgroundColor:'#f8faf9',frame:false,roundedCorners:true,hasShadow:true,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'quick-capture',backgroundThrottling:false,additionalArguments:[FLAG,WINDOW_FLAG]}});window=win;workspaces(win);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  for(const event of ['will-navigate','will-frame-navigate','will-redirect','will-attach-webview'])win.webContents.on(event,event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));win.webContents.session.setPermissionCheckHandler(()=>false);
  win.on('close',event=>{if(!quitting){event.preventDefault();hide();}});
  win.on('closed',()=>{if(window===win)window=null;});
  win.once('ready-to-show',()=>{if(wantShow&&!win.isDestroyed()){if(mini)win.showInactive();else {win.show();win.focus();}}});
  win.loadFile(indexFile).catch(error=>{lastError=`快速收集页面未能载入：${error.message}`;});
  return status();
 }
 function hide(){wantShow=false;if(mini)captureContext=null;if(window&&!window.isDestroyed())window.hide();notify();return {hidden:true};}
 function dismissSelection(point){
  if(!mini||resolving||!window||window.isDestroyed()||!window.isVisible())return false;
  if(point!==null){
   if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return false;
   const bounds=window.getBounds();
   if(point.x>=bounds.x&&point.x<=bounds.x+bounds.width&&point.y>=bounds.y&&point.y<=bounds.y+bounds.height)return false;
  }
  hide();return true;
 }
 async function dispatchSmall(event,action,input={}){
  if(!trustedSender(window,event,indexFile))throw Error('无效的快速收集调用来源');
  if(!allowed.has(action))throw Error('快速收集窗口无权执行此操作');
  if(action==='quickCaptureResolve'){
   if(!object(input)||!captureContext?.requiresCopy||input.id!==captureContext.id||!resolveSelection)throw Error('选区已变化，请重新选择');
   if(resolving)throw Error('正在读取选区，请稍候');
   const current=captureContext,revision=draftRevision;resolving=true;
   try{
    const result=await resolveSelection(current.nativeToken);
    if(captureContext!==current||!wantShow||draftRevision!==revision)throw Error('草稿或选区已变化，请重新选择');
    if(typeof result?.text!=='string'||result.text.trim().length<2||result.text.length>20000)throw Error('未读取到选中文字，请重新选择');
    captureContext={...current,text:result.text,requiresCopy:false};delete captureContext.nativeToken;
    return expand();
   }catch(error){if(captureContext===current&&wantShow){captureContext=null;await Promise.resolve(expand()).catch(()=>{});}throw error;}
   finally{resolving=false;}
  }
  if(action==='screenshotRegion'||action==='screenshotClipboard'){if(!screenshot)throw Error('桌面截图暂不可用');return screenshot(action,window);}
  if(action==='quickCaptureSuggest')return suggest(input);
  if(action==='quickCaptureExpand')return expand();
  if(action==='quickCaptureConsume'){if(captureContext?.id===input.id)captureContext=null;return state();}
  if(action==='quickCaptureDraft'){draftOccupied=input.occupied===true;draftRevision++;return {ok:true};}
  if(action==='quickCaptureState')return state(input);
  if(action==='quickCaptureSubmit'){
   const revision=viewRevision;
   const result=await submit(input);
   const accepted=!result.warning&&['queued','processing','completed'].includes(result.receipt?.status);
   // A delayed receipt must never dismiss a newer selection or reopened draft.
   if(accepted&&revision===viewRevision){draftOccupied=false;hide();}
   return {...result,accepted,state:await state()};
  }
  if(action==='quickCaptureRetry'){if(!object(input))throw Error('收集重试参数无效');const result=await business.retry(input);return {...result,state:await state()};}
  if(action==='quickCaptureHide')return hide();
  if(input.page!==undefined&&!['capture','settings','board'].includes(input.page))throw Error('快速收集导航目标无效');
  hide();showMain?.(input.page||'capture');return {opened:true};
 }
 function dispatchMain(action,input={}){
  if(action==='quickCaptureOpen'){if(input.taskId){if(adapter)return adapter.validateTask(input.taskId).then(()=>openCapture({targetTaskId:input.taskId},false));require('./capture-target.cjs').normalize(a,{kind:'task',taskId:input.taskId});return openCapture({targetTaskId:input.taskId},false);}return open();}
  if(action==='quickCaptureStatus')return reconcile();
  if(action==='quickCaptureConfigure')return configure(input);
  throw Error('未知快速收集设置操作');
 }
 function dispose(){quitting=true;wantShow=false;if(!adapter)business.dispose();try{unregister();}catch{}if(window&&!window.isDestroyed())window.destroy();window=null;}
 return {open,openCapture,dismissSelection,canShowSelection:()=>!resolving&&(!draftOccupied||mini||!wantShow),hide,status,reconcile,configure,state,submit,dispatchSmall,dispatchMain,dispose,matchesWindow:event=>!!window&&!window.isDestroyed()&&event?.sender===window.webContents,window:()=>window};
}
function migratePreference(a){
 a.data.runtime ||= {};const previousPreference=a.data.runtime.quickCapture;const migrated=preference(a.data);a.data.runtime.quickCapture=migrated;if(JSON.stringify(previousPreference)!==JSON.stringify(migrated)){try{a.save();}catch(error){a.data.runtime.quickCapture=previousPreference;throw error;}}
}
function createBusiness(a){
 let submitting=0;
 const previewControllers=new Set();let disposed=false;
 const requests=new Map(),receipts=new Set(),previewCache=new Map();let previewTail=Promise.resolve(),previewGeneration=0;
 function suggest(input){
  const generation=++previewGeneration;
  const {payload}=require('./capture.cjs').validate(a,{textItems:input.text?[{title:'推荐预览',content:input.text}]:[],items:input.items||[],provenance:input.provenance});
  const job=previewTail.then(async()=>{
   if(disposed)throw Error('应用正在退出');
   if(generation!==previewGeneration)throw Error('已由更新的材料替换本次推荐');
   const controller=new AbortController();previewControllers.add(controller);
   try{
   let text=input.text||'';
   for(const item of payload.items){
    const hash=crypto.createHash('sha256').update(item.title).update(item.base64).digest('hex');let parsed=previewCache.get(hash);
    if(parsed===undefined){parsed=(await require('./documents.cjs').parse(item.title,Buffer.from(item.base64,'base64'),controller.signal)).content;if(previewCache.size>=10)previewCache.delete(previewCache.keys().next().value);previewCache.set(hash,parsed);}
    text+='\n'+parsed;
   }
   return require('./capture-target.cjs').suggest(a,{text:text.slice(0,500000),provenance:input.provenance});
   }finally{previewControllers.delete(controller);}
  });previewTail=job.catch(()=>{});return job;
 }

 function receipt(id){
  if(!id)return null;if(typeof id!=='string'||!receipts.has(id))throw Error('此收集回执不属于当前快速收集窗口');
  const row=rows(a.data.captureQueue).find(row=>row.id===id);if(!row)return {id,status:'missing',imported:false,error:'收集记录已变化，请到工作台核对后再提交'};
  return {id:row.id,targetKind:row.target?.kind,status:row.status,imported:!!row.importedAt,sourceCount:rows(row.sourceIds).length,organize:!!row.organize,jobId:row.jobId,taskId:row.taskId,advanceMessage:row.advanceMessage,advancedAt:row.advancedAt,error:row.lastError||'',stage:row.stage,...(row.autoRetry?{autoRetry:{enabled:row.autoRetry.enabled===true,used:row.autoRetry.used||0,nextRetryAt:row.autoRetry.nextRetryAt||null,retryable:row.autoRetry.retryable===true,maxAttempts:3}}:{})};
 }
 function state(input={}){
  if(!object(input))throw Error('快速收集状态参数无效');
  const gate=a.data.stewardship?require('./stewardship.cjs').status(a):null;
  const automatic={allowed:!a.suspended&&(gate?.automaticAllowed??true),message:a.suspended?'设备恢复后继续处理':gate?.message||'可按计划继续处理',nextAllowedAt:gate?.nextAllowedAt||null};
  return {automatic,tasks:require('./capture-target.cjs').list(a).map(task=>({...task,capabilityScope:require('./capture-advance.cjs').capabilityScope(a,{target:{kind:'task',taskId:task.id},projectId:task.projectId})})),capabilities:(a.data.capabilities||[]).filter(c=>c.enabled).map(c=>({id:c.id,name:c.name,enabled:true,allowedTools:c.allowedTools})),advanceAvailable:['organize','execute','verify'].every(role=>rows(a.data.providers).some(p=>p.id===a.data.settings?.roles?.[role])),projects:rows(a.data.projects).map(project=>({id:project.id,name:project.name,archived:!!project.archivedAt,capabilityScope:require('./capture-advance.cjs').capabilityScope(a,{projectId:project.id})})),busy:!!a.operation,organizeAvailable:rows(a.data.providers).some(provider=>provider.id===a.data.settings?.roles?.organize),receipt:receipt(input.receiptId),submitting:submitting>0};
 }
 async function submit(input){
  const {requestId,payload:rawPayload}=submissionInput(input),{payload}=require('./capture.cjs').validate(a,rawPayload),fingerprint=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),existing=requests.get(requestId);
  if(existing){if(existing.fingerprint!==fingerprint)throw Error('这次请求的材料已变化，请重新保存');if(existing.promise)await existing.promise;if(existing.error)throw Error(existing.error);return {state:state(),receipt:receipt(existing.receiptId),warning:existing.warning||'',reused:true};}
  if(requests.size>=100){const first=[...requests].find(([,entry])=>!entry.promise);if(first)requests.delete(first[0]);else throw Error('当前快速收集请求过多，请稍后重试');}
  const entry={fingerprint,receiptId:null,promise:null};requests.set(requestId,entry);submitting++;
  entry.promise=(async()=>{
   const before=new Set(rows(a.data.captureQueue).map(row=>row.id));
   // captureEnqueue performs its durable admission synchronously, before returning
   // its promise. Record that admission before another renderer can add material.
   const pending=a.dispatch('captureEnqueue',payload);
   const admitted=rows(a.data.captureQueue).filter(row=>!before.has(row.id)&&row.payloadHash===fingerprint).map(row=>row.id);
   let saved;
   try{saved=await pending;}catch(error){
    if(admitted.length===1){entry.receiptId=admitted[0];entry.warning='材料已入队，启动后续处理时发生错误；请在收集队列核对，勿重复提交。';receipts.add(entry.receiptId);return;}
    throw error;
   }
   const created=rows(saved?.captureQueue).filter(row=>!before.has(row.id));
   const id=admitted.length===1?admitted[0]:created.length===1?created[0].id:null;
   if(!id){entry.error='无法核对本次收集回执，请在工作台查看保存结果；相同请求不会重复入队';throw Error(entry.error);}
   entry.receiptId=id;receipts.add(id);
  })();
  try{await entry.promise;entry.promise=null;return {state:state(),receipt:receipt(entry.receiptId),warning:entry.warning||'',reused:false};}
  catch(error){entry.promise=null;if(!entry.error&&!entry.receiptId)requests.delete(requestId);throw error;}finally{submitting--;}
 }

 async function retry(input){receipt(input.receiptId);await a.dispatch('captureRetry',{id:input.receiptId});return {state:state(),receipt:receipt(input.receiptId)};}
 return {suggest,state,submit,retry,dispose(){disposed=true;previewGeneration++;for(const controller of previewControllers)controller.abort();previewCache.clear();}};
}
module.exports={createController,createBusiness,migratePreference,retain,revoke,preference,trustedSender,submissionInput,ACCELERATOR,FLAG,WINDOW_FLAG};
