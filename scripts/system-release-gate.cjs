#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const VERSION = 'system-release-v2.2';
const SCHEMA = 1;
const FINDINGS = ['P1-01', 'P1-02', 'P1-03', 'P1-04', 'P1-05', 'P1-06', 'P2-01', 'P2-02'];
const SCENARIOS = Object.freeze({
  fullSuite: [],
  policyPause: [...Array.from({length: 10}, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
    'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'L01', 'L02', 'L03',
    'pause-inflight', 'pause-claim-settle', 'restart-content-result', 'two-task-isolation'],
  historicalReplay: ['S57', 'S62-input', 'S62-read', 'S63-after',
    'S62-input-counterfactual', 'S62-read-counterfactual', 'S63-after-counterfactual'],
  controlledWorker: ['full-delivery', 'read-reorder', 'read-mixed', 'check-revise',
    'write-response-lost', 'readback-mismatch', 'restart-content', 'restart-result'],
  build: [],
  packageWorker: ['package-worker-full-delivery'],
  packageverify: ['package-source-match', 'package-native', 'package-signature'],
});
const GROUPS = Object.keys(SCENARIOS);
const LAYERS = {fullSuite: 'software', policyPause: 'software', historicalReplay: 'historical',
  controlledWorker: 'controlled', build: 'package', packageWorker: 'controlled', packageverify: 'package'};
const REQUIRED_SNAPSHOTS = ['S57', 'S62-input', 'S62-read', 'S63-after'];
const fail = message => { throw Error(message); };
const need = (value, message) => { if (!value) fail(message); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v === undefined ? null : v)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = object => sha(canonical(object));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function fileHash(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
const inside = (root, file) => file === root || (!path.relative(root, file).startsWith('..' + path.sep)
  && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
function excluded(relative) {
  const top = relative.split('/')[0];
  return ['.git', 'node_modules', 'artifacts', 'dist', 'coverage', 'test-results',
    'playwright-report', '.local-data'].includes(top) || /^release(?:-|$)/.test(top)
    || relative === 'desktop/native/bin' || relative.startsWith('desktop/native/bin/')
    || relative === 'native/bin' || relative.startsWith('native/bin/')
    || relative.split('/').includes('.DS_Store');
}
const dependencyOutput = relative => ['.cache', '.vite', '.vite-temp'].includes(relative.split('/')[0]);
function tree(root, {ignore = () => false, symlinks = false} = {}) {
  root = fs.realpathSync(root);
  const entries = [];
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const rel = relative ? relative + '/' + name : name;
      if (ignore(rel)) continue;
      const file = path.join(root, rel), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        need(symlinks, `source symlink is not allowed: ${rel}`);
        need(inside(root, fs.realpathSync(file)), `symlink escapes tree: ${rel}`);
        entries.push({path: rel, type: 'link', target: fs.readlinkSync(file)});
      } else if (stat.isDirectory()) {
        entries.push({path: rel, type: 'directory'});
        walk(rel);
      } else {
        need(stat.isFile(), `unsupported input type: ${rel}`);
        entries.push({path: rel, type: 'file', mode: stat.mode & 0o777,
          bytes: stat.size, sha256: fileHash(file)});
      }
    }
  }
  walk('');
  return entries;
}
function validateDesign(design, review) {
  const text = fs.readFileSync(review, 'utf8');
  if (text.trimStart().startsWith('{')) {
    const raw = JSON.parse(text);
    need(raw.format === 'engineering-design-review/v1', 'unsupported design review format');
    const approved = require('./engineering-check.cjs').validateReview({definitionFile: raw.iterationDefinition, design, reviewFile: review});
    return {designDigest: approved.review.designSha256, reviewedBaselineDigest: approved.review.baselineCommit,
      reviewDigest: fileHash(review), requirements: approved.definition.requirements,
      iterationId: approved.definition.id, metricsDir: approved.definition.metricsDir,
      iterationDefinition: raw.iterationDefinition, verificationPlan: approved.definition.verificationPlan,
      verificationPlanDigest: raw.verificationPlanSha256};
  }
  const v2 = text.slice(text.indexOf('## v2独立复核结论'));
  need(text.includes('## v2独立复核结论') && v2.includes('approved_for_implementation'), 'design v2 not approved');
  const designDigest = v2.match(/`designDigest`[^\n]*`([a-f0-9]{64})`/)?.[1];
  const reviewedBaselineDigest = v2.match(/`reviewedBaselineDigest`[^\n]*`([a-f0-9]{64})`/)?.[1];
  need(designDigest === fileHash(design), 'design changed since independent approval');
  const baseline = [...v2.matchAll(/^\| (desktop\/[^ |]+) \| ([a-f0-9]{64}) \|$/gm)]
    .map(m => ({path: m[1], sha256: m[2]})).sort((a, b) => a.path < b.path ? -1 : 1);
  need(baseline.length > 0 && sha(JSON.stringify(baseline)) === reviewedBaselineDigest, 'design baseline identity mismatch');
  return {designDigest, reviewedBaselineDigest, reviewDigest: fileHash(review)};
}
function defaultPlan() {
  return {schema: SCHEMA,
    fullSuite: {tests: 'all', before: [{script: 'scripts/build-image-ocr.cjs'}, {script: 'scripts/build-pdf-ocr.cjs'}]},
    policyPause: {tests: ['tests/system-execution-policy*.test.cjs', 'tests/system-pending-check.test.cjs', 'tests/system-pause-delivery.test.cjs']},
    historicalReplay: {tests: ['scripts/system-release-history-tests.cjs'], snapshots: {}},
    controlledWorker: {tests: ['tests/system-controlled-worker.test.cjs', 'tests/system-pause-delivery.test.cjs']},
    build: {output: 'release-share/app/行知助手-darwin-arm64/行知助手.app',
      commands: [{script: 'scripts/release-build.cjs'}]},
    packageWorker: {tests: ['tests/system-package-worker.test.cjs']},
    packageverify: {tests: ['tests/system-package-verify.test.cjs']},
  };
}
function safeRelative(value) {
  need(typeof value === 'string' && value.length && !path.isAbsolute(value)
    && !value.includes('\\') && !value.split('/').some(p => ['..', '.', ''].includes(p)), `invalid relative path: ${value}`);
  return value;
}
function commandSpec(command) {
  need(command && typeof command === 'object', 'invalid command');
  safeRelative(command.script);
  need(/^(scripts|node_modules)\/.+\.(cjs|mjs|js)$/.test(command.script), 'command must be a source/dependency Node script');
  need(!excluded(command.script) || command.script.startsWith('node_modules/'), 'command is excluded from source');
  need(!command.args || (Array.isArray(command.args) && command.args.every(a => typeof a === 'string' && !a.includes('\0'))), 'args must be an argv array');
  for (const [key, value] of Object.entries(command.env || {})) {
    need(/^[A-Z][A-Z0-9_]*$/.test(key) && !/^(NODE|ELECTRON|SYSTEM_RELEASE|PATH|HOME|DYLD|LD_|BASH|ENV)/.test(key)
      && typeof value === 'string', `unsafe environment override: ${key}`);
  }
  need(!command.timeoutMs || (Number.isInteger(command.timeoutMs) && command.timeoutMs > 0), 'invalid timeout');
}
function validatePlan(plan) {
  need(plan.schema === SCHEMA, 'unsupported plan schema');
  need(Object.keys(plan).every(k => k === 'schema' || k === 'requirements' || GROUPS.includes(k)), 'unknown plan group');
  if (plan.requirements) need(Array.isArray(plan.requirements) && plan.requirements.length > 0
    && plan.requirements.every(id => typeof id === 'string' && /^[A-Z0-9][A-Z0-9-]*$/.test(id))
    && new Set(plan.requirements).size === plan.requirements.length, 'invalid requirements');
  for (const group of GROUPS) {
    const spec = plan[group];
    need(spec && typeof spec === 'object', `missing mandatory group: ${group}`);
    need(spec.testConcurrency === undefined || Number.isInteger(spec.testConcurrency) && spec.testConcurrency >= 1 && spec.testConcurrency <= 8, 'testConcurrency must be 1..8');
    if (spec.env) commandSpec({script: 'scripts/system-release-gate.cjs', env: spec.env});
    need(!spec.layer || spec.layer === LAYERS[group], `layer escalation: ${group}`);
    if (group === 'build') {
      need(Array.isArray(spec.commands) && spec.commands.length > 0, 'missing build commands');
      need(typeof spec.output === 'string', 'missing build.output: fixed source-relative .app path required');
      safeRelative(spec.output);
      need(spec.output.endsWith('.app') && !/[{}*?\[\]\0]/.test(spec.output)
        && excluded(spec.output), 'build.output must be a literal excluded .app output path');
    } else {
      if (group === 'fullSuite') need(spec.tests === 'all' && !spec.cases, 'fullSuite must run all tests');
      else need((Array.isArray(spec.tests) && spec.tests.length > 0 && !spec.cases)
        || (Array.isArray(spec.cases) && spec.cases.length > 0 && !spec.tests), `missing tests/cases: ${group}`);
      if (Array.isArray(spec.tests)) for (const file of spec.tests) {
        safeRelative(file);
        need((file.startsWith('tests/') && file.endsWith('.test.cjs'))
          || /^scripts\/system-release-[^/]+\.cjs$/.test(file), 'test must be in frozen tests/release adapters');
      }
    }
    for (const cmd of [...(spec.commands || []), ...(spec.before || []), ...(spec.cases || [])]) commandSpec(cmd);
    for (const c of spec.cases || []) need(SCENARIOS[group].includes(c.id), `unknown scenario ${c.id}`);
    need(!spec.cases || new Set(spec.cases.map(c => c.id)).size === spec.cases.length, 'duplicate script case');
  }
  return plan;
}
function sourceIdentity(source, design, review, plan, planFile) {
  // Empty/output-only parent directories are not compilation inputs.
  const entries = tree(source, {ignore: excluded}).filter(e => e.type !== 'directory');
  for (const file of ['package.json', 'package-lock.json', 'scripts/system-release-gate.cjs',
    'scripts/system-release-test-reporter.cjs', 'scripts/system-release-script-tests.cjs']) {
    need(entries.some(e => e.path === file && e.type === 'file'), `missing source input: ${file}`);
  }
  const dep = path.join(source, 'node_modules'), depStat = fs.lstatSync(dep);
  need(depStat.isDirectory() || depStat.isSymbolicLink(), 'node_modules unavailable');
  const dependencies = {realpath: fs.realpathSync(dep), link: depStat.isSymbolicLink() ? fs.readlinkSync(dep) : null,
    entries: tree(dep, {ignore: dependencyOutput, symlinks: true})};
  const attachments = {design: {path: design, sha256: fileHash(design)},
    designReview: {path: review, sha256: fileHash(review)},
    plan: planFile ? {path: planFile, sha256: fileHash(planFile)} : null};
  const rawReview = fs.readFileSync(review, 'utf8');
  if (rawReview.trimStart().startsWith('{')) {
    const parsed = JSON.parse(rawReview);
    need(parsed.format === 'engineering-design-review/v1', 'unsupported design review format');
    for (const file of [parsed.iterationDefinition, parsed.reviewDocument.path]) need(path.resolve(file) === fs.realpathSync(file), 'linked review attachment is not allowed');
    attachments.iterationDefinition = {path: parsed.iterationDefinition, sha256: fileHash(parsed.iterationDefinition)};
    attachments.reviewDocument = {path: parsed.reviewDocument.path, sha256: fileHash(parsed.reviewDocument.path)};
  }
  const node = {path: fs.realpathSync(process.execPath), version: process.version, sha256: fileHash(process.execPath)};
  return {entries, dependencies, attachments, node, planDigest: digest(plan)};
}
function outsideInputs(source, file) {
  const rel = path.relative(source, file).split(path.sep).join('/');
  need(!inside(source, file) || excluded(rel), `output would change frozen inputs: ${file}`);
}
function writeJSON(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: exclusive ? 'wx' : 'w', mode: 0o600});
}
function seal(dir, payload) {
  return {payload, hmac: crypto.createHmac('sha256', fs.readFileSync(path.join(dir, '.runner-key'))).update(canonical(payload)).digest('hex')};
}
function unseal(dir, file) {
  const envelope = readJSON(file);
  need(envelope.hmac === seal(dir, envelope.payload).hmac, `runner receipt tampered: ${file}`);
  return envelope.payload;
}
function loadFreeze(dir) {
  dir = fs.realpathSync(dir);
  const f = unseal(dir, path.join(dir, 'freeze.json'));
  need(f.schema === SCHEMA && f.runner === VERSION && f.freezeDigest === digest(f.identity), 'freeze/schema mismatch');
  need(f.sourceDigest === digest(f.manifest), 'source manifest tampered');
  need(f.identity.sourceDigest === f.sourceDigest && f.identity.planDigest === digest(f.plan), 'freeze plan mismatch');
  validatePlan(f.plan);
  return f;
}
function assertSource(f) {
  const manifest = sourceIdentity(f.source, f.design, f.designReview, f.plan, f.planFile);
  need(digest(manifest) === f.sourceDigest, 'stale: complete source/dependency/design/plan manifest changed (including added/deleted files)');
  return manifest;
}
function assertEngineeringAdmission(f) {
  need(f.identity.iterationDefinition && f.identity.requirements, 'ENGINEERING_ADMISSION_REQUIRED: legacy evidence remains readable but cannot enter the new build/archive pipeline');
  const approved = validateDesign(f.design, f.designReview);
  need(approved.iterationDefinition === f.identity.iterationDefinition
    && canonical(approved.requirements) === canonical(f.identity.requirements)
    && f.planFile && fs.realpathSync(f.planFile) === fs.realpathSync(approved.verificationPlan)
    && fileHash(f.planFile) === approved.verificationPlanDigest, 'engineering candidate binding changed');
  const admission = require('./engineering-check.cjs').check({source:f.source,definitionFile:approved.iterationDefinition,requireClean:true});
  need(admission.passed, 'engineering admission failed: ' + canonical(admission.rules.filter(r => r.status !== 'passed')));
  return admission;
}
function mutationIdentity(f, snapshots, bundle) {
  // ctime/inode catches write-and-restore even when macOS coalesces/delays watch
  // events. These times bind a run, never the reproducible source digest.
  const files = f.manifest.entries.map(e => path.join(f.source, e.path));
  files.push(...f.manifest.dependencies.entries.filter(e => e.type !== 'directory')
    .map(e => path.join(f.manifest.dependencies.realpath, e.path)), f.design, f.designReview, process.execPath);
  for (const attachment of Object.values(f.manifest.attachments)) if (attachment) files.push(attachment.path);
  for (const s of snapshots) files.push(...s.entries.filter(e => e.type !== 'directory').map(e => path.join(s.path, e.path)));
  if (bundle) files.push(...tree(bundle, {symlinks: true}).filter(e => e.type !== 'directory').map(e => path.join(bundle, e.path)));
  return digest(files.map(file => {
    const s = fs.lstatSync(file, {bigint: true});
    return {file, ino: String(s.ino), size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs)};
  }));
}
function freeze({source, dir, design, designReview, planFile}) {
  source = fs.realpathSync(source); dir = path.resolve(dir);
  dir = path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
  design = fs.realpathSync(design); designReview = fs.realpathSync(designReview);
  if (planFile) planFile = fs.realpathSync(planFile);
  else planFile = null;
  outsideInputs(source, dir);
  need(!inside(dir, design) && !inside(dir, designReview) && (!planFile || !inside(dir, planFile)), 'inputs cannot be inside gate output');
  const approvedDesign = validateDesign(design, designReview);
  const plan = validatePlan(planFile ? readJSON(planFile) : defaultPlan());
  if (approvedDesign.requirements) {
    need(planFile && fs.realpathSync(planFile) === fs.realpathSync(approvedDesign.verificationPlan)
      && fileHash(planFile) === approvedDesign.verificationPlanDigest
      && canonical(plan.requirements) === canonical(approvedDesign.requirements), 'unreviewed verification plan/requirements');
    const admission = require('./engineering-check.cjs').check({source, definitionFile: approvedDesign.iterationDefinition, requireClean: true});
    need(admission.passed, 'engineering admission failed: ' + canonical(admission.rules.filter(r => r.status !== 'passed')));
  } else need(!plan.requirements, 'legacy candidates cannot override original findings');
  const manifest = sourceIdentity(source, design, designReview, plan, planFile), sourceDigest = digest(manifest);
  const identity = {schema: SCHEMA, runner: VERSION, sourceDigest, planDigest: digest(plan), ...approvedDesign};
  const f = {schema: SCHEMA, runner: VERSION, source, design, designReview, planFile, plan,
    manifest, sourceDigest, identity, freezeDigest: digest(identity), frozenAt: new Date().toISOString()};
  fs.mkdirSync(dir, {recursive: false, mode: 0o700});
  fs.writeFileSync(path.join(dir, '.runner-key'), crypto.randomBytes(32), {flag: 'wx', mode: 0o600});
  writeJSON(path.join(dir, 'freeze.json'), seal(dir, f), true);
  return {sourceDigest, freezeDigest: f.freezeDigest, ...approvedDesign, planDigest: digest(plan),
    mandatory: GROUPS, productionDelivery: 'not_verified'};
}
function snapshotIdentity(f, group) {
  if (group !== 'historicalReplay') return {digest: digest([]), snapshots: []};
  const snapshots = REQUIRED_SNAPSHOTS.map(id => {
    const input = f.plan.historicalReplay.snapshots?.[id];
    need(input && path.isAbsolute(input.path), `unavailable: missing historical snapshot ${id}`);
    need(input.completeness === (id === 'S57' ? 'partial' : id === 'S51' ? 'legacy' : 'complete'), `invalid snapshot completeness: ${id}`);
    need(typeof input.expectedOutcome === 'string' && input.expectedOutcome.length > 0, `missing expectedOutcome: ${id}`);
    need(id !== 'S57' || input.expectedOutcome === 'unknownHistory', 'S57 must reject unknown history');
    const root = fs.realpathSync(input.path), entries = tree(root);
    need(entries.some(e => e.path === 'workspace.json'), `unavailable: ${id} missing workspace`);
    return {id, path: root, completeness: input.completeness, expectedOutcome: input.expectedOutcome,
      schema: input.schema, entries, snapshotDigest: digest(entries)};
  });
  return {digest: digest(snapshots), snapshots};
}
function packageIdentity(bundle, sourceDigest) {
  bundle = fs.realpathSync(bundle);
  const entries = tree(bundle, {symlinks: true});
  const asar = entries.find(e => e.path === 'Contents/Resources/app.asar' && e.type === 'file');
  need(asar, 'package missing app.asar');
  const unpacked = entries.filter(e => e.path.startsWith('Contents/Resources/app.asar.unpacked/'));
  need(unpacked.some(e => e.type === 'file'), 'package missing unpacked files');
  const native = unpacked.filter(e => e.type === 'file' && (e.path.includes('/native/bin/') || e.path.endsWith('.node')));
  need(native.length, 'package missing native outputs');
  const payload = {schema: SCHEMA, sourceDigest, bundle, entries, asarDigest: asar.sha256,
    unpackedDigest: digest(unpacked), nativeDigest: digest(native)};
  return {...payload, packageDigest: digest(payload)};
}
function getPackage(dir, f) {
  const p = unseal(dir, path.join(dir, 'package-id.json'));
  need(p.freezeDigest === f.freezeDigest && p.identity.sourceDigest === f.sourceDigest, 'stale package source');
  const build = verifyRun(dir, f, 'build');
  need(p.buildRunId === build.runId && p.buildReceiptDigest === digest(build)
    && digest(p.identity) === digest(build.builtPackage), 'stale build/package identity');
  need(digest(packageIdentity(p.identity.bundle, f.sourceDigest)) === digest(p.identity), 'package changed: ASAR/unpacked/native/bundle identity mismatch');
  return p;
}
// Resolve an absent output through its nearest existing ancestor. This binds
// ancestor symlinks before execution without creating or deleting an artifact.
function prospectiveRealpath(file) {
  const stat = fs.lstatSync(file, {throwIfNoEntry: false});
  if (stat) return fs.realpathSync(file);
  return path.join(prospectiveRealpath(path.dirname(file)), path.basename(file));
}
function prepareBuildOutput(f, dir, bundle, runId) {
  const declaredPath = path.join(f.source, f.plan.build.output);
  const realpath = prospectiveRealpath(declaredPath), requestedPath = path.resolve(bundle);
  need(realpath === prospectiveRealpath(requestedPath), 'requested package does not match frozen build.output');
  outsideInputs(f.source, realpath);
  need(!inside(dir, realpath) && !inside(realpath, dir), 'build.output must not overlap runner state');
  need(!fs.lstatSync(declaredPath, {throwIfNoEntry: false}), 'build.output already exists: fresh build requires an absent target');
  return {schema: SCHEMA, runId, sourceDigest: f.sourceDigest, declaredOutput: f.plan.build.output,
    requestedPath, realpath, before: 'absent', observedAbsentAt: new Date().toISOString()};
}
function buildOutputPath(f, record) {
  const declaredPath = path.join(f.source, f.plan.build.output);
  need(fs.lstatSync(declaredPath, {throwIfNoEntry: false})?.isDirectory(), 'build did not produce an actual output directory (missing or symlink)');
  need(fs.realpathSync(declaredPath) === record.realpath
    && fs.realpathSync(record.requestedPath) === record.realpath, 'build output realpath changed or requested package differs');
  return record.realpath;
}
function artifact(file) {
  need(fs.lstatSync(file).isFile(), `missing/linked evidence: ${file}`);
  return {path: fs.realpathSync(file), sha256: fileHash(file), bytes: fs.statSync(file).size};
}
function outputEvidence(output) {
  return tree(output, {ignore: rel => rel === 'receipt.json'}).filter(e => e.type === 'file')
    .map(e => artifact(path.join(output, e.path)));
}
function verifyArtifacts(items) {
  for (const item of items) need(digest(artifact(item.path)) === digest(item), `evidence/log tampered: ${item.path}`);
}
function parseTests(file, required, aliases = {}, source = process.cwd()) {
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const results = events.filter(e => e.type === 'test:pass' || e.type === 'test:fail');
  need(results.length > 0, 'missing actual node:test results');
  need(results.every(e => !e.file || (e.name !== e.file && path.resolve(e.name) !== path.resolve(e.file))),
    'missing actual assertions: implicit empty test file');
  need(results.every(e => e.type === 'test:pass' && !e.skip && !e.todo), 'failed/skipped/todo test');
  const summaries = events.filter(e => e.type === 'test:summary');
  need(summaries.length > 0 && summaries.every(e => e.success === true && e.counts?.failed === 0
    && e.counts?.cancelled === 0 && e.counts?.skipped === 0 && e.counts?.todo === 0), 'incomplete/failed/skipped test summary');
  const names = results.map(e => e.name);
  const scenarios = required.map(id => {
    const selected = aliases[id];
    need(selected === undefined || (Array.isArray(selected) && selected.length > 0), `invalid scenario mapping: ${id}`);
    const matched = selected ? selected.filter(selection => typeof selection === 'string' ? names.includes(selection)
      : selection && typeof selection.file === 'string' && typeof selection.name === 'string'
        && results.some(e => e.name === selection.name && e.file === path.resolve(source, selection.file)))
      : names.filter(name => name.startsWith(`[${id}]`));
    need(matched.length > 0 && (!selected || matched.length === selected.length), `missing mandatory scenario: ${id}`);
    return {id, tests: matched, outcome: 'passed'};
  });
  return {testCount: results.length, assertionIds: names, scenarios};
}
function expand(value, context) {
  return value.replace(/\{(package|output|source|snapshot:([^}]+))\}/g, (match, key, id) => {
    const result = key === 'package' ? context.package : key === 'output' ? context.output
      : key === 'source' ? context.source : context.snapshots.find(s => s.id === id)?.path;
    need(result, `unavailable placeholder: ${match}`); return result;
  });
}
function childEnv(extra) {
  // Do not inherit runtime injection flags or stale parent test-runner context.
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS$|NODE_PATH$|NODE_TEST_|ELECTRON_RUN_AS_NODE$|SYSTEM_RELEASE_|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(key)) delete env[key];
  return {...env, ...extra};
}
function watchInputs(f, snapshots, bundle) {
  const watchers = [], changed = [];
  const stamp = file => {
    try {
      const s = fs.lstatSync(file, {bigint: true});
      return s.isDirectory() ? 'directory' : [s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const add = (root, ignore = () => false) => {
    const baseline = new Map();
    const walk = rel => {
      for (const name of fs.readdirSync(path.join(root, rel))) {
        const p = rel ? rel + '/' + name : name;
        if (ignore(p)) continue;
        const state = stamp(path.join(root, p)); baseline.set(p, state);
        if (state === 'directory') walk(p);
      }
    };
    walk('');
    const watcher = fs.watch(root, {recursive: true}, (event, file) => {
      const rel = file?.toString().split(path.sep).join('/');
      if (rel && ignore(rel)) return;
      // macOS also reports the watched directory's own basename. This is a
      // directory notification, not a nonexistent child with that name.
      if (rel === path.basename(root) && !baseline.has(rel)) return;
      // FSEvents may deliver pre-registration events. Only accept events that
      // differ from our start state; write-and-restore still changes ctime.
      if (rel && baseline.has(rel) && stamp(path.join(root, rel)) === baseline.get(rel)) return;
      if (rel && stamp(path.join(root, rel)) === 'directory') return;
      changed.push(`${root}:${event}:${rel || 'unknown'}`);
    });
    watcher.on('error', error => changed.push(`watch unavailable: ${error.message}`));
    watchers.push(watcher);
  };
  try {
    add(f.source, excluded);
    add(f.manifest.dependencies.realpath, dependencyOutput);
    for (const snap of snapshots) add(snap.path);
    if (bundle) add(bundle);
    for (const file of [...new Set(Object.values(f.manifest.attachments).filter(Boolean).map(a => a.path))]) {
      const before = stamp(file);
      const watcher = fs.watch(path.dirname(file), (event, name) => {
        if ((!name || String(name) === path.basename(file)) && stamp(file) !== before) changed.push(`${file}:${event}`);
      });
      watcher.on('error', e => changed.push(e.message)); watchers.push(watcher);
    }
  } catch (error) { watchers.forEach(w => w.close()); throw error; }
  return {changed, close: () => watchers.forEach(w => w.close())};
}
async function execute(argv, source, env, output, index, timeoutMs) {
  const stdout = path.join(output, `${index}.stdout.jsonl`), stderr = path.join(output, `${index}.stderr.log`);
  const out = fs.openSync(stdout, 'wx'), err = fs.openSync(stderr, 'wx');
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await new Promise(resolve => {
      let error = null, timedOut = false;
      const child = spawn(process.execPath, argv, {cwd: source, env, shell: false,
        detached: process.platform !== 'win32', stdio: ['ignore', out, err]});
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      }, timeoutMs);
      child.on('error', e => { error = e.message; });
      child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({exitCode, signal, error, timedOut}); });
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  return {command: {executable: process.execPath, argv, cwd: source}, startedAt,
    endedAt: new Date().toISOString(), ...result, stdout: artifact(stdout), stderr: artifact(stderr)};
}
function groupCommands(f, group, context) {
  const spec = f.plan[group];
  const resolved = cmd => {
    const script = path.join(f.source, cmd.script);
    need(fs.statSync(script).isFile(), `unavailable command: ${cmd.script}`);
    return {...cmd, script, args: (cmd.args || []).map(s => expand(s, context)),
      env: Object.fromEntries(Object.entries(cmd.env || {}).map(([k, v]) => [k, expand(v, context)])),
      evidence: (cmd.evidence || []).map(s => path.resolve(f.source, expand(s, context))),
      evidenceDirectoriesFrom: (cmd.evidenceDirectoriesFrom || []).map(ref => ({report: path.resolve(f.source, expand(ref.report, context)), field: ref.field}))};
  };
  const commands = (group === 'build' ? spec.commands : spec.before || []).map(resolved)
    .map(c => ({argv: [c.script, ...c.args], env: c.env, timeoutMs: c.timeoutMs, evidence: c.evidence, evidenceDirectoriesFrom: c.evidenceDirectoriesFrom, test: false}));
  if (group === 'build') return commands;
  let files, cases;
  if (spec.tests === 'all') files = f.manifest.entries.filter(e => e.type === 'file' && /^tests\/.+\.test\.cjs$/.test(e.path)).map(e => e.path);
  else if (spec.cases) {
    cases = spec.cases.map(resolved);
    files = ['scripts/system-release-script-tests.cjs'];
  } else files = spec.tests.flatMap(pattern => {
    const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    const matches = f.manifest.entries.filter(e => e.type === 'file' && re.test(e.path)).map(e => e.path);
    need(matches.length, `unavailable test pattern: ${pattern}`); return matches;
  });
  files = [...new Set(files)];
  need(files.length > 0, 'no tests selected');
  for (const file of files) need(fs.statSync(path.join(f.source, file)).isFile(), `unavailable test: ${file}`);
  commands.push({argv: ['--test', ...(spec.testConcurrency ? ['--test-concurrency=' + spec.testConcurrency] : []), '--test-reporter=' + path.join(f.source, 'scripts/system-release-test-reporter.cjs'),
    ...files.map(file => path.join(f.source, file))],
    env: cases ? {SYSTEM_RELEASE_CASES: JSON.stringify(cases)} : {},
    evidence: cases ? cases.flatMap(c => c.evidence) : [],
    evidenceDirectoriesFrom: cases ? cases.flatMap(c => c.evidenceDirectoriesFrom) : [], test: true});
  return commands;
}
async function run({dir, group, bundle, runId = crypto.randomUUID()}) {
  need(typeof runId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId), 'invalid claimed runId');
  dir = fs.realpathSync(dir);
  need(GROUPS.includes(group), `unknown mandatory group: ${group}`);
  const lock = path.join(dir, '.running');
  const fd = fs.openSync(lock, 'wx'); fs.closeSync(fd);
  let monitor, receipt, output;
  try {
    // A new attempt, including a preflight rejection, invalidates the previous
    // active package identity. Historical receipts remain available for audit.
    if (group === 'build') fs.rmSync(path.join(dir, 'package-id.json'), {force: true});
    const f = loadFreeze(dir);
    const packageBound = ['packageWorker', 'packageverify'].includes(group);
    const p = packageBound ? getPackage(dir, f) : null;
    if (group === 'build') need(bundle, 'build requires --package with the exact output .app path');
    if (bundle) { bundle = path.resolve(bundle); outsideInputs(f.source, bundle); }
    const snapshots = snapshotIdentity(f, group);
    const runParent = path.join(dir, 'runs', group); fs.mkdirSync(runParent, {recursive:true});
    output = path.join(runParent, runId); fs.mkdirSync(output, {recursive:false});
    const context = {source: f.source, output, package: p?.identity.bundle || bundle, snapshots: snapshots.snapshots};
    const commands = groupCommands(f, group, context);
    for (const command of commands) for (const evidence of command.evidence) {
      need(inside(output, evidence), 'adapter evidence must use {output} to avoid stale files');
      need(!fs.existsSync(evidence), 'pre-existing evidence');
    }
    monitor = watchInputs(f, snapshots.snapshots, p?.identity.bundle);
    assertSource(f);
    need(snapshotIdentity(f, group).digest === snapshots.digest, 'stale snapshot before execution');
    const beforeMutationDigest = mutationIdentity(f, snapshots.snapshots, p?.identity.bundle);
    receipt = {schema: SCHEMA, runner: VERSION, freezeDigest: f.freezeDigest, sourceDigest: f.sourceDigest,
      planDigest: digest(f.plan), group, runId, layer: LAYERS[group], startedAt: new Date().toISOString(),
      beforeSourceDigest: f.sourceDigest, beforeMutationDigest, snapshotDigest: snapshots.digest, snapshots: snapshots.snapshots,
      packageDigest: p?.identity.packageDigest || null, commands: [], evidence: [], externalEvidence: [], status: 'running',
      productionDelivery: 'not_verified'};
    if (group === 'build') receipt.buildOutput = prepareBuildOutput(f, dir, bundle, runId);
    fs.writeFileSync(lock, JSON.stringify(seal(dir, {runId, group, parentPid: process.pid,
      freezeDigest: f.freezeDigest, sourceDigest: f.sourceDigest, bundle: context.package || null})));
    const groupEnv = Object.fromEntries(Object.entries(f.plan[group].env || {}).map(([key, value]) => [key, expand(value, context)]));
    const env = {...groupEnv, SYSTEM_RELEASE_GATE: dir, SYSTEM_RELEASE_GROUP: group, SYSTEM_RELEASE_RUN_ID: runId, SYSTEM_RELEASE_SOURCE_DIGEST: f.sourceDigest,
      SYSTEM_RELEASE_SNAPSHOT_DIGEST: snapshots.digest, SYSTEM_RELEASE_SNAPSHOTS: JSON.stringify(snapshots.snapshots.map(s => ({...s, entries: undefined}))),
      SYSTEM_RELEASE_OUTPUT: output, SYSTEM_RELEASE_LAYER: LAYERS[group], SYSTEM_RELEASE_PACKAGE: context.package || '',
      SYSTEM_RELEASE_PACKAGE_DIGEST: p?.identity.packageDigest || ''};
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      const result = await execute(command.argv, f.source, childEnv({...env, ...command.env}), output, i,
        command.timeoutMs || f.plan[group].timeoutMs || 30 * 60 * 1000);
      receipt.commands.push(result);
      need(result.exitCode === 0 && !result.signal && !result.error && !result.timedOut, `failed actual command: ${group}`);
      if (command.test) receipt.results = parseTests(result.stdout.path, SCENARIOS[group], f.plan[group].scenarioTests, f.source);
      receipt.evidence.push(...command.evidence.map(artifact));
      for (const ref of command.evidenceDirectoriesFrom) {
        need(command.evidence.includes(ref.report) && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(ref.field), 'external evidence requires a fresh declared report and simple field');
        const root = readJSON(ref.report)[ref.field];
        need(typeof root === 'string' && path.isAbsolute(root), 'missing external evidence directory');
        const actual = fs.realpathSync(root); outsideInputs(f.source, actual);
        need(!inside(actual, dir) && !inside(dir, actual), 'external evidence must not include runner state');
        receipt.externalEvidence.push({root: actual, entries: tree(actual)});
      }
      need(monitor.changed.length === 0, 'stale: inputs changed during runner execution: ' + monitor.changed.slice(0, 3).join(', '));
    }
    assertSource(f);
    need(snapshotIdentity(f, group).digest === snapshots.digest, 'stale historical snapshot');
    if (p) need(getPackage(dir, f).identity.packageDigest === p.identity.packageDigest, 'package changed during run');
    if (group === 'build') {
      receipt.builtPackage = packageIdentity(buildOutputPath(f, receipt.buildOutput), f.sourceDigest);
      receipt.packageDigest = receipt.builtPackage.packageDigest;
      Object.assign(receipt.buildOutput, {producedAt: new Date().toISOString(), packageDigest: receipt.packageDigest});
    }
    receipt.afterMutationDigest = mutationIdentity(f, snapshots.snapshots, p?.identity.bundle);
    need(receipt.beforeMutationDigest === receipt.afterMutationDigest, 'stale: input written/replaced during execution, even if bytes restored');
    // Drain filesystem events from mutations during the final hash pass.
    await new Promise(resolve => setTimeout(resolve, 25));
    need(monitor.changed.length === 0, 'stale: transient input mutation detected');
    receipt.afterSourceDigest = f.sourceDigest;
    receipt.output = output;
    receipt.evidence = outputEvidence(output);
    receipt.status = 'passed';
  } catch (error) {
    if (receipt) { receipt.status = /stale|changed|mutation/.test(error.message) ? 'stale' : 'failed'; receipt.error = error.message; }
    throw error;
  } finally {
    if (receipt) {
      receipt.endedAt = new Date().toISOString(); receipt.mutations = monitor?.changed || [];
      const envelope = seal(dir, receipt);
      writeJSON(path.join(output, 'receipt.json'), envelope, true);
      writeJSON(path.join(dir, group + '.json'), envelope);
    } else {
      // A new unsuccessful attempt must not leave an older green receipt active.
      fs.rmSync(path.join(dir, group + '.json'), {force: true});
    }
    monitor?.close(); fs.unlinkSync(lock);
  }
  return {group, status: receipt.status, runId: receipt.runId, testCount: receipt.results?.testCount,
    sourceDigest: receipt.sourceDigest, packageDigest: receipt.packageDigest, productionDelivery: 'not_verified'};
}
function verifyRun(dir, f, group, {runId} = {}) {
  need(GROUPS.includes(group), 'unknown mandatory group');
  need(runId === undefined || typeof runId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId), 'invalid historical runId');
  const r = unseal(dir, runId ? path.join(dir, 'runs', group, runId, 'receipt.json') : path.join(dir, group + '.json'));
  need(!runId || r.runId === runId, 'historical run identity mismatch');
  need(r.schema === SCHEMA && r.runner === VERSION && r.group === group && r.freezeDigest === f.freezeDigest
    && r.sourceDigest === f.sourceDigest && r.planDigest === digest(f.plan), `stale/mismatched report: ${group}`);
  need(r.status === 'passed' && r.beforeSourceDigest === f.sourceDigest && r.afterSourceDigest === f.sourceDigest
    && r.beforeMutationDigest === r.afterMutationDigest && r.mutations.length === 0
    && r.layer === LAYERS[group] && r.productionDelivery === 'not_verified', `failed/skipped/unavailable/layer mismatch: ${group}`);
  need(Date.parse(r.startedAt) >= Date.parse(f.frozenAt) && Date.parse(r.endedAt) >= Date.parse(r.startedAt), 'invalid run times');
  need(r.commands.length > 0, 'missing actual commands');
  for (const cmd of r.commands) {
    need(cmd.exitCode === 0 && !cmd.error && !cmd.signal && !cmd.timedOut, 'command did not complete');
    verifyArtifacts([cmd.stdout, cmd.stderr]);
  }
  verifyArtifacts(r.evidence);
  need(r.output && digest(outputEvidence(r.output)) === digest(r.evidence), 'evidence path set changed');
  for (const evidence of r.externalEvidence) need(digest(tree(evidence.root)) === digest(evidence.entries), 'external evidence/log tampered');
  need(snapshotIdentity(f, group).digest === r.snapshotDigest, `stale inputs: ${group}`);
  if (group !== 'build') {
    const testLog = r.commands.at(-1).stdout.path;
    need(digest(parseTests(testLog, SCENARIOS[group], f.plan[group].scenarioTests, f.source)) === digest(r.results), 'test result/log mismatch');
  } else {
    const b = r.buildOutput;
    need(b?.schema === SCHEMA && b.runId === r.runId && b.sourceDigest === f.sourceDigest
      && b.declaredOutput === f.plan.build.output && b.before === 'absent'
      && b.realpath === r.builtPackage?.bundle && b.packageDigest === r.builtPackage?.packageDigest
      && b.packageDigest === r.packageDigest, 'missing/mismatched fresh build output record');
    need(Date.parse(b.observedAbsentAt) >= Date.parse(r.startedAt)
      && Date.parse(b.observedAbsentAt) <= Date.parse(r.commands[0].startedAt)
      && Date.parse(b.producedAt) >= Date.parse(r.commands.at(-1).endedAt)
      && Date.parse(b.producedAt) <= Date.parse(r.endedAt), 'invalid build output observation times');
    buildOutputPath(f, b);
  }
  return r;
}
function packageId({dir, bundle}) {
  dir = fs.realpathSync(dir); const f = loadFreeze(dir); assertSource(f);
  need(!fs.existsSync(path.join(dir, '.running')), 'runner active');
  const build = verifyRun(dir, f, 'build');
  const identity = packageIdentity(bundle, f.sourceDigest);
  need(digest(identity) === digest(build.builtPackage), 'package was not produced by this frozen build');
  const p = {schema: SCHEMA, freezeDigest: f.freezeDigest, buildRunId: build.runId,
    buildReceiptDigest: digest(build), identity};
  writeJSON(path.join(dir, 'package-id.json'), seal(dir, p));
  return {...identity, entries: undefined};
}
function reviewClosure(f, runs, mappingFile, implementationReview) {
  need(mappingFile && implementationReview, 'missing reviewclosure: --mapping and --implementation-review required');
  outsideInputs(f.source, path.resolve(mappingFile)); outsideInputs(f.source, path.resolve(implementationReview));
  const mapping = readJSON(mappingFile), review = readJSON(implementationReview);
  need(mapping.schema === SCHEMA && mapping.finalSourceDigest === f.sourceDigest
    && mapping.designDigest === f.identity.designDigest, 'stale requirements mapping');
  need(review.schema === SCHEMA && review.status === 'approved' && review.finalSourceDigest === f.sourceDigest
    && review.designDigest === f.identity.designDigest && review.planDigest === digest(f.plan)
    && review.requirementMappingDigest === fileHash(mappingFile), 'stale/unapproved implementation review');
  need(typeof review.reviewedBy === 'string' && review.reviewedBy.trim() && typeof review.implementedBy === 'string'
    && review.implementedBy.trim() && review.reviewedBy !== review.implementedBy, 'independent implementation reviewer required');
  need(review.reviewDocument?.path && review.reviewDocument.sha256 === fileHash(review.reviewDocument.path), 'implementation review document missing/changed');
  need(Array.isArray(review.openFindings) && review.openFindings.length === 0, 'unclosed implementation findings');
  const verifyRefs = refs => {
    need(Array.isArray(refs) && refs.length > 0, 'missing review closure evidence');
    for (const ref of refs) {
      const run = runs[ref.group];
      need(run?.results, 'closure must reference an executed test group');
      need((ref.scenario && run.results.scenarios.some(s => s.id === ref.scenario))
        || (ref.test && run.results.assertionIds.includes(ref.test)), 'closure evidence does not match executed tests');
    }
  };
  for (const id of f.identity.requirements || FINDINGS) {
    const items = mapping.items?.filter(item => item.id === id);
    const findings = review.findings?.filter(item => item.id === id);
    need(items?.length === 1 && items[0].implementation === 'complete' && items[0].verification === 'passed', `unclosed requirement ${id}`);
    need(findings?.length === 1 && findings[0].status === 'closed', `unclosed review ${id}`);
    verifyRefs(items[0].evidence); verifyRefs(findings[0].evidence);
  }
  for (const item of review.findings) { need(item.status === 'closed', `open finding ${item.id}`); verifyRefs(item.evidence); }
  return {status: 'closed', mapping: artifact(mappingFile), review: artifact(implementationReview), document: artifact(review.reviewDocument.path)};
}
function check({dir, mappingFile, implementationReview}) {
  dir = fs.realpathSync(dir); const f = loadFreeze(dir);
  need(!fs.existsSync(path.join(dir, '.running')), 'runner active/incomplete');
  assertSource(f);
  const runs = Object.fromEntries(GROUPS.map(group => [group, verifyRun(dir, f, group)]));
  const p = getPackage(dir, f);
  need(p.buildRunId === runs.build.runId && p.buildReceiptDigest === digest(runs.build), 'stale build/package identity');
  for (const group of ['packageWorker', 'packageverify']) need(runs[group].packageDigest === p.identity.packageDigest
    && Date.parse(runs[group].startedAt) >= Date.parse(runs.build.endedAt), `wrong/old package tests: ${group}`);
  const closure = reviewClosure(f, runs, mappingFile, implementationReview);
  return {schema: SCHEMA, softwareReady: true, sourceDigest: f.sourceDigest,
    packageDigest: p.identity.packageDigest, bundle: p.identity.bundle, reviewclosure: closure,
    mandatory: GROUPS, productionDelivery: 'not_verified'};
}
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    need(/^--[a-z-]+$/.test(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'), `invalid CLI option: ${argv[i]}`);
    const key = argv[i].slice(2); need(!(key in result), `duplicate option ${key}`); result[key] = argv[i + 1];
  }
  return result;
}
async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'plan') return {plan: defaultPlan(), requiredScenarios: SCENARIOS,
    note: 'Save plan JSON; adapt paths/scenarioTests before freeze. Missing cases refuse release.'};
  const o = options(rest);
  need(['freeze', 'run', 'check', 'package-id'].includes(command), 'usage: system-release-gate.cjs plan|freeze|run|check|package-id');
  const allowed = {freeze: ['source', 'out', 'design', 'design-review', 'plan'], run: ['gate', 'only', 'package'],
    check: ['gate', 'mapping', 'implementation-review'], 'package-id': ['gate', 'package']}[command];
  need(Object.keys(o).every(k => allowed.includes(k)), 'unknown CLI option');
  if (command === 'freeze') return freeze({source: o.source || path.resolve(__dirname, '..'), dir: o.out,
    design: o.design, designReview: o['design-review'], planFile: o.plan});
  if (command === 'package-id') return packageId({dir: o.gate, bundle: o.package});
  if (command === 'check') return check({dir: o.gate, mappingFile: o.mapping, implementationReview: o['implementation-review']});
  return run({dir: o.gate, group: o.only, bundle: o.package});
}
module.exports = {VERSION, SCHEMA, FINDINGS, GROUPS, SCENARIOS, LAYERS, sha, digest, canonical,
  fileHash, tree, excluded, defaultPlan, validatePlan, sourceIdentity, freeze, loadFreeze,
  assertSource, packageIdentity, snapshotIdentity, parseTests, run, packageId, check, main,
  validateDesign, assertEngineeringAdmission, getPackage, mutationIdentity, watchInputs, prospectiveRealpath, inside, outsideInputs, verifyRun, unseal, verifyArtifacts, childEnv, groupCommands};
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(JSON.stringify({softwareReady: false, productionDelivery: 'not_verified', error: error.message})); process.exitCode = 1; });
