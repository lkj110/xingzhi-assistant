'use strict';
// Offline overlay on the frozen citation candidate. No install or model entry.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {inventory}=require('./prepare-marker-candidate.cjs'),{archive}=require('./prepare-citation-candidate.cjs');
const {sha}=require('../evaluations/foundation-runner/common.cjs');
const root=path.resolve(__dirname,'..'),work=path.dirname(root),PATCH=['desktop/public-context.cjs','desktop/public-user-citations.cjs'];
const BASE='ae3d09f14c7ce325804e7c18f738e348d145fa08763b9bd421102271526a515c';
async function prepare({output,manifest}){
 const evidence=path.dirname(manifest);
 for(const p of [output,evidence]){assert.ok(path.isAbsolute(p));assert.equal(fs.realpathSync(path.dirname(p)),fs.realpathSync(work));assert.ok(!fs.existsSync(p));}
 assert.match(path.basename(output),/^foundation-candidate-bundle-export-[\w-]+$/);assert.match(path.basename(evidence),/^foundation-export-package-[\w-]+$/);assert.equal(path.basename(manifest),'package-manifest.json');
 const source=path.join(work,'foundation-candidate-bundle-citation-20261029'),original=inventory(source),baseFile=path.join(source,'resources/app.asar'),asar=require('@electron/asar');assert.equal(sha(fs.readFileSync(baseFile)),BASE);
 const before=archive(asar,baseFile),files=new Map(before.files),sourceFiles=PATCH.map(p=>({path:p,bytes:fs.readFileSync(path.join(root,p))}));
 assert.ok(files.has(PATCH[0]));assert.equal(files.has(PATCH[1]),false);
 for(const f of sourceFiles)files.set(f.path,{bytes:f.bytes,sha256:sha(f.bytes),unpacked:false});
 const streams=[...before.directories,...[...files].map(([p,f])=>({path:p,type:'file',unpacked:f.unpacked,stat:{size:f.bytes.length,mode:0o644},streamGenerator:()=>Readable.from([f.bytes])}))].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 fs.cpSync(source,output,{recursive:true,errorOnExist:true,force:false,filter:p=>p!==baseFile});const target=path.join(output,'resources/app.asar');await asar.createPackageFromStreams(target,streams);
 const after=archive(asar,target);assert.deepEqual([...after.files.keys()].sort(),[...files.keys()].sort());assert.deepEqual(after.directories,before.directories);
 for(const[p,f]of files){assert.equal(after.files.get(p).sha256,f.sha256,p);assert.equal(after.files.get(p).unpacked,f.unpacked,p);}
 const changes=[...files].filter(([p,f])=>f.sha256!==before.files.get(p)?.sha256).map(([p,f])=>({path:p,beforeSha256:before.files.get(p)?.sha256??null,sha256:f.sha256}));assert.deepEqual(changes.map(f=>f.path).sort(),PATCH.slice().sort());
 const outer=inventory(output);assert.deepEqual(outer.map(f=>f.path),original.map(f=>f.path));assert.deepEqual(outer.filter((f,i)=>f.sha256!==original[i].sha256).map(f=>f.path),['resources/app.asar']);assert.deepEqual(inventory(source),original);
 for(const f of sourceFiles)assert.equal(sha(fs.readFileSync(path.join(root,f.path))),sha(f.bytes));
 const result={schema:1,kind:'offline-public-citation-export-candidate',createdAt:new Date().toISOString(),sourceCodeCommit:'c28a0e9ac5eafa90223e710cfb53ebb8fdec6f00',candidateInstalled:false,realModelCalls:0,baseCandidateUnchanged:true,baseCandidateAsarSha256:BASE,asarSha256:sha(fs.readFileSync(target)),executableSha256:outer.find(f=>f.path==='XingzhiAssistant.exe').sha256,groundingSha256:files.get('desktop/grounding.cjs').sha256,sourceGroundingSha256:sha(fs.readFileSync(path.join(root,'desktop/grounding.cjs'))),helperSha256:outer.find(f=>f.path==='resources/app.asar.unpacked/desktop/native/bin/windows-process.exe').sha256,files:outer,archiveFilesVerified:after.files.size,archiveChanges:changes,outerChangedFiles:['resources/app.asar']};
 assert.equal(result.groundingSha256,result.sourceGroundingSha256);fs.mkdirSync(evidence);fs.writeFileSync(manifest,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {manifest,output,asarSha256:result.asarSha256,archiveFilesVerified:result.archiveFilesVerified,archiveChanges:changes.map(f=>f.path),realModelCalls:0};
}
module.exports={prepare,PATCH};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},manifest:{type:'string'}}});prepare(values).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
