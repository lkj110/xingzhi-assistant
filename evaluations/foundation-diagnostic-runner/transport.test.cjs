'use strict';
// Local child processes only. No model CLI or model endpoint is used.
const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),{runTransport}=require('./transport.cjs');
const emit=v=>'process.stdout.write('+JSON.stringify(JSON.stringify(v)+'\n')+');';
const usage={input_tokens:12040,output_tokens:61,cached_input_tokens:0};
const run=(source,extra={})=>runTransport({bin:process.execPath,args:['-e',source],input:'synthetic fixture input',cwd:os.tmpdir(),timeoutMs:5000,idleTimeoutMs:3000,...extra});
test('failed CLI event is observed and process stopped without inventing usage',async()=>{
 await assert.rejects(run(emit({type:'turn.failed',error:{code:'SYNTHETIC_REJECTION',message:'Upstream unavailable',http_status:503}})+'setInterval(()=>{},1000);'),e=>{assert.equal(e.code,'CLI_TURN_FAILED');assert.equal(e.usageUnknown,true);assert.equal(e.usage,undefined);assert.equal(e.processTreeConfirmed,true);assert.equal(e.diagnostics.events[0].details.error.code,'SYNTHETIC_REJECTION');assert.equal(e.diagnostics.terminal.authoritativeUsagePresent,false);return true;});
});
test('prior authoritative usage and exact forwarded frames survive a later failure',async()=>{
 const frames=[];await assert.rejects(run(emit({type:'turn.completed',usage})+emit({type:'error',message:'Synthetic rejection'})+'setInterval(()=>{},1000);',{onFrame:f=>frames.push(f)}),e=>{assert.equal(e.usage.totalTokens,12101);assert.equal(e.usageUnknown,false);assert.equal(e.diagnostics.terminal.authoritativeUsagePresent,true);assert.ok(frames.some(f=>f.data.includes('Synthetic rejection')));return true;});
});
test('no-newline error is captured and success retains original usage',async()=>{
 await assert.rejects(run('process.stdout.write('+JSON.stringify(JSON.stringify({type:'error',message:'Last line'}))+');'),e=>e.code==='CLI_ERROR_EVENT'&&e.diagnostics.events[0].details.message==='Last line');
 const r=await run(emit({type:'turn.completed',usage}));assert.equal(r.usage.totalTokens,12101);assert.equal(r.diagnostics.terminal.outcome,'completed');assert.equal(r.diagnostics.events.length,0);
});
test('cancellation and invalid input keep original no-dispatch behavior',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(run('',{signal:controller.signal}),e=>e.code==='CLI_CANCELLED'&&e.started===false&&e.diagnostics.terminal.started===false);
 await assert.rejects(run('',{bin:'relative'}),e=>e.code==='CLI_INPUT_REJECTED'&&e.started===false);
});
