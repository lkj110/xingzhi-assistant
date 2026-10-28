'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {verify}=require('./candidate-identity.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
 const temp=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temp,'foundation-candidate-identity-')),bundle=path.join(directory,'bundle'),sourceRoot=path.join(directory,'source');
 t.after(()=>{assert.ok(path.resolve(directory).startsWith(temp+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:20});});
 const content={'XingzhiAssistant.exe':'SYNTHETIC NOT EXECUTABLE','resources/app.asar':'SYNTHETIC NOT ASAR','resources/app.asar.unpacked/desktop/native/bin/windows-process.exe':'SYNTHETIC HELPER','runtime.dll':'SYNTHETIC DLL'};
 for(const [name,value]of Object.entries(content)){const f=path.join(bundle,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,value);}
 fs.mkdirSync(path.join(sourceRoot,'desktop'),{recursive:true});fs.writeFileSync(path.join(sourceRoot,'desktop/grounding.cjs'),'SYNTHETIC SOURCE');
 const manifest={schema:1,executableSha256:sha(content['XingzhiAssistant.exe']),asarSha256:sha(content['resources/app.asar']),groundingSha256:sha('SYNTHETIC SOURCE'),sourceGroundingSha256:sha('SYNTHETIC SOURCE'),helperSha256:sha(content['resources/app.asar.unpacked/desktop/native/bin/windows-process.exe']),files:Object.entries(content).map(([p,b])=>({path:p,sha256:sha(b)}))};
 return {directory,bundle,sourceRoot,manifest,executable:path.join(bundle,'XingzhiAssistant.exe')};
}
test('candidate core and complete bundle identities are checked without launching anything',t=>{
 const f=fixture(t);assert.equal(verify(f.executable,f.manifest,{sourceRoot:f.sourceRoot}).complete,false);
 assert.equal(verify(f.executable,f.manifest,{sourceRoot:f.sourceRoot,complete:true}).files,4);
});
test('candidate core replacement, source drift and missing core manifest entry fail',t=>{
 const f=fixture(t),options={sourceRoot:f.sourceRoot};
 for(const key of ['executableSha256','asarSha256','groundingSha256','helperSha256','sourceGroundingSha256']){const manifest=structuredClone(f.manifest);manifest[key]='0'.repeat(64);assert.throws(()=>verify(f.executable,manifest,options),key);}
 const manifest=structuredClone(f.manifest);manifest.files=manifest.files.filter(r=>r.path!=='XingzhiAssistant.exe');assert.throws(()=>verify(f.executable,manifest,options),/Missing core/);
 fs.writeFileSync(path.join(f.bundle,'resources/app.asar'),'replaced');assert.throws(()=>verify(f.executable,f.manifest,options));
});
test('complete package verification rejects extra inventory and non-core content mutation',t=>{
 const f=fixture(t),options={sourceRoot:f.sourceRoot,complete:true};fs.writeFileSync(path.join(f.bundle,'extra.dll'),'unsealed');assert.throws(()=>verify(f.executable,f.manifest,options),/inventory changed/);
 fs.unlinkSync(path.join(f.bundle,'extra.dll'));fs.writeFileSync(path.join(f.bundle,'runtime.dll'),'changed');assert.throws(()=>verify(f.executable,f.manifest,options),/runtime.dll/);
});
test('candidate manifest disallows duplicated, absolute, parent and ambiguous path spellings',t=>{
 const f=fixture(t),options={sourceRoot:f.sourceRoot,complete:true};
 const duplicate=structuredClone(f.manifest);duplicate.files.push(duplicate.files[0]);assert.throws(()=>verify(f.executable,duplicate,options),/Duplicate/);
 for(const p of ['../outside','/absolute','resources/../runtime.dll','resources\\app.asar','./runtime.dll']){const m=structuredClone(f.manifest);m.files.push({path:p,sha256:'0'.repeat(64)});assert.throws(()=>verify(f.executable,m,options),p);}
});
