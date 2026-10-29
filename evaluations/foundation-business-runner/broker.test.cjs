'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createBroker}=require('./broker.cjs'),plan=require('./plan.json');
for(const args of [['exec'],['login','status']])for(const context of [undefined,{id:plan.protocolGate.id},{id:'foreign'}])test('unplanned '+args.join(' ')+' context is recorded without transport: '+(context?.id||'missing'),async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-broker-test-'));let calls=0;
 const broker=await createBroker({directory,plan,mode:'offline',sealIdentity:'a'.repeat(64),identityGuard:()=>{},admission:async()=>{},responseObserved:()=>{},fixture:async()=>{calls++;}});t.after(()=>broker.close());if(context)broker.setContext(context);
 const response=await fetch(broker.bridgeConfig.url,{method:'POST',headers:{'X-Runner-Nonce':broker.bridgeConfig.nonce},body:JSON.stringify({args,input:''})});
 const frames=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(frames.at(-1).code,78);assert.equal(broker.stopped,true);assert.equal(calls,0);assert.equal(broker.rows.length,1);assert.equal(broker.rows[0].caseId,context?.id||'unattributed');assert.equal(broker.rows[0].transportDispatched,false);
 const totals=broker.ledger.snapshot().totals;assert.equal(totals.applicationEntryAttempts,1);assert.equal(totals.admitted,0);assert.equal(totals.totalTokens,0);assert.equal(totals.unknownUsage,0);
 const terminal=JSON.parse(fs.readFileSync(path.join(directory,'calls',broker.rows[0].attemptId+'-terminal.json')));assert.equal(terminal.rawOutput,null);assert.ok(!terminal.errorDetail.includes('Cannot read properties'));
});
