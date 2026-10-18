// The scheduler owns durable execution handoff, not business retries or budget.
const crypto=require('node:crypto'),events=require('./deadline-events.cjs'),deadline=require('./deadline-state.cjs');
const journal=require('./work-journal.cjs'),execution=require('./execution.cjs');
const timers=new WeakMap(),listeners=new WeakMap();
const stamp=()=>new Date().toISOString();
function epoch(a){return execution.root(a).deadlineEpoch ||= crypto.randomUUID();}
function records(a){
  const result={};
  for(const event of journal.read(execution.root(a)).events)if(event.type==='deadline_execution')result[event.payload.operation.id]=event.payload.operation;
  return result;
}
function projectExecution(a,event){
  const operation=event.payload.operation;(a.data.deadlineExecutions ||= {})[operation.id]=structuredClone(operation);
}
function lookup(a,id,wake){
  const record=records(a)[id],task=record?.tasks.find(t=>t.id===wake.taskId&&t.workRevision===wake.workRevision);
  return task?{id,taskId:task.id,workRevision:task.workRevision,status:record.status}:null;
}
function saveExecution(a,operation){
  const old=records(a)[operation.id];if(JSON.stringify(old)===JSON.stringify(operation))return old;
  const task=a.data.tasks.find(t=>operation.tasks.some(row=>row.id===t.id));
  const anchor=task||operation.tasks[0];if(!anchor)throw Error('截止执行缺少事项归属');
  const last=journal.read(a).events.findLast(e=>e.entityKind==='task'&&e.entityId===anchor.id);
  journal.commit(a,[{entityKind:'task',entityId:anchor.id,workRevision:task?deadline.workRevision(task):last?.workRevision||anchor.workRevision,type:'deadline_execution',actor:'system',payload:{operation}}]);
  return operation;
}
function initialize(a){
  events.connectJournal(a);
  // Never reset committed policies from a restored workspace snapshot.
  for(const task of a.data.tasks)if(!task.deadlinePolicy)deadline.migrate(task);
  events.recover(a,{epoch:epoch(a),lookupOperation:(id,wake)=>lookup(a,id,wake)});
  for(const record of Object.values(records(a))) {
    projectExecution(a,{payload:{operation:record}});
    if(record.status==='started'&&record.epoch!==epoch(a)) {
      const id=`deadline-execution:${record.id}`;a.data.recoveryReviews ||= [];
      if(!a.data.recoveryReviews.some(r=>r.id===id))a.data.recoveryReviews.push({id,operationId:record.id,jobId:record.jobId,taskId:record.tasks[0]?.id,code:'DEADLINE_EXECUTION_INTERRUPTED',status:'open',message:'截止唤醒已交接；沿原执行记录核对进度，不重复创建截止操作。'});
    }
  }
  arm(a);
}
function reconcile(a,options={}) {
  if(a.readOnlyRecovery||a.data.runtime?.workJournalError)return [];
  // Compatibility for trusted legacy planners that still assign dueAt. Explicit
  // user updates use setPolicy and are journaled immediately at the IPC boundary.
  for(const task of a.data.tasks) {
    if(options.jobId&&task.agentJobId!==options.jobId)continue;
    if(task.deadlinePolicy&&task.dueAt!==task.deadlinePolicy.dueAt&&!(task.deadlinePolicy.origin==='legacy'&&task.dueAt===task.deadlinePolicy.legacyDueAt))events.setPolicy(a,{taskId:task.id,input:{dueAt:task.dueAt},now:options.now});
  }
  const result=events.reconcile(a,options);arm(a);return result;
}
function sourceCheck(a,task,job,now=Date.now()) {
  const due=(job?.followups||[]).filter(f=>f.status==='waiting'&&(!f.taskId||f.taskId===task.id)&&f.checkAt&&!f.checkedAt&&Date.parse(f.checkAt)<=now);
  const keys=new Set(due.flatMap(f=>f.watchKeys||[]));
  const watchers=(job?.watchers||[]).filter(w=>keys.has(w.key));
  const authorized=watchers.filter(w=>{try{require('./protocol-access.cjs').assertTool(a,job,w.tool,w.args||{});return true;}catch{return false;}});
  return authorized.length?{kind:'source_check',authorized:true,dueAt:due.map(f=>f.checkAt).sort()[0],watchKeys:authorized.map(w=>w.key)}:null;
}
function eligibility(a,wake) {
  const task=a.data.tasks.find(t=>t.id===wake.taskId);if(!task)return {allowed:false};
  const job=a.data.delegations.find(j=>j.id===task.agentJobId),view=events.context(a.data,task);
  const nextStep=view.waiting?sourceCheck(a,task,job):null;
  let gate={allowed:true};
  try{require('./execution-gate.cjs').assert(a,{job,task,automatic:true,readOnly:!!nextStep});if(!nextStep&&a.available){a.available('execute');a.available('verify');if(job)a.available('organize');}}catch(e){gate={allowed:false,reason:e.code||'execution_gate'};}
  if(job?.lastErrorAutomaticRetry===false)gate={allowed:false,reason:'manual_recovery'};
  const candidate=job&&require('./continuation-control.cjs').peek(a,job,task,{automatic:true});
  const identity=job&&require('./evidence-identity-preflight.cjs');
  const identityBlock=candidate?.identity?candidate:job&&identity.action(a,job,candidate?.action);
  if(identityBlock)gate={allowed:false,reason:identityBlock.reasonCode||identityBlock.reason};
  const local=candidate?.eligible&&candidate.action&&candidate.action.tool!=='platform_query'&&candidate.action.tool!=='planner';
  if(job?.status==='retry'&&job.nextRunAt&&Date.parse(job.nextRunAt)>Date.now()&&!local)gate={allowed:false,reason:'retry_due'};
  if(nextStep&&job){const watchers=(job.watchers||[]).filter(w=>nextStep.watchKeys.includes(w.key));if(watchers.some(w=>identity.action(a,job,{tool:w.tool,args:w.args})))gate={allowed:false,reason:'IDENTITY_SOURCE_WAIT'};}
  if(job&&(job.projectId&&require('./chat-streams.cjs').hasPending(a,job.projectId)||(a.data.connectors||[]).some(c=>(c.jobId===job.id||job.projectId&&c.projectId===job.projectId||(job.connectorIds||[]).includes(c.id))&&c.cursor?.token)))gate={allowed:false,reason:'source_batch_pending'};
  const hasNextStep=view.hasNextStep||!!nextStep;
  return {task,job,view,gate,nextStep,hasNextStep,allowed:gate.allowed&&hasNextStep&&!view.terminal&&!view.paused&&!view.review&&!view.invalidScope&&!view.archived};
}
function rawPending(a,job){return Object.values(events.state(a).wakeIntents).filter(w=>w.status==='pending'&&(job?w.jobId===job.id:!w.jobId));}
// Used by the existing Agent tick filter: only a legal due step may advance a
// future nextRunAt. A waiting job with no due source is not repeatedly launched.
function pending(a,job){return rawPending(a,job).filter(w=>eligibility(a,w).allowed).sort((x,y)=>deadline.stages[y.stage]-deadline.stages[x.stage]);}
function claimJob(a,job,operationId){
  const claims=[];
  for(const wake of rawPending(a,job)) {
    const e=eligibility(a,wake);if(!e.task||!e.allowed)continue;
    const claimed=events.claim(a,wake.id,{epoch:epoch(a),gate:e.gate,hasNextStep:e.hasNextStep,operationId,nextStep:e.nextStep,lookupOperation:(id,w)=>lookup(a,id,w)});
    if(claimed)claims.push({...claimed,nextStep:e.nextStep});
  }
  return claims;
}
function releaseClaims(a,claims){
  for(const wake of claims||[])events.release(a,wake.id,{epoch:epoch(a),lookupOperation:(id,w)=>lookup(a,id,w)});
}
function attachRun(a,run,claims){
  if(!claims?.length)return;
  const fresh=events.state(a).wakeIntents;
  for(const wake of claims) {
    const live=fresh[wake.id];if(!live||live.status==='cancelled')continue;
    const old=records(a)[wake.operationId];
    if(old&&old.runId!==run.id)throw Object.assign(Error('截止执行已交接，须恢复原操作'),{code:'DEADLINE_OPERATION_ATTACHED'});
    if(!old)saveExecution(a,{id:wake.operationId,runId:run.id,jobId:run.jobId||null,tasks:[{id:wake.taskId,workRevision:wake.workRevision}],status:'started',epoch:epoch(a),startedAt:run.startedAt||stamp()});
    else if(!old.tasks.some(t=>t.id===wake.taskId&&t.workRevision===wake.workRevision))saveExecution(a,{...old,tasks:[...old.tasks,{id:wake.taskId,workRevision:wake.workRevision}]});
    events.attach(a,wake.id,{epoch:epoch(a),operationId:wake.operationId,lookupOperation:(id,w)=>lookup(a,id,w)});
  }
  run.deadlineTasks=claims.map(w=>({id:w.taskId,workRevision:w.workRevision}));
}
function finishRun(a,run,claims,error){
  for(const id of new Set((claims||[]).map(w=>w.operationId))) {
    const record=records(a)[id];if(!record||record.status!=='started'||record.runId!==run.id)continue;
    saveExecution(a,{...record,status:error||run.error?'interrupted':'finished',resultStatus:run.status||null,finishedAt:run.finishedAt||stamp(),...(error?{errorCode:error.code||'EXECUTION_FAILED'}:{})});
  }
}
async function checkDueSources(a,job,claims){
  const keys=new Set(claims.flatMap(c=>c.nextStep?.watchKeys||[]));let changed=false;
  for(const watcher of [...job.watchers].filter(w=>keys.has(w.key))) {
    require('./execution-gate.cjs').assert(a,{job,automatic:true,readOnly:true});
    require('./protocol-access.cjs').assertTool(a,job,watcher.tool,watcher.args||{});
    const agent=require('./agent.cjs'),result=await agent.read(a,job,watcher.tool,watcher.args||{});
    const digest=require('./evidence-basis.cjs').hash(require('./tool-registry.cjs').facts(watcher.tool,result));
    if(digest!==watcher.hash){const updated=agent.watch(a,job,watcher.tool,watcher.args||{},result);changed ||= updated.businessChanged!==false;}
    else watcher.checkedAt=stamp();
  }
  for(const f of job.followups||[])if(f.status==='waiting'&&f.checkAt&&!f.checkedAt&&Date.parse(f.checkAt)<=Date.now()&&(f.watchKeys||[]).length&&(f.watchKeys||[]).every(k=>keys.has(k)))f.checkedAt=stamp();
  a.save();return changed;
}
function launchJob(a,job,{run=require('./agent.cjs').run,launch=execution.launch}={}) {
  const candidates=pending(a,job);if(!candidates.length)return false;
  const operationId=candidates[0].operationId,claims=claimJob(a,job,operationId);if(!claims.length)return false;
  try {
    launch(a,{jobId:job.id,automatic:true},`截止推进 · ${job.title}`,async view=>{
      const record={id:claims[0].operationId,jobId:job.id,startedAt:stamp(),status:'running'};
      try {
        if(!claims.every(c=>events.state(view).wakeIntents[c.id]?.status==='claimed'&&eligibility(view,c).allowed))return;
        // Source waits only read selected authorized due watchers. They never
        // run the planner or send a reminder message merely because time passed.
        const sources=claims.filter(c=>c.nextStep?.kind==='source_check');
        if(sources.length){attachRun(view,record,sources);await checkDueSources(view,job,sources);record.status='checked';}
        if(sources.length!==claims.length)await run(view,job.id,{check:false,operationId:record.id,deadlineClaims:claims});
        const actual=view.data.agentRuns?.find(r=>r.id===record.id)||record;finishRun(view,actual,claims);
      } catch(error){finishRun(view,record,claims,error);throw error;}
      finally{releaseClaims(view,claims);}
    });
    return true;
  } catch(error){releaseClaims(a,claims);throw error;}
}
function launchTask(a,task,wake){
  const e=eligibility(a,wake),claim=events.claim(a,wake.id,{epoch:epoch(a),gate:e.gate,hasNextStep:e.hasNextStep});if(!claim)return false;
  try {
    execution.launch(a,{taskId:task.id,automatic:true},`截止推进 · ${task.title}`,async view=>{
      const record={id:claim.operationId,startedAt:stamp(),status:'running'};
      try{if(events.state(view).wakeIntents[claim.id]?.status!=='claimed'||!eligibility(view,claim).allowed)return;attachRun(view,record,[claim]);await view.advance(task.id);record.status='finished';finishRun(view,record,[claim]);}
      catch(error){finishRun(view,record,[claim],error);throw error;}
      finally{releaseClaims(view,[claim]);}
    });return true;
  }catch(error){releaseClaims(a,[claim]);throw error;}
}
function tick(a){
  if(a.readOnlyRecovery||a.data.runtime?.workJournalError)return false;
  // In-process launch failures before the callback ran are released as well.
  for(const wake of Object.values(events.state(a).wakeIntents))if(wake.status==='claimed'&&wake.epoch===epoch(a)&&!execution.conflict(a,{taskId:wake.taskId,jobId:wake.jobId}))events.release(a,wake.id,{epoch:epoch(a),lookupOperation:(id,w)=>lookup(a,id,w)});
  let started=false;
  const urgency=job=>Math.max(0,...a.data.tasks.filter(t=>t.agentJobId===job.id).map(t=>deadline.effectivePriority(t).urgency));
  const jobs=[...a.data.delegations].sort((x,y)=>urgency(y)-urgency(x));
  for(const job of jobs)if(!execution.conflict(a,{jobId:job.id})&&launchJob(a,job))started=true;
  if(a.data.settings.automatic)for(const wake of pending(a)) {
    const task=a.data.tasks.find(t=>t.id===wake.taskId);if(task&&!execution.conflict(a,{taskId:task.id})&&launchTask(a,task,wake))started=true;
  }
  return started;
}
function subscribe(a,callback){const root=execution.root(a);listeners.set(root,callback);return ()=>listeners.delete(root);}
function arm(a){
  const root=execution.root(a),boundary=events.nextBoundary(root.data),old=timers.get(root);
  if(old?.boundary===boundary)return;clearTimeout(old?.timer);
  if(!boundary){timers.delete(root);return;}
  const timer=setTimeout(()=>{timers.delete(root);try{root.tick();listeners.get(root)?.();}catch(error){root.event?.('截止安排需要核对',error.message,null,'error');}},Math.min(2147483647,Math.max(1,Date.parse(boundary)-Date.now())));
  timer.unref?.();timers.set(root,{timer,boundary});
}
function dispose(a){const root=execution.root(a);clearTimeout(timers.get(root)?.timer);timers.delete(root);listeners.delete(root);}
function notify(a,{Notification,focused=false,onClick=()=>{}}){
  if(a.readOnlyRecovery||a.data.runtime?.workJournalError||focused||!Notification.isSupported())return {count:0};
  const attention=require('./attention.cjs'),pending=attention.pendingNotifications(a);
  if(!pending.count)return {count:0};
  const deadlines=pending.items.filter(i=>i.eventId),other=pending.items.filter(i=>!i.eventId);
  const attempts=events.beginNotifications(a,deadlines,{epoch:epoch(a)}),count=attempts.length+other.length;
  if(!count)return {count:0};
  try {
    const notification=new Notification({title:'行知助手需要你关注',body:`${count} 项工作有新的待处理进展，点击查看关注中心。`});
    notification.on('click',onClick);notification.show();
    events.finishNotifications(a,attempts,{status:'submitted'});attention.markNotified(a,other);
    return {count,status:'submitted'};
  }catch(error){events.finishNotifications(a,attempts,{status:'uncertain'});return {count,status:'uncertain'};}
}
module.exports={epoch,records,projectExecution,lookup,initialize,reconcile,sourceCheck,eligibility,pending,claimJob,releaseClaims,attachRun,finishRun,launchJob,tick,subscribe,arm,dispose,notify};
