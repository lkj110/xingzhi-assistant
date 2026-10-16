const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {Assistant} = require('../desktop/core.cjs');
const setup = require('../desktop/project-setup.cjs');
const feeds = require('../desktop/feeds.cjs');
const projects = require('../desktop/projects.cjs');
const rules = require('../desktop/work-rules.cjs');
const recovery = require('../desktop/recovery.cjs');

async function fixture(t, {models = false} = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-setup-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const counts = {model: 0, network: 0};
  const deny = async () => { counts.network++; throw Error('No external request allowed'); };
  const a = new Assistant({dir, chat: async () => { counts.model++; throw Error('No model allowed'); }, feedRequest: deny, webRequest: deny, agentRequest: deny, connectorRequest: deny});
  if (models) await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,name: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1'});
  const input = {name: '市场资料', goal: '根据资料更新工作计划', background: '仅使用可信来源', text: '预算6800，10月20日前完成。'};
  const preview = patch => setup.dispatch(a, 'projectSetupPreview', {...input, ...patch});
  const create = async (patch = {}, requestId = crypto.randomUUID()) => {
    const data = {...input, ...patch};
    const p = await setup.dispatch(a, 'projectSetupPreview', data);
    return setup.dispatch(a, 'projectSetupCreate', {...data, requestId, revision: p.revision});
  };
  const folder = name => {
    const location = path.join(dir, name); fs.mkdirSync(location);
    const row = {id: crypto.randomUUID(), name, path: fs.realpathSync(location), projectId: null, enabled: false};
    a.data.folders.push(row); return row;
  };
  return {a, dir, counts, input, preview, create, folder};
}

test('preview is read-only without models, network, persistent receipts, external reads or saved changes', async t => {
  const {a, counts, preview, folder} = await fixture(t), f = folder('资料');
  fs.writeFileSync(path.join(f.path, 'private.txt'), 'This file must not be read during preview'); a.save();
  const before = structuredClone(a.data), bytes = fs.readFileSync(a.file);
  t.mock.method(a, 'save', () => { throw Error('Preview must not save'); });
  t.mock.method(fs, 'readdirSync', () => { throw Error('Preview must not scan folders'); });
  const p = await preview({folderIds: [f.id], feedUrls: ['https://example.com/rss'], pageUrls: ['https://example.com/news']});
  assert.equal(p.modelCalls, 0); assert.equal(p.networkRequests, 0); assert.equal(p.summary.rule.enabled, false);
  assert.equal(p.summary.rule.autoAccept, false); assert.equal(p.summary.permissions.fileMode, 'off'); assert.equal(p.summary.permissions.allowWeb, false);
  assert.equal(p.summary.feeds.length, 1); assert.equal(p.summary.pages.length, 1); assert.equal(p.summary.folders.length, 1);
  assert.deepEqual(a.data, before); assert.deepEqual(fs.readFileSync(a.file), bytes); assert.deepEqual(counts, {model: 0, network: 0});
});

test('create saves project, initial material, paused rule and paused subscriptions once, without a delegation', async t => {
  const {a, counts, create, folder} = await fixture(t), f = folder('资料');
  const save = a.save.bind(a); let writes = 0;
  t.mock.method(a, 'save', () => { writes++; save(); });
  const r = await create({folderIds: [f.id], feedUrls: ['https://example.com/rss'], pageUrls: ['https://example.com/news']});
  assert.equal(writes, 1); assert.equal(a.data.projects.length, 1); assert.equal(a.data.sources.length, 1); assert.equal(a.data.workRules.length, 1);
  assert.equal(a.data.delegations.length, 0); assert.equal(a.data.tasks.length, 0); assert.equal(a.data.ruleRuns.length, 0);
  const rule = a.data.workRules[0];
  assert.equal(rule.config.projectId, r.projectId); assert.equal(rule.config.trigger, 'project_changes'); assert.equal(rule.status, 'paused');
  assert.equal(rule.config.includeExisting, true); assert.equal(rule.config.autoAccept, false); assert.equal(rule.config.fileMode, 'off');
  assert.deepEqual(rule.config.urls, []); assert.deepEqual(rule.config.folderIds, []); assert.equal(rule.config.allowWeb, false); assert.equal(rule.config.useGithub, false);
  assert.equal(a.data.feedConnections[0].enabled, false); assert.equal(a.data.webConnections[0].enabled, false); assert.equal(a.data.folders[0].enabled, false);
  assert.equal(a.data.folders[0].projectId, r.projectId); assert.equal(a.data.sources[0].projectId, r.projectId);
  assert.equal(a.data.projectSetupReceipts.length, 1); assert.equal(r.reused, false); assert.deepEqual(counts, {model: 0, network: 0});
});

test('enabled setup requires each model role but remains local and never clears global pause', async t => {
  const {a, counts, input, preview, create} = await fixture(t);
  await assert.rejects(preview({enabled: true}), /选择模型/);
  await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,name: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1'});
  a.data.settings.roles.verify = ''; await assert.rejects(preview({enabled: true}), /结果检查/);
  a.data.settings.roles.verify = a.data.providers[0].id;
  await a.dispatch('stewardshipPause'); const state = structuredClone(a.data.stewardship);
  const p = await preview({enabled: true}); assert.equal(p.summary.automatic.allowed, false); assert.match(p.summary.automatic.message, /暂停/);
  const r = await create({enabled: true, feedUrls: ['https://example.com/rss']});
  assert.equal(a.data.workRules[0].status, 'enabled'); assert.equal(a.data.feedConnections[0].enabled, true);
  assert.deepEqual(a.data.stewardship, state); assert.equal(a.data.settings.automatic, false); assert.equal(a.data.delegations.length, 0);
  assert.equal(rules.tick(a), false); assert.deepEqual(counts, {model: 0, network: 0}); assert.ok(input.goal);
});

test('subsequent local rule check uses existing sources and creates only the canonical project job', async t => {
  const {a, create, counts} = await fixture(t, {models: true});
  const r = await create({enabled: true}); await a.dispatch('ruleRun', {id: r.ruleId}); await a.runPromise;
  assert.equal(a.data.ruleRuns[0].status, 'created'); assert.equal(a.data.delegations.length, 1); assert.equal(a.data.sources.length, 1);
  assert.deepEqual(a.data.delegations[0].sourceIds, r.sourceIds); assert.equal(a.data.delegations[0].projectId, r.projectId);
  assert.equal(a.data.delegations[0].watchers.length, 0); assert.deepEqual(counts, {model: 0, network: 0});
});

test('an empty project is valid and explicitly explains it will wait for material', async t => {
  const {a, preview, create} = await fixture(t); const p = await preview({text: ''});
  assert.equal(p.summary.initialMaterial, null); assert.match(p.summary.warnings.join(' '), /没有材料入口/);
  const r = await create({text: ''}); assert.deepEqual(r.sourceIds, []); assert.equal(a.data.sources.length, 0);
});

test('selected output defaults to approval and explicit automatic writing and acceptance remain visible', async t => {
  const {a, dir, preview, create} = await fixture(t); const output = path.join(dir, 'deliveries'); fs.mkdirSync(output); a.data.agentSettings.outputFolder = output;
  const p = await preview({useOutputFolder: true}); assert.equal(p.summary.permissions.fileMode, 'ask'); assert.equal(p.summary.permissions.outputFolderName, 'deliveries');
  assert.equal(JSON.stringify(p).includes(dir), false);
  await create({useOutputFolder: true, fileMode: 'auto', autoAccept: true});
  assert.equal(a.data.workRules[0].config.fileMode, 'auto'); assert.equal(a.data.workRules[0].config.autoAccept, true);
  assert.equal(a.data.workRules[0].config.outputFolder, output); assert.equal(a.data.delegations.length, 0);
});

test('output folder cannot also be selected as an input directory', async t => {
  const {a, preview, folder} = await fixture(t), f = folder('both'); a.data.agentSettings.outputFolder = f.path;
  await assert.rejects(preview({folderIds: [f.id], useOutputFolder: true}), /需要分开/);
});

for (const [label, patch] of Object.entries({
  missing_name: {name: ''}, missing_goal: {goal: ''}, too_long_text: {text: 'x'.repeat(200001)}, wrong_boolean: {enabled: 'false'},
  fractional_interval: {intervalMinutes: 5.5}, too_many_feeds: {feedUrls: Array(4).fill('https://example.com/rss')},
  too_many_pages: {pageUrls: Array(4).fill('https://example.com/page')}, malformed_folders: {folderIds: 'folder'},
  duplicate_feed: {feedUrls: ['https://example.com/rss', 'https://example.com/rss']}, private_url: {pageUrls: ['http://127.0.0.1/a']},
  credentials_url: {feedUrls: ['https://user:password@example.com/feed']}, foreign_id: {projectId: 'existing'}, scanning_grant: {allowWeb: true}
})) test(`invalid ${label} setup never changes saved state`, async t => {
  const {a, preview} = await fixture(t), before = structuredClone(a.data), bytes = fs.readFileSync(a.file);
  await assert.rejects(preview(patch)); assert.deepEqual(a.data, before); assert.deepEqual(fs.readFileSync(a.file), bytes);
});

test('already assigned, removed, symlinked, and replaced authorized directories fail closed', async t => {
  const {a, dir, folder, preview, input} = await fixture(t), f = folder('input');
  f.projectId = 'other'; await assert.rejects(preview({folderIds: [f.id]}), /其他项目/); f.projectId = null;
  await assert.rejects(preview({folderIds: ['missing']}), /移除/);
  const p = await preview({folderIds: [f.id]}); fs.renameSync(f.path, path.join(dir, 'old-input')); fs.mkdirSync(f.path);
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, folderIds: [f.id], revision: p.revision, requestId: crypto.randomUUID()}), /已变化/);
  fs.rmdirSync(f.path); fs.symlinkSync(path.join(dir, 'old-input'), f.path);
  await assert.rejects(preview({folderIds: [f.id]}), /路径变化/); assert.equal(a.data.projects.length, 0);
});

test('binding an unassigned folder preserves its existing independent material and prior receipt state', async t => {
  const {a, folder, create} = await fixture(t), f = folder('input');
  await a.dispatch('import', {items: [{title: '独立材料', content: '旧正文'}]});
  const original = structuredClone(a.data.sources[0]);
  a.data.agentActions.push({id: 'pending-external', status: 'uncertain', sourceId: original.id});
  const beforeAction = structuredClone(a.data.agentActions); await create({folderIds: [f.id]});
  assert.deepEqual(a.data.sources.find(s => s.id === original.id), original); assert.deepEqual(a.data.agentActions, beforeAction);
});

test('input changes or forged preview revisions cannot commit', async t => {
  const {a, input, preview} = await fixture(t), p = await preview();
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, goal: '不同目标', revision: p.revision, requestId: crypto.randomUUID()}), /重新预览/);
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, revision: 'wrong', requestId: crypto.randomUUID()}), /重新预览/);
  assert.equal(a.data.projects.length, 0);
});

test('provider, output grant, folder assignment and global pause changes each invalidate a preview', async t => {
  const {a, input, folder, preview} = await fixture(t, {models: true}), f = folder('input');
  for (const mutate of [() => a.data.providers[0].model = 'changed', () => a.data.stewardship.paused = true]) {
    const p = await preview(); mutate(); await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId: crypto.randomUUID()}), /已变化/);
  }
  const p = await preview({folderIds: [f.id]}); f.projectId = 'other';
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, folderIds: [f.id], revision: p.revision, requestId: crypto.randomUUID()}), /其他项目/);
  assert.equal(a.data.projects.length, 0);
});

test('same request retry survives restart and does not require a still-valid preview or folder grant', async t => {
  const {a, input, create, folder} = await fixture(t), f = folder('input'), requestId = crypto.randomUUID(), data = {...input, folderIds: [f.id]};
  const first = await create({folderIds: [f.id]}, requestId);
  const next = new Assistant({dir: a.dir}); const before = structuredClone(next.data);
  const reused = await setup.dispatch(next, 'projectSetupCreate', {...data, revision: 'old', requestId});
  assert.equal(reused.projectId, first.projectId); assert.equal(reused.reused, true); assert.deepEqual(next.data, before);
  await assert.rejects(setup.dispatch(next, 'projectSetupCreate', {...data, goal: 'different', requestId}), /另一份/);
});

test('reusing a request cannot resurrect archived or removed project objects', async t => {
  const {a, input, create} = await fixture(t), requestId = crypto.randomUUID(), first = await create({}, requestId);
  a.data.projects[0].archivedAt = new Date().toISOString(); a.data.workRules[0].status = 'archived';
  const before = structuredClone(a.data);
  assert.equal((await setup.dispatch(a, 'projectSetupCreate', {...input, requestId})).reused, true); assert.deepEqual(a.data, before);
  a.data.projects = []; a.data.workRules = []; a.data.sources = [];
  const deleted = structuredClone(a.data), result = await setup.dispatch(a, 'projectSetupCreate', {...input, requestId});
  assert.equal(result.projectId, first.projectId); assert.deepEqual(a.data, deleted);
});

test('concurrent same-request submissions create one bundle; distinct requests cannot overwrite each other', async t => {
  const {a, input, preview} = await fixture(t), p = await preview(), requestId = crypto.randomUUID();
  const both = await Promise.all([1, 2].map(() => setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId})));
  assert.deepEqual(both.map(r => r.reused), [false, true]); assert.equal(both[0].projectId, both[1].projectId); assert.equal(a.data.projects.length, 1);
  const fresh = await preview({name: '另一个'});
  const results = await Promise.allSettled([1, 2].map(() => setup.dispatch(a, 'projectSetupCreate', {...input, name: '另一个', revision: fresh.revision, requestId: crypto.randomUUID()})));
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']); assert.equal(a.data.projects.length, 2);
});

test('an unrelated IPC mutation during shadow construction is preserved and rejects the stale commit', async t => {
  const {a, input, preview} = await fixture(t), p = await preview(), dispatch = projects.dispatch;
  t.mock.method(projects, 'dispatch', async (...args) => { const result = await dispatch(...args); a.event('Concurrent event', 'must survive'); return result; });
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId: crypto.randomUUID()}), /已变化/);
  assert.equal(a.data.projects.length, 0); assert.equal(a.data.events[0].title, 'Concurrent event');
});

test('a busy assistant permits read-only preview but rejects a new create; becoming busy mid-prepare also rejects', async t => {
  const {a, input, preview} = await fixture(t); a.operation = {label: 'working'};
  const p = await preview(); await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId: crypto.randomUUID()}), /正在处理/);
  a.operation = null; const dispatch = projects.dispatch;
  t.mock.method(projects, 'dispatch', async (...args) => { const result = await dispatch(...args); a.operation = {label: 'started'}; return result; });
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId: crypto.randomUUID()}), /正在处理/); assert.equal(a.data.projects.length, 0);
});

test('mid-bundle validation failure rolls back project, folder binding, material and subscription changes', async t => {
  const {a, input, preview, folder} = await fixture(t), f = folder('input'), patch = {folderIds: [f.id], feedUrls: ['https://example.com/rss']};
  const p = await preview(patch), before = structuredClone(a.data), bytes = fs.readFileSync(a.file);
  t.mock.method(feeds, 'dispatch', async () => { throw Error('Subscription save failed'); });
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, ...patch, revision: p.revision, requestId: crypto.randomUUID()}), /Subscription save failed/);
  assert.deepEqual(a.data, before); assert.deepEqual(fs.readFileSync(a.file), bytes);
});

for (const afterWrite of [false, true]) test(`save failure ${afterWrite ? 'after' : 'before'} actual disk write restores the entire bundle and can retry once`, async t => {
  const {a, input, preview} = await fixture(t), p = await preview(), requestId = crypto.randomUUID(), before = structuredClone(a.data), bytes = fs.readFileSync(a.file), save = a.save.bind(a);
  let calls = 0; const mock = t.mock.method(a, 'save', () => { calls++; if (afterWrite) save(); throw Error('Disk fault'); });
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId}), /Disk fault/);
  assert.equal(calls, 1); assert.deepEqual(a.data, before); assert.deepEqual(fs.readFileSync(a.file), bytes); mock.mock.restore();
  const r = await setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId});
  assert.equal(r.reused, false); assert.equal(a.data.projects.length, 1); assert.equal(a.data.projectSetupReceipts.length, 1);
});

test('restoring an older backup retains later setup receipts without re-enabling objects on retry', async t => {
  const {a, input, create} = await fixture(t, {models: true}), backup = recovery.create(a), requestId = crypto.randomUUID();
  const first = await create({enabled: true}, requestId); await a.dispatch('backupRestore', {id: backup});
  const before = structuredClone(a.data), result = await setup.dispatch(a, 'projectSetupCreate', {...input, enabled: true, requestId});
  assert.equal(result.projectId, first.projectId); assert.equal(result.reused, true); assert.deepEqual(a.data, before);
  assert.equal(a.data.workRules[0].status, 'paused'); assert.equal(a.data.projectSetupReceipts.length, 1);
});

test('receipt schema and retention conflicts fail closed without discarding deduplication history', async t => {
  const {a, input, create, preview} = await fixture(t); await create();
  const saved = structuredClone(a.data), restored = structuredClone(a.data); restored.projectSetupReceipts[0].projectId = 'wrong';
  assert.throws(() => setup.retain(restored, saved), /回执冲突/);
  a.data.projectSetupReceipts = {}; await assert.rejects(preview(), /回执无效/);
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, requestId: crypto.randomUUID()}), /回执无效/);
});

test('receipt limit never evicts an older request and response/receipt contain no pasted material or keys', async t => {
  const {a, input, create, preview} = await fixture(t); const first = await create(), r = a.data.projectSetupReceipts[0];
  assert.equal(JSON.stringify(r).includes(input.text), false); assert.equal(JSON.stringify(first).includes(input.goal), false);
  a.data.projectSetupReceipts = Array.from({length: setup.limits.receipts}, (_, i) => ({...structuredClone(r), requestId: `request-${String(i).padStart(8, '0')}`}));
  await assert.rejects(preview(), /1000/); assert.equal(a.data.projectSetupReceipts.length, 1000);
});

test('post-write failure cannot leave an automatic backup that resurrects a failed creation', async t => {
  const {a, input, preview} = await fixture(t), p = await preview(), save = a.save.bind(a), oldBackups = recovery.list(a).map(r => r.id);
  a.lastBackupAt = 0;
  t.mock.method(a, 'save', () => { save(); throw Error('post-write failure'); });
  await assert.rejects(setup.dispatch(a, 'projectSetupCreate', {...input, revision: p.revision, requestId: crypto.randomUUID()}), /post-write failure/);
  assert.deepEqual(recovery.list(a).map(r => r.id), oldBackups);
  assert.equal(a.data.projects.length, 0);
});

test('active collection preview includes Lark source, exact outcome and keyword; creates paused connector atomically',async t=>{
 const {a,input,counts}=await fixture(t,{models:true});const config={...input,criteria:'一页成果，列明待决策点',keyword:'需求',larkSources:['oc_fixture_capture']};const p=await setup.dispatch(a,'projectSetupPreview',config);assert.equal(p.summary.connectors.length,1);assert.equal(a.data.connectors.length,0);assert.equal(p.summary.keyword,'需求');assert.equal(p.summary.criteria,config.criteria);await setup.dispatch(a,'projectSetupCreate',{...config,revision:p.revision,requestId:crypto.randomUUID()});assert.equal(a.data.connectors.length,1);assert.equal(a.data.connectors[0].enabled,false);assert.equal(a.data.workRules[0].config.keyword,'需求');assert.ok(a.data.workRules[0].config.goal.includes(config.criteria));assert.deepEqual(counts,{model:0,network:0});
});
