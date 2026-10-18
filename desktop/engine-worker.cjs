// Single owner of Assistant, its schedulers, workspace writes and credentials in
// use. No Electron module or renderer-provided native URL is loaded here.
const {parentPort,workerData,isMainThread}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {createVault}=require('./native-bridge.cjs');
const quick=require('./quick-capture.cjs');
const errorData=error=>({message:error.message||'业务执行失败',code:error.code,...(typeof error.committed==='boolean'?{committed:error.committed}:{})});

function createEngine({assistant:a,native,emit=()=>{}}){
  const runtime=require('./runtime.cjs'),deadline=require('./deadline-scheduler.cjs');
  let closing=false,sequence=0,mirrorScheduled=null,timer,folderTimer,notifying=null;
  const active=new Set();
  const ensureRunning=()=>{if(closing)throw Object.assign(Error('应用正在退出'),{code:'ENGINE_CLOSING'});};
  const callNative=async(action,input)=>{ensureRunning();const result=await native(action,input);ensureRunning();return result;};
  function mirror(){
    const value={sequence:++sequence,quickCapture:quick.preference(a.data),pending:require('./pending-badges.cjs').counts(a.data)};
    emit({type:'mirror',mirror:value});return value;
  }
  function scheduleMirror(){if(closing||mirrorScheduled)return;mirrorScheduled=setImmediate(()=>{mirrorScheduled=null;try{mirror();}catch(error){report(error);}});}
  function report(error){emit({type:'backgroundError',error:errorData(error)});}
  function background(promise){Promise.resolve(promise).catch(report);}
  const saved=a.onStateSaved;a.onStateSaved=()=>{saved?.();scheduleMirror();};
  quick.migratePreference(a);
  const capture=quick.createBusiness(a);
  a.streamController=require('./chat-streams.cjs').create(a);
  const tick=a.tick.bind(a);a.tick=()=>{if(!closing)return tick();};

  // Override the dispatch boundary, so core's uiCommand AsyncLocalStorage also
  // applies to desktop commands that return publicState after a native dialog.
  const dispatch=a.dispatch.bind(a);
  a.dispatch=async(action,input={})=>{
    ensureRunning();
    switch(action){
      case 'sourceOriginOpen':
        await callNative('openExternal',{url:require('./capture-provenance.cjs').sourceURL(a.data,input)});return {opened:true};
      case 'accessOpenLink': {
        const access=require('./access.cjs'),link=access.opening(a,input);
        await callNative('openExternal',{url:link.url});
        // Revalidate the live session after the OS call; a concurrent cancellation
        // or replacement must never start polling the old authorization session.
        const current=access.opening(a,input);if(current.url!==link.url)throw Error('授权链接已变化，请重新连接');
        current.start?.();return a.publicState();
      }
      case 'runtimeStatus':return {...a.data.runtime,...await callNative('runtimeStatus')};
      case 'runtimeStartup':return callNative('runtimeStartup',{enabled:input.enabled===true});
      case 'chooseCapabilityFolder': {
        const result=await callNative('chooseFolder',{title:'选择能力仓库目录',properties:['openDirectory']});
        return {path:result.canceled?'':fs.realpathSync(result.filePaths[0])};
      }
      case 'chooseBriefingFolder': {
        a.ensureIdle();const result=await callNative('chooseFolder',{title:'选择工作简报保存目录',properties:['openDirectory','createDirectory']});a.ensureIdle();
        const schedule=require('./briefing-schedule.cjs');return result.canceled?schedule.snapshot(a):schedule.setFolder(a,result.filePaths[0]);
      }
      case 'briefingScheduleOpen':
        await callNative('showItemInFolder',{path:require('./briefing-schedule.cjs').resultPath(a,input.id)});return {ok:true};
      case 'agentOpenResult': {
        const record=a.data.agentActions.find(r=>r.id===input.actionId&&(r.status==='done'||r.status==='uncertain'&&r.tool==='lark_create'&&r.result?.created));
        if(!record)throw Error('执行记录不存在');
        if(record.result?.path){
          const target=input.version==='history'?record.result.path:record.result.latestPath||record.result.path;
          if(!fs.lstatSync(target).isFile())throw Error('交付文件已移除');
          await callNative('showItemInFolder',{path:target});
        }else{
          const url=new URL(record.result.url);
          if(['lark_create','lark_update'].includes(record.tool))require('./lark-connector.cjs').docTarget(url.href);
          else if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password)throw Error('外部记录地址无效');
          await callNative('openExternal',{url:url.href});
        }
        return {ok:true};
      }
      case 'chooseOutputFolder': {
        a.ensureIdle();const result=await callNative('chooseFolder',{title:'选择 Agent 产出文件夹',properties:['openDirectory','createDirectory']});a.ensureIdle();
        if(!result.canceled){const previous=a.data.agentSettings.outputFolder;a.data.agentSettings.outputFolder=fs.realpathSync(result.filePaths[0]);try{a.save();}catch(error){if(!error.committed)a.data.agentSettings.outputFolder=previous;throw error;}}
        return a.publicState();
      }
      case 'chooseFolder': {
        a.ensureIdle();const result=await callNative('chooseFolder',{title:'选择要收集材料的文件夹',properties:['openDirectory']});a.ensureIdle();
        if(!result.canceled){
          const folder=fs.realpathSync(result.filePaths[0]);
          if(!a.data.folders.some(f=>f.path===folder))a.data.folders.push({id:randomUUID(),path:folder,name:path.basename(folder),enabled:input.configureFirst!==true,projectId:null,health:input.configureFirst?'paused':'unchecked',addedAt:new Date().toISOString()});
          require('./collection-permissions.cjs').configure(a,'folder',a.data.folders.find(f=>f.path===folder),{trusted:true,command:'chooseFolder'});
          a.save();if(input.configureFirst!==true)await require('./folders.cjs').syncAllFolders(a);
        }
        return a.publicState();
      }
      case 'removeFolder':return require('./folders.cjs').dispatch(a,'folderRemove',input);
      case 'syncFolders':return require('./folders.cjs').dispatch(a,'folderSync',input);
      case 'openStorage':return callNative('openStorage',{path:a.dir});
      case 'saveExport': {
        const result=await callNative('saveExport',{title:'导出工作空间（不含密钥）',defaultPath:`行知工作空间-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'JSON',extensions:['json']}]});
        if(!result.canceled){const data=await dispatch('export');ensureRunning();const fd=fs.openSync(result.filePath,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
        return {ok:!result.canceled};
      }
      default:return dispatch(action,input);
    }
  };
  async function notifyAttention(){
    if(closing||a.readOnlyRecovery||a.data.runtime?.workJournalError)return;
    const availability=await callNative('attentionAvailable');if(!availability?.supported||availability.focused)return;
    const attention=require('./attention.cjs'),events=require('./deadline-events.cjs'),pending=attention.pendingNotifications(a);
    if(!pending.count)return;
    const attempts=events.beginNotifications(a,pending.items.filter(i=>i.eventId),{epoch:deadline.epoch(a)}),other=pending.items.filter(i=>!i.eventId),count=attempts.length+other.length;
    if(!count)return;
    try{await callNative('notifyAttention',{count});events.finishNotifications(a,attempts,{status:'submitted'});attention.markNotified(a,other);}
    catch(error){events.finishNotifications(a,attempts,{status:'uncertain'});if(!closing)report(error);}
  }
  function notify(){if(closing||notifying)return;notifying=notifyAttention().catch(report).finally(()=>{notifying=null;});}
  deadline.subscribe(a,()=>{scheduleMirror();notify();});
  async function request(method,input={}){
    ensureRunning();
    if(method==='dispatch'){
      try{return await a.dispatch(input.action,input.input);}finally{if(!closing){a.streamController.reconcile();scheduleMirror();}}
    }
    if(method==='preferences'){
      if(!input||typeof input!=='object'||Array.isArray(input))throw Error('快速捕获开关格式无效');
      const patch={};for(const key of ['enabled','selectionEnabled','screenshotEnabled'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')throw Error('快速捕获开关格式无效');patch[key]=input[key];}
      const previous=a.data.runtime.quickCapture;a.data.runtime.quickCapture={...quick.preference(a.data),...patch};
      try{a.save();}catch(error){if(!error.committed)a.data.runtime.quickCapture=previous;throw error;}
      mirror();return quick.preference(a.data);
    }
    if(method==='capture'){
      if(input.action==='validateTask'){require('./capture-target.cjs').normalize(a,{kind:'task',taskId:input.input.taskId});return {ok:true};}
      if(!['state','submit','suggest','retry'].includes(input.action))throw Error('未知快速收集操作');
      return capture[input.action](input.input);
    }
    if(method==='control'){
      if(input.action==='suspend'){runtime.suspend(a);return {ok:true};}
      if(input.action==='resume'){try{await runtime.resume(a);}catch(error){a.event('运行恢复需要处理',error.message,null,'warning');a.save();throw error;}return {ok:true};}
      if(input.action==='connectivity'){runtime.connectivity(a,input.input?.online===true);return {ok:true};}
      if(input.action==='stop'){a.stop();return {ok:true};}
    }
    throw Error('未知业务进程请求');
  }
  function handle(method,input){
    // Deliberately no global promise tail: independent executions, stop and
    // cancellation must remain concurrent while saves stay on this one thread.
    const promise=request(method,input);active.add(promise);promise.then(()=>active.delete(promise),()=>active.delete(promise));return promise;
  }
  function start(){
    mirror();a.streamController.reconcile();
    timer=setInterval(()=>{try{a.tick();scheduleMirror();notify();}catch(error){report(error);}},15000);
    folderTimer=setInterval(()=>background((async()=>{try{if(!closing&&require('./stewardship.cjs').canAutomate(a))await require('./folders.cjs').syncAllFolders(a);}catch(error){if(!closing){a.event('文件夹同步失败',error.message,null,'error');a.save();}}})()),300000);
  }
  async function close(){
    closing=true;a.suspended=true;clearInterval(timer);clearInterval(folderTimer);clearImmediate(mirrorScheduled);
    const sessions=[...(a.accessSessions?.values()||[])].map(s=>s.promise).filter(Boolean);
    require('./access.cjs').cancel(a);a.streamController.dispose();capture.dispose();deadline.dispose(a);require('./execution.cjs').abortAll(a);
    try{await Promise.allSettled([...active,a.runPromise,a.streamController.settled(),notifying,...sessions].filter(Boolean));a.save();}
    finally{deadline.dispose(a);clearImmediate(mirrorScheduled);}
  }
  return {handle,start,close};
}

async function boot(){
  const nativeRequests=new Map();let nextId=0,engine,closing=false;
  const native=(action,input)=>new Promise((resolve,reject)=>{
    if(closing){reject(Error('应用正在退出'));return;}
    const id=++nextId;nativeRequests.set(id,{resolve,reject});parentPort.postMessage({type:'native',id,action,input});
  });
  parentPort.on('message',message=>{
    if(message.type==='nativeResult'){
      const pending=nativeRequests.get(message.id);if(!pending)return;nativeRequests.delete(message.id);
      if(message.error)pending.reject(Object.assign(Error(message.error.message),message.error));else pending.resolve(message.result);return;
    }
    if(message.type!=='request')return;
    const respond=(result,error)=>{try{parentPort.postMessage({type:'result',id:message.id,result,...(error?{error:errorData(error)}:{})});}catch{parentPort.postMessage({type:'result',id:message.id,error:{message:'业务响应无法传输',code:'ENGINE_SERIALIZATION'}});}};
    if(message.method==='shutdown'){
      closing=true;for(const row of nativeRequests.values())row.reject(Error('应用正在退出'));nativeRequests.clear();
      engine.close().then(()=>respond({closed:true}),error=>respond(undefined,error)).finally(()=>{parentPort.close();process.exit(0);});return;
    }
    if(closing){respond(undefined,Error('应用正在退出'));return;}
    engine.handle(message.method,message.input).then(result=>respond(result),error=>respond(undefined,error));
  });
  const {Assistant}=require('./core.cjs');
  const options={dir:workerData.dir,vault:createVault(parentPort)};
  let a;
  if(workerData.fixtureModule){
    // Fixtures are explicit local test dependencies. Never load a renderer path,
    // repository fixture with main-process monkeypatches, or production data.
    const temporary=fs.realpathSync(os.tmpdir())+path.sep,fixture=fs.realpathSync(workerData.fixtureModule);
    const dir=fs.existsSync(workerData.dir)?fs.realpathSync(workerData.dir):path.join(fs.realpathSync(path.dirname(workerData.dir)),path.basename(workerData.dir));
    if(!fixture.startsWith(temporary)||!dir.startsWith(temporary))throw Error('Engine fixtures require temporary module and workspace paths');
    a=await require(fixture).create({Assistant,options});
  }else a=new Assistant(options);
  engine=createEngine({assistant:a,native,emit:message=>parentPort.postMessage(message)});engine.start();parentPort.postMessage({type:'ready'});
  process.once('unhandledRejection',()=>{closing=true;parentPort.postMessage({type:'fatal',error:{message:'业务后台执行失败，已停止以保护工作空间',code:'ENGINE_BACKGROUND_FAILED'}});void engine.close().then(()=>process.exit(1),()=>process.exit(1));});
}
if(!isMainThread&&workerData?.kind==='assistant-engine')boot().catch(error=>{parentPort.postMessage({type:'fatal',error:errorData(error)});parentPort.close();});
module.exports={createEngine};
