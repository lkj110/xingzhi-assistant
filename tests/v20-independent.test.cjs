const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Assistant } = require('../desktop/core.cjs');
const recovery = require('../desktop/recovery.cjs');
const rules = require('../desktop/work-rules.cjs');
const docs = require('../desktop/documents.cjs');
const pdfOCR = require('../desktop/pdf-ocr.cjs');
const projectSources = require('../desktop/project-rule-sources.cjs');
let pdfDirectory;
function fixturePDF(name) {
  if (!pdfDirectory) {
    pdfDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v20-independent-pdfs-')));
    require('node:child_process').execFileSync('/usr/bin/swift', [path.join(__dirname, '../scripts/pdf-ocr-fixture.swift'), pdfDirectory], { timeout: 120000, stdio: 'pipe' });
  }
  return fs.readFileSync(path.join(pdfDirectory, name));
}
after(() => { if (pdfDirectory) fs.rmSync(pdfDirectory, { recursive: true, force: true }); });
const native = { skip: process.platform !== 'darwin' };
const pdfItem = (name, title = name) => ({ title, base64: fixturePDF(name).toString('base64') });

async function setup(t, chat) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v20-independent-'))), counts = { models: 0, external: 0 };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deny = async () => { counts.external++; throw Error('No external I/O in independent QA'); };
  const a = new Assistant({ dir, chat: async (...args) => { counts.models++; if (chat) return chat(...args); throw Error('Unexpected model invocation'); }, feedRequest: deny, webRequest: deny, agentRequest: deny, connectorRequest: deny });
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' });
  return { a, counts, dir };
}
const input = extra => ({ name: '托管独立审查', goal: '根据项目新资料持续整理报告', text: '起始材料：当前预算 6800。', enabled: true, autoAccept: false, ...extra });
async function request(a, value) { const preview = await a.dispatch('projectSetupPreview', value); return { ...value, revision: preview.revision, requestId: crypto.randomUUID() }; }
async function create(a, value) { return a.dispatch('projectSetupCreate', await request(a, value)); }
async function check(a, ruleId) { await a.dispatch('ruleRun', { id: ruleId }); await a.runPromise; return a.data.ruleRuns[0]; }
const shape = data => Object.fromEntries(['projects', 'sources', 'workRules', 'feedConnections', 'webConnections', 'folders', 'projectSetupReceipts', 'agentActions'].map(key => [key, structuredClone(data[key] || [])]));
function folder(a, id = 'input') { const location = path.join(a.dir, id); fs.mkdirSync(location); a.data.folders.push({ id, name: id, path: fs.realpathSync(location), enabled: false }); a.save(); return location; }

test('V20 independent: wizard preview and create preserve a global pause and perform no collection or model calls', async t => {
  const { a, counts } = await setup(t); const location = folder(a); fs.writeFileSync(path.join(location, 'not-yet-read.md'), '目录尚未收集的内容');
  await a.dispatch('stewardshipPause'); const value = input({ folderIds: ['input'], feedUrls: ['https://fixture.invalid/rss'], pageUrls: ['https://fixture.invalid/page'] }), before = shape(a.data);
  const submission = await request(a, value); assert.deepEqual(shape(a.data), before);
  const saved = await a.dispatch('projectSetupCreate', submission); assert.equal(saved.reused, false); assert.equal(a.data.projects.length, 1); assert.equal(a.data.sources.length, 1);
  const rule = a.data.workRules.find(row => row.id === saved.ruleId); assert.equal(rule.config.trigger, 'project_changes'); assert.equal(rule.config.allowWeb, false); assert.equal(rule.config.autoAccept, false); assert.equal(rule.config.fileMode, 'off');
  assert.equal(a.data.folders[0].projectId, saved.projectId); assert.equal(a.data.sources[0].projectId, saved.projectId); assert.equal(a.data.delegations.length, 0);
  a.tick(); await a.runPromise; assert.equal(a.data.stewardship.paused, true); assert.equal(a.data.delegations.length, 0); assert.deepEqual(counts, { models: 0, external: 0 });
  assert.equal(a.data.sources.some(source => source.content.includes('目录尚未收集')), false);
});

test('V20 independent: concurrent identical wizard submissions create one durable configuration and replay after a real restart', async t => {
  const { a, counts } = await setup(t); const submission = await request(a, input());
  const [one, two] = await Promise.all([a.dispatch('projectSetupCreate', submission), a.dispatch('projectSetupCreate', submission)]);
  assert.equal(one.projectId, two.projectId); assert.equal(one.ruleId, two.ruleId); assert.deepEqual([one.reused, two.reused], [false, true]);
  const b = new Assistant({ dir: a.dir, chat: a.chat, agentRequest: a.agentRequest, feedRequest: a.feedRequest, webRequest: a.webRequest });
  const replay = await b.dispatch('projectSetupCreate', submission); assert.equal(replay.reused, true); assert.equal(replay.projectId, one.projectId);
  assert.equal(b.data.projects.length, 1); assert.equal(b.data.workRules.length, 1); assert.equal(b.data.sources.length, 1); assert.equal(b.data.projectSetupReceipts.length, 1); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: stale wizard preview cannot rebind a directory that acquired another project in the meantime', async t => {
  const { a, counts } = await setup(t); folder(a); const submission = await request(a, input({ folderIds: ['input'] }));
  await a.dispatch('projectSave', { name: '目录当前所属项目' }); const otherId = a.data.projects[0].id;
  await a.dispatch('folderConfigure', { id: 'input', projectId: otherId, enabled: false }); const before = shape(a.data);
  await assert.rejects(a.dispatch('projectSetupCreate', submission), /归属|变化/); assert.deepEqual(shape(a.data), before); assert.equal(a.data.folders[0].projectId, otherId); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: restoring a pre-wizard backup and repeating a request does not resurrect archived projects or revoked subscriptions and folder grants', async t => {
  const { a, counts } = await setup(t); folder(a); const backup = recovery.create(a);
  const submission = await request(a, input({ folderIds: ['input'], feedUrls: ['https://fixture.invalid/rss'], pageUrls: ['https://fixture.invalid/page'] })), saved = await a.dispatch('projectSetupCreate', submission);
  await a.dispatch('feedConnectionDelete', { id: saved.feedIds[0] }); await a.dispatch('webConnectionDelete', { id: saved.pageIds[0] }); await a.dispatch('folderRemove', { id: 'input' });
  const preview = await a.dispatch('projectLifecyclePreview', { id: saved.projectId }); await a.dispatch('projectLifecycleArchive', { id: saved.projectId, revision: preview.revision });
  await a.dispatch('backupRestore', { id: backup }); const before = shape(a.data), replay = await a.dispatch('projectSetupCreate', submission);
  assert.equal(replay.reused, true); assert.equal(replay.projectId, saved.projectId); assert.deepEqual(shape(a.data), before);
  assert.ok(a.data.projects.find(row => row.id === saved.projectId).archivedAt); assert.equal(a.data.feedConnections.length, 0); assert.equal(a.data.webConnections.length, 0); assert.equal(a.data.folders.length, 0);
  a.tick(); assert.equal(a.data.stewardship.paused, true); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: a wizard save that throws after the workspace rename rolls back disk and cannot survive through its automatic backup', async t => {
  const { a, counts } = await setup(t); const submission = await request(a, input({ feedUrls: ['https://fixture.invalid/rss'] })), before = shape(a.data), save = a.save.bind(a);
  // Force backup eligibility, then inject failure after the real workspace save.
  a.lastBackupAt = 0; let injected = false;
  a.save = () => { save(); if (!injected) { injected = true; throw Error('controlled error after save and backup'); } };
  await assert.rejects(a.dispatch('projectSetupCreate', submission), /controlled error/); a.save = save;
  assert.equal(injected, true); assert.deepEqual(shape(a.data), before); assert.deepEqual(shape(JSON.parse(fs.readFileSync(a.file, 'utf8'))), before);
  fs.writeFileSync(a.file, 'controlled workspace corruption after rejected setup');
  const b = new Assistant({ dir: a.dir, chat: a.chat, agentRequest: a.agentRequest, feedRequest: a.feedRequest, webRequest: a.webRequest });
  assert.equal(b.data.projects.length, 0); assert.equal(b.data.workRules.length, 0); assert.equal(b.data.sources.length, 0); assert.equal(b.data.feedConnections.length, 0); assert.equal((b.data.projectSetupReceipts || []).length, 0);
  const retried = await create(b, input({ enabled: false, feedUrls: ['https://fixture.invalid/rss'] })); assert.equal(retried.reused, false); assert.equal(b.data.projects.length, 1); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: a mixed PDF enters a wizard project with its true page evidence and reaches its existing-material rule exactly once', native, async t => {
  const { a, counts } = await setup(t), saved = await create(a, input({ text: '' }));
  const item = pdfItem('mixed.pdf', '项目预算.pdf');
  await a.dispatch('importDocuments', { projectId: saved.projectId, items: [item] }); const source = a.data.sources[0];
  assert.equal(source.projectId, saved.projectId); assert.equal(source.format, 'pdf'); assert.deepEqual([...new Set(source.segments.map(s => s.page))], [1, 2, 4]);
  assert.equal(source.segments[0].localOCR, undefined); assert.match(source.segments[0].text, /Native text page 1/);
  assert.ok(source.segments.filter(s => s.page !== 1).every(s => s.localOCR && s.boundingBox.orientation === 'display'));
  assert.ok(source.warnings.some(w => w.startsWith('第 3 页') && w.includes('仍无文字')));
  const excerpts = await a.dispatch('readSource', { id: source.id, query: '7200' }); assert.deepEqual(excerpts.segments.map(s => s.page), [2, 4]);
  await a.dispatch('captureEnqueue', { projectId: saved.projectId, items: [item], organize: true, autoRetry: true }); await a.runPromise;
  const row = a.data.captureQueue[0]; assert.equal(row.status, 'completed'); assert.deepEqual(row.sourceIds, []); assert.equal(a.data.sources.length, 1);
  const rule = a.data.workRules.find(r => r.id === saved.ruleId); assert.equal(projectSources.scan(a, rule.config)[0].sourceId, source.id);
  const run = await check(a, saved.ruleId); assert.equal(run.status, 'created', run.error); assert.deepEqual(a.data.delegations[0].sourceIds, [source.id]); assert.equal(a.data.sources.length, 1);
  assert.equal(fs.existsSync(path.join(a.dir, 'capture-payloads', `${row.id}.json`)), false);
  assert.equal(fs.readdirSync(a.dir, { recursive: true }).some(name => /\.(pdf|png|jpeg)$/i.test(name)), false); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: mixed PDF plus encrypted PDF rejects the whole queued batch and does not retry or leak its first text page', native, async t => {
  const { a, counts } = await setup(t), saved = await create(a, input({ text: '' }));
  await a.dispatch('captureEnqueue', { projectId: saved.projectId, items: [pdfItem('mixed.pdf'), pdfItem('encrypted.pdf')], organize: true, autoRetry: true }); await a.runPromise;
  const row = a.data.captureQueue[0]; assert.equal(row.status, 'failed'); assert.equal(row.autoRetry.retryable, false); assert.equal(row.autoRetry.nextRetryAt, null);
  assert.deepEqual(row.sourceIds, []); assert.equal(a.data.sources.length, 0); assert.equal(a.data.tasks.length, 0); assert.equal(a.data.delegations.length, 0);
  assert.match(row.lastError, /加密/); assert.equal((await check(a, saved.ruleId)).status, 'unchanged'); assert.equal(a.data.delegations.length, 0);
  const payload = path.join(a.dir, 'capture-payloads', `${row.id}.json`); assert.equal(fs.existsSync(payload), true);
  await a.dispatch('captureCancel', { id: row.id }); assert.equal(fs.existsSync(payload), false); assert.equal(row.status, 'cancelled');
  assert.equal(fs.readdirSync(a.dir, { recursive: true }).some(name => /\.(pdf|png|jpeg)$/i.test(name)), false); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: cancelling while OCR is pending discards a late result and the already-read text page and earlier file', native, async t => {
  const { a, counts } = await setup(t), saved = await create(a, input({ text: '' })); let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(pdfOCR, 'recognize', async (_buffer, { pages }) => { entered(); return new Promise(resolve => { finish = () => resolve(pages.map(page => ({ page, width: 100, height: 50, lines: [{ text: '迟到识别文字', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } }] }))); }); });
  await a.dispatch('captureEnqueue', { projectId: saved.projectId, items: [pdfItem('text.pdf'), pdfItem('mixed.pdf')], organize: true, autoRetry: true });
  await started; const row = a.data.captureQueue[0]; await a.dispatch('captureCancel', { id: row.id }); finish(); await a.runPromise;
  assert.equal(row.status, 'cancelled'); assert.equal(row.autoRetry.enabled, false); assert.equal(row.autoRetry.nextRetryAt, null); assert.equal(a.data.sources.length, 0); assert.equal(a.data.tasks.length, 0);
  assert.equal(a.operation, null); assert.equal(fs.existsSync(path.join(a.dir, 'capture-payloads', `${row.id}.json`)), false); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: PDF OCR failure cannot admit its extracted text as a partial material through direct import', native, async t => {
  const { a, counts } = await setup(t), saved = await create(a, input({ text: '' })); const before = shape(a.data);
  t.mock.method(pdfOCR, 'recognize', async () => { throw pdfOCR.failure('PDF_OCR_FAILED'); });
  await assert.rejects(a.dispatch('importDocuments', { projectId: saved.projectId, items: [pdfItem('text.pdf'), pdfItem('mixed.pdf')] }), { code: 'PDF_OCR_FAILED' });
  assert.deepEqual(shape(a.data), before); assert.equal(a.operation, null); assert.equal(a.controller, null); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: successful PDF recognition does not change a wizard job while a task-only external receipt is uncertain', native, async t => {
  const { a, counts } = await setup(t), saved = await create(a, input()); await check(a, saved.ruleId); const job = a.data.delegations[0];
  const task = a.createTask({ projectId: saved.projectId, title: '外部结果待核对', sourceIds: [...job.sourceIds] }); task.agentJobId = job.id; job.taskIds.push(task.id); job.status = 'paused';
  const receipt = { id: 'v20-unknown', taskId: task.id, status: 'uncertain', tool: 'write_file', content: '尚未核对的交付' }; a.data.agentActions.push(receipt);
  const before = structuredClone({ job, task, receipt, sources: a.data.sources });
  await a.dispatch('captureEnqueue', { projectId: saved.projectId, items: [pdfItem('mixed.pdf')], organize: true, autoRetry: true }); await a.runPromise;
  const row = a.data.captureQueue[0]; assert.equal(row.status, 'failed'); assert.match(row.lastError, /核对/); assert.equal(row.autoRetry.nextRetryAt, null);
  assert.deepEqual({ job, task, receipt, sources: a.data.sources }, before); assert.equal(row.sourceIds.length, 0); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: new PDF version invalidates a pending approval while preserving manual pause and original version history', native, async t => {
  const { a, counts } = await setup(t), saved = await create(a, input({ text: '' }));
  await a.dispatch('importDocuments', { projectId: saved.projectId, items: [pdfItem('text.pdf', '预算.pdf')] }); const original = a.data.sources[0];
  await check(a, saved.ruleId); const job = a.data.delegations[0];
  const task = a.createTask({ projectId: saved.projectId, title: '按预算完成报告', sourceIds: [original.id] }); task.agentJobId = job.id; job.taskIds.push(task.id);
  const receipt = { id: 'v20-pending', jobId: job.id, taskId: task.id, status: 'pending', approvedAt: '2026-10-01T00:00:00.000Z', tool: 'write_file', content: '旧版报告' }; a.data.agentActions.push(receipt); job.pendingActionId = receipt.id;
  await a.dispatch('agentPause', { id: job.id });
  await a.dispatch('importDocuments', { projectId: saved.projectId, items: [pdfItem('mixed.pdf', '预算.pdf')] }); const current = a.data.sources[0];
  assert.equal(current.previousSourceId, original.id); assert.equal(current.version, 2); assert.equal(original.previousSourceId, undefined); assert.equal(receipt.status, 'stale'); assert.equal(receipt.approvedAt, undefined); assert.equal(job.status, 'paused');
  const rule = a.data.workRules.find(r => r.id === saved.ruleId); assert.equal(projectSources.scan(a, rule.config)[0].sourceId, current.id);
  await check(a, saved.ruleId); assert.equal(job.status, 'paused'); assert.equal(a.data.delegations.length, 1); assert.equal(a.data.sources.length, 2); assert.equal(original.previousSourceId, undefined); assert.deepEqual(counts, { models: 0, external: 0 });
});

test('V20 independent: persisted wizard input and rule provenance stay current while restore removes automatic write permission', async t => {
  const { a, counts } = await setup(t); const output = path.join(a.dir, 'out'); fs.mkdirSync(output); a.data.agentSettings.outputFolder = fs.realpathSync(output); a.save();
  const before = recovery.create(a), submission = await request(a, input({ useOutputFolder: true, fileMode: 'auto' })), saved = await a.dispatch('projectSetupCreate', submission);
  await check(a, saved.ruleId); const jobId = a.data.projects.find(row => row.id === saved.projectId).jobId;
  await a.dispatch('backupRestore', { id: before }); const replay = await a.dispatch('projectSetupCreate', submission), rule = a.data.workRules.find(row => row.id === saved.ruleId), job = a.data.delegations.find(row => row.id === jobId);
  assert.equal(replay.reused, true); assert.equal(rule.config.fileMode, 'ask'); assert.equal(job.fileMode, 'ask'); assert.equal(rule.status, 'paused'); assert.equal(job.status, 'paused');
  assert.equal(a.data.projects.length, 1); assert.equal(a.data.workRules.length, 1); assert.equal(a.data.sources.length, 1); assert.equal(a.data.projectSetupReceipts.length, 1); assert.deepEqual(fs.readdirSync(output), []); assert.deepEqual(counts, { models: 0, external: 0 });
});
