// Native boundaries shared by desktop tests. No OS mouse listener, real shortcut,
// subscription CLI, or credentials are consulted. Scenario fixtures may replace
// these adapters with their own deterministic event/clipboard simulation.
const path=require('node:path');
if(!process.env.ASSISTANT_TEST_DATA_DIR||!process.env.ASSISTANT_DESKTOP_FIXTURE)throw Error('Desktop fixture and isolated userData are required');
const electron=require('electron'),registrations=new Map();
electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};
electron.Notification=class{static isSupported(){return false;}on(){}show(){}};
electron.globalShortcut.register=(key,callback)=>{if(registrations.has(key))return false;registrations.set(key,callback);return true;};
electron.globalShortcut.unregister=key=>registrations.delete(key);
electron.globalShortcut.isRegistered=key=>registrations.has(key);
electron.globalShortcut.unregisterAll=()=>registrations.clear();
require('../desktop/selection-capture.cjs').create=({assistant})=>{
 const status=()=>{const p=require('../desktop/quick-capture.cjs').preference(assistant.data);return {selectionEnabled:p.selectionEnabled,screenshotEnabled:p.screenshotEnabled,screenshotRegistered:p.screenshotEnabled,selectionRunning:p.selectionEnabled,screenPermission:'granted',accessibilityTrusted:true,captureError:'',screenshotKey:'⌘ ⇧ 2',captureDiagnostic:{stage:'waiting',events:0,selections:0,reads:0,lastRead:'waiting'}};};
 return {status,reconcile:status,configure(input){assistant.data.runtime.quickCapture={...require('../desktop/quick-capture.cjs').preference(assistant.data),...input};assistant.save();return status();},dispose(){},resolve(){throw Error('No OS selection in isolated desktop tests');}};
};
const subscription=require('../desktop/subscription.cjs');
subscription.status=async()=>({available:true,loggedIn:true,message:'已使用 ChatGPT 登录，可使用订阅额度',version:'fixture-cli',model:'gpt-6-astra',economical:'gpt-6-luna',models:[{id:'gpt-6-luna',name:'gpt-6-luna'},{id:'gpt-6-astra',name:'gpt-6-astra'}]});
for(const method of ['chat','run','request'])if(typeof subscription[method]==='function')subscription[method]=async()=>{throw Error('Real subscription requests prohibited in desktop tests');};
require(path.resolve(__dirname,'..',process.env.ASSISTANT_DESKTOP_FIXTURE));
