'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateOutput}=require('./output.cjs');
test('output cannot write outside dedicated new-run tree, including frozen tree children',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marker-output-')),base=path.join(dir,'runs'),frozen=path.join(dir,'frozen');fs.mkdirSync(frozen);
 for(const dest of [path.join(frozen,'new-run'),path.join(dir,'elsewhere'),base,path.join(base,'..','frozen','new-run')])assert.throws(()=>validateOutput(dest,base));
 assert.deepEqual(fs.readdirSync(frozen),[]);assert.ok(!fs.existsSync(base));assert.equal(validateOutput(path.join(base,'one'),base),path.join(fs.realpathSync.native(dir),'runs','one'));
});
test('output root junction cannot redirect into frozen tree',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marker-output-link-')),frozen=path.join(dir,'frozen'),base=path.join(dir,'runs');fs.mkdirSync(frozen);fs.symlinkSync(frozen,base,'junction');
 assert.throws(()=>validateOutput(path.join(base,'new-run'),base));assert.deepEqual(fs.readdirSync(frozen),[]);
});
