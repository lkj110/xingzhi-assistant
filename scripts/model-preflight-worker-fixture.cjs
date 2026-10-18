'use strict';
// Controlled old-format seed only. All subsequent changes use real App commands.
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const common=require('./generic-consumption-worker-fixture.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
// Execute the selected runtime's unmodified identity algorithm with only local
// fixture files/environment. Looking up the loaded module also works after the
// package runner redirects its require to the selected ASAR.
function controlledIdentity(root,{legacyCache=false}={}){
 const subscription=require('../desktop/subscription.cjs');
 const filename=Object.values(require.cache).find(m=>m.exports===subscription).filename;
 const localRequire=require('node:module').createRequire(filename);
 const folder=path.join(root,'subscription-identity');fs.mkdirSync(folder,{recursive:true});const dir=fs.realpathSync(folder);
 const bin=path.join(dir,'codex'),config=path.join(dir,'config.toml'),cache=path.join(dir,'models_cache.json');
 for(const [file,body]of [[bin,'controlled CLI metadata only; never executed\n'],[config,'model = "controlled"\n'],[cache,'{"models":[]}']]){
  if(!fs.existsSync(file))fs.writeFileSync(file,body,{mode:file===bin?0o700:0o600});
 }
 const env={PATH:dir,HOME:dir,CODEX_HOME:dir,LANG:'en_US.UTF-8',TZ:'UTC'},accesses=[];
 const isolatedFS={...fs};
 for(const name of ['statSync','realpathSync','accessSync','readFileSync'])isolatedFS[name]=(file,...args)=>{
  // Reject the built-in CLI candidate before it can touch the host filesystem.
  if(![bin,config,cache].includes(file))throw Object.assign(Error('outside controlled identity files'),{code:'ENOENT'});
  accesses.push({operation:name,file});return fs[name](file,...args);
 };
 const context={module:{exports:{}},process:{env},require:n=>n==='node:fs'?isolatedFS:n==='node:child_process'?{spawn(){throw Error('identity must never execute CLI');}}:localRequire(n)};
 let source=fs.readFileSync(filename,'utf8');
 if(legacyCache){
  // Explicit historical producer adapter, confined to a temporary VM and files.
  const current="const config=metadata(path.join(home,'config.toml'));\n  return {cliHash:cli?hash(cli):null,configurationHash:config.code&&config.code!=='ENOENT'?null:hash({env,config})};";
  assert.ok(source.includes(current));
  source=source.replace(current,"const config=metadata(path.join(home,'config.toml')),models=metadata(path.join(home,'models_cache.json'));\n  return {cliHash:cli?hash(cli):null,configurationHash:[config,models].some(v=>v.code&&v.code!=='ENOENT')?null:hash({env,config,models})};");
 }
 vm.runInNewContext(source,context,{filename});
 return {identity:context.module.exports.identity,bin,config,cache,env,accesses};
}
function historicalHealth(){
 const health=require('../desktop/subscription-health.cjs'),filename=Object.values(require.cache).find(m=>m.exports===health).filename;
 const source=fs.readFileSync(filename,'utf8'),marker='return {identityPolicyVersion:2,cliHash:';assert.ok(source.includes(marker));
 const context={module:{exports:{}},require:require('node:module').createRequire(filename),structuredClone,Date};
 vm.runInNewContext(source.replace(marker,'return {cliHash:'),context,{filename});return context.module.exports;
}
async function setup({Assistant,options,reportFile,mode='legacy',scenario='direct',...rest}){
 const f=await common.setup({Assistant,options,reportFile,restoreAudit:true,scenario:'success',...rest}),{a,job,task,audit}=f;
 const subscription=require('../desktop/subscription.cjs'),recovery=require('../desktop/model-preflight-recovery.cjs');
 const local=controlledIdentity(a.dir),health=require('../desktop/subscription-health.cjs');
 subscription.identity=local.identity;
 audit.cacheRefreshes||=[];
 const ownerEvents=()=>require('../desktop/work-journal.cjs').read(a).events.filter(e=>e.type==='execution_policy_prepared'&&e.entityId===job.id&&e.payload?.command==='owner_select');
 function continuationState(){
  const s=job.executionState.continuation,e=s.episodes[audit.preparedHealthUpgrade?.continuation.activeBasis||s.activeBasis];
  return {activeTaskId:s.activeTaskId??null,activeBasis:s.activeBasis,policyOwner:job.executionState.policyOwner||null,episodeKeys:Object.keys(s.episodes).sort(),episode:{basis:e.basis,taskId:e.taskId,cycles:e.cycles,hops:e.hops,suspendedBy:e.suspendedBy||null}};
 }
 function refreshCache(stage){
  const before=subscription.identity(),old=fs.statSync(local.cache),body=fs.readFileSync(local.cache,'utf8');
  if(stage==='after_health')fs.appendFileSync(local.cache,' \n');
  else if(stage==='before_claim')fs.writeFileSync(local.cache,JSON.stringify({models:[{slug:'controlled-refresh',visibility:'list'}]}));
  else {fs.writeFileSync(local.cache+'.next',body);fs.renameSync(local.cache+'.next',local.cache);}
  const after=subscription.identity();assert.deepEqual(after,before,'cache refresh must not change real identity');
  assert.ok(before.cliHash&&before.configurationHash);
  assert.ok(local.accesses.every(v=>v.file!==local.cache),'identity must not stat/read cache');
  const record={stage,before,after,oldInode:old.ino,newInode:fs.statSync(local.cache).ino};
  if(stage!=='during_health'){
   const failedAt=a.data.agentRuns.find(r=>r.id===audit.modelPreflight?.oldRunId)?.finishedAt;
   record.checkId=health.valid(a,{after:failedAt})?.checkId;assert.ok(record.checkId,'cache refresh preserves health');
  }
  audit.cacheRefreshes.push(record);f.saveAudit();
 }
 subscription.status=async()=>{refreshCache('during_health');return {installed:true,loggedIn:true,path:local.bin,version:'controlled'};};
 const prepare=recovery.prepare,claim=recovery.claim;
 recovery.prepare=(owner,...args)=>{const result=prepare(owner,...args);if((owner.executionOwner||owner)===a&&result&&!audit.cacheRefreshes.some(v=>v.stage==='after_prepare'))refreshCache('after_prepare');return result;};
 recovery.claim=(owner,...args)=>{let ownerAtClaim;if((owner.executionOwner||owner)===a&&require('../desktop/evidence-consumption.cjs').active(task)?.modelPreflightRecovery?.status==='prepared'){
  if(audit.preparedHealthUpgrade)assert.deepEqual(job.executionState.workEfficiency,audit.preparedHealthUpgrade.workEfficiency,'claim must not reset old efficiency counters/history to bypass recovery_pending');
  if(audit.preparedHealthUpgrade)ownerAtClaim={continuation:structuredClone(continuationState()),events:structuredClone(ownerEvents())};
  refreshCache('before_claim');
 }const result=claim(owner,...args);if(result&&ownerAtClaim){audit.ownerAtClaim=ownerAtClaim;f.saveAudit();}return result;};
 const original=a.chat;
 a.chat=async(p,k,m,o)=>{
  if(o.role==='execute'&&JSON.parse(m[1].content).evidenceConsumption&&!audit.modelPreflight){
   audit.modelPreflight={mode,seedPending:true};f.saveAudit();
   if(mode==='native'){
    o.onUsage({inputTokens:0,outputTokens:0,cachedInputTokens:0});
    throw require('../desktop/model-errors.cjs').preflightError(require('../desktop/model-errors.cjs').transportError('MODEL_TIMEOUT'),'login_status');
   }
   throw require('../desktop/model-errors.cjs').modelError('MODEL_AUTH','无法确认 Codex 登录状态，请在模型设置中重新检测。',false);
  }
  return original(p,k,m,o);
 };
 // Provider shape is seeded before the first controlled failure; no real CLI
 // inference is possible because chat, platform and network are all isolated.
 if(!audit.modelPreflight){for(const p of a.data.providers){p.type='codex';p.model='gpt-6.1-sol';}a.save();}
 function observe(){
  const p=require('../desktop/evidence-consumption.cjs').active(task),g=p?.modelPreflightRecovery;
  return {...common.observe(f),ids:{job:job.id,task:task.id},preflight:{seed:audit.modelPreflight,view:recovery.view(a,job),candidate:recovery.candidate(a,job,task),policy:require('../desktop/execution-policy.cjs').inspect(a,job),grant:g,health:health.receipt(a),healthUpgrade:p?.modelPreflightHealthUpgrade,healthUpgradeEvents:require('../desktop/work-journal.cjs').read(a).events.filter(e=>e.type===recovery.HEALTH_UPGRADE),workEfficiency:job.executionState.workEfficiency,continuation:continuationState(),ownerSelectionEvents:ownerEvents(),rawBudgetHash:hash(fs.readFileSync(path.join(a.dir,'spend-ledger.json'),'utf8')),oldRequests:Object.values(task.evidenceConsumption?.attempts||{}).flatMap(p=>p.requests||[]).filter(r=>r.requestId===audit.modelPreflight?.requestId)}};
 }
 const dispatch=a.dispatch.bind(a);
 a.dispatch=async(action,input)=>{
  if(action==='controlledPreflightObserve')return observe();
  if(action==='controlledPreflightPrepareLegacy'){
   assert.equal(scenario,'prepared-upgrade');assert.equal(mode,'legacy');assert.ok(!audit.preparedHealthUpgrade);
   assert.equal(recovery.candidate(a,job,task).eligible,true);
   const old=historicalHealth(),historical=controlledIdentity(a.dir,{legacyCache:true});
   const saved={identity:subscription.identity,status:subscription.status,check:health.check,valid:health.valid};
   const before={budget:hash(fs.readFileSync(path.join(a.dir,'spend-ledger.json'),'utf8')),requests:hash(require('../desktop/evidence-consumption.cjs').active(task).requests),calls:a.data.modelCalls.length,runs:a.data.agentRuns.length};
   try{
    subscription.identity=historical.identity;subscription.status=async()=>({installed:true,loggedIn:true,version:'controlled historical CLI'});health.check=old.check;health.valid=old.valid;
    await dispatch('uiCommand',{action:'subscriptionStatus',input:{}});
    const g=prepare(a,job,task);assert.equal(g.health.identityPolicyVersion,undefined);assert.equal(g.status,'prepared');
    // Historical post-prepare guard failure: preserve all accumulated attempts,
    // history, seen facts and strategy counters; only the saved failure changes.
    const work=require('../desktop/work-efficiency.cjs');
    const efficiency=job.executionState.workEfficiency||=(
     {version:2,progressVersion:1,intent:work.intent(a,job),seen:work.snapshot(a,job).facts,attempts:7,phase:'working',tried:{'historical-original-revision':true},history:[{id:'historical-original-revision',title:'历史原稿恢复',attempts:7,outcome:'no_progress',failure:'EVIDENCE_GENERATION_UNRESOLVED'}],reason:'controlled historical guard state'}
    );
    efficiency.phase='recovery_pending';efficiency.lastFailure={code:'EVIDENCE_GENERATION_UNRESOLVED',message:'历史原恢复尚未领取，生成结果未决',taskId:task.id,stage:'task_work'};
    const continuation=job.executionState.continuation,episode=continuation.episodes[continuation.activeBasis];
    assert.ok(episode);assert.equal(episode.taskId,task.id);
    continuation.activeTaskId=null;
    episode.suspendedBy={code:'EVIDENCE_GENERATION_UNRESOLVED',message:'历史原稿恢复后交还接续控制，保留原episode',at:g.preparedAt};
    audit.preparedHealthUpgrade={adapter:'historical-cache-metadata-and-markerless-health-v1',grant:structuredClone(g),before,workEfficiency:structuredClone(efficiency),continuation:structuredClone(continuationState()),ownerSelectionEvents:structuredClone(ownerEvents())};
   }finally{subscription.identity=saved.identity;subscription.status=saved.status;health.check=saved.check;health.valid=saved.valid;}
   assert.equal(health.valid(a,{after:a.data.agentRuns.find(r=>r.id===audit.modelPreflight.oldRunId).finishedAt}),null);
   a.save();f.saveAudit();return observe();
  }
  if(action==='controlledPreflightRun'){
   await dispatch('uiCommand',{action:'agentRun',input:{id:job.id}});
   await a.runPromise;
   if(audit.modelPreflight?.seedPending){
    const p=require('../desktop/evidence-consumption.cjs').active(task),r=p.requests.at(-1),call=a.data.modelCalls.find(c=>c.id===r.callId);
    assert.equal(call.errorCode,'MODEL_AUTH');assert.equal(job.status,'blocked');
    if(mode==='legacy'){
     // Explicit historical schema adapter, not a production migration. Preserve
     // every other actual error/request/usage field produced by the real run.
     delete r.producerSchema;delete call.producerSchema;
     for(const run of [...a.data.agentRuns,...task.progressRuns])for(const c of run.modelCallsDetail||[])if(c.id===call.id)delete c.producerSchema;
    }
    Object.assign(audit.modelPreflight,{seedPending:false,attemptId:p.attemptId,requestId:r.requestId,request:structuredClone(r),callId:call.id,oldRunId:r.runId,heldUSD:a.spendLedger.scopes['job:'+job.id].heldUSD,oldRunHash:hash(a.data.agentRuns.find(run=>run.id===r.runId))});
    a.save();
   }
   f.saveAudit();return observe();
  }
  const result=await dispatch(action,input);
  if(action==='uiCommand'&&input?.action==='subscriptionStatus'&&result?.health)refreshCache('after_health');
  if(action==='uiCommand'&&input?.action==='agentModelPreflightHealthUpgrade'&&scenario==='prepared-upgrade')refreshCache('after_upgrade');
  return result;
 };
 return {...f,observe};
}
module.exports={setup,controlledIdentity};
