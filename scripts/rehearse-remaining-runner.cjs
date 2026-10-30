'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const id=require('../evaluations/foundation-remaining-runner/identity.cjs'),{run}=require('../evaluations/foundation-remaining-runner/run.cjs');
async function rehearse({executable,output}){
 output=require('../evaluations/foundation-marker-runner/output.cjs').validateOutput(output,path.resolve(id.root,'../foundation-remaining-runs-20261030'));fs.mkdirSync(output,{recursive:true});
 const seal=id.read(path.join(id.root,'evaluations/foundation-remaining-runner/runner-seal.json'));id.verifyRunner(seal);const results=[];
 const probes=[{id:'normal',phases:['gate','business'],fault:'capture-lifecycle'},
  {id:'gate-malformed',phases:['gate'],fault:'malformed-inner',negative:true},
  {id:'business-unknown-usage',phases:['gate','business'],fault:'unknown-usage',negative:true},
  {id:'capture-submit',phases:['gate'],fault:'capture-submit',negative:true},
  {id:'wrong-window',phases:['gate'],fault:'wrong-window',negative:true},
  {id:'phase-stop',phases:['gate'],fault:'phase-stop',negative:true}];
 for(const probe of probes){
  const target=path.join(output,probe.id);let error;
  for(const [i,stage]of probe.phases.entries())try{await run({stage,executable,output:target,mode:'offline',readyReference:'OFFLINE-SYNTHETIC-NOT-USER-APPROVAL',fault:probe.id==='normal'||i===probe.phases.length-1?probe.fault:undefined});}catch(e){error=e;break;}
  assert.equal(!!error,!!probe.negative,probe.id+': '+error?.stack);assert.ok(!fs.existsSync(path.join(target,'f04.started.json'))&&!fs.existsSync(path.join(target,'f04')),'F04 must not run');
  const last=probe.phases.at(-1),summary=id.read(path.join(target,last,'summary.json'));assert.equal(summary.mode,'offline');assert.equal(summary.passed,!probe.negative);assert.equal(summary.liveModelCalls||summary.realCliExecutions||0,0);assert.equal(summary.actualHumanAcceptances,0);
  if(probe.negative){
   assert.ok(fs.existsSync(path.join(target,'stopped.json')));assert.ok(!fs.existsSync(path.join(target,last+'.completed.json')));
   if(last==='gate')assert.ok(!fs.existsSync(path.join(target,'business.started.json')));
   if(probe.fault==='malformed-inner'){assert.equal(summary.ledger.totals.admitted,1);assert.equal(summary.ledger.totals.unknownUsage,0);}
   if(probe.fault==='unknown-usage'){assert.ok(summary.ledger.totals.unknownUsage>0);assert.equal(summary.ledger.totals.totalTokens,null);assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision']);assert.ok(!fs.existsSync(path.join(target,'business/F06-yunshu-restart.json')));}
   if(['capture-submit','wrong-window','phase-stop'].includes(probe.fault)){assert.equal(summary.ledger.totals.admitted,0);assert.equal(summary.ledger.totals.totalTokens,0);const rows=require('../evaluations/foundation-remaining-runner/native.cjs').records(path.join(target,last,'native-commands.jsonl'));assert.ok(rows.some(r=>r.kind==='denied'&&r.boundary==='before-original-handler'));}
  }else{
   assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision','F06-yunshu-restart']);assert.equal(summary.gateExecutions,0);assert.equal(summary.simulatedAcceptances,2);
   for(const kind of ['revision-new-basis','marker-handoff-closed','restart-preserved','accepted-cold-restart-preserved','final-human-acceptance','capture-button-escape-reopen-recreate'])assert.ok(summary.checks.some(c=>c.kind===kind),kind);
   assert.ok(summary.gatePrerequisite?.summarySha256);const gate=id.read(path.join(target,'gate/summary.json'));assert.equal(gate.f04Prerequisite.runId,'3416bcda-77e0-4866-b0a6-2bb7eabec4f0');assert.equal(gate.f04Prerequisite.rerun,false);
   const report=require('../evaluations/foundation-remaining-runner/report.cjs').report(target);assert.equal(report.business.plannedGeneratedCases,2);assert.equal(report.business.plannedFixedInvalidCases,0);assert.equal(report.business.quality,null);assert.equal(report.cost.synthetic,true);id.write(path.join(target,'scoped-report.json'),report);
  }
  const files=['run.json',...probe.phases.flatMap(p=>[p+'.started.json',p+'.completed.json',p+'/summary.json',p+'/native-commands.jsonl',p+'/phase-review-request.json',p+'/ledger/ledger.json']),...(probe.negative?['stopped.json']:['scoped-report.json'])].filter(p=>fs.existsSync(path.join(target,p))).map(p=>({path:probe.id+'/'+p,sha256:id.sha(fs.readFileSync(path.join(target,p)))}));
  results.push({id:probe.id,passed:true,expectedFailure:!!probe.negative,error:error?.message||null,realModelCalls:0,files});console.log(JSON.stringify({probe:probe.id,passed:true,expectedFailure:!!probe.negative}));
 }
 id.verifyRunner(seal);const value={schema:1,kind:'offline-packaged-remaining-workflows-rehearsal',createdAt:new Date().toISOString(),runnerIdentity:seal.identity,asarSha256:id.read(path.join(id.root,'evaluations/foundation-remaining-runner/plan.json')).asarSha256,passed:true,results,realModelCalls:0,officialCliInvocations:0,actualHumanAcceptances:0,f04Executions:0,installed:false,syntheticFixtureOnly:true};id.write(path.join(output,'rehearsal.json'),value);return value;
}
module.exports={rehearse};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'}}});rehearse(values).then(r=>console.log(JSON.stringify({passed:r.passed,probes:r.results.length,realModelCalls:0,f04Executions:0}))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
