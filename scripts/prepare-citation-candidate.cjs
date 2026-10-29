'use strict';
// Isolated offline candidate; never installs, overwrites, or invokes a model.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process'),{Readable}=require('node:stream');
const {inventory}=require('./prepare-marker-candidate.cjs'),{sha}=require('../evaluations/foundation-runner/common.cjs');
const root=path.resolve(__dirname,'..'),work=path.dirname(root),PATCH=['desktop/citation-fields.cjs','desktop/grounding.cjs','desktop/check-finalization.cjs','desktop/generation-context.cjs'];
const BASE='982717eb093bf7606804abc88f17a45ecd0a6b32b6337e7b185638c6109016a3';
function archive(asar,file){
 const raw=fs.readFileSync(file),header=asar.getRawHeader(file).headerSize,files=new Map(),directories=[];
 for(const name of asar.listPackage(file)){
  const p=name.replaceAll('\\','/').replace(/^\//,'');assert.ok(p&&!p.split('/').some(x=>x==='.'||x==='..')&&!path.isAbsolute(p));
  const item=asar.statFile(file,path.normalize(p),false);assert.ok(!item.link&&!item.executable);
  if(item.files){directories.push({path:p,type:'directory',unpacked:!!item.unpacked});continue;}
  const bytes=item.unpacked?fs.readFileSync(path.join(file+'.unpacked',p)):raw.subarray(8+header+Number(item.offset||0),8+header+Number(item.offset||0)+item.size);assert.equal(bytes.length,item.size);
  files.set(p,{bytes,sha256:sha(bytes),unpacked:!!item.unpacked});
 }return {files,directories};
}
function sources(){return [...inventory(path.join(root,'src')).map(r=>({...r,path:'src/'+r.path})),...inventory(path.join(root,'public')).map(r=>({...r,path:'public/'+r.path})),...['index.html','vite.config.mjs','package.json','package-lock.json',...PATCH].map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))}))];}
async function prepare({output,manifest}){
 for(const p of [output,manifest])assert.ok(path.isAbsolute(p));const evidence=path.dirname(manifest);
 for(const p of [output,evidence]){assert.equal(fs.realpathSync.native(path.dirname(p)),fs.realpathSync.native(work));assert.ok(!fs.existsSync(p));}
 assert.match(path.basename(output),/^foundation-candidate-bundle-citation-[\w-]+$/);assert.match(path.basename(evidence),/^foundation-citation-package-[\w-]+$/);assert.equal(path.basename(manifest),'package-manifest.json');
 const source=path.join(work,'foundation-candidate-bundle-recheck-20261029'),original=inventory(source),baseFile=path.join(source,'resources/app.asar'),asar=require('@electron/asar');assert.equal(sha(fs.readFileSync(baseFile)),BASE);
 const inputs=sources(),before=archive(asar,baseFile),files=new Map(before.files),sourceFiles=PATCH.map(p=>({path:p,bytes:fs.readFileSync(path.join(root,p))}));
 fs.mkdirSync(evidence);const dist=path.join(evidence,'dist'),build=cp.spawnSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--outDir',dist],{cwd:root,windowsHide:true,encoding:'utf8'});
 fs.writeFileSync(path.join(evidence,'build.log'),(build.stdout||'')+(build.stderr||''),{flag:'wx'});assert.equal(build.status,0,'Frontend build failed');
 for(const p of files.keys())if(p.startsWith('dist/'))files.delete(p);
 for(const r of inventory(dist))sourceFiles.push({path:'dist/'+r.path,bytes:fs.readFileSync(path.join(dist,r.path))});
 for(const f of sourceFiles)files.set(f.path,{bytes:f.bytes,sha256:sha(f.bytes),unpacked:false});
 const directories=new Map(before.directories.map(d=>[d.path,d]));for(const p of files.keys()){let d=path.posix.dirname(p);while(d!=='.'){if(!directories.has(d))directories.set(d,{path:d,type:'directory',unpacked:false});d=path.posix.dirname(d);}}
 const streams=[...directories.values(),...[...files].map(([p,f])=>({path:p,type:'file',unpacked:f.unpacked,stat:{size:f.bytes.length,mode:0o644},streamGenerator:()=>Readable.from([f.bytes])}))].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 fs.cpSync(source,output,{recursive:true,errorOnExist:true,force:false,filter:p=>p!==baseFile});const target=path.join(output,'resources/app.asar');await asar.createPackageFromStreams(target,streams);
 const after=archive(asar,target);assert.deepEqual([...after.files.keys()].sort(),[...files.keys()].sort());
 for(const [p,f]of files){assert.equal(after.files.get(p).sha256,f.sha256,p);assert.equal(after.files.get(p).unpacked,f.unpacked,p);}
 const changes=[...new Set([...before.files.keys(),...files.keys()])].filter(p=>before.files.get(p)?.sha256!==files.get(p)?.sha256).map(p=>({path:p,beforeSha256:before.files.get(p)?.sha256??null,sha256:files.get(p)?.sha256??null}));
 assert.deepEqual(changes.filter(f=>!f.path.startsWith('dist/')).map(f=>f.path).sort(),PATCH.slice().sort());
 const outer=inventory(output);assert.deepEqual(outer.map(f=>f.path),original.map(f=>f.path));assert.deepEqual(outer.filter((f,i)=>f.sha256!==original[i].sha256).map(f=>f.path),['resources/app.asar']);assert.deepEqual(inventory(source),original);assert.deepEqual(sources(),inputs);
 const result={schema:1,kind:'offline-citation-field-candidate',createdAt:new Date().toISOString(),candidateInstalled:false,realModelCalls:0,baseCandidateUnchanged:true,baseCandidateAsarSha256:BASE,asarSha256:sha(fs.readFileSync(target)),executableSha256:outer.find(f=>f.path==='XingzhiAssistant.exe').sha256,groundingSha256:files.get('desktop/grounding.cjs').sha256,sourceGroundingSha256:sha(fs.readFileSync(path.join(root,'desktop/grounding.cjs'))),helperSha256:outer.find(f=>f.path==='resources/app.asar.unpacked/desktop/native/bin/windows-process.exe').sha256,files:outer,sourceInputs:inputs,archiveFilesVerified:after.files.size,archiveChanges:changes,outerChangedFiles:['resources/app.asar']};
 fs.writeFileSync(manifest,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {manifest,output,asarSha256:result.asarSha256,archiveFilesVerified:result.archiveFilesVerified,archiveChanges:changes.map(f=>f.path),realModelCalls:0};
}
module.exports={prepare,PATCH,archive};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},manifest:{type:'string'}}});prepare(values).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
