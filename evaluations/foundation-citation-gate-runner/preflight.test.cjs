'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {frozen,validatePlan,validateAuthorization,runnerSeal,verifyRunner,root}=require('./identity.cjs'),plan=require('./plan.json'),original=require('../foundation-diagnostic-runner/plan.json');
const {Ledger,planHash}=require('../foundation-diagnostic-runner/ledger.cjs');
const seal='a'.repeat(64),meta={caseId:plan.protocolGate.id,role:'execute',stage:'task_work',serializedInputBytes:13035,schemaBytes:124,visibleBytes:11709};
function temporary(t){const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'recheck-gate-unit-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),base);fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('only new reviewed candidate is eligible; old package is refused',()=>{
 const work=path.dirname(root),candidate=path.join(work,'foundation-candidate-bundle-citation-20261029/XingzhiAssistant.exe');
 assert.equal(frozen(candidate).plan.asarSha256,plan.asarSha256);
 assert.throws(()=>frozen(path.join(work,'foundation-candidate-bundle-marker-20261028/XingzhiAssistant.exe')));
});
test('plan cannot acquire business cases, more calls, more tokens or a resettable window',()=>{
 validatePlan(plan,original);
 for(const patch of [p=>{p.budget.maximumModelDispatches=5;},p=>{p.budget.reportedTokenStopThreshold=150000;},p=>{p.budget.dispatchWindowMinutes=46;},p=>{p.businessCasesEnabled=true;},p=>{p.caseLimits=[{id:'F01'}];},p=>{p.liveAuthorized=true;},p=>{p.protocolGate.description+='changed';},p=>{p.model.id='other';}]){const changed=structuredClone(plan);patch(changed);assert.throws(()=>validatePlan(changed,original));}
 const manifest=runnerSeal();assert.equal(verifyRunner(manifest),manifest.identity);manifest.identity='0'.repeat(64);assert.throws(()=>verifyRunner(manifest));
});
test('old runner/plan/sample/CLI approval is rejected by pure preflight without writing an authorization',()=>{
 const syntheticPlan=structuredClone(plan);syntheticPlan.cli.sha256='c'.repeat(64);const runner='b'.repeat(64);
 const approval={schema:1,grantedBy:'user',reference:'SYNTHETIC MEMORY ONLY; not real user authorization',runnerIdentity:runner,sealIdentity:plan.sourceSampleIdentity,planSha256:planHash(syntheticPlan),applicationAttempts:5,reportedTokenStopThreshold:120000,nonHardCapAccepted:true,realCliSha256:syntheticPlan.cli.sha256};
 validateAuthorization(approval,syntheticPlan,runner);
 for(const patch of [{runnerIdentity:'d'.repeat(64)},{planSha256:planHash(original)},{sealIdentity:'d'.repeat(64)},{realCliSha256:'d'.repeat(64)},{applicationAttempts:4},{reportedTokenStopThreshold:700000},{nonHardCapAccepted:false},{grantedBy:'runner'},{reference:''}])assert.throws(()=>validateAuthorization({...approval,...patch},syntheticPlan,runner));
});
test('missing user authorization fails before reading candidate or launching any process',async t=>{
 const cp=require('node:child_process');let spawns=0;t.mock.method(cp,'spawnSync',()=>{spawns++;throw Error('Forbidden');});t.mock.method(cp,'spawn',()=>{spawns++;throw Error('Forbidden');});
 await assert.rejects(require('./run.cjs').run({mode:'live',executable:'DO_NOT_READ',output:'DO_NOT_CREATE'}),/explicit user approval/);assert.equal(spawns,0);
});
test('four forwards plus one refusal, and no business quota',t=>{
 const dir=temporary(t),l=new Ledger({dir,plan,mode:'offline',sealIdentity:seal,conservativeAttemptSlot:true});
 for(let i=0;i<4;i++){const row=l.admit(meta);l.settle(row.id,{inputTokens:100,outputTokens:20});}
 assert.throws(()=>l.admit(meta),{code:'LEDGER_GLOBAL_BUDGET'});assert.equal(l.snapshot().totals.admitted,4);assert.equal(l.snapshot().totals.applicationEntryAttempts,5);
 const other=new Ledger({dir:path.join(dir,'business'),plan,mode:'offline',sealIdentity:seal,conservativeAttemptSlot:true});assert.throws(()=>other.admit({...meta,caseId:'F05-jianping-revision'}));assert.equal(other.snapshot().totals.admitted,0);
});
test('restart cannot reset the 45-minute window or resume an uncertain dispatch',t=>{
 const dir=temporary(t);let now=1000;const opts={dir,plan,mode:'offline',sealIdentity:seal,conservativeAttemptSlot:true,now:()=>now},first=new Ledger(opts),row=first.admit(meta);first.settle(row.id,{inputTokens:100,outputTokens:20});const started=first.snapshot().startedAt;
 now+=45*60000;const resumed=new Ledger(opts);assert.equal(resumed.snapshot().startedAt,started);assert.throws(()=>resumed.admit(meta),{code:'LEDGER_WINDOW'});
 const uncertainOptions={...opts,dir:path.join(dir,'uncertain')},uncertain=new Ledger(uncertainOptions);uncertain.admit(meta);const stopped=new Ledger(uncertainOptions);assert.equal(stopped.snapshot().stop.code,'LEDGER_INTERRUPTED');assert.throws(()=>stopped.admit(meta),{code:'LEDGER_STOPPED'});
});
