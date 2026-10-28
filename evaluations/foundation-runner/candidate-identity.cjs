'use strict';
// Sealed, portable package hashes only. This module never builds, installs or
// launches a package, and the caller selects one fixed candidate sample pack.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function verify(executable,manifest,{complete=false,sourceRoot=path.resolve(__dirname,'../..')}={}){
 assert.equal(manifest?.schema,1);const directory=fs.realpathSync.native(path.dirname(executable));
 for(const key of ['executableSha256','asarSha256','groundingSha256','helperSha256','sourceGroundingSha256'])assert.match(manifest[key],/^[a-f0-9]{64}$/);
 assert.equal(manifest.groundingSha256,manifest.sourceGroundingSha256);
 assert.equal(sha(fs.readFileSync(path.join(sourceRoot,'desktop/grounding.cjs'))),manifest.sourceGroundingSha256,'Candidate source changed');
 assert.ok(Array.isArray(manifest.files)&&manifest.files.length>0);const names=manifest.files.map(f=>f.path);
 assert.equal(new Set(names).size,names.length,'Duplicate package file');
 const file=(relative)=>{
  assert.ok(typeof relative==='string'&&relative.length>0&&!relative.includes('\\')&&!path.isAbsolute(relative));
  assert.ok(relative.split('/').every(part=>part&&part!=='.'&&part!=='..'));
  const result=path.resolve(directory,relative),resolved=fs.realpathSync.native(result),within=path.relative(directory,resolved);
  assert.ok(within&&!within.startsWith('..')&&!path.isAbsolute(within),'Package file escaped root');
  assert.ok(fs.lstatSync(result).isFile()&&!fs.lstatSync(result).isSymbolicLink(),'Package file must be ordinary');return result;
 };
 for(const row of manifest.files){file(row.path);assert.match(row.sha256,/^[a-f0-9]{64}$/);}
 const core=[['XingzhiAssistant.exe','executableSha256'],['resources/app.asar','asarSha256'],['resources/app.asar.unpacked/desktop/native/bin/windows-process.exe','helperSha256']];
 assert.equal(fs.realpathSync.native(executable),file('XingzhiAssistant.exe'));
 for(const [name,key] of core){const row=manifest.files.find(f=>f.path===name);assert.ok(row,'Missing core package file');assert.equal(row.sha256,manifest[key]);assert.equal(sha(fs.readFileSync(file(name))),manifest[key],name);}
 if(complete){
  const inventory=[];const walk=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){assert.ok(!entry.isSymbolicLink(),'Package links forbidden');const p=path.join(directory,entry.name);if(entry.isDirectory())walk(p);else {assert.ok(entry.isFile());inventory.push(path.relative(path.dirname(executable),p).replace(/\\/g,'/'));}}};walk(path.dirname(executable));
  assert.deepEqual(inventory.sort(),[...names].sort(),'Package inventory changed');
  for(const row of manifest.files)assert.equal(sha(fs.readFileSync(file(row.path))),row.sha256,row.path);
 }
 return {executableSha256:manifest.executableSha256,asarSha256:manifest.asarSha256,groundingSha256:manifest.groundingSha256,helperSha256:manifest.helperSha256,files:manifest.files.length,complete};
}
module.exports={verify};
