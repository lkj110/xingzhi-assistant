'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {runTransport,environment,MAX_OUTPUT_BYTES}=require('./transport.cjs');
const usage={input_tokens:100,output_tokens:20,cached_input_tokens:10},completed={type:'turn.completed',usage};
const emit=value=>'process.stdout.write('+JSON.stringify(JSON.stringify(value)+'\n')+');';
function run(body,extra={}){return runTransport({bin:process.execPath,args:['-e','process.stdin.resume();'+body],input:'synthetic input only',cwd:__dirname,env:environment(),timeoutMs:10000,idleTimeoutMs:3000,...extra});}
function directory(t){const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'foundation-transport-test-'));t.after(()=>{assert.ok(fs.realpathSync(dir).startsWith(base+path.sep)&&path.basename(dir).startsWith('foundation-transport-test-'));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('environment matches frozen subscription whitelist and excludes keys and injection options',()=>{
 const result=environment({PATH:'synthetic-path',CODEX_HOME:'synthetic-profile',HTTPS_PROXY:'synthetic-proxy',OPENAI_API_KEY:'synthetic-secret',NODE_OPTIONS:'synthetic-injection',ELECTRON_RUN_AS_NODE:'1',UNRELATED:'test'});
 assert.deepEqual(result,{PATH:'synthetic-path',CODEX_HOME:'synthetic-profile',HTTPS_PROXY:'synthetic-proxy'});
 const source=fs.readFileSync(path.resolve(__dirname,'../../desktop/subscription.cjs'),'utf8'),match=source.match(/function environment\(\)\s*\{[\s\S]*?\[([^\]]+)\]/);assert.ok(match);const keys=[...match[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);const fake=Object.fromEntries(keys.map(k=>[k,'value']));assert.deepEqual(Object.keys(environment(fake)),keys);
});
test('split UTF-8 stdout/stderr is forwarded exactly and successful raw usage is retained',async()=>{
 const stdout=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'证据绑定，中文完整。'}})+'\n'+JSON.stringify(completed)+'\n',stderr='合成诊断：启动完成。\n',frames=[];
 const body=`(async()=>{const out=Buffer.from(${JSON.stringify(stdout)}),err=Buffer.from(${JSON.stringify(stderr)});for(let i=0;i<Math.max(out.length,err.length);i++){if(i<out.length)process.stdout.write(out.subarray(i,i+1));if(i<err.length)process.stderr.write(err.subarray(i,i+1));await new Promise(r=>setTimeout(r,2));}})();`;
 const result=await run(body,{onFrame:f=>frames.push(f)});
 assert.equal(result.code,0);assert.equal(result.usageUnknown,false);assert.equal(result.processTreeConfirmed,true);assert.deepEqual(result.usage,{inputTokens:100,outputTokens:20,cachedInputTokens:10,totalTokens:120});assert.deepEqual(result.rawUsageEvents,[completed]);assert.equal(result.usageEvents,1);
 assert.equal(frames.filter(f=>f.channel==='stdout').map(f=>f.data).join(''),stdout);assert.equal(frames.filter(f=>f.channel==='stderr').map(f=>f.data).join(''),stderr);
});
test('valid usage survives nonzero exit and remains attributable rather than becoming unknown',async()=>{
 await assert.rejects(run(emit(completed)+'process.exitCode=7;'),e=>{assert.equal(e.code,'CLI_EXIT_FAILED');assert.equal(e.exitCode,7);assert.equal(e.usageUnknown,false);assert.equal(e.usage.totalTokens,120);assert.deepEqual(e.rawUsageEvents,[completed]);return true;});
});
test('repeated identical completion usage is not double-counted',async()=>{const result=await run(emit(completed)+emit(completed));assert.equal(result.usageEvents,2);assert.equal(result.usage.totalTokens,120);assert.equal(result.rawUsageEvents.length,2);});
test('missing optional cache survives transport-to-ledger settlement as unknown',async t=>{
 const {Ledger}=require('./ledger.cjs'),plan=require('../foundation-acceptance-20261028/plan.json'),sealIdentity=require('../foundation-acceptance-20261028/seal.json').identity;
 const ledger=new Ledger({dir:directory(t),plan,sealIdentity,mode:'offline'}),attempt=ledger.admit({caseId:'G00-ronglan',role:'verify',stage:'cache-test',serializedInputBytes:100,schemaBytes:100,visibleBytes:100});
 const result=await run(emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));assert.equal(result.usage.cachedInputTokens,undefined);ledger.settle(attempt.id,result.usage);
 assert.equal(ledger.snapshot().totals.totalTokens,120);assert.equal(ledger.snapshot().attempts[0].usage.cachedInputTokens,null);assert.equal(ledger.snapshot().stop,null);
});
test('missing completion and malformed usage fail closed with no invented token count',async t=>{
 await t.test('missing',async()=>{await assert.rejects(run(emit({type:'fixture.finished'})),e=>e.code==='CLI_MISSING_USAGE'&&e.usageUnknown===true&&!e.usage&&e.usageEvents===0);});
 for(const bad of [null,{}, {input_tokens:10},{input_tokens:-1,output_tokens:10},{input_tokens:10,output_tokens:1,cached_input_tokens:11}])await t.test(JSON.stringify(bad),async()=>{await assert.rejects(run(emit({type:'turn.completed',usage:bad})),e=>e.code==='CLI_INVALID_USAGE'&&e.usageUnknown===true&&!e.usage&&e.rawUsageEvents.length===1);});
});
test('conflicting or invalid later usage removes certainty but preserves both raw events',async t=>{
 for(const later of [{type:'turn.completed',usage:{...usage,input_tokens:101}},{type:'turn.completed',usage:{...usage,output_tokens:-1}}])await t.test(JSON.stringify(later.usage),async()=>{
  await assert.rejects(run(emit(completed)+emit(later)+'setInterval(()=>{},1000);'),e=>{assert.ok(['CLI_CONFLICTING_USAGE','CLI_INVALID_USAGE'].includes(e.code));assert.equal(e.usageUnknown,true);assert.equal(e.usage,undefined);assert.deepEqual(e.rawUsageEvents,[completed,later]);return true;});
 });
});
test('host-tool and provider error events stop the process while retaining valid earlier usage',async t=>{
 for(const event of [{type:'item.started',item:{type:'command_execution',status:'in_progress'}},{type:'turn.failed',error:{message:'synthetic rejection'}},{type:'error',message:'synthetic protocol failure'}])await t.test(event.type,async()=>{
  await assert.rejects(run(emit(completed)+emit(event)+'setInterval(()=>{},1000);'),e=>{assert.equal(e.code,event.type==='item.started'?'HOST_TOOL_ATTEMPT':'CLI_PROTOCOL_REJECTION');assert.equal(e.usage.totalTokens,120);assert.equal(e.usageUnknown,false);assert.equal(e.processTreeConfirmed,true);return true;});
 });
});
test('cancel terminates the entire synthetic process tree and waits for closure',async t=>{
 const dir=directory(t),heartbeat=path.join(dir,'heartbeat.txt'),controller=new AbortController();let descendant,buffer='';
 const nested=`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(heartbeat)},'start\\n');process.stdout.write('ready\\n');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'tick\\n'),50);`;
 const body=`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:['ignore','pipe','ignore'],windowsHide:true});child.stdout.once('data',()=>process.stdout.write(JSON.stringify({type:'fixture.descendant-ready',pid:child.pid})+'\\n'));setInterval(()=>{},1000);`;
 await assert.rejects(run(body,{signal:controller.signal,onFrame:f=>{if(f.channel!=='stdout')return;buffer+=f.data;let i;while((i=buffer.indexOf('\n'))>=0){const e=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(e.type==='fixture.descendant-ready'){descendant=e.pid;controller.abort();}}}}),e=>e.code==='CLI_CANCELLED'&&e.processTreeConfirmed===true);
 assert.ok(Number.isSafeInteger(descendant));const bytes=fs.statSync(heartbeat).size;await new Promise(r=>setTimeout(r,250));assert.equal(fs.statSync(heartbeat).size,bytes);assert.throws(()=>process.kill(descendant,0),e=>e.code==='ESRCH');
});
test('pre-cancelled request never starts a child and signal listeners are removed on normal completion',async()=>{
 const first=new AbortController();first.abort();await assert.rejects(run(emit(completed),{signal:first.signal}),e=>e.code==='CLI_CANCELLED'&&e.started===false);
 const second=new AbortController(),{getEventListeners}=require('node:events');await run(emit(completed),{signal:second.signal});assert.equal(getEventListeners(second.signal,'abort').length,0);
});
test('idle and total deadlines stop local hanging processes',async t=>{
 await t.test('idle',async()=>{await assert.rejects(run(emit({type:'fixture.ready'})+'setInterval(()=>{},1000);',{idleTimeoutMs:1000,timeoutMs:6000}),e=>e.code==='CLI_IDLE_TIMEOUT'&&e.processTreeConfirmed===true);});
 await t.test('total',async()=>{await assert.rejects(run("setInterval(()=>process.stdout.write(JSON.stringify({type:'fixture.progress'})+'\\n'),50);",{idleTimeoutMs:3000,timeoutMs:1000}),e=>e.code==='CLI_TOTAL_TIMEOUT'&&e.processTreeConfirmed===true);});
});
test('output bound, invalid UTF-8 and frame failures stop without unhandled events',async t=>{
 await t.test('bounded output',async()=>{await assert.rejects(run(`process.stdout.write('x'.repeat(${MAX_OUTPUT_BYTES+1}));setInterval(()=>{},1000);`),e=>e.code==='CLI_OUTPUT_LIMIT'&&e.usageUnknown===true);});
 await t.test('UTF-8',async()=>{await assert.rejects(run('process.stdout.write(Buffer.from([0xff]));'),e=>e.code==='CLI_INVALID_UTF8');});
 await t.test('frame delivery',async()=>{await assert.rejects(run(emit(completed),{onFrame:()=>{throw Error('synthetic closed receiver');}}),e=>e.code==='CLI_FRAME_FAILED'&&e.usage.totalTokens===120);});
});
