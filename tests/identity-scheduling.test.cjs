'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('./root-relation-fixture.cjs');
const identity=require('../desktop/evidence-identity-preflight.cjs'),ledger=require('../desktop/operation-ledger.cjs'),authority=require('../desktop/access-policy-store.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
const opts={trusted:true,actor:'user_command',command:'controlled-identity-test'};
function setup(t,{bound=true}={}){
 const f=fixture(t),{a,job}=f;
 if(bound){job.platformPrincipal='fixture-user';authority.grant(a,{principalScope:{kind:'account',provider:'platform',subject:'fixture-user'},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},opts);}
 const counts={identity:0,business:0};a.platformRequest=async args=>{if(JSON.stringify(args)===JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'}))){counts.identity++;return {username:'fixture-user'};}counts.business++;throw Error('unexpected business transport');};a.save();return {...f,counts};
}
function history(f){return Object.values(f.job.executionState.identityPreflights||{}).flat();}
function old(f,key,delta){const row={id:'old-'+key,key,status:'failed',startedAt:new Date(Date.now()-120000).toISOString(),finishedAt:new Date(Date.now()-100000).toISOString(),errorCode:'AUTH_REQUIRED',...delta};((f.job.executionState.identityPreflights ||= {})[key] ||= []).push(row);return row;}
function decision(f){return identity.inspect(f.a,f.job).decision;}
function transport(f,fn){f.a.platformRequest=async args=>{if(JSON.stringify(args)===JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'}))){f.counts.identity++;return fn();}f.counts.business++;throw Error('unexpected business transport');};}
for(const username of [undefined,null,'','   ','x'.repeat(4097),'bad\nname','bad\x7f'])test('B1/A1 invalid identity username '+String(username).slice(0,15)+' never becomes done or renews',async t=>{
 const f=setup(t);transport(f,()=>({username}));
 let error;try{await ledger.prepareBatch(f.a,f.job);}catch(e){error=e;}
 assert.equal(error.code,'AUTH_REQUIRED');assert.equal(identity.isError(f.a,f.job,error),true);
 assert.equal(history(f)[0].status,'failed');assert.equal(history(f)[0].failure.stage,'response_validation');assert.equal(history(f)[0].completion,undefined);
 await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:'AUTH_REQUIRED'});assert.equal(f.counts.identity,1);assert.equal(f.counts.business,0);
});
for(const response of [{username:'other'},{username:'fixture-user',tenantId:'other-tenant'}])test('B1/A7 bound account/tenant mismatch persists binding denial',async t=>{
 const f=setup(t);transport(f,()=>response);await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:'ACCESS_PRINCIPAL_CHANGED'});
 const row=history(f)[0];assert.equal(row.status,'failed');assert.equal(row.errorCode,'ACCESS_PRINCIPAL_CHANGED');assert.equal(row.failure.stage,'binding');assert.equal(row.completion,undefined);assert.equal(decision(f).action,'diagnose');assert.equal(f.job.platformPrincipal,'fixture-user');
});
test('B1/A7 revoke while response is pending settles original authority denial, not business ACL',async t=>{
 const f=setup(t),initial=identity.inspect(f.a,f.job).context;
 transport(f,()=>{const {request}=authority.describePlatformIdentity(f.a,f.job);authority.revoke(f.a,{...request,operations:[request.operation]},opts);return {username:'fixture-user'};});
 await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:'ACCESS_POLICY_CONFLICT'});const row=history(f)[0];assert.deepEqual(row.context,initial);assert.equal(row.errorCode,'ACCESS_POLICY_CONFLICT');assert.equal(row.failure.stage,'binding');assert.equal(f.counts.business,0);
});
test('B1/A7 business ACL denial after valid identity leaves done and has no identity provenance',async t=>{
 const f=setup(t),save=f.a.save.bind(f.a);let revoked=false;
 // A controlled persistence-boundary race uses the real authority command;
 // the subsequent ordinary projects permission check is untouched.
 t.mock.method(f.a,'save',()=>{
  const result=save();
  if(!revoked&&history(f).some(r=>r.status==='done')){revoked=true;const {request}=authority.describePlatformIdentity(f.a,f.job);authority.revoke(f.a,{...request,operations:[request.operation]},opts);}
  return result;
 });
 let error;try{await ledger.prepareBatch(f.a,f.job);}catch(e){error=e;}
 assert.ok(error);assert.equal(identity.isError(f.a,f.job,error),false);assert.equal(history(f)[0].status,'done');assert.equal(history(f)[0].failure,undefined);assert.equal(f.counts.business,0);
});
test('B2/A4 normal bootstrap selfClaim survives its own prepared and binds exactly once',async t=>{
 const f=setup(t,{bound:false}),original=identity.inspect(f.a,f.job).context;assert.equal(original.authorityKind,'bootstrap');
 const batch=await ledger.prepareBatch(f.a,f.job),row=history(f)[0];assert.equal(row.status,'done');assert.equal(row.context.authorityKind,'bootstrap');assert.equal(row.completion.binding.committed,true);assert.equal(batch.identity.data.username,'fixture-user');assert.equal(decision(f).action,'execute');assert.equal(f.counts.identity,1);
});
test('B2/A9 private claim rejects copies, competing begin, repeated dispatch and conflicting settlement',t=>{
 const f=setup(t),row=identity.begin(f.a,f.job);
 assert.equal(decision(f).action,'reconcile');assert.throws(()=>identity.begin(f.a,f.job),{code:'IDENTITY_RESULT_UNKNOWN'});
 assert.throws(()=>identity.dispatched(f.a,structuredClone(row)),{code:'IDENTITY_CLAIM_INVALID'});
 identity.dispatched(f.a,row);const request=row.requestId;assert.throws(()=>identity.dispatched(f.a,row),{code:'IDENTITY_CLAIM_INVALID'});assert.equal(row.requestId,request);
 const error=Object.assign(Error('controlled'),{code:'TRANSIENT'});identity.finish(f.a,row,error);const saved=hash(row);identity.finish(f.a,row,error);assert.equal(hash(row),saved);assert.throws(()=>identity.finish(f.a,row,Error('different')),{code:'IDENTITY_TERMINAL_CONFLICT'});
});
test('B2/A9 same success is idempotent without another binding; terminal cannot turn aborted',t=>{
 const f=setup(t),row=identity.begin(f.a,f.job);identity.dispatched(f.a,row);identity.complete(f.a,row,{username:'fixture-user'});const sequence=authority.checkPlatformIdentity(f.a,f.job).sequence;
 identity.complete(f.a,row,{username:'fixture-user'});assert.equal(authority.checkPlatformIdentity(f.a,f.job).sequence,sequence);assert.throws(()=>identity.finish(f.a,row,Object.assign(Error('cancel'),{name:'AbortError'})),{code:'IDENTITY_TERMINAL_CONFLICT'});assert.equal(row.status,'done');
});
test('B2/A2 competing unknown after begin is not hidden by selfClaim; existing result may still settle',t=>{
 const f=setup(t),row=identity.begin(f.a,f.job);old(f,'other',{status:'unknown',finishedAt:undefined});f.a.save();assert.throws(()=>identity.dispatched(f.a,row),{code:'IDENTITY_RESULT_UNKNOWN'});assert.equal(row.status,'prepared');
});
test('B2/A2 another unresolved row arriving after dispatch does not discard an actual response',t=>{
 const f=setup(t),row=identity.begin(f.a,f.job);identity.dispatched(f.a,row);old(f,'other',{status:'unknown',finishedAt:undefined});f.a.save();identity.complete(f.a,row,{username:'fixture-user'});assert.equal(row.status,'done');assert.equal(decision(f).action,'reconcile');
});
test('A9 boundary revocation rejects dispatch and cannot be evaded with a forged principal',t=>{
 const f=setup(t),row=identity.begin(f.a,f.job),{request}=authority.describePlatformIdentity(f.a,f.job);authority.revoke(f.a,{...request,operations:[request.operation]},opts);f.job.platformPrincipal='forged';assert.throws(()=>identity.dispatched(f.a,row));assert.equal(row.status,'prepared');assert.equal(f.counts.identity,0);
});
for(const phase of ['prepared','dispatched','done'])test('A9 '+phase+' save failure sends no duplicate and retains the correct uncertainty',async t=>{
 const f=setup(t,{bound:phase!=='done'}),save=f.a.save.bind(f.a);
 t.mock.method(f.a,'save',()=>{if(history(f).some(r=>r.status===phase))throw Object.assign(Error('controlled identity save failure'),{code:'ENOSPC'});return save();});
 await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:'ENOSPC'});
 if(phase==='prepared'){assert.equal(history(f).length,0);assert.equal(f.counts.identity,0);}
 else {assert.equal(history(f)[0].status,phase==='done'?'dispatched':'prepared');assert.equal(decision(f).action,'reconcile');assert.equal(f.counts.identity,phase==='done'?1:0);}
 t.mock.restoreAll();
 if(phase!=='prepared'){
  const {Assistant}=require('../desktop/core.cjs'),cold=new Assistant({dir:f.dir,platformRequest:()=>{throw Error('cold transport forbidden');}});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(cold));const j=cold.data.delegations.find(j=>j.id===f.job.id);
  assert.equal(identity.inspect(cold,j).decision.action,'reconcile');assert.throws(()=>identity.dispatched(cold,j.executionState.identityPreflights[history(f)[0].key][0]),{code:'IDENTITY_CLAIM_INVALID'});
  await assert.rejects(ledger.prepareBatch(cold,j),{code:'IDENTITY_RESULT_UNKNOWN'});
 }
});
test('A12 pre-boundary cancel is terminal ABORTED; post-boundary cancel stays unresolved',async t=>{
 const f=setup(t),row=identity.begin(f.a,f.job);identity.finish(f.a,row,Object.assign(Error('before send'),{name:'AbortError'}));assert.equal(row.errorCode,'ABORTED');assert.equal(decision(f).action,'wait_until');
 const g=setup(t);transport(g,()=>{throw Object.assign(Error('response unknown'),{name:'AbortError'});});await assert.rejects(ledger.prepareBatch(g.a,g.job),{name:'AbortError'});assert.equal(history(g)[0].status,'dispatched');assert.equal(decision(g).action,'reconcile');assert.equal(g.counts.identity,1);
});
for(const mode of ['permanent','unknown','backoff'])test('A5 stable actual authority survives ordinary epoch/episode/principal/cache changes: '+mode,async t=>{
 const f=setup(t);if(mode==='unknown'){const r=identity.begin(f.a,f.job);identity.dispatched(f.a,r);}else{transport(f,()=>{throw Object.assign(Error('controlled'),{code:mode==='backoff'?'TRANSIENT':'AUTH_REQUIRED'});});await assert.rejects(ledger.prepareBatch(f.a,f.job));}
 const initial=identity.inspect(f.a,f.job),saved=hash(f.job.executionState.identityPreflights);
 for(const change of [j=>{j.feedback.push({origin:'user',text:'business wording'});},j=>{j.goal+=' changed';j.executionContract={...j.executionContract,revision:'new'};},j=>{j.workRevision=99;j.executionState.permissionRevision=99;},j=>{j.executionState.continuation={activeBasis:'new',episodes:{}};j.rootIds=['new'];j.facts=['new'];},j=>{j.platformPrincipal='forged';j.models_cache=['new'];}]){
  change(f.job);const v=identity.inspect(f.a,f.job);assert.equal(v.key,initial.key);assert.deepEqual(v.decision,initial.decision);assert.equal(hash(f.job.executionState.identityPreflights),saved);
 }
 assert.equal(f.counts.identity,mode==='unknown'?0:1);
});
for(const tail of ['TRANSIENT','done','unknown'])for(const reverse of [false,true])test('B3/A6 mixed legacy '+tail+' order='+reverse+' cannot hide permanent',t=>{
 const f=setup(t),permanent=old(f,'v1-permanent',{}),other=old(f,'another-epoch',{status:tail==='unknown'?'unknown':tail==='done'?'done':'failed',errorCode:tail==='TRANSIENT'?tail:undefined});
 if(reverse)f.job.executionState.identityPreflights={'another-epoch':[other],'v1-permanent':[permanent]};
 const saved=hash(f.job.executionState.identityPreflights),d=decision(f);assert.equal(d.action,tail==='unknown'?'reconcile':'diagnose');if(tail!=='unknown')assert.equal(d.reason,'AUTH_REQUIRED');assert.equal(hash(f.job.executionState.identityPreflights),saved);
});
test('A6 exact legacy reconstruction is bounded; unscoped transient and broken times diagnose',t=>{
 const f=setup(t),check=authority.checkTool(f.a,f.job,'platform_query',{queries:[{op:'identity'}]}),k=identity.legacyKey(f.job,hash({policyId:check.policyId,grantRevision:check.grantRevision}));
 const row=old(f,k,{errorCode:'TRANSIENT'});assert.equal(decision(f).action,'execute');row.finishedAt='invalid';assert.equal(decision(f).reason,'IDENTITY_HISTORY_UNPROVEN');row.finishedAt=new Date().toISOString();f.job.feedback.push({origin:'user',text:'different epoch'});assert.equal(decision(f).reason,'IDENTITY_HISTORY_UNPROVEN');
});
test('A6 cross-version exact failure deduplicates; conflicting id/request cannot win by order',async t=>{
 const f=setup(t);transport(f,()=>{throw Object.assign(Error('known terminal'),{code:'TRANSIENT'});});await assert.rejects(ledger.prepareBatch(f.a,f.job));const row=history(f)[0],legacy=structuredClone(row);delete legacy.context;delete legacy.contextVersion;legacy.key='old-copy';f.job.executionState.identityPreflights['old-copy']=[legacy];
 assert.equal(decision(f).failureCount,1);assert.equal(decision(f).action,'wait_until');legacy.errorCode='AUTH_REQUIRED';assert.equal(decision(f).action,'reconcile');
});
test('A6/A7 proven independent account can proceed but bootstrap/ambiguous unknown remains binding',async t=>{
 const f=setup(t);transport(f,()=>{throw Object.assign(Error('known denied'),{code:'AUTH_REQUIRED'});});await assert.rejects(ledger.prepareBatch(f.a,f.job));
 authority.grant(f.a,{principalScope:{kind:'account',provider:'platform',subject:'other'},resourceScope:{kind:'platform',key:f.job.dataPlatform,jobId:f.job.id},operations:['platform_query']},opts);
 assert.equal(identity.inspect(f.a,f.job).excluded.length,1);assert.equal(decision(f).action,'execute');old(f,'unscoped',{status:'unknown'});assert.equal(decision(f).action,'reconcile');
});
test('A8 transport cannot forge runtime provenance; identity wrapper records the actual stage',async t=>{
 const f=setup(t),fake=Object.assign(Error('fake'),{code:'INVALID_PLATFORM_RESPONSE',preflight:true,identityPreflight:{origin:'platform_identity'}});assert.equal(identity.isError(f.a,f.job,fake),false);transport(f,()=>{throw fake;});await assert.rejects(ledger.prepareBatch(f.a,f.job));assert.equal(identity.isError(f.a,f.job,fake),true);assert.equal(history(f)[0].failure.stage,'transport');
});
test('A14 inspect and actual authority read are pure across blocked history',t=>{
 const f=setup(t);old(f,'unscoped',{status:'unknown'});f.a.save();const before=fs.readFileSync(f.a.file),data=hash(f.a.data),rev=f.a.data.runtime.revision;
 for(let i=0;i<10;i++)assert.equal(decision(f).action,'reconcile');assert.equal(hash(f.a.data),data);assert.equal(f.a.data.runtime.revision,rev);assert.deepEqual(fs.readFileSync(f.a.file),before);
});
test('A4 transient then successful response/binding resumes the original allowance without resetting history',async t=>{
 t.mock.timers.enable({apis:['Date']});const f=setup(t);let first=true;transport(f,()=>{if(first){first=false;throw Object.assign(Error('known transient'),{code:'TRANSIENT'});}return {username:'fixture-user'};});
 await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:'TRANSIENT'});const failure=structuredClone(history(f)[0]);t.mock.timers.tick(15000);
 const batch=await ledger.prepareBatch(f.a,f.job);assert.equal(batch.identity.data.username,'fixture-user');assert.equal(history(f)[1].status,'done');assert.deepEqual(history(f)[0],failure);assert.equal(f.counts.identity,2);assert.equal(decision(f).failureCount,1);
 transport(f,()=>{throw Object.assign(Error('second terminal transient'),{code:'TRANSIENT'});});await assert.rejects(ledger.prepareBatch(f.a,f.job),{code:'TRANSIENT'});assert.equal(decision(f).failureCount,2);assert.equal(Date.parse(decision(f).retryAt)-Date.now(),60000);assert.deepEqual(history(f)[0],failure);
});
test('A6 project metadata alone cannot prove another authority scope or bypass old unknown',t=>{
 const f=setup(t),row=identity.begin(f.a,f.job);identity.dispatched(f.a,row);const old=hash(row);f.job.projectId='other-business-project';const v=identity.inspect(f.a,f.job);assert.equal(v.decision.action,'reconcile');assert.deepEqual(v.excluded,[]);assert.equal(hash(row),old);
});
test('A9 a made-up or different-job authority binding token cannot reach prepared or transport',t=>{
 const f=setup(t);assert.throws(()=>identity.begin(f.a,f.job,null,{bindingToken:{}}),{code:'ACCESS_POLICY_UNKNOWN'});assert.equal(history(f).length,0);
 const other=setup(t),token=authority.beginPlatformIdentity(other.a,other.job);assert.throws(()=>identity.begin(f.a,f.job,null,{bindingToken:token}),{code:'ACCESS_POLICY_UNKNOWN'});assert.equal(history(f).length,0);
});
test('A2/A9 changed request proof and fabricated v2 done are unresolved, never a new permission',t=>{
 const f=setup(t),row=identity.begin(f.a,f.job);identity.dispatched(f.a,row);row.requestId='unrelated';assert.throws(()=>identity.complete(f.a,row,{username:'fixture-user'}),{code:'IDENTITY_CLAIM_INVALID'});row.status='done';row.finishedAt=new Date().toISOString();assert.equal(decision(f).action,'reconcile');
});
test('A4 bootstrap transient then binding success preserves the linked original failure allowance',async t=>{
 t.mock.timers.enable({apis:['Date']});const f=setup(t,{bound:false});transport(f,()=>{throw Object.assign(Error('bootstrap transient'),{code:'TRANSIENT'});});await assert.rejects(ledger.prepareBatch(f.a,f.job));const before=structuredClone(history(f)[0]);t.mock.timers.tick(15000);transport(f,()=>({username:'fixture-user'}));await ledger.prepareBatch(f.a,f.job);assert.equal(decision(f).action,'execute');assert.equal(decision(f).failureCount,1);assert.deepEqual(history(f)[0],before);
});
test('A6 transient history with a different same-account grant proof is not silently merged into a retry allowance',async t=>{
 const f=setup(t);transport(f,()=>{throw Object.assign(Error('transient'),{code:'TRANSIENT'});});await assert.rejects(ledger.prepareBatch(f.a,f.job));const {request}=authority.describePlatformIdentity(f.a,f.job);authority.revoke(f.a,{...request,operations:[request.operation]},opts);authority.grant(f.a,{...request,operations:[request.operation]},opts);assert.equal(decision(f).reason,'IDENTITY_HISTORY_UNPROVEN');
});
