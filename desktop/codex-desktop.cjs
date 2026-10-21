'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Explorer does not inherit the extra PATH entries supplied to Codex shells.
// Discover the desktop app's published CLI binaries without reading its auth.
function candidates(localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) {
  if (!path.isAbsolute(localAppData)) return [];
  const root = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const versions = [];
  try {
    for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
      if (!entry.isDirectory() || !/^[a-f0-9]{8,64}$/i.test(entry.name)) continue;
      const file = path.join(root, entry.name, 'codex.exe');
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) versions.push({file, modified:stat.mtimeMs});
      } catch {}
    }
  } catch {}
  versions.sort((a,b) => b.modified-a.modified || a.file.localeCompare(b.file));
  return [path.join(root, 'codex.exe'), ...versions.map(entry => entry.file)];
}
module.exports = {candidates};
