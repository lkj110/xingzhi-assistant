'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const contract=require('../desktop/verification-output.cjs'),root=path.resolve(__dirname,'..'),{run}=require('./helpers/verification-stage-fixture.cjs');
const oldFetch=global.fetch;global.fetch=()=>{throw Error('No network in offline regression');};after(()=>global.fetch=oldFetch);
for(const phase of ['content','result'])for(const mode of ['read','final','classification'])test(phase+' '+mode+' uses only stage protocol without changing binding',async()=>{
 const {calls,result}=await run(root,{phase,mode});
 assert.equal(result.passed,true,result.summary);
 for(const call of calls){const final=!!call.payload.checkFinalization||!!call.payload.groundingClassificationReview;assert.equal(call.contract,final?contract.FINAL_ID:contract.select({retryFull:false}));
  const text=call.messages[0].content;assert.ok(text.includes('原文锚点只证明位置，不能证明语义成立'));assert.ok(text.includes('不能把混合肯定断言藏进unknown/inference'));assert.ok(text.includes('须≥2不同原文片段'));assert.ok(text.includes('每条要求恰好一次'));assert.ok(!text.includes('groundingReview:{'));assert.ok(!text.includes('evidencePlan:['));
  assert.equal(text.includes('read_context.requests:'),false);assert.equal(text.includes('retryFull'),false);
  if(final){assert.ok(!text.includes('缺正文用read_context'));assert.ok(!text.includes('可在read_context请求compute_evidence'));assert.ok(text.includes('60秒后失效'));}
 }
});
test('read stages omit disabled tools and retain incremental full recovery only when eligible',async()=>{
 const normal=await run(root,{search:false,compute:false}),incremental=await run(root,{search:false,compute:false,incremental:true});
 assert.equal(normal.calls[0].contract,contract.select({search:false,compute:false,retryFull:false}));
 assert.equal(incremental.calls[0].contract,contract.select({search:false,compute:false,retryFull:true}));assert.ok(incremental.calls[0].messages[0].content.includes('retryFull'));
});
test('HTTP verification retains textual report structure',async()=>{
 const {calls}=await run(root,{type:'openai'});assert.equal(calls[0].schema,null);assert.ok(calls[0].messages[0].content.includes('groundingReview:{'));
});
