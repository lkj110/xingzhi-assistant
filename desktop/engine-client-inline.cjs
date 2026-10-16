// Compatibility for existing native fixtures that monkeypatch Assistant and
// Electron in one process. Never imported by the production desktop path.
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function createInlineFixture({dir,safeStorage,native,isPackaged}){
  if(isPackaged||!process.env.ASSISTANT_DESKTOP_FIXTURE||!process.env.ASSISTANT_TEST_DATA_DIR||process.env.ASSISTANT_ENGINE_WORKER==='1')throw Error('Inline engine is restricted to explicit isolated desktop fixtures');
  const temporary=fs.realpathSync(os.tmpdir())+path.sep,userData=fs.realpathSync(process.env.ASSISTANT_TEST_DATA_DIR);
  if(!userData.startsWith(temporary)||path.resolve(dir)!==path.join(userData,'workspace')&&path.resolve(dir)!==path.join(path.resolve(process.env.ASSISTANT_TEST_DATA_DIR),'workspace'))throw Error('Inline fixture data must be an isolated temporary workspace');
  if(fs.existsSync(dir)&&!fs.realpathSync(dir).startsWith(userData+path.sep))throw Error('Inline fixture workspace must not follow a symlink outside its temporary directory');
  const client=new EventEmitter();client.mirror=null;
  const vault={
    seal(value){if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('系统钥匙串不可用');return safeStorage.encryptString(value).toString('base64');},
    open(value){return safeStorage.decryptString(Buffer.from(value,'base64'));}
  };
  client.fixtureAssistant=new (require('./core.cjs').Assistant)({dir,vault});
  const engine=require('./engine-worker.cjs').createEngine({assistant:client.fixtureAssistant,native,emit:message=>{
    if(message.type==='mirror'){client.mirror=message.mirror;client.emit('mirror',client.mirror);}
    else if(message.type==='backgroundError')client.emit('backgroundError',message.error);
  }});
  client.ready=Promise.resolve().then(()=>engine.start());
  let closing=false;
  client.call=async(method,input)=>{await client.ready;if(closing)throw Error('应用正在退出');return engine.handle(method,input);};
  client.dispatch=(action,input)=>client.call('dispatch',{action,input});
  client.capture=(action,input)=>client.call('capture',{action,input});
  client.control=(action,input)=>client.call('control',{action,input});
  client.captureAdapter=require('./engine-client.cjs').EngineClient.prototype.captureAdapter.bind(client);
  client.close=()=>{if(!client.closePromise){closing=true;client.closePromise=client.ready.then(()=>engine.close());}return client.closePromise;};
  return client;
}
module.exports={createInlineFixture};
