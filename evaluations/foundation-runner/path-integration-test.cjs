'use strict';
// Offline only. Two separate Node environments exercise the same sealed app
// with real Windows short/long TEMP aliases. No CLI discovery or live option.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {read,write}=require('./common.cjs');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity=file=>{const s=fs.statSync(file,{bigint:true});assert.ok(s.isDirectory());return {dev:String(s.dev),ino:String(s.ino)};};
function aliases(){
 assert.equal(process.platform,'win32');
 const long=fs.realpathSync.native(os.tmpdir());
 const script=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class FoundationShortTemp {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint capacity);
}
'@
$buffer=New-Object System.Text.StringBuilder 32768
$length=[FoundationShortTemp]::GetShortPathName($env:FOUNDATION_PATH_TEMP_LONG,$buffer,[uint32]$buffer.Capacity)
if($length -eq 0 -or $length -ge $buffer.Capacity){throw 'Cannot obtain a complete Windows short path'}
@{short=$buffer.ToString()} | ConvertTo-Json -Compress`;
 const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 const discovered=JSON.parse(cp.execFileSync(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:65536,env:{...process.env,FOUNDATION_PATH_TEMP_LONG:long}}));
 const short=discovered.short;
 assert.ok(typeof short==='string'&&path.isAbsolute(short),'No absolute short TEMP alias');
 assert.notEqual(short.toLowerCase(),long.toLowerCase(),'Short TEMP alias is not a distinct spelling; this regression cannot silently skip');
 assert.equal(path.relative(fs.realpathSync.native(short),long),'','TEMP aliases resolve to different directories');
 const fileIdentity=identity(long);assert.deepEqual(identity(short),fileIdentity,'TEMP aliases have different file identities');
 return {short,long,fileIdentity,method:'GetShortPathNameW and fs.realpathSync.native'};
}
function cleanEnvironment(temp){
 const env={...process.env,TEMP:temp,TMP:temp};
 for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','FOUNDATION_PATH_TEMP_LONG'])delete env[key];
 return env;
}
async function child({executable,output,variant,temp}){
 assert.equal(process.platform,'win32');assert.ok(['short','long'].includes(variant));assert.ok(path.isAbsolute(temp));
 assert.equal(process.env.TEMP,temp);assert.equal(process.env.TMP,temp);assert.equal(os.tmpdir(),temp);
 const evidence={schema:1,variant,temp:process.env.TEMP,tmp:process.env.TMP,observedTmpdir:os.tmpdir(),canonicalTmpdir:fs.realpathSync.native(os.tmpdir()),fileIdentity:identity(os.tmpdir()),nodeVersion:process.version,nodeExecutableSha256:sha(process.execPath),mode:'offline',realModelCalls:0};
 write(path.join(path.dirname(output),variant+'-environment.json'),evidence);
 await require('./integration-test.cjs').test({executable,output});
}
async function execute({executable,output,variant,temp}){
 const stdoutPath=path.join(path.dirname(output),variant+'-stdout.log'),stderrPath=path.join(path.dirname(output),variant+'-stderr.log');
 const stdout=fs.openSync(stdoutPath,'wx'),stderr=fs.openSync(stderrPath,'wx');
 try{
  const result=await new Promise((resolve,reject)=>{
   const childProcess=cp.spawn(process.execPath,[__filename,'--child','--executable',executable,'--output',output,'--variant',variant,'--temp',temp],{cwd:path.resolve(__dirname,'../..'),env:cleanEnvironment(temp),windowsHide:true,stdio:['ignore',stdout,stderr]});
   childProcess.on('error',reject);childProcess.on('close',(code,signal)=>resolve({code,signal}));
  });
  return {...result,stdoutPath,stderrPath};
 }finally{fs.closeSync(stdout);fs.closeSync(stderr);}
}
async function test({executable,output}){
 assert.equal(process.platform,'win32');assert.ok(typeof executable==='string'&&path.isAbsolute(executable));assert.ok(typeof output==='string'&&path.isAbsolute(output)&&!fs.existsSync(output),'Use a new absolute output directory');
 const discovered=aliases();fs.mkdirSync(output,{recursive:true});write(path.join(output,'path-aliases.json'),{schema:1,...discovered,mode:'offline',realModelCalls:0});
 const result={schema:1,kind:'windows-temp-alias-offline-integration',mode:'offline',passed:false,tests:0,realModelCalls:0,variants:[]};
 try{
  for(const variant of ['short','long']){
   const directory=path.join(output,variant),run=await execute({executable,output:directory,variant,temp:discovered[variant]});
   const entry={variant,exitCode:run.code,signal:run.signal,passed:false,evidenceSha256:{stdout:sha(run.stdoutPath),stderr:sha(run.stderrPath)}};result.variants.push(entry);
   assert.equal(run.code,0,'Offline integration failed for '+variant+' TEMP; inspect retained stderr log');
   const environmentFile=path.join(output,variant+'-environment.json'),environment=read(environmentFile),resultsFile=path.join(directory,'integration-results.json'),integration=read(resultsFile);
   assert.equal(environment.observedTmpdir,discovered[variant]);assert.deepEqual(environment.fileIdentity,discovered.fileIdentity);assert.equal(integration.passed,true);assert.equal(integration.tests,5);assert.equal(integration.liveModelCalls,0);
   assert.deepEqual(integration.results.map(r=>r.name),['full-lifecycle','malformed-envelope','malformed-inner','unknown-usage','case-budget']);
   const scenarios=integration.results.map(r=>{
    assert.equal(r.passed,true);assert.equal(r.liveModelCalls,0);const file=path.join(directory,r.name,'summary.json'),summary=read(file);
    assert.equal(summary.mode,'offline');assert.equal(summary.liveModelCalls,0);assert.equal(summary.syntheticUsage,true);assert.equal(summary.userWorkspaceTouched,false);assert.equal(summary.manualAcceptancePerformed,false);
    return {name:r.name,passed:true,syntheticCalls:r.syntheticCalls,summarySha256:sha(file)};
   });
   Object.assign(entry,{passed:true,tests:integration.tests,scenarios,evidenceSha256:{...entry.evidenceSha256,environment:sha(environmentFile),integration:sha(resultsFile)}});result.tests+=integration.tests;
  }
  assert.equal(result.tests,10);result.passed=true;
 }catch(error){result.error={code:error.code||null,message:error.message};throw error;}
 finally{write(path.join(output,'path-integration-results.json'),result);}
 console.log(JSON.stringify({pathIntegrationPassed:true,tests:result.tests,realModelCalls:0,output}));return result;
}
module.exports={test,aliases};
if(require.main===module){
 const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'},child:{type:'boolean'},variant:{type:'string'},temp:{type:'string'}}});
 const task=values.child?child({executable:values.executable,output:values.output,variant:values.variant,temp:values.temp}):test({executable:values.executable,output:values.output});
 task.catch(error=>{console.error(error.stack);process.exitCode=1;});
}
