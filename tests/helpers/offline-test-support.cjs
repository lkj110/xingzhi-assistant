'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const rows = value => Array.isArray(value) ? value : [];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => [k, canonical(value[k])])) : value;
const digest = value => sha(JSON.stringify(canonical(value)) ?? 'null');
const rawDigest = value => sha(JSON.stringify(value) ?? 'null');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
function fail(code) { return Object.assign(new Error(code), {code}); }
function inside(root, filename) { const rel = path.relative(root, path.resolve(filename)); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function manifest(root) {
  const result = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw fail('SNAPSHOT_NONREGULAR_ENTRY');
      if (stat.isDirectory()) walk(file);
      else result.push({path: path.relative(root, file).split(path.sep).join('/'), bytes: stat.size, sha256: sha(fs.readFileSync(file))});
    }
  }
  walk(root); return result;
}
function installIsolation(writeRoot, audit) {
  const undo = [], fds = new Set();
  function patch(object, key, fn) { const old = object[key]; object[key] = fn(old); undo.push(() => {object[key] = old;}); }
  const denied = category => () => { audit[category]++; throw fail('REPLAY_FORBIDDEN_' + category.toUpperCase()); };
  patch(globalThis, 'fetch', () => denied('networkAttempts'));
  for (const module of ['node:http','node:https']) for (const key of ['request','get']) patch(require(module), key, () => denied('networkAttempts'));
  patch(require('node:net').Socket.prototype, 'connect', () => denied('networkAttempts'));
  patch(require('node:dgram'), 'createSocket', () => denied('networkAttempts'));
  patch(require('node:tls'), 'connect', () => denied('networkAttempts'));
  for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) patch(require('node:child_process'), key, () => denied('subprocessAttempts'));
  patch(require('node:worker_threads'), 'Worker', () => denied('subprocessAttempts'));
  function writable(value) {
    if (typeof value === 'number') { if (fds.has(value)) return; }
    else {
      const filename = value instanceof URL ? require('node:url').fileURLToPath(value) : String(value);
      if (inside(writeRoot, filename)) return;
    }
    audit.outsideWriteAttempts++; throw fail('REPLAY_WRITE_OUTSIDE_COPY');
  }
  patch(fs, 'openSync', old => function(file, flags, ...args) {
    const write = typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : /[wa+]/.test(flags);
    if (write) writable(file); const fd = old.call(fs, file, flags, ...args); if (write) fds.add(fd); return fd;
  });
  patch(fs, 'closeSync', old => function(fd) { fds.delete(fd); return old.call(fs, fd); });
  for (const key of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','rmSync','rmdirSync','truncateSync','chmodSync','utimesSync','writeSync','ftruncateSync'])
    patch(fs, key, old => function(target, ...args) { writable(target); return old.call(fs, target, ...args); });
  for (const key of ['renameSync','linkSync']) patch(fs, key, old => function(from, to, ...args) { writable(from); writable(to); return old.call(fs, from, to, ...args); });
  for (const key of ['copyFileSync','cpSync']) patch(fs, key, old => function(from, to, ...args) { writable(to); return old.call(fs, from, to, ...args); });
  // This replay uses only synchronous storage. An unexpected async write must
  // fail closed rather than outlive the isolation lifetime.
  for (const key of ['writeFile','appendFile','mkdir','unlink','rm','rmdir','truncate','chmod','utimes','rename','copyFile','cp','link','symlink','open','write','createWriteStream'])
    if (typeof fs[key] === 'function') patch(fs, key, () => denied('outsideWriteAttempts'));
  for (const key of ['writeFile','appendFile','mkdir','unlink','rm','rmdir','truncate','chmod','utimes','rename','copyFile','cp','link','symlink','open'])
    if (typeof fs.promises[key] === 'function') patch(fs.promises, key, () => denied('outsideWriteAttempts'));
  patch(fs, 'symlinkSync', () => denied('outsideWriteAttempts'));
  return {denyModel:denied('modelAttempts'), denyTransport:denied('networkAttempts'), restore() { for (const fn of undo.reverse()) fn(); }};
}
module.exports={rows,sha,canonical,digest,rawDigest,json,fail,inside,manifest,installIsolation};
