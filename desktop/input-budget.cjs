'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {modelError}=require('./model-errors.cjs');
const VERSION='model-budget-v1';
const IMPLEMENTATION_HASH=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const positive=n=>Number.isSafeInteger(n)&&n>=1024&&n<=10000000;
function capability(provider){
 // Only an explicit, attributable profile or the exact installed CLI catalogue
 // can supply a window. A model-name substring is never a capability registry.
 const explicit=provider.contextCapability;
 if(explicit&&positive(explicit.contextWindow)&&typeof explicit.source==='string'&&explicit.source.trim()&&Number.isFinite(Date.parse(explicit.checkedAt))){
  return {contextWindow:explicit.contextWindow,maxOutputTokens:positive(explicit.maxOutputTokens)?explicit.maxOutputTokens:null,source:explicit.source,checkedAt:explicit.checkedAt};
 }
 if(provider.type==='codex')try{
  const file=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'models_cache.json'),stat=fs.statSync(file);
  if(Date.now()-stat.mtimeMs<=30*86400000){const row=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')).models?.find(m=>m.slug===provider.model);
   if(positive(row?.context_window))return {contextWindow:row.context_window,maxOutputTokens:positive(row.max_output_tokens)?row.max_output_tokens:null,source:'installed-codex-model-catalogue',checkedAt:stat.mtime.toISOString()};}
 }catch{}
 return {contextWindow:null,maxOutputTokens:null,source:'unknown',checkedAt:null};
}
// Stable top-level ordering only. Arrays, prose and reference paths stay intact.
const prefix=['project','workMemory','groundingChecklist','requirements','delegation','sourceCatalog','historyCatalog','catalogIndex','catalogNote','sources','requestedSections','generationEvidence','dependencies','artifactHistory','artifacts','workingDraft','revision','groundingReviewRequest'];
const suffix=['task','currentStep','steps','contextReads','retrievedEvidence','deliveryEvidence','recentActions','contextRecovery','currentTime','workEfficiency','checkFinalization'];
function layout(value){
 if(!value||Array.isArray(value)||typeof value!=='object')return value;
 const result={};for(const key of prefix)if(Object.hasOwn(value,key))result[key]=value[key];
 for(const key of Object.keys(value))if(!prefix.includes(key)&&!suffix.includes(key))result[key]=value[key];
 for(const key of suffix)if(Object.hasOwn(value,key))result[key]=value[key];return result;
}
function payloads(messages){return messages.flatMap((m,index)=>{if(m.role!=='user'||typeof m.content!=='string')return [];try{const value=JSON.parse(m.content);return value&&typeof value==='object'&&!Array.isArray(value)?[{index,value}]:[];}catch{return [];}});}
function serialize(provider,messages){
 if(provider.type==='codex')return require('./subscription.cjs').validateInput(messages);
 return JSON.stringify(require('./model-protocols.cjs').request(provider,messages,true));
}
function measure(provider,messages,profile){
 const serialized=serialize(provider,messages),bytes=Buffer.byteLength(serialized,'utf8');
 // This is deliberately a conservative byte estimate, NOT exact tokenizer use.
 // CLI wrappers and server-provided instructions are outside this observation.
 const output=require('./model-protocols.cjs').outputBudget(provider);
 if(profile.maxOutputTokens&&output.enforced&&output.outputTokens>profile.maxOutputTokens)throw modelError('MODEL_CONFIG','输出上限超过已确认的模型能力，请核对模型设置。',false);
 const reserve=output.enforced?output.outputTokens:provider.maxOutputTokens||profile.maxOutputTokens||Math.min(output.outputTokens,profile.contextWindow?Math.floor(profile.contextWindow/4):output.outputTokens);
 const margin=profile.contextWindow?Math.max(provider.type==='codex'?16384:1024,Math.ceil(profile.contextWindow*.05)):null;
 const available=profile.contextWindow===null?null:profile.contextWindow-reserve-margin;
 return {estimatedInputTokens:bytes,visibleRequestBytes:bytes,outputReserve:reserve,wrapperReserve:margin,availableInputTokens:available,mode:'conservative-utf8-estimate',opaqueWrapper:provider.type==='codex',fits:available===null?serialized.length<=require('./model-input.cjs').DEFAULT_MAX:available>0&&bytes<=available};
}
function projected(value,level,stage){
 if(!Array.isArray(value.sourceCatalog)&&!Array.isArray(value.readableCatalog)&&!value.groundingChecklist)return value;
 const input=require('./model-input.cjs'),view=require('./context-evidence.cjs');
 const result=require('./model-context.cjs').project(view.bounded(input.navigation(value,level),{maxChars:level>1?16000:48000}),{stage});
 return require('./receipt-input.cjs').project(result);
}
function prepare(a,provider,messages,{stage='task_work',shrink=false}={}){
 if(!require('./context-optimizations.cjs').enabled(a,'A')){if(require('./context-optimizations.cjs').enabled(a,'B')){messages=messages.map(m=>({...m}));for(const {index,value} of payloads(messages))messages[index].content=JSON.stringify(require('./evidence-search.cjs').suppliedGroups(value));}return {messages,diagnostic:null,payloads:payloads(messages),identity:digest([provider.id,provider.type,provider.model])};}
 const profile=capability(provider),original=payloads(messages);
 const previous=shrink===true?prepare(a,provider,messages,{stage}).diagnostic:shrink||null;
 let next=messages.map(m=>({...m})),metrics,level=previous?previous.projectionLevel+1:0;
 for(;level<=3;level++){
  next=messages.map(m=>({...m}));
  for(const {index,value} of original){let v=level?projected(value,level,stage):value;if(require('./context-optimizations.cjs').enabled(a,'B'))v=require('./evidence-search.cjs').suppliedGroups(v);next[index].content=JSON.stringify(layout(v));}
  try{metrics=measure(provider,next,profile);}catch(e){if(e.diagnostic?.kind==='input_too_large'&&level<3)continue;throw e;}
  if(metrics.fits&&(!previous||metrics.visibleRequestBytes<previous.visibleRequestBytes&&digest(next)!==previous.inputHash))break;
 }
 if(level>3||!metrics.fits)throw Object.assign(modelError('MODEL_CONFIG','完整要求或不可省略内容超过当前模型输入预算；已保留原稿，请拆分要求或选择更大窗口。',false),{diagnostic:{kind:'input_budget_exceeded',profile,estimatedInputTokens:metrics?.estimatedInputTokens}});
 const values=payloads(next),scope=values.map(({value:v})=>[v.contextRevision,v.inputBasis,v.task?.id,v.groundingChecklist?.requirements]);
 const {checkedAt,...capabilityBasis}=profile;
 const identity=digest([provider.id,provider.type,provider.baseUrl,provider.model,capabilityBasis,VERSION]);
 const stable=values.map(({value:v})=>Object.fromEntries(prefix.filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]])));
 const diagnostic={version:VERSION,profile,...metrics,projectionLevel:level,inputHash:digest(next),modelIdentity:identity,prefixKey:digest([identity,scope,stable]),stablePrefixBytes:Buffer.byteLength(JSON.stringify(stable),'utf8'),unknownCapability:profile.contextWindow===null};
 return {messages:next,payloads:values,identity,diagnostic};
}
function commit(seen,prepared){
 if(seen.modelIdentity&&seen.modelIdentity!==prepared.identity){seen.clear();delete seen.sources;delete seen.userInputs;delete seen.toolEvidence;delete seen.claimFields;}
 seen.modelIdentity=prepared.identity;
 for(const {value} of prepared.payloads)require('./grounding.cjs').observe(seen,value);
}
module.exports={VERSION,IMPLEMENTATION_HASH,capability,layout,prepare,commit,measure,payloads};
