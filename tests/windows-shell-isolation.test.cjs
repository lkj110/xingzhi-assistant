'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
// A test-only override also runs these tests against extracted, frozen modules.
const root=process.env.FOUNDATION_NOTIFICATION_TEST_ROOT||path.resolve(__dirname,'..');
const windows=require(path.join(root,'desktop/windows-shell.cjs'));
const {createNativeBridge}=require(path.join(root,'desktop/native-bridge.cjs'));
function fixture({packaged=true,isolated=false,supported=true,focused=false,platform='win32'}={}){
 const calls={ids:[],shortcuts:[],probes:0,constructed:0,shown:0,clicks:0};
 const app={isPackaged:packaged,commandLine:{hasSwitch:name=>name==='user-data-dir'&&isolated},setAppUserModelId:id=>calls.ids.push(id),setToastActivatorCLSID:id=>calls.ids.push(id),getPath(){throw Error('unexpected global path read');}};
 const shell={writeShortcutLink:(...args)=>{calls.shortcuts.push(args);return true;}};
 class Notification {
  static isSupported(){calls.probes++;return supported;}
  constructor(options){calls.constructed++;calls.options=options;}
  on(event,handler){assert.equal(event,'click');calls.click=handler;}
  show(){calls.shown++;}
 }
 const bridge=createNativeBridge({app,shell,Notification,platform,getWindow:()=>({isFocused:()=>focused}),onAttention:()=>calls.clicks++});
 return {app,shell,Notification,bridge,calls};
}
for(const state of [
 {name:'packaged explicit profile',packaged:true,isolated:true},
 {name:'development default profile',packaged:false,isolated:false},
 {name:'development explicit profile',packaged:false,isolated:true}
]){
 test(state.name+' never registers or probes shared Windows notifications',async()=>{
  const f=fixture(state);
  assert.equal(windows.configure(f.app),false);
  assert.equal(windows.shortcut({app:f.app,shell:f.shell}),null);
  assert.deepEqual(await f.bridge('attentionAvailable'),{supported:false,focused:false});
  await assert.rejects(f.bridge('notifyAttention',{count:2}),{code:'NATIVE_NOTIFICATIONS_DISABLED'});
  assert.deepEqual(f.calls,{ids:[],shortcuts:[],probes:0,constructed:0,shown:0,clicks:0});
 });
}
test('isolated shortcut guard runs before explicit directory creation',t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-shortcut-test-'));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const directory=path.join(parent,'must-not-exist'),f=fixture({isolated:true});
 assert.equal(windows.shortcut({...f,directory}),null);assert.equal(fs.existsSync(directory),false);
});
test('missing or ambiguous profile metadata cannot claim shared Windows registration',async()=>{
 for(const app of [undefined,{}, {isPackaged:true}, {isPackaged:true,commandLine:{hasSwitch:()=>undefined}}]){
  assert.equal(windows.canRegisterWindowsShell(app),false);
  assert.equal(windows.configure(app),false);assert.equal(windows.shortcut({app}),null);
  const bridge=createNativeBridge({app,platform:'win32',getWindow:()=>null});
  assert.deepEqual(await bridge('attentionAvailable'),{supported:false,focused:false});
  await assert.rejects(bridge('notifyAttention'),{code:'NATIVE_NOTIFICATIONS_DISABLED'});
 }
});
test('focused isolated window reports focus without touching Electron notification API',async()=>{
 const f=fixture({isolated:true,focused:true});
 assert.deepEqual(await f.bridge('attentionAvailable'),{supported:false,focused:true});
 assert.equal(f.calls.probes,0);
});
test('default packaged Windows installation retains its identity, shortcut and notification behavior',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-shortcut-control-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const f=fixture();assert.equal(windows.configure(f.app),true);
 assert.deepEqual(f.calls.ids,[windows.appId,windows.toastId]);
 assert.equal(windows.shortcut({...f,directory}),path.join(directory,'行知助手.lnk'));
 const [file,operation,options]=f.calls.shortcuts[0];
 assert.equal(file,path.join(directory,'行知助手.lnk'));assert.equal(operation,'create');
 assert.equal(options.target,process.execPath);assert.equal(options.appUserModelId,windows.appId);assert.equal(options.toastActivatorClsid,windows.toastId);
 assert.deepEqual(await f.bridge('attentionAvailable'),{supported:true,focused:false});
 assert.deepEqual(await f.bridge('notifyAttention',{count:3}),{submitted:true});f.calls.click();
 assert.equal(f.calls.probes,1);assert.equal(f.calls.shown,1);assert.equal(f.calls.clicks,1);assert.match(f.calls.options.body,/3 项工作/);
});
test('default Windows unsupported capability is still reported as unsupported',async()=>{
 const f=fixture({supported:false});assert.equal((await f.bridge('attentionAvailable')).supported,false);
 assert.equal(f.calls.probes,1);assert.equal(f.calls.constructed,0);
});
for(const platform of ['darwin','linux'])test(platform+' keeps its existing native notification behavior',async()=>{
 const f=fixture({platform,packaged:false,isolated:true});
 assert.equal((await f.bridge('attentionAvailable')).supported,true);
 assert.deepEqual(await f.bridge('notifyAttention',{count:1}),{submitted:true});
 assert.equal(f.calls.probes,1);assert.equal(f.calls.shown,1);assert.deepEqual(f.calls.ids,[]);
});
test('isolated policy does not disable unrelated local native bridge operations',async()=>{
 const f=fixture({isolated:true}),opened=[];
 const bridge=createNativeBridge({...f,platform:'win32',shell:{showItemInFolder:p=>opened.push(p)},getWindow:()=>null});
 assert.deepEqual(await bridge('showItemInFolder',{path:'fixture.txt'}),{ok:true});assert.deepEqual(opened,['fixture.txt']);
});

// Execute actual main startup wiring with mocked Electron/engine boundaries.
// No Electron executable, registry API, real shortcut writer, worker or model runs.
async function startup({packaged,isolated,platform='win32',testData=false}){
 const f=fixture({packaged,isolated,platform}),pending=[],requests=[];
 Object.assign(f.app,{setName(){},setPath(){},requestSingleInstanceLock:()=>true,on(){},whenReady:()=>Promise.resolve()});
 f.app.getPath=()=>os.tmpdir();
 class EngineClient{constructor({native}){pending.push(native('attentionAvailable').then(result=>requests.push(result)));this.ready=new Promise(()=>{});}on(){}}
 const startupWindows={...windows,shortcut:options=>{
  // Replace only filesystem creation; use the production guard in real shortcut().
  if(windows.canRegisterWindowsShell(options.app))return 'mock-default-start-menu-entry';
  return windows.shortcut({...options,directory:path.join(os.tmpdir(),'forbidden-global-entry')});
 }};
 let shortcutCalls=0;
 const realShortcut=startupWindows.shortcut;startupWindows.shortcut=o=>{shortcutCalls++;return realShortcut(o);};
 vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/main.cjs'),'utf8'),{
  require:name=>{
   if(name==='electron')return {app:f.app,shell:f.shell,Notification:f.Notification};
   if(name==='node:path')return path;
   if(name==='./engine-client.cjs')return {EngineClient};
   if(name==='./native-bridge.cjs')return {createNativeBridge:o=>createNativeBridge({...o,platform})};
   if(name==='./windows-shell.cjs')return startupWindows;
   if(name==='./quick-capture.cjs')return {};
   throw Error('Unexpected startup dependency: '+name);
  },process:{platform,env:testData?{ASSISTANT_TEST_DATA_DIR:'fixture-only'}:{}},console,__dirname:path.join(root,'desktop')
 },{filename:'main.cjs',timeout:1000});
 await new Promise(resolve=>setImmediate(resolve));await Promise.all(pending);
 assert.equal(requests.length,1,'the actual main startup must reach its notification capability check');
 return {...f,requests,shortcutCalls};
}
test('actual startup and cold startup both avoid notification initialization for an explicit Windows profile',async()=>{
 for(let i=0;i<2;i++){
  const f=await startup({packaged:true,isolated:true});
  assert.equal(f.requests[0].supported,false);assert.equal(f.shortcutCalls,0);
  assert.deepEqual(f.calls.ids,[]);assert.equal(f.calls.probes,0);
 }
});
test('actual development startup with test data path also avoids shared registration',async()=>{
 const f=await startup({packaged:false,isolated:false,testData:true});
 assert.equal(f.requests[0].supported,false);assert.deepEqual(f.calls.ids,[]);assert.equal(f.calls.probes,0);assert.equal(f.shortcutCalls,0);
});
test('actual default Windows startup still uses existing shared integration',async()=>{
 const f=await startup({packaged:true,isolated:false});
 assert.equal(f.requests[0].supported,true);assert.equal(f.calls.ids.length,2);assert.equal(f.calls.probes,1);assert.equal(f.shortcutCalls,1);
});
