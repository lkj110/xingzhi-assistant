'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {generate}=require('../scripts/release-plan.cjs'),gate=require('../scripts/system-release-gate.cjs');
test('ENG-RELEASE: generated plan retains all seven groups, historical scenarios and full package matrix',()=>{
 const p=generate({historyRoot:'/private-fixtures',fixtureRoot:'/generic-fixtures'});assert.equal(gate.validatePlan(p),p);assert.equal(p.fullSuite.tests,'all');
 for(const group of gate.GROUPS){assert.ok(p[group]);for(const id of gate.SCENARIOS[group])assert.ok(p[group].scenarioTests?.[id]||p[group].cases?.some(c=>c.id===id),group+':'+id);}
 assert.equal(p.packageWorker.cases[0].evidence.length,13);assert.equal(p.packageWorker.cases[0].evidenceDirectoriesFrom.length,12);assert.ok(p.packageWorker.cases[0].evidence.includes('{output}/package-worker-matrix.json'));assert.equal(p.packageWorker.before.length,2);assert.equal(p.build.commands[0].script,'scripts/release-build.cjs');assert.equal(p.fullSuite.testConcurrency,4);assert.equal(p.fullSuite.env.GENERIC_RECOVERY_FIXTURE_ROOT,'/generic-fixtures');assert.ok(p.historicalReplay.snapshots.S57.path.startsWith('/private-fixtures/'));assert.equal(p.controlledWorker.before[0].args.at(-1),'3');
});
test('ENG-RELEASE: missing historical inputs cannot silently produce a runnable plan',()=>{assert.throws(()=>generate(),/HISTORY_ROOT_REQUIRED/);assert.throws(()=>generate({historyRoot:'/fixtures'}),/FIXTURE_ROOT_REQUIRED/);});
test('ENG-RELEASE: plan cannot drop full suite, inject runtime env, or unbound concurrency',()=>{for(const mutate of [p=>p.fullSuite.tests=['tests/release.test.cjs'],p=>p.fullSuite.env.NODE_OPTIONS='--require=/tmp/inject',p=>p.fullSuite.testConcurrency=0,p=>p.requirements=[]]){const p=generate({historyRoot:'/f',fixtureRoot:'/g'});mutate(p);assert.throws(()=>gate.validatePlan(p));}});

test('ENG-RELEASE: next iteration requirements do not alter mandatory groups',()=>{const p=generate({historyRoot:'/f',fixtureRoot:'/g',requirements:['NEXT-1']});assert.deepEqual(p.requirements,['NEXT-1']);assert.equal(gate.GROUPS.filter(k=>p[k]).length,7);});
