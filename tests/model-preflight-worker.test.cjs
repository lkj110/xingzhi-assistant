'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EngineClient}=require('../desktop/engine-client.cjs');
test('shared Worker/package identity helper observes real CLI/config/env and preserves files on restart',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-identity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {controlledIdentity}=require('../scripts/model-preflight-worker-fixture.cjs'),f=controlledIdentity(dir),initial={...f.identity()};
 assert.match(initial.cliHash,/^[0-9a-f]{64}$/);assert.match(initial.configurationHash,/^[0-9a-f]{64}$/);
 assert.deepEqual({...controlledIdentity(dir).identity()},initial);
 fs.appendFileSync(f.cache,' ');assert.deepEqual({...f.identity()},initial);assert.ok(f.accesses.every(v=>v.file!==f.cache));
 fs.copyFileSync(f.bin,f.bin+'.next');fs.renameSync(f.bin+'.next',f.bin);const replaced={...f.identity()};assert.notEqual(replaced.cliHash,initial.cliHash);assert.equal(replaced.configurationHash,initial.configurationHash);
 fs.appendFileSync(f.config,'reasoning = "high"\n');const configured={...f.identity()};assert.notEqual(configured.configurationHash,replaced.configurationHash);
 assert.deepEqual({...controlledIdentity(dir).identity()},configured);
 f.env.LANG='zh_CN.UTF-8';assert.notEqual(f.identity().configurationHash,configured.configurationHash);
});
function cacheStages(s,expected){
 const rows=s.audit.cacheRefreshes;assert.deepEqual(rows.map(v=>v.stage),expected);
 for(const row of rows){
  assert.match(row.before.cliHash,/^[0-9a-f]{64}$/);assert.match(row.before.configurationHash,/^[0-9a-f]{64}$/);assert.deepEqual(row.after,row.before);
  assert.deepEqual(row.before,rows[0].before,'real CLI/config/env identity remains stable across Worker restart');
  if(['during_health','after_prepare'].includes(row.stage))assert.notEqual(row.oldInode,row.newInode,'same-content atomic cache replacement actually occurred');
  if(row.stage!=='during_health')assert.ok(row.checkId);
 }
 assert.equal(new Set(rows.filter(v=>v.checkId).map(v=>v.checkId)).size,1,'same successful health check authorizes all cache refresh stages');
}
async function setup(t,mode,scenario='direct'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-preflight-worker-')),workspace=path.join(dir,'workspace'),reportFile=path.join(dir,'audit.json'),module=path.join(dir,'fixture.cjs');fs.mkdirSync(workspace);
 fs.writeFileSync(module,`exports.create=async({Assistant,options})=>{const deny=()=>{throw Error('Actual transport forbidden')};global.fetch=deny;require('node:net').Socket.prototype.connect=deny;require('node:child_process').spawn=deny;require('node:child_process').execFile=deny;return (await require(${JSON.stringify(path.resolve(__dirname,'../scripts/model-preflight-worker-fixture.cjs'))}).setup({Assistant,options,reportFile:${JSON.stringify(reportFile)},mode:${JSON.stringify(mode)},scenario:${JSON.stringify(scenario)}})).a;};`);
 let engine;async function start(){engine=new EngineClient({dir:workspace,fixtureModule:module,safeStorage:{isEncryptionAvailable:()=>false},native:async()=>({supported:false})});await engine.ready;}
 await start();t.after(async()=>{await engine.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});return {get engine(){return engine;},restart:async()=>{await engine.close();await start();}};
}
for(const mode of ['legacy','native'])test('formal Worker '+mode+' model preflight failure recovers once through original draft check and same-target delivery',async t=>{
 const f=await setup(t,mode),states=[];let s=await f.engine.dispatch('controlledPreflightRun');states.push({stage:'failed',state:s});
 assert.equal(s.jobStatus,'blocked',JSON.stringify(s));assert.equal(s.audit.patches.length,0);assert.equal(s.audit.writes,0);
 const old=structuredClone(s.preflight.seed),budget=structuredClone(s.budget);assert.equal(s.budget.limitUSD,200);
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');states.push({stage:'cold_failed',state:s});assert.deepEqual(s.preflight.oldRequests,[old.request]);assert.equal(s.audit.patches.length,0);assert.equal(s.preflight.view?.candidate,true,JSON.stringify(s.preflight));
 if(mode==='legacy'){
  const v=s.preflight.view;
  await f.engine.dispatch('uiCommand',{action:'agentModelPreflightAttest',input:{id:s.ids.job,taskId:s.ids.task,attemptId:v.attemptId,evidenceHash:v.evidenceHash,registryId:v.registry.id,executedBy:'supervisor',authorizationNote:'按用户已有修复后恢复原事项的授权进行验证',expectedWorkRevision:v.expectedWorkRevision,expectedTaskRevision:v.expectedTaskRevision}});
 }
 await f.engine.dispatch('uiCommand',{action:'subscriptionStatus',input:{}});
 s=await f.engine.dispatch('controlledPreflightObserve');assert.equal(s.audit.patches.length,0);assert.ok(Math.abs(s.budget.heldUSD-budget.heldUSD)<1e-9);states.push({stage:'attested_health',state:s});
 cacheStages(s,['during_health','after_health']);
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');cacheStages(s,['during_health','after_health']);
 s=await f.engine.dispatch('controlledPreflightRun');states.push({stage:'first_revision',state:s});assert.equal(s.audit.patches.length,1,JSON.stringify(s));assert.equal(s.consumption.receipts[0].attemptId,old.attemptId);assert.equal(s.consumption.receipts[0].baseArtifactId,'generic-original');assert.equal(s.audit.writes,0);assert.deepEqual(s.preflight.oldRequests,[old.request]);
 cacheStages(s,['during_health','after_health','after_prepare','before_claim']);
 assert.equal(s.preflight.grant.status,'terminal');assert.equal(s.preflight.grant.claim.health.checkId,s.audit.cacheRefreshes[1].checkId);
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');assert.equal(s.audit.patches.length,1);states.push({stage:'cold_revision',state:s});
 for(let i=0;i<8&&s.jobStatus!=='review';i++)s=await f.engine.dispatch('controlledPreflightRun');
 assert.equal(s.jobStatus,'review',JSON.stringify(s));assert.equal(s.audit.patches.length,2);assert.deepEqual(s.audit.checks,['content','result','goal']);assert.equal(s.audit.writes,1);assert.equal(s.accepted,false);assert.equal(s.budget.limitUSD,200);assert.ok(s.budget.spentUSD>=budget.spentUSD);assert.ok(Math.abs(s.budget.heldUSD-budget.heldUSD)<1e-9);assert.deepEqual(s.preflight.oldRequests,[old.request]);assert.equal(s.oldCycles,s.originalCycles);assert.equal(s.deliveries[0].result.verified,true);assert.equal(s.deliveries[0].result.url,require('../scripts/generic-consumption-worker-fixture.cjs').url);states.push({stage:'verified_delivery',state:s});
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');assert.equal(s.audit.writes,1);assert.equal(s.jobStatus,'review');assert.deepEqual(s.preflight.oldRequests,[old.request]);
 cacheStages(s,['during_health','after_health','after_prepare','before_claim']);
 if(process.env.SYSTEM_RELEASE_OUTPUT)fs.writeFileSync(path.join(process.env.SYSTEM_RELEASE_OUTPUT,'model-preflight-worker-'+mode+'.json'),JSON.stringify({mode,layer:'controlled',productionDelivery:'not_verified',userAccepted:false,passed:true,states},null,2)+'\n',{flag:'wx'});
});

test('formal Worker upgrades historical prepared through UI and cold restart before same-grant claim and same-target delivery',async t=>{
 const f=await setup(t,'legacy','prepared-upgrade'),states=[];
 const packaged=require('../scripts/model-preflight-package-worker.cjs');
 let s=await f.engine.dispatch('controlledPreflightRun');states.push({stage:'failed',state:s});const seed=structuredClone(s.preflight.seed);
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');const v=s.preflight.view;
 await f.engine.dispatch('uiCommand',{action:'agentModelPreflightAttest',input:{id:s.ids.job,taskId:s.ids.task,attemptId:v.attemptId,evidenceHash:v.evidenceHash,registryId:v.registry.id,executedBy:'supervisor',authorizationNote:'按已有授权验证同一原稿历史恢复',expectedWorkRevision:v.expectedWorkRevision,expectedTaskRevision:v.expectedTaskRevision}});
 s=await f.engine.dispatch('controlledPreflightPrepareLegacy');states.push({stage:'legacy_prepared',state:s});
 packaged.assertLegacyPrepared({generic:s});
 const old=structuredClone(s.preflight.grant),budget=structuredClone(s.budget),rawBudget=s.preflight.rawBudgetHash;
 const oldEfficiency=structuredClone(s.preflight.workEfficiency);assert.equal(oldEfficiency.phase,'recovery_pending');assert.equal(oldEfficiency.lastFailure.code,'EVIDENCE_GENERATION_UNRESOLVED');
 const oldContinuation=structuredClone(s.preflight.continuation);assert.equal(oldContinuation.activeTaskId,null);assert.equal(oldContinuation.activeBasis,oldContinuation.episode.basis);assert.equal(oldContinuation.episode.suspendedBy.code,'EVIDENCE_GENERATION_UNRESOLVED');
 assert.equal(old.status,'prepared');assert.equal(old.health.identityPolicyVersion,undefined);assert.equal(s.preflight.health.identityPolicyVersion,undefined);assert.equal(s.preflight.healthUpgradeEvents.length,0);assert.equal(s.audit.patches.length,0);assert.equal(s.preflight.rawBudgetHash,s.audit.preparedHealthUpgrade.before.budget);
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');assert.deepEqual(s.preflight.grant,old);states.push({stage:'cold_prepared',state:s});
 await f.engine.dispatch('uiCommand',{action:'subscriptionStatus',input:{}});s=await f.engine.dispatch('controlledPreflightObserve');states.push({stage:'upgrade_health',state:s});
 packaged.assertUpgradeHealth({generic:s});
 assert.equal(s.preflight.health.identityPolicyVersion,2);assert.notEqual(s.preflight.health.configurationHash,old.health.configurationHash);assert.equal(s.preflight.health.cliHash,old.health.cliHash);assert.equal(s.preflight.health.intentHash,old.health.intentHash);assert.deepEqual(s.preflight.grant,old);
 const u=s.preflight.view;assert.ok(u.healthUpgrade);
 await f.engine.dispatch('uiCommand',{action:'agentModelPreflightHealthUpgrade',input:{id:s.ids.job,taskId:u.taskId,attemptId:u.attemptId,...u.healthUpgrade,executedBy:'supervisor',authorizationNote:'按本人既有授权使用当前模型接续同一原稿；保留原未知费用及200美元累计上限。'}});
 s=await f.engine.dispatch('controlledPreflightObserve');states.push({stage:'health_upgraded',state:s});const upgraded=structuredClone(s.preflight.healthUpgrade),events=structuredClone(s.preflight.healthUpgradeEvents);
 packaged.assertUpgraded({generic:s});
 assert.equal(events.length,1);assert.equal(upgraded.grantId,old.id);assert.deepEqual(s.preflight.grant,old);assert.deepEqual(s.budget,budget);assert.equal(s.preflight.rawBudgetHash,rawBudget);assert.deepEqual(s.preflight.oldRequests,[seed.request]);assert.equal(s.audit.patches.length,0);
 cacheStages(s,['during_health','after_health','after_upgrade']);
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');states.push({stage:'cold_upgraded',state:s});assert.deepEqual(s.preflight.grant,old);assert.deepEqual(s.preflight.healthUpgrade,upgraded);assert.deepEqual(s.preflight.healthUpgradeEvents,events);assert.equal(s.preflight.rawBudgetHash,rawBudget);
 packaged.assertUpgraded({generic:s});
 assert.deepEqual(s.preflight.workEfficiency,oldEfficiency);
 assert.deepEqual(s.preflight.continuation,oldContinuation);
 s=await f.engine.dispatch('controlledPreflightRun');states.push({stage:'first_revision',state:s});
 assert.equal(s.audit.patches.length,1,JSON.stringify({jobStatus:s.jobStatus,error:s.error,runs:s.runs,efficiency:s.preflight.workEfficiency,cacheStages:s.audit.cacheRefreshes.map(v=>v.stage)}));
 const g=s.preflight.grant;assert.equal(g.id,old.id);assert.deepEqual(g.health,old.health);assert.deepEqual(g.proof,old.proof);assert.equal(g.status,'terminal');assert.equal(g.claim.healthUpgradeId,upgraded.id);assert.equal(g.claim.health.identityPolicyVersion,2);assert.deepEqual(g.claim.health,upgraded.health);assert.equal(s.consumption.receipts[0].attemptId,seed.attemptId);assert.equal(s.audit.patches.length,1);assert.equal(s.audit.writes,0);cacheStages(s,['during_health','after_health','after_upgrade','before_claim']);
 packaged.assertOwnerSelected({generic:s});
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');assert.equal(s.preflight.grant.id,old.id);
 packaged.assertOwnerSelected({generic:s});
 for(let i=0;i<8&&s.jobStatus!=='review';i++)s=await f.engine.dispatch('controlledPreflightRun');states.push({stage:'verified_delivery',state:s});
 assert.equal(s.jobStatus,'review');assert.deepEqual(s.audit.checks,['content','result','goal']);assert.equal(s.audit.patches.length,2);assert.equal(s.audit.writes,1);assert.equal(s.budget.limitUSD,200);assert.ok(Math.abs(s.budget.heldUSD-budget.heldUSD)<1e-9);assert.equal(s.deliveries[0].result.verified,true);assert.equal(s.deliveries[0].result.url,require('../scripts/generic-consumption-worker-fixture.cjs').url);assert.equal(s.accepted,false);assert.deepEqual(s.preflight.oldRequests,[seed.request]);assert.deepEqual(s.preflight.healthUpgradeEvents,events);
 const p=s.consumption.attempts[seed.attemptId];assert.equal(p.requests.length,2);assert.equal(p.modelPreflightRecovery.id,old.id);assert.deepEqual(p.modelPreflightRecovery.health,old.health);
 packaged.assertOwnerSelected({generic:s});
 await f.restart();s=await f.engine.dispatch('controlledPreflightObserve');states.push({stage:'cold_delivery',state:s});assert.equal(s.audit.writes,1);assert.deepEqual(s.preflight.healthUpgradeEvents,events);cacheStages(s,['during_health','after_health','after_upgrade','before_claim']);
 packaged.assertOwnerSelected({generic:s});
 if(process.env.SYSTEM_RELEASE_OUTPUT)fs.writeFileSync(path.join(process.env.SYSTEM_RELEASE_OUTPUT,'model-preflight-worker-prepared-upgrade.json'),JSON.stringify({layer:'controlled',passed:true,productionDelivery:'not_verified',states},null,2)+'\n',{flag:'wx'});
});
