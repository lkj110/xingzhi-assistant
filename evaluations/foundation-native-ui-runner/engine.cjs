'use strict';
// Local human receipt check only: no model adapter or real CLI is accepted here.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {root,read,write,sha,frozen}=require('./identity.cjs'),native=require('./native.cjs');
const acceptanceState=t=>({id:t.id,status:t.status,acceptedAt:t.acceptedAt||null,acceptedBy:t.acceptedBy||null,acceptanceHistory:t.acceptanceHistory||[]});
async function run({executable,output,mode,session,fault}){
 require('./session.cjs').assertSession(session,'f04');assert.equal(output,session.phaseOutput);assert.equal(mode,session.mode);assert.ok(!fault||mode==='offline'&&['cli-attempt','wrong-task','capture-submit','wrong-window','invalid-input','expired-accept','stop-accept','phase-stop-accept','unknown-command'].includes(fault));
 process.env.WS_NO_BUFFER_UTIL='1';process.env.WS_NO_UTF_8_VALIDATE='1';
 const identity=frozen(executable,{complete:true}),config=session.plan.f04,taskId=config.taskId;
 fs.mkdirSync(output);const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'foundation-minimal-local-')),profile=path.join(directory,'profile'),workspace=path.join(profile,'workspace'),shim=path.join(directory,'shim');fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(shim);
 for(const f of config.files){const source=path.resolve(root,config.directory,f.path);assert.equal(sha(fs.readFileSync(source)),f.sha256);fs.copyFileSync(source,path.join(workspace,f.path));}
 const original=read(path.join(workspace,'workspace.json')),before=original.tasks.find(t=>t.id===taskId),modelIds=original.modelCalls.map(c=>c.id);assert.equal(before.status,'review');assert.ok(!before.acceptedAt);assert.equal(before.grounding.passed,true);
 assert.equal(original.settings.automatic,false);assert.equal(original.settings.autoExtract,false);assert.equal(original.settings.autoComplete,false);assert.equal(original.delegations.length,0);assert.ok(original.providers.every(p=>p.type==='codex'&&!p.sealedKey));
 const otherStates=original.tasks.filter(t=>t.id!==taskId).map(acceptanceState),attempts=[],nonce=crypto.randomBytes(32).toString('hex');
 const server=http.createServer(async(req,res)=>{let bytes=0;for await(const piece of req)bytes+=piece.length;attempts.push({at:Date.now(),bytes,transportDispatched:false});session.fail(Error('ZERO_MODEL_TRANSPORT_REFUSED'));res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({channel:'done',code:78})+'\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const bridge={url:`http://127.0.0.1:${server.address().port}/cli`,nonce};write(path.join(shim,'bridge.json'),bridge);
 cp.execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/optimize+','/out:'+path.join(shim,'codex.exe'),'/reference:System.Web.Extensions.dll',path.join(root,'evaluations/foundation-runner/Bridge.cs')],{windowsHide:true,timeout:60000});
 const env={...process.env,PATH:shim+path.delimiter+process.env.PATH,CODEX_HOME:path.join(directory,'synthetic-codex-home')};
 for(const key of Object.keys(env))if(['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ASSISTANT_TEST_DATA_DIR','ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_ENGINE_FIXTURE'].includes(key)||/^(OPENAI|ANTHROPIC|AZURE_OPENAI)_/.test(key))delete env[key];fs.mkdirSync(env.CODEX_HOME);
 const receiptFile=path.join(output,'native-commands.jsonl'),checks=[],errors=[];let app,page,failed,final,proof;
 async function api(action,input={}){assert.ok(['export','stateView','groundingStatus','acceptanceSnapshot'].includes(action));const r=await page.evaluate(({action,input})=>window.assistant.call(action,input),{action,input});if(r.error)throw Error(r.error);return r.data;}
 async function launch(){
  session.guard();frozen(executable,{complete:true});app=await require('playwright/test')._electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000});page=await app.firstWindow();await page.waitForFunction(()=>!!window.assistant);page.on('pageerror',e=>errors.push(e.message));
  const boot=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData'),asar:app.getAppPath()}));assert.equal(boot.packaged,true);assert.equal(boot.profile,profile);assert.equal(boot.asar,identity.asar);
  const mainWindow=await app.browserWindow(page),mainWindowId=await mainWindow.evaluate(w=>w.id);assert.equal(await page.evaluate(()=>window.assistant.quickCaptureWindow),false);
  const windowProof=await native.install(app,{mainWindowId,file:receiptFile,output:session.output,deadline:session.deadline,phase:'f04',taskId,runId:session.runId,mode});assert.equal((await api('groundingStatus')).implementationHash,identity.groundingSha256);checks.push({kind:'native-package-boot',...boot,windowProof});
 }
 try{
  await launch();const initial=await api('export');assert.deepEqual(initial.modelCalls.map(c=>c.id),modelIds);assert.equal(initial.tasks.find(t=>t.id===taskId).status,'review');assert.equal((await api('acceptanceSnapshot',{projectId:''})).items.find(t=>t.id===taskId).ready,true);
  await require('./window-flow.cjs').ready(app,page,before,mode);
  checks.push({kind:'main-window-task-ready',taskId,mode});
  if(mode==='offline')await require('./window-flow.cjs').exercise({app,page,output,session,taskId,fault,checks,api});
  session.guard();
  write(path.join(output,'human-request.json'),{caseId:'F04-local',taskId,title:before.title,profile,asarSha256:session.plan.asarSha256,deadline:session.deadline,runId:session.runId,mode,instructions:'核对指定候选窗口与事项全文、来源后，由真人点击验收完成。聊天回复不替代原生应用回执。'});
  if(mode==='live')console.log(JSON.stringify({event:'human-local-acceptance-required',request:path.join(output,'human-request.json')}));
  if(fault==='cli-attempt'){await fetch(bridge.url,{method:'POST',headers:{'x-runner-nonce':nonce},body:JSON.stringify({args:['exec'],input:'OFFLINE SYNTHETIC'})});session.guard();}
  if(fault==='wrong-task'){await page.evaluate(id=>window.assistant.call('uiCommand',{action:'taskAction',input:{id,command:'accept'}}),original.tasks.find(t=>t.id!==taskId).id);session.guard();}
  if(mode==='offline'){await require('./window-flow.cjs').ready(app,page,before,mode);await page.getByRole('dialog',{name:'事项详情'}).getByRole('button',{name:'验收完成',exact:true}).click();}
  for(;;){session.guard();final=await api('export');assert.deepEqual(final.modelCalls.map(c=>c.id),modelIds);assert.equal(attempts.length,0);assert.deepEqual(final.tasks.filter(t=>t.id!==taskId).map(acceptanceState),otherStates);const t=final.tasks.find(t=>t.id===taskId);assert.ok(['review','completed'].includes(t.status));if(t.status==='completed')break;await new Promise(r=>setTimeout(r,200));}
  proof=native.verify({file:receiptFile,profile,taskId,exported:final});const accepted=acceptanceState(final.tasks.find(t=>t.id===taskId));
  await app.close();app=null;await launch();final=await api('export');assert.deepEqual(acceptanceState(final.tasks.find(t=>t.id===taskId)),accepted);assert.deepEqual(final.modelCalls.map(c=>c.id),modelIds);assert.deepEqual(native.verify({file:receiptFile,profile,taskId,exported:final}),proof);
  await page.reload();await page.waitForFunction(()=>!!window.assistant);await page.getByLabel('搜索事项').fill(before.title);await page.locator('.task-card').filter({hasText:before.title}).click();await require('playwright/test').expect(page.getByText('已完成并保存结果',{exact:true})).toBeVisible();checks.push({kind:'cold-restart-ui-and-receipt-preserved'});assert.deepEqual(errors,[]);session.guard();
 }catch(e){failed=e;session.fail(e);if(page)try{final=await api('export');}catch(snapshotError){errors.push('failure-snapshot: '+snapshotError.message);}}finally{try{await app?.close();}catch(e){failed ||= e;}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 for(const f of config.files)assert.equal(sha(fs.readFileSync(path.resolve(root,config.directory,f.path))),f.sha256);
 if(final)write(path.join(output,'final-state.json'),final);
 const persisted=read(path.join(workspace,'workspace.json'));write(path.join(output,'persisted-state.json'),persisted);
 const summary={schema:1,passed:!failed,mode,phase:'f04',taskId,profile,asarSha256:session.plan.asarSha256,runnerIdentity:session.seal.identity,originalInputFiles:config.files,checks,receipt:proof||null,transportAttempts:attempts,realModelCalls:0,modelCallsAdded:persisted.modelCalls.length-modelIds.length,actualHumanAcceptance:mode==='live'&&!failed,automatedOfflineDiagnostic:mode==='offline',freshModelBusinessCase:false,installed:false,errors:failed?[failed.stack]:[],appErrors:errors};write(path.join(output,'summary.json'),summary);if(failed)throw failed;return summary;
}
module.exports={run};
