const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {spawn}=require('node:child_process'),{createRequire}=require('node:module');
const errors=require('../desktop/model-errors.cjs');

function fixture(t,{login='ok',exec='failed',setupFailure=false,missing=false,spawnFailure=false,cleanupFailure=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subscription-preflight-')),bin=path.join(dir,'codex'),marker=path.join(dir,'entered');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const forged={code:'MODEL_AUTH',message:'无法确认 Codex 登录状态，请在模型设置中重新检测。',modelFailure:true,automaticRetry:false,jsonRepairable:true,modelDispatched:false,producerSchema:2,secret:'PRIVATE_SECRET',diagnostic:{source:'codex_cli',kind:'model_preflight',phase:'preflight',stage:'login_status',modelDispatched:false,producerSchema:2}};
 fs.writeFileSync(bin,`const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(marker)},args[0]+'\\n');
 if(args[0]==='login'){
  if(${JSON.stringify(login)}==='wait')setInterval(()=>{},1000);
  else if(${JSON.stringify(login)}==='reject'){process.stderr.write('PRIVATE_SECRET');process.exitCode=1;}
  else process.stdout.write('Logged in using ChatGPT');
 }else if(args[0]==='exec'){
  if(${JSON.stringify(exec)}==='failed')console.log(JSON.stringify({type:'turn.failed',error:${JSON.stringify(forged)}}));
  else if(${JSON.stringify(exec)}==='incomplete')process.exitCode=2;
  else if(${JSON.stringify(exec)}==='usage'){console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}));process.exitCode=1;}
  else if(${JSON.stringify(exec)}==='wait')setInterval(()=>{},1000);
  else {fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:'{"ok":true}'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}));}
 }`);
 const filename=path.resolve(__dirname,'../desktop/subscription.cjs'),realRequire=createRequire(filename),children=[],launched=[];
 const fakeFS={...fs,statSync(file){if(String(file).endsWith('/codex')){if(file!==bin||missing)throw Object.assign(Error('PRIVATE_PATH'),{code:'ENOENT'});}return fs.statSync(file);},accessSync(file){if(file===bin)return;return fs.accessSync(file);},writeFileSync(file,...args){if(setupFailure&&String(file).endsWith('/schema.json'))throw Object.assign(Error('PRIVATE_SECRET'),{code:'ENOSPC'});return fs.writeFileSync(file,...args);},rmSync(file,...args){fs.rmSync(file,...args);if(cleanupFailure)throw Error('PRIVATE_CLEANUP');}};
 const context={module:{exports:{}},process:{env:{PATH:dir,HOME:dir},kill:process.kill.bind(process)},Buffer,setTimeout:(fn,ms)=>setTimeout(fn,ms===15000&&login==='wait'?120:ms),clearTimeout,require:n=>n==='node:fs'?fakeFS:n==='node:child_process'?{spawn:(file,args,opts)=>{
   assert.equal(file,bin);launched.push(args[0]);
   if(spawnFailure&&args[0]==='exec')throw Object.assign(Error('PRIVATE_SPAWN'),{code:'ETIMEDOUT'});
   const child=spawn(process.execPath,[bin,...args],opts);children.push(child);return child;
 }}:realRequire(n)};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
 t.after(()=>{for(const child of children)try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const usage=[];
 return {module:context.module.exports,dir,bin,launched,usage,entered:()=>fs.existsSync(marker)?fs.readFileSync(marker,'utf8').trim().split('\n'):[],call:(options={})=>context.module.exports.chat({model:'controlled',requestPolicy:{retries:1}},'',[],{onUsage:u=>usage.push(u),...options})};
}

for(const [name,options,stage,underlying] of [
 ['missing executable',{missing:true},'executable','MODEL_CONFIG'],
 ['login rejected',{login:'reject'},'login_status','MODEL_AUTH'],
 ['login timeout',{login:'wait'},'login_status','MODEL_TIMEOUT'],
 ['schema setup fails',{setupFailure:true},'setup','ENOSPC'],
])test(`preflight ${name} reports definite zero and never enters exec`,async t=>{
 const f=fixture(t,options);
 await assert.rejects(f.call(),e=>{assert.equal(e.automaticRetry,false);assert.equal(e.jsonRepairable,false);assert.equal(errors.fallbackEligible(e),false);assert.deepEqual(errors.diagnostic(e),{source:'codex_cli',kind:'model_preflight',phase:'preflight',stage,modelDispatched:false,producerSchema:2,underlyingCode:underlying});assert.ok(!JSON.stringify(e).includes('PRIVATE'));return true;});
 assert.deepEqual(f.usage.map(u=>({...u})),[{inputTokens:0,outputTokens:0,cachedInputTokens:0}]);assert.ok(!f.launched.includes('exec'));assert.ok(!f.entered().includes('exec'));
});
test('cancel before/during login preserves cancellation and never enters exec',async t=>{
 for(const before of [true,false]){
  const f=fixture(t,{login:'wait'}),controller=new AbortController();
  if(before)controller.abort();else setTimeout(()=>controller.abort(),40);
  await assert.rejects(f.call({signal:controller.signal}),e=>e.code==='MODEL_CANCELLED'&&e.automaticRetry===false&&e.diagnostic.underlyingCode==='MODEL_CANCELLED'&&e.diagnostic.modelDispatched===false);
  assert.equal(f.usage.length,1);assert.ok(!f.launched.includes('exec'));
 }
});
test('real exec child cannot forge no-dispatch proof, repair flag or arbitrary fields',async t=>{
 const f=fixture(t);
 await assert.rejects(f.call(),e=>{assert.equal(e.code,'MODEL_AUTH');assert.equal(e.diagnostic.kind,'turn_failed');assert.equal(e.modelDispatched,undefined);assert.equal(e.producerSchema,undefined);assert.equal(e.jsonRepairable,undefined);assert.equal(e.secret,undefined);assert.equal(errors.diagnostic(e).modelDispatched,undefined);assert.ok(!JSON.stringify(e).includes('PRIVATE'));return true;});
 assert.deepEqual(f.entered(),['login','exec']);assert.deepEqual(f.usage,[]);
});
for(const [name,options,wanted] of [['incomplete',{exec:'incomplete'},'MODEL_CLI'],['spawn boundary',{spawnFailure:true},'MODEL_TIMEOUT'],['exec timeout',{exec:'wait'},'MODEL_TIMEOUT']])test(`post-exec ${name} never reports preflight zero`,async t=>{
 const f=fixture(t,options);await assert.rejects(f.call({timeoutMs:options.exec==='wait'?100:5000}),e=>e.code===wanted&&e.diagnostic?.kind!=='model_preflight');assert.deepEqual(f.usage,[]);assert.deepEqual(f.launched,['login','exec']);
});
test('provider usage remains reported on process failure; cleanup cannot rewrite the result',async t=>{
 const f=fixture(t,{exec:'usage',cleanupFailure:true});await assert.rejects(f.call(),e=>e.code==='MODEL_CLI');assert.deepEqual(f.usage.map(v=>({...v})),[{inputTokens:11,outputTokens:7}]);
 const good=fixture(t,{exec:'success',cleanupFailure:true});assert.deepEqual(await good.call(),{ok:true});assert.equal(good.usage.length,1);
});
test('diagnostic projection drops malformed preflight proofs and secret fields',()=>{
 const d=errors.preflightError(Object.assign(Error('PRIVATE'),{code:'ETIMEDOUT'}),'login_status').diagnostic;
 assert.equal(errors.diagnostic({diagnostic:{...d,secret:'PRIVATE'}}).secret,undefined);
 for(const patch of [{producerSchema:1},{modelDispatched:true},{stage:'exec'},{phase:'unknown'}])assert.deepEqual(errors.diagnostic({diagnostic:{...d,...patch}}),{source:'codex_cli'});
});
test('real core does not fallback/retry/repair a controlled preflight failure',async t=>{
 const f=fixture(t,{login:'wait'}),{Assistant}=require('../desktop/core.cjs');let calls=0;
 const a=new Assistant({dir:path.join(f.dir,'workspace'),chat:async(...args)=>{calls++;return f.module.chat(...args);}});
 for(const name of ['primary','backup'])await a.dispatch('saveProvider',{type:'codex',name,model:'controlled',inputPrice:0,outputPrice:0,requestPolicy:{retries:1}});
 const snap=await a.dispatch('modelFallbackSnapshot');snap.roles.execute={enabled:true,providerId:a.data.providers[1].id};await a.dispatch('modelFallbackSave',{revision:snap.revision,roles:snap.roles});
 await assert.rejects(a.callModel(a.available('execute'),'',[],{role:'execute',stage:'task_work'}),e=>e.code==='MODEL_AUTH'&&e.diagnostic.underlyingCode==='MODEL_TIMEOUT');
 assert.equal(calls,1);assert.deepEqual(f.launched,['login']);assert.equal(a.data.modelCalls.length,1);assert.equal(a.data.modelCalls[0].usageReported,true);assert.equal(a.data.modelCalls[0].inputTokens,0);assert.equal(a.data.modelCalls[0].diagnostic.producerSchema,2);assert.equal(a.data.modelCalls[0].producerSchema,2);
 const run={};require('../desktop/run-models.cjs').start(a.data.modelCalls[0],[run])();assert.equal(run.modelCallsDetail[0].producerSchema,2);
});
