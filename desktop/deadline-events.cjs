// T6 domain protocol. The parent installs the independent work-journal adapter:
// configure(a, {read: () => state, commit: ({expectedRevision,state,type}) =>
//   ({committed:true, ...receipt})}). commit must fsync before returning and CAS
// expectedRevision. Each state contains events, card state and wake obligations
// in ONE batch. a.save is only the workspace projection after that commit.
// Parent integration (all calls synchronous; now is epoch milliseconds):
// 1. require this module BEFORE work-journal replay (projector registered below).
// 2. After replay: connectJournal(a); recover(a,{epoch,lookupOperation}).
// 3. tick BEFORE canAutomate: reconcile(a); nextBoundary(a.data) -> ISO | null.
// 4. Object.values(state(a).wakeIntents).filter(w=>w.status==='pending').
//    claim(a,id,{epoch,gate:{allowed,reason},hasNextStep,operationId?}) -> wake|null.
//    Idempotently persist an execution operation with the returned operationId;
//    attach(a,id,{epoch,operationId,lookupOperation}). On enqueue failure call
//    release(a,id,{epoch,lookupOperation}); it checks before returning to pending.
//    lookupOperation(id,wake) -> {id,taskId,workRevision,...} | null. Use the
//    independent execution ledger, not a transient run or workspace-only flag.
// 5. beginNotifications(a,items,{epoch}) -> attempts; call the OS outside commits;
//    finishNotifications(a,attempts,{status:'submitted'|'failed'|'uncertain'}).
// 6. setPolicy(a,{taskId,input,expectedRevision}) journals changes; a terminal or
//    cancelled wake never cancels an already dispatched external operation.
// Without an adapter, local UI compatibility uses workspace saves; claiming a
// wake is deliberately disabled until the independent journal is connected.
const crypto=require('node:crypto');
const deadlines=require('./deadline-state.cjs');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows=value=>Array.isArray(value)?value.filter(v=>v!==null&&v!==undefined):[];
const adapters=new WeakMap();
const owner=a=>a.executionOwner||a;
const empty=()=>({version:3,revision:0,events:{},wakeIntents:{},notificationAttempts:{},acknowledgements:{},snoozes:{},policies:{}});
const iso=time=>new Date(time).toISOString();
function configure(a,adapter) {
  if(typeof adapter?.read!=='function'||typeof adapter?.commit!=='function')throw Error('截止工作记录适配器须提供 read/commit');
  adapters.set(owner(a),adapter);const saved=adapter.read();if(saved)a.data.deadlineState=structuredClone(saved);
}
function state(a) {return adapters.get(owner(a))?.read() || a.data.deadlineState || empty();}
function applyState(a,current) {
  a.data.deadlineState=structuredClone(current);
  for(const task of rows(a.data.tasks)) {
    const saved=current.policies?.[task.id];
    if(saved&&saved.workRevision===deadlines.workRevision(task)){task.deadlinePolicy=structuredClone(saved.policy);task.dueAt=saved.policy.origin==='legacy'&&Object.hasOwn(saved.policy,'legacyDueAt')?saved.policy.legacyDueAt:saved.policy.dueAt;}
  }
}
function project(a) {const current=state(a);applyState(a,current);return current;}
function connectJournal(a) {
  a=owner(a);
  const journal=require('./work-journal.cjs');
  journal.registerProjector('deadline_protocol', (owner,_task,event)=>applyState(owner,event.payload.state));
  const read=()=>journal.read(a).events.findLast(event=>event.type==='deadline_protocol')?.payload.state||empty();
  configure(a,{read,markPending:(receipt,error)=>journal.markPending(a,receipt,error),commit:({expectedRevision,state:next,type})=>{
    if((read()?.revision||0)!==expectedRevision)throw Object.assign(Error('截止工作记录已变化'),{code:'DEADLINE_CONFLICT'});
    const target=rows(a.data.tasks).find(t=>Object.values(next.events).some(e=>e.taskId===t.id))||rows(a.data.tasks)[0];
    const historical=Object.values(next.events).at(-1);
    if(!target&&!historical)throw Error('截止工作记录缺少事项归属');
    const entityId=target?.id||historical.taskId;
    const workRevision=target?deadlines.workRevision(target):journal.read(a).events.findLast(e=>e.entityKind==='task'&&e.entityId===entityId)?.workRevision||historical.workRevision;
    const receipt=journal.append(a,[{entityKind:'task',entityId,workRevision,type:'deadline_protocol',actor:'system',payload:{transition:type,state:next}}]);
    try{journal.project(a,receipt);}catch(error){journal.markPending(a,receipt,error);throw error;}
    return receipt;
  }});
  project(a);
}
function setPolicy(a,{taskId,input,expectedRevision,now=Date.now()}) {
  const task=rows(a.data.tasks).find(t=>t.id===taskId);if(!task)throw Error('事项不存在');
  const current=deadlines.policy(task);
  if(expectedRevision!==undefined&&current.deadlineRevision!==expectedRevision)throw Error('截止安排已变化，请刷新');
  const updated=structuredClone(task),policy=deadlines.updatePolicy(updated,input);
  if(JSON.stringify(current)===JSON.stringify(policy))return policy;
  return transact(a,'deadline.policy',store=>{
    (store.policies ||= {})[taskId]={workRevision:deadlines.workRevision(task),policy};
    reconcileInto({...a.data,tasks:a.data.tasks.map(t=>t.id===taskId?updated:t)},store,now);
    return policy;
  });
}
function transact(a,type,change) {
  const current=state(a),next=structuredClone(current),result=change(next);
  if(JSON.stringify(current)===JSON.stringify(next))return result;
  next.revision=(current.revision||0)+1;
  const adapter=adapters.get(owner(a)),undo=require('./state-transitions.cjs').snapshot(a.data);
  let receipt;
  try {
    if(adapter){receipt=adapter.commit({expectedRevision:current.revision||0,state:structuredClone(next),type});if(receipt?.then||receipt?.committed!==true)throw Error('截止工作记录未确认同步提交');}
    applyState(a,next);
    a.save();
  } catch(error) {
    if(receipt?.committed||error.committed) {
      applyState(a,adapter?.read()||next);
      if(receipt)adapter?.markPending?.(receipt,error);
      error.committed=true;error.projectionPending=true;
    } else undo();
    throw error;
  }
  if(typeof owner(a).tick==='function')require('./deadline-scheduler.cjs').arm(owner(a));
  return result;
}
function context(data,task,now=Date.now()) {
  const job=rows(data.delegations).find(j=>j.id===task.agentJobId);
  const project=rows(data.projects).find(p=>p.id===(task.projectId||job?.projectId));
  const projectId=task.projectId||job?.projectId;
  const invalidScope=!!(task.agentJobId&&!job||projectId&&!project||task.projectId&&job&&task.projectId!==(job.projectId||''));
  const terminal=deadlines.resolved(task)||(job&&deadlines.resolved(job));
  const paused=task.status==='paused'||job?.status==='paused'||job?.executionPaused===true;
  const review=task.status==='review'||job?.status==='review';
  const blocked=['needs_input','approval','limited','blocked'];
  const decisions=rows(data.decisions).filter(d=>d.status==='open'&&(rows(d.taskIds).includes(task.id)||job&&d.jobId===job.id&&!rows(d.taskIds).length));
  const actions=rows(data.agentActions).filter(r=>['pending','running','uncertain'].includes(r.status)&&(r.taskId===task.id||job&&r.jobId===job.id&&!r.taskId));
  const waiting=task.status==='waiting'||rows(job?.followups).some(f=>f.status==='waiting'&&(!f.taskId||f.taskId===task.id));
  const specificBlock=blocked.includes(task.status)||blocked.includes(job?.status)||decisions.length>0||actions.length>0||waiting;
  const steps=rows(task.steps),nextStep=steps.find(s=>!s.done);
  const dependenciesReady=rows(task.dependsOn).every(id=>rows(data.tasks).some(t=>t.id===id&&t.status==='completed'&&!t.agentCancelled));
  // Preparing/verifying a delivery is a legal next step; this does not approve
  // its external write. The scheduler still supplies the action-level gate.
  const knownNext=nextStep?nextStep.kind!=='manual'&&nextStep.tool!=='manual':steps.length>0&&task.verification?.passed!==true;
  const hasNextStep=!terminal&&!paused&&!review&&!specificBlock&&dependenciesReady&&knownNext;
  const pauseReason=paused?(task.pauseReason||job?.pauseReason||job?.summary||'用户已暂停工作'):null;
  // Only structural conditions, never timestamps, poll counters or prose.
  const condition=hash([paused,review,blocked.includes(task.status)?task.status:null,blocked.includes(job?.status)?job.status:null,task.requirementRevision||null,decisions.map(d=>d.id).sort(),actions.map(r=>[r.id,r.status]).sort(),waiting,hasNextStep]);
  return {job,terminal,invalidScope,paused,review,specificBlock,hasNextStep,waiting,pauseReason,archived:!!project?.archivedAt,condition,decisionIds:decisions.map(d=>d.id),actionIds:actions.map(r=>r.id)};
}
function legacyRecord(data,task,ctx,evaluated) {
  if(task.deadlinePolicy&&task.deadlinePolicy.origin!=='legacy'||deadlines.workRevision(task)!==1)return null;
  const owner=task.projectId||ctx.job?.projectId||'',paused=ctx.paused;
  const revision=hash([`deadline:${task.id}`,'deadline',evaluated.stage==='overdue'?'critical':'warning',task.title,evaluated.stage==='overdue'?'事项已超过截止时间。':'事项将在 24 小时内到期。',owner,[evaluated.dueAt,task.status,task.priority],{paused,deadlineAt:evaluated.dueAt}]);
  const record=rows(data.attentionRecords).find(r=>r.id===`deadline:${task.id}`&&r.revision===revision);
  return record?{...record,notified:record.notifiedKey===hash([revision,record.snoozedUntil||null])}:null;
}
function describe(stage) {return stage==='overdue'?'事项已超过截止时间。':stage==='imminent'?'事项即将到达截止时间。':'事项已进入临期提醒阶段。';}
function view(data,task,now=Date.now()) {
  const savedPolicy=data.deadlineState?.policies?.[task.id];
  if(savedPolicy?.workRevision===deadlines.workRevision(task))task={...task,deadlinePolicy:savedPolicy.policy};
  const ctx=context(data,task,now),evaluated=deadlines.evaluate(task,now);
  if(ctx.terminal)evaluated.stage='resolved';
  const store=data.deadlineState||empty(),stageKey=deadlines.stageKey(task,evaluated);
  const snooze=store.snoozes[stageKey],generation=snooze?.generation||0,id=deadlines.eventKey(task,evaluated,generation);
  const riskKey=hash([stageKey,ctx.condition]),saved=store.events[id];
  const legacy=legacyRecord(data,task,ctx,evaluated);
  const event=saved||{id,taskId:task.id,jobId:ctx.job?.id||null,workRevision:evaluated.workRevision,deadlineRevision:evaluated.deadlineRevision,stage:evaluated.stage,stageKey,snoozeGeneration:generation,status:'active',readAt:legacy?.readAt||null,snoozeUntil:snooze?.until||legacy?.snoozedUntil||null,legacyNotified:legacy?.notified||false};
  const active=deadlines.stages[evaluated.stage]>0&&!ctx.terminal&&!ctx.invalidScope&&event.status!=='cancelled';
  const acknowledged=!!store.acknowledgements[riskKey];
  const legacyNotified=(!task.deadlinePolicy||task.deadlinePolicy.origin==='legacy')&&deadlines.workRevision(task)===1&&rows(ctx.job?.deadlineNotices).includes(`${task.id}:${task.dueAt}:${evaluated.stage}`);
  return {...evaluated,...ctx,active,event,stageKey,riskKey,acknowledged,legacyNotified,legacyAttentionRevision:!saved?legacy?.revision:null,
    needsDecision:active&&evaluated.stage==='overdue'&&!ctx.hasNextStep&&!ctx.review&&!acknowledged,
    detail:describe(evaluated.stage),state:event.snoozeUntil&&Date.parse(event.snoozeUntil)>now?'snoozed':event.readAt?'read':'unread'};
}
function projectedData(a) {return {...a.data,deadlineState:state(a)};}
function reconcileInto(data,store,now,{jobId}={}) {
  const current=new Map();
  for(const task of rows(data.tasks)) {
    if(jobId&&task.agentJobId!==jobId)continue;
    if(task.deadlinePolicy&&(task.deadlinePolicy.dueAt||task.deadlinePolicy.precision==='date'||store.policies?.[task.id])&&(!store.policies?.[task.id]||store.policies[task.id].workRevision!==deadlines.workRevision(task)))(store.policies ||= {})[task.id]={workRevision:deadlines.workRevision(task),policy:structuredClone(task.deadlinePolicy)};
    const v=view({...data,deadlineState:store},task,now);
    if(!v.active)continue;
    const event=store.events[v.event.id] ||= {...v.event,createdAt:iso(now),legacyNotified:v.legacyNotified||v.event.legacyNotified};
    current.set(event.id,event);
    const wakeId=`wake:${v.stageKey}`;
    const wake=store.wakeIntents[wakeId] ||= {id:wakeId,eventId:event.id,taskId:task.id,jobId:v.job?.id||null,workRevision:v.workRevision,deadlineRevision:v.deadlineRevision,stage:v.stage,stageKey:v.stageKey,status:'pending',operationId:`deadline:${v.stageKey}`,createdAt:iso(now)};
    wake.eventId=event.id;
    if(wake.status==='pending') {
      const reason=v.archived?'project_active':v.paused?'resume':v.specificBlock?'business_block_resolved':!v.hasNextStep?'legal_next_step':null;
      if(reason)wake.retryCondition=reason;
      else if(!wake.retryCondition||['project_active','resume','business_block_resolved','legal_next_step'].includes(wake.retryCondition))wake.retryCondition='execution_gate';
    }
  }
  for(const event of Object.values(store.events))if(event.status==='active'&&(!jobId||event.jobId===jobId)&&!current.has(event.id))Object.assign(event,{status:'cancelled',cancelledAt:iso(now)});
  const liveStages=new Set([...current.values()].map(e=>e.stageKey));
  for(const wake of Object.values(store.wakeIntents))if(wake.status!=='cancelled'&&(!jobId||wake.jobId===jobId)&&!liveStages.has(wake.stageKey))Object.assign(wake,{status:'cancelled',cancelledAt:iso(now),retryCondition:null});
  return [...current.values()];
}
function reconcile(a,{now=Date.now(),jobId}={}) {return transact(a,'deadline.reconcile',store=>reconcileInto(a.data,store,now,{jobId}));}
function currentEvent(a,store,id,now) {
  const old=store.events[id],task=rows(a.data.tasks).find(t=>t.id===old?.taskId);
  if(!task)throw Error('截止提醒已变化或已解决');
  const v=view({...a.data,deadlineState:store},task,now);
  if(!v.active||v.event.id!==id||old.status!=='active')throw Error('截止提醒已变化或已解决');
  return v;
}
function act(a,{taskId,eventId,action,minutes,riskKey,now=Date.now()}) {
  if(!['read','unread','acknowledge','snooze','unsnooze'].includes(action))throw Error('未知截止提醒操作');
  if(action==='snooze'&&![30,120,1440].includes(minutes))throw Error('稍后提醒须为 30 分钟、2 小时或明天');
  return transact(a,`deadline.${action}`,store=>{
    reconcileInto(a.data,store,now);
    const task=rows(a.data.tasks).find(t=>t.id===taskId);
    if(!task)throw Error('事项不存在');
    const v=view({...a.data,deadlineState:store},task,now);
    if(!v.active||eventId&&eventId!==v.event.id)throw Error('截止提醒已变化或已解决');
    const event=store.events[v.event.id];
    if(action==='acknowledge') {
      if(riskKey&&riskKey!==v.riskKey)throw Error('截止风险条件已变化');
      store.acknowledgements[v.riskKey] ||= {taskId,workRevision:v.workRevision,deadlineRevision:v.deadlineRevision,stage:v.stage,at:iso(now)};
    } else if(action==='read')event.readAt=iso(now);
    else if(action==='unread')event.readAt=null;
    else {
      // A snooze has a new notification event but shares the same wake intent.
      store.snoozes[v.stageKey]={generation:(store.snoozes[v.stageKey]?.generation||0)+1,until:action==='snooze'?iso(now+minutes*60000):null};
      reconcileInto(a.data,store,now);
    }
    return {saved:true,modelCalls:0,networkRequests:0};
  });
}
function pendingNotifications(a,{now=Date.now()}={}) {
  const data=projectedData(a),store=data.deadlineState,items=[];
  for(const task of rows(data.tasks)) {
    const v=view(data,task,now),attempt=store.notificationAttempts[v.event.id];
    if(!v.active||v.archived||!v.notify||v.state!=='unread'||v.acknowledged||v.legacyNotified||v.event.legacyNotified||attempt)continue;
    items.push({id:`deadline:${task.id}`,revision:v.event.id,eventId:v.event.id,notificationKey:v.event.id,title:task.title,severity:v.stage==='overdue'?'critical':'warning'});
  }
  return {count:items.length,items};
}
function beginNotifications(a,items,{epoch,now=Date.now()}={}) {
  if(typeof epoch!=='string'||!epoch)throw Error('通知提交须提供进程 epoch');
  const eligible=new Set(pendingNotifications(a,{now}).items.map(x=>x.eventId));
  return transact(a,'deadline.notification_prepared',store=>{
    reconcileInto(a.data,store,now);const prepared=[];
    for(const item of items)if(eligible.has(item.eventId)&&!store.notificationAttempts[item.eventId]) {
      const attempt={id:`notification:${item.eventId}`,eventId:item.eventId,status:'prepared',epoch,at:iso(now)};
      store.notificationAttempts[item.eventId]=attempt;prepared.push(attempt);
    }
    return prepared;
  });
}
function finishNotifications(a,attempts,{status='submitted',now=Date.now()}={}) {
  if(!['submitted','failed','uncertain'].includes(status))throw Error('通知提交状态无效');
  return transact(a,'deadline.notification_result',store=>{
    let count=0;
    for(const input of attempts) {
      const attempt=store.notificationAttempts[input.eventId];
      if(attempt?.id===input.id&&attempt.status==='prepared'){Object.assign(attempt,{status,finishedAt:iso(now)});count++;}
    }
    return count;
  });
}
function markNotified(a,items,{now=Date.now()}={}) {
  const pending=pendingNotifications(a,{now}).items.filter(x=>items.some(item=>item.eventId===x.eventId&&item.revision===x.revision&&item.notificationKey===x.notificationKey));
  if(!pending.length)return 0;
  const attempts=beginNotifications(a,pending,{epoch:'legacy-notification-caller',now});
  return finishNotifications(a,attempts,{now});
}
function claim(a,id,{epoch,gate,hasNextStep,operationId,nextStep,lookupOperation,now=Date.now()}={}) {
  if(!adapters.has(owner(a)))throw Object.assign(Error('须先接入独立工作记录再领取截止唤醒'),{code:'DEADLINE_JOURNAL_REQUIRED'});
  if(typeof epoch!=='string'||!epoch)throw Error('唤醒领取须提供进程 epoch');
  return transact(a,'deadline.wake_claimed',store=>{
    reconcileInto(a.data,store,now);const wake=store.wakeIntents[id];
    if(!wake||wake.status!=='pending')return null;
    const v=currentEvent(a,store,wake.eventId,now);
    if(v.archived||v.paused||v.review||gate?.allowed!==true||hasNextStep!==true) {
      wake.retryCondition=v.archived?'project_active':v.paused?'resume':v.review?'acceptance':gate?.reason||'legal_next_step';return null;
    }
    const task=rows(a.data.tasks).find(t=>t.id===wake.taskId);
    if(['needs_input','approval','limited','blocked'].includes(task?.status)||['needs_input','approval','limited','blocked'].includes(v.job?.status)||v.decisionIds.length||v.actionIds.length&&!operationId){wake.retryCondition='business_block_resolved';return null;}
    if(v.waiting&&(nextStep?.kind!=='source_check'||nextStep.authorized!==true||!Number.isFinite(Date.parse(nextStep.dueAt))||Date.parse(nextStep.dueAt)>now)){wake.retryCondition='authorized_source_check_due';return null;}
    const selectedId=wake.operationBound?wake.operationId:operationId||wake.operationId;
    if(require('./execution.cjs').conflict(a,{taskId:wake.taskId,jobId:wake.jobId})) {
      const existing=lookupOperation?.(selectedId,wake);
      if(!existing||existing.id!==selectedId||existing.taskId!==wake.taskId||existing.workRevision!==wake.workRevision){wake.retryCondition='execution_in_flight';return null;}
    }
    // Once claimed, even an enqueue failure cannot replace its operation ID.
    // Callers must enqueue the RETURNED identity, not a newly generated run ID.
    Object.assign(wake,{status:'claimed',epoch,claimedAt:iso(now),retryCondition:null,operationId:selectedId,operationBound:true});
    return structuredClone(wake);
  });
}
function attach(a,id,{epoch,operationId,lookupOperation,now=Date.now()}={}) {
  return transact(a,'deadline.wake_attached',store=>{
    reconcileInto(a.data,store,now);const wake=store.wakeIntents[id];
    if(wake?.status==='attached'&&wake.operationId===operationId)return structuredClone(wake);
    if(!wake||wake.status!=='claimed'||wake.epoch!==epoch||wake.operationId!==operationId)return null;
    const operation=lookupOperation?.(operationId,wake);
    if(!operation||operation.id!==operationId||operation.taskId!==wake.taskId||operation.workRevision!==wake.workRevision)throw Error('执行账本尚未保存对应事项和工作修订的操作');
    Object.assign(wake,{status:'attached',attachedAt:iso(now)});return structuredClone(wake);
  });
}
function release(a,id,{epoch,lookupOperation,now=Date.now()}={}) {
  if(typeof lookupOperation!=='function')throw Error('释放唤醒前须核对执行账本');
  return transact(a,'deadline.wake_released',store=>{
    reconcileInto(a.data,store,now);const wake=store.wakeIntents[id];
    if(wake?.status!=='claimed'||wake.epoch!==epoch)return null;
    const operation=lookupOperation(wake.operationId,wake);
    if(operation) {
      if(operation.id!==wake.operationId||operation.taskId!==wake.taskId||operation.workRevision!==wake.workRevision)throw Error('截止唤醒操作归属不匹配');
      Object.assign(wake,{status:'attached',attachedAt:iso(now)});
    } else Object.assign(wake,{status:'pending',epoch:null,retryCondition:'execution_gate'});
    return structuredClone(wake);
  });
}
function recover(a,{epoch,lookupOperation,now=Date.now()}={}) {
  if(typeof epoch!=='string'||!epoch||typeof lookupOperation!=='function')throw Error('唤醒恢复须提供 epoch 和执行账本查询');
  return transact(a,'deadline.recover',store=>{
    reconcileInto(a.data,store,now);
    for(const attempt of Object.values(store.notificationAttempts))if(attempt.status==='prepared'&&attempt.epoch!==epoch)Object.assign(attempt,{status:'uncertain',recoveredAt:iso(now)});
    for(const wake of Object.values(store.wakeIntents))if(wake.status==='claimed'&&wake.epoch!==epoch) {
      const operation=lookupOperation(wake.operationId,wake);
      if(operation) {
        if(operation.id!==wake.operationId||operation.taskId!==wake.taskId||operation.workRevision!==wake.workRevision)throw Error('截止唤醒操作归属不匹配');
        Object.assign(wake,{status:'attached',attachedAt:iso(now)});
      } else Object.assign(wake,{status:'pending',epoch:null,retryCondition:'execution_gate'});
    }
    return structuredClone(store);
  });
}
function pendingCards(data,baseCards,now=Date.now()) {
  const cards=baseCards.map(card=>({...card}));
  for(const task of rows(data.tasks)) {
    const v=view(data,task,now);if(v.terminal||v.archived||v.invalidScope)continue;
    if(v.needsTime) {
      const id=`deadline-time:${hash([task.id,v.workRevision,v.deadlineRevision])}`;
      if(!cards.some(c=>c.id===id))cards.push({id,kind:'deadline_time',category:'progress',taskId:task.id,jobId:v.job?.id||null,jobTitle:task.title,question:'截止日期已记录，请选择具体时刻或保留仅日期。',route:{page:'board',taskId:task.id},nextActions:['choose_time','keep_date_only']});
    }
    if(!v.active)continue;
    const risk={taskId:task.id,eventId:v.event.id,stage:v.stage,deadlineAt:v.dueAt,riskKey:v.riskKey,acknowledged:v.acknowledged,decisionId:`deadline-risk:${v.riskKey}`};
    const related=cards.filter(c=>c.kind!=='deadline'&&(c.taskId===task.id||rows(c.taskIds).includes(task.id)||rows(c.tasks).some(t=>t.id===task.id)||v.job&&c.jobId===v.job.id&&!c.taskId&&!rows(c.taskIds).length));
    // Preserve all distinct underlying decisions. Risk acknowledgement cannot
    // remove or answer any permission, cost, approval or acceptance node.
    if(related.length){for(const card of related)card.deadlineRisks=[...(card.deadlineRisks||[]).filter(old=>old.taskId!==task.id),risk];continue;}
    if(v.needsDecision&&!cards.some(c=>c.id===risk.decisionId))cards.push({id:risk.decisionId,decisionId:risk.decisionId,kind:'deadline',category:'progress',taskId:task.id,jobId:v.job?.id||null,jobTitle:task.title,question:'截止时间已过，请确认接下来的安排。',context:v.pauseReason||v.detail,paused:v.paused,revision:v.event.id,deadlineRisks:[risk],route:{page:'board',taskId:task.id},nextActions:['adjust_deadline','confirm_scope','pause','custom','acknowledge']});
  }
  return cards;
}
function nextBoundary(data,now=Date.now()) {
  const times=[];
  for(const task of rows(data.tasks)) {
    const v=view(data,task,now);if(v.terminal||v.archived||v.invalidScope)continue;
    if(v.nextBoundary)times.push(Date.parse(v.nextBoundary));
    if(v.active&&v.event.snoozeUntil&&Date.parse(v.event.snoozeUntil)>now)times.push(Date.parse(v.event.snoozeUntil));
  }
  return times.length?iso(Math.min(...times)):null;
}
// Register before core's work-journal replay; this does no I/O.
require('./work-journal.cjs').registerProjector('deadline_execution',(owner,_task,event)=>require('./deadline-scheduler.cjs').projectExecution(owner,event));
require('./work-journal.cjs').registerProjector('deadline_protocol',(owner,_task,event)=>applyState(owner,event.payload.state));
module.exports={connectJournal,setPolicy,configure,project,state,transact,reconcile,view,context,act,pendingNotifications,beginNotifications,finishNotifications,markNotified,claim,attach,release,recover,pendingCards,nextBoundary};
