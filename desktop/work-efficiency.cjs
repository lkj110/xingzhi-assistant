// Parent integration (all arguments are App-owned, never model-supplied):
// before(a, job) BEFORE planning/model/spend reservation; persist its returned state.
// observe(a, job, step) AFTER each attempt, including failures, then save.
// observeCall(a, job, {taskId, role, result}) counts each read_context response.
// next(a, job) uses the existing deterministic scheduler before asking a planner.
// Programmatic pagination is owned by context-batch; it never renews this guard.
// No API grants access, accepts work, increases a budget or creates a decision.
const evidence=require('./evidence-basis.cjs');
const protocol=require('./task-context.cjs');
const rows=value=>Array.isArray(value)?value:[];
const LIMITS=Object.freeze({suggestAt:6,stopAt:12,maxFacts:4096});
const now=()=>new Date().toISOString();
const unique=values=>[...new Set(values)].sort();
function tasks(a,job){return rows(a.data.tasks).filter(t=>rows(job.taskIds).includes(t.id)&&t.agentJobId===job.id&&!t.deletedAt&&!t.agentCancelled);}
function intent(a,job){
 // Revisions, timestamps, authorization, planner revisions and check explanations
 // cannot manufacture a new user request. UserRequirement is written by user edits.
 const userRows=values=>rows(values).filter(f=>f.origin!=='result_check'&&f.kind!=='task_revision');
 const directives=require('./requirements.cjs').directives({...job,feedback:userRows(job.feedback),userDirectives:userRows(job.userDirectives)});
 return evidence.hash({goal:job.goal,contract:job.executionContract?.text||job.goal,
  directives:unique(directives.map(f=>evidence.hash({text:f.text,taskId:f.taskId}))),
  edits:rows(a.data.tasks).filter(t=>t.agentJobId===job.id&&t.userRequirement).map(t=>({id:t.id,...Object.fromEntries(['description','objective','criteria'].map(k=>[k,t.userRequirement[k]]))})).sort((x,y)=>x.id.localeCompare(y.id))});
}
function currentInputsAccessible(task,accessible){return rows(task.sourceIds).filter(id=>!task.supersededSourceIds?.includes(id)).every(id=>accessible.has(id));}
function draftMilestone(task,step,steps=task.steps){
 // Plan IDs, keys and titles are agent-editable. A text-step slot earns its
 // first-draft milestone once per user intent, even when a replan replaces it.
 return 'draft:'+evidence.hash({taskId:task.id,kind:step.kind,slot:steps.filter(s=>s.kind===step.kind).indexOf(step)});
}
function adoptionMilestone(task,step,artifact){return 'adopted:'+evidence.hash({taskId:task.id,step:draftMilestone(task,step),content:artifact.content});}
function currentCheck(a,task,check){return !check?.snapshot||check.snapshot.id===require('./revision-protocol.cjs').snapshot(a,task).id;}
function priorDrafts(a,job){
 // Baseline historical drafts too: an unfinished revision at startup is not a
 // new initial draft. History only consumes milestones; it never earns credit.
 return tasks(a,job).flatMap(task=>[task.steps,...rows(task.planHistory).map(p=>p.steps)].flatMap(steps=>rows(steps).filter(step=>['analysis','draft'].includes(step.kind)&&rows(a.data.artifacts).some(r=>r.taskId===task.id&&(r.stepId===step.id||r.id===step.artifactId)&&r.content?.trim())).map(step=>draftMilestone(task,step,steps))));
}
function snapshot(a,job){
 const facts=[],add=(kind,value)=>facts.push(kind+':'+evidence.hash(value)),active=tasks(a,job);
 for(const task of active){
  let context;try{context=protocol.buildContext(a,protocol.taskScope(task),'efficiency');}catch{continue;}
  const accessible=new Set(context.readableCatalog.filter(r=>!r.ambiguous).map(r=>r.id));
  for(const row of context.readableCatalog.filter(r=>r.purpose==='input'&&!r.ambiguous)){
   const source=a.data.sources.find(s=>s.id===row.id);
   // Association/permission/version counters do not count. Repeated facts under
   // a fresh source ID are still the same facts; platform observation noise is stripped.
   if(source)add('evidence',evidence.facts(source,task,job));
  }
  const current=require('./deliverables.cjs').current(a,task),valid=[];
  if(!currentInputsAccessible(task,accessible))continue;
  for(const artifact of current){
   const step=task.steps.find(s=>s.done&&s.artifactId===artifact.id);
   if(!step||!accessible.has(artifact.id)||!artifact.content?.trim()||artifact.stale||task.needsReplan)continue;
   const imported=artifact.origin==='user_import';
   if(artifact.contentHash&&artifact.contentHash!==evidence.hash(artifact.content))continue;
   // Adoption intentionally replaces the old step's output/input receipt. It
   // is a user action, not proof that the replacement has passed verification.
   if(!imported&&step.outputHash&&step.outputHash!==evidence.hash(artifact.content))continue;
   valid.push(artifact);
   // Scoped repairs can retain a sibling draft whose original generation used
   // an older dependency. A fresh fixed-version check may validate that draft;
   // the old generation receipt alone must not earn an initial-draft milestone.
   if(!imported&&step.inputBasis?.hash&&step.inputBasis.hash!==require('./step-evidence.cjs').snapshot(a,task,step).hash)continue;
   if(['analysis','draft'].includes(step.kind))facts.push(draftMilestone(task,step));
   if(imported)facts.push(adoptionMilestone(task,step,artifact));
  }
  const acceptance=require('./acceptance.cjs');
  const allValid=valid.length>0&&valid.length===current.length&&!task.needsReplan;
  // A current, passing check closes the same user requirement. Neither a new
  // body hash nor changing/omitting gap prose is a verified resolution. Each
  // verification stage earns credit once, until the actual user intent changes.
  const check=task.contentVerification;
  if(allValid&&check?.passed===true&&check.summary?.trim()&&Array.isArray(check.gaps)&&!check.gaps.some(g=>typeof g!=='string'||g.trim())&&check.basis===require('./execution-control.cjs').contentBasis(a,job,task)&&currentCheck(a,task,check))add('content_verified',{taskId:task.id});
  if(allValid&&task.verification?.basisVersion===2&&task.verification.basis===acceptance.basis(a,task)&&currentCheck(a,task,task.verification)&&!acceptance.reasons(a,task,{completed:task.status==='completed'}).length){
   add('verified',{taskId:task.id});
  }
  for(const action of rows(a.data.agentActions).filter(r=>r.jobId===job.id&&r.taskId===task.id&&r.status==='done'&&r.result?.verified===true&&!r.deliveryConflict)){
   const artifact=valid.find(r=>r.id===action.artifactId);
   if(!artifact||!accessible.has(artifact.id)||evidence.hash(action.content)!==evidence.hash(artifact.content))continue;
   if(action.result.sourceId&&!accessible.has(action.result.sourceId))continue;
   add('delivery',{tool:action.tool,content:artifact.content,target:action.result.url||action.result.latestPath||action.result.path||action.target});
  }
 }
 // Initial acquisition before planning is useful. Once tasks exist only their
 // scoped input bindings count, not a growing unrelated job-level source catalog.
 if(!active.length){
  try{for(const row of protocol.buildContext(a,{kind:'job',jobId:job.id},'efficiency').readableCatalog.filter(r=>r.purpose==='input'&&!r.ambiguous)){
   const source=a.data.sources.find(s=>s.id===row.id);if(source)add('evidence',evidence.facts(source,null,job));
  }}catch{}
 }
 return {intent:intent(a,job),facts:unique(facts)};
}
function suggestion(a,job){
 const task=tasks(a,job).find(t=>!['completed','review'].includes(t.status));
 return {code:'CHANGE_WORK_STRATEGY',taskId:task?.id||null,
  message:'当前尝试尚未形成有效成果。App 将复用已读资料、针对缺口改换证据或生成方式，并检查纠偏结果；不因次数阈值暂停委托。',
  alternatives:['programmatic_pagination','reuse_verification','finish_current_step','target_missing_evidence']};
}
function migrateProgress(a,job,state,current){
 if(state.progressVersion===1)return;
 const seen=rows(state.seen),adopted=tasks(a,job).flatMap(task=>task.steps.flatMap(step=>{
  const artifact=a.data.artifacts.find(r=>r.id===step.artifactId&&r.taskId===task.id&&r.origin==='user_import');
  return artifact&&seen.includes('artifact:'+evidence.hash(artifact.content))?[adoptionMilestone(task,step,artifact)]:[];
 }));
 const baseline=[...priorDrafts(a,job),...adopted,...current.facts.filter(f=>f.startsWith('content_verified:')||f.startsWith('verified:')&&seen.some(s=>s.startsWith('verified:')))];
 // strategy.ready uses legacy artifact hashes only as a probe before sync.
 // Remove them so a new verification/receipt on an unchanged draft is probed;
 // the stable milestones below still prevent that probe from crediting rewrites.
 state.seen=unique([...seen.filter(f=>!f.startsWith('artifact:')),...baseline]).slice(0,LIMITS.maxFacts);state.progressVersion=1;
}
function sync(a,job,{credit=true}={}){
 const current=snapshot(a,job);require('./operation-ledger.cjs').state(job);
 let state=job.executionState.workEfficiency;
 if(state&&(job.deletedAt||!require('./work-state.cjs').gate(a,job).automaticAllowed))return {state,changed:false};
 if(!state||state.intent!==current.intent){
  const prior=state;state=job.executionState.workEfficiency={version:2,progressVersion:1,intent:current.intent,seen:unique([...current.facts,...priorDrafts(a,job)]).slice(0,LIMITS.maxFacts),attempts:0,phase:'working',tried:{},history:[],updatedAt:now(),reason:prior?'new_user_requirements':'baseline'};
  return {state,changed:!!prior};
 }
 if(state.version!==2){
  state.version=2;state.tried ||= {};state.history ||= [];
  if(state.phase==='paused')state.phase='recovery_pending';
 }
 migrateProgress(a,job,state,current);
 const seen=new Set(state.seen),fresh=current.facts.filter(f=>!seen.has(f));
 if(fresh.length&&state.seen.length<LIMITS.maxFacts){
  state.seen.push(...fresh.slice(0,LIMITS.maxFacts-state.seen.length));
  if(!credit)return {state,changed:false};
  if(state.active){state.active.outcome='progress';state.active.finishedAt=now();state.history.push({...state.active,queue:undefined});state.history=state.history.slice(-24);}
  state.attempts=0;state.phase='working';state.reason='new_effective_output';state.lastProgressAt=now();if(job.executionState.recovery?.code==='AUTOMATIC_STRATEGY_REPAIR')job.executionState.recovery=null;delete state.suggestion;delete state.active;delete state.waitBasis;
  return {state,changed:true};
 }
 return {state,changed:false};
}
function status(state){return {allowed:!['recovery_pending','awaiting_change'].includes(state.phase),phase:state.phase,attempts:state.attempts,remainingAttempts:Math.max(0,LIMITS.stopAt-state.attempts),suggestion:state.suggestion||null,failure:state.lastFailure||null,triedStrategies:(state.history||[]).slice(-8).map(h=>({title:h.title,outcome:h.outcome,failure:h.failure})),failedActions:(state.history||[]).filter(h=>h.outcome!=='progress').flatMap(h=>h.executedActions||[]).slice(-8),strategy:state.active?{id:state.active.id,title:state.active.title,instruction:state.active.instruction}:null,code:state.phase==='recovery_pending'?'WORK_STRATEGY_CHANGE':null,requiresConfirmation:false,budgetUnchanged:true};}
function request(a,job,error={}){
 const {state}=sync(a,job);
 if(state.active){state.active.outcome='no_progress';state.active.finishedAt=now();state.active.failure=error.message||'替代策略未产生新证据或成果';state.history.push({...state.active,queue:undefined});state.history=state.history.slice(-24);delete state.active;}
 state.phase='recovery_pending';state.lastFailure={code:error.code||'NO_NEW_EVIDENCE',message:error.message||'已读取资料未形成有效进展',taskId:error.taskId||error.recoveryContext?.taskId||null,stage:error.recoveryContext?.stage||null};state.updatedAt=now();state.suggestion=suggestion(a,job);
 return status(state);
}
function before(a,job){return status(sync(a,job).state);}
function observe(a,job,step={}){
 const {state,changed}=sync(a,job,{credit:!['plan_task','revise_task','wait','ask','cancel_task','retire_output'].includes(step.tool)});
 if(['recovery_pending','awaiting_change'].includes(state.phase))return status(state);
 if(!changed)state.attempts++;
 state.updatedAt=now();state.lastTool=step.tool||null;
 if(state.active){
  if(step.tool!=='model_read_context')delete state.active.inFlight;
  if(step.tool==='model_read_context')state.active.reads=(state.active.reads||0)+1;
  else if((state.active.attempts=(state.active.attempts||0)+1)>=LIMITS.stopAt)return request(a,job,{message:'诊断策略仍未取得相关证据或有效成果，重新核对可执行条件',taskId:step.args?.taskId});
  else if(!state.active.queue?.length&&!state.active.planning)return request(a,job,{code:step.errorCode,message:step.error?'当前纠偏动作未成功：'+step.error:'当前纠偏策略已执行，但没有新增相关证据或有效成果',taskId:step.args?.taskId||step.args?.existingTaskId});
  if(state.active?.reads>=LIMITS.suggestAt)return request(a,job,{message:'当前纠偏策略仍反复请求资料，改换下一条可执行路径',taskId:step.args?.taskId});
 }else{
  if(state.attempts>=LIMITS.suggestAt){state.phase='change_strategy';state.suggestion=suggestion(a,job);}
  if(state.attempts>=LIMITS.stopAt)return request(a,job,{message:'连续尝试没有产生有效成果，正在自动诊断并切换推进方式',taskId:step.args?.taskId});
 }
 return status(state);
}
function inspect(job){return structuredClone(status(job.executionState?.workEfficiency||{phase:'working',attempts:0}));}
function view(a,job){return inspect(job);}
function readAttempt(a,job,{taskId}={}){
 if(taskId&&!tasks(a,job).some(t=>t.id===taskId))throw Error('读取尝试超出委托范围');
 return observe(a,job,{tool:'model_read_context',args:{taskId}});
}
function observeCall(a,job,{taskId,result}={}){return result?.kind==='read_context'?readAttempt(a,job,{taskId}):before(a,job);}
function assertAllowed(a,job){
 const result=before(a,job);
 if(!result.allowed)throw Object.assign(Error('正在自动纠偏：'+(job.executionState.workEfficiency.lastFailure?.message||'已保存资料，需要切换推进方式')),{code:result.code||'WORK_STRATEGY_WAIT',workEfficiency:true,noProgress:true,automaticRetry:false,requiresConfirmation:false});
 return result;
}
function next(a,job){const guard=before(a,job);return {...guard,action:guard.allowed?require('./execution-control.cjs').next(a,job):null};}
function initialize(a){
 for(const job of a.data.delegations){
  const old=job.executionState?.workEfficiency;
  if(old?.version===2&&old.active?.inFlight){
   old.active.outcome='interrupted';old.active.finishedAt=now();old.active.failure='上次纠偏动作已开始但未持久确认结果；先核对原执行记录，随后改用其他路径';
   old.history=[...(old.history||[]),{...old.active,queue:undefined}].slice(-24);delete old.active;old.phase='recovery_pending';
  }
  if(old?.version===1&&old.pausedByGuard&&job.status==='paused'&&job.summary?.startsWith('无有效成果的尝试已达到上限')){
   old.version=2;old.phase='recovery_pending';old.tried={};old.history=[];delete old.pausedByGuard;
   job.executionPaused=false;job.status='ready';job.nextRunAt=now();job.summary='已将无进展保护迁移为自动纠偏，将复用已有成果并切换执行策略';
  }
  if(old&&old.progressVersion!==1)migrateProgress(a,job,old,snapshot(a,job));
 }
}
module.exports={LIMITS,intent,snapshot,sync,request,before,observe,observeCall,readAttempt,view,inspect,assertAllowed,next,initialize};
