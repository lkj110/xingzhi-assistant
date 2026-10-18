'use strict';
// Controlled final-package identity scheduling proof. No production main/UI.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const h=require('./system-package-worker.cjs');
const SOURCE=path.resolve(__dirname,'..'),VERSION='identity-scheduling-package-worker/1';
const SCENARIOS=['permanent','unknown','transient','local_recovery'];
const REQUIRED=['engine-worker.cjs','core.cjs','agent.cjs','evidence-identity-preflight.cjs','evidence-recovery.cjs','execution-policy.cjs','operation-ledger.cjs','access-policy-store.cjs'];
const FIXTURES=['scripts/identity-scheduling-worker-fixture.cjs','scripts/generic-consumption-worker-fixture.cjs','tests/helpers/platform-fixture.cjs','tests/root-relation-physical-fixture.cjs'];
const ADDITIONAL_MODULES=Object.freeze(['package.json',...['index.js','conventions.js','errors.js','dom.js','grammar.js','dom-parser.js','entities.js','sax.js'].map(name=>'node_modules/@xmldom/xmldom/lib/'+name)]);
const inside=(root,file)=>file===root||file.startsWith(root+path.sep),read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{mode:0o600});
function additionalModuleInputs(source){
 const metadata=read(path.join(source,'package.json'));
 for(const field of ['private','scripts','devDependencies'])delete metadata[field];
 return ADDITIONAL_MODULES.map(file=>({path:file,sha256:file==='package.json'?require('node:crypto').createHash('sha256').update(JSON.stringify(metadata,null,2)+'\n').digest('hex'):h.fileHash(path.join(source,file))}));
}
function parseArgs(args){const out={};for(let i=0;i<args.length;i+=2){assert.ok(['--app','--output'].includes(args[i]));const k=args[i].slice(2);assert.ok(!Object.hasOwn(out,k)&&path.isAbsolute(args[i+1]||''));out[k]=args[i+1];}assert.ok(out.app?.endsWith('.app')&&out.output?.endsWith('.json'));return out;}
function adapt(text,desktop,helpers){return h.redirectRequires(text.replace(/require\((['"])\.\/generic-consumption-worker-fixture\.cjs\1\)/g,()=> 'require('+JSON.stringify(helpers.common)+')'),desktop,helpers.platform,helpers.physical);}
function binary(app){const dir=path.join(app,'Contents/MacOS'),files=fs.readdirSync(dir).filter(n=>fs.statSync(path.join(dir,n)).isFile());assert.equal(files.length,1);const file=fs.realpathSync(path.join(dir,files[0])),framework=fs.realpathSync(path.join(app,'Contents/Frameworks/Electron Framework.framework/Electron Framework'));assert.ok(inside(app,file)&&inside(app,framework));return {file,framework,fileSHA256:h.fileHash(file),frameworkSHA256:h.fileHash(framework),fuses:h.readNodeFuses(framework)};}
function moduleProof(config){
 const wt=require('node:worker_threads');if(!wt.isMainThread){assert.ok(wt.threadId>0);assert.equal(wt.workerData.entry,path.join(config.asar,'desktop/engine-worker.cjs'));assert.equal(wt.workerData.dir,config.workspace);}
 const files=Object.keys(require.cache);for(const file of files){assert.ok(inside(config.asar,file)||config.generated.some(r=>r.file===file),'unreviewed runtime import '+file);assert.notEqual(file,path.join(config.asar,'desktop/main.cjs'));}
 return {pid:process.pid,threadId:wt.threadId,entry:wt.workerData?.entry||null,modules:files.filter(f=>inside(config.asar,f)).map(file=>({file,sha256:h.fileHash(file)}))};
}
async function createFixture(input,config){
 const f=await require(config.fixture).setup({...input,reportFile:config.audit,scenario:config.scenario,restoreAudit:config.phase>0});
 require('node:worker_threads').parentPort.on('message',msg=>{if(msg.type!=='identityPackageProbe')return;try{f.saveAudit();require('node:worker_threads').parentPort.postMessage({type:'identityPackageProof',id:msg.id,result:{state:f.observe(),modules:moduleProof(config)}});}catch(e){require('node:worker_threads').parentPort.postMessage({type:'identityPackageProof',id:msg.id,error:e.stack});}});
 return f.a;
}
function assertModuleProof(proof,config,{pid=proof?.pid,threadId=proof?.threadId,main=false}={}){
 const additional=config.additionalInputs||[];
 if(config.additionalInputs!==undefined){assert.ok(Array.isArray(additional));assert.deepEqual(additional.map(row=>row.path).sort(),[...ADDITIONAL_MODULES].sort());for(const row of additional)assert.match(row.sha256,/^[a-f0-9]{64}$/);}
 assert.ok(Number.isInteger(proof?.pid)&&proof.pid>0);assert.equal(proof.pid,pid);assert.ok(Number.isInteger(proof.threadId));assert.equal(proof.threadId,threadId);assert.equal(proof.entry,main?null:path.join(config.asar,'desktop/engine-worker.cjs'));assert.ok(main?proof.threadId===0:proof.threadId>0);
 for(const name of (main?['engine-client.cjs']:REQUIRED)){const file=path.join(config.asar,'desktop',name),row=proof.modules.find(r=>r.file===file),expected=config.desktopInputs.find(r=>r.path==='desktop/'+name);assert.ok(row&&expected,'missing executed module '+name);assert.equal(row.sha256,expected.sha256);}
 for(const row of proof.modules){assert.ok(inside(config.asar,row.file));assert.notEqual(row.file,path.join(config.asar,'desktop/main.cjs'));const relative=path.relative(config.asar,row.file),expected=[...config.desktopInputs,...additional].find(input=>input.path===relative);assert.ok(expected,'unbound executed module '+relative);assert.equal(row.sha256,expected.sha256);}
}
const advancesFor=c=>c.scenario==='local_recovery'?(c.phase?[]:[0]):c.phase?[0,60001,60001]:c.scenario==='transient'?[0,0,15001,0,60001,60001]:[0,60001,60001];
const stagesFor=c=>[c.phase?'cold_initial':'initial',...advancesFor(c).map(n=>'tick_'+n),...(c.scenario==='local_recovery'?[]:['manual_request'])];
function assertPhase(result,execution,config){
 assert.ok(result);assert.equal(execution.code,0);assert.ok(!execution.timedOut&&!execution.signal&&!execution.error);assert.ok(Number.isInteger(execution.pid)&&execution.pid>0);assert.equal(result.pid,execution.pid);assert.equal(result.scenario,config.scenario);assert.equal(result.phase,config.phase);assert.equal(result.status,'passed');assert.equal(result.closed,true);assert.ok(result.versions?.electron);assert.match(config.expectedVersion||'',/^\d+\.\d+\.\d+$/);assert.equal(result.packageVersion,config.expectedVersion);assert.deepEqual(result.backgroundErrors,[]);assert.deepEqual(result.observations.map(r=>r.stage),stagesFor(config));assertModuleProof(result.mainModules,config,{pid:execution.pid,threadId:0,main:true});
 const thread=result.observations[0]?.state.threadId;assert.ok(Number.isInteger(thread)&&thread>0);for(const row of result.observations){assert.equal(row.state.threadId,thread);assertModuleProof(row.modules,config,{pid:execution.pid,threadId:thread});}
}
const counts=s=>[s.runCount,s.stepCount,s.attemptCount,s.audit.identity,s.audit.business,s.audit.models];
function assertBudget(budget){
 assert.ok(budget&&typeof budget==='object');assert.equal(budget.limitUSD,200);
 for(const k of ['spentUSD','heldUSD','unknownAcknowledged'])assert.ok(Number.isFinite(budget[k])&&budget[k]>=0,'required ledger '+k);
 assert.ok(Array.isArray(budget.approvals));assert.ok(budget.pending&&typeof budget.pending==='object'&&!Array.isArray(budget.pending));
}
function assertIdentityFailures(state,seed,scenario){
 const records=state.identityRecords.filter(r=>!seed.identityRecords.some(old=>old.id===r.id)),runs=state.runs.filter(r=>!seed.runs.some(old=>old.id===r.id));
 assert.equal(records.length,state.audit.identity-seed.audit.identity);assert.equal(runs.length,records.length);
 assert.equal(state.runCount-seed.runCount,runs.length);assert.equal(state.stepCount-seed.stepCount,records.length);
 assert.equal(state.attemptCount,state.attempts.length);assert.equal(seed.attemptCount,seed.attempts.length);
 const attempts=state.attempts.filter(r=>!seed.attempts.some(old=>old.runId===r.runId&&old.dispatchId===r.dispatchId&&old.attemptId===r.attemptId));
 let expectedAttempts=0;const requestIds=[];
 for(const [i,r]of records.entries()){
  assert.equal(r.status,'failed');assert.equal(r.contextVersion,2);assert.equal(r.context.jobId,state.jobId);assert.equal(r.context.authorityKind,'bound');assert.ok(r.context.policyId&&Number.isInteger(r.context.grantRevision)&&r.context.grantRevision>0);assert.equal(r.key,seed.identityKey);
  if(i)assert.deepEqual(r.context,records[0].context);
  assert.equal(r.failure.stage,'transport');assert.equal(r.errorCode,scenario==='transient'?'TRANSIENT':'INVALID_PLATFORM_RESPONSE');assert.equal(r.failure.code,scenario==='transient'?'TRANSIENT':'REPLAY_FORBIDDEN_NETWORKATTEMPTS');assert.ok(r.error&&r.failure.message);
  assert.ok(Number.isFinite(Date.parse(r.dispatchedAt))&&Number.isFinite(Date.parse(r.finishedAt))&&Date.parse(r.finishedAt)>=Date.parse(r.dispatchedAt));requestIds.push(r.requestId);
  const run=runs.find(x=>x.id===r.runId);assert.ok(run);assert.equal(run.status,scenario==='transient'&&i<2?'retry':'blocked');assert.equal(run.steps.length,1);
  const step=run.steps[0];assert.equal(step.id,r.stepId);assert.equal(step.tool,'platform_query');assert.equal(step.errorCode,r.failure.code);assert.equal(step.requests.length,1);assert.deepEqual(step.requests[0],r.request);assert.equal(r.request.query.op,'identity');assert.equal(r.request.requestId,r.requestId);assert.equal(r.request.runId,run.id);assert.equal(r.request.stepId,step.id);assert.equal(r.request.dispatchId,r.dispatchId);
  assert.equal(step.identityPreflight.origin,'platform_identity');assert.equal(step.identityPreflight.recordId,r.id);assert.equal(step.identityPreflight.requestId,r.requestId);assert.equal(step.identityPreflight.key,r.key);
  assert.equal(step.args.taskId,state.taskId);assert.ok(step.args.queries.length);assert.equal(step.evidenceAcquisition.taskId,state.taskId);
  const claimed=attempts.filter(x=>x.runId===run.id&&x.stepId===step.id&&x.dispatchId===r.dispatchId);assert.equal(claimed.length,step.args.queries.length);expectedAttempts+=step.args.queries.length;
  for(const query of step.args.queries){assert.ok(step.evidenceAcquisition.targets.some(t=>JSON.stringify(t.query)===JSON.stringify(query)));assert.equal(claimed.filter(x=>JSON.stringify(x.query)===JSON.stringify(query)).length,1);}
  const decision=step.identityPreflight.decision;assert.equal(decision.action,scenario==='transient'&&i<2?'wait_until':'diagnose');assert.equal(decision.reason,scenario==='transient'?(i<2?'TRANSIENT_BACKOFF':'TRANSIENT_EXHAUSTED'):'INVALID_PLATFORM_RESPONSE');
 }
 assert.equal(new Set(requestIds).size,records.length);assert.equal(attempts.length,expectedAttempts);assert.equal(state.attemptCount-seed.attemptCount,expectedAttempts);
 if(records.length){const expectedReason=scenario==='transient'?(records.length<3?'TRANSIENT_BACKOFF':'TRANSIENT_EXHAUSTED'):'INVALID_PLATFORM_RESPONSE';assert.equal(state.policy.reasonCode,expectedReason);assert.equal(state.identityDecision.reason,expectedReason);assert.equal(state.jobStatus,scenario==='transient'&&records.length<3?'retry':'blocked');assert.equal(state.nextRunAt,state.policy.resumeAt);}
}
function assertScenario(report,previous){
 assert.ok(SCENARIOS.includes(report.scenario));assert.ok(report.phase===0||report.phase===1);
 const states=report.observations.map(r=>r.state),first=states[0],last=states.at(-1),seed=previous?.observations[0].state||first;assert.ok(first&&last);assert.deepEqual(report.observations.map(r=>r.stage),stagesFor(report));
 if(previous){const prior=previous.observations.at(-1).state;assert.notEqual(report.pid,previous.pid);assert.deepEqual(counts(first),counts(prior));assert.deepEqual(first.identityRecords,prior.identityRecords);assert.deepEqual(first.attempts,prior.attempts);assert.deepEqual(first.budget,prior.budget);assert.deepEqual(first.episode,prior.episode);}
 for(const state of states){assert.equal(state.scenario,report.scenario);assert.ok(Number.isInteger(state.threadId)&&state.threadId>0);assert.equal(state.audit.business,0);assert.equal(state.audit.models,0);assert.deepEqual(state.audit.forbidden,[]);assert.equal(state.executions,0);assertBudget(state.budget);assert.deepEqual(state.budget,first.budget);assert.ok(state.runs.every(r=>r.status!=='running'));assert.equal(state.runCount,state.runs.length);assert.equal(state.stepCount,state.runs.reduce((n,r)=>n+r.steps.length,0));}
 if(report.scenario==='local_recovery'){
  const origin=seed.recovery?.initial;assert.ok(origin);for(const k of ['operationId','attemptId','logicalKey'])assert.ok(typeof origin[k]==='string'&&origin[k]);assert.match(origin.responseHash||'',/^[a-f0-9]{64}$/);assert.ok(Array.isArray(origin.requests)&&origin.requests.length>0);for(const request of origin.requests)assert.ok(typeof request.requestId==='string'&&request.requestId);
  const original=seed.recovery.initial,recovered=last.recovery;assert.equal(original.kind,'local_recovery');assert.equal(last.audit.identity,0);assert.equal(recovered.operation.status,'done');assert.equal(recovered.operation.id,original.operationId);assert.equal(recovered.operation.attemptId,original.attemptId);assert.equal(recovered.operation.logicalKey,original.logicalKey);assert.deepEqual(recovered.operation.requests,original.requests);assert.equal(recovered.source.id,recovered.operation.sourceId);assert.equal(recovered.source.associated,true);assert.equal(recovered.source.readAllowed,true);assert.equal(recovered.source.restoredHash,original.responseHash);assert.deepEqual(recovered.initial,original);assert.equal(recovered.oldRunHash,seed.recovery.oldRunHash);assert.deepEqual(recovered.claims,seed.recovery.claims);assert.deepEqual(last.identityRecords,seed.identityRecords);assert.equal(last.episode.cycles,seed.episode.cycles);
  assert.equal(recovered.associations.length-seed.recovery.associations.length,1);
  if(!report.phase){assert.equal(first.identityDecision.action,'reconcile');assert.equal(first.policy.action.tool,'recover_platform_result');const added=last.runs.filter(r=>!first.runs.some(x=>x.id===r.id));assert.equal(added.flatMap(r=>r.steps).filter(s=>s.tool==='recover_platform_result').length,1);assert.equal(added.flatMap(r=>r.steps).filter(s=>s.tool==='plan_task').length,1);}
  // Persisted phase reports use JSON. Optional computed properties with value
  // undefined are absent on disk; required identities above remain exact.
  else assert.deepEqual(JSON.parse(JSON.stringify(last.recovery)),previous.observations.at(-1).state.recovery);
  // Local work remains valid after this endpoint. This scenario proves cold
  // restoration only, not silence of later legitimate consumption/model work.
  return;
 }
 const expectedCalls=report.scenario==='unknown'?0:report.scenario==='transient'?3:1;
 assert.equal(last.audit.identity,expectedCalls);assert.equal(last.policy.eligible,false);assert.equal(last.policy.phase,'blocked');assert.equal(last.policy.resumeAt,null);assert.equal(last.nextRunAt,null);
 assert.equal(last.identityDecision.action,report.scenario==='unknown'?'reconcile':'diagnose');
 for(const state of states){assert.deepEqual(state.episode,seed.episode);assert.deepEqual(state.identityRecords.slice(0,seed.identityRecords.length),seed.identityRecords);
  if(report.scenario==='unknown'){assert.deepEqual(counts(state),counts(seed));assert.deepEqual(state.attempts,seed.attempts);assert.deepEqual(state.identityRecords,seed.identityRecords);assert.equal(state.identityDecision.reason,'IDENTITY_RESULT_UNKNOWN');assert.equal(state.policy.reasonCode,'IDENTITY_RESULT_UNKNOWN');}
  else assertIdentityFailures(state,seed,report.scenario);
 }
 if(report.phase){for(const state of states)assert.deepEqual(counts(state),counts(first));}
 else if(report.scenario==='transient'){
  assert.equal(Date.parse(states[1].policy.resumeAt)-states[1].clock,15000);assert.deepEqual(counts(states[2]),counts(states[1]));assert.equal(states[3].audit.identity,2);assert.equal(Date.parse(states[3].policy.resumeAt)-states[3].clock,60000);assert.deepEqual(counts(states[4]),counts(states[3]));assert.equal(states[5].audit.identity,3);assert.deepEqual(counts(states[6]),counts(states[5]));assert.deepEqual(counts(states[7]),counts(states[6]));
 }else for(const state of states.slice(2))assert.deepEqual(counts(state),counts(states[1]));
}

async function child(config){
 h.installIsolation(config);const report={scenario:config.scenario,phase:config.phase,pid:process.pid,status:'failed',observations:[],backgroundErrors:[]};let engine;
 try{
  assert.ok(process.versions.electron,'selected Electron runtime required');report.versions={electron:process.versions.electron,node:process.versions.node};
  report.packageVersion=read(path.join(config.asar,'package.json')).version;assert.equal(report.packageVersion,config.expectedVersion,'selected package version');
  const packaged=h.tree(path.join(config.asar,'desktop'),rel=>/^native\/bin(?:\/|$)/.test(rel)).filter(r=>r.type==='file').map(r=>'desktop/'+r.path).sort();
  assert.deepEqual(packaged,config.desktopInputs.map(r=>r.path).sort());for(const r of [...config.desktopInputs,...config.additionalInputs])assert.equal(h.fileHash(path.join(config.asar,r.path)),r.sha256);
  const {EngineClient}=require(path.join(config.asar,'desktop/engine-client.cjs'));report.mainModules=moduleProof(config);
  engine=new EngineClient({dir:config.workspace,fixtureModule:config.wrapper,workerOptions:{execArgv:['--require',config.preload]},safeStorage:{isEncryptionAvailable:()=>false},native:async action=>{if(action==='attentionAvailable')return {supported:false};fs.appendFileSync(path.join(config.dir,'denied-native.jsonl'),JSON.stringify({name:'native UI: '+action})+'\n');throw Error('native UI forbidden');}});
  engine.on('backgroundError',e=>report.backgroundErrors.push(e));await engine.ready;let sequence=0;
  const probe=()=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{engine.worker.off('message',listener);reject(Error('identity package probe timeout'));},15000),listener=m=>{if(m.type!=='identityPackageProof'||m.id!==id)return;clearTimeout(timer);engine.worker.off('message',listener);m.error?reject(Error(m.error)):resolve(m.result);};engine.worker.on('message',listener);engine.worker.postMessage({type:'identityPackageProbe',id});});
  const capture=async stage=>{const p=await probe();assertModuleProof(p.modules,config,{pid:process.pid,threadId:p.state.threadId});report.observations.push({stage,...p});write(config.result,report);return p.state;};
  await capture(config.phase?'cold_initial':'initial');
  const advances=advancesFor(config);
  for(const advanceMs of advances){await engine.dispatch('controlledIdentityTick',{advanceMs});await capture('tick_'+advanceMs);}
  if(config.scenario!=='local_recovery'){await engine.dispatch('controlledIdentityRun');await capture('manual_request');}
  assertScenario(report,config.phase?read(config.previous):null);assert.deepEqual(report.backgroundErrors,[]);report.status='passed';
 }catch(e){report.error=e.stack||e.message;}finally{if(engine)try{await engine.close();report.closed=true;}catch(e){report.error=e.stack;report.status='failed';}write(config.result,report);}return report;
}
async function spawn(binaryFile,configFile,config){const out=fs.openSync(config.stdout,'wx'),err=fs.openSync(config.stderr,'wx');try{return await new Promise(resolve=>{const p=require('node:child_process').spawn(binaryFile,[config.harness,'--child',configFile],{cwd:config.dir,env:h.childEnvironment(config.dir,configFile),stdio:['ignore',out,err]});let timedOut=false,error;const timer=setTimeout(()=>{timedOut=true;p.kill('SIGKILL');},120000);p.on('error',e=>{error=e.message;});p.on('close',(code,signal)=>{clearTimeout(timer);resolve({pid:p.pid,code,signal,timedOut,error});});});}finally{fs.closeSync(out);fs.closeSync(err);}}
async function run(options){
 parseArgs(['--app',options.app,'--output',options.output]);const app=fs.realpathSync(options.app),source=fs.realpathSync(SOURCE),output=path.resolve(options.output);
 let ancestor=path.dirname(output);while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);const realOutput=path.join(fs.realpathSync(ancestor),path.relative(ancestor,output));
 assert.ok(!inside(app,realOutput)&&(!inside(source,realOutput)||inside(path.join(source,'artifacts'),realOutput)));assert.ok(!/\/(?:Library|\.codex|\.config|\.local-data)(?:\/|$)/.test(realOutput));assert.ok(!fs.existsSync(realOutput));fs.mkdirSync(path.dirname(realOutput),{recursive:true});
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'identity-package-'))),report={schema:VERSION,layer:'controlled',status:'failed',passed:false,productionDelivery:'not_verified',userAccepted:false,realBusinessCalls:0,realNetworkCalls:0,realModelCalls:0,evidence:dir,phases:[],limitations:['Controlled transport and clock; no production UI or business validation','Local recovery proves original retained response association and cold load only; later legitimate consumption is not asserted silent']};let beforeSource,beforePackage;
 try{
  beforeSource=report.source=h.sourceIdentity(source);beforePackage=report.package=h.packageIdentity(app);report.sourceDigest=beforeSource.digest;report.packageDigest=beforePackage.digest;report.runtime=binary(app);
  report.additionalInputs=additionalModuleInputs(source);
  const asar=path.join(app,'Contents/Resources/app.asar'),desktop=path.join(asar,'desktop'),harness=path.join(dir,path.basename(__filename)),helper=path.join(dir,'system-package-worker.cjs'),fixture=path.join(dir,'identity-scheduling-worker-fixture.cjs'),helpers={common:path.join(dir,'generic-consumption-worker-fixture.cjs'),platform:path.join(dir,'platform-fixture.cjs'),physical:path.join(dir,'physical-fixture.cjs')};
  fs.copyFileSync(__filename,harness);fs.copyFileSync(path.join(__dirname,'system-package-worker.cjs'),helper);
  for(const [i,file]of [fixture,helpers.common,helpers.platform,helpers.physical].entries())fs.writeFileSync(file,adapt(fs.readFileSync(path.join(source,FIXTURES[i]),'utf8'),desktop,helpers));
  const preload=path.join(dir,'guard.cjs'),wrapper=path.join(dir,'worker-fixture.cjs');
  fs.writeFileSync(preload,`const c=JSON.parse(require('node:fs').readFileSync(process.env.SYSTEM_PACKAGE_WORKER_CONFIG,'utf8'));require(${JSON.stringify(helper)}).installIsolation(c);globalThis.__identityPackageConfig=c;\n`);
  fs.writeFileSync(wrapper,`exports.create=input=>require(${JSON.stringify(harness)}).createFixture(input,globalThis.__identityPackageConfig);\n`);
  const generated=[harness,helper,fixture,...Object.values(helpers),preload,wrapper].map(file=>({file,sha256:h.fileHash(file)})),desktopInputs=beforeSource.entries.filter(r=>r.type==='file'&&r.path.startsWith('desktop/'));
  report.fixture={original:FIXTURES.map(file=>({file,sha256:h.fileHash(path.join(source,file))})),generated};
  for(const scenario of SCENARIOS){const modeDir=path.join(dir,scenario),workspace=path.join(modeDir,'workspace'),audit=path.join(modeDir,'audit.json');fs.mkdirSync(workspace,{recursive:true});for(let phase=0;phase<2;phase++){
   const config={dir,asar,harness,fixture,preload,wrapper,workspace,audit,scenario,phase,generated,desktopInputs,additionalInputs:report.additionalInputs,expectedVersion:read(path.join(source,'package.json')).version,result:path.join(modeDir,'phase-'+phase+'.json'),previous:phase?path.join(modeDir,'phase-0.json'):null,stdout:path.join(modeDir,'phase-'+phase+'.stdout'),stderr:path.join(modeDir,'phase-'+phase+'.stderr')},configFile=path.join(modeDir,'config-'+phase+'.json');write(configFile,config);
   assert.equal(h.fileHash(asar),beforePackage.asarSHA256);const execution=await spawn(report.runtime.file,configFile,config),result=fs.existsSync(config.result)?read(config.result):null;report.phases.push({scenario,phase,execution,result});write(realOutput,report);assertPhase(result,execution,config);assertScenario(result,phase?read(config.previous):null);
  }}
  assert.equal(new Set(report.phases.map(p=>p.execution.pid)).size,8);report.status='passed';report.passed=true;
 }catch(e){report.error=e.stack||e.message;}finally{
  try{report.blockedExternalAttempts=fs.readdirSync(dir).filter(n=>n.startsWith('denied-')).flatMap(n=>fs.readFileSync(path.join(dir,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));assert.deepEqual(report.blockedExternalAttempts,[]);for(const row of report.fixture?.generated||[])assert.equal(h.fileHash(row.file),row.sha256);if(beforeSource){report.afterSourceDigest=h.sourceIdentity(source).digest;assert.equal(report.afterSourceDigest,beforeSource.digest);}if(beforePackage){report.afterPackageDigest=h.packageIdentity(app).digest;assert.equal(report.afterPackageDigest,beforePackage.digest);}}catch(e){report.status='failed';report.passed=false;report.identityError=e.stack;}
  try{if(report.additionalInputs){report.afterAdditionalInputs=additionalModuleInputs(source);assert.deepEqual(report.afterAdditionalInputs,report.additionalInputs);}}catch(error){report.status='failed';report.passed=false;report.additionalInputError=error.stack;}
  write(path.join(dir,'summary.json'),report);report.evidenceFiles=h.tree(dir);write(realOutput,report);
 }return report;
}
module.exports={VERSION,SCENARIOS,REQUIRED,ADDITIONAL_MODULES,additionalModuleInputs,parseArgs,adapt,createFixture,assertModuleProof,assertPhase,stagesFor,assertScenario,run};
if(require.main===module)(async()=>{if(process.argv[2]==='--child'){const r=await child(read(process.argv[3]));process.exitCode=r.status==='passed'?0:1;}else{const o=parseArgs(process.argv.slice(2)),r=await run(o);console.log(JSON.stringify({status:r.status,output:o.output,evidence:r.evidence}));process.exitCode=r.passed?0:1;}})().catch(e=>{console.error(e);process.exitCode=1;});
