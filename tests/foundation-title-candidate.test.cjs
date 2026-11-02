'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const build=require('../scripts/prepare-title-candidate.cjs'),id=require('../evaluations/foundation-remaining-runner/identity.cjs');
const plan=id.read(path.join(id.root,'evaluations/foundation-remaining-runner/plan.json'));
function archives(){
 const row=text=>({bytes:Buffer.from(text),sha256:id.sha(Buffer.from(text)),unpacked:false});
 const before={directories:[{path:'desktop',type:'directory',unpacked:false}],files:new Map(build.PATCH.map(p=>[p,row('old '+p)]))};before.files.set('desktop/unchanged.cjs',row('unchanged'));
 const inputs=build.PATCH.map(p=>({path:p,bytes:Buffer.from('new '+p)})),after={directories:structuredClone(before.directories),files:new Map(before.files)};for(const f of inputs)after.files.set(f.path,row(f.bytes));return {before,after,inputs};
}
test('offline overlay accepts exactly the reviewed title-contract module and no other archive change',()=>{const f=archives();assert.deepEqual(build.verifyArchiveDelta(f.before,f.after,f.inputs).map(r=>r.path).sort(),build.PATCH);});
for(const kind of ['missing','added','unrelated','unpacked','directory','wrong-source','missing-base-module'])test('overlay refuses '+kind,()=>{
 const f=archives();
 if(kind==='missing')f.after.files.delete(build.PATCH[0]);if(kind==='added')f.after.files.set('extra',f.after.files.get(build.PATCH[0]));if(kind==='unrelated')f.after.files.get('desktop/unchanged.cjs').sha256='0'.repeat(64);
 // Maps share unchanged entries, so make the counterexample an actual delta.
 if(kind==='unrelated')f.before.files.set('desktop/unchanged.cjs',{sha256:id.sha(Buffer.from('unchanged')),unpacked:false});
 if(kind==='unpacked')f.after.files.get(build.PATCH[0]).unpacked=true;if(kind==='directory')f.after.directories.push({path:'extra',type:'directory'});if(kind==='wrong-source')f.inputs[0].bytes=Buffer.from('not reviewed');if(kind==='missing-base-module')f.before.files.delete('desktop/body-structure.cjs');
 assert.throws(()=>build.verifyArchiveDelta(f.before,f.after,f.inputs));
});
test('new package independently verifies and F04 retains only its prior candidate coverage',t=>{
 for(const method of ['spawn','spawnSync','execFileSync'])t.mock.method(cp,method,()=>assert.fail('No process launch in identity checks'));
 const exe=path.resolve(id.root,'../foundation-candidate-bundle-title-20261102/XingzhiAssistant.exe'),identity=id.frozen(exe,{complete:true});
 assert.equal(identity.candidateIdentity.complete,true);assert.equal(identity.plan.asarSha256,plan.asarSha256);assert.equal(identity.f04Prerequisite.asarSha256,build.F04);assert.notEqual(identity.f04Prerequisite.asarSha256,build.BASE);assert.notEqual(identity.f04Prerequisite.asarSha256,plan.asarSha256);assert.equal(identity.f04Prerequisite.currentCandidateAsarSha256,plan.asarSha256);assert.equal(identity.f04Prerequisite.historicalOnly,true);assert.equal(identity.f04Prerequisite.currentCandidateCovered,false);assert.equal(identity.f04Prerequisite.rerun,false);
 assert.throws(()=>id.frozen(path.resolve(id.root,'../foundation-candidate-bundle-body-20261102/XingzhiAssistant.exe')));
 assert.throws(()=>id.frozen(path.resolve(id.root,'../foundation-candidate-bundle-export-20261030/XingzhiAssistant.exe')));
 assert.throws(()=>id.frozen(exe,{phase:'f04'}));
});
for(const field of ['old-asar','old-cli','new-cli-unpinned','wrong-source','manifest-hash','f04-coverage','f04-base'])test('candidate transition rejects '+field,()=>{
 const p=structuredClone(plan);if(field==='old-asar')p.asarSha256=build.BASE;if(field==='old-cli')p.cli.sha256=p.cliChange.previousSha256;if(field==='new-cli-unpinned')p.cli.sha256='f'.repeat(64);if(field==='wrong-source')p.sourceCodeCommit='f'.repeat(40);if(field==='manifest-hash')p.candidateTransition.packageManifestSha256='f'.repeat(64);if(field==='f04-coverage')p.candidateTransition.F04CurrentCandidateCovered=true;if(field==='f04-base')p.candidateTransition.baseAsarSha256=p.asarSha256;assert.throws(()=>id.validatePlan(p));
});
test('new seal binds product, package builder, wrapper, structural regressions and current Node',()=>{
 const seal=id.read(path.join(id.root,'evaluations/foundation-remaining-runner/runner-seal.json'));id.verifyRunner(seal);assert.notEqual(seal.identity,'a626d3975247ab3e06336e81e154d356e7b1c15a58b9aad0b68dc43df33aafa0');assert.equal(seal.host.nodeVersion,process.version);
 assert.notEqual(seal.identity,'f90db745e7aa32212b77182ec875ddf1d849533db2bf7ea6c5a733d40bf89153');
 for(const p of [...build.PRODUCT,'scripts/prepare-title-candidate.cjs','tests/foundation-title-candidate.test.cjs','tests/foundation-title-replay.test.cjs','tests/body-structure.test.cjs','tests/body-structure-flow.test.cjs','tests/fixtures/foundation-body-structure-f05-20261102.json','tests/fixtures/foundation-title-contract-f05-20261102.json'])assert.equal(seal.dependencies.find(r=>r.path===p)?.sha256,id.sha(fs.readFileSync(path.join(id.root,p))),p);
 for(const p of ['package-manifest.json','plan.json','fixture.cjs','title-replay.cjs'])assert.ok(seal.files.some(r=>r.path===p));
});
test('new local module source cannot drift after packaging',t=>{
 const original=fs.readFileSync,target=path.join(id.root,'desktop/body-structure.cjs');t.mock.method(fs,'readFileSync',(file,...args)=>{const value=original(file,...args);return path.resolve(String(file))===target?Buffer.concat([Buffer.from(value),Buffer.from(' ') ]):value;});
 assert.throws(()=>id.frozen(path.resolve(id.root,'../foundation-candidate-bundle-title-20261102/XingzhiAssistant.exe')),/Reviewed candidate source changed/);
});
test('negative fixture inserts a real third paragraph without changing the sealed gold',()=>{
 const text='title\nfirst\n\nsecond',changed=require('../evaluations/foundation-remaining-runner/fixture.cjs').threeParagraphs(text);assert.equal(changed,'title\n\nfirst\n\nsecond');assert.equal(text,'title\nfirst\n\nsecond');assert.throws(()=>require('../evaluations/foundation-remaining-runner/fixture.cjs').threeParagraphs('title\n\nfirst\n\nsecond'));
});
