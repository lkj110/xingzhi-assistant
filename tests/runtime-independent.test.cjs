const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),runtime=require('../desktop/runtime.cjs'),stewardship=require('../desktop/stewardship.cjs');

async function setup(t,chat=async()=>({ok:true})) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-independent-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'独立复核',model:'fixture',baseUrl:'https://example.invalid/v1'});return a;
}


test('Global automatic pause survives sleep and restart without changing individually paused jobs',async t=>{
  let calls=0;const a=await setup(t,async()=>{calls++;return {ok:true};});
  const interrupted=agent.buildJob(a,{goal:'唤醒继续',allowWeb:false}),manual=agent.buildJob(a,{goal:'手动暂停'});interrupted.status='running';manual.status='paused';a.data.delegations.push(interrupted,manual);a.activeAgentJob=interrupted;
  runtime.suspend(a);interrupted.status='paused';a.activeAgentJob=null;await a.dispatch('stewardshipPause');await runtime.resume(a);
  assert.equal(interrupted.status,'ready');assert.equal(manual.status,'paused');assert.equal(calls,0);assert.equal(a.operation,null);assert.equal(stewardship.status(a).reason,'paused');
  const b=new Assistant({dir:a.dir,chat:a.chat});b.tick();assert.equal(calls,0);assert.equal(b.operation,null);assert.equal(b.data.delegations.find(j=>j.id===manual.id).status,'paused');assert.equal(stewardship.status(b).reason,'paused');
});
test('Malformed workspace policy plus malformed ledger leaves readable blocked state and preserves ledger bytes',async t=>{
  let calls=0;const a=await setup(t,async()=>{calls++;return {ok:true};});const ledger=path.join(a.dir,'stewardship-ledger.json');
  a.data.stewardship={timeZone:'not/a/timezone',usage:null};a.save();fs.writeFileSync(ledger,'BROKEN_LEDGER_BYTES');
  const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(b.publicState().stewardshipStatus.reason,'meter');assert.equal(stewardship.canAutomate(b),false);
  await assert.rejects(b.dispatch('testProvider',{id:b.data.providers[0].id}),error=>error.stewardshipMeter===true);assert.equal(calls,0);assert.equal(fs.readFileSync(ledger,'utf8'),'BROKEN_LEDGER_BYTES');
  const c=new Assistant({dir:a.dir});assert.equal(c.publicState().stewardshipStatus.reason,'meter');assert.equal(fs.readFileSync(ledger,'utf8'),'BROKEN_LEDGER_BYTES');
});
