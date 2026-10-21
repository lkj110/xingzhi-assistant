'use strict';
const path = require('node:path');
function nativePath(name, directory = __dirname) {
  return path.join(directory, 'native', name).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
function powershell() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function ocrCommand(mode, pages = [], pageCount = 0) {
  return {file: powershell(), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', nativePath('WindowsOCR.ps1'), '-Mode', mode, '-Pages', pages.join(','), '-PageCount', String(pageCount)]};
}
module.exports = {nativePath, powershell, ocrCommand};
