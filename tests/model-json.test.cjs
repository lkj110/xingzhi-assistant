const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const json=require('../desktop/model-json.cjs'),{Assistant,modelChat}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),spend=require('../desktop/spend.cjs'),fallback=require('../desktop/model-fallback.cjs');
const value={content:'正文\n"引号"和 \\ 路径',tool:'ask',args:{question:'补充范围'}};
for(const [name,input] of [['plain',JSON.stringify(value)],['BOM','\uFEFF'+JSON.stringify(value)],['fence','```json\n'+JSON.stringify(value)+'\n```'],['encoded',JSON.stringify(JSON.stringify(value))]])test(`JSON parser accepts ${name} without changing content`,()=>{assert.deepEqual(json.parse(input),value);assert.deepEqual(json.subscription(JSON.stringify({response_json:input})),value);});
test('subscription accepts a structured response_json value and rejects a missing envelope',()=>{assert.deepEqual(json.subscription(JSON.stringify({response_json:value})),value);assert.throws(()=>json.subscription(JSON.stringify(value)),e=>e.jsonRepairable);});
for(const bad of ['{"PRIVATE_DRAFT":','Text before {"ok":true}','{"a":1}{"b":2}','null','42','"just text"'])test(`malformed JSON is not guessed: ${bad.slice(0,20)}`,()=>{assert.throws(()=>json.parse(bad),e=>e.code==='MODEL_INVALID_RESPONSE'&&e.jsonRepairable&&e.responseText===bad&&!JSON.stringify(e).includes('PRIVATE_DRAFT')&&!e.message.includes(bad));});
test('repair context is bounded and preserves the original messages',()=>{const original=[{role:'system',content:'original'}];assert.equal(json.repairMessages(original,{responseText:'x'.repeat(64001)}).length,2);assert.equal(original.length,1);assert.equal(json.repairMessages(original,{responseText:'small'})[1].role,'assistant');});
async function setup(t,chat){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-json-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});
 await a.dispatch('saveProvider',{name:'测试模型',model:'test',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:1});
 const j=agent.buildJob(a,{goal:'JSON 修复测试'});a.data.delegations.push(j);a.activeAgentJob=j;
 return {a,j,request:(options={})=>a.callModel(a.data.providers[0],'',[{role:'user',content:'PRIVATE_CONTEXT'}],{role:'execute',stage:'task_work',...options})};
}
const report=o=>o.onUsage({inputTokens:100,outputTokens:20});
test('one same-model format repair is separately metered in the original scope and no drafts are saved',async t=>{
 const seen=[];const {a,j,request}=await setup(t,async(p,k,m,o)=>{seen.push({provider:p.id,m,stage:o.stage,requestId:o.requestId,attempt:o.attempt});report(o);return json.parse(seen.length===1?'{"PRIVATE_DRAFT":':JSON.stringify(value));});
 await a.dispatch('saveProvider',{name:'备用',model:'backup',baseUrl:'https://backup.invalid/v1',inputPrice:1,outputPrice:1});const snap=fallback.snapshot(a);snap.roles.execute={enabled:true,providerId:a.data.providers[1].id};await a.dispatch('modelFallbackSave',{revision:snap.revision,roles:snap.roles});
 assert.deepEqual(await request(),value);assert.equal(seen.length,2);assert.equal(seen[0].provider,seen[1].provider);assert.equal(seen[0].requestId,seen[1].requestId);assert.equal(seen[1].stage,'json_repair');assert.equal(seen[1].attempt,2);assert.ok(seen[1].m.some(m=>m.content.includes('PRIVATE_DRAFT')));
 assert.equal(j.callsUsed,2);assert.equal(j.usage.reportedCalls,2);const s=spend.summaries(a).scopes[0];assert.equal(s.limitUSD,100);assert.equal(s.spentUSD,.00024);assert.equal(s.usage.inputTokens,200);assert.equal(a.data.modelCalls[0].stage,'json_repair');
 assert.ok(!fs.readFileSync(a.file,'utf8').includes('PRIVATE_DRAFT'));assert.ok(!JSON.stringify(a.data.modelCalls).includes('PRIVATE_CONTEXT'));
});
test('failed immediate repair yields a retryable error for delayed recovery',async t=>{let calls=0;const {a,request}=await setup(t,async(p,k,m,o)=>{calls++;report(o);return json.parse('{');});await assert.rejects(request(),e=>e.code==='MODEL_INVALID_RESPONSE'&&e.automaticRetry===true&&/延迟恢复/.test(e.message));assert.equal(calls,2);assert.equal(a.data.modelCalls.length,2);});
for(const state of ['budget','abort','pause','config'])test(`${state} prevents automatic format repair`,async t=>{
 let calls=0;const controller=new AbortController();let fixture;
 fixture=await setup(t,async(p,k,m,o)=>{calls++;if(state!=='unknown usage')o.onUsage({inputTokens:state==='budget'?101000000:100,outputTokens:20});if(state==='abort')controller.abort();if(state==='pause')fixture.j.status='paused';if(state==='config')fixture.a.data.providers[0].model='changed';return json.parse('{');});
 await assert.rejects(fixture.request({signal:controller.signal}),e=>state==='unknown usage'?e.spendKind==='unknown':state==='budget'?e.spendKind==='budget':state==='abort'||state==='pause'?e.code==='MODEL_CANCELLED':e.code==='MODEL_INVALID_RESPONSE');assert.equal(calls,1);
});
for(const stage of ['connection_test','evaluation'])test(`${stage} does not hide invalid JSON with a repair`,async t=>{let calls=0;const {request}=await setup(t,async(p,k,m,o)=>{calls++;report(o);return json.parse('{');});await assert.rejects(request({stage}));assert.equal(calls,1);});
test('failed repair without usage retains reservation and stops bounded format repair',async t=>{let calls=0;const {request}=await setup(t,async(p,k,m,o)=>{if(++calls===1)report(o);return json.parse('{');});await assert.rejects(request(),e=>e.code==='MODEL_INVALID_RESPONSE'&&!e.spendLimit);assert.equal(calls,2);});
test('OpenAI compatible response flows through parsing, format repair and real usage reporting',async t=>{
 let calls=0;const server=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const payload=JSON.parse(body);calls++;if(calls===2)assert.match(payload.messages.at(-1).content,/只修复格式/);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:calls===1?'{"broken":':JSON.stringify(value)}}],usage:{prompt_tokens:50,completion_tokens:10}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const {a,request}=await setup(t,modelChat);a.data.providers[0].baseUrl=`http://127.0.0.1:${server.address().port}/v1`;assert.deepEqual(await request(),value);assert.equal(calls,2);assert.equal(a.data.modelCalls[1].usageReported,true);assert.equal(a.data.modelCalls[0].usageReported,true);
});
test('subscription CLI reports usage before parsing and removes its transient response after failure',async t=>{
 const vm=require('node:vm'),{EventEmitter}=require('node:events'),createRequire=require('node:module').createRequire;
 const filename=path.resolve(__dirname,'../desktop/subscription.cjs'),realRequire=createRequire(filename),roots=[];let response='{"broken":',usage;
 const fakeFS={...fs,statSync:p=>String(p).replaceAll('\\','/')==='/fixture/codex'?{isFile:()=>true}:fs.statSync(p),accessSync:p=>String(p).replaceAll('\\','/')==='/fixture/codex'?undefined:fs.accessSync(p),mkdtempSync:p=>{const root=fs.mkdtempSync(p);roots.push(root);return root;}};
 const spawn=(_bin,args)=>{const child=new EventEmitter();child.pid=12345;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>queueMicrotask(()=>{
   if(args[0]==='login')child.stdout.emit('data',Buffer.from('Logged in using ChatGPT'));
   else{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:response}));child.stdout.emit('data',Buffer.from(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5,cached_input_tokens:2}})+'\n'));}
   child.emit('close',0);
 });return child;};
 const context={module:{exports:{}},process:{env:{PATH:'/fixture'},kill:()=>{}},Buffer,setTimeout,clearTimeout,require:n=>n==='node:fs'?fakeFS:n==='node:child_process'?{spawn}:realRequire(n)};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
 await assert.rejects(context.module.exports.chat({model:'fixture'},'',[],{onUsage:u=>usage=u}),e=>e.jsonRepairable&&e.responseText===response);
 assert.equal(usage.inputTokens,10);assert.equal(usage.outputTokens,5);assert.equal(usage.cachedInputTokens,2);assert.ok(roots.every(root=>!fs.existsSync(root)));
 response='```json\n'+JSON.stringify(value)+'\n```';assert.deepEqual(await context.module.exports.chat({model:'fixture'},'',[]),value);assert.ok(roots.every(root=>!fs.existsSync(root)));
});

test('format repair is allowed with reserved unknown usage inside the original budget',async t=>{let calls=0;const {a,request}=await setup(t,async(p,k,m,o)=>{if(++calls===1)return json.parse('{');report(o);return value;});assert.deepEqual(await request(),value);assert.equal(calls,2);const s=spend.summaries(a).scopes[0];assert.ok(s.heldUSD>0);assert.equal(s.unsettledCalls,0);assert.equal(s.limitUSD,100);});
