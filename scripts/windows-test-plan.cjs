'use strict';
const fs=require('node:fs'),path=require('node:path');
// These suites verify upstream's macOS signed bundle/private-history release
// workflow, not application features. Windows package verification lives in
// windows-package.cjs and launches the actual EXE with a fresh workspace.
const exclusions={
 'identity-scheduling-package-contract':'macOS .app release identity contract',
 'model-preflight-package-contract':'macOS .app release identity contract',
 'system-package-content':'macOS native payload allowlist',
 'system-package-worker':'macOS .app worker/release harness',
 'system-package-worker-generic':'macOS .app worker/release harness',
 'system-release-gate':'macOS formal release gate and private history',
 'release':'upstream macOS package aliases',
 'iteration-metrics':'upstream macOS release receipt metrics',
 'windows-capture-ui':'run separately, with exclusive desktop focus'
};
const files=fs.readdirSync(path.join(__dirname,'../tests')).filter(file=>file.endsWith('.test.cjs')&&!exclusions[file.replace(/\.test\.cjs$/,'')]).sort().map(file=>'tests/'+file);
module.exports=files;
module.exports.exclusions=exclusions;
