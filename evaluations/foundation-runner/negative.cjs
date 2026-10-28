'use strict';
// Fixed-invalid control only. Uses the installed ASAR's real EngineClient/Worker
// from the already isolated Electron process; never loads a checkout Assistant.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>file.startsWith(root+path.sep);
const installedAsar=require('../foundation-acceptance-20261028/plan.json').asarSha256;
function validateInput(input){
 assert.ok(input&&typeof input==='object'&&!Array.isArray(input));
 assert.deepEqual(Object.keys(input).sort(),['candidate','criteria','description','sources','title']);
 for(const k of ['candidate','criteria','description','title'])assert.ok(typeof input[k]==='string'&&input[k].trim(),k);
 assert.ok(Array.isArray(input.sources)&&input.sources.length>0);
 for(const s of input.sources){assert.deepEqual(Object.keys(s).sort(),['content','title']);assert.ok(typeof s.title==='string'&&s.title.trim());assert.ok(typeof s.content==='string'&&s.content.trim());}
}
async function createNegative({app,asar,directory,input,provider,packageIdentity}){
 const expectedAsar=packageIdentity?.asar?packageIdentity.plan.asarSha256:installedAsar;
 if(packageIdentity)assert.equal(packageIdentity.asar,asar);
 validateInput(input);
 // The caller creates its private run directory first; this adapter only adds
 // a unique child after resolving and checking the real temporary-directory path.
 assert.ok(fs.existsSync(directory),'Caller must create the isolated negative-control directory before createNegative');
 const tmp=fs.realpathSync(os.tmpdir()),base=fs.realpathSync(directory),realAsar=fs.realpathSync(asar);
 assert.ok(inside(tmp,base),'Negative control directory must be inside the real system temporary directory');
 assert.equal(sha(fs.readFileSync(realAsar)),expectedAsar,'Frozen ASAR identity changed');
 assert.equal(provider?.type,'codex');assert.equal(provider.model,'gpt-6.1-sol');assert.equal(provider.reasoning,'medium');
 const normalizedProvider={name:'Foundation fixed-draft control',type:'codex',model:provider.model,reasoning:provider.reasoning,inputPrice:0,outputPrice:0,requestPolicy:{idleMinutes:2,totalMinutes:3,retries:0}};
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(base,'negative-'))),workspace=path.join(dir,'workspace'),fixture=path.join(dir,'negative-fixture.cjs'),auditFile=path.join(dir,'seed-identity.json');
 assert.ok(inside(tmp,dir));fs.mkdirSync(workspace);
 fs.copyFileSync(path.join(__dirname,'negative-fixture.cjs'),fixture);
 const fixtureSha256=sha(fs.readFileSync(fixture));
 fs.writeFileSync(path.join(dir,'negative-config.json'),JSON.stringify({asar:realAsar,asarSha256:expectedAsar,workspace,input,provider:normalizedProvider,auditFile,fixtureSha256}),{flag:'wx'});
 const key='foundation-negative-'+crypto.randomUUID();let closed=false,seedIdentity;
 try{
  await app.evaluate(async(_electron,config)=>{
   const nodePath=process.getBuiltinModule('node:path');
   const packageRequire=process.getBuiltinModule('node:module').createRequire(nodePath.join(config.asar,'package.json'));
   const {EngineClient}=packageRequire('./desktop/engine-client.cjs');
   const engine=new EngineClient({dir:config.workspace,fixtureModule:config.fixture,safeStorage:{isEncryptionAvailable:()=>false},native:async action=>{
    if(action==='attentionAvailable')return {supported:false,focused:true};
    if(action==='runtimeStatus')return {online:false,loginSupported:false,openAtLogin:false};
    throw Object.assign(Error('Fixed-draft control forbids native action: '+action),{code:'NEGATIVE_NATIVE_DENIED'});
   }});
   const entry={engine,errors:[],closed:false};globalThis[config.key]=entry;
   engine.on('failure',error=>entry.errors.push({type:'failure',code:error.code,message:error.message}));
   engine.on('backgroundError',error=>entry.errors.push({type:'background',code:error.code,message:error.message}));
   try{await engine.ready;}catch(error){try{await engine.close();}finally{delete globalThis[config.key];}throw error;}
  },{key,asar:realAsar,workspace,fixture});
  seedIdentity=JSON.parse(fs.readFileSync(auditFile,'utf8'));
  assert.equal(seedIdentity.asarSha256,expectedAsar);assert.equal(seedIdentity.fixtureSha256,fixtureSha256);assert.equal(seedIdentity.candidateSha256,sha(input.candidate));
 }catch(error){
  try{await app.evaluate(async(_electron,key)=>{const entry=globalThis[key];if(entry)try{await entry.engine.close();}finally{delete globalThis[key];}},key);}catch{}
  throw error;
 }
 const allowed=new Set(['state','export','groundingStatus','acceptanceSnapshot','advance','stop']);
 const api=async(action,args={})=>{
  assert.ok(!closed,'Negative control is closed');assert.ok(allowed.has(action),'Fixed-draft adapter forbids this command');
  if(action==='advance')assert.equal(args.id,seedIdentity.taskId,'Control task identity changed');
  return app.evaluate(async(_electron,{key,action,args})=>{
   const entry=globalThis[key];if(!entry||entry.closed)throw Error('Fixed-draft worker is closed');
   if(entry.errors.length)throw Error('Fixed-draft worker failed: '+JSON.stringify(entry.errors));
   return entry.engine.dispatch(action,args);
  },{key,action,args});
 };
 const snapshot=async()=>{
  const state=await api('state');
  // state can become a UI summary if its dispatch context changes. Export is
  // the product's explicit full projection, so never hash a preview/deferred body.
  const full=await api('export'),artifact=full.artifacts.find(a=>a.id===seedIdentity.artifactId);
  if(!artifact||typeof artifact.content!=='string'||sha(artifact.content)!==seedIdentity.candidateSha256)throw Object.assign(Error('Fixed invalid candidate was changed or removed'),{code:'FIXED_CANDIDATE_CHANGED'});
  return state;
 };
 const close=async()=>{
  if(closed)return;closed=true;
  await app.evaluate(async(_electron,key)=>{
   const entry=globalThis[key];if(!entry)return;entry.closed=true;
   try{await entry.engine.close();}finally{delete globalThis[key];}
  },key);
 };
 // Retain the synthetic workspace and initial audit for review; never clean up
 // arbitrary caller paths and never expose an API that mutates the fixed draft.
 return {api,snapshot,close,seedIdentity,directory:dir,workspace};
}
module.exports={createNegative};
