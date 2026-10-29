'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Ledger}=require('./ledger.cjs'),base=require('./plan.json');
function ledger(plan=base){return new Ledger({dir:fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-ledger-')),plan,mode:'offline',sealIdentity:'a'.repeat(64),conservativeAttemptSlot:true});}
const meta={caseId:base.protocolGate.id,role:'execute',stage:'task_work',serializedInputBytes:13035,schemaBytes:124,visibleBytes:11709};
test('single gate allows four forwards; fifth is a recorded local refusal and sixth remains visible',()=>{
 const l=ledger();for(let i=0;i<4;i++){const a=l.admit(meta);l.settle(a.id,{inputTokens:100,outputTokens:20});}assert.throws(()=>l.admit(meta),{code:'LEDGER_GLOBAL_BUDGET'});let s=l.snapshot();assert.equal(s.totals.attempts,5);assert.equal(s.totals.admitted,4);assert.equal(s.totals.unknownUsage,0);assert.equal(s.totals.totalTokens,480);assert.throws(()=>l.admit(meta));s=l.snapshot();assert.equal(s.totals.applicationEntryAttempts,6);assert.equal(s.totals.unexpectedAttempts,1);
});
test('old four-slot plan refuses the fourth necessary call without borrowing business quota',()=>{
 const p=structuredClone(base);p.budget.applicationAttempts=p.budget.protocolAttempts=4;const l=ledger(p);for(let i=0;i<3;i++){const a=l.admit(meta);l.settle(a.id,{inputTokens:100,outputTokens:20});}assert.throws(()=>l.admit(meta));assert.equal(l.snapshot().totals.admitted,3);
});
test('foreign business case is refused; known prefix plus failed continuation remains unknown',()=>{
 const a=ledger();assert.throws(()=>a.admit({...meta,caseId:'F01'}));assert.equal(a.snapshot().totals.admitted,0);
 const l=ledger(),first=l.admit(meta);l.settle(first.id,{inputTokens:12040,outputTokens:61});const second=l.admit(meta);l.fail(second.id,'CLI_PROTOCOL_REJECTION');const s=l.snapshot();assert.equal(s.totals.knownTokenSubtotal,12101);assert.equal(s.totals.totalTokens,null);assert.equal(s.totals.unknownUsage,1);
});
test('100k and 120k admission compare actual known prefix plus reservation, not synthetic forecasts',()=>{
 for(const cap of [100000,120000])for(const delta of [0,1]){
  const p=structuredClone(base);p.budget.reportedTokenStopThreshold=p.budget.protocolTokenStopThreshold=cap;const l=ledger(p),reservation=meta.serializedInputBytes+meta.schemaBytes+32768+4096;
  const total=cap-reservation+delta,values=[12101,Math.floor((total-12101)/2),Math.ceil((total-12101)/2)];for(const v of values){const a=l.admit(meta);l.settle(a.id,{inputTokens:v,outputTokens:0});}
  if(delta)assert.throws(()=>l.admit(meta),{code:'LEDGER_GLOBAL_BUDGET'});else assert.equal(l.admit(meta).transportPermitted,true);
 }
});
