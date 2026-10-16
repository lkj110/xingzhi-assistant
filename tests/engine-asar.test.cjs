const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
test('packaged ASAR engine and nested parser execute in Electron Node mode without launching an App',async t=>{
 const root=path.resolve(__dirname,'..'),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'assistant-asar-test-')));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'source'));fs.cpSync(path.join(root,'desktop'),path.join(dir,'source/desktop'),{recursive:true});
 fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'source/package.json'));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir');
 await require('@electron/asar').createPackage(path.join(dir,'source'),path.join(dir,'app.asar'));
 fs.writeFileSync(path.join(dir,'fixture.cjs'),`exports.create=({Assistant,options})=>{const deny=async()=>{throw Error('External requests prohibited');};return new Assistant({...options,chat:deny,agentRequest:deny,connectorRequest:deny,officeRequest:deny,webRequest:deny,feedRequest:deny});};`);
 fs.writeFileSync(path.join(dir,'check.cjs'),`
 const assert=require('node:assert/strict'),path=require('node:path'),{Worker}=require('node:worker_threads');
 const {EngineClient}=require('./app.asar/desktop/engine-client.cjs');
 (async()=>{
  const engine=new EngineClient({dir:path.join(__dirname,'workspace'),fixtureModule:path.join(__dirname,'fixture.cjs'),native:async()=>({supported:false})});
  try{
   await engine.ready;assert.ok((await engine.dispatch('stateView')).revision);
   const result=await new Promise((resolve,reject)=>{
    const worker=new Worker('require(require("node:worker_threads").workerData.entry)',{eval:true,workerData:{entry:path.join(__dirname,'app.asar/desktop/documents.cjs'),kind:'assistant-document-parser',name:'test.txt',buffer:Buffer.from('asar-parser')}});
    worker.on('message',message=>{worker.terminate();resolve(message);});worker.on('error',reject);
   });assert.ok(result.result.content.includes('asar-parser'));
  }finally{await engine.close();}
  console.log('asar-worker-and-parser-ok');
 })().catch(error=>{console.error(error);process.exitCode=1;});`);
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(require('electron'),[path.join(dir,'check.cjs')],{cwd:dir,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Packaged worker timed out'));},45000);
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
 assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/asar-worker-and-parser-ok/);
});
