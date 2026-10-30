'use strict';
// Fixed offline matrix only. No live authorization or official CLI discovery.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {run}=require('./run.cjs'),{read,write,sha}=require('./identity.cjs'),{validateOutput}=require('../foundation-marker-runner/output.cjs');
async function integration({executable,output,guardsOnly=false}){
 output=validateOutput(output);fs.mkdirSync(output,{recursive:true});const tests=[];
 for(const fault of [...(guardsOnly?[]:[undefined]),'cli-rejection','unknown-usage','case-extra-request','human-timeout','malformed-inner']){
  const name=fault||'complete',directory=path.join(output,name);let error;try{await run({executable,output:directory,mode:'offline',fault});}catch(e){error=e;}
  if(!fs.existsSync(path.join(directory,'summary.json')))throw error||Error('Missing run summary');
  const s=read(path.join(directory,'summary.json')),l=s.ledger.totals;assert.equal(s.liveModelCalls,0);assert.equal(s.actualHumanAcceptances,0);assert.equal(s.gateExecutions,0);assert.equal(s.installed,false);assert.equal(s.userWorkspaceTouched,false);assert.equal(l.pendingUsage,0);assert.equal(l.unexpectedAttempts,0);
  const terminals=s.ledger.attempts.map(a=>read(path.join(directory,'calls',a.id+'-terminal.json')));assert.ok(terminals.every(t=>!t.transportDispatched));assert.equal(terminals.length,l.applicationEntryAttempts);
  if(!fault&&error)throw error;
  const expected={complete:29,'cli-rejection':6,'unknown-usage':7,'case-extra-request':3,'human-timeout':8,'malformed-inner':1};assert.equal(l.applicationEntryAttempts,expected[name]);
  if(!fault){assert.equal(error,undefined);assert.equal(s.passed,true);assert.equal(s.results.length,6);assert.equal(s.simulatedAcceptances,4);assert.equal(s.checks.filter(c=>c.kind==='marker-handoff-closed').length,3);assert.equal(s.checks.filter(c=>c.kind==='revision-new-basis').length,1);assert.equal(s.checks.filter(c=>c.kind==='boot').length,3);assert.deepEqual(s.results.map(r=>r.applicationAttempts),[2,2,6,4,11,4]);}
  else{assert.ok(error);assert.equal(s.passed,false);assert.ok(s.ledger.stop);}
  if(['cli-rejection','unknown-usage'].includes(fault)){assert.equal(l.unknownUsage,1);assert.equal(l.totalTokens,null);assert.ok(l.knownTokenSubtotal>0);assert.equal(terminals.at(-1).caseId,s.results.at(-1).caseId);assert.equal(terminals.at(-1).role,fault==='cli-rejection'?'execute':'verify');if(fault==='cli-rejection'){assert.equal(terminals.at(-1).error,'CLI_TURN_FAILED');assert.equal(terminals.at(-1).processTreeConfirmed,true);assert.ok(!JSON.stringify(terminals.at(-1).diagnostics).includes('SYNTHETIC_DIAGNOSTIC_SECRET'));}else assert.equal(read(path.join(directory,s.results.at(-1).caseId+'-initial-draft.json')).technicalInterrupted,true);}
  else assert.equal(l.unknownUsage,0);
  if(fault==='case-extra-request'){assert.equal(l.admitted,2);assert.equal(terminals.at(-1).executionEntered,undefined);assert.equal(terminals.at(-1).error,'LEDGER_CASE_BUDGET');}
  if(fault==='human-timeout'){assert.equal(s.simulatedAcceptances,0);assert.equal(s.results.at(-1).errorCode,'HUMAN_PENDING');}
  const r=require('./report.cjs').report(directory);assert.equal(r.quality,null);assert.equal(r.qualityStatus,'N/A-synthetic');assert.equal(Object.values(r.cost.stages).reduce((n,x)=>n+x.attempts,0),l.applicationEntryAttempts);
  if(!fault){const c=r.branchCoverage;assert.equal(c.targetBranchStatus,'synthetic-only');assert.equal(c.exactHistoricalCollisionLiveCovered,false);assert.equal(c.f05RevisionNewBasis,true);assert.equal(c.f05RevisionAuthorizationObserved,true);assert.equal(c.f05RevisionOldBoundedRecordsPreserved,true);assert.equal(c.f05RevisionSameBasisBoundedCollisionObserved,true);assert.equal(c.f06RestartBeforeAdvance,true);assert.equal(c.f06RestartAtReview,true);assert.ok(c.markerHandoffs.every(m=>m.newAuthorizationCount===1&&m.oldRecordsPreserved));assert.equal(fs.readdirSync(directory).filter(f=>f.endsWith('-outcome.json')).length,5);}
  write(path.join(directory,'cost-and-quality-status.json'),r);
  tests.push({name,passed:true,syntheticAttempts:l.applicationEntryAttempts,syntheticTransportExecutions:terminals.filter(t=>t.syntheticTransport).length,realModelCalls:0,runnerIdentity:s.runnerIdentity,summarySha256:sha(fs.readFileSync(path.join(directory,'summary.json'))),cases:s.results.map(c=>({caseId:c.caseId,attempts:c.applicationAttempts,technicalPassed:c.technicalPassed})),reservations:s.ledger.attempts.map(a=>({caseId:a.caseId,role:a.role,reservedTokens:a.reservedTokens,serializedInputBytes:a.serializedInputBytes,schemaBytes:a.schemaBytes}))});
 }
 const result={schema:1,passed:true,scope:guardsOnly?'stop-guards-only':'full-lifecycle-and-stop-guards',fullLifecyclePassed:!guardsOnly,releaseReady:false,tests,realModelCalls:0,actualHumanAcceptances:0,qualityMetrics:null};write(path.join(output,'integration-results.json'),result);return result;
}
module.exports={integration};if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'},'guards-only':{type:'boolean'}}});integration({executable:values.executable,output:values.output,guardsOnly:!!values['guards-only']}).then(r=>console.log(JSON.stringify({passed:r.passed,scenarios:r.tests.length,realModelCalls:0}))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
