'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),{createRequire}=require('node:module');
const contract=require('../desktop/verification-output.cjs');
function fixture(t,run,{onKill,spawnError}={}){
 const file=path.resolve(__dirname,'../desktop/subscription.cjs'),base=createRequire(file),children=new Map(),schemas=[],kills=[];let calls=0;
 const bin=path.join('/fixture','codex');
 const fakeFS={...fs,statSync(p){if(path.basename(p)==='codex'){if(p===bin)return {isFile:()=>true};throw Error('missing');}return fs.statSync(p);},accessSync(p){if(p!==bin)fs.accessSync(p);}};
 const context={module:{exports:{}},Buffer,setTimeout:(fn,ms)=>setTimeout(fn,ms===60000?25:ms===1500?60:ms),clearTimeout,process:{platform:'linux',env:{PATH:'/fixture'},kill(pid,signal){kills.push(signal);const child=children.get(-pid);onKill?.(child,signal);}},require(name){if(name==='node:fs')return fakeFS;if(name==='node:child_process')return {spawn(_bin,args){
  if(args[0]==='exec'&&spawnError)throw Object.assign(Error('PRIVATE_SPAWN'),{code:'ETIMEDOUT'});
  const child=new EventEmitter();child.pid=children.size+1;children.set(child.pid,child);child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=()=>queueMicrotask(()=>{if(args[0]==='login'){child.stdout.emit('data',Buffer.from('Logged in using ChatGPT'));child.emit('close',0);}else{calls++;schemas.push(JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8')));run(child,args);}});return child;
 }};return base(name);}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
 const usage=[],receipts=[];return {schemas,kills,usage,receipts,count:()=>calls,chat:context.module.exports.chat,call:options=>context.module.exports.chat({model:'offline',requestPolicy:{idleMinutes:1,totalMinutes:0}},'',[],{onUsage:v=>usage.push(v),onReceipt:v=>receipts.push(v),...options})};
}
const event=(child,value)=>child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));
test('idle timeout after turn start records process termination without inventing usage',async t=>{
 const f=fixture(t,c=>{event(c,{type:'thread.started',thread_id:'PRIVATE_THREAD'});event(c,{type:'turn.started'});},{onKill:(c)=>setTimeout(()=>c.emit('close',null,'SIGTERM'),2)});
 await assert.rejects(f.call(),e=>e.code==='MODEL_TIMEOUT'&&e.timeoutKind==='idle');
 const r=f.receipts.at(-1);assert.equal(r.usageStatus,'unknown');assert.equal(r.usage,null);assert.equal(f.usage.length,0);assert.equal(r.process.state,'closed');assert.equal(r.process.timeoutKind,'idle');assert.equal(r.process.terminationRequested,true);assert.ok(r.process.durationMs>=20);assert.ok(r.process.stdoutBytes>0);assert.equal(r.events.at(-1).type,'process_exit');assert.equal(r.events.at(-1).errorCode,'MODEL_TIMEOUT');assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.equal(f.count(),1);
});
test('first timeout survives later total timeout/cancellation; late terminal usage is retained',async t=>{
 const controller=new AbortController();let closeScheduled=false;
 const f=fixture(t,c=>{event(c,{type:'turn.started'});setTimeout(()=>controller.abort(),45);},{onKill:c=>{if(closeScheduled)return;closeScheduled=true;setTimeout(()=>{event(c,{type:'turn.completed',usage:{input_tokens:91,output_tokens:7}});c.emit('close',null,'SIGTERM');},55);}});
 await assert.rejects(f.call({timeoutMs:40,signal:controller.signal}),e=>e.timeoutKind==='idle');
 assert.deepEqual(f.usage,[{inputTokens:91,outputTokens:7}]);assert.equal(f.receipts.at(-1).process.timeoutKind,'idle');assert.equal(f.receipts.at(-1).usageStatus,'reported');assert.equal(f.count(),1);
});
test('split UTF-8 and final unterminated usage line are decoded before the failure receipt',async t=>{
 const f=fixture(t,c=>{const line=Buffer.from(JSON.stringify({type:'turn.failed',error:{code:'server_error',message:'中文私密内容'},usage:{input_tokens:17,output_tokens:3}}));const i=line.indexOf(Buffer.from('中'))+1;c.stdout.emit('data',line.subarray(0,i));c.stdout.emit('data',line.subarray(i));c.emit('close',1);});
 await assert.rejects(f.call());assert.deepEqual(f.usage,[{inputTokens:17,outputTokens:3}]);assert.equal(f.receipts.at(-1).events.at(-1).exitCode,1);assert.ok(!JSON.stringify(f.receipts).includes('中文'));
});
test('spawn failure and stderr-only activity remain local facts, never remote progress or zero usage',async t=>{
 const missing=fixture(t,()=>{}, {spawnError:true});await assert.rejects(missing.call());assert.equal(missing.receipts.at(-1).process.state,'spawn_failed');assert.equal(missing.receipts.at(-1).usageStatus,'unknown');assert.equal(missing.usage.length,0);
 const f=fixture(t,c=>{c.stderr.emit('data',Buffer.from('PRIVATE_HEARTBEAT'));},{onKill:c=>c.emit('close',1)});await assert.rejects(f.call());const r=f.receipts.at(-1);assert.equal(r.process.stdoutBytes,0);assert.ok(r.process.stderrBytes>0);assert.equal(r.events.length,1);assert.equal(r.usageStatus,'unknown');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('strict verifier schema is actually passed to CLI and malformed inner strings cannot start repair',async t=>{
 const f=fixture(t,(c,args)=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:{kind:'read_context',requests:[{tool:'read_source',sourceId:'source',ref:null}]}}));event(c,{type:'turn.completed',usage:{input_tokens:10,output_tokens:4}});c.emit('close',0);});
 assert.deepEqual(await f.call({responseContract:contract.ID}),{kind:'read_context',requests:[{tool:'read_source',sourceId:'source'}]});assert.deepEqual(f.schemas[0],contract.schema);assert.equal(f.usage.length,1);
 const bad=fixture(t,(c,args)=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:'{"passed":true,"gaps":[] stray}'}));event(c,{type:'turn.completed',usage:{input_tokens:10,output_tokens:4}});c.emit('close',0);});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verification-output-core-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const {Assistant}=require('../desktop/core.cjs'),a=new Assistant({dir,chat:bad.chat});await a.dispatch('saveProvider',{type:'codex',model:'offline',name:'offline',requestPolicy:{retries:0}});
 await assert.rejects(a.callModel(a.available('verify'),'',[],{role:'verify',stage:'task_verify',responseContract:contract.ID}),e=>e.code==='MODEL_INVALID_RESPONSE'&&!e.jsonRepairable);
 assert.equal(bad.count(),1);assert.equal(a.data.modelCalls.length,1);const row=a.data.modelCalls[0];assert.equal(row.inputTokens,10);assert.equal(row.outputTokens,4);assert.deepEqual(row.inputAttribution.transportSchema,contract.metadata);assert.equal(row.transportReceipt.process.state,'closed');assert.deepEqual(new Assistant({dir}).data.modelCalls[0].transportReceipt,row.transportReceipt);
});
test('legacy calls keep string envelope for planner, nonstrict, cache and goal verification',async t=>{
 const f=fixture(t,(c,args)=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:'{"passed":false,"summary":"缺口","gaps":["待补证"]}'}));event(c,{type:'turn.completed',usage:{input_tokens:10,output_tokens:4}});c.emit('close',0);});
 assert.equal((await f.call()).passed,false);assert.equal(f.schemas[0].properties.response_json.type,'string');
});

test('final CLI schema rejects read requests without repair and keeps actual reported usage',async t=>{
 const f=fixture(t,(c,args)=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:{kind:'read_context',requests:[]}}));event(c,{type:'turn.completed',usage:{input_tokens:19,output_tokens:5}});c.emit('close',0);});
 await assert.rejects(f.call({responseContract:contract.FINAL_ID}),e=>e.code==='MODEL_INVALID_RESPONSE'&&!e.jsonRepairable);
 assert.deepEqual(f.schemas[0],contract.get(contract.FINAL_ID).schema);assert.deepEqual(f.usage,[{inputTokens:19,outputTokens:5}]);assert.equal(f.count(),1);
 const bad=fixture(t,()=>assert.fail('unknown contract cannot dispatch'));await assert.rejects(bad.call({responseContract:'unknown'}),e=>e.code==='MODEL_CONFIG');assert.equal(bad.count(),0);
});
