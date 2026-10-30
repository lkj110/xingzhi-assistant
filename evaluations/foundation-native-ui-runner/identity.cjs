'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const parent=require('../foundation-minimal-runner/identity.cjs'),{root,read,write,sha,SAMPLE}=parent;
function validatePlan(p){
 assert.equal(p.schema,1);assert.equal(p.scope,'F04-native-ui-only');assert.equal(p.liveAuthorized,false);assert.equal(p.candidateInstalled,false);
 assert.deepEqual(p.budget,{modelApplicationAttempts:0,maximumModelDispatches:0,inputPlusOutputTokens:0,windowMinutes:45});
 assert.equal(p.asarSha256,'958928ee84007b689bb605dc2252591c582c291aae3f22731fa073e96bb9f62e');assert.equal(p.sourceSampleIdentity,SAMPLE);
 assert.deepEqual(p.f04,read(path.join(root,'evaluations/foundation-minimal-runner/plan.json')).f04);
}
function frozen(executable,options={}){const identity=parent.frozen(executable,options),plan=read(path.join(__dirname,'plan.json'));validatePlan(plan);assert.equal(plan.asarSha256,identity.plan.asarSha256);return {...identity,plan};}
function runnerSeal(){
 const old=parent.runnerSeal(),deps=[...old.dependencies,...old.files.map(f=>({...f,path:'evaluations/foundation-minimal-runner/'+f.path}))];
 for(const p of ['evaluations/foundation-minimal-runner/runner-seal.json','evaluations/foundation-minimal-runner/runner-review.json','desktop/quick-capture.cjs','tests/foundation-native-ui.test.cjs','scripts/rehearse-native-ui.cjs'])deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});
 const files=fs.readdirSync(__dirname).filter(p=>/\.(cjs|json)$/.test(p)&&!['runner-seal.json','runner-review.json'].includes(p)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const contents={files,dependencies:[...new Map(deps.map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path)),host:old.host};
 return {schema:1,...contents,identity:sha(JSON.stringify(contents)),scope:'F04-native-ui-only',liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(seal){assert.deepEqual(seal,runnerSeal(),'F04-only runner or dependency changed');return seal.identity;}
function validateAuthorization(a,plan,identity){
 assert.equal(a?.schema,1);assert.equal(a.grantedBy,'user');assert.ok(typeof a.reference==='string'&&a.reference.trim());assert.equal(a.scope,plan.scope);assert.equal(a.runnerIdentity,identity);assert.equal(a.sealIdentity,SAMPLE);assert.equal(a.asarSha256,plan.asarSha256);assert.equal(a.planSha256,sha(JSON.stringify(plan)));
 assert.equal(a.modelApplicationAttempts,0);assert.equal(a.maximumModelDispatches,0);assert.equal(a.inputPlusOutputTokens,0);assert.deepEqual(a.phaseWindowsMinutes,{f04:45});assert.equal(a.humanParticipationConfirmed,true);
}
module.exports={root,read,write,sha,SAMPLE,frozen,validatePlan,runnerSeal,verifyRunner,validateAuthorization};
