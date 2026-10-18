'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const gate = require('../scripts/system-release-gate.cjs');
const scripts = path.resolve(__dirname, '../scripts');
const put = (file, data) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, data); };
const json = (file, data) => put(file, JSON.stringify(data, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// These are synthetic gate-protocol fixtures, never software/production release
// evidence. Real release tests remain Main's responsibility against final source.
function fixture(t, {testBody = '', testOnly = false} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'system-release-gate-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), dir = path.join(root, 'gate');
  fs.mkdirSync(source);
  for (const file of fs.readdirSync(scripts).filter(n => /^system-release-.+\.cjs$/.test(n))) {
    put(path.join(source, 'scripts', file), fs.readFileSync(path.join(scripts, file)));
  }
  put(path.join(source, 'desktop/runtime.cjs'), 'module.exports = 1;\n');
  put(path.join(source, 'desktop/native/Example.swift'), 'native source\n');
  put(path.join(source, 'scripts/build-native.cjs'), '// build rule\n');
  put(path.join(source, 'tests/fixtures/example.txt'), 'fixture\n');
  put(path.join(source, 'docs/design.md'), 'implementation design\n');
  json(path.join(source, 'package.json'), {name: 'gate-fixture', version: '0.41.0'});
  json(path.join(source, 'package-lock.json'), {lockfileVersion: 3, version: '0.41.0'});
  const deps = path.join(root, 'dependencies'); fs.mkdirSync(deps);
  put(path.join(deps, 'module/index.js'), 'module.exports = true;\n');
  fs.symlinkSync(deps, path.join(source, 'node_modules'), 'dir');
  const design = path.join(root, 'approved-design.md'), designReview = path.join(root, 'design-review.md');
  put(design, 'Design v2\n');
  // Intentionally a DIFFERENT reviewed baseline: implementing after design
  // review must not require retroactively rebinding the design to final source.
  const baseline = [{path: 'desktop/runtime.cjs', sha256: gate.sha('old reviewed runtime')}];
  put(designReview, `## v2独立复核结论\napproved_for_implementation\n` +
    '`designDigest`: `' + gate.fileHash(design) + '`\n' +
    '`reviewedBaselineDigest`: `' + gate.sha(JSON.stringify(baseline)) + '`\n' +
    `| desktop/runtime.cjs | ${baseline[0].sha256} |\n`);
  const all = [...new Set(Object.values(gate.SCENARIOS).flat())];
  put(path.join(source, 'tests/all.test.cjs'), `const {test}=require('node:test');const assert=require('node:assert/strict');\n` +
    (testOnly ? '' : all.map(id => `test(${JSON.stringify('[' + id + '] actual assertion')},()=>assert.equal(2+2,4));`).join('\n')) +
    '\n' + testBody);
  put(path.join(source, 'scripts/fake-build.cjs'), `
    const fs=require('node:fs'),path=require('node:path');const root=process.argv[2];
    for(const [name,data] of Object.entries({'Contents/Resources/app.asar':'archive bytes',
      'Contents/Resources/app.asar.unpacked/desktop/native/bin/helper':'native bytes',
      'Contents/MacOS/Fixture':'executable bytes'})){
      const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);
    }
  `);
  const plan = {schema: 1};
  for (const group of gate.GROUPS) plan[group] = group === 'build'
    ? {output: 'release-fixture/Fixture.app', commands: [{script: 'scripts/fake-build.cjs', args: ['{package}']}]}
    : {tests: group === 'fullSuite' ? 'all' : ['tests/all.test.cjs']};
  plan.historicalReplay.snapshots = {};
  for (const id of ['S57', 'S62-input', 'S62-read', 'S63-after']) {
    const folder = path.join(root, 'snapshots', id);
    json(path.join(folder, 'workspace.json'), {id, paused: true});
    plan.historicalReplay.snapshots[id] = {path: folder, schema: 1,
      completeness: id === 'S57' ? 'partial' : 'complete', expectedOutcome: id === 'S57' ? 'unknownHistory' : 'paused'};
  }
  const planFile = path.join(root, 'plan.json'); json(planFile, plan);
  const bundle = path.join(source, 'release-fixture', 'Fixture.app');
  const freeze = () => gate.freeze({source, dir, design, designReview, planFile});
  const run = group => gate.run({dir, group, ...(group === 'build' ? {bundle} : {})});
  return {root, source, dir, deps, design, designReview, plan, planFile, bundle, freeze, run};
}
async function complete(f) {
  f.freeze();
  for (const group of gate.GROUPS) {
    await f.run(group);
    if (group === 'build') gate.packageId({dir: f.dir, bundle: f.bundle});
  }
  const frozen = gate.loadFreeze(f.dir);
  const refs = [{group: 'policyPause', scenario: 'D01'}];
  const mappingFile = path.join(f.root, 'mapping.json');
  json(mappingFile, {schema: 1, finalSourceDigest: frozen.sourceDigest, designDigest: frozen.identity.designDigest,
    items: gate.FINDINGS.map(id => ({id, implementation: 'complete', verification: 'passed', evidence: refs}))});
  const doc = path.join(f.root, 'implementation-review.md'); put(doc, 'Synthetic independent protocol review only.\n');
  const implementationReview = path.join(f.root, 'implementation-review.json');
  json(implementationReview, {schema: 1, status: 'approved', finalSourceDigest: frozen.sourceDigest,
    designDigest: frozen.identity.designDigest, planDigest: gate.digest(f.plan),
    requirementMappingDigest: gate.fileHash(mappingFile), implementedBy: 'fixture-author', reviewedBy: 'fixture-reviewer',
    reviewDocument: {path: doc, sha256: gate.fileHash(doc)}, openFindings: [],
    findings: gate.FINDINGS.map(id => ({id, status: 'closed', evidence: refs}))});
  return {dir: f.dir, mappingFile, implementationReview};
}

test('RG-01: build output is a mandatory literal frozen path', t => {
  const f = fixture(t);
  for (const output of [undefined, '{package}', 'release-{output}/App.app', 'release-*/App.app',
    '../Old.app', '/tmp/Old.app', 'desktop/Old.app']) {
    f.plan.build.output = output; json(f.planFile, f.plan);
    assert.throws(f.freeze, /build.output|invalid relative path/);
  }
});

test('RG-01: fresh exact output passes CLI build/package-id with run/path/digest observations', t => {
  const f = fixture(t); f.freeze();
  const cli = path.join(f.source, 'scripts/system-release-gate.cjs');
  assert.equal(fs.existsSync(f.bundle), false);
  const built = spawnSync(process.execPath, [cli, 'run', '--gate', f.dir, '--only', 'build', '--package', f.bundle], {encoding: 'utf8'});
  assert.equal(built.status, 0, built.stderr);
  const r = read(path.join(f.dir, 'build.json')).payload, observation = r.buildOutput;
  assert.equal(r.status, 'passed');
  assert.equal(observation.before, 'absent');
  assert.equal(observation.declaredOutput, f.plan.build.output);
  assert.equal(observation.requestedPath, f.bundle);
  assert.equal(observation.realpath, fs.realpathSync(f.bundle));
  assert.equal(observation.runId, JSON.parse(built.stdout).runId);
  assert.equal(observation.sourceDigest, r.sourceDigest);
  assert.equal(observation.packageDigest, gate.packageIdentity(f.bundle, r.sourceDigest).packageDigest);
  assert.ok(Date.parse(observation.observedAbsentAt) <= Date.parse(r.commands[0].startedAt));
  assert.ok(Date.parse(observation.producedAt) >= Date.parse(r.commands.at(-1).endedAt));
  const identified = spawnSync(process.execPath, [cli, 'package-id', '--gate', f.dir, '--package', f.bundle], {encoding: 'utf8'});
  assert.equal(identified.status, 0, identified.stderr);
  const p = read(path.join(f.dir, 'package-id.json')).payload;
  assert.equal(p.buildRunId, r.runId);
  assert.equal(p.buildReceiptDigest, gate.digest(r));
  assert.equal(p.identity.packageDigest, observation.packageDigest);
  const old = path.join(f.source, 'release-old/Old.app'); fs.cpSync(f.bundle, old, {recursive: true});
  assert.throws(() => gate.packageId({dir: f.dir, bundle: old}), /not produced by this frozen build/);
});

test('RG-01: build A cannot claim requested old B, even if plan incorrectly declares B', async t => {
  for (const declareB of [false, true]) await t.test('declareB=' + declareB, async t => {
    const f = fixture(t), actualA = path.join(f.source, 'release-other/A.app');
    // Seed a complete old B outside the runner, then freeze a command that only builds A.
    const seeded = spawnSync(process.execPath, [path.join(f.source, 'scripts/fake-build.cjs'), f.bundle]);
    assert.equal(seeded.status, 0);
    const oldHash = gate.digest(gate.packageIdentity(f.bundle, 'old-source'));
    f.plan.build.commands[0].args = [actualA];
    if (!declareB) f.plan.build.output = 'release-other/A.app';
    json(f.planFile, f.plan); f.freeze();
    await assert.rejects(f.run('build'), declareB ? /already exists/ : /does not match frozen build.output/);
    assert.equal(fs.existsSync(actualA), false, 'preflight must reject before executing the wrong build');
    assert.equal(gate.digest(gate.packageIdentity(f.bundle, 'old-source')), oldHash);
    assert.throws(() => gate.packageId({dir: f.dir, bundle: f.bundle}), /failed\/skipped\/unavailable/);
    assert.equal(fs.existsSync(path.join(f.dir, 'package-id.json')), false);
  });
});

test('RG-01: successful command producing A cannot satisfy declared/requested absent B', async t => {
  const f = fixture(t), actualA = path.join(f.source, 'release-other/A.app');
  f.plan.build.commands[0].args = [actualA]; json(f.planFile, f.plan); f.freeze();
  await assert.rejects(f.run('build'), /did not produce an actual output directory/);
  assert.ok(fs.existsSync(path.join(actualA, 'Contents/Resources/app.asar')));
  const r = read(path.join(f.dir, 'build.json')).payload;
  assert.equal(r.commands[0].exitCode, 0); assert.equal(r.status, 'failed');
  assert.throws(() => gate.packageId({dir: f.dir, bundle: actualA}), /failed\/skipped\/unavailable/);
  assert.equal(fs.existsSync(path.join(f.dir, 'package-id.json')), false);
});

test('RG-01: no-output command cannot adopt an old bundle or pass with absent output', async t => {
  for (const old of [true, false]) await t.test('old bundle=' + old, async t => {
    const f = fixture(t);
    if (old) assert.equal(spawnSync(process.execPath, [path.join(f.source, 'scripts/fake-build.cjs'), f.bundle]).status, 0);
    put(path.join(f.source, 'scripts/fake-build.cjs'), 'console.log(JSON.stringify({status:"passed"}));');
    f.freeze();
    await assert.rejects(f.run('build'), old ? /already exists/ : /did not produce an actual output directory/);
    const r = read(path.join(f.dir, 'build.json')).payload;
    assert.equal(r.commands.length, old ? 0 : 1);
    assert.equal(r.status, 'failed');
    assert.throws(() => gate.packageId({dir: f.dir, bundle: f.bundle}), /failed\/skipped\/unavailable/);
    assert.equal(fs.existsSync(path.join(f.dir, 'package-id.json')), false);
  });
});

test('RG-01: fresh output name cannot be a symlink to an old bundle', async t => {
  const f = fixture(t), old = path.join(f.root, 'Old.app');
  assert.equal(spawnSync(process.execPath, [path.join(f.source, 'scripts/fake-build.cjs'), old]).status, 0);
  put(path.join(f.source, 'scripts/fake-build.cjs'), `
    const fs=require('node:fs'),path=require('node:path');
    fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});
    fs.symlinkSync(${JSON.stringify(old)},process.argv[2],'dir');
  `);
  f.freeze(); await assert.rejects(f.run('build'), /missing or symlink/);
  assert.throws(() => gate.packageId({dir: f.dir, bundle: f.bundle}), /failed\/skipped\/unavailable/);
});

test('RG-01: changing an output ancestor symlink cannot redirect the recorded build', async t => {
  const f = fixture(t), initial = path.join(f.root, 'initial'), replaced = path.join(f.root, 'replaced');
  fs.mkdirSync(initial);
  assert.equal(spawnSync(process.execPath, [path.join(f.source, 'scripts/fake-build.cjs'), path.join(replaced, 'Fixture.app')]).status, 0);
  const ancestor = path.dirname(f.bundle); fs.symlinkSync(initial, ancestor, 'dir');
  put(path.join(f.source, 'scripts/fake-build.cjs'), `
    const fs=require('node:fs');fs.unlinkSync(${JSON.stringify(ancestor)});
    fs.symlinkSync(${JSON.stringify(replaced)},${JSON.stringify(ancestor)},'dir');
  `);
  f.freeze(); await assert.rejects(f.run('build'), /output realpath changed/);
  assert.throws(() => gate.packageId({dir: f.dir, bundle: f.bundle}), /failed\/skipped\/unavailable/);
});

test('RG-01: rejected rebuild invalidates previous package-id; clean fresh rebuild succeeds', async t => {
  const f = fixture(t); f.freeze(); await f.run('build'); gate.packageId({dir: f.dir, bundle: f.bundle});
  const identityFile = path.join(f.dir, 'package-id.json'), previous = fs.readFileSync(identityFile);
  const oldRunId = read(identityFile).payload.buildRunId;
  await assert.rejects(f.run('build'), /already exists/);
  assert.equal(fs.existsSync(identityFile), false);
  // Restoring an earlier valid identity cannot revive a failed/latest build.
  fs.writeFileSync(identityFile, previous);
  await assert.rejects(f.run('packageWorker'), /failed\/skipped\/unavailable/);
  fs.rmSync(f.bundle, {recursive: true});
  await f.run('build'); gate.packageId({dir: f.dir, bundle: f.bundle});
  assert.notEqual(read(identityFile).payload.buildRunId, oldRunId);
});

test('P1-06: complete path set includes source/docs/tests/native; outputs do not self-reference', t => {
  const f = fixture(t); f.freeze();
  const frozen = gate.loadFreeze(f.dir);
  assert.ok(frozen.manifest.entries.some(e => e.path === 'docs/design.md'));
  assert.ok(frozen.manifest.entries.some(e => e.path === 'scripts/system-release-gate.cjs'));
  assert.ok(frozen.manifest.entries.some(e => e.path === 'tests/all.test.cjs'));
  assert.ok(frozen.manifest.entries.some(e => e.path === 'desktop/native/Example.swift'));
  for (const file of ['artifacts/report.json', 'dist/app.js', 'release/bundle', 'release-test/app',
    'desktop/native/bin/helper', 'native/bin/tool', 'coverage/output']) put(path.join(f.source, file), 'output');
  assert.doesNotThrow(() => gate.assertSource(frozen));
  assert.ok(frozen.manifest.dependencies.link);
  assert.equal(frozen.manifest.dependencies.realpath, f.deps);
});

test('P1-06: additions, deletions and changes invalidate the COMPLETE source set', async t => {
  for (const file of ['desktop/runtime.cjs', 'scripts/build-native.cjs', 'docs/design.md', 'tests/all.test.cjs',
    'tests/fixtures/example.txt', 'package-lock.json', 'package.json', 'desktop/native/Example.swift']) {
    await t.test(file, t => {
      const f = fixture(t); f.freeze(); const frozen = gate.loadFreeze(f.dir), full = path.join(f.source, file);
      const original = fs.readFileSync(full); fs.appendFileSync(full, '\nchanged');
      assert.throws(() => gate.assertSource(frozen), /stale/);
      fs.writeFileSync(full, original); fs.unlinkSync(full);
      assert.throws(() => gate.assertSource(frozen), /stale|missing source/);
    });
  }
  for (const file of ['desktop/new.cjs', 'scripts/new.cjs', 'docs/new.md', 'tests/new.test.cjs']) {
    await t.test('added ' + file, t => {
      const f = fixture(t); f.freeze(); put(path.join(f.source, file), 'new');
      assert.throws(() => gate.assertSource(gate.loadFreeze(f.dir)), /stale/);
    });
  }
});

test('P1-06: symlinked dependency contents and target are bound, source symlinks fail closed', t => {
  const f = fixture(t); f.freeze(); const frozen = gate.loadFreeze(f.dir);
  fs.appendFileSync(path.join(f.deps, 'module/index.js'), '// changed');
  assert.throws(() => gate.assertSource(frozen), /stale/);
  fs.writeFileSync(path.join(f.deps, 'module/index.js'), 'module.exports = true;\n');
  const other = path.join(f.root, 'other-dependencies'); fs.cpSync(f.deps, other, {recursive: true});
  fs.unlinkSync(path.join(f.source, 'node_modules')); fs.symlinkSync(other, path.join(f.source, 'node_modules'), 'dir');
  assert.throws(() => gate.assertSource(frozen), /stale/);
  fs.unlinkSync(path.join(f.source, 'node_modules')); fs.symlinkSync(f.deps, path.join(f.source, 'node_modules'), 'dir');
  fs.symlinkSync(f.design, path.join(f.source, 'docs/external.md'));
  assert.throws(() => gate.assertSource(frozen), /symlink/);
});

test('P2-02: design baseline differs from final source; changed approved design is refused', t => {
  const f = fixture(t); const result = f.freeze();
  assert.notEqual(result.sourceDigest, result.reviewedBaselineDigest);
  fs.appendFileSync(f.design, 'unreviewed design');
  assert.throws(() => gate.assertSource(gate.loadFreeze(f.dir)), /stale/);
  assert.throws(() => gate.freeze({...f, dir: path.join(f.root, 'second-gate')}), /design changed/);
});

test('P1-06/P2-02: actual fixed commands, log/evidence/package binding and reviewclosure', async t => {
  const f = fixture(t), options = await complete(f);
  const ready = gate.check(options);
  assert.equal(ready.softwareReady, true);
  assert.equal(ready.productionDelivery, 'not_verified');
  assert.ok(ready.packageDigest);
  const frozen = gate.loadFreeze(f.dir);
  // Adding the identities AFTER freeze must not create a source self-reference.
  assert.doesNotThrow(() => gate.assertSource(frozen));
  for (const group of gate.GROUPS) {
    await t.test('missing ' + group, () => {
      const file = path.join(f.dir, group + '.json'), saved = fs.readFileSync(file);
      fs.unlinkSync(file); assert.throws(() => gate.check(options)); fs.writeFileSync(file, saved);
    });
  }
  await t.test('report status cannot be hand-edited', () => {
    const file = path.join(f.dir, 'fullSuite.json'), saved = fs.readFileSync(file), report = read(file);
    report.payload.status = 'skipped'; json(file, report);
    assert.throws(() => gate.check(options), /tampered/); fs.writeFileSync(file, saved);
  });
  await t.test('old log cannot be replaced by self-reported passed', () => {
    const file = read(path.join(f.dir, 'fullSuite.json')).payload.commands.at(-1).stdout.path;
    const saved = fs.readFileSync(file); put(file, '{"passed":true}\n');
    assert.throws(() => gate.check(options), /tampered/); fs.writeFileSync(file, saved);
  });
  await t.test('removed evidence and added output rejected', () => {
    const r = read(path.join(f.dir, 'fullSuite.json')).payload, file = r.commands[0].stderr.path;
    const saved = fs.readFileSync(file); fs.unlinkSync(file); assert.throws(() => gate.check(options)); put(file, saved);
    const extra = path.join(r.output, 'unbound.json'); put(extra, '{}');
    assert.throws(() => gate.check(options), /path set/); fs.unlinkSync(extra);
  });
  for (const name of ['Contents/Resources/app.asar', 'Contents/Resources/app.asar.unpacked/desktop/native/bin/helper', 'Contents/MacOS/Fixture']) {
    await t.test('package substitution ' + name, () => {
      const file = path.join(f.bundle, name), saved = fs.readFileSync(file); put(file, 'replacement');
      assert.throws(() => gate.check(options), /package changed/); put(file, saved);
    });
  }
  await t.test('unpacked addition rejected', () => {
    const file = path.join(f.bundle, 'Contents/Resources/app.asar.unpacked/new.node'); put(file, 'new');
    assert.throws(() => gate.check(options), /package changed/); fs.unlinkSync(file);
  });
  await t.test('snapshot changed after actual replay', () => {
    const file = path.join(f.plan.historicalReplay.snapshots['S62-read'].path, 'new-blob'); put(file, 'changed');
    assert.throws(() => gate.check(options), /stale inputs/); fs.unlinkSync(file);
  });
  for (const mutate of [r => r.status = 'unavailable', r => r.finalSourceDigest = 'old',
    r => r.findings[0].status = 'open', r => r.openFindings.push('unresolved'),
    r => r.reviewedBy = r.implementedBy, r => r.requirementMappingDigest = 'old',
    r => r.findings[0].evidence = [{group: 'policyPause', scenario: 'never executed'}]]) {
    await t.test('reviewclosure rejects stale/open/unexecuted evidence', () => {
      const saved = fs.readFileSync(options.implementationReview), r = read(options.implementationReview);
      mutate(r); json(options.implementationReview, r); assert.throws(() => gate.check(options));
      fs.writeFileSync(options.implementationReview, saved);
    });
  }
  await t.test('changed mapping requires a fresh review identity', () => {
    const saved = fs.readFileSync(options.mappingFile); fs.appendFileSync(options.mappingFile, ' ');
    assert.throws(() => gate.check(options), /implementation review/); fs.writeFileSync(options.mappingFile, saved);
  });
  await t.test('controlled cannot be promoted to production', () => {
    const file = path.join(f.dir, 'controlledWorker.json'), saved = fs.readFileSync(file), r = read(file);
    r.payload.layer = 'production'; r.payload.productionDelivery = 'accepted'; json(file, r);
    assert.throws(() => gate.check(options), /tampered/); fs.writeFileSync(file, saved);
  });
  await t.test('old reports cannot be relabelled for changed source', () => {
    put(path.join(f.source, 'docs/added.md'), 'new source');
    assert.throws(() => gate.check(options), /stale/);
    fs.unlinkSync(path.join(f.source, 'docs/added.md'));
  });
  assert.equal(gate.check(options).softwareReady, true);
});

test('P1-06: mutations DURING a run, including change-and-restore, are stale', async t => {
  for (const restore of [false, true]) {
    await t.test('restore=' + restore, async t => {
      const f = fixture(t, {testOnly: true, testBody: `test('mutation',async()=>{
        const fs=require('node:fs'),p=require('node:path').join(__dirname,'../desktop/runtime.cjs');
        const before=fs.readFileSync(p);fs.appendFileSync(p,' changed');
        await new Promise(r=>setTimeout(r,80));
        if(${restore})fs.writeFileSync(p,before);
        await new Promise(r=>setTimeout(r,80));assert.ok(true);
      });`});
      f.freeze(); await assert.rejects(f.run('fullSuite'), /stale/);
      assert.equal(read(path.join(f.dir, 'fullSuite.json')).payload.status, 'stale');
    });
  }
});

test('P1-06: actual failure/skip/todo/zero-tests cannot become passed', async t => {
  const bodies = ["test('fails',()=>assert.fail('actual failure'))", "test.skip('skipped',()=>{})",
    "test.todo('unavailable')", "console.log(JSON.stringify({passed:true,status:'passed'}))"];
  for (const body of bodies) {
    await t.test(body, async t => {
      const f = fixture(t, {testOnly: true, testBody: body}); f.freeze();
      await assert.rejects(f.run('fullSuite'));
      assert.notEqual(read(path.join(f.dir, 'fullSuite.json')).payload.status, 'passed');
    });
  }
});

test('P1-06: mandatory scenarios, missing snapshots and wrong completeness refuse', async t => {
  const f = fixture(t, {testOnly: true, testBody: "test('[D01] only',()=>assert.ok(true))"}); f.freeze();
  await assert.rejects(f.run('policyPause'), /missing mandatory scenario/);
  fs.unlinkSync(path.join(f.plan.historicalReplay.snapshots['S62-input'].path, 'workspace.json'));
  await assert.rejects(f.run('historicalReplay'), /unavailable/);
  assert.equal(fs.existsSync(path.join(f.dir, 'historicalReplay.json')), false);
});

test('P1-06: shell metacharacters stay literal argv in the existing-script adapter', async t => {
  const f = fixture(t), marker = path.join(f.root, 'INJECTED');
  const argument = `x; touch ${marker}; $(touch ${marker}) \`touch ${marker}\``;
  put(path.join(f.source, 'scripts/argument-test.cjs'), `const assert=require('node:assert/strict');assert.equal(process.argv[2],${JSON.stringify(argument)});`);
  f.plan.controlledWorker = {cases: gate.SCENARIOS.controlledWorker.map(id => ({id,
    script: 'scripts/argument-test.cjs', args: [argument]}))}; json(f.planFile, f.plan); f.freeze();
  assert.equal((await f.run('controlledWorker')).status, 'passed');
  assert.equal(fs.existsSync(marker), false);
});

test('P1-06: fresh-script report failure veto and stale evidence are not accepted', async t => {
  const f = fixture(t);
  put(path.join(f.source, 'scripts/report-test.cjs'), "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({passed:false,status:'unavailable'}))");
  f.plan.controlledWorker = {cases: gate.SCENARIOS.controlledWorker.map(id => ({id,
    script: 'scripts/report-test.cjs', args: ['{output}/' + id + '.json'], evidence: ['{output}/' + id + '.json']}))};
  json(f.planFile, f.plan); f.freeze();
  await assert.rejects(f.run('controlledWorker'), /failed actual command/);
});

test('P1-06: nested unavailable cannot hide behind a top-level passed report', async t => {
  const f = fixture(t);
  put(path.join(f.source, 'scripts/report-test.cjs'), "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({passed:true,status:'passed',scenarios:[{status:'unavailable'}]}))");
  f.plan.controlledWorker = {cases: gate.SCENARIOS.controlledWorker.map(id => ({id,
    script: 'scripts/report-test.cjs', args: ['{output}/' + id + '.json'], evidence: ['{output}/' + id + '.json']}))};
  json(f.planFile, f.plan); f.freeze();
  await assert.rejects(f.run('controlledWorker'), /failed actual command/);
});

test('P1-06: scenario aliases bind actual test file AND name', async t => {
  const f = fixture(t);
  f.plan.policyPause.scenarioTests = Object.fromEntries(gate.SCENARIOS.policyPause.map(id => [id,
    [{file: 'tests/all.test.cjs', name: '[' + id + '] actual assertion'}]]));
  json(f.planFile, f.plan); f.freeze(); assert.equal((await f.run('policyPause')).status, 'passed');
  const r = read(path.join(f.dir, 'policyPause.json')).payload;
  const aliases = structuredClone(f.plan.policyPause.scenarioTests); aliases.D01[0].file = 'tests/different.test.cjs';
  assert.throws(() => gate.parseTests(r.commands.at(-1).stdout.path, gate.SCENARIOS.policyPause, aliases, f.source), /missing mandatory scenario/);
});

test('P1-06: existing script external logs are hashed, not just its summary report', async t => {
  const f = fixture(t);
  put(path.join(f.source, 'scripts/external-report.cjs'), `
    const fs=require('node:fs'),path=require('node:path');const evidence=fs.mkdtempSync(path.join(${JSON.stringify(f.root)},'evidence-'));
    fs.writeFileSync(path.join(evidence,'actual.log'),'executed assertion evidence');
    fs.writeFileSync(process.argv[2],JSON.stringify({status:'passed',evidence}));
  `);
  f.plan.controlledWorker = {cases: gate.SCENARIOS.controlledWorker.map(id => ({id,
    script: 'scripts/external-report.cjs', args: ['{output}/' + id + '.json'], evidence: ['{output}/' + id + '.json'],
    evidenceDirectoriesFrom: [{report: '{output}/' + id + '.json', field: 'evidence'}]}))};
  json(f.planFile, f.plan); const options = await complete(f);
  assert.equal(gate.check(options).softwareReady, true);
  const r = read(path.join(f.dir, 'controlledWorker.json')).payload;
  fs.appendFileSync(path.join(r.externalEvidence[0].root, 'actual.log'), 'tampered');
  assert.throws(() => gate.check(options), /external evidence\/log tampered/);
});

test('P1-06: nested test files are included in the actual full-suite command', async t => {
  const f = fixture(t);
  put(path.join(f.source, 'tests/nested/failure.test.cjs'), "require('node:test').test('nested failure',()=>require('node:assert/strict').fail('must execute'))");
  f.freeze(); await assert.rejects(f.run('fullSuite'), /failed actual command/);
  const r = read(path.join(f.dir, 'fullSuite.json')).payload;
  assert.ok(r.commands.at(-1).command.argv.includes(path.join(f.source, 'tests/nested/failure.test.cjs')));
});

test('P1-06: package replacement during actual package Worker run is stale', async t => {
  const f = fixture(t, {testBody: `test('package mutation',()=>{
    if(process.env.SYSTEM_RELEASE_PACKAGE_DIGEST){
      const p=require('node:path').join(process.env.SYSTEM_RELEASE_PACKAGE,'Contents/Resources/app.asar');
      require('node:fs').appendFileSync(p,'replaced');
    }assert.ok(true);
  });`});
  f.freeze(); await f.run('build'); gate.packageId({dir: f.dir, bundle: f.bundle});
  await assert.rejects(f.run('packageWorker'), /stale|package changed/);
  assert.notEqual(read(path.join(f.dir, 'packageWorker.json')).payload.status, 'passed');
});

test('P1-06: timeout is a failed command and cannot leave an earlier green receipt', async t => {
  const f = fixture(t, {testOnly: true, testBody: "test('never completes',async()=>{await new Promise(r=>setTimeout(r,10000));})"});
  f.plan.fullSuite.timeoutMs = 200; json(f.planFile, f.plan); f.freeze();
  await assert.rejects(f.run('fullSuite'), /failed actual command/);
  const r = read(path.join(f.dir, 'fullSuite.json')).payload;
  assert.equal(r.status, 'failed'); assert.equal(r.commands[0].timedOut, true);
});

test('P1-06: CLI nonzero refusal, fixed group names, no arbitrary shell command', t => {
  const f = fixture(t); f.freeze();
  const cli = path.join(f.source, 'scripts/system-release-gate.cjs');
  for (const args of [['check', '--gate', f.dir], ['run', '--gate', f.dir, '--only', 'echo injected'],
    ['run', '--gate', f.dir, '--command', 'touch anything']]) {
    const result = spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stderr).softwareReady, false);
  }
});

test('P1-06: gate output cannot be included source and plan cannot disable mandatory full suite', t => {
  const f = fixture(t);
  assert.throws(() => gate.freeze({...f, dir: path.join(f.source, 'gate-output')}), /output would change/);
  f.plan.fullSuite.tests = ['tests/all.test.cjs']; json(f.planFile, f.plan);
  assert.throws(f.freeze, /fullSuite must run all/);
  f.plan.fullSuite.tests = 'all'; f.plan.controlledWorker.layer = 'production'; json(f.planFile, f.plan);
  assert.throws(f.freeze, /layer escalation/);
});

function structuredReview(f) {
  const engineering=require('../scripts/engineering-check.cjs');
  put(path.join(f.source,'scripts/engineering-check.cjs'),fs.readFileSync(path.join(scripts,'engineering-check.cjs')));
  const pkg=read(path.join(f.source,'package.json'));pkg.scripts=Object.fromEntries(engineering.PACKAGE_ENTRIES.map(n=>[n,'node scripts/release.cjs build']));Object.assign(pkg.scripts,{release:'node scripts/release.cjs','test:share':'node scripts/release.cjs verify'});json(path.join(f.source,'package.json'),pkg);
  const lock=read(path.join(f.source,'package-lock.json'));lock.packages={'':{version:pkg.version}};json(path.join(f.source,'package-lock.json'),lock);
  for(const [name,cmd] of [['package-share','build'],['share-verify','verify'],['cost-efficiency-package','build'],['cost-efficiency-package-verify','verify']])put(path.join(f.source,'scripts',name+'.cjs'),engineering.compatibilitySource(cmd));
  put(path.join(f.source,'.gitignore'),'node_modules/\nrelease*/\n');
  const git=(...args)=>{const r=spawnSync('git',['-C',f.source,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@invalid');git('add','.');git('commit','-qm','fixture baseline');
  const dfile=path.join(f.root,'iteration.json'),doc=path.join(f.root,'approved.md');put(doc,'Fixture independent approval');
  const d={version:1,id:'ENGINEERING-TEST',baselineCommit:git('rev-parse','HEAD'),risk:'C',author:'fixture-author',design:f.design,designReview:f.designReview,allowedFiles:['desktop/runtime.cjs'],requirements:['ENG-TEST'],verificationPlan:f.planFile,metricsDir:path.join(f.root,'metrics')};
  f.plan.requirements=d.requirements;json(f.planFile,f.plan);json(dfile,d);
  json(f.designReview,{format:'engineering-design-review/v1',status:'approved',author:d.author,reviewer:'fixture-reviewer',baselineCommit:d.baselineCommit,designSha256:gate.fileHash(f.design),iterationDefinition:dfile,iterationDefinitionSha256:gate.fileHash(dfile),verificationPlanSha256:gate.fileHash(f.planFile),requirementIds:d.requirements,reviewDocument:{path:doc,sha256:gate.fileHash(doc)},openFindings:[]});
  return {dfile,doc,d};
}
test('ENG-RELEASE: new review requirements bind the same seven-group closure without replacing legacy findings',async t=>{
  const f=fixture(t);structuredReview(f);const options=await complete(f);
  assert.throws(()=>gate.check(options),/unclosed requirement ENG-TEST/);
  const m=read(options.mappingFile),r=read(options.implementationReview),refs=[{group:'policyPause',scenario:'D01'}];
  m.items=[{id:'ENG-TEST',implementation:'complete',verification:'passed',evidence:refs}];json(options.mappingFile,m);
  r.requirementMappingDigest=gate.fileHash(options.mappingFile);r.findings=[{id:'ENG-TEST',status:'closed',evidence:refs}];json(options.implementationReview,r);
  assert.equal(gate.check(options).softwareReady,true);
  put(path.join(f.root,'approved.md'),'Changed approval');assert.throws(()=>gate.check(options),/stale/);
});
test('ENG-RELEASE: legacy review cannot supply new requirements to drop original findings',t=>{const f=fixture(t);f.plan.requirements=['REPLACEMENT'];json(f.planFile,f.plan);assert.throws(f.freeze,/legacy candidates cannot override/);});
test('ENG-RELEASE: changed approved plan and dirty source refuse new-format freeze',async t=>{
 await t.test('plan',t=>{const f=fixture(t);structuredReview(f);f.plan.fullSuite.testConcurrency=4;json(f.planFile,f.plan);assert.throws(f.freeze,/STALE_PLAN/);});
 await t.test('dirty',t=>{const f=fixture(t);structuredReview(f);put(path.join(f.source,'desktop/runtime.cjs'),'changed');assert.throws(f.freeze,/DIRTY_CANDIDATE/);});
});
test('ENG-RELEASE: group environment and bounded concurrency are frozen and injection is refused',async t=>{
 const f=fixture(t,{testBody:"test('group env reached worker',()=>assert.equal(process.env.ENGINEERING_FIXTURE,'yes'));"});f.plan.fullSuite.testConcurrency=2;f.plan.fullSuite.env={ENGINEERING_FIXTURE:'yes'};json(f.planFile,f.plan);f.freeze();assert.equal((await f.run('fullSuite')).status,'passed');
 for(const env of [{NODE_OPTIONS:'--require=x'},{SYSTEM_RELEASE_GROUP:'build'},{PATH:'/tmp'}]){f.plan.fullSuite.env=env;assert.throws(()=>gate.validatePlan(f.plan),/unsafe environment/);}
});


test('ENG-RELEASE: preserved legacy evidence cannot enter new engineering build or archive admission',t=>{const f=fixture(t);f.freeze();const frozen=gate.loadFreeze(f.dir);assert.throws(()=>gate.assertEngineeringAdmission(frozen),/ENGINEERING_ADMISSION_REQUIRED/);assert.equal(frozen.identity.requirements,undefined);});
test('ENG-RELEASE: linked new reviewer attachments are rejected including directory links',async t=>{
 for(const key of ['iterationDefinition','reviewDocument'])await t.test(key,t=>{const f=fixture(t),{dfile,doc}=structuredReview(f),r=read(f.designReview),link=path.join(f.root,'input-link');const target=key==='iterationDefinition'?dfile:doc;fs.symlinkSync(target,link);if(key==='iterationDefinition')r.iterationDefinition=link;else r.reviewDocument.path=link;json(f.designReview,r);assert.throws(f.freeze,/LINKED_REVIEW_INPUT/);});
});


test('ENG-METRICS: unified runner records admission rejection, never reimports an earlier green receipt',async t=>{
 const f=fixture(t);f.freeze();const dir=path.join(f.root,'metrics'),release=require('../scripts/release.cjs'),metrics=require('../scripts/iteration-metrics.cjs');
 await assert.rejects(release.runGroup({gate:f.dir,metrics:dir},'build'),/ENGINEERING_ADMISSION_REQUIRED/);
 let r=metrics.report({dir});assert.equal(r.attempts.failed,1);assert.equal(r.attempts.preflightRejected,1);assert.equal(r.phases.length,0);
 await f.run('build'); // legacy protocol fixture may still be read, not admitted as a new engineering candidate.
 await assert.rejects(release.runGroup({gate:f.dir,metrics:dir},'build'),/ENGINEERING_ADMISSION_REQUIRED/);
 r=metrics.report({dir});assert.equal(r.attempts.failed,2);assert.equal(r.attempts.count,2);assert.equal(r.phases.length,0);assert.equal(r.candidates.invalidated,0);
});

test('ENG-METRICS: no-command build refusal records immutable failure evidence and retains original receipt',async t=>{
 const f=fixture(t),{d}=structuredReview(f);f.freeze();fs.mkdirSync(f.bundle,{recursive:true});
 const release=require('../scripts/release.cjs'),metrics=require('../scripts/iteration-metrics.cjs');
 await assert.rejects(release.runGroup({gate:f.dir},'build'),/output.*exists/);
 const r=metrics.report({dir:d.metricsDir});assert.equal(r.attempts.preflightRejected,1);assert.equal(r.phases.length,0);
 const failed=gate.unseal(f.dir,path.join(f.dir,'build.json'));assert.equal(failed.status,'failed');assert.equal(failed.commands.length,0);
 const events=fs.readdirSync(path.join(d.metricsDir,'events')).map(n=>fs.readFileSync(path.join(d.metricsDir,'events',n),'utf8')).join('\n');assert.ok(events.includes('/runs/build/'+failed.runId+'/receipt.json'));
});
test('ENG-METRICS: successful unified run imports real receipt once with stable run identity',async t=>{
 const f=fixture(t),{d}=structuredReview(f);f.freeze();const release=require('../scripts/release.cjs'),metrics=require('../scripts/iteration-metrics.cjs');
 const result=await release.runGroup({gate:f.dir},'fullSuite');assert.equal(result.status,'passed');const before=metrics.report({dir:d.metricsDir});assert.equal(before.attempts.count,1);assert.equal(before.attempts.failed,0);assert.equal(before.phases.length,1);
 assert.equal(metrics.importRun({dir:d.metricsDir,gateDir:f.dir,group:'fullSuite',actor:'release-runner'}).duplicate,true);assert.equal(metrics.report({dir:d.metricsDir}).eventCount,before.eventCount);
});


test('ENG-METRICS: historical passed receipt verification retains actual results without mutating active run',async t=>{const f=fixture(t);f.freeze();const first=await f.run('fullSuite');const second=await f.run('fullSuite');const file=path.join(f.dir,'fullSuite.json'),before=gate.fileHash(file),frozen=gate.loadFreeze(f.dir);assert.equal(gate.verifyRun(f.dir,frozen,'fullSuite',{runId:first.runId}).runId,first.runId);assert.equal(gate.verifyRun(f.dir,frozen,'fullSuite').runId,second.runId);assert.equal(gate.fileHash(file),before);assert.throws(()=>gate.verifyRun(f.dir,frozen,'fullSuite',{runId:'../outside'}),/invalid historical/);});


test('ENG-METRICS: peer completion cannot erase this invocation admission failure',async t=>{
 const f=fixture(t);f.freeze();const release=require('../scripts/release.cjs'),metrics=require('../scripts/iteration-metrics.cjs'),dir=path.join(f.root,'metrics');
 const original=gate.assertEngineeringAdmission;let peerRunId;
 gate.assertEngineeringAdmission=function(frozen){const r=spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.join(scripts,'system-release-gate.cjs'))}).run({dir:${JSON.stringify(f.dir)},group:'fullSuite'}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);peerRunId=JSON.parse(r.stdout).runId;return original(frozen);};
 t.after(()=>{gate.assertEngineeringAdmission=original;});
 await assert.rejects(release.runGroup({gate:f.dir,metrics:dir},'fullSuite'),/ENGINEERING_ADMISSION_REQUIRED/);
 const result=metrics.report({dir});assert.equal(result.attempts.count,1);assert.equal(result.attempts.failed,1);assert.equal(result.attempts.preflightRejected,1);assert.equal(result.phases.length,0);assert.equal(gate.verifyRun(f.dir,gate.loadFreeze(f.dir),'fullSuite').runId,peerRunId);
});
test('ENG-RELEASE: claimed run identity is exact and an immutable run directory cannot be reused',async t=>{
 const f=fixture(t);f.freeze();const runId=require('node:crypto').randomUUID();assert.equal((await gate.run({dir:f.dir,group:'fullSuite',runId})).runId,runId);const receipt=path.join(f.dir,'runs/fullSuite',runId,'receipt.json'),before=gate.fileHash(receipt);await assert.rejects(gate.run({dir:f.dir,group:'fullSuite',runId}),/exist/);assert.equal(gate.fileHash(receipt),before);await assert.rejects(gate.run({dir:f.dir,group:'fullSuite',runId:'../old'}),/invalid claimed/);
});
