const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../desktop/model-context.cjs'),subscription=require('../desktop/subscription.cjs'),errors=require('../desktop/model-errors.cjs');
test('large duplicated directories retain all current and historical handles without duplicate inventories',()=>{
 const rows=Array.from({length:600},(_,i)=>({id:'source-'+i,ref:'s:'+i,type:'source',title:'Reference '+i,purpose:i%3?'input':'delivery_readback',state:i<400?'active':'historical',version:'v'.repeat(64),resourceKey:'https://example.invalid/'+i,characters:100000,sections:Array.from({length:30},(_,n)=>({title:'Section '+n,start:n*1000,characters:1000})),readTool:'read_source'}));
 const original={scope:{jobId:'job'},guard:'unchanged-local-guard',readableCatalog:rows.slice(0,400),sourceCatalog:rows.slice(0,400),historyCatalog:rows.slice(400),currentArtifact:[],executionContract:{scope:'Preserve all current requirements'},contextReads:[{result:{segments:[{text:'Keep exact evidence'}]}}]};
 const before=JSON.stringify(original),result=view.project(original);
 assert.equal(result.readableCatalog,undefined);assert.equal(result.sourceCatalog.length,400);assert.equal(result.historyCatalog.length,200);
 assert.deepEqual([...result.sourceCatalog,...result.historyCatalog].map(r=>r.ref),rows.map(r=>r.ref));
 assert.ok(result.historyCatalog.every(r=>r.state==='historical'));assert.equal(result.sourceCatalog[0].sectionCount,30);
 assert.deepEqual(result.contextReads,original.contextReads);assert.deepEqual(result.executionContract,original.executionContract);assert.equal(result.guard,original.guard);
 assert.equal(JSON.stringify(original),before);assert.ok(JSON.stringify(result).length<before.length/3);
});
test('writer source directory preserves historical sources and current artifact handles',()=>{
 const current={id:'a',ref:'a:1',type:'artifact',state:'active',purpose:'artifact'},old={id:'s',ref:'s:1',type:'source',state:'historical',purpose:'delivery_readback'};
 const result=view.project({readableCatalog:[current],sourceCatalog:[old],historyCatalog:[old],currentArtifact:[current]});
 assert.deepEqual(result.sourceCatalog.map(r=>r.ref),['a:1']);assert.deepEqual(result.historyCatalog.map(r=>r.ref),['s:1']);
});
test('oversized subscription input is rejected locally without unknown usage or automatic retries',async()=>{
 let usage;await assert.rejects(subscription.chat({model:'unused'},'',[{role:'user',content:'x'.repeat(subscription.maxInputChars)}],{onUsage:value=>usage=value}),error=>error.code==='MODEL_CONFIG'&&error.automaticRetry===false&&error.diagnostic.kind==='input_too_large');
 assert.deepEqual(usage,{inputTokens:0,outputTokens:0,cachedInputTokens:0});
});
test('CLI input rejection is classified from a recognized stderr line without exposing raw output',()=>{
 const error=subscription.inputFailure('PRIVATE\nError: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1126243}\n');
 assert.equal(error.code,'MODEL_CONFIG');assert.equal(error.automaticRetry,false);assert.ok(!error.message.includes('PRIVATE'));
 assert.deepEqual(errors.diagnostic(error),{source:'codex_cli',kind:'input_too_large',maxChars:1048576,actualChars:1126243,inputPolicyVersion:require('../desktop/model-input.cjs').POLICY_VERSION});
 assert.equal(subscription.inputFailure(JSON.stringify({type:'agent_message',text:'Error: turn/start: turn/start failed: Input exceeds the maximum length of 100 characters. "actual_chars":200'})),null);
});
