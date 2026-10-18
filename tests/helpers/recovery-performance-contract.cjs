'use strict';
const fs=require('node:fs'),path=require('node:path');
const history=require('./offline-test-support.cjs');
const LIMITS=Object.freeze({coldPublicMs:2000,unchangedStateViewMs:100});
const zero=()=>({networkAttempts:0,modelAttempts:0,subprocessAttempts:0,outsideWriteAttempts:0,businessAttempts:0,nativeAttempts:0,liveReadAttempts:0});
const failure=code=>Object.assign(Error(code),{code});
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const digest=history.digest;
const inside=(root,file)=>{const rel=path.relative(root,path.resolve(file));return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
function verifySyntheticSnapshot(snapshot,capture,expected){
  if(!expected||!Number.isSafeInteger(expected.files)||expected.files<1||typeof expected.workspaceHash!=='string')throw failure('SYNTHETIC_CAPTURE_IDENTITY_REQUIRED');
  const root=fs.realpathSync(snapshot);
  if(/[/\\]Library[/\\]Application Support[/\\]/.test(root))throw failure('LIVE_WORKSPACE_FORBIDDEN');
  const recorded=json(capture);
  if(recorded.consistent!==true||recorded.files!==expected.files||recorded.differences?.length!==0||
    recorded.manifest?.['workspace.json']!==expected.workspaceHash||Object.keys(recorded.manifest).length!==expected.files)throw failure('INVALID_CAPTURE_RECORD');
  const files=history.manifest(root);
  if(files.length!==expected.files||files.some(row=>recorded.manifest[row.path]!==row.sha256))throw failure('CAPTURE_HASH_MISMATCH');
  return {root,files,digest:digest(files),capturedAt:recorded.capturedAt};
}
function preservation(data,spend,interruptedIds=[]){
  const calls=data.modelCalls||[];
  const interrupted=new Set(interruptedIds);
  return {
    modelCalls:digest(calls),modelCallCount:calls.length,
    unknownUsage:calls.filter(c=>!Number.isFinite(c.inputTokens)||!Number.isFinite(c.outputTokens)).map(c=>({id:c.id,hash:digest(c)})),
    runs:digest((data.agentRuns||[]).map(r=>interrupted.has(r.id)?Object.fromEntries(Object.entries(r).filter(([k])=>!['status','finishedAt','modelCalls'].includes(k))):r)),runCount:(data.agentRuns||[]).length,
    actions:digest(data.agentActions||[]),actionCount:(data.agentActions||[]).length,
    callsUsed:digest((data.delegations||[]).map(j=>({id:j.id,callsUsed:j.callsUsed,usage:j.usage}))),
    spend:digest(spend),
    costs:Object.values(spend.scopes||{}).map(s=>({key:s.key,spentUSD:s.spentUSD,heldUSD:s.heldUSD,
      limitUSD:s.limitUSD,unknownCalls:s.usage?.unknownCalls,unknownAcknowledged:s.unknownAcknowledged,
      unreservedCalls:s.unreservedCalls,pending:digest(s.pending),approvals:digest(s.approvals)})),
  };
}

function installIsolation(root,audit){
  const guard=history.installIsolation(root,audit),undo=[];
  const deny=kind=>function(){audit[kind]++;throw failure('G10_FORBIDDEN_'+kind.toUpperCase());};
  const patch=(object,key,value)=>{const old=object[key];object[key]=value;undo.push(()=>{object[key]=old;});};
  patch(require('node:worker_threads'),'Worker',deny('subprocessAttempts'));
  patch(require('node:child_process').ChildProcess.prototype,'spawn',deny('subprocessAttempts'));
  for(const key of ['connect','createServer','createSecureServer'])patch(require('node:http2'),key,deny('networkAttempts'));
  patch(require('node:net').Server.prototype,'listen',deny('networkAttempts'));
  for(const key of Object.keys(require('node:dns'))){if(/^(lookup|resolve|reverse)/.test(key)&&typeof require('node:dns')[key]==='function')patch(require('node:dns'),key,deny('networkAttempts'));}
  for(const key of Object.keys(require('node:dns').promises)){if(/^(lookup|resolve|reverse)/.test(key))patch(require('node:dns').promises,key,deny('networkAttempts'));}
  for(const Resolver of [require('node:dns').Resolver,require('node:dns').promises.Resolver]){
    for(const key of Object.getOwnPropertyNames(Resolver.prototype))if(/^(lookup|resolve|reverse)/.test(key))patch(Resolver.prototype,key,deny('networkAttempts'));
  }
  for(const key of ['WebSocket','EventSource'])if(globalThis[key])patch(globalThis,key,deny('networkAttempts'));
  // No existing live workspace may be read even if its absolute path is present
  // in the captured profile. Modules/dependencies and the copied history can load.
  for(const key of ['readFileSync','readdirSync','statSync','lstatSync','openSync','readFile','readdir','stat','lstat','open','createReadStream']){
    const old=fs[key];patch(fs,key,function(file,...args){
      if(typeof file!=='number'&&/[/\\]Library[/\\]Application Support[/\\]/.test(String(file)))return deny('liveReadAttempts')();
      return old.call(fs,file,...args);
    });
  }
  for(const key of ['readFile','readdir','stat','lstat','open']){
    const old=fs.promises[key];patch(fs.promises,key,function(file,...args){
      if(/[/\\]Library[/\\]Application Support[/\\]/.test(String(file)))return deny('liveReadAttempts')();
      return old.call(fs.promises,file,...args);
    });
  }
  require('node:module').syncBuiltinESMExports();
  return {...guard,denyBusiness:deny('businessAttempts'),denyNative:deny('nativeAttempts'),restore(){for(const restore of undo.reverse())restore();guard.restore();require('node:module').syncBuiltinESMExports();}};
}
function performanceGates(samples){
  return samples.flatMap((sample,i)=>[
    {id:`sample${i+1}.cold_public_under_2000ms`,passed:Number.isFinite(sample.coldPublic?.wallMs)&&sample.coldPublic.wallMs<LIMITS.coldPublicMs,actualMs:sample.coldPublic?.wallMs??null,limitMs:2000},
    {id:`sample${i+1}.unchanged_stateView_under_100ms`,passed:sample.warmUnchanged===true&&Number.isFinite(sample.rpc?.warmStateView?.wallMs)&&sample.rpc.warmStateView.wallMs<LIMITS.unchangedStateViewMs,actualMs:sample.rpc?.warmStateView?.wallMs??null,limitMs:100},
  ]);
}
function validateOptions(options={}){
 const repetitions=options.repetitions??1,timeoutMs=options.timeoutMs??120000;
 if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>10||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000)throw failure('INVALID_OPTIONS');
 return {repetitions,timeoutMs};
}
function parseArgs(args){
  const options={},keys={'--snapshot':'snapshot','--capture':'capture','--output':'output','--repetitions':'repetitions','--timeout-ms':'timeoutMs'};
  for(let i=0;i<args.length;i++){
    const key=keys[args[i]];if(!key)throw failure('UNKNOWN_ARGUMENT');
    const value=args[++i];if(!value||value.startsWith('--'))throw failure('MISSING_ARGUMENT');
    if(Object.hasOwn(options,key))throw failure('DUPLICATE_ARGUMENT');
    options[key]=['repetitions','timeoutMs'].includes(key)?Number(value):value;
  }
  return options;
}
async function runCli(args,execute){
 try{
  if(typeof execute!=='function')throw failure('PRIVATE_HISTORY_UNAVAILABLE');
  const report=await execute(parseArgs(args));
  fs.writeSync(1,JSON.stringify({status:report.status,correctnessPassed:report.correctnessPassed,performancePassed:report.performancePassed,
    output:report.output,failedAssertions:report.assertions.filter(a=>!a.passed),performanceGates:report.performanceGates,
    samples:report.samples.map(s=>({index:s.index,startupMs:s.rpc.startupReady?.wallMs,coldPublicMs:s.coldPublic?.wallMs,
      coldStateViewMs:s.rpc.coldStateView?.wallMs,warmStateViewMs:s.rpc.warmStateView?.wallMs,pauseMs:s.rpc.pause?.wallMs,
      pause:s.pause,peakRssBytes:s.processPeakSampledRssBytes,preRunHost:s.preRunHost,error:s.error}))})+'\n');
  return report.status==='passed'?0:1;
 }catch(error){fs.writeSync(2,JSON.stringify({status:'failed',code:error.code||error.name,message:error.message})+'\n');return 1;}
}
module.exports={LIMITS,zero,preservation,installIsolation,performanceGates,validateOptions,parseArgs,runCli,verifySyntheticSnapshot};
