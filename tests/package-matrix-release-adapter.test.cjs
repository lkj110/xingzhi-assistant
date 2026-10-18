'use strict';
// Protocol fixtures only: exercise the actual report producer and release
// adapter, not the App or a production delivery.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const harness=require('../scripts/system-package-worker.cjs'),matrix=require('../scripts/system-package-worker-matrix.cjs');
for(const variant of ['valid','string-scenarios','missing-status','failed-status'])test(`package matrix real release adapter: ${variant}`,t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'matrix-release-protocol-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const records=harness.SCENARIOS.map(scenario=>({scenario,file:path.join(dir,'package-worker-'+scenario+'.json'),result:{scenario,status:'passed',passed:true,layer:'controlled',productionDelivery:'not_verified',userAccepted:false,source:{digest:'a'.repeat(64)},package:{digest:'b'.repeat(64)},afterSourceDigest:'a'.repeat(64),afterPackageDigest:'b'.repeat(64),realBusinessCalls:0,realNetworkCalls:0,realModelCalls:0,blockedExternalAttempts:[]}}));
 const report=matrix.summarize(records);report.protocolFixture=true;
 if(variant==='string-scenarios')report.scenarios=[...harness.SCENARIOS];
 if(variant==='missing-status')delete report.scenarios[0].status;
 if(variant==='failed-status')report.scenarios[0].status='failed';
 const output=path.join(dir,'report.json'),producer=path.join(dir,'producer.cjs');
 fs.writeFileSync(producer,"require('node:fs').writeFileSync(process.argv[2],process.argv[3],{flag:'wx'});");
 const cases=[{id:'synthetic-matrix-protocol',script:producer,args:[output,JSON.stringify(report)],evidence:[output]}];
 const env={...process.env,SYSTEM_RELEASE_CASES:JSON.stringify(cases)};delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--test',path.resolve(__dirname,'../scripts/system-release-script-tests.cjs')],{cwd:dir,env,encoding:'utf8',timeout:15000});
 assert.ifError(result.error);assert.equal(result.signal,null);
 assert.match(result.stdout,/synthetic-matrix-protocol/);assert.doesNotMatch(result.stderr,/recursively/);
 assert.equal(result.status,variant==='valid'?0:1,result.stdout+result.stderr);
 if(variant!=='valid')assert.match(result.stdout+result.stderr,/scenario did not pass/);
 else{assert.deepEqual(report.scenarios.map(s=>s.id),harness.SCENARIOS);assert.ok(report.scenarios.every(s=>s.status==='passed'));assert.equal(report.reports.length,12);}
});
