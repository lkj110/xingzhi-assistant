'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs');
const {hash}=require('../desktop/evidence-basis.cjs'),legacy=require('../desktop/evidence-legacy-preflight.cjs'),method=require('../desktop/evidence-storage-method.cjs'),policy=require('../desktop/access-policy-store.cjs'),journal=require('../desktop/work-journal.cjs');
const clone=structuredClone;
function setup(t){
 const f=fixture(t),{a,job,task}=f;job.platformPrincipal='fixture-user';job.workRevision=task.workRevision=1;
 policy.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'controlled'});
 const query={op:'code',taskId:'123'},target={query,obligationId:'controlled',rootIds:['123']},at=n=>new Date(Date.UTC(2026,9,17,0,0,n)).toISOString();
 const attempt={query:clone(query),obligationId:target.obligationId,rootIds:target.rootIds,status:'failed',at:at(3),finishedAt:at(6),error:'controlled timeout',errorCode:'TRANSIENT'};
 const ep={basis:'controlled-old',taskId:task.id,intentBasis:legacy.scope(job,task).intent,evidenceAcquisition:{requestBasis:'controlled-request',attempts:{[method.attemptKey(target)]:attempt}}};
 job.executionState.continuation={episodes:{[ep.basis]:ep},activeBasis:ep.basis};
 const check=policy.checkTool(a,job,'platform_query',{queries:[query]});
 const step={id:'controlled-step',tool:'platform_query',args:{taskId:task.id,queries:[query]},at:at(1),error:attempt.error,errorCode:'TRANSIENT',evidenceAcquisition:{taskId:task.id,episodeBasis:ep.basis,requestBasis:'controlled-request',targets:[target]}};
 step.dispatch={id:step.id,stepId:step.id,jobId:job.id,taskId:task.id,runId:'controlled-run',tool:step.tool,argsHash:hash(step.args),phase:'dispatch_started',preparedAt:at(2),requests:[{query:{op:'identity'},at:at(4),phase:'dispatch_started'}],failure:{dispatchId:step.id,stepId:step.id,runId:'controlled-run',phase:'dispatch_started',code:'TRANSIENT',message:attempt.error,at:at(5)},scopeHash:hash(legacy.scope(job,task)),policyHash:hash({policyId:check.policyId,grantRevision:check.grantRevision})};
 const run={id:'controlled-run',jobId:job.id,status:'paused',error:attempt.error,startedAt:at(0),finishedAt:at(7),steps:[step]};a.data.agentRuns.push(run);a.save();return {...f,query,target,attempt,ep,step,run};
}
const proof=f=>legacy.buildProof(f.a,f.job,f.task,{runId:f.run.id,stepId:f.step.id,query:f.query,...(f.manifest?{manifest:f.manifest}:{})});
test('controlled strict proof is pure; durable correction is idempotent across episodes and preserves original failure',t=>{
 const f=setup(t),before=clone(f.a.data),p=proof(f);assert.equal(p.eligible,true,p.reason);assert.deepEqual(f.a.data,before);
 const old=clone(f.attempt),budget=clone(f.a.spendLedger);legacy.prepare(f.a,f.job,f.task,p);assert.deepEqual(f.attempt,old);assert.deepEqual(f.a.spendLedger,budget);
 f.job.executionState.continuation.episodes.next=clone(f.ep);f.job.executionState.continuation.activeBasis='next';f.a.save();
 assert.equal(legacy.corrected(f.job,f.job.executionState.continuation.episodes.next.evidenceAcquisition.attempts[method.attemptKey(f.target)],f.task),true);
 legacy.prepare(f.a,f.job,f.task,p);assert.equal(journal.read(f.a).events.filter(e=>e.type===legacy.EVENT).length,1);
});
for(const [name,change,reason] of [
 ['null code stop prose',f=>{f.step.dispatch.failure.code=null;f.step.errorCode=undefined;},'TYPED_PREFLIGHT_FAILURE_MISSING'],
 ['missing run',f=>{f.a.data.agentRuns=[];},'RUN_MISSING_OR_AMBIGUOUS'],
 ['duplicate run',f=>f.a.data.agentRuns.push(clone(f.run)),'RUN_MISSING_OR_AMBIGUOUS'],
 ['missing request log',f=>delete f.step.dispatch.requests,'IDENTITY_ONLY_BOUNDARY_UNPROVEN'],
 ['business boundary',f=>f.step.dispatch.requests.push({query:f.query}),'IDENTITY_ONLY_BOUNDARY_UNPROVEN'],
 ['argument drift',f=>f.step.args.queries[0].taskId='999','DISPATCH_IDENTITY_MISMATCH'],
 ['running run',f=>f.run.status='running','RUN_NOT_TERMINAL'],
 ['source adapter mismatch',f=>f.manifest={},'SOURCE_ADAPTER_MISMATCH'],
 ['missing historical scope',f=>delete f.step.dispatch.scopeHash,'HISTORICAL_SCOPE_POLICY_UNPROVEN'],
 ['unknown claim',f=>f.job.executionState.evidenceMethodAttempts={old:{status:'unknown',query:clone(f.query)}},'CONTRADICTORY_OPERATION_RECEIPT_OR_CLAIM']
])test('controlled rejection: '+name,t=>{const f=setup(t);change(f);assert.equal(proof(f).reason,reason);});
test('append failure leaves no correction and no changed old attempt',t=>{
 const f=setup(t),p=proof(f),before=clone(f.attempt),append=journal.append;t.mock.method(journal,'append',()=>{throw Error('controlled append failure');});
 assert.throws(()=>legacy.prepare(f.a,f.job,f.task,p),/controlled append failure/);assert.deepEqual(f.attempt,before);assert.equal(f.job.executionState.evidencePreflightCorrections,undefined);
});
test('append success and projection/save crash replay only same correction, including a newer pause',t=>{
 const f=setup(t),p=proof(f),save=f.a.save.bind(f.a);t.mock.method(f.a,'save',()=>{throw Error('controlled projection save failure');});
 assert.throws(()=>legacy.prepare(f.a,f.job,f.task,p),/controlled projection save failure/);
 const durable=JSON.parse(require('node:fs').readFileSync(f.a.file));f.a.data=durable;
 const job=f.a.data.delegations.find(j=>j.id===f.job.id),task=f.a.data.tasks.find(t=>t.id===f.task.id);job.executionPaused=true;
 t.mock.restoreAll();f.a.save=save;journal.replay(f.a);
 assert.equal(job.executionPaused,true);assert.equal(Object.keys(job.executionState.evidencePreflightCorrections).length,1);assert.equal(journal.read(f.a).events.filter(e=>e.type===legacy.EVENT).length,1);
});
for(const guard of ['paused','revoked','budget'])test('prepare rechecks '+guard,t=>{
 const f=setup(t),p=proof(f);if(guard==='paused')f.job.executionPaused=true;
 if(guard==='revoked')policy.revoke(f.a,{principalScope:{kind:'account',provider:'platform',subject:f.job.platformPrincipal},resourceScope:{kind:'platform',key:f.job.dataPlatform,jobId:f.job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'controlled'});
 if(guard==='budget')t.mock.method(require('../desktop/spend.cjs'),'check',()=>{throw Object.assign(Error('controlled exhausted budget'),{spendLimit:true});});
 assert.throws(()=>legacy.prepare(f.a,f.job,f.task,p));assert.equal(f.job.executionState.evidencePreflightCorrections,undefined);
});

test('unregistered software cannot accept a workspace or mutable property baseline',t=>{
 const f=setup(t),a=Object.create(f.a);a.evidenceRecoveryBaseline=legacy.BASELINE;a.data.recoveryBaseline=legacy.BASELINE;
 assert.equal(legacy.buildProof(a,f.job,f.task,{runId:f.run.id,stepId:f.step.id,query:f.query}).reason,'SOURCE_ADAPTER_MISMATCH');
 f.step.dispatch.failure.code=null;f.step.errorCode=null;
 assert.deepEqual(legacy.pendingCommands(f.a,f.job,f.task),[]);
});

test('real Assistant registers only the trusted built-in adapter before policy migration',t=>{
 const f=setup(t),execution=require('../desktop/execution-policy.cjs');
 assert.equal(legacy.baselineFor(f.a),legacy.BASELINE);
 f.a.evidenceRecoveryBaseline={};f.a.data.recoveryBaseline={};
 const before=clone(f.a.data),p=execution.inspect(f.a,f.job);
 assert.equal(p.reasonCode,'EVIDENCE_PREFLIGHT_PROVEN');assert.equal(p.commands[0].command,legacy.EVENT);
 assert.deepEqual(f.a.data,before,'policy inspect must not initialize or project state');
 const old=clone(f.attempt),prepared=execution.prepare(f.a,f.job);
 assert.ok(prepared.preparedCommands.includes(legacy.EVENT));assert.deepEqual(f.attempt,old);
 assert.equal(journal.read(f.a).events.filter(e=>e.type===legacy.EVENT).length,1);
 assert.deepEqual(legacy.pendingCommands(f.a,f.job,f.task),[]);
 execution.prepare(f.a,f.job);assert.equal(journal.read(f.a).events.filter(e=>e.type===legacy.EVENT).length,1);
});

for(const paused of ['job','task','workspace'])test('real policy cannot migrate legacy proof through '+paused+' pause',t=>{
 const f=setup(t),execution=require('../desktop/execution-policy.cjs');assert.equal(proof(f).eligible,true);
 if(paused==='job')f.job.executionPaused=true;
 if(paused==='task')f.task.executionPaused=true;
 if(paused==='workspace')f.a.data.stewardship={automaticAllowed:false,reason:'workspace_paused'};
 const old=clone(f.attempt),p=execution.inspect(f.a,f.job);
 assert.ok(!p.commands.some(c=>c.command===legacy.EVENT));
 execution.prepare(f.a,f.job);
 assert.equal(f.job.executionState.evidencePreflightCorrections,undefined);assert.deepEqual(f.attempt,old);
 assert.equal(journal.read(f.a).events.filter(e=>e.type===legacy.EVENT).length,0);
});

for(const historical of ['missing_scope','null_code','unknown_claim','unknown_operation','missing_request_log'])test('real policy never migrates unproven historical row: '+historical,t=>{
 const f=setup(t),execution=require('../desktop/execution-policy.cjs');
 if(historical==='missing_scope')delete f.step.dispatch.scopeHash;
 if(historical==='null_code'){f.step.dispatch.failure.code=null;f.step.errorCode=null;}
 if(historical==='unknown_claim')f.job.executionState.evidenceMethodAttempts={unknown:{status:'unknown',query:clone(f.query)}};
 if(historical==='unknown_operation')f.job.executionState.operations.unknown={id:'controlled-unknown',query:clone(f.query),status:'unknown'};
 if(historical==='missing_request_log')delete f.step.dispatch.requests;
 const old=clone(f.attempt);assert.equal(proof(f).eligible,false);assert.deepEqual(legacy.pendingCommands(f.a,f.job,f.task),[]);
 const p=execution.inspect(f.a,f.job);assert.ok(!p.commands.some(c=>c.command===legacy.EVENT));
 execution.prepare(f.a,f.job);execution.prepare(f.a,f.job);
 assert.equal(f.job.executionState.evidencePreflightCorrections,undefined);assert.deepEqual(f.attempt,old);
 assert.equal(journal.read(f.a).events.filter(e=>e.type===legacy.EVENT).length,0);
});

for(const missing of ['scope','typed_failure'])test('pending command fast rejection avoids full operation-history scan: '+missing,t=>{
 const f=setup(t);if(missing==='scope')delete f.step.dispatch.scopeHash;else f.step.dispatch.failure.code=null;
 const operations=f.job.executionState.operations;
 Object.defineProperty(f.job.executionState,'operations',{configurable:true,get(){throw Error('must not scan operation history for rejected preflight');}});
 try{for(let i=0;i<3;i++)assert.deepEqual(legacy.pendingCommands(f.a,f.job,f.task),[]);}
 finally{Object.defineProperty(f.job.executionState,'operations',{configurable:true,enumerable:true,writable:true,value:operations});}
});
