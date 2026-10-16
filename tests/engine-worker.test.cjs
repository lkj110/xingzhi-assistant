const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {pathToFileURL}=require('node:url');
const {EngineClient}=require('../desktop/engine-client.cjs');
const desktop=path.resolve(__dirname,'../desktop');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The module is copied into the temporary test directory; neither model requests
// nor fixture RPCs are part of the production worker API.
const fixtureSource=String.raw`
exports.create=({Assistant,options})=>{
 const fs=require('node:fs'),path=require('node:path'),{threadId}=require('node:worker_threads');
 const denied=async()=>{throw Error('External calls prohibited in isolated worker tests');};
 class Fixture extends Assistant {
  tick(){}
  save(){if(this.failSaves>0){this.failSaves--;throw Error('fixture disk full');}return super.save();}
  async dispatch(action,input={}){
   if(action==='fixtureProbe')return {threadId,file:this.file,executions:this.executions.size};
   if(action==='fixtureFailSave'){this.failSaves=input.count||1;return {ok:true};}
   if(action==='fixtureSave'){const end=Date.now()+(input.busyMs||0);while(Date.now()<end){}this.data.fixturePayload='x'.repeat(input.bytes||0);this.data.settings.profile=input.profile||'durable';this.save();return {saved:true};}
   if(action==='fixtureHistory'){this.data.agentRuns=[{id:'history',steps:[{tool:'fixture',result:{text:'x'.repeat(3000000)}}]}];this.save();return {ok:true};}
   if(action==='fixtureWait')return new Promise(resolve=>{this.releaseFixture=resolve;});
   if(action==='fixtureRelease'){this.releaseFixture?.({released:true});return {ok:true};}
   if(action==='fixtureHang'){await new Promise(()=>{});}
   if(action==='fixtureCrash')process.exit(19);
   if(action==='fixtureBusy'){this.operation={label:'fixture busy'};return {ok:true};}
   if(action==='fixtureIdle'){this.operation=null;return {ok:true};}
   if(action==='fixtureSource'){this.data.sources.push({id:'origin',title:'origin',content:'text',state:'new',provenance:{url:input.url}});this.save();return {ok:true};}
   if(action==='fixtureVault'){const sealed=this.vault.seal(input.secret);this.data.fixtureSealed=sealed;this.save();return {matches:this.vault.open(sealed)===input.secret};}
   if(action==='fixtureParse')return require(path.join(desktop,'documents.cjs')).parse('inside-worker.txt',Buffer.from('nested document worker text'),new AbortController().signal);
   if(action==='fixtureExecution'){
    const task=this.createTask({title:input.title||'cancel fixture'});
    require(path.join(desktop,'execution.cjs')).launch(this,{taskId:task.id},'fixture',async view=>{
     await new Promise(resolve=>{const done=()=>{this.data.fixtureAborted=(this.data.fixtureAborted||0)+1;resolve();};if(view.controller.signal.aborted)done();else view.controller.signal.addEventListener('abort',done,{once:true});});
    });return {taskId:task.id};
   }
   if(action==='fixtureAccess'){
    this.data.providers=[{id:'p',name:'fixture',model:'fixture',type:'ollama',baseUrl:'https://fixture.invalid'}];this.data.settings.roles={organize:'p',execute:'p',verify:'p'};
    const agent=require(path.join(desktop,'agent.cjs')),access=require(path.join(desktop,'access.cjs'));
    const j=agent.buildJob(this,{goal:'read document',fileMode:'off',githubMode:'off'});this.data.delegations.push(j);
    const r=access.request(this,j,{kind:'lark_document',target:'https://example.larkoffice.com/docx/Fixture',reason:'fixture'});
    this.accessSessions.set(r.decisionId,{jobId:j.id,url:input.url,expiresAt:Date.now()+60000});return {id:r.decisionId};
   }
   return super.dispatch(action,input);
  }
 }
 return new Fixture({...options,chat:denied,agentRequest:denied,connectorRequest:denied,officeRequest:denied,webRequest:denied,feedRequest:denied});
};`;
function fixtureVault(){
 const key=crypto.randomBytes(32);
 return {isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},decryptString(bytes){const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString();}};
}
async function setup(t,overrides={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'assistant-engine-test-'))),workspace=path.join(dir,'workspace'),module=path.join(dir,'fixture.cjs'),nativeCalls=[];
 fs.mkdirSync(workspace);fs.writeFileSync(module,`const desktop=${JSON.stringify(desktop)};\n`+fixtureSource);
 const engine=new EngineClient({dir:workspace,fixtureModule:module,safeStorage:fixtureVault(),native:async(action,input)=>{nativeCalls.push({action,input});if(action==='attentionAvailable')return {supported:false};if(action==='chooseFolder')return {canceled:true};return {ok:true};},...overrides});
 t.after(async()=>{await engine.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});
 await engine.ready;return {engine,dir,workspace,nativeCalls};
}
test('Assistant and nested document parser run in workers; mirror is bounded and contains no workspace',async t=>{
 const {engine}=await setup(t);const probe=await engine.dispatch('fixtureProbe');assert.ok(probe.threadId>0);
 assert.match((await engine.dispatch('fixtureParse')).content,/nested document worker text/);
 await engine.dispatch('fixtureSave',{bytes:8_000_000});await delay(20);
 assert.ok(Buffer.byteLength(JSON.stringify(engine.mirror))<1000);assert.deepEqual(Object.keys(engine.mirror).sort(),['pending','quickCapture','sequence']);
 const full=await engine.dispatch('state');assert.equal(full.fixturePayload.length,8_000_000);
});
test('synchronous work and durable save do not stall the caller heartbeat; receipt arrives after disk commit',async t=>{
 const {engine,workspace}=await setup(t);let last=performance.now();const gaps=[];
 const interval=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;},5);
 try{
  await engine.dispatch('fixtureSave',{busyMs:350,bytes:5_000_000,profile:'acknowledged'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace,'workspace.json'))).settings.profile,'acknowledged');
  assert.ok(gaps.length>=15);assert.ok(Math.max(...gaps)<200,`caller gaps ${Math.max(...gaps)} ms`);
 }finally{clearInterval(interval);}
});
test('RPC stays concurrent and shutdown aborts every independent execution before worker exits',async t=>{
 const {engine,workspace}=await setup(t);
 const wait=engine.dispatch('fixtureWait');await engine.dispatch('fixtureRelease');assert.deepEqual(await wait,{released:true});
 await engine.dispatch('fixtureExecution',{title:'one'});await engine.dispatch('fixtureExecution',{title:'two'});
 assert.equal((await engine.dispatch('fixtureProbe')).executions,2);
 await engine.close();assert.equal(engine.closed,true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(workspace,'workspace.json'))).fixtureAborted,2);
 await assert.rejects(engine.dispatch('state'),/退出/);
});
test('vault stays synchronous in worker, encrypted on disk, and never exposes native errors',async t=>{
 const {engine,workspace}=await setup(t);const secret='UNIQUE-Vault-Secret-'+crypto.randomUUID();
 assert.deepEqual(await engine.dispatch('fixtureVault',{secret}),{matches:true});
 for(const file of fs.readdirSync(workspace))if(fs.statSync(path.join(workspace,file)).isFile())assert.equal(fs.readFileSync(path.join(workspace,file)).includes(Buffer.from(secret)),false);
 assert.equal(fs.existsSync(path.join(workspace,'vault.key')),false);
 engine.safeStorage.encryptString=()=>{throw Error(secret);};
 await assert.rejects(engine.dispatch('fixtureVault',{secret}),error=>error.code==='VAULT_UNAVAILABLE'&&!error.message.includes(secret));
 engine.safeStorage.getSelectedStorageBackend=()=> 'basic_text';await assert.rejects(engine.dispatch('fixtureVault',{secret}),/钥匙串/);
});
test('worker validates source and authorization URLs before native adapters see them',async t=>{
 const {engine,nativeCalls}=await setup(t);
 await engine.dispatch('fixtureSource',{url:'https://example.com/source?token=secret&keep=yes'});
 await engine.dispatch('sourceOriginOpen',{id:'origin',index:0,url:'file:///attacker'});
 assert.equal(nativeCalls.at(-1).input.url,'https://example.com/source?keep=yes');const count=nativeCalls.length;
 await assert.rejects(engine.dispatch('sourceOriginOpen',{id:'foreign',index:0,url:'https://attacker.invalid'}),/不存在/);assert.equal(nativeCalls.length,count);
 const access=await engine.dispatch('fixtureAccess',{url:'https://attacker.invalid/oauth'});
 await assert.rejects(engine.dispatch('accessOpenLink',access),/官方域名/);assert.equal(nativeCalls.length,count);
 await assert.rejects(engine.dispatch('agentOpenResult',{actionId:'foreign',url:'https://attacker.invalid'}),/不存在/);
});
test('quick capture owns receipts inside worker; failed save is retryable and preferences roll back',async t=>{
 const {engine,workspace}=await setup(t);await engine.dispatch('fixtureBusy');
 const input={requestId:crypto.randomUUID(),textItems:[{title:'capture',content:'exact original'}]};
 await engine.dispatch('fixtureFailSave');await assert.rejects(engine.capture('submit',input),/disk full/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(workspace,'workspace.json'))).captureQueue.length,0);
 const saved=await engine.capture('submit',input),again=await engine.capture('submit',input);
 assert.equal(saved.receipt.id,again.receipt.id);assert.equal(again.reused,true);assert.equal(saved.receipt.status,'queued');
 await assert.rejects(engine.capture('state',{receiptId:'foreign'}),/不属于/);
 await engine.dispatch('fixtureFailSave');await assert.rejects(engine.call('preferences',{enabled:true}),/disk full/);assert.equal(engine.mirror.quickCapture.enabled,false);
 await engine.call('preferences',{enabled:true});assert.equal(engine.mirror.quickCapture.enabled,true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(workspace,'workspace.json'))).runtime.quickCapture.enabled,true);
});
test('native commands inside uiCommand preserve summary context and dispatch errors',async t=>{
 const {engine}=await setup(t);await engine.dispatch('fixtureHistory');
 const view=await engine.dispatch('stateView');assert.ok(view.revision);assert.equal((await engine.dispatch('stateView',{revision:view.revision})).unchanged,true);
 const result=await engine.dispatch('uiCommand',{action:'chooseOutputFolder',input:{}});assert.ok(result.viewRevision);assert.equal(result.agentRuns[0].steps.length,0);
 await engine.dispatch('fixtureFailSave');await assert.rejects(engine.dispatch('uiCommand',{action:'settings',input:{profile:'failure'}}),/disk full/);
});
test('crash rejects all in-flight RPCs and bounded shutdown terminates uncooperative work',async t=>{
 const first=await setup(t);const waiting=first.engine.dispatch('fixtureWait'),crash=first.engine.dispatch('fixtureCrash');
 const settled=await Promise.allSettled([waiting,crash]);assert.ok(settled.every(r=>r.status==='rejected'));assert.equal(first.engine.closed,true);
 const {engine}=await setup(t,{shutdownTimeout:150});const pending=engine.dispatch('fixtureHang');const checked=assert.rejects(pending);
 await delay(20);await assert.rejects(engine.close(),error=>error.code==='ENGINE_SHUTDOWN_TIMEOUT');await checked;assert.equal(engine.closed,true);
});
test('async native quick/selection adapters never need an Assistant and wait for persistence',async t=>{
 const {engine,dir}=await setup(t);let registered=false;
 class Window extends EventEmitter{
  constructor(){super();this.visible=false;this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.setWindowOpenHandler=()=>{};this.webContents.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){}};}
  isDestroyed(){return false;}isVisible(){return this.visible;}show(){this.visible=true;}hide(){this.visible=false;}focus(){}setMinimumSize(){}setSize(){}setAlwaysOnTop(){}setVisibleOnAllWorkspaces(){}destroy(){}loadFile(file){this.webContents.mainFrame.url=pathToFileURL(file).href;return Promise.resolve();}
 }
 const shortcuts={register:()=>{registered=true;return true;},unregister:()=>{registered=false;},isRegistered:()=>registered};
 const quick=require('../desktop/quick-capture.cjs').createController({adapter:engine.captureAdapter(),BrowserWindow:Window,globalShortcut:shortcuts,preload:path.join(dir,'preload.cjs'),indexFile:path.join(dir,'index.html')});t.after(()=>quick.dispose());
 await quick.configure({enabled:true});assert.equal(quick.status().enabled,true);assert.equal(registered,true);
 await engine.dispatch('fixtureFailSave');await assert.rejects(quick.configure({enabled:false}),/保存失败/);assert.equal(registered,true);
 const selection=require('../desktop/selection-capture.cjs').create({adapter:engine.captureAdapter(),globalShortcut:{register:()=>true,unregister(){}},systemPreferences:{isTrustedAccessibilityClient:()=>false},platform:'darwin'});t.after(()=>selection.dispose());
 await selection.configure({selectionEnabled:false,screenshotEnabled:false});assert.equal(selection.status().selectionEnabled,false);
 quick.open();const window=quick.window();window.emit('ready-to-show');await engine.dispatch('fixtureBusy');
 const result=await quick.dispatchSmall({sender:window.webContents,senderFrame:window.webContents.mainFrame},'quickCaptureSubmit',{requestId:crypto.randomUUID(),textItems:[{title:'adapter',content:'durable'}]});
 assert.equal(result.accepted,true);assert.equal(window.visible,false);assert.equal(result.state.captureVisible,false);
});
test('inline fixture adapter rejects production, missing explicit flags and external workspaces',()=>{
 const {createInlineFixture}=require('../desktop/engine-client-inline.cjs');
 assert.throws(()=>createInlineFixture({dir:'/not-a-test',isPackaged:true}),/restricted/);
 assert.throws(()=>createInlineFixture({dir:'/not-a-test',isPackaged:false}),/restricted|isolated|ENOENT/);
});
test('legacy inline fixture preserves main-process Assistant injection only inside temporary test data',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'assistant-inline-test-'))),core=require('../desktop/core.cjs'),Base=core.Assistant;
 const keys=['ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_TEST_DATA_DIR','ASSISTANT_ENGINE_WORKER'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 let engine;
 try{
  process.env.ASSISTANT_DESKTOP_FIXTURE='explicit-fixture';process.env.ASSISTANT_TEST_DATA_DIR=dir;delete process.env.ASSISTANT_ENGINE_WORKER;
  core.Assistant=class extends Base {async dispatch(action,input){if(action==='fixtureInjected')return {injected:true,threadId:require('node:worker_threads').threadId};return super.dispatch(action,input);}};
  engine=require('../desktop/engine-client-inline.cjs').createInlineFixture({dir:path.join(dir,'workspace'),safeStorage:fixtureVault(),native:async()=>({supported:false}),isPackaged:false});
  await engine.ready;assert.deepEqual(await engine.dispatch('fixtureInjected'),{injected:true,threadId:0});
  const preference=await engine.captureAdapter().configure({selectionEnabled:false});assert.equal(preference.selectionEnabled,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'workspace/workspace.json'))).runtime.quickCapture.selectionEnabled,false);
  process.env.ASSISTANT_ENGINE_WORKER='1';assert.throws(()=>require('../desktop/engine-client-inline.cjs').createInlineFixture({dir:path.join(dir,'workspace'),isPackaged:false}),/restricted/);
 }finally{await engine?.close();core.Assistant=Base;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}fs.rmSync(dir,{recursive:true,force:true});}
});
test('vault timeout erases the shared secret and late main servicing cannot revive a cancelled request',async()=>{
 const {Worker}=require('node:worker_threads'),{serviceVault}=require('../desktop/native-bridge.cjs');let shared;
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');try{require(workerData.bridge).createVault(parentPort,{timeout:30}).seal('PRIVATE-CANCELLED-SECRET');}catch(error){parentPort.postMessage({done:true,code:error.code,message:error.message});}`,{eval:true,workerData:{bridge:path.join(desktop,'native-bridge.cjs')}});
 try{
  const result=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',message=>{if(message.type==='vault')shared=message.shared;else if(message.done)resolve(message);});});
  assert.equal(result.code,'VAULT_UNAVAILABLE');assert.ok(new Uint8Array(shared,16).every(value=>value===0));
  let called=false;serviceVault(shared,{isEncryptionAvailable(){called=true;return true;}});assert.equal(called,false);assert.ok(new Uint8Array(shared,16).every(value=>value===0));
  // Model cancellation arriving while a synchronous native keychain call is in
  // progress: its late return must not overwrite CANCELLED with READY.
  const racing=new SharedArrayBuffer(16+1024*1024),header=new Int32Array(racing,0,4),bytes=new Uint8Array(racing,16),request=Buffer.from(JSON.stringify({operation:'seal',value:'PRIVATE-RACE-SECRET'}));bytes.set(request);header[1]=request.length;
  serviceVault(racing,{isEncryptionAvailable:()=>true,encryptString(){Atomics.store(header,0,3);return Buffer.from('late-secret');}});
  assert.equal(Atomics.load(header,0),3);assert.ok(bytes.every(value=>value===0));
 }finally{await worker.terminate();}
});
