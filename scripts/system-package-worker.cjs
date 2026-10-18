'use strict';
// External, headless, controlled harness. Never starts desktop/main.cjs, extracts
// production modules, builds an app, or substitutes the checkout for app.asar.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const VERSION = 'system-package-worker/2';
const GENERIC_SCENARIOS = {generic_success:'success',generic_uncertain:'uncertain',generic_mismatch:'mismatch',generic_preflight_recovery:'preflight_recovery',generic_v2_recovery:'v2_recovery',generic_local_recovery:'local_recovery'};
const GENERIC_RECOVERIES=['generic_preflight_recovery','generic_v2_recovery','generic_local_recovery'];
const SCENARIOS = ['success', 'pause_during_check', 'uncertain', 'readback_mismatch', 'context_authorization_repair', 'storage_method_recovery', ...Object.keys(GENERIC_SCENARIOS)];
const SOURCE = path.resolve(__dirname, '..');
const REQUIRED = ['engine-client.cjs', 'engine-worker.cjs', 'core.cjs', 'agent.cjs'];
const STORAGE_MODULES = ['evidence-storage-method.cjs', 'evidence-recovery.cjs', 'platform-result.cjs', 'data-platform.cjs', 'access-policy-store.cjs'];
const GENERIC_MODULES = ['evidence-consumption.cjs','pending-check.cjs','execution-policy.cjs','continuation-control.cjs','execution-control.cjs','evidence-recovery.cjs','relation-obligations.cjs','generation.cjs','agent-writes.cjs','platform-result.cjs'];
const RECOVERY_MODULES=['evidence-legacy-preflight.cjs','evidence-storage-method.cjs','evidence-storage-family.cjs','platform-local-recovery.cjs','platform-operation-proof.cjs','operation-ledger.cjs','evidence-item-lifecycle.cjs'];
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fileHash(file) {
  const fd = fs.openSync(file, 'r'), h = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function tree(root, ignore = () => false) {
  const rows = [];
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const rel = relative ? relative + '/' + name : name;
      if (ignore(rel)) continue;
      const file = path.join(root, rel), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        assert.ok(inside(fs.realpathSync(root), fs.realpathSync(file)), 'escaping symlink: ' + file);
        rows.push({path: rel, type: 'link', target: fs.readlinkSync(file)});
      } else if (stat.isDirectory()) { rows.push({path: rel, type: 'directory'}); walk(rel); }
      else { assert.ok(stat.isFile(), 'unsupported input: ' + file); rows.push({path: rel, type: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: fileHash(file)}); }
    }
  }
  walk(''); return rows;
}
function sourceIdentity(root) {
  const excluded = ['node_modules', '.git', 'dist', 'artifacts', '.local-data', 'coverage', 'test-results', 'playwright-report'];
  const entries = tree(root, rel => excluded.includes(rel.split('/')[0]) || /^release(?:-|\/|$)/.test(rel)
    || /(^|\/)\.DS_Store$/.test(rel) || /^desktop\/native\/bin(?:\/|$)/.test(rel));
  return {root, scope: 'checkout inputs; excludes dependencies, generated native/bin and build/output directories', entries, digest: digest(entries)};
}
function packageIdentity(app) {
  const entries = tree(app), asar = entries.find(e => e.path === 'Contents/Resources/app.asar' && e.type === 'file');
  assert.ok(asar, 'final .app must contain app.asar');
  const unpacked = entries.filter(e => e.path.startsWith('Contents/Resources/app.asar.unpacked/'));
  const native = unpacked.filter(e => e.type === 'file' && (/\/native\/bin\//.test(e.path) || e.path.endsWith('.node')));
  assert.ok(native.length, 'final .app must contain unpacked native outputs');
  return {app, entries, digest: digest(entries), asarSHA256: asar.sha256, unpackedDigest: digest(unpacked), nativeDigest: digest(native), native, nativeExecution: 'not_exercised'};
}
// Read-only V1 fuse wire, including both slices of a universal binary. Unknown
// or disabled RunAsNode must fail BEFORE spawning, since ignoring the env flag
// could otherwise launch the production App. Layout: electron/fuses src/{index,constants,config}.ts.
function readNodeFuses(file) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(4 * 1024 * 1024 + SENTINEL.length + 257), wires = [];
  try {
    const size = fs.fstatSync(fd).size, step = 4 * 1024 * 1024;
    for (let offset = 0; offset < size; offset += step) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, offset), bytes = buffer.subarray(0, n);
      for (let i = bytes.indexOf(SENTINEL); i >= 0 && i < step; i = bytes.indexOf(SENTINEL, i + 1)) {
        const p = i + SENTINEL.length, version = bytes[p], length = bytes[p + 1];
        assert.ok(version === 1 && length > 0 && p + 2 + length <= n, 'unsupported/truncated Electron fuse wire');
        assert.equal(bytes[p + 2], 0x31, 'RunAsNode is disabled; refusing to launch the App');
        wires.push({offset: offset + i, version, length, runAsNode: true});
      }
    }
  } finally { fs.closeSync(fd); }
  assert.ok(wires.length >= 1 && wires.length <= 2, 'missing/ambiguous Electron fuse wire; no process launched');
  return wires;
}
function executable(app) {
  const folder = path.join(app, 'Contents/MacOS');
  const files = fs.readdirSync(folder).filter(name => fs.statSync(path.join(folder, name)).isFile());
  assert.equal(files.length, 1, 'ambiguous .app executable');
  const binary = fs.realpathSync(path.join(folder, files[0]));
  const framework = fs.realpathSync(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'));
  assert.ok(inside(app, binary) && inside(app, framework), 'runtime must belong to the selected .app');
  return {binary, framework, binarySHA256: fileHash(binary), frameworkSHA256: fileHash(framework), fuses: readNodeFuses(framework)};
}
function redirectRequires(text, desktop, helper, physicalHelper) {
  return text.replace(/require\((['"])(\.[^'"]+)\1\)/g, (_all, _quote, request) => {
    const match = request.match(/^\.\.\/(?:\.\.\/)?desktop\/([a-z0-9-]+\.cjs)$/);
    if (match) return 'require(' + JSON.stringify(path.join(desktop, match[1])) + ')';
    if (request === '../tests/helpers/platform-fixture.cjs' && helper) return 'require(' + JSON.stringify(helper) + ')';
    if (request === '../tests/root-relation-physical-fixture.cjs' && physicalHelper) return 'require(' + JSON.stringify(physicalHelper) + ')';
    throw Error('unreviewed relative fixture dependency: ' + request);
  });
}
function adaptFixture(text, desktop, helper, physicalHelper) {
  assert.match(text, /\brestoreAudit\b/, 'root fixture must support persisted transport restoration');
  return redirectRequires(text, desktop, helper, physicalHelper);
}
function childEnvironment(dir, config) {
  // Deliberately do not inherit NODE_OPTIONS/NODE_PATH, credentials, proxies,
  // ASSISTANT_* or CLI/model configuration. HOME is never reassigned.
  return {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC', TMPDIR: dir,
    XDG_CONFIG_HOME: path.join(dir, 'profile/config'), XDG_CACHE_HOME: path.join(dir, 'profile/cache'),
    ELECTRON_RUN_AS_NODE: '1', SYSTEM_PACKAGE_WORKER_CONFIG: config};
}
function installIsolation(config) {
  const Module = require('node:module'), wt = require('node:worker_threads');
  const nativeFs=process.versions.electron?require('original-fs'):fs;
  const log = path.join(config.dir, `denied-${config.phase}-${wt.threadId}.jsonl`);
  const append = fs.appendFileSync.bind(fs);
  const deny = name => (..._args) => { append(log, JSON.stringify({name, threadId: wt.threadId,stack:new Error().stack}) + '\n'); throw Error('CONTROLLED_EXTERNAL_DENIED: ' + name); };
  const patch = (object, names) => { for (const name of names) if (typeof object[name] === 'function') object[name] = deny(name); };
  globalThis.fetch = deny('fetch'); globalThis.WebSocket = deny('WebSocket');
  patch(require('node:net').Socket.prototype, ['connect']);
  patch(require('node:net'), ['connect', 'createConnection', 'createServer']);
  for (const name of ['node:http', 'node:https']) patch(require(name), ['request', 'get', 'createServer']);
  patch(require('node:http2'), ['connect', 'createServer', 'createSecureServer']);
  patch(require('node:tls'), ['connect', 'createServer']); patch(require('node:dgram'), ['createSocket']);
  for (const object of [require('node:dns'), require('node:dns').promises]) patch(object, Object.keys(object));
  patch(require('node:child_process'), ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  process.dlopen = deny('native module execution');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, ...args) {
    if (request === 'original-fs') return deny('unwrapped filesystem module')();
    if (request === 'electron' || request.startsWith('electron/')) return deny('Electron UI module')();
    const file = resolve.call(this, request, parent, ...args);
    if (path.isAbsolute(file) && (!inside(config.asar, file) && !inside(config.dir, file)
      || file === path.join(config.asar, 'desktop/main.cjs'))) return deny('module outside package/harness: ' + file)();
    return file;
  };
  const exists = fs.existsSync.bind(fs), realpath = fs.realpathSync.bind(fs), descriptors = new Map();
  // Electron's ASAR package.json reader opens its descriptor below public fs.open.
  // Bind that read-only exception to the selected archive's actual inode, never
  // to call-stack depth or an arbitrary descriptor presented by a caller.
  const archiveStat=nativeFs.statSync(config.asar),descriptorStat=nativeFs.fstatSync.bind(nativeFs);
  function selectedArchiveDescriptor(fd){
    try{const stat=descriptorStat(fd);return stat.isFile()&&stat.dev===archiveStat.dev&&stat.ino===archiveStat.ino&&stat.size===archiveStat.size;}
    catch{return false;}
  }
  function ownedDescriptor(fd,write=false){
    const owned=descriptors.get(fd);if(!owned||write&&!owned.writable)return false;
    try{const stat=descriptorStat(fd);return stat.dev===owned.dev&&stat.ino===owned.ino;}catch{return false;}
  }
  function remember(fd,file){
    const stat=descriptorStat(fd),{target,real}=resolved(file);
    descriptors.set(fd,{dev:stat.dev,ino:stat.ino,writable:inside(config.dir,target)&&inside(config.dir,real)&&!inside(config.asar,target)&&!inside(config.asar,real)});
  }
  function resolved(file) {
    if (file instanceof URL) file = require('node:url').fileURLToPath(file);
    const target = path.resolve(Buffer.isBuffer(file) ? file.toString() : file);
    let ancestor = target;
    while (!exists(ancestor)) { const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next; }
    return {target, real: path.join(realpath(ancestor), path.relative(ancestor,target))};
  }
  function readable(file) {
    if (typeof file === 'number') { if (!ownedDescriptor(file)&&!selectedArchiveDescriptor(file)) deny('read from unowned descriptor')(); return; }
    const {target,real}=resolved(file), allowed=p=>inside(config.dir,p)||inside(config.asar,p);
    if (!allowed(target)||!allowed(real)) deny('read outside package/temporary root')();
  }
  function writable(file) {
    if (typeof file === 'number') { if (!ownedDescriptor(file,true)) deny('write to unowned descriptor')(); return; }
    const {target,real}=resolved(file);
    if (!inside(config.dir, target) || !inside(config.dir, real)||inside(config.asar,target)||inside(config.asar,real)) deny('write outside temporary root')();
  }
  for (const object of [fs, fs.promises]) {
    for (const name of ['readFile','createReadStream','readdir','opendir','readlink','stat','lstat','realpath','access','exists']) {
      for (const key of [name,name+'Sync']) if(typeof object[key]==='function'){
        const original=object[key];object[key]=function(file,...args){
          if(key==='createReadStream'&&Number.isInteger(args[0]?.fd)){readable(args[0].fd);if(file!=null)readable(file);}
          else readable(file);
          return original.call(this,file,...args);
        };
        if(original.native)object[key].native=function(file,...args){readable(file);return original.native.call(this,file,...args);};
      }
    }
    for (const key of ['read','readSync','readv','readvSync']) if(typeof object[key]==='function'){
      const original=object[key];object[key]=function(fd,...args){readable(fd);return original.call(this,fd,...args);};
    }
    for (const key of ['write','writeSync','writev','writevSync','ftruncate','ftruncateSync','fchmod','fchmodSync','fchown','fchownSync','futimes','futimesSync']) if(typeof object[key]==='function'){
      const original=object[key];object[key]=function(fd,...args){writable(fd);return original.call(this,fd,...args);};
    }
    for (const key of ['close','closeSync']) if(typeof object[key]==='function'){
      const original=object[key];object[key]=function(fd,...args){descriptors.delete(fd);return original.call(this,fd,...args);};
    }
    for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream']) {
      for (const key of [name, name + 'Sync']) if (typeof object[key] === 'function') {
        const original = object[key]; object[key] = function(file, ...args) {
          if(key==='createWriteStream'&&Number.isInteger(args[0]?.fd)){writable(args[0].fd);if(file!=null)writable(file);}
          else writable(file);
          return original.call(this, file, ...args);
        };
      }
    }
    for (const name of ['rename', 'copyFile', 'cp']) for (const key of [name, name + 'Sync']) if (typeof object[key] === 'function') {
      const original = object[key]; object[key] = function(from, to, ...args) { if (name === 'rename') writable(from); else readable(from); writable(to); return original.call(this, from, to, ...args); };
    }
    patch(object, ['symlink', 'symlinkSync', 'link', 'linkSync']);
    for (const key of ['open', 'openSync']) if (typeof object[key] === 'function') {
      const original = object[key]; object[key] = function(file, flags, ...args) {
        readable(file);
        if (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags || 'r')) writable(file);
        if(object===fs&&key==='open'){
          const callback=args.pop();return original.call(this,file,flags,...args,(error,fd)=>{if(!error)remember(fd,file);callback(error,fd);});
        }
        const result=original.call(this,file,flags,...args);
        if(key==='openSync'){remember(result,file);return result;}
        return result.then(handle=>{
          const fd=handle.fd;remember(fd,file);
          for(const method of ['write','writev','writeFile','appendFile','truncate','chmod','chown','utimes','createWriteStream'])if(typeof handle[method]==='function'){
            const original=handle[method].bind(handle);handle[method]=(...args)=>{writable(fd);return original(...args);};
          }
          for(const method of ['read','readv','readFile','createReadStream'])if(typeof handle[method]==='function'){
            const original=handle[method].bind(handle);handle[method]=(...args)=>{readable(fd);return original(...args);};
          }
          const close=handle.close.bind(handle);handle.close=(...args)=>{descriptors.delete(fd);return close(...args);};return handle;
        });
      };
    }
  }
  Module.syncBuiltinESMExports();
}
function moduleProof(config, names) {
  const wt = require('node:worker_threads');
  if (!wt.isMainThread) {
    assert.equal(wt.workerData.kind, 'assistant-engine');
    assert.equal(wt.workerData.entry, path.join(config.asar, 'desktop/engine-worker.cjs'));
  }
  const rows = names.map(name => {
    const file = path.join(config.asar, 'desktop', name);
    assert.ok(require.cache[file], 'required package module was not loaded: ' + file);
    return {file, sha256: fileHash(file)};
  });
  const loaded = Object.keys(require.cache).filter(file => inside(config.asar, file)).sort();
  assert.ok(!loaded.includes(path.join(config.asar, 'desktop/main.cjs')));
  return {pid: process.pid, threadId: wt.threadId, workerEntry: wt.workerData?.entry, modules: rows, loadedPackageModules: loaded};
}
function workerModuleNames(config) {
  const names=['engine-worker.cjs', 'core.cjs', 'agent.cjs'];
  if(config.scenario==='context_authorization_repair')names.push('pending-check.cjs', 'generation-context.cjs', 'check-finalization.cjs', 'task-context.cjs', 'access.cjs');
  if(config.scenario==='storage_method_recovery'){
    assert.ok(Number.isInteger(config.phase)&&config.phase>=0&&config.phase<=3,'unknown storage proof phase');
    // Cold paused/review processes must not execute a dormant acquisition path.
    if(config.phase<=1)names.push(...STORAGE_MODULES);
  }
  return names;
}
function assertStorageModuleProof(phases,asar,desktopInputs){
  for(const phase of [0,1]){
    const result=phases[phase]?.result,proof=result?.final?.modules;
    assert.equal(result?.phase,phase);assert.equal(result.status,'passed');assert.ok(proof?.threadId>0);
    assert.equal(proof.pid,result.pid,'storage proof came from another process');
    assert.equal(proof.workerEntry,path.join(asar,'desktop/engine-worker.cjs'));
    for(const name of STORAGE_MODULES){
      const entries=proof.modules.filter(row=>row.file===path.join(asar,'desktop',name));
      assert.equal(entries.length,1,'missing actual storage module proof: '+name);
      assert.match(entries[0].sha256,/^[a-f0-9]{64}$/);
      const expected=desktopInputs.filter(row=>row.path==='desktop/'+name);
      assert.equal(expected.length,1);assert.equal(entries[0].sha256,expected[0].sha256,'storage module hash differs from package-verified source: '+name);
    }
  }
}
function assertStorageNoDispatch(previous,next,message){
  const before=structuredClone(previous),after=structuredClone(next);
  const oldLoaded=before.modules.loadedPackageModules,newLoaded=after.modules.loadedPackageModules;
  assert.ok(Array.isArray(oldLoaded)&&Array.isArray(newLoaded));
  const asar=path.dirname(path.dirname(after.modules.workerEntry));
  assert.ok(newLoaded.every(file=>inside(asar,file)),'module diagnostic escaped selected ASAR');
  assert.ok(oldLoaded.every(file=>newLoaded.includes(file)),'loaded module proof disappeared');
  delete before.modules.loadedPackageModules;delete after.modules.loadedPackageModules;
  assert.deepEqual(after,before,message);
}
function genericSnapshot(f,config){
  const observed=require(config.fixture).observe(f),{a,job,task}=f;
  // Only attest modules actually loaded by this Worker. The verifier below
  // requires the complete new execution path after the two acquisition rounds.
  const loaded=[...GENERIC_MODULES,...(GENERIC_RECOVERIES.includes(config.scenario)?RECOVERY_MODULES:[])].filter(name=>require.cache[path.join(config.asar,'desktop',name)]);
  return {jobId:job.id,taskId:task.id,jobStatus:job.status,taskStatus:task.status,autoAccept:job.autoAccept,
    acceptedAt:task.acceptedAt??null,completedAt:job.completedAt??null,paused:a.data.stewardship.paused,
    busy:!!a.operation,runs:a.data.agentRuns.length,modelCalls:job.callsUsed,primary:task.primaryArtifactId,generic:observed,
    modules:moduleProof(config,[...workerModuleNames(config),...loaded])};
}
function assertGenericBase(s){
  assertUnaccepted(s);const g=s.generic;assert.ok(g,'missing generic fixture observation');
  assert.ok(g.threadId>0);assert.equal(g.threadId,s.modules.threadId);
  assert.equal(g.accepted,false);assert.equal(g.oldCycles,g.originalCycles,'old cycle allowance changed');
  assert.ok(Number.isSafeInteger(s.modelCalls)&&s.modelCalls>=g.audit.patches.length+g.audit.checks.length,'missing or inconsistent cumulative model count');
  assert.equal(g.budget.limitUSD,200);assert.ok(Number.isFinite(g.budget.spentUSD)&&g.budget.spentUSD>=17,'original spend was reset');
  assert.deepEqual(g.audit.violations,[]);assert.equal(g.audit.creates,1,'only controlled historical seed may create a document');
  assert.equal(g.primary.id,s.primary);assert.equal(g.primary.primaryLineageId,'generic-original');
}
function assertGenericCheckpoint(s){
  assertGenericBase(s);const g=s.generic;
  assert.deepEqual(g.audit.queries,['leaf']);assert.equal(g.audit.patches.length,1);
  assert.equal(g.audit.writes,0);assert.deepEqual(g.audit.checks,[]);assert.equal(g.primary.draftOnly,true);
  assert.equal(g.consumption.receipts.length,1);assert.equal(g.consumption.receipts[0].artifactId,g.primary.id);
  assert.equal(g.consumption.receipts[0].baseArtifactId,'generic-original');
  assert.notEqual(s.jobStatus,'review');assert.notEqual(s.taskStatus,'review');
}
function assertGenericWritten(s){
  assertGenericBase(s);const g=s.generic;
  assert.deepEqual(g.audit.queries,['leaf','tail']);assert.equal(g.audit.patches.length,2);assert.equal(g.audit.writes,1);
  assert.equal(g.primary.draftOnly,false);assert.equal(g.contentCheck?.passed,true);assert.ok(g.audit.checks.includes('content'));
  assert.equal(g.consumption.receipts.length,2);const [first,last]=g.consumption.receipts;
  assert.equal(first.baseArtifactId,'generic-original');assert.equal(last.baseArtifactId,first.artifactId);
  assert.equal(last.artifactId,g.primary.id);assert.notEqual(last.artifactId,first.artifactId);
  assert.ok(g.primary.content.includes('leaf→tail')&&g.primary.content.includes('tail→无上游'));
  assert.equal(g.deliveries.length,1);assert.ok(g.deliveries[0].id);
}
function assertGenericComplete(s,{mismatch=false}={}){
  assertGenericWritten(s);const g=s.generic;
  if(mismatch){assert.notEqual(s.jobStatus,'review');assert.notEqual(s.taskStatus,'review');assert.ok(!g.audit.checks.includes('goal'),'mismatched readback reached final goal check');}
  else{
    assert.equal(s.jobStatus,'review');assert.equal(s.taskStatus,'review');assert.equal(g.resultCheck?.passed,true);
    assert.ok(g.audit.checks.includes('result')&&g.audit.checks.includes('goal'),'independent final checks missing');
    assert.equal(g.deliveries[0].status,'done');assert.equal(g.deliveries[0].result.url,'https://generic-fixture.feishu.cn/docx/GenericConsumptionFixture123');assert.equal(g.deliveries[0].result.verified,true);
  }
}
function assertGenericRestored(previous,next){
  assertUnaccepted(next);assert.notEqual(previous.modules.pid,next.modules.pid,'generic restart must replace the Electron process');
  assert.ok(next.modules.threadId>0);
  for(const key of ['jobId','taskId','jobStatus','taskStatus','autoAccept','acceptedAt','completedAt','paused','primary','runs','modelCalls'])assert.deepEqual(next[key],previous[key],'generic cold restore changed '+key);
  // Compare the JSON-persisted representation: absent optional fields cannot
  // differ merely because a live Worker object has an undefined property.
  const before=JSON.parse(JSON.stringify(previous.generic)),after=JSON.parse(JSON.stringify(next.generic));delete before.threadId;delete after.threadId;
  assert.deepEqual(after,before,'generic cold restore changed receipts, transport state, original draft or budget');
}
function assertGenericModuleProof(phases,asar,desktopInputs,{recovery=false}={}){
  for(const phase of recovery?[1,2]:[0,1]){
    const result=phases[phase]?.result,proof=result?.final?.modules;
    assert.equal(result?.phase,phase);assert.equal(result.status,'passed');assert.ok(proof?.threadId>0);assert.equal(proof.pid,result.pid);
    assert.equal(proof.workerEntry,path.join(asar,'desktop/engine-worker.cjs'));
    for(const name of [...GENERIC_MODULES,...(recovery?RECOVERY_MODULES:[])]){
      const found=proof.modules.filter(r=>r.file===path.join(asar,'desktop',name)),expected=desktopInputs.filter(r=>r.path==='desktop/'+name);
      assert.equal(found.length,1,'missing actual generic module proof: '+name);assert.equal(expected.length,1);
      assert.match(found[0].sha256,/^[a-f0-9]{64}$/);assert.equal(found[0].sha256,expected[0].sha256,'generic module differs from final package source: '+name);
    }
  }
}
function assertGenericRecoverySeed(g){
  const r=g.recovery,initial=r?.initial;assert.ok(initial&&['preflight_recovery','v2_recovery','local_recovery'].includes(initial.kind));
  assert.equal(g.primary.id,'generic-original');assert.equal(g.audit.patches.length,0);assert.equal(g.audit.writes,0);assert.deepEqual(g.audit.checks,[]);
  assert.equal(g.accepted,false);assert.equal(g.oldCycles,g.originalCycles);assert.deepEqual(g.budget,initial.ledger);assert.equal(g.budget.limitUSD,200);assert.equal(g.budget.spentUSD,17);
  assert.deepEqual(r.counts,initial.counts);assert.equal(r.counts.models,0);assert.equal(r.claims.length,0);assert.equal(r.corrections.length,0);assert.equal(r.source,undefined);
  if(initial.kind==='local_recovery'){
    assert.equal(initial.failureCode,'LOCAL_RESULT_STORAGE');assert.equal(r.operation.id,initial.operationId);assert.equal(r.operation.status,'failed');
    assert.ok(initial.requests.length>0&&initial.requests.every(q=>q.requestId&&q.operationId===initial.operationId&&q.attemptId===initial.attemptId));
    assert.match(initial.responseHash,/^[a-f0-9]{64}$/);assert.equal(r.originalOperationHash,initial.operationHash);assert.deepEqual(g.audit.queries,['leaf']);assert.equal(r.localCompletion,null);
  }else{
    assert.deepEqual(g.audit.queries,[]);assert.equal(initial.proof.eligible,true);assert.equal(r.oldRunHash,initial.runHash);assert.equal(r.oldAttemptPreserved,true);
    if(initial.kind==='preflight_recovery')assert.equal(initial.proof.reason,'PROVEN_ZERO_BUSINESS_DISPATCH');
    else {assert.equal(initial.proof.method,'platform-chunks-v2');assert.equal(initial.proof.originOperationId,initial.operationId);assert.equal(r.originalOperationHash,initial.operationHash);}
  }
}
function assertGenericRecoveryProgress(g){
  const r=g.recovery,initial=r?.initial;assert.ok(initial);assert.equal(r.source?.associated,true);assert.equal(r.source.readAllowed,true);assert.equal(r.operation.status,'done');
  assert.equal(r.operation.sourceId,r.source.id);assert.equal(r.operation.responseProof?.operationId,r.operation.id);assert.ok(r.operation.responseProof.requestId);
  assert.equal(r.operation.responseProof.dataHash,r.source.restoredHash,'saved source must match the original response');
  assert.ok(r.steps.some(s=>s.tool==='plan_task'&&s.args.evidenceResolution?.sourceIds.includes(r.source.id)),'normal plan_task must associate recovered source');
  for(const receipt of g.consumption.receipts){const attempt=g.consumption.attempts[receipt.attemptId];assert.equal(attempt.status,'committed');assert.ok(r.steps.some(s=>s.runId===attempt.runId&&s.tool==='advance_task'),'consumption must execute through normal Agent tool protocol');}
  if(initial.kind==='preflight_recovery'){
    assert.equal(r.corrections.length,1);assert.equal(r.corrections[0].payload.originalAttemptHash,initial.attemptHash);assert.equal(r.oldAttemptPreserved,true);assert.equal(r.oldRunHash,initial.runHash);assert.equal(r.claims.length,0);
    assert.ok(r.steps.some(s=>s.tool==='platform_query'&&s.dispatch.requests.some(q=>q.query.table==='leaf')),'corrected business target must really dispatch');
  }else if(initial.kind==='v2_recovery'){
    assert.equal(r.claims.length,1);const c=r.claims[0];assert.equal(c.method,'platform-chunks-v2');assert.equal(c.status,'done');assert.equal(c.originOperationId,initial.operationId);assert.equal(c.familyKey,initial.familyKey);
    assert.equal(r.operation.originOperationId,initial.operationId);assert.equal(r.operation.familyKey,c.familyKey);assert.equal(r.operation.methodClaimId,c.key);assert.equal(c.operationId,r.operation.id);assert.equal(c.sourceId,r.source.id);
    assert.equal(r.originalOperationHash,initial.operationHash);assert.equal(r.oldRunHash,initial.runHash);assert.equal(r.source.format,'platform-chunks-v2');
  }else{
    assert.equal(initial.kind,'local_recovery');assert.deepEqual(r.localCompletion?.counts,initial.counts,'local recovery must not allocate identity/platform/model/method calls');assert.equal(r.claims.length,0);
    assert.equal(r.operation.id,initial.operationId);assert.equal(r.operation.attemptId,initial.attemptId);assert.equal(r.operation.logicalKey,initial.logicalKey);assert.deepEqual(r.operation.requests,initial.requests);
    assert.equal(r.operation.responseProof.dataHash,initial.responseHash);assert.equal(r.source.restoredHash,initial.responseHash);
    const step=r.steps.find(s=>s.tool==='recover_platform_result');assert.equal(step?.result.sourceId,r.source.id);assert.equal(step.result.storageValidation,'original_response_verified');assert.deepEqual(step.dispatch.requests,[]);
  }
}
function snapshot(f, config) {
  if(GENERIC_SCENARIOS[config.scenario])return genericSnapshot(f,config);
  const {a, job, task, audit} = f, state = job.executionState?.continuation;
  return {jobId: job.id, taskId: task.id, jobStatus: job.status, taskStatus: task.status, autoAccept: job.autoAccept,
    acceptedAt: task.acceptedAt ?? null, completedAt: job.completedAt ?? null, paused: a.data.stewardship.paused,
    busy: !!a.operation, runs: a.data.agentRuns.length, primary: task.primaryArtifactId,
    continuation: state, activeTaskId: state?.activeTaskId, activeBasis: state?.activeBasis, episodes: state?.episodes,
    efficiency: job.executionState?.workEfficiency, ledger: a.spendLedger.scopes['job:' + job.id],
    reads: job.executionState?.reads,
    contentVerification: task.contentVerification, contextFinalizations: task.contextFinalizations,
    openDecisions: a.data.decisions.filter(d => d.status === 'open').length,
    actions: a.data.agentActions.filter(r => r.tool === 'lark_update'),
    counts: {model: audit.modelInputs.length, platform: audit.platformCalls.length,
      connector: audit.connectorCalls.length, revisions: audit.events.filter(e => e.kind === 'revision_generated').length,
      updates: audit.connectorCalls.filter(c => c.args[1] === '+update').length,
      reads: audit.connectorCalls.filter(c => c.args[1] === '+fetch').length},
    pauseInjected: audit.pauseInjected === true, legacyCounters: audit.legacyCounters, checks: audit.checks,
    violations: audit.violations,
    ...(config.scenario === 'context_authorization_repair' ? {contextRepair: require(config.fixture).contextRepairState(f)} : {}),
    ...(config.scenario === 'storage_method_recovery' ? {storageRecovery: require(config.fixture).state(f)} : {}),
    modules: moduleProof(config, workerModuleNames(config))};
}
async function createFixture({Assistant, options}, config) {
  const subscription = require(path.join(config.asar, 'desktop/subscription.cjs'));
  subscription.status = async () => ({available: false, loggedIn: false, message: 'controlled external fixture'});
  const fixture = require(config.fixture);
  if(config.phase>0)assert.ok(fs.existsSync(config.audit),'cold fixture audit missing; do not reseed');
  const f = await fixture.setup({Assistant, options, scenario: GENERIC_SCENARIOS[config.scenario]||config.scenario, reportFile: config.audit,
    restoreAudit: config.phase > 0});
  const {parentPort} = require('node:worker_threads');
  // Observation only. All business commands use the untouched EngineClient RPC.
  parentPort.on('message', message => {
    if (message.type !== 'packageProbe') return;
    try {
      assert.ok(['snapshot', 'complete', 'checkpoint'].includes(message.action));
      const complete = message.action === 'complete' ? fixture.assertComplete(f) : message.action === 'checkpoint' ? fixture.assertCheckpoint(f) : undefined;
      f.saveAudit();
      parentPort.postMessage({type: 'packageProbeResult', id: message.id, result: {snapshot: snapshot(f, config), complete}});
    } catch (error) { parentPort.postMessage({type: 'packageProbeResult', id: message.id, error: error.stack || error.message}); }
  });
  return f.a;
}
function assertUnaccepted(s) { assert.equal(s.autoAccept, false); assert.equal(s.acceptedAt, null); assert.equal(s.completedAt, null); }
function assertNegative(s) {
  assertUnaccepted(s); assert.notEqual(s.jobStatus, 'review'); assert.notEqual(s.taskStatus, 'completed'); assert.notEqual(s.taskStatus, 'review');
  assert.equal(s.counts.updates, 1); assert.equal(s.counts.revisions, 1); assert.deepEqual(s.violations, []);
  assert.ok(!s.checks.some(c => c.kind === 'goal' && c.passed));
}
function assertPause(s) {
  assertUnaccepted(s); assert.equal(s.paused, true); assert.equal(s.pauseInjected, true);
  assert.equal(s.counts.updates, 0); assert.equal(s.openDecisions, 0); assert.equal(s.activeTaskId, s.taskId);
  const episode = s.episodes[s.activeBasis];
  assert.equal(episode.pendingCheck.status, 'interrupted'); assert.ok(episode.pendingCheck.claimId);
  assert.equal(episode.cycles, s.legacyCounters.cycles); assert.equal(s.efficiency.attempts, 18);
}
function assertContinuationView(s) {
  assert.ok(s.continuation && s.continuation.episodes, 'missing complete continuation snapshot');
  for (const key of ['activeTaskId', 'activeBasis', 'episodes'])
    assert.deepEqual(s[key], s.continuation[key], 'inconsistent continuation snapshot: ' + key);
}
function assertPausedPreserved(previous, next) {
  assertPause(previous); assertPause(next);
  assertContinuationView(previous); assertContinuationView(next);
  // No business dispatch has been allowed yet. Preserve the whole state, not a
  // subset of counters or a new baseline chosen after the cold load.
  for (const key of ['continuation', 'efficiency', 'reads', 'contextFinalizations', 'legacyCounters'])
    assert.deepEqual(next[key], previous[key], 'paused restoration changed ' + key);
}
function assertRestored(previous, next) {
  for (const key of ['jobId', 'taskId', 'primary', 'paused', 'counts', 'ledger']) assert.deepEqual(next[key], previous[key], 'cold restart changed ' + key);
  if (previous.paused && !previous.storageRecovery) assertPausedPreserved(previous, next);
  if (previous.contextRepair) {
    const stable=c=>{const x=structuredClone(c);if(x.view)delete x.view.expectedRevision;return x;};
    if(previous.contextRepair.view)assert.ok(next.contextRepair.view?.expectedRevision>=previous.contextRepair.view.expectedRevision);
    assert.deepEqual(stable(next.contextRepair),stable(previous.contextRepair),'cold restart changed context repair facts');
  }
  if (previous.storageRecovery) assert.deepEqual(next.storageRecovery, previous.storageRecovery, 'cold restart changed storage recovery facts');
  assertUnaccepted(next);
  assert.notEqual(previous.modules.pid, next.modules.pid, 'restart must replace the Electron process, not just Assistant');
}
function assertContextRepairHistorical(s) {
  assertUnaccepted(s);assert.equal(s.jobStatus,'needs_input');assert.equal(s.counts.model,0);assert.equal(s.counts.updates,0);
  const c=s.contextRepair;assert.ok(c);assert.equal(c.lastError,'');assert.equal(c.view?.kind,'internal_context_authorization');
  const e=c.continuation.episodes[c.continuation.activeBasis],p=e.pendingCheck;
  assert.equal(p.status,'claimed');assert.equal(p.claimedByRunId,c.failedRun.id);assert.equal(p.artifactId,s.primary);
  assert.ok(p.interruption.at<c.failedRun.startedAt);assert.equal(c.failedRun.modelCalls,20);assert.equal(c.failedRun.modelCallsDetail.length,20);
  assert.ok(c.failedRun.modelCallsDetail.every(r=>r.status==='done'&&r.usageReported&&r.requestId));
  assert.ok(c.failedRun.modelCallsDetail.every(r=>r.at>=c.failedRun.startedAt&&r.at<=c.failedRun.finishedAt&&['inputTokens','outputTokens','estimatedUSD'].every(k=>Number.isFinite(r[k])&&r[k]>=0)),'whole failed run needs complete usage and timestamps');
  assert.equal(c.failedRun.steps.length,1);assert.equal(c.failedRun.steps[0].errorCode,'CONTEXT_INVALID_REQUEST');
  assert.equal(c.failedRun.steps[0].tool,'verify_content');assert.equal(c.failedRun.steps[0].result.decisionId,c.decision.id);
  assert.equal(c.decision.status,'open');assert.equal(c.decision.key,'access:external:verify_content');
}
function assertContextRepairCommitted(before,after) {
  assertUnaccepted(after);assert.equal(after.jobStatus,'ready');assert.deepEqual(after.counts,before.counts);
  assert.equal(after.runs,before.runs);
  const a=before.contextRepair,b=after.contextRepair;
  for(const key of ['primary','efficiency','reads','generationReads','ledger','policies','goal','contract','failedRun','modelCalls','artifacts','contextFinalizations'])assert.deepEqual(b[key],a[key],'UI repair changed '+key);
  const original=a.continuation.episodes[a.continuation.activeBasis],next=b.continuation.episodes[a.continuation.activeBasis];
  assert.deepEqual(next.pendingCheck,original.pendingCheck);
  const {checkRepairs,...unchanged}=next;assert.deepEqual(unchanged,original);
  const continuation=structuredClone(b.continuation);delete continuation.episodes[a.continuation.activeBasis].checkRepairs;assert.deepEqual(continuation,a.continuation,'UI repair changed another owner/episode');
  assert.equal(b.continuation.activeTaskId,a.continuation.activeTaskId);assert.equal(b.continuation.activeBasis,a.continuation.activeBasis);
  assert.equal(Object.keys(checkRepairs).length,1);assert.equal(checkRepairs[original.pendingCheck.generationAttemptId].status,'ready');
  assert.equal(b.decision.status,'superseded');assert.equal(b.decision.answer,undefined);assert.equal(b.view,null);
}
function assertResumedOriginal(previous, final) {
  assertPause(previous); assertUnaccepted(final);
  assertContinuationView(previous); assertContinuationView(final);
  for (const key of ['jobId', 'taskId', 'primary', 'activeTaskId', 'activeBasis'])
    assert.deepEqual(final[key], previous[key], 'resumed original identity changed ' + key);
  const original = previous.episodes[previous.activeBasis], restored = final.episodes[previous.activeBasis];
  assert.ok(restored?.pendingCheck, 'original episode/check receipt lost');
  for (const key of ['basis', 'taskId', 'intentBasis', 'cycles'])
    assert.deepEqual(restored[key], original[key], 'original episode changed ' + key);
  assert.ok(Number.isInteger(original.hops) && Number.isInteger(restored.hops) && restored.hops >= original.hops, 'original prerequisite hops reset');
  const prior = original.pendingCheck, pending = restored.pendingCheck;
  for (const key of ['claimId', 'generationAttemptId', 'ownerEpisodeId', 'taskId', 'artifactId', 'artifactHash', 'inputBasis', 'checkBasis', 'intentBasis'])
    assert.ok(prior[key], 'missing original pending identity: ' + key);
  // Only the claim lifecycle may advance. All generation/output/owner identity,
  // including any other receipt fields, is anchored to the pre-shutdown receipt.
  const mutable = new Set(['status', 'claimedByRunId', 'claimedAt', 'claimHistory', 'interruption', 'settledCheckId', 'settledAt']);
  const identity = p => Object.fromEntries(Object.entries(p).filter(([key]) => !mutable.has(key)));
  assert.deepEqual(identity(pending), identity(prior), 'original pending-check identity changed');
  assert.equal(pending.status, 'settled'); assert.ok(pending.settledCheckId && pending.settledAt, 'missing settled check receipt');
  const history = prior.claimHistory || [];
  assert.ok(Array.isArray(pending.claimHistory), 'original claim history lost');
  assert.deepEqual(pending.claimHistory.slice(0, history.length), history, 'original claim history prefix changed');
  assert.ok(prior.claimedByRunId && prior.claimedAt, 'missing pre-shutdown claim owner/time');
  assert.deepEqual(pending.claimHistory[history.length], {
    runId: prior.claimedByRunId, claimedAt: prior.claimedAt, interruption: prior.interruption || null,
  }, 'pre-shutdown claim/request proof not retained');
  assert.equal(final.counts.revisions, previous.counts.revisions, 'original draft regenerated');
  // work-efficiency.sync may reset consecutive attempts/phase on verified new
  // output. Those final diagnostics are not a cold/pause preservation boundary;
  // the caller still requires fixture.assertComplete on the actual full chain.
}
async function runChild(config) {
  assert.ok(process.versions.electron, 'Electron Node runtime required; no Node fallback');
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
  installIsolation(config);
  const report = {phase: config.phase, pid: process.pid, versions: process.versions, commands: [], status: 'failed'};
  let engine;
  try {
    assert.ok(!fs.existsSync(path.join(config.asar, 'scripts')) && !fs.existsSync(path.join(config.asar, 'tests')), 'package unexpectedly contains tests/scripts');
    report.packageVersion = read(path.join(config.asar, 'package.json')).version;
    const packagedFiles = tree(path.join(config.asar, 'desktop'), rel => /^native\/bin(?:\/|$)/.test(rel))
      .filter(row => row.type === 'file').map(row => 'desktop/' + row.path).sort();
    assert.deepEqual(packagedFiles, config.desktopInputs.map(row => row.path).sort(), 'package/source desktop path set mismatch');
    report.packageSourceMatch = [];
    for (const row of config.desktopInputs) {
      assert.equal(fileHash(path.join(config.asar, row.path)), row.sha256, 'package/source mismatch: ' + row.path);
      report.packageSourceMatch.push(row.path);
    }
    const {EngineClient} = require(path.join(config.asar, 'desktop/engine-client.cjs'));
    report.mainModules = moduleProof(config, ['engine-client.cjs']);
    const background = [];
    engine = new EngineClient({dir: config.workspace, fixtureModule: config.wrapper,
      workerOptions: {execArgv: ['--require', config.preload]},
      safeStorage: {isEncryptionAvailable: () => false},
      native: async action => { if (action === 'attentionAvailable') return {supported: false}; throw Error('Unexpected native UI operation: ' + action); }});
    engine.on('backgroundError', error => background.push(error));
    await engine.ready;
    let sequence = 0;
    const probe = (action = 'snapshot') => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { engine.worker.off('message', listener); reject(Error('Worker observation timeout')); }, 15000);
      const listener = message => { if (message.type !== 'packageProbeResult' || message.id !== id) return;
        clearTimeout(timer); engine.worker.off('message', listener); message.error ? reject(Error(message.error)) : resolve(message.result); };
      engine.worker.on('message', listener); engine.worker.postMessage({type: 'packageProbe', id, action});
    });
    const command = async (method, action, input = {id: report.initial.jobId}) => { report.commands.push({method, action, input}); return engine[method](action, input); };
    async function settled(before) {
      const until = Date.now() + 60000;
      while (Date.now() < until) {
        const {snapshot: s} = await probe();
        assert.deepEqual(s.violations, [], 'fixture transport contract failed');
        if (s.runs > before && !s.busy) return s;
        await sleep(50);
      }
      throw Error('Actual package Worker did not finish a new run: ' + JSON.stringify((await probe()).snapshot));
    }
    report.initial = (await probe()).snapshot;
    assert.ok(report.initial.modules.threadId > 0, 'fixture did not run in formal Worker');
    if(GENERIC_SCENARIOS[config.scenario]){
      // These fixture commands enter the packaged Agent via the formal Worker
      // RPC; only synthetic transport answers/old-state seed are external.
      const recovering=GENERIC_RECOVERIES.includes(config.scenario),scenario=recovering?'success':GENERIC_SCENARIOS[config.scenario],phase=config.phase-(recovering?1:0);
      const advance=async()=>{await command('dispatch','controlledRun',{});return (await probe()).snapshot;};
      if(config.phase>0)assertGenericRestored(read(config.previous).final,report.initial);
      if(phase===-1){report.final=report.initial;assertGenericRecoverySeed(report.final.generic);}
      else if(phase===0){report.final=await advance();assertGenericCheckpoint(report.final);}
      else{
        const previous=read(config.previous).final;
        if(phase===1){
          assertGenericCheckpoint(report.initial);report.final=report.initial;
          for(let n=0;n<6&&report.final.jobStatus!=='review';n++){
            report.final=await advance();
            if(scenario!=='success'&&report.final.generic.audit.writes)break;
          }
          assertGenericWritten(report.final);
          if(scenario==='uncertain'){assert.equal(report.final.generic.deliveries[0].status,'uncertain');assert.notEqual(report.final.jobStatus,'review');}
          else assertGenericComplete(report.final,{mismatch:scenario==='mismatch'});
        }else if(phase===2&&scenario!=='success'){
          report.final=report.initial;
          for(let n=0;n<(scenario==='uncertain'?6:1)&&report.final.jobStatus!=='review';n++)report.final=await advance();
          assert.equal(report.final.generic.deliveries[0].id,previous.generic.deliveries[0].id,'recovery replaced original external action');
          assertGenericComplete(report.final,{mismatch:scenario==='mismatch'});
          if(scenario==='uncertain')assert.ok(report.final.generic.audit.readbacks>previous.generic.audit.readbacks,'uncertain action did not reconcile through readback');
        }else{report.final=report.initial;assertGenericComplete(report.final);}
      }
      if(recovering&&phase>=0)assertGenericRecoveryProgress(report.final.generic);
      report.complete={layer:'controlled',productionDelivery:'not_verified',accepted:false,
        stage:phase===-1?'controlled_failed_recovery_start':phase===0?'partial_draft_cold_checkpoint':phase===1&&scenario==='uncertain'?'uncertain_action_checkpoint':scenario==='mismatch'?'mismatch_remains_blocked':'same_target_delivery_verified'};
    } else if (config.scenario === 'storage_method_recovery') {
      if (config.phase === 0) {
        assert.equal(report.initial.jobStatus, 'blocked');
        assert.equal(report.initial.storageRecovery.view?.route, 'evidence');
        assert.equal(report.initial.storageRecovery.view.eligible, true);
        assert.equal(report.initial.episodes[report.initial.activeBasis].cycles, 3);
        assert.deepEqual(report.initial.storageRecovery.methodAttempts, {});
        assert.equal(report.initial.counts.platform, 0); report.final = report.initial;
      } else {
        const previous = read(config.previous).final; assertRestored(previous, report.initial);
        if (config.phase === 1) {
          await command('control', 'resume'); report.final = await settled(report.initial.runs);
          report.checkpoint = (await probe('checkpoint')).complete;
        } else if (config.phase === 2) {
          await command('control', 'resume');
          assertStorageNoDispatch(report.initial, (await probe()).snapshot, 'paused recovery cannot dispatch');
          await command('dispatch', 'stewardshipResume'); await command('control', 'resume');
          report.final = await settled(report.initial.runs); report.complete = (await probe('complete')).complete;
        } else {
          await command('control', 'resume'); report.final = (await probe()).snapshot;
          assertStorageNoDispatch(report.initial, report.final, 'review cannot repeat method acquisition');
          report.complete = (await probe('complete')).complete;
        }
      }
    } else if (config.scenario === 'context_authorization_repair') {
      if(config.phase===0){assertContextRepairHistorical(report.initial);report.final=report.initial;}
      else {
        const previous=read(config.previous).final;assertRestored(previous,report.initial);
        if(config.phase===1){
          assertContextRepairHistorical(report.initial);
          const input={action:'agentCheckResume',input:{id:report.initial.jobId,...report.initial.contextRepair.view}};
          await command('dispatch','uiCommand',input);report.final=(await probe()).snapshot;
          assertContextRepairCommitted(report.initial,report.final);
          await command('dispatch','uiCommand',input);assert.deepEqual((await probe()).snapshot,report.final,'same UI command must replay idempotently');
        } else if(config.phase===2){
          await command('control','resume');report.final=await settled(report.initial.runs);
          report.complete=(await probe('complete')).complete;
        } else {report.final=report.initial;report.complete=(await probe('complete')).complete;}
      }
    } else if (config.phase === 0) {
      await command('control', 'resume'); // real runtime.resume -> core.tick -> agent.tick -> launch/run
      report.final = await settled(report.initial.runs);
      if (config.scenario === 'pause_during_check') assertPause(report.final);
      else if (config.scenario === 'uncertain') { assertNegative(report.final); assert.equal(report.final.actions.length, 1); assert.equal(report.final.actions[0].status, 'uncertain'); }
      else if (config.scenario === 'readback_mismatch') assertNegative(report.final);
      else report.complete = (await probe('complete')).complete;
    } else {
      const previous = read(config.previous).final;
      assertRestored(previous, report.initial);
      if (config.phase === 1 && config.scenario === 'pause_during_check') {
        await command('control', 'resume'); await sleep(75);
        const held = (await probe()).snapshot;
        assertRestored(previous, held);
        assert.equal(held.runs, report.initial.runs); assertPause(held);
        report.pausedRestart = held;
        await command('dispatch', 'stewardshipResume'); await command('control', 'resume');
        report.final = await settled(held.runs);
        assertResumedOriginal(previous, report.final);
        report.complete = (await probe('complete')).complete;
      } else if (config.phase === 1 && ['uncertain', 'readback_mismatch'].includes(config.scenario)) {
        let rejected = false;
        try { await command('dispatch', 'agentRun'); }
        catch (error) {
          if (config.scenario !== 'readback_mismatch') throw error;
          // Only a synchronous business guard rejection is a valid negative outcome.
          report.final = (await probe()).snapshot;
          if (report.final.busy || report.final.runs !== report.initial.runs) throw error;
          assert.deepEqual(report.final.counts, report.initial.counts, 'rejected retry still issued requests');
          report.retryGuard = error.message; rejected = true;
        }
        if (!rejected) report.final = await settled(report.initial.runs);
        assert.equal(report.final.actions.length, 1); assert.equal(report.final.actions[0].id, previous.actions[0].id);
        assert.equal(report.final.counts.updates, 1);
        if (config.scenario === 'uncertain') {
          assert.ok(report.final.counts.reads > previous.counts.reads); report.complete = (await probe('complete')).complete;
        } else assertNegative(report.final);
      } else { report.final = report.initial; report.complete = (await probe('complete')).complete; }
    }
    assertUnaccepted(report.final); assert.deepEqual(background, []);
    report.status = 'passed';
  } catch (error) { report.error = error.stack || error.message; }
  finally {
    if (engine) try { await engine.close(); } catch (error) { report.status = 'failed'; report.closeError = error.stack; }
    report.endedAt = new Date().toISOString(); write(config.result, report);
  }
  return report;
}
async function spawnPhase(binary, configFile, config) {
  const {spawn} = require('node:child_process');
  const stdout = path.join(config.dir, 'phase-' + config.phase + '.stdout.log'), stderr = path.join(config.dir, 'phase-' + config.phase + '.stderr.log');
  const out = fs.openSync(stdout, 'wx', 0o600), err = fs.openSync(stderr, 'wx', 0o600);
  try {
    return await new Promise(resolve => {
      const child = spawn(binary, [config.harness, '--child', configFile], {cwd: config.dir, env: childEnvironment(config.dir, configFile), stdio: ['ignore', out, err]});
      let timedOut = false, error;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 110000);
      child.on('error', e => { error = e.message; });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({pid: child.pid, code, signal, error, timedOut, stdout, stderr}); });
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
}
function parseArgs(argv) {
  const options = {scenario: 'pause_during_check'};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; assert.ok(['--app', '--output', '--scenario'].includes(key), 'unknown option: ' + key);
    assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), 'missing value: ' + key);
    assert.ok(!Object.hasOwn(options, key.slice(2)) || key === '--scenario' && i === argv.indexOf(key), 'duplicate option: ' + key);
    assert.equal(argv.indexOf(key), i, 'duplicate option: ' + key); options[key.slice(2)] = argv[i + 1];
  }
  assert.ok(path.isAbsolute(options.app || '') && options.app.endsWith('.app'), '--app must be an absolute .app path');
  assert.ok(path.isAbsolute(options.output || ''), '--output must be an absolute report path');
  assert.ok(SCENARIOS.includes(options.scenario), 'unsupported scenario'); return options;
}
async function run(options) {
  assert.ok(path.isAbsolute(options.app || '') && options.app.endsWith('.app'), 'absolute final .app required');
  assert.ok(path.isAbsolute(options.output || ''), 'absolute output report required');
  const source = fs.realpathSync(SOURCE), output = path.resolve(options.output);
  // Avoid overwriting an input/report and prevent writes into the tested .app,
  // including through a symlinked output parent. Existing ancestors are checked.
  let ancestor = path.dirname(output); while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actualParent = path.join(fs.realpathSync(ancestor), path.relative(ancestor, path.dirname(output)));
  const appRequested = path.resolve(options.app), app = fs.existsSync(appRequested) ? fs.realpathSync(appRequested) : appRequested;
  assert.ok(!inside(source, actualParent) && !inside(app, actualParent), 'report must be outside source and tested .app');
  assert.ok(!fs.existsSync(output), 'report already exists; use a new output path');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const report = {schema: VERSION, layer: 'controlled', scenario: options.scenario, status: 'unavailable', passed: false,
    productionDelivery: 'not_verified', userAccepted: false, startedAt: new Date().toISOString(),
    realBusinessCalls: 0, realNetworkCalls: 0, realModelCalls: 0, phases: [],
    limitations: ['Headless EngineClient/Worker RPC, no renderer/UI or production main entry',
      'Synthetic facts/model/connector/remote state; native outputs hashed, not executed',
      'JS transport and filesystem guards are test isolation, not an OS security sandbox',
      'Release source digest from environment is an external runner claim; local identity is computed separately']};
  let beforeSource, beforePackage, dir;
  try {
    assert.ok(SCENARIOS.includes(options.scenario));
    beforePackage = report.package = packageIdentity(app); beforeSource = report.source = sourceIdentity(source);
    report.runtime = executable(app);
    report.releaseRunnerBinding = {runId: process.env.SYSTEM_RELEASE_RUN_ID || null,
      sourceDigest: process.env.SYSTEM_RELEASE_SOURCE_DIGEST || null, packageDigest: process.env.SYSTEM_RELEASE_PACKAGE_DIGEST || null};
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'system-package-worker-'))); report.evidence = dir;
    const harness = path.join(dir, 'harness.cjs'), fixture = path.join(dir, 'root-fixture.cjs'), helper = path.join(dir, 'platform-fixture.cjs');
    const generic=!!GENERIC_SCENARIOS[options.scenario],physicalHelper=generic?path.join(dir,'physical-fixture.cjs'):null;
    const asar = path.join(app, 'Contents/Resources/app.asar'), desktop = path.join(asar, 'desktop');
    fs.copyFileSync(__filename, harness);
    fs.writeFileSync(helper, redirectRequires(fs.readFileSync(path.join(source, 'tests/helpers/platform-fixture.cjs'), 'utf8'), desktop));
    if(generic)fs.writeFileSync(physicalHelper,redirectRequires(fs.readFileSync(path.join(source,'tests/root-relation-physical-fixture.cjs'),'utf8'),desktop));
    const fixtureSource = generic?'scripts/generic-consumption-worker-fixture.cjs':options.scenario === 'storage_method_recovery' ? 'scripts/storage-method-worker-fixture.cjs' : 'scripts/root-delivery-fixture.cjs';
    fs.writeFileSync(fixture, adaptFixture(fs.readFileSync(path.join(source, fixtureSource), 'utf8'), desktop, helper,physicalHelper));
    const preload = path.join(dir, 'guard.cjs'), wrapper = path.join(dir, 'worker-fixture.cjs');
    fs.writeFileSync(preload, `const c=JSON.parse(require('node:fs').readFileSync(process.env.SYSTEM_PACKAGE_WORKER_CONFIG,'utf8'));require(${JSON.stringify(harness)}).installIsolation(c);\n`);
    fs.writeFileSync(wrapper, `const c=JSON.parse(require('node:fs').readFileSync(process.env.SYSTEM_PACKAGE_WORKER_CONFIG,'utf8'));exports.create=input=>require(${JSON.stringify(harness)}).createFixture(input,c);\n`);
    const workspace = path.join(dir, 'profile/workspace'); fs.mkdirSync(workspace, {recursive: true});
    report.fixture = {original: [fixtureSource, 'tests/helpers/platform-fixture.cjs',...(generic?['tests/root-relation-physical-fixture.cjs']:[])].map(p => ({path: p, sha256: fileHash(path.join(source, p))})),
      adaptation: ['literal relative requires redirected to selected ASAR desktop',
        'unmodified fixture.setup restoreAudit:true restores synthetic transport state; Assistant reloads workspace', 'read-only Worker observation messages'],
      generated: [harness, fixture, helper, preload, wrapper,...(physicalHelper?[physicalHelper]:[])].map(file => ({file, sha256: fileHash(file)}))};
    const desktopInputs = beforeSource.entries.filter(row => row.type === 'file' && row.path.startsWith('desktop/'));
    for (const name of REQUIRED) assert.ok(desktopInputs.some(row => row.path === 'desktop/' + name));
    report.status = 'failed';
    const phases = generic?(options.scenario==='generic_uncertain'||GENERIC_RECOVERIES.includes(options.scenario)?4:3):['context_authorization_repair','storage_method_recovery'].includes(options.scenario)?4:['pause_during_check', 'uncertain'].includes(options.scenario) ? 3 : 2;
    for (let phase = 0; phase < phases; phase++) {
      const config = {dir, asar, harness, fixture, helper, preload, wrapper, workspace, desktopInputs, scenario: options.scenario, phase,
        audit: path.join(dir, 'transport-audit.json'), previous: phase ? path.join(dir, `phase-${phase - 1}.json`) : null, result: path.join(dir, `phase-${phase}.json`)};
      const configFile = path.join(dir, `config-${phase}.json`); write(configFile, config);
      const execution = await spawnPhase(report.runtime.binary, configFile, config);
      const result = fs.existsSync(config.result) ? read(config.result) : null;
      report.phases.push({execution, result});
      assert.ok(execution.code === 0 && !execution.signal && !execution.error && !execution.timedOut,
        'Electron phase failed: ' + (result?.error || result?.closeError || execution.error || 'see retained logs; ASAR support is not assumed'));
      assert.equal(result?.status, 'passed', result?.error || 'Electron/ASAR child did not produce evidence; no source fallback');
      assert.equal(result.pid, execution.pid);
      assert.equal(fileHash(asar), beforePackage.asarSHA256, 'ASAR changed between process restarts');
    }
    const savedAudit = read(path.join(dir, 'transport-audit.json')),audit=generic?savedAudit.audit:savedAudit;
    if(options.scenario==='storage_method_recovery')assertStorageModuleProof(report.phases,asar,desktopInputs);
    if(generic){
      assertGenericModuleProof(report.phases,asar,desktopInputs,{recovery:GENERIC_RECOVERIES.includes(options.scenario)});
      assert.equal(audit.creates,1,'generic historical document must only be seeded once');
      assert.equal(new Set(report.phases.map(p=>p.result.pid)).size,phases,'each restoration must use a distinct Electron process');
      report.controlledCalls={model:report.phases.at(-1).result.final.modelCalls,modelCountScope:'packaged Agent cumulative callsUsed; includes planner calls',platform:audit.queries.length,connector:audit.creates+audit.writes+audit.readbacks,connectorCountScope:'document calls excluding synthetic identity checks'};
    }else{
      assert.equal(audit.events.filter(e => e.kind === 'baseline_ready').length, 1, 'fixture baseline must only be seeded once');
      assert.equal(audit.events.filter(e => e.kind === 'cold_worker_loaded').length, phases - 1, 'missing actual cold Worker restoration');
      report.controlledCalls = {model: audit.modelInputs.length, platform: audit.platformCalls.length, connector: audit.connectorCalls.length};
    }
    report.assertions = ['actual ASAR engine-client/worker/core/agent loaded', 'all source desktop files match package bytes',
      'same temporary workspace restored in new Electron process', 'fixture and package/source identities bound',
      'one same-target update; no duplicate write', 'user has not accepted',
      ['readback_mismatch','generic_mismatch'].includes(options.scenario) ? 'mismatched readback prevents review, including retry' : 'independent content/result/goal checks and same-target readback reach review'];
    if(generic)report.assertions.push('two distinct typed acquisition batches incorporated into the original primary lineage before any update',
      'partial draft with zero final checks survives a distinct-process cold restart',
      'actual ASAR consumption/check/policy/generation/relation/write modules attested without checkout fallback',
      'original cycles and cumulative $200 budget/$17 baseline spend retained');
    if(options.scenario==='generic_uncertain')report.assertions.push('response lost after apply; original action is read back after cold restart without second update');
    if(GENERIC_RECOVERIES.includes(options.scenario))report.assertions.push('controlled failed recovery start survives cold process before normal Agent scheduling',
      'actual correction/method/local recovery links source+ACL+operation+normal plan_task to two committed consumption receipts');
    if(options.scenario==='generic_preflight_recovery')report.assertions.push('one proven identity-only historical correction; original failed attempt/run retained; no fabricated SG history');
    if(options.scenario==='generic_v2_recovery')report.assertions.push('new platform-chunks-v2 method family, original operation/family/claim preserved; old v1 is not a substitute');
    if(options.scenario==='generic_local_recovery')report.assertions.push('real retained response source-save ENOSPC cold-restored; local action adds zero identity/platform/model/method calls');
    if (options.scenario === 'pause_during_check') report.assertions.push('pause during content check; no paused requests; original claim/counters/primary survive restart and resume');
    if (options.scenario === 'uncertain') report.assertions.push('response loss reconciles original action by read after cold restart');
    if (options.scenario === 'context_authorization_repair') report.assertions.push('historical claimed context failure with empty lastError and older interruption',
      'cold upgrade and committed UI repair survive distinct Electron processes', 'normal trusted uiCommand agentCheckResume supersedes false permission without authorizing',
      'first call original-content bounded conclusion reserved once; then specific gap/local revision and same-target delivery');
    if (options.scenario === 'storage_method_recovery') report.assertions.push('exact synthetic legacy size failure and exhausted three-cycle episode survive cold upgrade',
      'job method claim persisted before identity/data transport; one request across distinct cold processes',
      'oversized Coral response uses actual structural projection and lossless same-source archive',
      'normal deterministic acquisition associates fresh related facts before original-primary revision; old cycles/budget/ACL retained');
    report.status = 'passed'; report.passed = true;
  } catch (error) { report.error = error.stack || error.message; }
  finally {
    try {
      if (dir) {
        const blocked = fs.readdirSync(dir).filter(name => name.startsWith('denied-')).flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
        report.blockedExternalAttempts = blocked;
        if (blocked.length) { report.status = 'failed'; report.passed = false; report.isolationError = 'unexpected external/native/write attempt'; }
        for (const row of report.fixture?.generated || []) assert.equal(fileHash(row.file), row.sha256, 'external fixture/harness changed during run');
        report.evidenceFiles = tree(dir, rel => rel === 'profile' || rel.startsWith('profile/'));
        if (fs.existsSync(path.join(dir, 'profile/workspace'))) report.workspaceDigest = digest(tree(path.join(dir, 'profile/workspace')));
      }
      if (beforeSource) { report.afterSourceDigest = sourceIdentity(source).digest; assert.equal(report.afterSourceDigest, beforeSource.digest, 'source changed during run'); }
      if (beforePackage) { report.afterPackageDigest = packageIdentity(app).digest; assert.equal(report.afterPackageDigest, beforePackage.digest, 'ASAR/unpacked/native/bundle changed during run'); }
    } catch (error) { report.status = 'stale'; report.passed = false; report.identityError = error.stack; }
    report.endedAt = new Date().toISOString(); write(output, report);
  }
  return report;
}
module.exports = {VERSION, SCENARIOS, GENERIC_SCENARIOS, GENERIC_MODULES, GENERIC_RECOVERIES, RECOVERY_MODULES, SENTINEL, parseArgs, fileHash, tree, sourceIdentity, packageIdentity, readNodeFuses,
  redirectRequires, adaptFixture, childEnvironment, installIsolation, createFixture, snapshot, workerModuleNames, assertStorageModuleProof, assertStorageNoDispatch,
  genericSnapshot,assertGenericCheckpoint,assertGenericWritten,assertGenericComplete,assertGenericRestored,assertGenericModuleProof,assertGenericRecoverySeed,assertGenericRecoveryProgress,
  assertPause, assertNegative, assertRestored, assertPausedPreserved, assertResumedOriginal, assertContextRepairHistorical, assertContextRepairCommitted, run};
if (require.main === module) {
  (async () => {
    if (process.argv[2] === '--child') {
      const report = await runChild(read(process.argv[3])); process.exitCode = report.status === 'passed' ? 0 : 1;
    } else {
      const options = parseArgs(process.argv.slice(2)), report = await run(options);
      console.log(JSON.stringify({status: report.status, layer: report.layer, scenario: report.scenario, output: options.output, evidence: report.evidence, productionDelivery: report.productionDelivery}));
      process.exitCode = report.passed ? 0 : 1;
    }
  })().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
