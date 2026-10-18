'use strict';

// Distribution evidence only. Candidate admission and receipts belong to gate.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const gate = require('./system-release-gate.cjs');
const FORMAT = 'xingzhi-release-archive/v1';
const DOCS = ['开始使用.md', '开始使用.txt', '完整使用说明.md'];
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const need = (ok, code, message) => { if (!ok) fail(code, message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const exists = file => !!fs.lstatSync(file, {throwIfNoEntry: false});
const equal = (a, b) => gate.digest(a) === gate.digest(b);
const overlap = (a, b) => gate.inside(a, b) || gate.inside(b, a);
const turn = () => new Promise(resolve => setImmediate(resolve));

function requiredPath(value, name) {
  need(typeof value === 'string' && value.length > 0 && !value.includes('\0'), 'ARCHIVE_ARGUMENT', `${name} is required`);
  return path.resolve(value);
}
function stamp(file) {
  const s = fs.lstatSync(file, {bigint: true});
  return {ino: String(s.ino), dev: String(s.dev), mode: String(s.mode), size: String(s.size),
    mtime: String(s.mtimeNs), ctime: String(s.ctimeNs)};
}
function pathChain(file) {
  const result = [];
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    if (exists(p)) {
      const s = fs.lstatSync(p);
      // Directory contents legitimately change when sibling staging is created;
      // directory replacement and every symlink's write/restore remain bound.
      result.push({path: p, ...(s.isDirectory() ? {ino: String(s.ino), dev: String(s.dev), mode: s.mode & 0o7777} : stamp(p)),
        ...(s.isSymbolicLink() ? {link: fs.readlinkSync(p), realpath: fs.realpathSync(p)} : {})});
    }
    if (p === path.dirname(p)) return result;
  }
}
function fullBundle(bundle) {
  need(fs.lstatSync(bundle).isDirectory(), 'ARCHIVE_BUNDLE', 'bundle root must be an actual directory');
  return [{path: '', type: 'directory', mode: fs.lstatSync(bundle).mode & 0o7777},
    ...gate.tree(bundle, {symlinks: true}).map(e => ({...e, mode: fs.lstatSync(path.join(bundle, e.path)).mode & 0o7777}))];
}
function fileRecord(root, name) {
  const file = path.join(root, name), s = fs.lstatSync(file);
  need(s.isFile(), 'ARCHIVE_FILE_SET', `regular artifact file required: ${name}`);
  return {name, bytes: s.size, mode: s.mode & 0o7777, sha256: gate.fileHash(file)};
}
function cleanEnv() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS$|NODE_PATH$|NODE_TEST_|ELECTRON_RUN_AS_NODE$|SYSTEM_RELEASE_|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(key)) delete env[key];
  return env;
}
function commands(evidence, cwd) {
  let index = 0;
  return async (file, args, {input, timeout = 180000} = {}) => {
    const prefix = path.join(evidence, String(++index).padStart(3, '0'));
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const child = cp.execFile(file, args, {cwd, env: cleanEnv(), encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
        try {
          fs.writeFileSync(prefix + '.stdout', stdout, {flag: 'wx'});
          fs.writeFileSync(prefix + '.stderr', stderr, {flag: 'wx'});
          write(prefix + '.json', {file, args, startedAt, endedAt: new Date().toISOString(),
            exitCode: error ? error.code : 0, signal: error?.signal || null, error: error?.message || null});
          if (error) reject(Object.assign(new Error(`${path.basename(file)} failed: ${error.message}`), {code: 'ARCHIVE_COMMAND', cause: error}));
          else resolve(stdout);
        } catch (e) { reject(e); }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
  };
}

// Stat + hashes + gate's watchers are complementary: an equal final SHA does
// not excuse a write-and-restore during a run, including external review files.
function monitorInputs(f, snapshots, bundle, files, roots) {
  const monitor = gate.watchInputs(f, snapshots, bundle), watchers = [];
  try {
  const bindings = [...new Set(files)].map(file => ({path: file, realpath: fs.realpathSync(file), sha256: gate.fileHash(file)}));
  const beforeFiles = files.map(file => ({file, stat: stamp(file)}));
  const beforeChains = roots.map(pathChain);
  const beforeMutation = gate.mutationIdentity(f, snapshots, bundle);
  const beforeBundle = fullBundle(bundle);
  const bundleStats = () => beforeBundle.map(e => ({path: e.path, stat: stamp(path.join(bundle, e.path))}));
  const beforeBundleStats = bundleStats();
  const gateRoot = roots[0];
  const stateStamp = () => gate.tree(gateRoot).map(e => ({...e, stat: stamp(path.join(gateRoot, e.path))}));
  const beforeState = stateStamp();
    for (const file of [...new Set(files)]) {
      const before = stamp(file);
      const watcher = fs.watch(path.dirname(file), (event, name) => {
        if (name && String(name) !== path.basename(file)) return;
        try { if (!equal(before, stamp(file))) monitor.changed.push(`${file}:${event}`); }
        catch (e) { monitor.changed.push(`${file}:${e.code}`); }
      });
      watcher.on('error', e => monitor.changed.push(e.message)); watchers.push(watcher);
    }
    const watcher = fs.watch(gateRoot, {recursive: true}, (event, name) => {
      try { if (!equal(beforeState, stateStamp())) monitor.changed.push(`gate:${event}:${name || '?'}`); }
      catch (e) { monitor.changed.push(`gate:${e.message}`); }
    });
    watcher.on('error', e => monitor.changed.push(e.message)); watchers.push(watcher);
  return {bindings, bundleEntries: beforeBundle,
    assert() {
      need(equal(beforeChains, roots.map(pathChain)), 'ARCHIVE_INPUT_CHANGED', 'input path or symlink chain changed');
      need(equal(beforeFiles, files.map(file => ({file, stat: stamp(file)}))), 'ARCHIVE_INPUT_CHANGED', 'mapping/review/attachment stat changed');
      need(equal(bindings, bindings.map(b => ({path: b.path, realpath: fs.realpathSync(b.path), sha256: gate.fileHash(b.path)}))),
        'ARCHIVE_INPUT_CHANGED', 'mapping/review/attachment hash changed');
      need(beforeMutation === gate.mutationIdentity(f, snapshots, bundle), 'ARCHIVE_INPUT_CHANGED', 'source/dependency/plan/snapshot/package mutated, including write-and-restore');
      need(equal(beforeBundle, fullBundle(bundle)), 'ARCHIVE_INPUT_CHANGED', 'complete bundle identity changed');
      need(equal(beforeBundleStats, bundleStats()), 'ARCHIVE_INPUT_CHANGED', 'bundle file/directory/link stat changed');
      need(equal(beforeState, stateStamp()), 'ARCHIVE_INPUT_CHANGED', 'gate receipts changed during distribution');
      need(monitor.changed.length === 0, 'ARCHIVE_INPUT_CHANGED', `input changes observed: ${monitor.changed.slice(0, 8).join(', ')}`);
    },
    close() { monitor.close(); watchers.forEach(w => w.close()); }
  };
  } catch (e) { monitor.close(); watchers.forEach(w => w.close()); throw e; }
}

function context(options) {
  const dir = requiredPath(options.dir, 'dir'), mappingFile = requiredPath(options.mappingFile, 'mappingFile');
  const implementationReview = requiredPath(options.implementationReview, 'implementationReview');
  const args = {dir, mappingFile, implementationReview};
  const f = gate.loadFreeze(dir);
  gate.assertEngineeringAdmission(f);
  const snapshots = gate.snapshotIdentity(f, 'historicalReplay').snapshots;
  const p = gate.getPackage(dir, f), bundle = p.identity.bundle;
  const review = read(implementationReview);
  const files = [...Object.values(f.manifest.attachments).filter(Boolean).map(a => a.path),
    mappingFile, implementationReview, requiredPath(review.reviewDocument?.path, 'implementation review document')];
  const roots = [dir, f.source, path.join(f.source, 'node_modules'), f.manifest.dependencies.realpath,
    bundle, path.join(f.source, f.plan.build.output), ...snapshots.map(s => s.path),
    ...Object.values(f.plan.historicalReplay.snapshots).map(s => s.path), ...files];
  const monitor = monitorInputs(f, snapshots, bundle, files, roots);
  try {
    const admitted = gate.check(args);
    need(admitted.softwareReady === true && admitted.packageDigest === p.identity.packageDigest, 'ARCHIVE_GATE', 'live gate did not approve this package');
    monitor.assert();
    const pkg = read(path.join(f.source, 'package.json'));
    need(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version), 'ARCHIVE_VERSION', 'unsafe/missing frozen version');
    need(typeof pkg.productName === 'string' && pkg.productName && path.basename(pkg.productName) === pkg.productName
      && !/[\\\0\r\n]/.test(pkg.productName), 'ARCHIVE_BUNDLE', 'frozen productName required');
    need(path.basename(bundle) === pkg.productName + '.app', 'ARCHIVE_BUNDLE', 'bundle name differs from frozen productName');
    return {args, f, p, pkg, bundle, snapshots, roots, monitor,
      binding: {freezeDigest: f.freezeDigest, sourceDigest: f.sourceDigest, packageDigest: p.identity.packageDigest,
        inputs: monitor.bindings},
      live() {
        monitor.assert();
        gate.assertEngineeringAdmission(gate.loadFreeze(dir));
        const now = gate.check(args);
        need(now.softwareReady === true && now.packageDigest === p.identity.packageDigest && now.sourceDigest === f.sourceDigest,
          'ARCHIVE_GATE', 'live gate identity changed');
        monitor.assert();
      }};
  } catch (e) { monitor.close(); throw e; }
}

function safeOutput(ctx, out, extra = []) {
  out = requiredPath(out, 'out');
  const real = gate.prospectiveRealpath(out);
  gate.outsideInputs(ctx.f.source, real);
  need(!gate.inside(real, ctx.f.source), 'ARCHIVE_OUTPUT', 'output cannot contain source');
  need(!gate.inside(path.join(ctx.f.source, '.git'), real), 'ARCHIVE_OUTPUT', 'output cannot modify Git metadata');
  for (const input of [ctx.args.dir, ctx.bundle, ctx.f.manifest.dependencies.realpath,
    ...ctx.snapshots.map(s => s.path), ...ctx.monitor.bindings.map(b => b.realpath), ...extra]) {
    need(!overlap(real, fs.realpathSync(input)), 'ARCHIVE_OUTPUT', `output overlaps an input: ${input}`);
  }
  need(!gate.inside('/Applications', real) && !/\.app(?:\/|$)/.test(real), 'ARCHIVE_OUTPUT', 'distribution output cannot be an installed application');
  need(!exists(out), 'ARCHIVE_OUTPUT_EXISTS', `output already exists; use a fresh directory: ${out}`);
  return {out, real};
}
function transaction(ctx, out, extra) {
  const target = safeOutput(ctx, out, extra);
  const before = pathChain(path.dirname(target.out));
  fs.mkdirSync(path.dirname(target.out), {recursive: true});
  // Existing ancestor symlinks cannot drift during recursive parent creation.
  const current = new Map(pathChain(path.dirname(target.out)).map(e => [e.path, e]));
  need(before.every(e => equal(e, current.get(e.path))), 'ARCHIVE_OUTPUT_CHANGED', 'output ancestors changed');
  need(gate.prospectiveRealpath(target.out) === target.real, 'ARCHIVE_OUTPUT_CHANGED', 'output target changed');
  const parent = fs.realpathSync(path.dirname(target.out));
  const lock = path.join(parent, path.basename(target.out) + '.release-lock');
  gate.outsideInputs(ctx.f.source, lock);
  fs.mkdirSync(lock, {mode: 0o700});
  let stage;
  try {
    const prefix = path.join(parent, path.basename(target.out) + '.staging-');
    gate.outsideInputs(ctx.f.source, prefix);
    stage = fs.mkdtempSync(prefix);
    const evidence = path.join(stage, 'evidence'), result = path.join(stage, 'result');
    fs.mkdirSync(evidence); fs.mkdirSync(result);
    const chain = pathChain(path.dirname(target.out));
    const assertLocation = () => need(equal(chain, pathChain(path.dirname(target.out)))
      && gate.prospectiveRealpath(target.out) === target.real, 'ARCHIVE_OUTPUT_CHANGED', 'output path/symlink chain drifted');
    write(path.join(stage, 'attempt.json'), {operation: extra?.length ? 'verify' : 'archive', startedAt: new Date().toISOString(),
      target: target.out, ...ctx.binding});
    return {...target, stage, result, evidence, run: commands(evidence, ctx.f.source), assertLocation,
      assertTarget() {
        assertLocation();
        need(!exists(target.out), 'ARCHIVE_OUTPUT_EXISTS', 'output appeared while operation was running');
      },
      close() { fs.rmdirSync(lock); }};
  } catch (e) { fs.rmdirSync(lock); throw e; }
}

async function assertBundle(ctx, bundle, run) {
  need(equal(gate.tree(bundle, {symlinks: true}), ctx.p.identity.entries), 'ARCHIVE_BUNDLE', 'bundle files/bytes/permissions/links differ from gate package');
  need(equal(fullBundle(bundle), ctx.monitor.bundleEntries), 'ARCHIVE_BUNDLE', 'bundle directory/link/file permissions differ from approved package');
  const info = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]));
  const packed = JSON.parse(require('@electron/asar').extractFile(path.join(bundle, 'Contents/Resources/app.asar'), 'package.json').toString());
  need(info.CFBundleShortVersionString === ctx.pkg.version && info.CFBundleVersion === ctx.pkg.version
    && packed.version === ctx.pkg.version && packed.name === ctx.pkg.name, 'ARCHIVE_VERSION', 'plist/ASAR version or package name differs from frozen package.json');
  need(info.CFBundleIdentifier === 'local.xingzhi.assistant' && info.CFBundleName === ctx.pkg.productName
    && info.CFBundleExecutable === ctx.pkg.productName, 'ARCHIVE_BUNDLE', 'plist bundle identifier/name/executable mismatch');
  const executable = path.join(bundle, 'Contents/MacOS', info.CFBundleExecutable);
  need(fs.statSync(executable).isFile() && (fs.statSync(executable).mode & 0o111), 'ARCHIVE_BUNDLE', 'bundle executable is missing or not executable');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
}
function copyDocs(ctx, dest) {
  for (const [source, name] of [['SHARING.md', DOCS[0]], ['SHARING.md', DOCS[1]], ['USER_GUIDE.md', DOCS[2]]]) {
    const relative = 'docs/' + source;
    need(ctx.f.manifest.entries.some(e => e.path === relative && e.type === 'file'), 'ARCHIVE_DOCS', `documentation is not frozen: ${relative}`);
    fs.copyFileSync(path.join(ctx.f.source, relative), path.join(dest, name), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(dest, name), 0o644);
  }
}
function assertPayload(ctx, dir, archiveRoot, dmg) {
  const expected = [path.basename(ctx.bundle), ...DOCS, ...(dmg ? ['Applications'] : [])].sort();
  need(equal(fs.readdirSync(dir).sort(), expected), 'ARCHIVE_FILE_SET', 'unexpected/missing files in actual distribution payload');
  for (const name of DOCS) need(equal(fileRecord(dir, name), fileRecord(archiveRoot, name)), 'ARCHIVE_DOCS', `archive documentation differs: ${name}`);
  if (dmg) need(fs.lstatSync(path.join(dir, 'Applications')).isSymbolicLink()
    && fs.readlinkSync(path.join(dir, 'Applications')) === '/Applications', 'ARCHIVE_DMG', 'DMG Applications link is missing/incorrect');
}
function names(ctx, zipOnly) {
  const base = `Xingzhi-${ctx.pkg.version}-macOS-arm64`;
  return {zip: base + '.zip', dmg: zipOnly ? null : base + '.dmg'};
}
function sums(files) { return files.map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n'; }
function inspectManifest(ctx, root) {
  const manifestPath = path.join(root, 'manifest.json');
  need(fs.lstatSync(manifestPath).isFile(), 'ARCHIVE_MANIFEST', 'manifest must be a regular file');
  const m = read(manifestPath);
  need(m.format === FORMAT && m.status === 'passed' && m.scope === 'archive-integrity'
    && typeof m.zipOnly === 'boolean' && m.version === ctx.pkg.version
    && m.bundleName === path.basename(ctx.bundle) && equal(m.binding, ctx.binding), 'ARCHIVE_MANIFEST', 'stale/unapproved archive manifest');
  need(equal(m.bundleEntries, ctx.monitor.bundleEntries), 'ARCHIVE_BUNDLE', 'manifest bundle identity differs from gate-approved package');
  const n = names(ctx, m.zipOnly);
  const expected = [...DOCS, n.zip, ...(n.dmg ? [n.dmg] : []), 'SHA256SUMS.txt'].sort();
  need(Array.isArray(m.files) && equal(m.files.map(f => f.name).sort(), expected)
    && equal(fs.readdirSync(root).sort(), [...expected, 'manifest.json'].sort()), 'ARCHIVE_FILE_SET', 'archive file set differs from manifest/contract');
  need(equal(m.files, m.files.map(f => fileRecord(root, f.name))), 'ARCHIVE_HASH', 'archive artifact hash/bytes/permissions mismatch');
  need(fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8') === sums(m.files.filter(f => f.name !== 'SHA256SUMS.txt')),
    'ARCHIVE_HASH', 'SHA256SUMS content mismatch');
  // Do not trust a self-consistent edited README + manifest.
  for (const [name, source] of [[DOCS[0], 'SHARING.md'], [DOCS[1], 'SHARING.md'], [DOCS[2], 'USER_GUIDE.md']]) {
    need(gate.fileHash(path.join(root, name)) === gate.fileHash(path.join(ctx.f.source, 'docs', source)), 'ARCHIVE_DOCS', 'documentation differs from frozen source');
  }
  return {manifest: m, names: n};
}

// Reject traversal, duplicate names and symlink-parent tricks before letting
// ditto write anything. The expected paths/bytes come from the approved bundle,
// never from the ZIP's own manifest. Extraction is still independently checked.
async function inspectZip(ctx, file, root) {
  const prefix = path.basename(ctx.bundle);
  const expected = new Map(ctx.monitor.bundleEntries.map(e => [prefix + (e.path ? '/' + e.path : ''), e]));
  for (const name of DOCS) expected.set(name, {...fileRecord(root, name), type: 'file'});
  const crypto = require('node:crypto'), yauzl = require('yauzl');
  await new Promise((resolve, reject) => {
    // ditto writes UTF-8 names without necessarily setting ZIP flag 0x800.
    // Decode raw bytes strictly instead of yauzl's legacy CP437 fallback.
    yauzl.open(file, {lazyEntries: true, decodeStrings: false, validateEntrySizes: true}, (error, zip) => {
      if (error) return reject(error);
      const seen = new Set(); let done = false;
      const finish = error => { if (done) return; done = true; zip.close(); error ? reject(error) : resolve(); };
      zip.on('error', finish);
      zip.on('end', () => {
        try { need(seen.size === expected.size, 'ARCHIVE_ZIP', 'ZIP is missing approved entries'); finish(); }
        catch (e) { finish(e); }
      });
      zip.on('entry', entry => {
        try {
          const filename = new TextDecoder('utf-8', {fatal: true}).decode(entry.fileName);
          for (const field of entry.extraFields) if (field.id === 0x7075) {
            need(field.data.length >= 5 && new TextDecoder('utf-8', {fatal: true}).decode(field.data.subarray(5)) === filename,
              'ARCHIVE_ZIP', 'ZIP Unicode alternate path differs from raw path');
          }
          const name = filename.replace(/\/$/, ''), e = expected.get(name);
          need(e && !seen.has(name) && !name.includes('\\') && !path.posix.isAbsolute(name)
            && !name.split('/').some(p => !p || p === '.' || p === '..'), 'ARCHIVE_ZIP', `unexpected/duplicate ZIP entry: ${filename}`);
          seen.add(name);
          const mode = entry.externalFileAttributes >>> 16, type = mode & 0o170000;
          need((mode & 0o7777) === e.mode, 'ARCHIVE_ZIP', `ZIP permission mismatch: ${name}`);
          if (e.type === 'directory') {
            need(filename.endsWith('/') && type === 0o040000 && entry.uncompressedSize === 0, 'ARCHIVE_ZIP', `invalid ZIP directory: ${name}`);
            zip.readEntry(); return;
          }
          need(!filename.endsWith('/') && type === (e.type === 'link' ? 0o120000 : 0o100000), 'ARCHIVE_ZIP', `ZIP type mismatch: ${name}`);
          const bytes = e.type === 'link' ? Buffer.byteLength(e.target) : e.bytes;
          need(entry.uncompressedSize === bytes, 'ARCHIVE_ZIP', `ZIP size mismatch: ${name}`);
          if (e.type === 'link') {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), e.target));
            need(!path.posix.isAbsolute(e.target) && (target === prefix || target.startsWith(prefix + '/')), 'ARCHIVE_ZIP', `ZIP link escapes bundle: ${name}`);
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error) return finish(error);
            const hash = crypto.createHash('sha256'); let count = 0;
            stream.on('data', data => { count += data.length; hash.update(data); });
            stream.on('error', finish);
            stream.on('end', () => {
              try {
                const sha256 = e.type === 'link' ? crypto.createHash('sha256').update(e.target).digest('hex') : e.sha256;
                need(count === bytes && hash.digest('hex') === sha256, 'ARCHIVE_ZIP', `ZIP bytes mismatch: ${name}`);
                zip.readEntry();
              } catch (e) { finish(e); }
            });
          });
        } catch (e) { finish(e); }
      });
      zip.readEntry();
    });
  });
}

async function inspectArchives(ctx, tx, root, n) {
  const unpacked = path.join(tx.stage, 'unzipped');
  await inspectZip(ctx, path.join(root, n.zip), root);
  await tx.run('/usr/bin/ditto', ['-x', '-k', path.join(root, n.zip), unpacked]);
  assertPayload(ctx, unpacked, root, false);
  const bundle = path.join(unpacked, path.basename(ctx.bundle));
  await assertBundle(ctx, bundle, tx.run);
  if (n.dmg) {
    const dmg = path.join(root, n.dmg), mount = path.join(tx.stage, 'mount');
    fs.mkdirSync(mount);
    await tx.run('/usr/bin/hdiutil', ['verify', dmg]);
    let attached = false;
    try {
      const plist = await tx.run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist', dmg]);
      attached = true;
      const info = JSON.parse(await tx.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {input: plist}));
      need(info['system-entities']?.some(e => e['mount-point'] === mount), 'ARCHIVE_DMG', 'DMG did not attach at the isolated mountpoint');
      assertPayload(ctx, mount, root, true);
      await assertBundle(ctx, path.join(mount, path.basename(ctx.bundle)), tx.run);
    } finally {
      // Also attempt cleanup after a partially successful attach. A detach
      // failure is a failed verification, with the mount path in evidence.
      if (attached || fs.statSync(mount).dev !== fs.statSync(tx.stage).dev) await tx.run('/usr/bin/hdiutil', ['detach', mount]);
    }
  }
  return bundle;
}

// Node's rename can replace an existing empty directory. macOS RENAME_EXCL
// closes that race without an overwrite flag or a copy-to-final window.
async function renameExclusive(tx, from, to) {
  const swift = 'import Darwin\nif renamex_np(CommandLine.arguments[1], CommandLine.arguments[2], UInt32(RENAME_EXCL)) != 0 { perror("renamex_np"); exit(1) }';
  await tx.run('/usr/bin/swift', ['-e', swift, from, to]);
}
async function publish(ctx, tx, extraCheck = () => {}) {
  await turn(); ctx.live(); extraCheck(); tx.assertTarget();
  const original = fs.lstatSync(tx.result);
  const moved = () => {
    const s = fs.lstatSync(tx.real, {throwIfNoEntry: false});
    return s && s.ino === original.ino && s.dev === original.dev;
  };
  try {
    await renameExclusive(tx, tx.result, tx.real);
    tx.published = true;
    await turn(); ctx.live(); extraCheck(); tx.assertLocation();
  }
  catch (e) {
    // A successful rename followed by a log-write error still moved our own
    // directory. Detect ownership rather than touching a concurrent old target.
    if (moved()) {
      tx.published = true;
      try { await renameExclusive(tx, tx.real, tx.result); }
      catch (rollbackError) { e.rollbackError = rollbackError.message; }
      tx.published = !!moved();
    }
    throw e;
  }
}
function retainFailure(tx, error) {
  if (!tx) return;
  const report = {status: 'failed', passed: false, at: new Date().toISOString(), code: error.code || 'ARCHIVE_FAILED', error: error.stack};
  try {
    write(path.join(tx.stage, 'failure.json'), report);
    const manifest = path.join(tx.published ? tx.real : tx.result, 'manifest.json');
    if (exists(manifest)) {
      // Only this attempt's own unpublished/new output can be marked failed.
      fs.renameSync(manifest, path.join(tx.evidence, 'pre-failure-manifest.json'));
      write(manifest, {...report, scope: 'archive-integrity'});
    }
    const verification = path.join(tx.published ? tx.real : tx.result, 'verification.json');
    if (exists(verification)) {
      fs.renameSync(verification, path.join(tx.evidence, 'pre-failure-verification.json'));
      write(verification, {...report, scope: 'distribution-verification'});
    }
  } catch (saveError) { error.evidenceError = saveError.message; }
  error.evidenceDir = tx.stage;
  error.message += ` (failure evidence: ${tx.stage})`;
}

async function archive({dir, mappingFile, implementationReview, out, zipOnly = false}) {
  need(typeof zipOnly === 'boolean', 'ARCHIVE_ARGUMENT', 'zipOnly must be boolean');
  let ctx, tx;
  try {
    ctx = context({dir, mappingFile, implementationReview});
    tx = transaction(ctx, out);
    need(process.platform === 'darwin' && process.arch === 'arm64', 'ARCHIVE_PLATFORM', 'macOS arm64 required');
    await assertBundle(ctx, ctx.bundle, tx.run);
    const n = names(ctx, zipOnly), payload = path.join(tx.stage, 'payload');
    fs.mkdirSync(payload);
    copyDocs(ctx, tx.result); copyDocs(ctx, payload);
    await tx.run('/usr/bin/ditto', ['--norsrc', '--noextattr', ctx.bundle, path.join(payload, path.basename(ctx.bundle))]);
    await assertBundle(ctx, path.join(payload, path.basename(ctx.bundle)), tx.run);
    // ZIP intentionally has no installation link; zip-only needs no DMG tools.
    await tx.run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', payload, path.join(tx.result, n.zip)]);
    if (n.dmg) {
      fs.symlinkSync('/Applications', path.join(payload, 'Applications'));
      await tx.run('/usr/bin/hdiutil', ['create', '-volname', `${ctx.pkg.productName} ${ctx.pkg.version}`, '-srcfolder', payload,
        '-fs', 'HFS+', '-format', 'UDZO', path.join(tx.result, n.dmg)]);
    }
    const files = [...DOCS, n.zip, ...(n.dmg ? [n.dmg] : [])].sort().map(name => fileRecord(tx.result, name));
    fs.writeFileSync(path.join(tx.result, 'SHA256SUMS.txt'), sums(files), {flag: 'wx', mode: 0o644});
    files.push(fileRecord(tx.result, 'SHA256SUMS.txt'));
    await inspectArchives(ctx, tx, tx.result, n);
    await turn(); ctx.live(); tx.assertTarget();
    const manifest = {format: FORMAT, scope: 'archive-integrity', status: 'passed', version: ctx.pkg.version,
      platform: 'darwin', arch: 'arm64', zipOnly, bundleName: path.basename(ctx.bundle), binding: ctx.binding,
      bundleEntries: ctx.monitor.bundleEntries, files, at: new Date().toISOString(),
      experience: 'not_verified', productionDelivery: 'not_verified', developerId: false, notarized: false, gatekeeperApprovalTested: false};
    write(path.join(tx.result, 'manifest.json'), manifest);
    inspectManifest(ctx, tx.result);
    await publish(ctx, tx);
    return {passed: true, scope: 'archive-integrity', archiveDir: tx.real, manifest: path.join(tx.real, 'manifest.json'),
      evidenceDir: tx.stage, ...ctx.binding, experience: 'not_verified', productionDelivery: 'not_verified'};
  } catch (e) { retainFailure(tx, e); throw e; }
  finally { ctx?.monitor.close(); tx?.close(); }
}

async function verify({dir, mappingFile, implementationReview, archiveDir, out}) {
  let ctx, tx, archiveMonitor;
  try {
    ctx = context({dir, mappingFile, implementationReview});
    archiveDir = requiredPath(archiveDir, 'archiveDir');
    need(fs.lstatSync(archiveDir).isDirectory(), 'ARCHIVE_MANIFEST', 'archiveDir must be an actual directory');
    const archiveChain = pathChain(archiveDir);
    archiveDir = fs.realpathSync(archiveDir);
    tx = transaction(ctx, out, [archiveDir]);
    const baseline = () => ({chain: pathChain(archiveChain[0].path), entries: gate.tree(archiveDir),
      stats: fs.readdirSync(archiveDir).sort().map(name => ({name, stat: stamp(path.join(archiveDir, name))}))});
    const before = baseline(), changed = [];
    archiveMonitor = fs.watch(archiveDir, {recursive: true}, (event, name) => {
      try { if (!equal(before, baseline())) changed.push(`${event}:${name || '?'}`); }
      catch (e) { changed.push(e.message); }
    });
    archiveMonitor.on('error', e => changed.push(e.message));
    const unchanged = () => need(equal(before, baseline()) && !changed.length, 'ARCHIVE_INPUT_CHANGED', 'distribution archive changed during verification');
    const {manifest, names: n} = inspectManifest(ctx, archiveDir);
    const bundle = await inspectArchives(ctx, tx, archiveDir, n);
    unchanged(); ctx.live();
    const experience = await require('./release-share-verify.cjs').verify({bundle, output: path.join(tx.result, 'experience'),
      source: ctx.f.source, version: ctx.pkg.version});
    need(experience.passed === true && experience.scope === 'share-experience', 'ARCHIVE_EXPERIENCE', 'share experience did not pass');
    // Detect mutations of the extracted executable/resources by startup too.
    await assertBundle(ctx, bundle, tx.run);
    await turn(); unchanged(); ctx.live(); tx.assertTarget();
    const report = {passed: true, scope: 'distribution-verification', archiveDir, manifestSha256: gate.fileHash(path.join(archiveDir, 'manifest.json')),
      ...ctx.binding, version: manifest.version, zipOnly: manifest.zipOnly, experience,
      at: new Date().toISOString(), productionDelivery: 'not_verified', developerId: false, notarized: false, gatekeeperApprovalTested: false};
    write(path.join(tx.result, 'verification.json'), report);
    await publish(ctx, tx, unchanged);
    return {...report, out: tx.real, evidenceDir: tx.stage};
  } catch (e) { retainFailure(tx, e); throw e; }
  finally { archiveMonitor?.close(); ctx?.monitor.close(); tx?.close(); }
}

module.exports = {archive, verify};
