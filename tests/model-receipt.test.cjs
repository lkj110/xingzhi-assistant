'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const receipts=require('../desktop/model-receipt.cjs');
test('receipt retains bounded terminal metadata without prompts, secrets or raw errors',()=>{
 const r=receipts.create('codex_cli','PRIVATE_PROMPT');
 r.event('thread.started',{threadId:'12345678-1234-1234-1234-123456789abc'});
 for(let i=0;i<100;i++)r.event('error',{requestId:'sk-PRIVATE_SECRET',errorCode:'PRIVATE_PROVIDER_ERROR'});
 r.event('turn.failed',{errorCode:'MODEL_CLI'});
 const s=r.snapshot();assert.equal(s.eventCount,102);assert.equal(s.events.length,64);assert.equal(s.events.at(-1).type,'turn.failed');assert.equal(s.usageStatus,'unknown');assert.equal(s.usage,null);assert.equal(s.references[0].id,'12345678-1234-1234-1234-123456789abc');assert.ok(!JSON.stringify(s).includes('PRIVATE'));assert.match(s.inputHash,/^[a-f0-9]{64}$/);
});
test('missing and conflicting usage remain unsettled instead of guessed or added',()=>{
 const r=receipts.create('codex_cli','input');r.event('turn.failed');assert.equal(r.snapshot().usageStatus,'unknown');assert.equal(r.snapshot().usage,null);
 r.event('turn.completed',{usage:{inputTokens:10,outputTokens:2}});r.event('turn.completed',{usage:{inputTokens:10,outputTokens:2}});assert.deepEqual(r.snapshot().usage,{inputTokens:10,outputTokens:2});
 r.event('turn.completed',{usage:{inputTokens:12,outputTokens:2}});assert.equal(r.snapshot().usageStatus,'conflicting');assert.equal(r.snapshot().usage,null);
 r.event('turn.completed',{usage:{inputTokens:10,outputTokens:2}});assert.equal(r.snapshot().usageStatus,'conflicting');assert.equal(r.snapshot().usage,null);
});
test('all supplied usage fields and cache constraints must be valid; invalid reports cannot revive',()=>{
 const good={inputTokens:10,outputTokens:2};
 for(const patch of [{inputTokens:-1},{inputTokens:Number.MAX_SAFE_INTEGER},{cachedInputTokens:-1},{cachedInputTokens:null},{cachedInputTokens:undefined},{cachedInputTokens:11},{cachedInputTokens:NaN},{cacheWriteTokens:1.5},{cachedInputTokens:5,cacheWriteTokens:6},{cacheWriteTokens:2,cacheWrite1hTokens:3},{cacheWrite1hTokens:1}]){
  const bad={...good,...patch};assert.equal(receipts.usage(bad),null);
  for(const prior of [false,true]){
   const r=receipts.create('codex_cli','input');if(prior)r.event('turn.completed',{usage:good});r.event('turn.completed',{usage:bad});r.event('turn.completed',{usage:good});r.event('process_exit');
   assert.equal(r.snapshot().usageStatus,'invalid');assert.equal(r.snapshot().usage,null);
  }
 }
 assert.deepEqual(receipts.usage({...good,cachedInputTokens:3,cacheWriteTokens:7,cacheWrite1hTokens:2}),{...good,cachedInputTokens:3,cacheWriteTokens:7,cacheWrite1hTokens:2});
});
test('HTTP protocol rejects invalid cache usage before callbacks or settlement',async t=>{
 const protocols=require('../desktop/model-protocols.cjs'),http=require('../desktop/model-http.cjs');
 for(const [type,data] of [
  ['openai',{usage:{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:-1}}}],
  ['openai',{usage:{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:null}}}],
  ['responses',{usage:{input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:11}}}],
  ['gemini',{usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,cachedContentTokenCount:-1}}],
  ['gemini',{usageMetadata:{promptTokenCount:10,candidatesTokenCount:1.5,thoughtsTokenCount:0.5}}],
  ['anthropic',{usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:null}}],
  ['anthropic',{usage:{input_tokens:10,output_tokens:2,cache_creation_input_tokens:2,cache_creation:{ephemeral_1h_input_tokens:3}}}],
 ])assert.equal(protocols.usage({type},data),null,type);
 for(const status of [200,503]){
  const out=[],usage=[];
  t.mock.method(global,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:-1}}}),{status}));
  const result=http.chat({type:'openai',model:'mock',baseUrl:'http://localhost:1/v1'},'PRIVATE_KEY',[],{onReceipt:r=>out.push(r),onUsage:u=>usage.push(u)});
  if(status===200)assert.deepEqual(await result,{ok:true});else await assert.rejects(result,e=>e.code==='MODEL_HTTP');
  assert.deepEqual(usage,[]);assert.equal(out[0].usage,null);assert.notEqual(out[0].usageStatus,'reported');
 }
});
test('HTTP failures retain provider request identity and reported usage; final errors keep receipt',async t=>{
 const http=require('../desktop/model-http.cjs'),out=[],usage=[];
 t.mock.method(global,'fetch',async()=>new Response(JSON.stringify({error:{code:'server_error',message:'PRIVATE'},usage:{prompt_tokens:12,completion_tokens:4}}),{status:503,headers:{'x-request-id':'req_0123456789abcdef0123456789abcdef'}}));
 await assert.rejects(http.chat({type:'openai',model:'mock',baseUrl:'http://localhost:1/v1'},'PRIVATE_KEY',[],{onReceipt:r=>out.push(r),onUsage:u=>usage.push(u)}),e=>e.code==='MODEL_HTTP');
 assert.equal(out.length,1);assert.equal(out[0].references[0].id,'req_0123456789abcdef0123456789abcdef');assert.equal(out[0].usageStatus,'reported');assert.equal(usage[0].inputTokens,12);assert.ok(!JSON.stringify(out).includes('PRIVATE'));
});
