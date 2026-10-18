'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('../scripts/history-report.cjs');
test('history money summaries allow one ULP but reject negative, nonfinite and material changes',()=>{
 const report={};h.sameUSD(report,5.025775499999995,5.0257754999999955,'heldUSD','preCold');
 for(const [actual,expected] of [[-1e-13,0],[0,-1e-13],[NaN,0],[Infinity,0],['0',0],[0.01,0],[1e-12,0]])
  assert.throws(()=>h.sameUSD(report,actual,expected,'heldUSD','postCold'),/heldUSD.*postCold.*tolerance/);
 assert.equal(report.ledgerComparisons[0].delta,-8.881784197001252e-16);
});
for(const phase of ['futureBoundary_missing','unexpected_verify','preCold','postCold'])
test('history failure at '+phase+' retains latest observation and unverified cold status',()=>{
 const a={data:{delegations:[{id:'j',status:'blocked',lastError:'latest'}],tasks:[{id:'t',primaryArtifactId:'new'}],agentRuns:[]},executions:new Map()};
 const report={at:'2000',phase,finalColdRestartVerified:false,firstRun:{job:{status:'ready'},primary:'old'}};
 const original=new Error('failure at '+phase);h.failed(report,original,a,'j','t');
 assert.equal(report.currentRun.primary,'new');assert.equal(report.job.status,'blocked');assert.equal(report.firstRun.primary,'old');
 assert.equal(report.failedAt,phase);assert.equal(report.finalColdRestartVerified,false);assert.equal(report.error.message,original.message);assert.equal(report.policy,null);
});
test('history diagnostics never replace the original failure if state observation also fails',()=>{
 const report={phase:'postCold',finalColdRestartVerified:false},a={get data(){throw Error('observation failed');}};
 h.failed(report,new Error('original assertion failed'),a,'j','t');
 assert.equal(report.error.message,'original assertion failed');assert.equal(report.observationError,'observation failed');assert.equal(report.finalColdRestartVerified,false);
});
