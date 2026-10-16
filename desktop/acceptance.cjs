const crypto = require('node:crypto');
const rows = value => Array.isArray(value) ? value : [];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && !!value.trim();
const now = () => new Date().toISOString();
const evidence=require('./evidence-basis.cjs');

function jobOf(a, task) { return rows(a.data.delegations).find(job => job.id === task.agentJobId); }
function projectOf(a, task) { return task.projectId || jobOf(a, task)?.projectId || null; }
function scope(a, input = {}) {
  if (!object(input)) throw new Error('验收参数无效');
  const id = input.projectId === undefined ? '' : input.projectId;
  if (typeof id !== 'string' || id && id !== '@independent' && !rows(a.data.projects).some(project => project.id === id)) throw new Error('项目不存在');
  return id;
}
function matchesScope(a, task, projectId) {
  const id = projectOf(a, task);
  return !projectId || (projectId === '@independent' ? !id : id === projectId);
}
function activeSources(a, task) {
  return rows(task.sourceIds).filter(id => !rows(task.supersededSourceIds).includes(id)).map(id => rows(a.data.sources).find(source => source.id === id) || { id, missing: true });
}
function actionsOf(a, task) {
  const job = jobOf(a, task);
  return rows(a.data.agentActions).filter(action => action.taskId === task.id || !action.taskId && job && (action.jobId === job.id || action.id === job.pendingActionId));
}
function artifactState(a, task) {
  const ids=[...new Set([...rows(task.steps).map(s=>s?.artifactId),task.primaryArtifactId].filter(Boolean))];
  return ids.map(id => rows(a.data.artifacts).find(artifact => artifact.id === id && artifact.taskId === task.id) || { id, missing: true });
}
// This basis excludes scheduling and acceptance metadata. Pausing a delegation or
// changing a deadline does not invalidate an otherwise unchanged verified result.
function artifactBasis(a,task){return artifactState(a,task).map(row=>{const copy={...row};if(copy.accessPolicyQuarantined===false)delete copy.accessPolicyQuarantined;return copy;});}
function basis(a, task, {legacy=false}={}) {
  const job = jobOf(a, task), project = rows(a.data.projects).find(project => project.id === projectOf(a, task));
  return hash({
    task: { id: task.id, primaryArtifactId:legacy?undefined:task.primaryArtifactId, workRevision:legacy?undefined:(task.workRevision ?? 1),requirementRevision:legacy?undefined:task.requirementRevision,withdrawnRequirementIds:legacy?undefined:task.withdrawnRequirementIds,withdrawnBindingIds:legacy?undefined:task.withdrawnBindingIds, title: legacy?task.title:undefined, description: task.description, criteria: task.criteria, sourceIds: legacy?task.sourceIds:undefined, supersededSourceIds: legacy?task.supersededSourceIds:undefined, steps: legacy?task.steps:rows(task.steps).map(evidence.step), notes: legacy?task.notes:evidence.notes(task.notes), dependsOn: task.dependsOn, needsReplan: task.needsReplan, agentCancelled: task.agentCancelled },
    sources: legacy?activeSources(a, task).map(({ state, processedAt, ...source }) => source):evidence.taskSources(a,task),
    artifacts: legacy?artifactState(a,task):artifactBasis(a,task),
    deliveries: actionsOf(a, task).filter(action => action.taskId === task.id).map(({ id, tool, status, artifactId, content, result, deliveryConflict }) => ({ id, tool, status, artifactId, content, result, ...(!legacy&&deliveryConflict?{deliveryConflict}:{}) })),
    dependencies: rows(task.dependsOn).map(id => { const dependency = rows(a.data.tasks).find(task => task.id === id); return dependency ? { id, title: dependency.title, criteria: dependency.criteria, status: ['review','completed'].includes(dependency.status)?'checked':dependency.status, cancelled: dependency.agentCancelled, needsReplan: dependency.needsReplan, verification: verificationRef(dependency), steps: dependency.steps, artifacts: legacy?artifactState(a,dependency):artifactBasis(a,dependency) } : { id, missing: true }; }),
    job: job ? { id: job.id, requirementRevision:legacy?undefined:job.requirementRevision, goal: job.goal, executionContract:job.executionContract, feedback: legacy?job.feedback:evidence.feedback(job.feedback).filter(f=>!f.taskId||f.taskId===task.id), sourceIds: legacy?job.sourceIds:undefined, outputFolder: job.outputFolder, fileMode: legacy?job.fileMode:undefined, followups: rows(job.followups).filter(followup => (!followup.taskId || followup.taskId === task.id)&&relevantBatch(job,followup)).map(followupRef) } : null,
    project: project ? { id: project.id, name: project.name, background: project.background } : null
  });
}
function revision(a, task) {
  return hash({basis:basis(a, task), workRevision:task.workRevision ?? 1, eventId:task.workEvent?.eventId,
    status:task.status, deletedAt:task.deletedAt, verification:verificationRef(task),
    replacements:rows(a.data.sources).filter(s=>rows(task.sourceIds).includes(s.previousSourceId)&&!s.projectExcluded).map(s=>({id:s.id,previousSourceId:s.previousSourceId,version:evidence.version(s,task,jobOf(a,task))})),
    decisions:rows(a.data.decisions).filter(d => d.status === 'open' && d.blocking !== false && rows(d.taskIds).includes(task.id)).map(d => d.id)});
}
function activeTasks(a, job) {
  return rows(job.taskIds).map(id => rows(a.data.tasks).find(t => t.id === id)).filter(t => t && !t.deletedAt && !t.agentCancelled);
}
function mode(job) {
  if (['one_shot','continuous'].includes(job.mode)) return job.mode;
  // v2's established completion semantics were one-shot, irrespective of goal
  // wording. Only explicit ongoing-service configuration changes that default.
  return job.continuous === true || job.recurring === true || job.ruleType === 'continuous' ? 'continuous' : 'one_shot';
}
function verificationRef(task) {
  const check = task.verification;
  return check ? {basis:check.basis || null,passed:check.passed === true,gaps:check.gaps || []} : null;
}
function followupRef(f) {
  return {key:f.key,taskId:f.taskId || null,status:f.status,expected:f.expected,evidence:f.evidence,required:f.required !== false,workRevision:f.workRevision};
}
function completionDetails(a, job) {
  const tasks = activeTasks(a, job).sort((x,y) => x.id.localeCompare(y.id));
  const taskSetRevision = evidence.hash(rows(job.taskIds).map(id => {const t=rows(a.data.tasks).find(t=>t.id===id);return {id,missing:!t,deleted:!!t?.deletedAt,cancelled:!!t?.agentCancelled,workRevision:t?.workRevision ?? 1};}).sort((x,y)=>x.id.localeCompare(y.id)));
  return {basisVersion:3,workRevision:job.workRevision ?? 1,mode:mode(job),withdrawnRequirementIds:job.withdrawnRequirementIds,requirementRevision:job.requirementRevision || job.executionContract?.revision || evidence.intent(job),taskSetRevision,
    taskVerificationRefs:tasks.map(t => ({taskId:t.id,workRevision:t.workRevision ?? 1,basis:basis(a,t),check:verificationRef(t),ready:['review','completed'].includes(t.status)})),
    artifactRefs:tasks.flatMap(t=>artifactBasis(a,t).map(r=>({taskId:t.id,id:r.id,hash:evidence.hash(r)}))),
    receiptRefs:rows(a.data.agentActions).filter(r=>r.jobId===job.id||tasks.some(t=>t.id===r.taskId)).filter(r=>!['stale','rejected'].includes(r.status)).map(r=>({id:r.id,taskId:r.taskId,artifactId:r.artifactId,tool:r.tool,status:r.status,receiptHash:evidence.hash(r.result),conflict:r.deliveryConflict||null,verified:r.result?.verified===true,sourceId:r.result?.sourceId,target:r.result?.url||r.result?.latestPath||r.result?.path})).sort((x,y)=>x.id.localeCompare(y.id)),
    followupBasis:evidence.hash(rows(job.followups).filter(f=>relevantBatch(job,f)).map(followupRef)),
    intent:evidence.intent(job),sources:evidence.versions(rows(job.sourceIds).map(id=>rows(a.data.sources).find(s=>s.id===id)||{id,missing:true}),null,job)};
}
function completionBasis(a, job) { return evidence.hash(completionDetails(a, job)); }
function relevantBatch(job, row) {
  return mode(job) !== 'continuous' || row.required !== false && (row.workRevision === undefined || row.workRevision === (job.workRevision ?? 1));
}
function completionBlockers(a, job) {
  const result=[], add=(code,message)=>result.push({code,message}), tasks=activeTasks(a,job);
  if (!tasks.length) add('tasks','尚无可验收事项');
  if (rows(job.taskIds).some(id=>!rows(a.data.tasks).some(t=>t.id===id&&t.agentJobId===job.id))) add('task_set','事项集合存在缺失或错误关联');
  for (const task of tasks) {
    const blocked=reasons(a,task,{completed:task.status==='completed'});
    if(blocked.length) result.push(...blocked.map(r=>({...r,taskId:task.id})));
  }
  if(rows(job.followups).some(f=>f.status==='waiting'&&relevantBatch(job,f))) add('followup','仍有未解决的等待条件');
  if(rows(a.data.decisions).some(d=>d.status==='open'&&d.blocking!==false&&(d.jobId===job.id||rows(d.taskIds).some(id=>tasks.some(t=>t.id===id)))&&relevantBatch(job,d)&&!['acceptance','deadline'].includes(d.type))) add('decision','仍有影响本次交付的待处理决定');
  if(rows(a.data.agentActions).some(r=>(r.jobId===job.id||tasks.some(t=>t.id===r.taskId))&&['pending','running','uncertain'].includes(r.status)&&relevantBatch(job,r))) add('action','仍有待执行或未核对的外部动作');
  if(rows(a.data.connectors).some(c=>(c.jobId===job.id||job.projectId&&c.projectId===job.projectId||rows(job.connectorIds).includes(c.id))&&(c.cursor?.token||['partial','blocked'].includes(c.syncWindow?.status)))) add('sync','关联来源仍在分页同步');
  if(job.projectId && rows(a.data.chatStreams).some(s=>s.projectId===job.projectId&&(s.pending||['partial','pending'].includes(s.status)))) add('sync','关联消息仍在收集中');
  if(!deliveryCurrent(a,job,tasks)) add('delivery','最终交付未指向当前稿件或缺少有效回执');
  return result;
}
function deliveryCurrent(a, job, tasks=activeTasks(a,job)) {
  for(const task of tasks) {
    const current=require('./deliverables.cjs').primary(a,task);
    for(const step of rows(task.steps).filter(s=>s.kind==='external'&&s.done)) {
      let receipt;try{receipt=JSON.parse(step.evidence);}catch{}
      const action=receipt?.actionId&&rows(a.data.agentActions).find(r=>r.id===receipt.actionId);
      if(action?.deliveryConflict || action?.artifactId && current && action.artifactId!==current.id) return false;
    }
    if(job.outputFolder&&current&&!rows(a.data.agentActions).some(r=>r.jobId===job.id&&r.taskId===task.id&&r.tool==='write_file'&&r.status==='done'&&r.artifactId===current.id&&r.result?.verified===true&&!r.deliveryConflict)) return false;
  }
  return true;
}
function currentCompletionCheck(a, job) {
  return job.completionCheck?.basisVersion===3 && job.completionCheck.passed===true && !rows(job.completionCheck.gaps).length && job.completionCheck.basis===completionBasis(a,job);
}
function completionCandidate(a, job) {
  const blockers=completionBlockers(a,job), basis=completionBasis(a,job);
  return {ready:!blockers.length,basis,blockers,checked:currentCompletionCheck(a,job),taskIds:activeTasks(a,job).map(t=>t.id)};
}
function finalAcceptanceReasons(a, job, selectedIds) {
  if(!activeTasks(a,job).every(t=>t.status==='completed'||selectedIds.has(t.id))) return [];
  const blocked=completionBlockers(a,job);
  if(mode(job)==='unknown') blocked.push({code:'mode',message:'请先确认委托为一次性工作或持续服务'});
  if(!currentCompletionCheck(a,job)) blocked.push({code:'completion_check',message:'请先完成当前版本的委托整体检查'});
  return blocked;
}
function reasons(a, task, { completed = false, seen = new Set() } = {}) {
  if (seen.has(task.id)) return [{ code: 'dependency', message: '事项依赖存在循环，请核对计划' }];
  seen = new Set(seen); seen.add(task.id);
  const result = [], add = (code, message) => { if (!result.some(row => row.code === code)) result.push({ code, message }); }, job = jobOf(a, task);
  if (task.status !== (completed ? 'completed' : 'review')) add('status', completed ? '前置事项尚未完成验收' : '事项尚未进入待验收状态');
  if (task.deletedAt) add('deleted', '事项已删除');
  if (task.agentCancelled) add('cancelled', '事项已取消');
  if (task.needsReplan) add('replan', '来源或计划已变化，请先重新推进和检查');
  const verification = task.verification;
  if (verification?.passed !== true || !nonempty(verification.summary) || rows(verification.gaps).some(nonempty)) add('verification', '请先完成执行与结果检查');
  if (!rows(task.steps).length || !rows(task.steps).every(step => object(step) && ['analysis','draft','external'].includes(step.kind) && step.done === true)) add('steps', '执行步骤尚未全部完成');
  for (const step of rows(task.steps).filter(step => object(step) && step.done)) {
    if (step.kind === 'external') {
      if (!nonempty(step.evidence)) add('evidence', '外部步骤缺少执行结果依据');
      // Structured receipts must still exist and confirm success. Plain text is
      // intentionally supported for the existing manual externalDone workflow.
      let evidence; try { evidence = JSON.parse(step.evidence); } catch {}
      if (evidence?.actionId) {
        const action = rows(a.data.agentActions).find(action => action.id === evidence.actionId);
        if (!action || action.taskId !== task.id || action.status !== 'done' || action.tool !== step.tool || task.agentJobId && action.jobId !== task.agentJobId || action.result?.verified !== true || action.deliveryConflict || action.artifactId && !artifactState(a, task).some(artifact => !artifact.missing && artifact.id === action.artifactId)) add('receipt', '步骤引用的执行回执已缺失或不再有效');
      }
    } else {
      const artifact = rows(a.data.artifacts).find(artifact => artifact.id === step.artifactId && artifact.taskId === task.id);
      if (!artifact || !nonempty(artifact.content) || artifact.stepId && artifact.stepId !== step.id) add('artifact', '当前步骤的产出缺失或关联不一致');
    }
  }
  if (task.agentJobId && (!job || !rows(job.taskIds).includes(task.id) || task.projectId && job.projectId !== task.projectId)) add('job', '事项与所属委托的关联需要核对');
  if (job && rows(job.taskIds).some(id => { const linked = rows(a.data.tasks).find(task => task.id === id); return !linked || linked.agentJobId !== job.id; })) add('job_tasks', '所属委托存在缺失或错误关联的事项');
  if (projectOf(a, task) && !rows(a.data.projects).some(project => project.id === projectOf(a, task))) add('project', '事项所属项目已不存在');
  if (actionsOf(a, task).some(action => ['running', 'uncertain'].includes(action.status))) add('uncertain', '请先核对所属委托的外部动作结果');
  if (actionsOf(a, task).some(action => action.taskId === task.id && action.status === 'pending')) add('pending', '当前事项仍有执行动作等待确认');
  if (rows(a.data.decisions).some(decision => decision.status === 'open' && decision.blocking !== false && rows(decision.taskIds).includes(task.id))) add('decision', '当前事项仍有待处理的决定');
  if (rows(job?.followups).some(followup => followup.taskId === task.id && followup.status === 'waiting')) add('followup', '当前事项仍在等待结果');
  for (const source of activeSources(a, task)) {
    if (source.missing || source.deleted || source.projectExcluded || (source.projectId || null) !== projectOf(a, task)) add('source', '当前引用材料缺失、已撤回或已移出项目');
    else if (rows(a.data.sources).some(next => next.previousSourceId === source.id && !next.projectExcluded&&evidence.relevantChange(source,next,task,job))) add('source_version', '引用材料已有更新版本，请重新推进和检查');
  }
  if (rows(task.dependsOn).some(id => {
    const dependency = rows(a.data.tasks).find(task => task.id === id);
    return !dependency || dependency.id === task.id || dependency.agentJobId !== task.agentJobId || projectOf(a, dependency) !== projectOf(a, task) || dependency.status !== 'completed' || dependency.verification?.passed !== true || rows(dependency.verification?.gaps).some(nonempty) || dependency.agentCancelled || dependency.needsReplan || reasons(a, dependency, { completed: true, seen }).length > 0;
  })) add('dependency', '前置事项尚未有效验收或关联已变化');
  if (verification?.basis && verification.basis !== basis(a, task)) add('changed', '结果检查之后依据已变化，请重新检查');
  return result;
}
// Read-only views share checks while the complete workspace is unchanged.
// Mutating acceptance paths always validate again through reasons/preflight.
const presentationCache = new WeakMap();
function presentationChecks(a) {
  const fingerprint = hash(a.data), previous = presentationCache.get(a);
  const cache = previous?.fingerprint === fingerprint ? previous : {fingerprint, results:new Map()};
  presentationCache.set(a, cache);
  return (task, completed = false) => {
    const key = `${completed}:${task.id}`;
    if (!cache.results.has(key)) cache.results.set(key, module.exports.reasons(a, task, {completed}));
    return structuredClone(cache.results.get(key));
  };
}
function preflight(a, input, { projectId = '', requireRevision = false } = {}) {
  if (!object(input) || typeof input.id !== 'string') throw new Error('验收事项参数无效');
  const task = rows(a.data.tasks).find(task => task.id === input.id);
  if (!task) throw new Error('事项不存在');
  require('./project-lifecycle.cjs').assertTaskActive(a.data,task);
  if (!matchesScope(a, task, projectId)) throw new Error('事项已不在当前项目范围，请刷新');
  if ((requireRevision || input.revision !== undefined) && input.revision !== revision(a, task)) throw new Error('事项或验收依据已发生变化，请刷新并重新选择');
  const blocked = reasons(a, task);
  if (blocked.length) throw new Error(blocked.map(reason => reason.message).join('；'));
  return task;
}
function eventFor(target, entityKind, type, payload={}, actor='user', at=now()) {
  return {entityKind,entityId:target.id,workRevision:target.workRevision ?? 1,type,actor,payload,at};
}
function finishEvent(a, job, selectedIds, at) {
  if(!activeTasks(a,job).every(t=>t.status==='completed'||selectedIds.has(t.id))) return null;
  return eventFor(job,'job',mode(job)==='continuous'?'watching':'completed',{executionPaused:job.status==='paused'||job.executionPaused===true},'system',at);
}
function acceptanceEvents(a, tasks, {actor='user',at=now()}={}) {
  const ids=new Set(tasks.map(t=>t.id)), jobs=[...new Set(tasks.map(t=>jobOf(a,t)).filter(Boolean))];
  for(const job of jobs) {
    const blocked=finalAcceptanceReasons(a,job,ids);
    if(blocked.length) throw Object.assign(Error(blocked.map(r=>r.message).join('；')),{code:'COMPLETION_REQUIRED',reasons:blocked});
    if(actor==='policy'&&job.autoAccept!==true) throw Error('当前委托未启用自动验收');
  }
  return [...tasks.map(task=>({...eventFor(task,'task','accepted',{finalDelivery:finalDelivery(a,task),acceptanceRevision:revision(a,task)},actor,at),basisRefs:{taskBasis:basis(a,task),verification:verificationRef(task)}})),...jobs.map(job=>finishEvent(a,job,ids,at)).filter(Boolean)];
}
function finalDelivery(a, task) {
  const artifact=require('./deliverables.cjs').primary(a,task);
  const actions=actionsOf(a,task).filter(r=>r.taskId===task.id&&r.status==='done'&&r.result?.verified&&(!r.artifactId||r.artifactId===artifact?.id));
  return {artifactId:artifact?.id || null,artifactHash:artifact?evidence.hash(artifact.content):null,actionIds:actions.map(r=>r.id)};
}
function acceptTask(a, input, {actor='user',at=now()}={}) {
  if(!['user','policy'].includes(actor)) throw Error('验收主体无效');
  require('./work-journal.cjs').beforeSave(a);
  const existing=rows(a.data.tasks).find(t=>t.id===input.id);
  if(existing?.status==='completed'&&existing.acceptedAt&&(input.workRevision===undefined||input.workRevision===(existing.workRevision??1))) return existing;
  const internalPolicy=actor==='policy'&&existing?.agentJobId&&a.activeAgentJob?.id===existing.agentJobId&&jobOf(a,existing)?.autoAccept===true;
  const internalTaskPolicy=actor==='policy'&&!existing?.agentJobId&&a.activeSpendTask?.id===existing?.id&&a.data.settings?.autoComplete===true;
  if(!internalPolicy&&!internalTaskPolicy)a.ensureIdle?.({taskId:input.id});
  const task=preflight(a,input);
  if(actor==='policy'&&!task.agentJobId&&a.data.settings?.autoComplete!==true) throw Error('当前事项未启用自动验收');
  require('./work-journal.cjs').commit(a,acceptanceEvents(a,[task],{actor,at}));
  return task;
}
function markManualComplete(a, input) {
  require('./work-journal.cjs').beforeSave(a);
  const task=rows(a.data.tasks).find(t=>t.id===input.id);
  if(!task)throw Error('事项不存在');
  require('./project-lifecycle.cjs').assertTaskActive(a.data,task);
  a.ensureIdle?.({taskId:task.id});
  if(input.revision!==undefined&&input.revision!==revision(a,task))throw Object.assign(Error('事项或验收依据已发生变化'),{code:'STATE_STALE'});
  if(!nonempty(input.confirmation?.summary))throw Error('请填写人工完成确认');
  if(task.status==='completed'&&task.completionMode==='manual')return task;
  const confirmation={summary:input.confirmation.summary,evidenceRefs:rows(input.confirmation.evidenceRefs),origin:'user'};
  require('./work-journal.cjs').commit(a,[eventFor(task,'task','manual_completed',{confirmation,finalDelivery:finalDelivery(a,task),acceptanceRevision:revision(a,task)},'user')]);
  return task;
}
// Called by the owning Agent after the whole-batch check has been persisted.
function acceptPolicy(a, jobOrId) {
  require('./work-journal.cjs').beforeSave(a);
  const job=rows(a.data.delegations).find(j=>j.id===(typeof jobOrId==='string'?jobOrId:jobOrId.id));
  if(!job||job.autoAccept!==true) throw Error('当前委托未启用自动验收');
  const tasks=activeTasks(a,job).filter(t=>t.status!=='completed');
  if(!tasks.length) return {acceptedIds:[],jobId:job.id};
  for(const task of tasks){if(a.activeAgentJob?.id!==job.id)a.ensureIdle?.({taskId:task.id});preflight(a,{id:task.id});}
  const receipt=require('./work-journal.cjs').commit(a,acceptanceEvents(a,tasks,{actor:'policy'}));
  return {acceptedIds:tasks.map(t=>t.id),jobId:job.id,commitId:receipt.commitId};
}
// Compatibility exports use the same durable path; callers must not mutate old references.
function commitTask(a, task, at=now()) { return acceptTask(a,{id:task.id},{at}); }
function acceptOne(a, input) { return acceptTask(a,input); }
function recordCompletionCheck(a, jobOrId, checked, {basis:expectedBasis}={}) {
  require('./work-journal.cjs').beforeSave(a);
  const job=rows(a.data.delegations).find(j=>j.id===(typeof jobOrId==='string'?jobOrId:jobOrId.id));
  if(!job) throw Error('委托不存在');
  const current=completionBasis(a,job);
  if(!expectedBasis||expectedBasis!==current) throw Object.assign(Error('整体检查期间依据已变化'),{code:'COMPLETION_STALE'});
  if(typeof checked?.passed!=='boolean'||!nonempty(checked.summary)||!Array.isArray(checked.gaps)||checked.gaps.some(g=>typeof g!=='string')||checked.passed&&checked.gaps.some(nonempty)) throw Error('整体检查结果无效');
  if(checked.passed&&completionBlockers(a,job).length) throw Object.assign(Error('整体检查条件已变化'),{code:'COMPLETION_STALE'});
  const check={...completionDetails(a,job),passed:checked.passed,gaps:checked.gaps,summary:checked.summary,at:now(),basis:current};
  const events=[eventFor(job,'job','completion_checked',{check},'agent')];
  if(checked.passed&&activeTasks(a,job).every(t=>t.status==='completed')&&mode(job)!=='unknown') events.push(eventFor(job,'job',mode(job)==='continuous'?'watching':'completed',{},'system'));
  require('./work-journal.cjs').commit(a,events);
  return job.completionCheck;
}
function reconcileJobCompletion(a, jobOrId) {
  require('./work-journal.cjs').beforeSave(a);
  const job=rows(a.data.delegations).find(j=>j.id===(typeof jobOrId==='string'?jobOrId:jobOrId.id));
  if(!job||job.status==='completed'||job.deletedAt) return job;
  const tasks=activeTasks(a,job);
  if(!tasks.length||!tasks.every(t=>t.status==='completed')) return job;
  const blocked=completionBlockers(a,job);
  if(mode(job)==='unknown') blocked.push({code:'mode',message:'委托持续属性待核对'});
  if(!currentCompletionCheck(a,job)) blocked.push({code:'completion_check',message:'历史验收缺少当前整体检查'});
  const type=blocked.length?'finalizing':mode(job)==='continuous'?'watching':'completed';
  if(job.status!==type||type==='finalizing'&&hash(job.completionReview)!==hash(blocked)) require('./work-journal.cjs').commit(a,[eventFor(job,'job',type,{reasons:blocked,executionPaused:job.status==='paused'||job.executionPaused===true},'system')]);
  return job;
}
function snapshot(a, input = {}) {
  const projectId = scope(a, input);
  const items = rows(a.data.tasks).filter(task => task.status === 'review' && matchesScope(a, task, projectId)).map(task => {
    const job = jobOf(a, task), id = projectOf(a, task), blocked = [...reasons(a, task),...(job?finalAcceptanceReasons(a,job,new Set([task.id])):[])], artifacts = artifactState(a, task).filter(artifact => !artifact.missing);
    const sources = activeSources(a, task).map(source => (source.projectId || null) !== id ? { id: source.id, title: '其他项目材料，需核对关联', available: false, current: false } : ({ id: source.id, title: source.title || '材料缺失', version: source.version || 1, available: !source.missing && !source.deleted && !source.projectExcluded, current: !rows(a.data.sources).some(next => next.previousSourceId === source.id && !next.projectExcluded) }));
    return { id: task.id, title: task.title, criteria: task.criteria, projectId: id, projectName: rows(a.data.projects).find(project => project.id === id)?.name || '独立工作', jobId: job?.id || null, jobPaused: job?.status === 'paused', ready: !blocked.length, reasons: blocked, revision: revision(a, task), verifiedAt: task.verification?.at || null, verification: task.verification ? { passed: task.verification.passed === true, summary: task.verification.summary || '', gaps: rows(task.verification.gaps) } : null,
      steps: rows(task.steps).filter(object).map(step => ({ id: step.id, title: step.title, kind: step.kind, done: !!step.done, evidence: step.evidence || '', artifactId: step.artifactId })),
      artifacts: artifacts.map(artifact => ({ id: artifact.id, title: artifact.title, createdAt: artifact.createdAt, preview: String(artifact.content || '').slice(0, 360), chars: String(artifact.content || '').length })), sources,
      deliveries: actionsOf(a, task).filter(action => action.taskId === task.id && action.status === 'done').map(action => ({ id: action.id, tool: action.tool, artifactId: action.artifactId, current: artifacts.some(artifact => artifact.id === action.artifactId), verified: action.result?.verified === true, at: action.finishedAt || action.completedAt, target: action.result?.latestPath || action.result?.path || action.result?.url || '' })) };
  }).sort((a, b) => Number(b.ready) - Number(a.ready) || String(b.verifiedAt || '').localeCompare(String(a.verifiedAt || '')) || a.id.localeCompare(b.id));
  return { generatedAt: now(), projectId, items, counts: { total: items.length, ready: items.filter(item => item.ready).length, blocked: items.filter(item => !item.ready).length }, modelCalls: 0, networkRequests: 0 };
}
function accept(a, input = {}) {
  require('./work-journal.cjs').beforeSave(a);
  const projectId=scope(a,input);
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>100||new Set(input.items.map(item=>item?.id)).size!==input.items.length) throw Error('请选择 1–100 个不重复的待验收事项');
  const repeated=input.items.map(item=>rows(a.data.tasks).find(t=>t.id===item.id));
  if(repeated.every((t,i)=>t?.status==='completed'&&t.acceptedInputRevision===input.items[i].revision&&matchesScope(a,t,projectId)))return {acceptedIds:repeated.map(t=>t.id),snapshot:snapshot(a,{projectId}),modelCalls:0,networkRequests:0,replayed:true};
  for(const item of input.items) a.ensureIdle?.({taskId:item?.id});
  const tasks=input.items.map(item=>preflight(a,item,{projectId,requireRevision:true}));
  const receipt=require('./work-journal.cjs').commit(a,acceptanceEvents(a,tasks));
  return {acceptedIds:tasks.map(t=>t.id),commitId:receipt.commitId,snapshot:snapshot(a,{projectId}),modelCalls:0,networkRequests:0};
}
function dispatch(a, action, input = {}) {
  if (action === 'acceptanceSnapshot') return snapshot(a, input);
  if (action === 'acceptanceAccept') return accept(a, input);
  throw new Error('未知成果验收操作');
}
module.exports = { markManualComplete, acceptPolicy, acceptTask, recordCompletionCheck, reconcileJobCompletion, completionCandidate, completionDetails, completionBlockers, currentCompletionCheck, activeTasks, mode, finalDelivery, deliveryCurrent, presentationChecks, dispatch, snapshot, accept, acceptOne, preflight, commitTask, basis, completionBasis, revision, reasons };
