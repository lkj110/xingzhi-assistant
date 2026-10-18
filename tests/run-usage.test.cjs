const {test}=require('node:test'),assert=require('node:assert/strict');
const helpers=import('../src/run-usage.mjs');
test('Run rows display recorded totals and costs including retries, without current model prices',async()=>{
 const {runUsageSummary}=await helpers;
 assert.equal(runUsageSummary({status:'done',usage:{reportedCalls:9,totalTokens:1781828,estimatedUSD:5.664731}}),'1,781,828 token · 折算 $5.6647');
 assert.equal(runUsageSummary({status:'done',usage:{reportedCalls:1,totalTokens:100,estimatedUSD:0}}),'100 token · 折算 $0.0000');
});
test('Unknown, partial and unpriced usage is never presented as free',async()=>{
 const {usageSummary,runUsageSummary,callUsage}=await helpers;
 assert.equal(usageSummary({reportedCalls:0,totalTokens:0,estimatedUSD:0,unknownCalls:1}),'用量未知 · 费用未知 · 1 次用量未知');
 assert.match(usageSummary({reportedCalls:2,totalTokens:500,estimatedUSD:1,unknownCalls:1,unpricedCalls:1}),/500 token · 已知折算 \$1.0000 · 1 次用量未知 · 1 次缺少单价/);
 assert.match(usageSummary(callUsage({status:'done',inputTokens:20,outputTokens:10})),/30 token · 费用待计价/);
 assert.equal(runUsageSummary({status:'done'}),'用量与费用未记录');
 assert.equal(runUsageSummary({status:'unchanged',modelCalls:0,finishedAt:'2026-10-18T00:00:00.000Z'}),'0 token · 折算 $0.0000 · 未调用模型');
 assert.doesNotMatch(runUsageSummary({status:'running',usage:{reportedCalls:0,estimatedUSD:0}}),/\$0/);
 assert.match(usageSummary(callUsage({status:'error',inputTokens:5,outputTokens:1,estimatedUSD:.01})),/6 token · 折算 \$0.0100/);
});
