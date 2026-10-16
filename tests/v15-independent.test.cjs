const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Assistant } = require('../desktop/core.cjs');
const agent = require('../desktop/agent.cjs');
const decisions = require('../desktop/decisions.cjs');
const acceptance = require('../desktop/acceptance.cjs');
const lifecycle = require('../desktop/project-lifecycle.cjs');
const bundle = require('../desktop/delivery-bundle.cjs');
const rules = require('../desktop/work-rules.cjs');
const folders = require('../desktop/folders.cjs');

async function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-v15-independent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const forbidden = async () => { throw new Error('Independent audit forbids real model or network calls'); };
  const a = new Assistant({ dir, chat: forbidden, agentRequest: forbidden, connectorRequest: forbidden, webRequest: forbidden, feedRequest: forbidden });
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0, name: 'fixture', model: 'fixture', baseUrl: 'https://example.invalid/v1' });
  await a.dispatch('projectSave', { name: '审查项目', background: '原始范围' });
  const project = a.data.projects[0];
  const job = agent.buildJob(a, { projectId: project.id, goal: '整理并交付项目成果', fileMode: 'off', githubMode: 'off' });
  a.data.delegations.push(job); project.jobId = job.id;
  const planned = await agent.act(a, job, 'plan_task', { key: 'report', title: '项目成果', criteria: '依据当前资料完成', steps: [{ key: 'draft', title: '写成果', kind: 'draft' }] });
  return { a, project, job, task: a.task(planned.taskId) };
}

for (const relation of ['job', 'task']) test(`V15 independent: project feedback cannot rewrite work with an uncertain ${relation}-linked receipt`, async t => {
  const { a, project, job, task } = await setup(t);
  a.data.agentActions.push({ id: 'uncertain-receipt', ...(relation === 'job' ? { jobId: job.id } : { taskId: task.id }), status: 'uncertain', tool: 'write_file' });
  job.pendingActionId = null;
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('projectFeedback', { id: project.id, note: '改为另一套交付要求' }), /外部|核对/);
  assert.deepEqual(a.data, before);
});

test('V15 independent: project undo keeps newer unresolved writes and current work intact', async t => {
  const { a, project, job } = await setup(t);
  await a.dispatch('projectFeedback', { id: project.id, note: '增加交付范围' });
  const change = a.data.projectChanges[0];
  a.data.agentActions.push({ id: 'late-write', jobId: job.id, status: 'uncertain', tool: 'write_file' });
  job.pendingActionId = null;
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('projectUndo', { id: project.id, changeId: change.id }), /外部|核对/);
  assert.deepEqual(a.data, before);
});

test('V15 independent: project changes invalidate every old approval even after its pending pointer is lost', async t => {
  const { a, project, job, task } = await setup(t);
  a.data.agentActions.push({ id: 'pending-job', jobId: job.id, status: 'pending', approvedAt: new Date().toISOString() }, { id: 'pending-task', taskId: task.id, status: 'pending', approvedAt: new Date().toISOString() });
  job.pendingActionId = null;
  await a.dispatch('projectFeedback', { id: project.id, note: '新要求使旧交付内容失效' });
  assert.ok(a.data.agentActions.every(action => action.status === 'stale' && !action.approvedAt));
});

test('V15 independent: manual material import preflights task-only uncertain receipts before adding any source', async t => {
  const { a, project, task } = await setup(t);
  a.data.agentActions.push({ id: 'legacy-task-write', taskId: task.id, status: 'uncertain', tool: 'write_file' });
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('import', { items: [{ projectId: project.id, title: '新资料', content: '新的交付要求' }] }), /外部|核对/);
  assert.deepEqual(a.data, before);
});

test('V15 independent: editing a task cannot replace work beneath its legacy unresolved write', async t => {
  const { a, task } = await setup(t);
  a.data.agentActions.push({ id: 'legacy-task-write', taskId: task.id, status: 'uncertain', tool: 'write_file' });
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('updateTask', { id: task.id, title: '替换后的目标' }), /外部|核对/);
  assert.deepEqual(a.data, before);
});

for (const deadlineAt of ['2030-02-30T12:00:00Z', '2030-04-01T12:00:00']) test(`V15 independent: extending a timeout rejects invalid or timezone-free deadline ${deadlineAt}`, async t => {
  const { a, job, task } = await setup(t);
  const followup = { key: 'waiting', status: 'waiting', expected: '对方确认', taskId: task.id, sourceIds: [], deadlineAt: '2020-01-01T00:00:00Z' };
  job.followups.push(followup); decisions.timeout(a, job, followup);
  const card = a.publicState().decisionCards.find(row => row.kind === 'timeout');
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('decisionTimeout', { id: card.id, revision: card.revision, choice: 'extend', deadlineAt }), /时间|期限|时区/);
  assert.deepEqual(a.data, before);
});

test('V15 independent: answering a decision checks unresolved task-only receipts before changing the answer', async t => {
  const { a, job, task } = await setup(t);
  decisions.ask(a, job, { question: '选择哪种交付方式？', taskIds: [task.id] });
  a.data.agentActions.push({ id: 'legacy-task-write', taskId: task.id, status: 'uncertain', tool: 'write_file' });
  const card = a.publicState().decisionCards.find(row => row.kind === 'question');
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('decisionAnswer', { id: card.id, revision: card.revision, answer: '改用另一种方式' }), /外部|核对/);
  assert.deepEqual(a.data, before);
});

function completed(a, task) {
  const artifact = { id: `artifact-${task.id}`, taskId: task.id, stepId: task.steps[0].id, title: '当前成果', content: '项目当前成果正文。', createdAt: new Date().toISOString() };
  a.data.artifacts.push(artifact); task.steps[0].done = true; task.steps[0].artifactId = artifact.id;
  task.status = 'completed'; task.verification = { passed: true, summary: '成果符合要求', gaps: [], basis: acceptance.basis(a, task) };
  return artifact;
}

test('V15 independent: archiving an unchanged accepted result must not downgrade it to draft through permission revocation', async t => {
  const { a, project, job, task } = await setup(t);
  job.fileMode = 'auto'; completed(a, task); job.status = 'completed';
  assert.equal(bundle.snapshot(a, { projectId: project.id }).counts.accepted, 1);
  const preview = lifecycle.preview(a, { id: project.id });
  lifecycle.dispatch(a, 'projectLifecycleArchive', { id: project.id, revision: preview.revision });
  assert.equal(job.fileMode, 'ask');
  assert.equal(bundle.snapshot(a, { projectId: project.id }).counts.accepted, 1, 'archived output remains accepted when only automatic authorization was revoked');
});

test('V15 independent: editing an existing project rule preflights all unresolved writes before revision or state changes', async t => {
  const { a, project, job } = await setup(t);
  // Build the rule through its actual save/check flow so grant compatibility and
  // the canonical project delegation are exactly as a real saved rule produces.
  a.data.delegations = []; a.data.tasks = []; project.jobId = null;
  const config = { name: '每日整理', projectId: project.id, goal: '完成原要求', trigger: 'daily', fileMode: 'off', githubMode: 'off', enabled: true };
  await a.dispatch('ruleSave', config);
  const rule = a.data.workRules[0]; await rules.check(a, rule);
  const active = a.data.delegations[0]; assert.ok(active); assert.notEqual(active.id, job.id);
  a.data.agentActions.push({ id: 'unknown-rule-write', jobId: active.id, status: 'uncertain', tool: 'write_file' });
  active.pendingActionId = null;
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('ruleSave', { ...config, id: rule.id, goal: '替换后的要求' }), /外部|核对/);
  assert.deepEqual(a.data, before);
});

test('V15 independent: a scheduled rule cannot merge new material under an orphan uncertain write', async t => {
  const { a, project } = await setup(t);
  a.data.delegations = []; a.data.tasks = []; project.jobId = null;
  const folder = path.join(a.dir, 'inputs'); fs.mkdirSync(folder); const file = path.join(folder, 'source.md'); fs.writeFileSync(file, '原始资料');
  a.data.folders.push({ id: 'audit-folder', name: '资料目录', path: folder });
  await a.dispatch('ruleSave', { name: '自动跟进', projectId: project.id, goal: '更新计划', folderIds: ['audit-folder'], fileMode: 'off', githubMode: 'off', enabled: true });
  const rule = a.data.workRules[0]; await rules.check(a, rule); const active = a.data.delegations[0];
  a.data.agentActions.push({ id: 'orphan-scheduled-write', jobId: active.id, status: 'uncertain', tool: 'write_file' }); active.pendingActionId = null;
  const sourceIds = [...active.sourceIds], fingerprints = structuredClone(rule.fingerprints);
  fs.writeFileSync(file, '来源发生了改变'); await rules.check(a, rule);
  assert.deepEqual(active.sourceIds, sourceIds); assert.deepEqual(rule.fingerprints, fingerprints);
  assert.equal(a.data.agentActions[0].status, 'uncertain');
  assert.ok(['queued', 'error'].includes(a.data.ruleRuns[0].status));
});

test('V15 independent: delegation feedback checks legacy task-only unknown results before touching the plan', async t => {
  const { a, job, task } = await setup(t);
  a.data.agentActions.push({ id: 'legacy-agent-write', taskId: task.id, status: 'uncertain', tool: 'write_file' });
  const before = structuredClone(a.data);
  await assert.rejects(a.dispatch('agentFeedback', { id: job.id, note: '更换执行内容' }), /外部|核对/);
  assert.deepEqual(a.data, before);
});

test('V15 independent: a delegation with a legacy task-only uncertain write cannot spend model calls on a new plan', async t => {
  const { a, job, task } = await setup(t);
  a.data.agentActions.push({ id: 'legacy-before-run', taskId: task.id, status: 'uncertain', tool: 'write_file' });
  let calls = 0; a.chat = async () => { calls++; return { tool: 'ask', args: { question: '继续执行前还缺什么？' } }; };
  await a.dispatch('agentRun', { id: job.id }); await a.runPromise;
  assert.equal(calls, 0, 'an old unresolved write must be reconciled before any new planning call');
  assert.equal(a.data.agentActions[0].status, 'uncertain');
});

for (const relation of ['task-only', 'pending-pointer']) test(`V15 independent: folder sync preflights ${relation} uncertain receipts before version and manifest changes`, async t => {
  const { a, project, job, task } = await setup(t);
  const directory = path.join(a.dir, 'materials'); fs.mkdirSync(directory);
  const file = path.join(directory, 'plan.md'); fs.writeFileSync(file, '交付预算 6800');
  const folder = { id: 'folder', name: '资料', path: directory, projectId: project.id, enabled: true }; a.data.folders.push(folder);
  await folders.syncAllFolders(a, { id: folder.id }); const original = a.data.sources[0]; task.sourceIds = [original.id];
  a.data.agentActions.push({ id: 'folder-unknown', ...(relation === 'task-only' ? { taskId: task.id } : {}), status: 'uncertain', tool: 'write_file' });
  job.pendingActionId = relation === 'pending-pointer' ? 'folder-unknown' : null;
  const sources = structuredClone(a.data.sources), beforeTask = structuredClone(task), manifest = structuredClone(folder.manifest), sourceIds = [...job.sourceIds];
  fs.writeFileSync(file, '交付预算变为 8800'); await folders.syncAllFolders(a, { id: folder.id });
  assert.equal(folder.health, 'error'); assert.match(folder.error, /外部|核对/);
  assert.deepEqual(a.data.sources, sources); assert.deepEqual(folder.manifest, manifest); assert.deepEqual(task, beforeTask); assert.deepEqual(job.sourceIds, sourceIds);
});
