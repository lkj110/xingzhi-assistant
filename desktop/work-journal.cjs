// Durable lifecycle facts. Workspace snapshots are disposable projections of this log.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {hash} = require('./evidence-basis.cjs');
const rows = value => Array.isArray(value) ? value : [];
const handlers = new Map();
const fail = (message, code = 'WORK_JOURNAL_INVALID') => Object.assign(Error(message), {code});
const key = event => `${event.entityKind}:${event.entityId}`;
const revision = entity => entity.workRevision ?? 1;
function file(a) { return a.workJournalFile || path.join(a.dir || path.dirname(a.file), 'work-journal.json'); }
function entity(a, event) { return rows(a.data[event.entityKind === 'job' ? 'delegations' : 'tasks']).find(row => row.id === event.entityId); }
function validate(log) {
  if (log?.version !== 3 || !Array.isArray(log.events) || log.checksum !== hash(log.events)) throw fail('工作记录格式或校验不一致，需要恢复核对');
  const heads = new Map(), ids = new Set();
  for (const [index, event] of log.events.entries()) {
    const prior = heads.get(key(event));
    if (!event.eventId || ids.has(event.eventId) || event.sequence !== index + 1 || !['task','job'].includes(event.entityKind) || !event.entityId || !event.commitId || !event.actor || !event.type || !Number.isSafeInteger(event.workRevision) || event.workRevision < 1 || event.previousEventId !== (prior?.eventId || null)) throw fail('工作记录因果序列存在缺失或分叉');
    if (prior && event.workRevision !== prior.workRevision + (event.type === 'reopened' ? 1 : 0)) throw fail('工作修订缺少明确重开事件');
    heads.set(key(event), event); ids.add(event.eventId);
  }
  return log;
}
function read(a) {
  try {
    const log=validate(JSON.parse(fs.readFileSync(file(a),'utf8'))), cursor=a.data.runtime?.workJournal;
    if((cursor?.appliedSequence||0)>log.events.length||cursor?.lastEventId&&log.events[(cursor.appliedSequence||0)-1]?.eventId!==cursor.lastEventId)throw fail('工作记录落后于已提交投影或存在分叉');
    for(const target of [...rows(a.data.tasks),...rows(a.data.delegations)])if(target.workEvent?.sequence&&log.events[target.workEvent.sequence-1]?.eventId!==target.workEvent.eventId)throw fail('实体工作记录与因果序列不一致');
    return log;
  }
  catch (error) {
    if (error.code === 'ENOENT' && !a.data.runtime?.workJournal?.appliedSequence&&!a.data.runtime?.workJournal?.initialized) return {version:3, events:[], checksum:hash([])};
    throw fail(`工作记录无法读取：${error.message}`);
  }
}
function atomicWrite(a, log, receipt) {
  const target = file(a), temporary = `${target}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(log)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target); renamed = true;
    require('./filesystem-platform.cjs').syncDirectory(path.dirname(target));
  } catch (error) {
    // After rename the outcome may already survive a crash. Never undo facts or
    // repeat an acceptance merely because the directory fsync reported failure.
    if (renamed) Object.assign(error, {committed:true, commitReceipt:receipt});
    throw error;
  } finally { if (!renamed) try { fs.unlinkSync(temporary); } catch {} }
}
function append(a, inputs, {commitId = randomUUID()} = {}) {
  if (!Array.isArray(inputs) || !inputs.length) throw fail('工作事件批次不能为空');
  const log = read(a), old = log.events.filter(event => event.commitId === commitId);
  if (old.length) {
    if (old.length !== inputs.length || old.some((event, i) => hash(event.command) !== hash(inputs[i]))) throw fail('同一提交身份不能对应不同事件', 'WORK_JOURNAL_CONFLICT');
    return {committed:true, commitId, sequence:old.at(-1).sequence, events:old};
  }
  const events = [];
  for (const input of inputs) {
    const previous = [...log.events, ...events].findLast(event => key(event) === key(input));
    const current = entity(a, input), workRevision = input.workRevision ?? revision(current || {});
    if (input.previousEventId !== undefined && input.previousEventId !== (previous?.eventId || null)) throw fail('工作记录已变化', 'WORK_JOURNAL_CONFLICT');
    if (current?.projectionPending) throw fail('已提交记录正在恢复，请先重放投影', 'WORK_PROJECTION_PENDING');
    events.push({...structuredClone(input), command:structuredClone(input), eventId:input.eventId || randomUUID(), workRevision, sequence:log.events.length + events.length + 1, previousEventId:previous?.eventId || null, actor:input.actor || 'user', basisRefs:input.basisRefs || {}, commitId, at:input.at || new Date().toISOString()});
  }
  const next = {version:3, events:[...log.events, ...events]}; next.checksum = hash(next.events); validate(next);
  const receipt = {committed:true, commitId, sequence:events.at(-1).sequence, events};
  atomicWrite(a, next, receipt); return receipt;
}
function history(target, event, extra = {}) {
  target.acceptanceHistory ||= [];
  if (!target.acceptanceHistory.some(row => row.eventId === event.eventId)) target.acceptanceHistory.push({eventId:event.eventId, workRevision:event.workRevision, acceptedAt:event.at, acceptedBy:event.actor, basisRefs:event.basisRefs, ...extra});
}
function clearSchedule(target) {
  for (const field of ['nextRunAt','nextCheckAt','resumeWatching','retryAt','retryCheck','autoRecovery','finishAfterAcceptance','acceptanceCheckpoint','pendingActionId','lastError','lastErrorCode','limitReason']) delete target[field];
  target.pendingNodeIds = []; target.followupDue = false;
  if (target.executionState) { delete target.executionState.forcedNext; target.executionState.recovery = null; }
  for (const intent of rows(target.wakeIntents)) if (!['cancelled','attached'].includes(intent.status)) intent.status = 'cancelled';
  for (const reminder of rows(target.deadlineEvents)) if (!['cancelled','completed'].includes(reminder.status)) reminder.status = 'cancelled';
}
function projectEvent(a, event) {
  const target = entity(a, event), payload = event.payload || {};
  const trashEvent = event.type === 'task_scope_changed' || ['deleted','restored'].includes(event.type) && payload.trash;
  // Load lazily so startup/backup replay has the same projector as the UI command.
  if (trashEvent) require('./task-trash.cjs').projectEvent(a,target,event);
  if (event.type === 'evidence_preflight_reclassified_v1') require('./evidence-legacy-preflight.cjs');
  if (event.type === 'evidence_plan_committed') require('./evidence-continuation.cjs');
  if (event.type === 'repair_validation') require('./repair-validation.cjs');
  if (event.type === 'continuation_evidence_handoff') require('./evidence-recovery.cjs');
  if (event.type === 'continuation_check_restored') require('./pending-check.cjs');
  if (event.type === 'execution_policy_prepared') require('./execution-policy.cjs');
  if (!target) {
    a.data.recoveryReviews ||= [];
    if (!a.data.recoveryReviews.some(row => row.eventId === event.eventId)) a.data.recoveryReviews.push({id:`work:${event.eventId}`,eventId:event.eventId,entityId:event.entityId,entityKind:event.entityKind,code:'WORK_ENTITY_MISSING',status:'open'});
    if(handlers.has(event.type)) {const result=handlers.get(event.type)(a,null,event);if(result?.then)throw fail('投影器不得等待异步操作');}
    return; // A log never reconstructs a deleted business document.
  }
  if (trashEvent) { /* Fully projected above, including scope effects without a task. */ }
  else if (event.type === 'accepted' || event.type === 'manual_completed') {
    history(target, event, {finalDelivery:payload.finalDelivery || null});
    target.status = 'completed'; target.acceptedAt = event.at; target.acceptedBy = event.actor;
    target.acceptedInputRevision = payload.acceptanceRevision; target.acceptedRevision = event.workRevision; target.completedAt = event.at; target.finalDelivery = payload.finalDelivery || null;
    if (event.type === 'manual_completed') { target.completionMode = 'manual'; target.manualConfirmation = payload.confirmation; }
    clearSchedule(target);
    const job = rows(a.data.delegations).find(row => row.id === target.agentJobId);
    if (job && !rows(job.history).some(row => row.eventId === event.eventId)) (job.history ||= []).push({eventId:event.eventId,tool:event.actor === 'policy' ? 'policy_acceptance' : 'user_acceptance',at:event.at,result:{taskId:target.id,acceptedBy:event.actor,verifiedBasis:event.basisRefs.taskBasis}});
  } else if (event.type === 'completed') {
    target.status = 'completed'; target.completedAt = event.at; target.summary = payload.summary || '委托已完成'; clearSchedule(target);
  } else if (event.type === 'finalizing' || event.type === 'watching') {
    target.status = event.type; if(payload.executionPaused)target.executionPaused=true; target.summary = payload.summary || (event.type === 'finalizing' ? '已验收，收尾待检查' : '本次成果已验收，持续服务继续');
    delete target.finishAfterAcceptance; delete target.acceptanceCheckpoint;
    if (event.type === 'finalizing') { delete target.nextRunAt; target.completionReview = payload.reasons || []; }
    else { delete target.completionReview; target.lastAcceptedBatch = event.basisRefs; }
  } else if (event.type === 'completion_checked') {
    target.completionCheck = payload.check;delete target.completionOperation;
    require('./continuation-control.cjs').noteGoalCheck(a,target,payload.check);
  }
  else if (event.type === 'reopened') {
    for (const field of ['acceptedAt','acceptedBy','acceptedRevision','acceptedInputRevision','completedAt','completionCheck','completionMode','manualConfirmation','finalDelivery']) delete target[field];
    target.status = payload.status || (event.entityKind === 'job' ? 'ready' : 'todo'); target.verification = null;
    if(payload.needsReplan)target.needsReplan='用户补充了要求，请核对计划与现有成果';
    applyUserDelta(target,event);
    if(event.entityKind==='job'){
      if(event.actor==='policy')target.ruleReopenPending={ruleId:event.basisRefs.ruleId,ruleRevision:event.basisRefs.ruleRevision,triggerId:event.basisRefs.triggerId,commitId:event.commitId};
      else delete target.ruleReopenPending;
    }
    if (payload.requirementRevision !== undefined) target.requirementRevision = payload.requirementRevision;
  } else if (event.type === 'deleted') { target.deletedAt = event.at; clearSchedule(target); }
  else if (event.type === 'restored') { delete target.deletedAt; target.recoveryReview = {code:'RESTORED_WORK',eventId:event.eventId}; }
  else if (event.type === 'requirement_withdrawn') { target.withdrawnRequirementIds = [...new Set([...rows(target.withdrawnRequirementIds), payload.requirementId])]; }
  else if (event.type === 'binding_withdrawn') {
    const binding = rows(target.contextBindings).find(row => row.bindingId === payload.bindingId);
    if (binding) binding.state = 'withdrawn';
    target.withdrawnBindingIds = [...new Set([...rows(target.withdrawnBindingIds), payload.bindingId])];
    if (payload.sourceId) target.sourceIds = rows(target.sourceIds).filter(id => id !== payload.sourceId);
  } else if (event.type === 'baseline') {
    target.status = payload.status;
    if(event.entityKind==='job') target.mode=payload.mode || require('./acceptance.cjs').mode(target);
    for (const name of ['acceptedAt','acceptedBy','acceptedRevision','completedAt','deletedAt']) if (payload[name] !== undefined) target[name] = payload[name];
    if (target.acceptedAt) history(target, {...event,at:target.acceptedAt,actor:target.acceptedBy || 'legacy'}, {legacy:true});
  } else if (handlers.has(event.type)) {const result=handlers.get(event.type)(a,target,event);if(result?.then)throw fail('投影器不得等待异步操作');}
  else throw fail(`缺少工作事件投影器：${event.type}`);
  // Reminder and wake handoff revisions cannot invalidate business acceptance.
  if(!['deadline_protocol','deadline_execution'].includes(event.type)) {
    target.workRevision = event.workRevision; target.workEvent = {eventId:event.eventId,sequence:event.sequence};
  }
}
function markPending(a, receipt, error) {
  a.data.runtime ||= {}; a.data.runtime.workJournal ||= {};
  a.data.runtime.projectionPending = {domain:'work',commitId:receipt.commitId,sequence:receipt.sequence};
  a.data.runtime.workJournal.projectionPending = {commitId:receipt.commitId,sequence:receipt.sequence,message:'记录已保存，界面正在恢复'};
  for (const event of receipt.events || []) { const target = entity(a, event); if (target) target.projectionPending = {commitId:receipt.commitId,sequence:receipt.sequence,type:event.type}; }
  if (error) Object.assign(error, {committed:true,commitReceipt:receipt,projectionPending:true});
}
function project(a, receipt, {force = false} = {}) {
  if(!receipt?.committed||!Array.isArray(receipt.events))throw fail('投影需要已持久提交的凭据');
  for (const event of receipt.events) {
    const target = entity(a, event);
    if (!force && !['deadline_protocol','deadline_execution'].includes(event.type) && target?.workEvent?.sequence >= event.sequence) continue;
    projectEvent(a, event);
  }
  a.data.runtime ||= {};
  const current=a.data.runtime.workJournal;
  a.data.runtime.workJournal = {initialized:true,appliedSequence:Math.max(current?.appliedSequence||0,receipt.sequence),lastEventId:(current?.appliedSequence||0)>receipt.sequence?current.lastEventId:receipt.events.at(-1)?.eventId || null};
  if(a.data.runtime.projectionPending?.domain==='work') delete a.data.runtime.projectionPending;
  for (const event of receipt.events) { const target = entity(a, event); if (target) delete target.projectionPending; }
}
function commit(a, events, options = {}) {
  return require('./state-transitions.cjs').commit(a, receipt => { project(a, receipt); return receipt; }, {...options,workEvents:events});
}
function replay(a, {force = false, save = true} = {}) {
  const log = read(a);
  const receipt = {committed:true,commitId:log.events.at(-1)?.commitId,sequence:log.events.length,events:log.events};
  if (!receipt.sequence) {project(a,receipt);return receipt;}
  // force is required after loading a backup, even if its cursor claims current.
  return require('./state-transitions.cjs').commit(a, () => { project(a, receipt, {force}); return receipt; }, {commitReceipt:receipt,save});
}
function initialize(a, {migrate = false, save = true, force = false} = {}) {
  try {
    if (fs.existsSync(file(a))) {read(a);if(a.data.runtime)delete a.data.runtime.workJournalError;return replay(a,{force,save});}
    if (a.data.runtime?.workJournal?.initialized || a.data.runtime?.workJournal?.appliedSequence || !migrate) throw fail('独立工作记录缺失，不能从备份重新推断生命周期');
    const events = ['task','job'].flatMap(entityKind => rows(a.data[entityKind === 'task' ? 'tasks' : 'delegations']).map(target => ({entityKind,entityId:target.id,workRevision:revision(target),type:'baseline',actor:'legacy',payload:{...(entityKind==='job'?{mode:require('./acceptance.cjs').mode(target)}:{}),...Object.fromEntries(['status','acceptedAt','acceptedBy','acceptedRevision','completedAt','deletedAt'].filter(name => target[name] !== undefined).map(name => [name,target[name]]))}})));
    if(events.length)return commit(a,events,{save});
    const receipt={committed:true,commitId:randomUUID(),sequence:0,events:[]};
    atomicWrite(a,{version:3,events:[],checksum:hash([])},receipt);project(a,receipt);if(save)a.save();return receipt;
  } catch (error) { a.data.runtime ||= {}; a.data.runtime.workJournalError = {code:error.code || 'STORAGE_FAILURE',message:error.message}; throw error; }
}
function registerProjector(type, handler) { if (typeof handler !== 'function'||handler.constructor?.name==='AsyncFunction') throw TypeError('投影器必须为同步函数'); handlers.set(type, handler); }
module.exports = {file,read,validate,append,commit,replay,initialize,project,markPending,registerProjector,clearSchedule};

// Explicit trusted commands, never inferred from arbitrary save() mutations.
function beforeSave(a) {
  if (a.data.runtime?.workJournalError) throw fail(a.data.runtime.workJournalError.message);
  if (a.data.runtime?.workJournal?.projectionPending) replay(a, {save:false});
}
function observeCommittedState(a) { beforeSave(a); return a.data.runtime?.workJournal || null; }
function commandTarget(a, input) {
  const entityKind=input.entityKind || input.kind || 'task', entityId=input.entityId || input.id;
  if(!['task','job'].includes(entityKind)||!entityId) throw fail('工作命令范围无效');
  const target=entity(a,{entityKind,entityId}); if(!target) throw fail('事项或委托不存在');
  if(input.expectedWorkRevision!==undefined&&input.expectedWorkRevision!==revision(target)) throw fail('工作修订已变化','STATE_STALE');
  return {target,entityKind,entityId};
}
function replayCommand(a,input,type){
  if(!input.commitId)return null;
  const events=read(a).events.filter(e=>e.commitId===input.commitId);
  if(!events.length)return null;
  if(events[0].requestHash!==hash({type,input}))throw fail('同一提交身份不能用于另一用户命令','WORK_JOURNAL_CONFLICT');
  replay(a);return {committed:true,commitId:input.commitId,sequence:events.at(-1).sequence,events};
}
function userDelta(target,kind,input) {
  const payload={};
  if(input.changes!==undefined){
    if(!input.changes||typeof input.changes!=='object'||Array.isArray(input.changes))throw fail('用户修改字段无效');
    const fields=kind==='task'?['title','description','objective','criteria','priority','nextCheckAt','followupDue','generationMode','modelPreference']:['goal','title'];
    if(Object.keys(input.changes).some(key=>!fields.includes(key)))throw fail('用户修改包含非业务字段');
    payload.changes=structuredClone(input.changes);
    if(kind==='task'&&['description','objective','criteria'].some(key=>Object.hasOwn(input.changes,key)&&input.changes[key]!==target[key])){
      payload.previousRequirement=target.userRequirement?structuredClone(target.userRequirement):null;
      payload.userRequirement={revision:input.requirementRevision,origin:'user_edit',...Object.fromEntries(['description','objective','criteria'].map(key=>[key,input.changes[key]??target[key]??'']))};
    }
  }
  if(input.note!==undefined){if(typeof input.note!=='string'||!input.note.trim()||input.note.length>16000)throw fail('补充要求须为 1–16000 字符');payload.note=input.note.trim();payload.noteKind=input.noteKind||'feedback';}
  if(input.executionContract!==undefined){
    if(kind!=='job'||!input.executionContract?.revision||typeof input.executionContract.text!=='string'||!input.executionContract.text.trim()||input.executionContract.text.length>16000)throw fail('执行约定需要明确版本及正文');
    payload.executionContract={text:input.executionContract.text.trim(),revision:input.executionContract.revision,...(input.executionContract.updatedAt?{updatedAt:input.executionContract.updatedAt}:{})};
    payload.previousContract=target.executionContract?structuredClone(target.executionContract):{text:target.goal};
  }
  if(input.withdrawnRequirementIds)payload.withdrawnRequirementIds=[...new Set(input.withdrawnRequirementIds)];
  return payload;
}
function applyUserDelta(target,event) {
  const p=event.payload||{},kind=event.entityKind;
  if(p.changes)Object.assign(target,structuredClone(p.changes));
  if(p.userRequirement){
    target.requirementHistory ||= [];
    if(p.previousRequirement&&!target.requirementHistory.some(r=>r.revision===p.previousRequirement.revision))target.requirementHistory.push(structuredClone(p.previousRequirement));
    target.userRequirement={...structuredClone(p.userRequirement),at:event.at,workSequence:event.sequence};
  }
  if(p.executionContract){
    target.contractHistory ||= [];
    if(!target.contractHistory.some(r=>r.supersededByEventId===event.eventId))target.contractHistory.push({...structuredClone(p.previousContract),supersededAt:event.at,supersededByEventId:event.eventId});
    target.executionContract={...structuredClone(p.executionContract),updatedAt:p.executionContract.updatedAt||event.at,workSequence:event.sequence};
    delete target.repairProgress;
  }
  const displaced=[...rows(p.withdrawnRequirementIds),p.previousRequirement?.revision,p.previousContract?.revision].filter(Boolean);
  if(displaced.length)target.withdrawnRequirementIds=[...new Set([...rows(target.withdrawnRequirementIds),...displaced])];
  if(p.note){
    const field=kind==='job'?'feedback':'notes';target[field] ||= [];
    if(!target[field].some(n=>n.eventId===event.eventId))target[field].push({id:`work:${event.eventId}`,eventId:event.eventId,workSequence:event.sequence,contractRevision:target.executionContract?.revision||null,at:event.at,kind:p.noteKind||'feedback',text:p.note,...(p.taskId?{taskId:p.taskId}:{})});
    if(kind==='job'){require('./execution-contract.cjs').remember(target,target[field].find(n=>n.eventId===event.eventId));const directive=target.userDirectives.find(d=>d.at===event.at&&d.text===p.note);if(directive)Object.assign(directive,{workSequence:event.sequence,contractRevision:target.executionContract?.revision||null});}
  }
}
function recordCommand(a, input, type, payload={}) {
  beforeSave(a);
  const existing=replayCommand(a,input,type);if(existing)return existing;
  const {target,entityKind,entityId}=commandTarget(a,input);
  const event={entityKind,entityId,type,requestHash:hash({type,input}),workRevision:revision(target)+(type==='reopened'?1:0),actor:'user',payload,basisRefs:input.basisRefs||{},...(input.eventId?{eventId:input.eventId}:{})};
  return commit(a,[event],{commitId:input.commitId});
}
function recordReopen(a, input) {
  beforeSave(a);
  const existing=replayCommand(a,input,'reopened');if(existing)return existing;
  const {target,entityKind,entityId}=commandTarget(a,input);
  if(target.deletedAt) throw fail('请先明确恢复已删除事项');
  if(input.actor==='policy'){
    const rule=rows(a.data.workRules).find(r=>r.id===input.ruleId);
    if(entityKind!=='job'||!input.triggerId||!Array.isArray(input.taskIds)||!rule||rule.status!=='enabled'||rule.revision!==input.ruleRevision||target.ruleId!==rule.id||target.ruleRevision!==rule.revision)throw fail('规则重开需要当前有效规则、触发身份及明确事项范围','WORK_POLICY_INVALID');
    if(target.status==='paused'||target.executionPaused)throw fail('用户暂停的工作不能由规则重开','WORK_PAUSED');
  }else if(input.actor&&input.actor!=='user')throw fail('重开操作者无效');
  const make=(row,kind)=>({entityKind:kind,entityId:row.id,type:'reopened',workRevision:revision(row)+1,actor:input.actor||'user',payload:{requirementRevision:input.requirementRevision,...(input.actor==='policy'&&kind==='task'?{needsReplan:true}:{}),status:row.status==='paused'?'paused':kind==='job'?'ready':'todo'},basisRefs:input.basisRefs||{}});
  const primary=make(target,entityKind);Object.assign(primary.payload,userDelta(target,entityKind,input));
  const events=[{...primary,requestHash:hash({type:'reopened',input})}];
  if(entityKind==='job') {
    const ids=input.taskIds || rows(target.taskIds).filter(id=>{const task=rows(a.data.tasks).find(t=>t.id===id);return task&&!task.deletedAt&&!task.agentCancelled;});
    if(!Array.isArray(ids)||new Set(ids).size!==ids.length)throw fail('重开事项集合无效');
    for(const id of ids){const task=rows(a.data.tasks).find(t=>t.id===id);if(!task||task.agentJobId!==entityId||task.deletedAt||task.agentCancelled)throw fail('重开事项不在当前委托范围');events.push(make(task,'task'));}
  } else {
    const job=rows(a.data.delegations).find(j=>j.id===target.agentJobId);
    if(job){const linked=make(job,'job');delete linked.payload.requirementRevision;if(input.note)Object.assign(linked.payload,{note:input.note,noteKind:input.noteKind==='revise'?'task_revision':'task_feedback',taskId:target.id});events.push(linked);}
  }
  return commit(a,events,{commitId:input.commitId});
}
function recordUserEdit(a, input) {
  beforeSave(a);
  if(input.reopen===true) return recordReopen(a,input);
  const existing=replayCommand(a,input,'user_edited');if(existing)return existing;
  const {target,entityKind,entityId}=commandTarget(a,input);
  if(target.status==='completed'||target.acceptedAt) throw fail('修改已验收工作须使用明确重开命令','WORK_REOPEN_REQUIRED');
  if(input.requirementRevision===undefined) throw fail('用户要求变更需要稳定 requirementRevision');
  const event={entityKind,entityId,type:'user_edited',requestHash:hash({type:'user_edited',input}),workRevision:revision(target),actor:'user',payload:{requirementRevision:input.requirementRevision,...userDelta(target,entityKind,input)}};
  const job=entityKind==='task'&&rows(a.data.delegations).find(j=>j.id===target.agentJobId);
  const events=[event];if(job)events.push({entityKind:'job',entityId:job.id,type:'user_edited',workRevision:revision(job),actor:'user',payload:input.note?{note:input.note,noteKind:input.noteKind==='revise'?'task_revision':'task_feedback',taskId:target.id}:{}});
  return commit(a,events,{commitId:input.commitId});
}
function recordDelete(a,input) { return recordCommand(a,input,'deleted'); }
function recordRestore(a,input) { return recordCommand(a,input,'restored'); }
function recordResume(a,input) { return recordCommand(a,input,'execution_resumed',{status:input.status}); }
function recordJobFeedback(a,input) {
  beforeSave(a);
  const existing=replayCommand(a,input,'job_feedback');if(existing)return existing;
  const {target:job}=commandTarget(a,{...input,kind:'job'});
  if(job.deletedAt||input.requirementRevision===undefined)throw fail('补充要求需要有效委托及 requirementRevision');
  const scoped=input.taskIds!==undefined;
  if(scoped&&(!Array.isArray(input.taskIds)||!input.taskIds.length||new Set(input.taskIds).size!==input.taskIds.length))throw fail('补充要求的事项范围无效');
  if(scoped&&(input.executionContract!==undefined||input.changes!==undefined||input.withdrawnRequirementIds!==undefined))throw fail('委托整体要求变更不能限定到部分事项');
  const active=rows(a.data.tasks).filter(t=>rows(job.taskIds).includes(t.id)&&t.agentJobId===job.id&&!t.deletedAt&&!t.agentCancelled);
  if(scoped&&input.taskIds.some(id=>!active.some(t=>t.id===id)))throw fail('补充要求的事项不在当前委托范围');
  const tasks=scoped?active.filter(t=>input.taskIds.includes(t.id)):active;
  const reopen=job.status==='completed'||job.status==='finalizing'||tasks.some(t=>t.status==='completed'||t.acceptedAt);
  // A scoped instruction lives on the selected tasks. Updating job-wide intent
  // or feedback here would also invalidate the untouched siblings' checks.
  const events=[{target:job,kind:'job',reopen},...tasks.map(target=>({target,kind:'task',reopen:target.status==='completed'||!!target.acceptedAt}))].map(({target,kind,reopen},index)=>({entityKind:kind,entityId:target.id,type:reopen?'reopened':'user_edited',workRevision:revision(target)+(reopen?1:0),actor:'user',payload:{...(scoped&&kind==='job'?{}:{requirementRevision:input.requirementRevision}),needsReplan:kind==='task',status:target.status==='paused'?'paused':kind==='job'?'ready':'todo',...userDelta(target,kind,kind==='job'?(scoped?{}:input):{note:input.note,noteKind:input.noteKind})},...(index===0?{requestHash:hash({type:'job_feedback',input})}:{})}));
  return commit(a,events,{commitId:input.commitId});
}
function recordWithdraw(a,input) {
  if(!input.bindingId&&!input.requirementId) throw fail('撤回须指定绑定或要求身份');
  return recordCommand(a,input,input.bindingId?'binding_withdrawn':'requirement_withdrawn',input.bindingId?{bindingId:input.bindingId,sourceId:input.sourceId}:{requirementId:input.requirementId});
}
registerProjector('user_edited', (_a,target,event)=>{if(!target)return;if(event.payload.requirementRevision!==undefined)target.requirementRevision=event.payload.requirementRevision;applyUserDelta(target,event);if(event.payload.needsReplan)target.needsReplan='用户补充了要求，请核对计划与现有成果';target.verification=null;delete target.completionCheck;});
registerProjector('execution_resumed', (_a,target,event)=>{
  if(!target)return;
  delete target.executionPaused;target.status=event.payload.status;target.nextRunAt=event.at;target.failures=0;
  // Explicit resume handles the old cancellation, including on journal replay.
  // Other errors, permission decisions, spend limits and external receipts remain gates.
  if(event.actor==='user'&&target.lastErrorCode==='MODEL_CANCELLED'){
    target.lastError='';delete target.lastErrorCode;delete target.lastErrorAutomaticRetry;
  }
});
Object.assign(module.exports,{beforeSave,observeCommittedState,recordUserEdit,recordReopen,recordJobFeedback,recordResume,recordDelete,recordRestore,recordWithdraw});
