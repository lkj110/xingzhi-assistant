'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {root,sha,read,write}=require('../foundation-runner/common.cjs');
const pack=path.join(root,'evaluations/foundation-marker-acceptance-20261029');
const expectedAsar='9fe3cc8b865a37fa063fec7cce7158e4e9a07f682f6556fd08a844f6e89dec2b';
function listed(directory,seal){
 assert.equal(sha(JSON.stringify(seal.files)),seal.identity);
 for(const row of seal.files){assert.ok(/^[\w./-]+$/.test(row.path)&&!row.path.split('/').includes('..')&&!path.isAbsolute(row.path));assert.equal(sha(fs.readFileSync(path.join(directory,row.path))),row.sha256,row.path);}
}
function frozen(executable,{complete=false}={}){
 const seal=read(path.join(pack,'seal.json'));listed(pack,seal);
 for(const name of ['plan.json','stimuli.json','gold.json','inputs.cjs','package-manifest.json','coverage.json'])assert.ok(seal.files.some(f=>f.path===name),'Missing sealed '+name);
 const plan=read(path.join(pack,'plan.json')),manifest=read(path.join(pack,'package-manifest.json'));
 assert.equal(plan.liveAuthorized,false);assert.equal(plan.asarSha256,expectedAsar);assert.equal(manifest.asarSha256,expectedAsar);
 const candidateIdentity=require('../foundation-runner/candidate-identity.cjs').verify(executable,manifest,{complete});
 return {plan,pack,seal,asar:path.join(path.dirname(executable),'resources/app.asar'),candidateIdentity,groundingSha256:manifest.groundingSha256,executableSha256:manifest.executableSha256};
}
function dependencies(){
 const shared=fs.readdirSync(path.join(root,'evaluations/foundation-runner')).filter(f=>/\.(cjs|cs)$/.test(f)).map(f=>'evaluations/foundation-runner/'+f);
 const source=['desktop/subscription-protocol.cjs','desktop/host-process.cjs','desktop/windows-process.cjs','desktop/windows-native.cjs','desktop/model-errors.cjs','desktop/model-json.cjs','desktop/native/bin/windows-process.exe','desktop/grounding.cjs','evaluations/foundation-acceptance-20261028/plan.json','evaluations/foundation-acceptance-20261028/inputs.cjs'];
 // Playwright is a runtime dependency of the executor, not an unsealed global.
 const runtime=[];
 for(const module of ['playwright','playwright-core']){
  const base=path.dirname(require.resolve(module+'/package.json'));
  const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);assert.ok(!e.isSymbolicLink());if(e.isDirectory())walk(file);else if(e.isFile())runtime.push(path.relative(root,file).replace(/\\/g,'/'));}};walk(base);
 }
 return [...new Set([...shared,...source,...runtime])].sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))}));
}
function runnerSeal(sampleIdentity){
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|md)$/.test(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const deps=dependencies(),host={nodeVersion:process.version,nodeSha256:sha(fs.readFileSync(process.execPath)),cscSha256:sha(fs.readFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'))),optionalWebsocketNativeModules:false};return {schema:1,sampleSealIdentity:sampleIdentity,files,dependencies:deps,host,identity:sha(JSON.stringify({files,dependencies:deps,host})),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(manifest,sampleIdentity){
 assert.deepEqual(manifest,runnerSeal(sampleIdentity),'Runner or dependency identity changed');return manifest.identity;
}
module.exports={root,pack,sha,read,write,frozen,runnerSeal,verifyRunner};
