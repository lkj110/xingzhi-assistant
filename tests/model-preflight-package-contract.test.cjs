'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const h = require('../scripts/model-preflight-package-worker.cjs');
const root = path.resolve(__dirname, '..');
function temp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-preflight-contract-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir;
}
const clone = value => structuredClone(value);
const hash = 'a'.repeat(64);
function config() {
  return {asar: '/tmp/final.app/Contents/Resources/app.asar', mode: 'legacy', phase: 0, expectedVersion: '0.42.2',
    sourceDigest: hash, packageDigest: 'b'.repeat(64),
    desktopInputs: ['engine-client.cjs', ...h.REQUIRED].map(name => ({path: 'desktop/' + name, sha256: hash})),
    generated: [{file: '/tmp/harness/fixture.cjs', sha256: hash}]};
}
function proof(c, worker = true) {
  return {fromASAR: true, pid: 100, threadId: worker ? 1 : 0,
    ...(worker ? {workerEntry: path.join(c.asar, 'desktop/engine-worker.cjs')} : {}),
    modules: (worker ? h.REQUIRED : ['engine-client.cjs']).map(name => ({file: path.join(c.asar, 'desktop', name), sha256: hash})),
    externalModules: clone(c.generated)};
}
function failed(mode = 'legacy') {
  const request = {requestId: 'old-request', attempt: 1, runId: 'old-run', callId: 'old-call', spendTicketId: 'old-ticket',
    responseStatus: 'error', errorCode: 'MODEL_AUTH', usageReported: mode === 'native', ...(mode === 'native' ? {producerSchema: 2} : {})};
  const seed = {mode, seedPending: false, attemptId: 'old-attempt', requestId: request.requestId, request,
    callId: request.callId, oldRunId: request.runId, oldRunHash: hash};
  const s = {jobId: 'job', taskId: 'task', jobStatus: 'blocked', taskStatus: 'todo', autoAccept: false,
    acceptedAt: null, completedAt: null, primary: 'generic-original', runs: 1, modelCalls: 1,
    failedRun: {id: request.runId, status: 'blocked', finishedAt: '2026-10-18T12:00:00.000Z'}, failedRunHash: hash,
    failedCall: {id: request.callId, requestId: request.requestId, status: 'error', errorCode: 'MODEL_AUTH',
      estimatedUSD: mode === 'native' ? 0 : null, usageReported: mode === 'native', ...(mode === 'native' ? {producerSchema: 2,
        inputTokens: 0, outputTokens: 0, diagnostic: {kind: 'model_preflight', modelDispatched: false, stage: 'login_status'}} : {})},
    health: null,
    generic: {accepted: false, oldCycles: 1, originalCycles: 1, budget: {limitUSD: 200, spentUSD: 17, heldUSD: 0.1},
      primary: {id: 'generic-original'}, deliveries: [],
      audit: {violations: [], creates: 1, writes: 0, patches: [], checks: [], queries: ['leaf']},
      consumption: {receipts: [], attempts: {'old-attempt': {requests: [clone(request)]}}},
      preflight: {seed, oldRequests: [clone(request)], view: {candidate: true, native: mode === 'native', attested: mode === 'native', evidenceHash: hash}}}};
  return s;
}
function healthy(before, mode) {
  const s = clone(before);
  s.health = {status: 'success', installed: true, loggedIn: true, checkId: 'health', cliHash: hash, configurationHash: hash, intentHash: hash,
    startedAt: '2026-10-18T12:00:01.000Z', finishedAt: '2026-10-18T12:00:02.000Z', expiresAt: '2026-10-18T12:10:01.000Z'};
  s.generic.preflight.candidate = {eligible: true}; s.generic.preflight.view.attested = true;
  if (mode === 'legacy') s.generic.consumption.attempts['old-attempt'].modelPreflightAttestation = {
    executedBy: 'supervisor', evidenceHash: hash, authorizationNote: 'controlled contract test'};
  return s;
}
function recovered(before, mode) {
  const s = healthy(before, mode), seed = before.generic.preflight.seed, p = s.generic.consumption.attempts[seed.attemptId];
  p.status = 'committed';
  const next = {requestId: 'new-request', attempt: 1, runId: 'new-run', callId: 'new-call', spendTicketId: 'new-ticket',
    producerSchema: 2, responseStatus: 'done', usageReported: true};
  p.requests.push(next);
  p.modelPreflightRecovery = {status: 'terminal', attemptId: seed.attemptId, proof: {mode, oldRunId: seed.oldRunId, originalRequest: clone(seed.request)},
    claim: clone(next), terminal: {status: 'done', callId: next.callId}, health: clone(s.health)};
  s.generic.consumption.receipts.push({attemptId: seed.attemptId}); return s;
}

test('CLI is the two-option release-plan contract, with no scenario or source fallback', () => {
  const good = ['--app', '/tmp/final.app', '--output', '/tmp/result.json'];
  assert.deepEqual(h.parseArgs(good), {app: '/tmp/final.app', output: '/tmp/result.json'});
  for (const args of [[], ['--app', 'relative.app', '--output', '/tmp/r.json'], ['--app', '/tmp/final.app', '--output', 'r.json'],
    ['--app', '/tmp/final.app', '--output', '/tmp/r'], good.concat('--scenario', 'legacy'), good.concat('--source', root),
    good.concat('--app', '/tmp/other.app'), good.slice(0, -1)]) assert.throws(() => h.parseArgs(args));
});

test('output cannot overwrite the app, source, existing reports or a symlink into either input', t => {
  const dir = temp(t), app = path.join(dir, 'final.app'); fs.mkdirSync(app);
  const output = path.join(dir, 'result.json');
  assert.equal(h.outputPath({app, output}).output, output);
  fs.symlinkSync(app, path.join(dir, 'alias'));
  for (const file of [path.join(app, 'report.json'), path.join(dir, 'alias/report.json'), path.join(root, 'new-report.json'),
    path.join(dir, 'Library/Application Support/report.json')]) assert.throws(() => h.outputPath({app, output: file}));
  fs.writeFileSync(output, 'keep'); assert.throws(() => h.outputPath({app, output}), /already exists/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep');
});

test('all four external fixtures redirect literal application imports only to the selected ASAR', () => {
  const desktop = '/tmp/final.app/Contents/Resources/app.asar/desktop';
  const helpers = {common: '/tmp/harness/common.cjs', platform: '/tmp/harness/platform.cjs', physical: '/tmp/harness/physical.cjs'};
  for (const name of h.FIXTURES) {
    const source = fs.readFileSync(path.join(root, name), 'utf8'), adapted = h.adaptFixture(source, desktop, helpers);
    new vm.Script(adapted);
    assert.doesNotMatch(adapted, /require\(['"]\./); assert.ok(!adapted.includes(root));
    assert.throws(() => h.adaptFixture(source + "\nrequire('../active-desktop.cjs')", desktop, helpers), /unreviewed/);
  }
  const top = h.adaptFixture(fs.readFileSync(path.join(root, h.FIXTURES[0]), 'utf8'), desktop, helpers);
  assert.ok(top.includes(JSON.stringify(helpers.common)));
  for (const name of ['subscription.cjs', 'model-preflight-recovery.cjs', 'execution-policy.cjs'])
    assert.ok(top.includes(JSON.stringify(path.join(desktop, name))));
});

test('actual module proof rejects each missing module, checkout fallback, wrong hashes and non-Worker evidence', () => {
  const c = config(), p = proof(c); h.assertModuleProof(p, c, h.REQUIRED, true, 100);
  for (const name of h.REQUIRED) {
    const bad = clone(p); bad.modules = bad.modules.filter(row => row.file !== path.join(c.asar, 'desktop', name));
    assert.throws(() => h.assertModuleProof(bad, c, h.REQUIRED, true, 100), /missing actual ASAR load/);
  }
  for (const change of [p => p.fromASAR = false, p => p.threadId = 0, p => p.pid++, p => p.workerEntry = '/tmp/source/desktop/engine-worker.cjs',
    p => p.modules[0].file = '/tmp/source/desktop/core.cjs', p => p.modules[0].sha256 = 'c'.repeat(64),
    p => p.modules.push({file: path.join(c.asar, 'desktop/main.cjs'), sha256: hash}),
    p => p.externalModules.push({file: '/tmp/source/desktop/core.cjs', sha256: hash}), p => p.externalModules[0].sha256 = 'd'.repeat(64)]) {
    const bad = clone(p); change(bad); assert.throws(() => h.assertModuleProof(bad, c, h.REQUIRED, true, 100));
  }
});

test('phase evidence must include actual Electron exit, guards, all stages, complete matching inputs and close', () => {
  const c = config(), p = proof(c), execution = {code: 0, pid: 100};
  const state = {generic: {threadId: 1}, isolation: {installed: true, pid: 100, threadId: 1}, modules: p};
  const result = {status: 'passed', pid: 100, mode: c.mode, phase: 0, versions: {electron: 'controlled-contract'},
    sourceDigest: c.sourceDigest, packageDigest: c.packageDigest, packageVersion: c.expectedVersion,
    isolation: {installed: true, pid: 100, threadId: 0}, backgroundErrors: [], closed: true, commands: [{action: 'controlledPreflightRun', input: {}}],
    packageSourceMatch: c.desktopInputs.map(row => row.path), mainModules: proof(c, false), states: [{stage: 'failed', state}], final: state};
  h.assertPhase(result, execution, c);
  assert.throws(() => h.assertPhase(result, execution, {...c, expectedVersion: '0.42.1'}));
  assert.throws(() => h.assertPhase(result, execution, {...c, expectedVersion: undefined}));
  for (const change of [r => r.states = [], r => r.states[0].stage = 'verified_delivery', r => r.closed = false,
    r => r.versions = {}, r => r.isolation.installed = false, r => r.states[0].state.isolation.threadId = 0,
    r => r.backgroundErrors.push({error: 'background failed'}), r => r.commands = [], r => r.sourceDigest = 'changed', r => r.packageDigest = 'changed',
    r => r.packageSourceMatch.pop(), r => r.packageVersion = '0.42.0', r => r.final = null, r => r.status = 'failed']) {
    const bad = clone(result); change(bad); assert.throws(() => h.assertPhase(bad, execution, c));
  }
  for (const e of [{code: 1, pid: 100}, {code: 0, pid: 101}, {code: 0, pid: 100, timedOut: true}, {code: 0, pid: 100, signal: 'SIGKILL'}])
    assert.throws(() => h.assertPhase(result, e, c));
  assert.throws(() => h.assertPhase(null, execution, c));
});

test('cold restoration requires a distinct Electron process and preserves history, health, receipts and counters', () => {
  const before = recovered(failed('legacy'), 'legacy');
  before.modules = {pid: 100, threadId: 1}; before.generic.threadId = 1;
  const next = clone(before); next.modules.pid = 101; next.modules.threadId = 2; next.generic.threadId = 2;
  h.assertCold(before, next);
  for (const change of [s => s.modules.pid = 100, s => s.runs++, s => s.modelCalls++, s => s.failedRun.status = 'ready',
    s => s.failedCall.requestId = 'changed', s => s.health.checkId = 'new-health', s => s.generic.budget.spentUSD = 0,
    s => s.generic.consumption.receipts = [], s => s.generic.audit.writes++]) {
    const bad = clone(next); change(bad); assert.throws(() => h.assertCold(before, bad));
  }
});

for (const mode of ['legacy', 'native']) {
  test(mode + ' requires actual failed old request, cold-safe history and a health-only trusted transition', () => {
    const initial = failed(mode); h.assertFailed(initial, mode);
    const next = healthy(initial, mode); h.assertHealth(next, initial, mode);
    for (const change of [s => s.generic.audit.patches.push({}), s => s.generic.audit.writes++, s => s.generic.audit.checks.push('content'),
      s => s.generic.preflight.oldRequests = [], s => s.failedRunHash = 'changed', s => s.generic.preflight.view.candidate = false,
      s => s.generic.preflight.seed.seedPending = true, s => s.failedCall.usageReported = !s.failedCall.usageReported]) {
      const bad = clone(initial); change(bad); assert.throws(() => h.assertFailed(bad, mode));
    }
    for (const change of [s => s.health = null, s => s.health.status = 'pending', s => s.health.installed = false,
      s => s.health.startedAt = initial.failedRun.finishedAt, s => s.health.configurationHash = null,
      s => s.modelCalls++, s => s.generic.budget.spentUSD++, s => s.generic.preflight.candidate.eligible = false,
      s => s.generic.consumption.attempts['old-attempt'].modelPreflightRecovery = {}]) {
      const bad = clone(next); change(bad); assert.throws(() => h.assertHealth(bad, initial, mode));
    }
  });
  test(mode + ' recovery binds one terminal claim and receipt to the old attempt without rewriting history/budget', () => {
    const initial = failed(mode), s = recovered(initial, mode), seed = initial.generic.preflight.seed, budget = initial.generic.budget;
    const verify = value => h.assertRecovered(value, seed, budget, mode, s.health);
    verify(s);
    for (const change of [s => s.generic.preflight.oldRequests.push({}), s => s.generic.budget.heldUSD++, s => s.generic.budget.limitUSD++,
      s => s.generic.budget.spentUSD = 0, s => s.acceptedAt = 'now', s => s.failedRunHash = 'changed',
      s => s.generic.consumption.receipts[0].attemptId = 'new-attempt', s => s.generic.consumption.attempts['old-attempt'].requests.push({}),
      s => s.generic.consumption.attempts['old-attempt'].requests[1].spendTicketId = 'old-ticket',
      s => s.generic.consumption.attempts['old-attempt'].modelPreflightRecovery.status = 'prepared',
      s => s.generic.consumption.attempts['old-attempt'].modelPreflightRecovery.health.checkId = 'other',
      s => s.generic.consumption.attempts.extra = {modelPreflightRecovery: {}}]) {
      const bad = clone(s); change(bad); assert.throws(() => verify(bad));
    }
  });
}

test('shared isolation blocks source reads/imports, real transports, subprocesses, UI and external writes', t => {
  const dir = temp(t), asar = path.join(dir, 'app.asar'); fs.mkdirSync(asar);
  const externalDir = temp(t), outside = path.join(externalDir, 'private.cjs'); fs.writeFileSync(outside, 'module.exports=42');
  const code = `const assert=require('node:assert/strict'),fs=require('node:fs');
    require(${JSON.stringify(path.join(root, 'scripts/model-preflight-package-worker.cjs'))}).installIsolation(${JSON.stringify({dir, asar, phase: 0})});
    for(const action of [()=>fetch('https://fixture.invalid'),()=>require('node:net').connect(443,'fixture.invalid'),
      ()=>require('node:child_process').spawn('false'),()=>require('electron'),()=>require(${JSON.stringify(outside)}),
      ()=>fs.readFileSync(${JSON.stringify(outside)}),()=>fs.writeFileSync(${JSON.stringify(outside)},'changed')])assert.throws(action,/CONTROLLED_EXTERNAL_DENIED/);
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'allowed'))},'temporary');`;
  const result = spawnSync(process.execPath, ['-e', code], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(outside, 'utf8'), 'module.exports=42');
  assert.equal(fs.readFileSync(path.join(dir, 'allowed'), 'utf8'), 'temporary');
});

test('missing final package fails nonzero and still exports an independent absolute evidence directory', t => {
  const dir = temp(t), output = path.join(dir, 'result.json'), app = path.join(dir, 'missing.app');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/model-preflight-package-worker.cjs'), '--app', app, '--output', output],
    {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.passed, false); assert.equal(report.layer, 'controlled'); assert.equal(report.realBusinessCalls, 0);
  assert.ok(path.isAbsolute(report.evidence)); assert.ok(!report.evidence.startsWith(dir + path.sep));
  assert.ok(fs.existsSync(path.join(report.evidence, 'summary.json'))); assert.ok(report.evidenceFiles.length);
  assert.equal(report.sourceDigest, report.afterSourceDigest); assert.equal(report.phases.length, 0);
  t.after(() => fs.rmSync(report.evidence, {recursive: true, force: true}));
});

 test('legacy seed eligibility is mandatory after cold restore, never inferred from the pre-cold adapter',()=>{
  const initial=failed('legacy');initial.generic.preflight.view=null;
  h.assertFailed(initial,'legacy',{cold:false});assert.throws(()=>h.assertFailed(initial,'legacy'));
  for(const change of [s=>s.generic.audit.writes++,s=>s.generic.audit.patches.push({}),s=>s.generic.preflight.grant={}]){const bad=clone(initial);change(bad);assert.throws(()=>h.assertFailed(bad,'legacy',{cold:false}));}
  const native=failed('native');native.generic.preflight.view=null;assert.throws(()=>h.assertFailed(native,'native',{cold:false}));
 });

test('cold compares persisted preflight history while stage checks validate recomputed readiness',()=>{
 const before=failed('legacy');before.modules={pid:100,threadId:1};before.generic.threadId=1;const next=clone(before);next.modules.pid=101;next.generic.preflight.view=null;next.generic.preflight.candidate={eligible:false,reason:'MODEL_PREFLIGHT_PROOF_INVALID'};next.generic.preflight.policy={state:'recomputed'};h.assertCold(before,next);
 assert.throws(()=>h.assertFailed(next,'legacy'));
 for(const change of [s=>s.generic.preflight.seed.oldRunId='other',s=>s.generic.preflight.oldRequests=[],s=>s.generic.preflight.grant={status:'claimed'}]){const bad=clone(next);change(bad);assert.throws(()=>h.assertCold(before,bad));}
});

test('preflight first revision requires exact leaf-tail acquisition with one original-draft receipt',()=>{
 const s=recovered(failed('legacy'),'legacy');s.modules={pid:100,threadId:1};s.generic.threadId=1;s.jobStatus='ready';s.primary='revised';s.generic.primary={id:'revised',primaryLineageId:'generic-original',draftOnly:true};s.modelCalls=2;s.generic.audit.patches=[{}];s.generic.audit.queries=['leaf','tail'];Object.assign(s.generic.consumption.receipts[0],{artifactId:'revised',baseArtifactId:'generic-original'});h.assertPreflightCheckpoint(s);
 for(const change of [v=>v.generic.audit.queries=['leaf'],v=>v.generic.audit.queries.push('unrelated'),v=>v.generic.audit.patches.push({}),v=>v.generic.audit.writes++,v=>v.generic.consumption.receipts[0].baseArtifactId='other']){const bad=clone(s);change(bad);assert.throws(()=>h.assertPreflightCheckpoint(bad));}
});
