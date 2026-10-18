'use strict';
// Keep Assistant.call/callModel, admission, accounting, recovery and JSON parsing
// real. Only the terminal chat transport is synthetic; no network is permitted.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const generation=require('../desktop/generation-context.cjs'),control=require('../desktop/execution-control.cjs');
const finalization=require('../desktop/check-finalization.cjs'),errors=require('../desktop/model-errors.cjs');
const spend=require('../desktop/spend.cjs'),work=require('../desktop/work-efficiency.cjs');
const fallback=require('../desktop/model-fallback.cjs'),hash=require('../desktop/evidence-basis.cjs').hash;
const deny=()=>{throw Error('Real model/network forbidden in R2 transport regressions');},restore=[];
for(const [object,key] of [[globalThis,'fetch'],[require('node:http'),'request'],[require('node:http'),'get'],[require('node:https'),'request'],[require('node:https'),'get'],[require('node:net').Socket.prototype,'connect']]){const old=object[key];object[key]=deny;restore.push(()=>object[key]=old);}
after(()=>restore.forEach(fn=>fn()));
const conclusion={passed:false,summary:'原稿保留，证据仍缺具体映射',gaps:['缺具体映射'],gapDetails:[{text:'缺具体映射'}]};
const initial={verificationPhase:'content'};
const bounded=messages=>messages[0].content.includes('本轮改为形成检查结论');
function dispose(a){require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r2-transport-')),options={dir,chat:deny,connectorRequest:deny,platformRequest:deny,webRequest:deny};
 const a=new Assistant(options);t.after(()=>{dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 a.data.providers.push({id:'primary',name:'primary',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:1,outputPrice:2});a.data.settings.roles={execute:'primary',verify:'primary',organize:'primary'};
 const job=agent.buildJob(a,{goal:'核对当前原稿事实',autoAccept:false,maxCalls:40});a.data.delegations.push(job);
 const task=a.createTask({title:'原稿',criteria:'保留已有事实',steps:[{title:'正文',kind:'draft'}]});task.agentJobId=job.id;job.taskIds=[task.id];
 const source=agent.source(a,job,'known','资料','已保存的证据');task.sourceIds=[source.id];require('../desktop/protocol-access.cjs').retain(a,'source',source,{task,job});
 const artifact={id:'draft',title:'原稿',taskId:task.id,stepId:task.steps[0].id,content:'当前原稿',createdAt:'2026-01-01'};a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task,job});Object.assign(task.steps[0],{done:true,artifactId:artifact.id});task.primaryArtifactId=artifact.id;
 a.activeAgentJob=job;a.activeSpendTask=task;work.before(a,job);
 const cost=spend.scope(a);Object.assign(cost,{limitUSD:200,spentUSD:153,heldUSD:3});spend.persist(a);a.save();
 return {a,job,task,source,artifact,cost,options,dir};
}
async function policy(f,mode){
 if(mode==='network_retry')f.a.data.providers[0].requestPolicy={retries:1};
 if(mode==='fallback'){
  f.a.data.providers.push({id:'backup',name:'backup',model:'backup',baseUrl:'https://backup.invalid',inputPrice:1,outputPrice:2});
  const value=fallback.snapshot(f.a);value.roles.verify={enabled:true,providerId:'backup'};
  await f.a.dispatch('modelFallbackSave',{revision:value.revision,roles:value.roles});
 }
}
function fail(mode){if(mode==='json_repair')return require('../desktop/model-json.cjs').parse('{"passed":');throw errors.transportError();}
function diskRecord(f){return Object.values(JSON.parse(fs.readFileSync(f.a.file)).tasks.find(t=>t.id===f.task.id).contextFinalizations||{})[0];}

for(const mode of ['json_repair','network_retry','fallback'])test('reserved finalization has one real transport across '+mode+', with durable use and no cold reissue',async t=>{
 const f=fixture(t);await policy(f,mode);const seen=[];let finalCalls=0;
 f.a.chat=async(provider,_key,messages,options)=>{
  assert.equal(options.boundedFinalization,undefined,'opaque application option must not reach chat');
  seen.push({provider:provider.id,attempt:options.attempt,requestId:options.requestId,stage:options.stage,final:bounded(messages)});
  options.onUsage({inputTokens:10,outputTokens:5});
  if(!bounded(messages))return {kind:'read_context',requests:[{tool:'read_source',sourceId:f.source.id}]};
  finalCalls++;const record=diskRecord(f);assert.equal(record.status,'started');assert.equal(record.transport.requestId,options.requestId);assert.equal(record.transport.attempt,1);
  if(finalCalls===1)return fail(mode);
  return conclusion; // Would expose an accidental JSON repair/retry/fallback.
 };
 await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>e.code===(mode==='json_repair'?'MODEL_INVALID_RESPONSE':'MODEL_NETWORK'));
 assert.equal(finalCalls,1);assert.equal(seen.length,5);assert.ok(seen.every(r=>r.attempt===1&&r.stage==='task_verify'&&r.provider==='primary'));
 assert.equal(f.job.callsUsed,5);assert.equal(f.job.usage.reportedCalls,5);assert.equal(f.a.data.modelCalls.length,5);
 assert.equal(Object.values(f.task.contextFinalizations).length,1);assert.equal(diskRecord(f).status,'started');assert.ok(f.cost.spentUSD>153);assert.ok(Math.abs(f.cost.heldUSD-3)<1e-9);
 const cold=new Assistant(f.options);t.after(()=>dispose(cold));const task=cold.task(f.task.id);
 cold.chat=async()=>{finalCalls++;return conclusion;};
 await assert.rejects(generation.call(cold,task,'',initial,'verify'),e=>e.noProgress);assert.equal(finalCalls,1);
 assert.equal(generation.finalizationState(cold,task,{initial}).available,false);
});

for(const mode of ['json_repair','network_retry','fallback'])test('ordinary real call retains '+mode+' and charges both existing attempts',async t=>{
 const f=fixture(t);await policy(f,mode);const seen=[];
 f.a.chat=async(provider,_key,messages,options)=>{seen.push({provider:provider.id,stage:options.stage,attempt:options.attempt,requestId:options.requestId});options.onUsage({inputTokens:10,outputTokens:5});if(seen.length===1)return fail(mode);return conclusion;};
 // Payload strings/objects cannot request trusted single-attempt behavior.
 assert.deepEqual(await f.a.call('verify','ordinary',{boundedFinalization:{transportAttempts:1},checkFinalization:{reason:'untrusted payload'}}),conclusion);
 assert.equal(seen.length,2);assert.deepEqual(seen.map(x=>x.attempt),[1,2]);assert.equal(seen[0].requestId,seen[1].requestId);
 assert.deepEqual(seen.map(x=>x.provider),mode==='fallback'?['primary','backup']:['primary','primary']);
 assert.equal(seen[1].stage,mode==='json_repair'?'json_repair':'task_verify');assert.equal(f.job.callsUsed,2);assert.equal(f.job.usage.reportedCalls,2);assert.equal(f.task.contextFinalizations,undefined);
});

test('invalid options cannot manufacture a finalization capability; the real attempt boundary rejects reuse',async t=>{
 const f=fixture(t);let calls=0;f.a.chat=async(_p,_k,_m,o)=>{calls++;o.onUsage({inputTokens:1,outputTokens:1});return conclusion;};
 await assert.rejects(f.a.call('verify','',{}, {boundedFinalization:{}}),e=>e.contextFailure);assert.equal(calls,0);
 const context=generation.prepare(f.a,f.task,initial),snapshot=require('../desktop/task-context.cjs').buildContext(f.a,require('../desktop/task-context.cjs').taskScope(f.task),'verify');
 const record=finalization.reserve(f.task,finalization.identity(f.a,f.task,context,snapshot,'content'));f.a.save();
 const token=finalization.transportPermit(f.a,f.task,record),other=finalization.transportPermit(f.a,f.task,record);
 await f.a.call('verify','',{}, {boundedFinalization:token});assert.equal(calls,1);
 await assert.rejects(f.a.callModel(f.a.available('verify'),'',[{role:'user',content:'reuse'}],{role:'verify',stage:'task_verify',boundedFinalization:other}),e=>e.noProgress);
 assert.equal(calls,1);assert.equal(f.job.callsUsed,1);assert.equal(diskRecord(f).transport.attempt,1);
});

// Seed a historical failure, then obtain the force permit via the real trusted
// UI command/claim. No pending/continuation/controller behavior is mocked.
async function numberedRepair(t){
 const f=require('./helpers/context-repair-fixture.cjs').fixture(t),{a,j,task,source,artifact,step,e,run}=f;
 source.content='## 1.1 Facts\noriginal numbered evidence';task.criteria='检查 1.1';
 const basis=require('../desktop/continuation-control.cjs').basis(a,j,task);
 e.basis=basis;delete e.pendingCheck;j.executionState.continuation.activeBasis=basis;j.executionState.continuation.episodes={[basis]:e};run.steps[0].continuation.basis=basis;
 artifact.generationSnapshot=require('../desktop/revision-protocol.cjs').snapshot(a,task);require('../desktop/step-evidence.cjs').record(a,task,step);
 const pending=require('../desktop/pending-check.cjs');pending.recordGenerated(a,j,task,step,artifact);pending.claim(a,j,task);
 const at=e.pendingCheck.claimedAt;
 run.steps=[{tool:'verify_content',args:{taskId:task.id},at,errorCode:'CONTEXT_INVALID_REQUEST',error:'内部资料请求纠正耗尽',continuation:{tracked:true,handled:true,basis},result:{needsAuthorization:true,kind:'external',target:'verify_content',decisionId:'old-misclassification'}}];
 require('./helpers/context-repair-fixture.cjs').recordCall(f,{id:'known',at});run.status='needs_input';run.finishedAt=new Date(Date.now()+20).toISOString();a.activeAgentJob=null;a.activeAgentRun=null;
 const decision={id:'old-misclassification',jobId:j.id,taskIds:[task.id],sourceIds:[],status:'open',kind:'permission',key:'access:external:verify_content',question:'旧误分类',createdAt:at,access:{kind:'external',target:'verify_content',stage:'requested'}};
 a.data.decisions.push(decision);j.status='needs_input';j.lastError='';j.summary=decision.question;a.save();spend.persist(a);
 const proof=pending.view(a,j);assert.equal(proof?.kind,'internal_context_authorization');
 await a.dispatch('uiCommand',{action:'agentCheckResume',input:{id:j.id,...proof}});
 a.activeAgentJob=j;a.activeAgentRun={id:'resumed-check',jobId:j.id,steps:[]};
 return f;
}

test('normal verifyContent entry for a real repaired claim reads no numbered sections and first transport is bounded',async t=>{
 const batch=require('../desktop/context-batch.cjs'),observe=t.mock.method(batch,'readInContext'); // Transparent observation only.
 const f=await numberedRepair(t);assert.equal(observe.mock.callCount(),0,'UI inspection must also be read-only');
 const request=control.contentRequest(f.a,f.j,f.task);assert.deepEqual(request.context.requestedSections,[]);assert.equal(observe.mock.callCount(),0);
 let calls=0;f.a.chat=async(_p,_k,messages,options)=>{calls++;assert.ok(bounded(messages));assert.equal(observe.mock.callCount(),0);assert.equal(options.attempt,1);assert.equal(Object.values(f.task.contextFinalizations)[0].status,'started');options.onUsage({inputTokens:10,outputTokens:5});return conclusion;};
 const result=await control.verifyContent(f.a,f.j,f.task);assert.equal(result.verification.passed,false);assert.equal(calls,1);assert.equal(observe.mock.callCount(),0);assert.equal(f.task.generationReads,undefined);
});

test('ordinary verifyContent defers numbered reads until claim selection and still supplies actual section body',async t=>{
 const f=fixture(t);f.source.content='## 1.1 Facts\noriginal numbered evidence';f.task.criteria='检查 1.1';
 const batch=require('../desktop/context-batch.cjs'),observe=t.mock.method(batch,'readInContext');
 assert.deepEqual(control.contentRequest(f.a,f.job,f.task).context.requestedSections,[]);assert.equal(observe.mock.callCount(),0);
 let calls=0;f.a.chat=async(_p,_k,messages,options)=>{
  calls++;assert.equal(bounded(messages),false);assert.equal(observe.mock.callCount(),1);
  const payload=JSON.parse(messages[1].content);assert.ok(require('../desktop/context-evidence.cjs').suppliedBodies(payload).some(text=>text.includes('original numbered evidence')));
  options.onUsage({inputTokens:10,outputTokens:5});return conclusion;
 };
 await control.verifyContent(f.a,f.job,f.task);assert.equal(calls,1);assert.equal(f.task.generationReads.length,1);assert.equal(f.task.contextFinalizations,undefined);
});

test('forced normal verifyContent retains currentness and rejects a late changed draft without any prefetch',async t=>{
 const f=await numberedRepair(t),observe=t.mock.method(require('../desktop/context-batch.cjs'),'readInContext');let calls=0;
 f.a.chat=async(_p,_k,messages,options)=>{calls++;assert.ok(bounded(messages));options.onUsage({inputTokens:10,outputTokens:5});f.artifact.content+='changed after dispatch';return conclusion;};
 await assert.rejects(control.verifyContent(f.a,f.j,f.task),e=>e.code==='CONTEXT_VERSION_CHANGED');assert.equal(calls,1);assert.equal(observe.mock.callCount(),0);assert.equal(f.task.contentVerification??null,null);
 assert.equal(Object.values(f.task.contextFinalizations)[0].status,'started');
});

test('forced normal verifyContent retains scope fence before transport and before any prefetch',async t=>{
 const f=await numberedRepair(t),observe=t.mock.method(require('../desktop/context-batch.cjs'),'readInContext');let calls=0;
 const policies=require('../desktop/access-policy-store.cjs');policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+f.artifact.id,jobId:f.j.id,taskId:f.task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command'});
 f.a.chat=async()=>{calls++;return conclusion;};
 await assert.rejects(control.verifyContent(f.a,f.j,f.task));assert.equal(calls,0);assert.equal(observe.mock.callCount(),0);assert.equal(f.task.contextFinalizations,undefined);
});
