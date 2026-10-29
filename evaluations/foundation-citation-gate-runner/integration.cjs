'use strict';
// Fixed offline-only matrix. All CLI transport is a local Node fixture.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {run}=require('./run.cjs'),{read,write,sha}=require('./identity.cjs'),{validateOutput}=require('../foundation-marker-runner/output.cjs');
async function integration({executable,output}){
 output=validateOutput(output);fs.mkdirSync(output,{recursive:true});const tests=[];
 for(const fault of [undefined,'old-budget','cli-rejection','fifth-request','unknown-usage','malformed-inner']){
  const name=fault||'complete',directory=path.join(output,name);let error;
  try{await run({executable,output:directory,mode:'offline',fault});}catch(e){error=e;}
  const summaryPath=path.join(directory,'summary.json'),s=fs.existsSync(summaryPath)?read(summaryPath):null; if(!s)throw error||Error('Missing gate summary'); const totals=s.ledger.totals;
  assert.equal(s.realCliExecutions,0);assert.equal(s.synthetic,true);assert.equal(s.actualHumanAcceptances,0);assert.equal(s.businessCasesStarted,0);assert.equal(s.qualityEvaluation,false);assert.equal(s.installed,false);assert.equal(totals.pendingUsage,0);assert.equal(totals.unexpectedAttempts,0);
  const terminals=s.ledger.attempts.map(a=>read(path.join(directory,'calls',a.id+'-terminal.json')));assert.equal(terminals.length,totals.applicationEntryAttempts);assert.ok(terminals.every(t=>!t.transportDispatched));
  const expected={complete:4,'old-budget':4,'cli-rejection':2,'fifth-request':5,'unknown-usage':1,'malformed-inner':1};assert.equal(totals.attempts,expected[name]);
  if(!fault){assert.equal(error,undefined);assert.equal(s.passed,true);assert.deepEqual(terminals.map(t=>t.role),['execute','execute','verify','verify']);const responses=terminals.map(t=>JSON.parse(JSON.parse(t.rawOutput).response_json));assert.deepEqual(responses.slice(0,3).map(r=>r.kind),['read_context','artifact','read_context']);assert.equal(responses[3].passed,true);assert.ok(responses[3].groundingReview.claims.length);assert.equal(s.checks.filter(c=>c.kind==='independent-content-checkpoint').length,1);}
  else{assert.ok(error);assert.equal(s.passed,false);assert.ok(s.ledger.stop);assert.equal(s.checks.filter(c=>c.kind==='independent-content-checkpoint').length,0);}
  if(['cli-rejection','unknown-usage'].includes(fault)){assert.equal(totals.unknownUsage,1);assert.equal(totals.totalTokens,null);}else assert.equal(totals.unknownUsage,0);
  if(fault==='cli-rejection'){assert.equal(totals.knownTokenSubtotal,12101);const last=terminals.at(-1);assert.equal(last.error,'CLI_PROTOCOL_REJECTION');assert.equal(last.processTreeConfirmed,true);assert.equal(last.diagnostics.events[0].details.error.code,'SYNTHETIC_UPSTREAM_FAILURE');assert.equal(last.diagnostics.events[0].details.error.http_status,503);assert.ok(!JSON.stringify(last.diagnostics).includes('SYNTHETIC_DIAGNOSTIC_SECRET'));}
  if(['old-budget','fifth-request'].includes(fault)){assert.equal(totals.admitted,expected[name]-1);assert.equal(terminals.at(-1).executionEntered,undefined);assert.equal(terminals.at(-1).error,'LEDGER_GLOBAL_BUDGET');}
  tests.push({name,passed:true,syntheticAttempts:totals.attempts,syntheticTransportExecutions:terminals.filter(t=>t.syntheticTransport).length,realModelCalls:0,runnerIdentity:s.runnerIdentity,summarySha256:sha(fs.readFileSync(summaryPath)),reservations:s.ledger.attempts.map(a=>({role:a.role,reservedTokens:a.reservedTokens,serializedInputBytes:a.serializedInputBytes,schemaBytes:a.schemaBytes}))});
 }
 const result={schema:1,passed:true,tests,realModelCalls:0,actualHumanAcceptances:0,qualityMetrics:null};write(path.join(output,'integration-results.json'),result);return result;
}
module.exports={integration};if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'}}});integration(values).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
