'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Ledger}=require('./ledger.cjs'),plan=require('./plan.json');
const create=()=>new Ledger({dir:fs.mkdtempSync(path.join(os.tmpdir(),'business-ledger-test-')),plan,mode:'offline',sealIdentity:'a'.repeat(64),conservativeAttemptSlot:true});
const meta=id=>({caseId:id,role:'verify',stage:'task_verify',serializedInputBytes:13035,schemaBytes:124,visibleBytes:11709});
test('six case caps permit 34 forwards in total, preserving one refusal slot per case',()=>{
 const l=create();for(const c of plan.caseLimits)for(let i=0;i<c.attempts-1;i++){const a=l.admit(meta(c.id));l.settle(a.id,{inputTokens:100,outputTokens:20});}assert.equal(l.snapshot().totals.admitted,34);assert.equal(l.snapshot().totals.applicationEntryAttempts,34);assert.throws(()=>l.admit(meta(plan.caseLimits[0].id)),{code:'LEDGER_CASE_BUDGET'});assert.equal(l.snapshot().totals.admitted,34);
});
test('zero protocol quota and unknown business ids cannot dispatch',()=>{for(const id of [plan.protocolGate.id,'foreign']){const l=create();assert.throws(()=>l.admit(meta(id)));assert.equal(l.snapshot().totals.admitted,0);}});
test('initial, human recheck, revision and restart share the same case quota',()=>{
 const l=create(),c=plan.caseLimits[4];for(let i=0;i<c.attempts-1;i++){const a=l.admit({...meta(c.id),stage:['initial','recheck','revision','restart'][i%4]});l.settle(a.id,{inputTokens:100,outputTokens:20});}assert.throws(()=>l.admit(meta(c.id)),{code:'LEDGER_CASE_BUDGET'});assert.equal(l.snapshot().cases[c.id].admitted,12);
});
