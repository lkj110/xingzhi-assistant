const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant,modelChat}=require('../desktop/core.cjs');
const protocols=require('../desktop/model-protocols.cjs'),spend=require('../desktop/spend.cjs');
const messages=[{role:'user',content:'synthetic budget fixture'}];
async function setup(t,chat,config={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p1-budget-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat});
 await a.dispatch('saveProvider',{name:'Synthetic priced model',type:'openai',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:0,cachedInputPrice:0,outputPrice:300,maxOutputTokens:500000,...config});
 const task=a.createTask({title:'Budget boundary'});a.activeSpendTask=task;
 return {a,task,p:a.data.providers[0]};
}
const call=(a,p=a.data.providers[0])=>a.callModel(p,'',messages,{role:'execute',stage:'task_work'});
const scope=a=>spend.scope(a);
const reported=o=>o.onUsage({inputTokens:0,outputTokens:10,cachedInputTokens:0});

test('APP-002 original upper bound is rejected before dispatch; budget and call quota remain intact',async t=>{
 let sent=0;const {a}=await setup(t,async()=>{sent++;return {};});
 await assert.rejects(call(a),e=>e.spendLimit&&e.spendKind==='budget');
 assert.equal(sent,0);assert.equal(scope(a).spentUSD,0);assert.equal(scope(a).heldUSD,0);assert.equal(scope(a).limitUSD,100);
 assert.equal(a.publicState().stewardshipStatus.used,0);assert.deepEqual(scope(a).pending,{});
});

test('An explicitly smaller request is affordable and actual HTTP wire cap matches the reserved cap',async t=>{
 let wire,held;const old=global.fetch;t.after(()=>{global.fetch=old;});
 const {a,p}=await setup(t,modelChat,{maxOutputTokens:16000});
 global.fetch=async(_url,options)=>{
  wire=JSON.parse(options.body);held=scope(a).heldUSD;
  return new Response(JSON.stringify({usage:{prompt_tokens:0,completion_tokens:10},choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]}));
 };
 const value=await call(a,p);assert.equal(value.ok,true);assert.equal(wire.max_tokens,16000);assert.equal(held,4.8);
 assert.equal(scope(a).spentUSD,.003);assert.equal(scope(a).heldUSD,0);
});

for(const [type,field] of [['openai','max_tokens'],['azure','max_tokens'],['responses','max_output_tokens'],['anthropic','max_tokens'],['gemini','generationConfig'],['ollama','options']]){
 test(type+' actual protocol output ceiling and reservation share one validated value',async t=>{
  let seen;const {a,p}=await setup(t,async(p,k,m,o)=>{seen={body:protocols.request(p,m),ticket:o.spendTicket};reported(o);return {};},{type,maxOutputTokens:2048,...(type==='azure'?{baseUrl:'https://fixture.invalid/openai/v1'}:{})});
  await call(a,p);const actual=type==='gemini'?seen.body[field].maxOutputTokens:type==='ollama'?seen.body[field].num_predict:seen.body[field];
  assert.equal(actual,2048);assert.equal(seen.ticket.outputTokens,2048);assert.equal(seen.ticket.outputLimitMode,'explicit');assert.equal(seen.ticket.reservedUSD,.6144);
 });
}

test('Default, unknown and subscription caps keep their distinct guarantees',()=>{
 assert.deepEqual(protocols.outputBudget({type:'anthropic'}),{maxOutputTokens:8192,outputTokens:8192,mode:'protocol_default',enforced:true});
 assert.equal(protocols.request({type:'anthropic',model:'fixture'},messages).max_tokens,8192);
 for(const type of ['openai','azure','responses','gemini','ollama']){
  assert.deepEqual(protocols.outputBudget({type}),{maxOutputTokens:null,outputTokens:128000,mode:'estimate',enforced:false});
 }
 assert.equal(protocols.request({type:'openai',model:'fixture'},messages).max_tokens,undefined);
 assert.equal(protocols.request({type:'openai',model:'fixture',maxOutputTokens:2000,tokenParameter:'max_completion_tokens'},messages).max_completion_tokens,2000);
 for(const [configured,expected] of [[undefined,128000],[2048,128000],[500000,500000]])assert.deepEqual(protocols.outputBudget({type:'codex',maxOutputTokens:configured}),{maxOutputTokens:null,outputTokens:expected,mode:'estimate',enforced:false});
});

test('Known multi-candidate costs and malformed legacy caps are rejected without spending a call',async t=>{
 let sent=0;const {a,p}=await setup(t,async()=>{sent++;return {};},{maxOutputTokens:4096,outputPrice:20000});
 for(const key of ['n','best_of','candidateCount'])for(const value of [2,0,-1,1.5,'1',null,false]){
  p.extraBody={[key]:value};
  await assert.rejects(call(a,p),e=>e.code==='MODEL_CONFIG');
  assert.throws(()=>protocols.request(p,messages),e=>e.code==='MODEL_CONFIG');
 }
 p.extraBody={};
 for(const value of [0,15,1000001,1.5,NaN,Infinity,'invalid']){p.maxOutputTokens=value;await assert.rejects(call(a,p),e=>e.code==='MODEL_CONFIG');}
 assert.equal(sent,0);assert.equal(scope(a).spentUSD,0);assert.equal(scope(a).heldUSD,0);assert.equal(a.publicState().stewardshipStatus.used,0);
});

test('Single-candidate advanced parameters remain usable and preserved on the wire',async t=>{
 let seen;const {a,p}=await setup(t,async(p,k,m,o)=>{seen=protocols.request(p,m);reported(o);return {};},{maxOutputTokens:4096,outputPrice:20000,extraBody:{n:1,temperature:.2}});
 await call(a,p);assert.equal(seen.n,1);assert.equal(seen.temperature,.2);assert.equal(scope(a).spentUSD,.2);
 for(const key of ['best_of','candidateCount'])assert.equal(protocols.normalize({extraBody:{[key]:1}}).extraBody[key],1);
});

test('Concurrent requests share pending reservation before either request settles',async t=>{
 let sent=0,release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const {a,p}=await setup(t,async(p,k,m,o)=>{sent++;started();await gate;reported(o);return {};},{maxOutputTokens:200000});
 const first=call(a,p);await ready;assert.equal(scope(a).heldUSD,60);
 await assert.rejects(call(a,p),e=>e.spendKind==='budget');assert.equal(sent,1);assert.equal(scope(a).heldUSD,60);
 release();await first;assert.equal(scope(a).heldUSD,0);assert.equal(scope(a).spentUSD,.003);
});

test('Cold start preserves both legacy and new pending amounts, without repricing history',async t=>{
 const {a,p,task}=await setup(t,async()=>({}),{maxOutputTokens:2000});
 const ticket=spend.reserve(a,p,messages);assert.equal(ticket.reservedUSD,.6);
 const s=scope(a);s.pending['legacy-ticket']={reservedUSD:7,at:new Date().toISOString()};s.heldUSD+=7;spend.persist(a);a.save();
 const b=new Assistant({dir:a.dir,chat:async()=>({})});b.activeSpendTask=b.task(task.id);
 assert.equal(scope(b).heldUSD,7.6);assert.equal(scope(b).spentUSD,0);assert.equal(scope(b).limitUSD,100);assert.deepEqual(scope(b).pending,{});assert.equal(scope(b).usage.unknownCalls,2);
 await call(b);assert.equal(scope(b).heldUSD,8.2);assert.equal(scope(b).usage.unknownCalls,3);
});

test('Fallback uses its own cap and cannot borrow the small primary reservation',async t=>{
 const errors=require('../desktop/model-errors.cjs'),fallback=require('../desktop/model-fallback.cjs');let sent=0;
 const {a,p}=await setup(t,async(p,k,m,o)=>{sent++;reported(o);throw errors.transportError();},{maxOutputTokens:1000});
 await a.dispatch('saveProvider',{name:'Large fallback',type:'openai',model:'backup',baseUrl:'https://fixture.invalid/v1',inputPrice:0,cachedInputPrice:0,outputPrice:300,maxOutputTokens:500000});
 const backup=a.data.providers[1],f=fallback.snapshot(a);f.roles.execute={...f.roles.execute,enabled:true,providerId:backup.id};await a.dispatch('modelFallbackSave',{revision:f.revision,roles:f.roles});
 await assert.rejects(call(a,p),e=>e.spendKind==='budget');assert.equal(sent,1);assert.equal(scope(a).spentUSD,.003);assert.equal(scope(a).heldUSD,0);
 backup.extraBody={n:2};const f2=fallback.snapshot(a);f2.roles.execute={...f2.roles.execute,enabled:true,providerId:backup.id};await a.dispatch('modelFallbackSave',{revision:f2.revision,roles:f2.roles});await assert.rejects(call(a,p),e=>e.code==='MODEL_CONFIG');assert.equal(sent,2);assert.equal(scope(a).spentUSD,.006);assert.equal(scope(a).heldUSD,0);
});

test('Real Worker rejects unaffordable request, then persists an affordable call across restart',async t=>{
 const {EngineClient}=require('../desktop/engine-client.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p1-budget-worker-')),workspace=path.join(dir,'workspace'),fixture=path.join(dir,'fixture.cjs');
 fs.mkdirSync(workspace);
 fs.writeFileSync(fixture,`const path=require('node:path');const desktop=${JSON.stringify(path.resolve(__dirname,'../desktop'))};
 exports.create=({Assistant,options})=>{
  let sent=0,wire;
  class Fixture extends Assistant {
   tick(){}
   async dispatch(action,input={}){
    if(action==='budgetSetup'){await super.dispatch('saveProvider',{name:'Synthetic',type:'openai',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:0,cachedInputPrice:0,outputPrice:300,maxOutputTokens:500000});const task=this.createTask({title:'Worker budget'});this.save();return {taskId:task.id};}
    if(action==='budgetCall'){this.activeSpendTask=this.task(input.taskId);return this.callModel(this.data.providers[0],'',[{role:'user',content:'synthetic'}],{role:'execute',stage:'task_work'});}
    if(action==='budgetObserve'){this.activeSpendTask=this.task(input.taskId);return {sent,wire,scope:require(path.join(desktop,'spend.cjs')).scope(this)};}
    return super.dispatch(action,input);
   }
  }
  return new Fixture({...options,chat:async(p,k,m,o)=>{sent++;wire=require(path.join(desktop,'model-protocols.cjs')).request(p,m);o.onUsage({inputTokens:0,outputTokens:10,cachedInputTokens:0});return {ok:true};}});
 };`);
 let engine;const start=async()=>{engine=new EngineClient({dir:workspace,fixtureModule:fixture,safeStorage:{isEncryptionAvailable:()=>false},native:async()=>({supported:false})});await engine.ready;};
 t.after(async()=>{await engine?.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});
 await start();const ids=await engine.dispatch('budgetSetup');
 await assert.rejects(engine.dispatch('budgetCall',ids),/下一次请求预计预留/);
 let state=await engine.dispatch('budgetObserve',ids);assert.equal(state.sent,0);assert.equal(state.scope.spentUSD,0);assert.equal(state.scope.heldUSD,0);
 const provider=(await engine.dispatch('state')).providers[0];
 await engine.dispatch('uiCommand',{action:'saveProvider',input:{...provider,maxOutputTokens:16000}});
 assert.equal((await engine.dispatch('budgetCall',ids)).ok,true);
 state=await engine.dispatch('budgetObserve',ids);assert.equal(state.sent,1);assert.equal(state.wire.max_tokens,16000);assert.equal(state.scope.spentUSD,.003);
 await engine.close();await start();state=await engine.dispatch('budgetObserve',ids);assert.equal(state.scope.spentUSD,.003);assert.equal(state.scope.heldUSD,0);assert.equal(state.scope.limitUSD,100);
});
