'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('../foundation-business-runner/identity.cjs'),marker=require('../foundation-marker-runner/identity.cjs'),{root,sha,read,write}=base,{pack}=marker;
const SAMPLE='68785ade24b83dccffc00949dab70309a472c158d5be21358a95d399e415f8e5';
function frozen(executable,{complete=false}={}){
 const seal=read(path.join(pack,'seal.json'));assert.equal(seal.identity,SAMPLE);assert.equal(sha(JSON.stringify(seal.files)),SAMPLE);
 for(const f of seal.files)assert.equal(sha(fs.readFileSync(path.join(pack,f.path))),f.sha256);
 const plan=read(path.join(__dirname,'plan.json')),manifest=read(path.join(__dirname,'package-manifest.json'));
 assert.equal(plan.liveAuthorized,false);assert.equal(plan.scope,'offline-only-six-case-protocol-regression');assert.equal(plan.asarSha256,manifest.asarSha256);assert.equal(plan.gatePrerequisite.required,false);
 assert.deepEqual(plan.order,read(path.join(pack,'stimuli.json')).cases.map(c=>c.id));assert.equal(plan.budget.protocolAttempts,0);
 for(const f of manifest.archiveChanges)assert.equal(sha(fs.readFileSync(path.join(root,f.path))),f.sha256,'Candidate source drift');
 const candidateIdentity=require('../foundation-runner/candidate-identity.cjs').verify(executable,manifest,{complete});
 return {plan,pack,seal,asar:path.join(path.dirname(executable),'resources/app.asar'),candidateIdentity,groundingSha256:manifest.groundingSha256,executableSha256:manifest.executableSha256,gateProof:{applicable:false,reason:'Changed candidate; historical G01 cannot authorize this build',executions:0}};
}
function runnerSeal(){
 const inherited=base.runnerSeal(),deps=[...inherited.dependencies];
 for(const dir of ['foundation-marker-runner','foundation-business-runner'])for(const file of fs.readdirSync(path.join(root,'evaluations',dir))){const p='evaluations/'+dir+'/'+file;if(fs.statSync(path.join(root,p)).isFile())deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});}
 for(const p of ['desktop/check-finalization.cjs','desktop/generation-context.cjs','desktop/marker-confirmation.cjs','scripts/prepare-recheck-candidate.cjs'])deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|md|json)$/.test(f)&&!['runner-seal.json','runner-review.json'].includes(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const dependencies=[...new Map(deps.map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path)),contents={files,dependencies,host:inherited.host};
 return {schema:1,sampleSealIdentity:SAMPLE,...contents,identity:sha(JSON.stringify(contents)),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(value){assert.deepEqual(value,runnerSeal(),'Offline recheck runner changed');return value.identity;}
function seal(){assert.ok(!fs.existsSync(path.join(__dirname,'runner-review.json')));const value=runnerSeal();fs.writeFileSync(path.join(__dirname,'runner-seal.json'),JSON.stringify(value,null,2)+'\n');return {runnerIdentity:value.identity,sampleSealIdentity:SAMPLE};}
module.exports={root,pack,sha,read,write,frozen,runnerSeal,verifyRunner,seal};if(require.main===module)console.log(JSON.stringify(seal()));
