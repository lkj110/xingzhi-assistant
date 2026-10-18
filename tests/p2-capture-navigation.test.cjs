const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {Assistant}=require('../desktop/core.cjs');
const capture=require('../desktop/capture.cjs'),crypto=require('node:crypto');
const routes=['attention','capture','settings','board','help','guide','decisions','decisions:progress','decisions:review'];
const root=path.resolve(__dirname,'..');

function preload(){
 const ipcRenderer=new EventEmitter();let bridge;
 vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/preload.cjs'),'utf8'),{process:{argv:[]},require(name){assert.equal(name,'electron');return {ipcRenderer,contextBridge:{exposeInMainWorld(_name,value){bridge=value;}}};}});
 return {bridge,ipcRenderer};
}
test('sandbox preload publishes one immutable finite navigation contract and unsubscribes',()=>{
 const {bridge,ipcRenderer}=preload(),seen=[];
 const stop=bridge.onNavigate(value=>seen.push(value));
 for(const route of routes)ipcRenderer.emit('assistant:navigate',{},route);
 assert.deepEqual(seen,routes);
 assert.deepEqual(Array.from(bridge.navigationRoutes),routes);
 assert.ok(Object.isFrozen(bridge.navigationRoutes));
 assert.throws(()=>bridge.navigationRoutes.push('https://example.invalid'));
 for(const route of ['https://example.invalid','file:///etc/passwd','../help','decisions:other','Help','',null,{},['help']])ipcRenderer.emit('assistant:navigate',{},route);
 assert.deepEqual(seen,routes);
 stop();ipcRenderer.emit('assistant:navigate',{},'help');assert.deepEqual(seen,routes);
});
test('main, pending badges and quick-window producers emit only preload routes',async()=>{
 const sent=[],menu=[],categories=[],main=fs.readFileSync(path.join(root,'desktop/main.cjs'),'utf8');
 let ready,attention,showMain;
 class Window{constructor(){this.webContents={on(){},setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}},send(channel,page){if(channel==='assistant:navigate')sent.push(page);}};}loadFile(){}on(){}show(){}focus(){}isDestroyed(){return false;}}
 class Engine extends EventEmitter{constructor(){super();this.ready=Promise.resolve();}captureAdapter(){return {};}control(){return Promise.resolve();}}
 const electron={app:{setName(){},setPath(){},getPath(){return '/isolated';},requestSingleInstanceLock(){return true;},on(){},whenReady(){return {then(callback){ready=callback();return ready;}};}},BrowserWindow:Window,ipcMain:{handle(){}},Menu:{buildFromTemplate(value){menu.push(...value);return value;},setApplicationMenu(){}},Tray:class{setToolTip(){}on(){}},nativeImage:{createFromPath(){return {resize(){return {setTemplateImage(){}};}};}},powerMonitor:{on(){}},net:{isOnline(){return false;}}};
 vm.runInNewContext(main,{process:{env:{}},__dirname:path.join(root,'desktop'),setInterval(){},clearInterval(){},require(name){
  if(name==='electron')return electron;if(name==='node:path')return path;
  if(name==='./engine-client.cjs')return {EngineClient:Engine};
  if(name==='./native-bridge.cjs')return {createNativeBridge(options){attention=options.onAttention;return {};}};
  if(name==='./quick-capture.cjs')return {FLAG:'test',createController(options){showMain=options.showMain;return {reconcile(){},open(){}};}};
  if(name==='./screenshot.cjs')return {create(){return ()=>{};}};
  if(name==='./selection-capture.cjs')return {create(){return {reconcile(){}};}};
  if(name==='./pending-badges.cjs')return {create(options){const original=require('../desktop/pending-badges.cjs');const badge=original.create({...options,platform:'test',getCounts:()=>({total:2,progress:1,review:1}),tray:{setToolTip(){},setContextMenu(value){for(const item of value.slice(0,3))item.click();}},openPending(category){categories.push(category);options.openPending(category);}});return badge;}};
  throw Error('Unexpected main dependency '+name);
 }});
 await ready;
 attention();for(const page of ['capture','settings','board'])showMain(page);
 for(const item of menu.find(item=>item.label==='帮助').submenu)item.click();
 assert.deepEqual(categories,['all','progress','review']);
 const allowed=preload().bridge.navigationRoutes;
 for(const value of sent)assert.ok(allowed.includes(value),value);
 for(const value of routes)assert.ok(sent.includes(value),value);
 const quick=fs.readFileSync(path.join(root,'desktop/quick-capture.cjs'),'utf8');
 const match=quick.match(/input\.page!==undefined&&!\[([^\]]+)\]\.includes\(input\.page\)/);
 assert.ok(match);for(const value of match[1].matchAll(/'([^']+)'/g))assert.ok(allowed.includes(value[1]));
});

async function fixture(context){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p2-capture-'));
 const assistant=new Assistant({dir,chat:async()=>{throw Error('No real model');}});
 context.after(async()=>{await assistant.runPromise;fs.rmSync(dir,{recursive:true,force:true});});
 return assistant;
}
const file=(title,content,provenance)=>({title,base64:Buffer.from(content).toString('base64'),...(provenance===undefined?{}:{provenance})});
async function save(assistant,queued,items){
 if(queued)assistant.operation={label:'isolated busy'};
 try{await assistant.dispatch('captureSave',{items});}finally{if(queued)assistant.operation=null;}
 if(queued){assistant.tick();await assistant.runPromise;const row=assistant.data.captureQueue.at(-1);assert.equal(row.status,'completed',row.lastError);}
}
for(const queued of [false,true]){
 test(`per-file provenance survives ${queued?'queue':'idle'} import, duplicate and restart`,async context=>{
  const assistant=await fixture(context),first={kind:'screenshot',note:'first screenshot',appName:'Synthetic A',capturedAt:'2026-10-18T01:02:03Z',url:'https://u:p@example.invalid/a?token=secret&id=7#fragment',ignored:'strip'},second={kind:'file',appName:'Synthetic B',capturedAt:'2026-10-18T02:03:04Z'};
  const items=[file('first.txt','independent first text',first),file('second.txt','independent second text',second),file('legacy.txt','legacy input')];
  await save(assistant,queued,items);
  const source=name=>assistant.data.sources.find(row=>row.title===name);
  assert.deepEqual(source('first.txt').provenance,{kind:'screenshot',note:'first screenshot',appName:'Synthetic A',fileName:'first.txt',capturedAt:'2026-10-18T01:02:03.000Z',url:'https://example.invalid/a?id=7'});
  assert.equal(source('second.txt').provenance.appName,'Synthetic B');
  assert.equal(source('second.txt').provenance.capturedAt,'2026-10-18T02:03:04.000Z');
  assert.equal(source('legacy.txt').provenance.kind,'file');assert.equal(source('legacy.txt').provenance.fileName,'legacy.txt');assert.ok(Date.parse(source('legacy.txt').provenance.capturedAt));
  await save(assistant,queued,[file('first.txt','independent first text',{...first,appName:'Synthetic C',capturedAt:'2026-10-18T03:04:05Z'})]);
  assert.equal(assistant.data.sources.length,3);assert.equal(source('first.txt').provenance.appName,'Synthetic A');
  assert.equal(source('first.txt').captureOrigins[0].appName,'Synthetic C');
  assert.equal(source('first.txt').captureOrigins[0].capturedAt,'2026-10-18T03:04:05.000Z');
  const restored=new Assistant({dir:assistant.dir});assert.deepEqual(restored.data.sources,assistant.data.sources);
 });
 test(`malformed provenance and a bad second file remain atomic when ${queued?'queued':'idle'}`,async context=>{
  const assistant=await fixture(context);
  for(const invalid of ['bad',false,0,[],{capturedAt:'invalid'},{url:'file:///etc/passwd'},{note:1}]){
   await assert.rejects(save(assistant,queued,[file('good.txt','first'),file('bad.txt','second',invalid)]));
   assert.equal(assistant.data.sources.length,0);
  }
  const items=[file('good.txt','first'),file('bad.pdf','not a PDF')];
  if(queued){assistant.operation={label:'busy'};await assistant.dispatch('captureSave',{items});assistant.operation=null;assistant.tick();await assistant.runPromise;assert.equal(assistant.data.captureQueue.at(-1).status,'failed');}
  else await assert.rejects(assistant.dispatch('captureSave',{items}));
  assert.equal(assistant.data.sources.length,0);assert.equal(new Assistant({dir:assistant.dir}).data.sources.length,0);
 });
}
test('queued cancellation does not import any file',async context=>{
 const assistant=await fixture(context);assistant.operation={label:'busy'};
 await assistant.dispatch('captureSave',{items:[file('cancel.txt','cancelled text')]});
 const row=assistant.data.captureQueue.at(-1);
 await assistant.dispatch('captureCancel',{id:row.id});assistant.operation=null;assistant.tick();await assistant.runPromise;
 assert.equal(row.status,'cancelled');assert.equal(assistant.data.sources.length,0);
});
test('file defaults are bounded, sanitized and shared across legacy idle and queue inputs',()=>{
 const {forFile}=require('../desktop/capture-provenance.cjs');
 assert.deepEqual(forFile(undefined,'old.PNG','2026-10-18T00:00:00Z'),{kind:'screenshot',fileName:'old.PNG',capturedAt:'2026-10-18T00:00:00.000Z'});
 assert.deepEqual(forFile(null,'old.txt','2026-10-18T00:00:00Z'),{kind:'file',fileName:'old.txt',capturedAt:'2026-10-18T00:00:00.000Z'});
 const actual=forFile({kind:'unknown',fileName:'forged',appName:'a'.repeat(200),note:'n'.repeat(600),grant:true},'real.txt','2026-10-18T00:00:00Z');
 assert.equal(actual.kind,'manual');assert.equal(actual.fileName,'real.txt');assert.equal(actual.appName.length,120);assert.equal(actual.note.length,500);assert.equal(actual.grant,undefined);
});
for(const queued of [false,true])test(`legacy duplicate ${queued?'queue':'idle'} capture keeps first origin and appends its own time`,async context=>{
 const assistant=await fixture(context),items=[file('legacy.txt','same legacy body')];
 await save(assistant,queued,items);const original=structuredClone(assistant.data.sources[0].provenance);
 await new Promise(resolve=>setTimeout(resolve,5));await save(assistant,queued,items);
 assert.equal(assistant.data.sources.length,1);const source=assistant.data.sources[0];assert.deepEqual(source.provenance,original);
 assert.equal(source.captureOrigins.length,1);assert.equal(source.captureOrigins[0].kind,'file');assert.equal(source.captureOrigins[0].fileName,'legacy.txt');
 assert.ok(Date.parse(source.captureOrigins[0].capturedAt)>Date.parse(original.capturedAt));
 assert.deepEqual(new Assistant({dir:assistant.dir}).data.sources[0].captureOrigins,source.captureOrigins);
});
test('cancelled importDocuments parse commits neither file nor provenance',async context=>{
 const assistant=await fixture(context);
 const pending=assistant.dispatch('importDocuments',{items:[file('cancel.txt','cancelled import',{kind:'file',note:'must not persist'})]});
 assistant.controller.abort();await assert.rejects(pending);assert.equal(assistant.data.sources.length,0);assert.equal(assistant.operation,null);
});
test('desktop script contract requires fresh evidence and fails closed on a missing package',async context=>{
 const {argumentsFor,verify}=require('../scripts/p2-desktop-smoke.cjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'p2-desktop-contract-'));context.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const output=path.join(directory,'report.json');
 assert.throws(()=>argumentsFor([]),/--output/);assert.throws(()=>argumentsFor(['--app']),/Usage/);assert.throws(()=>argumentsFor(['--unknown']),/Usage/);
 assert.deepEqual(argumentsFor(['--output',output]),{output});
 const result=await verify(argumentsFor(['--app',path.join(directory,'missing.app'),'--output',output]));
 assert.equal(result.passed,false);assert.equal(result.processClosed,true);assert.equal(result.profileRemoved,true);assert.ok(result.errors.length);
 assert.deepEqual(JSON.parse(fs.readFileSync(output)),result);
 const bytes=fs.readFileSync(output);await assert.rejects(verify({output}),/overwrite/);assert.deepEqual(fs.readFileSync(output),bytes);
});

const manualSource={kind:'manual',url:'https://user:password@example.invalid/manual?id=19&token=secret#fragment',note:'Explicit batch note',appName:'Not a file origin',capturedAt:'2026-10-01T00:00:00Z'};
const manualFields={url:'https://example.invalid/manual?id=19',note:'Explicit batch note'};
const originCases=[
 {name:'explicit manual',provenance:manualSource,fields:manualFields},
 {name:'absent kind',provenance:{...manualSource,kind:undefined},fields:{}},
 {name:'unknown kind',provenance:{...manualSource,kind:'unknown'},fields:{}},
 {name:'automatic selection',provenance:{...manualSource,kind:'selection'},fields:{}},
 {name:'mixed text',provenance:manualSource,textItems:[{title:'text origin',content:'independent text origin'}],fields:{}},
 {name:'no top provenance',fields:{}},
 {name:'manual without fields',provenance:{kind:'manual',capturedAt:manualSource.capturedAt},fields:{}}
];
for(const restart of [false,true])for(const sample of originCases){
 test(`two-hop ${restart?'cold restart':'normal read'} preserves ${sample.name} decision`,async context=>{
  const assistant=await fixture(context),own={kind:'file',appName:'Independent file',url:'https://example.invalid/own',note:'Own note',capturedAt:'2026-10-18T09:10:11+08:00'};
  const expected=[{kind:'file',...sample.fields},{kind:'file',...sample.fields},{...own,capturedAt:'2026-10-18T01:10:11.000Z'},{kind:'manual'}];
  assistant.operation={label:'hold before durable read'};
  await capture.dispatch(assistant,'captureEnqueue',{items:[file('absent.txt','absent body'),file('null.txt','null body',null),file('own.txt','own body',own),file('empty.txt','empty object body',{})],textItems:sample.textItems||[],provenance:sample.provenance});
  const row=assistant.data.captureQueue[0],stored=JSON.parse(fs.readFileSync(path.join(assistant.dir,'capture-payloads',row.id+'.json')));
  assert.deepEqual(stored.items.map(item=>item.provenance),expected);
  const validated=capture.validate(assistant,stored).payload;
  assert.deepEqual(validated.items.map(item=>item.provenance),expected);
  assert.deepEqual(capture.validate(assistant,JSON.parse(JSON.stringify(validated))).payload.items.map(item=>item.provenance),expected);
  if(['absent kind','unknown kind'].includes(sample.name))assert.equal(stored.provenance.kind,'manual');
  const active=restart?new Assistant({dir:assistant.dir,chat:async()=>{throw Error('No model');}}):assistant;
  context.after(async()=>{await active.runPromise;});active.operation=null;capture.tick(active);await active.runPromise;
  assert.equal(active.data.captureQueue[0].status,'completed',active.data.captureQueue[0].lastError);
  for(const [index,item]of stored.items.entries()){
   const source=active.data.sources.find(source=>source.title===item.title);
   assert.deepEqual(source.provenance,{...expected[index],fileName:item.title,capturedAt:expected[index].capturedAt||row.createdAt});
  }
  assert.deepEqual(new Assistant({dir:assistant.dir}).data.sources,active.data.sources);
  assert.deepEqual(active.data.modelCalls||[],[]);
 });
}
for(const sample of [originCases[0],originCases[1],originCases[2],originCases[4]]){
 test(`old durable ${sample.name} follows stored contract without rewriting payload`,async context=>{
  const assistant=await fixture(context);assistant.operation={label:'old queue fixture'};
  await capture.dispatch(assistant,'captureEnqueue',{items:[file('old.txt','old payload body')],provenance:manualSource});
  const row=assistant.data.captureQueue[0],payloadFile=path.join(assistant.dir,'capture-payloads',row.id+'.json');
  const storedProvenance={...sample.provenance,...manualFields,capturedAt:'2026-10-01T00:00:00.000Z'};
  if(sample.name==='explicit manual')for(const kind of ['manual',undefined,'unknown'])assert.deepEqual(require('../desktop/capture-provenance.cjs').normalize({...manualSource,kind}),storedProvenance);
  const payload={items:[file('old.txt','old payload body')],textItems:sample.textItems||[],provenance:storedProvenance,projectId:null,organize:false};
  const bytes=JSON.stringify(payload);fs.writeFileSync(payloadFile,bytes);row.payloadBytes=Buffer.byteLength(bytes);row.payloadHash=crypto.createHash('sha256').update(bytes).digest('hex');row.createdAt='2026-10-10T01:02:03.000Z';assistant.save();
  const restored=new Assistant({dir:assistant.dir,chat:async()=>{throw Error('No model');}}),add=restored.addSources.bind(restored);context.after(async()=>{await restored.runPromise;});
  let fail=true;restored.addSources=(...args)=>{assert.equal(fs.readFileSync(payloadFile,'utf8'),bytes);if(fail){fail=false;throw Error('One isolated precommit failure');}return add(...args);};
  capture.tick(restored);await restored.runPromise;assert.equal(restored.data.captureQueue[0].status,'failed');assert.equal(restored.data.sources.length,0);
  assert.equal(fs.readFileSync(payloadFile,'utf8'),bytes);assert.equal(restored.data.captureQueue[0].payloadHash,row.payloadHash);
  await capture.dispatch(restored,'captureRetry',{id:row.id});await restored.runPromise;
  assert.equal(restored.data.captureQueue[0].status,'completed');
  assert.deepEqual(restored.data.sources.find(source=>source.title==='old.txt').provenance,{kind:'file',...sample.fields,fileName:'old.txt',capturedAt:row.createdAt});
  assert.equal(fs.existsSync(payloadFile),false);assert.deepEqual(restored.data.modelCalls||[],[]);
 });
}
test('manual compatibility never launders invalid per-file provenance or partially imports',async context=>{
 const assistant=await fixture(context);
 for(const invalid of [false,0,'bad',[],{url:'file:///etc/passwd'},{note:1},{capturedAt:'invalid'}]){
  await assert.rejects(capture.dispatch(assistant,'captureEnqueue',{items:[file('good.txt','good body'),file('bad.txt','bad body',invalid)],provenance:manualSource}));
  assert.equal(assistant.data.captureQueue.length,0);assert.equal(assistant.data.sources.length,0);
 }
 await capture.dispatch(assistant,'captureEnqueue',{items:[file('good.txt','good body'),file('bad.pdf','not a PDF')],provenance:manualSource});await assistant.runPromise;
 assert.equal(assistant.data.captureQueue[0].status,'failed');assert.equal(assistant.data.sources.length,0);
 assert.equal(new Assistant({dir:assistant.dir}).data.sources.length,0);
});
test('manual compatibility duplicates append only each new capture origin and timestamp',async context=>{
 const assistant=await fixture(context),origins=[manualSource,{...manualSource,url:'https://example.invalid/second',note:'Second explicit note'}];
 for(const provenance of origins){await capture.dispatch(assistant,'captureEnqueue',{items:[file('same.txt','same file body')],provenance});await assistant.runPromise;}
 const source=assistant.data.sources[0],rows=assistant.data.captureQueue;
 assert.equal(assistant.data.sources.length,1);assert.equal(source.captureOrigins.length,1);
 assert.deepEqual(source.provenance,{kind:'file',...manualFields,fileName:'same.txt',capturedAt:rows[0].createdAt});
 assert.deepEqual(source.captureOrigins[0],{kind:'file',url:origins[1].url,note:origins[1].note,fileName:'same.txt',capturedAt:rows[1].createdAt,captureId:rows[1].id});
 assert.deepEqual(new Assistant({dir:assistant.dir}).data.sources,assistant.data.sources);
});
test('quick fileItems snapshots edits, preserves invalid values and never mutates file origins',async()=>{
 const source=fs.readFileSync(path.join(root,'src/QuickCaptureWindow.jsx'),'utf8'),implementation=source.match(/ async function fileItems\(\)\{[\s\S]+?\n \}/);
 assert.ok(implementation);
 const own={kind:'screenshot',url:'https://example.invalid/own',note:'Own note',capturedAt:'2026-10-18T01:02:03Z'},invalid=[false,0,'bad',[]];
 const files=[{name:'own.txt',captureProvenance:own},{name:'legacy.txt'},...invalid.map((value,index)=>({name:'invalid-'+index+'.txt',captureProvenance:value}))];
 let release,selected;const pending=new Promise(resolve=>{release=resolve;});
 const context=vm.createContext({files,sourceEdits:{url:true},sourceUrl:'https://example.invalid/edited',sourceNote:'Untouched auto note',serializeCaptureFiles:async snapshot=>{selected=snapshot;await pending;return snapshot.map(file=>({title:file.name,base64:'Ym9keQ==',...(file.captureProvenance!==undefined?{provenance:file.captureProvenance}:{})}));}});
 vm.runInContext(implementation[0],context);const result=context.fileItems();
 context.sourceUrl='https://example.invalid/newer';context.sourceEdits={note:true};context.files=[];release();
 const items=JSON.parse(JSON.stringify(await result));assert.equal(selected.length,6);assert.notEqual(selected,files);
 assert.deepEqual(items[0].provenance,{...own,url:'https://example.invalid/edited'});assert.deepEqual(items[1].provenance,{kind:'file',url:'https://example.invalid/edited'});
 assert.deepEqual(items.slice(2).map(item=>item.provenance),invalid);assert.equal(own.url,'https://example.invalid/own');assert.equal(own.note,'Own note');
 context.files=[files[0]];context.sourceEdits={note:true};context.sourceNote='';const cleared=JSON.parse(JSON.stringify(await context.fileItems()));
 assert.deepEqual(cleared[0].provenance,{...own,note:''});assert.equal(own.note,'Own note');
});
