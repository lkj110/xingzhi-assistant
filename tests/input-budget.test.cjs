'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const budget=require('../desktop/input-budget.cjs'),grounding=require('../desktop/grounding.cjs'),{Assistant}=require('../desktop/core.cjs');
const profile=window=>({contextWindow:window,maxOutputTokens:2048,source:'test-capability-fixture',checkedAt:'2026-10-22T00:00:00Z'});
const provider={type:'openai',id:'p',model:'fixture',maxOutputTokens:1024,contextCapability:profile(16000)};
const state={data:{settings:{evidenceGrounding:true}}};
const messages=value=>[{role:'system',content:'完整规则'},{role:'user',content:JSON.stringify(value)}];
const parsed=prepared=>JSON.parse(prepared.messages[1].content);
async function setup(t,chat){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-budget-'));t.after(()=>{assert.ok(dir.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{type:'openai',model:'mock',name:'budget fixture',baseUrl:'http://127.0.0.1:1/v1',inputPrice:0,outputPrice:0,key:'test-only'});a.data.settings.evidenceGrounding=true;return a;
}
test('known model budgets the complete escaped wire request and reserves output',()=>{
 const p=budget.prepare(state,provider,messages({requirements:'字\\"\n'.repeat(100)}));
 assert.equal(p.diagnostic.mode,'conservative-utf8-estimate');assert.ok(p.diagnostic.estimatedInputTokens>600);
 assert.equal(p.diagnostic.availableInputTokens,16000-1024-1024);assert.equal(p.diagnostic.profile.source,'test-capability-fixture');
 assert.throws(()=>budget.prepare(state,{...provider,maxOutputTokens:4096},messages({})),/输出上限/);
 assert.throws(()=>budget.prepare(state,{...provider,type:'anthropic',maxOutputTokens:null},messages({})),/输出上限/,'protocol defaults cannot exceed the known output limit');
 const anthropic=budget.prepare(state,{...provider,type:'anthropic',maxOutputTokens:null,contextCapability:{...profile(16000),maxOutputTokens:8192}},messages({}));assert.equal(anthropic.diagnostic.outputReserve,8192);
});
test('capabilities never infer windows from model names',()=>{
 assert.equal(budget.capability({type:'openai',model:'gpt-6.1-sol'}).contextWindow,null);
 assert.equal(budget.prepare(state,{type:'openai',model:'unknown'},messages({hello:'world'})).diagnostic.unknownCapability,true);
});
test('stable prefix excludes time and progress without changing bodies, sequence or references',()=>{
 const v={currentTime:'one',task:{id:'t',progress:1},sources:[{id:'b',content:'原文条件'},{id:'a',contentRef:{path:'sources[0].content',start:0,end:4}}],groundingChecklist:{requirements:['第二','第一']}};
 const a=budget.prepare(state,provider,messages(v)),b=budget.prepare(state,provider,messages({...v,currentTime:'two',task:{id:'t',progress:2}}));
 assert.equal(a.diagnostic.prefixKey,b.diagnostic.prefixKey);assert.deepEqual(parsed(a),v);
 assert.equal(JSON.stringify(parsed(a)).slice(0,21),JSON.stringify(parsed(b)).slice(0,21));
 assert.deepEqual(require('../desktop/model-input.cjs').materialize(parsed(a)),require('../desktop/model-input.cjs').materialize(v));
});
test('budget projection never silently removes irreducible requirements',()=>{
 assert.throws(()=>budget.prepare(state,{...provider,contextCapability:profile(8192)},messages({groundingChecklist:{requirements:['必须完整保留'.repeat(3000)]}})),/超过当前模型输入预算/);
});
test('small backup window removes recoverable evidence and removed text cannot count as seen',()=>{
 const content='限定条件'.repeat(7000),value={groundingChecklist:{requirements:[]},sourceCatalog:[{id:'s',version:'v',type:'source'}],generationEvidence:[{ok:true,sourceId:'s',version:'v',content,canonical:{origin:0},start:0,complete:true}],artifacts:[]};
 const p=budget.prepare(state,{...provider,contextCapability:profile(8192)},messages(value)),seen=new Set();budget.commit(seen,p);
 assert.ok(p.diagnostic.projectionLevel>0);assert.equal([...seen].some(s=>s.includes(content)),false);
 assert.ok(parsed(p).generationEvidence.length===0||parsed(p).generationEvidence.every(r=>!r.content||r.content.length<content.length));
});
test('switching models clears previously observed evidence',()=>{
 const payload={artifacts:[{id:'a',content:'原文甲'}]},seen=new Set();
 budget.commit(seen,budget.prepare(state,provider,messages(payload)));assert.equal(grounding.covered('原文甲',seen),true);
 budget.commit(seen,budget.prepare(state,{...provider,id:'backup'},messages({artifacts:[{id:'b',content:'原文乙'}]})));
 assert.equal(grounding.covered('原文甲',seen),false);assert.equal(grounding.covered('原文乙',seen),true);
});
test('strict off preserves original requests and diagnostics are not added',()=>{
 const m=messages({currentTime:'t',sources:[]});const p=budget.prepare({data:{settings:{}}},provider,m);assert.equal(p.messages,m);assert.equal(p.diagnostic,null);
});
test('A1 budgets independently of A2 layout and A2 cannot outlive its safety dependency',()=>{
 const value={currentTime:'now',task:{id:'t'},groundingChecklist:{requirements:['完整条件']},sources:[]},onlyBudget={...state,contextOptimizationOverrides:{A2:false}},off={...state,contextOptimizationOverrides:{A1:false,A2:true}};
 const p=budget.prepare(onlyBudget,provider,messages(value));assert.equal(p.diagnostic.layoutEnabled,false);assert.equal(p.diagnostic.prefixKey,null);assert.equal(p.messages[1].content,JSON.stringify(value));
 assert.throws(()=>budget.prepare(onlyBudget,{...provider,contextCapability:profile(8192)},messages({groundingChecklist:{requirements:['不能删'.repeat(5000)]}})),/输入预算/);
 assert.equal(require('../desktop/context-optimizations.cjs').enabled(off,'A2'),false);assert.equal(budget.prepare(off,provider,messages(value)).diagnostic,null);
});
test('projection preserves draft safety by withholding full-visibility proof when any section is missing',()=>{
 const body='摘要：预算100元。\n\n'+('中间正文。'.repeat(8000))+'\n\n例外：海外预算另计。',v={groundingChecklist:{requirements:['保留海外例外']},sourceCatalog:[],artifacts:[{id:'draft',title:'报告',content:body}]};
 let p;try{p=budget.prepare(state,{...provider,contextCapability:profile(8192)},messages(v));}catch(e){assert.equal(e.code,'MODEL_CONFIG');return;}
 const seen=new Set();budget.commit(seen,p);assert.equal(grounding.covered(body,seen),false);assert.ok(parsed(p).groundingChecklist.requirements.includes('保留海外例外'));
});
test('local budget rejection has no model attempt, charge or seen callback',async t=>{
 let calls=0,commits=0;const a=await setup(t,async()=>{calls++;return {};});const p=a.available('execute');p.contextCapability=profile(8192);p.maxOutputTokens=1024;
 await assert.rejects(a.call('execute','规则',{groundingChecklist:{requirements:['不可删'.repeat(20000)]}},{onSupplied:()=>commits++}),/输入预算/);
 assert.equal(calls,0);assert.equal(commits,0);assert.equal(a.data.modelCalls?.length||0,0);
});
test('failed attempt never commits evidence and successful attempt records actual final input',async t=>{
 let fail=true,commits=0;const a=await setup(t,async(_p,_k,m,o)=>{o.onUsage({inputTokens:20,outputTokens:2,cachedInputTokens:0});if(fail)throw require('../desktop/model-errors.cjs').transportError();return {ok:true};});
 await assert.rejects(a.call('execute','规则',{currentTime:'one',groundingChecklist:{requirements:[]}},{onSupplied:()=>commits++}));assert.equal(commits,0);
 fail=false;await a.call('execute','规则',{currentTime:'two',groundingChecklist:{requirements:[]}},{onSupplied:p=>{commits++;assert.ok(p.diagnostic.inputHash);}});assert.equal(commits,1);
 const row=a.data.modelCalls[0];assert.ok(row.inputAttribution.budget.inputHash);assert.equal(row.inputAttribution.observedUsage.totalTokens,22);
});
test('overflow retry respects user policy and reduces recoverable context',async t=>{
 let calls=0;const a=await setup(t,async()=>{if(++calls===1)throw require('../desktop/model-errors.cjs').httpError(400,'context_length_exceeded');return {ok:true};});
 await assert.rejects(a.call('execute','规则',{groundingChecklist:{requirements:[]}}));assert.equal(calls,1);
 calls=0;a.available('execute').requestPolicy.retries=1;assert.deepEqual(await a.call('execute','规则',recoveryPayload()),{ok:true});assert.equal(calls,2);
});
test('real CLI classification propagates only derived overflow into controlled recovery',async t=>{
 const cli=require('../desktop/subscription.cjs');assert.equal(cli.cliFailure({code:'MODEL_CONFIG',contextOverflow:true}).contextOverflow,undefined);
 let calls=0;const a=await setup(t,async()=>{if(++calls===1)throw cli.cliFailure({code:'context_length_exceeded',message:'maximum context length'});return {ok:true};});
 await assert.rejects(a.call('execute','规则',{groundingChecklist:{requirements:[]}}));assert.equal(calls,1);
 calls=0;a.available('execute').requestPolicy.retries=1;assert.equal((await a.call('execute','规则',recoveryPayload())).ok,true);assert.equal(calls,2);
});
function recoveryPayload(){return {groundingChecklist:{requirements:[]},sourceCatalog:[],generationEvidence:Array.from({length:3},(_,i)=>({sourceId:'s'+i,version:'v',content:'x'.repeat(6000),complete:true,start:0,canonical:{origin:0}}))};}
test('overflow recovery advances past the actual prior projection and must reduce wire bytes',()=>{const p={...provider,contextCapability:profile(16000)},first=budget.prepare(state,p,messages(recoveryPayload()));assert.ok(first.diagnostic.projectionLevel>0);const next=budget.prepare(state,p,messages(recoveryPayload()),{shrink:first.diagnostic});assert.ok(next.diagnostic.projectionLevel>first.diagnostic.projectionLevel);assert.ok(next.diagnostic.visibleRequestBytes<first.diagnostic.visibleRequestBytes);assert.notEqual(first.diagnostic.inputHash,next.diagnostic.inputHash);assert.throws(()=>budget.prepare(state,p,messages({groundingChecklist:{requirements:[]}}),{shrink:true}),/输入预算/);});
