'use strict';
// Packaged integration rehearsal only. There is no live mode or real CLI option.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const id=require('../evaluations/foundation-minimal-runner/identity.cjs'),{run}=require('../evaluations/foundation-minimal-runner/run.cjs');
async function rehearse({executable,output}){
 const base=path.resolve(id.root,'../foundation-minimal-runs-20261030');output=require('../evaluations/foundation-marker-runner/output.cjs').validateOutput(output,base);fs.mkdirSync(output,{recursive:true});
 const seal=id.read(path.join(id.root,'evaluations/foundation-minimal-runner/runner-seal.json'));id.verifyRunner(seal);const results=[];
 const probes=[{id:'normal',phases:['f04','gate','business']},{id:'f04-cli-denied',phases:['f04'],fault:'cli-attempt'},{id:'f04-wrong-task',phases:['f04'],fault:'wrong-task'},{id:'gate-malformed',phases:['f04','gate'],fault:'malformed-inner'},{id:'business-unknown-usage',phases:['f04','gate','business'],fault:'unknown-usage'}];
 for(const probe of probes){
  const target=path.join(output,probe.id);let error;
  for(const [i,stage]of probe.phases.entries())try{await run({stage,executable,output:target,mode:'offline',readyReference:'OFFLINE-SYNTHETIC-NOT-HUMAN',fault:i===probe.phases.length-1?probe.fault:undefined});}catch(e){error=e;break;}
  assert.equal(!!error,!!probe.fault,probe.id+': '+error?.stack);
  const last=probe.phases.at(-1),summary=id.read(path.join(target,last,'summary.json'));
  assert.equal(summary.mode,'offline');assert.equal(summary.passed,!probe.fault);assert.equal(summary.liveModelCalls||summary.realCliExecutions||summary.realModelCalls||0,0);
  if(probe.fault){
   assert.ok(fs.existsSync(path.join(target,'stopped.json')));assert.ok(!fs.existsSync(path.join(target,last+'.completed.json')));
   if(last==='f04'){assert.equal(summary.modelCallsAdded,0);assert.equal(summary.transportAttempts.length,probe.fault==='cli-attempt'?1:0);assert.equal(summary.receipt,null);}
   if(probe.fault==='malformed-inner'){assert.equal(summary.ledger.totals.unknownUsage,0);assert.equal(summary.ledger.totals.usageComplete,true);assert.equal(summary.ledger.totals.admitted,1);assert.match(JSON.stringify(summary.errors),/JSON|RESPONSE|Unexpected|invalid/i);}
   if(probe.fault==='unknown-usage'){assert.ok(summary.ledger.totals.unknownUsage>0);assert.equal(summary.ledger.totals.totalTokens,null);assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision']);assert.ok(!fs.existsSync(path.join(target,'business/F06-yunshu-restart.json')));}
  }else{
   assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision','F06-yunshu-restart']);assert.equal(summary.actualHumanAcceptances,0);assert.equal(summary.gateExecutions,0);assert.ok(summary.gatePrerequisite?.summarySha256);
   for(const kind of ['revision-new-basis','marker-handoff-closed','restart-preserved','final-human-acceptance'])assert.ok(summary.checks.some(c=>c.kind===kind),kind);
   const report=require('../evaluations/foundation-minimal-runner/report.cjs').report(target);assert.equal(report.business.plannedGeneratedCases,2);assert.equal(report.business.plannedFixedInvalidCases,0);assert.equal(report.business.quality,null);assert.equal(report.cost.synthetic,true);id.write(path.join(target,'scoped-report.json'),report);
  }
  const files=['run.json',...probe.phases.flatMap(p=>[p+'.started.json',p+'.completed.json',p+'/summary.json',p+'/native-commands.jsonl',p+'/phase-review-request.json',p+'/ledger/ledger.json']),...(probe.fault?['stopped.json']:['scoped-report.json'])].filter(p=>fs.existsSync(path.join(target,p))).map(p=>({path:probe.id+'/'+p,sha256:id.sha(fs.readFileSync(path.join(target,p)))}));
  results.push({id:probe.id,passed:true,expectedFailure:!!probe.fault,error:error?.message||null,liveModelCalls:0,files});console.log(JSON.stringify({probe:probe.id,passed:true,expectedFailure:!!probe.fault}));
 }
 id.verifyRunner(seal);const value={schema:1,kind:'offline-packaged-minimal-runner-rehearsal',createdAt:new Date().toISOString(),runnerIdentity:seal.identity,asarSha256:id.read(path.join(id.root,'evaluations/foundation-minimal-runner/plan.json')).asarSha256,passed:true,results,realModelCalls:0,officialCliInvocations:0,actualHumanAcceptances:0,installed:false,syntheticFixtureOnly:true};id.write(path.join(output,'rehearsal.json'),value);return value;
}
module.exports={rehearse};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'}}});rehearse(values).then(r=>console.log(JSON.stringify({passed:r.passed,probes:r.results.length,realModelCalls:r.realModelCalls}))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
