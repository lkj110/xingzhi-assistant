const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {_electron,expect}=require('playwright/test');
const execute=promisify(execFile),root=path.resolve(__dirname,'..');
const routes=['attention','capture','settings','board','help','guide','decisions','decisions:progress','decisions:review'];

function argumentsFor(values){
 const options={};
 for(let index=0;index<values.length;index++){
  const value=values[index];
  if(value==='--help'||value==='--b5-only')options[value.slice(2)]=true;
  else if(['--app','--output'].includes(value)&&values[index+1]&&!values[index+1].startsWith('--'))options[value.slice(2)]=path.resolve(values[++index]);
  else throw Error('Usage: node scripts/p2-desktop-smoke.cjs [--app <candidate.app>] --output <fresh-report.json> [--b5-only]');
 }
 if(!options.help&&!options.output)throw Error('--output <fresh-report.json> is required');
 return options;
}
function sha(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function seedWorkspace(){
 const path=require('node:path');
 const {Assistant}=require(path.join(process.env.P2_RUNTIME,'desktop/core.cjs'));
 const assistant=new Assistant({dir:path.join(process.env.P2_PROFILE,'workspace')});
 assistant.data.runtime.quickCapture={version:2,enabled:false,selectionEnabled:false,screenshotEnabled:false};
 assistant.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};
 assistant.data.settings.automatic=false;
 assistant.save();
}
async function verify(options){
 assert.ok(!fs.existsSync(options.output),'Refusing to overwrite prior evidence');
 fs.mkdirSync(path.dirname(options.output),{recursive:true});
 const result={passed:false,scope:options['b5-only']?'B5-only':'B5+B6',startedAt:new Date().toISOString(),scriptSHA256:sha(__filename),checks:[],errors:[],rendererErrors:[],realServices:0,paidModelCalls:0,pending:options['b5-only']?['B6 execution trust UI intentionally not checked']:[]};
 let run,app,server,page,quick,environment,executable,runtime,profile,busyRequest,heldResponse;
 const loopbackCalls=[],requests=[],stderr=[];
 const reportStem=options.output.replace(/\.json$/,'');
 async function closeApp(){
  if(!app)return;
  const current=app,child=current.process();app=null;
  try{await current.close();}catch(error){if(child.exitCode===null)child.kill('SIGKILL');throw error;}
  assert.notEqual(child.exitCode,null,'Isolated Electron process must exit');
 }
 try{
  run=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-p2-desktop-')));
  profile=path.join(run,'profile');fs.mkdirSync(profile);
  for(const name of ['home','codex','config','cache'])fs.mkdirSync(path.join(run,name));
  environment={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(run,'home'),CODEX_HOME:path.join(run,'codex'),XDG_CONFIG_HOME:path.join(run,'config'),XDG_CACHE_HOME:path.join(run,'cache'),TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',TZ:process.env.TZ||'Asia/Shanghai'};
  if(options.app){
   const bundle=fs.realpathSync(options.app);assert.ok(bundle.endsWith('.app'),'--app must identify a .app bundle');
   const info=JSON.parse((await execute('/usr/bin/plutil',['-convert','json','-o','-',path.join(bundle,'Contents/Info.plist')])).stdout);
   executable=path.join(bundle,'Contents/MacOS',info.CFBundleExecutable);
   runtime=path.join(bundle,'Contents/Resources/app.asar');
   result.candidate={bundle,executable,archiveSHA256:sha(runtime),version:info.CFBundleShortVersionString};
  }else{
   runtime=path.join(run,'app');fs.mkdirSync(runtime);
   for(const name of ['desktop','src','docs','index.html','package.json'])fs.cpSync(path.join(root,name),path.join(runtime,name),{recursive:true});
   fs.symlinkSync(path.join(root,'node_modules'),path.join(runtime,'node_modules'),'dir');
   const {build}=await import('vite'),{default:react}=await import('@vitejs/plugin-react');
   await build({configFile:false,root:runtime,base:'./',plugins:[react()],build:{outDir:path.join(runtime,'dist'),emptyOutDir:true}});
   executable=require('electron');
   result.candidate={source:root,development:true,version:JSON.parse(fs.readFileSync(path.join(runtime,'package.json'))).version,files:Object.fromEntries(['desktop/main.cjs','desktop/preload.cjs','desktop/core.cjs','desktop/capture.cjs','desktop/capture-provenance.cjs','src/App.jsx','src/QuickCaptureWindow.jsx','src/ScreenshotInput.jsx','src/CapabilitiesPage.jsx'].map(file=>[file,sha(path.join(runtime,file))]))};
  }
  await execute(executable,['-e',`(${seedWorkspace.toString()})()`],{env:{...environment,ELECTRON_RUN_AS_NODE:'1',P2_RUNTIME:runtime,P2_PROFILE:profile},timeout:30000});
  server=http.createServer((request,response)=>{
   let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',()=>{
    loopbackCalls.push({url:request.url,body:JSON.parse(body)});
    if(request.url!=='/v1/chat/completions'||heldResponse){response.writeHead(500);response.end('Unexpected loopback request');return;}
    heldResponse=response;
   });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const api=async(action,input={})=>page.evaluate(async({action,input})=>{const response=await window.assistant.call(action,input);if(response.error)throw Error(response.error);return response.data;},{action,input});
  const command=(action,input={})=>api('uiCommand',{action,input});
  const state=()=>api('state');
  async function launch(){
   app=await _electron.launch({executablePath:executable,args:[...(options.app?[]:[runtime]),'--user-data-dir='+profile],cwd:run,env:environment,timeout:30000});
   app.process().stderr?.on('data',chunk=>{stderr.push(String(chunk));if(stderr.length>60)stderr.shift();});
   page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>result.rendererErrors.push(error.message));
   await page.locator('.sidebar').waitFor();
   const identity=await app.evaluate(({app,BrowserWindow})=>({profile:app.getPath('userData'),packaged:app.isPackaged,appPath:app.getAppPath(),preferences:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()}));
   assert.equal(fs.realpathSync(identity.profile),profile);assert.equal(identity.packaged,!!options.app);assert.equal(identity.appPath,runtime);
   assert.equal(identity.preferences.sandbox,true);assert.equal(identity.preferences.contextIsolation,true);assert.equal(identity.preferences.nodeIntegration,false);
   const current=await state();assert.equal(current.storagePath,path.join(profile,'workspace'));
   const detection=await api('quickCaptureDetectionStatus');assert.equal(detection.selectionEnabled,false);assert.equal(detection.screenshotEnabled,false);assert.equal(detection.selectionRunning,false);
   result.identity={...identity,preferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}};
   await app.context().route(/^https?:/,route=>{requests.push(route.request().url());return route.abort();});
   await app.evaluate(({ipcMain})=>{
    const original=ipcMain._invokeHandlers.get('assistant:call');if(typeof original!=='function')throw Error('Production IPC handler unavailable');
    globalThis.p2CaptureProbe={requests:[],context:null};ipcMain.removeHandler('assistant:call');
    ipcMain.handle('assistant:call',async(event,action,input)=>{
     const probe=globalThis.p2CaptureProbe;
     if(['quickCaptureSuggest','quickCaptureSubmit'].includes(action))probe.requests.push(JSON.parse(JSON.stringify({action,items:(input.items||[]).map(({title,provenance})=>({title,provenance})),provenance:input.provenance,text:input.text,textItems:input.textItems})));
     if(action==='quickCaptureConsume'&&probe.context?.id===input.id){const response=await original(event,'quickCaptureState',{});if(!response.error)probe.context=null;return response;}
     const response=await original(event,action,input);
     if(action==='quickCaptureState'&&!response.error&&probe.context)return {...response,data:{...response.data,captureContext:probe.context,captureVisible:true,mini:false}};
     return response;
    });
   });
  }
  const navigate=async route=>{const window=await app.browserWindow(page);await window.evaluate((window,value)=>window.webContents.send('assistant:navigate',value),route);};
  await launch();
  const bridge=await page.evaluate(()=>({routes:window.assistant.navigationRoutes,frozen:Object.isFrozen(window.assistant.navigationRoutes)}));
  assert.deepEqual(bridge.routes,routes);assert.equal(bridge.frozen,true);
  const headings={attention:'关注中心',capture:'收集队列',settings:'模型与设置',board:'工作看板',help:'使用说明',decisions:'待我决策'};
  for(const route of routes){
   await navigate(route);
   if(route==='guide'){await expect(page.locator('.quickstart-body')).toBeVisible();await page.getByRole('button',{name:'暂时跳过',exact:true}).click();await expect(page.locator('.quickstart-body')).toHaveCount(0);}
   else if(route.startsWith('decisions'))await expect(page.getByLabel('筛选决定')).toHaveValue(route.includes(':')?'group:'+route.split(':')[1]:'all');
   else await expect(page.locator('.page-heading h1')).toHaveText(headings[route]);
  }
  for(const label of ['使用说明','快速上手']){
   await app.evaluate(({Menu},name)=>Menu.getApplicationMenu().items.find(item=>item.label==='帮助').submenu.items.find(item=>item.label===name).click(),label);
   if(label==='使用说明')await expect(page.locator('.help-page')).toBeVisible();
   else{await expect(page.locator('.quickstart-body')).toBeVisible();await page.getByRole('button',{name:'暂时跳过',exact:true}).click();await expect(page.locator('.quickstart-body')).toHaveCount(0);}
  }
  for(const [index,value]of ['all','group:progress','group:review'].entries()){
   await app.evaluate(({app},position)=>app.dock.getMenu().items[position].click(),index);
   await expect(page.getByLabel('筛选决定')).toHaveValue(value);
  }
  await navigate('board');await expect(page.locator('.page-heading h1')).toHaveText(headings.board);
  await page.evaluate(()=>{window.p2Routes=[];window.p2Unsubscribe=window.assistant.onNavigate(value=>window.p2Routes.push(value));});
  for(const route of ['file:///tmp/invalid','https://example.invalid','decisions:unknown',null,{},['help']])await navigate(route);
  await expect(page.locator('.page-heading h1')).toHaveText(headings.board);assert.deepEqual(await page.evaluate(()=>window.p2Routes),[]);
  await navigate('help');await expect.poll(()=>page.evaluate(()=>window.p2Routes)).toEqual(['help']);
  await page.evaluate(()=>window.p2Unsubscribe());await navigate('board');await expect(page.locator('.page-heading h1')).toHaveText(headings.board);
  assert.deepEqual(await page.evaluate(()=>window.p2Routes),['help']);result.checks.push('Actual sandbox preload → React: all nine routes, help menus, dock decision categories, rejected routes and unsubscribe');
  await command('saveProvider',{name:'P2 loopback only',type:'openai',model:'p2-local',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,inputPrice:0,outputPrice:0});
  const provider=(await state()).providers[0];
  async function startBusy(){
   busyRequest=command('testProvider',{id:provider.id}).then(value=>({value}),error=>({error:error.message}));
   await expect.poll(()=>!!heldResponse).toBe(true);await expect.poll(async()=>!!(await state()).operation).toBe(true);
  }
  async function releaseBusy(){
   assert.ok(heldResponse);heldResponse.writeHead(200,{'Content-Type':'application/json'});heldResponse.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));heldResponse=null;
   const outcome=await busyRequest;busyRequest=null;assert.ok(!outcome.error,outcome.error);
  }
  async function openCapture(small){
   if(!small){await navigate('board');await page.getByRole('button',{name:'收集信息',exact:true}).click();return page;}
   const opened=quick?null:app.waitForEvent('window');await page.getByRole('button',{name:'快速收集',exact:true}).click();
   if(opened){quick=await opened;quick.setDefaultTimeout(15000);quick.on('pageerror',error=>result.rendererErrors.push(error.message));}
   await expect(quick.getByRole('heading',{name:'快速记录事项',exact:true})).toBeVisible();
   await quick.getByRole('button',{name:'新建事项',exact:true}).click();
   return quick;
  }
  async function addFiles(target,label){
   const expected=await target.evaluate(async tag=>{
    const form=document.querySelector('.quick-capture-window form')||document.querySelector('.modal form');
    const imageNames=[];
    for(const suffix of ['ALPHA','BRAVO']){
     const canvas=document.createElement('canvas');canvas.width=900;canvas.height=180;const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,900,180);context.fillStyle='black';context.font='36px sans-serif';context.fillText(`${tag} ${suffix} 7429`,25,90);
     const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const clipboard=new DataTransfer();clipboard.items.add(new File([blob],suffix+'.png',{type:'image/png'}));
     form.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}));
     await new Promise(resolve=>setTimeout(resolve,30));imageNames.push([...document.querySelectorAll('.file-chip')].at(-1).textContent);
    }
    const annotated=new File([tag+' annotated provenance body'],tag+'-annotated.txt',{type:'text/plain'});
    annotated.captureProvenance={kind:'file',appName:'P2 synthetic source',windowTitle:tag,note:'Per-file origin',capturedAt:'2026-10-18T10:11:12Z',url:'https://u:p@example.invalid/doc?id=7&token=secret#fragment'};
    window.p2OriginalFiles||={};window.p2OriginalFiles[tag]=annotated;
    const transfer=new DataTransfer();transfer.items.add(annotated);const drop=document.querySelector('.quick-capture-drop,.drop-zone');drop.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    return {imageNames,annotated:annotated.name};
   },label);
   await target.getByLabel(target===quick?'快速收集文件':'导入材料文件',{exact:true}).setInputFiles({name:label+'-legacy.txt',mimeType:'text/plain',buffer:Buffer.from(label+' legacy body')});
   await expect(target.locator('.file-chip')).toHaveCount(4);
   return {...expected,legacy:label+'-legacy.txt'};
  }
  const saved=[];
  for(const small of [false,true])for(const busy of [false,true]){
   const label=`P2-${small?'quick':'main'}-${busy?'queue':'idle'}`;
   if(busy)await startBusy();
   const target=await openCapture(small),expected=await addFiles(target,label),before=(await state()).sources.length;
   if(small){
    await target.getByRole('button',{name:'仅保存材料',exact:true}).click();
   }else await target.getByRole('button',{name:'保存材料',exact:true}).click();
   if(busy){await expect.poll(async()=>(await state()).captureQueue.some(row=>row.status==='queued'&&row.itemTitles.includes(expected.legacy))).toBe(true);assert.equal((await state()).sources.length,before);await releaseBusy();}
   await expect.poll(async()=>(await state()).sources.length,{timeout:30000}).toBe(before+4);
   await expect.poll(async()=>!(await state()).operation).toBe(true);
   const current=await state(),legacy=current.sources.find(source=>source.title===expected.legacy),annotated=current.sources.find(source=>source.title===expected.annotated);
   assert.deepEqual(annotated.provenance,{kind:'file',appName:'P2 synthetic source',windowTitle:label,fileName:expected.annotated,note:'Per-file origin',capturedAt:'2026-10-18T10:11:12.000Z',url:'https://example.invalid/doc?id=7'});
   assert.equal(legacy.provenance.kind,'file');assert.equal(legacy.provenance.fileName,expected.legacy);assert.ok(Date.parse(legacy.provenance.capturedAt));assert.equal(legacy.provenance.appName,undefined);
   const images=current.sources.filter(source=>expected.imageNames.includes(source.title));
   assert.equal(images.length,2);assert.notEqual(images[0].provenance.capturedAt,images[1].provenance.capturedAt);
   for(const source of images){assert.equal(source.provenance.kind,'screenshot');assert.equal(source.provenance.note,'剪贴板图片');assert.equal(source.provenance.fileName,source.title);assert.ok(Date.parse(source.provenance.capturedAt));}
   const disk=JSON.parse(fs.readFileSync(path.join(profile,'workspace/workspace.json')));
   for(const source of [legacy,annotated,...images]){assert.deepEqual(disk.sources.find(item=>item.id===source.id).provenance,source.provenance);saved.push({id:source.id,provenance:source.provenance});}
   result.checks.push(label+': real File/FileReader → IPC → production Worker → durable per-file origins; two pasted PNGs + annotated text + legacy file');
  }
  const manualURL='https://example.invalid/explicit?id=19',manualNote='Explicit UI file note';
  const observed=()=>app.evaluate(()=>globalThis.p2CaptureProbe.requests);
  const sourceFields=()=>({url:quick.getByLabel('快速收集来源链接',{exact:true}),note:quick.getByLabel('快速收集来源说明',{exact:true})});
  async function showSource(){const details=quick.locator('details').filter({has:quick.locator('summary').filter({hasText:'信息来源'})});if(await details.getAttribute('open')===null)await details.locator('summary').click();}
  async function captureContext(label){
   const context={id:crypto.randomUUID(),text:label+' automatic selected text',provenance:{kind:'selection',appName:'Synthetic text app',windowTitle:'Synthetic text window',url:'https://example.invalid/automatic',note:'Automatic text note',capturedAt:'2026-10-17T09:08:07Z'}};
   await app.evaluate((_electron,context)=>{globalThis.p2CaptureProbe.context=context;},context);
   const window=await app.browserWindow(quick);await window.evaluate(window=>window.webContents.send('assistant:quick-capture-changed'));
   await quick.getByRole('button',{name:'加入当前草稿',exact:true}).click();
   await expect(quick.getByLabel('快速收集正文',{exact:true})).toHaveValue(context.text);
   return context;
  }
  async function rememberSources(names){
   const current=await state(),disk=JSON.parse(fs.readFileSync(path.join(profile,'workspace/workspace.json')));
   const sources=names.map(name=>current.sources.find(source=>source.title===name));
   for(const source of sources){assert.ok(source);assert.deepEqual(disk.sources.find(item=>item.id===source.id).provenance,source.provenance);saved.push({id:source.id,provenance:source.provenance});}
   return sources;
  }
  for(const busy of [false,true]){
   const label='B5-IR-manual-'+(busy?'queue':'idle'),name=label+'.txt';if(busy)await startBusy();
   await openCapture(true);await quick.getByLabel('快速收集文件',{exact:true}).setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(label+' body')});await showSource();
   const fields=sourceFields(),before=(await state()).sources.length;await fields.url.fill(busy?manualURL:'file:///invalid-source');await fields.note.fill(manualNote);
   if(!busy){
    await quick.getByRole('button',{name:'仅保存材料',exact:true}).click();await expect(quick.locator('.form-error').filter({hasText:'HTTP'})).toBeVisible();assert.equal((await state()).sources.length,before);
    await quick.getByRole('button',{name:'隐藏快速收集窗口',exact:true}).click();await openCapture(true);await expect(fields.url).toHaveValue('file:///invalid-source');await expect(fields.note).toHaveValue(manualNote);await fields.url.fill(manualURL);
   }
   await expect.poll(async()=>{const request=(await observed()).findLast(request=>request.action==='quickCaptureSuggest'&&request.items.some(item=>item.title===name));return request?.items[0]?.provenance;}).toEqual({kind:'file',url:manualURL,note:manualNote});
   await quick.getByRole('button',{name:'仅保存材料',exact:true}).click();
   if(busy){await expect.poll(async()=>(await state()).captureQueue.find(row=>row.itemTitles.includes(name))?.status).toBe('queued');assert.equal((await state()).sources.length,before);const row=(await state()).captureQueue.find(row=>row.itemTitles.includes(name));const payload=JSON.parse(fs.readFileSync(path.join(profile,'workspace/capture-payloads',row.id+'.json')));assert.deepEqual(payload.items[0].provenance,{kind:'file',url:manualURL,note:manualNote});await releaseBusy();}
   await expect.poll(async()=>(await state()).sources.length,{timeout:30000}).toBe(before+1);await expect.poll(async()=>!(await state()).operation).toBe(true);
   const request=(await observed()).findLast(request=>request.action==='quickCaptureSubmit'&&request.items.some(item=>item.title===name));assert.deepEqual(request.items[0].provenance,{kind:'file',url:manualURL,note:manualNote});assert.equal(request.textItems.length,0);
   const [source]=await rememberSources([name]),row=(await state()).captureQueue.find(row=>row.itemTitles.includes(name));assert.deepEqual(source.provenance,{kind:'file',url:manualURL,note:manualNote,fileName:name,capturedAt:row.createdAt});
   result.checks.push(label+': normal files-only UI, explicit serialized fields, production queue/disk; '+(busy?'busy admission':'validation failure and hide/reopen preserve edits'));
  }
  result.manualUIEvidence=[];
  for(const mode of ['none','url','note','clear']){
   const label='B5-IR-mixed-'+mode,busy=mode==='url';if(busy)await startBusy();await openCapture(true);
   if(mode==='none'){
    await showSource();await sourceFields().url.fill('https://example.invalid/discarded');await sourceFields().note.fill('discarded draft');await quick.getByRole('button',{name:'清空草稿',exact:true}).click();await quick.getByRole('button',{name:'新建事项',exact:true}).click();
   }
   const expected=await addFiles(quick,label);await showSource();const fields=sourceFields();
   if(mode==='url')await fields.url.fill(manualURL);if(mode==='note')await fields.note.fill(manualNote);
   const captured=await captureContext(label);
   await expect(fields.url).toHaveValue(mode==='url'?manualURL:captured.provenance.url);await expect(fields.note).toHaveValue(mode==='note'?manualNote:captured.provenance.note);
   if(mode==='clear'){await fields.url.fill('');await fields.note.fill('');}
   const edits=mode==='url'?{url:manualURL}:mode==='note'?{note:manualNote}:mode==='clear'?{url:'',note:''}:{};
   const expectedOwn={kind:'file',appName:'P2 synthetic source',windowTitle:label,note:'Per-file origin',capturedAt:'2026-10-18T10:11:12Z',url:'https://u:p@example.invalid/doc?id=7&token=secret#fragment'};
   await expect.poll(async()=>{const request=(await observed()).findLast(request=>request.action==='quickCaptureSuggest'&&request.items.some(item=>item.title===expected.legacy));return request?.items.find(item=>item.title===expected.annotated)?.provenance;}).toEqual({...expectedOwn,...edits});
   const before=(await state()).sources.length;
   if(mode==='note')await quick.evaluate(()=>{const read=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(file){FileReader.prototype.readAsDataURL=read;window.p2ReleaseRead=()=>{read.call(this,file);delete window.p2ReleaseRead;};};});
   await quick.getByRole('button',{name:'仅保存材料',exact:true}).click();
   if(mode==='note'){await expect.poll(()=>quick.evaluate(()=>typeof window.p2ReleaseRead)).toBe('function');await fields.note.fill('Newer draft during FileReader');await quick.evaluate(()=>window.p2ReleaseRead());}
   if(busy){await expect.poll(async()=>(await state()).captureQueue.find(row=>row.itemTitles.includes(expected.legacy))?.status).toBe('queued');assert.equal((await state()).sources.length,before);await releaseBusy();}
   await expect.poll(async()=>(await state()).sources.length,{timeout:30000}).toBe(before+5);await expect.poll(async()=>!(await state()).operation).toBe(true);
   const request=(await observed()).findLast(request=>request.action==='quickCaptureSubmit'&&request.items.some(item=>item.title===expected.legacy));
   assert.deepEqual(request.items.find(item=>item.title===expected.annotated).provenance,{...expectedOwn,...edits});
   assert.deepEqual(request.items.find(item=>item.title===expected.legacy).provenance,mode==='none'?undefined:{kind:'file',...edits});
   assert.deepEqual(await quick.evaluate(tag=>window.p2OriginalFiles[tag].captureProvenance,label),expectedOwn);
   const sources=await rememberSources([...expected.imageNames,expected.annotated,expected.legacy,captured.text]),row=(await state()).captureQueue.find(row=>row.itemTitles.includes(expected.legacy));
   for(const source of sources.slice(0,4)){
    const own=source.title===expected.annotated,image=expected.imageNames.includes(source.title),provenance=source.provenance;
    assert.equal(provenance.kind,image?'screenshot':'file');assert.equal(provenance.fileName,source.title);assert.equal(provenance.appName,own?'P2 synthetic source':undefined);
    assert.equal(provenance.url,mode==='url'?manualURL:mode==='clear'?undefined:own?'https://example.invalid/doc?id=7':undefined);
    assert.equal(provenance.note,mode==='note'?manualNote:mode==='clear'?undefined:own?'Per-file origin':image?'剪贴板图片':undefined);
    assert.equal(provenance.capturedAt,own?'2026-10-18T10:11:12.000Z':image?request.items.find(item=>item.title===source.title).provenance.capturedAt:row.createdAt);
   }
   assert.deepEqual(sources[4].provenance,{kind:'selection',appName:'Synthetic text app',windowTitle:'Synthetic text window',capturedAt:'2026-10-17T09:08:07.000Z',...(mode==='clear'?{}:{url:mode==='url'?manualURL:captured.provenance.url,note:mode==='note'?manualNote:captured.provenance.note})});
   result.manualUIEvidence.push({mode,serialized:request,sources:sources.map(source=>({title:source.title,provenance:source.provenance}))});
   if(mode==='note'){await openCapture(true);await expect(fields.note).toHaveValue('Newer draft during FileReader');await quick.getByRole('button',{name:'清空草稿',exact:true}).click();}
   result.checks.push(label+': synthetic native text + ScreenshotInput PNGs + independent files; only edited fields propagate, input objects unchanged'+(mode==='note'?'; FileReader snapshot and newer draft preserved':''));
  }
  result.syntheticNativeContext='Read-only quickCaptureState/Consume fixture; Suggest/Submit payloads observed but forwarded unchanged to production IPC/Worker; no OS capture';
  if(!options['b5-only']){
   const repository=path.join(run,'synthetic-dw'),marker=path.join(run,'unwanted-python-execution');
   for(const directory of ['.agents/skills/dw','scripts/governance/lint'])fs.mkdirSync(path.join(repository,directory),{recursive:true});
   fs.writeFileSync(path.join(repository,'package.json'),JSON.stringify({name:'@bytedance-dev/dw-agent-team',version:'0.0.0-fixture'}));
   fs.writeFileSync(path.join(repository,'AGENTS.md'),'Synthetic local DW documentation');fs.writeFileSync(path.join(repository,'.agents/skills/dw/SKILL.md'),'Synthetic read-only guidance');
   for(const name of ['_lint_common.py','sql_anti_pattern_linter.py','py_anti_pattern_linter.py'])fs.writeFileSync(path.join(repository,'scripts/governance/lint',name),`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("unexpected execution")\n`);
   await navigate('settings');await expect(page.locator('.page-heading h1')).toHaveText(headings.settings);await page.getByRole('button',{name:'能力中心',exact:true}).click();await page.getByRole('button',{name:'添加仓库',exact:true}).click();
   const mode=page.getByLabel('DW 脚本执行信任',{exact:true});
   await expect(mode).toHaveCount(1);await expect(mode).toHaveValue('pinned');
   assert.equal(await mode.locator('option[value="trusted_latest"]').count(),1);
   await page.getByLabel('能力仓库路径',{exact:true}).fill(repository);
   await page.getByLabel('能力名称',{exact:true}).fill('P2 synthetic DW');
   await page.getByRole('button',{name:'检查能力',exact:true}).click();
   const preview=page.getByRole('region',{name:'能力检查结果',exact:true});
   await expect(preview).toContainText('固定本次检查脚本');await expect(preview.locator('code')).toHaveText(/^[a-f0-9]{64}$/);
   const consent=page.getByLabel('我确认上述 DW 脚本执行信任与风险',{exact:true});
   await expect(consent).not.toBeChecked();await expect(page.getByRole('button',{name:'挂载所选能力',exact:true})).toBeDisabled();
   await mode.selectOption('trusted_latest');
   await expect(preview).toHaveCount(0);await expect(consent).toHaveCount(0);
   const body=await page.locator('.capability-center').innerText();assert.match(body,/当前用户/);assert.match(body,/文件/);assert.match(body,/网络/);assert.match(body,/不是.*沙箱|不.*操作系统.*沙箱/);
   assert.match(body,/费用.*不约束子进程/);assert.match(body,/费用未知/);assert.match(body,/不支持降级/);
   await page.getByRole('button',{name:'检查能力',exact:true}).click();await expect(preview).toContainText('信任后续脚本更新');
   await consent.check();await page.getByRole('button',{name:'挂载所选能力',exact:true}).click();
   await expect.poll(async()=>(await state()).capabilities[0]?.executionTrust?.mode).toBe('trusted_latest');
   const entry=page.getByRole('article',{name:'能力 P2 synthetic DW',exact:true});await entry.getByRole('button',{name:'编辑',exact:true}).click();
   await expect(mode).toHaveValue('trusted_latest');await mode.selectOption('pinned');await page.getByRole('button',{name:'检查能力',exact:true}).click();
   await expect(consent).not.toBeChecked();await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();await consent.check();await page.getByRole('button',{name:'保存配置',exact:true}).click();
   await expect.poll(async()=>(await state()).capabilities[0]?.executionTrust?.mode).toBe('pinned');
   assert.equal(fs.existsSync(marker),false);result.checks.push('B6: actual preview/consent/save/edit UI for pinned and trusted_latest, stale preview cleared, digest and full risks visible; zero Python execution');
  }
  const beforeRestart=await state();assert.equal(loopbackCalls.length,4);assert.equal(beforeRestart.modelCalls.length,4);
  for(const call of beforeRestart.modelCalls)assert.equal(call.providerId,provider.id);
  assert.deepEqual(requests,[]);assert.deepEqual(result.rendererErrors,[]);
  result.captureEvidence=saved;result.loopbackModelCalls=loopbackCalls.length;
  await page.screenshot({path:reportStem+'-ui.png'});
  await closeApp();quick=null;await launch();
  const restored=await state();for(const source of saved)assert.deepEqual(restored.sources.find(item=>item.id===source.id).provenance,source.provenance);
  assert.equal(restored.sources.length,38);assert.deepEqual(restored.modelCalls,beforeRestart.modelCalls);
  assert.deepEqual(restored.capabilities,beforeRestart.capabilities);
  result.checks.push('Full Electron/Worker restart preserves all 38 file/text origins and synthetic call receipts');
 }catch(error){
  result.errors.push(error.stack||String(error));
  try{if(page&&!page.isClosed()){await page.screenshot({path:reportStem+'-failure.png'});fs.writeFileSync(reportStem+'-failure-ui.txt',await page.locator('body').innerText(),{flag:'wx'});}}catch(evidenceError){result.errors.push('Failure evidence: '+evidenceError.message);}
  try{if(quick&&!quick.isClosed()){await quick.screenshot({path:reportStem+'-failure-quick.png'});fs.writeFileSync(reportStem+'-failure-quick-ui.txt',await quick.locator('body').innerText(),{flag:'wx'});}}catch(evidenceError){result.errors.push('Quick failure evidence: '+evidenceError.message);}
 }
 finally{
  heldResponse?.destroy();heldResponse=null;
  try{await closeApp();result.processClosed=true;}catch(error){result.errors.push('Cleanup: '+error.message);result.processClosed=false;}
  server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
  try{if(run)fs.rmSync(run,{recursive:true,force:true});result.profileRemoved=!run||!fs.existsSync(run);}catch(error){result.errors.push('Profile cleanup: '+error.message);result.profileRemoved=false;}
  result.finishedAt=new Date().toISOString();result.rendererRequests=requests;result.rendererErrors=[...new Set(result.rendererErrors)];result.stderr=stderr.join('').slice(-16000);
  result.passed=result.errors.length===0&&result.rendererErrors.length===0&&result.profileRemoved&&result.processClosed;
  fs.writeFileSync(options.output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 }
 return result;
}
if(require.main===module){
 (async()=>{const options=argumentsFor(process.argv.slice(2));if(options.help){console.log('node scripts/p2-desktop-smoke.cjs [--app <candidate.app>] --output <fresh-report.json> [--b5-only]\nWithout --app: build current dev source in an isolated temporary directory. --b5-only explicitly excludes B6 UI; release gate must omit it.');return;}const result=await verify(options);console.log(JSON.stringify({passed:result.passed,checks:result.checks,errors:result.errors,output:options.output},null,2));if(!result.passed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
}
module.exports={argumentsFor,verify};
