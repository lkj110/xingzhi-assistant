'use strict';
// Bounded private diagnostics. Never a model input or a substitute usage receipt.
const crypto=require('node:crypto');
const limits=Object.freeze({lineBytes:32768,stderrBytes:8192,messageChars:2048,events:4,diagnosticBytes:24576});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function redact(value){
 value=String(value);
 const escaped=value.replace(/\\+["']/g,'"');
 if(escaped!==value&&/["']?(?:authorization|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|password|secret|cookie|request[ _-]?body|prompt|messages|headers|body|input)["']?\s*[:=]/i.test(escaped))return '[OMITTED_ESCAPED_SENSITIVE_DATA]';
 // Free-form credential/request blocks are not safely parseable. Retain only
 // the preceding diagnostic text, never a partially redacted value or body.
 const sensitive=/(?:^|[\s{,;])["']?(?:authorization|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|password|secret|cookie|request[ _-]?body|prompt|messages|headers|body|input)["']?\s*[:=]/i.exec(value);
 if(sensitive)value=value.slice(0,sensitive.index)+' [REDACTED_SENSITIVE_SUFFIX]';
 return value
  .replace(/\bsk-[A-Za-z0-9_-]{6,}/g,'[REDACTED_KEY]')
  .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi,'[REDACTED_AUTH]')
  .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi,url=>{try{const u=new URL(url);if(u.username||u.password){u.username='REDACTED';u.password='';}if(u.search)u.search='REDACTED_QUERY';if(u.hash)u.hash='REDACTED_FRAGMENT';return u.href;}catch{return '[REDACTED_URL]';}})
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
}
function text(value,max=limits.messageChars,redactions=[]){if(typeof value!=='string')return undefined;
 if(/\b(?:prompt|messages|request_body|headers|body|input)["']?\s*[:=]\s*[\[{]/i.test(value))return '[OMITTED_EMBEDDED_REQUEST_DATA]';
 for(const item of redactions)value=value.split(item).join('[REDACTED_REQUEST_TEXT]');
 const safe=redact(value);return safe.length>max?safe.slice(0,max)+' [TRUNCATED]':safe;}
function fields(value,depth=0,redactions=[]){
 if(typeof value==='string')return {message:text(value,limits.messageChars,redactions)};
 if(!value||typeof value!=='object'||Array.isArray(value)||depth>2)return undefined;
 const result={};
 for(const key of ['message','code','type','status','status_code','http_status','request_id','retryable','retry_after','reason']){
  const v=value[key];if(typeof v==='string')result[key]=text(v,key==='message'||key==='reason'?limits.messageChars:160,redactions);else if(typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))result[key]=v;
 }
 for(const key of ['error','cause'])if(value[key]!==undefined){const child=fields(value[key],depth+1,redactions);if(child)result[key]=child;}
 return result;
}
function requestTexts(input){const result=[];if(typeof input!=='string')return result;
 if(input.length>=12)result.push(input);
 const at=input.indexOf('APPLICATION MESSAGES:\n');let visited=0;
 function walk(value){if(++visited>5000||result.length>=256)return;if(typeof value==='string'&&value.length>=12){result.push(value);try{walk(JSON.parse(value));}catch{}}else if(value&&typeof value==='object')for(const v of Object.values(value))walk(v);}
 try{walk(JSON.parse(at<0?input:input.slice(at+'APPLICATION MESSAGES:\n'.length)));}catch{}
 return [...new Set(result)].sort((a,b)=>b.length-a.length);
}
function collector({now=()=>new Date().toISOString(),requestInput}={}){
 const redactions=requestTexts(requestInput);
 const startedAt=now(),events=[];let partial='',lineBytes=0,lineHash=crypto.createHash('sha256'),lineOverflow=false,stderr='',stderrBytes=0,stderrOverflow=false,stderrHash=crypto.createHash('sha256'),droppedEvents=0,discardedLines=0,malformedLines=0,finished=false;
 function endLine(){
  const incremental=lineHash.digest('hex'),fingerprint=lineOverflow?incremental:sha(partial);
  if(lineOverflow)discardedLines++;
  else if(partial.trim()){
   let event;try{event=JSON.parse(partial);}catch{malformedLines++;}
   if(event&&['error','turn.failed'].includes(event.type)){
    if(events.length>=limits.events)droppedEvents++;
    else events.push({at:now(),eventType:event.type,rawEventSha256:fingerprint,rawEventBytes:lineBytes,details:fields(event,0,redactions)});
   }
  }
  partial='';lineBytes=0;lineHash=crypto.createHash('sha256');lineOverflow=false;
 }
 function feed({channel,data}){
  if(finished||typeof data!=='string')return;
  if(channel==='stderr'){
   const bytes=Buffer.byteLength(data);stderrBytes+=bytes;stderrHash.update(data);
   if(stderrBytes>limits.stderrBytes){stderrOverflow=true;stderr='';}else if(!stderrOverflow)stderr+=data;return;
  }
  if(channel!=='stdout')return;
  const parts=data.split('\n');for(let i=0;i<parts.length;i++){
   const part=parts[i];lineHash.update(part);lineBytes+=Buffer.byteLength(part);
   if(lineBytes>limits.lineBytes){lineOverflow=true;partial='';}else if(!lineOverflow)partial+=part;
   if(i<parts.length-1)endLine();
  }
 }
 function finish(result,error){
  if(finished)throw Error('Diagnostic collector already finalized');finished=true;if(lineBytes)endLine();
  const terminal={finishedAt:now(),outcome:error?'failed':'completed',failureCode:error?.code||null,started:result?.started??true,exitCode:result?.exitCode??result?.code??null,exitSignal:result?.exitSignal??null,processTreeConfirmed:result?.processTreeConfirmed??false,authoritativeUsagePresent:!!result?.usage&&!result?.usageUnknown,usageUnknown:result?.usageUnknown??!result?.usage,usageEvents:result?.usageEvents??0};
  // Error.code is a symbolic category; only numeric process codes are exit codes.
  if(typeof terminal.exitCode!=='number')terminal.exitCode=null;
  const diagnostic={schema:1,startedAt,events,droppedEvents,discardedLines,malformedLines,stderr:{bytes:stderrBytes,sha256:stderrHash.digest('hex'),omittedForSize:stderrOverflow,text:stderrOverflow?null:text(stderr,4096,redactions)},terminal,limits};
  if(Buffer.byteLength(JSON.stringify(diagnostic))>limits.diagnosticBytes){diagnostic.events=events.map(e=>({...e,details:{message:'[OMITTED_DIAGNOSTIC_SIZE_LIMIT]'}}));diagnostic.stderr.text=null;diagnostic.contentOmittedForTotalSize=true;}
  return diagnostic;
 }
 return {feed,finish};
}
module.exports={collector,redact,limits};
