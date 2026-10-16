const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {Assistant,modelChat,endpoint} = require('../desktop/core.cjs');
const protocols = require('../desktop/model-protocols.cjs');
const transport = require('../desktop/model-http.cjs');
const catalog = require('../desktop/model-catalog.json');

async function service(t, respond) {
  const requests = [];
  const server = http.createServer(async(req,res) => {
    const chunks = []; for await(const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const request = {url:req.url,method:req.method,headers:req.headers,body:raw ? JSON.parse(raw) : undefined};
    requests.push(request); await respond(request,res);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return {base:`http://127.0.0.1:${server.address().port}`,requests};
}
const reply = (res,body,status=200) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const messages = [{role:'system',content:'Use supplied facts. Return JSON.'},{role:'user',content:'Question'},{role:'assistant',content:'Earlier answer'},{role:'user',content:'Continue'}];
const chatResult = {choices:[{finish_reason:'stop',message:{content:'{"ok":true}',reasoning_content:'PRIVATE_REASONING'}}],usage:{prompt_tokens:13,completion_tokens:7,prompt_cache_hit_tokens:5}};
const answers = {
  openai:chatResult, azure:chatResult,
  responses:{status:'completed',output:[{type:'reasoning',summary:[{text:'PRIVATE_REASONING'}]},{type:'message',content:[{type:'output_text',text:'{"ok":'},{type:'output_text',text:'true}'}]}],usage:{input_tokens:13,output_tokens:7,input_tokens_details:{cached_tokens:5}}},
  anthropic:{stop_reason:'end_turn',content:[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'text',text:'{"ok":true}'}],usage:{input_tokens:6,cache_read_input_tokens:5,cache_creation_input_tokens:2,output_tokens:7}},
  gemini:{candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'PRIVATE_REASONING'},{text:'{"ok":true}'}]}}],usageMetadata:{promptTokenCount:13,candidatesTokenCount:4,thoughtsTokenCount:3,cachedContentTokenCount:5}},
  ollama:{done:true,message:{content:'{"ok":true}',thinking:'PRIVATE_REASONING'},prompt_eval_count:13,eval_count:7}
};

for (const type of Object.keys(answers)) test(`${type}: real HTTP wire format, authentication, final text and usage`,async t => {
  const {base,requests} = await service(t,(_req,res) => reply(res,answers[type]));
  const config = {type,baseUrl:base + (type === 'azure' ? '/openai/v1' : type === 'ollama' ? '' : type === 'gemini' ? '/v1beta' : '/v1'),model:'fixture-model',maxOutputTokens:2048,extraBody:{temperature:0.4}};
  let usage;
  assert.deepEqual(await modelChat(config,'SYNTHETIC_TOKEN',messages,{onUsage:u => usage=u}),{ok:true});
  assert.equal(usage.inputTokens,13); assert.equal(usage.outputTokens,7);
  const r = requests[0]; assert.equal(r.method,'POST'); assert.equal(r.headers['content-type'],'application/json'); assert.ok(!r.url.includes('SYNTHETIC_TOKEN'));
  const auth = {anthropic:'x-api-key',gemini:'x-goog-api-key',azure:'api-key'}[type] || 'authorization';
  assert.equal(r.headers[auth],(auth === 'authorization' ? 'Bearer ' : '')+'SYNTHETIC_TOKEN');
  assert.ok(!JSON.stringify(r.body).includes('SYNTHETIC_TOKEN'));
  if (type === 'anthropic') {
    assert.equal(r.url,'/v1/messages'); assert.equal(r.headers['anthropic-version'],'2023-06-01'); assert.match(r.body.system,/Use supplied facts/);
    assert.deepEqual(r.body.messages,messages.slice(1)); assert.equal(r.body.max_tokens,2048); assert.equal(r.body.response_format,undefined); assert.equal(usage.cacheWriteTokens,2);
  } else if (type === 'gemini') {
    assert.equal(r.url,'/v1beta/models/fixture-model:generateContent'); assert.deepEqual(r.body.systemInstruction.parts,[{text:messages[0].content}]);
    assert.deepEqual(r.body.contents.map(m=>m.role),['user','model','user']); assert.equal(r.body.generationConfig.responseMimeType,'application/json');
    assert.equal(r.body.generationConfig.maxOutputTokens,2048); assert.equal(r.body.generationConfig.temperature,0.4); assert.equal(r.body.model,undefined);
  } else if (type === 'responses') {
    assert.equal(r.url,'/v1/responses'); assert.deepEqual(r.body.input,messages); assert.equal(r.body.store,false); assert.equal(r.body.max_output_tokens,2048);
    assert.deepEqual(r.body.text,{format:{type:'json_object'}}); assert.equal(r.body.messages,undefined);
  } else if (type === 'ollama') {
    assert.equal(r.url,'/api/chat'); assert.equal(r.body.format,'json'); assert.deepEqual(r.body.options,{temperature:0.4,num_predict:2048});
  } else {
    assert.equal(r.url,type === 'azure' ? '/openai/v1/chat/completions' : '/v1/chat/completions'); assert.deepEqual(r.body.messages,messages);
    assert.deepEqual(r.body.response_format,{type:'json_object'}); assert.equal(r.body.max_tokens,2048); assert.equal(r.body.temperature,0.4);
  }
  assert.equal(await modelChat({...config,jsonMode:false},'',messages,{json:false}),'{'+'"ok":true}');
});

test('DeepSeek, Kimi, Qwen, GLM and self-hosted presets preserve arbitrary model IDs and reasoning parameters',async t => {
  const {base,requests} = await service(t,(_req,res) => reply(res,chatResult));
  for (const id of ['deepseek','kimi','qwen','glm','doubao','siliconflow','openrouter','groq','together','vllm','lmstudio']) {
    const preset = catalog.presets.find(p => p.id === id); assert.ok(preset,id);
    const config = {...preset,baseUrl:base+'/tenant/v1',model:'organization/new-open-weight-model:custom',extraBody:{thinking:{type:'enabled'},enable_thinking:true}};
    assert.deepEqual(await modelChat(config,'SYNTHETIC',messages),{ok:true});
    const r = requests.at(-1); assert.equal(r.url,'/tenant/v1/chat/completions'); assert.equal(r.body.model,config.model);
    assert.deepEqual(r.body.thinking,{type:'enabled'}); assert.equal(r.body.enable_thinking,true);
    assert.equal(!!r.body.response_format,preset.jsonMode !== false);
  }
});

test('Root, versioned, proxy and full endpoints resolve without duplicated suffixes; Azure version stays separate',() => {
  for (const [config,expected] of [
    [{type:'openai',baseUrl:'https://api.example/v4/chat/completions/'},'https://api.example/v4/chat/completions'],
    [{type:'responses',baseUrl:'https://api.example'},'https://api.example/v1/responses'],
    [{type:'responses',baseUrl:'https://api.example/proxy/responses'},'https://api.example/proxy/responses'],
    [{type:'anthropic',baseUrl:'https://api.example'},'https://api.example/v1/messages'],
    [{type:'anthropic',baseUrl:'https://api.example/anthropic'},'https://api.example/anthropic/v1/messages'],
    [{type:'anthropic',baseUrl:'https://api.example/proxy/v1/messages'},'https://api.example/proxy/v1/messages'],
    [{type:'gemini',baseUrl:'https://api.example',model:'models/test'},'https://api.example/v1beta/models/test:generateContent'],
    [{type:'gemini',baseUrl:'https://api.example/v1beta/models/old:generateContent',model:'new'},'https://api.example/v1beta/models/new:generateContent'],
    [{type:'azure',baseUrl:'https://resource.example',model:'my deployment',apiVersion:'2024-10-21'},'https://resource.example/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21'],
    [{type:'azure',baseUrl:'https://resource.example/openai/deployments/fixture/chat/completions',model:'fixture',apiVersion:'2024-10-21'},'https://resource.example/openai/deployments/fixture/chat/completions?api-version=2024-10-21'],
    [{type:'ollama',baseUrl:'http://localhost:11434/api'},'http://localhost:11434/api/chat']
  ]) assert.equal(endpoint(config),expected);
  for(const baseUrl of ['file:///tmp/x','https://user:secret@example/v1','https://example/v1?key=SECRET','https://example/v1#secret']) assert.throws(()=>endpoint({baseUrl}),e=>e.code==='MODEL_CONFIG'&&!e.message.includes('SECRET'));
  assert.throws(()=>endpoint({type:'azure',baseUrl:'https://resource.example',model:'x'}),/API 版本/);
});

test('Advanced parameters cannot replace prompts, tool authorization, formats, limits, or carry secrets',() => {
  for(const extraBody of ['[]','invalid','{"__proto__":{"polluted":true}}','{"headers":{"Authorization":"SECRET"}}',...['tools','mcp_servers','messages','model','stream','input','generationConfig','responseMimeType','max_tokens','num_predict'].map(k=>JSON.stringify({[k]:'SECRET'}))]) {
    assert.throws(()=>protocols.normalize({extraBody}),e=>e.code==='MODEL_CONFIG'&&!e.message.includes('SECRET'));
  }
  for(const maxOutputTokens of [-1,0,1.5,1000001,'bad']) assert.throws(()=>protocols.normalize({maxOutputTokens}),/输出上限/);
  assert.throws(()=>protocols.normalize({type:'unsupported'}),/接口类型/);
  assert.deepEqual(protocols.normalize({extraBody:'{"reasoning_effort":"high"}'}).extraBody,{reasoning_effort:'high'});
  assert.equal(protocols.request({type:'openai',model:'reasoner',tokenParameter:'max_completion_tokens',maxOutputTokens:4096},messages).max_completion_tokens,4096);
  assert.equal(protocols.request({type:'anthropic',model:'fixture'},messages).max_tokens,8192);
});

test('Claude one-hour cache writes and Gemini reasoning tokens contribute to the cost ledger',() => {
  const spend=require('../desktop/spend.cjs');
  const usage=spend.usage(protocols.usage({type:'anthropic'},{usage:{input_tokens:100,output_tokens:10,cache_read_input_tokens:30,cache_creation_input_tokens:70,cache_creation:{ephemeral_5m_input_tokens:20,ephemeral_1h_input_tokens:50}}}));
  assert.equal(usage.inputTokens,200);assert.equal(usage.cacheWrite1hTokens,50);
  assert.equal(spend.cost(usage,{input:1,cached:0.1,output:2}),0.000248);
  assert.equal(spend.usage({...usage,cacheWrite1hTokens:71}),null);
  const gemini=spend.usage(protocols.usage({type:'gemini'},answers.gemini));
  assert.equal(gemini.outputTokens,7);assert.equal(spend.cost(gemini,{input:1,cached:0.1,output:2}),0.0000225);
});

test('Provider refusals and truncation never become successful text or repairable JSON',async t => {
  let answer; const {base} = await service(t,(_req,res) => reply(res,answer));
  const rows = [
    ['anthropic',{stop_reason:'refusal',content:[{type:'text',text:'PRIVATE_REFUSAL'}]},'MODEL_BLOCKED'],
    ['gemini',{promptFeedback:{blockReason:'SAFETY'}},'MODEL_BLOCKED'],
    ['gemini',{candidates:[{finishReason:'SAFETY'}]},'MODEL_BLOCKED'],
    ['responses',{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'PRIVATE_REFUSAL'}]}]},'MODEL_BLOCKED'],
    ['anthropic',{...answers.anthropic,stop_reason:'max_tokens'},'MODEL_INVALID_RESPONSE'],
    ['gemini',{...answers.gemini,candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"ok":true}'}]}}]},'MODEL_INVALID_RESPONSE'],
    ['responses',{...answers.responses,status:'incomplete'},'MODEL_INVALID_RESPONSE'],
    ['openai',{choices:[{finish_reason:'length',message:{content:'{"ok":true}'}}]},'MODEL_INVALID_RESPONSE'],
    ['ollama',{...answers.ollama,done:false},'MODEL_INVALID_RESPONSE'],
    ['anthropic',{stop_reason:'end_turn',content:[{type:'thinking',thinking:'PRIVATE_REASONING'}]},'MODEL_INVALID_RESPONSE'],
    ['gemini',{candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'PRIVATE_REASONING'}]}}]},'MODEL_INVALID_RESPONSE'],
    ['responses',{status:'queued'},'MODEL_INVALID_RESPONSE'],
    ['responses',{status:'completed',output:[null,{type:'message',content:[null]}]},'MODEL_INVALID_RESPONSE'],
    ['anthropic',{content:{some:'PRIVATE_BODY'}},'MODEL_INVALID_RESPONSE'],
    ['gemini',{candidates:[{content:{parts:[null]}}]},'MODEL_INVALID_RESPONSE'],
    ['openai',{choices:[{message:{content:[null]}}]},'MODEL_INVALID_RESPONSE']
  ];
  for(const [type,body,code] of rows) {
    answer=body;
    await assert.rejects(modelChat({type,baseUrl:base,model:'fixture'},'',messages,{json:false}),e=>e.code===code&&e.automaticRetry===false&&!e.jsonRepairable&&!/PRIVATE/.test(e.message));
  }
});

test('HTTP failures stay redacted and redirects do not forward credentials or prompts',async t => {
  const destination = await service(t,(_req,res)=>reply(res,chatResult));
  let status = 302;
  const source = await service(t,(_req,res) => {res.writeHead(status,{Location:destination.base+'/v1/chat/completions'});res.end(JSON.stringify({error:{message:'SECRET_PROVIDER_BODY'}}));});
  await assert.rejects(modelChat({type:'openai',baseUrl:source.base,model:'fixture'},'SYNTHETIC',messages),e=>e.code==='MODEL_NETWORK');
  assert.equal(destination.requests.length,0);
  for(status of [400,401,403,404,429,503]) await assert.rejects(modelChat({type:'anthropic',baseUrl:source.base,model:'fixture'},'',messages),e=>e.httpStatus===status&&!e.message.includes('SECRET_PROVIDER_BODY')&&e.automaticRetry===(status>=500||status===429));
});

test('Cancellation interrupts native generation and model discovery',async t => {
  let started; const {base} = await service(t,()=>started?.());
  for(const operation of [signal=>modelChat({type:'gemini',baseUrl:base,model:'fixture'},'',messages,{signal}),signal=>transport.listModels({type:'anthropic',baseUrl:base},'',{signal})]) {
    const controller=new AbortController(); const ready=new Promise(resolve=>started=resolve);
    const pending=operation(controller.signal); await ready; controller.abort();
    await assert.rejects(pending,e=>e.code==='MODEL_CANCELLED');
  }
});

test('Model discovery handles pagination, native formats, manual IDs and does not follow remote page URLs',async t => {
  const {base,requests} = await service(t,(req,res) => {
    if(req.url.startsWith('/gemini/models')) return reply(res,req.url.includes('pageToken=') ? {models:[{name:'models/model-b',supportedGenerationMethods:['generateContent']}]} : {models:[{name:'models/model-a',displayName:'Model A',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'next page'});
    if(req.url.startsWith('/anthropic/v1/models')) return reply(res,req.url.includes('after_id=') ? {data:[{id:'claude-new'}]} : {data:[{id:'claude-a',display_name:'Claude A'}],has_more:true,last_id:'https://evil.invalid/steal'});
    if(req.url==='/ollama/api/tags') return reply(res,{models:[{name:'qwen-custom:latest'}]});
    if(req.url==='/bad/models') return reply(res,{});
    return reply(res,{data:[{id:'any/new-model'},{id:'any/new-model'}]});
  });
  assert.deepEqual((await transport.listModels({type:'gemini',baseUrl:base+'/gemini'},'SYNTHETIC')).models.map(m=>m.id),['model-a','model-b']);
  assert.deepEqual((await transport.listModels({type:'anthropic',baseUrl:base+'/anthropic'},'SYNTHETIC')).models.map(m=>m.id),['claude-a','claude-new']);
  assert.ok(requests.at(-1).url.startsWith('/anthropic/v1/models?after_id=https%3A'));
  assert.equal((await transport.listModels({type:'ollama',baseUrl:base+'/ollama'},'')).models[0].id,'qwen-custom:latest');
  assert.equal((await transport.listModels({type:'openai',baseUrl:base+'/v1/chat/completions'},'')).models.length,1);
  await assert.rejects(transport.listModels({type:'openai',baseUrl:base+'/bad'},''),/手动填写/);
});

test('Saved native providers survive restart, hide credentials and complete connection tests with recorded usage',async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-provider-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {base} = await service(t,(req,res) => reply(res,req.method === 'GET' ? {data:[{id:'claude-fixture'}]} : answers.anthropic));
  const a=new Assistant({dir});
  await a.dispatch('saveProvider',{name:'Claude fixture',type:'anthropic',baseUrl:base+'/v1',model:'future-model',key:'SYNTHETIC_SECRET',authMode:'bearer',maxOutputTokens:4096,workspaceId:'wrkspc_test',extraBody:'{"thinking":{"type":"adaptive"}}',inputPrice:1,outputPrice:2});
  const p=a.data.providers[0];assert.equal(p.type,'anthropic');assert.ok(p.sealedKey);assert.equal(p.authMode,'bearer');
  assert.ok(!fs.readFileSync(a.file,'utf8').includes('SYNTHETIC_SECRET'));
  assert.ok(!JSON.stringify(a.publicState()).includes(p.sealedKey));assert.ok(!JSON.stringify(a.publicState()).includes('SYNTHETIC_SECRET'));
  const b=new Assistant({dir});assert.equal(b.data.providers[0].maxOutputTokens,4096);
  assert.deepEqual(b.data.providers[0].extraBody,{thinking:{type:'adaptive'}});
  assert.equal((await b.dispatch('testProvider',{id:p.id})).ok,true);assert.equal(b.data.modelCalls[0].inputTokens,13);assert.equal(b.data.modelCalls[0].status,'done');
  const beforeCalls=b.data.modelCalls.length;
  assert.equal((await b.dispatch('listProviderModels',{...p,key:''})).models[0].id,'claude-fixture');
  assert.equal(b.data.modelCalls.length,beforeCalls);assert.equal(b.operation,null);
  await assert.rejects(b.dispatch('saveProvider',{...p,baseUrl:'https://different.invalid/v1'}),/重新填写/);
  await assert.rejects(b.dispatch('listProviderModels',{...p,baseUrl:'https://different.invalid/v1'}),/重新填写/);assert.equal(b.operation,null);
  await b.dispatch('saveProvider',{...p,baseUrl:'https://different.invalid/v1',clearKey:true});assert.equal(b.data.providers[0].sealedKey,'');
});

test('Changing native auth, generation options or API version invalidates saved routing consent',async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-provider-consent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir});
  for(const name of ['primary','backup'])await a.dispatch('saveProvider',{name,type:'anthropic',baseUrl:'https://example.invalid/v1',model:name,inputPrice:0,outputPrice:0});
  const [primary,backup]=a.data.providers;
  for(const change of [{authMode:'bearer'},{maxOutputTokens:16384},{apiVersion:'2023-06-01'},{extraBody:{thinking:{type:'adaptive'}}}]) {
    const snapshot=await a.dispatch('modelFallbackSnapshot');snapshot.roles.execute={enabled:true,providerId:backup.id};await a.dispatch('modelFallbackSave',{revision:snapshot.revision,roles:snapshot.roles});
    await a.dispatch('saveProvider',{...primary,...change});assert.equal((await a.dispatch('modelFallbackSnapshot')).roles.execute.enabled,false);
  }
});
