// plan_task's durable boundary for existing tasks. This is a fact projector,
// not a scheduler, permission authority, or second business-obligation ledger.
const evidence=require('./evidence-basis.cjs');
const links=require('./evidence-links.cjs');
const journal=require('./work-journal.cjs');
const TYPE='evidence_plan_committed';
const rows=value=>Array.isArray(value)?value:[];
const fail=(message,code)=>Object.assign(Error(message),{code});
const taskFields=['title','description','criteria','objective','priority','dependsOn','steps','planVersion','needsReplan','agentCancelled','primaryArtifactId','planResetBasis','planResetDiagnostic','lastEvidenceResolution','evidenceRequest','intake','status','previousStatus','waitingOn','nextCheckAt','followupDue','verification','contentVerification','completionCheck','lastError','updatedAt'];
const stepFields=['id','key','title','kind','tool','outputRole','targetArtifactId','artifactId','done','evidence','inputBasis','outputHash'];
const pick=(value,fields)=>Object.fromEntries(fields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,structuredClone(value[k])]));
const cleanStep=step=>pick(step,stepFields);
const stepState=step=>{const {title,...state}=cleanStep(step);return evidence.hash(state);};
function detached(a,data){
  // An execution view is a Proxy whose inherited set trap writes to the owner.
  // Never use Object.create(a): even draft.data/save would mutate the live App.
  const view=Object.create(Object.getPrototypeOf(a),Object.getOwnPropertyDescriptors(a));
  Object.defineProperty(view,'data',{value:data,writable:true,enumerable:true,configurable:true});return view;
}
function inputRefs(a,task){
  return links.bindings(a,task).filter(b=>b.purpose==='input'&&b.state!=='withdrawn').map(b=>pick(b,['sourceId','revisionId','resourceKey','contentHash','principalScope','state'])).sort((x,y)=>evidence.hash(x).localeCompare(evidence.hash(y)));
}
function inputsChanged(a,job,task,next){
  if(evidence.hash(inputRefs(a,task))!==evidence.hash(inputRefs(a,next)))return true;
  // Legacy steps can predate typed bindings. Their recorded basis still detects
  // an in-place source update, without treating observation timestamps as facts.
  const sources=evidence.taskSources(a,next);
  return rows(task.steps).some(s=>s.done&&s.kind!=='external'&&s.inputBasis?.sources&&evidence.hash(s.inputBasis.sources)!==evidence.hash(sources));
}
function diagnostic(task){
  const check=task.contentVerification?.passed===false?task.contentVerification:task.verification?.passed===false?task.verification:null;
  return check?{basis:check.basis,gaps:check.gaps,details:check.gapDetails}:task.planResetDiagnostic||null;
}
function request(args){
  const result=structuredClone(args);delete result.commandId;delete result.commitId;
  // Runtime receipts echoed by old planners are not command identity.
  if(Array.isArray(result.steps))result.steps=result.steps.map(s=>pick(s,['key','id','title','kind','tool','outputRole','targetArtifactId']));
  return result;
}
function identity(a,job,task,args){
  for(const key of ['commandId','commitId'])if(args[key]!==undefined&&(typeof args[key]!=='string'||!args[key].trim()||args[key].length>200))throw fail('计划命令身份无效','PLAN_INPUT_INVALID');
  const requestHash=evidence.hash({jobId:job.id,taskId:task.id,args:request(args)});
  // plan_task merges requested IDs with existing inputs. Identity must cover
  // that same effective set, including retained evidence updated in place.
  const selected=[...new Set([...rows(task.sourceIds),...rows(args.sourceIds)])].filter(id=>!rows(args.removeSourceIds).includes(id)).sort(),scope={workRevision:task.workRevision??1,jobWorkRevision:job.workRevision??1,requirementRevision:task.requirementRevision??null,contractRevision:job.executionContract?.revision??job.requirementRevision??null,
    sources:selected.map(id=>{const s=a.data.sources.find(s=>s.id===id);return {id,version:s?links.revision(s):null,contentHash:s?evidence.hash(s.content):null};}),
    ...(rows(args.resetSteps).length?{diagnostic:diagnostic(task)}:{}),
    ...(args.dueAt!==undefined?{deadlineRevision:task.deadlinePolicy?.deadlineRevision??0}:{})};
  const explicit=args.commitId||args.commandId;
  return {requestHash,scope,commitId:explicit?`plan_task:${explicit}`:`plan_task:${evidence.hash({requestHash,scope})}`};
}
function recover(a,job,task,args){
  const id=identity(a,job,task,args),events=journal.read(a).events;
  let prior=events.find(e=>e.commitId===id.commitId);
  if(!prior&&!args.commitId&&!args.commandId&&args.dueAt!==undefined){
    const dueAt=require('./date-time.cjs').optionalISO(args.dueAt,'截止时间'),withoutDeadline=s=>{const {deadlineRevision,...rest}=s;return rest;};
    if(task.dueAt===dueAt)prior=events.findLast(e=>e.type===TYPE&&e.entityId===task.id&&e.payload.requestHash===id.requestHash&&e.payload.deadlineAt===dueAt&&evidence.hash(withoutDeadline(e.payload.commandScope))===evidence.hash(withoutDeadline(id.scope)));
  }
  if(prior){
    if(prior.type!==TYPE||prior.entityId!==task.id||prior.payload.requestHash!==id.requestHash)throw fail('同一计划命令身份不能对应不同参数','WORK_JOURNAL_CONFLICT');
    // Replay committed facts even if a later user pause/revocation prevents new
    // work. Returning the old receipt grants no execution eligibility.
    if(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||(task.workEvent?.sequence||0)<prior.sequence)journal.replay(a);
    return structuredClone(prior.payload.result);
  }
  if(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending)journal.replay(a);
  return null;
}
function assertGuard(a,job,task){
  require('./execution-gate.cjs').assert(a,{job,task,readOnly:true});
  if(job.deletedAt||task.acceptedAt||task.status==='completed'||task.executionPaused)throw fail('工作已结束或暂停，须由用户明确重开','EXECUTION_GATE_CLOSED');
  if(a.readOnlyRecovery)throw fail('工作记录需要恢复','WORK_PROJECTION_PENDING');
  if(rows(a.data.agentActions).some(r=>(r.jobId===job.id||r.taskId===task.id)&&(['running','uncertain'].includes(r.status)||['unknown','uncertain'].includes(r.effectStatus))))throw fail('须先核对原外部动作结果','EXTERNAL_EFFECT_UNRESOLVED');
  // Unlike spend.check, inspection must neither create a scope nor mutate the
  // blocked record. Charges and unknown reservations remain solely spend-owned.
  if(a.spendError)throw fail(a.spendError,'SPEND_STORAGE_ERROR');
  const scopes=a.spendLedger?.scopes||a.data.spendMeter?.scopes||{};
  for(const key of ['job:'+job.id,'task:'+task.id]){
    const s=scopes[key];if(!s)continue;
    if(s.blocked||require('./spend.cjs').unsettled(s)>0||s.spentUSD+s.heldUSD>=s.limitUSD)throw fail('累计费用或未知用量需要核对','SPEND_LIMIT');
  }
}
function assertSources(a,job,task,bindings){
  const access=require('./protocol-access.cjs');
  const selected={...task,contextBindings:bindings,sourceIds:bindings.filter(b=>b.purpose==='input'&&b.state!=='withdrawn').map(b=>b.sourceId)};
  const view=detached(a,{...a.data,tasks:a.data.tasks.map(t=>t.id===task.id?selected:t)});
  if(a.dir&&a.requireContextAccessPolicy)access.initialize(view);
  const deleted=new Set(require('./source-deletions.cjs').replay({dir:a.dir,data:{sources:[],tasks:[],delegations:[],sourceDeletions:structuredClone(rows(a.data.sourceDeletions))}}).map(e=>e.sourceId));
  for(const b of bindings.filter(b=>b.purpose==='input'&&b.state==='active')){
    const s=a.data.sources.find(s=>s.id===b.sourceId);
    if(deleted.has(b.sourceId)||links.withdrawn(s)||!access.allowedObject(view,'source',s,job,selected))throw fail('引用来源已撤回或无读取权限','CONTEXT_SCOPE_DENIED');
    if(links.revision(s)!==b.revisionId||evidence.hash(s.content)!==b.contentHash||evidence.hash(links.principal(s))!==evidence.hash(b.principalScope))throw fail('来源版本已变化，请重新关联','CONTEXT_VERSION_CHANGED');
  }
}
function inspect(a,job,task){
  let blocked=null;
  try{assertGuard(a,job,task);assertSources(a,job,task,links.bindings(a,task));}catch(e){blocked={code:e.code||'EXECUTION_GATE_CLOSED',message:e.message};}
  const step=rows(task.steps).find(s=>!s.done),main=require('./deliverables.cjs').primary(a,task);
  return {version:1,taskId:task.id,workRevision:task.workRevision??1,contractRevision:job.executionContract?.revision??null,sourceBasis:evidence.hash(inputRefs(a,task)),primaryArtifactId:main?.id||task.primaryArtifactId||null,primaryHash:main?evidence.hash(main.content):null,
    projectionPending:!!(a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending||task.projectionPending),blocked,
    nextStepId:blocked||task.needsReplan||task.evidenceRequest?null:step?.id||null,lastCommitId:task.evidenceContinuation?.commitId||null};
}
function patch(before,after,fields){
  const set={},remove=[];
  for(const key of fields)if(evidence.hash(before[key])!==evidence.hash(after[key])){
    if(Object.hasOwn(after,key))set[key]=key==='steps'?after.steps.map(cleanStep):structuredClone(after[key]);else remove.push(key);
  }
  return {set,remove};
}
function applyPatch(target,delta){for(const k of delta.remove)delete target[k];Object.assign(target,structuredClone(delta.set));}
function invalidateChecks(task,event,checks){
  task.invalidatedChecks ||= [];
  for(const check of checks)if(!task.invalidatedChecks.some(c=>c.commitId===event.commitId&&c.kind===check.kind))task.invalidatedChecks.push({...structuredClone(check),commitId:event.commitId,invalidatedAt:event.at});
  task.verification=null;task.contentVerification=null;delete task.completionCheck;
}
function projectBindings(a,task,event){
  const p=event.payload;
  // Use the existing deletion authority, including when restoring an old backup.
  require('./source-deletions.cjs').replay(a);
  for(const b of p.withdrawals){
    const key=evidence.hash({sourceId:b.sourceId,purpose:b.purpose});task.contextWithdrawals ||= [];
    if(!task.contextWithdrawals.some(w=>w.key===key))task.contextWithdrawals.push({...b,key,eventId:event.eventId,sequence:event.sequence});
    task.withdrawnBindingIds=[...new Set([...rows(task.withdrawnBindingIds),b.bindingId])];
  }
  const withdrawn=b=>rows(task.withdrawnBindingIds).includes(b.bindingId)||rows(task.contextWithdrawals).some(w=>w.key===evidence.hash({sourceId:b.sourceId,purpose:b.purpose}));
  const current=rows(task.contextBindings),job=rows(a.data.delegations).find(j=>j.id===task.agentJobId);
  let unavailable=false;
  const saved=p.bindings.map(b=>{
    const next=structuredClone(b),source=a.data.sources.find(s=>s.id===b.sourceId);
    // Only references are restored. Revoked ACLs are never copied from the log;
    // protocol-access still decides whether any existing body can be read.
    if(withdrawn(b)||current.some(c=>c.sourceId===b.sourceId&&c.purpose===b.purpose&&c.state==='withdrawn')||!source||!rows(job?.sourceIds).includes(b.sourceId)||links.withdrawn(source)&&b.state!=='historical'){
      if(next.state==='active')unavailable=true;next.state='withdrawn';
    }else if(b.state==='active'&&(links.revision(source)!==b.revisionId||evidence.hash(source.content)!==b.contentHash||evidence.hash(links.principal(source))!==evidence.hash(b.principalScope))){next.state='historical';unavailable=true;}
    return next;
  });
  // Later withdrawal tombstones and delivery readbacks have their own authority.
  for(const b of current)if(!saved.some(s=>s.bindingId===b.bindingId)&&(b.state==='withdrawn'||b.purpose!=='input'))saved.push(b);
  task.contextBindings=saved;task.evidenceLinksVersion=3;links.project(task);
  if(unavailable)task.needsReplan='已提交计划的来源已删除或变化，请核对当前可用证据';
}
function projectEvent(a,task,event){
  if(Object.hasOwn(event.payload,'deadlineAt'))require('./deadline-events.cjs');
  if(!task||task.deletedAt||task.acceptedAt||task.status==='completed'||(task.workRevision??1)>event.workRevision)return;
  // Forced backup replay also encounters snapshots *after* a commit. Preserve
  // subsequent generation/check progress; do not reopen an already applied plan.
  if((task.evidenceContinuation?.sequence||0)>=event.sequence)return;
  const p=event.payload,oldSteps=rows(task.steps),paused=task.status==='paused'||task.executionPaused;
  const status=task.status,previousStatus=task.previousStatus,lastError=task.lastError;
  applyPatch(task,p.task);
  if(p.task.set.steps)task.steps=task.steps.map(s=>p.preservedStepIds.includes(s.id)?{...(oldSteps.find(old=>old.id===s.id)||s),title:s.title}:s);
  if(paused){task.status=status;task.previousStatus=previousStatus;task.lastError=lastError;}
  if(p.history&&!rows(task.planHistory).some(h=>h.commitId===event.commitId))task.planHistory=[...rows(task.planHistory),{...structuredClone(p.history),commitId:event.commitId}].slice(-20);
  projectBindings(a,task,event);if(p.invalidateChecks)invalidateChecks(task,event,p.invalidatedChecks);
  for(const change of p.dependents){
    const target=rows(a.data.tasks).find(t=>t.id===change.id);
    if(!target||target.deletedAt||target.acceptedAt||target.status==='completed'||(target.workRevision??1)!==change.workRevision)continue;
    const paused=target.status==='paused'||target.executionPaused,oldStatus=target.status;
    applyPatch(target,change.patch);if(paused)target.status=oldStatus;
    invalidateChecks(target,event,change.invalidatedChecks);
  }
  const job=rows(a.data.delegations).find(j=>j.id===task.agentJobId);
  if(job&&p.jobTitle!==undefined)job.title=p.jobTitle;
  for(const delta of p.decisions){const d=rows(a.data.decisions).find(d=>d.id===delta.id);if(d?.status==='open')applyPatch(d,delta.patch);}
  if(p.notice){a.data.events ||= [];if(!a.data.events.some(e=>e.id===p.notice.id)){a.data.events.unshift(structuredClone(p.notice));a.data.events=a.data.events.slice(0,2000);}}
  task.evidenceContinuation={version:1,commitId:event.commitId,sequence:event.sequence,sourceBasis:p.sourceBasis,affectedStepIds:p.affectedStepIds,at:event.at};
}
function checks(task){return ['verification','contentVerification','completionCheck'].filter(k=>task[k]).map(kind=>({kind,check:structuredClone(task[kind])}));}
function deadlineEvents(a,draft,task,dueAt){
  const protocol=require('./deadline-events.cjs');let state=structuredClone(protocol.state(a));const events=[];
  draft.tick=undefined;draft.executionOwner=draft;
  protocol.configure(draft,{read:()=>state,commit:({expectedRevision,state:next,type})=>{
    if((state.revision||0)!==expectedRevision)throw fail('截止工作记录已变化','DEADLINE_CONFLICT');
    state=structuredClone(next);events.push({entityKind:'task',entityId:task.id,workRevision:task.workRevision??1,type:'deadline_protocol',actor:'system',payload:{transition:type,state}});return {committed:true};
  }});
  protocol.setPolicy(draft,{taskId:task.id,input:{dueAt}});protocol.reconcile(draft,{jobId:task.agentJobId});return events;
}
function commit(a,job,task,args,{apply,withdrawals,inputsChanged:changedInputs,dueAt,deadline}){
  assertGuard(a,job,task);
  const identityBefore=identity(a,job,task,args),expectedRevision=a.data.runtime?.revision||0;
  const expectedEntities=[task,job].map(t=>({kind:t===job?'job':'task',id:t.id,workRevision:t.workRevision??1,eventId:t.workEvent?.eventId||null}));
  const primary=require('./deliverables.cjs').primary(a,task);
  // All fallible binding/plan work happens on a detached projection before append.
  const draft=detached(a,structuredClone(a.data));draft.save=()=>{};draft.event=()=>{};
  if(a.dir&&a.requireContextAccessPolicy)require('./protocol-access.cjs').initialize(draft);
  const next=draft.data.tasks.find(t=>t.id===task.id),nextJob=draft.data.delegations.find(j=>j.id===job.id);
  const result=apply(draft,nextJob,next);
  // The source ID may stay stable while its revision changes. Keep older typed
  // bindings as history; only the selected current version remains active.
  for(const b of next.contextBindings)if(b.purpose==='input'&&b.state==='active'){
    const s=draft.data.sources.find(s=>s.id===b.sourceId);
    if(s&&(links.revision(s)!==b.revisionId||evidence.hash(s.content)!==b.contentHash)){b.state='historical';b.bindingRevision=(b.bindingRevision||1)+1;}
  }
  links.project(next);
  result.steps=result.steps.map(cleanStep);result.commitId=identityBefore.commitId;
  const taskPatch=patch(task,next,taskFields),invalidated=task.planVersion!==next.planVersion?checks(task):[];
  const history=task.planVersion!==next.planVersion?structuredClone(next.planHistory.at(-1)):null;
  if(history)history.steps=history.steps.map(cleanStep);
  const payload={version:1,requestHash:identityBefore.requestHash,commandScope:identityBefore.scope,sourceBasis:evidence.hash(inputRefs(draft,next)),inputsChanged:changedInputs,
    primary:{artifactId:primary?.id||task.primaryArtifactId||null,hash:primary?evidence.hash(primary.content):null},task:taskPatch,bindings:structuredClone(next.contextBindings),withdrawals,history,
    affectedStepIds:next.steps.filter(s=>!s.done&&task.steps.some(old=>old.id===s.id&&evidence.hash(cleanStep(old))!==evidence.hash(cleanStep(s)))).map(s=>s.id),
    invalidateChecks:task.planVersion!==next.planVersion,preservedStepIds:next.steps.filter(s=>task.steps.some(old=>old.id===s.id&&stepState(old)===stepState(s))).map(s=>s.id),invalidatedChecks:invalidated,
    dependents:[],decisions:[],result};
  for(const target of a.data.tasks){
    if(target.id===task.id)continue;
    const after=draft.data.tasks.find(t=>t.id===target.id),delta=after&&patch(target,after,taskFields);
    if(delta&&(Object.keys(delta.set).length||delta.remove.length))payload.dependents.push({id:target.id,workRevision:target.workRevision??1,patch:delta,invalidatedChecks:checks(target)});
  }
  for(const old of rows(a.data.decisions)){
    const after=rows(draft.data.decisions).find(d=>d.id===old.id);
    if(after&&evidence.hash(old)!==evidence.hash(after))payload.decisions.push({id:old.id,patch:patch(old,after,['status','answer','answeredAt'])});
  }
  if(nextJob.title!==job.title)payload.jobTitle=nextJob.title;
  if(history)payload.notice={id:identityBefore.commitId,at:history.at,title:'Agent 调整了计划',detail:history.reason,taskId:task.id,kind:'info'};
  const events=[{entityKind:'task',entityId:task.id,workRevision:task.workRevision??1,type:TYPE,actor:'agent',basisRefs:{jobId:job.id,contractRevision:identityBefore.scope.contractRevision,primary:payload.primary},payload}];
  const handoff=require('./evidence-recovery.cjs').handoffEvent(draft,nextJob,next);
  if(handoff)events.push(handoff);
  if(deadline){payload.deadlineAt=dueAt;events.push(...deadlineEvents(a,draft,task,dueAt));}
  assertGuard(a,job,task);assertSources(a,job,task,next.contextBindings);
  if(evidence.hash(identity(a,job,task,args))!==evidence.hash(identityBefore)||primary&&evidence.hash(primary.content)!==payload.primary.hash)throw fail('计划提交依据已变化','STATE_STALE');
  const committed=require('./state-transitions.cjs').commit(a,receipt=>{
    journal.project(a,receipt);return structuredClone(payload.result);
  },{workEvents:events,commitId:identityBefore.commitId,expectedRevision,expectedEntities});
  if(deadline)require('./deadline-scheduler.cjs').arm(a);
  return committed;
}
journal.registerProjector(TYPE,projectEvent);
module.exports={TYPE,inputsChanged,inspect,recover,commit};
