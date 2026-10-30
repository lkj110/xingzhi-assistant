'use strict';
// Reuse the frozen terminal-outcome scoring rules. Only the declared population
// changes: two unfinished generated workflows and no fixed-invalid controls.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('../foundation-citation-offline-runner/report.cjs'),{read}=require('./identity.cjs');
const ORDER=['F05-jianping-revision','F06-yunshu-restart'];
function scoped(result,summary){
 const ids=summary.results.map(c=>c.caseId);assert.equal(new Set(ids).size,ids.length);assert.deepEqual(ids,ORDER.slice(0,ids.length));assert.ok(ids.length<=2);assert.ok(summary.results.every(c=>c.lane!=='fixed_invalid'));
 assert.equal(result.attemptedFixedInvalidCases,0);assert.equal(result.attemptedGeneratedCases,ids.length);
 result.plannedGeneratedCases=2;result.unattemptedGeneratedCases=2-ids.length;result.plannedFixedInvalidCases=0;result.completionScope='F05/F06 only; F04 historical human-operation check is separate';
 if(result.quality){const q=result.quality;assert.ok(q.completionPlanned.numerator<=2);q.completionPlanned={numerator:q.completionPlanned.numerator,denominator:2,rate:q.completionPlanned.numerator/2};assert.equal(q.fixedInvalidRelease.denominator,0);assert.equal(q.fixedInvalidRelease.rate,null);}
 if(result.branchCoverage){delete result.branchCoverage.sixCaseWorkflowCompleted;result.branchCoverage.subsetWorkflowCompleted=summary.passed===true&&ids.length===2;}
 return result;
}
function report(output,adjudication){
 const run=read(path.join(output,'run.json')),summaries=Object.fromEntries(['gate','business'].map(p=>{const file=path.join(output,p,'summary.json');return [p,fs.existsSync(file)?read(file):null];}));
 const phases={};let totalTokens=0,knownTokenSubtotal=0,attempts=0,unknown=false;
 for(const phase of ['gate','business']){
  const summary=summaries[phase],started=fs.existsSync(path.join(output,phase+'.started.json')),totals=summary?.ledger?.totals;
  phases[phase]={started,totalTokens:totals?totals.totalTokens:started?null:0,knownTokenSubtotal:totals?.knownTokenSubtotal||0,applicationAttempts:totals?.applicationEntryAttempts??(started?null:0)};
  if(phases[phase].totalTokens===null)unknown=true;else totalTokens+=phases[phase].totalTokens;
  knownTokenSubtotal+=phases[phase].knownTokenSubtotal;if(phases[phase].applicationAttempts!==null)attempts+=phases[phase].applicationAttempts;
 }
 const business=summaries.business?scoped(base.report(path.join(output,'business'),adjudication),summaries.business):null;
 return {schema:1,runId:run.runId,mode:run.mode,runnerIdentity:run.runnerIdentity,asarSha256:run.asarSha256,synthetic:run.mode==='offline',installed:false,phaseCompletions:Object.fromEntries(['gate','business'].map(p=>[p,fs.existsSync(path.join(output,p+'.completed.json'))])),
  f04Prerequisite:read(path.join(__dirname,'plan.json')).f04Prerequisite,
  gate:summaries.gate?{passed:summaries.gate.passed,realCliExecutions:summaries.gate.realCliExecutions}:null,
  cost:{synthetic:run.mode==='offline',totalTokens:unknown?null:totalTokens,knownTokenSubtotal,knownApplicationAttempts:attempts,complete:!unknown,phases},business};
}
module.exports={scoped,report};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},adjudication:{type:'string'}}});console.log(JSON.stringify(report(values.output,values.adjudication?read(values.adjudication):undefined),null,2));}
