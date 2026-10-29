'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {root,pack,sha,read,write,frozen,runnerSeal,verifyRunner}=require('./identity.cjs');
const {createBroker}=require('./broker.cjs'),{createCheckpoint}=require('../foundation-marker-runner/checkpoints.cjs');
const {current,digest,marker,confirmation,assertReady,createPhases,waitForHuman}=require('../foundation-marker-runner/phases.cjs');
const {createNegative}=require('../foundation-runner/negative.cjs');
const binding=require('./binding.cjs');
async function run({executable,output,mode='offline',authorization,authorizationPath,realCli,fault}){
 process.env.WS_NO_BUFFER_UTIL='1';process.env.WS_NO_UTF_8_VALIDATE='1';
 assert.equal(process.platform,'win32');output=require('../foundation-marker-runner/output.cjs').validateOutput(output);
 assert.ok(['offline','live'].includes(mode));assert.ok(!fault||mode==='offline');
 const identity=frozen(executable,{complete:true}),{plan,asar}=identity,sealIdentity=identity.seal.identity;
 const manifest=read(path.join(__dirname,'runner-seal.json'));verifyRunner(manifest,sealIdentity);
 const suite=read(path.join(pack,'stimuli.json')),specs=suite.cases;
 assert.deepEqual(specs.map(s=>s.id),plan.order);assert.equal(specs.length,6);
 assert.equal(specs.filter(s=>s.lane==='fixed_invalid').length,2);
 const {project}=require(path.join(pack,'inputs.cjs'));
 if(fault==='case-budget'){
  plan.caseLimits[0].tokenStopThreshold=1;plan.budget.businessTokenStopThreshold=plan.caseLimits.reduce((n,c)=>n+c.tokenStopThreshold,0);plan.budget.reportedTokenStopThreshold=plan.budget.protocolTokenStopThreshold+plan.budget.businessTokenStopThreshold;
 }
 let shimHash,shimPath;
 const guardIdentity=()=>{
  const fresh=frozen(executable);assert.equal(fresh.seal.identity,sealIdentity);verifyRunner(manifest,sealIdentity);
  if(mode==='live')assert.equal(sha(fs.readFileSync(realCli)),authorization.realCliSha256);
  if(shimHash)assert.equal(sha(fs.readFileSync(shimPath)),shimHash,'CLI shim changed');
 };
 if(mode==='live'){
  const review=read(path.join(__dirname,'runner-review.json'));assert.equal(review.approvedForLiveReadiness,true);assert.equal(review.sampleSealIdentity,sealIdentity);assert.equal(review.runnerIdentity,manifest.identity);assert.equal(review.realModelCalls,0);
  assert.ok(authorization&&path.isAbsolute(realCli),'New real user approval and verified CLI required');assert.equal(authorization.realCliSha256,plan.gatePrerequisite.realCliSha256);
  assert.equal(sha(fs.readFileSync(realCli)),authorization.realCliSha256);
  require('../foundation-runner/authorization.cjs').claimAuthorization({authorizationPath,authorization,output,runnerIdentity:manifest.identity,sealIdentity});
 }
 require('../foundation-marker-runner/output.cjs').validateOutput(output);fs.mkdirSync(output,{recursive:true});const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'foundation-business-runner-'));
 const shim=path.join(directory,'shim'),profile=path.join(directory,'profile');fs.mkdirSync(shim);
 cp.execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/optimize+','/out:'+path.join(shim,'codex.exe'),'/reference:System.Web.Extensions.dll',path.join(root,'evaluations/foundation-runner/Bridge.cs')],{windowsHide:true,timeout:60000});
 shimPath=path.join(shim,'codex.exe');shimHash=sha(fs.readFileSync(shimPath));
 const env={...process.env,PATH:shim+path.delimiter+process.env.PATH,CODEX_HOME:path.join(directory,'synthetic-codex-home')};
 for(const key of Object.keys(env))if(['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ASSISTANT_TEST_DATA_DIR','ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_ENGINE_FIXTURE'].includes(key)||/^(OPENAI|ANTHROPIC|AZURE_OPENAI)_/.test(key))delete env[key];fs.mkdirSync(env.CODEX_HOME);
 let app,page,negative,failed,activeTaskId;const results=[],checks=[],appErrors=[],control=new AbortController();
 const phases=createPhases({snapshot:()=>exportState()});
 const fixture=mode==='offline'?require('./fixture.cjs').createFixture({pack,plan,fault}):undefined;
 const broker=await createBroker({directory:output,plan,mode,sealIdentity,authorization,realCli,identityGuard:guardIdentity,fault,faultCaseId:specs.find(s=>s.lane==='generated').id,fixture,admission:async(call,context)=>{await phases.admit(call,context);if(phases.value.kind==='recheck')binding.unchanged(context.contentBinding,await exportState(),context.taskId);if(fs.existsSync(path.join(output,'STOP')))throw Error('USER_STOP_FILE');},responseObserved:(...args)=>phases.observed(...args)});
 write(path.join(shim,'bridge.json'),broker.bridgeConfig);
 const stop=()=>{control.abort();broker.cancel('USER_STOP_SIGNAL');};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const provider={type:'codex',name:mode==='offline'?'Offline synthetic CLI':'Guarded subscription evaluation',model:plan.model.id,reasoning:plan.model.reasoning,inputPrice:0,outputPrice:0,requestPolicy:{idleMinutes:2,totalMinutes:3,retries:0}};
 const deadline=()=>{const started=broker.ledger.snapshot().startedAt;assert.ok(started);return started+plan.budget.dispatchWindowMinutes*60000;};
 async function guard(){
  if(control.signal.aborted||fs.existsSync(path.join(output,'STOP')))throw Error('USER_STOP');
  if(broker.stopped)throw Error('BROKER_STOPPED: '+broker.errors.join(';'));
  const s=broker.ledger.snapshot();if(s.startedAt&&Date.now()>=deadline())throw Object.assign(Error('Original round dispatch window expired'),{code:'HUMAN_PENDING'});
 }
 async function api(action,input={}){
  assert.ok(['state','export','settings','saveProvider','captureSave','createTask','advance','taskAction','stop','acceptanceSnapshot','groundingStatus'].includes(action));
  if(action==='taskAction')assert.equal(input.command,'revise','Live executor cannot confirm, recheck or accept for a human');
  const result=await page.evaluate(({action,input})=>window.assistant.call(action,input),{action,input});if(result.error)throw Object.assign(Error(result.error),{code:result.code});return result.data;
 }
 const exportState=async(call=api)=>{const v=await call('export');return v.data||v.workspace||v;};
 async function launch(){
  guardIdentity();frozen(executable,{complete:true});
  app=await require('playwright/test')._electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>appErrors.push(e.message));await page.waitForFunction(()=>!!window.assistant);
  const proof=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData'),version:app.getVersion(),asar:app.getAppPath()}));assert.equal(proof.packaged,true);assert.equal(proof.profile,profile);assert.equal(proof.version,plan.installedVersion);assert.equal(proof.asar,asar);
  const status=await api('groundingStatus');assert.equal(status.implementationHash,identity.groundingSha256);checks.push({kind:'boot',proof,groundingHash:status.implementationHash,attempts:broker.rows.length});
 }
 async function settle(id,call=api){
  const end=Date.now()+plan.budget.perCallTimeoutMs*2;
  for(;;){await guard();const state=await call('state'),task=state.tasks.find(t=>t.id===id);if(['review','blocked','completed','waiting','paused'].includes(task?.status))return task;if(Date.now()>=end)throw Error('TASK_DID_NOT_SETTLE');await new Promise(r=>setTimeout(r,200));}
 }
 async function restart(){const count=broker.rows.length;await app.close();app=null;await launch();await new Promise(r=>setTimeout(r,300));assert.equal(broker.rows.length,count,'Restart called model');}
 async function checkpoint(spec,input,data,stage){
  const {draft}=current(data,activeTaskId),content={...input,...(stage==='revision'?{revisionNote:spec.revision.note}:{})};
  const bound=binding.checkpoint(data,activeTaskId);
  const c=createCheckpoint({directory:path.join(output,'checkpoints'),caseId:spec.id,stage,input:content,draft,sealIdentity});
  checks.push({kind:'independent-content-review',caseId:spec.id,stage,identity:c.identity,syntheticSkipped:mode==='offline'});
  if(mode==='live'){
   console.log(JSON.stringify({event:'independent-review-needed',caseId:spec.id,stage,request:c.requestPath,decision:c.decisionPath}));
   // Cancellation and STOP files remain effective during an independent review.
   const timer=setInterval(()=>{guard().catch(()=>control.abort());},200);
   try{await c.wait({signal:control.signal,deadline:deadline()});}finally{clearInterval(timer);}
  }
  await guard();binding.unchanged(bound,await exportState(),activeTaskId,'checkpoint');
 }
 function prompt(spec,stage,action,data){
  const value={schema:1,caseId:spec.id,stage,action,taskId:activeTaskId,deadline:new Date(deadline()).toISOString(),outputDirectory:output,stopFile:path.join(output,'STOP'),sealIdentity,...data};
  write(path.join(output,`${spec.id}-${stage}-${action}.json`),value);console.log(JSON.stringify(mode==='live'?{event:'human-action-required',...value}:{event:'offline-human-action-simulated',caseId:spec.id,stage,action}));
 }
 async function qualify(spec,input,context,stage,initial){
  const view=current(initial,activeTaskId);write(path.join(output,`${spec.id}-${stage}-draft.json`),{input:{...input,...(stage==='revision'?{revisionNote:spec.revision.note}:{})},...view});
  // Even a blocked draft is retained for blinded adjudication and false-block reporting.
  await checkpoint(spec,input,initial,stage);
  if(marker(view.task)){
   assert.notEqual(spec.id,plan.protocolGate.id,'Unexpected gate human handoff');
   const reviewBinding={draftHash:digest(view.draft),reportHash:view.task.grounding.reportHash,basis:view.task.grounding.basis};context.contentBinding=binding.content(initial,activeTaskId);
   const count=broker.rows.length;
   prompt(spec,stage,'marker-confirmation',{draft:view.draft,sources:input.sources,markerReview:view.task.grounding.markerReview,reportHash:reviewBinding.reportHash,instructions:'请真人阅读原文与待确认表达，先点“确认这些表达已清楚”，再单独点“重新核验”。不要改稿或要求。'});
   // Admission still forbids any request before the exact current user record exists.
   phases.open('recheck',context,{...reviewBinding,stage:stage+'-human-recheck'});
   if(mode==='offline'&&fault!=='human-timeout'){
    await require('../foundation-marker-runner/offline-human.cjs').act(page,'confirm',activeTaskId,mode);assert.equal(broker.rows.length,count,'Confirmation called model');
    const confirmed=current(await exportState(),activeTaskId).task;assert.ok(confirmation(confirmed,reviewBinding.reportHash,reviewBinding.basis));
    await require('../foundation-marker-runner/offline-human.cjs').act(page,'recheck',activeTaskId,mode);
   }
   const waitingDeadline=fault==='human-timeout'?Date.now()+350:deadline();
   const after=await waitForHuman({read:()=>exportState(),guard,deadline:waitingDeadline,check:data=>{
    const {task,draft}=current(data,activeTaskId);binding.unchanged(context.contentBinding,data,activeTaskId);assert.equal(digest(draft),reviewBinding.draftHash,'Human handoff draft changed');
    if(task.status==='blocked'||task.status==='paused')throw Error('Recheck rejected the draft');
    if(task.status==='completed')throw Error('Premature human acceptance');
    if(marker(task)&&task.grounding.reportHash!==reviewBinding.reportHash&&broker.rows.length>count&&phases.value.kind==='closed')throw Error('Second marker handoff is unclosed; stop round');
    return task.status==='review';
   }});
   const task=current(after,activeTaskId).task;assertReady(task);assert.equal(task.grounding.humanMarkerConfirmation,task.groundingMarkerConfirmation.recordHash);
   checks.push({kind:'marker-handoff-closed',caseId:spec.id,stage,actualHuman:mode==='live',beforeAttempts:count,afterAttempts:broker.rows.length,reportHash:reviewBinding.reportHash,confirmationRecordHash:task.groundingMarkerConfirmation.recordHash});return after;
  }
  assertReady(view.task);return initial;
 }
 async function humanAccept(spec,context,stage,data){
  const {draft,task}=current(data,activeTaskId);assertReady(task);const hash=binding.content(data,activeTaskId),count=broker.rows.length;phases.open('closed',context,{stage:'human-acceptance'});
  const acceptance=await api('acceptanceSnapshot',{projectId:''});assert.equal(acceptance.items.find(x=>x.id===activeTaskId)?.ready,true);
  prompt(spec,stage,'final-acceptance',{draft,input:{...project(spec),...(stage==='revision'?{revisionNote:spec.revision.note}:{})},instructions:'请真人核对全文及来源，确认满足全部要求后点击“验收完成”；不同意请停止本轮。'});
  if(mode==='offline')await require('../foundation-marker-runner/offline-human.cjs').act(page,'accept',activeTaskId,mode);
  const final=await waitForHuman({read:()=>exportState(),guard,deadline:deadline(),check:data=>{const v=current(data,activeTaskId);binding.unchanged(hash,data,activeTaskId);assert.equal(broker.rows.length,count,'Model call during final human acceptance');assert.ok(['review','completed'].includes(v.task.status),'Unexpected acceptance state');assert.equal(v.task.grounding?.passed,true);assert.equal(v.task.verification?.passed,true);return v.task.status==='completed';}});
  assert.equal(current(final,activeTaskId).task.acceptedBy,'user');checks.push({kind:'final-human-acceptance',caseId:spec.id,stage,actualHuman:mode==='live',attempts:count});return final;
 }
 function reconcile(data,id,caseId){
  const calls=(data.modelCalls||[]).filter(c=>c.taskId===id).reverse(),rows=broker.rows.filter(r=>r.caseId===caseId);
  for(let i=rows.length;i<calls.length;i++){const c=calls[i],row=broker.ledger.localReject({caseId,role:c.role,stage:c.stage},'APPLICATION_FAILED_BEFORE_CLI_EXEC');broker.rows.push({caseId,attemptId:row.id,transportDispatched:false,applicationCallId:c.id});broker.cancel('APPLICATION_FAILED_BEFORE_CLI_EXEC');}
  assert.equal(calls.length,broker.rows.filter(r=>r.caseId===caseId).length,'Unreconciled application call');
  for(const c of calls){assert.equal(c.providerType,'codex');assert.equal(c.model,plan.model.id);assert.equal(c.reasoning,plan.model.reasoning);if(c.errorCode||c.stage==='json_repair')broker.cancel(c.errorCode||'UNPLANNED_REPAIR');}
  return calls;
 }
 try{
  await launch();const empty=await api('state');assert.equal(empty.tasks.length,0);assert.equal(empty.providers.length,0);
  await page.getByRole('button',{name:'暂时跳过',exact:true}).click();
  await api('settings',{automatic:false,autoComplete:false,autoExtract:false,evidenceGrounding:true});await api('saveProvider',provider);
  for(const spec of specs){
   await guard();const input=project(spec),start=broker.rows.length;let initial,final,error,context,draftStage='initial',priorDraftHash;
   if(spec.lane==='fixed_invalid'){
    fs.mkdirSync(path.join(directory,spec.id));negative=await createNegative({app,asar,directory:path.join(directory,spec.id),input,provider,packageIdentity:identity});activeTaskId=negative.seedIdentity.taskId;
    assert.equal((await negative.api('groundingStatus')).implementationHash,identity.groundingSha256);
    context={id:spec.id,taskId:activeTaskId,...input,lane:spec.lane,sources:(await negative.snapshot()).sources};
   }else{
    for(const s of input.sources)await api('captureSave',{organize:false,textItems:[s]});const state=await api('state'),sources=input.sources.map(s=>state.sources.find(v=>v.title===s.title));assert.ok(sources.every(Boolean));
    await api('createTask',{title:input.title,description:input.description,criteria:input.criteria,sourceIds:sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});
    activeTaskId=(await api('state')).tasks.find(t=>t.title===input.title).id;context={id:spec.id,taskId:activeTaskId,...input,lane:spec.lane,sources,revisionNote:spec.revision?.note};
   }
   broker.setContext(context);const call=negative?negative.api:api;phases.open('work',context,{stage:'initial'});
   try{
    if(spec.lane==='generated_restart')await restart();
    await call('advance',{id:activeTaskId});await settle(activeTaskId,call);initial=await exportState(call);
    if(negative){await negative.snapshot();const t=initial.tasks.find(t=>t.id===activeTaskId);assert.equal(t.status,'blocked');assert.equal(t.grounding?.passed,false);const acceptance=await call('acceptanceSnapshot',{projectId:''});assert.notEqual(acceptance.items.find(t=>t.id===activeTaskId)?.ready,true);final=initial;}
    else{
     final=await qualify(spec,input,context,'initial',initial);
     if(spec.lane==='generated_revision'){
      const initialBasis=current(final,activeTaskId).task.grounding.basis;priorDraftHash=digest(current(final,activeTaskId).draft);draftStage='revision';context.revised=true;await api('taskAction',{id:activeTaskId,command:'revise',note:spec.revision.note});phases.open('work',context,{stage:'revision'});
      await api('advance',{id:activeTaskId});await settle(activeTaskId);const revised=await exportState();assert.notEqual(digest(current(revised,activeTaskId).draft),digest(current(initial,activeTaskId).draft));assert.notEqual(current(revised,activeTaskId).task.grounding.basis,initialBasis,'Revision reused old verification basis');final=await qualify(spec,input,context,'revision',revised);checks.push({kind:'revision-new-basis',caseId:spec.id});
     }
     if(spec.lane==='generated_restart'){
      const hash=sha(JSON.stringify(current(final,activeTaskId)));await restart();final=await exportState();assert.equal(sha(JSON.stringify(current(final,activeTaskId))),hash,'Restart changed evidence/draft');
     }
     if(spec.id!==plan.protocolGate.id)final=await humanAccept(spec,context,spec.revision?'revision':'initial',final);
    }
   }catch(e){error=e;if(broker.stopped){try{await call('stop');await new Promise(r=>setTimeout(r,300));}catch{}}}
   final=await exportState(call);if(error&&!negative){const audit=require('./failed-draft.cjs').capture({directory:output,caseId:spec.id,stage:draftStage,input:{...input,...(draftStage==='revision'?{revisionNote:spec.revision.note}:{})},data:final,taskId:activeTaskId,error,priorDraftHash});checks.push({kind:'failed-draft-audit',caseId:spec.id,stage:draftStage,...audit});}const calls=reconcile(final,activeTaskId,spec.id);
   const result={caseId:spec.id,lane:spec.lane,taskId:activeTaskId,technicalPassed:!error,error:error?.message||null,errorCode:error?.code||null,applicationAttempts:calls.length,cliExecRequests:broker.rows.length-start,actualHumanAcceptance:mode==='live'&&!error&&spec.lane!=='fixed_invalid'&&spec.id!==plan.protocolGate.id,semanticAdjudication:mode==='offline'?'not-applicable-synthetic':'pending-independent-final-audit',initial,final,...(negative?{seedIdentity:negative.seedIdentity}:{})};
   write(path.join(output,spec.id+'.json'),result);results.push({...result,initial:undefined,final:undefined});
   phases.open('closed',context);if(negative){await negative.close();negative=null;}if(error)throw error;await guard();
  }
  assert.equal(results.length,6);assert.deepEqual(appErrors,[]);
 }catch(e){failed=e;broker.cancel(e.code||e.message);}finally{
  try{await negative?.close();await app?.close();}catch(e){failed ||= e;}await broker.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);
 }
 try{guardIdentity();}catch(e){failed ||= e;}
 const summary={schema:1,passed:!failed,gatePrerequisite:identity.gateProof,gateExecutions:broker.rows.filter(r=>r.caseId===plan.protocolGate.id).length,mode,fault:fault||null,sealIdentity,runnerIdentity:manifest.identity,host:manifest.host,shimSha256:shimHash,asarSha256:plan.asarSha256,groundingSha256:identity.groundingSha256,isolatedDirectory:directory,liveModelCalls:mode==='offline'?0:broker.rows.filter(r=>r.transportDispatched).length,syntheticUsage:mode==='offline',userWorkspaceTouched:false,installed:false,actualHumanAcceptances:results.filter(r=>r.actualHumanAcceptance).length,simulatedAcceptances:mode==='offline'?checks.filter(c=>c.kind==='final-human-acceptance').length:0,markerBranch:checks.some(c=>c.kind==='marker-handoff-closed')?(mode==='offline'?'synthetic-only':'observed-human-closed-loop'):'not-triggered-unverified',results,checks,ledger:broker.ledger.snapshot(),errors:[...(failed?[failed.stack]:[]),...broker.errors],appErrors};
 write(path.join(output,'summary.json'),summary);console.log(JSON.stringify({passed:summary.passed,mode,liveModelCalls:summary.liveModelCalls,cases:results.length,output,error:failed?.message}));if(failed)throw failed;return summary;
}
module.exports={run};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'},offline:{type:'boolean'},live:{type:'boolean'},authorization:{type:'string'},'real-cli':{type:'string'},fault:{type:'string'}}});assert.notEqual(!!values.offline,!!values.live);assert.ok(!values.fault||values.offline&&['malformed-inner','cli-rejection','unknown-usage','case-budget','case-extra-request','human-timeout'].includes(values.fault));run({executable:values.executable,output:values.output,mode:values.live?'live':'offline',authorization:values.authorization?read(values.authorization):undefined,authorizationPath:values.authorization,realCli:values['real-cli'],fault:values.fault}).catch(e=>{console.error(e.stack);process.exitCode=1;});}
