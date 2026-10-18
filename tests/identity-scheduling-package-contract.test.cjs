'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const h=require('../scripts/identity-scheduling-package-worker.cjs');
const clone=structuredClone;
function state(scenario='permanent'){return {scenario,jobId:'j',taskId:'t',threadId:1,clock:100000,audit:{identity:0,business:0,models:0,forbidden:[]},executions:0,budget:{limitUSD:200,spentUSD:17,heldUSD:0,unknownAcknowledged:0,pending:{},approvals:[]},episode:{cycles:1,hops:1},identityKey:'key',identityRecords:[],attempts:[],runCount:0,stepCount:0,attemptCount:0,runs:[],jobStatus:'ready',policy:{eligible:true,phase:'ready'},nextRunAt:null};}
function after(seed,n){
 const s=clone(seed),transient=s.scenario==='transient';s.runCount=s.stepCount=s.attemptCount=s.audit.identity=n;
 for(let i=0;i<n;i++){
  const at=100000+[0,15001,75002][i],time=new Date(at).toISOString(),runId='run'+i,stepId='step'+i,requestId='req'+i,code=transient?'TRANSIENT':'REPLAY_FORBIDDEN_NETWORKATTEMPTS',query={op:'table_lineage',table:'leaf'};
  const decision={action:transient&&i<2?'wait_until':'diagnose',reason:transient?(i<2?'TRANSIENT_BACKOFF':'TRANSIENT_EXHAUSTED'):'INVALID_PLATFORM_RESPONSE',...(transient&&i<2?{retryAt:new Date(at+[15000,60000][i]).toISOString()}: {})};
  const request={requestId,runId,stepId,dispatchId:stepId,query:{op:'identity'}},record={id:'id'+i,status:'failed',contextVersion:2,context:{jobId:'j',authorityKind:'bound',policyId:'p',grantRevision:1},key:'key',failure:{stage:'transport',code,message:'failure'},error:'failure',errorCode:transient?'TRANSIENT':'INVALID_PLATFORM_RESPONSE',dispatchedAt:time,finishedAt:time,requestId,runId,stepId,dispatchId:stepId,request};
  const step={id:stepId,tool:'platform_query',errorCode:code,args:{taskId:'t',queries:[query]},evidenceAcquisition:{taskId:'t',targets:[{query}]},requests:[request],identityPreflight:{origin:'platform_identity',key:'key',recordId:record.id,requestId,decision}};
  s.identityRecords.push(record);s.runs.unshift({id:runId,status:transient&&i<2?'retry':'blocked',steps:[step]});s.attempts.push({attemptId:'attempt'+i,runId,stepId,dispatchId:stepId,query});
  s.clock=at;s.identityDecision=decision;s.jobStatus=transient&&i<2?'retry':'blocked';s.policy={eligible:false,phase:s.jobStatus,reasonCode:decision.reason,resumeAt:decision.retryAt||null};s.nextRunAt=s.policy.resumeAt;
 }
 return s;
}
function sample(scenario='permanent'){
 const seed=state(scenario);if(scenario==='unknown'){seed.identityRecords=[{id:'unknown',status:'dispatched',requestId:'old'}];seed.identityDecision={action:'reconcile',reason:'IDENTITY_RESULT_UNKNOWN'};seed.policy={eligible:false,phase:'blocked',reasonCode:'IDENTITY_RESULT_UNKNOWN',resumeAt:null};}
 const values=scenario==='transient'?[seed,after(seed,1),after(seed,1),after(seed,2),after(seed,2),after(seed,3),after(seed,3),after(seed,3)]:scenario==='unknown'?Array.from({length:5},()=>clone(seed)):[seed,...Array.from({length:4},()=>after(seed,1))];
 return {scenario,phase:0,pid:1,observations:h.stagesFor({scenario,phase:0}).map((stage,i)=>({stage,state:values[i]}))};
}
function coldOf(prior){return {scenario:prior.scenario,phase:1,pid:2,observations:h.stagesFor({scenario:prior.scenario,phase:1}).map(stage=>({stage,state:clone(prior.observations.at(-1).state)}))};}
test('identity package contract rejects continuing runs, duplicate calls and changed budget despite blocked labels',()=>{
 const good=sample();h.assertScenario(good);
 for(const change of [s=>s.audit.identity++,s=>s.audit.business++,s=>s.audit.models++,s=>s.runCount++,s=>s.stepCount++,s=>s.attemptCount++,s=>s.executions=1,s=>s.runs[0].status='done',s=>s.budget.spentUSD++,s=>s.budget.pending.new={holdUSD:1},s=>s.episode.cycles=0,s=>s.nextRunAt='future',s=>s.policy.resumeAt='future',s=>s.policy.eligible=true,s=>s.identityDecision.action='execute',s=>s.audit.forbidden.push('network')]){
  const bad=clone(good);change(bad.observations.at(-1).state);assert.throws(()=>h.assertScenario(bad));
 }
});
test('identity package cold phase must retain exact histories and show no further execution',()=>{
 const prior=sample(),cold=coldOf(prior);h.assertScenario(cold,prior);
 for(const change of [r=>r.pid=1,r=>r.observations[0].state.identityRecords=[],r=>r.observations.at(-1).state.runCount++,r=>r.observations[0].state.budget.spentUSD=0]){const bad=clone(cold);change(bad);assert.throws(()=>h.assertScenario(bad,prior));}
});
test('identity package actual module proof rejects source fallback, hashes and missing executed modules',()=>{
 const asar='/tmp/final.app/Contents/Resources/app.asar',config={asar,desktopInputs:h.REQUIRED.map(n=>({path:'desktop/'+n,sha256:'a'.repeat(64)}))};
 const p={pid:1,threadId:1,entry:asar+'/desktop/engine-worker.cjs',modules:h.REQUIRED.map(n=>({file:asar+'/desktop/'+n,sha256:'a'.repeat(64)}))};h.assertModuleProof(p,config);
 for(const change of [r=>r.threadId=0,r=>r.threadId=0.5,r=>r.pid=-42,r=>r.entry='/source/desktop/engine-worker.cjs',r=>r.modules.pop(),r=>r.modules[0].file='/source/desktop/core.cjs',r=>r.modules[0].sha256='b'.repeat(64)]){const bad=clone(p);change(bad);assert.throws(()=>h.assertModuleProof(bad,config));}
});
test('identity package fixture adaptation redirects only imports and rejects undeclared dependencies',()=>{
 const desktop='/tmp/final.app/Contents/Resources/app.asar/desktop',helpers={common:'/tmp/common.cjs',platform:'/tmp/platform.cjs',physical:'/tmp/physical.cjs'};
 for(const file of ['scripts/identity-scheduling-worker-fixture.cjs','scripts/generic-consumption-worker-fixture.cjs','tests/helpers/platform-fixture.cjs','tests/root-relation-physical-fixture.cjs']){
  const source=fs.readFileSync(path.resolve(__dirname,'..',file),'utf8'),adapted=h.adapt(source,desktop,helpers);new vm.Script(adapted);assert.doesNotMatch(adapted,/require\(['"]\./);
  assert.throws(()=>h.adapt(source+"\nrequire('../unknown-runtime.cjs')",desktop,helpers),/unreviewed/);
 }
});
test('identity package accepts retry retry blocked and rejects false success, early stop or a fourth attempt',()=>{
 const good=sample('transient');h.assertScenario(good);h.assertScenario(coldOf(good),good);
 for(const change of [s=>s.runs.at(-1).status='done',s=>s.runs.at(-1).status='blocked',s=>s.runs[0].status='retry',s=>s.identityRecords[0].requestId='new',s=>s.runs[0].steps[0].errorCode='unrelated',s=>s.audit.identity=4]){const bad=clone(good);change(bad.observations.at(-1).state);assert.throws(()=>h.assertScenario(bad));}
 const bad=clone(good);bad.observations[2].state.attemptCount++;assert.throws(()=>h.assertScenario(bad));
});
test('identity package unknown rejects even first-tick internal attempts without external requests',()=>{
 const good=sample('unknown');h.assertScenario(good);h.assertScenario(coldOf(good),good);
 const bad=clone(good);for(const row of bad.observations.slice(1))row.state.attemptCount=999;assert.throws(()=>h.assertScenario(bad));
 const corrupt=clone(good);corrupt.observations[1].state.identityRecords[0].status='done';assert.throws(()=>h.assertScenario(corrupt));
});
test('identity package phase binds actual child PID, main load, Worker, version and complete scenario captures',()=>{
 const asar='/tmp/final.app/Contents/Resources/app.asar',config={asar,scenario:'permanent',phase:0,expectedVersion:'0.42.2',desktopInputs:['engine-client.cjs',...h.REQUIRED].map(n=>({path:'desktop/'+n,sha256:'a'.repeat(64)}))};
 const proof=main=>({pid:1,threadId:main?0:1,entry:main?null:asar+'/desktop/engine-worker.cjs',modules:(main?['engine-client.cjs']:h.REQUIRED).map(n=>({file:asar+'/desktop/'+n,sha256:'a'.repeat(64)}))});
 const good=sample();Object.assign(good,{status:'passed',closed:true,versions:{electron:'controlled'},packageVersion:'0.42.2',backgroundErrors:[],mainModules:proof(true)});for(const row of good.observations)row.modules=proof(false);
 const exit={code:0,pid:1};h.assertPhase(good,exit,config);
 for(const change of [r=>r.pid=9,r=>r.phase=1,r=>r.scenario='unknown',r=>r.observations.pop(),r=>r.observations[1].modules.pid=9,r=>r.observations[1].state.threadId=2,r=>r.observations[1].modules.threadId=0,r=>r.mainModules.modules=[],r=>r.packageVersion='0.42.1',r=>r.closed=false,r=>r.versions={}]){const bad=clone(good);change(bad);assert.throws(()=>h.assertPhase(bad,exit,config));}
 for(const e of [{code:1,pid:1},{code:0,pid:2},{code:0,pid:1,timedOut:true},{code:0,pid:1,signal:'SIGKILL'}])assert.throws(()=>h.assertPhase(good,e,config));
});
test('identity package local recovery binds the original response and cold-restored source without claiming later silence',()=>{
 const seed=state('local_recovery');seed.identityDecision={action:'reconcile'};seed.policy.action={tool:'recover_platform_result'};
 const initial={kind:'local_recovery',operationId:'original-op',attemptId:'original-attempt',logicalKey:'logical',requests:[{requestId:'old'}],responseHash:'a'.repeat(64)};
 seed.recovery={initial,oldRunHash:'original-run-hash',claims:[],associations:[],operation:{id:'original-op',status:'failed'}};
 const last=clone(seed);Object.assign(last,{runCount:1,stepCount:2,runs:[{id:'local-run',status:'done',steps:[{tool:'recover_platform_result'},{tool:'plan_task'}]}]});
 Object.assign(last.recovery,{operation:{id:initial.operationId,attemptId:initial.attemptId,logicalKey:initial.logicalKey,requests:clone(initial.requests),status:'done',sourceId:'restored-source'},source:{id:'restored-source',associated:true,readAllowed:true,restoredHash:'a'.repeat(64)},associations:[{id:'one-association'}]});
 const good={scenario:'local_recovery',phase:0,pid:1,observations:[{stage:'initial',state:seed},{stage:'tick_0',state:last}]};h.assertScenario(good);h.assertScenario(coldOf(good),good);
 for(const change of [s=>s.recovery.operation.id='new-op',s=>s.recovery.operation.requests=[],s=>s.recovery.source.id='other',s=>s.recovery.source.restoredHash='changed',s=>s.recovery.associations.push({id:'duplicate'}),s=>s.recovery.oldRunHash='rewritten',s=>s.recovery.claims.push({id:'new'})]){const bad=clone(good);change(bad.observations.at(-1).state);assert.throws(()=>h.assertScenario(bad));}
 const rawCold=coldOf(good);rawCold.observations[0].state.recovery.operation.optional=undefined;h.assertScenario(rawCold,JSON.parse(JSON.stringify(good)));
 const cold=coldOf(good);cold.observations[0].state.recovery.source.id='changed-after-restart';assert.throws(()=>h.assertScenario(cold,good));
});
