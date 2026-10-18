'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const metrics = require('../scripts/iteration-metrics.cjs');
const scripts = path.resolve(__dirname, '../scripts');
const cli = path.join(scripts, 'iteration-metrics.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const put = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value); };
const json = (file, value) => put(file, JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stamp = seconds => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const errorCode = code => error => error.code === code;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iteration-metrics-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dir = path.join(root, 'ledger');
  const receipt = path.join(root, 'synthetic-evidence.txt'); put(receipt, 'isolated test evidence, not a real cost receipt\n');
  const evidence = [{path: receipt, sha256: sha(fs.readFileSync(receipt))}];
  const init = {dir, iterationId: 'iteration-fixture', actor: 'author', occurredAt: stamp(0)};
  metrics.init(init);
  function event(type, eventId, payload, at = 1, extra = {}) {
    return {eventId, type, occurredAt: stamp(at), actor: 'author', origin: 'observed', payload, evidence, ...extra};
  }
  const record = e => metrics.record({dir, event: e});
  const result = (id, candidateId, status = 'failed', at = 1, classification = 'test') =>
    event('candidate_result', id, {candidateId, attemptId: id, status, classification}, at);
  const invalidate = (id, candidateId, at) => event('candidate_invalidated', id,
    {candidateId, decidedBy: 'author', decision: 'invalidate', reason: 'explicit fixture integrator decision'}, at);
  const cost = (id, measurementId, status, amount, at = 1) => event('cost', id,
    {measurementId, status, amount, provider: 'fixture-provider', model: 'fixture-model', currency: 'USD',
      inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, inputIncludesCached: true,
      basis: 'synthetic test receipt only', ...(status === 'unknown' ? {reason: 'no actual billing receipt'} : {})}, at);
  const correct = (id, old, replacement, at = 10) => {
    const value = replacement && {...replacement};
    if (value) { delete value.eventId; delete value.recordedAt; }
    return event('correction', id, {targetEventId: old.eventId, reason: 'new fixture evidence', replacement: value}, at);
  };
  return {root, dir, evidence, init, event, record, result, invalidate, cost, correct, report: () => metrics.report({dir})};
}

test('MET01: init uses the same complete semantic idempotence as record', t => {
  const f = fixture(t), bytes = fs.readFileSync(path.join(f.dir, 'events', '000000000001.json'));
  const original = metrics.init(f.init); assert.equal(original.duplicate, true);
  assert.equal(f.record({...original.event, origin: 'imported', recordedAt: stamp(100)}).duplicate, true);
  for (const change of [{actor: 'release-runner'}, {occurredAt: stamp(100)}]) {
    assert.throws(() => metrics.init({...f.init, ...change}), errorCode('METRICS_CONFLICT'));
    assert.throws(() => f.record({...original.event, ...change}), errorCode('METRICS_CONFLICT'));
  }
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events', '000000000001.json')), bytes);
  assert.equal(f.report().iteration.startedAt, stamp(0));
  assert.equal(f.report().eventCount, 1);
  assert.throws(() => metrics.init({...f.init, iterationId: 'other'}), errorCode('METRICS_CONFLICT'));
  const dirty = path.join(f.root, 'dirty'); put(path.join(dirty, 'keep'), 'do not reset');
  assert.throws(() => metrics.init({...f.init, dir: dirty}), errorCode('METRICS_STORAGE'));
  assert.equal(fs.readFileSync(path.join(dirty, 'keep'), 'utf8'), 'do not reset');
});

test('idempotence checks complete semantics, allowing only collection origin and recordedAt to differ', t => {
  const f = fixture(t), original = f.event('defect', 'd1', {defectId: 'D1', severity: 'P1', stage: 'pre_release', rootCauseId: 'R1'});
  const saved = f.record(original), filesBefore = fs.readdirSync(path.join(f.dir, 'events'));
  assert.equal(f.record({...original, origin: 'imported', recordedAt: stamp(500)}).duplicate, true);
  assert.equal(f.record({...original, payload: {rootCauseId: 'R1', stage: 'pre_release', severity: 'P1', defectId: 'D1'}}).event.recordedAt, saved.event.recordedAt);
  for (const change of [
    {occurredAt: stamp(2)}, {actor: 'another-author'},
    {payload: {...original.payload, severity: 'P2'}},
    {evidence: [{...f.evidence[0], sha256: 'f'.repeat(64)}]},
    {evidence: [{...f.evidence[0], path: path.join(f.root, 'different')}]}
  ]) assert.throws(() => f.record({...original, ...change}), errorCode('METRICS_CONFLICT'));
  const p = {phaseId: 'same', phase: 'review'};
  f.record(f.event('phase_started', 'phase', p, 3));
  assert.throws(() => f.record(f.event('phase_ended', 'phase', p, 3)), errorCode('METRICS_CONFLICT'));
  assert.equal(fs.readdirSync(path.join(f.dir, 'events')).length, filesBefore.length + 1);
});

test('two failures then pass on one candidate: failed attempts=2, candidate rework=0', t => {
  const f = fixture(t);
  f.record(f.result('run1', 'C1', 'failed', 1));
  f.record(f.result('run2', 'C1', 'failed', 2, 'environment'));
  f.record(f.result('run3', 'C1', 'passed', 3));
  const r = f.report();
  assert.equal(r.attempts.failed, 2); assert.equal(r.attempts.count, 3);
  assert.equal(r.candidates.invalidated, 0); assert.deepEqual(r.warnings, []);
  assert.equal(r.attempts.byClassification.test, 1); assert.equal(r.attempts.byClassification.environment, 1);
});

test('many failed groups and repeated decisions count one invalidated candidate', t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) f.record(f.result('group' + i, 'C1', 'failed', i));
  f.record(f.invalidate('decision1', 'C1', 4)); f.record(f.invalidate('decision2', 'C1', 5));
  assert.equal(f.report().attempts.failed, 3); assert.equal(f.report().candidates.invalidated, 1);
  assert.equal(f.report().candidates.consecutiveInvalidated, 1);
  const invalid = f.invalidate('bad', 'C2', 6);
  for (const modified of [{...invalid, evidence: []}, {...invalid, actor: 'not-integrator'},
    {...invalid, payload: {...invalid.payload, decision: 'failed'}}]) assert.throws(() => f.record(modified));
});

test('MET03: attempt successes never clear consecutive candidate invalidations', t => {
  const f = fixture(t);
  f.record(f.result('old-pass', 'old', 'passed', 1));
  f.record(f.invalidate('i1', 'C1', 2));
  f.record(f.result('ordinary-red', 'C1', 'failed', 3));
  f.record(f.invalidate('i2', 'C2', 4));
  f.record(f.result('old-repass', 'old', 'passed', 5));
  f.record(f.result('invalid-repass', 'C2', 'passed', 6));
  assert.equal(f.report().candidates.convergenceReviewRequired, true);
  assert.equal(f.report().warnings.length, 1);
  f.record(f.result('new-pass', 'C3', 'passed', 7));
  assert.equal(f.report().candidates.convergenceReviewRequired, true);
  assert.equal(f.report().candidates.consecutiveInvalidated, 2);
  f.record(f.invalidate('i3', 'C3', 8));
  assert.equal(f.report().candidates.consecutiveInvalidated, 3);
  assert.equal(f.report().warnings.length, 1, 'historical prompt is retained');
  assert.equal(f.report().candidates.invalidated, 3);
});

test('corrections preserve old bytes, support chained revisions, and reject missing, branching, circular and changed-type targets', t => {
  const f = fixture(t), old = f.event('defect', 'defect', {defectId: 'D', severity: 'P1', stage: 'pre_release', rootCauseId: 'R'});
  f.record(old);
  const file = path.join(f.dir, 'events', '000000000002.json'), bytes = fs.readFileSync(file);
  const replacement = {...old, payload: {...old.payload, severity: 'P2'}};
  const c1 = f.correct('c1', old, replacement); f.record(c1);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(f.report().defects.bySeverity.P2, 1);
  assert.throws(() => f.record(f.correct('branch', old, replacement)), errorCode('METRICS_CORRECTION'));
  assert.throws(() => f.record(f.correct('self', {eventId: 'self'}, replacement)), errorCode('METRICS_CORRECTION'));
  assert.throws(() => f.record(f.correct('missing', {eventId: 'never'}, replacement)), errorCode('METRICS_CORRECTION'));
  assert.throws(() => f.record(f.correct('type', c1, f.result('x', 'C'))), errorCode('METRICS_CORRECTION'));
  const c2 = f.correct('c2', c1, {...replacement, payload: {...replacement.payload, severity: 'P3'}}); f.record(c2);
  assert.equal(f.report().defects.bySeverity.P3, 1);
  const retraction = f.correct('retract', c2, null); f.record(retraction); assert.equal(f.report().defects.count, 0);
  f.record(f.correct('restore', retraction, replacement)); assert.equal(f.report().defects.bySeverity.P2, 1);
  assert.equal(f.report().eventCount, 6);
});

test('defects count unique IDs, severity and pre/post release separately, and expose repeated root causes', t => {
  const f = fixture(t), d = f.event('defect', 'one', {defectId: 'D1', severity: 'P0', stage: 'pre_release', rootCauseId: '__proto__'});
  f.record(d); f.record({...d, eventId: 'duplicate-observation'});
  f.record(f.event('defect', 'two', {defectId: 'D2', severity: 'P2', stage: 'post_release', rootCauseId: '__proto__'}, 2));
  const r = f.report().defects;
  assert.equal(r.count, 2); assert.equal(r.preRelease, 1); assert.equal(r.postRelease, 1);
  assert.deepEqual(r.recurringRootCauses, [{rootCauseId: '__proto__', defectIds: ['D1', 'D2']}]);
});

test('actual, estimated and unknown costs stay distinct; corrected late receipts replace rather than add', t => {
  const f = fixture(t), absent = f.cost('unknown', 'subscription', 'unknown', null);
  f.record(absent); const estimate = f.cost('estimate', 'api', 'estimated', 2); f.record(estimate);
  let r = f.report().costs;
  assert.equal(r.actualUSD, 0); assert.equal(r.estimatedUSD, 2); assert.equal(r.totalUSD, null); assert.equal(r.unknownCount, 1);
  f.record(f.correct('actual-subscription', absent, f.cost('x', 'subscription', 'actual', 3)));
  f.record(f.correct('actual-api', estimate, f.cost('x', 'api', 'actual', 1.5)));
  r = f.report().costs;
  assert.equal(r.actualUSD, 4.5); assert.equal(r.estimatedUSD, 0); assert.equal(r.totalUSD, 4.5);
  assert.equal(r.unknownCount, 0); assert.equal(r.measurements.length, 2);
  const lateEstimate = f.cost('unexpected-estimate', 'api', 'estimated', 5);
  assert.throws(() => f.record(lateEstimate), errorCode('METRICS_CONFLICT'));
});

test('MET02: duplicate measurements share one correction history without reviving old estimates', t => {
  const f = fixture(t), a = f.cost('estimate-A', 'M', 'estimated', 2), b = {...a, eventId: 'estimate-B'};
  f.record(a); f.record(b);
  const files = ['000000000002.json', '000000000003.json'].map(name => path.join(f.dir, 'events', name));
  const bytes = files.map(file => fs.readFileSync(file));
  assert.equal(f.report().costs.measurements.length, 1);
  const actual = f.correct('actual', a, f.cost('unused', 'M', 'actual', 1));
  f.record(actual); assert.equal(f.record(actual).duplicate, true);
  let r = f.report().costs;
  assert.equal(r.actualUSD, 1); assert.equal(r.estimatedUSD, 0); assert.equal(r.measurements.length, 1);
  assert.equal(f.record(b).duplicate, true, 'replaying the old event does not revive it');
  assert.throws(() => f.record(f.correct('stale-branch', b, f.cost('unused', 'M', 'actual', 8))), errorCode('METRICS_CORRECTION'));
  assert.throws(() => f.record({...a, eventId: 'late-old-estimate'}), errorCode('METRICS_CONFLICT'));
  const next = f.correct('actual-revised', actual, f.cost('unused', 'M', 'actual', 0.5)); f.record(next);
  r = f.report().costs; assert.equal(r.actualUSD, 0.5); assert.equal(r.estimatedUSD, 0); assert.equal(r.measurements.length, 1);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]));
  const second = f.cost('alias-first', 'M2', 'estimated', 2); f.record(second);
  const alias = {...second, eventId: 'alias-second'}; f.record(alias);
  f.record(f.correct('alias-corrected', alias, f.cost('unused', 'M2', 'actual', 1)));
  assert.equal(f.report().costs.actualUSD, 1.5, 'either alias of the current revision can be corrected');
  assert.throws(() => f.record(f.correct('fork', second, f.cost('unused', 'M2', 'actual', 9))), errorCode('METRICS_CORRECTION'));
});

test('measurement IDs deduplicate, inclusive cached input is never added twice, exclusive counts add once', t => {
  const f = fixture(t), a = f.cost('one', 'M1', 'actual', 1);
  f.record(a); f.record({...a, eventId: 'same-measurement'});
  const b = f.cost('two', 'M2', 'estimated', 0); b.payload.inputIncludesCached = false; f.record(b);
  const r = f.report().costs;
  assert.equal(r.actualUSD, 1); assert.equal(r.measurements.length, 2); assert.equal(r.totalStatus, 'estimated');
  assert.deepEqual(r.measurements.map(c => c.totalInputTokens), [100, 140]);
  const bad = f.cost('bad', 'M3', 'actual', 2); bad.payload.cachedInputTokens = 101;
  assert.throws(() => f.record(bad), /cached tokens/);
  assert.throws(() => f.record({...a, eventId: 'no-receipt', evidence: []}), /requires receipt/);
  assert.throws(() => f.record({...a, eventId: 'bad-hash', evidence: [{...f.evidence[0], sha256: '0'.repeat(64)}]}), errorCode('METRICS_EVIDENCE'));
  assert.throws(() => f.record(f.cost('unknown-with-zero', 'M4', 'unknown', 0)), /unknown cost cannot/);
});

test('uncollected costs remain unknown, not zero, including report markdown', t => {
  const f = fixture(t), r = f.report();
  assert.equal(r.costs.totalUSD, null); assert.equal(r.costs.totalStatus, 'unknown'); assert.equal(r.costs.unknownCount, 1);
  assert.match(r.markdown, /total unknown/); assert.equal(metrics.markdown(r), r.markdown);
  const unknown = f.cost('unmetered', 'subscription', 'unknown', null);
  Object.assign(unknown.payload, {inputTokens: null, cachedInputTokens: null, outputTokens: null, inputIncludesCached: null});
  f.record(unknown);
  assert.equal(f.report().costs.measurements[0].totalInputTokens, null);
  assert.equal(f.report().costs.totalUSD, null);
});

test('parallel phase durations are separate from wall-clock; unfinished and uncertain phases are explicit', t => {
  const f = fixture(t);
  for (const id of ['a', 'b']) f.record(f.event('phase_started', id + '-start', {phaseId: id, phase: 'implementation'}, 1, {actor: id}));
  for (const id of ['a', 'b']) f.record(f.event('phase_ended', id + '-end', {phaseId: id, phase: 'implementation'}, 11, {actor: id}));
  f.record(f.event('phase_started', 'open', {phaseId: 'open', phase: 'review'}, 12));
  const unknown = {phaseId: 'unknown', phase: 'design', timing: 'unknown', reason: 'source only gives collection dates'};
  f.record(f.event('phase_started', 'u-start', unknown, 1)); f.record(f.event('phase_ended', 'u-end', unknown, 10));
  f.record(f.event('iteration_closed', 'closed', {iterationId: f.init.iterationId}, 15));
  const r = f.report();
  assert.equal(r.iteration.wallClockMs, 15000);
  assert.deepEqual(r.phases.filter(p => ['a', 'b'].includes(p.phaseId)).map(p => p.durationMs), [10000, 10000]);
  assert.equal(r.phases.find(p => p.phaseId === 'open').status, 'ongoing');
  assert.equal(r.phases.find(p => p.phaseId === 'unknown').durationMs, null);
  assert.equal(own(r, 'totalPhaseDurationMs'), false);
});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test('broken phase timelines, duplicate phase facts and invalid event input fail without appending', t => {
  const f = fixture(t), p = {phaseId: 'phase', phase: 'review'};
  assert.throws(() => f.record(f.event('phase_ended', 'end', p)), errorCode('METRICS_TIMELINE'));
  f.record(f.event('phase_started', 'start', p, 5));
  assert.throws(() => f.record(f.event('phase_ended', 'early-end', p, 3)), errorCode('METRICS_TIMELINE'));
  assert.throws(() => f.record(f.event('phase_started', 'different-start', p, 6)), errorCode('METRICS_CONFLICT'));
  for (const change of [{occurredAt: '2026-02-31T00:00:00Z'}, {origin: 'fabricated'}, {actor: ''}, {extra: true}, {payload: {x: undefined}}])
    assert.throws(() => f.record({...f.result('invalid', 'C'), ...change}));
  const badDuration = f.result('bad-duration', 'C');
  Object.assign(badDuration.payload, {startedAt: stamp(4), endedAt: stamp(3)});
  assert.throws(() => f.record(badDuration), /ends before start/);
  assert.equal(f.report().eventCount, 2);
});

test('release CLI preflight schema records a real early failure with unknown code and no candidate rework', t => {
  const f = fixture(t), event = f.event('attempt_failed', 'preflight-id', {attemptId: 'id', phase: 'verification',
    command: ['release', 'run', 'fullSuite'], classification: 'preflight_rejection', startedAt: stamp(1), endedAt: stamp(3),
    error: 'missing frozen input', candidate: 'source-digest'}, 2, {actor: 'release-runner', evidence: []});
  f.record(event); f.record(event);
  const r = f.report(); assert.equal(r.attempts.failed, 1); assert.equal(r.attempts.preflightRejected, 1);
  assert.equal(r.attempts.items[0].errorCode, null); assert.equal(r.candidates.invalidated, 0);
  assert.equal(r.attempts.items[0].endedAt, stamp(3));
  assert.equal(r.attempts.items[0].durationMs, 2000);
});

for (const damage of ['bytes', 'tail', 'middle', 'head', 'pending', 'metadata', 'event-symlink']) {
  test(`ledger refuses ${damage} corruption/truncation instead of returning zeros`, t => {
    const f = fixture(t); f.record(f.result('one', 'C')); f.record(f.result('two', 'C', 'passed', 2));
    const first = path.join(f.dir, 'events', '000000000002.json'), last = path.join(f.dir, 'events', '000000000003.json');
    if (damage === 'bytes') put(first, '{');
    if (damage === 'tail') fs.unlinkSync(last);
    if (damage === 'middle') fs.unlinkSync(first);
    if (damage === 'head') json(path.join(f.dir, 'HEAD.json'), {sequence: 3, hash: '0'.repeat(64)});
    if (damage === 'pending') put(path.join(f.dir, 'HEAD.json.interrupted.pending'), 'partial');
    if (damage === 'metadata') json(path.join(f.dir, 'meta.json'), {format: 'iteration-metrics/v1', iterationId: 'rewritten'});
    if (damage === 'event-symlink') { fs.renameSync(first, path.join(f.root, 'elsewhere')); fs.symlinkSync(path.join(f.root, 'elsewhere'), first); }
    assert.throws(f.report); assert.throws(() => f.record(f.result('three', 'C', 'passed', 3)));
  });
}

test('lock contention never steals locks, and linked ledger directories are refused', t => {
  const f = fixture(t), lock = path.join(f.dir, '.lock'); put(lock, 'external writer');
  for (const action of [f.report, () => f.record(f.result('x', 'C')), () => metrics.init(f.init)])
    assert.throws(action, errorCode('METRICS_LOCKED'));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'external writer'); fs.unlinkSync(lock);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.dir, alias, 'dir');
  assert.throws(() => metrics.report({dir: alias}), errorCode('METRICS_STORAGE'));
  assert.equal(f.report().eventCount, 1);
});

test('a partial durable write retains the lock and old events; no automatic reset/retry', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.dir, 'events', '000000000001.json'));
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'HEAD.json')) throw Object.assign(new Error('injected disk failure'), {code: 'ENOSPC'});
    return original(from, to);
  };
  try { assert.throws(() => f.record(f.result('interrupted', 'C')), /incomplete write/); }
  finally { fs.renameSync = original; }
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events', '000000000001.json')), before);
  assert.equal(fs.existsSync(path.join(f.dir, '.lock')), true); assert.throws(f.report, errorCode('METRICS_LOCKED'));
  fs.unlinkSync(path.join(f.dir, '.lock')); assert.throws(f.report, errorCode('METRICS_CORRUPT'));
});

test('separate processes serialize or explicitly reject lock contention without losing successful events', async t => {
  const f = fixture(t), files = [1, 2].map(i => {
    const file = path.join(f.root, `record-${i}.json`); json(file, {dir: f.dir, event: f.result('race' + i, 'C', 'failed', i)}); return file;
  });
  const run = file => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'record', '--input', file], {stdio: ['ignore', 'pipe', 'pipe'], shell: false});
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({code, stderr}));
  });
  const results = await Promise.all(files.map(run));
  for (const r of results) if (r.code !== 0) assert.equal(JSON.parse(r.stderr).code, 'METRICS_LOCKED');
  assert.equal(f.report().attempts.failed, results.filter(r => r.code === 0).length);
  assert.ok(results.some(r => r.code === 0));
});

test('CLI init/record/report JSON files are data, unknown fields reject, no shell evaluation', t => {
  const f = fixture(t), marker = path.join(f.root, 'must-not-exist');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', shell: false});
  const initFile = path.join(f.root, 'init.json'); json(initFile, f.init);
  assert.equal(run('init', '--input', initFile).status, 0);
  json(initFile, {...f.init, occurredAt: stamp(100)});
  const conflict = run('init', '--input', initFile);
  assert.equal(conflict.status, 1); assert.equal(JSON.parse(conflict.stderr).code, 'METRICS_CONFLICT');
  const event = f.event('attempt_failed', 'literal', {attemptId: 'literal', phase: 'verification', command: ['release', '$(touch ' + marker + ')'],
    classification: 'preflight_rejection', startedAt: stamp(1), endedAt: stamp(2), error: '`touch marker`'}, 2, {evidence: []});
  const file = path.join(f.root, 'event.json'); json(file, event);
  assert.equal(run('record', '--dir', f.dir, '--event', file).status, 0);
  const reportFile = path.join(f.root, 'report.json'); json(reportFile, {dir: f.dir});
  const output = run('report', '--input', reportFile); assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).attempts.failed, 1); assert.equal(fs.existsSync(marker), false);
  json(reportFile, {dir: f.dir, unknown: true}); assert.equal(run('report', '--input', reportFile).status, 1);
  assert.equal(run('report', '--input', reportFile, '--dir', f.dir).status, 1);
});

// Tiny real gate runs, isolated source/keys/logs only. Before integration this
// worktree has the legacy gate: point ITERATION_METRICS_GATE_SCRIPTS at Main's
// scripts directory to copy the actual historical-selection implementation.
// No gate implementation, result or validator is rewritten/mocked here.
function gateFixture(t, failing = false, mutating = false, complete = false) {
  const f = fixture(t), source = path.join(f.root, 'source'); fs.mkdirSync(source);
  for (const name of ['system-release-gate.cjs', 'system-release-test-reporter.cjs', 'system-release-script-tests.cjs', 'iteration-metrics.cjs']) {
    const from = name === 'iteration-metrics.cjs' ? scripts : process.env.ITERATION_METRICS_GATE_SCRIPTS || scripts;
    const text = fs.readFileSync(path.join(from, name), 'utf8');
    put(path.join(source, 'scripts', name), text);
  }
  const gate = require(path.join(source, 'scripts/system-release-gate.cjs'));
  const api = require(path.join(source, 'scripts/iteration-metrics.cjs'));
  json(path.join(source, 'package.json'), {name: 'metrics-fixture', version: '1.0.0'});
  json(path.join(source, 'package-lock.json'), {lockfileVersion: 3, version: '1.0.0'});
  put(path.join(source, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;');
  put(path.join(source, 'scripts', 'build-fixture.cjs'), complete ? `
    const fs=require('node:fs'),path=require('node:path'),root=process.argv[2];
    for(const name of ['Contents/Resources/app.asar','Contents/Resources/app.asar.unpacked/desktop/native/bin/helper','Contents/MacOS/Fixture']){
      const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'small synthetic gate fixture');
    }
  ` : '// unused build fixture');
  put(path.join(source, 'tests', 'tiny.test.cjs'), `const {test}=require('node:test');const assert=require('node:assert/strict');test('real fixture assertion',()=>{assert.equal(2+2,${failing ? 5 : 4});`
    + (mutating ? `require('node:fs').writeFileSync(require('node:path').join(__dirname,'../changed.txt'),'fixture input mutation');` : '') + '});');
  if (complete) fs.appendFileSync(path.join(source, 'tests', 'tiny.test.cjs'), '\n' + [...new Set(Object.values(gate.SCENARIOS).flat())]
    .map(id => `test(${JSON.stringify('[' + id + '] synthetic protocol assertion')},()=>assert.equal(2+2,4));`).join('\n'));
  const design = path.join(f.root, 'design.md'), designReview = path.join(f.root, 'review.md');
  put(design, 'isolated legacy metrics protocol design');
  const baseline = [{path: 'desktop/fixture.cjs', sha256: sha('fixture-reviewed-baseline')}];
  put(designReview, '## v2独立复核结论\napproved_for_implementation\n`designDigest`: `' + sha(fs.readFileSync(design)) + '`\n'
    + '`reviewedBaselineDigest`: `' + sha(JSON.stringify(baseline)) + '`\n| desktop/fixture.cjs | ' + baseline[0].sha256 + ' |\n');
  const plan = {schema: 1};
  for (const group of gate.GROUPS) plan[group] = group === 'build'
    ? {output: 'release-fixture/App.app', commands: [{script: 'scripts/build-fixture.cjs', args: ['{package}']}]}
    : {tests: group === 'fullSuite' ? 'all' : ['tests/tiny.test.cjs']};
  if (complete) {
    plan.historicalReplay.snapshots = {};
    for (const id of ['S57', 'S62-input', 'S62-read', 'S63-after']) {
      const folder = path.join(f.root, 'snapshots', id); json(path.join(folder, 'workspace.json'), {id, paused: true});
      plan.historicalReplay.snapshots[id] = {path: folder, schema: 1,
        completeness: id === 'S57' ? 'partial' : 'complete', expectedOutcome: id === 'S57' ? 'unknownHistory' : 'paused'};
    }
  }
  const planFile = path.join(f.root, 'plan.json'); json(planFile, plan);
  const gateDir = path.join(f.root, 'gate'); gate.freeze({source, dir: gateDir, design, designReview, planFile});
  const args = {dir: f.dir, gateDir, group: 'fullSuite', actor: 'release-runner'};
  const run = () => gate.run({dir: gateDir, group: 'fullSuite'});
  const receipt = () => gate.unseal(gateDir, path.join(gateDir, 'fullSuite.json'));
  const rewrite = (r, both = true) => {
    const hmac = crypto.createHmac('sha256', fs.readFileSync(path.join(gateDir, '.runner-key'))).update(gate.canonical(r)).digest('hex');
    json(path.join(gateDir, 'fullSuite.json'), {payload: r, hmac});
    if (both) json(path.join(gateDir, 'runs', 'fullSuite', r.runId, 'receipt.json'), {payload: r, hmac});
  };
  async function finishCandidate() {
    assert.equal(complete, true, 'full synthetic protocol fixture must be requested');
    const bundle = path.join(source, plan.build.output);
    for (const group of gate.GROUPS) {
      if (!fs.existsSync(path.join(gateDir, group + '.json')))
        await gate.run({dir: gateDir, group, ...(group === 'build' ? {bundle} : {})});
      if (group === 'build') gate.packageId({dir: gateDir, bundle});
    }
    const frozen = gate.loadFreeze(gateDir), refs = [{group: 'policyPause', scenario: 'D01'}];
    const mappingFile = path.join(f.root, 'mapping.json'), implementationReview = path.join(f.root, 'implementation-review.json');
    json(mappingFile, {schema: 1, finalSourceDigest: frozen.sourceDigest, designDigest: frozen.identity.designDigest,
      items: gate.FINDINGS.map(id => ({id, implementation: 'complete', verification: 'passed', evidence: refs}))});
    const doc = path.join(f.root, 'implementation-review.md'); put(doc, 'Synthetic independent gate protocol review only.');
    json(implementationReview, {schema: 1, status: 'approved', finalSourceDigest: frozen.sourceDigest,
      designDigest: frozen.identity.designDigest, planDigest: gate.digest(plan), requirementMappingDigest: gate.fileHash(mappingFile),
      implementedBy: 'fixture-author', reviewedBy: 'fixture-reviewer', reviewDocument: {path: doc, sha256: gate.fileHash(doc)},
      openFindings: [], findings: gate.FINDINGS.map(id => ({id, status: 'closed', evidence: refs}))});
    return {dir: f.dir, gateDir, mappingFile, implementationReview, actor: 'release-runner'};
  }
  return {...f, source, gateDir, gate, api, args, run, receipt, rewrite, finishCandidate};
}

test('real passed gate receipt imports idempotently; observed automatic recording and import use identical fact semantics', async t => {
  const f = gateFixture(t); await f.run();
  const result = f.api.importRun(f.args); assert.equal(result.imported, 3); assert.equal(result.duplicate, false);
  assert.equal(f.api.importRun(f.args).duplicate, true);
  const original = f.receipt(), before = sha(fs.readFileSync(path.join(f.gateDir, 'fullSuite.json')));
  const other = path.join(f.root, 'automatic-ledger'); metrics.init({...f.init, dir: other});
  for (const e of result.events) metrics.record({dir: other, event: {...e, origin: 'observed', recordedAt: stamp(200)}});
  assert.equal(f.api.importRun({...f.args, dir: other}).duplicate, true);
  assert.throws(() => f.api.importRun({...f.args, actor: 'different'}), errorCode('METRICS_CONFLICT'));
  const r = f.report(); assert.equal(r.eventCount, 4); assert.equal(r.attempts.count, 1); assert.equal(r.attempts.failed, 0);
  assert.equal(r.phases[0].durationMs, Date.parse(original.endedAt) - Date.parse(original.startedAt));
  assert.equal(sha(fs.readFileSync(path.join(f.gateDir, 'fullSuite.json'))), before);
  assert.equal(r.costs.totalUSD, null);
  const input = path.join(f.root, 'import.json'); json(input, f.args);
  const output = spawnSync(process.execPath, [path.join(f.source, 'scripts/iteration-metrics.cjs'), 'import-run', '--input', input], {encoding: 'utf8', shell: false});
  assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).duplicate, true);
});

test('real failed gate commands import with sealed original evidence and retain the first failure', async t => {
  const f = gateFixture(t, true); await assert.rejects(f.run, /failed actual command/);
  const result = f.api.importRun(f.args); assert.equal(result.imported, 3);
  const r = f.report(); assert.equal(r.attempts.failed, 1); assert.equal(r.candidates.invalidated, 0);
  assert.equal(r.attempts.byClassification.unknown, 1, 'exit status cannot invent root cause attribution');
  assert.equal(result.events[2].payload.gateStatus, 'failed');
  const first = f.receipt(), firstFile = path.join(f.gateDir, 'runs', 'fullSuite', first.runId, 'receipt.json');
  const firstBytes = fs.readFileSync(firstFile);
  await assert.rejects(f.run, /failed actual command/); f.api.importRun(f.args);
  assert.equal(f.report().attempts.failed, 2); assert.equal(f.report().candidates.invalidated, 0);
  assert.deepEqual(fs.readFileSync(firstFile), firstBytes);
});

test('MET03: one real passed group cannot clear the streak; its later explicit invalidation makes three', async t => {
  const f = gateFixture(t); f.record(f.invalidate('i1', 'C1', 1)); f.record(f.invalidate('i2', 'C2', 2));
  await f.run(); const r = f.receipt(); f.api.importRun(f.args);
  assert.equal(f.report().candidates.consecutiveInvalidated, 2);
  assert.equal(f.report().candidates.convergenceReviewRequired, true);
  const invalidation = f.invalidate('i3', r.freezeDigest, 3);
  invalidation.occurredAt = new Date(Date.parse(r.endedAt) + 1).toISOString(); f.record(invalidation);
  assert.equal(f.report().candidates.consecutiveInvalidated, 3);
  assert.equal(f.report().candidates.convergenceReviewRequired, true);
});

test('MET03: only evidenced whole gate acceptance resets streak; reporting it cannot grant current readiness', async t => {
  // All seven groups here are tiny protocol fixtures, not App/package approval.
  const f = gateFixture(t, false, false, true);
  f.record(f.invalidate('i1', 'C1', 1)); f.record(f.invalidate('i2', 'C2', 2));
  await f.run(); const r = f.receipt(); f.api.importRun(f.args);
  assert.equal(f.report().candidates.consecutiveInvalidated, 2);
  assert.throws(() => f.api.acceptCandidate({dir: f.dir, gateDir: f.gateDir,
    mappingFile: path.join(f.root, 'not-yet-mapped.json'), implementationReview: path.join(f.root, 'not-yet-reviewed.json')}));
  assert.equal(f.report().candidates.consecutiveInvalidated, 2);
  const args = await f.finishCandidate();
  const accepted = f.api.acceptCandidate(args), event = accepted.event;
  assert.equal(event.type, 'candidate_accepted'); assert.equal(event.payload.candidateId, r.freezeDigest);
  assert.equal(f.report().candidates.consecutiveInvalidated, 0); assert.equal(f.report().candidates.convergenceReviewRequired, false);
  assert.deepEqual(f.report().candidates.acceptedIds, [r.freezeDigest]); assert.equal(f.report().warnings.length, 1);
  assert.equal(f.api.acceptCandidate({...args, occurredAt: event.occurredAt}).duplicate, true);
  assert.throws(() => f.api.record({dir: f.dir, event: {...event, eventId: 'wrong-candidate',
    payload: {...event.payload, candidateId: '0'.repeat(64)}}}), errorCode('METRICS_GATE_RECEIPT'));
  assert.throws(() => f.api.record({dir: f.dir, event: {...event, eventId: 'missing-evidence', evidence: [event.evidence[0]]}}),
    errorCode('METRICS_GATE_EVIDENCE'));
  assert.throws(() => f.api.record({dir: f.dir, event: {...event, eventId: 'too-early', occurredAt: stamp(3)}}), errorCode('METRICS_TIMELINE'));
  const review = read(args.implementationReview); review.status = 'rejected'; json(args.implementationReview, review);
  assert.throws(() => f.api.acceptCandidate(args), /unapproved/);
  assert.throws(() => f.gate.check({dir: f.gateDir, mappingFile: args.mappingFile, implementationReview: args.implementationReview}));
  const history = f.report();
  assert.equal(history.releaseAuthority, false); assert.equal(own(history, 'softwareReady'), false);
  assert.deepEqual(history.candidates.acceptedIds, [r.freezeDigest], 'past acceptance remains a history fact after current evidence changes');
  assert.match(history.markdown, /does not grant release readiness/);
});

test('MET04: missed failed runs can be imported by UUID after active advances, without rewriting any receipt', async t => {
  const f = gateFixture(t, true); await assert.rejects(f.run); const first = f.receipt();
  await assert.rejects(f.run); const second = f.receipt();
  const activeFile = path.join(f.gateDir, 'fullSuite.json');
  const firstFile = path.join(f.gateDir, 'runs', 'fullSuite', first.runId, 'receipt.json');
  const secondFile = path.join(f.gateDir, 'runs', 'fullSuite', second.runId, 'receipt.json');
  const files = [activeFile, firstFile, secondFile], bytes = files.map(file => fs.readFileSync(file));
  assert.equal(f.api.importRun(f.args).runId, second.runId);
  const historicalArgs = {...f.args, runId: first.runId};
  const imported = f.api.importRun(historicalArgs);
  assert.equal(imported.runId, first.runId); assert.equal(imported.selection, 'historical');
  assert.equal(f.report().attempts.failed, 2); assert.equal(f.report().candidates.invalidated, 0);
  assert.equal(f.api.importRun(historicalArgs).duplicate, true);
  assert.equal(f.api.importRun({...f.args, runId: second.runId}).duplicate, true);
  for (const runId of ['../../fullSuite', '', null, crypto.randomUUID()]) assert.throws(() => f.api.importRun({...f.args, runId}));
  put(path.join(f.gateDir, '.running'), 'peer runner');
  assert.throws(() => f.api.importRun(historicalArgs), errorCode('METRICS_GATE_BUSY'));
  fs.unlinkSync(path.join(f.gateDir, '.running'));
  const linkedId = crypto.randomUUID(); fs.symlinkSync(path.dirname(firstFile), path.join(f.gateDir, 'runs', 'fullSuite', linkedId), 'dir');
  assert.throws(() => f.api.importRun({...f.args, runId: linkedId}), errorCode('METRICS_STORAGE'));
  fs.unlinkSync(path.join(f.gateDir, 'runs', 'fullSuite', linkedId));
  const envelope = read(firstFile); envelope.hmac = '0'.repeat(64); json(firstFile, envelope);
  assert.throws(() => f.api.importRun(historicalArgs), /tampered/); put(firstFile, bytes[1]);
  const log = first.commands[0].stdout.path, logBytes = fs.readFileSync(log); put(log, 'tampered original log');
  assert.throws(() => f.api.importRun(historicalArgs), /tampered|hash mismatch/); put(log, logBytes);
  const wrong = {...first, runId: second.runId};
  json(firstFile, {payload: wrong, hmac: crypto.createHmac('sha256', fs.readFileSync(path.join(f.gateDir, '.runner-key'))).update(f.gate.canonical(wrong)).digest('hex')});
  assert.throws(() => f.api.importRun(historicalArgs), errorCode('METRICS_GATE_RECEIPT')); put(firstFile, bytes[1]);
  const output = spawnSync(process.execPath, [path.join(f.source, 'scripts/iteration-metrics.cjs'), 'import-run',
    '--dir', f.dir, '--gate', f.gateDir, '--group', 'fullSuite', '--run-id', first.runId], {encoding: 'utf8', shell: false});
  assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).runId, first.runId);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]));
  assert.equal(f.report().attempts.failed, 2);
});

test('MET04: historical passed runs use real selected-run verification even when active is unavailable', async t => {
  const f = gateFixture(t); await f.run(); const first = f.receipt();
  await f.run(); const second = f.receipt();
  const active = path.join(f.gateDir, 'fullSuite.json'), activeBytes = fs.readFileSync(active);
  put(active, 'unavailable active pointer');
  try {
    const imported = f.api.importRun({...f.args, runId: first.runId});
    assert.equal(imported.runId, first.runId); assert.equal(imported.events[2].payload.status, 'passed');
    assert.equal(fs.readFileSync(active, 'utf8'), 'unavailable active pointer');
  } finally { put(active, activeBytes); }
  assert.equal(f.api.importRun(f.args).runId, second.runId);
  assert.equal(f.api.importRun({...f.args, runId: first.runId}).duplicate, true);
  assert.equal(f.report().attempts.count, 2); assert.equal(f.report().attempts.failed, 0);
  assert.deepEqual(fs.readFileSync(active), activeBytes);
});

test('passed receipt must actually pass verifyRun, including real node:test result parsing', async t => {
  const f = gateFixture(t, true); await assert.rejects(f.run);
  const r = f.receipt(); r.status = 'passed'; r.commands[0].exitCode = 0;
  r.afterSourceDigest = r.sourceDigest; r.afterMutationDigest = r.beforeMutationDigest;
  r.output = path.join(f.gateDir, 'runs', 'fullSuite', r.runId);
  // Use actual command artifacts; gate still parses the original failing log.
  r.evidence = [r.commands[0].stdout, r.commands[0].stderr].sort((a, b) => a.path.localeCompare(b.path));
  f.rewrite(r);
  assert.throws(() => f.api.importRun(f.args), /failed\/skipped\/todo test/); assert.equal(f.report().eventCount, 1);
  await assert.rejects(f.run);
  assert.notEqual(f.receipt().runId, r.runId);
  assert.throws(() => f.api.importRun({...f.args, runId: r.runId}), /failed\/skipped\/todo test/);
  assert.equal(f.report().eventCount, 1, 'historical passed also parses the original failing log');
});

test('real stale run with a successful command remains an observed failed attempt, never a candidate invalidation', async t => {
  const f = gateFixture(t, false, true);
  await assert.rejects(f.run, /stale|changed/);
  assert.equal(f.receipt().status, 'stale'); assert.equal(f.receipt().commands[0].exitCode, 0);
  f.api.importRun(f.args);
  assert.equal(f.report().attempts.failed, 1); assert.equal(f.report().attempts.items[0].gateStatus, 'stale');
  assert.equal(f.report().candidates.invalidated, 0);
});

test('failed import rejects bad seal, changed logs, mismatched immutable copy/freeze, empty commands and unsafe evidence', async t => {
  const f = gateFixture(t, true); await assert.rejects(f.run);
  const original = f.receipt();
  const active = path.join(f.gateDir, 'fullSuite.json'), envelope = read(active);
  envelope.hmac = '0'.repeat(64); json(active, envelope);
  assert.throws(() => f.api.importRun(f.args), /tampered/); f.rewrite(original);
  const stdout = original.commands[0].stdout.path, bytes = fs.readFileSync(stdout); put(stdout, 'changed');
  assert.throws(() => f.api.importRun(f.args), /tampered|hash mismatch/); put(stdout, bytes);
  const changes = [
    r => { r.error = 'mismatched active copy'; },
    r => { r.sourceDigest = '0'.repeat(64); },
    r => { r.commands = []; },
    r => { r.commands[0].stdout.path = f.evidence[0].path; },
    r => { r.commands[0].endedAt = stamp(1); },
    r => { r.beforeSourceDigest = '0'.repeat(64); }
  ];
  for (let i = 0; i < changes.length; i++) {
    const r = structuredClone(original); changes[i](r); f.rewrite(r, i !== 0);
    assert.throws(() => f.api.importRun(f.args)); f.rewrite(original);
  }
  put(path.join(f.gateDir, '.running'), 'runner'); assert.throws(() => f.api.importRun(f.args), errorCode('METRICS_GATE_BUSY'));
  fs.unlinkSync(path.join(f.gateDir, '.running'));
  assert.equal(f.report().eventCount, 1); assert.equal(f.api.importRun(f.args).imported, 3);
});

test('missing gate helper exports fail clearly without disabling unrelated ledger APIs', t => {
  const f = fixture(t), gate = require('../scripts/system-release-gate.cjs');
  const old = gate.unseal; delete gate.unseal;
  try { assert.throws(() => metrics.importRun({dir: f.dir, gateDir: f.root, group: 'fullSuite'}), errorCode('METRICS_GATE_API')); }
  finally { if (old) gate.unseal = old; }
  assert.equal(f.report().eventCount, 1);
});
