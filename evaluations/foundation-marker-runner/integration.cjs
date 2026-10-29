'use strict';
// Bounded offline-only suite. It never discovers a CLI or creates live approval.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {run}=require('./run.cjs'),{read,write}=require('./identity.cjs'),{validateOutput}=require('./output.cjs');
async function integration({executable,output}){
 output=validateOutput(output);fs.mkdirSync(output,{recursive:true});const tests=[];
 for(const fault of [undefined,'malformed-inner','malformed-evidence','unknown-usage','case-budget','human-timeout']){
  const name=fault||'full',directory=path.join(output,name);let error;
  try{await run({executable,output:directory,mode:'offline',fault});}catch(e){error=e;}
  const s=read(path.join(directory,'summary.json'));assert.equal(s.liveModelCalls,0);assert.equal(s.actualHumanAcceptances,0);assert.equal(s.installed,false);assert.equal(s.userWorkspaceTouched,false);assert.equal(s.ledger.totals.pendingUsage,0);assert.equal(s.ledger.totals.unexpectedAttempts,0);
  if(!fault){assert.equal(error,undefined);assert.equal(s.passed,true);assert.equal(s.results.length,7);assert.equal(s.simulatedAcceptances,4);assert.equal(s.checks.filter(c=>c.kind==='marker-handoff-closed').length,3);assert.equal(s.checks.filter(c=>c.kind==='boot').length,3);assert.equal(s.ledger.totals.attempts,25);assert.equal(s.ledger.totals.unknownUsage,0);}
  else{
   assert.ok(error);assert.equal(s.passed,false);assert.ok(s.ledger.stop);
   const expected={'malformed-inner':1,'malformed-evidence':5,'unknown-usage':1,'case-budget':4,'human-timeout':10};assert.equal(s.ledger.totals.attempts,expected[fault]);
   if(fault==='unknown-usage'){assert.equal(s.ledger.totals.unknownUsage,1);assert.equal(s.ledger.totals.totalTokens,null);}else assert.equal(s.ledger.totals.unknownUsage,0);
   if(fault==='malformed-evidence'){assert.equal(s.results.length,2);assert.ok(s.errors.some(e=>e.includes('RUNNER_EVIDENCE_FORMAT')));assert.ok(s.ledger.totals.totalTokens>0);}
   if(fault==='case-budget'){assert.equal(s.results.length,2);assert.equal(Object.values(s.ledger.caseStops)[0].code,'LEDGER_CASE_BUDGET');}
   if(fault==='human-timeout'){assert.equal(s.results.length,4);assert.equal(s.results.at(-1).errorCode,'HUMAN_PENDING');assert.equal(s.simulatedAcceptances,0);const c=read(path.join(directory,s.results.at(-1).caseId+'.json'));assert.equal(c.final.tasks.find(t=>t.id===c.taskId).status,'waiting');}
  }
  const r=require('./report.cjs').report(directory);assert.equal(r.quality,null);assert.equal(r.qualityStatus,'N/A-synthetic');assert.equal(Object.values(r.cost.stages).reduce((n,x)=>n+x.attempts,0),s.ledger.totals.applicationEntryAttempts);write(path.join(directory,'cost-and-quality-status.json'),r);
  tests.push({name,passed:true,syntheticAttempts:s.ledger.totals.attempts,realModelCalls:0,runnerIdentity:s.runnerIdentity,summarySha256:require('./identity.cjs').sha(fs.readFileSync(path.join(directory,'summary.json')))});
 }
 const result={schema:1,passed:true,tests,realModelCalls:0,actualHumanAcceptances:0};write(path.join(output,'integration-results.json'),result);return result;
}
module.exports={integration};if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'}}});integration(values).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
