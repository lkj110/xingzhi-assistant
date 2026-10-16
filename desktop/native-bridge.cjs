// The only synchronous bridge is the keychain. The worker may wait; Electron's
// window thread only services messages and never calls Atomics.wait.
const {isMainThread}=require('node:worker_threads');
const CAPACITY=1024*1024, HEADER=16;
const vaultError=()=>Object.assign(Error('系统钥匙串操作失败，请检查系统权限后重试'),{code:'VAULT_UNAVAILABLE'});
function createVault(port,{timeout=30000}={}){
  if(isMainThread)throw Error('同步钥匙串桥只能在业务 Worker 内使用');
  function invoke(operation,value){
    const shared=new SharedArrayBuffer(HEADER+CAPACITY),header=new Int32Array(shared,0,4),bytes=new Uint8Array(shared,HEADER);
    const request=Buffer.from(JSON.stringify({operation,value}));
    if(request.length>CAPACITY){request.fill(0);throw vaultError();}
    bytes.set(request);header[1]=request.length;request.fill(0);
    try{
      port.postMessage({type:'vault',shared});
      const deadline=Date.now()+timeout;
      while(true){
        const status=Atomics.load(header,0);if(status!==0&&status!==4)break;
        const left=deadline-Date.now();if(left<=0){Atomics.store(header,0,3);throw vaultError();}
        Atomics.wait(header,0,status,left);
      }
      if(Atomics.load(header,0)!==1)throw vaultError();
      const length=Atomics.load(header,1);if(length<0||length>CAPACITY)throw vaultError();
      return Buffer.from(bytes.subarray(0,length)).toString('utf8');
    }finally{bytes.fill(0);}
  }
  return {seal:value=>invoke('seal',value),open:value=>invoke('open',value)};
}
function serviceVault(shared,safeStorage){
  if(!(shared instanceof SharedArrayBuffer)||shared.byteLength!==HEADER+CAPACITY)return;
  const header=new Int32Array(shared,0,4),bytes=new Uint8Array(shared,HEADER);
  if(Atomics.compareExchange(header,0,0,4)!==0){bytes.fill(0);return;}
  let response;
  try{
    const length=Atomics.load(header,1);if(length<1||length>CAPACITY)throw vaultError();
    const request=JSON.parse(Buffer.from(bytes.subarray(0,length)).toString('utf8'));bytes.fill(0);
    if(typeof request.value!=='string'||!['seal','open'].includes(request.operation)||!safeStorage?.isEncryptionAvailable())throw vaultError();
    // basic_text is not OS-backed protection (Linux without an available keyring).
    if(safeStorage.getSelectedStorageBackend?.()==='basic_text')throw vaultError();
    response=Buffer.from(request.operation==='seal'?safeStorage.encryptString(request.value).toString('base64'):safeStorage.decryptString(Buffer.from(request.value,'base64')));
    if(response.length>CAPACITY)throw vaultError();
    if(Atomics.load(header,0)===3)return;
    bytes.set(response);Atomics.store(header,1,response.length);
    // Cancellation can race the synchronous keychain call on the other thread.
    // Never overwrite CANCELLED with READY after the worker has erased its view.
    if(Atomics.compareExchange(header,0,4,1)!==4)bytes.fill(0);
  }catch{
    bytes.fill(0);Atomics.store(header,1,0);Atomics.compareExchange(header,0,4,2);
  }finally{
    response?.fill(0);if(Atomics.load(header,0)===3)bytes.fill(0);Atomics.notify(header,0);
  }
}
function createNativeBridge({app,dialog,shell,Notification,net,getWindow,onAttention}){
  return async function invoke(action,input={}){
    switch(action){
      case 'openExternal': await shell.openExternal(input.url);return {opened:true};
      case 'showItemInFolder': shell.showItemInFolder(input.path);return {ok:true};
      case 'openStorage': {const error=await shell.openPath(input.path);if(error)throw Error(error);return {ok:true};}
      case 'chooseFolder': return dialog.showOpenDialog(getWindow(),input);
      case 'saveExport': return dialog.showSaveDialog(getWindow(),input);
      case 'runtimeStatus': return {online:net.isOnline(),loginSupported:app.isPackaged,openAtLogin:app.getLoginItemSettings().openAtLogin};
      case 'runtimeStartup':
        if(!app.isPackaged)throw Error('登录启动请在打包后的 App 中设置');
        app.setLoginItemSettings({openAtLogin:input.enabled===true});return {openAtLogin:app.getLoginItemSettings().openAtLogin};
      case 'attentionAvailable': return {supported:Notification.isSupported(),focused:!!getWindow()?.isFocused()};
      case 'notifyAttention': {
        const notification=new Notification({title:'行知助手需要你关注',body:`${input.count} 项工作有新的待处理进展，点击查看关注中心。`});
        notification.on('click',onAttention);notification.show();return {submitted:true};
      }
      default: throw Error('未知原生操作');
    }
  };
}
module.exports={createVault,serviceVault,createNativeBridge};
