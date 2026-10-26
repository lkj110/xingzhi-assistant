'use strict';
// Bounded transport metadata only: no prompts, response bodies, headers or
// credential-bearing error messages. A receipt never substitutes for usage.
const crypto=require('node:crypto');
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const types=new Set(['thread.started','turn.started','turn.completed','turn.failed','error','process_exit','http_response']);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function usage(value){
 if(!integer(value?.inputTokens)||!integer(value?.outputTokens)||!integer(value.inputTokens+value.outputTokens))return null;
 const result={inputTokens:value.inputTokens,outputTokens:value.outputTokens};
 for(const key of ['cachedInputTokens','cacheWriteTokens','cacheWrite1hTokens'])if(Object.hasOwn(value,key)){if(!integer(value[key]))return null;result[key]=value[key];}
 if((result.cacheWrite1hTokens??0)>(result.cacheWriteTokens??0)||(result.cachedInputTokens??0)+(result.cacheWriteTokens??0)>result.inputTokens)return null;
 return result;
}
function reference(kind,value){
 if(typeof value!=='string'||!value||value.length>512)return null;
 // Keep only known opaque UUID / request-id forms reversible for support.
 const plain=/^(?:req_)?[a-f0-9]{32}$/i.test(value)||/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
 return {kind,hash:hash(value),...(plain?{id:value}:{})};
}
function create(source,input){
 const started=require('node:perf_hooks').performance.now();
 const state={version:1,source,attemptId:crypto.randomUUID(),inputHash:hash(input),eventCount:0,events:[],references:[],usageStatus:'unknown',usage:null};
 return {
  event(type,{requestId,threadId,exitCode,httpStatus,errorCode,usage:reported}={}){
   if(!types.has(type))return;
   const event={sequence:++state.eventCount,type,elapsedMs:Math.max(0,Math.round(require('node:perf_hooks').performance.now()-started))};
   if(['thread.started','turn.started','turn.completed','turn.failed'].includes(type))state.lastProtocolEvent=type;
   if(Number.isInteger(exitCode))event.exitCode=exitCode;
   if(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599)event.httpStatus=httpStatus;
   if(require('./model-errors.cjs').safeErrorCode({code:errorCode})===errorCode)event.errorCode=errorCode;
   for(const [kind,value] of [['request',requestId],['thread',threadId]]){const ref=reference(kind,value);if(ref&&!state.references.some(r=>r.kind===ref.kind&&r.hash===ref.hash)&&state.references.length<8)state.references.push(ref);}
   // Missing usage is not a zero or malformed report. Once actual reports
   // disagree or are invalid, later events cannot silently restore certainty.
   if(reported!=null){
    const measured=usage(reported);
    if(!measured){state.usage=null;state.usageStatus='invalid';}
    else if(state.usageStatus==='unknown'){state.usage=measured;state.usageStatus='reported';}
    else if(state.usageStatus==='reported'&&JSON.stringify(state.usage)!==JSON.stringify(measured)){state.usage=null;state.usageStatus='conflicting';}
   }
   if(state.events.length<64)state.events.push(event);else state.events[63]=event;
  },
  snapshot(){return structuredClone(state);},
  // Local process facts, never fields supplied by CLI event JSON. No output text.
  process(value){
   const result={};
   for(const key of ['durationMs','idleMs','stdoutBytes','stderrBytes'])if(integer(value?.[key]))result[key]=value[key];
   if(['closed','spawn_failed','not_started'].includes(value?.state))result.state=value.state;
   if(['idle','total'].includes(value?.timeoutKind))result.timeoutKind=value.timeoutKind;
   if(['SIGTERM','SIGKILL','SIGINT'].includes(value?.signal))result.signal=value.signal;
   if(typeof value?.terminationRequested==='boolean')result.terminationRequested=value.terminationRequested;
   state.process=result;
   this.event('process_exit',{exitCode:value?.exitCode,errorCode:value?.errorCode});
  },
 };
}
module.exports={create,usage};
