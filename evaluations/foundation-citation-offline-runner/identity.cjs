'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {root,sha,read,write}=require('../foundation-runner/common.cjs');
const pack=path.join(root,'evaluations/foundation-marker-acceptance-20261029'),SAMPLE='68785ade24b83dccffc00949dab70309a472c158d5be21358a95d399e415f8e5';
const manifestPath=path.join(__dirname,'package-manifest.json');
function frozen(executable,{complete=false}={}){
 const plan=read(path.join(__dirname,'plan.json')),manifest=read(manifestPath),seal=read(path.join(pack,'seal.json'));
 assert.equal(plan.liveAuthorized,false);assert.equal(plan.scope,'offline-six-case-lifecycle-on-citation-candidate');assert.equal(plan.gatePrerequisite.offlineOnly,true);
 assert.equal(seal.identity,SAMPLE);assert.equal(sha(JSON.stringify(seal.files)),seal.identity);for(const f of seal.files)assert.equal(sha(fs.readFileSync(path.join(pack,f.path))),f.sha256);
 assert.equal(plan.asarSha256,manifest.asarSha256);const candidateIdentity=require('../foundation-runner/candidate-identity.cjs').verify(executable,manifest,{complete});
 return {plan,pack,seal,asar:path.join(path.dirname(executable),'resources/app.asar'),candidateIdentity,groundingSha256:manifest.groundingSha256,executableSha256:manifest.executableSha256,gateProof:{offlineOnly:true,passed:false,authorizationReusable:false}};
}
function runnerSeal(){
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|md|json)$/.test(f)&&!['runner-seal.json','runner-review.json'].includes(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const paths=[];for(const dir of ['foundation-runner','foundation-marker-runner','foundation-business-runner'])for(const name of fs.readdirSync(path.join(root,'evaluations',dir)))if(/\.(cjs|cs)$/.test(name))paths.push('evaluations/'+dir+'/'+name);
 paths.push('desktop/evidence-basis.cjs','desktop/grounding.cjs','desktop/citation-fields.cjs','desktop/subscription-protocol.cjs','desktop/host-process.cjs','desktop/windows-process.cjs','desktop/windows-native.cjs','desktop/model-errors.cjs','desktop/model-json.cjs','desktop/native/bin/windows-process.exe');
 for(const module of ['playwright','playwright-core']){
  const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);assert.ok(!e.isSymbolicLink());if(e.isDirectory())walk(p);else if(e.isFile())paths.push(path.relative(root,p).replaceAll('\\','/'));}};walk(path.dirname(require.resolve(module+'/package.json')));
 }
 const dependencies=[...new Set(paths)].sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.resolve(root,p)))}));
 const host={nodeVersion:process.version,nodeSha256:sha(fs.readFileSync(process.execPath)),cscSha256:sha(fs.readFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'))),optionalWebsocketNativeModules:false},contents={files,dependencies,host};
 return {schema:1,sampleSealIdentity:SAMPLE,...contents,identity:sha(JSON.stringify(contents)),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(value){assert.deepEqual(value,runnerSeal());return value.identity;}
function validateAuthorization(){throw Error('This runner is offline-only; no real authorization can enable it');}
function seal(){const file=path.join(__dirname,'runner-seal.json');assert.ok(!fs.existsSync(file));const value=runnerSeal();write(file,value);return value.identity;}
module.exports={root,pack,sha,read,write,frozen,runnerSeal,verifyRunner,validateAuthorization,seal};if(require.main===module)console.log(seal());
