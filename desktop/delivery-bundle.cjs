const crypto = require('node:crypto');
const path = require('node:path');
const JSZip = require('jszip');
const acceptance = require('./acceptance.cjs');
const delivery = require('./delivery-format.cjs');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(object) : [];
const strings = value => Array.isArray(value) ? value.filter(value => typeof value === 'string') : [];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const limits = Object.freeze({ files: 200, totalBytes: 8 * 1024 * 1024, sourceBytes: 2 * 1024 * 1024 });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const tokenPattern = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9_.-]{12,})/gi;
const privatePathPattern = /(?:file:\/\/[^\s<>"']*|(?:\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|[A-Za-z]:[\\/]Users[\\/])[^\s<>"']*)/gi;
const metadataPathPattern = /(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|Volumes|private|etc|opt|data|workspace|usr|Applications)\/)[^\n，。；）]+/g;
function protections(a) {
  const secrets = new Set(), paths = new Set();
  let credentialsUnavailable = false;
  const add = (set, value) => { if (typeof value === 'string' && value.length >= 3) set.add(value); else if (object(value)) Object.values(value).forEach(value => add(set, value)); };
  for (const provider of rows(a.data.providers)) for (const key of ['sealedKey', 'apiKey', 'key', 'token']) add(secrets, provider[key]);
  for (const key of ['githubToken', 'searchKey']) add(secrets, a.data.agentSettings?.[key]);
  for (const sealed of [...rows(a.data.providers).map(provider => provider.sealedKey), a.data.agentSettings?.githubToken, a.data.agentSettings?.searchKey].filter(Boolean)) {
    if (typeof a.vault?.open !== 'function') continue;
    try { const plain = a.vault.open(sealed); if (typeof plain !== 'string') { credentialsUnavailable = true; if (plain?.catch) plain.catch(() => {}); } else add(secrets, plain); } catch { credentialsUnavailable = true; }
  }
  for (const item of [...rows(a.data.folders), ...rows(a.data.delegations)]) { add(paths, item.path); add(paths, item.outputFolder); }
  add(paths, a.data.briefingSchedule?.folder); add(paths, a.dir); add(paths, a.file);
  const known = [...secrets, ...paths].sort((a, b) => b.length - a.length);
  return {
    revision: digest([known, credentialsUnavailable]), credentialsUnavailable,
    unsafe(text) { return known.some(value => text.includes(value)) || /(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/i.test(text) || new RegExp(tokenPattern).test(text) || new RegExp(privatePathPattern).test(text); },
    label(value) {
      let text = typeof value === 'string' ? value : '';
      for (const value of known) text = text.split(value).join('[已隐藏]');
      return text.replace(tokenPattern, '[凭据已隐藏]').replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s，。；]+/gi, '[凭据已隐藏]')
        .replace(/https?:\/\/[^\s，。；）]+/gi, '[网址已隐藏]').replace(metadataPathPattern, '[路径已隐藏]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180);
    }
  };
}
function parameters(a, input) {
  if (!object(input) || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 300) throw new Error('请选择要导出成果的项目');
  const projects = rows(a.data.projects).filter(project => project.id === input.projectId);
  if (projects.length !== 1) throw new Error('交付包所属项目不存在或标识冲突');
  for (const key of ['includeDrafts', 'includeSources']) if (own(input, key) && typeof input[key] !== 'boolean') throw new Error('交付包选项必须为明确的开关');
  return { project: projects[0], options: { projectId: input.projectId, includeDrafts: input.includeDrafts === true, includeSources: input.includeSources === true } };
}
function uniqueMap(items) {
  const map = new Map(), duplicate = new Set();
  for (const item of items) { if (map.has(item.id)) duplicate.add(item.id); else map.set(item.id, item); }
  for (const id of duplicate) map.delete(id);
  return map;
}
function fileReceiptProblems(a, task, artifacts, job) {
  const result = [], current = task.primaryArtifactId?require('./deliverables.cjs').primary(a,task):[...rows(a.data.artifacts)].reverse().find(artifact => artifacts.some(item => item.id === artifact.id));
  const actions = rows(a.data.agentActions), receipts = [], currentContent = typeof current?.content === 'string' ? current.content : '';
  for (const step of rows(task.steps).filter(step => step.done && step.kind === 'external' && step.tool === 'write_file')) {
    let evidence; try { evidence = JSON.parse(step.evidence); } catch {}
    const matching = actions.filter(action => action.id === evidence?.actionId), record = matching.length === 1 ? matching[0] : null;
    if (!record) result.push('当前文件步骤缺少可核对的结构化回执'); else receipts.push(record);
  }
  if (job?.outputFolder && job.fileMode !== 'off' && current) {
    const record = actions.findLast(action => action.taskId === task.id && action.jobId === job.id && action.tool === 'write_file' && action.status === 'done' && action.artifactId === current.id);
    if (!record) result.push('最新产出没有匹配的文件交付回执'); else receipts.push(record);
  }
  for (const record of new Set(receipts)) {
    const format = record.fileFormat || record.result?.format || delivery.formatOf(record.target);
    const validTarget = !!job?.outputFolder && typeof record.target === 'string' && path.dirname(record.target) === job.outputFolder && record.result?.path === record.target && delivery.formats.has(format) && delivery.formatOf(record.target) === format && (!record.result?.format || record.result.format === format) && (!record.latestName || typeof record.latestName === 'string' && !/[\\/]/.test(record.latestName) && delivery.formatOf(record.latestName) === format && record.result?.latestPath === path.join(job.outputFolder, record.latestName));
    if (!validTarget || record.taskId !== task.id || record.jobId !== task.agentJobId || record.tool !== 'write_file' || record.status !== 'done' || record.result?.verified !== true || record.artifactId !== current?.id || record.content !== current?.content || record.result?.hash !== hash(currentContent) || record.result?.bytes !== Buffer.byteLength(currentContent) || record.result?.latestHash && record.result.latestHash !== record.result.hash) result.push('文件回执与当前最新正文不一致，请重新检查交付');
  }
  return [...new Set(result)];
}
function formatFor(a, task, artifact) {
  const record = rows(a.data.agentActions).findLast(action => action.taskId === task.id && action.jobId === task.agentJobId && action.tool === 'write_file' && action.status === 'done' && action.artifactId === artifact.id);
  const declared = record ? record.fileFormat || record.result?.format || delivery.formatOf(record.latestName || record.target) || 'md' : artifact.format || 'md';
  return delivery.normalize(declared);
}
function build(a, input = {}) {
  const { project, options } = parameters(a, input), safe = protections(a);
  const jobs = uniqueMap(rows(a.data.delegations)), tasks = uniqueMap(rows(a.data.tasks)), artifacts = uniqueMap(rows(a.data.artifacts));
  const sources = uniqueMap(rows(a.data.sources)), items = [], sourceItems = [], files = [], revisions = [];
  let excluded = 0;
  const title = (value, fallback) => safe.label(value) || fallback;
  for (const task of [...tasks.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const job = jobs.get(task.agentJobId), owner = task.projectId || job?.projectId;
    if (owner !== project.id) continue;
    if (task.agentCancelled || task.agentJobId && (!job || job.projectId !== project.id || !strings(job.taskIds).includes(task.id))) { excluded++; continue; }
    const current = [], associationProblems = [];
    for (const step of rows(task.steps)) {
      if (!step.done || !step.artifactId || current.some(item => item.id === step.artifactId)) continue;
      const artifact = artifacts.get(step.artifactId);
      if (!artifact || artifact.taskId !== task.id || artifact.stepId && artifact.stepId !== step.id || artifact.projectId && artifact.projectId !== project.id) { excluded++; associationProblems.push('当前步骤有缺失或错误归属的产出，请核对完整成果'); continue; }
      current.push(artifact);
    }
    if(task.primaryArtifactId&&!current.some(r=>r.id===task.primaryArtifactId)){
      const primary=require('./deliverables.cjs').primary(a,task);
      if(primary&&artifacts.get(primary.id)===primary)current.push(primary);
      else {excluded++;associationProblems.push('绑定的业务主稿不可读取或存在归属冲突');}
    }
    const reasons = acceptance.reasons(a, task, { completed: true }).map(reason => reason.code === 'status' ? '当前事项尚未完成验收' : reason.message);
    if (!task.verification?.basis) reasons.push('缺少绑定当前正文的检查记录，请重新检查');
    reasons.push(...associationProblems, ...fileReceiptProblems(a, task, current, job));
    const accepted = reasons.length === 0;
    revisions.push([task.id, acceptance.revision(a, task)]);
    for (const artifact of current) {
      let format = 'md', problem = '';
      try { format = formatFor(a, task, artifact); delivery.validate(artifact.content, format); } catch (error) { problem = error.message; }
      if (!problem && Buffer.from(artifact.content, 'utf8').toString('utf8') !== artifact.content) problem = '正文包含无法无损导出的字符，请修订后重试';
      if (!problem && safe.unsafe(artifact.content)) problem = '正文包含凭据或本机私人路径，请修订正文后导出';
      const status = problem ? 'blocked' : accepted ? 'accepted' : 'draft';
      const item = { id: artifact.id, taskId: task.id, title: title(artifact.title || task.title, '未命名产出'), taskTitle: title(task.title, '未命名事项'), format, bytes: typeof artifact.content === 'string' ? Buffer.byteLength(artifact.content) : 0, status, acceptanceMode: accepted ? task.acceptedBy === 'user' ? 'user' : 'automatic' : null, reasons: [...new Set([...(problem ? [problem] : []), ...reasons])].map(reason => title(reason, '需要核对')), selected: !problem && (accepted || options.includeDrafts) };
      items.push(item);
      if (item.selected) files.push({ kind: status, item, content: artifact.content });
      // Include unselected content as well: an eligible draft or blocked result
      // changing into an accepted result changes the user's reviewed selection.
      revisions.push(['artifact', artifact.id, artifact.content, item]);
    }
  }
  const replaced = new Set([...sources.values()].filter(source => source.projectId === project.id && !source.projectExcluded && source.previousSourceId && sources.get(source.previousSourceId)?.projectId === project.id).map(source => source.previousSourceId));
  for (const source of [...sources.values()].filter(source => source.projectId === project.id && !source.deleted && !source.projectExcluded && !replaced.has(source.id)).sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    let problem = '', content = source.content;
    if (typeof content !== 'string' || !content.trim()) problem = '材料正文缺失';
    else if (Buffer.byteLength(content) > limits.sourceBytes) problem = '单份材料超过 2 MiB，请缩小材料';
    else if (Buffer.from(content, 'utf8').toString('utf8') !== content) problem = '材料包含无法无损导出的字符';
    else if (safe.unsafe(content)) problem = '材料正文包含凭据或本机私人路径，请修订正文后导出';
    const item = { id: source.id, title: title(source.title, '未命名材料'), version: Number.isSafeInteger(source.version) && source.version > 0 ? source.version : 1, format: 'txt', bytes: typeof content === 'string' ? Buffer.byteLength(content) : 0, problem, selected: options.includeSources && !problem };
    sourceItems.push(item); if (item.selected) files.push({ kind: 'source', item, content });
    revisions.push(['source', source.id, source.content, source.previousSourceId, item]);
  }
  const selectedArtifacts = files.filter(file => file.kind !== 'source');
  const bytes = files.reduce((sum, file) => sum + file.item.bytes, 0), blockers = [];
  if (safe.credentialsUnavailable) blockers.push('暂时无法核对本机保存的凭据，请解锁凭据存储后重试。');
  if (!selectedArtifacts.length) blockers.push(options.includeDrafts ? '当前没有可导出的成果，请先生成并检查产出。' : '当前没有有效验收成果；可先完成验收，或明确勾选包含未验收草稿。');
  // Selecting sources means all current source bodies. Never silently omit an
  // unsafe/oversized source while showing the user's explicit inclusion choice.
  if (options.includeSources && sourceItems.some(source => source.problem)) blockers.push('选中的当前材料中有正文不可导出，请先修订材料或取消附材料正文。');
  if (files.length > limits.files) blockers.push(`交付包最多包含 ${limits.files} 份正文，请减少项目内需要交付的产出或材料。`);
  if (bytes > limits.totalBytes) blockers.push('交付包正文总量超过 8 MiB，请缩小本次交付范围。');
  const counts = { accepted: items.filter(item => item.status === 'accepted').length, drafts: items.filter(item => item.status === 'draft').length, blocked: items.filter(item => item.status === 'blocked').length, excluded, sources: sourceItems.length, selected: files.length, bytes };
  const report = { projectId: project.id, projectName: title(project.name, '项目'), archived: !!project.archivedAt, ...options, items, sources: sourceItems, counts, blockers, canExport: !blockers.length, limits, modelCalls: 0, networkRequests: 0 };
  report.revision = digest([project, options, revisions, counts, blockers, safe.revision]);
  return { report, files, safe };
}
function snapshot(a, input = {}) { return build(a, input).report; }
async function exportBundle(a, input = {}) {
  if (!object(input) || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) throw new Error('请先预览当前项目的交付包');
  const { report, files } = build(a, input);
  if (input.revision !== report.revision) throw new Error('项目或交付内容已变化，请刷新预览后重新下载');
  if (!report.canExport) throw new Error(report.blockers.join('；'));
  const generatedAt = new Date().toISOString(), zip = new JSZip(), counters = { accepted: 0, draft: 0, source: 0 }, directory = { accepted: 'accepted', draft: 'drafts', source: 'sources' };
  const entries = files.map(file => {
    const filename = `${directory[file.kind]}/${String(++counters[file.kind]).padStart(3, '0')}.${file.item.format}`;
    const content = Buffer.from(file.content, 'utf8');
    zip.file(filename, content, { date: new Date(generatedAt), createFolders: false });
    return { path: filename, kind: file.kind, title: file.item.title, bytes: content.length, sha256: hash(content), ...(file.kind === 'source' ? { version: file.item.version } : { task: file.item.taskTitle, acceptanceMode: file.item.acceptanceMode, reasons: file.item.reasons }) };
  });
  const manifest = { schemaVersion: 1, generatedAt, project: report.projectName, projectArchived: report.archived, options: { includeDrafts: report.includeDrafts, includeSources: report.includeSources }, counts: { accepted: counters.accepted, drafts: counters.draft, sources: counters.source }, entries,
    notes: ['正文取自本机保存的当前步骤产出，UTF-8 内容未改写。', 'accepted 内成果具有当前有效检查及完成记录；acceptanceMode 区分人工验收与自动验收。', 'drafts 内为未验收或检查已失效的当前产出，不代表已完成交付。', '未重新读取外部文件或平台；历史文件回执仅证明上次执行时核对成功。', '已省略内部标识、原始路径和授权信息。导出前确认正文可分享。'] };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n', { date: new Date(generatedAt) });
  const markdown = value => String(value).replace(/[\\`*_{}\[\]()#+.!<>|]/g, '\\$&');
  const explanation = [`# 项目成果交付包`, '', `项目：${markdown(report.projectName)}`, `生成时间：${generatedAt}`, `项目状态：${report.archived ? '已归档' : '进行中'}`, '', `有效验收成果：${counters.accepted} 份；未验收草稿：${counters.draft} 份；材料正文：${counters.source} 份。`, '', '## 使用说明', '', ...manifest.notes.map(note => `- ${note}`), '', '## 文件清单', '', ...entries.map(entry => `- ${entry.path} — ${markdown(entry.title)}（${entry.bytes} 字节）`), '', 'manifest.json 保存每份正文的 SHA-256，可用来核对传输后字节是否一致。', '本次下载没有发出任何外部消息，也没有执行项目事项。', ''].join('\n');
  zip.file('README.md', explanation, { date: new Date(generatedAt) });
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  // Compression yields to timers and other dispatches. Do not return a package
  // made from stale evidence if a task, source, receipt, or scope changed meanwhile.
  if (snapshot(a, input).revision !== report.revision) throw new Error('生成交付包期间项目内容已变化，请刷新后重新下载');
  if (buffer.length > limits.totalBytes + 1024 * 1024) throw new Error('交付包超过大小上限，请缩小范围');
  return { filename: `项目成果-${generatedAt.slice(0, 10)}.zip`, mimeType: 'application/zip', base64: buffer.toString('base64'), bytes: buffer.length, manifest, revision: report.revision, modelCalls: 0, networkRequests: 0 };
}
function dispatch(a, action, input = {}) {
  if (action === 'deliveryBundleSnapshot') return snapshot(a, input);
  if (action === 'deliveryBundleExport') return exportBundle(a, input);
  throw new Error('未知项目交付包操作');
}
module.exports = { dispatch, snapshot, exportBundle, limits };
