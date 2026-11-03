'use strict';
// Offline overlay of exactly two reviewed modules. Never starts an application.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {inventory}=require('./prepare-marker-candidate.cjs');
const {archive}=require('./prepare-citation-candidate.cjs');
const {sha}=require('../evaluations/foundation-runner/common.cjs');
const root=path.resolve(__dirname,'..'),work=path.dirname(root);
const BASE='2671389c1a58145d7615498ab7eaddd57813280e8bce826d752f967fd205003c';
const PATCH=['desktop/native-bridge.cjs','desktop/windows-shell.cjs'];
function verifyArchiveDelta(before,after,inputs){
 assert.deepEqual(inputs.map(f=>f.path).sort(),PATCH);
 const expected=new Map(before.files);
 for(const f of inputs){assert.ok(expected.has(f.path));assert.equal(expected.get(f.path).unpacked,false);expected.set(f.path,{bytes:f.bytes,sha256:sha(f.bytes),unpacked:false});}
 assert.deepEqual([...after.files.keys()].sort(),[...expected.keys()].sort());assert.deepEqual(after.directories,before.directories);
 for(const [p,f]of expected){assert.equal(after.files.get(p).sha256,f.sha256,p);assert.equal(after.files.get(p).unpacked,f.unpacked,p);}
 const changes=[...expected].filter(([p,f])=>f.sha256!==before.files.get(p).sha256).map(([p,f])=>({path:p,beforeSha256:before.files.get(p).sha256,sha256:f.sha256}));
 assert.deepEqual(changes.map(f=>f.path).sort(),PATCH);return changes;
}
function destination(p,prefix){
 assert.ok(typeof p==='string'&&path.isAbsolute(p));
 assert.equal(fs.realpathSync.native(path.dirname(p)),fs.realpathSync.native(work),'Output must be an immediate work sibling');
 assert.match(path.basename(p),new RegExp('^'+prefix+'[a-zA-Z0-9-]+$'));
 assert.ok(!fs.existsSync(p),'Output must be new');
}
async function prepare({output,manifest,review,reviewSha256}){
 destination(output,'foundation-candidate-bundle-notification-');
 assert.ok(typeof manifest==='string'&&path.isAbsolute(manifest));assert.equal(path.basename(manifest),'package-manifest.json');
 const evidence=path.dirname(manifest);destination(evidence,'foundation-notification-package-');
 assert.notEqual(output,evidence);
 assert.ok(typeof review==='string'&&path.isAbsolute(review));assert.match(reviewSha256,/^[a-f0-9]{64}$/);
 const reviewBytes=fs.readFileSync(review);assert.equal(sha(reviewBytes),reviewSha256,'Review seal mismatch');
 const approval=JSON.parse(reviewBytes);assert.equal(approval.approvedForPackaging,true);
 assert.deepEqual(approval.productFiles.map(f=>f.path).sort(),PATCH);
 const inputs=PATCH.map(p=>({path:p,bytes:fs.readFileSync(path.join(root,p))}));
 for(const f of inputs)assert.equal(sha(f.bytes),approval.productFiles.find(row=>row.path===f.path).sha256,'Reviewed source drift: '+f.path);
 const source=path.join(work,'foundation-candidate-bundle-title-20261102');
 assert.equal(fs.realpathSync.native(source),source,'Frozen source cannot be a link or alias');
 const original=inventory(source),frozen=JSON.parse(fs.readFileSync(path.join(root,'docs/delivery/foundation-win-20261102/candidate.json')));
 assert.equal(frozen.asarSha256,BASE);
 assert.deepEqual(original,frozen.files.map(f=>({path:f.path,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path,'en')),'Full frozen base manifest mismatch');
 const baseFile=path.join(source,'resources/app.asar'),asar=require('@electron/asar');assert.equal(sha(fs.readFileSync(baseFile)),BASE);
 const before=archive(asar,baseFile),files=new Map(before.files);
 for(const f of inputs)files.set(f.path,{bytes:f.bytes,sha256:sha(f.bytes),unpacked:false});
 const streams=[...before.directories,...[...files].map(([p,f])=>({path:p,type:'file',unpacked:f.unpacked,stat:{size:f.bytes.length,mode:0o644},streamGenerator:()=>Readable.from([f.bytes])}))].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 fs.cpSync(source,output,{recursive:true,errorOnExist:true,force:false,filter:p=>p!==baseFile});
 const target=path.join(output,'resources/app.asar');await asar.createPackageFromStreams(target,streams);
 const after=archive(asar,target),changes=verifyArchiveDelta(before,after,inputs),outer=inventory(output);
 assert.deepEqual(outer.map(f=>f.path),original.map(f=>f.path));
 assert.deepEqual(outer.filter((f,i)=>f.sha256!==original[i].sha256).map(f=>f.path),['resources/app.asar']);
 assert.deepEqual(inventory(source),original,'Frozen source changed');
 for(const f of inputs)assert.equal(sha(fs.readFileSync(path.join(root,f.path))),sha(f.bytes),'Source changed while packaging');
 const result={schema:1,kind:'offline-windows-notification-isolation-candidate',createdAt:new Date().toISOString(),displayVersion:'0.42.4',versionMeaning:'Existing runtime version; candidate identity is its exact manifest and SHA256.',baseCandidateAsarSha256:BASE,baseCandidateUnchanged:true,reviewSha256,preparationScriptSha256:sha(fs.readFileSync(__filename)),sourceModules:inputs.map(f=>({path:f.path,sha256:sha(f.bytes)})),asarSha256:sha(fs.readFileSync(target)),executableSha256:outer.find(f=>f.path==='XingzhiAssistant.exe').sha256,files:outer.map(f=>({...f,bytes:fs.statSync(path.join(output,f.path)).size})),archiveFilesVerified:after.files.size,archiveChanges:changes,outerChangedFiles:['resources/app.asar'],applicationStarts:0,candidateInstalled:false,intentionalModelCalls:0,intentionalOfficialCliInvocations:0,realWindowsRuntimeVerified:false};
 fs.mkdirSync(evidence);fs.writeFileSync(manifest,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 return {output,manifest,asarSha256:result.asarSha256,files:result.files.length,archiveFilesVerified:result.archiveFilesVerified,changes:changes.map(f=>f.path)};
}
module.exports={prepare,verifyArchiveDelta,BASE,PATCH};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},manifest:{type:'string'},review:{type:'string'},reviewSha256:{type:'string'}}});prepare(values).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
