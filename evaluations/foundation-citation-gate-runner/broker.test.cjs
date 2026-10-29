'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {createBroker}=require('./broker.cjs'),plan=require('./plan.json'),{planHash}=require('../foundation-diagnostic-runner/ledger.cjs');
for(const kind of ['missing-context','business-context','identity-drift'])for(const args of [['login','status'],['exec']])test(kind+' rejects '+args.join(' ')+' before any external process',async t=>{
 const base=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(base,'new-gate-broker-'));let spawned=0,guardCalls=0;
 t.mock.method(cp,'spawnSync',()=>{spawned++;throw Error('SYNTHETIC test forbids process');});t.mock.method(cp,'spawn',()=>{spawned++;throw Error('SYNTHETIC test forbids process');});
 const seal='a'.repeat(64),authorization={schema:1,grantedBy:'user',reference:'SYNTHETIC OFFLINE UNIT ONLY',sealIdentity:seal,planSha256:planHash(plan),applicationAttempts:5,reportedTokenStopThreshold:120000,nonHardCapAccepted:true};
 const broker=await createBroker({directory,plan,mode:'live',realCli:path.join(directory,'NONEXISTENT-FAKE-CLI.exe'),sealIdentity:seal,authorization,identityGuard:()=>{guardCalls++;throw Error('SYNTHETIC_IDENTITY_DRIFT');},admission:async()=>{},responseObserved:()=>{}});
 t.after(async()=>{await broker.close();assert.equal(path.dirname(fs.realpathSync(directory)),base);fs.rmSync(directory,{recursive:true,force:true});});
 if(kind!=='missing-context')broker.setContext({id:kind==='business-context'?'F01':plan.protocolGate.id});
 const response=await fetch(broker.bridgeConfig.url,{method:'POST',headers:{'X-Runner-Nonce':broker.bridgeConfig.nonce},body:JSON.stringify({args,input:''})});const frames=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.equal(frames.at(-1).code,78);assert.equal(spawned,0);assert.equal(guardCalls,kind==='identity-drift'?1:0);assert.equal(broker.stopped,true);assert.equal(broker.ledger.snapshot().totals.admitted,0);assert.equal(broker.ledger.snapshot().totals.totalTokens,0);assert.equal(broker.rows[0].transportDispatched,false);
});
