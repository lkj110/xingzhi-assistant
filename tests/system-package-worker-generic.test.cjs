'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const h=require('../scripts/system-package-worker.cjs'),root=path.resolve(__dirname,'..');
const matrix=require('../scripts/system-package-worker-matrix.cjs');
function temp(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'generic-package-contract-')));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function sample(complete=false){
 const first={artifactId:'draft-1',baseArtifactId:'generic-original'},last={artifactId:'draft-2',baseArtifactId:'draft-1'};
 return {jobId:'job',taskId:'task',autoAccept:false,acceptedAt:null,completedAt:null,paused:false,busy:false,
  jobStatus:complete?'review':'ready',taskStatus:complete?'review':'todo',primary:complete?'draft-2':'draft-1',runs:complete?2:1,modelCalls:complete?5:1,
  modules:{pid:100,threadId:1},generic:{threadId:1,accepted:false,oldCycles:1,originalCycles:1,budget:{limitUSD:200,spentUSD:17.01},
   primary:{id:complete?'draft-2':'draft-1',primaryLineageId:'generic-original',draftOnly:!complete,content:complete?'leaf→tail\ntail→无上游':'leaf→tail'},
   audit:{layer:'controlled future, NOT production',queries:complete?['leaf','tail']:['leaf'],patches:complete?[{attemptId:'1'},{attemptId:'2'}]:[{attemptId:'1'}],checks:complete?['content','result','goal']:[],writes:complete?1:0,creates:1,readbacks:complete?2:1,violations:[]},
   consumption:{receipts:complete?[first,last]:[first]},contentCheck:complete?{passed:true}:undefined,resultCheck:complete?{passed:true}:undefined,
   deliveries:complete?[{id:'same-action',status:'done',result:{url:'https://generic-fixture.feishu.cn/docx/GenericConsumptionFixture123',verified:true}}]:[]}};
}
test('generic package adaptation copies both reviewed helpers and redirects all runtime imports to the chosen ASAR',()=>{
 const desktop='/tmp/selected.app/Contents/Resources/app.asar/desktop',helper='/tmp/harness/platform.cjs',physical='/tmp/harness/physical.cjs';
 const original=fs.readFileSync(path.join(root,'scripts/generic-consumption-worker-fixture.cjs'),'utf8');
 const adapted=h.adaptFixture(original,desktop,helper,physical);new vm.Script(adapted);
 assert.equal(adapted,h.redirectRequires(original,desktop,helper,physical),'adaptation must not edit fixture behavior');
 assert.doesNotMatch(adapted,/require\(['"]\.\./);assert.ok(adapted.includes(JSON.stringify(physical)));
 assert.ok(adapted.includes(JSON.stringify(path.join(desktop,'evidence-consumption.cjs'))));
 assert.throws(()=>h.adaptFixture(original,desktop,helper),/unreviewed relative/);
 for(const file of ['tests/helpers/platform-fixture.cjs','tests/root-relation-physical-fixture.cjs']){
  const source=fs.readFileSync(path.join(root,file),'utf8'),copy=h.redirectRequires(source,desktop);new vm.Script(copy);
  assert.doesNotMatch(copy,/require\(['"]\.\./);
  assert.throws(()=>h.redirectRequires(source+"\nrequire('../production-settings.cjs')",desktop),/unreviewed/);
 }
 assert.deepEqual(h.GENERIC_SCENARIOS,{generic_success:'success',generic_uncertain:'uncertain',generic_mismatch:'mismatch',generic_preflight_recovery:'preflight_recovery',generic_v2_recovery:'v2_recovery',generic_local_recovery:'local_recovery'});
});
test('matrix requires twelve reports with exact release-plan names and a single source/package identity',()=>{
 const records=()=>h.SCENARIOS.map(scenario=>({scenario,file:'/tmp/evidence/package-worker-'+scenario+'.json',result:{scenario,status:'passed',passed:true,layer:'controlled',productionDelivery:'not_verified',userAccepted:false,source:{digest:'a'.repeat(64)},package:{digest:'b'.repeat(64)},afterSourceDigest:'a'.repeat(64),afterPackageDigest:'b'.repeat(64),realBusinessCalls:0,realNetworkCalls:0,realModelCalls:0,blockedExternalAttempts:[]}}));
 const result=matrix.summarize(records());assert.equal(result.reports.length,12);
 assert.deepEqual(result.reports.slice(-6).map(r=>path.basename(r.file)),['package-worker-generic_success.json','package-worker-generic_uncertain.json','package-worker-generic_mismatch.json','package-worker-generic_preflight_recovery.json','package-worker-generic_v2_recovery.json','package-worker-generic_local_recovery.json']);
 for(const change of [r=>r.pop(),r=>r[8]=r[7],r=>r[8].file='/tmp/evidence/package-worker-success.json',r=>r[8].result.scenario='success',r=>r[8].result.passed=false,
  r=>r[8].result.source.digest='c'.repeat(64),r=>r[8].result.package.digest='c'.repeat(64),r=>r[8].result.afterPackageDigest='c'.repeat(64),
  r=>r[8].result.realNetworkCalls=1,r=>r[8].result.blockedExternalAttempts=[{name:'fetch'}],r=>r[8].result.productionDelivery='verified']){
  const r=records();change(r);assert.throws(()=>matrix.summarize(r));
 }
});
test('generic partial-draft checkpoint refuses early checking, writing, acceptance or fabricated lineage',async t=>{
 h.assertGenericCheckpoint(sample());
 const changes=[s=>s.generic.audit.writes++,s=>s.generic.audit.checks.push('content'),s=>s.generic.primary.draftOnly=false,
  s=>s.generic.audit.queries.push('tail'),s=>s.generic.consumption.receipts[0].baseArtifactId='different',
  s=>s.primary='different',s=>s.generic.primary.primaryLineageId='different',s=>s.jobStatus='review',s=>s.taskStatus='review',
  s=>s.autoAccept=true,s=>s.acceptedAt='now',s=>s.generic.accepted=true,s=>s.generic.audit.creates++,
  s=>s.generic.oldCycles=0,s=>s.generic.budget.limitUSD=300,s=>s.generic.budget.spentUSD=0,s=>s.modelCalls=undefined,
  s=>s.generic.audit.violations.push('repeated call')];
 for(const [i,change]of changes.entries())await t.test('guard '+i,()=>{const s=sample();change(s);assert.throws(()=>h.assertGenericCheckpoint(s));});
});
test('generic completed delivery requires two batches, same original lineage, independent checks and verified remote URL',async t=>{
 h.assertGenericComplete(sample(true));
 const changes=[s=>s.generic.audit.queries.push('leaf'),s=>s.generic.audit.patches.pop(),s=>s.generic.audit.writes++,
  s=>s.generic.primary.draftOnly=true,s=>s.generic.primary.content='leaf→tail',s=>s.generic.contentCheck.passed=false,
  s=>s.generic.consumption.receipts[1].baseArtifactId='generic-original',s=>s.generic.consumption.receipts[1].artifactId='other',
  s=>s.generic.resultCheck.passed=false,s=>s.generic.audit.checks=['content'],s=>s.generic.deliveries.push(s.generic.deliveries[0]),
  s=>s.generic.deliveries[0].status='uncertain',s=>s.generic.deliveries[0].result.verified=false,s=>s.generic.deliveries[0].result.url='file:///tmp/draft.md'];
 for(const [i,change]of changes.entries())await t.test('guard '+i,()=>{const s=sample(true);change(s);assert.throws(()=>h.assertGenericComplete(s));});
});
test('generic mismatch remains non-review through the same write and cannot run a final goal check',()=>{
 const s=sample(true);s.jobStatus='blocked';s.taskStatus='todo';s.generic.audit.checks=['content','result'];s.generic.resultCheck.passed=false;
 h.assertGenericComplete(s,{mismatch:true});
 for(const change of [s=>s.jobStatus='review',s=>s.taskStatus='review',s=>s.generic.audit.checks.push('goal'),s=>s.generic.audit.writes++]){
  const bad=structuredClone(s);change(bad);assert.throws(()=>h.assertGenericComplete(bad,{mismatch:true}));
 }
});
test('generic distinct-process restore preserves actual draft, receipts, budget, requests and model count',async t=>{
 const before=sample(),cold=structuredClone(before);cold.modules.pid++;cold.modules.threadId=3;cold.generic.threadId=3;h.assertGenericRestored(before,cold);
 const changes=[s=>s.modules.pid=100,s=>s.runs++,s=>s.modelCalls++,s=>s.primary='other',s=>s.generic.primary.content='changed',
  s=>s.generic.consumption.receipts=[],s=>s.generic.audit.queries=[],s=>s.generic.audit.writes++,s=>s.generic.oldCycles=0,
  s=>s.generic.budget.spentUSD++,s=>s.generic.budget.heldUSD=1,s=>s.generic.deliveries.push({id:'new'}),s=>s.acceptedAt='now'];
 for(const [i,change]of changes.entries())await t.test('restore guard '+i,()=>{const s=structuredClone(cold);change(s);assert.throws(()=>h.assertGenericRestored(before,s));});
});
test('generic moduleProof rejects checkout fallback, missing actual load, wrong hash and non-Worker execution',async t=>{
 const asar='/tmp/final.app/Contents/Resources/app.asar',inputs=h.GENERIC_MODULES.map(name=>({path:'desktop/'+name,sha256:'a'.repeat(64)}));
 const phases=()=>[0,1].map(phase=>({result:{phase,pid:100+phase,status:'passed',final:{modules:{pid:100+phase,threadId:2,workerEntry:path.join(asar,'desktop/engine-worker.cjs'),modules:h.GENERIC_MODULES.map(name=>({file:path.join(asar,'desktop',name),sha256:'a'.repeat(64)}))}}}}));
 h.assertGenericModuleProof(phases(),asar,inputs);
 for(const phase of [0,1])for(const name of h.GENERIC_MODULES)await t.test('phase '+phase+' loaded '+name,()=>{
  const p=phases();p[phase].result.final.modules.modules=p[phase].result.final.modules.modules.filter(r=>!r.file.endsWith('/'+name));assert.throws(()=>h.assertGenericModuleProof(p,asar,inputs));
 });
 for(const change of [p=>p[1].result.final.modules.workerEntry='/tmp/checkout/desktop/engine-worker.cjs',p=>p[1].result.final.modules.threadId=0,
  p=>p[1].result.final.modules.pid=100,p=>p[0].result.status='failed',p=>p[1].result.final.modules.modules[0].sha256='b'.repeat(64),p=>p[1].result.final.modules.modules[0].file='/tmp/checkout/desktop/evidence-consumption.cjs']){
  const p=phases();change(p);assert.throws(()=>h.assertGenericModuleProof(p,asar,inputs));
 }
});
function recoverySample(kind,{seed=false}={}){
 const g=sample(true).generic,initial={kind,operationId:'origin',operationHash:'old-op-hash',attemptId:'original-attempt',logicalKey:'original-logical',responseHash:'a'.repeat(64),requests:[{requestId:'request',operationId:'origin',attemptId:'original-attempt'}],familyKey:'family',runHash:'old-run-hash',attemptHash:'old-attempt-hash',failureCode:'LOCAL_RESULT_STORAGE',proof:{eligible:true,reason:'PROVEN_ZERO_BUSINESS_DISPATCH',method:'platform-chunks-v2',originOperationId:'origin'},counts:{identity:2,platform:kind==='local_recovery'?1:0,models:0,methodClaims:0},ledger:{limitUSD:200,spentUSD:17}};
 const c={key:'claim',method:'platform-chunks-v2',familyKey:'family',originOperationId:'origin',operationId:'successor',sourceId:'source',status:'done'};
 g.recovery={initial,counts:{...initial.counts},oldRunHash:initial.runHash,oldAttemptPreserved:true,originalOperationHash:initial.operationHash,
  corrections:kind==='preflight_recovery'?[{payload:{originalAttemptHash:initial.attemptHash}}]:[],claims:kind==='v2_recovery'?[c]:[],
  source:{id:'source',associated:true,readAllowed:true,format:'platform-chunks-v2',restoredHash:initial.responseHash},
  operation:{id:kind==='v2_recovery'?'successor':'origin',sourceId:'source',status:'done',attemptId:initial.attemptId,logicalKey:initial.logicalKey,requests:structuredClone(initial.requests),responseProof:{operationId:kind==='v2_recovery'?'successor':'origin',requestId:'request',dataHash:initial.responseHash},originOperationId:'origin',familyKey:'family',methodClaimId:'claim'},
  steps:[{runId:'run-1',tool:'advance_task'},{runId:'run-2',tool:'advance_task'},{tool:'plan_task',args:{evidenceResolution:{sourceIds:['source']}}},{tool:'platform_query',dispatch:{requests:[{query:{table:'leaf'}}]}},{tool:'recover_platform_result',result:{sourceId:'source',storageValidation:'original_response_verified'},dispatch:{requests:[]}}],localCompletion:{counts:{...initial.counts}}};
 g.consumption.attempts={};g.consumption.receipts.forEach((r,i)=>{r.attemptId='attempt-'+i;g.consumption.attempts[r.attemptId]={status:'committed',runId:'run-'+(i+1)};});
 if(seed){g.primary.id='generic-original';g.budget=structuredClone(initial.ledger);g.audit.patches=[];g.audit.writes=0;g.audit.checks=[];g.audit.queries=kind==='local_recovery'?['leaf']:[];g.recovery.claims=[];g.recovery.corrections=[];g.recovery.source=undefined;g.recovery.localCompletion=null;g.recovery.steps=[];g.recovery.operation.status='failed';g.recovery.operation.id='origin';}
 return g;
}
test('COV-1 recovery package contract requires actual failed cold starts and rejects seeded completion or missing proof',async t=>{
 for(const kind of ['preflight_recovery','v2_recovery','local_recovery']){
  h.assertGenericRecoverySeed(recoverySample(kind,{seed:true}));
  for(const [i,change]of [s=>s.primary.id='new-draft',s=>s.audit.patches.push({}),s=>s.audit.writes=1,s=>s.audit.checks.push('content'),s=>s.budget.spentUSD=0,s=>s.recovery.counts.models++,s=>s.recovery.claims.push({}),s=>s.recovery.source={id:'source'}].entries())await t.test(kind+' seed guard '+i,()=>{const g=recoverySample(kind,{seed:true});change(g);assert.throws(()=>h.assertGenericRecoverySeed(g));});
 }
 const pre=recoverySample('preflight_recovery',{seed:true});pre.recovery.initial.proof.eligible=false;assert.throws(()=>h.assertGenericRecoverySeed(pre));
 const local=recoverySample('local_recovery',{seed:true});delete local.recovery.initial.requests[0].requestId;assert.throws(()=>h.assertGenericRecoverySeed(local));
 const v2=recoverySample('v2_recovery',{seed:true});v2.recovery.initial.proof.method='coral-structural-v1';assert.throws(()=>h.assertGenericRecoverySeed(v2));
});
test('COV-1 recovery package contract binds correction, v2 method family and zero-dispatch local receipt to normal association/consumption',async t=>{
 for(const kind of ['preflight_recovery','v2_recovery','local_recovery']){
  h.assertGenericRecoveryProgress(recoverySample(kind));
  for(const [i,change]of [s=>s.recovery.source.associated=false,s=>s.recovery.source.readAllowed=false,s=>s.recovery.operation.status='failed',s=>s.recovery.steps=s.recovery.steps.filter(v=>v.tool!=='plan_task'),s=>s.consumption.attempts['attempt-0'].runId='other',s=>s.consumption.attempts['attempt-0'].status='failed',s=>s.recovery.operation.sourceId='unrelated',s=>s.recovery.operation.responseProof.operationId='unrelated',s=>s.recovery.operation.responseProof.dataHash='corrupt',s=>delete s.recovery.operation.responseProof.requestId].entries())await t.test(kind+' flow guard '+i,()=>{const g=recoverySample(kind);change(g);assert.throws(()=>h.assertGenericRecoveryProgress(g));});
 }
 const mutations={preflight_recovery:[s=>s.recovery.corrections=[],s=>s.recovery.corrections.push(s.recovery.corrections[0]),s=>s.recovery.oldAttemptPreserved=false,s=>s.recovery.oldRunHash='changed',s=>s.recovery.steps=s.recovery.steps.filter(v=>v.tool!=='platform_query')],
  v2_recovery:[s=>s.recovery.claims[0].method='coral-structural-v1',s=>s.recovery.claims[0].familyKey='new-family',s=>s.recovery.operation.originOperationId='other',s=>s.recovery.operation.methodClaimId='new-claim',s=>s.recovery.claims[0].sourceId='other-source',s=>s.recovery.originalOperationHash='rewritten',s=>s.recovery.source.format='coral-structural-v1'],
  local_recovery:[...['identity','platform','models','methodClaims'].map(key=>s=>s.recovery.localCompletion.counts[key]++),s=>s.recovery.operation.id='new',s=>s.recovery.operation.attemptId='new',s=>s.recovery.operation.requests.push({requestId:'new'}),s=>s.recovery.operation.responseProof.dataHash='changed',s=>s.recovery.source.restoredHash='changed',s=>s.recovery.steps.find(v=>v.tool==='recover_platform_result').dispatch.requests.push({}),s=>s.recovery.steps.find(v=>v.tool==='recover_platform_result').result.storageValidation='legacy_unverified']};
 for(const [kind,changes]of Object.entries(mutations))for(const [i,change]of changes.entries())await t.test(kind+' identity guard '+i,()=>{const g=recoverySample(kind);change(g);assert.throws(()=>h.assertGenericRecoveryProgress(g));});
});
test('COV-1 recovery package moduleProof requires actual recovery modules in post-cold execution phases',async t=>{
 const asar='/tmp/final.app/Contents/Resources/app.asar',names=[...h.GENERIC_MODULES,...h.RECOVERY_MODULES],inputs=names.map(name=>({path:'desktop/'+name,sha256:'a'.repeat(64)}));
 const phases=()=>[0,1,2,3].map(phase=>({result:{phase,status:'passed',pid:100+phase,final:{modules:{pid:100+phase,threadId:1,workerEntry:path.join(asar,'desktop/engine-worker.cjs'),modules:[1,2].includes(phase)?names.map(name=>({file:path.join(asar,'desktop',name),sha256:'a'.repeat(64)})):[]}}}}));
 h.assertGenericModuleProof(phases(),asar,inputs,{recovery:true});
 for(const phase of [1,2])for(const name of h.RECOVERY_MODULES)await t.test('phase '+phase+' '+name,()=>{const p=phases();p[phase].result.final.modules.modules=p[phase].result.final.modules.modules.filter(r=>!r.file.endsWith('/'+name));assert.throws(()=>h.assertGenericModuleProof(p,asar,inputs,{recovery:true}));});
});
test('isolation forbids real filesystem reads, inherited descriptors and symlink escapes while allowing fixture and selected package reads',t=>{
 const dir=temp(t),outside=path.join(path.dirname(dir),path.basename(dir)+'-outside');fs.writeFileSync(outside,'synthetic private data');t.after(()=>fs.rmSync(outside,{force:true}));
 fs.symlinkSync(outside,path.join(dir,'escape'));fs.mkdirSync(path.join(dir,'app.asar'));fs.writeFileSync(path.join(dir,'app.asar/module.cjs'),'safe package text');
 const script=`const assert=require('node:assert/strict'),fs=require('node:fs');
 const inherited=fs.openSync(${JSON.stringify(outside)},'r');
 require(${JSON.stringify(path.join(root,'scripts/system-package-worker.cjs'))}).installIsolation(${JSON.stringify({dir,asar:path.join(dir,'app.asar'),phase:0})});
 const outside=${JSON.stringify(outside)},escape=${JSON.stringify(path.join(dir,'escape'))};
 for(const call of [()=>fs.readFileSync(outside),()=>fs.openSync(outside,'r'),()=>fs.createReadStream(outside),()=>fs.statSync(outside),()=>fs.existsSync(outside),()=>fs.readFileSync(escape),()=>fs.readFileSync(inherited),()=>fs.readSync(inherited,Buffer.alloc(1),0,1,null),()=>fs.copyFileSync(outside,${JSON.stringify(path.join(dir,'copy'))})])assert.throws(call,/CONTROLLED_EXTERNAL_DENIED/);
 assert.equal(fs.readFileSync(${JSON.stringify(path.join(dir,'app.asar/module.cjs'))},'utf8'),'safe package text');
 fs.writeFileSync(${JSON.stringify(path.join(dir,'allowed'))},'ok');
 assert.equal(fs.readFileSync(${JSON.stringify(path.join(dir,'allowed'))},'utf8'),'ok');
 (async()=>{await assert.rejects(async()=>fs.promises.readFile(outside),/CONTROLLED_EXTERNAL_DENIED/);const handle=await fs.promises.open(${JSON.stringify(path.join(dir,'allowed'))},'r');assert.equal(await handle.readFile('utf8'),'ok');await handle.close();})();`;
 const r=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);
 assert.equal(fs.readFileSync(outside,'utf8'),'synthetic private data');assert.equal(fs.existsSync(path.join(dir,'copy')),false);
});
