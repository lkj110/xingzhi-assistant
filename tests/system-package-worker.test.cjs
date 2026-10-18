'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const harness = require('../scripts/system-package-worker.cjs');
const root = path.resolve(__dirname, '..');
function temporary(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'package-worker-contract-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir;
}
function put(dir, relative, text) { const file = path.join(dir, relative); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); return file; }
function sample() {
  const continuation = {version: 1, activeTaskId: 'task', activeBasis: 'basis', migrations: {old: {at: 'before'}},
    episodes: {basis: {basis: 'basis', taskId: 'task', intentBasis: 'intent', cycles: 2, hops: 2, executions: 3,
      factKeys: ['old-fact'], readingResumes: {read: {at: 'before', inputBasis: 'input'}},
      pendingCheck: {claimId: 'claim', generationAttemptId: 'generation', ownerEpisodeId: 'basis', taskId: 'task',
        agentRunId: 'generation-run', stepId: 'step', intentBasis: 'intent', taskWorkRevision: 1,
        artifactId: 'draft', artifactHash: 'body-hash', inputBasis: 'input', checkBasis: 'check', checkPhase: 'content',
        status: 'interrupted', createdAt: 'generated-at', claimedByRunId: 'paused-run', claimedAt: 'claimed-at',
        interruption: {code: 'EXECUTION_GATE_CLOSED', at: 'paused-at', requestProof: [{id: 'request', status: 'done'}]},
        claimHistory: [{runId: 'older-run', claimedAt: 'older-at', interruption: {requestProof: [{id: 'older-request'}]}}]}},
      earlier: {basis: 'earlier', taskId: 'task', complete: true, cycles: 1, hops: 1}}};
  return {jobId: 'job', taskId: 'task', primary: 'draft', jobStatus: 'blocked', taskStatus: 'blocked',
    autoAccept: false, acceptedAt: null, completedAt: null, paused: true, pauseInjected: true,
    continuation, activeTaskId: 'task', activeBasis: 'basis', episodes: continuation.episodes,
    efficiency: {attempts: 18, tried: {old: {at: 'old-at'}}, history: [{id: 'old-method', outcome: 'no_progress'}],
      reading: {input: {attempts: 2, sources: ['old-source']}}}, reads: {source: {count: 2}},
    contextFinalizations: {check: {status: 'pending', attempts: 1, reads: ['old-source']}},
    legacyCounters: {attempts: 18, cycles: 2}, counts: {updates: 0, revisions: 1, model: 5},
    ledger: {spentUSD: 1, heldUSD: 0.3}, openDecisions: 0, checks: [], violations: [], modules: {pid: 100}};
}
function resumed(previous) {
  const final = structuredClone(previous), old = previous.episodes.basis.pendingCheck, pending = final.episodes.basis.pendingCheck;
  final.modules.pid = 101; final.paused = false; final.jobStatus = final.taskStatus = 'review';
  final.counts.updates = 1; final.counts.model++;
  pending.claimHistory.push({runId: old.claimedByRunId, claimedAt: old.claimedAt, interruption: structuredClone(old.interruption)});
  Object.assign(pending, {status: 'settled', claimedByRunId: 'resumed-run', claimedAt: 'resumed-at', settledCheckId: 'settled', settledAt: 'settled-at'});
  final.episodes.basis.complete = true; final.episodes.basis.executions++;
  final.efficiency.attempts = 0; final.efficiency.phase = 'working'; final.efficiency.reason = 'new_effective_output';
  return final;
}
test('CLI requires explicit absolute final app/output and rejects ambiguous options', () => {
  assert.deepEqual(harness.SCENARIOS, ['success', 'pause_during_check', 'uncertain', 'readback_mismatch', 'context_authorization_repair', 'storage_method_recovery', 'generic_success', 'generic_uncertain', 'generic_mismatch', 'generic_preflight_recovery', 'generic_v2_recovery', 'generic_local_recovery']);
  assert.equal(harness.parseArgs(['--app', '/tmp/final.app', '--output', '/tmp/report.json']).scenario, 'pause_during_check');
  for (const scenario of harness.SCENARIOS) assert.equal(harness.parseArgs(['--app', '/tmp/final.app', '--output', '/tmp/r', '--scenario', scenario]).scenario, scenario);
  for (const args of [[], ['--app', './a.app', '--output', '/tmp/r'], ['--app', '/tmp/a.app', '--output', 'r'],
    ['--app', '/tmp/a.app', '--output', '/tmp/r', '--scenario', 'other'], ['--app', '/tmp/a.app', '--output'],
    ['--app', '/tmp/a.app', '--app', '/tmp/b.app', '--output', '/tmp/r'],
    ['--app', '/tmp/a.app', '--output', '/tmp/r', '--source', '/tmp/source']]) assert.throws(() => harness.parseArgs(args));
});
function repairSample(){
 const s=sample();s.paused=false;s.pauseInjected=false;s.jobStatus='needs_input';s.taskStatus='todo';s.counts={model:0,updates:0,revisions:0};s.runs=2;
 const p=s.continuation.episodes.basis.pendingCheck;p.status='claimed';p.claimedByRunId='failed';p.interruption.at='2026-01-01';
 s.contextRepair={view:{kind:'internal_context_authorization',proofId:'proof',expectedRevision:8,expectedWorkRevision:1,expectedTaskRevision:1},
  lastError:'',primary:'draft',continuation:structuredClone(s.continuation),efficiency:s.efficiency,reads:s.reads,generationReads:[{result:{ok:true,content:'kept'}}],ledger:s.ledger,policies:{events:['grant']},goal:'original',contract:{text:'original'},artifacts:[{id:'draft',content:'original'}],
  decision:{id:'decision',status:'open',key:'access:external:verify_content'},
  failedRun:{id:'failed',startedAt:'2026-02-01',finishedAt:'2026-02-03',modelCalls:20,modelCallsDetail:Array.from({length:20},(_,i)=>({id:'call-'+i,at:'2026-02-02',status:'done',usageReported:true,requestId:'request-'+i,inputTokens:50,outputTokens:0,estimatedUSD:0})),steps:[{tool:'verify_content',errorCode:'CONTEXT_INVALID_REQUEST',result:{decisionId:'decision'}}]},modelCalls:[]};
 return s;
}
function committedRepair(s){
 const next=structuredClone(s);next.jobStatus='ready';next.contextRepair.view=null;next.contextRepair.decision.status='superseded';
 next.contextRepair.continuation.episodes.basis.checkRepairs={generation:{status:'ready'}};return next;
}
test('context repair ASAR assertions preserve original history, proof, counters and permissions through cold/UI boundaries',()=>{
 const before=repairSample(),after=committedRepair(before);harness.assertContextRepairHistorical(before);harness.assertContextRepairCommitted(before,after);
 const cold=structuredClone(before);cold.modules.pid++;cold.contextRepair.view.expectedRevision++;harness.assertRestored(before,cold);
 for(const mutate of [
  s=>s.contextRepair.lastError='replacement',s=>s.contextRepair.view.kind='legacy_pause',s=>s.contextRepair.failedRun.modelCallsDetail.pop(),
  s=>s.contextRepair.failedRun.modelCallsDetail[0].usageReported=false,s=>delete s.contextRepair.failedRun.modelCallsDetail[0].estimatedUSD,s=>s.contextRepair.failedRun.modelCallsDetail[0].at='2027-01-01',s=>s.contextRepair.decision.status='answered',
  s=>s.contextRepair.continuation.episodes.basis.pendingCheck.claimedByRunId='other',s=>s.counts.model=1,
 ]){const bad=structuredClone(before);mutate(bad);assert.throws(()=>harness.assertContextRepairHistorical(bad));}
 for(const mutate of [
  s=>s.contextRepair.ledger.spentUSD=0,s=>s.contextRepair.policies.events=[],s=>s.contextRepair.generationReads=[],
  s=>s.contextRepair.failedRun.modelCallsDetail[0].requestId='new',s=>s.contextRepair.artifacts[0].content='new',
  s=>s.contextRepair.continuation.episodes.basis.pendingCheck.interruption={},s=>s.contextRepair.continuation.episodes.earlier.cycles=0,
  s=>s.contextRepair.efficiency.tried={},s=>s.contextRepair.view={kind:'internal_context_authorization'},
  s=>s.contextRepair.decision.answer='approved',s=>s.contextRepair.continuation.episodes.basis.checkRepairs.generation.status='claimed',
  s=>s.counts.updates=1,s=>s.runs++,
 ]){const bad=structuredClone(after);mutate(bad);assert.throws(()=>harness.assertContextRepairCommitted(before,bad));}
 for(const mutate of [s=>s.contextRepair.view.proofId='changed',s=>s.contextRepair.continuation.episodes.basis.pendingCheck.claimId='changed',s=>s.contextRepair.contextFinalizations={claim:{status:'started'}},s=>s.contextRepair.modelCalls.push({status:'running'})]){const bad=structuredClone(cold);mutate(bad);assert.throws(()=>harness.assertRestored(before,bad));}
});
test('RunAsNode fuse preflight fails closed before any executable launch', t => {
  const dir = temporary(t), wire = (version = 1, enabled = 0x31) => Buffer.concat([harness.SENTINEL, Buffer.from([version, 2, enabled, 0x30])]);
  const file = put(dir, 'framework', Buffer.concat([Buffer.from('binary'), wire(), wire()]));
  assert.equal(harness.readNodeFuses(file).length, 2);
  for (const bytes of [Buffer.from('no fuse'), wire(2), wire(1, 0x30), wire(1, 0x72), Buffer.concat([wire(), wire(), wire()]), harness.SENTINEL]) {
    fs.writeFileSync(file, bytes); assert.throws(() => harness.readNodeFuses(file));
  }
});
test('source/package identities cover changes, additions, ASAR, unpacked and native bytes', t => {
  const dir = temporary(t), source = path.join(dir, 'source'), app = path.join(dir, 'final.app');
  put(source, 'desktop/core.cjs', 'one'); put(source, 'scripts/a.cjs', 'fixture'); fs.mkdirSync(path.join(source, 'desktop/native'));
  const first = harness.sourceIdentity(source).digest;
  put(source, 'desktop/extra.cjs', 'two'); assert.notEqual(harness.sourceIdentity(source).digest, first);
  fs.rmSync(path.join(source, 'desktop/extra.cjs')); assert.equal(harness.sourceIdentity(source).digest, first);
  put(source, 'desktop/native/bin/helper', 'generated'); assert.equal(harness.sourceIdentity(source).digest, first);
  put(app, 'Contents/Resources/app.asar', 'archive'); put(app, 'Contents/Resources/app.asar.unpacked/desktop/native/bin/helper', 'native');
  const a = harness.packageIdentity(app);
  put(app, 'Contents/Resources/app.asar.unpacked/desktop/native/bin/helper', 'modified');
  const b = harness.packageIdentity(app); assert.notEqual(a.digest, b.digest); assert.notEqual(a.nativeDigest, b.nativeDigest); assert.notEqual(a.unpackedDigest, b.unpackedDigest);
  assert.equal(a.asarSHA256, b.asarSHA256);
  fs.symlinkSync(dir, path.join(app, 'escape')); assert.throws(() => harness.packageIdentity(app), /escaping symlink/);
});
test('tmp fixture rewrites every runtime import into ASAR and rejects drift/unreviewed dependencies', () => {
  const original = fs.readFileSync(path.join(root, 'scripts/root-delivery-fixture.cjs'), 'utf8');
  const desktop = '/tmp/final.app/Contents/Resources/app.asar/desktop';
  const result = harness.adaptFixture(original, desktop, '/tmp/helper.cjs');
  new vm.Script(result);
  assert.doesNotMatch(result, /require\(['"]\.\./);
  assert.match(result, /app\.asar\/desktop\/agent\.cjs/);
  assert.match(result, /restoreAudit/);
  assert.equal(result, harness.redirectRequires(original, desktop, '/tmp/helper.cjs'), 'only dependency paths may change');
  assert.throws(() => harness.adaptFixture(original.replaceAll("restoreAudit", "oldContract"), desktop, '/tmp/helper.cjs'), /persisted transport restoration/);
  assert.throws(() => harness.redirectRequires("require('../private.cjs')", desktop), /unreviewed/);
  const helper = harness.redirectRequires(fs.readFileSync(path.join(root, 'tests/helpers/platform-fixture.cjs'), 'utf8'), desktop);
  assert.match(helper, /app\.asar\/desktop\/data-platform\.cjs/); new vm.Script(helper);
});
test('restart adapter hydrates fixture cursors without seeding or rewriting Assistant business state', async t => {
  const dir = temporary(t), desktop = path.join(dir, 'app.asar/desktop'), helper = path.join(dir, 'helper.cjs');
  const data = {delegations: [{id: 'job'}], tasks: [{id: 'task', sourceIds: ['initial']}], artifacts: [{id: 'old'}], sources: [{id: 'initial'}, {id: 'other'}]};
  const saved = {scenario: 'pause_during_check', readBatches: Array.from({length: 6}, () => []), events: [{kind: 'revision_generated'}],
    ids: {jobId: 'job', taskId: 'task', oldId: 'old', initialId: 'initial', unrelatedId: 'other'},
    transportState: {readIndex: 6, generated: true, pendingBatch: null}, remote: {body: 'synthetic remote', revision: 1}, baseline: {ledger: {spentUSD: 1}}, modelInputs: [], connectorCalls: [], checks: [], violations: []};
  const audit = put(dir, 'audit.json', JSON.stringify(saved)), before = JSON.stringify(data);
  class Assistant { constructor() { this.data = data; } task(id) { return this.data.tasks.find(t => t.id === id); } dispatch() { throw Error('must not reseed'); } }
  const module = {exports: {}};
  vm.runInNewContext(harness.adaptFixture(fs.readFileSync(path.join(root, 'scripts/root-delivery-fixture.cjs'), 'utf8'), desktop, helper), {
    module, exports: module.exports, require: name => {
      if (name === helper) return {install: () => {}};
      if (name.startsWith(desktop)) return {};
      return require(name);
    }, structuredClone,
  });
  const fixture = await module.exports.setup({Assistant, scenario: saved.scenario, options: {dir}, reportFile: audit, restoreAudit: true});
  assert.equal(JSON.stringify(data), before); assert.strictEqual(fixture.task, data.tasks[0]);
  assert.equal(fixture.audit.events.at(-1).kind, 'cold_worker_loaded');
  assert.equal(fixture.audit.readBatches.length, 6); assert.equal(fixture.remote.body, saved.remote.body);
  assert.equal(JSON.parse(fs.readFileSync(audit)).transportState.generated, true);
  assert.equal(JSON.parse(fs.readFileSync(audit)).transportState.readIndex, 6);
});
test('pause/cold-restore/negative assertions reject acceptance, reset counters, writes and in-process reopen', () => {
  harness.assertPause(sample());
  for (const patch of [{paused: false}, {autoAccept: true}, {acceptedAt: 'now'}, {openDecisions: 1}, {efficiency: {attempts: 0}}, {counts: {updates: 1}}, {activeTaskId: null}]) {
    assert.throws(() => harness.assertPause({...sample(), ...patch}));
  }
  const next = {...sample(), modules: {pid: 101}}; harness.assertRestored(sample(), next);
  assert.throws(() => harness.assertRestored(sample(), sample()), /replace the Electron process/);
  assert.throws(() => harness.assertRestored(sample(), {...next, ledger: {spentUSD: 0}}), /ledger/);
  const negative = {...sample(), counts: {updates: 1, revisions: 1}}; harness.assertNegative(negative);
  assert.throws(() => harness.assertNegative({...negative, taskStatus: 'review'}));
  assert.throws(() => harness.assertNegative({...negative, checks: [{kind: 'goal', passed: true}]}));
});
test('PKG-P1-01: cold and paused snapshots preserve the full pre-shutdown state', async t => {
  const previous = sample(), cold = structuredClone(previous); cold.modules.pid = 101;
  harness.assertRestored(previous, cold); harness.assertPausedPreserved(previous, cold);
  const mutations = [
    ['claim', s => s.episodes.basis.pendingCheck.claimId = 'new-claim'],
    ['generation', s => s.episodes.basis.pendingCheck.generationAttemptId = 'new-generation'],
    ['active task', s => s.activeTaskId = s.continuation.activeTaskId = 'other-task'],
    ['active basis', s => { s.episodes.other = structuredClone(s.episodes.basis); s.activeBasis = s.continuation.activeBasis = 'other'; }],
    ['episode owner', s => s.episodes.basis.taskId = 'other-task'],
    ['pending owner', s => s.episodes.basis.pendingCheck.ownerEpisodeId = 'other-basis'],
    ['artifact', s => s.episodes.basis.pendingCheck.artifactId = 'other-artifact'],
    ...['taskId', 'artifactHash', 'inputBasis', 'checkBasis', 'intentBasis', 'checkPhase', 'claimedByRunId', 'claimedAt']
      .map(key => ['pending ' + key, s => s.episodes.basis.pendingCheck[key] = 'changed']),
    ['claim history', s => s.episodes.basis.pendingCheck.claimHistory = []],
    ['old request proof', s => s.episodes.basis.pendingCheck.claimHistory[0].interruption.requestProof = []],
    ['current request proof', s => s.episodes.basis.pendingCheck.interruption.requestProof = []],
    ['cycles', s => s.episodes.basis.cycles = 0],
    ['hops', s => s.episodes.basis.hops = 0],
    ['executions', s => s.episodes.basis.executions = 0],
    ['prior episode', s => delete s.episodes.earlier],
    ['continuation metadata', s => s.continuation.migrations = {}],
    ['attempts', s => s.efficiency.attempts = 0],
    ['tried', s => s.efficiency.tried = {}],
    ['history', s => s.efficiency.history = []],
    ['reading', s => s.efficiency.reading = {}],
    ['episode reading receipt', s => s.episodes.basis.readingResumes = {}],
    ['reads', s => s.reads = {}],
    ['bounded check', s => s.contextFinalizations = {}],
    ['legacy counters', s => s.legacyCounters.attempts = 0],
    ['missing full continuation', s => delete s.continuation],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const changed = structuredClone(cold); mutate(changed);
    assert.throws(() => harness.assertRestored(previous, changed), undefined, 'cold ' + name);
    assert.throws(() => harness.assertPausedPreserved(previous, changed), undefined, 'paused ' + name);
  });
});
test('PKG-P1-01: final settlement stays anchored to the original receipt while progress diagnostics may reset', async t => {
  const previous = sample(), final = resumed(previous);
  harness.assertResumedOriginal(previous, final);
  const mutations = [
    ...['claimId', 'generationAttemptId', 'ownerEpisodeId', 'taskId', 'intentBasis', 'artifactId', 'artifactHash',
      'inputBasis', 'checkBasis', 'agentRunId', 'stepId', 'taskWorkRevision', 'createdAt'].map(key =>
      [key, s => s.episodes.basis.pendingCheck[key] = 'changed']),
    ['episode identity', s => s.episodes.basis.basis = 'changed'],
    ['episode owner', s => s.episodes.basis.taskId = 'changed'],
    ['episode intent', s => s.episodes.basis.intentBasis = 'changed'],
    ['owner selection', s => s.activeTaskId = s.continuation.activeTaskId = 'changed'],
    ['cycles', s => s.episodes.basis.cycles = 0],
    ['hops', s => s.episodes.basis.hops = 0],
    ['claim history deletion', s => s.episodes.basis.pendingCheck.claimHistory.shift()],
    ['claim history rewrite', s => s.episodes.basis.pendingCheck.claimHistory[0].claimedAt = 'changed'],
    ['pre-shutdown claim missing', s => s.episodes.basis.pendingCheck.claimHistory.pop()],
    ['pre-shutdown request changed', s => s.episodes.basis.pendingCheck.claimHistory[1].interruption.requestProof = []],
    ['regenerated draft', s => s.counts.revisions++],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const changed = structuredClone(final); mutate(changed);
    assert.throws(() => harness.assertResumedOriginal(previous, changed), undefined, name);
  });
  const corruptHeld = structuredClone(previous);
  corruptHeld.episodes.basis.pendingCheck.claimId = 'replacement-claim';
  const selfConsistent = resumed(corruptHeld);
  harness.assertResumedOriginal(corruptHeld, selfConsistent);
  assert.throws(() => harness.assertResumedOriginal(previous, selfConsistent), /identity changed/,
    'self-consistency against a corrupted cold held snapshot cannot redefine the original claim');
});
test('PKG-P1-01: actual snapshot includes complete continuation, reading and bounded finalization state', t => {
  const dir = temporary(t), asar = path.join(dir, 'synthetic.asar');
  for (const name of ['engine-worker', 'core', 'agent']) {
    const file = put(asar, 'desktop/' + name + '.cjs', 'module.exports = {};'); require(file);
    t.after(() => { delete require.cache[file]; });
  }
  const s = sample(), job = {id: s.jobId, executionState: {continuation: s.continuation, workEfficiency: s.efficiency, reads: s.reads}};
  const task = {id: s.taskId, contextFinalizations: s.contextFinalizations};
  const a = {data: {stewardship: {paused: true}, agentRuns: [], decisions: [], agentActions: []}, spendLedger: {scopes: {}}};
  const audit = {modelInputs: [], platformCalls: [], connectorCalls: [], events: []};
  const result = JSON.parse(JSON.stringify(harness.snapshot({a, job, task, audit}, {asar})));
  for (const key of ['continuation', 'episodes', 'efficiency', 'reads', 'contextFinalizations']) assert.deepEqual(result[key], s[key], key);
});
test('child environment strips inherited Node injection, model credentials and production profile configuration', t => {
  const env = harness.childEnvironment(temporary(t), '/tmp/config.json');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  for (const name of ['HOME', 'NODE_OPTIONS', 'NODE_PATH', 'OPENAI_API_KEY', 'HTTP_PROXY', 'ASSISTANT_TEST_DATA_DIR']) assert.ok(!(name in env));
});
test('isolation blocks actual transport entry points, subprocesses, source fallback, UI and out-of-tmp writes', t => {
  const dir = temporary(t), outside = put(path.dirname(dir), path.basename(dir) + '-outside', 'unchanged');
  t.after(() => fs.rmSync(outside, {force: true}));
  put(dir, 'app.asar', 'synthetic selected archive');
  const source = `const assert=require('node:assert/strict'),fs=require('node:fs');
    const h=require(${JSON.stringify(path.join(root, 'scripts/system-package-worker.cjs'))});
    h.installIsolation({dir:${JSON.stringify(dir)},asar:${JSON.stringify(path.join(dir, 'app.asar'))},phase:0});
    for(const call of [()=>fetch('https://invalid.test'),()=>require('node:net').connect(1),
      ()=>require('node:child_process').spawn('false'),()=>require('electron'),
      ()=>require(${JSON.stringify(path.join(root, 'desktop/core.cjs'))}),()=>fs.writeFileSync(${JSON.stringify(outside)},'changed')])
      assert.throws(call,/CONTROLLED_EXTERNAL_DENIED/);
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'allowed'))},'ok');`;
  const result = spawnSync(process.execPath, ['-e', source], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
  assert.equal(fs.readFileSync(path.join(dir, 'denied-0-0.jsonl'), 'utf8').trim().split('\n').length, 6);
});
test('missing final package yields unavailable/nonpassing evidence without launching any app', async t => {
  const dir = temporary(t), output = path.join(dir, 'report.json');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/system-package-worker.cjs'), '--app', path.join(dir, 'missing.app'), '--output', output, '--scenario', 'success'], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 1, result.stderr); const report = JSON.parse(fs.readFileSync(output));
  assert.equal(report.status, 'unavailable'); assert.equal(report.passed, false); assert.equal(report.layer, 'controlled');
  assert.deepEqual(report.phases, []); assert.equal(report.productionDelivery, 'not_verified');
});
test('output guards reject overwriting the app, source or existing evidence', async t => {
  const dir = temporary(t), app = path.join(dir, 'final.app'); fs.mkdirSync(app);
  const output = put(dir, 'existing.json', 'existing');
  for (const target of [output, path.join(app, 'report.json'), path.join(root, 'report.json')])
    await assert.rejects(harness.run({app, output: target, scenario: 'success'}));
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing');
  fs.symlinkSync(app, path.join(dir, 'app-link'));
  await assert.rejects(harness.run({app, output: path.join(dir, 'app-link/report.json'), scenario: 'success'}));
});
test('mechanism only: Electron Node mode loads a synthetic ASAR in an eval Worker with external preload, no App/runtime', async t => {
  const dir = temporary(t), electron = require('electron');
  const app = path.resolve(electron, '../../..');
  harness.readNodeFuses(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'));
  const synthetic = path.join(dir, 'synthetic'); put(synthetic, 'entry.cjs', "require('node:worker_threads').parentPort.postMessage({marker:require('@fixture/runtime').marker,preloaded:globalThis.probePreload===true,file:__filename});");
  put(synthetic, 'package.json', JSON.stringify({name:'synthetic-root',version:'1.0.0'}));
  put(synthetic, 'node_modules/@fixture/runtime/package.json', JSON.stringify({name:'@fixture/runtime',version:'1.0.0',main:'lib/index.cjs'}));
  put(synthetic, 'node_modules/@fixture/runtime/lib/index.cjs', "module.exports={marker:'synthetic-only'};");
  await require('@electron/asar').createPackage(synthetic, path.join(dir, 'probe.asar'));
  const harnessCopy = path.join(dir, 'harness.cjs'); fs.copyFileSync(path.join(root, 'scripts/system-package-worker.cjs'), harnessCopy);
  const isolation = `require(${JSON.stringify(harnessCopy)}).installIsolation(${JSON.stringify({dir, asar: path.join(dir, 'probe.asar'), phase: 0})});`;
  put(dir, 'preload.cjs', isolation + 'globalThis.probePreload=true;');
  const entry = path.join(dir, 'probe.asar/entry.cjs');
  const script = put(dir, 'probe.cjs', `const assert=require('node:assert/strict'),{Worker}=require('node:worker_threads');
    assert.ok(process.versions.electron);${isolation}const worker=new Worker('require(require("node:worker_threads").workerData.entry)',
      {eval:true,workerData:{entry:${JSON.stringify(entry)}},execArgv:['--require',${JSON.stringify(path.join(dir, 'preload.cjs'))}]});
    worker.on('message',m=>{assert.deepEqual(m,{marker:'synthetic-only',preloaded:true,file:${JSON.stringify(entry)}});console.log('synthetic-asar-worker-ok');});`);
  const result = spawnSync(electron, [script], {cwd: dir, env: harness.childEnvironment(dir, ''), encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /synthetic-asar-worker-ok/);
});

// The release runner supplies a frozen final .app. Contract tests above never
// impersonate this scenario ID. No package = no package test/pass claim.
if (process.env.SYSTEM_RELEASE_PACKAGE) test('package-worker-full-delivery', {timeout: 20 * 60 * 1000}, async t => {
  const output = process.env.SYSTEM_RELEASE_OUTPUT;
  assert.ok(output && path.isAbsolute(output), 'release output directory required');
  for (const scenario of harness.SCENARIOS) await t.test(scenario, async () => {
    const result = await harness.run({app: process.env.SYSTEM_RELEASE_PACKAGE,
      output: path.join(output, `package-worker-${scenario}.json`), scenario});
    assert.equal(result.status, 'passed', result.error || result.identityError);
    assert.equal(result.productionDelivery, 'not_verified'); assert.equal(result.userAccepted, false);
  });
});

test('storage scenario external fixture redirects every product dependency to selected final ASAR',()=>{
 const source=fs.readFileSync(path.join(root,'scripts/storage-method-worker-fixture.cjs'),'utf8'),desktop='/tmp/final.app/Contents/Resources/app.asar/desktop';
 const adapted=harness.adaptFixture(source,desktop,'/tmp/helper.cjs');new vm.Script(adapted);
 assert.doesNotMatch(adapted,/require\(['"]\.\./);assert.match(adapted,/app\.asar\/desktop\/platform-result\.cjs/);
 assert.equal(adapted,harness.redirectRequires(source,desktop,'/tmp/helper.cjs'));
 assert.ok(harness.SCENARIOS.includes('storage_method_recovery'));
});
test('storage package module proof follows the executing phase without preloading dormant code',()=>{
 const storage=['evidence-storage-method.cjs','evidence-recovery.cjs','platform-result.cjs','data-platform.cjs','access-policy-store.cjs'];
 const base=['engine-worker.cjs','core.cjs','agent.cjs'];
 for(const phase of [0,1,2,3])assert.deepEqual(harness.workerModuleNames({scenario:'storage_method_recovery',phase}),phase<=1?[...base,...storage]:base);
 for(const phase of [undefined,-1,4,1.5])assert.throws(()=>harness.workerModuleNames({scenario:'storage_method_recovery',phase}));
 assert.ok(harness.workerModuleNames({scenario:'context_authorization_repair',phase:3}).includes('check-finalization.cjs'));
});
test('storage package summary cannot omit actual query-stage module proof',async t=>{
 const asar='/tmp/selected.app/Contents/Resources/app.asar',names=['evidence-storage-method.cjs','evidence-recovery.cjs','platform-result.cjs','data-platform.cjs','access-policy-store.cjs'];
 const expected=names.map(name=>({path:'desktop/'+name,sha256:'a'.repeat(64)}));
 const sample=()=>[0,1,2,3].map(phase=>({result:{phase,pid:100+phase,status:'passed',final:{modules:{pid:100+phase,threadId:2,workerEntry:path.join(asar,'desktop/engine-worker.cjs'),modules:phase<=1?names.map(name=>({file:path.join(asar,'desktop',name),sha256:'a'.repeat(64)})):[]}}}}));
 harness.assertStorageModuleProof(sample(),asar,expected);
 for(const phase of [0,1])for(const name of names)await t.test('phase '+phase+' requires '+name,()=>{const p=sample();p[phase].result.final.modules.modules=p[phase].result.final.modules.modules.filter(row=>!row.file.endsWith('/'+name));assert.throws(()=>harness.assertStorageModuleProof(p,asar,expected));});
 for(const mutate of [p=>p[1].result.final.modules.workerEntry='/tmp/checkout/engine-worker.cjs',p=>p[1].result.final.modules.threadId=0,p=>p[1].result.final.modules.pid=100,p=>p[1].result.final.modules.modules[0].sha256='b'.repeat(64),p=>p[1].result.final.modules.modules[0].file='/tmp/checkout/evidence-storage-method.cjs']){const p=sample();mutate(p);assert.throws(()=>harness.assertStorageModuleProof(p,asar,expected));}
});
test('storage no-dispatch comparison allows only monotone in-ASAR diagnostic loading',()=>{
 const asar='/tmp/final.app/Contents/Resources/app.asar',file=path.join(asar,'desktop/engine-worker.cjs');
 const before={counts:{model:2,platform:1,updates:1},ledger:{spentUSD:5,heldUSD:1},primary:'draft',continuation:{claimId:'claim',cycles:3},modules:{pid:11,threadId:2,workerEntry:file,modules:[{file,sha256:'a'.repeat(64)}],loadedPackageModules:[file]}};
 const after=structuredClone(before);after.modules.loadedPackageModules.push(path.join(asar,'desktop/pending-check.cjs'));
 const original=JSON.stringify([before,after]);harness.assertStorageNoDispatch(before,after);assert.equal(JSON.stringify([before,after]),original);
 for(const mutate of [x=>x.counts.model++,x=>x.counts.platform++,x=>x.counts.updates++,x=>x.ledger.spentUSD++,x=>x.ledger.heldUSD++,x=>x.primary='other',x=>x.continuation.claimId='new',x=>x.continuation.cycles=0,x=>x.modules.pid++,x=>x.modules.threadId++,x=>x.modules.modules[0].sha256='b'.repeat(64),x=>x.modules.loadedPackageModules.shift(),x=>x.modules.loadedPackageModules.push('/tmp/checkout/foreign.cjs')]){
  const changed=structuredClone(after);mutate(changed);assert.throws(()=>harness.assertStorageNoDispatch(before,changed));
 }
});
