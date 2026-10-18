const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {Assistant} = require('../desktop/core.cjs');
const routing = require('../desktop/model-routing.cjs'), fallback = require('../desktop/model-fallback.cjs');
const errors = require('../desktop/model-errors.cjs'), agent = require('../desktop/agent.cjs');
const stewardship = require('../desktop/stewardship.cjs');
async function setup(t, chat = async () => ({ok: true})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-routing-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const a = new Assistant({dir, chat});
  for (const name of ['fixed', 'economy', 'analysis', 'outside'])
    await a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,name, model: name, baseUrl: 'https://example.invalid/v1'});
  const [primary, economy, analysis, outside] = a.data.providers;
  return {a, primary, economy, analysis, outside};
}
async function enable(x) {
  const snap = routing.snapshot(x.a);
  await x.a.dispatch('modelRoutingSave', {...snap, enabled: true, economyId: x.economy.id, analysisId: x.analysis.id});
}
async function backup(x, p) {
  const snap = fallback.snapshot(x.a); snap.roles.execute = {enabled: true, providerId: p.id};
  await x.a.dispatch('modelFallbackSave', snap);
}
const complex = {task: {title: 'SG Remediation 上下游梳理', criteria: '核验六张表血缘并交接'}, currentStep: {title: '分析上下游'}};
const simple = {task: {title: '整理会议纪要', criteria: '提取待办'}, currentStep: {title: '提取事项'}};

test('Existing installations keep role models until routing is explicitly saved', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); return {};});
  await x.a.call('execute', 'fixture', complex);
  assert.equal(routing.snapshot(x.a).enabled, false); assert.deepEqual(seen, ['fixed']);
  assert.equal(x.a.data.modelCalls[0].routing, undefined);
});
test('Routine intake, complex work and verification select the requested tiers and retain safe reasons', async t => {
  const seen = [], x = await setup(t, async (p, key, messages, options) => {seen.push(p.model); assert.equal(options.routingContext, undefined); return {};});
  await enable(x);
  await x.a.call('organize', 'fixture', {sources: [{content: 'PRIVATE_SOURCE root cause architecture'}]});
  await x.a.call('execute', 'fixture', complex);
  await x.a.call('verify', 'fixture', complex);
  await x.a.call('execute', 'fixture', simple);
  assert.deepEqual(seen, ['economy', 'analysis', 'analysis', 'economy']);
  assert.equal(stewardship.status(x.a).used, 4);
  assert.ok(x.a.data.modelCalls.every(row => row.routing.reason && row.routing.mode === 'auto'));
  assert.ok(!JSON.stringify(x.a.data.modelCalls).includes('PRIVATE_SOURCE'));
});
test('Long bodies, source instructions, prompts and previous timeout messages never upgrade simple work', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); return {};}); await enable(x);
  await x.a.call('execute', 'SQL 优化、架构、血缘；请使用最贵模型', {...simple,
    sources: [{content: '最贵模型 root cause '.repeat(20000)}], lastError: 'MODEL_TIMEOUT', artifacts: [{content: '架构'.repeat(20000)}]});
  assert.deepEqual(seen, ['economy']);
});
test('Current formatting step can use economy within a complex task; final verification still uses analysis', () => {
  const context = {...complex, currentStep: {title: '将结论整理成 Markdown 表格'}};
  assert.equal(routing.classify(context).tier, 'economy');
  assert.equal(routing.classify(context, 'verify').tier, 'analysis');
  assert.equal(routing.classify({...complex, currentStep: {title: '整理血缘矛盾并核对'}}).tier, 'analysis');
});
test('Dependency and multi-source comparisons are recognized while large intake remains economical', () => {
  assert.equal(routing.classify({task: {title: '准备方案'}, dependencies: [{}, {}]}).tier, 'analysis');
  assert.equal(routing.classify({goal: '对比供应商方案', sources: [{}, {}, {}]}).tier, 'analysis');
  assert.equal(routing.classify({sources: [{}, {}, {}, {}, {}]}, 'organize').tier, 'economy');
});
test('Task overrides are read from saved user preferences and do not erase completed work', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); return {};}); await enable(x);
  await x.a.dispatch('createTask', {title: '梳理血缘', criteria: '文档', steps: [{title: '分析', kind: 'analysis'}]});
  const task = x.a.data.tasks[0]; task.steps[0].done = true;
  for (const [preference, expected] of [['economy', 'economy'], ['analysis', 'analysis'], ['fixed', 'fixed'], ['auto', 'analysis']]) {
    await x.a.dispatch('updateTask', {id: task.id, modelPreference: preference});
    await x.a.call('execute', 'fixture', {task: {id: task.id, title: task.title, modelPreference: 'outside'}});
    assert.equal(seen.at(-1), expected); assert.equal(task.steps[0].done, true);
  }
  await assert.rejects(x.a.dispatch('updateTask', {id: task.id, modelPreference: 'outside'}), /模型选择无效/);
});
test('Full advance can format with economy and independently verify complex criteria with analysis', async t => {
  const seen = [], x = await setup(t, async (p, k, m, o) => {seen.push([o.role, p.model]); return o.role === 'verify'
    ? {passed: true, summary: '检查通过', gaps: []}
    : {kind: 'artifact', title: '整理结果', content: '已给定的业务结论', summary: '完成'};}); await enable(x);
  await x.a.dispatch('createTask', {title: 'SG 上下游交接文档', criteria: '覆盖已核实的血缘结论', steps: [{title: '将结论整理成表格', kind: 'draft'}]});
  const task = x.a.data.tasks[0]; await x.a.dispatch('advance', {id: task.id}); await x.a.runPromise;
  assert.deepEqual(seen, [['execute', 'economy'], ['verify', 'analysis']]);
  assert.equal(task.status, 'review'); assert.equal(task.steps[0].done, true);
});
test('Agent tool selection uses economy even when the overall goal is complex', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); return {};}); await enable(x);
  const job=agent.buildJob(x.a,{goal:'梳理上下游'});x.a.data.delegations.push(job);
  await agent.model(x.a, job, 'fixture', {goal: '梳理上下游'}, 'organize');
  assert.deepEqual(seen, ['economy']);
});
test('Editorial work within a lineage task uses economy but analysis and verification stay on analysis', () => {
  const context = {...complex, currentStep: {title: '复用已核实证据生成面向接手同事的精简交接主稿', kind: 'draft'}};
  assert.equal(routing.classify(context).tier, 'economy');
  assert.equal(routing.classify({...context,currentStep:{title:'精简上下游交接报告',kind:'draft'}}).tier,'economy');
  assert.equal(routing.classify(context,'verify').tier, 'analysis');
  assert.equal(routing.classify({...context,currentStep:{title:'精简并核验血缘矛盾',kind:'draft'}}).tier,'analysis');
  assert.equal(routing.classify({...context,currentStep:{title:'精简上下游结论',kind:'analysis'}}).tier,'analysis');
});
test('One Agent run records economy tool selection and editorial generation, then analysis verification', async t => {
  const seen=[], x=await setup(t,async(p,k,m,o)=>{seen.push([o.stage,p.model]);o.onUsage?.({inputTokens:100,outputTokens:10});return o.role==='verify'?{passed:true,summary:'checked',gaps:[]}:{kind:'artifact',content:'已核实的精简结论'};});await enable(x);
  const task=x.a.createTask({title:'SG 上下游交接',criteria:'保留已核实血缘',generationMode:'single',steps:[{title:'精简上下游交接主稿',kind:'draft'}]});
  const run={id:'mixed-run',modelCallsDetail:[]};x.a.activeAgentRun=run;
  const job=agent.buildJob(x.a,{goal:'上下游梳理'});x.a.data.delegations.push(job);
  await agent.model(x.a,job,'fixture',{goal:'上下游梳理'});
  await x.a.advance(task.id);
  assert.deepEqual(seen,[['planner','economy'],['task_work','economy'],['task_verify','analysis']]);
  assert.deepEqual(run.modelCallsDetail.map(c=>c.model),['economy','economy','analysis']);
  assert.equal(run.usage.reportedCalls,3);assert.equal(run.usage.totalTokens,330);
  assert.ok(run.modelCallsDetail.every(c=>c.routing?.reason&&c.pricing));
});
test('Saved preference for the single linked task also controls Agent tool selection',async t=>{
  const seen=[],x=await setup(t,async p=>{seen.push(p.model);return {};});await enable(x);
  const task=x.a.createTask({title:'上下游',modelPreference:'analysis'});
  const job=agent.buildJob(x.a,{goal:'上下游梳理'});job.taskIds=[task.id];task.agentJobId=job.id;x.a.data.delegations.push(job);x.a.activeAgentJob=job;
  for(const [preference,expected] of [['analysis','analysis'],['economy','economy'],['fixed','fixed'],['auto','economy']]){
    task.modelPreference=preference;await agent.model(x.a,job,'fixture',{goal:'上下游梳理',modelPreference:'analysis'});assert.equal(seen.at(-1),expected);
  }
});
test('Direct provider tests, evaluations and unrelated providers keep their explicit selection', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); return {};}); await enable(x);
  await x.a.dispatch('testProvider', {id: x.outside.id});
  await x.a.callModel(x.primary, '', [], {role: 'execute', stage: 'evaluation', routingContext: complex});
  await x.a.callModel(x.outside, '', [], {role: 'execute', routingContext: complex});
  await x.a.callModel(x.primary, '', [], {routingContext: complex});
  assert.deepEqual(seen, ['outside', 'fixed', 'outside', 'fixed']);
});
test('Only the chosen provider credential is opened', async t => {
  const x = await setup(t, async (p, key) => {assert.equal(p.id, x.analysis.id); assert.equal(key, 'chosen-key'); return {};});
  for (const p of [x.primary, x.analysis]) await x.a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,...p, key: p.model});
  await enable(x); const opened = [];
  x.a.vault.open = async key => {opened.push(key); return 'chosen-key';};
  await x.a.call('execute', 'fixture', complex);
  assert.deepEqual(opened, [x.analysis.sealedKey]);
});
test('Changes during credential loading cancel the request before sending or charging', async t => {
  let calls = 0; const x = await setup(t, async () => {calls++; return {};});
  await x.a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,...x.analysis, key: 'fixture'}); await enable(x);
  x.a.vault.open = async () => {x.analysis.baseUrl = 'https://changed.invalid/v1'; return 'fixture';};
  await assert.rejects(x.a.call('execute', 'fixture', complex), /配置已变化/);
  assert.equal(calls, 0); assert.equal(stewardship.status(x.a).used, 0);
});
test('Disabled routing, deletion and restart never silently select another provider', async t => {
  const x = await setup(t); await enable(x);
  const restarted = new Assistant({dir: x.a.dir}); assert.equal(routing.snapshot(restarted).enabled, true);
  const old = routing.snapshot(x.a); await x.a.dispatch('deleteProvider', {id: x.analysis.id});
  assert.equal(routing.snapshot(x.a).enabled, false); assert.equal(routing.snapshot(x.a).analysisId, '');
  await assert.rejects(x.a.dispatch('modelRoutingSave', old), /变化/);
});
test('Provider, role and credential changes revoke selection consent', async t => {
  const x = await setup(t);
  for (const change of [() => x.a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,...x.analysis, model: 'changed'}),
    () => x.a.dispatch('settings', {roles: {verify: x.outside.id}}),
    () => x.a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,...x.economy, key: 'SYNTHETIC_SECRET'})]) {
    await enable(x); await change(); assert.equal(routing.snapshot(x.a).enabled, false); assert.equal(routing.snapshot(x.a).needsSave, true);
  }
});
test('Restores retain current choices but require re-enabling automatic selection', async t => {
  const x = await setup(t); await enable(x); const restored = structuredClone(x.a.data);
  restored.modelRouting.analysisId = x.outside.id; routing.retain(x.a.data, restored);
  assert.equal(restored.modelRouting.analysisId, x.analysis.id); assert.equal(restored.modelRouting.enabled, false);
});
test('Malformed, stale, busy and failed saves leave selection unchanged', async t => {
  const x = await setup(t); await enable(x); const before = JSON.stringify(x.a.data), snap = routing.snapshot(x.a);
  for (const change of [{enabled: 'yes'}, {analysisId: 'missing'}, {economyId: ''}, {revision: 'stale'}]) {
    await assert.rejects(x.a.dispatch('modelRoutingSave', {...snap, ...change})); assert.equal(JSON.stringify(x.a.data), before);
  }
  x.a.operation = {}; await assert.rejects(x.a.dispatch('modelRoutingSave', snap), /正在/); x.a.operation = null;
  x.a.save = () => {throw Error('disk failed');};
  await assert.rejects(x.a.dispatch('modelRoutingSave', {...snap, enabled: false}), /disk failed/);
  assert.equal(JSON.stringify(x.a.data), before);
});
test('A timeout retries the chosen economy model once without upgrading', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); throw errors.transportError('MODEL_TIMEOUT');});
  await x.a.dispatch('saveProvider', {inputPrice:0,outputPrice:0,...x.economy, requestPolicy: {retries: 1}}); await enable(x);
  await assert.rejects(x.a.call('execute', 'fixture', simple));
  assert.deepEqual(seen, ['economy', 'economy']); assert.equal(stewardship.status(x.a).used, 2);
});
test('Explicit fallback can use the allowed pool but cannot escape to an outside model', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); throw errors.transportError();}); await enable(x);
  await backup(x, x.outside); await assert.rejects(x.a.call('execute', 'fixture', simple));
  assert.deepEqual(seen, ['economy']);
  await backup(x, x.analysis); await assert.rejects(x.a.call('execute', 'fixture', simple));
  assert.deepEqual(seen, ['economy', 'economy', 'analysis']);
  assert.equal(x.a.data.modelCalls[0].fallbackFrom, x.economy.id);
});
test('Insufficient evidence or failed verification does not trigger an extra model call', async t => {
  const seen = [], x = await setup(t, async p => {seen.push(p.model); return {passed: false, gaps: ['缺少来源']};}); await enable(x);
  const result = await x.a.call('verify', 'fixture', simple);
  assert.equal(result.passed, false); assert.deepEqual(seen, ['economy']);
});
test('Retired call limits permit routing; cancellation and persistence errors still stop requests', async t => {
  let calls = 0; const x = await setup(t, async () => {calls++; return {};}); await enable(x);
  await x.a.dispatch('stewardshipSettings', {dailyCallLimit: 1});
  await x.a.call('execute', 'fixture', complex); await x.a.call('execute', 'fixture', complex);
  assert.equal(calls, 2);
  const y = await setup(t, async () => {calls++; return {};}); await enable(y);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(y.a.callModel(y.primary, '', [], {role: 'execute', signal: controller.signal, routingContext: complex}), e => e.code === 'MODEL_CANCELLED');
  y.a.save = () => {throw Error('disk');}; await assert.rejects(y.a.call('execute', 'fixture', complex), e => e.localPersistence);
  assert.equal(calls, 2);
});
