const crypto = require('node:crypto');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(object) : [];
const strings = value => Array.isArray(value) ? value.filter(value => typeof value === 'string') : [];
const pid = value => value == null || value === '' ? null : value;
const text = value => typeof value === 'string' ? value : '';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const limits = Object.freeze({ historyPageSize: 10, diffPageSize: 100, taskPageSize: 10, textPageChars: 5000, maxChars: 500000, maxLines: 8000, maxLineChars: 2000, maxCells: 250000 });
const channels = ['feedConnectionId', 'webConnectionId', 'connectorId', 'folderId'];
function index(items) {
  const map = new Map(), duplicates = new Set();
  for (const item of items) { if (map.has(item.id)) duplicates.add(item.id); else map.set(item.id, item); }
  for (const id of duplicates) map.delete(id);
  return { map, duplicates };
}
function family(source) {
  const keys = channels.filter(key => source[key] !== undefined && source[key] !== null && source[key] !== '');
  if (keys.length > 1 || keys.some(key => typeof source[key] !== 'string')) return null;
  const identity = source.identity == null ? '' : source.identity;
  if (typeof identity !== 'string') return null;
  if (keys[0] === 'feedConnectionId') {
    if (typeof source.feedEntryKey !== 'string' || !source.feedEntryKey) return null;
    return JSON.stringify([pid(source.projectId), keys[0], source.feedConnectionId, source.feedEntryKey, identity]);
  }
  if (keys[0] === 'folderId') {
    if (!identity && (typeof source.fileName !== 'string' || !source.fileName)) return null;
    return JSON.stringify([pid(source.projectId), keys[0], source.folderId, identity, source.fileName || '']);
  }
  if (keys.length) {
    if (keys[0] === 'connectorId' && !identity) return null;
    return JSON.stringify([pid(source.projectId), keys[0], source[keys[0]], identity]);
  }
  if (identity) return JSON.stringify([pid(source.projectId), 'identity', identity]);
  if (!text(source.title).trim()) return null;
  return JSON.stringify([pid(source.projectId), 'manual', source.title, text(source.origin)]);
}
function parameters(input) {
  if (!object(input) || typeof input.id !== 'string' || !input.id || input.id.length > 300) throw new Error('材料版本参数无效');
  for (const key of ['selectedId', 'compareId']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 300)) throw new Error('请选择有效的对比版本');
  const pages = {};
  for (const key of ['historyPage', 'diffPage', 'taskPage', 'leftPage', 'rightPage']) {
    const value = input[key] === undefined ? 1 : input[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new Error('版本对比分页参数无效');
    pages[key] = value;
  }
  return pages;
}
function graph(data, id) {
  const {map, duplicates} = index(rows(data.sources)), anchor = map.get(id);
  if (!anchor) throw new Error('材料不存在或标识重复，请刷新后核对');
  const key = family(anchor), children = new Map(), issues = [], issue = (code, message) => { if (!issues.some(item => item.code === code)) issues.push({code, message}); };
  if (pid(anchor.projectId) !== null && !rows(data.projects).some(project => project.id === anchor.projectId)) issue('project', '材料所属项目记录缺失，无法判断当前版本。');
  if (!key) issue('family', '材料来源标识不完整或存在冲突，无法关联其他版本。');
  for (const source of rows(data.sources)) if (source.previousSourceId) { const list = children.get(source.previousSourceId) || []; list.push(source); children.set(source.previousSourceId, list); }
  const members = new Map([[anchor.id, anchor]]), queue = [anchor], parents = new Map(), next = new Map();
  for (let i = 0; i < queue.length; i++) {
    const source = queue[i], previousId = source.previousSourceId;
    const join = candidate => {
      if (candidate && (typeof candidate.id !== 'string' || !candidate.id || duplicates.has(candidate.id))) { issue('duplicate', '相邻版本的标识缺失或重复，版本链需要核对。'); return false; }
      if (!candidate || !key || family(candidate) !== key) { issue('scope', '有版本关联指向其他项目或不同来源，已隔离这些记录。'); return false; }
      if (!members.has(candidate.id)) { members.set(candidate.id, candidate); queue.push(candidate); }
      return true;
    };
    if (previousId !== undefined && previousId !== null && previousId !== '') {
      if (typeof previousId !== 'string' || !map.has(previousId)) issue('missing', duplicates.has(previousId) ? '上版材料标识重复，版本链需要核对。' : '上版材料记录缺失或标识无效，版本链不完整。');
      else if (join(map.get(previousId))) parents.set(source.id, previousId);
    } else if (Number.isSafeInteger(source.version) && source.version > 1) issue('missing', '材料标称为后续版本，但缺少上版关联，历史不完整。');
    const successors = [];
    for (const child of children.get(source.id) || []) {
      // Attaching a copy to another project preserves its original previous ID.
      // It starts another project's material history, not a successor of this chain.
      if (pid(child.projectId) !== pid(anchor.projectId) && typeof child.copiedFrom === 'string' && map.has(child.copiedFrom)) continue;
      if (join(child)) successors.push(child.id);
    }
    next.set(source.id, successors);
    if (successors.length > 1) issue('branch', '同一版本存在多个后续分支，无法自动判定最新版本。');
  }
  const roots = [...members.keys()].filter(id => !parents.has(id)), leaves = [...members.keys()].filter(id => !(next.get(id) || []).length), ordered = [], seen = new Set();
  if (roots.length === 1) {
    let cursor = roots[0];
    while (cursor && !seen.has(cursor)) { seen.add(cursor); ordered.push(members.get(cursor)); const successors = next.get(cursor) || []; cursor = successors.length === 1 ? successors[0] : null; }
  }
  // Detect cycles in each component without recursive traversal or a depth cap.
  const checked = new Set();
  for (const id of members.keys()) {
    let cursor = id; const trail = new Set();
    while (cursor && !checked.has(cursor) && !trail.has(cursor)) { trail.add(cursor); cursor = parents.get(cursor); }
    if (cursor && trail.has(cursor)) issue('cycle', '版本关联存在循环，不能据此判定先后或当前版本。');
    for (const value of trail) checked.add(value);
  }
  for (const [id, previous] of parents) {
    const source = members.get(id), parent = members.get(previous);
    if (Number.isSafeInteger(source.version) && Number.isSafeInteger(parent.version) && source.version !== parent.version + 1) issue('number', '版本编号与前后关联不一致，请核对原记录。');
  }
  const linear = issues.length === 0 && roots.length === 1 && leaves.length === 1 && ordered.length === members.size;
  const latest = linear ? members.get(leaves[0]) : null;
  const history = linear ? ordered.slice().reverse() : [...members.values()].sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  return {anchor, members, parents, latest, history, linear, issues};
}
function page(items, requested, size) {
  const pageCount = Math.max(1, Math.ceil(items.length / size)), page = Math.min(requested, pageCount);
  return {items: items.slice((page - 1) * size, page * size), total: items.length, page, pageCount, pageSize: size};
}
function metadata(source, latest, linear) {
  return {id: source.id, title: text(source.title) || '未命名材料', version: Number.isSafeInteger(source.version) && source.version > 0 ? source.version : null, createdAt: typeof source.createdAt === 'string' && Number.isFinite(Date.parse(source.createdAt)) ? new Date(source.createdAt).toISOString() : null,
    chars: typeof source.content === 'string' ? source.content.length : null, deleted: source.deleted === true, withdrawn: source.projectExcluded === true, latest: !!latest && latest.id === source.id, current: !!latest && latest.id === source.id && !source.deleted && !source.projectExcluded,
    relation: !linear ? 'uncertain' : latest?.id === source.id ? 'latest' : 'historical'};
}
function textPage(content, requested) {
  const pageCount = Math.max(1, Math.ceil(content.length / limits.textPageChars)), page = Math.min(requested, pageCount), start = (page - 1) * limits.textPageChars, end = Math.min(content.length, start + limits.textPageChars);
  // Slice boundaries may fall between UTF-16 surrogate halves. The extra unit is
  // shown at the boundary, and offsets explicitly describe the returned text.
  let from = start, to = end;
  if (from > 0 && /[\uDC00-\uDFFF]/.test(content[from]) && /[\uD800-\uDBFF]/.test(content[from - 1])) from--;
  if (to > 0 && to < content.length && /[\uD800-\uDBFF]/.test(content[to - 1]) && /[\uDC00-\uDFFF]/.test(content[to])) to++;
  return {text: content.slice(from, to), totalChars: content.length, page, pageCount, start: from, end: to, boundaryOverlap: from !== start || to !== end};
}
function tokenize(content) {
  const tokens = []; let start = 0;
  const push = end => { if (end - start > limits.maxLineChars) return '存在超过 2000 字符的长行'; tokens.push(content.slice(start, end)); start = end; return tokens.length > limits.maxLines ? '材料行数超过 8000 行' : null; };
  for (let i = 0; i < content.length; i++) if (content[i] === '\r' || content[i] === '\n') { if (content[i] === '\r' && content[i + 1] === '\n') i++; const error = push(i + 1); if (error) return {error}; }
  if (start < content.length) { const error = push(content.length); if (error) return {error}; }
  return {tokens};
}
function lineCount(content) { let lines = 0, start = 0; for (let i = 0; i < content.length; i++) if (content[i] === '\r' || content[i] === '\n') { if (content[i] === '\r' && content[i + 1] === '\n') i++; lines++; start = i + 1; } return lines + Number(start < content.length); }
function displayRow(row) {
  const match = row.token.match(/(\r\n|\r|\n)$/), ending = match?.[0] || '';
  return {kind: row.kind, oldLine: row.oldLine, newLine: row.newLine, text: ending ? row.token.slice(0, -ending.length) : row.token, ending: ending === '\r\n' ? 'CRLF' : ending === '\n' ? 'LF' : ending === '\r' ? 'CR' : 'none'};
}
function compare(left, right, pages) {
  if (typeof left !== 'string' || typeof right !== 'string') return {mode: 'unavailable', complete: false, identical: null, counts: null, reason: '其中一版正文缺失，无法比较。'};
  const same = left === right;
  const fallback = reason => ({mode: 'preview', complete: same, identical: same, counts: same ? {added: 0, removed: 0, unchanged: lineCount(left)} : null, reason: `${reason}，已改为逐页原文预览${same ? '；已精确确认两版正文完全相同。' : '，未计算完整行差异。'}`, left: textPage(left, pages.leftPage), right: textPage(right, pages.rightPage)});
  if (left.length > limits.maxChars || right.length > limits.maxChars) return fallback('正文超过 50 万字符的比较范围');
  const old = tokenize(left), next = tokenize(right);
  if (old.error || next.error) return fallback(old.error || next.error);
  const a = old.tokens, b = next.tokens; let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  if (n * m > limits.maxCells) return fallback('变化范围超过 25 万格的行对齐上限');
  const matrix = new Uint16Array((n + 1) * (m + 1)), width = m + 1;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) matrix[i * width + j] = a[prefix + i] === b[prefix + j] ? 1 + matrix[(i + 1) * width + j + 1] : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  const differences = [], counts = {added: 0, removed: 0, unchanged: 0};
  const append = (kind, token, oldLine, newLine) => { counts[kind]++; differences.push({kind, token, oldLine, newLine}); };
  for (let i = 0; i < prefix; i++) append('unchanged', a[i], i + 1, i + 1);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) { append('unchanged', a[prefix + i], prefix + i + 1, prefix + j + 1); i++; j++; }
    else if (i < n && (j === m || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) { append('removed', a[prefix + i], prefix + i + 1, null); i++; }
    else { append('added', b[prefix + j], null, prefix + j + 1); j++; }
  }
  for (let k = suffix; k > 0; k--) append('unchanged', a[a.length - k], a.length - k + 1, b.length - k + 1);
  const paged = page(differences, pages.diffPage, limits.diffPageSize);
  return {mode: 'diff', complete: true, identical: same, counts, ...paged, items: paged.items.map(displayRow), leftLines: a.length, rightLines: b.length, reason: null};
}
function affected(data, left, right, requestedPage) {
  const jobs = index(rows(data.delegations)).map, tasks = index(rows(data.tasks)).map, selected = new Set([left.id, right.id]), scope = pid(left.projectId), matches = [];
  for (const task of tasks.values()) {
    const refs = [...new Set(strings(task.sourceIds))].filter(id => selected.has(id)); if (!refs.length) continue;
    const job = jobs.get(task.agentJobId), owner = pid(task.projectId) ?? pid(job?.projectId);
    if (owner !== scope || task.agentJobId && (!job || pid(job.projectId) !== scope || !strings(job.taskIds).includes(task.id))) continue;
    matches.push({id: task.id, title: text(task.title) || '未命名事项', status: text(task.status), cancelled: task.agentCancelled === true, needsReplan: typeof task.needsReplan === 'string' ? task.needsReplan : task.needsReplan ? '需要重新核对计划' : '', references: refs.map(id => ({id, sides: [id === left.id ? 'left' : null, id === right.id ? 'right' : null].filter(Boolean), active: !strings(task.supersededSourceIds).includes(id)}))});
  }
  matches.sort((a, b) => Number(!!b.needsReplan) - Number(!!a.needsReplan) || a.id.localeCompare(b.id));
  return {...page(matches, requestedPage, limits.taskPageSize), notice: '仅列出明确引用所选两版材料的事项。引用和待重规划标记不代表已经重算或完成验证。'};
}
function snapshot(a, input = {}) {
  const pages = parameters(input), data = object(a.data) ? a.data : {}, chain = graph(data, input.id);
  const selectedId = input.selectedId === undefined ? input.id : input.selectedId, compareId = input.compareId === undefined ? chain.parents.get(selectedId) || selectedId : input.compareId;
  if (!chain.members.has(selectedId) || !chain.members.has(compareId)) throw new Error('只能对比同一项目、同一合法来源链中的版本');
  const left = chain.members.get(compareId), right = chain.members.get(selectedId), meta = source => metadata(source, chain.latest, chain.linear);
  const history = page(chain.history.map(meta), pages.historyPage, limits.historyPageSize), tasks = affected(data, left, right, pages.taskPage), diff = left.accessPolicyQuarantined||right.accessPolicyQuarantined?{mode:'unavailable',complete:false,identical:null,counts:null,reason:'正文保留权限已撤回或待恢复，仅可查看版本记录。'}:compare(left.content, right.content, pages);
  return {id: input.id, selectedId, compareId, projectId: pid(chain.anchor.projectId), history: {...history, order: chain.linear ? 'linked' : 'recorded'}, left: meta(left), right: meta(right), latestId: chain.latest?.id || null, latestPreviousId: chain.latest ? chain.parents.get(chain.latest.id) || chain.latest.id : null, currentId: chain.latest && !chain.latest.deleted && !chain.latest.projectExcluded ? chain.latest.id : null, newerAvailable: !!chain.latest && chain.latest.id !== right.id,
    issues: chain.issues, chainValid: chain.linear, direction: left.id === right.id ? 'same' : !chain.linear ? 'unknown' : chain.history.findIndex(source => source.id === left.id) > chain.history.findIndex(source => source.id === right.id) ? 'forward' : 'backward', diff, affectedTasks: tasks, revision: hash([chain.history.map(source => [source.id, source.previousSourceId, source.version, source.deleted, source.projectExcluded, source.createdAt, source.title]), left.content, right.content, tasks.items]), limits, modelCalls: 0, networkRequests: 0};
}
function dispatch(a, action, input = {}) {
  if (action === 'sourceVersionsSnapshot') return snapshot(a, input);
  throw new Error('未知材料版本操作');
}
module.exports = {dispatch, snapshot, limits};
