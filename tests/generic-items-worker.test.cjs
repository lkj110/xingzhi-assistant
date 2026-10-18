'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EngineClient}=require('../desktop/engine-client.cjs');
async function setup(t,scenario){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'generic-items-worker-')),workspace=path.join(dir,'workspace'),module=path.join(dir,'fixture.cjs'),reportFile=path.join(dir,'audit.json');fs.mkdirSync(workspace);
 fs.writeFileSync(module,`exports.create=async({Assistant,options})=>{const deny=()=>{throw Error('No real transport')};global.fetch=deny;require('node:net').Socket.prototype.connect=deny;require('node:child_process').spawn=deny;require('node:child_process').execFile=deny;return require(${JSON.stringify(path.resolve(__dirname,'../scripts/generic-items-worker-fixture.cjs'))}).setup({Assistant,options,reportFile:${JSON.stringify(reportFile)},scenario:${JSON.stringify(scenario)}});};`);
 let engine;async function start(){engine=new EngineClient({dir:workspace,fixtureModule:module,safeStorage:{isEncryptionAvailable:()=>false},native:async()=>({supported:false})});await engine.ready;}await start();
 t.after(async()=>{await engine.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});return {get engine(){return engine;},restart:async()=>{await engine.close();await start();}};
}
test('G01 formal Worker identity timeout and cold backoff create zero business failures or fees',async t=>{
 const f=await setup(t,'identity'),s=await f.engine.dispatch('controlledItemRun');assert.ok(s.threadId>0);assert.equal(s.code,'TRANSIENT');assert.equal(s.audit.identity,1);assert.deepEqual(s.audit.business,[]);assert.equal(s.operations.length,0);assert.ok(s.attempts.every(a=>a.status!=='failed'));assert.equal(s.preflights.length,1);
 await f.restart();const again=await f.engine.dispatch('controlledItemRetryIdentity');assert.equal(again.code,'TRANSIENT_BACKOFF');assert.equal(again.audit.identity,1);assert.deepEqual(again.audit.business,[]);assert.equal(again.operations.length,0);assert.deepEqual(again.attempts,s.attempts);assert.equal(again.ledger,s.ledger);
});
test('G02 formal Worker partial batch cold restart preserves two sources, unknown third and queued fourth',async t=>{
 const f=await setup(t,'partial'),s=await f.engine.dispatch('controlledItemRun');assert.ok(s.threadId>0);assert.equal(s.code,'ABORTED');assert.deepEqual(s.audit.business,['123','124','125']);assert.deepEqual(s.attempts.map(a=>a.status),['done','done','unknown','queued']);assert.equal(s.sources.length,2);assert.deepEqual(new Set(s.pendingSourceIds),new Set(s.sources));
 await f.restart();const before=await f.engine.dispatch('controlledItemObserve');assert.deepEqual(before.attempts,s.attempts);assert.deepEqual(before.sources,s.sources);assert.equal(before.candidates[2],'reconcile');assert.equal(before.candidates[3],'execute');
 const replay=await f.engine.dispatch('controlledItemRetryUnknown');assert.equal(replay.code,'OPERATION_RECONCILIATION_REQUIRED');assert.deepEqual(replay.after.audit.business,s.audit.business);assert.deepEqual(replay.after.attempts,s.attempts);assert.deepEqual(replay.after.sources,s.sources);assert.equal(replay.after.ledger,s.ledger);assert.equal(replay.after.history,s.history);
});
