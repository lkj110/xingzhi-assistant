'use strict';
// One gate only: there is no business-case, revision, confirmation or acceptance route.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {root,sha,read,write,frozen,verifyRunner}=require('./identity.cjs');
const {createBroker}=require('./broker.cjs'),{createPhases}=require('../foundation-marker-runner/phases.cjs');
async function run({executable,output,mode='offline',authorizationPath,realCli,fault}){
 process.env.WS_NO_BUFFER_UTIL='1';process.env.WS_NO_UTF_8_VALIDATE='1';
 assert.equal(process.platform,'win32');if(mode==='live')assert.ok(authorizationPath&&path.isAbsolute(authorizationPath),'New explicit user approval and an absolute authorization path are required');assert.ok(['offline','live'].includes(mode));assert.ok(!fault||mode==='offline'&&['old-budget','cli-rejection','fifth-request','unknown-usage','malformed-inner'].includes(fault));
 output=require('../foundation-marker-runner/output.cjs').validateOutput(output);
 const identity=frozen(executable,{complete:true}),{plan,pack,asar}=identity,sampleIdentity=identity.seal.identity,manifest=read(path.join(__dirname,'runner-seal.json'));verifyRunner(manifest);
 let authorization,shimHash,shimPath;
 const guardIdentity=()=>{frozen(executable);verifyRunner(manifest);if(shimHash)assert.equal(sha(fs.readFileSync(shimPath)),shimHash);if(mode==='live')assert.equal(sha(fs.readFileSync(realCli)),authorization.realCliSha256);};
 if(mode==='live'){
  const review=read(path.join(__dirname,'runner-review.json'));assert.equal(review.approvedForLiveReadiness,true);assert.equal(review.runnerIdentity,manifest.identity);assert.equal(review.sampleSealIdentity,sampleIdentity);assert.equal(review.realModelCalls,0);
  authorization=read(authorizationPath);require('./identity.cjs').validateAuthorization(authorization,plan,manifest.identity);assert.ok(path.isAbsolute(realCli));assert.equal(sha(fs.readFileSync(realCli)),authorization.realCliSha256);
  require('../foundation-runner/authorization.cjs').claimAuthorization({authorizationPath,authorization,output,runnerIdentity:manifest.identity,sealIdentity:sampleIdentity});
 }
 if(fault==='old-budget'){plan.budget.applicationAttempts=4;plan.budget.protocolAttempts=4;plan.budget.reportedTokenStopThreshold=100000;plan.budget.protocolTokenStopThreshold=100000;}
 require('../foundation-marker-runner/output.cjs').validateOutput(output);fs.mkdirSync(output,{recursive:true});
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'foundation-recheck-gate-runner-')),profile=path.join(directory,'profile'),shim=path.join(directory,'shim');fs.mkdirSync(shim);
 shimPath=path.join(shim,'codex.exe');cp.execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/optimize+','/out:'+shimPath,'/reference:System.Web.Extensions.dll',path.join(root,'evaluations/foundation-runner/Bridge.cs')],{windowsHide:true,timeout:60000});shimHash=sha(fs.readFileSync(shimPath));
 const env={...process.env,PATH:shim+path.delimiter+process.env.PATH,CODEX_HOME:path.join(directory,'synthetic-codex-home')};
 for(const key of Object.keys(env))if(['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ASSISTANT_TEST_DATA_DIR','ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_ENGINE_FIXTURE'].includes(key)||/^(OPENAI|ANTHROPIC|AZURE_OPENAI)_/.test(key))delete env[key];fs.mkdirSync(env.CODEX_HOME);
 let app,page,failed,taskId,final;const checks=[],control=new AbortController(),appErrors=[];
 async function api(action,input={}){assert.ok(['state','export','settings','saveProvider','captureSave','createTask','advance','stop','groundingStatus','acceptanceSnapshot'].includes(action));const r=await page.evaluate(({action,input})=>window.assistant.call(action,input),{action,input});if(r.error)throw Error(r.error);return r.data;}
 const snapshot=async()=>{const v=await api('export');return v.data||v.workspace||v;};
 const phases=createPhases({snapshot});
 const broker=await createBroker({directory:output,plan,mode,sealIdentity:sampleIdentity,authorization,realCli,identityGuard:guardIdentity,fault,fixture:mode==='offline'?require('../foundation-diagnostic-runner/fixture.cjs').createFixture({pack,plan,fault}):undefined,admission:async(call,context)=>{await phases.admit(call,context);if(fs.existsSync(path.join(output,'STOP')))throw Error('USER_STOP_FILE');},responseObserved:(...args)=>phases.observed(...args)});
 write(path.join(shim,'bridge.json'),broker.bridgeConfig);
 const stop=()=>{control.abort();broker.cancel('USER_STOP_SIGNAL');};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const deadline=()=>broker.ledger.snapshot().startedAt+plan.budget.dispatchWindowMinutes*60000;
 async function guard(){if(control.signal.aborted||fs.existsSync(path.join(output,'STOP')))throw Error('USER_STOP');if(broker.stopped)throw Error('BROKER_STOPPED: '+broker.errors.join(';'));if(broker.ledger.snapshot().startedAt&&Date.now()>=deadline())throw Error('ROUND_WINDOW_EXPIRED');}
 const input=require(path.join(pack,'inputs.cjs')).project(plan.protocolGate);
 try{
  guardIdentity();app=await require('playwright/test')._electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>appErrors.push(e.message));await page.waitForFunction(()=>!!window.assistant);
  const proof=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData'),asar:app.getAppPath(),version:app.getVersion()}));assert.equal(proof.packaged,true);assert.equal(proof.profile,profile);assert.equal(proof.asar,asar);assert.equal(proof.version,plan.installedVersion);assert.equal((await api('groundingStatus')).implementationHash,identity.groundingSha256);checks.push({kind:'package-identity',proof});
  const empty=await api('state');assert.equal(empty.tasks.length,0);assert.equal(empty.providers.length,0);await page.getByRole('button',{name:'暂时跳过',exact:true}).click();
  await api('settings',{automatic:false,autoComplete:false,autoExtract:false,evidenceGrounding:true});await api('saveProvider',{type:'codex',name:mode==='offline'?'Offline diagnostic fixture':'Guarded diagnostic gate',model:plan.model.id,reasoning:plan.model.reasoning,inputPrice:0,outputPrice:0,requestPolicy:{idleMinutes:2,totalMinutes:3,retries:0}});
  for(const source of input.sources)await api('captureSave',{organize:false,textItems:[source]});const sources=(await api('state')).sources;assert.equal(sources.length,input.sources.length);
  await api('createTask',{title:input.title,description:input.description,criteria:input.criteria,sourceIds:sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});taskId=(await api('state')).tasks[0].id;
  const context={id:plan.protocolGate.id,taskId,...input,sources,lane:'generated'};broker.setContext(context);phases.open('work',context,{stage:'protocol-gate'});
  await api('advance',{id:taskId});
  for(;;){await guard();const task=(await api('state')).tasks.find(t=>t.id===taskId);if(['review','blocked','waiting','completed','paused'].includes(task?.status))break;await new Promise(r=>setTimeout(r,200));}
  final=await snapshot();const {task,draft}=require('../foundation-marker-runner/phases.cjs').current(final,taskId);require('../foundation-marker-runner/phases.cjs').assertReady(task);
  const acceptance=await api('acceptanceSnapshot',{projectId:''});assert.equal(acceptance.items.find(t=>t.id===taskId)?.ready,true);
  const bound=require('../foundation-diagnostic-runner/checkpoint-binding.cjs').binding(final,taskId);
  const c=require('../foundation-marker-runner/checkpoints.cjs').createCheckpoint({directory:path.join(output,'checkpoints'),caseId:plan.protocolGate.id,stage:'protocol-gate',input,draft,sealIdentity:sampleIdentity});checks.push({kind:'independent-content-checkpoint',identity:c.identity,contentBinding:bound,syntheticSkipped:mode==='offline'});
  if(mode==='live'){console.log(JSON.stringify({event:'independent-review-needed',request:c.requestPath,decision:c.decisionPath}));const timer=setInterval(()=>{guard().catch(()=>control.abort());},200);try{await c.wait({signal:control.signal,deadline:deadline()});}finally{clearInterval(timer);}}
  await guard();require('../foundation-diagnostic-runner/checkpoint-binding.cjs').unchanged(bound,await snapshot(),taskId);assert.deepEqual(appErrors,[]);
 }catch(e){failed=e;broker.cancel(e.code||e.message);try{await api('stop');await new Promise(r=>setTimeout(r,300));}catch{}}
 finally{
  if(page)try{final=await snapshot();const calls=(final.modelCalls||[]).filter(c=>c.taskId===taskId).reverse();for(let i=broker.rows.length;i<calls.length;i++){const call=calls[i],row=broker.ledger.localReject({caseId:plan.protocolGate.id,role:call.role,stage:call.stage},'APPLICATION_FAILED_BEFORE_CLI_EXEC');broker.rows.push({caseId:plan.protocolGate.id,attemptId:row.id,transportDispatched:false,applicationCallId:call.id});broker.cancel('APPLICATION_FAILED_BEFORE_CLI_EXEC');failed ||= Error('Application failed before CLI exec');}assert.equal(calls.length,broker.rows.length);for(const call of calls){assert.equal(call.providerType,'codex');assert.equal(call.model,plan.model.id);assert.equal(call.reasoning,plan.model.reasoning);if(call.stage==='json_repair')throw Error('UNPLANNED_JSON_REPAIR');}assert.equal(final.tasks.length,1);write(path.join(output,'final-state.json'),final);}catch(e){failed ||= e;broker.cancel(e.message);}
  try{await app?.close();}catch(e){failed ||= e;}await broker.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);
 }
 try{guardIdentity();}catch(e){failed ||= e;}
 const summary={schema:1,passed:!failed,mode,fault:fault||null,sampleSealIdentity:sampleIdentity,runnerIdentity:manifest.identity,planSha256:require('../foundation-diagnostic-runner/ledger.cjs').planHash(plan),asarSha256:plan.asarSha256,shimSha256:shimHash,isolatedDirectory:directory,gateId:plan.protocolGate.id,taskId,realCliExecutions:mode==='live'?broker.rows.filter(r=>r.transportDispatched).length:0,synthetic:mode==='offline',actualHumanAcceptances:0,businessCasesStarted:0,qualityEvaluation:false,installed:false,checks,ledger:broker.ledger.snapshot(),errors:[...(failed?[failed.stack]:[]),...broker.errors],appErrors};write(path.join(output,'summary.json'),summary);console.log(JSON.stringify({passed:summary.passed,mode,attempts:summary.ledger.totals.applicationEntryAttempts,realCliExecutions:summary.realCliExecutions,output,error:failed?.message}));if(failed)throw failed;return summary;
}
module.exports={run};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'},offline:{type:'boolean'},live:{type:'boolean'},authorization:{type:'string'},'real-cli':{type:'string'},fault:{type:'string'}}});assert.notEqual(!!values.offline,!!values.live);run({executable:values.executable,output:values.output,mode:values.live?'live':'offline',authorizationPath:values.authorization,realCli:values['real-cli'],fault:values.fault}).catch(e=>{console.error(e.stack);process.exitCode=1;});}
