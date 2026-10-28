'use strict';
// One bounded offline rehearsal and four fault injections. No live mode exists here.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {run}=require('./run.cjs'),{read,write}=require('./common.cjs');
async function test({executable,output}){
 assert.ok(path.isAbsolute(output)&&!fs.existsSync(output));fs.mkdirSync(output,{recursive:true});const results=[];
 for(const fault of [undefined,'malformed-envelope','malformed-inner','unknown-usage','case-budget']){
  const name=fault||'full-lifecycle',dir=path.join(output,name);let error;
  try{await run({executable,output:dir,mode:'offline',fault});}catch(e){error=e;}
  const s=read(path.join(dir,'summary.json'));assert.equal(s.liveModelCalls,0);assert.equal(s.manualAcceptancePerformed,false);assert.equal(s.userWorkspaceTouched,false);
  if(!fault){assert.equal(error,undefined);assert.equal(s.passed,true);assert.equal(s.results.length,7);assert.equal(s.ledger.totals.attempts,22);assert.equal(s.checks.filter(c=>c.kind==='independent-content-checkpoint'&&c.syntheticSkipped).length,2);}
  else if(fault==='case-budget'){
   assert.ok(error);assert.equal(s.passed,false);assert.equal(s.results.length,7);
   const denied=s.results.find(r=>r.caseId==='F01-lanqiao-tour');assert.equal(denied.technicalPassed,false);assert.equal(denied.applicationAttempts,2);
   assert.ok(s.results.filter(r=>r.caseId!==denied.caseId).every(r=>r.technicalPassed));
   assert.equal(s.ledger.cases[denied.caseId].admitted,1);assert.equal(s.ledger.caseStops[denied.caseId].code,'LEDGER_CASE_BUDGET');
   assert.equal(s.ledger.totals.attempts,21);
  }else{
   assert.ok(error);assert.equal(s.passed,false);assert.equal(s.results.length,1);assert.equal(s.results[0].caseId,'G00-ronglan');assert.equal(s.ledger.totals.attempts,1);assert.ok(s.ledger.stop);
   const terminal=fs.readdirSync(path.join(dir,'calls')).filter(f=>f.endsWith('-terminal.json'));assert.equal(terminal.length,1);
   const t=read(path.join(dir,'calls',terminal[0]));assert.ok(t.error&&t.errorDetail);assert.ok(Array.isArray(t.rawUsageEvents));assert.equal(typeof t.rawOutput,'string');
   if(fault==='unknown-usage'){assert.equal(s.ledger.totals.totalTokens,null);assert.equal(s.ledger.totals.unknownUsage,1);}
   else{assert.ok(s.ledger.totals.totalTokens>0);assert.equal(s.ledger.totals.unknownUsage,0);}
  }
  results.push({name,passed:true,syntheticCalls:s.ledger.totals.attempts,liveModelCalls:0,guardStopped:!!s.ledger.stop});
 }
 write(path.join(output,'integration-results.json'),{passed:true,tests:results.length,results,liveModelCalls:0});console.log(JSON.stringify({integrationPassed:true,tests:results.length,output}));
}
module.exports={test};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'}}});test(values).catch(e=>{console.error(e.stack);process.exitCode=1;});}
