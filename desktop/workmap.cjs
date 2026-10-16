const acceptance = require('./acceptance.cjs');
const stewardship = require('./stewardship.cjs');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(object) : [];
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const validId = value => typeof value === 'string' && !!value;
const pid = value => value == null || value === '' ? null : value;
const statuses = { todo: '待推进', running: '正在推进', waiting: '等待反馈', review: '待验收', blocked: '需要关注', paused: '已暂停', completed: '已完成' };
const jobStatuses = { ready: '待推进', running: '正在推进', watching: '持续跟进', retry: '等待重试', limited: '额度已用完', needs_input: '等待决定', approval: '等待动作确认', review: '等待验收', blocked: '需要关注', paused: '已暂停', completed: '已完成' };
const states = { all: '全部工作', actionable: '可继续处理', blocked: '等待与阻塞', check: '关联或依据待核对', completed: '有效完成', cancelled: '已取消' };
const issue = (code, message) => ({ code, message });
const unique = items => items.filter((item, i) => items.findIndex(other => other.code === item.code && other.message === item.message) === i);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function snapshot(a, input = {}) {
  if (!object(input)) throw new Error('工作地图参数无效');
  // Clean the view only. A damaged legacy entry must neither mutate saved work nor
  // make a foreign record look like independent work.
  const data = { ...a.data };
  for (const key of ['projects', 'tasks', 'delegations', 'sources', 'artifacts', 'agentActions', 'decisions', 'providers', 'workRules', 'connectors']) data[key] = rows(data[key]);
  data.settings ||= {};
  const view = { ...a, data };
  const projectId = input.projectId === undefined ? '' : input.projectId, jobId = input.jobId === undefined ? '' : input.jobId;
  const state = input.state === undefined ? 'all' : input.state, pageSize = input.pageSize === undefined ? 20 : input.pageSize, requestedPage = input.page === undefined ? 1 : input.page;
  if (typeof projectId !== 'string' || projectId && projectId !== '@independent' && !data.projects.some(project => project.id === projectId)) throw new Error('工作地图项目不存在');
  if (typeof jobId !== 'string' || typeof state !== 'string' || !Object.hasOwn(states, state)) throw new Error('工作地图筛选无效');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(requestedPage) || requestedPage < 1) throw new Error('工作地图分页参数无效');
  const projects = new Map(data.projects.map(project => [project.id, project]));
  const jobs = new Map(data.delegations.filter(job => validId(job.id)).map(job => [job.id, job]));
  const tasks = new Map(data.tasks.filter(task => validId(task.id)).map(task => [task.id, task]));
  const duplicates = new Set(data.tasks.filter((task, index) => data.tasks.findIndex(other => other.id === task.id) !== index).map(task => task.id));
  const jobDuplicates = new Set(data.delegations.filter((job, index) => data.delegations.findIndex(other => other.id === job.id) !== index).map(job => job.id));
  const projectOf = task => pid(task.projectId) ?? pid(jobs.get(task.agentJobId)?.projectId);
  const hasJobRef = task => task.agentJobId !== undefined && task.agentJobId !== null && task.agentJobId !== '';
  const validProject = value => value === null || validId(value) && projects.has(value);
  const includes = value => !projectId || (projectId === '@independent' ? value === null && validProject(value) : value === projectId);
  const projectName = value => projects.get(value)?.name || (value === null ? '独立工作' : '项目关联待核对');
  const knownJob = task => {
    const job = jobs.get(task.agentJobId);
    return job && !jobDuplicates.has(job.id) && pid(job.projectId) === projectOf(task) ? job : null;
  };
  const scopedJobs = [...jobs.values()].filter(job => includes(pid(job.projectId)) && (projectId !== '@independent' || validProject(pid(job.projectId))));
  if (jobId && !scopedJobs.some(job => job.id === jobId)) throw new Error('委托不在当前工作地图范围');
  const now = Date.now();
  let automatic;
  try { automatic = a.suspended ? { automaticAllowed: false, reason: 'suspended', message: '电脑休眠中，唤醒后按原计划继续', nextAllowedAt: null } : data.stewardship ? stewardship.status(view, now) : { automaticAllowed: true, reason: null, message: '可按已有计划继续', nextAllowedAt: null }; }
  catch { automatic = { automaticAllowed: false, reason: 'meter', message: '托管设置或调用账本需要核对', nextAllowedAt: null }; }

  const structural = new Map(), edges = new Map(), reverse = new Map(), degree = new Map(), layers = new Map();
  for (const task of tasks.values()) {
    const problems = [], project = projectOf(task), job = knownJob(task), dependencyIds = list(task.dependsOn), links = [];
    if (duplicates.has(task.id)) problems.push(issue('duplicate', '事项编号重复，请核对工作记录'));
    if (!validProject(project)) problems.push(issue('project', '事项所属项目不存在或关联无效'));
    if (hasJobRef(task) && (!validId(task.agentJobId) || !job || !list(job.taskIds).includes(task.id))) problems.push(issue('job', '事项与所属委托的关联需要核对'));
    if (job && list(job.taskIds).some(id => !tasks.has(id) || tasks.get(id).agentJobId !== job.id || projectOf(tasks.get(id)) !== pid(job.projectId))) problems.push(issue('job_tasks', '所属委托存在缺失或错误关联的事项'));
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn) || new Set(dependencyIds).size !== dependencyIds.length || dependencyIds.some(id => !validId(id))) problems.push(issue('dependency_shape', '前置事项列表格式或重复关联需要核对'));
    for (const id of dependencyIds) {
      const dependency = tasks.get(id);
      if (!dependency || duplicates.has(id)) problems.push(issue('dependency_missing', '前置事项缺失或编号重复，请核对关联'));
      else if (projectOf(dependency) !== project || pid(dependency.agentJobId) !== pid(task.agentJobId)) problems.push(issue('dependency_scope', '前置事项不属于同一项目和委托，请核对关联'));
      else links.push(id);
    }
    structural.set(task.id, problems); edges.set(task.id, [...new Set(links)]); degree.set(task.id, new Set(links).size);
    for (const id of new Set(links)) { if (!reverse.has(id)) reverse.set(id, []); reverse.get(id).push(task.id); }
  }
  // Kahn's traversal also marks descendants of a cycle as blocked. It stays
  // iterative for long imported plans and never recursively expands a diamond.
  const queue = [...tasks.keys()].filter(id => degree.get(id) === 0), order = [];
  for (const id of queue) layers.set(id, 0);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; order.push(id);
    for (const next of reverse.get(id) || []) {
      layers.set(next, Math.max(layers.get(next) || 0, layers.get(id) + 1));
      degree.set(next, degree.get(next) - 1); if (!degree.get(next)) queue.push(next);
    }
  }
  for (const [id, count] of degree) if (count) { structural.get(id).push(issue('dependency_cycle', '事项或前置链存在循环，请核对计划')); layers.set(id, null); }

  const checked = new Map(), validity = new Map();
  function ownCompletion(task) {
    if (checked.has(task.id)) return checked.get(task.id);
    let problems = [...structural.get(task.id)];
    try {
      // Validate the same local evidence as acceptance, then combine dependencies
      // once in graph order. The original basis still checks the original plan.
      const localTask = { ...task, dependsOn: [], verification: task.verification ? { ...task.verification, basis: undefined } : null };
      problems.push(...acceptance.reasons(view, localTask, { completed: true }));
      if (task.verification?.basis && task.verification.basis !== acceptance.basis(view, task)) problems.push(issue('changed', '结果检查之后依据已变化，请重新检查'));
    } catch { problems.push(issue('record', '执行依据存在无效记录，请核对事项')); }
    checked.set(task.id, unique(problems)); return checked.get(task.id);
  }
  for (const id of order) {
    const task = tasks.get(id);
    const valid = task.status === 'completed' && ownCompletion(task).length === 0 && edges.get(id).every(dependency => validity.get(dependency) === true);
    validity.set(id, valid);
  }
  for (const id of tasks.keys()) if (!validity.has(id)) validity.set(id, false);

  function gates(task, job) {
    const result = [], add = (code, message) => result.push(issue(code, message));
    if(projects.get(task?projectOf(task):job?.projectId)?.archivedAt)add('project_archived','项目已归档，重新打开项目后按需恢复具体工作');
    if (!automatic.automaticAllowed) add(automatic.reason, automatic.message);
    if (require('./execution.cjs').conflict(a,{jobId:job?.id,taskId:task?.id}) && task?.status !== 'running' && job?.status !== 'running') add('busy', '同一事项或项目正在执行，当前操作结束后继续');
    if (task?.status === 'paused') add('task_paused', '事项已手动暂停');
    if (task?.needsReplan) add('replan', '材料或计划发生变化，需先由 Agent 重新核对');
    if (task && !Object.hasOwn(statuses, task.status)) add('task_status', '事项状态无法识别，请打开核对');
    if (task && ['waiting', 'review', 'blocked', 'running'].includes(task.status)) add(task.status, { waiting: '等待外部结果或补充反馈', review: '产出等待人工验收', blocked: '推进遇到问题，请打开事项处理', running: '当前事项正在执行' }[task.status]);
    if (job) {
      if (!Object.hasOwn(jobStatuses, job.status)) add('job_status', '委托状态无法识别，请打开核对');
      if (['paused', 'needs_input', 'approval', 'review', 'blocked', 'running', 'completed'].includes(job.status)) add(`job_${job.status}`, { paused: '所属委托已暂停', needs_input: '所属委托等待你作出决定', approval: '所属委托有外部动作等待确认', review: '所属委托等待成果验收', blocked: '所属委托推进遇到问题', running: '所属委托正在执行', completed: '所属委托已结束，未完成事项需核对目标' }[job.status]);
      if (require('./work-rules.cjs').projectTriggerPending(view,job)) add('rule_materials_pending','等待项目资料规则检查，核对新材料后再推进');
      else if (job.ruleId && !require('./work-rules.cjs').canRun(view, job)) add('rule_paused', '工作规则已暂停、移除或版本已变化');
      if (job.status === 'limited') add('job_budget', job.summary || '推进费用需要确认');
      if (Date.parse(job.nextRunAt) > now) add('scheduled', `委托已安排下次${job.status === 'watching' ? '检查' : '推进'}，尚未到时`);
      if (data.decisions.some(decision => decision.jobId === job.id && decision.status === 'open')) add('decision', '所属委托有待处理的决定');
      if (data.agentActions.some(action => action.jobId === job.id && action.status === 'pending' && !require('./decisions.cjs').approved(data, job, action))) add('approval', '所属委托有外部动作待确认');
      if (data.connectors.some(connector => connector.projectId === job.projectId && connector.cursor?.token)) add('sync', '项目资料同步尚未完成');
      if (list(job.followups).some(followup => object(followup) && followup.status === 'waiting' && (!followup.taskId || followup.taskId === task?.id))) add('followup', '正在等待符合条件的新证据，打开委托查看跟进安排');
    } else if (!task?.agentJobId && !data.settings.automatic) add('manual', '独立事项自动推进尚未开启');
    if (data.agentActions.some(action => (task && action.taskId === task.id || job && action.jobId === job.id) && ['running', 'uncertain'].includes(action.status))) add('uncertain', '所属事项或委托有外部结果待核对');
    const roles = job ? ['organize', 'execute', 'verify'] : ['execute', 'verify'];
    if (roles.some(role => !data.providers.some(provider => provider.id === data.settings.roles?.[role]))) add('model', '所需模型尚未配置完整');
    const step = list(task?.steps).find(step => !object(step) || step.done !== true);
    if (task && !list(task.steps).length) add('step', '尚未建立有效执行步骤，请核对或重新规划事项');
    if (list(task?.steps).some(step => !object(step) || !['analysis', 'draft', 'external'].includes(step.kind) || typeof step.done !== 'boolean')) add('step', '当前执行步骤格式需要核对');
    if (step?.kind === 'external') {
      const tool = step.tool;
      if (!job || tool === 'manual' || !['write_file', 'github_create', 'github_update', 'github_comment', 'request_confirmation'].includes(tool)) add('manual_step', '当前步骤需要人工执行并记录真实结果');
      else if (tool === 'request_confirmation') add('confirmation', '当前步骤需要按已授权渠道发起确认并等待回复');
      else {
        const key = { write_file: 'fileMode', github_create: 'githubMode', github_update: 'githubUpdateMode', github_comment: 'githubCommentMode' }[tool], mode = job[key];
        if (!['auto', 'ask'].includes(mode)) add('permission', '当前步骤所需的写入权限未开启');
        else if (mode === 'ask' && !data.agentActions.some(action => action.jobId === job.id && action.taskId === task.id && action.tool === tool && require('./decisions.cjs').approved(data, job, action))) add('permission_ask', '当前步骤按需确认，准备具体动作后仍需你批准');
        if (tool === 'write_file' && !job.outputFolder) add('destination', '当前步骤尚未选择产出文件夹');
        if (tool.startsWith('github_') && !job.githubRepo) add('destination', '当前步骤尚未授权 GitHub 仓库');
        if (tool.startsWith('github_') && !data.agentSettings?.githubToken) add('credential', 'GitHub 写入凭据尚未配置');
      }
    }
    return unique(result);
  }
  function sourceLinks(ids, project, job) {
    return [...new Set(list(ids))].map(id => {
      const source = data.sources.find(source => source.id === id);
      const allowed = source && pid(source.projectId) === project && (!job || list(job.sourceIds).includes(id));
      const current = !!allowed && !source.deleted && !source.projectExcluded && !data.sources.some(next => next.previousSourceId === id && pid(next.projectId) === project && !next.projectExcluded);
      return { id: validId(id) ? id : '', type: 'source', title: allowed ? text(source.title, 160) || '未命名材料' : '材料缺失或关联待核对', available: !!allowed && !source.deleted && !source.projectExcluded, current };
    });
  }
  const items = [];
  for (const task of tasks.values()) {
    if(task.deletedAt)continue;
    const project = projectOf(task), job = knownJob(task);
    if (!includes(project) || projectId === '@independent' && hasJobRef(task) && !job || jobId && task.agentJobId !== jobId) continue;
    const problems = [...structural.get(task.id)];
    const dependencyLinks = [...new Set(list(task.dependsOn))].map(id => {
      const dependency = tasks.get(id), allowed = dependency && !duplicates.has(id) && projectOf(dependency) === project && pid(dependency.agentJobId) === pid(task.agentJobId);
      const valid = !!allowed && validity.get(id) === true;
      return { id: validId(id) ? id : '', type: 'task', title: allowed ? text(dependency.title, 160) || '未命名事项' : '前置事项缺失或范围不符', available: !!allowed, valid,
        detail: !allowed ? '请核对关联' : valid ? '已完成且当前依据有效' : dependency.status === 'completed' ? '已标完成，但验收依据或前置链需要核对' : dependency.agentCancelled ? '前置事项已取消' : '前置事项尚未有效验收' };
    });
    const dependencyReady = !problems.length && dependencyLinks.every(link => link.valid);
    if (task.status === 'completed' && !validity.get(task.id)) problems.push(...ownCompletion(task), ...(dependencyLinks.some(link => !link.valid) ? [issue('dependency', '前置事项尚未有效验收或关联已变化')] : []));
    const controls = task.agentCancelled || validity.get(task.id) ? [] : gates(task, job);
    if (!dependencyReady && dependencyLinks.some(link => !link.valid)) controls.unshift(issue('dependency', '请先处理未完成或依据失效的前置事项'));
    const itemState = task.agentCancelled ? 'cancelled' : problems.length ? 'check' : validity.get(task.id) ? 'completed' : dependencyReady && !controls.length ? 'actionable' : 'blocked';
    const steps = list(task.steps).filter(object).map((step, index) => ({ id: text(step.id, 160) || `step-${index}`, title: text(step.title, 500) || '步骤待核对', kind: step.kind, done: step.done === true, tool: text(step.tool, 80) }));
    const active = steps.find(step => !step.done);
    const artifacts = [...new Set(list(task.steps).filter(object).map(step => step.artifactId).filter(validId))].map(id => {
      const artifact = data.artifacts.find(artifact => artifact.id === id && artifact.taskId === task.id);
      return { id, type: 'artifact', title: artifact ? text(artifact.title, 160) || '未命名产出' : '当前产出缺失或关联待核对', available: !!artifact };
    });
    items.push({ id: `task:${task.id}`, type: 'task', taskId: task.id, jobId: job?.id || null, projectId: validProject(project) ? project : null, projectName: text(projectName(project), 100), title: text(task.title, 160) || '未命名事项', goal: text(job?.goal || task.criteria, 3000), jobTitle: text(job?.title, 160), status: task.status, statusLabel: statuses[task.status] || '状态待核对', state: itemState, stateLabel: states[itemState], priority: task.priority || 'normal', dueAt: date(task.dueAt), scheduledAt: date(job?.nextRunAt), layer: layers.get(task.id), dependencyReady, validCompletion: validity.get(task.id), dependencies: dependencyLinks, issues: unique(problems), gates: controls, steps, currentStep: active?.title || (itemState === 'completed' ? '步骤全部完成并通过检查' : task.agentCancelled ? '已取消' : steps.length ? '执行步骤已完成，等待结果检查或验收' : '尚未建立有效执行步骤'), sources: sourceLinks(list(task.sourceIds).filter(id => !list(task.supersededSourceIds).includes(id)), project, job), artifacts });
  }
  for (const job of scopedJobs) {
    if (jobId && job.id !== jobId || [...tasks.values()].some(task => task.agentJobId === job.id && projectOf(task) === pid(job.projectId))) continue;
    const problems = [];
    if (!validProject(pid(job.projectId)) || jobDuplicates.has(job.id) || list(job.taskIds).length) problems.push(issue('job', '委托项目或事项关联需要核对'));
    const controls = gates(null, job), itemState = problems.length ? 'check' : job.status === 'completed' ? 'check' : controls.length ? 'blocked' : 'actionable';
    if (job.status === 'completed') problems.push(issue('empty_completion', '委托已标完成，但没有关联事项，请打开核对目标与交付'));
    items.push({ id: `job:${job.id}`, type: 'job', taskId: null, jobId: job.id, projectId: validProject(pid(job.projectId)) ? pid(job.projectId) : null, projectName: text(projectName(pid(job.projectId)), 100), title: text(job.title, 160) || '未命名委托', goal: text(job.goal, 3000), jobTitle: text(job.title, 160), status: job.status, statusLabel: jobStatuses[job.status] || '状态待核对', state: itemState, stateLabel: states[itemState], priority: 'normal', dueAt: null, scheduledAt: date(job.nextRunAt), layer: 0, dependencyReady: !problems.length, validCompletion: false, dependencies: [], issues: problems, gates: controls, steps: [], currentStep: '尚未拆解事项，进入委托查看资料获取与计划', sources: sourceLinks(job.sourceIds, pid(job.projectId), job), artifacts: [] });
  }
  const rank = { check: 0, actionable: 1, blocked: 2, completed: 3, cancelled: 4 }, priority = { high: 0, normal: 1, low: 2 };
  items.sort((x, y) => rank[x.state] - rank[y.state] || (priority[x.priority] ?? 1) - (priority[y.priority] ?? 1) || (x.layer ?? -1) - (y.layer ?? -1) || (x.dueAt || 'z').localeCompare(y.dueAt || 'z') || x.id.localeCompare(y.id));
  const counts = Object.fromEntries(Object.keys(states).map(key => [key, key === 'all' ? items.length : items.filter(item => item.state === key).length]));
  const selected = state === 'all' ? items : items.filter(item => item.state === state), pageCount = Math.max(1, Math.ceil(selected.length / pageSize)), page = Math.min(requestedPage, pageCount), start = (page - 1) * pageSize;
  const next = items.find(item => item.state === 'check') || items.find(item => item.state === 'actionable') || items.find(item => item.state === 'blocked' && item.dependencyReady);
  return { generatedAt: new Date(now).toISOString(), projectId, jobId, state, page, pageSize, pageCount, total: selected.length, from: selected.length ? start + 1 : 0, to: Math.min(start + pageSize, selected.length), counts, automatic, items: selected.slice(start, start + pageSize), jobs: scopedJobs.map(job => ({ id: job.id, title: text(job.title, 160) || '未命名委托', projectId: pid(job.projectId) })),
    next: next ? { id: next.id, type: next.type, taskId: next.taskId, jobId: next.jobId, title: next.title, reason: next.issues[0]?.message || next.gates[0]?.message || (next.type === 'job' ? '进入委托查看资料收集和事项拆解' : '前置已就绪，可进入原事项查看当前步骤'), state: next.state } : null,
    modelCalls: 0, networkRequests: 0, notices: ['依赖就绪与当前可处理分别判断；实际执行仍会重新检查模型、调用额度、具体动作授权与外部结果。', '完成依据来自本机保存的验收记录；本页不重新访问网页、文件系统或外部服务。'] };
}
function dispatch(a, action, input = {}) {
  if (action === 'workmapSnapshot') return snapshot(a, input);
  throw new Error('未知工作地图操作');
}
module.exports = { snapshot, dispatch };
