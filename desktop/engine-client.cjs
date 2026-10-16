const {Worker}=require('node:worker_threads');
const {EventEmitter}=require('node:events');
const path=require('node:path');
const {serviceVault}=require('./native-bridge.cjs');
const failure=(message,code='ENGINE_UNAVAILABLE')=>Object.assign(Error(message),{code});
class EngineClient extends EventEmitter {
  constructor({dir,safeStorage,native,fixtureModule,shutdownTimeout=5000,startupTimeout=60000,workerOptions={}}){
    super();this.pending=new Map();this.nextId=0;this.mirror=null;this.closing=false;this.closed=false;
    this.safeStorage=safeStorage;this.native=native;this.shutdownTimeout=shutdownTimeout;
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    // CJS require understands Electron ASAR paths; an OS-level worker entry does
    // not on every Electron release. Bootstrap both packaged and unpackaged builds.
    this.worker=new Worker('require(require("node:worker_threads").workerData.entry)',{
      ...workerOptions,eval:true,workerData:{entry:path.join(__dirname,'engine-worker.cjs'),kind:'assistant-engine',dir,fixtureModule}
    });
    this.worker.on('message',message=>this.receive(message));
    this.worker.on('error',error=>this.fail(error));
    this.exited=new Promise(resolve=>this.worker.once('exit',code=>{
      this.closed=true;clearTimeout(this.startupTimer);
      if(!this.shutdownAcknowledged)this.fail(failure(`业务进程已退出（${code}），请重新启动应用`));
      resolve(code);
    }));
    this.startupTimer=setTimeout(()=>{this.fail(failure('业务进程启动超时'));void this.worker.terminate();},startupTimeout);
    // A startup rejection remains observable through ready without becoming an
    // unhandled rejection before the desktop has installed its error handler.
    this.ready.catch(()=>{});
  }
  fail(error){
    if(this.failure)return;this.failure=error;clearTimeout(this.startupTimer);this.rejectReady(error);
    for(const row of this.pending.values())row.reject(error);this.pending.clear();
    this.emit('failure',error);
  }
  async receive(message){
    if(message.type==='vault'){serviceVault(message.shared,this.safeStorage);return;}
    if(message.type==='native'){
      try{
        if(this.closing)throw failure('应用正在退出','ENGINE_CLOSING');
        if(typeof this.native!=='function')throw failure('原生接口不可用','NATIVE_UNAVAILABLE');
        const result=await this.native(message.action,message.input);
        if(!this.closed)this.worker.postMessage({type:'nativeResult',id:message.id,result});
      }catch(error){if(!this.closed)try{this.worker.postMessage({type:'nativeResult',id:message.id,error:{message:error.message,code:error.code}});}catch{}}
      return;
    }
    if(message.type==='mirror'){
      if(!this.mirror||message.mirror.sequence>this.mirror.sequence){this.mirror=message.mirror;this.emit('mirror',this.mirror);}return;
    }
    if(message.type==='ready'){clearTimeout(this.startupTimer);this.resolveReady();return;}
    if(message.type==='fatal'){this.fail(failure(message.error.message,message.error.code));return;}
    if(message.type==='backgroundError'){this.emit('backgroundError',message.error);return;}
    if(message.type!=='result')return;
    const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);
    if(pending.method==='shutdown'&&!message.error)this.shutdownAcknowledged=true;
    if(message.error)pending.reject(Object.assign(Error(message.error.message),message.error));else pending.resolve(message.result);
  }
  send(method,input){
    if(this.failure)return Promise.reject(this.failure);
    if(this.closed)return Promise.reject(failure('业务进程已关闭'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject,method});
      try{this.worker.postMessage({type:'request',id,method,input});}catch(error){this.pending.delete(id);reject(error);}
    });
  }
  async call(method,input){
    if(this.closing)throw failure('应用正在退出','ENGINE_CLOSING');
    await this.ready;if(this.closing)throw failure('应用正在退出','ENGINE_CLOSING');
    return this.send(method,input);
  }
  dispatch(action,input){return this.call('dispatch',{action,input});}
  capture(action,input){return this.call('capture',{action,input});}
  control(action,input){return this.call('control',{action,input});}
  captureAdapter(){return {
    preference:()=>this.mirror?.quickCapture||{enabled:false,selectionEnabled:false,screenshotEnabled:false},
    configure:input=>this.call('preferences',input),
    state:input=>this.capture('state',input),submit:input=>this.capture('submit',input),
    retry:input=>this.capture('retry',input),suggest:input=>this.capture('suggest',input),
    validateTask:taskId=>this.capture('validateTask',{taskId})
  };}
  close(){
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    this.closePromise=(async()=>{
      let timeout;
      try{
        await Promise.race([
          (async()=>{await this.ready;await this.send('shutdown');await this.exited;})(),
          new Promise((_,reject)=>{timeout=setTimeout(()=>reject(failure('业务进程退出超时，已强制关闭','ENGINE_SHUTDOWN_TIMEOUT')),this.shutdownTimeout);})
        ]);
      }finally{
        clearTimeout(timeout);
        if(!this.closed)await this.worker.terminate();
        for(const row of this.pending.values())row.reject(failure('业务进程已关闭'));this.pending.clear();
      }
    })();
    return this.closePromise;
  }
}
module.exports={EngineClient};
