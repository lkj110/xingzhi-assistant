'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const attribution=require('../desktop/input-attribution.cjs'),efficiency=require('../desktop/efficiency.cjs');
const messages=[{role:'system',content:'逐项核实。'},{role:'user',content:JSON.stringify({task:{criteria:'保留例外'},artifacts:[{content:'中文正文🙂'}],contextReads:[{request:{tool:'read_source'},result:{sourceId:'s',version:'v',content:'原文',coverage:{complete:false}}}],sourceCatalog:[{id:'s'}]})}];
test('attribution partitions exact serialized visible characters and UTF-8 bytes without retaining texts',()=>{
 const report=attribution.measure(messages),values=Object.values(report.categories);
 assert.equal(values.reduce((n,r)=>n+r.serializedChars,0),messages.reduce((n,m)=>n+m.content.length,0));
 assert.equal(values.reduce((n,r)=>n+r.utf8Bytes,0),messages.reduce((n,m)=>n+Buffer.byteLength(m.content),0));
 for(const key of ['systemInstructions','requirements','draft','evidenceBodies','toolReceipts','navigation'])assert.ok(report.categories[key].utf8Bytes>0,key);
 assert.ok(!JSON.stringify(report).includes('原文'));assert.equal(report.observedUsage,null);
});
test('actual total and approximate category allocations remain separate and sum exactly',()=>{
 const report=attribution.settle(attribution.measure(messages),{inputTokens:103,outputTokens:12,cachedInputTokens:80});
 assert.equal(report.observedUsage.totalTokens,115);assert.equal(report.observedUsage.cachedInputTokens,80);
 assert.equal(Object.values(report.categories).reduce((n,r)=>n+(r.estimatedInputTokens||0),0),103);
 assert.match(report.allocationMethod,/proportional/);assert.match(report.limitation,/estimates/);
});
test('missing or invalid usage never becomes zero consumption or a token estimate',()=>{
 for(const usage of [null,{}, {inputTokens:10,outputTokens:2,cachedInputTokens:11}]){
  const report=attribution.settle(attribution.measure(messages),usage);assert.equal(report.observedUsage,null);
  assert.ok(Object.values(report.categories).every(r=>r.estimatedInputTokens===undefined));
 }
});
test('noncanonical JSON, tool messages and multimodal input are measured without altering them',()=>{
 const input=[{role:'user',content:'{ "a": 1 }'},{role:'tool',content:'失败：权限不足'},{role:'user',content:[{type:'text',text:'字段'}]}],before=structuredClone(input);
 assert.ok(attribution.measure(input).categories.toolReceipts.utf8Bytes>0);assert.deepEqual(input,before);
});
test('production call persists attribution for successful and failed attempts without adding it to messages',async()=>{
 for(const fail of [false,true]){
  const run={id:'run'},a={data:{modelCalls:[]},activeSpendRun:run,save(){}};
  const invoke=async(p,k,m,o)=>{assert.deepEqual(m,messages);o.onUsage({inputTokens:97,outputTokens:3,cachedInputTokens:20});if(fail)throw Error('simulated transport failure');return {ok:true};};
  if(fail)await assert.rejects(efficiency.call(a,{model:'mock'},'',messages,{},invoke));else await efficiency.call(a,{model:'mock'},'',messages,{},invoke);
  assert.equal(a.data.modelCalls[0].inputAttribution.observedUsage.totalTokens,100);
  assert.deepEqual(run.modelCallsDetail[0].inputAttribution,a.data.modelCalls[0].inputAttribution);
 }
});
