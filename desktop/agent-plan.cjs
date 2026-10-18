const crypto = require('node:crypto');
const uid = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();
const writeTools = ['lark_create', 'lark_update', 'write_file', 'github_create', 'github_update', 'github_comment', 'request_confirmation', 'manual'];
const required = (v, label, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${label}必须是 1–${max} 字符的字符串，不能是数组或对象`); return v.trim(); };
const shape = s => ({key:s.key,kind:s.kind,...(s.kind==='external'?{tool:s.tool}:{}),...(s.outputRole?{outputRole:s.outputRole}:{}),...(s.targetArtifactId?{targetArtifactId:s.targetArtifactId}:{})});
const evidence=require('./evidence-basis.cjs');
const continuation=require('./evidence-continuation.cjs');

// These are preflight input errors, before any plan or journal write. Report
// them together so the planner can correct its arguments without user input.
function validateInputs(job, sourceIds, steps) {
  const issues=[];
  if(!Array.isArray(sourceIds)||new Set(sourceIds).size!==sourceIds.length)issues.push('sourceIds 必须是不重复的来源 ID 数组');
  else {
    const invalid=sourceIds.filter(id=>!job.sourceIds.includes(id));
    if(invalid.length)issues.push('sourceIds 只能引用此委托真实获取的不重复来源，移除非来源 ID：'+invalid.slice(0,12).join('、')+'。稿件 ID 应放 primaryArtifactId 或文本步骤 targetArtifactId，不能放 sourceIds');
  }
  if(Array.isArray(steps))for(const [i,s] of steps.entries()){
    if(s?.kind==='external'&&(s.outputRole!==undefined||s.targetArtifactId!==undefined))issues.push(`steps[${i}] 为外部步骤，请移除 outputRole 和 targetArtifactId；这两个字段只用于文本步骤，外部交付使用事项绑定的主稿`);
  }
  if(issues.length)throw Object.assign(Error('计划参数需要修正：'+issues.join('；')),{code:'PLAN_INPUT_INVALID',planInputInvalid:true,issues});
}

function dependencies(a, job, task, ids) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !job.taskIds.includes(id) || id === task?.id)) throw new Error('依赖必须是同一委托内的其他事项');
  const reaches = (id, seen = new Set()) => {
    if (id === task?.id) return true;
    if (seen.has(id)) return false;
    seen.add(id); return (a.task(id).dependsOn || []).some(next => reaches(next, seen));
  };
  if (ids.some(id=>a.task(id).deletedAt))throw Error('不能依赖已删除的事项，请先恢复或调整依赖');
  if (ids.some(id => reaches(id))) throw new Error('事项依赖不能形成循环');
  return ids;
}
function dependencyIssues(a, task) {
  const acceptance = require('./acceptance.cjs');
  const project = t => t.projectId || a.data.delegations.find(j => j.id === t.agentJobId)?.projectId || null;
  if (!Array.isArray(task.dependsOn || [])) return [{id:task.id,title:task.title,reason:'依赖列表无效'}];
  return [...new Set(task.dependsOn || [])].flatMap(id => {
    const dependency = a.data.tasks.find(t => t.id === id);
    if (dependency?.deletedAt) return [{id,title:dependency.title,reason:'前置事项已删除，请恢复或调整依赖'}];
    if (!dependency) return [{id,title:id,reason:'前置事项已不存在'}];
    if (dependency.id === task.id || dependency.agentJobId !== task.agentJobId || project(dependency) !== project(task)) return [{id,title:dependency.title,reason:'依赖不属于同一委托与项目'}];
    const reasons = acceptance.reasons(a, dependency, {completed:true,seen:new Set([task.id])});
    return reasons.length ? [{id,title:dependency.title,reason:reasons.map(r=>r.message).join('；')}] : [];
  });
}
function assertReady(a, task) {
  require('./project-lifecycle.cjs').assertTaskActive(a.data,task);
  if (task.agentCancelled) throw new Error('此事项已取消，请先重新规划');
  if (task.needsReplan) throw Object.assign(new Error('来源或依赖已变化，请先用 plan_task 核对并调整计划'),{code:'PLAN_RECONCILE_REQUIRED',taskId:task.id});
  const blocked = dependencyIssues(a, task);
  if (blocked.length) throw new Error(`前置事项尚未有效验收：${blocked.map(t=>`${t.title}（${t.reason}）`).join('、')}`);
}
function invalidateDependents(a, task, seen = new Set()) {
  if (seen.has(task.id)) return; seen.add(task.id);
  for (const next of a.data.tasks.filter(t => t.agentJobId === task.agentJobId && t.dependsOn?.includes(task.id) && !t.agentCancelled)) {
    next.needsReplan = `前置事项「${task.title}」发生变化`;
    a.requeue(next); invalidateDependents(a, next, seen);
  }
}
function supersededSources(a, job, ids) {
  const selected = new Set(ids), superseded = [];
  for (const id of ids) {
    let source = a.data.sources.find(s => s.id === id);
    if (!source || source.projectExcluded || (source.projectId || null) !== (job.projectId || null)) throw new Error('引用来源已撤回、缺失或不属于当前项目，请核对来源列表');
    const seen = new Set([id]);
    while (true) {
      const next = a.data.sources.filter(s => job.sourceIds.includes(s.id) && s.previousSourceId === source.id && !s.projectExcluded && !s.copiedFrom && (s.projectId || null) === (job.projectId || null));
      if (!next.length) break;
      if (next.length > 1 || seen.has(next[0].id)) throw new Error('来源版本链不明确，请核对来源列表');
      source = next[0]; seen.add(source.id);
    }
    if (source.deleted) throw new Error('引用来源的当前版本已撤回，请核对来源列表');
    if (source.id !== id) {
      if (!selected.has(source.id)) throw new Error(`来源 ${id} 已更新，请将当前版本 ${source.id} 加入 sourceIds 后重新规划`);
      superseded.push(id);
    }
  }
  return superseded;
}
function planTask(a, job, args) {
  require('./project-lifecycle.cjs').assertJobActive(a.data,job);
  const key = required(args.key, '事项标识', 100), title = required(args.title, '标题', 160);let criteria = required(args.criteria, '完成标准', 3000);
  const dueAt=args.dueAt===undefined?undefined:require('./date-time.cjs').optionalISO(args.dueAt,'截止时间');
  let task = a.data.tasks.find(t => t.agentJobId === job.id && t.agentKey === key);
  if(args.existingTaskId){const existing=a.task(args.existingTaskId);if(existing.agentJobId!==job.id)throw new Error('只能归并同一委托的已有事项');if(task&&task.id!==existing.id)throw new Error('事项标识与指定已有事项不一致');task=existing;}
  if(!task&&job.projectId){const matches=a.data.tasks.filter(t=>t.agentJobId===job.id&&!t.agentCancelled&&t.title.trim()===title);if(matches.length===1)task=matches[0];}
  if(task){const committed=continuation.recover(a,job,task,args);if(committed)return committed;}
  require('./task-trash.cjs').assertTask(task);
  if(!task&&a.data.tasks.some(t=>t.deletedAt&&t.agentJobId===job.id&&t.title.trim()===title))throw Error('同名事项已由用户删除，不得自动重建');
  if(!task&&job.taskIds.some(id=>!a.task(id).deletedAt&&a.task(id).intake?.status==='pending'))throw Error('请先用 existingTaskId 整理已记录的事项，不要重复新建');
  const pendingIntake=task?.intake?.status==='pending';
  if(task?.userRequirement)criteria=task.userRequirement.criteria;
  const objective=task?.userRequirement?.objective??(args.objective===undefined?task?.objective:required(args.objective,'目标',3000));
  if(pendingIntake){required(args.description,'背景',10000);required(objective,'目标',3000);if(title==='正在整理新事项')throw Error('请从原文提炼具体标题');}
  if (task?.status === 'paused' && !task.agentCancelled) throw new Error('事项已暂停，不能自动修改');
  validateInputs(job,args.sourceIds===undefined?(task?.sourceIds||[]):args.sourceIds,args.steps ?? task?.steps);
  const sourceIds = require('./evidence-links.cjs').merge(task,args);
  validateInputs(job,sourceIds,args.steps ?? task?.steps);
  if(pendingIntake&&task.intake.sourceIds.some(id=>!sourceIds.includes(id)))throw Error('初次整理必须保留本次原文来源');
  const supersededSourceIds = supersededSources(a, job, sourceIds);
  const dependsOn = dependencies(a, job, task, args.dependsOn ?? task?.dependsOn ?? []);
  const inputSteps = args.steps ?? task?.steps;
  if (!Array.isArray(inputSteps) || !inputSteps.length || inputSteps.length > 12) throw new Error('计划需要 1–12 个有效步骤');
  const used = new Set();
  const proposed = inputSteps.map((s, i) => {
    if (!['analysis','draft','external'].includes(s.kind) || (s.kind === 'external' && !writeTools.includes(s.tool))) throw new Error('外部步骤必须指定实际执行工具；步骤类型无效');
    const title = required(s.title, '步骤标题', 500);
    const old = task?.steps.find(o => s.key ? o.key === s.key : s.id ? o.id === s.id : o.title === title && o.kind === s.kind && o.tool === s.tool);
    const stepKey = s.key || old?.key || `step-${uid().slice(0,8)}`;
    required(stepKey, '步骤标识', 100);
    if (used.has(stepKey)) throw new Error('步骤标识不能重复'); used.add(stepKey);
    const outputRole=s.outputRole===undefined?old?.outputRole:s.outputRole,targetArtifactId=s.targetArtifactId===undefined?old?.targetArtifactId:s.targetArtifactId;
    if(outputRole!==undefined&&!['primary','supporting'].includes(outputRole)||s.kind==='external'&&(outputRole||targetArtifactId))throw Error('文本步骤的 outputRole 必须是 primary 或 supporting');
    if(targetArtifactId){
      if(!task||typeof targetArtifactId!=='string')throw Error('修订目标必须属于已有事项');
      require('./deliverables.cjs').bind(a,{...task},targetArtifactId);
    }
    return {id:old?.id || uid(),key:stepKey,title,kind:s.kind,...(s.kind==='external'?{tool:s.tool}:{}),...(outputRole?{outputRole}:{}),...(targetArtifactId?{targetArtifactId}:{}),done:false};
  });
  const reset = args.resetSteps || [];
  if (!Array.isArray(reset) || reset.some(k => !proposed.some(s => s.key === k))) throw new Error('重新执行的步骤标识无效');
  // Preflight binding rules before changing any plan/status. New-task creation is checked
  // with a detached owner listed in a detached job; no source or live projection is changed.
  const checkTask={...(task||{id:'plan-preflight',agentJobId:job.id,projectId:job.projectId||null,sourceIds:[]}),agentCancelled:false};
  const checkApp={...a,data:{...a.data,delegations:a.data.delegations.map(j=>j.id===job.id?{...j,taskIds:[...j.taskIds,checkTask.id]}:j)}};
  require('./evidence-links.cjs').setInputs(checkApp,checkTask,sourceIds,supersededSourceIds);
  const outputs=require('./deliverables.cjs'),previousPrimary=task&&outputs.primary(a,task);
  if(args.primaryArtifactId!==undefined){if(!task||typeof args.primaryArtifactId!=='string'||!args.primaryArtifactId)throw Error('主稿绑定必须指定已有事项的稿件 ID');outputs.bind(checkApp,checkTask,args.primaryArtifactId);}
  const preservePrimary=args.primaryArtifactId===undefined&&task&&!Object.hasOwn(task,'primaryArtifactId')&&previousPrimary&&proposed.some(s=>s.outputRole==='supporting'&&s.id===previousPrimary.stepId)?previousPrimary.id:null;
  if(preservePrimary)outputs.bind(checkApp,checkTask,preservePrimary);
  const inputsChanged=!!task&&continuation.inputsChanged(a,job,task,checkTask);
  const repairPrimary=task?(outputs.primary(checkApp,checkTask)||previousPrimary):null;
  const repairCandidates=repairPrimary?proposed.filter(s=>s.kind!=='external'&&s.outputRole!=='supporting'&&(!s.targetArtifactId||s.targetArtifactId===repairPrimary.id)):[];
  const primaryRepairStep=repairCandidates.find(s=>s.targetArtifactId===repairPrimary.id||s.id===repairPrimary.stepId)||repairCandidates.findLast(s=>s.kind==='draft')||repairCandidates.at(-1);
  if(inputsChanged&&repairPrimary&&!primaryRepairStep)throw Object.assign(Error('新证据需要保留主稿修订文本步骤，请用 plan_task 补充后再交付'),{code:'PLAN_INPUT_INVALID',planInputInvalid:true});
  const bindingChanged=args.primaryArtifactId!==undefined&&args.primaryArtifactId!==task?.primaryArtifactId;
  const structural=!!task&&(JSON.stringify(task.steps.map(shape))!==JSON.stringify(proposed.map(shape))||JSON.stringify(dependsOn)!==JSON.stringify(task.dependsOn||[]));
  const resolution=require('./evidence-request.cjs').resolution(checkApp,job,task,checkTask,args,{structural,bindingChanged});
  let update;
  if (!task) {
    if (job.taskIds.filter(id=>!a.task(id).deletedAt).length >= 10) throw new Error('每个委托最多建立 10 个事项');
  } else {
    const description = task.userRequirement?.description??String(args.description ?? task.description).slice(0,10000);
    const diagnostic=task.contentVerification?.passed===false?task.contentVerification:task.verification?.passed===false?task.verification:null;
    const resetDiagnostic=diagnostic?{basis:diagnostic.basis,gaps:diagnostic.gaps,details:diagnostic.gapDetails}:task.planResetDiagnostic||null;
    const resetBasis=evidence.hash({intent:evidence.intent(job,task),sources:evidence.taskSources(checkApp,checkTask),dependencies:dependsOn,diagnostic:resetDiagnostic,request:task.evidenceRequest?.basis||task.lastEvidenceResolution?.basis||null});
    if(reset.length&&task.planResetBasis===resetBasis)throw Object.assign(Error('同一依据已调整过计划，请执行未完成步骤；新的证据或具体检查缺口才能再次重做'),{code:'PLAN_ALREADY_RECONCILED',taskId:task.id});
    const changed = inputsChanged || structural || bindingChanged || resolution || reset.length || task.needsReplan || task.agentCancelled || criteria !== task.criteria || description !== task.description || objective !== task.objective || JSON.stringify(sourceIds) !== JSON.stringify(task.sourceIds) || JSON.stringify(supersededSourceIds) !== JSON.stringify(task.supersededSourceIds || []);
    if (changed) {
      const reason = required(args.reason, '修改计划时需要说明原因', 2000);
      const history = {at:stamp(),reason,version:task.planVersion || 1,steps:structuredClone(task.steps),dependsOn:task.dependsOn || [],title:task.title,criteria:task.criteria,primaryArtifactId:task.primaryArtifactId,sourceIds:[...task.sourceIds],supersededSourceIds:[...(task.supersededSourceIds||[])]};
      // Steps execute in order: an edited/removed/reordered step invalidates its suffix.
      let dirty = JSON.stringify(dependsOn) !== JSON.stringify(task.dependsOn || []);
      const next = proposed.map((s,i) => {
        const old = task.steps[i];
        if (inputsChanged && s.kind!=='external') dirty = true;
        if (!old || JSON.stringify(shape(old)) !== JSON.stringify(shape(s)) || reset.includes(s.key)) dirty = true;
        return !dirty ? {...old,title:s.title} : {...s,...(old?.id===s.id&&old.artifactId?{artifactId:old.artifactId}:{}),...(s.kind!=='external'&&old?.id===s.id&&old.artifactId&&!s.targetArtifactId?{targetArtifactId:old.artifactId}:{}),...(previousPrimary?.stepId===s.id&&!s.outputRole?{outputRole:'primary'}:{}),...(inputsChanged&&s.id===primaryRepairStep?.id?{outputRole:'primary',targetArtifactId:repairPrimary.id}:{})};
      });
      update={reason,history,next,description,resetBasis,resetDiagnostic};
    }
  }
  const links=require('./evidence-links.cjs');
  // All validation is complete. Persist explicit withdrawals before any plan
  // projection so an older backup cannot resurrect the removed association.
  const workEvents=task&&args.removeSourceIds?.length?links.withdrawalEvents(a,task,args.removeSourceIds,{actor:'agent',reason:args.reason,command:'plan_task'}):[];
  const apply=(a,job,task,receipt,{deadline=true}={})=>{
    if(receipt)require('./work-journal.cjs').project(a,receipt);
    if(!task){
      task=a.createTask({...args,title,criteria,sourceIds});
      Object.assign(task,{projectId:job.projectId||null,agentJobId:job.id,agentKey:key,dependsOn,steps:proposed,planHistory:[],planVersion:1});job.taskIds.push(task.id);
    }else if(update){
      task.planHistory=[...(task.planHistory||[]),update.history].slice(-20);task.planVersion=(task.planVersion||1)+1;
      Object.assign(task,{title,description:update.description,criteria,dependsOn,steps:update.next,needsReplan:null,agentCancelled:false});
      if(reset.length){task.planResetBasis=update.resetBasis;task.planResetDiagnostic=update.resetDiagnostic;}
      if(task.status==='paused')task.status='todo';
      a.requeue(task);invalidateDependents(a,task);a.event('Agent 调整了计划',update.reason,task.id);
    }else{task.title=title;task.steps.forEach((s,i)=>{s.title=proposed[i].title;});}
    links.setInputs(a,task,sourceIds,supersededSourceIds);
    if(args.primaryArtifactId!==undefined)outputs.bind(a,task,args.primaryArtifactId);
    else if(preservePrimary||update&&previousPrimary)outputs.bind(a,task,preservePrimary||previousPrimary.id);
    if(update){task.contentVerification=null;delete task.completionCheck;}
    if(resolution){task.lastEvidenceResolution=resolution;delete task.evidenceRequest;}
    if(['high','normal','low'].includes(args.priority))task.priority=args.priority;
    if(objective!==undefined)task.objective=objective;
    if(pendingIntake){task.intake.status='organized';task.intake.organizedAt=stamp();if(job.intakeTaskId===task.id)job.title=title;}
    if(deadline&&args.dueAt!==undefined){
      require('./deadline-events.cjs').setPolicy(a,{taskId:task.id,input:{dueAt}});
      require('./deadline-scheduler.cjs').reconcile(a,{jobId:job.id});
    }
    task.updatedAt=stamp();return structuredClone({taskId:task.id,status:task.status,planVersion:task.planVersion,steps:task.steps,dependsOn});
  };
  if(task)return continuation.commit(a,job,task,args,{
    apply:(draft,draftJob,draftTask)=>apply(draft,draftJob,draftTask,null,{deadline:false}),
    withdrawals:workEvents.filter(e=>e.type==='context_bindings_withdrawn').flatMap(e=>e.payload.bindings),
    inputsChanged,dueAt,deadline:args.dueAt!==undefined,
  });
  return require('./state-transitions.cjs').commit(a,receipt=>apply(a,job,task,receipt),workEvents.length?{workEvents}:{});
}
function cancelTask(a, job, args) {
  require('./project-lifecycle.cjs').assertJobActive(a.data,job);
  const task = a.task(args.taskId);
  if (task.agentJobId !== job.id) throw new Error('事项不属于当前委托');
  const reason = required(args.reason, '取消原因', 2000);
  task.agentCancelled = true; task.status = 'paused'; task.cancelReason = reason;
  a.invalidate(task); invalidateDependents(a,task); a.event('Agent 取消了事项',reason,task.id); a.save();
  return {taskId:task.id,cancelled:true};
}
module.exports = {planTask,cancelTask,assertReady,dependencyIssues,invalidateDependents};
