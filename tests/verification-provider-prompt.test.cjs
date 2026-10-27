'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),contract=require('../desktop/verification-output.cjs');
async function fixture(t,types){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verification-routing-')),calls=[];
 const a=new Assistant({dir,chat:async(p,k,m,o)=>{calls.push({provider:p,messages:m,options:o});o.onUsage({inputTokens:1,outputTokens:1});return {ok:true};}});
 t.after(()=>{require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 for(const [i,type] of types.entries())await a.dispatch('saveProvider',{name:'offline'+i,type,model:'offline'+i,baseUrl:'https://fixture.invalid',key:type==='codex'?'':'offline',inputPrice:0,outputPrice:0});
 a.data.settings.roles.verify=a.data.providers[0].id;return {a,calls};
}
const call=a=>a.call('verify','legacy protocol',{task:{title:'简单核对'}},{responseContract:contract.FINAL_ID,structuredPrompt:'typed protocol'});
for(const types of [['openai','codex'],['codex','openai']])test('actual routed '+types.join(' to ')+' selects prompt before budgeting',async t=>{
 const {a,calls}=await fixture(t,types),routing=require('../desktop/model-routing.cjs');
 await a.dispatch('modelRoutingSave',{...routing.snapshot(a),enabled:true,economyId:a.data.providers[1].id,analysisId:a.data.providers[1].id});
 await call(a);assert.equal(calls.length,1);assert.equal(calls[0].provider.type,types[1]);
 assert.ok(calls[0].messages[0].content.includes(types[1]==='codex'?'typed protocol':'legacy protocol'));
 assert.equal(calls[0].options.transportSchema?.id,types[1]==='codex'?contract.FINAL_ID:undefined);assert.equal(calls[0].options.structuredMessages,undefined);
});
for(const types of [['openai','codex'],['codex','openai']])test('authorized fallback '+types.join(' to ')+' reselects protocol',async t=>{
 const {a,calls}=await fixture(t,types),fallback=require('../desktop/model-fallback.cjs'),settings=fallback.snapshot(a);settings.roles.verify={enabled:true,providerId:a.data.providers[1].id};await a.dispatch('modelFallbackSave',settings);
 const chat=a.chat;a.chat=async(...args)=>{const value=await chat(...args);if(calls.length===1)throw require('../desktop/model-errors.cjs').transportError();return value;};
 await call(a);assert.equal(calls.length,2);for(const c of calls)assert.ok(c.messages[0].content.includes(c.provider.type==='codex'?'typed protocol':'legacy protocol'));
});
test('JSON repair messages are never replaced with ordinary typed prompt',async t=>{
 const {a,calls}=await fixture(t,['openai']);const chat=a.chat;a.chat=async(...args)=>{const value=await chat(...args);if(calls.length===1)require('../desktop/model-json.cjs').parse('{"bad":');return value;};
 await call(a);assert.equal(calls.length,2);assert.equal(calls[1].options.stage,'json_repair');assert.ok(!calls[1].messages[0].content.includes('typed protocol'));assert.notDeepEqual(calls[1].messages,calls[0].messages);
});
