'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('../foundation-marker-runner/identity.cjs'),{root,pack,sha,read,write}=base;
const SAMPLE='68785ade24b83dccffc00949dab70309a472c158d5be21358a95d399e415f8e5';
function validatePlan(plan){
 assert.equal(plan.liveAuthorized,false);assert.equal(plan.candidateInstalled,false);assert.equal(plan.sourceSampleIdentity,SAMPLE);
 assert.deepEqual(plan.order,['f04','gate','business']);assert.deepEqual(plan.business.order,['F05-jianping-revision','F06-yunshu-restart']);
 assert.deepEqual(plan.total,{applicationAttempts:25,maximumModelDispatches:22,reportedTokenStopThreshold:620000});
 for(const [phase,attempts,tokens,dispatches]of [['gate',5,120000,4],['business',20,500000,18]]){
  const p=plan[phase],b=p.budget;assert.equal(b.applicationAttempts,attempts);assert.equal(b.reportedTokenStopThreshold,tokens);assert.equal(b.maximumModelDispatches,dispatches);assert.equal(b.dispatchWindowMinutes,45);
  assert.equal(b.priorBudgetsReusable,false);assert.equal(b.serverEnforcedTokenCap,false);assert.deepEqual(p.settings,plan.settings);assert.equal(p.asarSha256,plan.asarSha256);
 }
 assert.equal(plan.gate.budget.protocolAttempts,5);assert.equal(plan.gate.budget.businessAttempts,0);assert.deepEqual(plan.gate.caseLimits,[]);
 assert.equal(plan.business.budget.protocolAttempts,0);assert.equal(plan.business.budget.businessAttempts,20);
 assert.deepEqual(plan.business.caseLimits.map(c=>[c.id,c.attempts,c.tokenStopThreshold]),[['F05-jianping-revision',13,330000],['F06-yunshu-restart',7,170000]]);
 assert.equal(plan.f04.windowMinutes,45);assert.equal(plan.f04.taskId,'93efb213-e312-4818-a534-02ef26f3b149');assert.equal(plan.f04.modelCalls,0);
 assert.equal(plan.settings.concurrency,1);assert.equal(plan.settings.retries,0);assert.equal(plan.settings.fallback,false);
}
function frozen(executable,{complete=false,phase}={}){
 const plan=read(path.join(__dirname,'plan.json'));validatePlan(plan);
 const seal=read(path.join(pack,'seal.json'));assert.equal(seal.identity,SAMPLE);assert.equal(sha(JSON.stringify(seal.files)),SAMPLE);
 for(const f of seal.files)assert.equal(sha(fs.readFileSync(path.join(pack,f.path))),f.sha256);
 const manifest=read(path.join(__dirname,'package-manifest.json'));assert.equal(manifest.asarSha256,plan.asarSha256);
 const candidateIdentity=require('../foundation-runner/candidate-identity.cjs').verify(executable,manifest,{complete});
 for(const f of manifest.archiveChanges)assert.equal(sha(fs.readFileSync(path.join(root,f.path))),f.sha256);
 for(const f of plan.f04.files)assert.equal(sha(fs.readFileSync(path.resolve(root,plan.f04.directory,f.path))),f.sha256,'Historical F04 input changed');
 return {plan:phase?plan[phase]:plan,pack,seal,asar:path.join(path.dirname(executable),'resources/app.asar'),candidateIdentity,groundingSha256:manifest.groundingSha256};
}
function validateAuthorization(a,plan,runnerIdentity){
 assert.equal(a?.schema,1);assert.equal(a.grantedBy,'user');assert.ok(typeof a.reference==='string'&&a.reference.trim());assert.equal(a.runnerIdentity,runnerIdentity);assert.equal(a.sealIdentity,SAMPLE);
 assert.equal(a.planSha256,require('../foundation-business-runner/ledger.cjs').planHash(plan));assert.equal(a.asarSha256,plan.asarSha256);
 for(const[k,v]of Object.entries(plan.total))assert.equal(a[k],v);
 assert.equal(a.nonHardCapAccepted,true);assert.equal(a.humanParticipationConfirmed,true);assert.deepEqual(a.phaseWindowsMinutes,{f04:45,gate:45,business:45});assert.equal(a.realCliSha256,plan.cli.sha256);
}
function runnerSeal(){
 const inherited=base.runnerSeal(SAMPLE),deps=[...inherited.dependencies];
 for(const dir of ['foundation-marker-runner','foundation-business-runner','foundation-diagnostic-runner','foundation-citation-gate-runner','foundation-citation-business-runner','foundation-citation-offline-runner'])for(const file of fs.readdirSync(path.join(root,'evaluations',dir)))if(/\.(cjs|json|md)$/.test(file)){
  const p='evaluations/'+dir+'/'+file;deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});
 }
 for(const p of ['scripts/prepare-export-candidate.cjs','scripts/prepare-citation-candidate.cjs','scripts/prepare-marker-candidate.cjs','scripts/rehearse-minimal-runner.cjs','tests/foundation-minimal-runner.test.cjs','desktop/evidence-basis.cjs','desktop/citation-fields.cjs'])deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|json|md)$/.test(f)&&!['runner-seal.json','runner-review.json'].includes(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const dependencies=[...new Map(deps.map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path)),contents={files,dependencies,host:inherited.host};
 return {schema:1,sampleSealIdentity:SAMPLE,...contents,identity:sha(JSON.stringify(contents)),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(value){assert.deepEqual(value,runnerSeal(),'Minimal runner/dependency drift');return value.identity;}
module.exports={root,pack,sha,read,write,SAMPLE,frozen,validatePlan,validateAuthorization,runnerSeal,verifyRunner};
if(require.main===module){const file=path.join(__dirname,'runner-seal.json');assert.ok(!fs.existsSync(file));const value=runnerSeal();write(file,value);console.log(JSON.stringify({runnerIdentity:value.identity}));}
