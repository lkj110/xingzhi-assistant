// B2 integration: real React/preload/main/Worker; only remote CLI and native services are isolated.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron,expect}=require('playwright/test');
const root=path.resolve(__dirname,'..'),report=process.env.B2_ARTIFACT_DIR;
if(!report||!path.isAbsolute(report))throw Error('Set B2_ARTIFACT_DIR to a private evidence directory');
fs.mkdirSync(report,{recursive:true});
const run=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'b2-ui-worker-'))),runtime=path.join(run,'app'),profile=path.join(run,'profile'),fixture=path.join(run,'fixture.cjs');
fs.mkdirSync(runtime);fs.mkdirSync(profile);fs.cpSync(path.join(root,'desktop'),path.join(runtime,'desktop'),{recursive:true});
fs.copyFileSync(path.join(root,'package.json'),path.join(runtime,'package.json'));fs.symlinkSync(path.join(root,'node_modules'),path.join(runtime,'node_modules'),'dir');
const desktop=path.join(runtime,'desktop'),bin=path.join(run,'lark-cli'),remote=path.join(run,'remote.json');
const synthetic=fs.readFileSync(path.join(root,'tests/p1-b2-lark-identity.test.cjs'),'utf8').split('String.raw`')[1]?.split('`,{mode:0o700}')[0];
if(!synthetic)throw Error('Synthetic CLI fixture not found');
fs.writeFileSync(bin,'#!'+process.execPath+'\n'+synthetic,{mode:0o700});
fs.writeFileSync(remote,JSON.stringify({ambient:'A',pages:1,bodies:0,users:{A:{appId:'cli_app',brand:'feishu',openId:'ou_A',tenantId:'tenant_A'},B:{appId:'cli_app',brand:'feishu',openId:'ou_B',tenantId:'tenant_B'}}}));
fs.writeFileSync(fixture,`const desktop=${JSON.stringify(desktop)};\n`+String.raw`
const path=require('node:path');
exports.create=async({Assistant,options})=>{
 const calls=[],denied=async()=>{calls.push('external');throw Error('External/model call prohibited');};
 require(path.join(desktop,'subscription.cjs')).status=async()=>({available:false,loggedIn:false,message:'isolated offline fixture'});
 const policy=require(path.join(desktop,'access-policy-store.cjs')),collection=require(path.join(desktop,'collection-permissions.cjs'));
 class Fixture extends Assistant{
  tick(){}
  async dispatch(action,input={}){
   if(action==='b2Probe')return {threadId:require('node:worker_threads').threadId,calls,data:this.data,sequence:policy.inventory(this).sequence};
   if(action==='b2Revoke'){const c=this.data.connectors[0];policy.revoke(this,{...collection.spec('connector',c),operations:['local_read']},{trusted:true,actor:'user_command',command:'test_ui_revoke'});return {ok:true};}
   return super.dispatch(action,input);
  }
 }
 const a=new Fixture({...options,chat:denied,agentRequest:denied,webRequest:denied,feedRequest:denied,officeRequest:denied});
 await a.dispatch('projectSave',{name:'B2隔离项目'});
 a.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};a.data.runtime.quickCapture={enabled:false,selectionEnabled:false,screenshotEnabled:false};a.save();return a;
};`);
const bootstrap=path.join(run,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`const desktop=${JSON.stringify(desktop)};\n`+String.raw`
const path=require('node:path'),electron=require('electron');
electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};
electron.Notification=class{static isSupported(){return false;}on(){}show(){}};
electron.globalShortcut.register=()=>false;electron.globalShortcut.unregister=()=>{};electron.globalShortcut.unregisterAll=()=>{};electron.globalShortcut.isRegistered=()=>false;
const status=()=>({selectionEnabled:false,screenshotEnabled:false,selectionRunning:false});
require(path.join(desktop,'selection-capture.cjs')).create=()=>({status,reconcile:status,dispose(){},resolve(){throw Error('No native selection in B2');}});
require(path.join(desktop,'native-bridge.cjs')).createNativeBridge=()=>async action=>{if(action==='attentionAvailable')return {supported:false};throw Error('No native service in B2: '+action);};
electron.safeStorage.isEncryptionAvailable=()=>false;require(path.join(desktop,'main.cjs'));
`);
(async()=>{
 const {build}=await import('vite'),{default:react}=await import('@vitejs/plugin-react');
 await build({configFile:false,root,base:'./',plugins:[react()],build:{outDir:path.join(runtime,'dist'),emptyOutDir:true}});
 const env={...process.env,PATH:run+path.delimiter+process.env.PATH,ASSISTANT_TEST_DATA_DIR:profile,ASSISTANT_DESKTOP_FIXTURE:bootstrap,ASSISTANT_ENGINE_WORKER:'1',ASSISTANT_ENGINE_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({args:[bootstrap],cwd:runtime,env,executablePath:require('electron')});let page;const checks=[],errors=[];
 try{
  page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('.sidebar').waitFor();
  const rpc=async(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
  const probe=()=>rpc('b2Probe');assert.ok((await probe()).threadId>0);
  await page.locator('.sidebar').getByRole('button',{name:'信息收集',exact:true}).click();await page.getByRole('button',{name:'信息连接',exact:true}).click();
  await page.getByLabel('连接名称',{exact:true}).fill('B2真实Worker连接');await page.getByLabel('连接来源类型').selectOption('chat');await page.getByLabel('连接来源地址').fill('oc_fixture');await page.getByRole('button',{name:'添加信息连接',exact:true}).click();
  const region=page.getByRole('region',{name:'账号绑定 B2真实Worker连接'}),article=region.locator('..');
  const sync=async expected=>{const ids=new Set((await probe()).data.connectorRuns.map(r=>r.id));await article.getByRole('button',{name:'立即同步／重试'}).click();await expect.poll(async()=>{const r=(await probe()).data.connectorRuns.find(r=>!ids.has(r.id));return r?.finishedAt?r.status:'running';}).toBe(expected);return (await probe()).data.connectorRuns.find(r=>!ids.has(r.id));};
  const bodyTrace=()=>fs.readFileSync(path.join(run,'trace.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(e=>['im','docs'].includes(e.args[0]));
  await expect(region).toContainText('尚未绑定采集账号');assert.equal((await probe()).sequence,0);assert.equal(fs.existsSync(path.join(run,'trace.jsonl')),false);checks.push('real UI save: no grant or CLI call');
  const preview=region.getByRole('button',{name:'预览采集账号',exact:true});await preview.click();await expect(region.getByRole('button',{name:'确认绑定此账号'})).toBeFocused();await expect(region).toContainText('tenant_A');assert.equal((await probe()).sequence,0);
  await region.getByRole('button',{name:'取消绑定预览'}).click();await expect(preview).toBeFocused();await preview.click();await expect(region.getByRole('button',{name:'确认绑定此账号'})).toBeFocused();await page.keyboard.press('Enter');
  await expect(region.getByRole('status')).toContainText('账号已绑定');assert.equal((await probe()).sequence,3);checks.push('preview/cancel/keyboard confirmation through main and Worker grants exactly once');
  await sync('updated');assert.equal((await probe()).data.sources.length,1);await expect(article).toContainText('连接正常');
  const state=JSON.parse(fs.readFileSync(remote));state.ambient='B';fs.writeFileSync(remote,JSON.stringify(state));const beforeBodies=bodyTrace().length;await sync('unchanged');assert.equal(JSON.parse(fs.readFileSync(remote)).bodies,2);const newBodies=bodyTrace().slice(beforeBodies);assert.equal(newBodies.length,1);assert.ok(newBodies.every(e=>e.who==='A'&&e.pinned===true));await expect(article).toContainText('连接正常');assert.ok((await probe()).data.sources.every(s=>s.larkIdentity.openId==='ou_A'));checks.push('global switch B keeps body and source identity A');
  await rpc('b2Revoke');const before=JSON.parse(fs.readFileSync(remote)).bodies,sequence=(await probe()).sequence;
  await article.getByRole('button',{name:'编辑连接'}).click();await page.getByRole('button',{name:'保存连接设置'}).click();await sync('error');await expect(article).toContainText('权限不足');assert.equal(JSON.parse(fs.readFileSync(remote)).bodies,before);assert.equal((await probe()).sequence,sequence);checks.push('revocation: edit/save/retry cannot read or regrant');
  await region.getByRole('button',{name:'预览并重新绑定账号'}).click();await expect(region.getByRole('group')).toContainText('tenant_B');await region.getByRole('button',{name:'确认绑定此账号'}).click();await expect.poll(async()=>(await probe()).data.connectors[0].larkBinding.identity.openId).toBe('ou_B');
  await sync('updated');assert.equal((await probe()).data.sources.length,2);await expect(article).toContainText('连接正常');
  const final=await probe();assert.equal(final.data.connectors[0].larkBindingHistory.length,2);assert.ok(final.data.sources.some(s=>s.larkIdentity.openId==='ou_B'&&!s.previousSourceId));assert.ok(final.data.sources.some(s=>s.larkIdentity.openId==='ou_A'));checks.push('explicit B binding and sync preserve A history without cross-account version link');
  assert.deepEqual(final.calls,[]);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(report,'connections-worker.png'),fullPage:true});
  fs.writeFileSync(path.join(report,'result.json'),JSON.stringify({checks,pageErrors:errors,externalCalls:final.calls,threadId:final.threadId,profile,runtime,limits:'actual main/preload/Worker with synthetic CLI, not installed package or real account'},null,2));console.log(JSON.stringify({checks,threadId:final.threadId}));
 }catch(e){if(page){fs.writeFileSync(path.join(report,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(report,'failure.png')});}throw e;}
 finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
