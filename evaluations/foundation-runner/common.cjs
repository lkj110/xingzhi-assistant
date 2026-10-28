'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),pack=path.join(root,'evaluations/foundation-acceptance-20261028');
const IDENTITY='7055d464d6b39a6711cda0bb6bb4e5085f5b2610079f50840ee91f7cc30e31d7';
const candidatePack=path.join(root,'evaluations/foundation-candidate-20261028');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
function frozen(executable,{candidate=false,complete=false}={}){
 assert.equal(typeof candidate,'boolean');assert.equal(typeof complete,'boolean');
 const selected=candidate?candidatePack:pack,seal=read(path.join(selected,'seal.json'));
 if(!candidate)assert.equal(seal.identity,IDENTITY);assert.equal(sha(JSON.stringify(seal.files)),seal.identity);
 assert.ok(/^[a-f0-9]{64}$/.test(seal.identity));
 for(const f of seal.files){assert.ok(typeof f.path==='string'&&!path.isAbsolute(f.path)&&inside(selected,path.resolve(selected,f.path)));assert.equal(sha(fs.readFileSync(path.join(selected,f.path))),f.sha256,f.path);}
 for(const f of ['plan.json','stimuli.json','gold.json','inputs.cjs',...(candidate?['package-manifest.json']:[])])assert.ok(seal.files.some(row=>row.path===f),'Unsealed required file: '+f);
 const plan=read(path.join(selected,'plan.json')),asar=path.join(path.dirname(executable),'resources/app.asar');
 assert.equal(sha(fs.readFileSync(asar)),plan.asarSha256);assert.equal(plan.liveAuthorized,false);
 assert.equal(sha(fs.readFileSync(executable)),'991bd6c0157954d7cb4faf8bae36545765af725cceec92c92373197c993b6a5a');
 let candidateIdentity;
 if(candidate){candidateIdentity=require('./candidate-identity.cjs').verify(executable,read(path.join(selected,'package-manifest.json')),{complete});assert.equal(candidateIdentity.asarSha256,plan.asarSha256);}
 return {plan,asar,seal,pack:selected,runnerDirectory:candidate?selected:__dirname,candidate,candidateIdentity,
  groundingSha256:candidateIdentity?.groundingSha256||'cc46e51f073a5ea922af4a304c926e4d2c0833f3e37f7079c5c550c2ff072b9b',executableSha256:sha(fs.readFileSync(executable))};
}
function inside(base,file){const r=path.relative(base,file);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);}
function dependencies(executable,{candidate=false}={}){
 const repo=['desktop/subscription-protocol.cjs','desktop/host-process.cjs','desktop/windows-process.cjs','desktop/windows-native.cjs','desktop/model-errors.cjs','desktop/model-json.cjs','desktop/native/bin/windows-process.exe',...(candidate?['desktop/grounding.cjs','evaluations/foundation-acceptance-20261028/inputs.cjs']:[])];
 const installed=['resources/app.asar.unpacked/desktop/native/bin/windows-process.exe'];
 return [...repo.map(p=>({scope:'repo',path:p,sha256:sha(fs.readFileSync(path.join(root,p)))})),...installed.map(p=>({scope:'installed',path:p,sha256:sha(fs.readFileSync(path.join(path.dirname(executable),p)))}))];
}
module.exports={root,pack,candidatePack,IDENTITY,sha,read,write,frozen,inside,dependencies};
