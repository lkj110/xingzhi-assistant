const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const SCREENSHOT_KEY='CommandOrControl+Shift+2';
function create({assistant:a,adapter,globalShortcut,systemPreferences,capture,openCapture,canShow,dismissSelection,platform=process.platform,run=spawn,now=Date.now,copyTimeout=4000}){
 let child=null,error='',owned=false,trusted=false,starting=false,disposed=false,epoch=0;
 let candidate=null,cancelCopy=null;
 const helper=platform==='win32'?require('./windows-native.cjs').nativePath('bin/windows-capture.exe'):path.join(__dirname,'native/bin/selection-capture').replace('app.asar/','app.asar.unpacked/');
 const accessible=()=>platform==='win32'||platform==='darwin'&&systemPreferences.isTrustedAccessibilityClient(false);
 let captureDiagnostic={stage:'waiting',events:0,selections:0,reads:0,lastRead:'waiting'};
 const dismissReasons=new Set(['selection_cleared','scroll','keyboard','app_changed']);
 const stages=new Set(['gesture_received','selection_changed','focus_unavailable','selection_unavailable','selection_empty','selection_read','read_started','own_app','focus_changed','copy_candidate']);
 const config=()=>adapter?adapter.preference():require('./quick-capture.cjs').preference(a.data);
 function stop(){epoch++;candidate=null;cancelCopy?.();if(child){child.kill();child=null;}starting=false;}
 function resolve(token){
  if(disposed||!config().selectionEnabled||!trusted||!accessible())return Promise.reject(Error('选区读取已关闭或辅助功能授权已失效'));
  if(cancelCopy)return Promise.reject(Error('正在读取选区，请稍候'));
  if(!candidate||candidate.token!==token||now()-candidate.at>45000)return Promise.reject(Error('选区已过期，请回到原应用重新选择'));
  const target=candidate;candidate=null;
  return new Promise((resolve,reject)=>{
   let copy,buffer='',done=false;
   const finish=(error,text)=>{if(done)return;done=true;clearTimeout(timer);cancelCopy=null;copy?.kill();if(error)reject(error);else resolve({text});};
   const timer=setTimeout(()=>finish(Error('读取选区超时，请重新选择；也可复制后粘贴到小窗')),copyTimeout);
   cancelCopy=()=>finish(Error('选区读取已取消'));
   try{
    copy=run(helper,['--copy-selection'],{stdio:['pipe','pipe','ignore'],windowsHide:true});
    copy.on('error',()=>finish(Error('无法启动选区兼容组件')));
    copy.on('close',()=>finish(Error('未读取到选区，请重新选择；也可复制后粘贴到小窗')));
    copy.stdout.on('data',bytes=>{
     buffer+=bytes;if(buffer.length>200000){finish(Error('选区过长，请缩小选择范围'));return;}
     let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let result;try{result=JSON.parse(line);}catch{continue;}
      if(result?.type!=='copy_result')continue;
      if(typeof result.text==='string'&&result.text.trim().length>=2&&result.text.length<=20000){captureDiagnostic.selections++;captureDiagnostic.stage='selection_read';finish(null,result.text.trim());}
      else finish(Error(typeof result.error==='string'?result.error.slice(0,300):'未读取到选中文字，请重新选择'));
     }
    });
    copy.stdin.on('error',()=>finish(Error('选区读取已中断')));
    copy.stdin.end(JSON.stringify({pid:target.pid,bundleId:target.bundleId,windowTitle:target.windowTitle,...(Number.isSafeInteger(target.windowHandle)?{windowHandle:target.windowHandle}:{})})+'\n');
   }catch{finish(Error('无法启动选区兼容组件'));}
  });
 }
 function status(){return {captureDiagnostic:{...captureDiagnostic},selectionEnabled:config().selectionEnabled===true,screenshotEnabled:config().screenshotEnabled===true,screenshotRegistered:owned,selectionRunning:!!child&&trusted,platform,screenPermission:platform==='win32'?'granted':platform==='darwin'?(systemPreferences.getMediaAccessStatus?.('screen')||'unknown'):'unsupported',accessibilityTrusted:accessible(),captureError:error|| (config().selectionEnabled&&platform==='darwin'&&!systemPreferences.isTrustedAccessibilityClient(false)?'选区弹窗已开启，等待辅助功能授权':''),screenshotKey:platform==='darwin'?'⌘ ⇧ 2':'Ctrl + Shift + 2'};}
 async function screenshot(){try{const result=await capture();if(!result.cancelled)openCapture({image:result,origin:'框选截图',provenance:{kind:'screenshot',capturedAt:new Date().toISOString()}},false);}catch(e){error=e.message;}}
 function start(){
  if(child||starting||disposed)return;starting=true;const current=++epoch;trusted=false;
  let buffer='';
  try {
   child=run(helper,platform==='win32'?['--selection',String(process.pid)]:[],{stdio:['ignore','pipe','ignore'],windowsHide:true});
   child.on('error',()=>{if(epoch===current){error='无法启动选中文字收集组件';child=null;starting=false;}});
   child.stdout.on('data',bytes=>{
    if(epoch!==current)return;
    buffer+=bytes;if(buffer.length>200000){stop();error='选择内容过长，已停止自动弹窗';return;}
    let end;
    while((end=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let item;
     try{item=JSON.parse(line);}catch{continue;}
     if(!item||typeof item!=='object')continue;
     if(item.type==='dismiss'&&!cancelCopy){
      const point=Number.isFinite(item.x)&&Number.isFinite(item.y)?{x:item.x,y:item.y}:null;
      if((point||dismissReasons.has(item.reason))&&dismissSelection?.(point))candidate=null;
     }
     if(item.type==='status'){trusted=item.trusted===true;error=trusted?'':'需要在系统设置 → 隐私与安全性 → 辅助功能中允许行知助手';}
     if(item.type==='error')error=typeof item.message==='string'?item.message.slice(0,500):'选区监听出现错误';
     if(item.type==='diagnostic'&&stages.has(item.stage)){
      captureDiagnostic.stage=item.stage;
      if(item.stage==='read_started')captureDiagnostic.reads++;
      if(['selection_unavailable','selection_empty','selection_read','focus_unavailable','focus_changed','own_app'].includes(item.stage))captureDiagnostic.lastRead=item.stage;
      if(['gesture_received','selection_changed'].includes(item.stage))captureDiagnostic.events++;
     }
     const copyCandidate=item.type==='candidate'&&Number.isInteger(item.pid)&&item.pid>0&&typeof item.bundleId==='string'&&item.bundleId.length>0&&item.bundleId.length<300&&typeof item.windowTitle==='string'&&item.windowTitle.length<=500&&!['local.xingzhi.assistant','com.github.Electron'].includes(item.bundleId);
     const directSelection=item.type==='selection'&&typeof item.text==='string'&&item.text.trim().length>=2&&item.text.length<=20000;
     if((directSelection||copyCandidate)&&trusted&&config().selectionEnabled){
      if(directSelection)captureDiagnostic.selections++;
      if(!canShow()){captureDiagnostic.stage='draft_occupied';continue;}
      if(cancelCopy)continue;
      candidate=copyCandidate?{token:randomUUID(),at:now(),pid:item.pid,bundleId:item.bundleId,windowTitle:item.windowTitle,...(Number.isSafeInteger(item.windowHandle)?{windowHandle:item.windowHandle}:{})}:null;
      try{const provenance={kind:'selection',capturedAt:new Date().toISOString(),...Object.fromEntries(['appName','bundleId','windowTitle'].map(k=>[k,k==='appName'?item.app:item[k]]).filter(([,v])=>typeof v==='string'))};if(typeof item.url==='string'){try{provenance.url=require('./capture-provenance.cjs').normalize({url:item.url}).url;}catch{}}openCapture({...copyCandidate?{requiresCopy:true,nativeToken:candidate.token}:{text:item.text},origin:item.app||'选中文字',provenance},true);captureDiagnostic.stage='popup_shown';error='';}
      catch(e){captureDiagnostic.stage='popup_failed';error=`选区已读取，但无法显示记录弹窗：${e.message}`;}
     }
    }
   });
   child.on('close',()=>{if(epoch===current){child=null;starting=false;}});
  }catch(e){starting=false;error=e.message;}

 }
 function reconcile(){
  if(disposed)return status();
  if(config().selectionEnabled&&accessible())start();else if(child)stop();
  if(config().screenshotEnabled&&!owned){owned=globalShortcut.register(SCREENSHOT_KEY,screenshot);if(!owned)error='截图快捷键被占用，可在小窗内点击框选截图';}
  if(!config().screenshotEnabled&&owned){globalShortcut.unregister(SCREENSHOT_KEY);owned=false;}
  return status();
 }
 function configure(input){for(const key of ['selectionEnabled','screenshotEnabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw Error('快速捕获开关格式无效');if(!['darwin','win32'].includes(platform)&&input.selectionEnabled)throw Error('选中文字自动弹窗支持 Windows 和 macOS');if(adapter)return adapter.configure(Object.fromEntries(['selectionEnabled','screenshotEnabled'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))).then(()=>{if(disposed)return status();if(input.selectionEnabled&&platform==='darwin')systemPreferences.isTrustedAccessibilityClient(true);error='';return reconcile();});const previous={...config()};a.data.runtime.quickCapture={...previous,...Object.fromEntries(['selectionEnabled','screenshotEnabled'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))};try{a.save();}catch(e){a.data.runtime.quickCapture=previous;throw e;}if(input.selectionEnabled&&platform==='darwin')systemPreferences.isTrustedAccessibilityClient(true);error='';return reconcile();}
 function dispose(){disposed=true;stop();if(owned)globalShortcut.unregister(SCREENSHOT_KEY);owned=false;}
 return {status,reconcile,configure,screenshot,dispose,resolve};
}
module.exports={create,SCREENSHOT_KEY};
