'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {root,pack,IDENTITY,sha,read,write,frozen,inside,dependencies}=require('./common.cjs');
const {createCheckpoint}=require('./checkpoints.cjs');
const {project}=require('../foundation-acceptance-20261028/inputs.cjs'),{createBroker}=require('./broker.cjs');
const {createNegative}=require('./negative.cjs');
async function run({executable,output,mode='offline',authorization,authorizationPath,realCli,fault}){
 assert.equal(process.platform,'win32');assert.ok(path.isAbsolute(output)&&!fs.existsSync(output),'Output must be a new absolute directory');
 const identity=frozen(executable),{plan,asar}=identity,dependencyIdentity=dependencies(executable);let runnerManifest;
 if(fault==='case-budget'){
  assert.equal(mode,'offline');plan.caseLimits.find(c=>c.id==='F01-lanqiao-tour').tokenStopThreshold=50000;
  plan.budget.businessTokenStopThreshold=plan.caseLimits.reduce((n,c)=>n+c.tokenStopThreshold,0);plan.budget.reportedTokenStopThreshold=plan.budget.protocolTokenStopThreshold+plan.budget.businessTokenStopThreshold;
 }
 const identityGuard=()=>{frozen(executable);assert.deepEqual(dependencies(executable),dependencyIdentity);if(runnerManifest){for(const f of runnerManifest.files)assert.equal(sha(fs.readFileSync(path.join(__dirname,f.path))),f.sha256);assert.equal(sha(fs.readFileSync(realCli)),authorization.realCliSha256);}};
 if(mode==='live'){
  // A new explicit approval and reviewed runner identity are required; never generate either here.
  assert.ok(authorization,'New user budget approval required');
  const manifest=read(path.join(__dirname,'runner-seal.json')),review=read(path.join(__dirname,'runner-review.json'));
  assert.equal(manifest.identity,sha(JSON.stringify({files:manifest.files,dependencies:manifest.dependencies})));assert.equal(review.runnerIdentity,manifest.identity);assert.equal(review.approvedForLiveReadiness,true);
  assert.deepEqual(manifest.files.map(f=>f.path).sort(),fs.readdirSync(__dirname).filter(f=>/\.(cjs|cs|md)$/.test(f)).sort());
  assert.deepEqual(manifest.dependencies,dependencyIdentity);
  for(const f of manifest.files)assert.equal(sha(fs.readFileSync(path.join(__dirname,f.path))),f.sha256);
  assert.equal(review.realModelCalls,0);assert.equal(authorization.runnerIdentity,manifest.identity);
  assert.ok(path.isAbsolute(realCli));assert.equal(sha(fs.readFileSync(realCli)),authorization.realCliSha256);runnerManifest=manifest;
  require('./authorization.cjs').claimAuthorization({authorizationPath,authorization,output,runnerIdentity:manifest.identity,sealIdentity:IDENTITY});
 }
 fs.mkdirSync(output,{recursive:true});const tmp=fs.realpathSync(os.tmpdir()),directory=fs.realpathSync(fs.mkdtempSync(path.join(tmp,'foundation-runner-')));
 const shim=path.join(directory,'shim');fs.mkdirSync(shim);const profile=path.join(directory,'profile');
 const csc=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 cp.execFileSync(csc,['/nologo','/target:exe','/optimize+','/out:'+path.join(shim,'codex.exe'),'/reference:System.Web.Extensions.dll',path.join(__dirname,'Bridge.cs')],{windowsHide:true,timeout:60000});
 const broker=await createBroker({directory:output,plan,mode,sealIdentity:IDENTITY,authorization,realCli,identityGuard,fault,fixture:mode==='offline'?require('./offline-fixture.cjs').createFixture():undefined});
 write(path.join(shim,'bridge.json'),broker.bridgeConfig);
 const env={...process.env,PATH:shim+path.delimiter+process.env.PATH,CODEX_HOME:path.join(directory,'synthetic-codex-home')};
 for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ASSISTANT_TEST_DATA_DIR','ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_ENGINE_FIXTURE'])delete env[key];
 fs.mkdirSync(env.CODEX_HOME); // The isolated app never reads the user's CLI profile; live forwarding is owned by the guarded broker.
 const {_electron:electron}=require('playwright/test');let app,page,negative,failed;const results=[],checks=[],appErrors=[];
 const provider={type:'codex',name:mode==='offline'?'Offline synthetic CLI':'Guarded subscription evaluation',model:plan.model.id,reasoning:plan.model.reasoning,inputPrice:0,outputPrice:0,requestPolicy:{idleMinutes:2,totalMinutes:3,retries:0}};
 const control=new AbortController();const signalStop=()=>{control.abort();broker.cancel('USER_PROCESS_SIGNAL');};process.on('SIGINT',signalStop);process.on('SIGTERM',signalStop);
 async function launch(){
  identityGuard();
  app=await electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000});page=await app.firstWindow();page.on('pageerror',e=>appErrors.push(e.message));await page.waitForFunction(()=>!!window.assistant);
  const proof=await app.evaluate(({app},names)=>({packaged:app.isPackaged,profile:app.getPath('userData'),version:app.getVersion(),asar:app.getAppPath(),modules:names.map(n=>({name:n,hash:process.getBuiltinModule('node:crypto').createHash('sha256').update(process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(app.getAppPath(),'desktop',n))).digest('hex')}))}),['subscription.cjs','subscription-protocol.cjs','host-process.cjs']);
  assert.equal(proof.packaged,true);assert.equal(proof.profile,profile);assert.equal(proof.version,plan.installedVersion);assert.equal(proof.asar,asar);
  for(const m of proof.modules)assert.equal(m.hash,sha(fs.readFileSync(path.join(root,'desktop',m.name))));checks.push({kind:'installed-package-identity',proof});
 }
 async function api(action,input={}){
  assert.ok(['state','export','settings','saveProvider','captureSave','createTask','advance','taskAction','stop','acceptanceSnapshot'].includes(action),'Unplanned UI command');
  if(action==='taskAction')assert.equal(input.command,'revise','Runner cannot perform human acceptance');
  const r=await page.evaluate(({action,input})=>window.assistant.call(action,input),{action,input});if(r.error)throw Object.assign(Error(r.error),{code:r.code});return r.data;
 }
 const exportState=async(call=api)=>{const e=await call('export');return e.data||e.workspace||e;};
 async function settle(id,call=api){
  const deadline=Date.now()+plan.budget.perCallTimeoutMs*9;while(Date.now()<deadline){
   if(broker.stopped){await call('stop');await new Promise(r=>setTimeout(r,300));throw Error('BROKER_STOPPED: '+broker.errors.join(';'));}
   const state=await call('state'),task=state.tasks.find(t=>t.id===id);if(['review','blocked','completed','waiting','paused'].includes(task?.status))return {state,task};
   await new Promise(r=>setTimeout(r,200));
  }throw Error('TASK_DID_NOT_SETTLE');
 }
 async function restart(){const count=broker.rows.length;await app.close();app=null;await launch();await api('state');await new Promise(r=>setTimeout(r,300));assert.equal(broker.rows.length,count,'Restart dispatched a model');}
 function artifacts(data,id){return (data.artifacts||[]).filter(a=>a.taskId===id);}
 async function checkpoint(spec,input,data,taskId,stage){
  const task=data.tasks.find(t=>t.id===taskId),current=data.artifacts.find(a=>a.id===task.primaryArtifactId)||data.artifacts.find(a=>a.id===task.steps[0].artifactId);
  const c=createCheckpoint({directory:path.join(output,'checkpoints'),caseId:spec.id,stage,input,draft:current,sealIdentity:IDENTITY});
  checks.push({kind:'independent-content-checkpoint',caseId:spec.id,stage,identity:c.identity,syntheticSkipped:mode==='offline'});
  if(mode==='live'){
   console.log(JSON.stringify({checkpoint:c.requestPath,decision:c.decisionPath,caseId:spec.id,stage}));
   await c.wait({signal:control.signal,deadline:broker.ledger.snapshot().startedAt+plan.budget.dispatchWindowMinutes*60000});
  }
 }
 function reconcile(data,taskId,caseId){
  const calls=(data.modelCalls||[]).filter(r=>r.taskId===taskId).reverse(),transport=broker.rows.filter(r=>r.caseId===caseId);
  for(let i=transport.length;i<calls.length;i++){
   const c=calls[i];assert.equal(c.providerType,'codex');assert.equal(c.model,plan.model.id);
   // With the verified PATH shim this application attempt never reached a forwarding boundary.
   const rejected=broker.ledger.localReject({caseId,role:c.role,stage:c.stage},'APPLICATION_FAILED_BEFORE_CLI_EXEC');
   broker.rows.push({caseId,attemptId:rejected.id,applicationCallId:c.id,transportDispatched:false,localRejected:true});
   broker.cancel('APPLICATION_FAILED_BEFORE_CLI_EXEC');
  }
  assert.equal(calls.length,broker.rows.filter(r=>r.caseId===caseId).length,'Unreconciled application entry');
  const currentTransport=broker.rows.filter(r=>r.caseId===caseId),accounting=broker.ledger.snapshot();
  for(const [index,c] of calls.entries()){
   assert.equal(c.providerType,'codex');assert.equal(c.model,plan.model.id);assert.equal(c.reasoning,plan.model.reasoning);
   const boundary=currentTransport[index],entry=accounting.attempts.find(a=>a.id===boundary?.attemptId);
   const caseRefusal=c.errorCode==='MODEL_CLI'&&boundary?.transportDispatched===false&&boundary.role===c.role&&boundary.stage===c.stage&&entry?.transportPermitted===false&&entry.caseId===caseId&&entry.rejection?.code==='LEDGER_CASE_BUDGET'&&entry.rejection.scope==='case';
   if(c.errorCode&&!caseRefusal||c.stage==='json_repair')broker.cancel(c.errorCode||'UNPLANNED_JSON_REPAIR');
  }
  return calls;
 }
 try{
  await launch();const before=await api('state');assert.equal(before.providers.length,0);assert.equal(before.tasks.length,0);
  await api('settings',{automatic:false,autoComplete:false,evidenceGrounding:true});await api('saveProvider',provider);
  const suite=read(path.join(pack,'stimuli.json'));
  for(const spec of [{...plan.protocolGate,lane:'generated'},...suite.cases]){
   if(broker.stopped)break;const input=project(spec),start=broker.rows.length;let taskId,context,initial,final,caseError;
   if(spec.lane==='fixed_invalid'){
    fs.mkdirSync(path.join(directory,spec.id));negative=await createNegative({app,asar,directory:path.join(directory,spec.id),input,provider});taskId=negative.seedIdentity.taskId;
    const state=await negative.snapshot();context={id:spec.id,taskId,title:input.title,description:input.description,criteria:input.criteria,lane:spec.lane,candidate:input.candidate,sources:state.sources};broker.setContext(context);
   }else{
    for(const source of input.sources)await api('captureSave',{organize:false,textItems:[source]});const state=await api('state');
    const sources=input.sources.map(s=>state.sources.find(r=>r.title===s.title));assert.ok(sources.every(Boolean));
    await api('createTask',{title:input.title,description:input.description,criteria:input.criteria,sourceIds:sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});
    taskId=(await api('state')).tasks.find(t=>t.title===input.title).id;context={id:spec.id,taskId,title:input.title,description:input.description,criteria:input.criteria,lane:spec.lane,sources,revisionNote:spec.revision?.note};broker.setContext(context);
   }
   const call=negative?negative.api:api;
   try{
    if(spec.lane==='generated_restart'){await restart();checks.push({caseId:spec.id,kind:'restart-before-advance-zero-calls'});}
    await call('advance',{id:taskId});await settle(taskId,call);initial=await exportState(call);
    if(spec.id===plan.protocolGate.id||spec.lane==='generated_revision'){
     assert.equal(initial.tasks.find(t=>t.id===taskId).status,'review');
     await checkpoint(spec,input,initial,taskId,spec.id===plan.protocolGate.id?'protocol-gate':'initial-draft');
    }
    if(spec.lane==='generated_revision'){
     const t=initial.tasks.find(t=>t.id===taskId);assert.equal(t.status,'review','Initial revision draft did not reach review');
     context.revised=true;await api('taskAction',{id:taskId,command:'revise',note:spec.revision.note});
     const pending=await exportState();assert.notEqual(pending.tasks.find(t=>t.id===taskId).status,'review');
     await api('advance',{id:taskId});await settle(taskId);final=await exportState();
     assert.notEqual(sha(JSON.stringify(artifacts(initial,taskId))),sha(JSON.stringify(artifacts(final,taskId))));
     assert.notDeepEqual(initial.tasks.find(t=>t.id===taskId).grounding,final.tasks.find(t=>t.id===taskId).grounding);
     checks.push({caseId:spec.id,kind:'revision-new-draft-and-verification'});
    }else final=initial;
    if(spec.lane==='generated_restart'){
     const expected=sha(JSON.stringify({artifacts:artifacts(final,taskId),grounding:final.tasks.find(t=>t.id===taskId).grounding}));await restart();final=await exportState();
     assert.equal(sha(JSON.stringify({artifacts:artifacts(final,taskId),grounding:final.tasks.find(t=>t.id===taskId).grounding})),expected);
     assert.equal(final.tasks.find(t=>t.id===taskId).status,'review');checks.push({caseId:spec.id,kind:'restart-at-review-preserves-current-evidence'});
    }
    const t=final.tasks.find(t=>t.id===taskId);assert.notEqual(t.status,'completed');
    if(spec.lane==='fixed_invalid'){
     await negative.snapshot();assert.equal(t.status,'blocked');assert.equal(t.grounding.passed,false);
    }else {assert.equal(t.status,'review',t.lastError);assert.equal(t.grounding.passed,true);}
    const acceptance=await call('acceptanceSnapshot',{projectId:''});write(path.join(output,spec.id+'-acceptance.json'),acceptance);
    const item=acceptance.items.find(i=>i.id===taskId);if(spec.lane==='fixed_invalid')assert.ok(!item||item.ready===false);else assert.equal(item?.ready,true);
    // Independent semantic judgement remains pending even when the product says passed.
   }catch(e){caseError=e.message;}
   if(!final)final=await exportState(call);
   const calls=reconcile(final,taskId,spec.id),actual=broker.rows.slice(start);
   if(caseError&&spec.id!==plan.protocolGate.id&&!broker.ledger.snapshot().caseStops[spec.id])broker.ledger.stopCase(spec.id,caseError);
   const result={caseId:spec.id,lane:spec.lane,taskId,technicalPassed:!caseError,error:caseError||null,applicationAttempts:calls.length,cliExecRequests:actual.length,manualAcceptance:'pending-human',semanticAdjudication:mode==='offline'?'not-applicable-synthetic':'pending-independent-review',initial,final,...(negative?{seedIdentity:negative.seedIdentity}:{})};
   write(path.join(output,spec.id+'.json'),result);results.push({caseId:spec.id,technicalPassed:!caseError,applicationAttempts:calls.length,error:caseError||null});
   if(negative){await negative.close();negative=null;}
   if(caseError&&spec.id===plan.protocolGate.id){broker.cancel('PROTOCOL_GATE_FAILED');throw Error(caseError);}
   if(broker.stopped)throw Error('GLOBAL_STOP_AFTER_CASE');
  }
  assert.equal(results.length,7);assert.ok(results.every(r=>r.technicalPassed));assert.deepEqual(appErrors,[]);assert.ok(!broker.stopped);
 }catch(e){failed=e;broker.cancel(e.message);}finally{
  try{await negative?.close();await app?.close();}catch(e){failed ||=e;}await broker.close();
  process.off('SIGINT',signalStop);process.off('SIGTERM',signalStop);
 }
 const summary={passed:!failed,mode,fault:fault||null,liveModelCalls:mode==='offline'?0:broker.rows.filter(r=>r.transportDispatched).length,syntheticUsage:mode==='offline',sealIdentity:IDENTITY,asarSha256:plan.asarSha256,executableSha256:identity.executableSha256,shimSha256:sha(fs.readFileSync(path.join(shim,'codex.exe'))),isolatedDirectory:directory,userWorkspaceTouched:false,manualAcceptancePerformed:false,results,checks,ledger:broker.ledger.snapshot(),errors:[...(failed?[failed.stack]:[]),...broker.errors],appErrors};
 try{identityGuard();}catch(e){failed ||=e;summary.passed=false;summary.errors.push(e.stack);}summary.dependencies=dependencyIdentity;
 write(path.join(output,'summary.json'),summary);console.log(JSON.stringify({passed:summary.passed,mode,liveModelCalls:summary.liveModelCalls,cases:results.length,output,error:failed?.message}));if(failed)throw failed;return summary;
}
module.exports={run};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'},offline:{type:'boolean'},live:{type:'boolean'},authorization:{type:'string'},'real-cli':{type:'string'},fault:{type:'string'}}});
 assert.notEqual(!!values.offline,!!values.live,'Choose exactly --offline or --live');assert.ok(!values.fault||values.offline&&['malformed-envelope','malformed-inner','unknown-usage','case-budget'].includes(values.fault));run({executable:values.executable,output:values.output,mode:values.live?'live':'offline',authorization:values.authorization?read(values.authorization):undefined,authorizationPath:values.authorization,realCli:values['real-cli'],fault:values.fault}).catch(e=>{console.error(e.stack);process.exitCode=1;});}
