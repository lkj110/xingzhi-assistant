'use strict';
// Offline, separate candidate only. Keep every frozen outer/archive byte except
// the three explicit protocol modules; no frontend build, install or transport.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {inventory}=require('./prepare-marker-candidate.cjs'),{sha}=require('../evaluations/foundation-runner/common.cjs');
const root=path.resolve(__dirname,'..'),work=path.dirname(root),PATCH=['desktop/check-finalization.cjs','desktop/generation-context.cjs','desktop/marker-confirmation.cjs'];
const BASE='9fe3cc8b865a37fa063fec7cce7158e4e9a07f682f6556fd08a844f6e89dec2b';
function archive(asar,file){
 const raw=fs.readFileSync(file),header=asar.getRawHeader(file).headerSize,files=new Map(),directories=[];
 for(const name of asar.listPackage(file)){
  const p=name.replaceAll('\\','/').replace(/^\//,'');assert.ok(p&&!p.split('/').some(x=>x==='.'||x==='..')&&!path.isAbsolute(p));
  const item=asar.statFile(file,path.normalize(p),false);assert.ok(!item.link&&!item.executable);
  if(item.files){directories.push({path:p,type:'directory',unpacked:!!item.unpacked});continue;}
  const bytes=item.unpacked?fs.readFileSync(path.join(file+'.unpacked',p)):raw.subarray(8+header+Number(item.offset||0),8+header+Number(item.offset||0)+item.size);assert.equal(bytes.length,item.size);
  files.set(p,{bytes,sha256:sha(bytes),unpacked:!!item.unpacked});
 }
 return {files,directories};
}
async function prepare({output,manifest}){
 for(const p of [output,manifest])assert.ok(path.isAbsolute(p));
 assert.equal(fs.realpathSync.native(path.dirname(output)),fs.realpathSync.native(work));assert.match(path.basename(output),/^foundation-candidate-bundle-recheck-[\w-]+$/);assert.ok(!fs.existsSync(output));
 const evidence=path.dirname(manifest);assert.equal(fs.realpathSync.native(path.dirname(evidence)),fs.realpathSync.native(work));assert.match(path.basename(evidence),/^foundation-recheck-package-[\w-]+$/);assert.ok(!fs.existsSync(evidence));assert.equal(path.basename(manifest),'package-manifest.json');
 const source=path.join(work,'foundation-candidate-bundle-marker-20261028'),original=inventory(source),baseFile=path.join(source,'resources/app.asar'),asar=require('@electron/asar');assert.equal(sha(fs.readFileSync(baseFile)),BASE);
 const before=archive(asar,baseFile),files=new Map(before.files),sourceFiles=PATCH.map(p=>({path:p,bytes:fs.readFileSync(path.join(root,p))}));
 for(const f of sourceFiles){assert.ok(files.has(f.path));files.set(f.path,{bytes:f.bytes,sha256:sha(f.bytes),unpacked:false});}
 const streams=[...before.directories,...[...files].map(([p,f])=>({path:p,type:'file',unpacked:f.unpacked,stat:{size:f.bytes.length,mode:0o644},streamGenerator:()=>Readable.from([f.bytes])}))].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 fs.cpSync(source,output,{recursive:true,errorOnExist:true,force:false,filter:p=>p!==baseFile});const target=path.join(output,'resources/app.asar');await asar.createPackageFromStreams(target,streams);
 const after=archive(asar,target);assert.deepEqual([...after.files.keys()].sort(),[...files.keys()].sort());assert.deepEqual(after.directories,before.directories);
 for(const [p,f]of files){assert.equal(after.files.get(p).sha256,f.sha256,p);assert.equal(after.files.get(p).unpacked,f.unpacked,p);}
 const changes=[...files].filter(([p,f])=>f.sha256!==before.files.get(p).sha256).map(([p,f])=>({path:p,beforeSha256:before.files.get(p).sha256,sha256:f.sha256}));assert.deepEqual(changes.map(f=>f.path).sort(),PATCH.slice().sort());
 const outer=inventory(output);assert.deepEqual(outer.map(f=>f.path),original.map(f=>f.path));assert.deepEqual(outer.filter((f,i)=>f.sha256!==original[i].sha256).map(f=>f.path),['resources/app.asar']);assert.deepEqual(inventory(source),original);
 for(const f of sourceFiles)assert.equal(sha(fs.readFileSync(path.join(root,f.path))),sha(f.bytes));
 const result={schema:1,kind:'offline-recheck-candidate',createdAt:new Date().toISOString(),candidateInstalled:false,realModelCalls:0,baseCandidateUnchanged:true,baseCandidateAsarSha256:BASE,asarSha256:sha(fs.readFileSync(target)),executableSha256:outer.find(f=>f.path==='XingzhiAssistant.exe').sha256,groundingSha256:files.get('desktop/grounding.cjs').sha256,sourceGroundingSha256:sha(fs.readFileSync(path.join(root,'desktop/grounding.cjs'))),helperSha256:outer.find(f=>f.path==='resources/app.asar.unpacked/desktop/native/bin/windows-process.exe').sha256,files:outer,archiveFilesVerified:after.files.size,archiveChanges:changes,outerChangedFiles:['resources/app.asar']};
 assert.equal(result.groundingSha256,result.sourceGroundingSha256);fs.mkdirSync(evidence);fs.writeFileSync(manifest,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {manifest,output,asarSha256:result.asarSha256,archiveFilesVerified:result.archiveFilesVerified,archiveChanges:changes.map(f=>f.path),realModelCalls:0};
}
module.exports={prepare,PATCH};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},manifest:{type:'string'}}});prepare(values).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
