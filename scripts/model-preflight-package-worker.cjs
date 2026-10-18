'use strict';
// Headless final-package proof. Application modules are required ONLY from the
// selected ASAR. External files are the reviewed fixture/helpers and this runner.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const h = require('./system-package-worker.cjs');
const VERSION = 'model-preflight-package-worker/1';
const SOURCE = path.resolve(__dirname, '..');
const REQUIRED = ['engine-worker.cjs', 'core.cjs', 'agent.cjs', 'subscription.cjs',
  'subscription-health.cjs', 'model-preflight-recovery.cjs', 'model-errors.cjs',
  'evidence-consumption.cjs', 'efficiency.cjs', 'run-models.cjs', 'execution-policy.cjs'];
const FIXTURES = ['scripts/model-preflight-worker-fixture.cjs', 'scripts/generic-consumption-worker-fixture.cjs',
  'tests/helpers/platform-fixture.cjs', 'tests/root-relation-physical-fixture.cjs'];
const STAGES = [['failed'], ['cold_failed', 'attested_health', 'first_revision'],
  ['cold_revision', 'verified_delivery'], ['cold_delivery']];
const UPGRADE_STAGES = [['failed'], ['cold_failed', 'legacy_prepared'],
  ['cold_prepared', 'upgrade_health', 'health_upgraded'], ['cold_upgraded', 'first_revision'],
  ['cold_revision', 'verified_delivery'], ['cold_delivery']];
const stagesFor = config => config.scenario === 'prepared-upgrade' ? UPGRADE_STAGES : STAGES;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const json = value => JSON.parse(JSON.stringify(value));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    assert.ok(['--app', '--output'].includes(key), 'unknown option: ' + key);
    assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), 'missing value: ' + key);
    assert.ok(!Object.hasOwn(options, key.slice(2)), 'duplicate option: ' + key);
    options[key.slice(2)] = argv[i + 1];
  }
  assert.ok(path.isAbsolute(options.app || '') && options.app.endsWith('.app'), '--app must be an absolute .app path');
  assert.ok(path.isAbsolute(options.output || '') && options.output.endsWith('.json'), '--output must be an absolute JSON path');
  return options;
}

function adaptFixture(text, desktop, helpers) {
  // This is the only additional dependency relative to the existing generic
  // fixture adapter. No behavior, application code or historical values change.
  const adapted = text.replace(/require\((['"])\.\/generic-consumption-worker-fixture\.cjs\1\)/g,
    () => 'require(' + JSON.stringify(helpers.common) + ')');
  return h.redirectRequires(adapted, desktop, helpers.platform, helpers.physical);
}

function executable(app) {
  const folder = path.join(app, 'Contents/MacOS');
  const names = fs.readdirSync(folder).filter(name => fs.statSync(path.join(folder, name)).isFile());
  assert.equal(names.length, 1, 'ambiguous .app executable');
  const binary = fs.realpathSync(path.join(folder, names[0]));
  const framework = fs.realpathSync(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'));
  assert.ok(inside(app, binary) && inside(app, framework), 'runtime escaped selected .app');
  return {binary, framework, binarySHA256: h.fileHash(binary), frameworkSHA256: h.fileHash(framework), fuses: h.readNodeFuses(framework)};
}

function installIsolation(config) {
  h.installIsolation(config);
  // Deny native callbacks separately; the low-level helper also denies network,
  // child processes, native modules, UI imports and non-fixture filesystem IO.
  return {installed: true, pid: process.pid, threadId: require('node:worker_threads').threadId};
}

function moduleProof(config) {
  const wt = require('node:worker_threads');
  const files = Object.keys(require.cache).sort();
  for (const file of files) {
    assert.ok(inside(config.asar, file) || config.generated.some(row => row.file === file), 'unreviewed runtime module: ' + file);
    assert.notEqual(file, path.join(config.asar, 'desktop/main.cjs'), 'production main must never load');
  }
  if (!wt.isMainThread) {
    assert.equal(wt.workerData.kind, 'assistant-engine');
    assert.equal(wt.workerData.entry, path.join(config.asar, 'desktop/engine-worker.cjs'));
    assert.equal(wt.workerData.dir, config.workspace);
  }
  // Observation of actual require.cache only: do NOT require modules to make
  // this proof pass. Dormant modules must be loaded by the tested application.
  return {pid: process.pid, threadId: wt.threadId, workerEntry: wt.workerData?.entry,
    fromASAR: true, modules: files.filter(file => inside(config.asar, file)).map(file => ({file, sha256: h.fileHash(file)})),
    externalModules: files.filter(file => !inside(config.asar, file)).map(file => ({file, sha256: h.fileHash(file)}))};
}

function snapshot(f, config) {
  const {a, job, task, audit} = f, generic = f.observe();
  const seed = audit.modelPreflight;
  const oldRun = seed?.oldRunId && a.data.agentRuns.find(run => run.id === seed.oldRunId);
  // evidence-basis was already loaded by the fixture. This read observes the
  // actual stored run with the same canonical hashing as the original audit.
  const basis = require.cache[path.join(config.asar, 'desktop/evidence-basis.cjs')];
  assert.ok(basis);
  return json({jobId: job.id, taskId: task.id, jobStatus: job.status, taskStatus: task.status,
    autoAccept: job.autoAccept, acceptedAt: task.acceptedAt ?? null, completedAt: job.completedAt ?? null,
    paused: a.data.stewardship.paused, primary: task.primaryArtifactId, runs: a.data.agentRuns.length,
    modelCalls: job.callsUsed, generic, health: a.data.runtime?.subscriptionHealth ?? null,
    failedRun: oldRun || null, failedRunHash: oldRun ? basis.exports.hash(oldRun) : null,
    failedCall: seed?.callId ? a.data.modelCalls.find(call => call.id === seed.callId) : null,
    isolation: config.workerIsolation, modules: moduleProof(config)});
}

async function createFixture(input, config) {
  const wt = require('node:worker_threads');
  assert.ok(!wt.isMainThread && wt.threadId > 0, 'formal Worker required');
  if (config.phase > 0) {
    assert.ok(fs.existsSync(config.audit), 'cold audit missing; refusing to reseed');
    assert.ok(fs.existsSync(path.join(config.workspace, 'workspace.json')), 'cold workspace missing');
  }
  const f = await require(config.fixture).setup({...input, reportFile: config.audit, mode: config.mode, scenario: config.scenario || 'direct'});
  wt.parentPort.on('message', message => {
    if (message.type !== 'modelPreflightPackageProbe') return;
    try {
      f.saveAudit();
      wt.parentPort.postMessage({type: 'modelPreflightPackageProof', id: message.id, result: snapshot(f, config)});
    } catch (error) {
      wt.parentPort.postMessage({type: 'modelPreflightPackageProof', id: message.id, error: error.stack || error.message});
    }
  });
  return f.a;
}

function assertPreserved(s, seed, budget, mode) {
  const g = s.generic;
  assert.equal(g.accepted, false); assert.equal(s.autoAccept, false);
  assert.equal(s.acceptedAt, null); assert.equal(s.completedAt, null);
  assert.deepEqual(g.audit.violations, []); assert.equal(g.audit.creates, 1);
  assert.equal(g.oldCycles, g.originalCycles); assert.equal(g.budget.limitUSD, 200);
  assert.ok(Number.isFinite(g.budget.spentUSD) && g.budget.spentUSD >= 17);
  assert.ok(Number.isFinite(g.budget.heldUSD));
  assert.deepEqual(g.preflight.seed, seed);
  assert.equal(seed.mode, mode); assert.equal(seed.seedPending, false);
  assert.deepEqual(g.preflight.oldRequests, [seed.request], 'historical request was changed/duplicated');
  assert.equal(s.failedRunHash, seed.oldRunHash, 'original failed run was rewritten');
  assert.equal(s.failedRun.id, seed.oldRunId); assert.equal(s.failedRun.status, 'blocked');
  assert.equal(s.failedCall.id, seed.callId); assert.equal(s.failedCall.requestId, seed.requestId);
  assert.equal(s.failedCall.errorCode, 'MODEL_AUTH'); assert.equal(s.failedCall.status, 'error');
  if (budget) {
    assert.ok(s.generic.budget.spentUSD >= budget.spentUSD);
    assert.ok(Math.abs(g.budget.heldUSD - budget.heldUSD) < 1e-9, 'held spend changed');
  }
  assert.equal(seed.request.responseStatus, 'error'); assert.equal(seed.request.errorCode, 'MODEL_AUTH');
  if (mode === 'legacy') {
    assert.equal(Object.hasOwn(seed.request, 'producerSchema'), false);
    assert.equal(Object.hasOwn(s.failedCall, 'producerSchema'), false);
    assert.equal(seed.request.usageReported, false); assert.equal(s.failedCall.usageReported, false);
    assert.equal(s.failedCall.estimatedUSD, null);
  } else {
    assert.equal(seed.request.producerSchema, 2); assert.equal(s.failedCall.producerSchema, 2);
    assert.equal(seed.request.usageReported, true); assert.equal(s.failedCall.usageReported, true);
    assert.equal(s.failedCall.inputTokens, 0); assert.equal(s.failedCall.outputTokens, 0); assert.equal(s.failedCall.estimatedUSD, 0);
    assert.equal(s.failedCall.diagnostic.kind, 'model_preflight');
    assert.equal(s.failedCall.diagnostic.modelDispatched, false);
    assert.equal(s.failedCall.diagnostic.stage, 'login_status');
  }
}

function assertFailed(s, mode, {cold=true}={}) {
  const g = s.generic, seed = g.preflight.seed;
  assertPreserved(s, seed, null, mode);
  assert.equal(s.jobStatus, 'blocked'); assert.equal(g.primary.id, 'generic-original');
  assert.equal(g.audit.patches.length, 0); assert.equal(g.audit.writes, 0); assert.deepEqual(g.audit.checks, []);
  assert.deepEqual(g.audit.queries, ['leaf']); assert.equal(g.consumption.receipts.length, 0);
  // The historical seed adapter preserves the writer's in-memory undefined
  // fields. Only cold JSON restoration is the legacy input under test. Native
  // proof is available immediately; both modes must prove eligibility at cold.
  if (cold || mode === 'native') {
    assert.equal(g.preflight.view?.candidate, true);
    assert.equal(g.preflight.view.native, mode === 'native');
    assert.equal(g.preflight.view.attested, mode === 'native');
  }
  assert.ok(!g.preflight.grant); assert.equal(s.health, null);
}

function assertHealth(s, before, mode) {
  assertPreserved(s, before.generic.preflight.seed, before.generic.budget, mode);
  for (const key of ['runs', 'modelCalls', 'primary', 'jobStatus']) assert.deepEqual(s[key], before[key]);
  for (const key of ['budget', 'primary', 'deliveries']) assert.deepEqual(s.generic[key], before.generic[key]);
  const businessAudit = value => {const audit=json(value);delete audit.cacheRefreshes;return audit;};
  assert.deepEqual(businessAudit(s.generic.audit),businessAudit(before.generic.audit));
  const receipt = s.health;
  assert.equal(receipt?.status, 'success'); assert.equal(receipt.installed, true); assert.equal(receipt.loggedIn, true);
  assert.ok(receipt.checkId && receipt.cliHash && receipt.configurationHash && receipt.intentHash);
  assert.ok(Date.parse(receipt.startedAt) > Date.parse(s.failedRun.finishedAt));
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
  assert.ok(Date.parse(receipt.expiresAt) > Date.parse(receipt.finishedAt));
  assert.equal(s.generic.preflight.candidate?.eligible, true);
  const p = s.generic.consumption.attempts[before.generic.preflight.seed.attemptId];
  if (mode === 'legacy') {
    assert.equal(p.modelPreflightAttestation.executedBy, 'supervisor');
    assert.equal(p.modelPreflightAttestation.evidenceHash, before.generic.preflight.view.evidenceHash);
    assert.ok(p.modelPreflightAttestation.authorizationNote);
    assert.equal(s.generic.preflight.view.attested, true);
  } else assert.ok(!p.modelPreflightAttestation);
  assert.ok(!p.modelPreflightRecovery, 'health observation must not prepare a recovery grant');
}

function assertPreflightCheckpoint(s) {
  // The resumed run has one action left after revising: it acquires tail.
  // This differs from the generic fixture's first-ever run checkpoint.
  assert.deepEqual(s.generic.audit.queries, ['leaf', 'tail']);
  const normalized = json(s); normalized.generic.audit.queries = ['leaf'];
  h.assertGenericCheckpoint(normalized);
}

function assertRecovered(s, seed, budget, mode, health) {
  assertPreserved(s, seed, budget, mode);
  const p = s.generic.consumption.attempts[seed.attemptId], grant = p.modelPreflightRecovery;
  assert.equal(p.status, 'committed'); assert.equal(grant.status, 'terminal');
  assert.equal(grant.terminal.status, 'done'); assert.equal(grant.proof.mode, mode);
  assert.equal(grant.attemptId, seed.attemptId); assert.equal(grant.proof.oldRunId, seed.oldRunId);
  assert.deepEqual(grant.proof.originalRequest, seed.request);
  if(p.modelPreflightHealthUpgrade){
    const old=s.generic.audit.preparedHealthUpgrade.grant,u=p.modelPreflightHealthUpgrade;
    assert.equal(grant.id,old.id);assert.deepEqual(grant.proof,old.proof);assert.deepEqual(grant.health,old.health);
    assert.equal(grant.health.identityPolicyVersion,undefined);assert.equal(grant.claim.healthUpgradeId,u.id);
    assert.deepEqual(grant.claim.health,health);assert.equal(health.identityPolicyVersion,2);
    assertUpgradeEvent(s,u);
    assertOwnerSelected(s);
  }else assert.deepEqual(grant.health, health);
  assert.equal(p.requests.length, 2, 'exactly one recovery request allowed');
  const next = p.requests.find(r => r.requestId !== seed.requestId);
  assert.ok(next); assert.equal(next.requestId, grant.claim.requestId);
  assert.notEqual(next.runId, seed.oldRunId); assert.notEqual(next.spendTicketId, seed.request.spendTicketId);
  assert.equal(next.producerSchema, 2); assert.equal(next.responseStatus, 'done');
  assert.equal(next.callId, grant.terminal.callId); assert.equal(next.usageReported, true);
  assert.equal(Object.values(s.generic.consumption.attempts).filter(p => p.modelPreflightRecovery).length, 1);
  assert.equal(s.generic.consumption.receipts[0].attemptId, seed.attemptId);
}

function assertUpgradeEvent(s,u){
  const events=s.generic.preflight.healthUpgradeEvents;assert.equal(events.length,1);
  const value={...u};delete value.eventId;
  assert.equal(events[0].eventId,u.eventId);assert.equal(events[0].commitId,u.id);
  assert.equal(events[0].entityKind,'job');assert.equal(events[0].entityId,u.jobId);assert.equal(events[0].actor,u.executedBy);
  assert.deepEqual(events[0].payload.upgrade,value);assert.equal(u.health.identityPolicyVersion,2);
  assert.equal(u.prepareEventId,s.generic.audit.preparedHealthUpgrade.grant.eventId);
}
function assertPreparedUnchanged(s){
  const g=s.generic,old=g.audit.preparedHealthUpgrade,p=g.consumption.attempts[g.preflight.seed.attemptId];
  assert.equal(old.adapter,'historical-cache-metadata-and-markerless-health-v1');
  assert.deepEqual(g.preflight.grant,old.grant);assert.deepEqual(p.modelPreflightRecovery,old.grant);
  assert.equal(old.grant.status,'prepared');assert.equal(old.grant.health.identityPolicyVersion,undefined);
  assert.equal(p.requests.length,1);assert.deepEqual(p.requests,[g.preflight.seed.request]);
  assert.equal(g.preflight.rawBudgetHash,old.before.budget);assert.equal(g.runs.length,old.before.runs);
  assert.equal(g.audit.patches.length,0);assert.equal(g.audit.writes,0);assert.deepEqual(g.audit.checks,[]);
  assert.equal(old.workEfficiency.phase,'recovery_pending');assert.equal(old.workEfficiency.lastFailure.code,'EVIDENCE_GENERATION_UNRESOLVED');
  assert.deepEqual(g.preflight.workEfficiency,old.workEfficiency,'health upgrade must preserve historical efficiency counters');
  assert.equal(old.continuation.activeTaskId,null);assert.equal(old.continuation.activeBasis,old.continuation.episode.basis);
  assert.equal(old.continuation.episode.suspendedBy.code,'EVIDENCE_GENERATION_UNRESOLVED');
  assert.deepEqual(g.preflight.continuation,old.continuation,'health upgrade must leave suspended owner and episode history unchanged');
  assert.deepEqual(g.preflight.ownerSelectionEvents,old.ownerSelectionEvents,'health confirmation must not select an execution owner');
}
function assertOwnerSelected(s){
  const g=s.generic,old=g.audit.preparedHealthUpgrade,at=g.audit.ownerAtClaim,p=g.preflight;
  assert.ok(at,'actual recovery claim must record its owner evidence');
  const upgrade=p.healthUpgradeEvents[0];assert.ok(upgrade);
  const selected=at.events.filter(e=>e.sequence>upgrade.sequence&&e.payload.proof?.owner?.basis===old.continuation.activeBasis);
  assert.equal(selected.length,1,'normal owner_select must be durable after UI upgrade and before model claim');
  const event=selected[0],owner={kind:'continuation',taskId:old.grant.taskId,basis:old.continuation.activeBasis};
  assert.equal(event.type,'execution_policy_prepared');assert.equal(event.payload.command,'owner_select');
  assert.equal(event.entityKind,'job');assert.equal(event.entityId,old.grant.jobId);assert.equal(event.actor,'system');assert.equal(event.payload.taskId,owner.taskId);
  assert.deepEqual(event.payload.proof.owner,owner);assert.deepEqual(at.continuation.policyOwner,{...owner,commandId:event.commitId});
  assert.equal(at.continuation.activeTaskId,owner.taskId);assert.equal(at.continuation.activeBasis,owner.basis);
  assert.deepEqual(at.continuation.episode,old.continuation.episode,'owner takeover must not clear suspension/cycles/hops');
  assert.deepEqual(at.continuation.episodeKeys,old.continuation.episodeKeys,'owner takeover must reuse the original episode');
  assert.deepEqual(p.ownerSelectionEvents.find(e=>e.eventId===event.eventId),event,'owner selection survives cold replay');
  // Later evidence may legitimately refresh the active episode. The original
  // episode and its suspension/counters must still survive unchanged.
  for(const basis of old.continuation.episodeKeys)assert.ok(p.continuation.episodeKeys.includes(basis),'historical episodes must survive later work');
  assert.deepEqual(p.continuation.episode,old.continuation.episode,'later work must preserve the original suspension/cycles/hops');
}
function assertLegacyPrepared(s){
  assertPreparedUnchanged(s);assert.equal(s.generic.preflight.health.identityPolicyVersion,undefined);
  assert.equal(s.generic.preflight.healthUpgrade,undefined);assert.deepEqual(s.generic.preflight.healthUpgradeEvents,[]);
  assert.ok(s.generic.preflight.view.healthUpgrade);
}
function assertUpgradeHealth(s){
  assertPreparedUnchanged(s);const p=s.generic.preflight,r=p.health,old=p.grant.health;
  assert.equal(r.status,'success');assert.equal(r.identityPolicyVersion,2);assert.equal(r.cliHash,old.cliHash);assert.equal(r.intentHash,old.intentHash);
  assert.notEqual(r.configurationHash,old.configurationHash);assert.ok(Date.parse(r.startedAt)>Date.parse(p.grant.preparedAt));
  assert.equal(p.healthUpgrade,undefined);assert.deepEqual(p.healthUpgradeEvents,[]);assert.ok(p.view.healthUpgrade);
  assert.equal(p.view.healthUpgrade.expectedHealthCheckId,r.checkId);assert.equal(p.view.healthUpgrade.expectedHealthSequence,r.sequence);
}
function assertUpgraded(s){
  assertPreparedUnchanged(s);const p=s.generic.preflight,u=p.healthUpgrade;
  assert.ok(u);assert.equal(u.grantId,p.grant.id);assert.equal(p.view.healthUpgrade,null);
  assert.deepEqual(u.health,p.health);assertUpgradeEvent(s,u);
}

function assertCold(previous, next) {
  // Compare persisted history, not freshly recomputed readiness projections.
  // assertFailed/assertRecovered validate the corresponding live stage below.
  const persisted = value => {
    const result = json(value), p = result.generic.preflight;
    for (const key of ['view', 'candidate', 'policy']) delete p[key];
    return result;
  };
  h.assertGenericRestored(persisted(previous), persisted(next));
  for (const key of ['health', 'failedRun', 'failedRunHash', 'failedCall'])
    assert.deepEqual(next[key], previous[key], 'cold restoration changed ' + key);
}

function assertModuleProof(proof, config, names, worker, pid) {
  assert.ok(proof); assert.equal(proof.fromASAR, true); assert.equal(proof.pid, pid);
  if (worker) {
    assert.ok(proof.threadId > 0); assert.equal(proof.workerEntry, path.join(config.asar, 'desktop/engine-worker.cjs'));
  } else assert.equal(proof.threadId, 0);
  for (const row of proof.modules) {
    assert.ok(inside(config.asar, row.file)); assert.notEqual(row.file, path.join(config.asar, 'desktop/main.cjs'));
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
  }
  for (const name of names) {
    const rows = proof.modules.filter(row => row.file === path.join(config.asar, 'desktop', name));
    const expected = config.desktopInputs.filter(row => row.path === 'desktop/' + name);
    assert.equal(rows.length, 1, 'missing actual ASAR load: ' + name); assert.equal(expected.length, 1);
    assert.equal(rows[0].sha256, expected[0].sha256, 'loaded module hash mismatch: ' + name);
  }
  for (const row of proof.externalModules) {
    const expected = config.generated.find(v => v.file === row.file);
    assert.ok(expected, 'unreviewed external code'); assert.equal(row.sha256, expected.sha256);
  }
}

function assertPhase(result, execution, config) {
  assert.equal(execution.code, 0, result?.error || execution.error || 'Electron process failed; see retained logs');
  assert.ok(!execution.signal && !execution.error && !execution.timedOut);
  assert.equal(result?.status, 'passed', result?.error || 'missing Electron/Worker evidence');
  assert.equal(result.pid, execution.pid); assert.ok(result.versions.electron);
  assert.equal(result.mode, config.mode); assert.equal(result.phase, config.phase);
  assert.equal(result.scenario||'direct',config.scenario||'direct');
  assert.match(config.expectedVersion || '', /^\d+\.\d+\.\d+$/);
  assert.equal(result.packageVersion, config.expectedVersion);
  assert.equal(result.sourceDigest, config.sourceDigest); assert.equal(result.packageDigest, config.packageDigest);
  assert.equal(result.isolation.installed, true); assert.equal(result.isolation.pid, result.pid); assert.equal(result.isolation.threadId, 0);
  assert.deepEqual(result.backgroundErrors, []); assert.equal(result.closed, true);
  const actions = result.commands.map(row => row.action === 'uiCommand' ? 'uiCommand:' + row.input?.action : row.action);
  if (config.phase === 0) assert.deepEqual(actions, ['controlledPreflightRun']);
  if (config.scenario === 'prepared-upgrade') {
    const expected=[['controlledPreflightRun'],['uiCommand:agentModelPreflightAttest','controlledPreflightPrepareLegacy'],
      ['uiCommand:subscriptionStatus','uiCommand:agentModelPreflightHealthUpgrade'],['controlledPreflightRun'],null,[]];
    if(config.phase===4)assert.ok(actions.length>=1&&actions.length<=8&&actions.every(v=>v==='controlledPreflightRun'));
    else assert.deepEqual(actions,expected[config.phase]);
  } else {
  if (config.phase === 1) assert.deepEqual(actions, [
    ...(config.mode === 'legacy' ? ['uiCommand:agentModelPreflightAttest'] : []), 'uiCommand:subscriptionStatus', 'controlledPreflightRun']);
  if (config.phase === 2) assert.ok(actions.length >= 1 && actions.length <= 8 && actions.every(v => v === 'controlledPreflightRun'));
  if (config.phase === 3) assert.deepEqual(actions, [], 'cold delivery must not dispatch again');
  }
  assert.deepEqual(result.packageSourceMatch, config.desktopInputs.map(row => row.path));
  assertModuleProof(result.mainModules, config, ['engine-client.cjs'], false, result.pid);
  assert.deepEqual(result.states.map(row => row.stage), stagesFor(config)[config.phase]);
  for (const row of result.states) {
    const s = row.state;
    assert.equal(s.isolation.installed, true); assert.equal(s.isolation.pid, result.pid);
    assert.equal(s.isolation.threadId, s.modules.threadId); assert.equal(s.generic.threadId, s.modules.threadId);
    assertModuleProof(s.modules, config, REQUIRED, true, result.pid);
  }
  assert.deepEqual(result.final, result.states.at(-1).state);
}

async function runChild(config) {
  const report = {mode: config.mode, scenario: config.scenario || 'direct', phase: config.phase, pid: process.pid, versions: process.versions,
    sourceDigest: config.sourceDigest, packageDigest: config.packageDigest, status: 'failed', states: [], commands: [], backgroundErrors: []};
  let engine;
  try {
    assert.ok(process.versions.electron, 'Electron runtime required; no Node fallback');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
    report.isolation = installIsolation(config);
    for (const row of config.generated) assert.equal(h.fileHash(row.file), row.sha256, 'generated harness identity changed');
    // Electron fs treats app.asar itself as a virtual directory. Raw archive
    // bytes are hashed by the host immediately before/after every process;
    // never enable original-fs or disable ASAR to evade the installed guard.
    report.packageVersion = read(path.join(config.asar, 'package.json')).version;
    // Explicit missing-module evidence takes precedence over the old version or
    // generic desktop path-set mismatch when exercising a known old package.
    for (const name of ['engine-client.cjs', ...REQUIRED])
      assert.ok(fs.existsSync(path.join(config.asar, 'desktop', name)), 'required package module missing: ' + name);
    assert.equal(report.packageVersion, config.expectedVersion, 'package version must match frozen source');
    assert.ok(!fs.existsSync(path.join(config.asar, 'scripts')) && !fs.existsSync(path.join(config.asar, 'tests')));
    const packaged = h.tree(path.join(config.asar, 'desktop'), rel => /^native\/bin(?:\/|$)/.test(rel))
      .filter(row => row.type === 'file').map(row => 'desktop/' + row.path).sort();
    assert.deepEqual(packaged, config.desktopInputs.map(row => row.path).sort(), 'package/source desktop path set mismatch');
    report.packageSourceMatch = [];
    for (const row of config.desktopInputs) {
      assert.equal(h.fileHash(path.join(config.asar, row.path)), row.sha256, 'package/source mismatch: ' + row.path);
      report.packageSourceMatch.push(row.path);
    }
    const {EngineClient} = require(path.join(config.asar, 'desktop/engine-client.cjs'));
    report.mainModules = moduleProof(config);
    engine = new EngineClient({dir: config.workspace, fixtureModule: config.wrapper,
      workerOptions: {execArgv: ['--require', config.preload]}, safeStorage: {isEncryptionAvailable: () => false},
      native: async action => {
        if (action === 'attentionAvailable') return {supported: false};
        fs.appendFileSync(path.join(config.dir, 'denied-native.jsonl'), JSON.stringify({name: 'native UI: ' + action}) + '\n');
        throw Error('Unexpected native UI operation: ' + action);
      }});
    engine.on('backgroundError', error => report.backgroundErrors.push(error));
    await engine.ready;
    let sequence = 0;
    const probe = () => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { engine.worker.off('message', listener); reject(Error('Worker observation timeout')); }, 15000);
      const listener = message => {
        if (message.type !== 'modelPreflightPackageProof' || message.id !== id) return;
        clearTimeout(timer); engine.worker.off('message', listener);
        message.error ? reject(Error(message.error)) : resolve(message.result);
      };
      engine.worker.on('message', listener); engine.worker.postMessage({type: 'modelPreflightPackageProbe', id});
    });
    const command = async (action, input = {}) => {
      report.commands.push({action, input}); write(config.result, report);
      return engine.dispatch(action, input);
    };
    const capture = async stage => {
      const state = await probe(); report.states.push({stage, state}); report.final = state; write(config.result, report); return state;
    };
    if (config.phase === 0) {
      await command('controlledPreflightRun'); assertFailed(await capture('failed'), config.mode, {cold:false});
    } else {
      const previous = read(config.previous).final, baseline = read(config.baseline).final;
      const seed = baseline.generic.preflight.seed, budget = baseline.generic.budget;
      let s = await capture(stagesFor(config)[config.phase][0]); assertCold(previous, s);
      if(config.scenario==='prepared-upgrade'){
        if(config.phase===1){
          assertFailed(s,config.mode);const v=s.generic.preflight.view;
          await command('uiCommand',{action:'agentModelPreflightAttest',input:{id:s.jobId,taskId:s.taskId,attemptId:v.attemptId,evidenceHash:v.evidenceHash,registryId:v.registry.id,executedBy:'supervisor',authorizationNote:'按已有授权验证旧prepared的原稿恢复',expectedWorkRevision:v.expectedWorkRevision,expectedTaskRevision:v.expectedTaskRevision}});
          await command('controlledPreflightPrepareLegacy');assertLegacyPrepared(await capture('legacy_prepared'));
        }else if(config.phase===2){
          assertLegacyPrepared(s);await command('uiCommand',{action:'subscriptionStatus',input:{}});
          s=await capture('upgrade_health');assertUpgradeHealth(s);const v=s.generic.preflight.view;
          await command('uiCommand',{action:'agentModelPreflightHealthUpgrade',input:{id:s.jobId,taskId:v.taskId,attemptId:v.attemptId,...v.healthUpgrade,executedBy:'supervisor',authorizationNote:'按本人既有授权使用当前模型接续同一原稿；保留原未知费用及200美元累计上限。'}});
          assertUpgraded(await capture('health_upgraded'));
        }else{
          const health=read(config.healthPhase).states.find(row=>row.stage==='upgrade_health').state.health;
          if(config.phase===3){assertUpgraded(s);await command('controlledPreflightRun');s=await capture('first_revision');assertPreflightCheckpoint(s);}
          else if(config.phase===4){assertPreflightCheckpoint(s);for(let i=0;i<8&&s.jobStatus!=='review';i++){await command('controlledPreflightRun');s=await probe();}s=await capture('verified_delivery');}
          assertRecovered(s,seed,budget,config.mode,health);
          if(config.phase>=4){h.assertGenericComplete(s);assert.deepEqual(s.generic.audit.checks,['content','result','goal']);}
        }
      } else if (config.phase === 1) {
        assertFailed(s, config.mode);
        if (config.mode === 'legacy') {
          const v = s.generic.preflight.view;
          await command('uiCommand', {action: 'agentModelPreflightAttest', input: {id: s.jobId, taskId: s.taskId,
            attemptId: v.attemptId, evidenceHash: v.evidenceHash, registryId: v.registry.id, executedBy: 'supervisor',
            authorizationNote: '按用户已有修复后恢复原事项的授权进行受控最终包验证',
            expectedWorkRevision: v.expectedWorkRevision, expectedTaskRevision: v.expectedTaskRevision}});
        }
        await command('uiCommand', {action: 'subscriptionStatus', input: {}});
        const healthy = await capture('attested_health'); assertHealth(healthy, s, config.mode);
        await command('controlledPreflightRun'); s = await capture('first_revision');
        assertPreflightCheckpoint(s); assertRecovered(s, seed, budget, config.mode, healthy.health);
      } else {
        const health = read(config.healthPhase).states.find(row => row.stage === 'attested_health').state.health;
        if (config.phase === 2) {
          assertPreflightCheckpoint(s); assertRecovered(s, seed, budget, config.mode, health);
          for (let i = 0; i < 8 && s.jobStatus !== 'review'; i++) { await command('controlledPreflightRun'); s = await probe(); }
          s = await capture('verified_delivery');
        }
        h.assertGenericComplete(s); assertRecovered(s, seed, budget, config.mode, health);
        assert.deepEqual(s.generic.audit.checks, ['content', 'result', 'goal']);
      }
    }
    assert.deepEqual(report.backgroundErrors, []); report.status = 'passed';
  } catch (error) { report.error = error.stack || error.message; }
  finally {
    if (engine) {
      try { await engine.close(); report.closed = true; }
      catch (error) { report.status = 'failed'; report.closeError = error.stack || error.message; }
    }
    if (report.backgroundErrors.length) report.status = 'failed';
    report.endedAt = new Date().toISOString(); write(config.result, report);
  }
  return report;
}

async function spawnPhase(binary, configFile, config) {
  const stdout = path.join(config.dir, 'stdout.log'), stderr = path.join(config.dir, 'stderr.log');
  const out = fs.openSync(stdout, 'wx', 0o600), err = fs.openSync(stderr, 'wx', 0o600);
  try {
    return await new Promise(resolve => {
      const child = require('node:child_process').spawn(binary, [config.harness, '--child', configFile],
        {cwd: config.dir, env: h.childEnvironment(config.root, configFile), stdio: ['ignore', out, err]});
      let timedOut = false, error;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 110000);
      child.on('error', e => { error = e.message; });
      child.on('close', (code, signal) => {
        clearTimeout(timer); resolve({pid: child.pid, code, signal, error, timedOut, stdout, stderr});
      });
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
}

function outputPath(options) {
  parseArgs(['--app', options.app, '--output', options.output]);
  const requested = path.resolve(options.app), app = fs.existsSync(requested) ? fs.realpathSync(requested) : requested;
  let ancestor = path.dirname(options.output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const parent = path.join(fs.realpathSync(ancestor), path.relative(ancestor, path.dirname(options.output)));
  const source = fs.realpathSync(SOURCE), output = path.join(parent, path.basename(options.output));
  assert.ok(!inside(app, output), 'report must be outside selected .app');
  assert.ok(!inside(source, output) || inside(path.join(source, 'artifacts'), output), 'report must be outside source inputs');
  assert.ok(!/\/(?:Library|\.codex|\.config|\.local-data)(?:\/|$)/.test(output), 'report must not use a production profile');
  assert.ok(!fs.existsSync(output), 'report already exists; use a new output path');
  return {source, app, output};
}

async function run(options) {
  const {source, app, output} = outputPath(options);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const report = {schema: VERSION, layer: 'controlled', passed: false, status: 'failed',
    productionDelivery: 'not_verified', userAccepted: false, realBusinessCalls: 0, realNetworkCalls: 0, realModelCalls: 0,
    startedAt: new Date().toISOString(), phases: [],
    limitations: ['Headless real Electron/Worker RPC; no renderer or production main entry',
      'Synthetic model/platform/connector answers; trusted uiCommand exercised only in temporary workspaces',
      'JS guards are test isolation, not an OS security sandbox; native bundle bytes hashed, not executed',
      'Prepared-upgrade alone uses an explicit historical cache/marker producer adapter; all subsequent UI checks, upgrade, claim and replay use selected-package runtime']};
  let beforeSource, beforePackage;
  // Independent persistent evidence directory, including on missing-package or
  // missing-module failure. The release gate can collect it without rerunning.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-preflight-package-')));
  report.evidence = root;
  try {
    beforeSource = report.source = h.sourceIdentity(source); report.sourceDigest = beforeSource.digest;
    beforePackage = report.package = h.packageIdentity(app); report.packageDigest = beforePackage.digest;
    report.runtime = executable(app);
    report.releaseRunnerBinding = {runId: process.env.SYSTEM_RELEASE_RUN_ID || null,
      sourceDigest: process.env.SYSTEM_RELEASE_SOURCE_DIGEST || null, packageDigest: process.env.SYSTEM_RELEASE_PACKAGE_DIGEST || null,
      scope: 'external runner claims, separate from computed local identities'};
    const asar = path.join(app, 'Contents/Resources/app.asar'), desktop = path.join(asar, 'desktop');
    const harness = path.join(root, 'model-preflight-package-worker.cjs'), helper = path.join(root, 'system-package-worker.cjs');
    const fixture = path.join(root, 'model-preflight-worker-fixture.cjs');
    const helpers = {common: path.join(root, 'generic-consumption-worker-fixture.cjs'),
      platform: path.join(root, 'platform-fixture.cjs'), physical: path.join(root, 'physical-fixture.cjs')};
    fs.copyFileSync(__filename, harness); fs.copyFileSync(path.join(__dirname, 'system-package-worker.cjs'), helper);
    for (const [i, file] of [fixture, helpers.common, helpers.platform, helpers.physical].entries())
      fs.writeFileSync(file, adaptFixture(fs.readFileSync(path.join(source, FIXTURES[i]), 'utf8'), desktop, helpers));
    const preload = path.join(root, 'guard.cjs'), wrapper = path.join(root, 'worker-fixture.cjs');
    fs.writeFileSync(preload, `const c=JSON.parse(require('node:fs').readFileSync(process.env.SYSTEM_PACKAGE_WORKER_CONFIG,'utf8'));c.workerIsolation=require(${JSON.stringify(harness)}).installIsolation(c);globalThis.__modelPreflightPackageConfig=c;\n`);
    fs.writeFileSync(wrapper, `exports.create=input=>require(${JSON.stringify(harness)}).createFixture(input,globalThis.__modelPreflightPackageConfig);\n`);
    const generated = [harness, helper, fixture, ...Object.values(helpers), preload, wrapper].map(file => ({file, sha256: h.fileHash(file)}));
    report.fixture = {original: ['scripts/model-preflight-package-worker.cjs', 'scripts/system-package-worker.cjs', ...FIXTURES]
      .map(file => ({path: file, sha256: h.fileHash(path.join(source, file))})), generated,
      adaptation: 'literal require redirection only; only fixture/helpers are external, every application import resolves to selected ASAR'};
    const desktopInputs = beforeSource.entries.filter(row => row.type === 'file' && row.path.startsWith('desktop/'));
    for (const name of ['engine-client.cjs', ...REQUIRED]) assert.ok(desktopInputs.some(row => row.path === 'desktop/' + name));
    for (const {mode,scenario,label} of [{mode:'legacy',scenario:'direct',label:'legacy'},{mode:'native',scenario:'direct',label:'native'},{mode:'legacy',scenario:'prepared-upgrade',label:'prepared-upgrade'}]) {
      const modeDir = path.join(root, label), workspace = path.join(modeDir, 'profile/workspace'), audit = path.join(modeDir, 'transport-audit.json');
      fs.mkdirSync(workspace, {recursive: true});
      for (let phase = 0; phase < stagesFor({scenario}).length; phase++) {
        const phaseDir = path.join(modeDir, 'phase-' + phase); fs.mkdirSync(phaseDir);
        const resultPath = n => path.join(modeDir, 'phase-' + n, 'result.json');
        const config = {root, dir: root, asar, harness, helper, fixture, preload, wrapper, workspace, audit,
          generated, desktopInputs, sourceDigest: report.sourceDigest, packageDigest: report.packageDigest, asarSHA256: beforePackage.asarSHA256,
          mode, scenario, phase, expectedVersion: read(path.join(source, 'package.json')).version, result: resultPath(phase), previous: phase ? resultPath(phase - 1) : null,
          baseline: resultPath(0), healthPhase: resultPath(scenario==='prepared-upgrade'?2:1)};
        const configFile = path.join(phaseDir, 'config.json'); write(configFile, config);
        // IO isolation spans the common harness and mode workspace; process log
        // destinations stay distinct for each cold Electron process.
        assert.equal(h.fileHash(asar), beforePackage.asarSHA256, 'ASAR changed before cold process');
        const execution = await spawnPhase(report.runtime.binary, configFile, {...config, dir: phaseDir});
        const result = fs.existsSync(config.result) ? read(config.result) : null;
        report.phases.push({mode, scenario, phase, execution, result}); write(output, report);
        assertPhase(result, execution, config);
        assert.equal(h.fileHash(asar), beforePackage.asarSHA256, 'ASAR changed between cold processes');
      }
      const auditData = read(audit);
      assert.equal(auditData.audit.creates, 1); assert.equal(auditData.audit.writes, 1);
      report[label] = {audit, controlledCalls: {model: report.phases.at(-1).result.final.modelCalls,
        platform: auditData.audit.queries.length, connector: auditData.audit.creates + auditData.audit.writes + auditData.audit.readbacks}};
    }
    assert.equal(report.phases.length, 14);
    assert.equal(new Set(report.phases.map(p => p.result.pid)).size, 14, 'distinct Electron processes required');
    report.assertions = ['legacy and native actual failure -> cold -> trusted attestation/health -> original draft -> cold -> two batches/checks/same-target delivery -> cold',
      'actual ASAR health/recovery/consumption/core/efficiency/run-models/execution-policy loads with path/hash proof',
      'old request/run preserved; one recovery claim; two receipts; one verified same-target write; no acceptance',
      'legacy prepared cache identity -> v2 UI health -> CAS-bound upgrade -> cold -> same grant claim; historical recovery_pending counters and raw ledger retained',
      'same source/package identities across all processes; no active-source application fallback'];
    report.status = 'passed'; report.passed = true;
  } catch (error) { report.error = error.stack || error.message; }
  finally {
    try {
      report.blockedExternalAttempts = fs.readdirSync(root).filter(name => name.startsWith('denied-'))
        .flatMap(name => fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
      if (report.blockedExternalAttempts.length) {
        report.status = 'failed'; report.passed = false; report.isolationError = 'unexpected real external/native/filesystem attempt';
      }
      for (const row of report.fixture?.generated || []) assert.equal(h.fileHash(row.file), row.sha256, 'harness changed during execution');
      if (beforeSource) { report.afterSource = h.sourceIdentity(source); report.afterSourceDigest = report.afterSource.digest; }
      if (beforePackage) { report.afterPackage = h.packageIdentity(app); report.afterPackageDigest = report.afterPackage.digest; }
      if (beforeSource) assert.equal(report.afterSourceDigest, report.sourceDigest, 'source changed during execution');
      if (beforePackage) assert.equal(report.afterPackageDigest, report.packageDigest, 'package changed during execution');
    } catch (error) { report.status = 'stale'; report.passed = false; report.identityError = error.stack || error.message; }
    report.endedAt = new Date().toISOString();
    write(path.join(root, 'summary.json'), report);
    report.evidenceFiles = h.tree(root);
    write(output, report);
  }
  return report;
}

module.exports = {VERSION, REQUIRED, FIXTURES, STAGES, UPGRADE_STAGES, stagesFor, parseArgs, adaptFixture, installIsolation, createFixture,
  assertModuleProof, assertPhase, assertFailed, assertPreflightCheckpoint, assertHealth, assertRecovered, assertCold,
  assertLegacyPrepared, assertUpgradeHealth, assertUpgraded, assertOwnerSelected, outputPath, run};
if (require.main === module) (async () => {
  if (process.argv[2] === '--child') {
    const report = await runChild(read(process.argv[3])); process.exitCode = report.status === 'passed' ? 0 : 1;
  } else {
    const options = parseArgs(process.argv.slice(2)), report = await run(options);
    console.log(JSON.stringify({status: report.status, passed: report.passed, layer: report.layer, output: options.output,
      evidence: report.evidence, sourceDigest: report.sourceDigest, packageDigest: report.packageDigest, realBusinessCalls: report.realBusinessCalls}));
    process.exitCode = report.passed ? 0 : 1;
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
