'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,recordCall}=require('./helpers/context-repair-fixture.cjs');
const pending=require('../desktop/pending-check.cjs'),hash=require('../desktop/evidence-basis.cjs').hash;
function failed(t){
 const f=fixture(t),{a,j,task,e,run}=f;
 pending.claim(a,j,task);const at=e.pendingCheck.claimedAt;
 run.steps=[{tool:'verify_content',args:{taskId:task.id},at,errorCode:'CONTEXT_INVALID_REQUEST',error:'内部纠偏耗尽，需修正参数、关联或权限',continuation:{tracked:true,handled:true,basis:e.basis},result:{needsAuthorization:true,kind:'external',target:'verify_content',decisionId:'bad-permission'}}];
 e.pendingCheck.interruption={code:'EXECUTION_GATE_CLOSED',at:'2025-12-01',requestProof:[{id:'ancient'}]};
 recordCall(f,{id:'known',at});run.status='needs_input';run.finishedAt=new Date(Date.now()+20).toISOString();a.activeAgentRun=null;a.activeAgentJob=null;
 const d={id:'bad-permission',jobId:j.id,taskIds:[task.id],sourceIds:[],status:'open',kind:'permission',key:'access:external:verify_content',question:'需要授权：检查外部访问权限',createdAt:at,access:{kind:'external',target:'verify_content',stage:'requested'}};
 a.data.decisions.push(d);j.status='needs_input';j.lastError='';j.summary=d.question;a.save();require('../desktop/spend.cjs').persist(a);return {...f,d};
}
function preservedParts(f){return {p:{...f.e.pendingCheck,status:undefined,claimedByRunId:undefined,claimedAt:undefined,claimHistory:undefined},cycles:f.e.cycles,hops:f.e.hops,attempts:f.j.executionState.workEfficiency.attempts,tried:f.j.executionState.workEfficiency.tried,reading:f.j.executionState.workEfficiency.reading,ledger:f.a.spendLedger,artifacts:f.a.data.artifacts,goal:f.j.goal};}
function preserved(f){return hash(preservedParts(f));}
async function command(f){const view=pending.view(f.a,f.j);assert.equal(view?.kind,'internal_context_authorization');const input={id:f.j.id,...view};await f.a.dispatch('uiCommand',{action:'agentCheckResume',input});return input;}
test('R3: exact false permission repair with empty lastError preserves old claim and supersedes without permission consent',async t=>{
 const f=failed(t),before=preserved(f),old=structuredClone(f.e.pendingCheck);const input=await command(f);
 assert.equal(f.d.status,'superseded');assert.equal(f.d.answer,undefined);assert.equal(f.j.status,'ready');assert.equal(preserved(f),before);assert.deepEqual(f.e.pendingCheck,old);
 const saved=fs.readFileSync(f.a.file);await f.a.dispatch('uiCommand',{action:'agentCheckResume',input});assert.deepEqual(fs.readFileSync(f.a.file),saved);
 f.a.activeAgentRun={id:'resumed',jobId:f.j.id,steps:[]};f.a.activeAgentJob=f.j;
 const claim=pending.claim(f.a,f.j,f.task);assert.equal(claim.claimId,old.claimId);assert.ok(claim.forceFinalization?.semanticCheckId);assert.equal(f.e.pendingCheck.claimedByRunId,'resumed');assert.deepEqual(f.e.pendingCheck.interruption,old.interruption);assert.equal(f.e.pendingCheck.claimHistory.at(-1).runId,old.claimedByRunId);assert.equal(preserved(f),before);
});
test('R3: UI repair while globally paused does not dispatch or erase a separate permission',async t=>{
 const f=failed(t);await f.a.dispatch('stewardshipPause',{});f.a.data.decisions.push({id:'real',jobId:f.j.id,status:'open',kind:'permission',key:'access:lark_create',taskIds:[f.task.id],sourceIds:[],question:'真实权限'});await command(f);
 assert.equal(f.j.status,'needs_input');assert.equal(f.a.data.stewardship.paused,true);assert.equal(f.a.data.decisions.find(x=>x.id==='real').status,'open');assert.equal(require('../desktop/agent.cjs').tick(f.a),false);assert.equal(f.run.modelCalls,1);
});
test('R3: UI repair cold restart preserves exact permit and no model calls',async t=>{
 const f=failed(t);await f.a.dispatch('stewardshipPause',{});await command(f);const before=structuredClone(preservedParts(f)),{Assistant}=require('../desktop/core.cjs');
 const cold=new Assistant({dir:f.dir,chat:()=>{throw Error('no automatic model');}});t.after(()=>{require('../desktop/access.cjs').cancel(cold);require('../desktop/deadline-scheduler.cjs').dispose(cold);});
 const j=cold.data.delegations.find(x=>x.id===f.j.id),task=cold.task(f.task.id),e=j.executionState.continuation.episodes[f.e.basis];assert.deepEqual(preservedParts({...f,a:cold,j,task,e}),before);assert.equal(cold.data.modelCalls.length,1);assert.equal(require('../desktop/agent.cjs').tick(cold),false);
 await cold.dispatch('stewardshipResume');cold.activeAgentJob=j;cold.activeAgentRun={id:'after-cold',jobId:j.id,steps:[]};assert.ok(pending.claim(cold,j,task).forceFinalization);
});
test('R3: unproved, consumed, altered, unknown and real external failures never obtain a UI repair',t=>{
 const mutations={
  real_tool:f=>{f.run.steps[0].tool='lark_update';},
  changed_code:f=>{f.run.steps[0].errorCode='CONTEXT_SCOPE_DENIED';},
  unknown:f=>{f.run.modelCallsDetail[0].usageReported=false;},
  missing_history:f=>{f.run.modelCalls=2;},
  wrong_owner:f=>{f.j.executionState.continuation.activeTaskId='other';},
  wrong_claim:f=>{f.e.pendingCheck.claimedByRunId='other';},
  changed_body:f=>{f.artifact.content+='changed';},
  changed_contract:f=>{f.j.goal+='changed';},
  consumed:f=>{f.task.contextFinalizations={legacy:{checkPhase:'content',status:'started'}};},
  duplicate_decision:f=>{f.a.data.decisions.push({...f.d,id:'duplicate'});},
  unresolved_request:f=>{f.run.modelCallsDetail[0].status='running';},
 };
 for(const [name,mutate] of Object.entries(mutations)){const f=failed(t);mutate(f);const before=JSON.stringify(f.a.data);assert.equal(pending.view(f.a,f.j),null,name);assert.equal(JSON.stringify(f.a.data),before,name);}
});
test('R3: claim cannot be inherited after repair claimant crash or later permission/owner/decision changes',async t=>{
 for(const kind of ['owner','decision','contract','crash']){
  const f=failed(t);await command(f);
  if(kind==='owner')f.j.executionState.continuation.activeTaskId='other';
  if(kind==='decision')f.d.status='open';
  if(kind==='contract')f.j.goal+='new';
  f.a.activeAgentJob=f.j;f.a.activeAgentRun={id:'new',jobId:f.j.id,steps:[]};
  if(kind==='crash'){pending.claim(f.a,f.j,f.task);f.a.data.agentRuns.unshift({...f.a.activeAgentRun,finishedAt:new Date().toISOString(),modelCalls:0,modelCallsDetail:[]});f.a.activeAgentRun={id:'third',jobId:f.j.id,steps:[]};}
  const before=structuredClone(f.e.pendingCheck);
  try{assert.equal(pending.claim(f.a,f.j,f.task),null,kind);}catch(e){assert.ok(['CHECK_REQUEST_UNRESOLVED','EXECUTION_GATE_CLOSED','CHECK_REPAIR_STALE'].includes(e.code),e.stack);}
  assert.deepEqual(f.e.pendingCheck,before,kind);
 }
});
module.exports={failed,preserved};
test('R3: typed repair commit append failure has zero changes; projection failure replays the one supersede',async t=>{
 const f=failed(t);await f.a.dispatch('stewardshipPause',{});const input={id:f.j.id,...pending.view(f.a,f.j)},journal=require('../desktop/work-journal.cjs');
 const before=preserved(f),old=structuredClone(f.e.pendingCheck),append=t.mock.method(journal,'append',()=>{throw Error('append refused');});
 await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),/append refused/);append.mock.restore();assert.equal(f.d.status,'open');assert.equal(preserved(f),before);assert.equal(f.e.checkRepairs,undefined);
 const save=f.a.save.bind(f.a);let once=true;const bad=t.mock.method(f.a,'save',()=>{if(once){once=false;throw Error('projection failed');}return save();});
 await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),e=>e.committed===true);bad.mock.restore();journal.replay(f.a);
 assert.equal(f.d.status,'superseded');assert.equal(f.a.data.stewardship.paused,true);assert.equal(preserved(f),before);assert.deepEqual(f.e.pendingCheck,old);assert.equal(journal.read(f.a).events.filter(x=>x.payload?.repairKind==='internal_context_authorization').length,1);
});
test('R3: UI commit or claim rejects scope withdrawal, consumed conclusion and changed work revision',async t=>{
 for(const mode of ['ui_scope','claim_scope','claim_consumed','claim_revision']){
  const f=failed(t),input={id:f.j.id,...pending.view(f.a,f.j)};
  if(mode==='ui_scope'){f.a.contextAccessCheck=()=>false;await assert.rejects(f.a.dispatch('uiCommand',{action:'agentCheckResume',input}),e=>e.code==='STATE_STALE');assert.equal(f.d.status,'open');continue;}
  await f.a.dispatch('uiCommand',{action:'agentCheckResume',input});
  if(mode==='claim_scope')f.a.contextAccessCheck=()=>false;
  if(mode==='claim_consumed')f.task.contextFinalizations={old:{checkPhase:'content',status:'started'}};
  if(mode==='claim_revision')f.j.workRevision=(f.j.workRevision??1)+1;
  f.a.activeAgentJob=f.j;f.a.activeAgentRun={id:'new-claim',jobId:f.j.id,steps:[]};const before=structuredClone(f.e.pendingCheck);
  try{assert.equal(pending.claim(f.a,f.j,f.task),null,mode);}catch(e){assert.ok(['EXECUTION_GATE_CLOSED','CHECK_REQUEST_UNRESOLVED','CHECK_REPAIR_STALE'].includes(e.code),e.stack);}
  assert.deepEqual(f.e.pendingCheck,before);assert.equal(f.run.modelCalls,1);
 }
});
test('R3 review: scheduler cannot restore an old repair owner after a real sibling takes over',async t=>{
 const f=failed(t);await command(f);
 const b=f.a.createTask({title:'独立任务',steps:[{title:'独立正文',kind:'draft'}]});b.agentJobId=f.j.id;f.j.taskIds.push(b.id);
 const c=f.j.executionState.continuation,key=require('../desktop/continuation-control.cjs').basis(f.a,f.j,b);
 c.episodes[key]={taskId:b.id,basis:key,intentBasis:hash({contract:f.j.goal,requirements:null}),cycles:0,hops:0};c.activeTaskId=b.id;c.activeBasis=key;
 f.j.executionState.policyOwner={kind:'continuation',taskId:b.id,basis:key};const old=structuredClone(f.e.pendingCheck);
 const result=require('../desktop/execution-policy.cjs').prepare(f.a,f.j);
 assert.equal(c.activeTaskId,b.id);assert.equal(c.activeBasis,key);assert.equal(result.taskIds.includes(f.task.id),false);assert.deepEqual(f.e.pendingCheck,old);assert.equal(f.a.data.modelCalls.length,1);
 f.a.activeAgentJob=f.j;f.a.activeAgentRun={id:'later',jobId:f.j.id,steps:[]};assert.throws(()=>pending.claim(f.a,f.j,f.task),e=>['CHECK_REQUEST_UNRESOLVED','CHECK_REPAIR_STALE'].includes(e.code));
});
test('R3 review: the whole failure run must have settled calls and consistent usage',async t=>{
 for(const mode of ['earlier_unknown','missing_time','token_conflict','cost_conflict','missing_count','missing_scope','cache_hour_conflict','negative_cached','earlier_known']){
  const f=failed(t);
  if(mode.startsWith('earlier')||mode==='missing_time'){
   recordCall(f,{id:'earlier',at:'2026-01-01T00:00:03.000Z',status:mode==='earlier_unknown'?'running':'done'});
   for(const calls of [f.a.data.modelCalls,f.run.modelCallsDetail]){const c=calls.find(r=>r.id==='earlier');c.role='organize';c.stage='planner';if(mode==='missing_time')delete c.at;}
  }
  if(mode==='token_conflict')f.run.modelCallsDetail[0].inputTokens++;
  if(mode==='cost_conflict')f.run.modelCallsDetail[0].estimatedUSD=9;
  if(mode==='missing_count'){recordCall(f,{id:'discarded',at:'2026-01-01T00:00:03.000Z'});f.run.modelCallsDetail.pop();f.a.data.modelCalls.pop();delete f.run.modelCalls;}
  if(mode==='missing_scope'){for(const c of [f.run.modelCallsDetail[0],f.a.data.modelCalls[0]]){c.spendScope='missing';c.spendTicketId='unproved';}}
  if(mode==='cache_hour_conflict'){for(const c of [f.run.modelCallsDetail[0],f.a.data.modelCalls[0]])c.cacheWriteTokens=50;f.run.modelCallsDetail[0].cacheWrite1hTokens=0;f.a.data.modelCalls[0].cacheWrite1hTokens=50;}
  if(mode==='negative_cached')for(const c of [f.run.modelCallsDetail[0],f.a.data.modelCalls[0]])c.cachedInputTokens=-1;
  if(mode==='earlier_known'){
   const base=structuredClone(Object.values(f.a.spendLedger.scopes)[0]);f.a.spendLedger.scopes.unrelated={...base,key:'unrelated',pending:{ancient:{reservedUSD:3}},heldUSD:3};const ledger=hash(f.a.spendLedger);
   await command(f);assert.equal(hash(f.a.spendLedger),ledger);assert.equal(f.e.checkRepairs[f.e.pendingCheck.generationAttemptId].proof.requestProof.length,2);
  }else assert.equal(pending.view(f.a,f.j),null,mode);
 }
});
test('R3 review: legacy read preparation and projection cannot revive a yielded typed repair owner',async t=>{
 const f=failed(t);f.j.executionState.workEfficiency.reading={[f.task.id]:{ineffective:3,batches:9}};await command(f);
 const cont=require('../desktop/continuation-control.cjs'),policy=require('../desktop/execution-policy.cjs');
 cont.handoff(f.a,f.j,{code:'CONTEXT_INVALID_REQUEST',message:'context changed',noProgress:true});
 assert.equal(pending.inspect(f.a,f.j).reason,'CHECK_REPAIR_STALE');assert.equal(f.j.executionState.continuation.activeTaskId,null);
 const before=structuredClone({pending:f.e.pendingCheck,tried:f.j.executionState.workEfficiency.tried,readingResumes:f.e.readingResumes});
 const prepared=policy.prepare(f.a,f.j);assert.equal(prepared.eligible,false);assert.equal(prepared.preparedCommands.includes('continuation_read_resume'),false);
 cont.applyPrepared(f.a,f.j,{command:'continuation_read_resume',taskId:f.task.id,proof:{basis:f.e.basis,cycles:f.e.cycles,hops:f.e.hops,suspendedBy:structuredClone(f.e.suspendedBy),methodId:'read_check:old',inputBasis:'old',title:'old'}},new Date().toISOString());
 assert.equal(f.j.executionState.continuation.activeTaskId,null);assert.deepEqual({pending:f.e.pendingCheck,tried:f.j.executionState.workEfficiency.tried,readingResumes:f.e.readingResumes},before);
 f.a.activeAgentJob=f.j;f.a.activeAgentRun={id:'after-yield',jobId:f.j.id,steps:[]};assert.throws(()=>pending.claim(f.a,f.j,f.task),e=>e.code==='CHECK_REQUEST_UNRESOLVED');
});
test('R3 review: claimed repair exit is not redispatched on subsequent scheduler attempts',async t=>{
 const f=failed(t);await command(f);f.a.activeAgentJob=f.j;f.a.activeAgentRun={id:'claimed-exit',jobId:f.j.id,steps:[],startedAt:new Date().toISOString()};pending.claim(f.a,f.j,f.task);
 f.a.data.agentRuns.unshift({...f.a.activeAgentRun,status:'error',finishedAt:new Date().toISOString(),modelCalls:0,modelCallsDetail:[]});f.a.activeAgentJob=null;f.a.activeAgentRun=null;
 let calls=0;f.a.call=async()=>{calls++;throw Error('unexpected model');};
 const before=JSON.stringify({pending:f.e.pendingCheck,runs:f.a.data.agentRuns,executions:f.e.executions,repair:f.e.checkRepairs});
 const agent=require('../desktop/agent.cjs'),policy=require('../desktop/execution-policy.cjs');
 for(let i=0;i<2;i++){const p=policy.prepare(f.a,f.j);assert.equal(p.eligible,false);assert.equal(p.reasonCode,'CHECK_REQUEST_UNRESOLVED');await agent.run(f.a,f.j.id);assert.equal(agent.tick(f.a),false);}
 assert.equal(JSON.stringify({pending:f.e.pendingCheck,runs:f.a.data.agentRuns,executions:f.e.executions,repair:f.e.checkRepairs}),before);assert.equal(calls,0);
});
