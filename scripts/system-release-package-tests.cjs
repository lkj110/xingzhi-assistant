'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
let report;
before(()=>{const app=process.env.SYSTEM_RELEASE_PACKAGE,out=process.env.SYSTEM_RELEASE_OUTPUT;assert.ok(app&&out,'final frozen package and output required');const file=path.join(out,'package-verification.json');assert.equal(fs.existsSync(file),false);const result=cp.spawnSync(process.execPath,[path.join(__dirname,'system-package-verify.cjs'),app,file],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:180000});if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);assert.ifError(result.error);assert.equal(result.status,0);report=JSON.parse(fs.readFileSync(file));assert.equal(report.passed,true);assert.equal(report.actualUserWorkspaceTouched,false);});
test('package-source-match',()=>{assert.ok(report.verifiedFiles>100);assert.equal(report.version,require('../package.json').version);assert.deepEqual(report.rendererErrors,[]);assert.equal(report.modelCalls,0);});
test('package-native',()=>{assert.deepEqual(report.nativeHelpers,['selection-capture','image-ocr','pdf-ocr']);});
test('package-signature',()=>{assert.equal(report.passed,true);assert.ok(report.archiveSha256.match(/^[a-f0-9]{64}$/));});
