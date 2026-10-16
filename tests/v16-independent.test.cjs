const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Assistant } = require('../desktop/core.cjs');
const agent = require('../desktop/agent.cjs');
const stewardship = require('../desktop/stewardship.cjs');
const { blockedError } = require('../desktop/model-errors.cjs');
const modelErrors = require('../desktop/model-errors.cjs');
const fallback = require('../desktop/model-fallback.cjs');
const versions = require('../desktop/source-versions.cjs');

async function setup(t, chat = async () => ({ ok: true })) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v16-independent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deny = async () => { throw new Error('Independent tests forbid real service calls'); };
  const a = new Assistant({ dir, chat, agentRequest: deny, connectorRequest: deny, webRequest: deny, feedRequest: deny });
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: 'primary', model: 'primary', baseUrl: 'https://primary.invalid/v1' });
  const primary = a.data.providers[0];
  return { a, primary, request: (options = {}) => a.callModel(primary, '', [{ role: 'user', content: 'test material' }], { role: 'execute', stage: 'task_work', ...options }) };
}

test('V16 independent: pre-cancelled inference spends no workspace or delegation allowance and never calls a model', async t => {
  let calls = 0; const { a, request } = await setup(t, async () => { calls++; return { ok: true }; });
  const job = agent.buildJob(a, { goal: '取消前不得开始', fileMode: 'off', githubMode: 'off' }); a.data.delegations.push(job); a.activeAgentJob = job;
  const controller = new AbortController(); controller.abort();
  const before = stewardship.status(a).used;
  await assert.rejects(request({ signal: controller.signal }), /abort|停止|取消/i);
  assert.equal(calls, 0); assert.equal(stewardship.status(a).used, before); assert.equal(job.callsUsed, 0); assert.equal((a.data.modelCalls || []).length, 0);
});

for (const blocked of [false, true]) test(`V16 independent: persistence failure after ${blocked ? 'a refusal' : 'successful inference'} is never eligible for automatic replay`, async t => {
  let calls = 0;
  const { a, request } = await setup(t, async () => { calls++; if (blocked) throw blockedError(); return { ok: true }; });
  const save = a.save.bind(a); let failed = false;
  a.save = () => { if (calls > 0 && !failed) { failed = true; throw new Error('Simulated local persistence failure'); } return save(); };
  await assert.rejects(request(), error => error.automaticRetry === false);
  assert.equal(calls, 1); assert.equal(stewardship.status(a).used, 1);
  a.save = save;
});

test('V16 independent: refusal telemetry retains a stable error code instead of boolean modelFailure', async t => {
  const { a, request } = await setup(t, async () => { throw blockedError(); });
  await assert.rejects(request(), error => error.code === 'MODEL_BLOCKED' && error.automaticRetry === false);
  assert.equal(a.data.modelCalls[0].errorCode, 'MODEL_BLOCKED');
});

test('V16 independent: a refused model plus a transient local save failure cannot schedule an automatic Agent retry', async t => {
  let calls = 0; const { a } = await setup(t, async () => { calls++; throw blockedError(); });
  const job = agent.buildJob(a, { goal: '检查保存失败后的模型拦截', fileMode: 'off', githubMode: 'off' }); a.data.delegations.push(job);
  const save = a.save.bind(a); let failed = false;
  a.save = () => { if (!failed && a.data.modelCalls?.[0]?.errorCode === 'MODEL_BLOCKED') { failed = true; throw new Error('Simulated ledger save failure'); } return save(); };
  await a.dispatch('agentRun', { id: job.id }); await a.runPromise;
  assert.equal(calls, 1); assert.equal(job.status, 'blocked'); assert.equal(job.nextRunAt, null);
  assert.equal(a.data.tasks.length, 0); assert.equal(a.data.agentActions.length, 0);
  a.save = save;
});

async function enableBackup(a, roles = ['execute', 'verify']) {
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: 'backup', model: 'backup', baseUrl: 'https://backup.invalid/v1', key: 'BACKUP-CREDENTIAL' });
  const backup = a.data.providers.find(provider => provider.name === 'backup');
  fallback.initialize(a); const snapshot = fallback.snapshot(a);
  fallback.dispatch(a, 'modelFallbackSave', { revision: snapshot.revision, roles: Object.fromEntries(['organize', 'execute', 'verify'].map(role => [role, { enabled: roles.includes(role), providerId: roles.includes(role) ? backup.id : '' }])) });
  return backup;
}

test('V16 independent: fallback resumes generation and verification while a real local delivery occurs exactly once', async t => {
  const seen = []; const { a, primary } = await setup(t);
  const backup = await enableBackup(a);
  a.chat = async (provider, key, messages) => {
    seen.push(provider.id); if (provider.id === primary.id) throw modelErrors.transportError();
    assert.equal(provider.id, backup.id); assert.equal(key, 'BACKUP-CREDENTIAL');
    return messages[0].content.includes('推进给定事项') ? { kind: 'artifact', title: '结果', content: '当前项目成果正文。' } : { passed: true, summary: '结果与交付一致', gaps: [] };
  };
  const output = path.join(a.dir, 'outputs'); fs.mkdirSync(output); a.data.agentSettings.outputFolder = output;
  const job = agent.buildJob(a, { goal: '整理并保存一份成果', useOutputFolder: true, fileMode: 'auto', githubMode: 'off', autoAccept: true, maxCalls: 10 }); a.data.delegations.push(job);
  const plan = await agent.act(a, job, 'plan_task', { key: 'report', title: '成果', criteria: '有真实文件', steps: [{ key: 'draft', title: '编写', kind: 'draft' }, { key: 'save', title: '保存', kind: 'external', tool: 'write_file' }] });
  const task = a.task(plan.taskId); await a.advance(task.id); assert.equal(a.data.artifacts.length, 1);
  const receipt = await agent.act(a, job, 'write_file', { taskId: task.id }); await a.advance(task.id);
  assert.equal(task.status, 'review'); assert.equal(task.acceptedAt, undefined); assert.equal(a.data.artifacts.length, 1); assert.equal(a.data.agentActions.length, 1); assert.equal(a.data.agentActions[0].status, 'done');
  assert.equal(fs.readFileSync(receipt.path, 'utf8'), '当前项目成果正文。');
  assert.deepEqual(seen, [primary.id, backup.id, primary.id, backup.id]); assert.equal(job.callsUsed, 4); assert.equal(stewardship.status(a).used, 4);
  const requests = new Set(a.data.modelCalls.map(row => row.requestId)); assert.equal(requests.size, 2);
  for (const id of requests) assert.deepEqual(a.data.modelCalls.filter(row => row.requestId === id).map(row => row.attempt).sort(), [1, 2]);
});

for (const failure of ['refusal', 'quota', 'auth', 'invalid']) test(`V16 independent: configured fallback does not bypass ${failure} failures`, async t => {
  const seen = []; const { a, primary, request } = await setup(t); await enableBackup(a);
  const error = failure === 'refusal' ? blockedError() : failure === 'quota' ? modelErrors.httpError(429, 'insufficient_quota') : failure === 'auth' ? modelErrors.httpError(403) : modelErrors.modelError('MODEL_INVALID_RESPONSE', '无效结构', false);
  a.chat = async provider => { seen.push(provider.id); throw error; };
  await assert.rejects(request()); assert.deepEqual(seen, [primary.id]); assert.equal(stewardship.status(a).used, 1); assert.equal(a.data.modelCalls.length, 1);
});



test('V16 independent: cancellation after a primary failure prevents a backup call and second charge', async t => {
  const seen = []; const { a, primary, request } = await setup(t); await enableBackup(a); const controller = new AbortController();
  a.chat = async provider => { seen.push(provider.id); controller.abort(); throw modelErrors.transportError(); };
  await assert.rejects(request({ signal: controller.signal }), /停止|取消|abort/i);
  assert.deepEqual(seen, [primary.id]); assert.equal(stewardship.status(a).used, 1); assert.equal(a.data.modelCalls.length, 1);
});

test('V16 independent: changed provider credentials revoke fallback permission before another model receives context', async t => {
  const seen = []; const { a, primary, request } = await setup(t); const backup = await enableBackup(a);
  a.chat = async provider => { seen.push(provider.id); backup.sealedKey = a.vault.seal('CHANGED-CREDENTIAL'); throw modelErrors.transportError(); };
  await assert.rejects(request()); assert.deepEqual(seen, [primary.id]); assert.equal(stewardship.status(a).used, 1); assert.equal(fallback.snapshot(a).roles.execute.enabled, false);
});

test('V16 independent: copying a revision into another project does not corrupt the original legal version chain', async t => {
  const { a } = await setup(t); await a.dispatch('projectSave', { name: '原项目' }); const project = a.data.projects[0];
  await a.dispatch('import', { items: [{ title: '预算说明', content: '6800', projectId: project.id }] }); const first = a.data.sources[0];
  await a.dispatch('import', { items: [{ title: '预算说明', content: '7200', projectId: project.id }] }); const current = a.data.sources[0];
  await a.dispatch('projectSave', { name: '另一个项目的私有名称' }); const other = a.data.projects[0];
  await a.dispatch('projectAttach', { id: other.id, sourceIds: [current.id] }); const copy = a.data.sources[0]; assert.equal(copy.copiedFrom, current.id);
  const report = versions.snapshot(a, { id: current.id });
  assert.equal(report.chainValid, true); assert.equal(report.latestId, current.id); assert.deepEqual(new Set(report.history.items.map(row => row.id)), new Set([first.id, current.id]));
  assert.equal(JSON.stringify(report).includes(other.name), false); assert.equal(JSON.stringify(report).includes(copy.id), false);
});

test('V16 independent: foreign previous links and compare targets never disclose another project material', async t => {
  const { a } = await setup(t); a.data.projects.push({ id: 'p', name: '本项目' }, { id: 'foreign-project', name: '另项目私有标题' });
  a.data.sources.push({ id: 'foreign-source', projectId: 'foreign-project', title: '机密材料标题', content: 'NEVER-LEAK-CONTENT', identity: 'same-key', version: 1 }, { id: 'local-source', projectId: 'p', title: '本项目资料', content: '本项目资料正文', identity: 'same-key', version: 2, previousSourceId: 'foreign-source' });
  const before = structuredClone(a.data), report = versions.snapshot(a, { id: 'local-source' });
  assert.equal(report.chainValid, false); assert.equal(report.currentId, null); assert.equal(report.latestId, null);
  for (const forbidden of ['foreign-source', 'foreign-project', '机密材料标题', 'NEVER-LEAK-CONTENT', '另项目私有标题']) assert.equal(JSON.stringify(report).includes(forbidden), false, forbidden);
  assert.throws(() => versions.snapshot(a, { id: 'local-source', compareId: 'foreign-source' }), /同一|合法/);
  assert.deepEqual(a.data, before);
});

for (const shape of ['cycle', 'branch', 'missing']) test(`V16 independent: a ${shape} version family cannot claim a latest/current result`, async t => {
  const { a } = await setup(t); a.data.projects.push({ id: 'p', name: '项目' });
  const base = { projectId: 'p', title: '版本资料', identity: 'record', content: '相同正文' };
  if (shape === 'cycle') a.data.sources.push({ ...base, id: 'a', previousSourceId: 'b' }, { ...base, id: 'b', previousSourceId: 'a' });
  if (shape === 'branch') a.data.sources.push({ ...base, id: 'a', version: 1 }, { ...base, id: 'b', version: 2, previousSourceId: 'a' }, { ...base, id: 'c', version: 2, previousSourceId: 'a' });
  if (shape === 'missing') a.data.sources.push({ ...base, id: 'a', version: 2, previousSourceId: 'missing-parent' });
  const before = structuredClone(a.data), report = versions.snapshot(a, { id: 'a' });
  assert.equal(report.chainValid, false); assert.equal(report.latestId, null); assert.equal(report.currentId, null); assert.ok(report.issues.length > 0); assert.deepEqual(a.data, before);
});

test('V16 independent: very long lines use honest paged text and preserve every UTF-16 boundary without invented diff counts', async t => {
  const { a } = await setup(t); a.data.projects.push({ id: 'p', name: '项目' });
  const old = 'x'.repeat(4999) + '🧭' + '甲'.repeat(12000), current = 'x'.repeat(4999) + '🧭' + '乙'.repeat(12000);
  a.data.sources.push({ id: 'old', projectId: 'p', title: '长文', origin: '输入', content: old, version: 1 }, { id: 'current', projectId: 'p', title: '长文', origin: '输入', content: current, version: 2, previousSourceId: 'old' });
  const first = versions.snapshot(a, { id: 'current' }); assert.equal(first.diff.mode, 'preview'); assert.equal(first.diff.complete, false); assert.equal(first.diff.counts, null);
  const recovered = new Array(current.length);
  for (let page = 1; page <= first.diff.right.pageCount; page++) {
    const part = versions.snapshot(a, { id: 'current', rightPage: page }).diff.right;
    assert.equal(Buffer.from(part.text, 'utf8').toString('utf8'), part.text);
    for (let i = 0; i < part.text.length; i++) recovered[part.start + i] = part.text[i];
  }
  assert.equal(recovered.join(''), current);
});

test('V16 independent: a historical deleted marker retains metadata without exposing withdrawn body or revalidating the task', async t => {
  const { a } = await setup(t); a.data.projects.push({ id: 'p', name: '项目' });
  const base = { projectId: 'p', title: '授权文件', identity: 'file-identity', folderId: 'folder', fileName: 'facts.md' };
  a.data.sources.push({ ...base, id: 'first', version: 1, content: '预算6800' }, { ...base, id: 'deleted', version: 2, previousSourceId: 'first', deleted: true, content: '预算6800' }, { ...base, id: 'restored', version: 3, previousSourceId: 'deleted', content: '预算7200' });
  const task = a.createTask({ title: '等待重新核对', projectId: 'p', sourceIds: ['first', 'restored'] }); task.supersededSourceIds = ['first']; task.needsReplan = '来源已更新'; task.status = 'blocked';
  const before = structuredClone(a.data), report = versions.snapshot(a, { id: 'restored', compareId: 'deleted' });
  assert.equal(report.chainValid, true); assert.equal(report.currentId, 'restored'); assert.equal(report.left.deleted, true); assert.equal(report.diff.complete, false); assert.equal(report.diff.mode, 'unavailable'); assert.doesNotMatch(JSON.stringify(report.diff), /预算6800/);
  assert.equal(report.affectedTasks.items[0].id, task.id); assert.equal(report.affectedTasks.items[0].needsReplan, '来源已更新'); assert.deepEqual(a.data, before);
});
