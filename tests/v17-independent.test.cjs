const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Assistant } = require('../desktop/core.cjs');
const agent = require('../desktop/agent.cjs');
const runtime = require('../desktop/runtime.cjs');
const stewardship = require('../desktop/stewardship.cjs');
const recovery = require('../desktop/recovery.cjs');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const quick = require('../desktop/quick-capture.cjs');

async function at(time, fn) {
  const previous = Date.now; Date.now = () => Date.parse(time);
  try { return await fn(); } finally { Date.now = previous; }
}
const timedPause = (a, until) => a.dispatch('stewardshipPause', { until, revision: stewardship.status(a).revision });
const request = a => a.callModel(a.data.providers[0], '', [{ role: 'user', content: '独立测试正文' }], { role: 'execute', stage: 'task_work' });

async function setup(t, chat = async () => ({ tool: 'ask', args: { question: '请补充资料' } })) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v17-independent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deny = async () => { throw new Error('Independent tests forbid real service calls'); };
  const a = new Assistant({ dir, chat, agentRequest: deny, connectorRequest: deny, webRequest: deny, feedRequest: deny });
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: 'independent fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' });
  return a;
}

async function interrupted(t) {
  let enter, finish, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; }), response = new Promise(resolve => { finish = resolve; });
  const a = await setup(t, async () => { calls++; enter(); await response; return { tool: 'ask', args: { question: '等待补充' } }; });
  await a.dispatch('agentCreate', { goal: '休眠后保留手动暂停', allowWeb: false });
  await entered; const job = a.data.delegations[0]; runtime.suspend(a);
  await a.dispatch('agentPause', { id: job.id }); finish(); await a.runPromise;
  assert.equal(job.status, 'paused'); assert.equal(calls, 1);
  await a.dispatch('stewardshipPause');
  return { a, job, calls: () => calls };
}

test('V17 independent: explicit job pause after a sleep interruption survives power resume', async t => {
  const { a, job, calls } = await interrupted(t);
  await runtime.resume(a);
  assert.equal(job.status, 'paused'); assert.equal(a.operation, null); assert.equal(calls(), 1);
});

test('V17 independent: explicit job pause after a sleep interruption survives application restart', async t => {
  const { a, job } = await interrupted(t);
  const b = new Assistant({ dir: a.dir, chat: a.chat });
  assert.equal(b.data.delegations.find(row => row.id === job.id).status, 'paused'); assert.equal(b.operation, null);
});

for (const mode of ['resume', 'restart']) test(`V17 independent: legacy task-only unknown receipt remains paused after ${mode}`, async t => {
  const a = await setup(t), job = agent.buildJob(a, { goal: '先核对外部动作' });
  a.data.delegations.push(job);
  const task = a.createTask({ title: '含待核对交付的事项' }); task.agentJobId = job.id; job.taskIds.push(task.id);
  const receipt = { id: 'legacy-unknown', taskId: task.id, status: 'uncertain', tool: 'write_file' }; a.data.agentActions.push(receipt);
  job.status = 'running'; a.activeAgentJob = job; runtime.suspend(a); job.status = 'paused'; a.activeAgentJob = null;
  await a.dispatch('stewardshipPause');
  if (mode === 'resume') {
    await runtime.resume(a); assert.equal(job.status, 'paused'); assert.equal(receipt.status, 'uncertain');
  } else {
    const b = new Assistant({ dir: a.dir, chat: a.chat });
    assert.equal(b.data.delegations.find(row => row.id === job.id).status, 'paused');
    assert.equal(b.data.agentActions.find(row => row.id === receipt.id).status, 'uncertain');
  }
});

test('V17 independent: timed resume crosses the budget midnight while retaining Friday overnight ownership', async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; return { ok: true }; }); a.data.stewardship.timeZone = 'UTC';
  await at('2026-10-02T23:50:00Z', async () => {
    await a.dispatch('stewardshipSettings', { weekdays: [5], dailyCallLimit: 1, window: { enabled: true, start: '22:00', end: '06:00' } });
    await request(a); await timedPause(a, '2026-10-03T00:30:00Z');
    assert.equal(stewardship.status(a).nextAllowedAt, '2026-10-03T00:30:00.000Z');
  });
  await at('2026-10-03T00:30:00Z', async () => {
    a.tick(); const status = stewardship.status(a);
    assert.equal(status.automaticAllowed, true); assert.equal(status.windowWeekday, 5); assert.equal(status.used, 0); assert.equal(status.pauseUntil, null);
    await request(a); await request(a);
    assert.equal(stewardship.status(a).nextAllowedAt, null);
  });
  assert.equal(calls, 3); assert.equal(a.data.stewardship.usage.days['2026-10-02'], 1); assert.equal(a.data.stewardship.usage.days['2026-10-03'], 2);
});

test('V17 independent: elapsed global pause on an off day cannot start a ready delegation', async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; return { tool: 'ask', args: { question: '不应调用' } }; }); a.data.stewardship.timeZone = 'UTC';
  const job = agent.buildJob(a, { goal: '仅周一工作' }); job.nextRunAt = '2026-10-03T00:00:00Z'; a.data.delegations.push(job);
  await at('2026-10-03T11:00:00Z', async () => { await a.dispatch('stewardshipSettings', { weekdays: [1] }); await timedPause(a, '2026-10-03T12:00:00Z'); });
  await at('2026-10-03T12:00:00Z', async () => {
    a.tick(); assert.equal(a.data.stewardship.paused, false); assert.equal(stewardship.status(a).reason, 'offday');
    assert.equal(stewardship.status(a).nextAllowedAt, '2026-10-05T00:00:00.000Z'); assert.equal(job.status, 'ready'); assert.equal(a.operation, null); assert.equal(calls, 0);
  });
});

test('V17 independent: timed global resume preserves manual tasks and jobs, pending approval, and unknown external receipts', async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; return { ok: true }; }); a.data.stewardship.timeZone = 'UTC';
  const manual = agent.buildJob(a, { goal: '手动暂停的委托' }), approval = agent.buildJob(a, { goal: '逐项审批的委托', fileMode: 'ask' });
  manual.status = 'paused'; approval.status = 'approval'; a.data.delegations.push(manual, approval);
  const task = a.createTask({ title: '手动暂停的事项' }); task.status = 'paused'; task.stewardshipDeferredUntil = '2026-10-02T00:00:00Z';
  a.data.agentActions.push({ id: 'unknown', jobId: manual.id, status: 'uncertain' }, { id: 'approval', jobId: approval.id, status: 'pending' }); approval.pendingActionId = 'approval';
  const before = structuredClone({ tasks: a.data.tasks, jobs: a.data.delegations, actions: a.data.agentActions });
  await at('2026-10-02T10:00:00Z', async () => { await timedPause(a, '2026-10-02T11:00:00Z'); });
  await at('2026-10-02T11:00:00Z', async () => { a.tick(); assert.equal(stewardship.status(a).automaticAllowed, true); });
  assert.deepEqual({ tasks: a.data.tasks, jobs: a.data.delegations, actions: a.data.agentActions }, before); assert.equal(calls, 0); assert.equal(a.operation, null);
});

test('V17 independent: restoring an older backup cancels both saved and currently authorized timed resume', async t => {
  const a = await setup(t); a.data.stewardship.timeZone = 'UTC';
  await at('2031-10-03T10:00:00Z', async () => {
    await timedPause(a, '2031-10-03T11:00:00Z'); const backup = recovery.create(a, 'independent-timed-snapshot');
    await timedPause(a, '2031-10-03T12:00:00Z');
    await a.dispatch('backupRestore', { id: backup }); assert.equal(a.data.stewardship.paused, true); assert.equal(a.data.stewardship.pauseUntil, null);
  });
  await at('2031-10-03T13:00:00Z', async () => {
    const b = new Assistant({ dir: a.dir, chat: a.chat }); b.tick();
    assert.equal(stewardship.status(b).reason, 'paused'); assert.equal(b.data.stewardship.pauseUntil, null); assert.equal(b.operation, null);
  });
});

test('V17 independent: damaged-workspace recovery cannot revive a timer from either backup or authoritative ledger', async t => {
  const a = await setup(t); a.data.stewardship.timeZone = 'UTC';
  await at('2031-10-03T10:00:00Z', async () => { await timedPause(a, '2031-10-03T11:00:00Z'); recovery.create(a, 'independent-corruption'); });
  fs.writeFileSync(a.file, 'CORRUPTED_WORKSPACE');
  await at('2031-10-03T12:00:00Z', async () => {
    const b = new Assistant({ dir: a.dir, chat: a.chat }); b.tick();
    assert.equal(stewardship.status(b).reason, 'paused'); assert.equal(b.data.stewardship.pauseUntil, null); assert.equal(b.operation, null);
  });
});

test('V17 independent: spring DST gap uses an actual valid instant after timed resume', async t => {
  const a = await setup(t); a.data.stewardship.timeZone = 'America/New_York';
  await at('2026-03-08T06:00:00Z', async () => {
    await a.dispatch('stewardshipSettings', { weekdays: [0], window: { enabled: true, start: '02:30', end: '04:00' } });
    await timedPause(a, '2026-03-08T06:45:00Z'); assert.equal(stewardship.status(a).nextAllowedAt, '2026-03-08T07:00:00.000Z');
  });
  await at('2026-03-08T06:45:00Z', async () => { a.tick(); assert.equal(stewardship.status(a).reason, 'window'); assert.equal(a.operation, null); });
  await at('2026-03-08T07:00:00Z', async () => { a.tick(); assert.equal(stewardship.status(a).automaticAllowed, true); });
});

test('V17 independent: repeated DST hour does not replenish the budget after timed resume', async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; return { ok: true }; }); a.data.stewardship.timeZone = 'America/New_York';
  await at('2026-11-01T05:30:00Z', async () => {
    await a.dispatch('stewardshipSettings', { weekdays: [0], dailyCallLimit: 1, window: { enabled: true, start: '01:30', end: '02:30' } });
    await request(a); await timedPause(a, '2026-11-01T05:45:00Z');
  });
  for (const instant of ['2026-11-01T05:45:00Z', '2026-11-01T06:45:00Z']) await at(instant, async () => {
    a.tick(); assert.equal(stewardship.status(a).reason, null); assert.equal(stewardship.status(a).used, calls);
    await request(a);
    assert.equal(stewardship.status(a).nextAllowedAt, null);
  });
  assert.equal(calls, 3);
});

function desktopFixture(t, a) {
  let binding = null, shown = 0;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
      this.webContents.session = { setPermissionRequestHandler: fn => { this.requestPermission = fn; }, setPermissionCheckHandler: fn => { this.checkPermission = fn; } };
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; return Promise.resolve(); }
  }
  const shortcuts = { isRegistered: () => !!binding, register: (_key, callback) => { binding = callback; return true; }, unregister: () => { binding = null; } };
  const indexFile = path.join(a.dir, 'fixture-index.html'), controller = quick.createController({ assistant: a, BrowserWindow: FakeWindow, globalShortcut: shortcuts, preload: path.join(a.dir, 'fixture-preload.cjs'), indexFile, showMain: () => { shown++; } });
  t.after(() => controller.dispose()); controller.open();
  const win = controller.window(), event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return { controller, win, event, indexFile, shown: () => shown, registered: () => !!binding };
}
const submission = title => ({ requestId: crypto.randomUUID(), textItems: [{ title, content: `${title}正文` }] });

test('V17 independent: distinct simultaneous quick captures each return their own durable receipt', async t => {
  const a = await setup(t); a.operation = { label: '正在推进其他事项' };
  const { controller, event } = desktopFixture(t, a), left = submission('第一份'), right = submission('第二份');
  const results = await Promise.allSettled([controller.dispatchSmall(event, 'quickCaptureSubmit', left), controller.dispatchSmall(event, 'quickCaptureSubmit', right)]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.notEqual(results[0].value.receipt.id, results[1].value.receipt.id); assert.equal(a.data.captureQueue.length, 2);
  assert.deepEqual(a.data.captureQueue.map(row => row.itemTitles[0]), ['第一份', '第二份']);
  for (const row of a.data.captureQueue) { assert.equal(row.status, 'queued'); assert.equal(fs.existsSync(path.join(a.dir, 'capture-payloads', `${row.id}.json`)), true); }
  const b = new Assistant({ dir: a.dir, chat: a.chat }); assert.equal(b.data.captureQueue.length, 2); assert.ok(b.data.captureQueue.every(row => row.status === 'queued'));
});

test('V17 independent: a duplicated quick request enqueues once and cannot change its material', async t => {
  const a = await setup(t); a.operation = { label: '已有工作' }; const { controller, event } = desktopFixture(t, a), input = submission('同一份材料');
  const [first, second] = await Promise.all([controller.dispatchSmall(event, 'quickCaptureSubmit', input), controller.dispatchSmall(event, 'quickCaptureSubmit', structuredClone(input))]);
  assert.equal(first.receipt.id, second.receipt.id); assert.equal(a.data.captureQueue.length, 1);
  await assert.rejects(controller.dispatchSmall(event, 'quickCaptureSubmit', { ...input, textItems: [{ title: '改过材料', content: '不得冒用旧请求' }] }), /变化/);
  assert.equal(a.data.captureQueue.length, 1);
});

test('V17 independent: quick-window IPC rejects foreign frames, navigation, and unrestricted workspace actions', async t => {
  const a = await setup(t); a.data.settings.profile = 'PRIVATE_PROFILE'; a.data.agentSettings.githubToken = 'PRIVATE_TOKEN';
  const { controller, win, event } = desktopFixture(t, a);
  for (const action of ['state', 'export', 'agentCreate', 'backupRestore', 'quickCaptureConfigure', 'readSource']) await assert.rejects(controller.dispatchSmall(event, action, {}), /无权/);
  await assert.rejects(controller.dispatchSmall({ ...event, senderFrame: { url: event.senderFrame.url } }, 'quickCaptureState'), /来源/);
  await assert.rejects(controller.dispatchSmall({ ...event, sender: {} }, 'quickCaptureState'), /来源/);
  const original = event.senderFrame.url; event.senderFrame.url = 'https://untrusted.invalid/';
  await assert.rejects(controller.dispatchSmall(event, 'quickCaptureState'), /来源/); event.senderFrame.url = original;
  const snapshot = JSON.stringify(await controller.dispatchSmall(event, 'quickCaptureState'));
  assert.equal(snapshot.includes('PRIVATE_PROFILE'), false); assert.equal(snapshot.includes('PRIVATE_TOKEN'), false); assert.equal(snapshot.includes('sealedKey'), false);
  assert.equal(win.options.webPreferences.nodeIntegration, false); assert.equal(win.options.webPreferences.sandbox, true); assert.equal(win.options.webPreferences.contextIsolation, true);
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) { let prevented = false; win.webContents.emit(name, { preventDefault: () => { prevented = true; } }); assert.equal(prevented, true); }
  assert.deepEqual(win.openHandler(), { action: 'deny' }); assert.equal(win.checkPermission(), false);
  let permission; win.requestPermission(null, 'clipboard-read', value => { permission = value; }); assert.equal(permission, false);
});

test('V17 independent: quick capture cannot inspect an unrelated capture receipt', async t => {
  const a = await setup(t); a.operation = { label: '已有工作' }; const { controller, event } = desktopFixture(t, a);
  await a.dispatch('captureEnqueue', { textItems: [{ title: '主窗口私有收集', content: '私有正文' }] });
  const unrelated = a.data.captureQueue[0];
  await assert.rejects(controller.dispatchSmall(event, 'quickCaptureState', { receiptId: unrelated.id }), /不属于/);
  const state = await controller.dispatchSmall(event, 'quickCaptureState'); assert.equal(state.receipt, null); assert.equal(JSON.stringify(state).includes('私有正文'), false);
});

test('V17 independent: a saved quick submission retains its identity if starting queue processing fails to save', async t => {
  const a = await setup(t), { controller, event } = desktopFixture(t, a), input = submission('已保存后处理失败');
  const originalSave = a.save.bind(a); let saves = 0;
  a.save = () => { if (++saves === 2) throw new Error('Simulated failure persisting the queue start'); return originalSave(); };
  await Promise.allSettled([controller.dispatchSmall(event, 'quickCaptureSubmit', input)]);
  assert.equal(a.data.captureQueue.length, 1); const savedId = a.data.captureQueue[0].id; assert.equal(a.data.captureQueue[0].status, 'queued');
  const persisted = JSON.parse(fs.readFileSync(a.file, 'utf8')); assert.equal(persisted.captureQueue[0].id, savedId);
  a.save = originalSave; a.operation = { label: '避免与测试重试并发处理' };
  const retry = await controller.dispatchSmall(event, 'quickCaptureSubmit', input);
  assert.equal(retry.receipt.id, savedId); assert.equal(a.data.captureQueue.length, 1);
  a.operation = null; a.tick(); await a.runPromise;
  assert.equal(a.data.captureQueue[0].id, savedId); assert.equal(a.data.captureQueue[0].status, 'completed'); assert.equal(a.data.sources.length, 1);
});

for (const status of ['uncertain', 'pending']) test(`V17 independent: queued quick materials respect legacy ${status} project receipts`, async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; return { ok: true }; });
  await a.dispatch('projectSave', { name: '保留审批边界的项目' }); const project = a.data.projects[0];
  const job = agent.buildJob(a, { projectId: project.id, goal: '已有交付' }); a.data.delegations.push(job); project.jobId = job.id;
  const task = a.createTask({ title: '原计划', projectId: project.id }); task.agentJobId = job.id; job.taskIds.push(task.id); job.status = status === 'pending' ? 'approval' : 'paused';
  const receipt = { id: `legacy-${status}`, taskId: task.id, status, approvedAt: '2026-10-01T00:00:00Z', tool: 'write_file' }; a.data.agentActions.push(receipt); job.pendingActionId = receipt.id;
  const before = structuredClone({ task, receipt, sourceIds: job.sourceIds });
  a.operation = { label: '其他事项正在处理' }; const { controller, event } = desktopFixture(t, a), input = { ...submission('新增需求'), projectId: project.id };
  const submitted = await controller.dispatchSmall(event, 'quickCaptureSubmit', input); a.operation = null; a.tick(); await a.runPromise;
  const row = a.data.captureQueue.find(value => value.id === submitted.receipt.id);
  if (status === 'uncertain') {
    assert.equal(row.status, 'failed'); assert.equal(a.data.sources.length, 0);
    assert.deepEqual({ task, receipt, sourceIds: job.sourceIds }, before); assert.equal(fs.existsSync(path.join(a.dir, 'capture-payloads', `${row.id}.json`)), true);
  } else {
    assert.equal(row.status, 'completed'); assert.equal(a.data.sources.length, 1); assert.equal(receipt.status, 'stale'); assert.equal(receipt.approvedAt, undefined); assert.equal(job.pendingActionId, null);
  }
  assert.equal(calls, 0); assert.equal(a.data.agentActions.length, 1); assert.equal(a.data.artifacts.length, 0);
});

for (const enabled of [false, true]) test(`V17 independent: backup restore retains the current quick-shortcut ${enabled ? 'enabled' : 'disabled'} preference`, async t => {
  const a = await setup(t), { controller, registered } = desktopFixture(t, a);
  controller.configure({ enabled: !enabled }); const backup = recovery.create(a, 'quick-setting-snapshot'); controller.configure({ enabled });
  await a.dispatch('backupRestore', { id: backup }); controller.reconcile();
  assert.equal(controller.status().enabled, enabled); assert.equal(registered(), enabled); assert.equal(a.data.runtime.quickCapture.enabled, enabled);
  const b = new Assistant({ dir: a.dir, chat: a.chat }); assert.equal(b.data.runtime.quickCapture.enabled, enabled);
});

test('V17 independent: automatic damaged-workspace recovery never registers an old shortcut authorization', async t => {
  const a = await setup(t), { controller } = desktopFixture(t, a); controller.configure({ enabled: true });
  recovery.create(a, 'enabled-shortcut-before-corruption'); controller.dispose(); fs.writeFileSync(a.file, 'CORRUPTED_WORKSPACE');
  const b = new Assistant({ dir: a.dir, chat: a.chat }), restored = desktopFixture(t, b); restored.controller.reconcile();
  assert.equal(b.data.runtime.quickCapture.enabled, false); assert.equal(restored.registered(), false); assert.equal(restored.controller.status().registered, false);
});

test('V17 independent: stopping all work revokes scheduled resume durably across restart', async t => {
  const a = await setup(t);
  await at('2031-10-03T10:00:00Z', async () => { await timedPause(a, '2031-10-03T11:00:00Z'); a.stop(); assert.equal(a.data.stewardship.pauseUntil, null); });
  await at('2031-10-03T12:00:00Z', async () => {
    const b = new Assistant({ dir: a.dir, chat: a.chat }); b.tick();
    assert.equal(stewardship.status(b).reason, 'paused'); assert.equal(b.data.stewardship.pauseUntil, null); assert.equal(b.operation, null);
  });
});
