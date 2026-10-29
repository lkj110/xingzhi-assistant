'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('../foundation-citation-offline-runner/identity.cjs'),{root,pack,sha,read,write}=base;
const SAMPLE='68785ade24b83dccffc00949dab70309a472c158d5be21358a95d399e415f8e5';
function validatePlan(plan,original){
 assert.equal(plan.liveAuthorized,false);assert.equal(plan.scope,'one-exposed-protocol-gate-on-citation-candidate-only');
 assert.equal(plan.businessCasesEnabled,false);assert.equal(plan.qualityEvaluation,false);assert.equal(plan.exposedProtocolGate,true);
 assert.deepEqual(plan.protocolGate,original.protocolGate);assert.deepEqual(plan.model,original.model);assert.deepEqual(plan.settings,original.settings);
 assert.deepEqual(plan.order,[original.protocolGate.id]);assert.deepEqual(plan.caseLimits,[]);assert.equal(plan.sourceSampleIdentity,SAMPLE);
 assert.deepEqual(plan.budget,{...original.budget,maximumModelDispatches:4});assert.equal(plan.priorBudgetsReusable,false);assert.match(plan.cli.sha256,/^[a-f0-9]{64}$/);
}
function frozen(executable,{complete=false}={}){
 const old=base.frozen(executable,{complete}),plan=read(path.join(__dirname,'plan.json'));
 validatePlan(plan,read(path.join(root,'evaluations/foundation-diagnostic-runner/plan.json')));assert.equal(plan.asarSha256,old.plan.asarSha256);assert.equal(old.seal.identity,SAMPLE);
 return {...old,plan};
}
function validateAuthorization(a,plan,runnerIdentity){
 assert.equal(a?.schema,1);assert.equal(a.grantedBy,'user');assert.ok(typeof a.reference==='string'&&a.reference.trim());assert.equal(a.runnerIdentity,runnerIdentity);assert.equal(a.sealIdentity,SAMPLE);
 assert.equal(a.planSha256,require('../foundation-diagnostic-runner/ledger.cjs').planHash(plan));assert.equal(a.applicationAttempts,plan.budget.applicationAttempts);assert.equal(a.reportedTokenStopThreshold,plan.budget.reportedTokenStopThreshold);assert.equal(a.nonHardCapAccepted,true);assert.equal(a.realCliSha256,plan.cli.sha256);
}
function runnerSeal(){
 const inherited=base.runnerSeal(),deps=[...inherited.dependencies];
 for(const dir of ['foundation-citation-offline-runner','foundation-diagnostic-runner'])for(const file of fs.readdirSync(path.join(root,'evaluations',dir))){const p='evaluations/'+dir+'/'+file;if(fs.statSync(path.join(root,p)).isFile()&&!['runner-review.json'].includes(file))deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});}
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|md|json)$/.test(f)&&!['runner-seal.json','runner-review.json'].includes(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const dependencies=[...new Map(deps.map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path)),contents={files,dependencies,host:inherited.host};return {schema:1,sampleSealIdentity:SAMPLE,...contents,identity:sha(JSON.stringify(contents)),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(value){assert.deepEqual(value,runnerSeal(),'Citation candidate gate runner or dependencies changed');return value.identity;}
function seal(){assert.ok(!fs.existsSync(path.join(__dirname,'runner-seal.json')));const value=runnerSeal();write(path.join(__dirname,'runner-seal.json'),value);return value.identity;}
module.exports={root,pack,sha,read,write,frozen,validatePlan,validateAuthorization,runnerSeal,verifyRunner,seal};if(require.main===module)console.log(seal());
