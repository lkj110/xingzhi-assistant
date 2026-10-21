const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {candidates} = require('../desktop/codex-desktop.cjs');

test('desktop CLI discovery tolerates missing installs and rejects relative roots', () => {
  assert.deepEqual(candidates('relative-path'), []);
  const missing = path.join(os.tmpdir(), 'missing-codex-' + require('node:crypto').randomUUID());
  assert.deepEqual(candidates(missing), [path.join(missing, 'OpenAI', 'Codex', 'bin', 'codex.exe')]);
});

test('desktop CLI discovery skips incomplete updates and prefers the newest executable', t => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), '行知 Codex '));
  t.after(() => fs.rmSync(local, {recursive:true, force:true}));
  const root = path.join(local, 'OpenAI', 'Codex', 'bin');
  function fixture(version, time, binary=true) {
    const dir = path.join(root, version);
    fs.mkdirSync(dir, {recursive:true});
    const file = path.join(dir, 'codex.exe');
    if (binary) { fs.writeFileSync(file, 'fixture'); fs.utimesSync(file, time, time); }
    return file;
  }
  const old = fixture('1111111111111111', 1000);
  const current = fixture('2222222222222222', 2000);
  fixture('3333333333333333', 3000, false);
  fixture('unrelated-directory', 4000);
  const shapedDirectory = fixture('4444444444444444', 5000, false);
  fs.mkdirSync(shapedDirectory);
  assert.deepEqual(candidates(local), [path.join(root, 'codex.exe'), current, old]);
});
