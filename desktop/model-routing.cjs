const crypto = require('node:crypto');
const {configuration: baseConfiguration} = require('./model-fallback.cjs');
const roles = ['organize', 'execute', 'verify'];
const preferences = ['auto', 'economy', 'analysis', 'fixed'];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configuration = data => digest([baseConfiguration(data), (data.providers || []).map(p => [p.id, p.archivedAt || null])]);
const exists = (data, id) => (data.providers || []).some(p => p.id === id && !p.archivedAt);

function revoke(data, reason = 'configuration') {
  const old = data.modelRouting;
  data.modelRouting = {version: 1, revision: crypto.randomUUID(), enabled: false,
    economyId: exists(data, old?.economyId) ? old.economyId : '',
    analysisId: exists(data, old?.analysisId) ? old.analysisId : '',
    needsSave: !!(old?.enabled || old?.needsSave), reason, configuration: configuration(data)};
}
function valid(data) {
  const value = data.modelRouting;
  return value?.version === 1 && typeof value.revision === 'string' && typeof value.enabled === 'boolean'
    && value.configuration === configuration(data)
    && (!value.enabled || (exists(data, value.economyId) && exists(data, value.analysisId)));
}
function initialize(a) { if (!valid(a.data)) revoke(a.data); }
function changed(a) { if (!valid(a.data)) revoke(a.data); }
function retain(current, restored) { restored.modelRouting = structuredClone(current.modelRouting); revoke(restored, 'restore'); }
function revision(a) { return digest({configuration: configuration(a.data), value: a.data.modelRouting}); }
function snapshot(a) {
  const value = a.data.modelRouting || {};
  return {revision: revision(a), enabled: !!value.enabled && valid(a.data),
    economyId: value.economyId || '', analysisId: value.analysisId || '', needsSave: !!value.needsSave || (!!value.enabled && !valid(a.data)),
    providers: a.data.providers.filter(p => !p.archivedAt).map(p => ({id: p.id, name: p.name, model: p.model, type: p.type}))};
}

// Inspect the requested work, never model prompts, source bodies, output length or errors.
// These are explainable heuristics; users can override a misclassified task.
const complex = /血缘|上下游|根因|故障诊断|排障|架构|迁移方案|一致性|交叉核对|跨[多\d一二三四五六七八九十]*[表源系统]|冲突分析|矛盾|权衡|审计|风险评估|SQL\s*(?:分析|审查|优化)|lineage|root\s*cause|trade.?offs?|architecture|cross[- ](?:source|table)|sql\s*(?:review|optim)/i;
const routine = /提取|整理(?:成|为)|转(?:成|为)|排版|格式|润色|翻译|摘要|总结|跟进|提醒|汇总状态|format|extract|translate|summari[sz]|remind|follow.?up/i;
const editorial = /精简|压缩|缩写|缩短|改写|润色|排版|翻译|摘要|删(?:除|去)重复|condens|shorten|rewrite|reformat|proofread|translate|summari[sz]/i;
const analysisAction = /分析|核[对验查]|审查|诊断|推导|调查|补充.*(?:证据|查询)|重新.*(?:查询|判断)|analy[sz]|verif|investigat|reconcile/i;
function isEditorial(text){return editorial.test(String(text||''))&&!analysisAction.test(String(text||''));}
function classify(payload = {}, role = 'execute', stage = '') {
  const task = payload.task || {};
  const step = String(payload.currentStep?.title || '');
  // The application assigns this stage. Tool selection is distinct from the
  // analysis performed inside advance_task and the independent final checks.
  if (stage === 'planner' && role !== 'verify')
    return {tier: 'economy', reason: '本次选择下一步工具与调度，优先使用日常模型；正文分析和结果检查另行选模'};
  if(role!=='verify'&&payload.revision&&isEditorial(payload.revision.note))return {tier:'economy',reason:'本次仅按修改意见编辑已有文稿，使用日常模型；关键结果仍独立检查'};
  if (role !== 'verify' && payload.currentStep?.kind !== 'analysis' && editorial.test(step) && !analysisAction.test(step))
    return {tier: 'economy', reason: '当前步骤精简、改写或整理已有内容，优先使用日常模型'};
  if (role !== 'verify' && step && routine.test(step) && !complex.test(step))
    return {tier: 'economy', reason: '当前步骤是提取、格式整理或日常跟进'};
  const intent = [task.title, task.description, task.criteria, payload.goal, payload.delegation?.goal, step].filter(v => typeof v === 'string').join('\n');
  if (complex.test(intent)) return {tier: 'analysis', reason: role === 'verify' ? '核验涉及依赖、冲突或专业分析的完成标准' : '目标涉及依赖、冲突或专业分析'};
  const dependencies = payload.dependencies?.length || task.dependsOn?.length || 0;
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (dependencies >= 2 || tasks.some(t => (t.dependsOn?.length || 0) >= 2))
    return {tier: 'analysis', reason: '需要协调多项前置依赖'};
  if (role !== 'organize' && (payload.sources?.length || 0) >= 3 && /分析|比较|对比|核对|综合|analy[sz]|compare|reconcile/i.test(intent))
    return {tier: 'analysis', reason: '需要综合比较三份以上材料'};
  return {tier: 'economy', reason: role === 'organize' ? '信息提取与事项拆解优先使用日常模型' : '未识别到复杂分析要求，优先使用日常模型'};
}
function select(a, primary, options = {}) {
  const value = a.data.modelRouting;
  if (!value?.enabled || !valid(a.data) || !roles.includes(options.role)
      || ['connection_test', 'evaluation'].includes(options.stage) || a.modelBudgetOwner
      || a.data.settings.roles[options.role] !== primary.id) return {provider: primary};
  const payload = options.routingContext || {};
  const taskId = payload.task?.id || (options.stage === 'planner' && a.activeAgentJob?.taskIds?.length === 1 ? a.activeAgentJob.taskIds[0] : null);
  const task = a.data.tasks.find(t => t.id === taskId);
  // The preference comes from saved user settings, never from source/model supplied fields.
  const preference = task?.modelPreference || 'auto';
  if (preference === 'fixed') return {provider: primary, routing: {mode: 'fixed', tier: 'fixed', reason: '此事项固定使用角色模型', primaryId: primary.id}};
  const decision = ['economy', 'analysis'].includes(preference)
    ? {tier: preference, reason: preference === 'economy' ? '此事项指定日常模型' : '此事项指定分析模型'}
    : options.role==='execute'&&options.stage==='task_work'&&(task?.autoRepair?.attempt>=2||a.activeAgentJob?.autoRecovery?.errorCode==='MODEL_INVALID_RESPONSE'&&a.activeAgentJob.autoRecovery.consecutive>=2)
      ? {tier:'analysis',reason:'已有文稿连续未通过结果检查，使用已配置的分析模型处理修订意见'}
      : classify(payload, options.role, options.stage);
  const provider = a.data.providers.find(p => p.id === value[decision.tier + 'Id'] && !p.archivedAt);
  return {provider: provider || primary, routing: {mode: preference === 'auto' ? 'auto' : 'manual', ...decision, primaryId: primary.id}};
}
function allowsFallback(a, selection, backup) {
  if (!backup || backup.id === selection.provider.id) return false;
  return !selection.routing || selection.routing.mode === 'fixed'
    || [a.data.modelRouting?.economyId, a.data.modelRouting?.analysisId].includes(backup.id);
}
function dispatch(a, action, input = {}) {
  if (action === 'modelRoutingSnapshot') return snapshot(a);
  if (action !== 'modelRoutingSave') throw new Error('未知自动选模操作');
  a.ensureIdle();
  if (input.revision !== revision(a)) throw new Error('模型配置已变化，请刷新后重新保存自动选模。');
  if (typeof input.enabled !== 'boolean' || typeof input.economyId !== 'string' || typeof input.analysisId !== 'string') throw new Error('自动选模配置无效');
  for (const id of [input.economyId, input.analysisId]) if ((id || input.enabled) && !exists(a.data, id)) throw new Error('请选择已保存且可用的日常模型和分析模型');
  const before = a.data.modelRouting, events = a.data.events.slice();
  a.data.modelRouting = {version: 1, revision: crypto.randomUUID(), configuration: configuration(a.data),
    enabled: input.enabled, economyId: input.economyId, analysisId: input.analysisId, needsSave: false};
  try { a.event('保存自动选模', input.enabled ? '根据工作要求在日常与分析模型之间选择' : '使用固定角色模型'); a.save(); }
  catch (error) { a.data.modelRouting = before; a.data.events = events; throw error; }
  return snapshot(a);
}
module.exports = {initialize, changed, retain, revoke, revision, snapshot, classify, isEditorial, select, allowsFallback, dispatch, preferences};
