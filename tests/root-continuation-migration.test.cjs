const {test}=require('node:test');
const assert=require('node:assert/strict');
const {hash}=require('../desktop/evidence-basis.cjs');
const migration=require('../desktop/continuation-migration.cjs');
const at=seconds=>new Date(Date.UTC(2026,9,16,10)+seconds*1000).toISOString();
const key=(tool,id='task')=>['plan_task','revise_task'].includes(tool)?hash({tool,taskId:id}):hash({tool,args:{taskId:id}});
const failedCheck=i=>({tool:'advance_task',args:{taskId:'task'},result:{taskId:'task',repairQueued:true,verification:{passed:false,gaps:['同一入口 SQL 仍缺失'],at:at(i*10+2),basis:'draft-'+i,snapshot:{id:'snapshot-'+i,artifacts:[{artifactId:'artifact-'+i,hash:hash('draft-'+i)}]}}}});
const invalid=()=>({tool:'advance_task',args:{taskId:'task'},error:'无效修订结构',errorCode:'MODEL_INVALID_RESPONSE'});
function fixture(steps=[]){
 const task={id:'task',agentJobId:'job',createdAt:at(-10),status:'todo',planVersion:57,sourceIds:Array.from({length:210},(_,i)=>'source-'+i),steps:[{id:'draft',kind:'draft',done:false},{id:'save',kind:'external',done:false}]};
 const old={intent:'saved-user-obligation',phase:'awaiting_change',waitBasis:'saved-input-basis',lastFailure:{code:'PLAN_ALREADY_RECONCILED',taskId:task.id},blocker:{at:at(100)},history:[],tried:{},reads:{retained:true}};
 const job={id:'job',createdAt:at(-10),taskIds:[task.id],status:'blocked',nextRunAt:null,feedback:[],executionState:{workEfficiency:old,reads:{saved:'original'},spend:{usd:157.1}}};
 const a={data:{tasks:[task],delegations:[job],agentRuns:[],artifacts:[]}};
 function append(step,i,id='cached:'+task.id,basis=old.waitBasis){
  step={...structuredClone(step),at:at(i*10+1),strategyRecovery:{id}};
  const h={id,basis,startedAt:at(i*10),finishedAt:at(i*10+5),outcome:'no_progress',actionKeys:[key(step.tool,step.args.taskId||step.args.existingTaskId)],executedActions:[{tool:step.tool,args:structuredClone(step.args)}]};
  old.history.push(h);old.tried[basis+':'+id]={at:h.startedAt};
  a.data.agentRuns.unshift({id:'run-'+i,jobId:job.id,startedAt:at(i*10),finishedAt:at(i*10+6),steps:[step],status:'done'});
  if(step.tool==='advance_task')for(const ref of step.result?.verification?.snapshot?.artifacts||[])a.data.artifacts.push({id:ref.artifactId,taskId:task.id,stepId:'draft',content:'draft-'+i,createdAt:at(i*10+1.5),generationSnapshot:{id:'before-'+i}});
  return step;
 }
 steps.forEach((s,i)=>append(s,i,'repair-'+i+':'+task.id));
 append({tool:'plan_task',args:{existingTaskId:task.id},error:'计划已经协调',errorCode:'PLAN_ALREADY_RECONCILED'},9,'replan');
 return {a,job,task,old,append,inspect(){return migration.inspect(a,job,task);}};
}
function unknown(result,code){assert.equal(result.eligible,false);assert.equal(result.cycles,null);assert.equal(result.reason,'LEGACY_HISTORY_INCOMPLETE');if(code)assert.ok(result.proof.unknown.some(r=>r.code===code),JSON.stringify(result.proof.unknown));}

test('three actual generated-then-failed checks exhaust the old episode',()=>{
 const f=fixture([failedCheck(0),failedCheck(1),failedCheck(2)]),r=f.inspect();
 assert.equal(r.eligible,false);assert.equal(r.cycles,3);assert.equal(r.reason,'LEGACY_CYCLES_EXHAUSTED');assert.equal(r.proof.complete,true);
 assert.deepEqual(r.proof.attempts.map(a=>a.kind),['failed_check','failed_check','failed_check']);
});
test('one true failure imports one cycle and leaves exactly two',()=>{
 for(const failure of [failedCheck(0),invalid()]){
  const f=fixture([failure]),r=f.inspect();assert.equal(r.eligible,true);assert.equal(r.cycles,1);assert.equal(3-r.cycles,2);
  assert.equal(r.proof.actionKey,key('advance_task'));assert.equal(r.proof.precondition.actionKey,key('plan_task'));
 }
});
test('generation failures and complete failed checks share the same finite budget',()=>{
 const r=fixture([invalid(),failedCheck(1),invalid()]).inspect();assert.equal(r.eligible,false);assert.equal(r.cycles,3);
});
test('history with a missing failed run is unknown, not zero',()=>{
 const f=fixture([invalid()]);f.a.data.agentRuns=f.a.data.agentRuns.filter(r=>r.id!=='run-0');
 unknown(f.inspect(),'MISSING_ACTION_RECEIPT');
});
test('a surviving final error without strategy history is not enough proof',()=>{
 const f=fixture();f.old.history=[];unknown(f.inspect());
});
test('an old tried strategy without its history cannot be silently discarded',()=>{
 const f=fixture();f.old.tried['older-basis:full_rewrite:task']={at:at(-20)};unknown(f.inspect(),'TRIED_WITHOUT_HISTORY');
});
test('ordinary feedback, source-update feedback and plan/hash changes do not forgive failures',()=>{
 const f=fixture([failedCheck(0),failedCheck(1),failedCheck(2)]),before=f.inspect();
 f.job.feedback.push({at:at(50),kind:'feedback',text:'请报告进度'},{at:at(60),origin:'source_update',text:'诊断更新'});
 f.task.planVersion=100;f.task.primaryArtifactId='new-draft';f.task.contentHash='new-body';f.old.lastFailure.message='同一个错误的新措辞';
 const after=f.inspect();assert.equal(after.cycles,3);assert.equal(after.eligible,false);assert.equal(after.migrationId,before.migrationId);
});
test('the saved episode spans changing strategy input bases',()=>{
 const f=fixture([failedCheck(0),invalid()]);f.old.history[0].basis='old-plan-basis';delete f.old.tried['saved-input-basis:repair-0:task'];f.old.tried['old-plan-basis:repair-0:task']={at:at(0)};
 const r=f.inspect();assert.equal(r.eligible,true);assert.equal(r.cycles,2);
});
test('a proven precondition-only episode imports zero once; restart preserves old ledgers',()=>{
 const f=fixture(),before=JSON.stringify(f.a.data),r=f.inspect();
 assert.equal(r.eligible,true);assert.equal(r.cycles,0);assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(f.inspect(),r);
 const old=JSON.stringify(f.old),reads=JSON.stringify(f.job.executionState.reads),spend=JSON.stringify(f.job.executionState.spend);
 // The parent owns this atomic write. Persist only the returned receipt here to
// verify the inspector's idempotency contract without importing the controller.
 f.job.executionState.continuation={migrations:{[r.migrationId]:{proof:r.proof,cycles:r.cycles}}};
 const data=JSON.parse(JSON.stringify(f.a.data)),restored=migration.inspect({data},data.delegations[0],data.tasks[0]);
 assert.equal(restored.eligible,false);assert.equal(restored.reason,'ALREADY_MIGRATED');assert.equal(restored.migrationId,r.migrationId);
 assert.equal(JSON.stringify(f.old),old);assert.equal(JSON.stringify(f.job.executionState.reads),reads);assert.equal(JSON.stringify(f.job.executionState.spend),spend);
});
test('older controller migration receipts also prevent a duplicate handoff',()=>{
 const f=fixture(),id=hash({version:1,waitBasis:f.old.waitBasis,stopped:f.old.blocker.at,lastFailure:f.old.lastFailure});
 f.job.executionState.continuation={migrations:{[id]:{at:at(101)}}};assert.equal(f.inspect().reason,'ALREADY_MIGRATED');
});
test('replayed run and check identities count only once',()=>{
 const f=fixture([failedCheck(0),failedCheck(1)]);
 f.a.data.agentRuns.push(structuredClone(f.a.data.agentRuns.find(r=>r.id==='run-0')));
 const s=f.a.data.agentRuns.find(r=>r.id==='run-1').steps[0],check=f.a.data.agentRuns.find(r=>r.id==='run-0').steps[0].result.verification;
 s.result.verification=structuredClone(check);
 const r=f.inspect();assert.equal(r.eligible,true);assert.equal(r.cycles,1);
});
test('same gap prose without check metadata still counts distinct dispatches',()=>{
 const steps=[0,1,2].map(i=>{const s=failedCheck(i);delete s.result.verification.at;delete s.result.verification.basis;return s;});
 const r=fixture(steps).inspect();assert.equal(r.cycles,3);assert.equal(r.eligible,false);
});
test('split advance then verify_content counts a failed cycle and deduplicates a shared check',()=>{
 const check={id:'check-1',passed:false,gaps:['SQL缺失'],at:at(12),basis:'body-1',snapshot:{id:'snapshot',artifacts:[{artifactId:'generated',hash:hash('actual generated draft')}]}};
 const f=fixture([{tool:'advance_task',args:{taskId:'task'},result:{taskId:'task',status:'todo'}},{tool:'verify_content',args:{taskId:'task'},result:{taskId:'task',verification:check}},{tool:'verify_content',args:{taskId:'task'},result:{taskId:'task',verification:check}}]);
 f.a.data.artifacts.push({id:'generated',taskId:'task',content:'actual generated draft',createdAt:at(1.5),generationSnapshot:{id:'before'}});
 assert.equal(f.inspect().cycles,1);assert.equal(f.inspect().eligible,true);
});
test('standalone failed verification with no revision evidence is unknown',()=>{
 const f=fixture([{tool:'verify_content',args:{taskId:'task'},result:{taskId:'task',verification:{passed:false,at:at(2),basis:'body'}}}]);unknown(f.inspect(),'CHECK_WITHOUT_REVISION_RECEIPT');
});
test('persisted failed verification missing its run result remains unknown',()=>{
 const f=fixture([invalid()]);f.task.contentVerification={passed:false,basis:'check-commit',at:at(2)};unknown(f.inspect(),'CHECK_COMMIT_WITHOUT_RUN_RECEIPT');
});
test('a duplicate dispatch ID with conflicting outcomes is not accepted',()=>{
 const f=fixture([failedCheck(0)]),copy=structuredClone(f.a.data.agentRuns.find(r=>r.id==='run-0'));copy.steps[0].result.verification.passed=true;f.a.data.agentRuns.push(copy);unknown(f.inspect(),'CONFLICTING_ATTEMPT');
});
test('actionKey multiplicity detects hidden repeated failures',()=>{
 const f=fixture([invalid()]);f.old.history[0].actionKeys.push(key('advance_task'));unknown(f.inspect(),'MISSING_ACTION_RECEIPT');
});
test('a matching plan error for another task or strategy does not prove this wait',()=>{
 for(const change of [s=>{s.args.existingTaskId='other';},s=>{s.strategyRecovery.id='unrelated';}]){
  const f=fixture();change(f.a.data.agentRuns[0].steps[0]);unknown(f.inspect(),'PLAN_PRECONDITION_NOT_PROVEN');
 }
});
test('foreign jobs and unrelated tasks do not consume this budget',()=>{
 const f=fixture([failedCheck(0)]);
 for(let i=0;i<3;i++)f.a.data.agentRuns.push({id:'foreign-'+i,jobId:i===0?'other-job':'job',startedAt:at(i*10),steps:[{...invalid(),args:{taskId:i===0?'task':'other-task'},at:at(i*10+1)}]});
 assert.equal(f.inspect().cycles,1);assert.equal(f.inspect().eligible,true);
});
test('unclassified, interrupted and missing result attempts do not default to zero',()=>{
 for(const step of [{tool:'advance_task',args:{taskId:'task'},error:'lost',errorCode:'UNKNOWN'},{tool:'advance_task',args:{taskId:'task'}},{tool:'advance_task',args:{taskId:'task'},result:{error:'lost'}}])unknown(fixture([step]).inspect());
});
test('the retained run window must cover the start even if the last plan error survives',()=>{
 const f=fixture();f.a.data.agentRuns[0].startedAt=at(92);unknown(f.inspect(),'RUN_WINDOW_NOT_COVERED');
});
test('a saturated legacy history ring cannot prove there are no missing attempts',()=>{
 const f=fixture();while(f.old.history.length<24)f.old.history.unshift({...f.old.history[0],id:'old-'+f.old.history.length});unknown(f.inspect(),'HISTORY_RETENTION_LIMIT');
});
test('an aggregate invalid output ledger cannot hide missing generation failures',()=>{
 const f=fixture([invalid()]);f.job.executionState.invalidOutputs={prior:{taskId:'task',at:at(3),count:2}};unknown(f.inspect(),'GENERATION_FAILURE_LEDGER_INCOMPLETE');
});
test('read guard and plan prerequisite errors are not completed revision-check cycles',()=>{
 const steps=['WORK_STRATEGY_CHANGE','CONTEXT_INVALID_REQUEST','PLAN_RECONCILE_REQUIRED'].map(errorCode=>({tool:'advance_task',args:{taskId:'task'},error:errorCode,errorCode}));
 const r=fixture(steps).inspect();assert.equal(r.eligible,true);assert.equal(r.cycles,0);
});
test('inspection is pure even on frozen App-owned input',()=>{
 const f=fixture([invalid()]);function freeze(v){if(v&&typeof v==='object'){Object.freeze(v);for(const x of Object.values(v))freeze(x);}}freeze(f.a.data);
 assert.equal(f.inspect().eligible,true);
});
test('incomplete old episode identity and non-continuable tasks are rejected',()=>{
 for(const change of [f=>{delete f.old.intent;},f=>{delete f.old.blocker;},f=>{f.task.needsReplan=true;},f=>{f.task.steps[0].done=true;},f=>{f.task.status='completed';}]){const f=fixture();change(f);assert.equal(f.inspect().eligible,false);}
});
test('history rebuilt after ordinary feedback cannot forgive earlier failures',()=>{
 const f=fixture([failedCheck(0),failedCheck(1),failedCheck(2)]);
 f.old.history=f.old.history.filter(h=>h.id==='replan');f.old.tried={'saved-input-basis:replan':{at:at(90)}};f.old.intent='another-feedback-hash';
 f.job.feedback.push({at:at(80),kind:'feedback',text:'继续原要求'});
 const r=f.inspect();unknown(r,'PRIOR_BUDGET_ATTRIBUTION_UNKNOWN');assert.equal(r.proof.priorAttempts.length,3);
});
test('200 retained runs do not prove completeness before the oldest retained run',()=>{
 const f=fixture([invalid()]);for(let i=0;f.a.data.agentRuns.length<200;i++)f.a.data.agentRuns.push({id:'other-'+i,jobId:'other-job',startedAt:at(0),steps:[]});
 unknown(f.inspect(),'BUDGET_HISTORY_TRUNCATED');
});
test('three fresh checks of the same generated version consume only one cycle',()=>{
 const f=fixture([failedCheck(0)]),snapshot=structuredClone(f.a.data.agentRuns.find(r=>r.id==='run-0').steps[0].result.verification.snapshot);
 for(let i=1;i<3;i++)f.append({tool:'verify_content',args:{taskId:'task'},result:{verification:{passed:false,at:at(i*10+2),basis:'another-diagnostic-'+i,snapshot}}},i,'check-'+i+':task');
 const r=f.inspect();assert.equal(r.eligible,true);assert.equal(r.cycles,1);
});
test('failed checks without a verifiable generated artifact cannot manufacture complete cycles',()=>{
 for(const change of [f=>{f.a.data.artifacts=[];},f=>{f.a.data.artifacts[0].content='different version';},f=>{f.a.data.artifacts[0].origin='user_import';},f=>{f.a.data.artifacts[0].createdAt=at(-30);}]){const f=fixture([failedCheck(0)]);change(f);unknown(f.inspect(),'CHECK_WITHOUT_REVISION_RECEIPT');}
});
