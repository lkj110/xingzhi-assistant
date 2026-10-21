'use strict';
const fs = require('node:fs');
// Windows/Node cannot flush directory handles (FlushFileBuffers returns EPERM).
// Callers still fsync the file before atomic rename. Do not swallow file I/O
// failures; directory metadata durability across power loss is OS-dependent.
function syncDirectory(directory) {
  if (process.platform === 'win32') {
    if (!fs.statSync(directory).isDirectory()) throw Error('Expected an existing directory');
    return;
  }
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
module.exports = {syncDirectory};
