const crypto=require('node:crypto');
const now=()=>new Date().toISOString();
const rows=value=>Array.isArray(value)?value:[];
const modes=['fileMode','githubMode','githubUpdateMode','githubCommentMode'];
const lifecycleKeys=['archivedAt','reopenedAt','lifecycleRevision','archiveSummary'];
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function isActive(data,projectId){return !projectId||projectId==='@independent'||rows(data.projects).some(p=>p.id===projectId&&!p.archivedAt);}
function assertActive(data,projectId){
  if(isActive(data,projectId))return;
  const p=rows(data.projects).find(p=>p.id===projectId);
  throw new Error(p?`项目「${p.name}」已归档，请先重新打开项目；采集与执行仍需分别恢复。`:'项目不存在，请重新选择');
}
function byId(data,id){const p=rows(data.projects).find(p=>p.id===id);if(!p)throw new Error('项目不存在');return p;}
function scope(data,id){
  const project=byId(data,id),rules=rows(data.workRules).filter(r=>r.config?.projectId===id),ruleIds=new Set(rules.map(r=>r.id));
  const jobs=rows(data.delegations).filter(j=>j.projectId===id||j.id===project.jobId||ruleIds.has(j.ruleId)),jobIds=new Set(jobs.map(j=>j.id));
  const tasks=rows(data.tasks).filter(t=>t.projectId===id||jobIds.has(t.agentJobId)||jobs.some(j=>rows(j.taskIds).includes(t.id))),taskIds=new Set(tasks.map(t=>t.id));
  const pendingIds=new Set(jobs.map(j=>j.pendingActionId).filter(Boolean));
  const select=key=>rows(data[key]).filter(r=>r.projectId===id);
  const actions=rows(data.agentActions).filter(r=>r.projectId===id||jobIds.has(r.jobId)||taskIds.has(r.taskId)||pendingIds.has(r.id));
  const schedule=data.briefingSchedule?.projectId===id?data.briefingSchedule:null;
  return {project,jobs,tasks,rules,actions,folders:select('folders'),webConnections:select('webConnections'),feedConnections:select('feedConnections'),connectors:select('connectors'),routing:select('intakeRoutingRules'),capture:select('captureQueue'),schedule,
    sources:select('sources'),artifacts:rows(data.artifacts).filter(r=>r.projectId===id||taskIds.has(r.taskId))};
}
function revision(s){return hash(s);}
function preview(a,input={}){
  const s=scope(a.data,input.id),group=(key,label,items)=>({key,label,count:items.length,items:items.map(row=>({id:row.id,name:row.name||row.title||row.config?.name||row.projectName||row.id}))});
  const groups=[group('jobs','暂停委托',s.jobs.filter(j=>!['completed','paused'].includes(j.status))),group('tasks','暂停未完成事项',s.tasks.filter(t=>!t.agentCancelled&&!['completed','paused'].includes(t.status))),group('rules','停用工作规则',s.rules.filter(r=>r.status!=='archived'&&r.status!=='paused')),
    group('folders','停用资料目录',s.folders.filter(r=>r.enabled!==false)),group('webConnections','停用网页订阅',s.webConnections.filter(r=>r.enabled)),group('feedConnections','停用 RSS 订阅',s.feedConnections.filter(r=>r.enabled)),group('connectors','停用信息连接',s.connectors.filter(r=>r.enabled)),group('routing','停用自动归类',s.routing.filter(r=>r.enabled)),group('capture','暂停收集队列',s.capture.filter(r=>['queued','processing'].includes(r.status)||r.autoRetry?.enabled===true)),group('approvals','作废尚未执行的确认',s.actions.filter(r=>r.status==='pending')),
    group('writeModes','撤销自动写入',s.jobs.filter(j=>modes.some(key=>j[key]==='auto'))),group('sendPolicies','撤销飞书发送授权',s.connectors.filter(c=>c.sendPolicy&&c.sendPolicy.mode!=='off'))];
  if(s.schedule)groups.push(group('briefing','停用此项目定时简报',s.schedule.enabled?[{id:'briefing',name:'项目定时简报'}]:[]));
  const unresolved=s.actions.filter(r=>['running','uncertain'].includes(r.status)).map(r=>({id:r.id,tool:r.tool||'外部动作',title:r.title||'待核对动作',status:r.status,jobId:r.jobId||s.jobs.find(j=>j.pendingActionId===r.id)?.id||null,taskId:r.taskId||null}));
  return {projectId:s.project.id,projectName:s.project.name,archivedAt:s.project.archivedAt||null,reopenedAt:s.project.reopenedAt||null,revision:revision(s),groups,unresolved,preserved:{tasks:s.tasks.length,sources:s.sources.length,artifacts:s.artifacts.length,receipts:s.actions.length},modelCalls:0,networkRequests:0};
}
function validCompletions(data,s){
  const acceptance=require('./acceptance.cjs'),a={data};
  // A policy restriction may change verification hashes, but it cannot repair
  // stale evidence or settle an unknown external result.
  if(s.actions.some(r=>['running','uncertain'].includes(r.status)))return {tasks:[],checkpoints:[]};
  const tasks=s.tasks.filter(t=>t.status==='completed'&&typeof t.verification?.basis==='string'&&t.verification.basis===acceptance.basis(a,t)&&acceptance.reasons(a,t,{completed:true}).length===0),ids=new Set(tasks.map(t=>t.id));
  const checkpoints=s.jobs.filter(j=>{
    const active=rows(j.taskIds).map(id=>rows(data.tasks).find(t=>t.id===id)).filter(t=>t&&!t.agentCancelled);
    return j.acceptanceCheckpoint?.basis===acceptance.completionBasis(a,j)&&active.length>0&&active.every(t=>ids.has(t.id))&&!rows(j.followups).some(f=>f.status==='waiting')&&!rows(data.decisions).some(d=>d.jobId===j.id&&d.status==='open')&&!s.connectors.some(c=>c.cursor?.token);
  });
  return {tasks,checkpoints};
}
function migrateCompletions(data,eligible,at){
  const acceptance=require('./acceptance.cjs'),a={data},pending=new Map(eligible.tasks.map(t=>[t.id,t])),done=new Set();
  function migrate(task){
    if(done.has(task.id))return;done.add(task.id);
    for(const id of rows(task.dependsOn))if(pending.has(id))migrate(pending.get(id));
    const previousBasis=task.verification.basis,basis=acceptance.basis(a,task);
    if(basis!==previousBasis)task.verification={...task.verification,basis,policyOnlyMigration:{reason:'project_archive_permission_restriction',at,previousBasis,basis}};
  }
  for(const task of eligible.tasks)migrate(task);
  for(const job of eligible.checkpoints){const previousBasis=job.acceptanceCheckpoint.basis,basis=acceptance.completionBasis(a,job);if(basis!==previousBasis)job.acceptanceCheckpoint={...job.acceptanceCheckpoint,basis,policyOnlyMigration:{reason:'project_archive_permission_restriction',at,previousBasis,basis}};}
}
function pauseScope(data,id,at=now()){
  const s=scope(data,id),eligible=validCompletions(data,s);
  for(const rule of s.rules){if(rule.status!=='archived')rule.status='paused';rule.nextRunAt=null;rule.waitingForJob=false;rule.summary='项目已归档，工作规则保持暂停';for(const key of modes)if(rule.config?.[key]==='auto')rule.config[key]='ask';}
  for(const task of s.tasks)if(!task.agentCancelled&&task.status!=='completed'&&task.status!=='paused'){task.previousStatus=task.status==='running'?'blocked':task.status;task.status='paused';task.updatedAt=at;}
  for(const record of s.actions)if(record.status==='pending'){record.status='stale';delete record.approvedAt;record.staleReason='项目已归档，请重新打开并重新准备后确认';}
  for(const job of s.jobs){
    if(job.status!=='completed')job.status='paused';job.nextRunAt=null;job.resumeWatching=false;job.retryCheck=false;delete job.rulePausedState;
    for(const key of modes)if(job[key]==='auto')job[key]='ask';
    const pending=s.actions.find(r=>r.id===job.pendingActionId);
    if(!pending||!['running','uncertain'].includes(pending.status))job.pendingActionId=s.actions.find(r=>r.jobId===job.id&&['running','uncertain'].includes(r.status))?.id||null;
    if(job.status!=='completed')job.summary='项目已归档；未决外部回执保留，重新打开后再核对与恢复';
    job.updatedAt=at;
  }
  for(const row of [...s.folders,...s.webConnections,...s.feedConnections,...s.connectors]){row.enabled=false;row.nextRunAt=null;row.health='paused';}
  for(const row of s.connectors)if(row.sendPolicy&&row.sendPolicy.mode!=='off')row.sendPolicy={...row.sendPolicy,mode:'off',revision:crypto.randomUUID(),updatedAt:at};
  for(const row of s.routing){row.enabled=false;row.disabledReason='项目已归档';}
  require('./capture.cjs').revokeRetries(data,{projectId:id});
  for(const row of s.capture)if(['queued','processing'].includes(row.status)){row.status='failed';row.updatedAt=at;row.lastError='项目已归档，收集处理已暂停。已导入材料及暂存文件保留；重新打开项目后可重试剩余步骤。';}
  if(s.schedule){s.schedule.enabled=false;s.schedule.nextRunAt=null;for(const r of rows(s.schedule.runs))if(r.status==='running'){r.status='interrupted';r.error='项目已归档；重新打开后可核对原保存记录';}}
  migrateCompletions(data,eligible,at);
}
function initialize(a){for(const p of rows(a.data.projects))if(p.archivedAt)pauseScope(a.data,p.id,p.archivedAt);}
function retain(current,restored){
  restored.projects ||= [];
  for(const currentProject of rows(current.projects)){
    let p=restored.projects.find(p=>p.id===currentProject.id);
    if(!p){p=structuredClone(currentProject);restored.projects.push(p);}
    for(const key of lifecycleKeys){if(Object.hasOwn(currentProject,key))p[key]=structuredClone(currentProject[key]);else delete p[key];}
  }
  const changedProjects=new Set(rows(current.projects).filter(p=>p.lifecycleRevision).map(p=>p.id));
  for(const rule of rows(restored.workRules))if(changedProjects.has(rule.config?.projectId)){
    const live=rows(current.workRules).find(r=>r.id===rule.id&&r.config?.projectId===rule.config.projectId);
    for(const key of modes){if(live){if(Object.hasOwn(live.config,key))rule.config[key]=live.config[key];else delete rule.config[key];}else if(rule.config[key]==='auto')rule.config[key]='ask';}
    rule.status=live?.status==='archived'?'archived':'paused';rule.nextRunAt=null;rule.waitingForJob=false;
  }
  initialize({data:restored});
}
function change(a,input,archive){
  a.ensureIdle();const s=scope(a.data,input.id);
  if(input.revision!==revision(s))throw new Error('项目或关联工作已变化，请刷新归档预览后再操作');
  if(archive&&s.project.archivedAt)throw new Error('项目已经归档');
  if(!archive&&!s.project.archivedAt)throw new Error('项目尚未归档');
  const at=now();
  require('./state-transitions.cjs').commit(a,()=>{
    if(archive){
      const impact=preview(a,input);pauseScope(a.data,input.id,at);
      s.project.archivedAt=at;s.project.archiveSummary={at,groups:impact.groups.map(g=>({key:g.key,count:g.count})),unresolved:impact.unresolved.length};
      if(s.schedule)s.schedule.revision=crypto.randomUUID();
      a.event('项目已归档',`${s.project.name}：采集、推进和发送授权已暂停；历史材料、交付和 ${impact.unresolved.length} 条待核对回执保留。`);
    }else{
      delete s.project.archivedAt;s.project.reopenedAt=at;
      a.event('项目已重新打开',`${s.project.name}：委托、事项、连接与规则继续保持暂停；需要使用的入口请分别恢复。`);
    }
    s.project.updatedAt=at;s.project.lifecycleRevision=crypto.randomUUID();
  });
  return a.publicState();
}
function jobProjects(data,j){return j?[...new Set([j.projectId,...rows(data.projects).filter(p=>p.jobId===j.id).map(p=>p.id),rows(data.workRules).find(r=>r.id===j.ruleId)?.config?.projectId].filter(Boolean))]:[];}
function taskProjects(data,t){return t?[...new Set([t.projectId,...rows(data.delegations).filter(j=>j.id===t.agentJobId||rows(j.taskIds).includes(t.id)).flatMap(j=>jobProjects(data,j)),...rows(data.projects).filter(p=>p.jobId===t.agentJobId).map(p=>p.id)].filter(Boolean))]:[];}
function isJobActive(data,j){return jobProjects(data,j).every(id=>isActive(data,id));}
function isTaskActive(data,t){return !t?.deletedAt&&taskProjects(data,t).every(id=>isActive(data,id));}
function assertJobActive(data,j){for(const id of jobProjects(data,j))assertActive(data,id);}
function assertTaskActive(data,t){require('./task-trash.cjs').assertTask(t);for(const id of taskProjects(data,t))assertActive(data,id);}
function taskProject(data,t){return t?.projectId||rows(data.delegations).find(j=>j.id===t?.agentJobId)?.projectId||rows(data.projects).find(p=>p.jobId===t?.agentJobId)?.id||null;}
function jobProject(data,j){return j?.projectId||rows(data.projects).find(p=>p.jobId===j?.id)?.id||rows(data.workRules).find(r=>r.id===j?.ruleId)?.config?.projectId||null;}
function assertDispatch(a,action,input={}){
  if(typeof action!=='string'||!rows(a.data.projects).some(p=>p.archivedAt))return;
  const d=a.data,check=id=>assertActive(d,id),find=(key,id)=>rows(d[key]).find(r=>r.id===id),task=id=>assertTaskActive(d,find('tasks',id)),job=id=>assertJobActive(d,find('delegations',id));
  if(action.startsWith('projectLifecycle')||action.startsWith('deliveryBundle'))return;
  if(['projectSave','projectFeedback','projectUndo','projectAttach'].includes(action)){if(input.id)check(input.id);return;}
  if(['importDocuments','captureSave','captureEnqueue','agentCreate','createTask'].includes(action)){check(input.projectId);return;}
  if(action==='import'){for(const item of rows(input.items))check(item.projectId);return;}
  if(action==='extract'){for(const id of rows(input.ids))check(find('sources',id)?.projectId);return;}
  if(action==='deleteSource'){check(find('sources',input.id)?.projectId);return;}
  if(['advance','updateTask'].includes(action)||action==='taskAction'&&input.command!=='pause'){task(input.id);return;}
  if(['acceptanceAccept','operationsSchedule'].includes(action)){for(const item of rows(input.items))task(item.id);return;}
  if(['agentRun','agentResume','agentFeedback','agentBudget','agentResolve','agentApprove','agentReject','agentLarkCreatePolicy','agentContract','agentRepairValidation'].includes(action)){job(input.id);return;}
  if(['ruleSave','ruleRun','ruleResume'].includes(action)){check(find('workRules',input.id)?.config?.projectId);check(input.projectId);return;}
  for(const [prefix,key] of [['connector','connectors'],['webConnection','webConnections'],['feedConnection','feedConnections'],['folder','folders']])if(action===prefix+'Save'||action===prefix+'Configure'||action===prefix+'Sync'||action===prefix+'Toggle'&&input.enabled){check(find(key,input.id)?.projectId);check(input.projectId);return;}
  if(action==='captureRetry'){check(find('captureQueue',input.id)?.projectId);return;}
  if(['intakeRoutingSave','intakeRoutingResolve'].includes(action)||action==='intakeRoutingToggle'&&input.enabled){check(find('intakeRoutingRules',input.id)?.projectId);check(input.projectId);return;}
  if(['decisionAnswer','decisionTimeout'].includes(action)){job(find('decisions',input.id)?.jobId);return;}
  if(action==='communicationPolicy'&&input.mode!=='off'){check(find('connectors',input.connectorId)?.projectId);return;}
  if(['communicationEdit','communicationCheck'].includes(action)){const r=find('agentActions',input.actionId);check(r?.projectId);job(r?.jobId);return;}
  if(['briefingScheduleSave','briefingScheduleRun','briefingScheduleRetry'].includes(action)){if(action==='briefingScheduleSave')check(input.projectId);else check(d.briefingSchedule?.projectId);return;}
  if(action==='memorySave'||action==='memoryToggle'&&input.enabled){check(find('memories',input.id)?.projectId);check(input.projectId);}
}
function dispatch(a,action,input={}){
  if(action==='projectLifecyclePreview')return preview(a,input);
  if(action==='projectLifecycleArchive')return change(a,input,true);
  if(action==='projectLifecycleReopen')return change(a,input,false);
  throw new Error('未知项目归档操作');
}
module.exports={initialize,isActive,assertActive,assertDispatch,preview,retain,dispatch,pauseScope,taskProject,jobProject,isJobActive,isTaskActive,assertJobActive,assertTaskActive};
