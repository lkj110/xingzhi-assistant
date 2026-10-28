'use strict';
// Bounded, offline candidate construction. This does not install or launch an
// application, modify the frozen bundle, discover credentials, or call a model.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const root=path.resolve(__dirname,'..'),work=path.dirname(root),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const SOURCE_COMMIT='0d448e264c87a6e65638b330141408335c33c6c1';
const BASE_ASAR='56916f8062b2384df6de2fbb3a8d976b9ae8bf6c7e4ff0c29f8d841ed0c5b1af';
const EXE='991bd6c0157954d7cb4faf8bae36545765af725cceec92c92373197c993b6a5a';
const REVIEW_SHA='4cb926d8e0751b3d1407f9040ebcedda7995e8ac12f4ba85e27da22558d0f62d';
const PATCH_FILES=['desktop/acceptance.cjs','desktop/agent.cjs','desktop/continuation-control.cjs','desktop/core.cjs','desktop/execution-control.cjs','desktop/execution-facts.cjs','desktop/grounding.cjs','desktop/marker-confirmation.cjs'];
const git=args=>cp.execFileSync('git',args,{cwd:root,windowsHide:true});
const normalized=p=>p.replaceAll('\\','/');
function inventory(directory){const result=[];function walk(current){for(const entry of fs.readdirSync(current,{withFileTypes:true})){const file=path.join(current,entry.name);assert.ok(!entry.isSymbolicLink(),'Links are not accepted');if(entry.isDirectory())walk(file);else{assert.ok(entry.isFile());result.push({path:normalized(path.relative(directory,file)),sha256:sha(fs.readFileSync(file))});}}}walk(directory);return result.sort((a,b)=>a.path.localeCompare(b.path,'en'));}
function assertPaths({executable,output,manifest}){
 for(const p of [executable,output,manifest])assert.ok(typeof p==='string'&&path.isAbsolute(p),'Paths must be absolute');
 const actualWork=fs.realpathSync.native(work),out=path.resolve(output),evidence=path.dirname(path.resolve(manifest));
 assert.equal(fs.realpathSync.native(path.dirname(out)),actualWork,'Candidate must be an immediate sibling directory');
 assert.match(path.basename(out),/^foundation-candidate-bundle-marker-[a-zA-Z0-9-]+$/);
 assert.ok(!fs.existsSync(out),'Candidate output must be new');
 assert.equal(fs.realpathSync.native(path.dirname(evidence)),actualWork,'Evidence must be an immediate sibling directory');
 assert.match(path.basename(evidence),/^foundation-marker-package-[a-zA-Z0-9-]+$/);
 assert.equal(path.basename(manifest),'package-manifest.json');
 if(fs.existsSync(evidence))assert.equal(fs.realpathSync.native(evidence),evidence,'Evidence directory cannot be a link or alias');
 assert.ok(!fs.existsSync(manifest),'Manifest must be new');assert.ok(!fs.existsSync(path.join(evidence,'dist')),'Build output must be new');assert.ok(!fs.existsSync(path.join(evidence,'build.log')),'Build log must be new');
 const source=path.dirname(fs.realpathSync.native(executable));
 assert.equal(source,fs.realpathSync.native(path.join(work,'foundation-candidate-bundle-notice-20261028')),'Only the frozen notice candidate is accepted');
 assert.notEqual(source,out);assert.equal(path.basename(executable),'XingzhiAssistant.exe');
 return {source,out,evidence};
}
function reviewedSources(){
 const reviewPath='docs/evidence/foundation-marker-confirmation-review.json',reviewBytes=fs.readFileSync(path.join(root,reviewPath));assert.equal(sha(reviewBytes),REVIEW_SHA,'Independent review drift');
 const review=JSON.parse(reviewBytes);assert.equal(review.approvedForUpload,true);
 const actualPatch=git(['diff','--name-only','30dceb8',SOURCE_COMMIT,'--','desktop']).toString().trim().split(/\r?\n/).sort();assert.deepEqual(actualPatch,PATCH_FILES.slice().sort());
 const scopes=['desktop','src','public','index.html','vite.config.mjs','package.json','package-lock.json'];
 // Git applies the repository's clean filters for normal Windows line endings.
 // Reviewed patch bytes below remain exact; both checkout and committed byte
 // identities are recorded for other inputs (including unused native sources).
 git(['diff','--exit-code',SOURCE_COMMIT,'--',...scopes]);
 assert.equal(git(['ls-files','--others','--','src','public']).toString().trim(),'','Untracked frontend inputs are not accepted');
 const files=git(['ls-tree','-r','--name-only',SOURCE_COMMIT,'--',...scopes]).toString().trim().split(/\r?\n/).filter(Boolean);
 const sourceMap=new Map();for(const file of files){const current=fs.readFileSync(path.join(root,file)),committed=git(['show',SOURCE_COMMIT+':'+file]);sourceMap.set(file,{bytes:current,sha256:sha(current),commitBytesSha256:sha(committed)});}
 for(const file of [...PATCH_FILES,'src/App.jsx','src/MarkerConfirmation.jsx','src/MarkerConfirmation.css']){const reviewed=review.reviewedFiles.find(r=>r.path===file);assert.ok(reviewed,'Missing reviewed build input: '+file);assert.equal(sourceMap.get(file)?.sha256,reviewed.sha256,file);}
 return sourceMap;
}
function archiveFiles(asar,archive){
 const raw=fs.readFileSync(archive),header=asar.getRawHeader(archive).headerSize,result=new Map(),directories=[];
 for(const p of asar.listPackage(archive).map(p=>normalized(p.replace(/^[\\/]+/,'')))){
  assert.ok(p&&!p.split('/').some(s=>s==='..'||s==='.')&&!path.isAbsolute(p),'Unsafe archive path');
  const info=asar.statFile(archive,path.normalize(p),false);assert.ok(!info.link&&!info.executable,'Unexpected archive link or executable metadata');
  if(info.files){directories.push({path:p,type:'directory',unpacked:!!info.unpacked});continue;}
  const bytes=info.unpacked?fs.readFileSync(path.join(archive+'.unpacked',p)):raw.subarray(8+header+Number(info.offset||0),8+header+Number(info.offset||0)+info.size);assert.equal(bytes.length,info.size,p);
  result.set(p,{bytes,sha256:sha(bytes),unpacked:!!info.unpacked});
 }
 return {files:result,directories};
}
async function prepare(options){
 assert.equal(process.platform,'win32');const {source,out,evidence}=assertPaths(options),sourceAsar=path.join(source,'resources/app.asar');
 assert.equal(sha(fs.readFileSync(options.executable)),EXE);assert.equal(sha(fs.readFileSync(sourceAsar)),BASE_ASAR);
 const sourceMap=reviewedSources(),original=inventory(source),asar=require('@electron/asar'),before=archiveFiles(asar,sourceAsar);
 // Every packaged desktop source other than the exact reviewed patch must
 // already match the pinned commit. Native binaries retain the frozen bytes.
 for(const [p,f]of before.files)if(p.startsWith('desktop/')&&sourceMap.has(p)&&!PATCH_FILES.includes(p))assert.equal(f.sha256,sourceMap.get(p).sha256,'Unexpected base/source divergence: '+p);
 const packagedMetadata=JSON.parse(before.files.get('package.json').bytes),sourceMetadata=JSON.parse(sourceMap.get('package.json').bytes);
 // Electron Packager omits development-only metadata; retain the frozen
 // packaged bytes and independently compare every remaining runtime field.
 for(const key of ['private','scripts','devDependencies'])delete sourceMetadata[key];
 assert.deepEqual(packagedMetadata,sourceMetadata,'Packaged runtime metadata differs from pinned source');
 fs.mkdirSync(evidence,{recursive:true});
 const build=cp.spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',path.join(evidence,'dist')],{cwd:root,windowsHide:true,encoding:'utf8',env:{...process.env,NO_COLOR:'1'}});
 fs.writeFileSync(path.join(evidence,'build.log'),String(build.stdout||'')+String(build.stderr||''),{flag:'wx'});assert.equal(build.error,undefined);assert.equal(build.status,0,'Frontend build failed');
 const built=inventory(path.join(evidence,'dist'));assert.ok(built.some(f=>f.path==='index.html'));assert.ok(built.some(f=>f.path.endsWith('.js')));assert.ok(built.some(f=>f.path.endsWith('.css')));
 const files=new Map([...before.files].filter(([p])=>!p.startsWith('dist/')));
 for(const p of PATCH_FILES)files.set(p,{...sourceMap.get(p),unpacked:false});
 for(const f of built){const p='dist/'+f.path;files.set(p,{bytes:fs.readFileSync(path.join(evidence,p)),sha256:f.sha256,unpacked:false});}
 const directories=new Map(before.directories.filter(d=>d.path!=='dist'&&!d.path.startsWith('dist/')).map(d=>[d.path,d]));
 for(const p of files.keys()){let parent=path.posix.dirname(p);while(parent!=='.'){if(!directories.has(parent))directories.set(parent,{path:parent,type:'directory',unpacked:false});parent=path.posix.dirname(parent);}}
 const streams=[...directories.values(),...[...files].map(([p,f])=>({path:p,type:'file',unpacked:f.unpacked,stat:{size:f.bytes.length,mode:0o644},streamGenerator:()=>Readable.from([f.bytes])}))].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 fs.cpSync(source,out,{recursive:true,errorOnExist:true,force:false,filter:p=>p!==sourceAsar});
 const archive=path.join(out,'resources/app.asar');await asar.createPackageFromStreams(archive,streams);
 const after=archiveFiles(asar,archive);assert.deepEqual([...after.files.keys()].sort(),[...files.keys()].sort());assert.deepEqual(after.directories.map(d=>d.path).sort(),[...directories.keys()].sort());
 for(const [p,f]of files){assert.equal(after.files.get(p).sha256,f.sha256,p);assert.equal(after.files.get(p).unpacked,!!f.unpacked,p);}
 const outer=inventory(out);assert.deepEqual(outer.map(f=>f.path),original.map(f=>f.path));assert.deepEqual(outer.filter((f,i)=>f.sha256!==original[i].sha256).map(f=>f.path),['resources/app.asar']);assert.deepEqual(inventory(source),original,'Frozen source bundle changed');
 // Detect build-time edits, not only stale inputs checked before invoking Vite.
 for(const [p,f]of sourceMap)assert.equal(sha(fs.readFileSync(path.join(root,p))),f.sha256,'Build input changed: '+p);
 const changes=[...new Set([...before.files.keys(),...after.files.keys()])].sort().filter(p=>before.files.get(p)?.sha256!==after.files.get(p)?.sha256).map(p=>({path:p,kind:!before.files.has(p)?'added':!after.files.has(p)?'removed':'modified',beforeSha256:before.files.get(p)?.sha256||null,sha256:after.files.get(p)?.sha256||null}));
 assert.deepEqual(changes.filter(f=>!f.path.startsWith('dist/')).map(f=>f.path),PATCH_FILES.slice().sort());
 const result={schema:1,kind:'isolated-marker-confirmation-candidate',createdAt:new Date().toISOString(),sourceCommit:SOURCE_COMMIT,sourceReviewSha256:REVIEW_SHA,version:JSON.parse(sourceMap.get('package.json').bytes).version,platform:'win32',arch:'x64',candidateInstalled:false,applicationLaunched:false,realModelCalls:0,baseCandidateUnchanged:true,
  executableSha256:EXE,baseCandidateAsarSha256:BASE_ASAR,asarSha256:sha(fs.readFileSync(archive)),groundingSha256:after.files.get('desktop/grounding.cjs').sha256,markerConfirmationSha256:after.files.get('desktop/marker-confirmation.cjs').sha256,helperSha256:sha(fs.readFileSync(path.join(out,'resources/app.asar.unpacked/desktop/native/bin/windows-process.exe'))),outerChangedFiles:['resources/app.asar'],archiveFilesVerified:after.files.size,archiveChanges:changes,files:outer,
  sourceFiles:[...sourceMap].map(([path,f])=>({path,sha256:f.sha256,commitBytesSha256:f.commitBytesSha256})),frontendBuild:{node:process.version,buildLogSha256:sha(fs.readFileSync(path.join(evidence,'build.log'))),files:built},archiveInventory:[...after.files].map(([path,f])=>({path,sha256:f.sha256,unpacked:f.unpacked}))};
 fs.writeFileSync(options.manifest,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output:out,manifest:options.manifest,asarSha256:result.asarSha256,archiveFilesVerified:result.archiveFilesVerified,outerFiles:outer.length,archiveChanges:changes.map(c=>c.path),realModelCalls:0}));return result;
}
module.exports={prepare,assertPaths,reviewedSources,inventory,PATCH_FILES,SOURCE_COMMIT};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'},manifest:{type:'string'}}});prepare(values).catch(e=>{console.error(e.stack);process.exitCode=1;});}
