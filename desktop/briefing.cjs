// Work briefings read retained local records only. They never start work or verify
// a remote receipt again; the difference is stated alongside every result.
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(object) : [];
const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const ranges = {'24h':86400000,'7d':604800000,'30d':2592000000};
const labels = {deliveries:'已核对的外部交付',completions:'完成记录',drafts:'尚未验收的产出',materials:'收集与材料变化',decisions:'当前待判断',followups:'当前等待与跟进',deadlines:'当前截止安排'};
const toolLabels = {write_file:'文件交付',github_create:'创建 GitHub Issue',github_update:'更新 GitHub Issue',github_comment:'追加 GitHub 评论',request_confirmation:'发送确认消息'};
const own = (o,key) => Object.prototype.hasOwnProperty.call(o,key);

function redactor(data) {
  const values = new Set();
  const collect = value => {if (typeof value === 'string' && value.length >= 3) values.add(value);else if (object(value)) Object.values(value).forEach(collect);};
  for (const provider of rows(data.providers)) for (const key of ['sealedKey','apiKey','key','token','baseUrl']) collect(provider[key]);
  for (const key of ['githubToken','searchKey','outputFolder']) collect(data.agentSettings?.[key]);
  for (const item of [...rows(data.folders),...rows(data.delegations)]) {collect(item.path);collect(item.outputFolder);}
  const secrets = [...values].sort((a,b)=>b.length-a.length);
  return value => {
    let text = typeof value === 'string' ? value : '';
    for (const value of secrets) text = text.split(value).join('[已隐藏]');
    return text.replace(/https?:\/\/[^\s，。；）]+/gi,'[网址已隐藏]')
      .replace(/(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|Volumes|private|etc|opt|data|workspace)\/)[^\n，。；）]+/g,'[路径已隐藏]')
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_|Bearer\s+)[A-Za-z0-9_.-]+/gi,'[凭据已隐藏]')
      .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s，。；]+/gi,'[凭据已隐藏]')
      .replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,180);
  };
}
function parameters(data,input) {
  if (!object(input)) throw new Error('工作简报参数无效');
  const projectId = own(input,'projectId') ? input.projectId : '';
  if (typeof projectId !== 'string' || projectId.length > 300 || (projectId && projectId !== '@independent' && !rows(data.projects).some(p=>p.id===projectId))) throw new Error('工作简报所属项目无效');
  const range = own(input,'range') ? input.range : '7d';
  if (typeof range !== 'string' || !own(ranges,range)) throw new Error('简报时间范围须为 24h、7d 或 30d');
  const pageSize = own(input,'pageSize') ? input.pageSize : 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('简报每页条数须为 1 至 100');
  const pages = own(input,'pages') ? input.pages : {};
  if (!object(pages) || Object.entries(pages).some(([key,value])=>!own(labels,key)||!Number.isSafeInteger(value)||value<1)) throw new Error('简报页码无效');
  return {projectId,range,pageSize,pages};
}
function build(a,input={}) {
  const data = object(a.data) ? a.data : {}, params = parameters(data,input), safe = redactor(data), now = Date.now();
  const {projectId,range} = params, from = now-ranges[range], all = Object.fromEntries(Object.keys(labels).map(key=>[key,[]]));
  const projects = new Map(rows(data.projects).map(p=>[p.id,p])), jobs = new Map(rows(data.delegations).map(j=>[j.id,j]));
  const tasks = new Map(rows(data.tasks).map(t=>[t.id,t])), sources = new Map(rows(data.sources).map(s=>[s.id,s])), artifacts = new Map(rows(data.artifacts).map(v=>[v.id,v]));
  const scope = value => value === undefined || value === null || value === '' ? '' : typeof value === 'string' && projects.has(value) ? value : null;
  const jobScope = job => job ? scope(job.projectId) : null;
  const taskScope = task => {
    if (!task) return null;
    const direct = scope(task.projectId);
    if (task.agentJobId) {const linked = jobScope(jobs.get(task.agentJobId));return linked === null || direct === null || (task.projectId && direct !== linked) ? null : linked;}
    return direct;
  };
  const selected = value => value !== null && (!projectId || (projectId === '@independent' ? value === '' : value === projectId));
  const routes = (task,job,owner) => ({...(task?{taskId:task.id}:{}),...(job?{jobId:job.id}:{}),...(owner?{projectId:owner}:{})});
  const base = (id,title,owner,at,route={}) => ({id,title:safe(title)||'未命名记录',project:owner?safe(projects.get(owner)?.name)||'所选项目':'独立工作',at:iso(at),route});
  const inRange = at => {const date = iso(at);return date && Date.parse(date)>=from && Date.parse(date)<=now;};
  const undated = new Set(), badScope = new Set();
  const timed = (kind,row,key) => {if (inRange(row.at)) all[kind].push(row);else if (!row.at) undated.add(`${kind}:${key}`);};
  const scopedActions = rows(data.agentActions).filter(action=>{
    const task = action.taskId ? tasks.get(action.taskId) : null, job = action.jobId ? jobs.get(action.jobId) : null;
    if ((action.taskId&&!task)||(action.jobId&&!job)||(!task&&!job)) {badScope.add(`action:${action.id}`);return false;}
    const owner = task ? taskScope(task) : jobScope(job);
    if (owner === null || (job && (jobScope(job)!==owner || (task && task.agentJobId!==job.id))) || (action.projectId && scope(action.projectId)!==owner)) {badScope.add(`action:${action.id}`);return false;}
    return selected(owner);
  });
  const receipt = (task,step) => {
    let evidence;try {evidence=JSON.parse(step.evidence);}catch{}
    const explicit=object(evidence)&&own(evidence,'actionId');
    return scopedActions.find(action=>{
      if (action.taskId!==task.id || action.tool!==step.tool || action.status!=='done' || action.result?.verified!==true) return false;
      // A newer explicit receipt must never be replaced by an old successful
      // write of the same artifact when the new receipt is missing or failed.
      if(explicit)return typeof evidence.actionId==='string'&&evidence.actionId===action.id;
      return !!step.artifactId&&action.artifactId===step.artifactId;
    });
  };
  const replaced = new Set(rows(data.sources).filter(s=>!s.projectExcluded && s.previousSourceId && scope(s.projectId)!==null && scope(s.projectId)===scope(sources.get(s.previousSourceId)?.projectId) && sources.has(s.previousSourceId)).map(s=>s.previousSourceId));
  function completion(task) {
    if (!task || task.status!=='completed' || task.agentCancelled || task.needsReplan || task.verification?.passed!==true || !Array.isArray(task.verification?.gaps) || task.verification.gaps.some(Boolean) || !Array.isArray(task.steps) || !task.steps.length || task.steps.some(step=>!object(step)||!['draft','analysis','external'].includes(step.kind)||step.done!==true)) return 'unverified';
    if (task.completionMode==='manual' || !require('./acceptance.cjs').currentBasis(a,task)) return 'unverified';
    const owner = taskScope(task);
    if (strings(task.sourceIds).filter(id=>!strings(task.supersededSourceIds).includes(id)).some(id=>{const s=sources.get(id);return !s||s.deleted||s.projectExcluded||replaced.has(id)||scope(s.projectId)!==owner;})) return 'unverified';
    let manual = false;
    for (const step of rows(task.steps)) {
      if (!step.done) return 'unverified';
      if (step.kind==='external') {
        if (step.tool && step.tool!=='manual') {if(!receipt(task,step))return 'unverified';}
        else {if(typeof step.evidence!=='string'||!step.evidence.trim())return 'unverified';manual=true;}
      } else {const artifact=artifacts.get(step.artifactId);if(!artifact||artifact.taskId!==task.id||typeof artifact.content!=='string'||!artifact.content.trim())return 'unverified';}
    }
    if (scopedActions.some(r=>r.taskId===task.id&&['uncertain','running'].includes(r.status))) return 'unverified';
    return manual?'manual_evidence':'checked';
  }
  const completionLabels = {checked:'已完成并通过检查',manual_evidence:'已完成，含人工执行证据',unverified:'已记录完成，证据待核对'};
  for (const task of tasks.values()) {
    const owner = taskScope(task);if(owner===null){badScope.add(`task:${task.id}`);continue;}if(!selected(owner)||task.agentCancelled)continue;
    const job = jobs.get(task.agentJobId), route = routes(task,job,owner), state = completion(task);
    if (task.status==='completed') timed('completions',{...base(`task:${task.id}`,task.title,owner,task.completedAt,route),kind:state,label:completionLabels[state],detail:state==='manual_evidence'?'外部步骤由人工提供执行证据；不代表已由连接器读回核对。':state==='unverified'?'完成状态缺少当前有效检查或完整步骤证据。':'当前步骤与检查记录完整；验收方式以事项记录为准。'},task.id);
    if (task.status==='review') all.decisions.push({...base(`review:${task.id}`,task.title,owner,task.updatedAt,route),kind:'review',label:'事项待验收',detail:'打开事项检查当前产出与完成标准。'});
    if (!job && task.status==='waiting') all.followups.push({...base(`waiting:${task.id}`,task.title,owner,task.updatedAt,route),kind:'task',label:'等待反馈',detail:'打开事项查看所需反馈。',deadlineAt:iso(task.dueAt),checkAt:iso(task.nextCheckAt),overdue:!!iso(task.dueAt)&&Date.parse(task.dueAt)<=now,paused:false});
    if (task.status!=='completed'&&iso(task.dueAt)) all.deadlines.push({...base(`due:${task.id}`,task.title,owner,task.dueAt,route),kind:'task',label:Date.parse(task.dueAt)<=now?'事项已到期':'事项截止时间',detail:task.status==='paused'||job?.status==='paused'?'当前已暂停；截止时间仍保留。':'以事项设置的截止时间为准。',overdue:Date.parse(task.dueAt)<=now});
  }
  for (const artifact of artifacts.values()) {
    const task=tasks.get(artifact.taskId),owner=taskScope(task);if(!task||!selected(owner)||task.agentCancelled)continue;
    const current=rows(task.steps).some(step=>step.artifactId===artifact.id&&step.done);
    if(current&&completion(task)!=='unverified')continue;
    timed('drafts',{...base(`artifact:${artifact.id}`,artifact.title||task.title,owner,artifact.createdAt,routes(task,jobs.get(task.agentJobId),owner)),kind:current?'current':'historical',label:current?'已有产出，尚未验收':'历史产出，当前步骤未引用',detail:'生成产出不等于已执行外部交付；正文请打开事项查看。'},artifact.id);
  }
  for (const action of scopedActions) {
    const task=tasks.get(action.taskId),job=jobs.get(action.jobId)||jobs.get(task?.agentJobId),owner=task?taskScope(task):jobScope(job),route=routes(task,job,owner);
    if (action.status==='done'&&action.result?.verified===true&&own(toolLabels,action.tool)) {
      const current = !!task && rows(task.steps).some(step=>step.done&&receipt(task,step)?.id===action.id);
      timed('deliveries',{...base(`action:${action.id}`,task?.title||job?.title,owner,action.finishedAt||action.completedAt||action.at,route),kind:action.tool,label:toolLabels[action.tool],detail:current?'执行时已读回核对，关联当前步骤。':'执行时已读回核对；属于历史动作，或当前步骤未引用。',current,verified:true},action.id);
    }
    if (['pending','uncertain','running'].includes(action.status)) all.decisions.push({...base(`action:${action.id}`,task?.title||job?.title,owner,action.createdAt,route),kind:action.status,label:action.status==='pending'?'外部动作待审批':action.status==='running'?'外部动作正在执行':'外部结果待核对',detail:action.status==='running'?'请等待执行结束；若发生中断，需先核对外部结果。':'打开所属工作检查具体动作和执行记录。'});
  }
  for (const source of sources.values()) {
    const owner=scope(source.projectId);if(owner===null){badScope.add(`source:${source.id}`);continue;}if(!selected(owner))continue;
    const changed=!!source.previousSourceId || (Number.isSafeInteger(source.version)&&source.version>1);
    const channel=source.feedConnectionId?'RSS 订阅':source.webConnectionId?'网页订阅':source.folderId?'本地目录':source.connectorId?'连接来源':'手动收集';
    timed('materials',{...base(`source:${source.id}`,source.title,owner,source.createdAt,owner?{projectId:owner}:{}),kind:changed?'version':'new',label:changed?'材料版本变化':'新收集材料',detail:`${channel} · ${source.deleted?'已撤回':source.projectExcluded?'已排除':replaced.has(source.id)?'已有更新版本':'当前版本'}`,version:Number.isSafeInteger(source.version)&&source.version>0?source.version:1},source.id);
  }
  for (const decision of rows(data.decisions).filter(d=>d.status==='open')) {
    const job=jobs.get(decision.jobId),owner=jobScope(job);if(!job||owner===null||(decision.projectId&&scope(decision.projectId)!==owner)){badScope.add(`decision:${decision.id}`);continue;}if(!selected(owner))continue;
    const task=strings(decision.taskIds).map(id=>tasks.get(id)).find(t=>t&&t.agentJobId===job.id&&taskScope(t)===owner);
    all.decisions.push({...base(`decision:${decision.id}`,task?.title||job.title,owner,decision.updatedAt||decision.createdAt,routes(task,job,owner)),kind:'decision',label:decision.kind==='timeout'?'跟进超时，需要判断':'需要补充决定',detail:'打开所属委托查看问题、依据和建议。'});
  }
  for (const job of jobs.values()) {
    const owner=jobScope(job);if(owner===null){badScope.add(`job:${job.id}`);continue;}if(!selected(owner))continue;
    if(['needs_input','approval','review'].includes(job.status)&&!all.decisions.some(d=>d.route.jobId===job.id))all.decisions.push({...base(`job:${job.id}`,job.title,owner,job.updatedAt,routes(null,job,owner)),kind:'job',label:'委托等待处理',detail:'打开委托查看当前需要处理的问题。'});
    for (const [index,followup] of rows(job.followups).entries()) {
      if(followup.status!=='waiting')continue;
      const task=followup.taskId?tasks.get(followup.taskId):null;
      if(followup.taskId&&(!task||task.agentJobId!==job.id||taskScope(task)!==owner)){badScope.add(`followup:${job.id}:${index}`);continue;}
      const route=routes(task,job,owner),paused=job.status==='paused',deadlineAt=iso(followup.deadlineAt),checkAt=iso(followup.checkAt),overdue=!!deadlineAt&&Date.parse(deadlineAt)<=now;
      const row={...base(`followup:${job.id}:${index}`,task?.title||job.title,owner,followup.createdAt,route),kind:'agent',label:overdue?'跟进已超时':'等待来源变化或反馈',detail:paused?'委托已暂停，自动跟进暂不执行。':'打开委托查看等待条件和证据；检查时间是计划值。',deadlineAt,checkAt,overdue,paused};
      all.followups.push(row);
      if(deadlineAt)all.deadlines.push({...row,id:`followup-due:${job.id}:${index}`,at:deadlineAt,kind:'followup',label:overdue?'跟进期限已过':'跟进截止时间'});
    }
  }
  for(const [key,items] of Object.entries(all))items.sort((a,b)=>key==='deadlines'?(a.at||'').localeCompare(b.at||'')||a.id.localeCompare(b.id):(b.at||'').localeCompare(a.at||'')||a.id.localeCompare(b.id));
  const counts=Object.fromEntries(Object.entries(all).map(([key,items])=>[key,items.length]));
  const verifiedCompletions=all.completions.filter(row=>row.kind==='checked').length,manualCompletions=all.completions.filter(row=>row.kind==='manual_evidence').length;
  return {params,all,report:{generatedAt:new Date(now).toISOString(),from:new Date(from).toISOString(),to:new Date(now).toISOString(),projectId,range,scopeLabel:projectId==='@independent'?'独立工作':projectId?safe(projects.get(projectId).name)||'所选项目':'全部项目与独立工作',counts,completionCounts:{checked:verifiedCompletions,manualEvidence:manualCompletions,unverified:all.completions.length-verifiedCompletions-manualCompletions},modelCalls:0,networkRequests:0,notices:[...(undated.size?[`${undated.size} 条范围内候选记录缺少有效发生时间，未计入期间进展。`]:[]),...(!projectId&&badScope.size?[`${badScope.size} 条记录归属不完整或相互冲突，未计入简报。`]:[])],limitations:['期间进展按本机保留记录的发生时间汇总；待判断、等待跟进和截止安排展示当前状态，不受所选回顾时间限制。','外部交付只统计执行时有读回核对记录的动作；没有再次联网验证，历史交付不代表当前文件或外部内容仍未变化。','完成记录要求仍处于完成状态；修改后重新推进的事项、已删除或被保留上限裁剪的历史无法完整还原。人工执行证据与连接器核对分开标注。','概览与导出仅含脱敏标题和结构化状态，省略材料、产出、问题、消息正文与路径、网址、凭据；工作标题仍可能包含业务信息，分享前请检查。','所有导出包含当前筛选的全部匹配记录；预览按栏目分页。计划检查时间不保证实际执行，仍受 App 运行、托管开关、时间窗口与额度影响。']}};
}
function snapshot(a,input={}) {
  const {params,all,report}=build(a,input);
  report.sections=Object.fromEntries(Object.entries(all).map(([key,items])=>{
    const total=items.length,pageCount=Math.max(1,Math.ceil(total/params.pageSize)),page=Math.min(params.pages[key]||1,pageCount),start=(page-1)*params.pageSize;
    return [key,{label:labels[key],period:['decisions','followups','deadlines'].includes(key)?'current':'range',items:items.slice(start,start+params.pageSize),total,page,pageSize:params.pageSize,pageCount,from:total?start+1:0,to:Math.min(start+params.pageSize,total)}];
  }));return report;
}
const md = value => String(value||'').replace(/[\\`*_{}[\]<>#|]/g,'\\$&').replace(/\r?\n/g,' ');
function exportReport(a,input={}) {
  if(!object(input)||!['md','json'].includes(input.format))throw new Error('简报导出格式须为 Markdown 或 JSON');
  const {all,report}=build(a,input),{projectId,...publicReport}=report;
  publicReport.sections=Object.fromEntries(Object.entries(all).map(([key,items])=>[key,{label:labels[key],total:items.length,items:items.map(({id,route,...item})=>item)}]));
  const content=input.format==='json'?JSON.stringify(publicReport,null,2):[
    '# 行知助手工作简报','',`范围：${md(report.scopeLabel)}`,`期间：${report.from} 至 ${report.to}`,`生成时间：${report.generatedAt}`,'','## 汇总','',...Object.keys(labels).map(key=>`- ${labels[key]}：${report.counts[key]} 条`),`- 完成记录分类：检查通过 ${report.completionCounts.checked}；含人工执行证据 ${report.completionCounts.manualEvidence}；证据待核对 ${report.completionCounts.unverified}`,
    ...Object.entries(publicReport.sections).flatMap(([key,section])=>['',`## ${section.label}${['decisions','followups','deadlines'].includes(key)?'（当前状态）':'（所选期间）'}`,'',...(section.items.length?section.items.flatMap(item=>[`- **${md(item.title)}** · ${md(item.project)} · ${md(item.label)}`,`  - 时间：${item.at||'未记录'}；${md(item.detail)}`,...(item.deadlineAt?[`  - 截止：${item.deadlineAt}`]:[]),...(item.checkAt?[`  - 计划检查：${item.checkAt}`]:[])]):['暂无匹配记录。'])]),'','## 范围与说明','',...report.notices.map(note=>`- ${md(note)}`),...report.limitations.map(note=>`- ${md(note)}`)
  ].join('\n');
  return {filename:`行知工作简报-${report.generatedAt.slice(0,10)}-${report.range}.${input.format}`,mime:input.format==='json'?'application/json':'text/markdown',content};
}
function dispatch(a,action,input={}) {
  if(action==='briefingSnapshot')return snapshot(a,input);
  if(action==='briefingExport')return exportReport(a,input);
  throw new Error('未知工作简报操作');
}
module.exports={snapshot,exportReport,dispatch};
