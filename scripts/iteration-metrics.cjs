#!/usr/bin/env node
'use strict';

// Local observation ledger, never release authority. Public APIs are synchronous.
// CLI: <init|record|import-run|report> --input <JSON file containing API arguments>.
// record also accepts --dir <dir> --event <event JSON>; report --dir <dir>.
// Payloads (all IDs are opaque strings, times RFC3339 with explicit timezone):
// phase_started/ended: {phaseId, phase, timing?: actual|estimated|unknown, reason?}
// defect: {defectId, severity: P0..P3, stage: pre_release|post_release, rootCauseId}
// candidate_result: {candidateId, attemptId, status: passed|failed,
//   classification: product|test|environment|unknown, classificationReason?, ...}
// candidate_invalidated: {candidateId, decidedBy, decision: invalidate, reason}
// candidate_accepted: {candidateId,sourceDigest,packageDigest,gateDir,mappingFile,
//   implementationReview}; adding this fact revalidates the whole gate.check.
// acceptCandidate({dir,gateDir,mappingFile,implementationReview,actor?,occurredAt?})
// collects its evidence and records it (actor defaults to release-runner).
// Only this overall acceptance ends an invalidation streak; group results never do.
// attempt_failed: {attemptId, command:{executable,argv,cwd}|[command,...argv], phase, errorCode?,
//   error, startedAt, endedAt, classification: preflight_rejection|product|test|environment}
// cost: {measurementId,provider,model,status:actual|estimated|unknown,currency:USD,
//   amount,inputTokens,cachedInputTokens,outputTokens,inputIncludesCached,basis,reason?}
// correction: {targetEventId,reason,replacement:<event without eventId/recordedAt>|null}
// Corrections target the latest revision, preserve type and measurementId, and
// never rewrite old bytes. Different measurements with the same ID need correction.
// report() returns JSON with markdown; markdown(report) is also exported.
// importRun also accepts runId (UUID); CLI: --run-id. Omit for the active run.
// Historical import never rewrites the active pointer or grants release readiness.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FORMAT = 'iteration-metrics/v1';
const TYPES = ['iteration_started', 'phase_started', 'phase_ended', 'defect',
  'candidate_invalidated', 'candidate_accepted', 'candidate_result', 'attempt_failed', 'cost', 'correction', 'iteration_closed'];
const PHASES = ['design', 'implementation', 'review', 'verification', 'wait'];
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), {code}); }
function need(ok, message, code = 'METRICS_INVALID') { if (!ok) fail(code, message); }
function object(v, name) {
  need(v && typeof v === 'object' && !Array.isArray(v)
    && [Object.prototype, null].includes(Object.getPrototypeOf(v)), `${name} must be a JSON object`);
}
function string(v, name) { need(typeof v === 'string' && v.trim() && v.length <= 16384 && !v.includes('\0'), `invalid ${name}`); }
function keys(v, allowed, name) { object(v, name); need(Object.keys(v).every(k => allowed.includes(k)), `unknown ${name} field`); }
function choice(v, values, name) { need(values.includes(v), `invalid ${name}`); }
function time(v, name) {
  string(v, name);
  need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v)
    && Number.isFinite(Date.parse(v)), `invalid ${name}`);
  const date = v.slice(0, 10), parsed = new Date(date + 'T00:00:00Z');
  need(parsed.toISOString().slice(0, 10) === date, `invalid calendar date: ${name}`);
  return Date.parse(v);
}
function canonical(v, seen = new Set()) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { need(Number.isFinite(v), 'non-finite JSON number'); return JSON.stringify(v); }
  need(v && typeof v === 'object' && !seen.has(v), 'non-JSON/cyclic value');
  seen.add(v);
  let result;
  if (Array.isArray(v)) {
    need(Object.keys(v).length === v.length, 'sparse/non-JSON array');
    result = '[' + v.map(x => canonical(x, seen)).join(',') + ']';
  } else {
    object(v, 'value');
    result = '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k], seen)).join(',') + '}';
  }
  seen.delete(v); return result;
}
const digest = v => hash(canonical(v));
function command(v) {
  if (Array.isArray(v)) {
    need(v.length > 0 && v.every(x => typeof x === 'string' && !x.includes('\0')), 'command must be a nonempty argv array');
    string(v[0], 'command name'); return;
  }
  keys(v, ['executable', 'argv', 'cwd'], 'command');
  string(v.executable, 'command.executable'); string(v.cwd, 'command.cwd');
  need(Array.isArray(v.argv) && v.argv.every(x => typeof x === 'string' && !x.includes('\0')), 'command.argv must be strings');
}
function normalizeEvent(input, replacement = false) {
  keys(input, ['eventId', 'type', 'occurredAt', 'actor', 'origin', 'payload', 'evidence', 'recordedAt'], 'event');
  const e = JSON.parse(canonical(input));
  if (!replacement) string(e.eventId, 'eventId');
  choice(e.type, TYPES, 'event type'); time(e.occurredAt, 'occurredAt'); string(e.actor, 'actor');
  choice(e.origin, ['observed', 'imported'], 'origin');
  if (own(e, 'recordedAt')) time(e.recordedAt, 'recordedAt');
  delete e.recordedAt;
  object(e.payload, 'payload');
  need(Array.isArray(e.evidence), 'evidence must be an array');
  const paths = new Set();
  for (const ref of e.evidence) {
    keys(ref, ['path', 'sha256'], 'evidence'); string(ref.path, 'evidence.path');
    need(path.isAbsolute(ref.path) && path.normalize(ref.path) === ref.path, 'evidence.path must be a normalized absolute path');
    need(SHA.test(ref.sha256), 'invalid evidence SHA256');
    need(!paths.has(ref.path), 'duplicate evidence path'); paths.add(ref.path);
  }
  e.evidence.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const p = e.payload;
  switch (e.type) {
    case 'iteration_started': case 'iteration_closed': string(p.iterationId, 'iterationId'); break;
    case 'phase_started': case 'phase_ended':
      string(p.phaseId, 'phaseId'); choice(p.phase, PHASES, 'phase');
      if (p.timing !== undefined) choice(p.timing, ['actual', 'estimated', 'unknown'], 'phase timing');
      if (p.timing && p.timing !== 'actual') string(p.reason, 'phase timing reason');
      break;
    case 'defect':
      string(p.defectId, 'defectId'); string(p.rootCauseId, 'rootCauseId');
      choice(p.severity, ['P0', 'P1', 'P2', 'P3'], 'severity');
      choice(p.stage, ['pre_release', 'post_release'], 'defect stage'); break;
    case 'candidate_invalidated':
      string(p.candidateId, 'candidateId'); string(p.decidedBy, 'decidedBy'); string(p.reason, 'reason');
      need(p.decidedBy === e.actor && p.decision === 'invalidate' && e.evidence.length > 0,
        'invalidation requires the explicit integrator decision and evidence'); break;
    case 'candidate_accepted':
      keys(p, ['candidateId', 'sourceDigest', 'packageDigest', 'gateDir', 'mappingFile', 'implementationReview'], 'candidate acceptance');
      for (const key of ['candidateId', 'sourceDigest', 'packageDigest']) need(SHA.test(p[key]), `invalid ${key}`);
      for (const key of ['gateDir', 'mappingFile', 'implementationReview']) {
        string(p[key], key); need(path.isAbsolute(p[key]) && path.normalize(p[key]) === p[key], `invalid ${key} path`);
      }
      need(e.evidence.length > 0, 'whole candidate acceptance requires gate evidence'); break;
    case 'candidate_result':
      string(p.candidateId, 'candidateId'); string(p.attemptId, 'attemptId');
      choice(p.status, ['passed', 'failed'], 'candidate status');
      choice(p.classification, ['product', 'test', 'environment', 'unknown'], 'classification');
      if (p.classification === 'unknown') string(p.classificationReason, 'classificationReason');
      if (own(p, 'startedAt') || own(p, 'endedAt'))
        need(time(p.endedAt, 'endedAt') >= time(p.startedAt, 'startedAt'), 'candidate attempt ends before start');
      need(e.evidence.length > 0, 'candidate result requires evidence'); break;
    case 'attempt_failed':
      string(p.attemptId, 'attemptId'); command(p.command); string(p.phase, 'phase');
      if (p.errorCode === undefined) p.errorCode = null;
      if (p.errorCode !== null) string(p.errorCode, 'errorCode');
      string(p.error, 'error');
      need(time(p.endedAt, 'endedAt') >= time(p.startedAt, 'startedAt'), 'attempt ends before start');
      need(time(e.occurredAt, 'occurredAt') >= time(p.startedAt, 'startedAt'), 'attempt occurrence predates start');
      choice(p.classification, ['preflight_rejection', 'product', 'test', 'environment'], 'attempt classification'); break;
    case 'cost':
      for (const key of ['measurementId', 'provider', 'model', 'basis']) string(p[key], key);
      choice(p.status, ['actual', 'estimated', 'unknown'], 'cost status'); need(p.currency === 'USD', 'currency must be USD');
      need(typeof p.inputIncludesCached === 'boolean' || (p.inputIncludesCached === null
        && p.inputTokens === null && p.cachedInputTokens === null), 'inputIncludesCached must declare the token basis or unknown with null input tokens');
      for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens'])
        need(p[key] === null || (Number.isSafeInteger(p[key]) && p[key] >= 0), `invalid ${key}`);
      if (p.inputIncludesCached && p.inputTokens !== null && p.cachedInputTokens !== null)
        need(p.cachedInputTokens <= p.inputTokens, 'cached tokens exceed inclusive input');
      if (p.status === 'unknown') { need(p.amount === null, 'unknown cost cannot have amount'); string(p.reason, 'unknown reason'); }
      else need(typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount >= 0, 'known cost requires nonnegative amount');
      if (p.status === 'actual') need(e.evidence.length > 0, 'actual cost requires receipt evidence');
      break;
    case 'correction':
      need(!replacement, 'correction cannot replace a correction');
      keys(p, ['targetEventId', 'reason', 'replacement'], 'correction payload');
      string(p.targetEventId, 'targetEventId'); string(p.reason, 'correction reason');
      need(own(p, 'replacement'), 'correction must explicitly replace or retract');
      if (p.replacement !== null) {
        need(!own(p.replacement, 'eventId') && !own(p.replacement, 'recordedAt'), 'replacement identity is the correction eventId');
        p.replacement = normalizeEvent(p.replacement, true);
        need(p.replacement.type !== 'correction', 'nested correction');
      }
      break;
  }
  return e;
}
// Only collection origin and recordedAt are excluded. Replacement origin is
// also collection metadata; original actor, time, evidence and all payload stay.
function stable(e) {
  const value = {...e}; delete value.origin; delete value.recordedAt;
  if (e.type === 'correction' && e.payload.replacement)
    value.payload = {...e.payload, replacement: stable(e.payload.replacement)};
  return value;
}
function factIdentity(e) { const result = stable(e); delete result.eventId; return canonical(result); }
function effective(events) {
  const active = new Map(), roots = new Map(), heads = new Map(), latestAliases = new Map(), measurements = new Map();
  for (const e of events) {
    if (e.type !== 'correction') {
      if (e.type === 'cost') {
        const root = measurements.get(e.payload.measurementId);
        if (root) {
          // Identical observations are aliases of one measurement revision.
          // Later correction supersedes all those aliases, never their bytes.
          need(active.has(root) && factIdentity(heads.get(root)) === factIdentity(e),
            `conflicting measurement ${e.payload.measurementId}; append a correction`, 'METRICS_CONFLICT');
          roots.set(e.eventId, root); latestAliases.get(root).add(e.eventId); continue;
        }
        measurements.set(e.payload.measurementId, e.eventId);
      }
      active.set(e.eventId, e); roots.set(e.eventId, e.eventId); heads.set(e.eventId, e);
      latestAliases.set(e.eventId, new Set([e.eventId])); continue;
    }
    const p = e.payload, root = roots.get(p.targetEventId), old = heads.get(root);
    need(old && latestAliases.get(root).has(p.targetEventId) && p.targetEventId !== e.eventId,
      'correction target must exist and be the latest revision', 'METRICS_CORRECTION');
    const r = p.replacement;
    need(old.type !== 'iteration_started' || r !== null, 'cannot retract iteration start', 'METRICS_CORRECTION');
    if (r) {
      need(r.type === old.type, 'correction must preserve fact type', 'METRICS_CORRECTION');
      if (old.type === 'cost') need(r.payload.measurementId === old.payload.measurementId,
        'correction must preserve measurementId', 'METRICS_CORRECTION');
      active.set(root, {...r, eventId: e.eventId, recordedAt: e.recordedAt});
    } else active.delete(root);
    heads.set(root, {...(r || old), eventId: e.eventId});
    latestAliases.set(root, new Set([e.eventId]));
    roots.set(e.eventId, root);
  }
  return [...active.values()];
}
function regular(file) {
  need(fs.lstatSync(file).isFile(), `not a regular file: ${file}`, 'METRICS_STORAGE');
  need(fs.realpathSync(file) === path.resolve(file), `linked path: ${file}`, 'METRICS_STORAGE');
}
function readJSON(file) {
  regular(file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail('METRICS_CORRUPT', `invalid JSON at ${file}: ${error.message}`); }
}
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeExclusive(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, canonical(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomicJSON(file, value, replace = false) {
  const tmp = file + '.' + crypto.randomUUID() + '.pending';
  writeExclusive(tmp, value);
  if (replace) fs.renameSync(tmp, file);
  else { fs.linkSync(tmp, file); fs.unlinkSync(tmp); } // no overwrite race
  syncDir(path.dirname(file));
}
function withLock(dir, fn, create = false) {
  string(dir, 'dir'); dir = path.resolve(dir);
  if (create) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  need(fs.lstatSync(dir).isDirectory() && fs.realpathSync(dir) === dir, 'ledger directory must not traverse symlinks', 'METRICS_STORAGE');
  const lock = path.join(dir, '.lock');
  try { writeExclusive(lock, {pid: process.pid, createdAt: new Date().toISOString()}); }
  catch (error) {
    if (error.code === 'EEXIST') fail('METRICS_LOCKED', `ledger locked: ${lock}; no automatic takeover. Confirm the writer has stopped, preserve a copy, verify events against HEAD and original evidence before manual recovery.`);
    throw error;
  }
  const transaction = {dirty: false};
  try {
    const result = fn(dir, transaction);
    fs.unlinkSync(lock); syncDir(dir); return result;
  } catch (error) {
    if (!transaction.dirty) fs.unlinkSync(lock);
    else error.message += `; incomplete write: preserve ${dir} and inspect .lock/HEAD/events before manual recovery (never reset)`;
    throw error;
  }
}
function readLedger(dir) {
  const allowed = ['.lock', 'meta.json', 'HEAD.json', 'events'];
  need(fs.readdirSync(dir).every(n => allowed.includes(n)), 'unexpected/incomplete ledger file', 'METRICS_CORRUPT');
  const meta = readJSON(path.join(dir, 'meta.json')), head = readJSON(path.join(dir, 'HEAD.json'));
  keys(meta, ['format', 'iterationId'], 'ledger metadata'); need(meta.format === FORMAT, 'unsupported ledger format');
  string(meta.iterationId, 'iterationId');
  keys(head, ['sequence', 'hash'], 'ledger HEAD');
  need(Number.isSafeInteger(head.sequence) && head.sequence > 0 && SHA.test(head.hash), 'invalid HEAD', 'METRICS_CORRUPT');
  const eventDir = path.join(dir, 'events');
  need(fs.lstatSync(eventDir).isDirectory() && fs.realpathSync(eventDir) === eventDir, 'linked events directory', 'METRICS_STORAGE');
  const names = fs.readdirSync(eventDir).sort();
  need(names.length === head.sequence, 'event chain truncated or uncommitted; HEAD count mismatch', 'METRICS_CORRUPT');
  let previousHash = digest(meta);
  const events = [], ids = new Set();
  for (let i = 0; i < names.length; i++) {
    need(names[i] === `${String(i + 1).padStart(12, '0')}.json`, 'event chain gap/unexpected file', 'METRICS_CORRUPT');
    const row = readJSON(path.join(eventDir, names[i]));
    keys(row, ['sequence', 'previousHash', 'event', 'hash'], 'event envelope');
    need(row.sequence === i + 1 && row.previousHash === previousHash
      && row.hash === digest({sequence: row.sequence, previousHash: row.previousHash, event: row.event}), 'broken event hashchain', 'METRICS_CORRUPT');
    const normalized = normalizeEvent(row.event); time(row.event.recordedAt, 'recordedAt');
    need(canonical({...normalized, recordedAt: row.event.recordedAt}) === canonical(row.event), 'noncanonical event', 'METRICS_CORRUPT');
    need(!ids.has(row.event.eventId), 'duplicate stored eventId', 'METRICS_CORRUPT'); ids.add(row.event.eventId);
    events.push(row.event); previousHash = row.hash;
  }
  need(previousHash === head.hash, 'HEAD hash mismatch', 'METRICS_CORRUPT');
  summarize(meta, events); // validates corrections, fact identities and timelines too
  return {meta, head, events};
}
function append(dir, ledger, inputs, transaction) {
  const all = [...ledger.events], byId = new Map(all.map(e => [e.eventId, e])), results = [], additions = [];
  for (const input of inputs) {
    const e = normalizeEvent(input), existing = byId.get(e.eventId);
    if (existing) {
      need(canonical(stable(existing)) === canonical(stable(e)), `eventId semantic conflict: ${e.eventId}`, 'METRICS_CONFLICT');
      results.push({event: existing, duplicate: true}); continue;
    }
    for (const ref of [...e.evidence, ...(e.type === 'correction' ? e.payload.replacement?.evidence || [] : [])]) {
      regular(ref.path);
      need(hash(fs.readFileSync(ref.path)) === ref.sha256, `evidence changed: ${ref.path}`, 'METRICS_EVIDENCE');
    }
    const fact = e.type === 'correction' ? e.payload.replacement : e;
    if (fact?.type === 'candidate_accepted') verifyAcceptance(fact);
    e.recordedAt = new Date().toISOString();
    byId.set(e.eventId, e); all.push(e); additions.push(e); results.push({event: e, duplicate: false});
  }
  summarize(ledger.meta, all);
  if (!additions.length) return results;
  transaction.dirty = true;
  let {sequence, hash: previousHash} = ledger.head;
  for (const event of additions) {
    const body = {sequence: ++sequence, previousHash, event};
    const row = {...body, hash: digest(body)};
    atomicJSON(path.join(dir, 'events', `${String(sequence).padStart(12, '0')}.json`), row);
    previousHash = row.hash;
  }
  atomicJSON(path.join(dir, 'HEAD.json'), {sequence, hash: previousHash}, true);
  transaction.dirty = false; return results;
}
function init({dir, iterationId, actor, occurredAt}) {
  string(iterationId, 'iterationId'); string(actor, 'actor'); time(occurredAt, 'occurredAt');
  const event = {eventId: `iteration:${iterationId}:started`, type: 'iteration_started', occurredAt,
    actor, origin: 'observed', payload: {iterationId}, evidence: []};
  return withLock(dir, (root, transaction) => {
    if (fs.existsSync(path.join(root, 'meta.json'))) {
      const ledger = readLedger(root);
      need(ledger.meta.iterationId === iterationId, 'iteration already initialized with another identity', 'METRICS_CONFLICT');
      return append(root, ledger, [event], transaction)[0];
    }
    need(fs.readdirSync(root).every(n => n === '.lock'), 'init requires an empty directory; refusing reset', 'METRICS_STORAGE');
    transaction.dirty = true;
    const meta = {format: FORMAT, iterationId};
    fs.mkdirSync(path.join(root, 'events'), {mode: 0o700}); atomicJSON(path.join(root, 'meta.json'), meta);
    return append(root, {meta, head: {sequence: 0, hash: digest(meta)}, events: []}, [event], transaction)[0];
  }, true);
}
function record({dir, event}) {
  return withLock(dir, (root, transaction) => append(root, readLedger(root), [event], transaction)[0]);
}
function uniqueFact(map, id, e, label) {
  const old = map.get(id);
  need(!old || factIdentity(old) === factIdentity(e), `conflicting ${label} ${id}; append a correction`, 'METRICS_CONFLICT');
  if (!old) map.set(id, e);
}
function summarize(meta, raw) {
  const events = effective(raw).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const starts = events.filter(e => e.type === 'iteration_started'), closes = events.filter(e => e.type === 'iteration_closed');
  need(starts.length === 1 && closes.length <= 1, 'iteration must have one start and at most one close', 'METRICS_TIMELINE');
  need([...starts, ...closes].every(e => e.payload.iterationId === meta.iterationId), 'iteration identity mismatch');
  const start = starts[0].occurredAt, end = closes[0]?.occurredAt || null;
  need(!end || Date.parse(end) >= Date.parse(start), 'iteration ends before start', 'METRICS_TIMELINE');
  const phases = new Map(), ends = new Map(), defects = new Map(), attempts = new Map(), costs = new Map();
  const invalidated = new Map(), firstSeen = new Map(), accepted = new Set(), warnings = [];
  let streak = [], lastInvalidation = -Infinity;
  for (const e of events) {
    const p = e.payload, at = Date.parse(e.occurredAt);
    need(at >= Date.parse(start), 'fact predates iteration start', 'METRICS_TIMELINE');
    if (end) need(at <= Date.parse(end), 'fact follows iteration close; correct close first', 'METRICS_TIMELINE');
    if (p.candidateId && !firstSeen.has(p.candidateId)) firstSeen.set(p.candidateId, at);
    if (e.type === 'phase_started') uniqueFact(phases, p.phaseId, e, 'phase start');
    if (e.type === 'phase_ended') uniqueFact(ends, p.phaseId, e, 'phase end');
    if (e.type === 'defect') uniqueFact(defects, p.defectId, e, 'defect');
    if (e.type === 'cost') uniqueFact(costs, p.measurementId, e, 'measurement');
    if (e.type === 'attempt_failed' || e.type === 'candidate_result') {
      uniqueFact(attempts, p.attemptId, e, 'attempt');
      if (p.startedAt) need(Date.parse(p.startedAt) >= Date.parse(start) && (!end || Date.parse(p.endedAt) <= Date.parse(end)),
        'attempt outside iteration timeline', 'METRICS_TIMELINE');
    }
    if (e.type === 'candidate_invalidated' && !invalidated.has(p.candidateId)) {
      invalidated.set(p.candidateId, e); streak.push(p.candidateId); lastInvalidation = at;
      if (streak.length === 2) warnings.push({code: 'CONVERGENCE_REVIEW_REQUIRED', occurredAt: e.occurredAt,
        candidateIds: [...streak], message: '连续两次候选被明确推翻：复核影响分析、假设与测试契约。此提示不改变 gate 状态。'});
    }
    if (e.type === 'candidate_accepted') {
      accepted.add(p.candidateId);
      if (!invalidated.has(p.candidateId) && firstSeen.get(p.candidateId) > lastInvalidation) streak = [];
    }
  }
  const phaseRows = [];
  for (const id of ends.keys()) need(phases.has(id), `phase end without start: ${id}`, 'METRICS_TIMELINE');
  for (const [id, a] of phases) {
    const b = ends.get(id), timing = a.payload.timing || 'actual';
    if (b) need(b.payload.phase === a.payload.phase && (b.payload.timing || 'actual') === timing
      && Date.parse(b.occurredAt) >= Date.parse(a.occurredAt), `phase mismatch/negative duration: ${id}`, 'METRICS_TIMELINE');
    phaseRows.push({phaseId: id, phase: a.payload.phase, actor: a.actor, timing,
      startedAt: a.occurredAt, endedAt: b?.occurredAt || null, status: b ? 'ended' : 'ongoing',
      durationMs: b && timing !== 'unknown' ? Date.parse(b.occurredAt) - Date.parse(a.occurredAt) : null,
      reason: a.payload.reason || null});
  }
  const defectRows = [...defects.values()].map(e => ({...e.payload, eventId: e.eventId}));
  const rootCauses = {};
  for (const d of defectRows) {
    if (!own(rootCauses, d.rootCauseId)) Object.defineProperty(rootCauses, d.rootCauseId, {value: [], enumerable: true});
    rootCauses[d.rootCauseId].push(d.defectId);
  }
  const failures = [...attempts.values()].filter(e => e.type === 'attempt_failed' || e.payload.status === 'failed');
  const costRows = [...costs.values()].map(e => {
    const p = e.payload;
    const totalInputTokens = p.inputTokens === null || (!p.inputIncludesCached && p.cachedInputTokens === null)
      ? null : p.inputTokens + (p.inputIncludesCached ? 0 : p.cachedInputTokens);
    need(totalInputTokens === null || Number.isSafeInteger(totalInputTokens), 'token total overflow');
    return {...p, eventId: e.eventId, totalInputTokens};
  });
  const unknown = costRows.filter(c => c.status === 'unknown').map(c => ({measurementId: c.measurementId, reason: c.reason}));
  if (!costRows.length) unknown.push({measurementId: null, reason: 'No cost receipt or measurement collected for this iteration.'});
  const sum = status => costRows.filter(c => c.status === status).reduce((n, c) => n + c.amount, 0);
  const actualUSD = sum('actual'), estimatedUSD = sum('estimated');
  need(Number.isFinite(actualUSD + estimatedUSD), 'cost total overflow');
  return {format: FORMAT, iterationId: meta.iterationId, releaseAuthority: false, eventCount: raw.length, effectiveEventCount: events.length,
    iteration: {startedAt: start, endedAt: end, status: end ? 'closed' : 'ongoing',
      wallClockMs: end ? Date.parse(end) - Date.parse(start) : null},
    phases: phaseRows,
    defects: {count: defectRows.length, preRelease: defectRows.filter(d => d.stage === 'pre_release').length,
      postRelease: defectRows.filter(d => d.stage === 'post_release').length,
      bySeverity: Object.fromEntries(['P0', 'P1', 'P2', 'P3'].map(s => [s, defectRows.filter(d => d.severity === s).length])),
      rootCauses, recurringRootCauses: Object.entries(rootCauses).filter(([, ids]) => ids.length > 1).map(([rootCauseId, defectIds]) => ({rootCauseId, defectIds})), items: defectRows},
    attempts: {count: attempts.size, failed: failures.length,
      preflightRejected: failures.filter(e => e.payload.classification === 'preflight_rejection').length,
      byClassification: Object.fromEntries(['product', 'test', 'environment', 'unknown', 'preflight_rejection'].map(c => [c, failures.filter(e => e.payload.classification === c).length])),
      items: [...attempts.values()].map(e => ({...e.payload, eventId: e.eventId, type: e.type,
        durationMs: e.payload.startedAt && e.payload.endedAt ? Date.parse(e.payload.endedAt) - Date.parse(e.payload.startedAt) : null}))},
    candidates: {invalidated: invalidated.size, invalidatedIds: [...invalidated.keys()], acceptedIds: [...accepted], consecutiveInvalidated: streak.length,
      convergenceReviewRequired: streak.length >= 2}, warnings,
    costs: {currency: 'USD', actualUSD, estimatedUSD, unknownCount: unknown.length, unknown,
      totalUSD: unknown.length ? null : actualUSD + estimatedUSD,
      totalStatus: unknown.length ? 'unknown' : estimatedUSD > 0 || costRows.some(c => c.status === 'estimated') ? 'estimated' : 'actual',
      measurements: costRows}};
}
function markdown(r) {
  const escape = x => String(x).replace(/[|\r\n]/g, ' ').replace(/</g, '&lt;');
  const lines = [`# Iteration ${escape(r.iterationId)}`, '',
    `Events: ${r.eventCount}; status: ${r.iteration.status}; wall-clock: ${r.iteration.wallClockMs === null ? 'ongoing / unknown' : r.iteration.wallClockMs + ' ms'}.`,
    `Defects: ${r.defects.count} (pre-release ${r.defects.preRelease}, post-release ${r.defects.postRelease}).`,
    `Failed attempts: ${r.attempts.failed}; explicitly invalidated candidates: ${r.candidates.invalidated}.`,
    `Costs (USD): actual ${r.costs.actualUSD}; estimated ${r.costs.estimatedUSD}; unknown ${r.costs.unknownCount}; total ${r.costs.totalUSD === null ? 'unknown' : r.costs.totalUSD} (${r.costs.totalStatus}).`, '',
    '| Phase | Actor | Status | Timing | Duration ms |', '| --- | --- | --- | --- | --- |'];
  for (const p of r.phases) lines.push(`| ${escape(p.phaseId)} (${p.phase}) | ${escape(p.actor)} | ${p.status} | ${p.timing} | ${p.durationMs ?? 'unknown'} |`);
  lines.push('', 'Phase durations may overlap and are never summed as iteration wall-clock.',
    'Historical observations only: this report does not grant release readiness; gate remains the authority.');
  for (const u of r.costs.unknown) lines.push(`- Unknown cost ${escape(u.measurementId ?? 'uncollected')}: ${escape(u.reason)}`);
  for (const w of r.warnings) lines.push(`- ${w.code}: ${escape(w.message)} (${w.candidateIds.map(escape).join(', ')})`);
  return lines.join('\n') + '\n';
}
function report({dir}) {
  return withLock(dir, root => {
    const ledger = readLedger(root), result = summarize(ledger.meta, ledger.events);
    return {...result, chainHead: ledger.head, markdown: markdown(result)};
  });
}

// Gather immutable receipts and review evidence without granting acceptance.
// The sole acceptance authority remains gate.check, called before appending a
// new acceptance (including a correction). Reports only replay this history.
function acceptanceInputs({gateDir, mappingFile, implementationReview}) {
  const gate = require('./system-release-gate.cjs');
  for (const name of ['loadFreeze', 'unseal', 'check'])
    need(typeof gate[name] === 'function', `system-release-gate must export ${name}`, 'METRICS_GATE_API');
  for (const value of [gateDir, mappingFile, implementationReview]) string(value, 'acceptance input');
  gateDir = fs.realpathSync(gateDir); mappingFile = path.resolve(mappingFile); implementationReview = path.resolve(implementationReview);
  need(!fs.existsSync(path.join(gateDir, '.running')), 'gate run is still active', 'METRICS_GATE_BUSY');
  const f = gate.loadFreeze(gateDir), packageFile = path.join(gateDir, 'package-id.json');
  const pkg = gate.unseal(gateDir, packageFile), review = readJSON(implementationReview);
  string(review.reviewDocument?.path, 'review document path');
  const files = [path.join(gateDir, 'freeze.json'), packageFile, mappingFile, implementationReview, review.reviewDocument.path];
  const activeFiles = [];
  let latestEnd = time(f.frozenAt, 'frozenAt');
  for (const group of gate.GROUPS) {
    const activeFile = path.join(gateDir, group + '.json'); regular(activeFile);
    const r = gate.unseal(gateDir, activeFile);
    need(typeof r.runId === 'string' && UUID.test(r.runId), 'invalid acceptance runId', 'METRICS_GATE_RECEIPT');
    const file = path.join(gateDir, 'runs', group, r.runId, 'receipt.json'); regular(file);
    need(canonical(gate.unseal(gateDir, file)) === canonical(r), 'acceptance active/immutable mismatch', 'METRICS_GATE_RECEIPT');
    files.push(file); activeFiles.push(activeFile); latestEnd = Math.max(latestEnd, time(r.endedAt, 'run.endedAt'));
  }
  const ref = file => { regular(file); return {path: file, sha256: hash(fs.readFileSync(file))}; };
  return {gate, gateDir, latestEnd,
    payload: {candidateId: f.freezeDigest, sourceDigest: f.sourceDigest, packageDigest: pkg.identity?.packageDigest,
      gateDir, mappingFile, implementationReview},
    evidence: [...new Set(files)].map(ref), active: activeFiles.map(ref)};
}
function verifyAcceptance(event) {
  const input = acceptanceInputs(event.payload), p = input.payload;
  need(canonical(event.payload) === canonical(p), 'candidate acceptance identity mismatch', 'METRICS_GATE_RECEIPT');
  const checked = input.gate.check({dir: p.gateDir, mappingFile: p.mappingFile, implementationReview: p.implementationReview});
  need(checked.softwareReady === true && checked.sourceDigest === p.sourceDigest && checked.packageDigest === p.packageDigest,
    'whole candidate did not pass gate.check', 'METRICS_GATE_RECEIPT');
  need(time(event.occurredAt, 'acceptance occurredAt') >= input.latestEnd, 'acceptance predates its required runs', 'METRICS_TIMELINE');
  for (const ref of input.evidence) need(event.evidence.some(e => e.path === ref.path && e.sha256 === ref.sha256),
    `acceptance missing bound evidence: ${ref.path}`, 'METRICS_GATE_EVIDENCE');
  for (const ref of [...input.evidence, ...input.active]) {
    regular(ref.path);
    need(hash(fs.readFileSync(ref.path)) === ref.sha256, 'gate acceptance inputs changed during check', 'METRICS_GATE_BUSY');
  }
  need(!fs.existsSync(path.join(p.gateDir, '.running')), 'gate run began during acceptance', 'METRICS_GATE_BUSY');
}
function acceptCandidate({dir, gateDir, mappingFile, implementationReview, actor = 'release-runner', occurredAt}) {
  const input = acceptanceInputs({gateDir, mappingFile, implementationReview});
  occurredAt = occurredAt === undefined ? new Date().toISOString() : occurredAt;
  // A fresh check at a different time is a separate observation. Reusing the
  // returned occurredAt with identical evidence is an idempotent replay.
  const event = {eventId: `candidate:${input.payload.candidateId}:accepted:${digest({occurredAt, evidence: input.evidence})}`,
    type: 'candidate_accepted', occurredAt, actor, origin: 'observed', payload: input.payload, evidence: input.evidence};
  return record({dir, event});
}

function importRun({dir, gateDir, group, actor = 'release-runner', runId}) {
  string(gateDir, 'gateDir'); string(group, 'group'); string(actor, 'actor');
  need(runId === undefined || typeof runId === 'string' && UUID.test(runId), 'runId must be a UUID', 'METRICS_GATE_RECEIPT');
  // Lazy load: ordinary ledger APIs work before the integrator exports these.
  const gate = require('./system-release-gate.cjs');
  for (const name of ['unseal', 'loadFreeze', 'verifyRun', 'verifyArtifacts'])
    need(typeof gate[name] === 'function', `system-release-gate must export ${name}`, 'METRICS_GATE_API');
  need(gate.GROUPS.includes(group), 'unknown gate group', 'METRICS_GATE_RECEIPT');
  gateDir = fs.realpathSync(gateDir);
  need(!fs.existsSync(path.join(gateDir, '.running')), 'gate run is still active', 'METRICS_GATE_BUSY');
  const f = gate.loadFreeze(gateDir), activeFile = path.join(gateDir, group + '.json');
  const selectedFile = runId === undefined ? activeFile : path.join(gateDir, 'runs', group, runId, 'receipt.json');
  regular(selectedFile);
  const r = gate.unseal(gateDir, selectedFile);
  need(runId === undefined || r.runId === runId, 'selected historical run identity mismatch', 'METRICS_GATE_RECEIPT');
  need(r.schema === gate.SCHEMA && r.runner === gate.VERSION && r.group === group
    && r.freezeDigest === f.freezeDigest && r.sourceDigest === f.sourceDigest
    && r.planDigest === gate.digest(f.plan) && r.layer === gate.LAYERS[group]
    && r.productionDelivery === 'not_verified', 'gate receipt identity mismatch', 'METRICS_GATE_RECEIPT');
  need(typeof r.runId === 'string' && UUID.test(r.runId), 'unsafe/missing gate runId', 'METRICS_GATE_RECEIPT');
  choice(r.status, ['passed', 'failed', 'stale'], 'gate status');
  const begun = time(r.startedAt, 'run.startedAt'), ended = time(r.endedAt, 'run.endedAt');
  need(begun >= time(f.frozenAt, 'frozenAt') && ended >= begun, 'invalid gate times', 'METRICS_GATE_RECEIPT');
  const runDir = path.join(gateDir, 'runs', group, r.runId), receiptFile = path.join(runDir, 'receipt.json');
  regular(receiptFile);
  const receiptBytes = fs.readFileSync(receiptFile), receiptSha256 = hash(receiptBytes);
  need(canonical(gate.unseal(gateDir, receiptFile)) === canonical(r), 'active and immutable run receipt mismatch', 'METRICS_GATE_RECEIPT');
  need(Array.isArray(r.commands) && r.commands.length > 0,
    'receipt has no executed command evidence; record the real early failure as attempt_failed', 'METRICS_GATE_NO_COMMAND');
  const evidence = new Map([[receiptFile, {path: receiptFile, sha256: receiptSha256}]]);
  let previousEnd = begun;
  function verifyRefs(refs) {
    need(Array.isArray(refs), 'missing gate artifact list', 'METRICS_GATE_EVIDENCE');
    for (const ref of refs) {
      need(ref && typeof ref.path === 'string' && path.isAbsolute(ref.path)
        && ref.path.startsWith(runDir + path.sep), 'command evidence escapes immutable run', 'METRICS_GATE_EVIDENCE');
      regular(ref.path);
    }
    gate.verifyArtifacts(refs);
    for (const ref of refs) {
      need(SHA.test(ref.sha256) && hash(fs.readFileSync(ref.path)) === ref.sha256, 'gate evidence hash mismatch', 'METRICS_GATE_EVIDENCE');
      const old = evidence.get(ref.path);
      need(!old || old.sha256 === ref.sha256, 'inconsistent artifact identity', 'METRICS_GATE_EVIDENCE');
      evidence.set(ref.path, {path: ref.path, sha256: ref.sha256});
    }
  }
  for (const cmd of r.commands) {
    command(cmd.command);
    const a = time(cmd.startedAt, 'command.startedAt'), b = time(cmd.endedAt, 'command.endedAt');
    need(a >= previousEnd && b >= a && b <= ended, 'command outside run timeline', 'METRICS_GATE_EVIDENCE'); previousEnd = b;
    need((cmd.exitCode === null || Number.isInteger(cmd.exitCode)) && typeof cmd.timedOut === 'boolean'
      && (cmd.signal === null || typeof cmd.signal === 'string')
      && (cmd.error === null || typeof cmd.error === 'string'), 'missing command outcome', 'METRICS_GATE_EVIDENCE');
    need(cmd.command.cwd === f.source, 'command source mismatch', 'METRICS_GATE_EVIDENCE');
    verifyRefs([cmd.stdout, cmd.stderr]);
  }
  verifyRefs(r.evidence);
  if (r.status === 'passed') need(canonical(gate.verifyRun(gateDir, f, group, {runId})) === canonical(r),
    'verified run changed or gate lacks historical run selection support', 'METRICS_GATE_RECEIPT');
  else {
    // Failed/stale runs cannot satisfy verifyRun's success-only contract. Their
    // HMAC, freeze binding, immutable copy, raw commands and logs are mandatory.
    string(r.error, 'failed run error');
    need(r.beforeSourceDigest === f.sourceDigest, 'failed run source binding mismatch', 'METRICS_GATE_RECEIPT');
    need(Array.isArray(r.externalEvidence), 'missing external evidence list', 'METRICS_GATE_EVIDENCE');
    for (const ref of r.externalEvidence) need(gate.digest(gate.tree(ref.root)) === gate.digest(ref.entries),
      'failed run external evidence changed', 'METRICS_GATE_EVIDENCE');
  }
  need(!fs.existsSync(path.join(gateDir, '.running'))
    && canonical(gate.unseal(gateDir, selectedFile)) === canonical(r)
    && hash(fs.readFileSync(receiptFile)) === receiptSha256
    && canonical(gate.loadFreeze(gateDir)) === canonical(f), 'gate changed during import', 'METRICS_GATE_BUSY');
  const attemptId = `gate:${r.freezeDigest}:${group}:${r.runId}`;
  const identity = {freezeDigest: r.freezeDigest, sourceDigest: r.sourceDigest, planDigest: r.planDigest,
    group, runId: r.runId, receiptSha256};
  const refs = [...evidence.values()];
  const base = {actor, origin: 'imported', evidence: refs};
  const phase = {phaseId: attemptId, phase: 'verification', timing: 'actual', gate: identity};
  const events = [
    {...base, eventId: attemptId + ':phase-start', type: 'phase_started', occurredAt: r.startedAt, payload: phase},
    {...base, eventId: attemptId + ':phase-end', type: 'phase_ended', occurredAt: r.endedAt, payload: phase},
    {...base, eventId: attemptId + ':result', type: 'candidate_result', occurredAt: r.endedAt,
      payload: {candidateId: r.freezeDigest, attemptId, runId: r.runId, group, status: r.status === 'passed' ? 'passed' : 'failed',
        startedAt: r.startedAt, endedAt: r.endedAt,
        gateStatus: r.status, classification: 'unknown', classificationReason: 'Gate outcome alone does not establish product/test/environment attribution; use an evidenced correction.',
        packageDigest: r.packageDigest || null, gate: identity}}
  ];
  const results = withLock(dir, (root, transaction) => append(root, readLedger(root), events, transaction));
  return {runId: r.runId, group, selection: runId === undefined ? 'active' : 'historical', imported: results.filter(x => !x.duplicate).length,
    duplicate: results.every(x => x.duplicate), events: results.map(x => x.event)};
}
function main(argv) {
  const [action, ...rest] = argv, options = {};
  need(['init', 'record', 'import-run', 'report'].includes(action), 'usage: iteration-metrics.cjs init|record|import-run|report --input args.json');
  for (let i = 0; i < rest.length; i += 2) {
    need(/^--[a-z-]+$/.test(rest[i]) && typeof rest[i + 1] === 'string' && !rest[i + 1].startsWith('--'), 'invalid CLI options');
    const key = rest[i].slice(2); need(!own(options, key), 'duplicate CLI option'); options[key] = rest[i + 1];
  }
  const allowed = {init: ['dir', 'iteration-id', 'actor', 'occurred-at'], record: ['dir', 'event'],
    'import-run': ['dir', 'gate', 'group', 'actor', 'run-id'], report: ['dir']}[action];
  need(Object.keys(options).every(k => k === 'input' || allowed.includes(k)), 'unknown CLI option');
  need(!options.input || Object.keys(options).length === 1, '--input cannot be combined with other options');
  const args = options.input ? readJSON(path.resolve(options.input)) : action === 'init'
    ? {dir: options.dir, iterationId: options['iteration-id'], actor: options.actor, occurredAt: options['occurred-at']}
    : action === 'record' ? {dir: options.dir, event: readJSON(path.resolve(options.event))}
    : action === 'import-run' ? {dir: options.dir, gateDir: options.gate, group: options.group, actor: options.actor, runId: options['run-id']} : {dir: options.dir};
  keys(args, {init: ['dir', 'iterationId', 'actor', 'occurredAt'], record: ['dir', 'event'],
    'import-run': ['dir', 'gateDir', 'group', 'actor', 'runId'], report: ['dir']}[action], 'CLI input');
  return ({init, record, 'import-run': importRun, report})[action](args);
}
module.exports = {init, record, importRun, acceptCandidate, report, markdown, main};
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({code: error.code || 'METRICS_IO', error: error.message}) + '\n'); process.exitCode = 1; }
}
