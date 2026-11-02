'use strict';
// A new isolated package. No installation, model CLI or base-package writes.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {inventory}=require('./prepare-marker-candidate.cjs'),{archive}=require('./prepare-citation-candidate.cjs'),{sha}=require('../evaluations/foundation-runner/common.cjs');
const root=path.resolve(__dirname,'..'),work=path.dirname(root);
const SOURCE='ca9419e0786be67b6cb35143042f44dd676dd434',BASE='6dfc43b3bcae1f99aa9188e1fd857a5e16ff1942454a69e2b15e1c0b31061de6',F04='958928ee84007b689bb605dc2252591c582c291aae3f22731fa073e96bb9f62e';
const PATCH=['desktop/body-structure.cjs'],PRODUCT=['desktop/acceptance.cjs','desktop/body-structure.cjs','desktop/core.cjs','desktop/generation-context.cjs','desktop/grounding.cjs'];
function verifyArchiveDelta(before,after,inputs){
 assert.deepEqual(inputs.map(r=>r.path).sort(),PATCH);assert.ok(before.files.has(PATCH[0]));
 const expected=new Map(before.files);for(const f of inputs)expected.set(f.path,{bytes:f.bytes,sha256:sha(f.bytes),unpacked:false});
 assert.deepEqual([...after.files.keys()].sort(),[...expected.keys()].sort());assert.deepEqual(after.directories,before.directories);
 for(const [p,f]of expected){assert.equal(after.files.get(p).sha256,f.sha256,p);assert.equal(after.files.get(p).unpacked,f.unpacked,p);}
 const changes=[...expected].filter(([p,f])=>f.sha256!==before.files.get(p)?.sha256).map(([p,f])=>({path:p,beforeSha256:before.files.get(p).sha256,sha256:f.sha256}));assert.deepEqual(changes.map(f=>f.path).sort(),PATCH);return changes;
}
async function prepare({output,manifest}){
 for(const p of [output,manifest])assert.ok(typeof p==='string'&&path.isAbsolute(p));
 const evidence=path.dirname(manifest);for(const p of [output,evidence]){assert.equal(fs.realpathSync.native(path.dirname(p)),fs.realpathSync.native(work));assert.ok(!fs.existsSync(p),'Output must be new');}
 assert.match(path.basename(output),/^foundation-candidate-bundle-title-[\w-]+$/);assert.match(path.basename(evidence),/^foundation-title-package-[\w-]+$/);assert.equal(path.basename(manifest),'package-manifest.json');
 const source=path.join(work,'foundation-candidate-bundle-body-20261102'),original=inventory(source),baseFile=path.join(source,'resources/app.asar'),asar=require('@electron/asar');assert.equal(sha(fs.readFileSync(baseFile)),BASE);
 const before=archive(asar,baseFile),files=new Map(before.files),product=PRODUCT.map(p=>({path:p,bytes:fs.readFileSync(path.join(root,p))}));
 for(const f of product){assert.equal(sha(f.bytes),sha(cp.execFileSync('git',['show',SOURCE+':'+f.path],{cwd:root,windowsHide:true})),f.path+' differs from reviewed source');if(!PATCH.includes(f.path))assert.equal(before.files.get(f.path).sha256,sha(f.bytes),f.path+' inherited runtime drift');}
 const inputs=product.filter(f=>PATCH.includes(f.path));for(const f of inputs)files.set(f.path,{bytes:f.bytes,sha256:sha(f.bytes),unpacked:false});
 const streams=[...before.directories,...[...files].map(([p,f])=>({path:p,type:'file',unpacked:f.unpacked,stat:{size:f.bytes.length,mode:0o644},streamGenerator:()=>Readable.from([f.bytes])}))].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 fs.cpSync(source,output,{recursive:true,errorOnExist:true,force:false,filter:p=>p!==baseFile});const target=path.join(output,'resources/app.asar');await asar.createPackageFromStreams(target,streams);
 const after=archive(asar,target),changes=verifyArchiveDelta(before,after,inputs),outer=inventory(output);
 assert.deepEqual(outer.map(f=>f.path),original.map(f=>f.path));assert.deepEqual(outer.filter((f,i)=>f.sha256!==original[i].sha256).map(f=>f.path),['resources/app.asar']);assert.deepEqual(inventory(source),original);
 for(const f of product){assert.equal(sha(fs.readFileSync(path.join(root,f.path))),sha(f.bytes));assert.equal(after.files.get(f.path).sha256,sha(f.bytes));}
 const result={schema:1,kind:'offline-title-contract-candidate',createdAt:new Date().toISOString(),sourceCodeCommit:SOURCE,candidateInstalled:false,realModelCalls:0,baseCandidateUnchanged:true,baseCandidateAsarSha256:BASE,asarSha256:sha(fs.readFileSync(target)),executableSha256:outer.find(f=>f.path==='XingzhiAssistant.exe').sha256,groundingSha256:files.get('desktop/grounding.cjs').sha256,sourceGroundingSha256:sha(fs.readFileSync(path.join(root,'desktop/grounding.cjs'))),helperSha256:outer.find(f=>f.path==='resources/app.asar.unpacked/desktop/native/bin/windows-process.exe').sha256,sourceModules:product.map(f=>({path:f.path,sha256:sha(f.bytes)})),files:outer,archiveFilesVerified:after.files.size,archiveChanges:changes,outerChangedFiles:['resources/app.asar'],f04:{historicalHumanWorkflowCompleted:true,historicalAsarSha256:F04,currentCandidateHumanWorkflowTested:false,rerun:false}};
 fs.mkdirSync(evidence);fs.writeFileSync(manifest,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {manifest,output,asarSha256:result.asarSha256,archiveFilesVerified:result.archiveFilesVerified,archiveChanges:changes.map(f=>f.path),realModelCalls:0};
}
module.exports={prepare,verifyArchiveDelta,PATCH,PRODUCT,SOURCE,BASE,F04};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},manifest:{type:'string'}}});prepare(values).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
