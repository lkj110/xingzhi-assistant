'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const unavailableScripts=['generic-recovery-performance.cjs','prepared-upgrade-history.cjs'];
for(const script of unavailableScripts)test('public history CLI refuses absent evidence: '+script,()=>{
 const result=spawnSync(process.execPath,[path.join(root,'scripts',script)],{cwd:os.tmpdir(),encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
 assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');
 const report=JSON.parse(result.stderr);assert.equal(report.code,'PRIVATE_HISTORY_UNAVAILABLE');assert.equal(report.status,'unavailable');assert.equal(report.productionDelivery,'not_verified');
});
test('private history test adapter fails explicitly, never skips or passes',()=>{
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(root,'scripts/system-release-history-tests.cjs')],{cwd:os.tmpdir(),encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
 assert.equal(result.error,undefined);assert.equal(result.status,1);assert.match(result.stdout,/PRIVATE_HISTORY_UNAVAILABLE/);
 assert.match(result.stdout,/# pass 0/);assert.match(result.stdout,/# fail 1/);assert.match(result.stdout,/# skipped 0/);assert.doesNotMatch(result.stdout+result.stderr,/MODULE_NOT_FOUND/);
});
test('public tree excludes installation receipts and live/private replay runners',()=>{
 for(const name of ['tests/fixtures/codex-r7-installation.json','scripts/system-history-replay.cjs','scripts/consumption-admission-performance.cjs','scripts/protocol-v3-live-copy.cjs'])assert.equal(fs.existsSync(path.join(root,name)),false,name);
});
test('public defaults discover synthetic tests, not private evidence adapters',()=>{
 const packageJson=require('../package.json');assert.match(packageJson.scripts.test,/node --test tests\/\*\.test\.cjs/);
 assert.doesNotMatch(packageJson.scripts.test,/private-history|system-release-history-tests|test-name-pattern/);
 for(const name of ['consumption-scale','generic-recovery-cli','generic-recovery-performance','system-history-replay','model-preflight-recovery','root-platform-recovery','release','release-plan'])assert.ok(fs.existsSync(path.join(__dirname,name+'.test.cjs')),name);
});
test('public release plan retains seven mandatory groups and failing private-history slots',()=>{
 const gate=require('../scripts/system-release-gate.cjs'),plan=require('../scripts/release-plan.cjs').generate({historyRoot:'/synthetic-history',fixtureRoot:'/synthetic-fixtures'});
 assert.equal(gate.GROUPS.length,7);assert.equal(gate.validatePlan(plan),plan);
 for(const group of gate.GROUPS){const entry=plan[group];for(const name of Array.isArray(entry.tests)?entry.tests:[])assert.ok(fs.existsSync(path.join(root,name)),group+':'+name);}
 for(const group of ['historicalReplay','controlledWorker'])assert.ok(plan[group].tests.includes('scripts/system-release-history-tests.cjs'));
 assert.equal(plan.historicalReplay.before[0].script,'scripts/prepared-upgrade-history.cjs');
});
test('public package retains MIT metadata and public registry dependency URLs',()=>{
 const packageJson=require('../package.json'),lock=require('../package-lock.json');assert.equal(packageJson.license,'MIT');assert.equal(lock.packages[''].license,'MIT');
 assert.equal(packageJson.version,lock.version);assert.equal(packageJson.version,lock.packages[''].version);
 assert.deepEqual(packageJson.dependencies,lock.packages[''].dependencies);assert.deepEqual(packageJson.devDependencies,lock.packages[''].devDependencies);
 assert.match(packageJson.repository.url,/github\.com\/lkj110\/xingzhi-assistant/);
 for(const entry of Object.values(lock.packages))if(entry.resolved)assert.equal(new URL(entry.resolved).hostname,'registry.npmjs.org');
});
