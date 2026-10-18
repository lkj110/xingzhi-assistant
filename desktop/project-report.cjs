const access=require('./protocol-access.cjs');
const acceptance=require('./acceptance.cjs');
const path = require('node:path');

const taskLabels = {todo:'待推进',running:'正在推进',waiting:'等待反馈',review:'待验收',completed:'已完成',blocked:'需要关注',paused:'已暂停'};
const jobLabels = {...taskLabels,ready:'待继续',watching:'持续跟进',approval:'待审批',needs_input:'需要补充',limited:'额度已用完',retry:'等待重试'};
const tools = {write_file:'文件交付',github_create:'创建 Issue',github_update:'更新 Issue',github_comment:'追加评论',request_confirmation:'发送确认消息'};
const completionLabels={checked:'已完成，当前检查有效',manual_evidence:'已完成，当前检查有效（含人工执行证据）',manual_completed:'人工确认完成，非当前检查通过',unverified:'已记录完成，当前检查待核对'};
const limits = {rows:100,artifacts:50,body:12000,totalBody:120000};
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const date = value => iso(value) || '未记录';
const currentStep = (task,id) => (task.steps || []).some(step => step.done && step.artifactId === id);
const receiptStep = (task,record) => (task.steps || []).some(step => {if (!step.done || step.tool !== record.tool) return false;try {return JSON.parse(step.evidence).actionId === record.id;} catch {return false;}});
const latest = values => values.map(iso).filter(Boolean).sort().at(-1) || null;
const first = values => values.map(iso).filter(Boolean).sort()[0] || null;
// Only explicit public web addresses are exported. Internal paths, credentials,
// query parameters and fragments are never inferred from connector configuration.
function publicLink(value) {
  try {const u = new URL(value);return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? `${u.protocol}//${u.host}${u.pathname}` : null;} catch {return null;}
}
function fileName(value) {return typeof value === 'string' ? path.win32.basename(path.basename(value)) : '';}
function md(value) {return String(value || '').replace(/[\\`*_{}[\]<>#|]/g,'\\$&').replace(/\r?\n/g,' ');}
function markdown(r) {
  const lines = [`# ${md(r.project.name)} · 项目进展简报`, '', `生成时间：${r.generatedAt}；最近记录更新：${date(r.lastUpdatedAt)}`, '', '此简报依据本机保存的状态汇总，未调用模型、未重新查询外部服务。已核对交付指上次执行时读回成功，不代表外部内容此后未变化。', '', '## 进展', '', `- 已完成并通过检查：${r.progress.completed} / ${r.progress.total} 项（当前依据有效，不含人工执行证据）`, `- 历史已验收：${r.progress.historicalAccepted} 项；当前检查待核对：${r.progress.unverified} 项`, `- 当前检查有效但含人工执行证据：${r.progress.manualEvidence} 项；人工确认完成：${r.progress.manualCompleted} 项（不代表连接器读回核对）`, `- 待判断：${r.totals.decisions}；等待反馈：${r.totals.followups}；已到期事项：${r.progress.overdueTasks}；外部结果待核对：${r.progress.uncertainWrites}`, `- 下一次自动检查：${date(r.nextCheckAt)}；${md(r.automatic.message)}`, `- 取消事项 ${r.progress.cancelled} 项不计入进度。历史验收不等于当前检查通过；暂停、待验收和需重做的事项不计为当前通过。`, '', '## 事项与完成标准', ''];
  for (const t of r.tasks) lines.push(`- **${md(t.title)}**（${md(t.label)}，${t.ref}）`, `  - 完成标准：${md(t.criteria) || '未填写'}；截止：${date(t.dueAt)}`, `  - 下一步：${md(t.nextStep) || '等待验收或下一次推进'}${t.needsReplan ? `；需重做：${md(t.needsReplan)}` : ''}${t.staleSources ? '；引用材料已变化或无法使用' : ''}`, `  - 当前依据：${t.sourceRefs.join('、') || '未关联当前项目材料'}`);
  if (!r.tasks.length) lines.push('暂无事项。');
  lines.push('', '## 待判断与阻塞', '');
  for (const d of r.decisions) lines.push(`- ${md(d.kind)}：${md(d.question)}${d.suggestion ? `；建议：${md(d.suggestion)}` : ''}（${d.taskRefs.join('、') || '项目委托'}）`);
  for (const b of r.blockers) lines.push(`- ${md(b.title)}：${md(b.reason)}${b.taskRef ? `（${b.taskRef}）` : ''}`);
  if (!r.decisions.length && !r.blockers.length) lines.push('暂无需要处理的记录。');
  lines.push('', '## 持续跟进', '');
  for (const f of r.followups) lines.push(`- ${md(f.expected)}：${f.overdue ? '已超时' : '等待结果'}；期限 ${date(f.deadlineAt)}；下次检查 ${date(f.checkAt)}${f.paused ? '；委托已暂停' : ''}（${f.taskRef || '项目委托'}）`);
  if (!r.followups.length) lines.push('暂无等待中的跟进。');
  lines.push('', '## 当前材料依据', '');
  for (const s of r.sources) lines.push(`- ${s.ref} ${md(s.title)} · 第 ${s.version} 版 · ${date(s.at)}${s.url ? ` · [来源](${s.url.replace(/[()]/g,c=>encodeURIComponent(c))})` : ''}`);
  if (!r.sources.length) lines.push('暂无当前项目材料。');
  lines.push('', '## 当前产出', '');
  for (const a of r.artifacts) {
    lines.push(`### ${a.ref} ${md(a.title)}`, '', `${md(a.completionLabel)}${a.historicalAccepted ? '；保留历史验收记录' : ''}；生成于 ${date(a.at)}；关联 ${a.taskRef}；依据 ${a.sourceRefs.join('、') || '未关联当前材料'}。`, '');
    if (r.includeArtifactContent) lines.push('正文（引用块）：', '', ...(a.content || '').split('\n').map(line => `> ${line}`), '', ...(a.contentTruncated ? ['正文已截断，请在 App 中打开完整产出。', ''] : []));
  }
  if (!r.artifacts.length) lines.push('暂无当前产出。');
  if (!r.includeArtifactContent) lines.push('', '本次未附产出正文。');
  lines.push('', '## 已核对的外部交付', '');
  for (const d of r.deliveries) lines.push(`- ${md(d.label)} · ${md(d.title)} · ${date(d.at)}${d.filename ? ` · 文件名：${md(d.filename)}` : ''}${d.url ? ` · [外部记录](${d.url.replace(/[()]/g,c=>encodeURIComponent(c))})` : ''}${d.artifactRef ? ` · ${d.artifactRef}` : ''}${d.receiptId ? ` · 回执 ${md(d.receiptId)}` : ''}`);
  if (!r.deliveries.length) lines.push('暂无关联当前产出或当前步骤的已核对交付。');
  lines.push('', '## 范围与省略', '', `历史或撤回材料 ${r.excluded.sources} 份；历史产出 ${r.excluded.artifacts} 份；历史交付 ${r.excluded.deliveries} 条。正文来自你保存的材料与产出；分享前请自行检查其中的工作内容。`);
  if (r.truncated) lines.push('', `本次内容有截断：${r.notices.map(md).join('；')}。完整内容请在 App 中查看。`);
  return lines.join('\n');
}

function report(a,input={}){return access.derivedRead(a,()=>reportOnce(a,input));}
function reportOnce(a, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目简报参数无效');
  const projectId = input.projectId || input.id;
  const p = a.data.projects.find(p => p.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (input.includeArtifactContent !== undefined && typeof input.includeArtifactContent !== 'boolean') throw new Error('是否附产出正文须为布尔值');
  const data = a.data, now = Date.now(), notices = new Set();
  const trim = (value, max = 1000) => {const text = String(value || '');if (text.length <= max) return text;notices.add('部分标题、说明或完成标准超出长度限制');return text.slice(0,max) + '…';};
  const bound = (rows,name,count=limits.rows) => {if (rows.length > count) notices.add(`${name}仅展示前 ${count} 条，共 ${rows.length} 条`);return rows.slice(0,count);};
  const jobs = data.delegations.filter(j => j.projectId === p.id), jobIds = new Set(jobs.map(j => j.id));
  const scopeOf = task => task.projectId || data.delegations.find(j => j.id === task.agentJobId)?.projectId;
  const scopedTasks = data.tasks.filter(t => scopeOf(t) === p.id), taskIds = new Set(scopedTasks.map(t => t.id));
  const sourceRows = data.sources.filter(s => s.projectId === p.id);
  const replaced = new Set(sourceRows.filter(s => !s.projectExcluded).map(s => s.previousSourceId).filter(Boolean));
  const currentSources = sourceRows.filter(s => !s.deleted && !s.projectExcluded && !replaced.has(s.id) && access.canReadSnapshot(a,'source',s,{projectId:p.id}));
  const sourceRefs = new Map(currentSources.map((s,i) => [s.id,`S${i+1}`]));
  const taskRefs = new Map(scopedTasks.map((t,i) => [t.id,`T${i+1}`]));
  const unavailable = t => (t.sourceIds || []).filter(id => !(t.supersededSourceIds || []).includes(id) && (!sourceRefs.has(id)||!access.canReadSnapshot(a,'source',data.sources.find(s=>s.id===id),{task:t,projectId:p.id})));
  const sound = t => !t.agentCancelled && !t.needsReplan && !unavailable(t).length;
  const checks=acceptance.presentationChecks(a);
  const historicalAccepted=t=>!!t.acceptedAt||!!t.acceptanceHistory?.length;
  const completionKind=t=>{
    if(t.status!=='completed'||t.agentCancelled)return null;
    if(t.completionMode==='manual')return 'manual_completed';
    if(!sound(t)||checks(t,true).length)return 'unverified';
    const artifactIds=[...new Set([...(t.steps||[]).map(step=>step.artifactId),t.primaryArtifactId].filter(Boolean))];
    if(artifactIds.some(id=>!access.canReadSnapshot(a,'artifact',data.artifacts.find(value=>value.id===id&&value.taskId===t.id),{task:t,projectId:p.id})))return 'unverified';
    if(data.agentActions.some(record=>record.taskId===t.id&&record.status==='done'&&(record.result?.verified!==true||record.deliveryConflict)&&(currentStep(t,record.artifactId)||receiptStep(t,record))))return 'unverified';
    let manual=false;
    for(const step of (t.steps||[]).filter(step=>step.kind==='external')){
      let receipt;try{receipt=JSON.parse(step.evidence);}catch{}
      if(!receipt?.actionId){if(step.tool&&step.tool!=='manual')return 'unverified';manual=true;}
    }
    return manual?'manual_evidence':'checked';
  };
  const completionKinds=new Map(scopedTasks.map(task=>[task.id,completionKind(task)]));
  const completed=t=>completionKinds.get(t.id)==='checked';
  const currentCheckValid=t=>['checked','manual_evidence'].includes(completionKinds.get(t.id));
  const completionLabel=t=>t.agentCancelled?'已取消':completionLabels[completionKinds.get(t.id)]||taskLabels[t.status]||'状态待核对';
  const artifacts = data.artifacts.filter(r => taskIds.has(r.taskId));
  const taskMap = new Map(scopedTasks.map(t => [t.id,t]));
  const currentArtifacts = artifacts.filter(r => sound(taskMap.get(r.taskId)) && currentStep(taskMap.get(r.taskId),r.id) && access.canReadSnapshot(a,'artifact',r,{task:taskMap.get(r.taskId),projectId:p.id}));
  const artifactRefs = new Map(currentArtifacts.map((r,i) => [r.id,`A${i+1}`]));
  const actions = data.agentActions.filter(r => (!r.projectId || r.projectId === p.id) && (!r.jobId || jobIds.has(r.jobId)) && (r.taskId ? taskIds.has(r.taskId) : jobIds.has(r.jobId)));
  const currentWrite = r => {
    const task=taskMap.get(r.taskId);
    if(r.deliveryConflict||actions.some(record=>['uncertain','running'].includes(record.status)&&(record.taskId===r.taskId||!record.taskId&&record.jobId&&record.jobId===r.jobId)))return false;
    if(!r.artifactId)return r.tool==='request_confirmation'&&sound(task||{})&&receiptStep(task||{},r);
    if(!artifactRefs.has(r.artifactId)||task?.id!==data.artifacts.find(value=>value.id===r.artifactId)?.taskId)return false;
    return !(task.steps||[]).some(step=>step.kind==='external'&&step.tool===r.tool)||receiptStep(task,r);
  };
  const delivered = actions.filter(r => r.status === 'done' && r.result?.verified === true && !r.deliveryConflict && currentWrite(r));
  const uncertain = actions.filter(r => ['uncertain','running'].includes(r.status));
  const open = [...(data.decisions || []).filter(d => d.status === 'open' && jobIds.has(d.jobId) && (!d.projectId || d.projectId === p.id)),...actions.filter(r => r.status === 'pending').map(r => ({id:`action:${r.id}`,jobId:r.jobId,kind:'approval',question:`请确认${tools[r.tool] || '外部动作'}：${r.title || ''}`,taskIds:r.taskId ? [r.taskId] : [],updatedAt:r.createdAt}))];
  const waiting = jobs.flatMap(j => (j.followups || []).filter(f => f.status === 'waiting' && (!f.taskId || taskIds.has(f.taskId))).map(f => ({...f,jobId:j.id,paused:j.status === 'paused'})));
  const blockers = [
    ...uncertain.map(r => ({id:r.id,title:tools[r.tool] || '外部动作',reason:'执行结果尚未核对，不能按已交付处理',taskId:r.taskId,jobId:r.jobId,taskRef:taskRefs.get(r.taskId),kind:'uncertain'})),
    ...actions.filter(r => r.status === 'done' && r.result?.verified !== true && currentWrite(r)).map(r => ({id:r.id,title:tools[r.tool] || '外部动作',reason:'缺少读回核对证据',taskId:r.taskId,jobId:r.jobId,taskRef:taskRefs.get(r.taskId),kind:'unverified'})),
    ...scopedTasks.filter(t => !t.agentCancelled && (['blocked','paused','review'].includes(t.status) || !taskLabels[t.status] || t.needsReplan || unavailable(t).length || completionKinds.get(t.id)==='unverified')).map(t => ({id:t.id,title:trim(t.title,300),taskId:t.id,taskRef:taskRefs.get(t.id),kind:'task',reason:trim(t.needsReplan || (unavailable(t).length ? '引用材料已变化、撤回或不属于当前项目' : completionKinds.get(t.id)==='unverified' ? '历史完成记录保留，当前检查待核对' : taskLabels[t.status] || '事项状态无法识别，请核对'))})),
    ...jobs.filter(j => ['blocked','needs_input','limited','paused','approval'].includes(j.status)).map(j => ({id:j.id,title:trim(j.title,300),jobId:j.id,kind:'job',reason:jobLabels[j.status]}))
  ];
  const activeTasks = scopedTasks.filter(t => !t.agentCancelled);
  const actionable = jobs.filter(j => ['ready','running','watching','retry'].includes(j.status));
  const scheduledCheckAt = first([...actionable.map(j => j.nextRunAt),...waiting.filter(f => !f.paused && actionable.some(j => j.id === f.jobId)).map(f => f.checkAt),...activeTasks.filter(t => !t.agentJobId && t.status === 'waiting').map(t => t.nextCheckAt),...(data.workRules || []).filter(r => r.config.projectId === p.id && r.status === 'enabled').map(r => r.nextRunAt),...(data.connectors || []).filter(c => c.projectId === p.id && c.enabled).map(c => c.nextRunAt)]);
  const stewardship = require('./stewardship.cjs');
  const gate = a.suspended ? {automaticAllowed:false,reason:'suspended',message:'电脑休眠中，唤醒后按原计划继续',nextAllowedAt:null} : data.stewardship ? stewardship.status(a,now) : {automaticAllowed:true,reason:null,message:'可按计划自动收集与推进',nextAllowedAt:null};
  let nextCheckAt = null;
  if (scheduledCheckAt && !['paused','meter','suspended'].includes(gate.reason)) {
    const candidate = Math.max(now,Date.parse(scheduledCheckAt),Date.parse(gate.nextAllowedAt) || 0);
    const future = data.stewardship ? stewardship.status(a,candidate) : gate;
    nextCheckAt = future.automaticAllowed ? new Date(candidate).toISOString() : future.nextAllowedAt;
  }
  const r = {project:{id:p.id,name:trim(p.name,300)},generatedAt:new Date(now).toISOString(),includeArtifactContent:input.includeArtifactContent === true,modelCalls:0,nextCheckAt,scheduledCheckAt,automatic:{allowed:gate.automaticAllowed,reason:gate.reason,message:gate.message,nextAllowedAt:gate.nextAllowedAt},
    lastUpdatedAt:latest([p.updatedAt,p.createdAt,...scopedTasks.flatMap(t => [t.updatedAt,t.completedAt,t.createdAt]),...sourceRows.map(s => s.createdAt),...artifacts.map(v => v.createdAt),...actions.flatMap(v => [v.finishedAt,v.createdAt]),...open.map(v => v.updatedAt)]),
    progress:{total:activeTasks.length,completed:activeTasks.filter(completed).length,historicalAccepted:activeTasks.filter(historicalAccepted).length,manualEvidence:activeTasks.filter(t=>completionKinds.get(t.id)==='manual_evidence').length,manualCompleted:activeTasks.filter(t=>completionKinds.get(t.id)==='manual_completed').length,unverified:activeTasks.filter(t=>completionKinds.get(t.id)==='unverified').length,cancelled:scopedTasks.length-activeTasks.length,paused:activeTasks.filter(t => t.status === 'paused').length,overdueTasks:activeTasks.filter(t => t.status!=='completed' && Date.parse(t.dueAt) <= now).length,overdueFollowups:waiting.filter(f => Date.parse(f.deadlineAt) <= now).length,uncertainWrites:uncertain.length},
    totals:{tasks:scopedTasks.length,sources:currentSources.length,artifacts:currentArtifacts.length,decisions:open.length,followups:waiting.length,deliveries:delivered.length,blockers:blockers.length},
    excluded:{sources:sourceRows.length-currentSources.length,artifacts:artifacts.length-currentArtifacts.length,deliveries:actions.filter(v => v.status === 'done' && !currentWrite(v)).length},
    sources:bound(currentSources,'材料').map(s => ({id:s.id,ref:sourceRefs.get(s.id),title:trim(s.title,300),version:s.version || 1,at:iso(s.createdAt),url:publicLink(s.url)})),
    tasks:bound(scopedTasks,'事项').map(t => ({id:t.id,ref:taskRefs.get(t.id),title:trim(t.title,300),status:t.status,label:completionLabel(t),completionKind:completionKinds.get(t.id),historicalAccepted:historicalAccepted(t),currentCheckValid:currentCheckValid(t),criteria:trim(t.criteria,2000),dueAt:iso(t.dueAt),nextStep:trim(t.steps?.find(s => !s.done)?.title,500),needsReplan:trim(t.needsReplan,500),staleSources:unavailable(t).length,sourceRefs:(t.sourceIds || []).filter(id => sourceRefs.has(id)&&access.canReadSnapshot(a,'source',data.sources.find(s=>s.id===id),{task:t,projectId:p.id})).slice(0,100).map(id => sourceRefs.get(id)),completed:completed(t)})),
    decisions:bound(open,'待判断').map(d => ({id:d.id,jobId:d.jobId,kind:d.kind === 'timeout' ? '等待超时' : d.kind === 'approval' ? '外部动作待审批' : '需要判断',question:trim(d.question,2000),suggestion:trim(d.suggestion,1000),taskRefs:(d.taskIds || []).filter(id => taskRefs.has(id)).slice(0,100).map(id => taskRefs.get(id))})),
    blockers:bound(blockers,'阻塞'),
    followups:bound(waiting,'跟进').map(f => ({key:trim(f.key,200),jobId:f.jobId,taskId:f.taskId,taskRef:taskRefs.get(f.taskId),expected:trim(f.expected,2000),deadlineAt:iso(f.deadlineAt),checkAt:iso(f.checkAt),overdue:Date.parse(f.deadlineAt) <= now,paused:f.paused})),
    deliveries:bound(delivered,'交付').map(d => ({id:d.id,taskId:d.taskId,label:tools[d.tool] || '外部交付',title:trim(d.title,300),artifactRef:artifactRefs.get(d.artifactId),at:iso(d.finishedAt || d.completedAt || d.at),verified:true,...(d.tool === 'write_file' ? {filename:trim(fileName(d.result?.latestPath || d.result?.path),300)} : {url:publicLink(d.result?.url)}),...(d.tool === 'request_confirmation' ? {receiptId:trim(d.result?.messageId,100)} : {})})),
    artifacts:[],truncated:false,notices:[]};
  let remaining = limits.totalBody;
  r.artifacts = bound(currentArtifacts,'产出',limits.artifacts).map(v => {const t = taskMap.get(v.taskId),content = String(v.content || ''),size = Math.min(limits.body,remaining),include = r.includeArtifactContent;const item = {id:v.id,ref:artifactRefs.get(v.id),taskId:v.taskId,taskRef:taskRefs.get(v.taskId),title:trim(v.title,300),at:iso(v.createdAt),characters:content.length,accepted:completed(t),historicalAccepted:historicalAccepted(t),currentCheckValid:currentCheckValid(t),completionKind:completionKinds.get(t.id),completionLabel:completionLabel(t),sourceRefs:(t.sourceIds || []).filter(id => sourceRefs.has(id)&&access.canReadSnapshot(a,'source',data.sources.find(s=>s.id===id),{task:t,projectId:p.id})).slice(0,100).map(id => sourceRefs.get(id))};if (include) {item.content = content.slice(0,size);item.contentTruncated = content.length > size;remaining -= item.content.length;if (item.contentTruncated) notices.add('产出正文每份最多 12,000 字符、合计最多 120,000 字符');}return item;});
  r.notices = [...notices];r.truncated = notices.size > 0;r.markdown = markdown(r);
  return r;
}
module.exports = {report};
