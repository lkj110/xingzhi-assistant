'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {hash}=require('../desktop/evidence-basis.cjs');
const recovery=require('../desktop/model-preflight-recovery.cjs'),journal=require('../desktop/work-journal.cjs'),transitions=require('../desktop/state-transitions.cjs');
const health=require('../desktop/subscription-health.cjs');
const clone=v=>structuredClone(v);
const message='无法确认 Codex 登录状态，请在模型设置中重新检测。';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-recovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const job={id:'job',taskIds:['task'],workRevision:1,status:'blocked',executionState:{continuation:{episodes:{original:{taskId:'task',cycles:2,hops:3}}}},lastErrorAutomaticRetry:false,lastErrorCode:'MODEL_AUTH',lastError:message};
 const call={id:'call',at:'2026-10-18T10:01:00Z',jobId:'job',taskId:'task',runId:'run',taskRunId:'taskrun',requestId:'request',attempt:1,spendTicketId:'ticket',spendScope:'job:job',providerId:'provider',providerType:'codex',model:'model',role:'execute',stage:'task_work',status:'error',errorCode:'MODEL_AUTH',errorMessage:message,usageReported:false,estimatedUSD:null,reservedUSD:1.72002};
 const snap=clone(call);for(const k of ['jobId','taskRunId','reservedUSD'])delete snap[k];
 const step={id:'step-dispatch',tool:'advance_task',args:{taskId:'task'},error:message,errorCode:'MODEL_AUTH'};
 const run={id:'run',jobId:'job',startedAt:'2026-10-18T10:00:00Z',finishedAt:'2026-10-18T10:02:00Z',status:'blocked',steps:[step],modelCalls:1,modelCallsDetail:[clone(snap)],usage:{inputTokens:0,outputTokens:0,totalTokens:0,estimatedUSD:0,reportedCalls:0,unknownCalls:1}};
 const taskRun={id:'taskrun',startedAt:'2026-10-18T10:00:30Z',finishedAt:'2026-10-18T10:01:59Z',status:'blocked',modelCallsDetail:[clone(snap)],usage:clone(run.usage)};
 const request={requestId:'request',attempt:1,runId:'run',callId:'call',spendTicketId:'ticket',status:'unknown',usageReported:false,errorCode:'MODEL_AUTH',responseStatus:'error',at:'2026-10-18T10:00:59Z',finishedAt:'2026-10-18T10:01:58Z'};
 const p={version:1,jobId:'job',taskId:'task',attemptId:'consumption',status:'unknown',runId:'run',intent:'intent',scope:'scope',baseArtifactId:'draft',baseHash:'base',primaryLineageId:'draft',stepId:'draft-step',targetFacts:[{factKey:'one',bindingVersion:'binding'}],additionalFacts:[],originalInputBasis:{hash:'input'},originalGenerationSnapshot:{id:'snapshot'},requests:[request],errorCode:'MODEL_AUTH',error:message};
 const task={id:'task',agentJobId:'job',status:'blocked',workRevision:1,progressRuns:[taskRun],evidenceConsumption:{version:1,activeAttemptId:p.attemptId,attempts:{[p.attemptId]:p},receipts:[]}};
 const a={dir,file:path.join(dir,'workspace.json'),data:{tasks:[task],delegations:[job],agentRuns:[run],modelCalls:[call],runtime:{},decisions:[],agentActions:[],sources:[],artifacts:[],providers:[],settings:{}},save(){fs.writeFileSync(this.file,JSON.stringify(this.data));},dispatch(action,input){assert.equal(action,'agentModelPreflightAttest');return recovery.attest(this,job,input);}};
 a.data.spendMeter={scopes:{'job:job':{limitUSD:200,spentUSD:170.97393881,heldUSD:5.02577550,usage:{unknownCalls:3,unpricedCalls:0},unreservedCalls:0}}};
 return {a,job,task,p,request,call,run,taskRun,step};
}
function attest(f,input={}){
 const c=recovery.candidate(f.a,f.job,f.task,{allowUnattested:true});assert.equal(c.eligible,true,c.reason);
 return require('../desktop/workspace-view.cjs').command(f.a,{action:'agentModelPreflightAttest',input:{id:f.job.id,taskId:f.task.id,attemptId:f.p.attemptId,evidenceHash:c.evidenceHash,registryId:recovery.REGISTRY.id,executedBy:'supervisor',authorizationNote:'按既有授权恢复原工作',expectedWorkRevision:1,expectedTaskRevision:1,...input}});
}
function guards(t,f){
 t.mock.method(require('../desktop/execution-gate.cjs'),'assert',()=>true);
 t.mock.method(require('../desktop/evidence-consumption.cjs'),'current',()=>true);
 t.mock.method(require('../desktop/continuation-control.cjs'),'allowed',()=>true);
 t.mock.method(require('../desktop/pending-check.cjs'),'inspect',()=>({eligible:false}));
 t.mock.method(require('../desktop/protocol-access.cjs'),'assertTool',()=>true);
 t.mock.method(require('../desktop/projects.cjs'),'relatedActions',()=>[]);
 t.mock.method(require('../desktop/execution-facts.cjs'),'modelGuard',()=>null);
 const start=Date.now()-1000,r={version:1,checkId:'healthy',status:'success',sequence:1,cliHash:'cli',configurationHash:'config',intentHash:'intent',startedAt:new Date(start).toISOString(),finishedAt:new Date(start+500).toISOString(),expiresAt:new Date(start+health.TTL_MS).toISOString(),installed:true,loggedIn:true};
 journal.commit(f.a,[{type:'subscription_health_pending_v1',entityKind:'task',entityId:f.task.id,workRevision:1,actor:'user',payload:{health:{...r,status:'pending'}}}]);f.a.data.runtime.subscriptionHealth=r;
 t.mock.method(health,'valid',()=>({valid:true}));
}
function prepared(t){const f=fixture(t);attest(f);guards(t,f);const g=recovery.prepare(f.a,f.job,f.task);assert.ok(g);return {...f,g};}
function start(f){f.a.activeAgentJob=f.job;f.a.activeSpendTask=f.task;f.a.activeAgentRun={id:'new-run'};f.p.status='generating';f.p.runId='new-run';return {requestId:'new-request',attempt:1,spendTicket:{id:'new-ticket'},role:'execute',stage:'task_work'};}
function claim(f,meta=start(f)){const r={requestId:meta.requestId,attempt:meta.attempt,runId:f.p.runId,spendTicketId:meta.spendTicket.id,status:'possible_dispatch',producerSchema:2};transitions.commit(f.a,()=>{f.p.requests.push(r);recovery.claim(f.a,meta,r);});return {r,meta};}
function native(f){const diagnostic={source:'codex_cli',kind:'model_preflight',phase:'preflight',stage:'login_status',modelDispatched:false,producerSchema:2};f.request.producerSchema=2;f.request.status='observed';f.request.usageReported=true;f.p.status='failed';for(const c of [f.call,f.run.modelCallsDetail[0],f.taskRun.modelCallsDetail[0]])Object.assign(c,{diagnostic:clone(diagnostic),usageReported:true,inputTokens:0,outputTokens:0,estimatedUSD:0});f.step.errorDiagnostic=clone(diagnostic);}

test('schema1 + fixed text alone cannot classify without trusted per-attempt attestation',t=>{
 const f=fixture(t),before=clone(f.a.data);assert.equal(recovery.candidate(f.a,f.job,f.task).reason,'MODEL_PREFLIGHT_ATTESTATION_REQUIRED');
 assert.equal(recovery.view(f.a,f.job).attested,false);assert.deepEqual(f.a.data,before);
 assert.throws(()=>recovery.attest(f.a,f.job,{}),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 attest(f);assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,true);
 assert.deepEqual(f.a.data.spendMeter,before.spendMeter);assert.deepEqual(f.p.requests,before.tasks[0].evidenceConsumption.attempts.consumption.requests);
 const count=journal.read(f.a).events.length;attest(f);assert.equal(journal.read(f.a).events.length,count);
});
test('fixed attestation command rejects arbitrary JSON and wrong UI scope',t=>{
 const f=fixture(t);
 for(const input of [{registryId:'arbitrary'},{attemptId:'other'},{evidenceHash:'wrong'},{manifestHash:recovery.REGISTRY.manifestHash},{executedBy:'model'},{authorizationNote:''},{expectedTaskRevision:2},{taskId:'other'}])assert.throws(()=>attest(f,input));
 assert.equal(journal.read(f.a).events.length,0);
});
const negative={
 'wrong request tuple':f=>f.request.spendTicketId='other',
 'wrong call run':f=>f.call.runId='other',
 'wrong call job':f=>f.call.jobId='other',
 'wrong call task':f=>f.call.taskId='other',
 'wrong transport attempt':f=>f.call.attempt=2,
 'wrong spend scope':f=>f.call.spendScope='task:task',
 'missing ticket':f=>delete f.call.spendTicketId,
 'missing raw call':f=>f.a.data.modelCalls=[],
 'missing run copy':f=>f.run.modelCallsDetail=[],
 'missing step':f=>f.run.steps=[],
 'duplicate call':f=>f.a.data.modelCalls.push(clone(f.call)),
 'duplicate run':f=>f.a.data.agentRuns.push(clone(f.run)),
 'duplicate step':f=>f.run.steps.push(clone(f.step)),
 'duplicate taskrun':f=>f.task.progressRuns.push(clone(f.taskRun)),
 'taskrun missing for declared identity':f=>f.task.progressRuns=[],
 'taskrun copy mismatch':f=>f.taskRun.modelCallsDetail[0].errorMessage='other',
 'foreign run copy':f=>f.a.data.agentRuns.push({id:'foreign',modelCallsDetail:[clone(f.run.modelCallsDetail[0])]}),
 'run copy missing identity':f=>delete f.run.modelCallsDetail[0].requestId,
 'raw postexec fixed text':f=>f.call.diagnostic={source:'codex_cli',kind:'turn_failed'},
 'runcopy postexec fixed text':f=>f.run.modelCallsDetail[0].diagnostic={kind:'turn_failed'},
 'taskcopy postexec fixed text':f=>f.taskRun.modelCallsDetail[0].diagnostic={kind:'turn_failed'},
 'step postexec fixed text':f=>f.step.errorDiagnostic={kind:'turn_failed'},
 'run postexec diagnostic':f=>f.run.diagnostic={kind:'turn_failed'},
 'request postexec marker':f=>f.request.modelDispatched=true,
 'new producer missing typed proof':f=>f.request.producerSchema=2,
 'unknown producer':f=>f.request.producerSchema=3,
 'mixed producer copy':f=>f.taskRun.modelCallsDetail[0].producerSchema=2,
 'explicit null diagnostic':f=>f.call.diagnostic=null,
 'reported tokens':f=>f.call.inputTokens=1,
 'even zero tokens on legacy call':f=>f.call.inputTokens=0,
 'reported actual usage':f=>f.call.usageReported=true,
 'actual aggregate usage':f=>f.run.usage.inputTokens=1,
 'candidate':f=>f.p.candidate={content:'generated'},
 'step result':f=>f.step.result={content:'generated'},
 'call result':f=>f.call.result={content:'generated'},
 'receipt':f=>f.task.evidenceConsumption.receipts.push({attemptId:f.p.attemptId}),
 'additional unresolved request':f=>f.p.requests.push({...f.request,requestId:'another'}),
 'nonexact fixed text':f=>{f.call.errorMessage+=' ';f.run.modelCallsDetail[0].errorMessage+=' ';f.taskRun.modelCallsDetail[0].errorMessage+=' ';f.step.error+=' ';},
};
for(const [name,change] of Object.entries(negative))test('strict rejection: '+name,t=>{const f=fixture(t);change(f);assert.equal(recovery.candidate(f.a,f.job,f.task,{allowUnattested:true}).eligible,false);});
test('producer2 native zero diagnostic proof needs no legacy attestation; all copies still required',t=>{
 const f=fixture(t);native(f);assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,true);delete f.step.errorDiagnostic;assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,false);
});
test('new producer missing typed proof never falls back even with valid legacy attestation',t=>{const f=fixture(t);attest(f);f.request.producerSchema=2;assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,false);});
test('forged direct attestation JSON, changed evidence or manifest never accepted',t=>{
 const f=fixture(t);const c=recovery.candidate(f.a,f.job,f.task,{allowUnattested:true});f.p.modelPreflightAttestation={version:1,attemptId:f.p.attemptId,evidenceHash:c.evidenceHash,registry:clone(recovery.REGISTRY),executedBy:'supervisor',authorizationNote:'x'};assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,false);
 delete f.p.modelPreflightAttestation;attest(f);f.call.reservedUSD=0;assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,false);f.call.reservedUSD=1.72002;f.p.modelPreflightAttestation.registry.manifestHash='wrong';assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,false);
});
test('prepare and replay preserve old unknown, reserve, budgets, cycles/hops and attempt scope',t=>{
 const f=fixture(t);attest(f);guards(t,f);const before=clone(f.a.data),old=clone(f.p);const g=recovery.prepare(f.a,f.job,f.task);assert.equal(g.status,'prepared');assert.equal(f.p.status,'prepared');
 for(const key of ['requests','scope','targetFacts','additionalFacts','originalInputBasis','originalGenerationSnapshot','error','errorCode','runId'])assert.deepEqual(f.p[key],old[key]);
 assert.deepEqual(f.a.data.spendMeter,before.spendMeter);assert.deepEqual(f.job.executionState,before.delegations[0].executionState);assert.equal(f.job.lastErrorAutomaticRetry,false);
 assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);assert.equal(recovery.prepare(f.a,f.job,f.task).id,g.id);journal.replay(f.a,{force:true});assert.equal(f.p.modelPreflightRecovery.status,'prepared');
 const {r}=claim(f);journal.replay(f.a,{force:true});assert.equal(f.p.modelPreflightRecovery.status,'claimed');assert.equal(f.p.status,'generating');assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,r),false);
});
test('latest health failure/change blocks prepare and prepared claim; never original result after claim',t=>{
 const f=fixture(t);attest(f);guards(t,f);health.valid.mock.mockImplementation(()=>null);assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,false);assert.throws(()=>recovery.prepare(f.a,f.job,f.task),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});
 health.valid.mock.mockImplementation(()=>({valid:true}));recovery.prepare(f.a,f.job,f.task);const meta=start(f);f.a.data.runtime.subscriptionHealth.cliHash='changed';assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_HEALTH_CHANGED'});
 f.a.data.runtime.subscriptionHealth.cliHash='cli';const {r}=claim(f,meta);health.valid.mock.mockImplementation(()=>null);
 assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);
 Object.assign(r,{status:'observed',usageReported:true,callId:'new-call',responseStatus:'done'});f.a.data.modelCalls.unshift({id:'new-call',requestId:r.requestId,attempt:1,runId:r.runId,spendTicketId:r.spendTicketId,jobId:'job',taskId:'task',status:'done'});
 recovery.afterModel(f.a,meta);assert.equal(f.p.modelPreflightRecovery.status,'terminal');assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);
 f.task.evidenceConsumption.receipts.push({attemptId:f.p.attemptId});assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);
 assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,r),false);
});
test('claimed failure, restart and idempotent replay cannot dispatch a second recovery',t=>{
 const f=prepared(t),{meta,r}=claim(f);Object.assign(r,{status:'unknown',usageReported:false,callId:'new-call',responseStatus:'error',errorCode:'MODEL_AUTH'});f.a.data.modelCalls.unshift({id:'new-call',requestId:r.requestId,attempt:1,runId:r.runId,spendTicketId:r.spendTicketId,jobId:'job',taskId:'task',status:'error'});recovery.afterModel(f.a,meta,{code:'MODEL_AUTH'});f.p.status='unknown';
 assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,r),false);assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,false);assert.equal(recovery.prepare(f.a,f.job,f.task).status,'terminal');
 journal.replay(f.a,{force:true});assert.equal(f.p.modelPreflightRecovery.status,'terminal');assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});
 const cold=clone(f.a.data);f.a.data=cold;journal.replay(f.a,{force:true});const p=cold.tasks[0].evidenceConsumption.attempts.consumption;assert.equal(p.modelPreflightRecovery.status,'terminal');assert.equal(p.requests.length,2);
});
test('save failure at append+claim restores both, no dispatch; committed prepare only replays once',t=>{
 const f=prepared(t),meta=start(f),oldSave=f.a.save;let dispatches=0;f.a.save=()=>{throw Object.assign(Error('full'),{code:'ENOSPC'});};
 assert.throws(()=>{claim(f,meta);dispatches++;},{code:'ENOSPC'});assert.equal(dispatches,0);assert.equal(f.p.requests.length,1);assert.equal(f.p.modelPreflightRecovery.status,'prepared');f.a.save=oldSave;
 claim(f,meta);journal.replay(f.a,{force:true});assert.equal(f.p.requests.length,2);assert.equal(f.p.modelPreflightRecovery.status,'claimed');
});
test('prepare save failure leaves durable event pending and cannot dispatch until replay',t=>{
 const f=fixture(t);attest(f);guards(t,f);const oldSave=f.a.save;f.a.save=()=>{throw Error('ENOSPC');};assert.throws(()=>recovery.prepare(f.a,f.job,f.task));assert.ok(f.a.data.runtime.projectionPending);
 const meta=start(f);assert.throws(()=>recovery.assertBeforeModel(f.a,meta));f.a.save=oldSave;journal.replay(f.a);assert.equal(journal.read(f.a).events.filter(e=>e.type===recovery.TYPE).length,1);
});
test('fresh guards reject changed current input/ACL, budget, pending check or gate before prepare',t=>{
 const f=fixture(t);attest(f);guards(t,f);
 const c=require('../desktop/evidence-consumption.cjs');c.current.mock.mockImplementation(()=>false);assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'EVIDENCE_CONSUMPTION_STALE');c.current.mock.mockImplementation(()=>true);
 f.a.data.spendMeter.scopes['job:job'].limitUSD=175;assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,false);f.a.data.spendMeter.scopes['job:job'].limitUSD=200;
 f.job.executionState.continuation.episodes.original.pendingCheck={status:'pending'};assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'CHECK_REQUEST_UNRESOLVED');delete f.job.executionState.continuation.episodes.original.pendingCheck;
 require('../desktop/protocol-access.cjs').assertTool.mock.mockImplementation(()=>{throw Object.assign(Error('no'),{code:'CONTEXT_SCOPE_DENIED'});});assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'CONTEXT_SCOPE_DENIED');
});
for(const [name,change] of Object.entries({
 'attempt error differs':f=>f.p.error='other',
 'step request differs':f=>f.step.requestId='other',
 'step ticket differs':f=>f.step.spendTicketId='other',
 'typed request diagnostic conflicts':f=>{native(f);f.request.diagnostic={...f.call.diagnostic,stage:'setup'};},
 'typed run diagnostic conflicts':f=>{native(f);f.run.diagnostic={...f.call.diagnostic,stage:'setup'};},
 'typed taskrun diagnostic conflicts':f=>{native(f);f.taskRun.errorDiagnostic={...f.call.diagnostic,stage:'setup'};},
 'typed forged postexec field':f=>{native(f);for(const c of [f.call,f.run.modelCallsDetail[0],f.taskRun.modelCallsDetail[0]])c.diagnostic.execEntered=true;f.step.errorDiagnostic.execEntered=true;},
 'typed bad diagnostic schema':f=>{native(f);for(const c of [f.call,f.run.modelCallsDetail[0],f.taskRun.modelCallsDetail[0]])c.diagnostic.producerSchema=1;f.step.errorDiagnostic.producerSchema=1;},
}))test('additional strict negative: '+name,t=>{const f=fixture(t);change(f);assert.equal(recovery.candidate(f.a,f.job,f.task,{allowUnattested:true}).eligible,false);});

function realHealth(t,f){
 const subscription=require('../desktop/subscription.cjs');
 t.mock.method(subscription,'identity',()=>({cliHash:'cli-file-metadata',configurationHash:'local-public-config'}));
 t.mock.method(subscription,'status',async()=>({installed:true,loggedIn:true}));
 f.a.dispatch=function(action,input){if(action==='subscriptionStatus')return health.check(this);return recovery.attest(this,f.job,input);};
 return ()=>require('../desktop/workspace-view.cjs').command(f.a,{action:'subscriptionStatus',input:{}});
}
test('real App health receipt admits prepare and same-commit claim with immutable intent; expiry permits exact result only',async t=>{
 const f=fixture(t);attest(f);guards(t,f);health.valid.mock.restore();delete f.a.data.runtime.subscriptionHealth;
 const check=realHealth(t,f);assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,false);await check();assert.ok(health.valid(f.a,{after:f.run.finishedAt}));
 const identity=health.identity(f.a);recovery.prepare(f.a,f.job,f.task);assert.deepEqual(health.identity(f.a),identity);
 const {meta,r}=claim(f);const expiry=Date.parse(health.receipt(f.a).expiresAt);t.mock.method(Date,'now',()=>expiry+1);assert.equal(health.valid(f.a,{after:f.run.finishedAt}),null);
 assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,r),false);
 Object.assign(r,{status:'observed',usageReported:true,callId:'new-call',responseStatus:'done'});f.a.data.modelCalls.unshift({id:'new-call',requestId:r.requestId,attempt:1,runId:r.runId,spendTicketId:r.spendTicketId,jobId:'job',taskId:'task',status:'done'});
 recovery.afterModel(f.a,meta);assert.equal(f.p.modelPreflightRecovery.status,'terminal');
});
test('real health newer pending/failed and CLI identity changes block an unclaimed prepared grant',async t=>{
 const f=fixture(t);attest(f);guards(t,f);health.valid.mock.restore();delete f.a.data.runtime.subscriptionHealth;const check=realHealth(t,f);await check();recovery.prepare(f.a,f.job,f.task);const meta=start(f);
 const subscription=require('../desktop/subscription.cjs');subscription.identity.mock.mockImplementation(()=>({cliHash:'changed',configurationHash:'local-public-config'}));assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});
 subscription.identity.mock.mockImplementation(()=>({cliHash:'cli-file-metadata',configurationHash:'local-public-config'}));let resolve;subscription.status.mock.mockImplementation(()=>new Promise(r=>{resolve=r;}));const checking=check();assert.equal(health.receipt(f.a).status,'pending');assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});resolve({installed:true,loggedIn:false});await checking;assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});
});
test('reviewed r7 dispatch failure shape remains prepared without claiming model dispatch',t=>{
 const f=fixture(t),d={id:f.step.id,stepId:f.step.id,runId:f.run.id,jobId:f.job.id,taskId:f.task.id,tool:'advance_task',argsHash:hash(f.step.args),requestSchema:2,requests:[],phase:'prepared'};
 d.failure={dispatchId:d.id,runId:d.runId,stepId:d.stepId,phase:'prepared',requestId:null,code:'MODEL_AUTH',stopped:false,message};f.step.dispatch=d;
 assert.equal(recovery.candidate(f.a,f.job,f.task,{allowUnattested:true}).eligible,true);
 d.failure.phase='dispatch_started';assert.equal(recovery.candidate(f.a,f.job,f.task,{allowUnattested:true}).eligible,false);
});
test('prepared inspect offers only exact original error resume and preserves job error',t=>{
 const f=prepared(t),before=clone(f.job),v=recovery.inspect(f.a,f.job,f.task);assert.equal(v.eligible,true);assert.equal(v.command,undefined);assert.equal(v.route,'consume');assert.equal(recovery.resumeAction(f.a,f.job,f.task).tool,'advance_task');assert.deepEqual(f.job,before);
 f.job.lastErrorCode='MODEL_BLOCKED';assert.equal(recovery.resumeAction(f.a,f.job,f.task),null);f.job.lastErrorCode='MODEL_AUTH';f.job.lastError='other';assert.equal(recovery.resumeAction(f.a,f.job,f.task),null);
});
for(const code of ['MODEL_PREFLIGHT_HEALTH_REQUIRED','MODEL_PREFLIGHT_HEALTH_CHANGED'])test('current '+code+' reaches policy and visible state without rewriting the original failure',t=>{
 const f=prepared(t),before=clone(f.a.data),policy=require('../desktop/execution-policy.cjs');
 if(code==='MODEL_PREFLIGHT_HEALTH_REQUIRED')health.valid.mock.mockImplementation(()=>null);
 else f.a.data.runtime.subscriptionHealth.configurationHash='different';
 const stateBefore=clone(f.a.data),p=policy.inspect(f.a,f.job,{mode:'manual'});
 assert.equal(p.reasonCode,code);assert.equal(p.eligible,false);assert.deepEqual(p.commands,[]);
 const state=require('../desktop/work-state.cjs').view(f.a,f.job);assert.equal(state.error.code,code);assert.equal(state.error.message,p.reason);assert.deepEqual(f.a.data,stateBefore);assert.equal(f.job.lastError,before.delegations[0].lastError);
});
test('unattested or unrelated failure never becomes a health diagnostic',t=>{
 const f=fixture(t);guards(t,f);health.valid.mock.mockImplementation(()=>null);const policy=require('../desktop/execution-policy.cjs');
 assert.equal(policy.inspect(f.a,f.job).reasonCode,'MODEL_AUTH');attest(f);f.job.lastErrorCode='MODEL_BLOCKED';f.job.lastError='unrelated failure';
 assert.equal(policy.inspect(f.a,f.job).reasonCode,'MODEL_BLOCKED');
});
test('health-blocked recovery does not hide another eligible recovery or stronger workspace gate',t=>{
 const f=prepared(t),policy=require('../desktop/execution-policy.cjs'),second={...clone(f.task),id:'second'};f.a.data.tasks.push(second);f.job.taskIds.push(second.id);
 t.mock.method(recovery,'inspect',(_a,_j,t)=>t.id==='task'?{eligible:false,phase:'blocked',reason:'MODEL_PREFLIGHT_HEALTH_REQUIRED',proof:{}}:{eligible:true,action:{tool:'advance_task',args:{taskId:t.id}}});
 assert.equal(policy.inspect(f.a,f.job).action.args.taskId,'second');f.a.data.stewardship={paused:true};assert.equal(policy.inspect(f.a,f.job).reasonCode,'workspace_paused');
 f.a.data.stewardship.paused=false;require('../desktop/execution-facts.cjs').modelGuard.mock.mockImplementation(()=>({code:'permission',message:'revoked'}));assert.equal(policy.inspect(f.a,f.job).reasonCode,'permission');
});
test('manual admission denial records current reason with no new run or model call',async t=>{
 const f=prepared(t),agent=require('../desktop/agent.cjs');health.valid.mock.mockImplementation(()=>null);
 const events=[];f.a.event=(title,detail,taskId,kind)=>events.push({title,detail,taskId,kind});
 const oldRuns=clone(f.a.data.agentRuns),oldCalls=clone(f.a.data.modelCalls),oldBudget=clone(f.a.data.spendMeter),oldJob=clone(f.job);
 await agent.run(f.a,f.job.id,{userRequested:true});assert.equal(events.length,1);assert.equal(events[0].title,'本次推进未启动');assert.match(events[0].detail,/MODEL_PREFLIGHT_HEALTH_REQUIRED/);
 assert.deepEqual(f.a.data.agentRuns,oldRuns);assert.deepEqual(f.a.data.modelCalls,oldCalls);assert.deepEqual(f.a.data.spendMeter,oldBudget);assert.deepEqual(f.job,oldJob);
});
test('a later batch retains only the historic attempt exact old-request exemption',t=>{
 const f=prepared(t),{meta,r}=claim(f);Object.assign(r,{status:'observed',usageReported:true,callId:'new-call',responseStatus:'done'});f.a.data.modelCalls.unshift({id:'new-call',requestId:r.requestId,attempt:1,runId:r.runId,spendTicketId:r.spendTicketId,jobId:'job',taskId:'task',status:'done'});recovery.afterModel(f.a,meta);f.p.status='committed';
 const next={...clone(f.p),attemptId:'next-batch',requests:[clone(f.request)],status:'unknown'};delete next.modelPreflightRecovery;delete next.modelPreflightAttestation;f.task.evidenceConsumption.attempts[next.attemptId]=next;f.task.evidenceConsumption.activeAttemptId=next.attemptId;
 assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);assert.equal(recovery.resolvedRequest(f.a,f.task,next,next.requests[0]),false);assert.equal(recovery.resolvedRequest(f.a,f.task,clone(f.p),f.request),false);assert.equal(recovery.grant(f.a,f.job,f.task),null);journal.replay(f.a,{force:true});assert.equal(f.task.evidenceConsumption.activeAttemptId,next.attemptId);assert.equal(f.p.modelPreflightRecovery.status,'terminal');assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);
});
test('journal append failure does not prepare or dispatch; result save failure never unclaims',t=>{
 const f=fixture(t);attest(f);guards(t,f);const oldAppend=journal.append;const mock=t.mock.method(journal,'append',()=>{throw Error('ENOSPC');});assert.throws(()=>recovery.prepare(f.a,f.job,f.task));assert.equal(f.p.status,'unknown');assert.equal(f.p.modelPreflightRecovery,undefined);mock.mock.restore();assert.equal(journal.append,oldAppend);
 recovery.prepare(f.a,f.job,f.task);const {meta,r}=claim(f);Object.assign(r,{status:'observed',usageReported:true,callId:'new-call',responseStatus:'done'});f.a.data.modelCalls.unshift({id:'new-call',requestId:r.requestId,attempt:1,runId:r.runId,spendTicketId:r.spendTicketId,jobId:'job',taskId:'task',status:'done'});
 const oldSave=f.a.save;f.a.save=()=>{throw Error('ENOSPC');};assert.throws(()=>recovery.afterModel(f.a,meta));assert.equal(f.p.modelPreflightRecovery.status,'claimed');assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});f.a.save=oldSave;recovery.afterModel(f.a,meta);assert.equal(f.p.modelPreflightRecovery.status,'terminal');
});
test('ambiguous committed claim save may never dispatch or open another claim',t=>{
 const f=prepared(t),meta=start(f);let dispatch=0;f.a.save=()=>{fs.writeFileSync(f.a.file,JSON.stringify(f.a.data));throw Object.assign(Error('directory sync failed'),{committed:true});};assert.throws(()=>{claim(f,meta);dispatch++;});assert.equal(dispatch,0);assert.equal(f.p.modelPreflightRecovery.status,'claimed');assert.equal(f.p.requests.length,2);assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});
});

for(const cause of ['ENOSPC','EACCES','ENOENT','ETIMEDOUT'])test('shared local preflight schema restores '+cause+' through health and one claim',async t=>{
 const f=fixture(t);native(f);guards(t,f);health.valid.mock.restore();delete f.a.data.runtime.subscriptionHealth;
 const errors=require('../desktop/model-errors.cjs'),error=errors.preflightError(Object.assign(Error('local preparation'),{code:cause}),'setup'),diagnostic=errors.diagnostic(error);
 assert.equal(errors.isPreflightDiagnostic(diagnostic),true);assert.equal(diagnostic.underlyingCode,cause);
 Object.assign(f.p,{errorCode:error.code,error:error.message});Object.assign(f.job,{lastErrorCode:error.code,lastError:error.message});f.request.errorCode=error.code;
 for(const c of [f.call,f.run.modelCallsDetail[0],f.taskRun.modelCallsDetail[0]])Object.assign(c,{errorCode:error.code,errorMessage:error.message,diagnostic:clone(diagnostic)});
 Object.assign(f.step,{errorCode:error.code,error:error.message,errorDiagnostic:clone(diagnostic)});
 const original=clone(f.p.requests),budget=clone(f.a.data.spendMeter);assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,true);
 await realHealth(t,f)();recovery.prepare(f.a,f.job,f.task);const {meta}=claim(f);
 assert.equal(f.p.modelPreflightRecovery.status,'claimed');assert.deepEqual(f.p.requests[0],original[0]);assert.deepEqual(f.a.data.spendMeter,budget);assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});
});
test('shared preflight schema rejects unsafe cause, extra field and post-exec marker',t=>{
 const errors=require('../desktop/model-errors.cjs'),d=errors.diagnostic(errors.preflightError(Object.assign(Error(),{code:'ENOSPC'}),'setup'));
 for(const invalid of [{...d,underlyingCode:'UNREVIEWED'},{...d,execEntered:true},{...d,modelDispatched:true},{...d,producerSchema:3}]){
  assert.equal(errors.isPreflightDiagnostic(invalid),false);assert.deepEqual(errors.diagnostic({diagnostic:invalid}),{source:'codex_cli'});
  const f=fixture(t);native(f);for(const c of [f.call,f.run.modelCallsDetail[0],f.taskRun.modelCallsDetail[0]])c.diagnostic=clone(invalid);f.step.errorDiagnostic=clone(invalid);assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,false);
 }
});
function completedThenFailedBatch(t){
 const f=prepared(t),{meta,r}=claim(f);Object.assign(r,{status:'observed',usageReported:true,callId:'new-call',responseStatus:'done'});
 f.a.data.modelCalls.unshift({id:'new-call',requestId:r.requestId,attempt:1,runId:r.runId,spendTicketId:r.spendTicketId,jobId:'job',taskId:'task',status:'done'});
 recovery.afterModel(f.a,meta);f.p.status='committed';f.a.save();f.a.data=JSON.parse(fs.readFileSync(f.a.file));journal.replay(f.a,{force:true});
 f.job=f.a.data.delegations[0];f.task=f.a.data.tasks[0];f.p=f.task.evidenceConsumption.attempts.consumption;f.request=f.p.requests[0];
 const second=fixture(t);native(second);const names={consumption:'consumption-B',run:'run-B',taskrun:'taskrun-B',request:'request-B',call:'call-B',ticket:'ticket-B','step-dispatch':'step-dispatch-B'};
 const rename=v=>Array.isArray(v)?v.map(rename):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[names[k]||k,rename(x)])):typeof v==='string'?(names[v]||v):v;
 const p=rename(second.p);f.task.evidenceConsumption.attempts[p.attemptId]=p;f.task.evidenceConsumption.activeAttemptId=p.attemptId;f.a.data.agentRuns.push(rename(second.run));f.task.progressRuns.push(rename(second.taskRun));f.a.data.modelCalls.push(rename(second.call));
 f.a.activeAgentJob=null;f.a.activeAgentRun=null;f.a.activeSpendTask=null;return {...f,next:p};
}
test('cold completed A exact resolution permits B independent preflight recovery once',async t=>{
 const f=completedThenFailedBatch(t),old=clone(f.p),budget=clone(f.a.data.spendMeter);health.valid.mock.restore();delete f.a.data.runtime.subscriptionHealth;await realHealth(t,f)();
 assert.equal(recovery.resolvedRequest(f.a,f.task,f.p,f.request),true);assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,true);
 const g=recovery.prepare(f.a,f.job,f.task);assert.notEqual(g.id,f.p.modelPreflightRecovery.id);
 const b={...f,p:f.next},nextMeta=start(b);nextMeta.requestId='B-recovery-request';nextMeta.spendTicket.id='B-recovery-ticket';f.a.activeAgentRun.id='B-recovery-run';f.next.runId='B-recovery-run';const {meta}=claim(b,nextMeta);assert.equal(f.next.modelPreflightRecovery.status,'claimed');assert.throws(()=>recovery.assertBeforeModel(f.a,meta),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});
 assert.deepEqual(f.p,old);assert.deepEqual(f.a.data.spendMeter,budget);
});
for(const [name,change] of Object.entries({
 'changed proof':f=>f.p.modelPreflightRecovery.proof.call.errorMessage='changed',
 'extra unknown':f=>f.p.requests.push({requestId:'unresolved',status:'unknown'}),
 'wrong tuple':f=>f.p.requests[0].spendTicketId='wrong'
}))test('B cannot bypass unresolved A: '+name,t=>{
 const f=completedThenFailedBatch(t);change(f);assert.equal(recovery.candidate(f.a,f.job,f.task).eligible,true);assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'EVIDENCE_GENERATION_UNRESOLVED');assert.equal(f.next.modelPreflightRecovery,undefined);
});

test('prepared expiry and failed refresh recover through same-identity latest health and one cold claim',async t=>{
 const f=fixture(t);attest(f);guards(t,f);health.valid.mock.restore();delete f.a.data.runtime.subscriptionHealth;
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const check=realHealth(t,f);await check();const g=recovery.prepare(f.a,f.job,f.task),initial=clone(g.health),budget=clone(f.a.data.spendMeter);
 t.mock.timers.tick(health.TTL_MS+1);assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'MODEL_PREFLIGHT_HEALTH_REQUIRED');
 const sub=require('../desktop/subscription.cjs');sub.status.mock.mockImplementation(async()=>({installed:true,loggedIn:false}));await check();assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,false);
 sub.status.mock.mockImplementation(async()=>({installed:true,loggedIn:true}));await check();assert.equal(recovery.inspect(f.a,f.job,f.task).eligible,true);assert.deepEqual(g.health,initial);assert.equal(recovery.prepare(f.a,f.job,f.task).id,g.id);
 const latest=health.receipt(f.a);assert.notEqual(latest.checkId,initial.checkId);claim(f);assert.deepEqual(g.claim.health,latest);assert.equal(g.status,'claimed');assert.deepEqual(f.a.data.spendMeter,budget);
 t.mock.timers.tick(health.TTL_MS+1);f.a.save();f.a.data=JSON.parse(fs.readFileSync(f.a.file));journal.replay(f.a,{force:true});const task=f.a.data.tasks[0],job=f.a.data.delegations[0],p=task.evidenceConsumption.attempts.consumption;
 assert.equal(recovery.grant(f.a,job,task).status,'claimed');assert.equal(recovery.resolvedRequest(f.a,task,p,p.requests[0]),true);assert.equal(p.requests.length,2);assert.equal(recovery.inspect(f.a,job,task).eligible,false);
 const saved=clone(p.modelPreflightRecovery.claim.health);p.modelPreflightRecovery.claim.health.expiresAt=p.modelPreflightRecovery.claim.at;assert.equal(recovery.grant(f.a,job,task),null);p.modelPreflightRecovery.claim.health=saved;p.modelPreflightRecovery.claim.health.checkId='forged';assert.equal(recovery.grant(f.a,job,task),null);
});
test('prepared new successful check must retain original CLI configuration and intent identity',async t=>{
 const f=fixture(t);attest(f);guards(t,f);health.valid.mock.restore();delete f.a.data.runtime.subscriptionHealth;const check=realHealth(t,f);await check();recovery.prepare(f.a,f.job,f.task);
 const sub=require('../desktop/subscription.cjs');sub.identity.mock.mockImplementation(()=>({cliHash:'replacement',configurationHash:'local-public-config'}));await check();assert.ok(health.valid(f.a,{after:f.run.finishedAt}));assert.equal(recovery.inspect(f.a,f.job,f.task).reason,'MODEL_PREFLIGHT_HEALTH_CHANGED');assert.equal(f.p.requests.length,1);
});
test('a newer successful check is recorded in atomic claim; save failure cannot dispatch',async t=>{
 const f=fixture(t);attest(f);guards(t,f);health.valid.mock.restore();delete f.a.data.runtime.subscriptionHealth;const check=realHealth(t,f);await check();const g=recovery.prepare(f.a,f.job,f.task);await check();const original=clone(g),save=f.a.save,meta=start(f);let dispatch=0;
 f.a.save=()=>{throw Error('ENOSPC');};assert.throws(()=>{claim(f,meta);dispatch++;});assert.equal(dispatch,0);assert.deepEqual(f.p.modelPreflightRecovery,original);assert.equal(f.p.requests.length,1);f.a.save=save;claim(f,meta);assert.equal(f.p.modelPreflightRecovery.status,'claimed');
});

test('exact preflight owner survives legacy efficiency guard without authorizing planner, checks or siblings',t=>{
 const f=prepared(t),{a,job,task,p}=f,work=require('../desktop/work-efficiency.cjs');
 job.executionState.workEfficiency={version:2,phase:'recovery_pending',attempts:3,tried:{old:true},history:[{title:'old failure'}],lastFailure:{code:'EVIDENCE_GENERATION_UNRESOLVED',message:'old unknown'}};
 const prior=clone(job.executionState.workEfficiency),run={id:'new-run',jobId:job.id,status:'running',steps:[]};a.data.agentRuns.unshift(run);a.activeAgentRun=run;a.activeAgentJob=job;job.status='running';
 const opts={task,stage:'dispatch',action:{tool:'advance_task',args:{taskId:task.id}}};
 assert.equal(recovery.permits(a,job,opts),true);assert.equal(work.assertAllowed(a,job,opts).allowed,true);assert.deepEqual(job.executionState.workEfficiency,prior);
 for(const patch of [{stage:'planner'},{stage:'goal_verify'},{stage:'task_verify'},{task:{id:'other'}},{action:{tool:'platform_query',args:{taskId:task.id}}},{action:{tool:'advance_task',args:{taskId:'other'}}}])assert.equal(recovery.permits(a,job,{...opts,...patch}),false);
 const meta=start(f);a.activeAgentRun=run;assert.equal(recovery.permits(a,job,{task,stage:'task_work'}),true);assert.equal(work.assertAllowed(a,job,{task,stage:'task_work'}).allowed,true);
 assert.deepEqual(job.executionState.workEfficiency,prior);
 health.valid.mock.mockImplementation(()=>null);assert.throws(()=>work.assertAllowed(a,job,{task,stage:'task_work'}),{code:'MODEL_PREFLIGHT_HEALTH_REQUIRED'});assert.deepEqual(job.executionState.workEfficiency,prior);
 health.valid.mock.mockImplementation(()=>({valid:true}));claim(f,meta);assert.throws(()=>recovery.permits(a,job,{task,stage:'task_work'}),{code:'MODEL_PREFLIGHT_RECOVERY_USED'});
});
test('preflight efficiency permission requires an actual owned active run and preserves execution/ACL/input gates',t=>{
 const f=prepared(t),{a,job,task}=f,opts={task,stage:'dispatch',action:{tool:'advance_task',args:{taskId:task.id}}};
 assert.equal(recovery.permits(a,job,opts),false);
 const run={id:'new-run',jobId:job.id,status:'running'};a.activeAgentRun=run;a.activeAgentJob=job;assert.equal(recovery.permits(a,job,opts),false);a.data.agentRuns.unshift(run);assert.equal(recovery.permits(a,job,opts),true);
 run.finishedAt=new Date().toISOString();assert.equal(recovery.permits(a,job,opts),false);delete run.finishedAt;
 require('../desktop/protocol-access.cjs').assertTool.mock.mockImplementation(()=>{throw Object.assign(Error('revoked'),{code:'ACCESS_DENIED'});});assert.throws(()=>recovery.permits(a,job,opts),{code:'ACCESS_DENIED'});
 require('../desktop/protocol-access.cjs').assertTool.mock.mockImplementation(()=>true);
 require('../desktop/evidence-consumption.cjs').current.mock.mockImplementation(()=>false);assert.throws(()=>recovery.permits(a,job,opts),{code:'EVIDENCE_CONSUMPTION_STALE'});
});
