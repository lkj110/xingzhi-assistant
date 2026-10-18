const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const fixture=require('../scripts/root-delivery-fixture.cjs'),agent=require('../desktop/agent.cjs'),recovery=require('../desktop/input-recovery.cjs');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'input-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const deny=()=>{throw Error('Real transport forbidden');};
 for(const [o,k] of [[globalThis,'fetch'],[require('node:net').Socket.prototype,'connect'],[require('node:child_process'),'spawn']])t.mock.method(o,k,deny);
 const f=await fixture.setup({options:{dir},scenario:'input_upgrade'});t.after(()=>fixture.dispose(f.a));
 await agent.run(f.a,f.job.id);assert.equal(f.job.status,'blocked',fixture.compactFailure(f));assert.equal(f.job.lastErrorAutomaticRetry,false);
 assert.equal(f.task.contentVerification,null);assert.notEqual(f.task.primaryArtifactId,f.old.id);
 return f;
}
test('persisted old failure → cold upgraded load → automatic preflight → original primary check → one same-target update/readback → review',async t=>{
 const f=await setup(t),id=f.task.primaryArtifactId,runId=f.a.data.agentRuns[0].id,reads=f.audit.readBatches.length,queries=f.audit.platformCalls.length;
 const before=structuredClone(f.a.spendLedger.scopes['job:'+f.job.id]),history=JSON.stringify(f.a.data.agentRuns[0]);f.reopen();
 assert.equal(f.job.lastErrorAutomaticRetry,false);assert.ok(recovery.eligible(f.a,f.job));
 assert.equal(agent.tick(f.a),true);await f.a.runPromise;
 assert.equal(f.task.primaryArtifactId,id);assert.equal(f.audit.readBatches.length,reads);assert.equal(f.audit.platformCalls.length,queries);
 assert.equal(JSON.stringify(f.a.data.agentRuns.find(r=>r.id===runId)),history);
 const attempt=f.job.executionState.inputRecovery.attempts[recovery.POLICY_VERSION];
 assert.equal(attempt.status,'ready');assert.ok(attempt.preflight.inputChars<1048576);assert.equal(attempt.previousRunId,runId);
 const spend=f.a.spendLedger.scopes['job:'+f.job.id];assert.equal(spend.limitUSD,before.limitUSD);assert.ok(Math.abs(spend.heldUSD-before.heldUSD)<1e-9);
 fixture.assertComplete(f);f.reopen();assert.equal(f.job.status,'review');assert.equal(agent.tick(f.a),false);
});
test('content and post-delivery result conclusions have independent bounded slots across a cold restart',async t=>{
 const f=await setup(t);f.job.maxActions=1;let restarted=false;
 for(let n=0;n<8&&f.job.status!=='review';n++){
  await agent.run(f.a,f.job.id);
  if(!restarted&&f.a.data.agentActions.some(a=>a.tool==='lark_update'&&a.status==='done')){
   assert.equal(f.audit.finalChecksReturned.content,true);assert.equal(f.audit.finalChecksReturned.result,undefined);
   const attempts=structuredClone(f.task.contextFinalizations);f.reopen();assert.deepEqual(f.task.contextFinalizations,attempts);restarted=true;
  }
 }
 assert.equal(restarted,true);fixture.assertComplete(f);
 assert.deepEqual(Object.values(f.task.contextFinalizations).map(r=>r.checkPhase).sort(),['content','result']);
});
for(const kind of ['paused','workspace_paused','budget','unknown_usage','uncertain','permission','accepted','exhausted','generic_config','same_policy','missing_diagnostic'])test('upgrade does not bypass '+kind,async t=>{
 const f=await setup(t),a=f.a,j=f.job;
 if(kind==='paused')j.executionPaused=true;
 if(kind==='workspace_paused')a.data.stewardship.paused=true;
 if(kind==='budget')a.spendLedger.scopes['job:'+j.id].limitUSD=0;
 if(kind==='unknown_usage')a.spendLedger.scopes['job:'+j.id].unreservedCalls=1;
 if(kind==='uncertain')a.data.agentActions.push({id:'uncertain',jobId:j.id,taskId:f.task.id,status:'uncertain'});
 if(kind==='permission')a.data.runtime.accessPolicyProjectionPending=true;
 if(kind==='accepted')f.task.status='completed';
 if(kind==='exhausted'){j.executionState.workEfficiency.phase='awaiting_change';}
 const last=a.data.agentRuns[0].steps.at(-1),call=a.data.modelCalls.find(r=>r.runId===a.data.agentRuns[0].id&&r.status==='error');
 if(kind==='generic_config'){last.errorDiagnostic={source:'codex_cli',kind:'turn_failed'};call.diagnostic=last.errorDiagnostic;}
 if(kind==='same_policy'){last.errorDiagnostic.inputPolicyVersion=recovery.POLICY_VERSION;call.diagnostic.inputPolicyVersion=recovery.POLICY_VERSION;}
 if(kind==='missing_diagnostic'){delete last.errorDiagnostic;delete call.diagnostic;}
 const calls=a.data.modelCalls.length,spent=JSON.stringify(a.spendLedger),artifacts=JSON.stringify(a.data.artifacts);
 if(kind==='permission') {assert.equal(recovery.restore(a,j),false);}
 else assert.equal(recovery.eligible(a,j),false);
 assert.equal(a.data.modelCalls.length,calls);assert.equal(JSON.stringify(a.spendLedger),spent);assert.equal(JSON.stringify(a.data.artifacts),artifacts);
});
test('oversized immutable profile fails preflight without transport, charges or repeated upgrade attempts across restart',async t=>{
 const f=await setup(t);f.a.data.settings.profile='"\\'.repeat(600000);
 const calls=f.a.data.modelCalls.length,spent=JSON.stringify(f.a.spendLedger),artifacts=JSON.stringify(f.a.data.artifacts);
 assert.equal(agent.tick(f.a),true);await f.a.runPromise;
 assert.equal(f.job.status,'blocked');assert.equal(f.job.executionState.inputRecovery.attempts[recovery.POLICY_VERSION].status,'blocked');
 assert.equal(f.a.data.modelCalls.length,calls);assert.equal(JSON.stringify(f.a.spendLedger),spent);assert.equal(JSON.stringify(f.a.data.artifacts),artifacts);
 f.reopen();assert.equal(agent.tick(f.a),false);assert.equal(f.a.data.modelCalls.length,calls);
});
test('revoked current primary cannot be restored by an upgrade, and preflight is free',async t=>{
 const f=await setup(t),policy=require('../desktop/access-policy-store.cjs');
 policy.revoke(f.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+f.task.primaryArtifactId,jobId:f.job.id,taskId:f.task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'test_revoke'});
 const ledger=JSON.stringify(f.a.spendLedger),calls=f.a.data.modelCalls.length;
 assert.equal(recovery.restore(f.a,f.job),false);assert.equal(f.job.status,'blocked');
 assert.equal(JSON.stringify(f.a.spendLedger),ledger);assert.equal(f.a.data.modelCalls.length,calls);
});
