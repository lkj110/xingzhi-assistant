// Read-only import of one recorded legacy recovery episode. This is budget
// evidence, not dispatch authorization: the caller must apply current guards and
// atomically persist migrationId, proof and cycles with its continuation handoff.
const {hash}=require('./evidence-basis.cjs');
const rows=value=>Array.isArray(value)?value:[];
const time=value=>typeof value==='string'?Date.parse(value):NaN;
const taskId=step=>step.args?.taskId||step.args?.existingTaskId||step.result?.taskId;
const TASK_TOOLS=new Set(['advance_task','revise_task','verify_content','plan_task']);
const PRECONDITIONS=new Set(['PLAN_ALREADY_RECONCILED','PLAN_INPUT_INVALID','PLAN_RECONCILE_REQUIRED','REVISION_TARGET_REQUIRED','EVIDENCE_REQUIRED','EXTERNAL_TOOL_REQUIRED','CONTENT_REPAIR_REQUIRED','WORK_STRATEGY_CHANGE','WORK_STRATEGY_WAIT','CONTEXT_INVALID_REQUEST','EXECUTION_GATE_CLOSED']);
const MAX_CYCLES=3;

// Match strategy-recovery's persisted actionKeys, including its deliberate
// omission of repair prose and planVersion. Never use a draft hash as a budget key.
function actionKey(step){
 const args=step.args||{};
 if(['plan_task','revise_task'].includes(step.tool))return hash({tool:step.tool,taskId:args.taskId||args.existingTaskId||args.key});
 try{return hash(require('./operation-ledger.cjs').normalize(step.tool,args));}catch{return null;}
}
function checkKey(check,task,attempt){
 const id=check.checkId||check.verificationId||check.commitId||check.id;
 if(id)return hash({taskId:task.id,checkId:id});
 if(check.at&&(check.basis||check.snapshot?.id))return hash({taskId:task.id,at:check.at,basis:check.basis||null,snapshot:check.snapshot?.id||null});
 // Old checks without an ID still have a durable dispatch identity. Identical
// gap prose is not an identity: three independent failures must count three times.
 return hash({taskId:task.id,attempt});
}
function inspect(a,job,task){
 const old=job?.executionState?.workEfficiency;
 const proof={version:1,jobId:job?.id||null,taskId:task?.id||null,complete:false,attempts:[],histories:[],unknown:[]};
 let migrationId=null,cycles=null;
 const result=(eligible,reason)=>({eligible,migrationId,cycles,proof,reason});
 const unknown=(code,details={})=>proof.unknown.push({...details,code});
 if(!old||old.phase!=='awaiting_change'||old.lastFailure?.code!=='PLAN_ALREADY_RECONCILED')return result(false,'NOT_LEGACY_PLAN_WAIT');
 if(!task||task.agentJobId!==job.id||!rows(job.taskIds).includes(task.id)||old.lastFailure.taskId&&old.lastFailure.taskId!==task.id)return result(false,'TASK_MISMATCH');
 const nextAction={tool:'advance_task',args:{taskId:task.id}},nextKey=actionKey(nextAction);
 proof.actionKey=nextKey;proof.action=nextAction;
 proof.legacy={intent:old.intent||null,waitBasis:old.waitBasis||null,stoppedAt:old.blocker?.at||null,lastFailure:structuredClone(old.lastFailure)};
 const stop=time(old.blocker?.at);
 if(!old.intent||!old.waitBasis||!Number.isFinite(stop))return result(false,'LEGACY_EPISODE_UNKNOWN');
 const episodeId=hash({jobId:job.id,taskId:task.id,intent:old.intent,waitBasis:old.waitBasis,stoppedAt:old.blocker.at});
 proof.episodeId=episodeId;
 migrationId=hash({version:1,episodeId,actionKey:nextKey});
 const migrations=job.executionState.continuation?.migrations||{};
 const previousId=hash({version:1,waitBasis:old.waitBasis,stopped:old.blocker.at,lastFailure:old.lastFailure});
 if(migrations[migrationId]||migrations[previousId])return result(false,'ALREADY_MIGRATED');
 if(task.deletedAt||task.agentCancelled||['paused','review','completed','waiting'].includes(task.status)||task.needsReplan||task.evidenceRequest)return result(false,'TASK_NOT_CONTINUABLE');
 const next=rows(task.steps).find(s=>!s.done);
 if(next&&!['analysis','draft'].includes(next.kind))return result(false,'NO_DIRECT_TEXT_ACTION');

 // All strategies in the saved episode participate, not just waitBasis: plan
// changes can alter that hash without resolving the original obligation.
 const histories=rows(old.history);
 if(!histories.length||!old.tried||typeof old.tried!=='object')return result(false,'LEGACY_HISTORY_INCOMPLETE');
 if(histories.length>=24)unknown('HISTORY_RETENTION_LIMIT');
 if(old.active)unknown('UNSETTLED_LEGACY_STRATEGY');
 const starts=histories.map(h=>time(h.startedAt));
 if(starts.some(x=>!Number.isFinite(x)))return result(false,'LEGACY_HISTORY_INCOMPLETE');
 const start=Math.min(...starts);
 proof.window={startedAt:new Date(start).toISOString(),stoppedAt:old.blocker.at};
 if(start>stop)return result(false,'LEGACY_HISTORY_INCOMPLETE');
 proof.ledgerHash=hash({intent:old.intent,waitBasis:old.waitBasis,blocker:old.blocker,tried:old.tried,history:histories});
 const runs=rows(a?.data?.agentRuns);
 const runStarts=runs.map(r=>time(r.startedAt)).filter(Number.isFinite);
 // agentRuns is a newest-first ring of 200 runs. Its retained suffix must
// cover the episode; merely finding the final plan error proves nothing.
 if(!runStarts.length||Math.min(...runStarts)>start)unknown('RUN_WINDOW_NOT_COVERED');
 proof.retention={runs:runs.length,oldestRunAt:runStarts.length?new Date(Math.min(...runStarts)).toISOString():null};
 // workEfficiency.sync rebuilt history/tried on *any* intent hash change.
 // The first surviving history is therefore not a budget reset receipt. This
 // importer cannot certify semantic new-fact/requirement boundaries; unresolved
 // older work must remain unknown for the parent's evidence admission path.
 const ownershipStart=Math.max(time(task.createdAt),time(job.createdAt));
 if(!Number.isFinite(ownershipStart))unknown('BUDGET_ORIGIN_UNKNOWN');
 else if(runs.length>=200&&(!runStarts.length||Math.min(...runStarts)>ownershipStart))unknown('BUDGET_HISTORY_TRUNCATED');
 proof.priorAttempts=[];
 for(const run of runs.filter(r=>r.jobId===job.id))for(const [index,step] of rows(run.steps).entries()){
  if(taskId(step)!==task.id||!['advance_task','verify_content'].includes(step.tool)||!(time(step.at)<start))continue;
  if(step.errorCode==='MODEL_INVALID_RESPONSE'||step.result?.verification?.passed===false||!step.result&&!PRECONDITIONS.has(step.errorCode)){
   const ref={runId:run.id||null,index,actionKey:actionKey(step),at:step.at,code:step.errorCode||null,checkId:step.result?.verification?checkKey(step.result.verification,task,run.id+':'+index):null};
   proof.priorAttempts.push(ref);unknown('PRIOR_BUDGET_ATTRIBUTION_UNKNOWN',ref);
  }
 }
 const receipts=[],byAttempt=new Map();
 for(const run of runs.filter(r=>r.jobId===job.id))for(const [index,step] of rows(run.steps).entries()){
  const at=time(step.at);
  if(Number.isFinite(at)&&(at<start||at>stop))continue;
  if(!Number.isFinite(at)){if(taskId(step)===task.id)unknown('ATTEMPT_TIME_UNKNOWN',{runId:run.id||null,index});continue;}
  const id=step.attemptId||step.executionAttemptId||(run.id?run.id+':'+index:null);
  if(!id){if(taskId(step)===task.id)unknown('ATTEMPT_ID_UNKNOWN',{index});continue;}
  const record={id,runId:run.id||null,index,at:step.at,finishedAt:run.finishedAt,key:actionKey(step),step};
  if(byAttempt.has(id)){
   if(hash(byAttempt.get(id).step)!==hash(step))unknown('CONFLICTING_ATTEMPT',{attemptId:id});
   continue;
  }
  byAttempt.set(id,record);receipts.push(record);
 }
 receipts.sort((x,y)=>time(x.at)-time(y.at)||x.id.localeCompare(y.id));
 const targetKeys=new Set([...TASK_TOOLS].map(tool=>actionKey({tool,args:{taskId:task.id}})));
 const relevantHistories=[];
 for(const h of histories){
  const end=time(h.finishedAt);
  if(!h.id||!h.basis||!Number.isFinite(end)||end<time(h.startedAt)||end>stop){unknown('STRATEGY_IDENTITY_UNKNOWN',{strategyId:h.id||null});continue;}
  const selected=receipts.filter(r=>time(r.at)>=time(h.startedAt)&&time(r.at)<=end&&(!r.step.strategyRecovery?.id||r.step.strategyRecovery.id===h.id));
  const keys=rows(h.actionKeys),actions=rows(h.executedActions);
  const relevant=keys.some(k=>targetKeys.has(k))||actions.some(s=>taskId(s)===task.id)||h.id.endsWith(':'+task.id)||h.id==='replan';
  if(!relevant)continue;
  relevantHistories.push(h);
  proof.histories.push({id:h.id,basis:h.basis,startedAt:h.startedAt,finishedAt:h.finishedAt,outcome:h.outcome,actionKeys:[...keys]});
  // actionKeys keeps every dispatch; executedActions keeps only the last six.
  // Compare multiplicities, otherwise one retained success could hide failures.
  const expected=new Map(),actual=new Map();
  for(const key of keys)expected.set(key,(expected.get(key)||0)+1);
  for(const r of selected)if(r.key)actual.set(r.key,(actual.get(r.key)||0)+1);
  if(!keys.length&&(actions.length||h.outcome!=='progress'))unknown('STRATEGY_ACTIONS_UNKNOWN',{strategyId:h.id});
  for(const [key,count] of expected)if((actual.get(key)||0)<count)unknown('MISSING_ACTION_RECEIPT',{strategyId:h.id,actionKey:key,expected:count,observed:actual.get(key)||0});
  for(const action of actions){const key=actionKey(action);if(taskId(action)===task.id&&(!key||!expected.has(key)))unknown('ACTION_KEY_MISMATCH',{strategyId:h.id});}
  if(h.outcome==='interrupted'&&selected.some(r=>!r.step.result&&!r.step.errorCode))unknown('INTERRUPTED_STRATEGY',{strategyId:h.id});
 }
 for(const [key,tried] of Object.entries(old.tried)){
  // Excluded is a policy decision, not another dispatch; its actual failure is
// counted from the run receipt. Do not infer attempts from diagnostic prose.
  if(tried?.outcome==='excluded')continue;
  if(!histories.some(h=>key===h.basis+':'+h.id))unknown('TRIED_WITHOUT_HISTORY',{strategyKey:key});
 }
 const planKey=actionKey({tool:'plan_task',args:{taskId:task.id}});
 const precondition=receipts.filter(r=>taskId(r.step)===task.id&&r.step.tool==='plan_task'&&r.step.errorCode==='PLAN_ALREADY_RECONCILED'&&relevantHistories.some(h=>h.basis===old.waitBasis&&rows(h.actionKeys).includes(planKey)&&time(r.at)>=time(h.startedAt)&&time(r.at)<=time(h.finishedAt)&&(!r.step.strategyRecovery?.id||r.step.strategyRecovery.id===h.id))).at(-1);
 if(!precondition)unknown('PLAN_PRECONDITION_NOT_PROVEN');
 else proof.precondition={attemptId:precondition.id,actionKey:planKey,at:precondition.at,code:'PLAN_ALREADY_RECONCILED'};

 const counted=new Map(),checks=new Set(),generated=new Map(),consumed=new Set();let modelFailures=0;
 for(const r of receipts.filter(r=>taskId(r.step)===task.id&&TASK_TOOLS.has(r.step.tool))){
  const step=r.step,check=step.result?.verification;
  if(step.errorCode==='MODEL_INVALID_RESPONSE'&&['advance_task','verify_content'].includes(step.tool)){
   counted.set('attempt:'+r.id,{attemptId:r.id,actionKey:r.key,kind:'generation_failure',code:step.errorCode,at:r.at});modelFailures++;continue;
  }
  if(step.error||step.errorCode){
   if(!PRECONDITIONS.has(step.errorCode))unknown('UNCLASSIFIED_FAILURE',{attemptId:r.id,code:step.errorCode||null});
   continue;
  }
  if(!step.result){unknown('ATTEMPT_RESULT_MISSING',{attemptId:r.id});continue;}
  if(step.tool==='advance_task'){
   const nextReceipt=receipts.find(other=>time(other.at)>time(r.at));
   const end=Math.min(Number.isFinite(time(r.finishedAt))?time(r.finishedAt):stop,nextReceipt?time(nextReceipt.at):stop);
   for(const artifact of rows(a.data.artifacts))if(artifact.taskId===task.id&&artifact.generationSnapshot&&artifact.origin!=='user_import'&&time(artifact.createdAt)>=time(r.at)&&time(artifact.createdAt)<=end){
    generated.set(artifact.id,{artifactId:artifact.id,hash:hash(artifact.content),attemptId:r.id,createdAt:artifact.createdAt});
   }
  }
  if(check&&typeof check.passed==='boolean'){
   const id=checkKey(check,task,r.id);checks.add(id);
   // advance_task may carry an old task.verification while writing a later
// draft. That is not a newly completed failed cycle.
   const stale=Number.isFinite(time(check.at))&&time(check.at)<time(r.at);
   if(!stale&&check.passed===false&&!counted.has('check:'+id)){
    const outputs=rows(check.snapshot?.artifacts).map(ref=>generated.get(ref.artifactId)).filter(output=>output&&rows(check.snapshot.artifacts).some(ref=>ref.artifactId===output.artifactId&&ref.hash===output.hash));
    const fresh=outputs.filter(output=>!consumed.has(output.artifactId));
    if(fresh.length&&check.mode!=='exact'){
     counted.set('check:'+id,{attemptId:r.id,checkId:id,actionKey:r.key,kind:'failed_check',at:check.at||r.at,generations:fresh});
     for(const output of fresh)consumed.add(output.artifactId);
    }else if(!outputs.length||fresh.length&&check.mode==='exact')unknown('CHECK_WITHOUT_REVISION_RECEIPT',{attemptId:r.id,checkId:id});
    // Rechecking the same already-consumed generated version is not a cycle.
   }else if(!stale&&check.passed===true){
    for(const ref of rows(check.snapshot?.artifacts))consumed.add(ref.artifactId);
   }
  }else if(step.tool==='advance_task'){
   if(step.result.error)unknown('UNCLASSIFIED_RESULT_FAILURE',{attemptId:r.id});
  }
 }
 for(const check of [task.verification,task.contentVerification])if(check?.passed===false&&time(check.at)>=start&&time(check.at)<=stop&&!checks.has(checkKey(check,task,null)))unknown('CHECK_COMMIT_WITHOUT_RUN_RECEIPT',{at:check.at});
 for(const record of Object.values(job.executionState.invalidOutputs||{}))if(record.taskId===task.id&&time(record.at)>=start&&time(record.at)<=stop&&record.count>modelFailures)unknown('GENERATION_FAILURE_LEDGER_INCOMPLETE',{at:record.at,count:record.count,observed:modelFailures});
 proof.attempts=[...counted.values()];proof.knownCycles=counted.size;
 proof.complete=proof.unknown.length===0;
 // Unknown counts deliberately remain null, never zero. Even with an incomplete
// history, three proven failures are sufficient to reject this migration.
 cycles=proof.complete?counted.size:null;
 if(counted.size>=MAX_CYCLES)return result(false,'LEGACY_CYCLES_EXHAUSTED');
 if(!proof.complete)return result(false,'LEGACY_HISTORY_INCOMPLETE');
 return result(true,'PROVEN_PRECONDITION_MISCONSUMPTION');
}
module.exports={inspect};
