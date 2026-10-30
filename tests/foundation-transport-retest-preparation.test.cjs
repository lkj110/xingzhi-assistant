'use strict';
// Sealing/admission checks only; never start the candidate or official CLI.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const id=require('../evaluations/foundation-remaining-runner/identity.cjs'),session=require('../evaluations/foundation-remaining-runner/session.cjs'),{planHash}=require('../evaluations/foundation-business-runner/ledger.cjs');
const plan=id.read(path.join(id.root,'evaluations/foundation-remaining-runner/plan.json')),oldSeal=require('./fixtures/foundation-remaining-prior-seal-20261030.json');
const seal=()=>id.read(path.join(id.root,'evaluations/foundation-remaining-runner/runner-seal.json'));
function directory(t){const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'retest-preparation-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),base);fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('new output root is fixed and old scope, samples, budgets and semantic settings remain exact',()=>{
 id.validatePlan(plan);assert.equal(plan.outputParent,'../foundation-transport-retest-runs-20261030');
 const old=require('../evaluations/foundation-minimal-runner/plan.json');
 for(const key of ['gate','business','settings','total','cli','asarSha256','sourceSampleIdentity'])assert.deepEqual(plan[key],old[key]);
 for(const outputParent of ['../foundation-remaining-runs-20261030','../','C:/','../foundation-transport-retest-runs-20261030/../old'])assert.throws(()=>id.validatePlan({...plan,outputParent}));
});
test('new seal binds diagnostic implementation, original event, old seal and all new regression sources',()=>{
 const s=seal();id.verifyRunner(s);assert.notEqual(s.identity,oldSeal.identity);assert.equal(s.liveAuthorized,false);
 for(const p of ['evaluations/foundation-runner/failure-cause.cjs','evaluations/foundation-runner/transport.cjs','tests/foundation-transport-cause.test.cjs','tests/foundation-transport-retest-preparation.test.cjs','tests/fixtures/foundation-cli-routing-timeout-20261030.json','tests/fixtures/foundation-remaining-prior-seal-20261030.json']){
  const row=s.dependencies.find(f=>f.path===p);assert.ok(row,p);assert.equal(row.sha256,id.sha(fs.readFileSync(path.join(id.root,p))));
 }
 assert.equal(oldSeal.identity,'3d4b4489abb902e14aad462ee63980c285b909c02f21c553059c8d8a3aadf375');assert.throws(()=>id.verifyRunner(oldSeal),/drift/);
});
test('changed sealed regression fixture cannot be hidden by the new seal',t=>{
 const s=seal(),target=path.join(id.root,'tests/fixtures/foundation-cli-routing-timeout-20261030.json'),read=fs.readFileSync;
 t.mock.method(fs,'readFileSync',(file,...args)=>{const v=read(file,...args);return path.resolve(String(file))===target?Buffer.concat([Buffer.from(v),Buffer.from(' ')]):v;});
 assert.throws(()=>id.verifyRunner(s),/drift/);
});
for(const replacement of ['old-runner','old-plan','old-output'])test('stale authorization '+replacement+' is refused before consuming authorization or spawning',t=>{
 const s=seal(),dir=directory(t),auth=path.join(dir,'authorization.json'),output=path.join(dir,'unused');
 const a={schema:1,grantedBy:'user',reference:'OFFLINE UNIT NOT REAL USER AUTHORIZATION',scope:plan.scope,runnerIdentity:s.identity,sealIdentity:id.SAMPLE,asarSha256:plan.asarSha256,planSha256:planHash(plan),f04PrerequisiteIdentity:id.verifyPrerequisite(plan).identity,...plan.total,nonHardCapAccepted:true,humanParticipationConfirmed:true,phaseWindowsMinutes:{gate:45,business:45},realCliSha256:plan.cli.sha256};
 if(replacement==='old-runner')a.runnerIdentity=oldSeal.identity;
 if(replacement==='old-plan')a.planSha256=planHash({...plan,outputParent:'../foundation-remaining-runs-20261030'});
 fs.writeFileSync(auth,JSON.stringify(a));const before=fs.readFileSync(auth),read=id.read;
 t.mock.method(id,'frozen',()=>({plan:structuredClone(plan)}));
 // Synthetic review for admission testing only. This does not write readiness
 // or a real authorization; the tested path must reject before claim/spawn.
 t.mock.method(id,'read',file=>file===path.join(id.root,'evaluations/foundation-remaining-runner/runner-review.json')?{approvedForLiveReadiness:true,runnerIdentity:s.identity,asarSha256:plan.asarSha256,realModelCalls:0}:read(file));
 let claimed=0;t.mock.method(require('../evaluations/foundation-runner/authorization.cjs'),'claimAuthorization',()=>{claimed++;assert.fail('No authorization claim allowed');});
 for(const method of ['spawn','spawnSync','execFileSync'])t.mock.method(cp,method,()=>assert.fail('No subprocess allowed'));
 assert.throws(()=>session.begin({phase:'gate',mode:'live',readyReference:'UNIT ONLY',authorizationPath:auth,output:replacement==='old-output'?path.resolve(id.root,'../foundation-remaining-runs-20261030/never-create'):output,executable:'unused'}));
 assert.equal(claimed,0);assert.equal(fs.existsSync(auth+'.consumed.json'),false);assert.equal(fs.existsSync(output),false);assert.deepEqual(fs.readFileSync(auth),before);
});
test('live entry rejects offline fault injection before any dispatch or session start',async t=>{
 for(const method of ['spawn','spawnSync','execFileSync'])t.mock.method(cp,method,()=>assert.fail('No subprocess allowed'));
 for(const stage of ['gate','business'])await assert.rejects(require('../evaluations/foundation-remaining-runner/run.cjs').run({stage,mode:'live',fault:'routing-timeout'}));
});
