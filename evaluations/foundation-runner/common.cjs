'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),pack=path.join(root,'evaluations/foundation-acceptance-20261028');
const IDENTITY='7055d464d6b39a6711cda0bb6bb4e5085f5b2610079f50840ee91f7cc30e31d7';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
function frozen(executable){
 const seal=read(path.join(pack,'seal.json'));assert.equal(seal.identity,IDENTITY);assert.equal(sha(JSON.stringify(seal.files)),IDENTITY);
 for(const f of seal.files)assert.equal(sha(fs.readFileSync(path.join(pack,f.path))),f.sha256,f.path);
 const plan=read(path.join(pack,'plan.json')),asar=path.join(path.dirname(executable),'resources/app.asar');
 assert.equal(sha(fs.readFileSync(asar)),plan.asarSha256);assert.equal(plan.liveAuthorized,false);
 assert.equal(sha(fs.readFileSync(executable)),'991bd6c0157954d7cb4faf8bae36545765af725cceec92c92373197c993b6a5a');
 return {plan,asar,seal,executableSha256:sha(fs.readFileSync(executable))};
}
function inside(base,file){const r=path.relative(base,file);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);}
function dependencies(executable){
 const repo=['desktop/subscription-protocol.cjs','desktop/host-process.cjs','desktop/windows-process.cjs','desktop/windows-native.cjs','desktop/model-errors.cjs','desktop/model-json.cjs','desktop/native/bin/windows-process.exe'];
 const installed=['resources/app.asar.unpacked/desktop/native/bin/windows-process.exe'];
 return [...repo.map(p=>({scope:'repo',path:p,sha256:sha(fs.readFileSync(path.join(root,p)))})),...installed.map(p=>({scope:'installed',path:p,sha256:sha(fs.readFileSync(path.join(path.dirname(executable),p)))}))];
}
module.exports={root,pack,IDENTITY,sha,read,write,frozen,inside,dependencies};
