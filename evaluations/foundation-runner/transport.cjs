'use strict';
// The evaluator forwards only the frozen subscription CLI environment. No login,
// discovery, networking or model call happens merely by importing this module.
const cp=require('node:child_process'),path=require('node:path');
const {normalizeUsage}=require('./ledger.cjs');
const {classifyFailureEvent}=require('./failure-cause.cjs');
const root=path.resolve(__dirname,'../..'),protocol=require(path.join(root,'desktop/subscription-protocol.cjs')),host=require(path.join(root,'desktop/host-process.cjs'));
const windows=process.platform==='win32'?require(path.join(root,'desktop/windows-process.cjs')):null;
const ENVIRONMENT_KEYS=Object.freeze(['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','PATHEXT','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','CODEX_HOME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY']);
const MAX_OUTPUT_BYTES=4000000;
function environment(source=process.env){const result={};for(const key of ENVIRONMENT_KEYS)if(typeof source[key]==='string'&&source[key])result[key]=source[key];return result;}
function error(code,message){return Object.assign(Error(message),{code});}
function runTransport({bin,args,input,cwd,env=environment(),timeoutMs,idleTimeoutMs,signal,onFrame=()=>{}}){
 return new Promise((resolve,reject)=>{
  const early=(code,message)=>reject(Object.assign(error(code,message),{started:false,usageUnknown:true,usageEvents:0,rawUsageEvents:[],processTreeConfirmed:true}));
  if(!path.isAbsolute(bin||'')||!path.isAbsolute(cwd||'')||!Array.isArray(args)||args.some(a=>typeof a!=='string')||typeof input!=='string'||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<=0||typeof onFrame!=='function')return early('CLI_INPUT_REJECTED','Invalid transport configuration');
  if(signal?.aborted)return early('CLI_CANCELLED','Transport was cancelled before launch');
  let child;try{child=(windows?.spawn||cp.spawn)(bin,args,{cwd,env:environment(env),windowsHide:true,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});}catch{return early('CLI_SPAWN_FAILED','Could not launch the CLI process');}
  const stdoutDecoder=new TextDecoder('utf-8',{fatal:true}),stderrDecoder=new TextDecoder('utf-8',{fatal:true});
  const rawUsageEvents=[];let usage,disputedUsage=false,failure,partial='',bytes=0,ended=false,stopping=false,totalTimer,idleTimer,hardKill;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const stop=problem=>{
   failure ||=problem;if(ended||stopping)return;stopping=true;clearTimeout(idleTimer);clearTimeout(totalTimer);
   try{host.terminate(child,'SIGTERM');}catch{failure ||=error('CLI_TERMINATION_FAILED','Could not stop CLI process tree');}
   hardKill=setTimeout(()=>{try{host.terminate(child,'SIGKILL');}catch{}},1500);
  };
  const abort=()=>stop(error('CLI_CANCELLED','Transport was cancelled'));
  const armIdle=()=>{if(stopping||ended)return;clearTimeout(idleTimer);idleTimer=setTimeout(()=>stop(error('CLI_IDLE_TIMEOUT','CLI idle deadline reached')),idleTimeoutMs);};
  const frame=(channel,data)=>{if(!data)return;try{onFrame({channel,data});}catch{stop(error('CLI_FRAME_FAILED','Could not deliver CLI output'));}};
  const line=text=>{
   if(!text.trim())return;
   let event;try{event=JSON.parse(text);}catch{stop(error('CLI_PROTOCOL_JSON','CLI stdout contained an invalid JSON event'));return;}
   if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'){stop(error('CLI_PROTOCOL_EVENT','CLI stdout event has no type'));return;}
   if(event.type==='turn.completed'){
    rawUsageEvents.push(clone(event));
    let next;try{next=normalizeUsage(event.usage);}catch{disputedUsage=true;stop(error('CLI_INVALID_USAGE','CLI completion contains missing or invalid usage'));return;}
    if(usage&&JSON.stringify(usage)!==JSON.stringify(next)){disputedUsage=true;stop(error('CLI_CONFLICTING_USAGE','CLI completion usage conflicts with an earlier event'));return;}
    usage=next;
   }
   const reported=classifyFailureEvent(event);if(reported)stop(error(reported.code,reported.message));
   if(protocol.hostToolError(event.item))stop(error('HOST_TOOL_ATTEMPT','CLI attempted a host tool'));
  };
  const consume=(channel,chunk)=>{
   armIdle();bytes+=chunk.length;
   if(bytes>MAX_OUTPUT_BYTES){stop(error('CLI_OUTPUT_LIMIT','CLI output exceeded the evaluation limit'));return;}
   let text;try{text=(channel==='stdout'?stdoutDecoder:stderrDecoder).decode(chunk,{stream:true});}catch{stop(error('CLI_INVALID_UTF8','CLI output is not valid UTF-8'));return;}
   if(channel==='stdout'){
    partial+=text;let index;while((index=partial.indexOf('\n'))>=0){const value=partial.slice(0,index);partial=partial.slice(index+1);line(value);}
   }
   frame(channel,text);
  };
  const stdout=chunk=>consume('stdout',chunk),stderr=chunk=>consume('stderr',chunk);
  const processError=()=>stop(error('CLI_SPAWN_FAILED','CLI process could not run'));
  const inputError=()=>stop(error('CLI_STDIN_FAILED','Could not deliver the complete CLI input'));
  const closed=(code,exitSignal)=>{
   ended=true;clearTimeout(totalTimer);clearTimeout(idleTimer);clearTimeout(hardKill);signal?.removeEventListener('abort',abort);
   child.stdout?.removeListener('data',stdout);child.stderr?.removeListener('data',stderr);child.removeListener('error',processError);child.stdin?.removeListener('error',inputError);
   try{const tail=stdoutDecoder.decode();partial+=tail;frame('stdout',tail);}catch{failure ||=error('CLI_INVALID_UTF8','CLI stdout ended with incomplete UTF-8');}
   try{frame('stderr',stderrDecoder.decode());}catch{failure ||=error('CLI_INVALID_UTF8','CLI stderr ended with incomplete UTF-8');}
   if(partial)line(partial);
   const processTreeConfirmed=windows?windows.confirmed(child):true;
   if(!processTreeConfirmed)failure ||=error('CLI_TREE_UNCONFIRMED','The Windows supervisor did not confirm process-tree termination');
   if(code!==0)failure ||=error('CLI_EXIT_FAILED','CLI exited unsuccessfully');
   if(!usage||disputedUsage)failure ||=error('CLI_MISSING_USAGE','No unique valid CLI usage was received');
   const evidence={started:true,usageUnknown:!usage||disputedUsage,usageEvents:rawUsageEvents.length,rawUsageEvents:clone(rawUsageEvents),code,exitSignal,processTreeConfirmed,outputBytes:bytes};
   if(usage&&!disputedUsage){evidence.usage=clone(usage);if(evidence.usage.cachedInputTokens===null)delete evidence.usage.cachedInputTokens;}
   if(failure){const category=failure.code;Object.assign(failure,evidence,{code:category,exitCode:code});reject(failure);}else resolve(evidence);
  };
  child.stdout?.on('data',stdout);child.stderr?.on('data',stderr);child.on('error',processError);child.stdin?.on('error',inputError);child.once('close',closed);
  signal?.addEventListener('abort',abort,{once:true});
  totalTimer=setTimeout(()=>stop(error('CLI_TOTAL_TIMEOUT','CLI total deadline reached')),timeoutMs);armIdle();
  try{child.stdin.end(input);}catch{inputError();}
  if(signal?.aborted)abort();
 });
}
module.exports={runTransport,environment,ENVIRONMENT_KEYS,MAX_OUTPUT_BYTES};
