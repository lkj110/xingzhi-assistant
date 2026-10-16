const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Assistant } = require('../desktop/core.cjs');
const agent = require('../desktop/agent.cjs');
const capture = require('../desktop/capture.cjs');
const feeds = require('../desktop/feeds.cjs');
const recovery = require('../desktop/recovery.cjs');
const errors = require('../desktop/model-errors.cjs');
const stewardship = require('../desktop/stewardship.cjs');

async function setup(t, chat = async () => ({ tasks: [], summary: '保留背景资料' })) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v18-independent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deny = async () => { throw new Error('Independent tests forbid real external services'); };
  const a = new Assistant({ dir, chat, agentRequest: deny, connectorRequest: deny, webRequest: deny, feedRequest: deny });
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' });
  return a;
}
const material = (title = '新增要求', content = '请核对原计划的新信息') => ({ textItems: [{ title, content }], organize: true });
async function at(time, fn) { const previous = Date.now; Date.now = () => Date.parse(time); try { return await fn(); } finally { Date.now = previous; } }
const sourceTasks = input => ({ tasks: input.sources.map(source => ({ title: `处理${source.title}`, criteria: '依据本份资料完成', sourceIds: [source.id], steps: [{ title: '编写说明', kind: 'draft' }] })) });
const retryPolicy = (a, row, enabled) => a.dispatch('captureRetryPolicy', { id: row.id, enabled, revision: a.publicState().captureQueue.find(value => value.id === row.id).autoRetry.revision });

test('V18 independent: after a capture retry, fair rotation may reach project review before a queued capture, then the next tick imports it and wakes the same job', async t => {
  let a, extractionCalls = 0, calls = 0;
  a = await setup(t, async (_provider, _key, messages) => {
    calls++; const system = messages[0].content, input = JSON.parse(messages[1].content);
    if (system.includes('从材料提取')) {
      if (++extractionCalls === 1) throw errors.httpError(503);
      return { tasks: [], summary: '纯背景资料已整理' };
    }
    if (system.includes('动作格式')) {
      const task = a.data.tasks[0];
      if (!task) return { tool: 'plan_task', args: { key: 'review', title: '整理项目说明', criteria: '依据项目材料给出说明', sourceIds: input.sources.map(source => source.id), steps: [{ title: '撰写说明', kind: 'draft' }] } };
      if (task.status !== 'review') return { tool: 'advance_task', args: { taskId: task.id } };
      return { tool: 'complete', args: { summary: '说明已交付，等待用户验收' } };
    }
    if (system.includes('推进给定事项')) return { kind: 'artifact', title: '项目说明', content: '依据原材料整理的项目说明。' };
    return { passed: true, summary: '说明满足当前材料中的标准', gaps: [] };
  });
  await a.dispatch('projectSave', { name: '队列轮转项目' }); const project = a.data.projects[0];
  a.addSources([{ projectId: project.id, title: '原始项目材料', content: '请整理一份项目说明。' }]);
  const manual = agent.buildJob(a, { goal: '手动暂停的其他委托' }); manual.status = 'paused'; a.data.delegations.push(manual);
  await a.dispatch('captureEnqueue', { ...material('背景', '纯背景，无需行动'), autoRetry: true }); await a.runPromise;
  const retry = a.data.captureQueue[0]; assert.equal(retry.status, 'failed');
  await at(retry.autoRetry.nextRetryAt, async () => { a.tick(); await a.runPromise; });
  assert.equal(retry.status, 'completed'); assert.equal(a.lastQueue, 'capture'); assert.equal(extractionCalls, 2);
  const until = new Date(Date.now() + 60000).toISOString();
  await a.dispatch('stewardshipPause', { until, revision: stewardship.status(a).revision });
  const quick = require('../desktop/quick-capture.cjs').createController({ assistant: a, BrowserWindow: function () { throw Error('No native window'); }, globalShortcut: { isRegistered: () => false, register: () => false, unregister() {} }, preload: __filename, indexFile: __filename });
  t.after(() => quick.dispose());
  const saved = await quick.submit({ requestId: require('node:crypto').randomUUID(), projectId: project.id, organize: false, textItems: [{ title: '新补充材料', content: '项目收到一条新的背景说明。' }] });
  const queued = a.data.captureQueue.find(row => row.id === saved.receipt.id); assert.equal(queued.status, 'queued');
  await a.dispatch('ruleSave', { name: '说明定时交付', projectId: project.id, goal: '按已收材料整理项目说明并交用户验收', trigger: 'daily', time: '09:00', enabled: true, allowWeb: false, folderIds: [], useOutputFolder: false, fileMode: 'off', useGithub: false, maxCalls: 30, maxActions: 12, dailyCalls: 30, dailyStarts: 1, autoAccept: false });
  a.data.workRules[0].nextRunAt = new Date(Date.now() - 1000).toISOString(); a.save(); a.tick();
  assert.equal(project.jobId, null); assert.equal(queued.status, 'queued');
  await at(new Date(Date.parse(until) + 1000).toISOString(), async () => {
    a.tick(); await a.runPromise;
    const job = a.data.delegations.find(value => value.id === project.jobId);
    assert.ok(job); assert.equal(a.lastQueue, 'rules'); assert.equal(job.status, 'ready'); assert.equal(queued.status, 'queued');
    a.tick(); await a.runPromise;
    assert.equal(a.lastQueue, 'agent'); assert.equal(job.status, 'review'); assert.equal(a.task(job.taskIds[0]).status, 'review'); assert.equal(queued.status, 'queued');
    const callsBefore = calls, priorSources = a.data.sources.length;
    a.tick(); await a.runPromise;
    assert.equal(a.lastQueue, 'capture'); assert.equal(queued.status, 'completed'); assert.equal(queued.sourceIds.length, 1);
    assert.equal(a.data.sources.length, priorSources + 1); assert.equal(calls, callsBefore); assert.equal(job.status, 'ready');
    assert.equal(project.jobId, job.id); assert.ok(job.sourceIds.includes(queued.sourceIds[0])); assert.equal(a.data.tasks.length, 1);
    assert.equal(manual.status, 'paused'); assert.equal(stewardship.status(a).pauseUntil, null);
  });
});

for (const prependNew of [false, true]) test(`V18 independent: organizing new material cannot mutate an independent task under an unknown external receipt${prependNew ? ' or partially commit an earlier new task' : ''}`, async t => {
  let task, calls = 0;
  const a = await setup(t, async (_provider, _key, messages) => {
    calls++; const input = JSON.parse(messages[1].content), sourceIds = input.sources.map(source => source.id);
    return { tasks: [
      ...(prependNew ? [{ title: '不应部分创建的任务', criteria: '保留整批原子性', sourceIds, steps: [{ title: '写文档', kind: 'draft' }] }] : []),
      { existingTaskId: task.id, title: task.title, sourceIds, description: '改变既有范围' }
    ] };
  });
  task = a.createTask({ title: '旧格式独立事项', criteria: '先核对外部交付' }); task.status = 'review'; task.verification = { passed: true, summary: '原结论' };
  const receipt = { id: 'legacy-independent-unknown', taskId: task.id, status: 'uncertain', tool: 'write_file', content: '原外部交付' }; a.data.agentActions.push(receipt);
  const before = structuredClone({ task, receipt });
  await a.dispatch('captureEnqueue', material()); await a.runPromise;
  assert.equal(calls, 1); assert.equal(a.data.captureQueue[0].status, 'failed');
  assert.deepEqual({ task: a.task(task.id), receipt: a.data.agentActions[0] }, before);
  assert.equal(a.data.tasks.length, 1); assert.equal(a.data.sources[0].state, 'new');
});

for (const paused of [false, true]) test(`V18 independent: new organized evidence invalidates an independent ${paused ? 'paused' : 'active'} task approval without executing the old action`, async t => {
  let task, calls = 0; const a = await setup(t, async (_provider, _key, messages) => {
    calls++; const input = JSON.parse(messages[1].content);
    return { tasks: [{ existingTaskId: task.id, title: task.title, sourceIds: input.sources.map(source => source.id), description: '交付目标获得新证据' }] };
  });
  task = a.createTask({ title: '等待旧审批的独立事项' }); if (paused) task.status = 'paused';
  const receipt = { id: 'legacy-approved-pending', taskId: task.id, status: 'pending', approvedAt: '2026-10-01T00:00:00Z', tool: 'write_file', content: '旧内容不可自动发出' };
  a.data.agentActions.push(receipt);
  await a.dispatch('captureEnqueue', material()); await a.runPromise;
  assert.equal(a.data.captureQueue[0].status, 'completed'); assert.equal(task.sourceIds.length, 1); assert.equal(calls, 1);
  assert.equal(receipt.status, 'stale'); assert.equal(receipt.approvedAt, undefined); assert.equal(receipt.content, '旧内容不可自动发出');
  assert.equal(a.data.agentActions.length, 1); assert.equal(a.data.artifacts.length, 0);
  if (paused) assert.equal(task.status, 'paused');
});

for (const action of ['updateTask', 'taskAction']) test(`V18 independent: ${action} cannot retain a legacy independent approval after its task requirements change`, async t => {
  const a = await setup(t), task = a.createTask({ title: '独立事项', criteria: '原标准' });
  const receipt = { id: 'legacy-manual-pending', taskId: task.id, status: 'pending', approvedAt: '2026-10-01T00:00:00Z', tool: 'write_file', content: '原审批正文' }; a.data.agentActions.push(receipt);
  await a.dispatch(action, action === 'updateTask' ? { id: task.id, criteria: '新的验收范围' } : { id: task.id, command: 'feedback', note: '交付范围发生变化' });
  assert.equal(receipt.status, 'stale'); assert.equal(receipt.approvedAt, undefined); assert.equal(receipt.content, '原审批正文'); assert.equal((a.data.modelCalls || []).length, 0);
});

const xml = items => `<rss version="2.0"><channel>${items.map(item => `<item><guid>${item.id}</guid><title>${item.title || '公告'}</title><link>https://feed.example/2026/${item.id}</link><pubDate>Fri, 02 Oct 2026 12:00:00 GMT</pubDate><description><![CDATA[${item.body}]]></description></item>`).join('')}</channel></rss>`;
const rule = (include = [], exclude = [], scope = 'body') => ({ include, exclude, scope, match: 'any' });
async function feedFixture(t, filter = rule()) {
  const a = await setup(t); let body = xml([]), requests = 0;
  a.feedRequest = async () => { requests++; return { status: 200, url: 'https://feed.example/rss.xml', headers: { 'content-type': 'application/rss+xml' }, body }; };
  await a.dispatch('projectSave', { name: '独立 RSS 审查' }); const project = a.data.projects[0];
  await a.dispatch('feedConnectionSave', { name: '公告订阅', url: 'https://feed.example/rss.xml', projectId: project.id, intervalMinutes: 30, enabled: false, filter }); const id = a.data.feedConnections[0].id;
  const current = () => a.data.feedConnections.find(row => row.id === id);
  return { a, project, current, requests: () => requests, set: entries => { body = xml(entries); },
    configure: async filter => a.dispatch('feedConnectionSave', { ...current(), filter }),
    sync: async () => { await a.dispatch('feedConnectionSync', { id }); await a.runPromise; return a.data.feedConnectionRuns[0]; } };
}

test('V18 independent: body-only RSS filters cannot be satisfied by generated URL, title, or publication metadata', async t => {
  const { a, set, sync, requests } = await feedFixture(t, rule(['2026']));
  set([{ id: '2026-release', title: '2026 公告', body: '正文只有新的发布日期说明' }]);
  const preview = await a.dispatch('feedConnectionFilterPreview', { filter: rule(['2026']), samples: [{ title: '2026 公告', body: '正文只有新的发布日期说明' }] });
  const run = await sync(); assert.equal(preview.filtered, 1); assert.equal(run.filtered, 1); assert.equal(run.received, 0); assert.equal(run.added, 0);
  assert.equal(a.data.sources.length, 0); assert.equal((a.data.modelCalls || []).length, 0); assert.equal(requests(), 1);
});

test('V18 independent: restrictive new-entry filters still refresh an already-tracked revision and invalidate its old approval', async t => {
  const { a, project, current, set, sync, configure } = await feedFixture(t); set([{ id: 'tracked', body: '预算第一版' }]); await sync();
  const outputFolder=path.join(a.dir,'synthetic-output');fs.mkdirSync(outputFolder);
  const source = a.data.sources[0], job = agent.buildJob(a, { projectId: project.id, goal: '依据公告交付', useOutputFolder:true, fileMode: 'ask' }, {outputFolder}); a.data.delegations.push(job); project.jobId = job.id; job.sourceIds.push(source.id); job.status = 'paused';
  const task = a.createTask({ projectId: project.id, title: '依据公告的成果', sourceIds: [source.id] }); task.agentJobId = job.id; job.taskIds.push(task.id); task.status = 'review'; task.verification = { passed: true };
  const receipt = { id: 'old-approved', taskId: task.id, status: 'pending', approvedAt: '2026-10-01T00:00:00Z' }; a.data.agentActions.push(receipt); job.pendingActionId = receipt.id;
  await configure(rule(['预算'], ['撤销'])); set([{ id: 'tracked', body: '撤销此前安排，改期处理' }, { id: 'untracked', body: '撤销新闻' }]);
  const run = await sync(), latest = a.data.sources[0]; assert.equal(run.added, 1); assert.equal(run.filtered, 1); assert.equal(run.received, 1); assert.equal(latest.version, 2); assert.equal(latest.previousSourceId, source.id);
  assert.equal(a.data.sources.length, 2); assert.ok(task.sourceIds.includes(latest.id)); assert.ok(task.needsReplan); assert.equal(task.verification, null);
  assert.equal(job.status, 'paused'); assert.equal(job.fileMode, 'ask'); assert.equal(receipt.status, 'stale'); assert.equal(receipt.approvedAt, undefined); assert.equal((a.data.modelCalls || []).length, 0); assert.equal(current().imported, 2);
});

test('V18 independent: mixed accepted and filtered RSS entries remain atomic under a legacy unknown receipt', async t => {
  const { a, project, current, set, sync, configure } = await feedFixture(t); set([{ id: 'tracked', body: '原始安排' }]); await sync();
  const source = a.data.sources[0], job = agent.buildJob(a, { projectId: project.id, goal: '需要先核对' }); a.data.delegations.push(job); project.jobId = job.id; job.sourceIds.push(source.id); job.status = 'paused';
  const task = a.createTask({ projectId: project.id, title: '待核对成果', sourceIds: [source.id] }); task.agentJobId = job.id; job.taskIds.push(task.id);
  a.data.agentActions.push({ id: 'legacy-unknown', taskId: task.id, status: 'uncertain' });
  await configure(rule(['允许'])); const before = structuredClone({ sources: a.data.sources, tasks: a.data.tasks, jobs: a.data.delegations, receipts: a.data.agentActions });
  set([{ id: 'tracked', body: '旧条目更新应受未知回执约束' }, { id: 'new-accepted', body: '允许接收' }, { id: 'new-filtered', body: '不相关消息' }]);
  const run = await sync(); assert.equal(run.status, 'error'); assert.match(run.error, /核对/); assert.equal(current().imported, 1);
  assert.deepEqual({ sources: a.data.sources, tasks: a.data.tasks, jobs: a.data.delegations, receipts: a.data.agentActions }, before); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V18 independent: previously filtered IDs can be received later and then remain continuously tracked across restart', async t => {
  const { a, current, set, sync, configure } = await feedFixture(t, rule(['允许'])); set([{ id: 'deferred', body: '新的公开安排' }]);
  assert.equal((await sync()).filtered, 1); assert.equal(a.data.sources.length, 0);
  await configure(rule(['公开'])); assert.equal((await sync()).added, 1); const first = a.data.sources[0];
  await configure(rule([], ['取消'])); set([{ id: 'deferred', body: '取消公开安排' }]); a.save();
  const b = new Assistant({ dir: a.dir, chat: a.chat, feedRequest: a.feedRequest });
  await b.dispatch('feedConnectionSync', { id: current().id }); await b.runPromise;
  assert.equal(b.data.sources.length, 2); assert.equal(b.data.sources[0].version, 2); assert.equal(b.data.sources[0].previousSourceId, first.id); assert.equal(b.data.feedConnectionRuns[0].filtered, 0); assert.equal((b.data.modelCalls || []).length, 0);
});

test('V18 independent: older backups retain the current RSS filter while pausing automatic reads', async t => {
  const { a, current, configure, set, sync, requests } = await feedFixture(t, rule(['旧要求'])); const backup = recovery.create(a, 'old-filter');
  await configure(rule(['新要求'], ['无关'])); await a.dispatch('feedConnectionToggle', { id: current().id, enabled: true });
  await a.dispatch('backupRestore', { id: backup }); assert.deepEqual(current().filter, rule(['新要求'], ['无关'])); assert.equal(current().enabled, false); assert.equal(current().nextRunAt, null);
  a.tick(); assert.equal(requests(), 0); set([{ id: 'old-only', body: '旧要求' }, { id: 'new-only', body: '新要求' }]);
  const run = await sync(); assert.equal(run.added, 1); assert.equal(run.filtered, 1); assert.match(a.data.sources[0].content, /新要求/); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V18 independent: automatic retry after partial organization calls the model only for the unfinished source', async t => {
  const batches = []; const a = await setup(t, async (_p, _k, messages) => {
    const input = JSON.parse(messages[1].content); batches.push(input.sources.map(source => source.id));
    if (batches.length === 2) throw errors.transportError(); return sourceTasks(input);
  });
  await at('2031-10-03T10:00:00Z', async () => {
    await a.dispatch('captureSave', { items: Array.from({ length: 7 }, (_, index) => ({ title: `材料${index}.txt`, base64: Buffer.from(`第${index}份独立要求`).toString('base64') })), organize: true, autoRetry: true }); await a.runPromise;
  });
  const row = a.data.captureQueue[0], sourceIds = [...row.sourceIds], previousTasks = a.data.tasks.map(task => task.id);
  assert.equal(row.status, 'failed'); assert.equal(row.organizedSourceIds.length, 6); assert.equal(a.data.tasks.length, 6); assert.equal(row.autoRetry.nextRetryAt, '2031-10-03T10:01:00.000Z');
  await at('2031-10-03T10:02:00Z', async () => { assert.equal(capture.tick(a), true); await a.runPromise; });
  assert.equal(row.status, 'completed'); assert.equal(row.autoRetry.used, 1); assert.equal(a.data.tasks.length, 7); assert.equal(a.data.sources.length, 7); assert.deepEqual(row.sourceIds, sourceIds);
  assert.deepEqual(batches[2], batches[1]); assert.equal(batches[2].length, 1); assert.ok(previousTasks.every(id => a.data.tasks.some(task => task.id === id))); assert.equal(a.data.modelCalls.length, 3);
});

test('V18 independent: a due retry waits through global pause and resumes one attempt without catch-up bursts', async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; throw errors.transportError(); });
  const manual = agent.buildJob(a, { goal: '用户暂停的委托' }); manual.status = 'paused'; a.data.delegations.push(manual);
  await at('2031-10-03T10:00:00Z', async () => { await a.dispatch('captureEnqueue', { ...material(), autoRetry: true }); await a.runPromise; await a.dispatch('stewardshipPause'); });
  const row = a.data.captureQueue[0], deadline = row.autoRetry.nextRetryAt;
  await at('2031-10-03T12:00:00Z', async () => {
    for (let index = 0; index < 3; index++) assert.equal(capture.tick(a), false);
    assert.equal(calls, 1); assert.equal(row.autoRetry.used, 0); assert.equal(row.autoRetry.nextRetryAt, deadline);
    await a.dispatch('stewardshipResume'); assert.equal(capture.tick(a), true); await a.runPromise;
    assert.equal(capture.tick(a), false); assert.equal(row.autoRetry.nextRetryAt, '2031-10-03T12:05:00.000Z');
  });
  assert.equal(calls, 2); assert.equal(row.autoRetry.used, 1); assert.equal(manual.status, 'paused');
});





test('V18 independent: successful organization with a local save failure cannot automatically replay tasks or model requests', async t => {
  let calls = 0; const a = await setup(t, async (_p, _k, messages) => { if (++calls === 1) throw errors.transportError(); return sourceTasks(JSON.parse(messages[1].content)); });
  await at('2031-10-03T10:00:00Z', async () => { await a.dispatch('captureEnqueue', { ...material(), autoRetry: true }); await a.runPromise; });
  const row = a.data.captureQueue[0], save = a.save.bind(a); let injected = false;
  a.save = () => { if (!injected && a.data.tasks.length === 1) { injected = true; throw new Error('Simulated local task persistence failure'); } return save(); };
  await at('2031-10-03T10:01:00Z', async () => { assert.equal(capture.tick(a), true); await a.runPromise; }); a.save = save;
  assert.equal(injected, true); assert.equal(row.status, 'failed'); assert.equal(row.autoRetry.nextRetryAt, null); assert.equal(row.autoRetry.retryable, false); assert.equal(calls, 2); assert.equal(a.data.tasks.length, 1);
  const taskId = a.data.tasks[0].id, persisted = JSON.parse(fs.readFileSync(a.file, 'utf8')); assert.equal(persisted.tasks[0].id, taskId);
  await at('2031-10-03T11:00:00Z', async () => { assert.equal(capture.tick(a), false); await a.dispatch('captureRetry', { id: row.id }); await a.runPromise; });
  assert.equal(row.status, 'completed'); assert.equal(a.data.tasks.length, 1); assert.equal(a.data.tasks[0].id, taskId); assert.equal(calls, 2);
});

test('V18 independent: an unknown external receipt introduced before automatic retry blocks the whole proposed task batch', async t => {
  let calls = 0, task; const a = await setup(t, async (_p, _k, messages) => {
    if (++calls === 1) throw errors.transportError(); const input = JSON.parse(messages[1].content), sourceIds = input.sources.map(source => source.id);
    return { tasks: [...sourceTasks(input).tasks, { existingTaskId: task.id, title: task.title, sourceIds, description: '后到资料' }] };
  });
  task = a.createTask({ title: '先核对旧执行' }); task.status = 'review'; task.verification = { passed: true };
  await at('2031-10-03T10:00:00Z', async () => { await a.dispatch('captureEnqueue', { ...material(), autoRetry: true }); await a.runPromise; });
  const row = a.data.captureQueue[0], receipt = { id: 'unknown-before-retry', taskId: task.id, status: 'uncertain' }; a.data.agentActions.push(receipt); const before = structuredClone(task);
  await at('2031-10-03T10:01:00Z', async () => { assert.equal(capture.tick(a), true); await a.runPromise; });
  assert.deepEqual(a.task(task.id), before); assert.equal(a.data.tasks.length, 1); assert.equal(receipt.status, 'uncertain'); assert.equal(row.status, 'failed'); assert.equal(row.autoRetry.nextRetryAt, null); assert.equal(row.autoRetry.retryable, false); assert.equal(calls, 2);
  await at('2031-10-03T12:00:00Z', async () => { assert.equal(capture.tick(a), false); }); assert.equal(calls, 2);
});

test('V18 independent: disabling retry persists through restart and cannot be replaced by an older authorized backup', async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; throw errors.transportError(); });
  await at('2031-10-03T10:00:00Z', async () => { await a.dispatch('captureEnqueue', { ...material(), autoRetry: true }); await a.runPromise; });
  const row = a.data.captureQueue[0], backup = recovery.create(a, 'authorized-retry'); await retryPolicy(a, row, false);
  await at('2031-10-03T11:00:00Z', async () => {
    const b = new Assistant({ dir: a.dir, chat: a.chat }); assert.equal(capture.tick(b), false); assert.equal(b.data.captureQueue[0].autoRetry.enabled, false);
    await b.dispatch('backupRestore', { id: backup }); await b.dispatch('stewardshipResume'); assert.equal(capture.tick(b), false);
    assert.equal(b.data.captureQueue[0].autoRetry.enabled, false); assert.equal(b.data.captureQueue[0].autoRetry.nextRetryAt, null); assert.equal(calls, 1);
  });
});

test('V18 independent: cancelling an in-flight automatic retry ignores a late successful model response', async t => {
  let calls = 0, enter, release; const entered = new Promise(resolve => { enter = resolve; }), response = new Promise(resolve => { release = resolve; });
  const a = await setup(t, async (_p, _k, messages) => {
    if (++calls === 1) throw errors.transportError(); const input = JSON.parse(messages[1].content); enter(); await response; return sourceTasks(input);
  });
  await at('2031-10-03T10:00:00Z', async () => { await a.dispatch('captureEnqueue', { ...material(), autoRetry: true }); await a.runPromise; });
  const row = a.data.captureQueue[0];
  await at('2031-10-03T10:01:00Z', async () => {
    assert.equal(capture.tick(a), true); await entered; await a.dispatch('captureCancel', { id: row.id }); release(); await a.runPromise;
  });
  assert.equal(row.status, 'cancelled'); assert.equal(row.autoRetry.enabled, false); assert.equal(row.autoRetry.nextRetryAt, null);
  assert.equal(a.data.tasks.length, 0); assert.equal(a.data.sources[0].state, 'new'); assert.equal(calls, 2); assert.equal(row.autoRetry.used, 1);
  await at('2031-10-03T12:00:00Z', async () => { assert.equal(capture.tick(a), false); }); assert.equal(calls, 2);
});

test('V18 independent: normal automatic organization advances unrelated material while excluding a failed capture batch', async t => {
  const batches = []; const a = await setup(t, async (_p, _k, messages) => {
    const input = JSON.parse(messages[1].content); batches.push(input.sources.map(source => source.id));
    if (batches.length === 1) throw errors.transportError(); return { tasks: [], summary: '普通材料是背景信息' };
  });
  await at('2031-10-03T10:00:00Z', async () => { await a.dispatch('captureEnqueue', { ...material('失败队列材料'), autoRetry: false }); await a.runPromise; });
  const row = a.data.captureQueue[0], heldId = row.sourceIds[0];
  await a.dispatch('import', { items: [{ title: '普通新材料', content: '新收集的背景信息，与待重试队列无关' }] });
  const normal = a.data.sources.find(source => source.id !== heldId);
  await at('2031-10-03T10:10:00Z', async () => { await a.cycle(); });
  assert.deepEqual(batches[1], [normal.id]); assert.equal(batches.length, 2); assert.equal(normal.state, 'processed');
  assert.equal(a.data.sources.find(source => source.id === heldId).state, 'new'); assert.equal(row.status, 'failed'); assert.equal(row.autoRetry.enabled, false); assert.equal(row.autoRetry.used, 0); assert.equal(a.data.tasks.length, 0);
});
