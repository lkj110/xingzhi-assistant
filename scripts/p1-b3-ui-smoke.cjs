// B3: real renderer -> preload -> production main -> actual Worker, isolated only.
// No install, packaging, model, OS credential or external service is used.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron,expect}=require('playwright/test');
const root=path.resolve(__dirname,'..'),report=process.env.B3_ARTIFACT_DIR;
if(!report||!path.isAbsolute(report))throw Error('Set B3_ARTIFACT_DIR to the private evidence directory');
fs.mkdirSync(report,{recursive:true});
const run=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'b3-ui-'))),runtime=path.join(run,'app'),profile=path.join(run,'profile'),fixture=path.join(run,'fixture.cjs');
fs.mkdirSync(runtime);fs.mkdirSync(profile);
fs.cpSync(path.join(root,'desktop'),path.join(runtime,'desktop'),{recursive:true});
fs.copyFileSync(path.join(root,'package.json'),path.join(runtime,'package.json'));
fs.symlinkSync(path.join(root,'node_modules'),path.join(runtime,'node_modules'),'dir');
const desktop=path.join(runtime,'desktop');
fs.writeFileSync(fixture,`const desktop=${JSON.stringify(desktop)};\n`+String.raw`
const fs=require('node:fs'),path=require('node:path');
exports.create=async({Assistant,options})=>{
 const calls=[],denied=async()=>{calls.push('external');throw Error('External calls prohibited');};
 require(path.join(desktop,'subscription.cjs')).status=async()=>({available:false,loggedIn:false,message:'isolated offline fixture'});
 class Fixture extends Assistant{
  tick(){}
  save(){
   if(!this.boundaryFault)return super.save();
   const after=this.boundaryFault==='after';this.boundaryFault=null;
   const key=after?'readFileSync':'renameSync',original=fs[key],file=this.file,ledger=path.join(this.dir,'action-ledger.json');let fired=false;
   fs[key]=function(target,...args){if(!fired&&(after?target===ledger:args[0]===file)){fired=true;throw Object.assign(Error('B3 injected '+(after?'afterSave':'rename')+' failure'),{code:after?'EIO':'ENOSPC'});}return original.call(this,target,...args);};
   try{return super.save();}finally{fs[key]=original;if(!fired)throw Error('Fault did not fire');}
  }
  async dispatch(action,input={}){
   if(action==='b3Fault'){this.fault=input;this.snapshotBlocked=false;return {ok:true};}
   if(action==='b3Probe')return {threadId:require('node:worker_threads').threadId,calls,trace:this.trace||[],data:this.data,basis:require(path.join(desktop,'acceptance.cjs')).basis(this,this.task(this.acceptedId))};
   if(action==='stateView'&&this.refreshFails){this.refreshFails--;throw Object.assign(Error('B3 renderer refresh failed'),{code:'EIO'});}
   if(action==='intakeRoutingSnapshot'&&this.snapshotBlocked)throw Error('B3 snapshot temporarily unavailable');
   if(action==='intakeRoutingSave')(this.trace||=[]).push(JSON.parse(JSON.stringify(input)));
   const mode=this.fault?.action===action?this.fault.mode:null;
   if(mode){this.fault=null;if(['before','after'].includes(mode))this.boundaryFault=mode;if(mode==='after-refresh'){this.boundaryFault='after';this.refreshFails=1;}}
   if(mode==='unknown-before')throw Error('B3 response lost before dispatch');
   const result=await super.dispatch(action,input);
   if(mode==='refresh')this.refreshFails=1;
   if(mode==='unknown'){this.snapshotBlocked=true;throw Error('B3 unknown response');}
   if(mode==='unknown-readable')throw Error('B3 response lost after dispatch');
   return result;
  }
 }
 const a=new Fixture({...options,chat:denied,agentRequest:denied,webRequest:denied,feedRequest:denied,connectorRequest:denied,officeRequest:denied});
 await a.dispatch('saveProvider',{name:'isolated model',model:'fixture',type:'ollama',baseUrl:'http://127.0.0.1:9',inputPrice:0,outputPrice:0});
 await a.dispatch('projectSave',{name:'B3隔离项目'});const p=a.data.projects[0];
 await a.dispatch('createTask',{title:'B3待恢复事项',criteria:'只用于故障验证'});await a.dispatch('taskAction',{id:a.data.tasks[0].id,command:'pause'});
 const agent=require(path.join(desktop,'agent.cjs')),j=agent.buildJob(a,{projectId:p.id,goal:'B3验收保护',fileMode:'off',allowWeb:false,maxCalls:20});a.data.delegations.push(j);
 const one=await agent.act(a,j,'plan_task',{key:'one',title:'B3已验收子项',criteria:'固定依据',steps:[{kind:'draft',title:'固定报告'}]});
 await agent.act(a,j,'plan_task',{key:'two',title:'B3未完成子项',criteria:'独立结果',steps:[{kind:'draft',title:'另一报告'}]});
 const t=a.task(one.taskId),artifact={id:'b3-ui-artifact',taskId:t.id,stepId:t.steps[0].id,title:'fixed evidence',content:'fixed independently checked evidence',createdAt:new Date().toISOString()};
 a.data.artifacts.push(artifact);require(path.join(desktop,'protocol-access.cjs')).retain(a,'artifact',artifact,{task:t,command:'test_fixture'});
 Object.assign(t.steps[0],{done:true,artifactId:artifact.id});t.status='review';t.verification={passed:true,summary:'fixed evidence',gaps:[],basis:require(path.join(desktop,'acceptance.cjs')).basis(a,t)};
 await a.dispatch('taskAction',{id:t.id,command:'accept'});a.acceptedId=t.id;
 await a.dispatch('memorySave',{kind:'preference',title:'B3记忆',content:'原始确认内容',enabled:true});
 a.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};a.data.runtime.quickCapture={enabled:false,selectionEnabled:false,screenshotEnabled:false};a.save();
 return a;
};`);
const bootstrap=path.join(run,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`const desktop=${JSON.stringify(desktop)};\n`+String.raw`
const path=require('node:path'),electron=require('electron');
electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};
electron.Notification=class{static isSupported(){return false;}on(){}show(){}};
electron.globalShortcut.register=()=>false;electron.globalShortcut.unregister=()=>{};electron.globalShortcut.unregisterAll=()=>{};electron.globalShortcut.isRegistered=()=>false;
const status=()=>({selectionEnabled:false,screenshotEnabled:false,selectionRunning:false});
require(path.join(desktop,'selection-capture.cjs')).create=()=>({status,reconcile:status,dispose(){},resolve(){throw Error('No native selection in B3');}});
require(path.join(desktop,'native-bridge.cjs')).createNativeBridge=()=>async action=>{if(action==='attentionAvailable')return {supported:false};throw Error('No native service in B3: '+action);};
electron.safeStorage.isEncryptionAvailable=()=>false;
require(path.join(desktop,'main.cjs'));
`);
const proof=t=>Object.fromEntries(['status','acceptedAt','acceptedBy','acceptedRevision','completedAt','verification','workRevision','workEvent','acceptanceHistory','steps'].map(k=>[k,t[k]]));
(async()=>{
 const {build}=await import('vite'),{default:react}=await import('@vitejs/plugin-react');
 await build({configFile:false,root,base:'./',plugins:[react()],build:{outDir:path.join(runtime,'dist'),emptyOutDir:true}});
 const env={...process.env,ASSISTANT_TEST_DATA_DIR:profile,ASSISTANT_DESKTOP_FIXTURE:bootstrap,ASSISTANT_ENGINE_WORKER:'1',ASSISTANT_ENGINE_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({args:[bootstrap],cwd:runtime,env,executablePath:require('electron')});let page;
 const checks=[],errors=[];
 try{
  page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.locator('.sidebar').waitFor();
  const rpc=async(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
  const initial=await rpc('b3Probe');assert.ok(initial.threadId>0);const accepted=initial.data.tasks.find(t=>t.title==='B3已验收子项'),before=proof(accepted);
  if(!process.env.B3_UI_REVIEW_ONLY){
  await page.getByRole('heading',{name:'B3待恢复事项',exact:true}).click();
  await rpc('b3Fault',{action:'taskAction',mode:'before'});await page.getByRole('button',{name:'恢复事项',exact:true}).click();
  await expect(page.getByText(/B3 injected rename failure/)).toBeVisible();
  assert.equal((await rpc('b3Probe')).data.tasks.find(t=>t.title==='B3待恢复事项').status,'paused');
  await rpc('uiCommand',{action:'settings',input:{profile:'unrelated UI follow-up'}});
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'workspace/workspace.json'))).tasks.find(t=>t.title==='B3待恢复事项').status,'paused');
  checks.push('real task resume precommit failure; unrelated save keeps paused');
  await page.getByRole('button',{name:'关闭事项详情',exact:true}).click();
  await page.locator('.sidebar').getByRole('button',{name:/^项目(?:\s*\d+)?$/}).click();await page.getByRole('button',{name:'工作记忆',exact:true}).click();
  await page.locator('.memory-item').filter({hasText:'B3记忆'}).getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByLabel('记忆内容',{exact:true}).fill('修改后的确认内容');await page.getByRole('button',{name:'确认并保存记忆',exact:true}).click();
  await expect(page.locator('.memory-notice')).toContainText('记忆已保存');
  const afterMemory=await rpc('b3Probe');assert.deepEqual(proof(afterMemory.data.tasks.find(t=>t.id===accepted.id)),before);assert.equal(afterMemory.basis,initial.basis);assert.match(afterMemory.data.tasks.find(t=>t.title==='B3未完成子项').needsReplan,/记忆/);
  checks.push('real memory edit preserves accepted child proof/basis and replans sibling');
  await page.screenshot({path:path.join(report,'ui-memory.png')});
  }
  await page.locator('.sidebar').getByRole('button',{name:'信息收集',exact:true}).click();await page.getByRole('button',{name:'材料归类',exact:true}).click();
  const name=page.getByLabel('归类规则名称',{exact:true}),keywords=page.getByLabel('归类关键词',{exact:true});
  const add=async(label,mode)=>{await name.fill(label);await keywords.fill('B3');await rpc('b3Fault',{action:'intakeRoutingSave',mode});await page.getByRole('button',{name:'添加归类规则',exact:true}).click();};
  await add('B3已提交规则','after-refresh');await expect(page.locator('.routing-page > .form-error')).toContainText('已保存，请核对当前规则');await expect(page.getByRole('button',{name:'保存归类规则',exact:true})).toBeEnabled();
  let probe=await rpc('b3Probe');assert.equal(probe.data.intakeRoutingRules.length,1);const id=probe.data.intakeRoutingRules[0].id;
  await page.screenshot({path:path.join(report,'ui-after-save.png')});
  await page.getByRole('button',{name:'保存归类规则',exact:true}).click();await expect(name).toHaveValue('');probe=await rpc('b3Probe');assert.equal(probe.data.intakeRoutingRules.length,1);assert.equal(probe.trace.at(-1).id,id);
  checks.push('afterSave EIO survives a second renderer refresh failure; retry becomes edit, no duplicate');
  await add('B3刷新失败规则','refresh');await expect(page.locator('.routing-page > .form-error')).toContainText('界面刷新未完成');await expect(page.getByRole('button',{name:'保存归类规则',exact:true})).toBeEnabled();assert.equal((await rpc('b3Probe')).data.intakeRoutingRules.length,2);
  await page.screenshot({path:path.join(report,'ui-refresh-failure.png')});
  await page.getByRole('button',{name:'取消编辑',exact:true}).click();checks.push('successful mutation plus renderer refresh failure preserves committed result');
  await add('B3未知回包规则','unknown');await expect(page.getByRole('button',{name:'核对保存结果',exact:true})).toBeEnabled();await expect(name).toBeDisabled();probe=await rpc('b3Probe');const envelope=probe.trace.at(-1);assert.equal(probe.data.intakeRoutingRules.length,3);
  await rpc('b3Fault',{});await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await expect(name).toHaveValue('');probe=await rpc('b3Probe');assert.deepEqual(probe.trace.at(-1),envelope);assert.equal(probe.data.intakeRoutingRules.length,3);checks.push('unknown response freezes input and retries identical requestId/expectedRevision');
  await name.fill('B3已提交规则');await keywords.fill('B3');await keywords.press('Tab');await page.getByRole('button',{name:'添加归类规则',exact:true}).press('Enter');await expect(name).toHaveValue('');assert.equal((await rpc('b3Probe')).data.intakeRoutingRules.length,4);checks.push('intentional same-name rule and keyboard submit remain available');
  const currentRules=async()=>(await rpc('b3Probe')).data.intakeRoutingRules;
  const diskRules=()=>JSON.parse(fs.readFileSync(path.join(profile,'workspace/workspace.json'))).intakeRoutingRules;
  const abandon=async()=>{page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'放弃此草稿并新建',exact:true}).click();await expect(name).toHaveValue('');await expect(name).toBeEnabled();};
  const checkPending=async(draft)=>{await expect(page.getByRole('button',{name:'核对保存结果',exact:true})).toBeEnabled();await expect(name).toHaveValue(draft);await expect(name).toBeDisabled();await expect(page.locator('.routing-page > .form-error')).not.toContainText('已保存');};
  if(process.env.B3_UI_CASE!=='I2'){
   const original=(await currentRules()).find(r=>r.name==='B3刷新失败规则');
   await page.locator('.routing-rule').filter({has:page.getByRole('heading',{name:original.name,exact:true})}).getByRole('button',{name:'编辑归类规则',exact:true}).click();
   await name.fill('B3派发前丢失编辑');await rpc('b3Fault',{action:'intakeRoutingSave',mode:'unknown-before'});await page.getByRole('button',{name:'保存归类规则',exact:true}).click();
   await checkPending('B3派发前丢失编辑');assert.equal(diskRules().find(r=>r.id===original.id).name,original.name);
   let editEnvelope=(await rpc('b3Probe')).trace.at(-1);assert.equal(editEnvelope.revision,original.revision);
   await page.screenshot({path:path.join(report,'ui-I1-before-dispatch.png')});
   await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await expect(name).toHaveValue('');
   probe=await rpc('b3Probe');assert.deepEqual(probe.trace.at(-1),editEnvelope);assert.equal(diskRules().find(r=>r.id===original.id).name,'B3派发前丢失编辑');
   checks.push('I1: unknown edit before dispatch keeps draft, claims no save, retries unchanged revision successfully');
   await page.locator('.routing-rule').filter({has:page.getByRole('heading',{name:'B3派发前丢失编辑',exact:true})}).getByRole('button',{name:'编辑归类规则',exact:true}).click();
   await name.fill('B3提交后未知编辑');await rpc('b3Fault',{action:'intakeRoutingSave',mode:'unknown-readable'});await page.getByRole('button',{name:'保存归类规则',exact:true}).click();
   await checkPending('B3提交后未知编辑');assert.equal(diskRules().find(r=>r.id===original.id).name,'B3提交后未知编辑');editEnvelope=(await rpc('b3Probe')).trace.at(-1);
   const current=(await currentRules()).find(r=>r.id===original.id);await rpc('uiCommand',{action:'intakeRoutingSave',input:{...current,name:'B3后来合法编辑'}});
   const latest=(await currentRules()).find(r=>r.id===original.id);
   for(let attempt=0;attempt<2;attempt++){
    await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await checkPending('B3提交后未知编辑');probe=await rpc('b3Probe');assert.deepEqual(probe.trace.at(-1),editEnvelope);assert.deepEqual(diskRules().find(r=>r.id===original.id),latest);
   }
   await page.screenshot({path:path.join(report,'ui-I1-newer-edit.png')});await abandon();
   checks.push('I1: unknown edit after dispatch stays unconfirmed; repeated stale retries preserve newer edit and original draft');
   await page.locator('.routing-rule').filter({has:page.getByRole('heading',{name:'B3后来合法编辑',exact:true})}).getByRole('button',{name:'编辑归类规则',exact:true}).click();
   await name.fill('B3明确已提交编辑');await rpc('b3Fault',{action:'intakeRoutingSave',mode:'after-refresh'});await page.getByRole('button',{name:'保存归类规则',exact:true}).click();
   await expect(page.locator('.routing-page > .form-error')).toContainText('已保存，请核对当前规则');await expect(page.getByRole('button',{name:'保存归类规则',exact:true})).toBeEnabled();await expect(name).toHaveValue('B3明确已提交编辑');await expect(name).toBeEnabled();assert.equal(diskRules().find(r=>r.id===original.id).name,'B3明确已提交编辑');
   await page.getByRole('button',{name:'取消编辑',exact:true}).click();checks.push('I1 positive: explicit committed edit confirms saved result even when refresh fails');
  }
  if(process.env.B3_UI_CASE!=='I1'){
   const count=(await currentRules()).length;
   await add('B3未知后被删除','unknown');await expect(page.getByRole('button',{name:'核对保存结果',exact:true})).toBeEnabled();await expect(name).toBeDisabled();
   probe=await rpc('b3Probe');const frozen=probe.trace.at(-1),created=probe.data.intakeRoutingRules.find(r=>r.creationRequestId===frozen.requestId);assert.ok(created);
   await rpc('uiCommand',{action:'intakeRoutingDelete',input:{id:created.id,revision:created.revision}});await rpc('b3Fault',{});
   for(let attempt=0;attempt<2;attempt++){
    await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await checkPending('B3未知后被删除');probe=await rpc('b3Probe');assert.deepEqual(probe.trace.at(-1),frozen);assert.equal(diskRules().length,count);assert.ok(!diskRules().some(r=>r.id===created.id));
   }
   await page.screenshot({path:path.join(report,'ui-I2-deleted-stale.png')});checks.push('I2: unknown create -> normal delete -> repeated stale UI retry retains identical UUID/revision; no resurrection');
   await abandon();await name.fill('B3未知后被删除');await keywords.fill('B3');await page.getByRole('button',{name:'添加归类规则',exact:true}).click();await expect(name).toHaveValue('');
   probe=await rpc('b3Probe');assert.notEqual(probe.trace.at(-1).requestId,frozen.requestId);assert.equal(diskRules().length,count+1);checks.push('I2 positive: explicit abandon confirmation then intentional same-name new request is allowed');
  }
  const countBeforeKnownFailure=(await currentRules()).length;
  await add('B3明确未提交草稿','before');await expect(page.locator('.routing-page > .form-error')).toContainText('rename failure');await expect(name).toBeEnabled();await expect(name).toHaveValue('B3明确未提交草稿');assert.equal(diskRules().length,countBeforeKnownFailure);
  const failedEnvelope=(await rpc('b3Probe')).trace.at(-1);await name.fill('B3明确失败后修改');await page.getByRole('button',{name:'添加归类规则',exact:true}).click();await expect(name).toHaveValue('');
  probe=await rpc('b3Probe');assert.notEqual(probe.trace.at(-1).requestId,failedEnvelope.requestId);assert.equal(diskRules().length,countBeforeKnownFailure+1);checks.push('first known precommit failure leaves editable draft and permits corrected submission');
  probe=await rpc('b3Probe');assert.deepEqual(probe.calls,[]);assert.deepEqual(errors,[]);assert.deepEqual(proof(probe.data.tasks.find(t=>t.id===accepted.id)),before);
  await page.screenshot({path:path.join(report,'ui-final.png')});
  fs.writeFileSync(path.join(report,'ui-result.json'),JSON.stringify({checks,threadId:probe.threadId,externalCalls:probe.calls,pageErrors:errors,trace:probe.trace,run,runtime,profile,productionMain:true,isolated:true},null,2));
  console.log(JSON.stringify({checks,run,externalCalls:0,pageErrors:errors}));
 }catch(error){if(page){await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(run,'failure-ui.txt'),await page.locator('body').innerText().catch(()=>''));}throw error;}
 finally{await app.close();}
})().catch(error=>{console.error(error);console.error('Preserved isolated run:',run);process.exitCode=1;});
