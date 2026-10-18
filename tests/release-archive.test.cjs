'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');
const asar = require('@electron/asar');
const scripts = path.resolve(__dirname, '../scripts');
const put = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value); };
const json = (file, value) => put(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// The author's ffe13c2 worktree predates Main's gate/admission exports. In that
// isolated worktree only, use Main's real implementation read-only. Integration
// uses the ordinary local module. No gate decision or receipt is fabricated.
const localGate = path.join(scripts, 'system-release-gate.cjs');
const gateFile = require(localGate).assertEngineeringAdmission ? localGate
  : path.resolve(scripts, '../../../../scripts/system-release-gate.cjs');
const gateScripts = path.dirname(gateFile), gate = require(gateFile);
const engineering = require(path.join(gateScripts, 'engineering-check.cjs'));
const helpers = ['context', 'safeOutput', 'fullBundle', 'inspectZip', 'inspectManifest', 'renameExclusive', 'commands'];
function loadArchive({command, experience} = {}) {
  const file = path.join(scripts, 'release-archive.cjs'), m = new Module(file, module);
  m.filename = file; m.paths = module.paths;
  m.require = name => name === './system-release-gate.cjs' ? gate
    : name === 'node:child_process' && command ? {...cp, execFile: command}
      : name === './release-share-verify.cjs' && experience ? {verify: experience}
        : Module.createRequire(file)(name);
  m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports._test = {' + helpers.join(',') + '};', file);
  return m.exports;
}

// A real freeze -> seven real node:test groups -> real package-id -> live check,
// using a tiny synthetic app. Signing/recipient UI are NOT validated here.
async function fixture(t, {version = '1.2.3', plistVersion = version, asarVersion = version, legacy = false} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-archive-test-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), dir = path.join(root, 'gate'), deps = path.join(root, 'deps');
  fs.mkdirSync(source); fs.mkdirSync(deps);
  for (const name of fs.readdirSync(gateScripts).filter(n => /^system-release-.+\.cjs$/.test(n) || n === 'engineering-check.cjs')) put(path.join(source, 'scripts', name), fs.readFileSync(path.join(gateScripts, name)));
  for (const [name, command] of [['package-share.cjs', 'build'], ['share-verify.cjs', 'verify'],
    ['cost-efficiency-package.cjs', 'build'], ['cost-efficiency-package-verify.cjs', 'verify']]) put(path.join(source, 'scripts', name), engineering.compatibilitySource(command));
  put(path.join(source, '.gitignore'), 'node_modules/\nrelease-*/\n');
  put(path.join(source, 'desktop/runtime.cjs'), 'module.exports = 42;\n');
  put(path.join(source, 'docs/SHARING.md'), '# Share the fixture\n');
  put(path.join(source, 'docs/USER_GUIDE.md'), '# Fixture guide\n');
  put(path.join(deps, 'module/index.js'), 'module.exports = 1;\n');
  fs.symlinkSync(deps, path.join(source, 'node_modules'));
  const pkg = {name: 'archive-fixture', productName: '行知助手', version, scripts: {
    ...Object.fromEntries(engineering.PACKAGE_ENTRIES.map(k => [k, 'node scripts/release.cjs build'])),
    release: 'node scripts/release.cjs', 'test:share': 'node scripts/release.cjs verify'}};
  json(path.join(source, 'package.json'), pkg);
  json(path.join(source, 'package-lock.json'), {version, lockfileVersion: 3, packages: {'': {version}}});
  const asarSource = path.join(root, 'asar-source');
  json(path.join(asarSource, 'package.json'), {...pkg, version: asarVersion});
  const asarFile = path.join(root, 'fixture.asar'); await asar.createPackage(asarSource, asarFile);
  const plist = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
    Object.entries({CFBundleIdentifier: 'local.xingzhi.assistant', CFBundleName: '行知助手', CFBundleExecutable: '行知助手',
      CFBundleShortVersionString: plistVersion, CFBundleVersion: plistVersion}).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('') + '</dict></plist>';
  put(path.join(source, 'scripts/fixture-build.cjs'), `
    const fs=require('node:fs'),path=require('node:path'),root=process.argv[2];
    const files=${JSON.stringify({'Contents/Info.plist': plist, 'Contents/MacOS/行知助手': '#!/bin/sh\nexit 0\n',
      'Contents/Resources/app.asar.unpacked/desktop/native/bin/helper': 'native-fixture',
      'Contents/Frameworks/Fixture.framework/Versions/A/Fixture': 'framework-code', 'Contents/Resources/icon.icns': 'icon-bytes'})};
    for(const [name,bytes] of Object.entries(files)){const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);}
    fs.writeFileSync(path.join(root,'Contents/Resources/app.asar'),Buffer.from(${JSON.stringify(fs.readFileSync(asarFile).toString('base64'))},'base64'));
    fs.chmodSync(path.join(root,'Contents/MacOS/行知助手'),0o755);
    fs.chmodSync(path.join(root,'Contents/Resources/app.asar.unpacked/desktop/native/bin/helper'),0o755);
    const fw=path.join(root,'Contents/Frameworks/Fixture.framework');
    fs.symlinkSync('A',path.join(fw,'Versions/Current'));fs.symlinkSync('Versions/Current/Fixture',path.join(fw,'Fixture'));
  `);
  const all = [...new Set(Object.values(gate.SCENARIOS).flat())];
  put(path.join(source, 'tests/scenarios.test.cjs'), "const {test}=require('node:test'),assert=require('node:assert/strict');\n" +
    all.map(id => `test(${JSON.stringify('[' + id + '] synthetic protocol assertion')},()=>assert.equal(2+2,4));`).join('\n'));
  const design = path.join(root, 'design.md'), designReview = path.join(root, 'design-review.md');
  put(design, 'synthetic reviewed design\n');
  const baseline = [{path: 'desktop/runtime.cjs', sha256: gate.sha('baseline runtime')}];
  put(designReview, '## v2独立复核结论\napproved_for_implementation\n' +
    '`designDigest`: `' + gate.fileHash(design) + '`\n`reviewedBaselineDigest`: `' + gate.sha(JSON.stringify(baseline)) + '`\n' +
    `| desktop/runtime.cjs | ${baseline[0].sha256} |\n`);
  const requirements = legacy ? gate.FINDINGS : ['ARCHIVE-FIXTURE'];
  const plan = {schema: 1, ...(!legacy ? {requirements} : {})};
  for (const group of gate.GROUPS) plan[group] = group === 'build'
    ? {output: 'release-fixture/行知助手.app', commands: [{script: 'scripts/fixture-build.cjs', args: ['{package}']}]}
    : {tests: group === 'fullSuite' ? 'all' : ['tests/scenarios.test.cjs']};
  plan.historicalReplay.snapshots = {};
  for (const id of ['S57', 'S62-input', 'S62-read', 'S63-after']) {
    const p = path.join(root, 'snapshots', id); json(path.join(p, 'workspace.json'), {paused: true, fixture: id});
    plan.historicalReplay.snapshots[id] = {path: p, schema: 1, completeness: id === 'S57' ? 'partial' : 'complete',
      expectedOutcome: id === 'S57' ? 'unknownHistory' : 'paused'};
  }
  const planFile = path.join(root, 'plan.json'); json(planFile, plan);
  const git = args => cp.execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Protocol Fixture', '-c', 'user.email=protocol@example.invalid', ...args], {encoding: 'utf8'}).trim();
  git(['init', '--quiet']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic archive protocol baseline']);
  const definition = path.join(root, 'iteration.json'), designDocument = path.join(root, 'approved-design.md');
  if (!legacy) {
    put(designDocument, 'Synthetic independent design review for tool protocol only.\n');
    const baselineCommit = git(['rev-parse', 'HEAD']);
    json(definition, {version: 1, id: 'ARCHIVE-FIXTURE', baselineCommit, risk: 'C', author: 'fixture-author',
      design, designReview, allowedFiles: ['desktop/runtime.cjs'], requirements, verificationPlan: planFile, metricsDir: path.join(root, 'metrics')});
    json(designReview, {format: 'engineering-design-review/v1', status: 'approved', author: 'fixture-author', reviewer: 'fixture-reviewer',
      baselineCommit, designSha256: gate.fileHash(design), iterationDefinition: definition, iterationDefinitionSha256: gate.fileHash(definition),
      verificationPlanSha256: gate.fileHash(planFile), requirementIds: requirements, reviewDocument: {path: designDocument, sha256: gate.fileHash(designDocument)}, openFindings: []});
  }
  gate.freeze({source, dir, design, designReview, planFile});
  const bundle = path.join(source, plan.build.output);
  for (const group of gate.GROUPS) {
    await gate.run({dir, group, ...(group === 'build' ? {bundle} : {})});
    if (group === 'build') gate.packageId({dir, bundle});
  }
  const f = gate.loadFreeze(dir), refs = [{group: 'policyPause', scenario: 'D01'}];
  const mappingFile = path.join(root, 'mapping.json'), implementationReview = path.join(root, 'implementation-review.json');
  const doc = path.join(root, 'implementation-review.md'); put(doc, 'Synthetic independent protocol review, not release evidence.\n');
  json(mappingFile, {schema: 1, finalSourceDigest: f.sourceDigest, designDigest: f.identity.designDigest,
    items: requirements.map(id => ({id, implementation: 'complete', verification: 'passed', evidence: refs}))});
  json(implementationReview, {schema: 1, status: 'approved', finalSourceDigest: f.sourceDigest,
    designDigest: f.identity.designDigest, planDigest: gate.digest(plan), requirementMappingDigest: gate.fileHash(mappingFile),
    implementedBy: 'fixture-author', reviewedBy: 'fixture-reviewer', reviewDocument: {path: doc, sha256: gate.fileHash(doc)},
    openFindings: [], findings: requirements.map(id => ({id, status: 'closed', evidence: refs}))});
  const options = {dir, mappingFile, implementationReview};
  assert.equal(gate.check(options).softwareReady, true);
  return {root, source, dir, bundle, deps, design, designReview, doc, planFile, mappingFile, implementationReview,
    definition, designDocument, options, out: path.join(root, 'distribution')};
}

// OS boundary protocol simulation: actual ditto/plutil remain real. A fake app
// cannot pass codesign or recipient UI. These success fixtures claim only the
// tool protocol; final actual package/signing/UI verification belongs to Main.
function adapter({hook, dmg = false, experience} = {}) {
  const calls = [], images = new Map();
  const command = (file, args, options, callback) => {
    calls.push({file, args});
    const finish = (error, stdout = '', stderr = '') => { setImmediate(() => callback(error, stdout, stderr)); return {stdin: {on() {}, end() {}}}; };
    try {
      hook?.(file, args);
      if (file === '/usr/bin/codesign') return finish(null);
      if (file === '/usr/bin/swift' && args[0] === '-e') {
        assert.equal(fs.lstatSync(args.at(-1), {throwIfNoEntry: false}), undefined, 'protocol rename must not overwrite');
        fs.renameSync(args.at(-2), args.at(-1)); return finish(null);
      }
      if (file === '/usr/bin/hdiutil' && dmg) {
        if (args[0] === 'create') {
          const image = args.at(-1), payload = args[args.indexOf('-srcfolder') + 1];
          fs.writeFileSync(image, 'synthetic dmg protocol'); images.set(image, payload);
        } else if (args[0] === 'attach') {
          const mount = args[args.indexOf('-mountpoint') + 1];
          const source = images.get(args.at(-1));
          assert.ok(source, 'known image fixture');
          cp.execFileSync('/usr/bin/ditto', [source, mount]);
          return finish(null, JSON.stringify({'system-entities': [{'mount-point': mount}]}));
        }
        return finish(null);
      }
      return cp.execFile(file, args, options, callback);
    } catch (error) { return finish(error); }
  };
  const api = loadArchive({command, experience});
  return {...api, calls};
}
async function rejected(promise, code) {
  const e = await promise.then(() => assert.fail('must reject'), e => e);
  if (code) assert.match(e.code || e.message, code);
  if (e.evidenceDir) {
    assert.equal(read(path.join(e.evidenceDir, 'failure.json')).passed, false);
    const m = path.join(e.evidenceDir, 'result/manifest.json');
    if (fs.existsSync(m)) assert.equal(read(m).status, 'failed');
  }
  return e;
}
const mac = {skip: process.platform !== 'darwin' || process.arch !== 'arm64'};

test('archive refuses incomplete gate, stale source, wrong bytes and unapproved implementation review before tools run', mac, async t => {
  const f = await fixture(t), api = adapter();
  for (const [file, replacement, reason] of [
    [path.join(f.dir, 'policyPause.json'), JSON.stringify({...read(path.join(f.dir, 'policyPause.json')), hmac: '0'.repeat(64)}), /tampered/],
    [path.join(f.source, 'desktop/runtime.cjs'), 'changed', /stale|engineering admission failed/],
    [path.join(f.bundle, 'Contents/Resources/icon.icns'), 'another-icon', /package changed/],
    [f.implementationReview, JSON.stringify({...read(f.implementationReview), status: 'rejected'}), /unapproved/],
  ]) await t.test(reason.source, async () => {
    const original = fs.readFileSync(file); fs.writeFileSync(file, replacement);
    try {
      await assert.rejects(api.archive({...f.options, out: f.out, zipOnly: true}), reason);
      assert.equal(fs.existsSync(f.out), false); assert.equal(api.calls.length, 0);
    } finally { fs.writeFileSync(file, original); }
  });
  const executable = path.join(f.bundle, 'Contents/MacOS/行知助手');
  fs.chmodSync(executable, 0o644);
  await assert.rejects(api.archive({...f.options, out: f.out, zipOnly: true}), /package changed/);
  fs.chmodSync(executable, 0o755);
  const link = path.join(f.bundle, 'Contents/Frameworks/Fixture.framework/Versions/Current');
  fs.unlinkSync(link); fs.symlinkSync('A/.', link);
  await assert.rejects(api.archive({...f.options, out: f.out, zipOnly: true}), /package changed/);
  fs.unlinkSync(link); fs.symlinkSync('A', link);
  fs.renameSync(path.join(f.dir, 'packageverify.json'), path.join(f.root, 'missing-receipt'));
  await assert.rejects(api.archive({...f.options, out: f.out, zipOnly: true}), /ENOENT/);
});

test('archive fresh-path checks reject existing/symlink output and input overlaps without overwriting', mac, async t => {
  const f = await fixture(t), api = adapter(), existing = path.join(f.root, 'old'); fs.mkdirSync(existing); put(path.join(existing, 'keep'), 'old artifact');
  const linked = path.join(f.root, 'linked'); fs.symlinkSync(existing, linked);
  const escaped = path.join(f.root, 'source-alias'); fs.symlinkSync(f.source, escaped);
  for (const out of [existing, linked, path.join(f.source, 'scripts/new-output'), path.join(escaped, 'scripts/new-output'),
    path.join(f.dir, 'new-output'), path.join(f.bundle, 'new-output'), path.join(f.deps, 'new-output'), path.join(f.root, 'snapshots/S57/new-output'), f.mappingFile]) {
    await assert.rejects(api.archive({...f.options, out, zipOnly: true}));
  }
  assert.equal(fs.readFileSync(path.join(existing, 'keep'), 'utf8'), 'old artifact'); assert.equal(api.calls.length, 0);
});

test('archive rejects a gate-approved synthetic bundle whose plist or ASAR version differs from frozen package', mac, async t => {
  for (const versions of [{plistVersion: '9.9.9'}, {asarVersion: '9.9.9'}]) await t.test(JSON.stringify(versions), async t => {
    const f = await fixture(t, versions), api = adapter();
    const e = await rejected(api.archive({...f.options, out: f.out, zipOnly: true}), /ARCHIVE_VERSION/);
    assert.ok(e.evidenceDir); assert.equal(fs.existsSync(f.out), false);
  });
});

test('real ZIP transport + simulated signature/UI protocol preserves full identity; zip-only never calls DMG', mac, async t => {
  const f = await fixture(t); let experienceCalls = 0;
  const api = adapter({experience: async ({bundle, output, version}) => {
    experienceCalls++; assert.notEqual(bundle, f.bundle); assert.equal(version, '1.2.3');
    assert.deepEqual(gate.tree(bundle, {symlinks: true}), gate.tree(f.bundle, {symlinks: true}));
    fs.mkdirSync(output); json(path.join(output, 'verification.json'), {passed: true, scope: 'share-experience', protocolFixture: true});
    return {passed: true, scope: 'share-experience', protocolFixture: true};
  }});
  const archived = await api.archive({...f.options, out: f.out, zipOnly: true});
  assert.equal(archived.passed, true); assert.equal(archived.experience, 'not_verified');
  assert.equal(fs.readdirSync(f.out).some(name => name.endsWith('.dmg')), false);
  const m = read(path.join(f.out, 'manifest.json')); assert.equal(m.binding.packageDigest, gate.check(f.options).packageDigest);
  assert.ok(m.binding.inputs.some(b => b.path === f.mappingFile)); assert.ok(m.binding.inputs.some(b => b.path === f.doc));
  const verified = await api.verify({...f.options, archiveDir: f.out, out: path.join(f.root, 'verified')});
  assert.equal(verified.passed, true); assert.equal(experienceCalls, 1);
  assert.equal(api.calls.some(c => c.file === '/usr/bin/hdiutil'), false);
  const before = gate.tree(f.out);
  await assert.rejects(api.archive({...f.options, out: f.out, zipOnly: true}), /already exists/);
  assert.deepEqual(gate.tree(f.out), before);
});

test('DMG protocol verifies, mounts readonly, compares full payload and detaches', mac, async t => {
  const f = await fixture(t), api = adapter({dmg: true});
  const result = await api.archive({...f.options, out: f.out});
  assert.equal(result.passed, true);
  const calls = api.calls.filter(c => c.file === '/usr/bin/hdiutil').map(c => c.args);
  assert.deepEqual(calls.map(args => args[0]), ['create', 'verify', 'attach', 'detach']);
  assert.ok(calls[2].includes('-readonly')); assert.ok(calls[2].includes('-mountpoint'));
});

test('source/dependency/plan/mapping/review/package write-and-restore during archive is refused', mac, async t => {
  const f = await fixture(t);
  const files = [path.join(f.source, 'desktop/runtime.cjs'), path.join(f.deps, 'module/index.js'), f.planFile,
    f.mappingFile, f.implementationReview, f.doc, f.designReview, f.definition, f.designDocument,
    path.join(f.bundle, 'Contents'), path.join(f.bundle, 'Contents/Resources/icon.icns'),
    path.join(f.root, 'snapshots/S57/workspace.json')];
  for (const [i, file] of files.entries()) await t.test(path.relative(f.root, file), async () => {
    let changed = false;
    const api = adapter({hook(tool, args) {
      if (!changed && tool === '/usr/bin/ditto' && args.includes('-c')) {
        changed = true;
        if (fs.lstatSync(file).isDirectory()) {
          const mode = fs.lstatSync(file).mode & 0o7777; fs.chmodSync(file, 0o700); fs.chmodSync(file, mode);
        } else { const bytes = fs.readFileSync(file); fs.appendFileSync(file, '\nmutation'); fs.writeFileSync(file, bytes); }
      }
    }});
    const out = path.join(f.root, 'mutated-' + i);
    await rejected(api.archive({...f.options, out, zipOnly: true}), /ARCHIVE_INPUT_CHANGED/);
    assert.ok(changed); assert.equal(fs.existsSync(out), false);
  });
});

test('output parent symlink write-and-restore is rejected and existing artifacts survive', mac, async t => {
  const f = await fixture(t), actual = path.join(f.root, 'actual'), other = path.join(f.root, 'other'), alias = path.join(f.root, 'alias');
  fs.mkdirSync(actual); fs.mkdirSync(other); fs.symlinkSync(actual, alias); put(path.join(actual, 'old.zip'), 'old');
  let changed = false;
  const api = adapter({hook(tool, args) {
    if (!changed && tool === '/usr/bin/ditto' && args.includes('-c')) {
      changed = true; fs.unlinkSync(alias); fs.symlinkSync(other, alias); fs.unlinkSync(alias); fs.symlinkSync(actual, alias);
    }
  }});
  await rejected(api.archive({...f.options, out: path.join(alias, 'new'), zipOnly: true}), /ARCHIVE_OUTPUT_CHANGED/);
  assert.equal(fs.readFileSync(path.join(actual, 'old.zip'), 'utf8'), 'old'); assert.equal(fs.existsSync(path.join(actual, 'new')), false);
});

test('verify rejects edited manifest set/hash and self-consistent non-ASAR ZIP edits before experience', mac, async t => {
  const f = await fixture(t); let experienceCalls = 0;
  const api = adapter({experience: async () => { experienceCalls++; return {passed: true, scope: 'share-experience'}; }});
  await api.archive({...f.options, out: f.out, zipOnly: true});
  const original = read(path.join(f.out, 'manifest.json'));
  put(path.join(f.out, 'extra'), 'unexpected');
  await rejected(api.verify({...f.options, archiveDir: f.out, out: path.join(f.root, 'bad-set')}), /ARCHIVE_FILE_SET/);
  fs.unlinkSync(path.join(f.out, 'extra'));
  const zipName = original.files.find(f => f.name.endsWith('.zip')).name, zip = path.join(f.out, zipName), zipBytes = fs.readFileSync(zip);
  fs.appendFileSync(zip, 'tampering');
  await rejected(api.verify({...f.options, archiveDir: f.out, out: path.join(f.root, 'bad-hash')}), /ARCHIVE_HASH/);
  fs.writeFileSync(zip, zipBytes);
  const unpacked = path.join(f.root, 'tamper-payload'); cp.execFileSync('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
  const payloadBundle = path.join(unpacked, path.basename(f.bundle));
  const mutations = [
    ['bytes', () => put(path.join(payloadBundle, 'Contents/Resources/icon.icns'), 'bad!-bytes'),
      () => put(path.join(payloadBundle, 'Contents/Resources/icon.icns'), 'icon-bytes')],
    ['permissions', () => fs.chmodSync(path.join(payloadBundle, 'Contents/MacOS/行知助手'), 0o644),
      () => fs.chmodSync(path.join(payloadBundle, 'Contents/MacOS/行知助手'), 0o755)],
    ['link', () => { const p = path.join(payloadBundle, 'Contents/Frameworks/Fixture.framework/Versions/Current'); fs.unlinkSync(p); fs.symlinkSync('.', p); },
      () => { const p = path.join(payloadBundle, 'Contents/Frameworks/Fixture.framework/Versions/Current'); fs.unlinkSync(p); fs.symlinkSync('A', p); }],
  ];
  for (const [name, mutate, restore] of mutations) {
    mutate();
    fs.unlinkSync(zip); cp.execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', unpacked, zip]);
    const edited = structuredClone(original);
    const z = edited.files.find(f => f.name === zipName); z.bytes = fs.statSync(zip).size; z.sha256 = gate.fileHash(zip);
    const sum = path.join(f.out, 'SHA256SUMS.txt');
    fs.writeFileSync(sum, edited.files.filter(f => f.name !== 'SHA256SUMS.txt').map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n');
    Object.assign(edited.files.find(f => f.name === 'SHA256SUMS.txt'), {bytes: fs.statSync(sum).size, sha256: gate.fileHash(sum)});
    json(path.join(f.out, 'manifest.json'), edited);
    await rejected(api.verify({...f.options, archiveDir: f.out, out: path.join(f.root, 'bad-' + name)}), /ARCHIVE_ZIP|ARCHIVE_BUNDLE/);
    restore();
  }
  assert.equal(experienceCalls, 0);
});

test('experience failure retains evidence and cannot publish a passed verification', mac, async t => {
  const f = await fixture(t), api = adapter({experience: async ({output}) => {
    fs.mkdirSync(output); json(path.join(output, 'verification.json'), {passed: false, failedStep: 'OCR'}); throw Error('recipient OCR failed');
  }});
  await api.archive({...f.options, out: f.out, zipOnly: true});
  const before = gate.tree(f.out), out = path.join(f.root, 'verification-failed');
  const e = await rejected(api.verify({...f.options, archiveDir: f.out, out}));
  assert.match(e.message, /OCR failed/); assert.equal(fs.existsSync(out), false);
  assert.equal(read(path.join(e.evidenceDir, 'result/experience/verification.json')).passed, false);
  assert.deepEqual(gate.tree(f.out), before);
});

test('real macOS exclusive rename refuses a pre-existing empty directory', mac, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-exclusive-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), target = path.join(root, 'target'), evidence = path.join(root, 'evidence');
  fs.mkdirSync(source); fs.mkdirSync(target); fs.mkdirSync(evidence); put(path.join(source, 'keep'), 'source');
  const api = loadArchive(), tx = {run: api._test.commands(evidence, root)};
  await assert.rejects(api._test.renameExclusive(tx, source, target), /renamex_np/);
  assert.equal(fs.readFileSync(path.join(source, 'keep'), 'utf8'), 'source'); assert.deepEqual(fs.readdirSync(target), []);
  const fresh = path.join(root, 'fresh'); await api._test.renameExclusive(tx, source, fresh);
  assert.equal(fs.readFileSync(path.join(fresh, 'keep'), 'utf8'), 'source');
});

test('ZIP traversal is refused by real archive parser before any extraction', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-zip-path-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of ['开始使用.md', '开始使用.txt', '完整使用说明.md']) put(path.join(root, name), 'guide');
  const ZIP = require('jszip'), zip = new ZIP(); zip.file('../escape', 'must never be extracted');
  const file = path.join(root, 'bad.zip'); fs.writeFileSync(file, await zip.generateAsync({type: 'nodebuffer', platform: 'UNIX'}));
  const api = loadArchive();
  await assert.rejects(api._test.inspectZip({bundle: '/fixture/Test.app', monitor: {bundleEntries: [{path: '', type: 'directory', mode: 0o755}]}}, file, root), /unexpected\/duplicate ZIP entry/);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escape')), false);
});

test('signature rejection and a concurrent final target retain failure evidence and never overwrite', mac, async t => {
  const f = await fixture(t);
  const sign = adapter({hook(tool) { if (tool === '/usr/bin/codesign') throw Error('signature refused'); }});
  const e = await rejected(sign.archive({...f.options, out: f.out, zipOnly: true}), /ARCHIVE_COMMAND/);
  assert.ok(fs.readdirSync(path.join(e.evidenceDir, 'evidence')).some(n => n.endsWith('.stderr')));
  let raced = false;
  const race = adapter({hook(tool, args) {
    if (!raced && tool === '/usr/bin/swift' && args[0] === '-e') {
      raced = true; fs.mkdirSync(f.out); put(path.join(f.out, 'old'), 'concurrent artifact');
    }
  }});
  await rejected(race.archive({...f.options, out: f.out, zipOnly: true}), /ARCHIVE_COMMAND/);
  assert.equal(fs.readFileSync(path.join(f.out, 'old'), 'utf8'), 'concurrent artifact');
  assert.deepEqual(fs.readdirSync(f.out), ['old']);
});

test('a restored review edit during experience prevents the final passed verification', mac, async t => {
  const f = await fixture(t), api = adapter({experience: async () => {
    const bytes = fs.readFileSync(f.doc); fs.appendFileSync(f.doc, 'changed'); fs.writeFileSync(f.doc, bytes);
    return {passed: true, scope: 'share-experience', protocolFixture: true};
  }});
  await api.archive({...f.options, out: f.out, zipOnly: true});
  const out = path.join(f.root, 'verify-restored');
  await rejected(api.verify({...f.options, archiveDir: f.out, out}), /ARCHIVE_INPUT_CHANGED/);
  assert.equal(fs.existsSync(out), false);
});

test('direct archive/verify APIs reject legacy freeze although legacy gate.check remains readable', mac, async t => {
  const f = await fixture(t, {legacy: true}), api = adapter();
  assert.equal(gate.check(f.options).softwareReady, true);
  await assert.rejects(api.archive({...f.options, out: f.out, zipOnly: true}), /ENGINEERING_ADMISSION_REQUIRED/);
  await assert.rejects(api.verify({...f.options, archiveDir: f.out, out: path.join(f.root, 'verify')}), /ENGINEERING_ADMISSION_REQUIRED/);
  assert.equal(api.calls.length, 0); assert.equal(fs.existsSync(f.out), false);
});

test('actual tiny ZIP/DMG transport round-trip; synthetic app signature remains only a protocol fixture', mac, async t => {
  const f = await fixture(t), api = adapter();
  const result = await api.archive({...f.options, out: f.out});
  assert.equal(result.scope, 'archive-integrity');
  assert.equal(read(path.join(f.out, 'manifest.json')).experience, 'not_verified');
  assert.deepEqual(api.calls.filter(c => c.file === '/usr/bin/hdiutil').map(c => c.args[0]), ['create', 'verify', 'attach', 'detach']);
});
