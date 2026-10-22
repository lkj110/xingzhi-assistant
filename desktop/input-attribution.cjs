'use strict';
// Diagnostics only: never fed back into prompts or used for admission/acceptance.
// Provider usage is measured. Category tokens are a byte-weighted allocation,
// not tokenizer counts; opaque provider framing cannot be attributed separately.
const VERSION='input-attribution-v1';
const IMPLEMENTATION_HASH=require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex');
const categories=['systemInstructions','requirements','draft','evidenceBodies','evidenceMetadata','toolReceipts','navigation','other'];
const bodies=new Set(['content','text','originalContent']);
function category(path){
 const top=path[0],key=path.at(-1);
 if(['task','groundingChecklist','requirements','businessObligations'].includes(top)||top==='groundingReviewRequest'&&path[1]==='userInputs')return 'requirements';
 if(['artifacts','workingDraft','revision','changedChunks','unchangedChunks'].includes(top))return 'draft';
 if(['contextReads','generationEvidence','requestedSections','retrievedEvidence','sources','deliveryEvidence'].includes(top)){
  if(bodies.has(key))return 'evidenceBodies';
  return ['contextReads','deliveryEvidence'].includes(top)?'toolReceipts':'evidenceMetadata';
 }
 if(['recentActions','completedWrites','toolResults'].includes(top))return 'toolReceipts';
 if(['readableCatalog','sourceCatalog','historyCatalog','currentArtifact','catalogIndex','catalogNote','inputBudget','bodyReferenceNote','receiptReferenceNote'].includes(top))return 'navigation';
 return 'other';
}
function measure(messages){
 const totals=Object.fromEntries(categories.map(key=>[key,{serializedChars:0,utf8Bytes:0}]));
 const add=(key,text)=>{totals[key].serializedChars+=text.length;totals[key].utf8Bytes+=Buffer.byteLength(text,'utf8');};
 const visit=(value,path=[])=>{
  const key=category(path);
  if(value===null||typeof value!=='object'){add(key,JSON.stringify(value));return;}
  const entries=Array.isArray(value)?value.map((v,i)=>[i,v]):Object.entries(value);
  add(key,Array.isArray(value)?'[]':'{}');
  entries.forEach(([k,v],i)=>{const next=[...path,k];if(i)add(key,',');if(!Array.isArray(value))add(category(next),JSON.stringify(k)+':');visit(v,next);});
 };
 for(const message of messages){
  const content=typeof message.content==='string'?message.content:JSON.stringify(message.content??'');
  if(message.role==='system'||message.role==='developer')add('systemInstructions',content);
  else if(message.role==='user'){
   let value;try{value=JSON.parse(content);}catch{}
   // Whitespace/noncanonical JSON is preserved and reported as unclassified.
   if(value&&typeof value==='object'&&JSON.stringify(value)===content)visit(value);else add('other',content);
  }else add(message.role==='tool'?'toolReceipts':'other',content);
 }
 const visibleChars=Object.values(totals).reduce((n,r)=>n+r.serializedChars,0),visibleUtf8Bytes=Object.values(totals).reduce((n,r)=>n+r.utf8Bytes,0);
 return {version:VERSION,visibleChars,visibleUtf8Bytes,categories:totals,usageReported:false,observedUsage:null,allocationMethod:'reported-input-proportional-to-visible-utf8-bytes',limitation:'Category tokens are estimates; tokenizer, provider framing and cached-token placement are not observable. Actual totals are in observedUsage.'};
}
function settle(measured,usage){
 const valid=usage&&['inputTokens','outputTokens','cachedInputTokens'].every(k=>Number.isFinite(usage[k])&&usage[k]>=0)&&usage.cachedInputTokens<=usage.inputTokens;
 const result=structuredClone(measured);result.usageReported=!!valid;
 if(valid)result.observedUsage={inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cachedInputTokens:usage.cachedInputTokens,totalTokens:usage.inputTokens+usage.outputTokens};
 let allocated=0;
 const active=categories.filter(k=>result.categories[k].utf8Bytes>0);
 for(const [i,key] of active.entries()){
  const row=result.categories[key];row.visibleByteShare=row.utf8Bytes/result.visibleUtf8Bytes;
  if(valid){row.estimatedInputTokens=i===active.length-1?usage.inputTokens-allocated:Math.floor(usage.inputTokens*row.visibleByteShare);allocated+=row.estimatedInputTokens;}
 }
 return result;
}
module.exports={VERSION,IMPLEMENTATION_HASH,measure,settle};
