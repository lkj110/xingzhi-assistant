const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const projects = require('./projects.cjs');
const rules = require('./work-rules.cjs');
const feeds = require('./feeds.cjs');
const pages = require('./web-connections.cjs');
const folders = require('./folders.cjs');
const stewardship = require('./stewardship.cjs');

const limits = { feeds: 3, pages: 3, folders: 3, receipts: 1000, text: 200000 };
const queues = new WeakMap();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stale = () => new Error('设置或授权已变化，请重新预览后创建项目');
const fields = new Set(['name', 'goal', 'background', 'text', 'feedUrls', 'pageUrls', 'folderIds', 'intervalMinutes', 'enabled', 'useOutputFolder', 'fileMode', 'maxCalls', 'dailyCalls', 'autoAccept', 'revision', 'requestId', 'keyword', 'criteria', 'larkSources', 'capabilityIds']);
function text(value, label, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw Error(`${label}${required ? '须为 1–' : '最多 '}${max} 字符`);
  return value.trim();
}
function bool(input, key, fallback = false) {
  if (input[key] === undefined) return fallback;
  if (typeof input[key] !== 'boolean') throw Error(`${key} 开关格式无效`);
  return input[key];
}
function integer(input, key, fallback, min, max) {
  const value = input[key] === undefined ? fallback : input[key];
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${key} 须为 ${min}–${max} 的整数`);
  return value;
}
function list(input, key, max, normalize) {
  const values = input[key] === undefined ? [] : input[key];
  if (!Array.isArray(values) || values.length > max) throw Error(`${key} 最多选择 ${max} 项`);
  const result = values.map(normalize);
  if (new Set(result).size !== result.length) throw Error(`${key} 不能重复`);
  return result;
}
function normalize(input) {
  if (!object(input) || Object.keys(input).some(key => !fields.has(key))) throw Error('托管向导只支持新建项目，请检查输入字段');
  const useOutputFolder = bool(input, 'useOutputFolder');
  if (input.fileMode !== undefined && !['off', 'ask', 'auto'].includes(input.fileMode)) throw Error('请选择有效的文件写入权限');
  return {
    keyword: text(input.keyword,'触发关键词',200), criteria: text(input.criteria,'预期成果',2000),
    capabilityIds:list(input,'capabilityIds',10,v=>text(v,'能力 ID',100,true)),
    larkSources:list(input,'larkSources',3,v=>text(v,'飞书来源',2000,true)),
    name: text(input.name, '项目名称', 100, true), goal: text(input.goal, '工作目标', 10000, true),
    background: text(input.background, '项目背景', 10000), text: text(input.text, '初始材料', limits.text),
    feedUrls: list(input, 'feedUrls', limits.feeds, value => pages.urlOf(value)),
    pageUrls: list(input, 'pageUrls', limits.pages, value => pages.urlOf(value)),
    folderIds: list(input, 'folderIds', limits.folders, value => text(value, '目录编号', 100, true)),
    intervalMinutes: integer(input, 'intervalMinutes', 15, 5, 1440),
    enabled: bool(input, 'enabled'), autoAccept: bool(input, 'autoAccept'),
    useOutputFolder, fileMode: useOutputFolder ? input.fileMode || 'ask' : 'off'
  };
}
function directory(location, label, workspace) {
  try {
    if (typeof location !== 'string' || !path.isAbsolute(location) || fs.realpathSync(location) !== location) throw Error();
    const stat = fs.lstatSync(location);
    if (!stat.isDirectory() || stat.isSymbolicLink() || location === workspace) throw Error();
    return { path: location, dev: stat.dev, ino: stat.ino };
  } catch { throw Error(`${label}已失效或路径变化，请在工具与连接重新授权`); }
}
function grants(a, config) {
  const selected = config.folderIds.map(id => {
    const matches = (a.data.folders || []).filter(folder => folder.id === id);
    if (matches.length !== 1) throw Error('所选资料目录已移除或编号重复，请重新选择');
    const folder = matches[0];
    if (folder.projectId) throw Error('所选资料目录已归属其他项目，请使用未分配的授权目录');
    return { id, name: folder.name, enabled: folder.enabled, projectId: folder.projectId || null, directory: directory(folder.path, '资料目录', a.dir) };
  });
  const output = config.useOutputFolder ? directory(a.data.agentSettings?.outputFolder, '产出目录', a.dir) : null;
  if (output && selected.some(folder => folder.directory.path === output.path)) throw Error('资料目录与产出目录需要分开，避免产出再次成为输入');
  return { selected, output };
}
function configRevision(a, config, scope) {
  // Hash grants and configuration only. Material ingestion and routine status polls
  // need not discard a preview; the final commit separately checks the whole state.
  return hash({ config, scope, roles: a.data.settings?.roles, providers: a.data.providers, capabilities:a.data.capabilities, connectors:a.data.connectors.map(c=>[c.id,c.target,c.projectId,c.enabled]),
    projectIds: (a.data.projects || []).map(p => [p.id, p.archivedAt, p.jobId]),
    rules: (a.data.workRules || []).map(r => [r.id, r.status, r.revision, r.config]),
    feeds: (a.data.feedConnections || []).map(c => [c.id, c.url, c.projectId, c.enabled]),
    pages: (a.data.webConnections || []).map(c => [c.id, c.url, c.projectId, c.enabled]),
    stewardship: a.data.stewardship, stewardshipError: a.stewardshipError || '',
    suspended: !!a.suspended, runtimeHold: [a.data.runtime?.stewardshipRecoveryHold, a.data.runtime?.stewardshipResumeHold]
  });
}
function receipts(data) {
  if (data.projectSetupReceipts === undefined) return [];
  const values = data.projectSetupReceipts;
  if (!Array.isArray(values) || values.length > limits.receipts) throw Error('项目创建回执无效，请保留工作空间并检查备份');
  const ids = new Set();
  for (const r of values) {
    if (!object(r) || typeof r.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(r.requestId) || ids.has(r.requestId)
      || typeof r.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.inputHash) || typeof r.projectId !== 'string' || !r.projectId
      || typeof r.ruleId !== 'string' || !r.ruleId || !Number.isFinite(Date.parse(r.createdAt))
      || ['sourceIds', 'feedIds', 'pageIds', 'folderIds'].some(key => !Array.isArray(r[key]) || r[key].some(id => typeof id !== 'string' || !id))) throw Error('项目创建回执无效，请保留工作空间并检查备份');
    ids.add(r.requestId);
  }
  return values;
}
function publicReceipt(receipt, reused) {
  return { projectId: receipt.projectId, ruleId: receipt.ruleId, sourceIds: [...receipt.sourceIds], feedIds: [...receipt.feedIds],
    pageIds: [...receipt.pageIds], folderIds: [...receipt.folderIds], createdAt: receipt.createdAt, reused };
}
async function prepare(a, config) {
  const scope = grants(a, config), revision = configRevision(a, config, scope);
  const shadow = Object.create(a);
  shadow.data = structuredClone(a.data); shadow.operation = null; shadow.controller = null;
  shadow.save = () => {}; shadow.publicState = () => ({});
  shadow.launch = () => { throw Error('托管向导不能启动后台工作'); };
  await projects.dispatch(shadow, 'projectSave', { name: config.name, background: config.background });
  const project = shadow.data.projects[0];
  const sourceIds = [];
  if (config.text) {
    shadow.addSources([{ title: `${config.name} · 初始材料`, content: config.text, origin: '托管项目向导', projectId: project.id }]);
    sourceIds.push(shadow.data.sources[0].id);
  }
  for (const folder of scope.selected) await folders.dispatch(shadow, 'folderConfigure', { id: folder.id, projectId: project.id, enabled: config.enabled });
  const feedIds = [], pageIds = [];
  for (const [index, url] of config.feedUrls.entries()) {
    await feeds.dispatch(shadow, 'feedConnectionSave', { name: `${config.name.slice(0,88)} · RSS ${index + 1}`, url, projectId: project.id, intervalMinutes: config.intervalMinutes, enabled: config.enabled });
    feedIds.push(shadow.data.feedConnections.at(-1).id);
  }
  for (const [index, url] of config.pageUrls.entries()) {
    await pages.dispatch(shadow, 'webConnectionSave', { name: `${config.name.slice(0,88)} · 网页 ${index + 1}`, url, projectId: project.id, intervalMinutes: config.intervalMinutes, enabled: config.enabled });
    pageIds.push(shadow.data.webConnections.at(-1).id);
  }
  const connectorIds=[];
  for(const [index,target] of config.larkSources.entries()){
    await require('./connectors.cjs').dispatch(shadow,'connectorSave',{name:`${config.name.slice(0,80)} · 飞书 ${index+1}`,kind:target.startsWith('oc_')?'chat':'document',target,projectId:project.id,intervalMinutes:config.intervalMinutes,lookbackDays:7,enabled:config.enabled});
    connectorIds.push(shadow.data.connectors.at(-1).id);
  }
  await rules.dispatch(shadow, 'ruleSave', { name: `${config.name.slice(0,92)} · 托管`, goal: config.goal+(config.criteria?'\n预期结果与验收标准：\n'+config.criteria:''), keyword:config.keyword,capabilityIds:config.capabilityIds,projectId: project.id,
    trigger: 'project_changes', includeExisting: true, intervalMinutes: config.intervalMinutes, folderIds: [], urls: [], useGithub: false,
    allowWeb: false, useOutputFolder: config.useOutputFolder, fileMode: config.fileMode, githubMode: 'off', githubUpdateMode: 'off', githubCommentMode: 'off',
    autoAccept: config.autoAccept, enabled: config.enabled });
  const rule = shadow.data.workRules[0], automatic = stewardship.status(a), warnings = [];
  if (!config.text && !config.feedUrls.length && !config.pageUrls.length && !config.folderIds.length && !config.larkSources.length) warnings.push('当前没有材料入口；补充项目材料后才会触发托管工作。');
  if (config.folderIds.length) warnings.push('目录按应用现有的目录同步节奏收集；已有独立材料保持原归属，后续同步写入新项目。');
  if (!config.enabled) warnings.push('项目规则、飞书、RSS、网页和所选目录均先暂停，之后可在各自入口明确启用。');
  if (!automatic.automaticAllowed) warnings.push(automatic.message);
  return { shadow, revision, receipt: { projectId: project.id, ruleId: rule.id, sourceIds, feedIds, pageIds, folderIds: [...config.folderIds], createdAt: new Date().toISOString() },
    summary: { connectors:connectorIds.map(id=>{const c=shadow.data.connectors.find(c=>c.id===id);return {name:c.name,target:c.target,enabled:c.enabled};}),capabilities:require('./capabilities.cjs').context(shadow,{capabilityGrants:shadow.data.workRules[0].config.capabilityGrants}),keyword:config.keyword,criteria:config.criteria,project: { name: config.name, goal: config.goal, background: config.background },
      initialMaterial: config.text ? { title: `${config.name} · 初始材料`, characters: config.text.length, preview: config.text.slice(0,500), truncated: config.text.length > 500 } : null,
      feeds: feedIds.map(id => { const c = shadow.data.feedConnections.find(c => c.id === id); return { name: c.name, url: c.url, enabled: c.enabled }; }),
      pages: pageIds.map(id => { const c = shadow.data.webConnections.find(c => c.id === id); return { name: c.name, url: c.url, enabled: c.enabled }; }),
      folders: scope.selected.map(f => ({ id: f.id, name: f.name, enabled: config.enabled })),
      rule: { trigger: 'project_changes', intervalMinutes: config.intervalMinutes, autoAccept: config.autoAccept, enabled: config.enabled },
      permissions: { allowWeb: false, useOutputFolder: config.useOutputFolder, fileMode: config.fileMode, outputFolderName: scope.output ? path.basename(scope.output.path) : '' },
      automatic: { allowed: automatic.automaticAllowed && !a.suspended, message: a.suspended ? '应用已暂停自动工作' : automatic.message, nextAllowedAt: automatic.nextAllowedAt }, warnings },
  };
}
async function preview(a, input) {
  const config = normalize(input);
  receipts(a.data);
  if (receipts(a.data).length >= limits.receipts) throw Error('已达到 1000 次向导创建上限，请使用项目页手动新建');
  const prepared = await prepare(a, config);
  if (prepared.revision !== configRevision(a, config, grants(a, config))) throw stale();
  return { revision: prepared.revision, inputRevision: hash(config), summary: prepared.summary, modelCalls: 0, networkRequests: 0 };
}
function diskSnapshot(a) {
  if (!a.file || !fs.existsSync(a.file)) return null;
  return { bytes: fs.readFileSync(a.file), mode: fs.statSync(a.file).mode & 0o777 };
}
function restoreDisk(a, snapshot) {
  if (!a.file) return;
  if (!snapshot) { if (fs.existsSync(a.file)) fs.unlinkSync(a.file); return; }
  if (fs.existsSync(a.file) && fs.readFileSync(a.file).equals(snapshot.bytes)) return;
  const temporary = `${a.file}.setup-rollback-${crypto.randomUUID()}`;
  let fd;
  try { fd = fs.openSync(temporary, 'wx', snapshot.mode); fs.writeFileSync(fd, snapshot.bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, a.file); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function create(a, input) {
  const config = normalize(input), inputHash = hash(config);
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw Error('请提供有效的项目创建请求编号');
  const previous = receipts(a.data).find(r => r.requestId === input.requestId);
  if (previous) { if (previous.inputHash !== inputHash) throw Error('此请求编号已用于另一份项目设置，请重新预览'); return publicReceipt(previous, true); }
  a.ensureIdle();
  if (receipts(a.data).length >= limits.receipts) throw Error('已达到 1000 次向导创建上限，请使用项目页手动新建');
  const before = a.data, stateHash = hash(before);
  const prepared = await prepare(a, config);
  a.ensureIdle();
  if (typeof input.revision !== 'string' || input.revision !== prepared.revision || prepared.revision !== configRevision(a, config, grants(a, config)) || stateHash !== hash(a.data)) throw stale();
  const receipt = { ...prepared.receipt, requestId: input.requestId, inputHash };
  prepared.shadow.data.projectSetupReceipts = [...receipts(prepared.shadow.data), receipt];
  prepared.shadow.event('托管项目已配置', `${config.name}：${config.enabled ? '已安排后续检查' : '先暂停，等待明确启用'}。保存时未调用模型或读取外部材料。`);
  const snapshot = diskSnapshot(a), lastLedger = a.lastLedger, lastBackupAt = a.lastBackupAt;
  a.data = prepared.shadow.data;
  // Defer the periodic backup until an ordinary save after this transaction.
  // A failed save must not leave a recoverable snapshot of an uncommitted bundle.
  a.lastBackupAt = Date.now();
  try { a.save(); }
  catch (error) {
    a.data = before; a.lastLedger = lastLedger; a.lastBackupAt = lastBackupAt;
    try { restoreDisk(a, snapshot); } catch { throw Error('项目保存失败且存储回滚未完成，请保留工作空间并检查磁盘后重试'); }
    throw error;
  }
  a.lastBackupAt = lastBackupAt;
  return publicReceipt(receipt, false);
}
// Unlike some older retain helpers, the destination is first. Recovery calls
// retain(restored, current); only receipts are merged, never objects or grants.
function retain(restored, current) {
  const merged = new Map();
  for (const r of [...receipts(restored), ...receipts(current)]) {
    const prior = merged.get(r.requestId);
    if (prior && (prior.inputHash !== r.inputHash || prior.projectId !== r.projectId || prior.ruleId !== r.ruleId)) throw Error('项目创建回执冲突，不能恢复此备份');
    merged.set(r.requestId, structuredClone(r));
  }
  if (merged.size > limits.receipts) throw Error('项目创建回执超过保留上限，不能恢复此备份');
  restored.projectSetupReceipts = [...merged.values()];
}
async function dispatch(a, action, input = {}) {
  if (action === 'projectSetupPreview') return preview(a, input);
  if (action !== 'projectSetupCreate') throw Error('未知托管向导操作');
  const previous = queues.get(a) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => create(a, input));
  queues.set(a, next);
  try { return await next; } finally { if (queues.get(a) === next) queues.delete(a); }
}
module.exports = { dispatch, preview, create, normalize, retain, limits };
