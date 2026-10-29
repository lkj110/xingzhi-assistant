'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('../foundation-marker-runner/identity.cjs'),{root,sha,read,write}=base;
const expectedSample='68785ade24b83dccffc00949dab70309a472c158d5be21358a95d399e415f8e5';
function frozen(executable,{complete=false}={}){
 const old=base.frozen(executable,{complete});assert.equal(old.seal.identity,expectedSample);
 const plan=read(path.join(__dirname,'plan.json'));assert.deepEqual(plan.protocolGate,old.plan.protocolGate);assert.deepEqual(plan.model,old.plan.model);assert.equal(plan.liveAuthorized,false);assert.equal(plan.businessCasesEnabled,false);assert.deepEqual(plan.caseLimits,[]);assert.equal(plan.budget.businessAttempts,0);assert.equal(plan.budget.businessTokenStopThreshold,0);assert.equal(plan.budget.applicationAttempts,plan.budget.protocolAttempts);assert.equal(plan.budget.reportedTokenStopThreshold,plan.budget.protocolTokenStopThreshold);assert.equal(plan.asarSha256,old.plan.asarSha256);
 return {...old,plan};
}
function runnerSeal(){
 const old=base.runnerSeal(expectedSample),dependencies=[...old.dependencies];
 for(const directory of ['evaluations/foundation-marker-runner','evaluations/foundation-marker-acceptance-20261029'])for(const name of fs.readdirSync(path.join(root,directory))){const p=directory+'/'+name;if(fs.statSync(path.join(root,p)).isFile())dependencies.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});}
 dependencies.sort((a,b)=>a.path.localeCompare(b.path));
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|md|json)$/.test(f)&&!['runner-seal.json','runner-review.json'].includes(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const contents={files,dependencies,host:old.host};return {schema:1,sampleSealIdentity:expectedSample,...contents,identity:sha(JSON.stringify(contents)),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(manifest){assert.deepEqual(manifest,runnerSeal(),'Diagnostic runner identity changed');return manifest.identity;}
function seal(){assert.ok(!fs.existsSync(path.join(__dirname,'runner-review.json')),'Reviewed runner cannot be resealed');const value=runnerSeal();fs.writeFileSync(path.join(__dirname,'runner-seal.json'),JSON.stringify(value,null,2)+'\n');return {runnerIdentity:value.identity,sampleSealIdentity:expectedSample};}
module.exports={root,sha,read,write,frozen,runnerSeal,verifyRunner,seal};
if(require.main===module)console.log(JSON.stringify(seal()));
