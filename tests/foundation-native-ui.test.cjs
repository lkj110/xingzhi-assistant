'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{EventEmitter}=require('node:events'),{pathToFileURL}=require('node:url');
const policy=require('../evaluations/foundation-native-ui-runner/policy.cjs'),native=require('../evaluations/foundation-native-ui-runner/native.cjs'),id=require('../evaluations/foundation-native-ui-runner/identity.cjs'),sessions=require('../evaluations/foundation-native-ui-runner/session.cjs');
const plan=id.read(path.join(id.root,'evaluations/foundation-native-ui-runner/plan.json'));
const check=(role,action,input,extra={})=>policy.classify({role,action,input,trusted:true,taskId:'target',closed:false,...extra});
test('capture lifecycle allows only exact state, boolean occupancy and empty hide',()=>{
 for(const [a,v]of [['quickCaptureState',{}],['quickCaptureState',undefined],['quickCaptureState',{receiptId:crypto.randomUUID()}],['quickCaptureDraft',{occupied:false}],['quickCaptureDraft',{occupied:true}],['quickCaptureHide',{}],['quickCaptureHide',undefined]])assert.equal(check('capture',a,v).allowed,true);
 for(const [a,v]of [['quickCaptureState',{receiptId:''}],['quickCaptureState',{extra:1}],['quickCaptureDraft',{occupied:0}],['quickCaptureDraft',{occupied:true,text:'PRIVATE_SENTINEL'}],['quickCaptureDraft',null],['quickCaptureHide',{page:'board'}],['uiCommand',{action:'quickCaptureHide',input:{}}]])assert.equal(check('capture',a,v).allowed,false);
});
for(const action of ['quickCaptureSubmit','quickCaptureRetry','quickCaptureSuggest','quickCaptureResolve','quickCaptureConsume','quickCaptureExpand','quickCaptureOpenMain','screenshotRegion','screenshotClipboard','advance','recheckGroundingMarkers','registrationOpen','unknownCommand'])test('capture denies '+action,()=>assert.equal(check('capture',action,{}).allowed,false));
test('only the trusted main window can accept exactly the active task',()=>{
 const input={action:'taskAction',input:{id:'target',command:'accept'}};
 assert.equal(check('main','uiCommand',input).kind,'accept');
 for(const role of ['capture','unknown'])assert.equal(check(role,'uiCommand',input).allowed,false);
 assert.equal(check('main','uiCommand',input,{trusted:false}).allowed,false);assert.equal(check('main','uiCommand',input,{closed:true}).allowed,false);
 for(const value of [{action:'taskAction',input:{id:'other',command:'accept'}},{action:'taskAction',input:{id:'target',command:'revise'}},{...input,extra:true},{action:'taskAction',input:{...input.input,force:true}}])assert.equal(check('main','uiCommand',value).allowed,false);
 assert.equal(check('main','taskAction',input.input).allowed,false);
});
test('closed sessions permit only trusted main reads for failure evidence',()=>{
 assert.equal(check('main','export',{}, {closed:true}).allowed,true);
 for(const role of ['capture','unknown'])assert.equal(check(role,'export',{}, {closed:true}).allowed,false);
 assert.equal(check('capture','quickCaptureState',{}, {closed:true}).allowed,false);
 assert.equal(check('main','quickCaptureHide',{}).allowed,false);assert.equal(check('main','state',{}, {trusted:false}).allowed,false);
});
test('receipt query rejects malformed UUID punctuation',()=>assert.equal(check('capture','quickCaptureState',{receiptId:'-'.repeat(36)}).allowed,false));
test('diagnostics summarize parameter types and keys without values',()=>{
 for(const value of [{secret:'PRIVATE_SENTINEL',text:'PRIVATE_SENTINEL'},['PRIVATE_SENTINEL'],'PRIVATE_SENTINEL'])assert.ok(!JSON.stringify(policy.inputSummary(value)).includes('PRIVATE_SENTINEL'));
});
function disposable(t,prefix){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),prefix));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
async function fixture(t,handler){
 const dir=disposable(t,'native-ui-unit-'),file=path.join(dir,'receipt.jsonl'),captureSession={},mainSession={},map=new Map(),handlers=new Map([['assistant:call',handler||(async()=>({data:{tasks:[]}}))]]),app=new EventEmitter();
 app.getPath=()=>dir;app.getAppPath=()=>id.root;
 const make=(n,s)=>{const w=new EventEmitter();Object.assign(w,{id:n,title:'unit',isDestroyed:()=>false,setTitle:v=>w.title=v,getTitle:()=>w.title,hide:()=>{},webContents:{id:n+10,session:s,mainFrame:{url:pathToFileURL(path.join(id.root,'dist/index.html')).href},getURL(){return this.mainFrame.url;},setBackgroundThrottling(){}}});map.set(n,w);return w;};
 const main=make(1,mainSession);
 const electron={app,session:{fromPartition:()=>captureSession},BrowserWindow:{fromId:n=>map.get(n),fromWebContents:c=>[...map.values()].find(w=>w.webContents===c),getAllWindows:()=>[...map.values()]},ipcMain:{_invokeHandlers:handlers,removeHandler:k=>handlers.delete(k),handle:(k,fn)=>handlers.set(k,fn)}};
 await native.install({evaluate:(fn,args)=>fn(electron,args)},{mainWindowId:1,file,output:dir,deadline:Date.now()+60000,taskId:'target',runId:'unit',mode:'offline'});
 const capture=make(2,captureSession);app.emit('browser-window-created',{},capture);
 const invoke=(w,action,input,event={})=>handlers.get('assistant:call')({sender:w.webContents,senderFrame:w.webContents.mainFrame,...event},action,input);
 return {dir,file,main,capture,invoke,make,mainSession,app};
}
test('dynamic capture requests use original trusted handler and origin receipts',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return {data:{ok:true}};});
 for(const [action,input]of [['quickCaptureState',{}],['quickCaptureDraft',{occupied:false}],['quickCaptureHide',{}]])await f.invoke(f.capture,action,input);
 assert.equal(calls,3);assert.ok(!fs.existsSync(path.join(f.dir,'stopped.json')));
 for(const r of native.records(f.file).filter(r=>r.kind==='native-command')){assert.equal(r.windowRole,'capture');assert.equal(r.trusted,true);assert.equal(r.mainFrame,true);assert.equal(r.senderId,12);assert.match(r.windowTitle,/快速收集/);}
});
for(const scenario of ['subframe','unknown-window','capture-accept','main-hide','payload'])test('denied '+scenario+' records origin before original handler',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return {data:{}};});
 if(scenario==='subframe')await f.invoke(f.capture,'quickCaptureState',{}, {senderFrame:{url:f.capture.webContents.mainFrame.url}});
 if(scenario==='unknown-window')await f.invoke(f.make(3,f.mainSession),'quickCaptureState',{});
 if(scenario==='capture-accept')await f.invoke(f.capture,'uiCommand',{action:'taskAction',input:{id:'target',command:'accept'}});
 if(scenario==='main-hide')await f.invoke(f.main,'quickCaptureHide',{});
 if(scenario==='payload')await f.invoke(f.capture,'quickCaptureDraft',{occupied:false,text:'PRIVATE_SENTINEL'});
 assert.equal(calls,0);const denied=native.records(f.file).find(r=>r.kind==='denied');assert.ok(denied.senderId&&denied.windowId);assert.equal(denied.boundary,'before-original-handler');assert.ok(denied.senderUrl&&denied.profile&&denied.phase);assert.ok(!JSON.stringify(denied).includes('PRIVATE_SENTINEL'));
});
test('original trusted-handler rejection is retained and closes the run',async t=>{
 const f=await fixture(t,async()=>{throw Error('original trust rejected');});await assert.rejects(f.invoke(f.capture,'quickCaptureState',{}));const row=native.records(f.file).find(r=>r.kind==='native-exception');assert.equal(row.boundary,'original-handler-exception');assert.equal(row.windowRole,'capture');assert.ok(fs.existsSync(path.join(f.dir,'stopped.json')));
});
for(const scenario of ['accept','draft','hide'])test('phase STOP blocks '+scenario+' before original handler',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return {data:{}};});fs.mkdirSync(path.join(f.dir,'f04'));fs.writeFileSync(path.join(f.dir,'f04/STOP'),'');
 if(scenario==='accept')await f.invoke(f.main,'uiCommand',{action:'taskAction',input:{id:'target',command:'accept'}});
 if(scenario==='draft')await f.invoke(f.capture,'quickCaptureDraft',{occupied:false});
 if(scenario==='hide')await f.invoke(f.capture,'quickCaptureHide',{});
 assert.equal(calls,0);assert.equal(native.records(f.file).find(r=>r.kind==='denied').reason,'closed-window');
});
test('data URL rejection logs protocol and hash without its body',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return {data:{}};});const other=f.make(3,f.mainSession);other.webContents.mainFrame.url='data:text/html,PRIVATE_SENTINEL';other.title='x'.repeat(500);
 await f.invoke(other,'quickCaptureState',{});const rows=native.records(f.file);assert.equal(calls,0);assert.ok(!JSON.stringify(rows).includes('PRIVATE_SENTINEL'));
 const row=rows.find(r=>r.kind==='denied');assert.match(row.senderUrl,/^<data: sha256=/);assert.ok(row.windowTitle.length<=120);
});
for(const scenario of ['read-after-quit','capture-state-after-quit','read-before-quit','accept-after-quit','draft-after-quit','hide-after-quit','different-read-error','extra-code','extra-committed','extra-data'])test('shutdown result boundary: '+scenario,async t=>{
 const response={error:scenario==='different-read-error'?'real read failure':'应用正在退出',...(scenario==='extra-code'?{code:'CLOSED'}:{}),...(scenario==='extra-committed'?{committed:false}:{}),...(scenario==='extra-data'?{data:{}}:{})},f=await fixture(t,async()=>response);
 if(scenario!=='read-before-quit')f.app.emit('before-quit',{});
 const result=scenario==='capture-state-after-quit'?await f.invoke(f.capture,'quickCaptureState',{}):scenario==='draft-after-quit'?await f.invoke(f.capture,'quickCaptureDraft',{occupied:false}):scenario==='hide-after-quit'?await f.invoke(f.capture,'quickCaptureHide',{}):scenario==='accept-after-quit'?await f.invoke(f.main,'uiCommand',{action:'taskAction',input:{id:'target',command:'accept'}}):await f.invoke(f.main,'stateView',{});
 assert.equal(result,response);const expected=scenario==='read-after-quit'||scenario==='capture-state-after-quit';assert.equal(fs.existsSync(path.join(f.dir,'stopped.json')),!expected);assert.equal(native.records(f.file).find(r=>r.kind==='native-command').expectedShutdown,expected);assert.equal(native.records(f.file).some(r=>r.kind==='shutdown-observed'),scenario!=='read-before-quit');
});
function sessionFixture(t){
 const output=path.resolve(id.root,'../foundation-native-ui-runs-20261030/unit-'+crypto.randomUUID());let time=1000;
 t.mock.method(id,'frozen',()=>({plan}));t.mock.method(id,'verifyRunner',()=>{});
 t.after(()=>{if(fs.existsSync(output)){assert.ok(path.basename(fs.realpathSync(output)).startsWith('unit-'));fs.rmSync(output,{recursive:true,force:true});}});
 return {output,begin:()=>sessions.begin({output,executable:'UNIT-NONE',mode:'offline',readyReference:'UNIT',now:()=>time}),time:v=>time=v};
}
test('F04-only plan rejects model budget and prior multi-stage authorization',()=>{
 id.validatePlan(plan);for(const key of ['modelApplicationAttempts','maximumModelDispatches','inputPlusOutputTokens','windowMinutes']){const p=structuredClone(plan);p.budget[key]++;assert.throws(()=>id.validatePlan(p));}
 const a={schema:1,grantedBy:'user',reference:'UNIT',scope:plan.scope,runnerIdentity:'a'.repeat(64),sealIdentity:id.SAMPLE,asarSha256:plan.asarSha256,planSha256:id.sha(JSON.stringify(plan)),modelApplicationAttempts:0,maximumModelDispatches:0,inputPlusOutputTokens:0,phaseWindowsMinutes:{f04:45},humanParticipationConfirmed:true};id.validateAuthorization(a,plan,a.runnerIdentity);
 for(const patch of [{scope:'old-suite'},{maximumModelDispatches:22},{inputPlusOutputTokens:620000},{phaseWindowsMinutes:{f04:45,gate:45,business:45}},{humanParticipationConfirmed:false}])assert.throws(()=>id.validateAuthorization({...a,...patch},plan,a.runnerIdentity));
});
test('live clock injection and direct engine entry are refused',async()=>{assert.throws(()=>sessions.begin({mode:'live',readyReference:'UNIT',now:()=>0}));await assert.rejects(require('../evaluations/foundation-native-ui-runner/engine.cjs').run({mode:'offline'}));});
for(const condition of ['deadline','backwards','STOP'])test('one-shot session closes on '+condition,t=>{const f=sessionFixture(t),s=f.begin();if(condition==='deadline')f.time(s.deadline);else if(condition==='backwards')f.time(s.startedAt-1);else fs.writeFileSync(path.join(f.output,'STOP'),'');assert.throws(()=>s.guard());assert.ok(fs.existsSync(path.join(f.output,'stopped.json')));assert.throws(()=>f.begin());});
test('session cannot finish with model activity or altered summary',async t=>{
 const f=sessionFixture(t),s=f.begin();fs.mkdirSync(s.phaseOutput);const summary={passed:true,mode:'offline',realModelCalls:0,modelCallsAdded:0,transportAttempts:[],actualHumanAcceptance:false};id.write(path.join(s.phaseOutput,'summary.json'),summary);
 await assert.rejects(s.finish({...summary,modelCallsAdded:1}));await assert.rejects(s.finish({...summary,transportAttempts:[{}]}));
 fs.writeFileSync(path.join(s.phaseOutput,'summary.json'),JSON.stringify({...summary,changed:true}));await assert.rejects(s.finish(summary));
});
