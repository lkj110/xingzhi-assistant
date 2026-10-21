'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const check=require('../scripts/engineering-check.cjs');
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'engineering-check-'))),source=path.join(dir,'source'),evidence=path.join(dir,'evidence');fs.mkdirSync(source);fs.mkdirSync(evidence);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const git=(...args)=>cp.execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
 const scripts=Object.fromEntries(check.PACKAGE_ENTRIES.map(n=>[n,'node scripts/release.cjs build']));Object.assign(scripts,{release:'node scripts/release.cjs','test:share':'node scripts/release.cjs verify'});
 write(path.join(source,'package.json'),{version:'1.0.0',scripts});write(path.join(source,'package-lock.json'),{version:'1.0.0',packages:{'':{version:'1.0.0'}}});
 for(const [file,command] of [['package-share','build'],['share-verify','verify'],['cost-efficiency-package','build'],['cost-efficiency-package-verify','verify']])write(path.join(source,'scripts',file+'.cjs'),check.compatibilitySource(command));
 write(path.join(source,'.gitignore'),'scripts/ignored.cjs\n');git('add','.');git('commit','-qm','baseline');const baselineCommit=git('rev-parse','HEAD');
 const definitionFile=path.join(evidence,'iteration.json'),design=path.join(evidence,'design.md'),designReview=path.join(evidence,'review.json'),verificationPlan=path.join(evidence,'plan.json'),reviewDocument=path.join(evidence,'review.md');
 write(design,'Fixture design');write(reviewDocument,'Fixture independent approval');write(verificationPlan,{requirements:['TEST-1']});
 const d={version:1,id:'TEST',baselineCommit,risk:'C',author:'author',design,designReview,verificationPlan,allowedFiles:['scripts/allowed.cjs'],requirements:['TEST-1'],metricsDir:path.join(evidence,'metrics')};
 function sign(){write(definitionFile,d);write(designReview,{format:'engineering-design-review/v1',status:'approved',author:'author',reviewer:'fixture-reviewer',baselineCommit,designSha256:check.hash(design),iterationDefinition:definitionFile,iterationDefinitionSha256:check.hash(definitionFile),verificationPlanSha256:check.hash(verificationPlan),requirementIds:d.requirements,reviewDocument:{path:reviewDocument,sha256:check.hash(reviewDocument)},openFindings:[]});}
 sign();return {source,d,definitionFile,designReview,design,verificationPlan,reviewDocument,sign,write,git,run:(clean=false)=>check.check({source,definitionFile,requireClean:clean})};
}
const failed=(r,code)=>r.rules.some(x=>x.status==='failed'&&x.code===code);
test('ENG-CHECK: clean approved Git candidate and all canonical entrypoints pass',t=>{const f=fixture(t);assert.equal(f.run(true).passed,true);});
test('ENG-CHECK: tracked changes, untracked and ignored new code cannot escape reviewed write scope',t=>{const f=fixture(t);f.write(path.join(f.source,'scripts/ignored.cjs'),'changed');assert.equal(failed(f.run(),'OUTSIDE_WRITE_SCOPE'),true);assert.equal(failed(f.run(true),'DIRTY_CANDIDATE'),true);});
test('ENG-CHECK: allowed uncommitted source cannot freeze, committed allowed source can',t=>{const f=fixture(t);f.write(path.join(f.source,'scripts/allowed.cjs'),'module.exports=1;');assert.equal(f.run().passed,true);assert.equal(failed(f.run(true),'DIRTY_CANDIDATE'),true);f.git('add','scripts/allowed.cjs');f.git('commit','-qm','change');assert.equal(f.run(true).passed,true);});
test('ENG-CHECK: shared tool risk cannot be downgraded',t=>{const f=fixture(t);f.d.risk='A';f.sign();f.write(path.join(f.source,'scripts/allowed.cjs'),'x');assert.equal(failed(f.run(),'RISK_DOWNGRADE'),true);assert.equal(check.minimumRisk(['src/view.jsx']),'B');assert.equal(check.minimumRisk(['docs/readme.md']),'A');});
test('ENG-CHECK: changed design, plan, definition or reviewer document invalidates approval',async t=>{for(const name of ['design','verificationPlan','definitionFile','reviewDocument'])await t.test(name,t=>{const f=fixture(t);fs.appendFileSync(f[name],' ');assert.equal(f.run().passed,false);});});
test('ENG-CHECK: author self-approval and open findings reject',async t=>{for(const alteration of [{reviewer:'author'},{openFindings:['BLOCK']}])await t.test(JSON.stringify(alteration),t=>{const f=fixture(t);const r=JSON.parse(fs.readFileSync(f.designReview));f.write(f.designReview,{...r,...alteration});assert.equal(f.run().passed,false);});});
test('ENG-CHECK: package lock drift and direct packaging alias reject',t=>{const f=fixture(t);const p=JSON.parse(fs.readFileSync(path.join(f.source,'package.json')));p.version='1.0.1';p.scripts['package:share']='node scripts/package-share.cjs';f.write(path.join(f.source,'package.json'),p);assert.equal(failed(f.run(),'VERSION_MISMATCH'),true);assert.equal(failed(f.run(),'PACKAGE_BYPASS'),true);});
test('ENG-CHECK: unsupported aliases and changed direct compatibility script reject',t=>{const f=fixture(t);f.write(path.join(f.source,'scripts/cost-efficiency-package.cjs'),'packager({overwrite:true})');assert.equal(failed(f.run(),'PACKAGE_BYPASS'),true);});
test('ENG-CHECK: unknown definition fields, duplicates and path traversal reject',async t=>{for(const change of [{extra:1},{allowedFiles:['a','a']},{allowedFiles:['../package.json']},{requirements:[]}])await t.test(JSON.stringify(change),t=>{const f=fixture(t);Object.assign(f.d,change);f.sign();assert.equal(f.run().passed,false);});});
test('ENG-CHECK: nested parent repo is not a valid App baseline',t=>{const f=fixture(t);fs.mkdirSync(path.join(f.source,'nested'));const r=check.check({source:path.join(f.source,'nested'),definitionFile:f.definitionFile});assert.equal(failed(r,'WRONG_GIT_ROOT'),true);});
test('ENG-CHECK: private tracked names reject independently of allowed write set',t=>{const f=fixture(t);f.d.allowedFiles.push('auth.json');f.sign();f.write(path.join(f.source,'auth.json'),'{}');f.git('add','auth.json');assert.equal(failed(f.run(),'PRIVATE_INPUT_TRACKED'),true);});


test('ENG-CHECK: rename must authorize both removed and added paths',async t=>{
 for(const mode of ['removed-outside','added-outside','both-allowed'])await t.test(mode,t=>{const f=fixture(t);f.write(path.join(f.source,'desktop/protected.cjs'),'protected');f.git('add','desktop/protected.cjs');f.git('commit','-qm','tracked source');f.d.baselineCommit=f.git('rev-parse','HEAD');
 // Rebind the fixture approval to the new baseline (not a real review).
 f.d.allowedFiles=mode==='removed-outside'?['scripts/allowed.cjs']:mode==='added-outside'?['desktop/protected.cjs']:['desktop/protected.cjs','scripts/allowed.cjs'];
 f.sign();const r=JSON.parse(fs.readFileSync(f.designReview));r.baselineCommit=f.d.baselineCommit;f.write(f.designReview,r);
 f.git('mv','desktop/protected.cjs','scripts/allowed.cjs');f.git('commit','-qm','rename');
 assert.equal(f.run(true).passed,mode==='both-allowed');if(mode!=='both-allowed')assert.equal(failed(f.run(true),'OUTSIDE_WRITE_SCOPE'),true);
 });
});
test('ENG-CHECK: reviewer document direct and parent symlinks reject before freeze',async t=>{
 for(const parent of [false,true])await t.test(String(parent),t=>{const f=fixture(t),outside=path.join(path.dirname(f.source),'outside');fs.mkdirSync(outside);const target=path.join(outside,'review.md');fs.writeFileSync(target,'Fixture independent approval');const link=path.join(path.dirname(f.source),'review-link');{if(!require('./helpers/symlink.cjs').link(t,parent?outside:target,link))return;}const r=JSON.parse(fs.readFileSync(f.designReview));r.reviewDocument.path=parent?path.join(link,'review.md'):link;f.write(f.designReview,r);assert.equal(failed(f.run(),'LINKED_REVIEW_INPUT'),true);});
});
