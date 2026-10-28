'use strict';
const fs=require('node:fs'),path=require('node:path');
// Offline diagnostic: launches only Node with a fixed numeric-output program.
// No subscription CLI discovery, credentials, model status or network requests.
const root=path.resolve(__dirname,'..'),outputFile=process.argv[2];
if(process.platform!=='win32')throw Error('This probe measures the Windows process supervisor');
if(!outputFile||!path.isAbsolute(outputFile)||fs.existsSync(outputFile))throw Error('Provide a new absolute output JSON path');
const managed=require(path.join(root,'desktop/windows-process.cjs')),original=managed.spawn;
let current;
managed.spawn=(bin,args,options)=>{
 const child=original(bin,args,options),row=current;
 row.filteredEnvironmentKeys=Object.keys(options.env).sort();
 child.once('spawn',()=>row.events.push({kind:'spawn',ms:performance.now()-row.start}));
 child.stdout.on('data',chunk=>row.events.push({kind:'stdout',ms:performance.now()-row.start,text:chunk.toString().trim()}));
 child.on('close',(code,signal)=>row.events.push({kind:'close',ms:performance.now()-row.start,code,signal}));
 return child;
};
const {processCall}=require(path.join(root,'desktop/subscription.cjs'));
const body='let i=0;const t=setInterval(()=>{console.log(++i);if(i===6){clearInterval(t);}},50)';
(async()=>{
 const runs=[];
 for(const idleTimeoutMs of [200,200,200,1000]){
  current={idleTimeoutMs,start:performance.now(),events:[]};const row=current;
  try{row.result=await processCall(process.execPath,['-e',body],{timeoutMs:0,idleTimeoutMs,onProgress:()=>row.events.push({kind:'activity',ms:performance.now()-row.start})});}
  catch(e){row.error={code:e.code,timeoutKind:e.timeoutKind};}
  row.elapsedMs=performance.now()-row.start;delete row.start;runs.push(row);
 }
 fs.writeFileSync(outputFile,JSON.stringify({actualProcessCall:true,liveModelCalls:0,runs},null,2),{flag:'wx'});
 console.log(JSON.stringify({outputFile,runs:runs.map(({idleTimeoutMs,error,result})=>({idleTimeoutMs,error,exitCode:result?.code}))}));
})().catch(e=>{console.error(e);process.exitCode=1;});
