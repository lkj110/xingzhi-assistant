const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Assistant } = require('../desktop/core.cjs');
const rules = require('../desktop/work-rules.cjs');
const recovery = require('../desktop/recovery.cjs');
const documents = require('../desktop/documents.cjs');
const imageOCR = require('../desktop/image-ocr.cjs');
const projectSources = require('../desktop/project-rule-sources.cjs');
const agent = require('../desktop/agent.cjs');
let imageDirectory;
function fixtureImage(name) {
  if (!imageDirectory) {
    imageDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v19-independent-images-')));
    require('node:child_process').execFileSync('/usr/bin/swift', [path.join(__dirname, '../scripts/image-ocr-fixture.swift'), imageDirectory], { timeout: 60000, stdio: 'pipe' });
  }
  return fs.readFileSync(path.join(imageDirectory, name));
}
after(() => { if (imageDirectory) fs.rmSync(imageDirectory, { recursive: true, force: true }); });

async function setup(t, chat = async () => { throw new Error('No model invocation expected in this independent test'); }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v19-independent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deny = async () => { throw new Error('Independent QA forbids external services'); };
  const a = new Assistant({ dir, chat, agentRequest: deny, connectorRequest: deny, feedRequest: deny, webRequest: deny });
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' });
  return a;
}
const config = extra => ({ name: '独立审查规则', goal: '按已授权资料整理说明', allowWeb: false, fileMode: 'off', githubMode: 'off', enabled: true, ...extra });
async function check(a, rule) { await a.dispatch('ruleRun', { id: rule.id }); await a.runPromise; return a.data.ruleRuns[0]; }

test('V19 independent: restoring an old backup cannot restore a revoked rule input folder or read its material after rule resume', async t => {
  const a = await setup(t);
  for (const id of ['revoked', 'current']) {
    const folder = path.join(a.dir, id); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'input.md'), `${id} material`);
    a.data.folders.push({ id, name: id, path: fs.realpathSync(folder) });
  }
  await a.dispatch('ruleSave', config({ folderIds: ['revoked'] })); const old = a.data.workRules[0], id = old.id;
  const backup = recovery.create(a);
  await a.dispatch('ruleSave', { ...old.config, id, folderIds: ['current'], enabled: true });
  await a.dispatch('backupRestore', { id: backup });
  const restored = a.data.workRules.find(rule => rule.id === id);
  await a.dispatch('ruleResume', { id }); await check(a, restored);
  assert.equal(a.data.sources.some(source => source.content.includes('revoked material')), false);
  assert.deepEqual(restored.config.folderIds, ['current']);
  assert.equal(a.data.sources.length, 1); assert.match(a.data.sources[0].content, /current material/);
  assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: a rule archived after a backup remains archived and cannot regain scheduling through restore', async t => {
  const a = await setup(t);
  await a.dispatch('ruleSave', config({ trigger: 'daily' })); const id = a.data.workRules[0].id;
  const backup = recovery.create(a); await a.dispatch('ruleArchive', { id });
  await a.dispatch('backupRestore', { id: backup });
  assert.equal(a.data.workRules.find(rule => rule.id === id).status, 'archived');
  await assert.rejects(a.dispatch('ruleResume', { id }), /无需恢复|归档/);
  assert.equal(a.data.delegations.length, 0); assert.equal((a.data.modelCalls || []).length, 0);
});



test('V19 independent: a project and rule created after a backup remain linked after restore and resume the same delegation', async t => {
  let calls = 0; const a = await setup(t, async () => { calls++; return { tool: 'ask', args: { question: '请确认继续处理的细节' } }; });
  const backup = recovery.create(a);
  await a.dispatch('projectSave', { name: '备份之后的新项目' }); const projectId = a.data.projects[0].id;
  a.addSources([{ projectId, title: '新项目资料', content: '保留后续创建的项目资料' }]);
  await a.dispatch('ruleSave', config({ projectId, trigger: 'daily' })); const ruleId = a.data.workRules[0].id;
  await check(a, a.data.workRules[0]); const jobId = a.data.projects[0].jobId, sourceIds = [...a.data.delegations[0].sourceIds];
  await a.dispatch('backupRestore', { id: backup });
  const project = a.data.projects.find(row => row.id === projectId), rule = a.data.workRules.find(row => row.id === ruleId), job = a.data.delegations.find(row => row.id === jobId);
  assert.ok(project && rule && job); assert.equal(project.jobId, jobId); assert.equal(rule.activeJobId, jobId); assert.equal(job.ruleId, ruleId);
  assert.equal(rule.status, 'paused'); assert.equal(job.status, 'paused'); assert.deepEqual(job.sourceIds, sourceIds); assert.equal(calls, 0);
  await a.dispatch('ruleResume', { id: ruleId }); await a.dispatch('agentResume', { id: jobId });
  assert.equal(job.status, 'ready'); await a.dispatch('agentRun', { id: jobId }); await a.runPromise;
  assert.equal(a.data.delegations.length, 1); assert.equal(job.status, 'needs_input'); assert.equal(calls, 1);
});

test('V19 independent: restoring an earlier plan retains the current rule goal, revision and narrowed call budgets on its canonical job', async t => {
  const a = await setup(t);
  await a.dispatch('projectSave', { name: '目标调整项目' }); const project = a.data.projects[0];
  await a.dispatch('ruleSave', config({ projectId: project.id, trigger: 'daily', dailyCalls: 50, maxCalls: 80 })); const rule = a.data.workRules[0];
  await check(a, rule); const jobId = project.jobId, backup = recovery.create(a);
  await a.dispatch('ruleSave', { ...rule.config, id: rule.id, goal: '当前新目标：仅整理新版本', maxCalls: 12, maxActions: 2, dailyCalls: 5, dailyStarts: 1, enabled: true });
  const revision = rule.revision;
  await a.dispatch('backupRestore', { id: backup });
  const restored = a.data.workRules.find(row => row.id === rule.id), job = a.data.delegations.find(row => row.id === jobId);
  assert.equal(restored.revision, revision); assert.equal(job.ruleRevision, revision); assert.equal(job.ruleId, restored.id);
  assert.equal(restored.config.goal, '当前新目标：仅整理新版本'); assert.equal(job.goal, restored.config.goal); assert.equal(job.title, restored.config.goal);
  assert.equal(job.maxCalls, undefined); assert.equal(job.maxActions, 2); assert.equal(restored.config.dailyCalls, undefined); assert.equal(restored.config.dailyStarts, 1);
  assert.equal(restored.status, 'paused'); assert.equal(job.status, 'paused'); assert.equal(restored.nextRunAt, null);
});

test('V19 independent: restoring an auto-write rule requires fresh write approval and preserves the current acceptance choice', async t => {
  const a = await setup(t); const output = path.join(a.dir, 'delivery'); fs.mkdirSync(output); a.data.agentSettings.outputFolder = fs.realpathSync(output);
  await a.dispatch('projectSave', { name: '写入授权项目' }); const project = a.data.projects[0];
  await a.dispatch('ruleSave', config({ projectId: project.id, trigger: 'daily', useOutputFolder: true, fileMode: 'auto', autoAccept: false })); const rule = a.data.workRules[0];
  await check(a, rule); const jobId = project.jobId, backup = recovery.create(a);
  await a.dispatch('ruleSave', { ...rule.config, id: rule.id, goal: '在当前范围继续交付', enabled: true });
  await a.dispatch('backupRestore', { id: backup });
  const restored = a.data.workRules.find(row => row.id === rule.id), job = a.data.delegations.find(row => row.id === jobId);
  assert.equal(restored.config.fileMode, 'ask'); assert.equal(job.fileMode, 'ask');
  assert.equal(restored.config.autoAccept, false); assert.equal(job.autoAccept, false);
  assert.equal(restored.status, 'paused'); assert.equal(job.status, 'paused'); assert.deepEqual(fs.readdirSync(output), []); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: native OCR has the same source evidence through direct and queued imports without duplicate material or model calls', { skip: process.platform !== 'darwin' }, async t => {
  const a = await setup(t); await a.dispatch('projectSave', { name: '图片来源一致性' }); const projectId = a.data.projects[0].id;
  const item = { title: '会议.png', base64: fixtureImage('synthetic.png').toString('base64') };
  await a.dispatch('importDocuments', { projectId, items: [item] }); const source = a.data.sources[0];
  assert.match(source.content, /Budget 7200/); assert.equal(source.format, 'png'); assert.equal(source.projectId, projectId);
  assert.ok(source.warnings.some(value => /错漏/.test(value))); assert.ok(source.segments.every(segment => segment.localOCR && segment.page === 1 && segment.boundingBox.coordinateSystem === 'normalized-top-left'));
  const excerpt = await a.dispatch('readSource', { id: source.id, query: 'Budget' });
  assert.equal(excerpt.totalMatches, 1); assert.match(excerpt.segments[0].text, /7200/); assert.equal(excerpt.segments[0].localOCR, true);
  await a.dispatch('captureEnqueue', { projectId, items: [item], organize: true, autoRetry: true }); await a.runPromise;
  const row = a.data.captureQueue[0]; assert.equal(row.status, 'completed'); assert.equal(row.sourceIds.length, 0); assert.equal(a.data.sources.length, 1);
  assert.equal(a.data.sources[0].id, source.id); assert.equal((a.data.modelCalls || []).length, 0);
  assert.equal(fs.existsSync(path.join(a.dir, 'capture-payloads', `${row.id}.json`)), false);
  assert.equal(JSON.stringify(a.publicState()).includes(item.base64.slice(0, 200)), false);
  assert.equal(fs.readdirSync(a.dir, { recursive: true }).some(name => /\.(png|jpeg|jpg)$/i.test(name)), false);
});

test('V19 independent: a valid OCR image followed by a broken image leaves no partial sources and cancellation clears the held payload', { skip: process.platform !== 'darwin' }, async t => {
  const a = await setup(t);
  await a.dispatch('captureEnqueue', { items: [{ title: 'valid.png', base64: fixtureImage('synthetic.png').toString('base64') }, { title: 'broken.jpeg', base64: Buffer.from([255, 216, 255, 0]).toString('base64') }], organize: true, autoRetry: true }); await a.runPromise;
  const row = a.data.captureQueue[0]; assert.equal(row.status, 'failed'); assert.equal(row.autoRetry.retryable, false); assert.equal(row.autoRetry.nextRetryAt, null);
  assert.equal(a.data.sources.length, 0); assert.equal(a.data.tasks.length, 0); assert.equal(a.data.artifacts.length, 0); assert.equal((a.data.modelCalls || []).length, 0);
  const payload = path.join(a.dir, 'capture-payloads', `${row.id}.json`); assert.equal(fs.existsSync(payload), true);
  await a.dispatch('captureCancel', { id: row.id }); assert.equal(row.status, 'cancelled'); assert.equal(fs.existsSync(payload), false);
  assert.equal(fs.readdirSync(a.dir, { recursive: true }).some(name => /\.(png|jpeg|jpg)$/i.test(name)), false);
});

test('V19 independent: cancellation after one image was recognized rejects a late second result and commits none of the batch', async t => {
  const a = await setup(t); let entered, finish, calls = 0;
  const started = new Promise(resolve => { entered = resolve; }), original = imageOCR.recognize;
  const result = { format: 'png', width: 100, height: 50, scaled: false, lines: [{ text: '受控图片识别结果', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } }] };
  imageOCR.recognize = async () => { calls++; if (calls === 1) return result; entered(); return new Promise(resolve => { finish = resolve; }); };
  t.after(() => { imageOCR.recognize = original; });
  await a.dispatch('captureEnqueue', { items: [{ title: 'first.png', base64: Buffer.from('fixture-first').toString('base64') }, { title: 'second.png', base64: Buffer.from('fixture-second').toString('base64') }], organize: true, autoRetry: true });
  await started; const row = a.data.captureQueue[0]; await a.dispatch('captureCancel', { id: row.id }); finish(result); await a.runPromise;
  assert.equal(calls, 2); assert.equal(row.status, 'cancelled'); assert.equal(row.autoRetry.enabled, false); assert.equal(row.autoRetry.nextRetryAt, null);
  assert.equal(a.data.sources.length, 0); assert.equal(a.data.tasks.length, 0); assert.equal((a.data.modelCalls || []).length, 0);
  assert.equal(fs.existsSync(path.join(a.dir, 'capture-payloads', `${row.id}.json`)), false); assert.equal(a.operation, null);
});

test('V19 independent: successful native OCR cannot alter a project while its independent legacy action has an unknown result', { skip: process.platform !== 'darwin' }, async t => {
  const a = await setup(t); await a.dispatch('projectSave', { name: '图片与未知回执' }); const project = a.data.projects[0];
  const job = require('../desktop/agent.cjs').buildJob(a, { projectId: project.id, goal: '保护旧计划', allowWeb: false, fileMode: 'off' }); a.data.delegations.push(job); project.jobId = job.id;
  const task = a.createTask({ projectId: project.id, title: '待核对事项' }); task.agentJobId = job.id; job.taskIds.push(task.id); job.status = 'paused';
  const receipt = { id: 'v19-image-unknown', taskId: task.id, status: 'uncertain', tool: 'write_file', content: '待核对的旧交付' }; a.data.agentActions.push(receipt);
  const before = structuredClone({ job, task, receipt });
  await a.dispatch('captureEnqueue', { projectId: project.id, items: [{ title: '补充.png', base64: fixtureImage('synthetic.png').toString('base64') }], organize: true, autoRetry: true }); await a.runPromise;
  const row = a.data.captureQueue[0]; assert.equal(row.status, 'failed'); assert.equal(row.autoRetry.nextRetryAt, null); assert.equal(a.data.sources.length, 0);
  assert.deepEqual({ job, task, receipt }, before); assert.equal((a.data.modelCalls || []).length, 0);
});

async function projectRule(a, extra = {}) {
  await a.dispatch('projectSave', { name: '项目资料规则独立验证' }); const project = a.data.projects[0];
  await a.dispatch('ruleSave', config({ projectId: project.id, trigger: 'project_changes', ...extra }));
  return { project, rule: a.data.workRules[0] };
}

test('V19 independent: RSS revisions reach an existing-material rule as one current record without rereading the feed or copying sources', async t => {
  const a = await setup(t), { project, rule } = await projectRule(a); let budget = 6800, requests = 0;
  a.feedRequest = async url => { requests++; return { status: 200, url, headers: { 'content-type': 'application/rss+xml' }, body: `<rss version="2.0"><channel><item><guid>budget</guid><title>项目公告</title><description>预算 ${budget} 元</description></item></channel></rss>` }; };
  await a.dispatch('feedConnectionSave', { name: '规则跨模块 RSS', projectId: project.id, url: 'https://fixture.invalid/rss', enabled: false, intervalMinutes: 15 }); const feedId = a.data.feedConnections[0].id;
  for (budget of [6800, 7200]) { await a.dispatch('feedConnectionSync', { id: feedId }); await a.runPromise; }
  assert.equal(a.data.sources.length, 2); const current = a.data.sources[0], old = a.data.sources[1];
  const preview = projectSources.scan(a, rule.config); assert.equal(preview.length, 1); assert.equal(preview[0].sourceId, current.id);
  await check(a, rule); const job = a.data.delegations.find(row => row.id === project.jobId);
  assert.equal(a.data.ruleRuns[0].status, 'created'); assert.equal(a.data.sources.length, 2); assert.deepEqual(job.sourceIds, [current.id]); assert.equal(job.watchers.length, 0); assert.equal(requests, 2);
  assert.equal(projectSources.scan(a, rule.config)[0].key.endsWith(old.id), true); assert.equal((a.data.modelCalls || []).length, 0);
  assert.equal((await check(a, rule)).status, 'unchanged'); assert.equal(requests, 2); assert.equal(a.data.delegations.length, 1);
  const before = structuredClone([old, current]); budget = 7600;
  await a.dispatch('feedConnectionSync', { id: feedId }); await a.runPromise;
  assert.equal(a.data.sources.length, 3); const next = a.data.sources[0]; assert.equal(next.previousSourceId, current.id);
  assert.equal(old.previousSourceId, before[0].previousSourceId); assert.equal(old.version, before[0].version); assert.equal(current.previousSourceId, old.id);
  const run = await check(a, rule); assert.equal(run.status, 'merged', run.error); assert.equal(projectSources.scan(a, rule.config)[0].sourceId, next.id); assert.equal(requests, 3);
});

for (const status of ['pending', 'uncertain']) test(`V19 independent: ${status} task-only receipts prevent a project rule from creating a delegation or checkpointing already-imported sources`, async t => {
  const a = await setup(t), { project, rule } = await projectRule(a);
  a.addSources([{ projectId: project.id, title: '项目新材料', content: '触发前先核对旧任务的外部记录。' }]); const source = a.data.sources[0];
  const task = a.createTask({ projectId: project.id, title: '独立旧事项', sourceIds: [source.id] }); task.status = 'paused';
  const receipt = { id: `v19-rule-${status}`, taskId: task.id, status, approvedAt: '2026-10-01T00:00:00.000Z', tool: 'write_file', content: '原审批或未知交付' }; a.data.agentActions.push(receipt);
  const before = structuredClone({ source, task, receipt }); const run = await check(a, rule);
  assert.equal(run.status, 'queued'); assert.equal(a.data.delegations.length, 0); assert.equal(project.jobId, null); assert.equal(rule.usage.starts, 0);
  assert.deepEqual(rule.fingerprints, {}); assert.equal(rule.pending.length, 1); assert.deepEqual({ source, task, receipt }, before); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: folder withdrawal is a removed trigger and cannot restore an earlier version as current project material', async t => {
  const a = await setup(t), { project, rule } = await projectRule(a), folders = require('../desktop/folders.cjs');
  const folder = path.join(a.dir, 'inputs'); fs.mkdirSync(folder); a.data.folders.push({ id: 'local-input', name: '授权输入', path: fs.realpathSync(folder), projectId: project.id, enabled: true });
  const file = path.join(folder, '计划.md'); fs.writeFileSync(file, '第一版'); await folders.syncAllFolders(a); fs.writeFileSync(file, '第二版'); await folders.syncAllFolders(a);
  await check(a, rule); const job = a.data.delegations.find(row => row.id === project.jobId), current = a.data.sources[0];
  const planned = await agent.act(a, job, 'plan_task', { key: 'version', title: '依据最新材料整理', criteria: '保持来源有效', sourceIds: [current.id], steps: [{ key: 'draft', title: '整理', kind: 'draft' }] });
  const task = a.task(planned.taskId); task.status = 'review'; task.verification = { passed: true }; task.steps[0].done = true; job.status = 'completed';
  fs.unlinkSync(file); await folders.syncAllFolders(a); const run = await check(a, rule);
  assert.equal(run.status, 'merged', run.error); assert.deepEqual(run.changes.map(row => row.change), ['removed']); assert.equal(projectSources.current(a, rule.config).length, 0);
  assert.equal(a.data.sources.length, 3); assert.equal(a.data.sources[0].deleted, true); assert.equal(task.verification, null); assert.ok(task.needsReplan); assert.equal(task.steps[0].done, false);
  assert.equal(a.data.delegations.length, 1); assert.equal(job.id, project.jobId); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: an explicitly attached latest revision starts a separate target-project family without exposing its previous project history', async t => {
  const a = await setup(t); await a.dispatch('projectSave', { name: '原始项目' }); const original = a.data.projects[0];
  for (const content of ['不应进入目标项目的历史版本', '明确选择附加的当前版本']) a.addSources([{ projectId: original.id, title: '资料', content }]);
  const originalCurrent = a.data.sources[0], { project, rule } = await projectRule(a);
  await a.dispatch('projectAttach', { id: project.id, sourceIds: [originalCurrent.id] }); const copied = a.data.sources.find(row => row.projectId === project.id);
  assert.equal(copied.copiedFrom, originalCurrent.id); const scan = projectSources.scan(a, rule.config);
  assert.equal(scan.length, 1); assert.equal(scan[0].sourceId, copied.id); assert.equal(scan[0].key.endsWith(copied.id), true);
  assert.equal(JSON.stringify(scan).includes('不应进入目标项目的历史版本'), false); await check(a, rule);
  const job = a.data.delegations.find(row => row.id === project.jobId); assert.deepEqual(job.sourceIds, [copied.id]); assert.equal(projectSources.current(a, { projectId: original.id }).length, 1);
  assert.equal(a.data.sources.length, 3); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: unmatched new material does not freeze unfinished work or restart completed work, while a later match reuses the same job', async t => {
  const a = await setup(t), { project, rule } = await projectRule(a, { keyword: '里程碑' });
  a.addSources([{ projectId: project.id, title: '里程碑一', content: '准备交付说明' }]); await check(a, rule); const job = a.data.delegations.find(row => row.id === project.jobId);
  job.status = 'watching'; a.addSources([{ projectId: project.id, title: '一般背景一', content: '不触发新的一轮工作' }]);
  assert.equal(rules.canRun(a, job), true); assert.equal((await check(a, rule)).status, 'unchanged');
  job.status = 'completed'; a.addSources([{ projectId: project.id, title: '一般背景二', content: '完成后也不额外触发' }]);
  assert.equal(rules.canRun(a, job), false); assert.equal((await check(a, rule)).status, 'unchanged'); assert.equal(rules.canRun(a, job), false);
  a.addSources([{ projectId: project.id, title: '里程碑二', content: '现在继续处理已有工作' }]); assert.equal((await check(a, rule)).status, 'merged');
  assert.equal(rules.canRun(a, job), true); assert.equal(a.data.delegations.length, 1); assert.equal(job.sourceIds.length, 4); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: native OCR from the quick window can trigger project work after a baseline without duplicating or silently extracting it', { skip: process.platform !== 'darwin' }, async t => {
  const a = await setup(t), { project, rule } = await projectRule(a, { includeExisting: false });
  a.addSources([{ projectId: project.id, title: '既有背景', content: '记录基线时不创建委托。' }]); assert.equal((await check(a, rule)).status, 'baseline');
  const quick = require('../desktop/quick-capture.cjs').createController({ assistant: a, BrowserWindow: function () { throw Error('No native window'); }, globalShortcut: { isRegistered: () => false, register: () => false, unregister() {} }, preload: __filename, indexFile: __filename }); t.after(() => quick.dispose());
  const request = { requestId: require('node:crypto').randomUUID(), projectId: project.id, organize: true, autoRetry: true, items: [{ title: '新会议.jpeg', base64: fixtureImage('synthetic.jpeg').toString('base64') }] };
  const saved = await quick.submit(request); await a.runPromise; const receipt = a.data.captureQueue.find(row => row.id === saved.receipt.id);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.sourceIds.length, 1); assert.equal(a.data.delegations.length, 0); assert.equal((a.data.modelCalls || []).length, 0);
  const repeated = await quick.submit(request); assert.equal(repeated.reused, true); assert.equal(repeated.receipt.id, receipt.id);
  assert.equal((await check(a, rule)).status, 'created'); const job = a.data.delegations.find(row => row.id === project.jobId), image = a.data.sources.find(row => row.id === receipt.sourceIds[0]);
  assert.ok(job.sourceIds.includes(image.id)); assert.equal(job.sourceIds.length, 2); assert.equal(a.data.sources.length, 2); assert.equal(a.data.tasks.length, 0); assert.equal(job.watchers.length, 0);
  assert.equal(image.format, 'jpeg'); assert.match(image.content, /Budget 7200/); assert.ok(image.segments.every(segment => segment.localOCR)); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: receipt resolution, manual resume and budget edits remain possible before project checking without advancing work or bypassing a paused rule', async t => {
  const a = await setup(t), { project, rule } = await projectRule(a);
  a.addSources([{ projectId: project.id, title: '原资料', content: '等待后续资料' }]); await check(a, rule); const job = a.data.delegations.find(row => row.id === project.jobId);
  const task = a.createTask({ projectId: project.id, title: '关联事项', sourceIds: [...job.sourceIds] }); task.agentJobId = job.id; job.taskIds.push(task.id);
  await a.dispatch('agentPause', { id: job.id }); a.addSources([{ projectId: project.id, title: '新材料', content: '需要规则重新检查' }]);
  const receipt = { id: 'v19-control-unknown', taskId: task.id, status: 'uncertain', tool: 'write_file', content: '待人工核对' }; a.data.agentActions.push(receipt); job.pendingActionId = receipt.id;
  assert.equal((await check(a, rule)).status, 'queued'); assert.equal(rules.canRun(a, job), false);
  await a.dispatch('agentResolve', { id: job.id, actionId: receipt.id, confirmedNotApplied: true });
  assert.equal(receipt.status, 'failed'); assert.equal(job.status, 'paused'); assert.equal(job.pendingActionId, null); assert.equal((a.data.modelCalls || []).length, 0);
  await a.dispatch('agentResume', { id: job.id }); await assert.rejects(a.dispatch('agentBudget', { id: job.id, maxCalls: 60 }), /取消调用次数/); assert.equal(job.maxCalls, undefined); assert.equal(job.status, 'ready');
  await assert.rejects(a.dispatch('agentRun', { id: job.id }), /项目资料.*检查/); assert.equal(a.operation, null); assert.equal((a.data.modelCalls || []).length, 0);
  assert.equal((await check(a, rule)).status, 'merged'); assert.equal(rules.canRun(a, job), true); assert.equal(a.data.tasks.length, 1);
  await a.dispatch('rulePause', { id: rule.id });
  for (const action of ['agentResume', 'agentBudget', 'agentResolve']) await assert.rejects(a.dispatch(action, { id: job.id, maxCalls: 80, actionId: receipt.id, confirmedNotApplied: true }), /规则.*暂停|规则.*变更/);
  assert.equal(job.status, 'paused'); assert.equal((a.data.modelCalls || []).length, 0);
});

test('V19 independent: restoring a project-source rule and resuming the rule does not revoke an earlier explicit job pause', async t => {
  const a = await setup(t), { project, rule } = await projectRule(a);
  a.addSources([{ projectId: project.id, title: '暂停前资料', content: '保持用户暂停意图' }]); await check(a, rule); const jobId = project.jobId;
  await a.dispatch('agentPause', { id: jobId }); const backup = recovery.create(a);
  await a.dispatch('backupRestore', { id: backup }); const restored = a.data.workRules.find(row => row.id === rule.id), job = a.data.delegations.find(row => row.id === jobId);
  assert.equal(job.status, 'paused'); await a.dispatch('ruleResume', { id: restored.id });
  assert.equal(job.status, 'paused'); assert.equal((await check(a, restored)).status, 'unchanged'); assert.equal(rules.canRun(a, job), false); assert.equal((a.data.modelCalls || []).length, 0);
  await a.dispatch('agentResume', { id: jobId }); assert.equal((await check(a, restored)).status, 'merged'); assert.equal(rules.canRun(a, job), true);
});

test('V19 independent: an agent-read matching source does not trigger its own rule, but a user-attached copy can trigger another project', async t => {
  const a = await setup(t), { project, rule } = await projectRule(a, { keyword: '预算', allowWeb: true });
  a.addSources([{ projectId: project.id, title: '预算输入', content: '预算要求待核对' }]); await check(a, rule); const job = a.data.delegations.find(row => row.id === project.jobId); let reads = 0;
  a.agentRequest = async url => { reads++; return { status: 200, url, headers: { 'content-type': 'text/html' }, body: '<title>预算来源</title><p>预算是 7200。</p>' }; };
  const result = await agent.act(a, job, 'read_url', { url: 'https://fixture.invalid/agent-read' }), derived = a.data.sources.find(source => source.id === result.sourceId);
  assert.equal(derived.agentJobId, job.id); job.status = 'completed'; const count = a.data.sources.length;
  assert.equal((await check(a, rule)).status, 'unchanged'); assert.equal(job.status, 'completed'); assert.equal(a.data.sources.length, count); assert.equal(projectSources.scan(a, rule.config).length, 1); assert.equal(reads, 1);
  const target = await projectRule(a, { keyword: '预算' }); await a.dispatch('projectAttach', { id: target.project.id, sourceIds: [derived.id] });
  const copy = a.data.sources.find(source => source.projectId === target.project.id); assert.equal(copy.copiedFrom, derived.id);
  assert.equal((await check(a, target.rule)).status, 'created'); const targetJob = a.data.delegations.find(row => row.id === target.project.jobId);
  assert.deepEqual(targetJob.sourceIds, [copy.id]); assert.equal(a.data.delegations.length, 2); assert.equal(reads, 1); assert.equal((a.data.modelCalls || []).length, 0);
});
