'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');
const policy=require('../scripts/package-content-policy.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('BIN-01: build selection excludes npm hidden locks without removing runtime files or licenses', async t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-metadata-'));
 t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 for (const name of ['desktop', 'dist', 'node_modules/prod/node_modules/nested']) fs.mkdirSync(path.join(root, name), {recursive: true});
 const files = {
  'package.json': JSON.stringify({name: 'fixture', version: '1.0.0', dependencies: {prod: '1.0.0'}}),
  'node_modules/prod/package.json': JSON.stringify({name: 'prod', version: '1.0.0', dependencies: {nested: '1.0.0'}}),
  'node_modules/prod/node_modules/nested/package.json': JSON.stringify({name: 'nested', version: '1.0.0'}),
  'node_modules/.package-lock.json': '{"resolved":"https://private.example.invalid/dependency"}',
  'node_modules/prod/node_modules/.package-lock.json': '{"resolved":"https://private.example.invalid/nested"}',
  'node_modules/prod/index.js': 'module.exports = 1;',
  'node_modules/prod/LICENSE': 'License text',
  'node_modules/prod/node_modules/nested/index.js': 'module.exports = 2;',
  'node_modules/prod/.package-lock.json.txt': 'not an npm hidden lock',
  'desktop/core.cjs': 'runtime',
  'dist/app.js': 'renderer'
 };
 for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
 const expected = await policy.expectedFiles(root);
 const excluded = ['node_modules/.package-lock.json', 'node_modules/prod/node_modules/.package-lock.json'];
 assert.deepEqual([...expected.keys()].sort(), Object.keys(files).filter(name => !excluded.includes(name)).sort());
 for (const name of Object.keys(files).filter(name => name !== 'package.json' && !excluded.includes(name))) assert.equal(expected.get(name).sha256, sha(files[name]));
});
test('BIN-01: archive verification rejects reintroduced dependency installer metadata', async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-metadata-archive-'));
 t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
 const root = path.join(dir, 'source');
 fs.mkdirSync(path.join(root, 'node_modules'), {recursive: true});
 fs.mkdirSync(path.join(root, 'desktop'));
 fs.writeFileSync(path.join(root, 'desktop/core.cjs'), 'runtime');
 fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), '{"privateInstallerMetadata":true}');
 const archive = path.join(dir, 'app.asar');
 await asar.createPackage(root, archive);
 assert.throws(() => policy.verifyArchive(asar, archive, new Map([['desktop/core.cjs', {sha256: sha('runtime')}]])), /Complete package file set/);
});
test('RG-03: complete ASAR correspondence rejects changed dependencies and extra executable files',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'package-content-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const expected=new Map([['desktop/core.cjs',{sha256:sha('core')}],['dist/app.js',{sha256:sha('renderer')}],['node_modules/runtime/index.js',{sha256:sha('dependency')}] ]);
 for(const kind of ['valid','dependency','extra']){const root=path.join(dir,kind);fs.mkdirSync(root);for(const [name,bytes] of [['desktop/core.cjs','core'],['dist/app.js','renderer'],['node_modules/runtime/index.js',kind==='dependency'?'different':'dependency']]){fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),bytes);}if(kind==='extra')fs.writeFileSync(path.join(root,'desktop/extra.cjs'),'unexpected execution');const archive=root+'.asar';await asar.createPackage(root,archive);if(kind==='valid')assert.equal(policy.verifyArchive(asar,archive,expected).length,3);else assert.throws(()=>policy.verifyArchive(asar,archive,expected),kind==='extra'?/Complete package file set/:/Package content differs/);}
});
test('RG-03: expected dependency mapping follows production pruning and sanitizes package metadata',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'package-input-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['desktop','dist','node_modules/prod','node_modules/dev'])fs.mkdirSync(path.join(root,name),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{prod:'1.0.0'},devDependencies:{dev:'1.0.0'},scripts:{test:'private'}}));
 for(const name of ['prod','dev']){fs.writeFileSync(path.join(root,'node_modules',name,'package.json'),JSON.stringify({name,version:'1.0.0'}));fs.writeFileSync(path.join(root,'node_modules',name,'index.js'),name);}
 fs.writeFileSync(path.join(root,'desktop/core.cjs'),'core');fs.writeFileSync(path.join(root,'dist/app.js'),'app');fs.writeFileSync(path.join(root,'desktop/.DS_Store'),'junk');
 const files=await policy.expectedFiles(root);assert.ok(files.has('node_modules/prod/index.js'));assert.ok(![...files.keys()].some(n=>n.startsWith('node_modules/dev/')||n.endsWith('.DS_Store')));assert.equal(files.get('node_modules/prod/index.js').sha256,sha('prod'));assert.equal(files.get('package.json').sha256,sha(JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{prod:'1.0.0'}},null,2)+'\n'));
});
test('RG-03a: equal bytes cannot hide an unexpected ASAR symlink',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'package-link-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const root=path.join(dir,'source');fs.mkdirSync(path.join(root,'desktop'),{recursive:true});fs.writeFileSync(path.join(root,'desktop/b.cjs'),'same');fs.symlinkSync('b.cjs',path.join(root,'desktop/a.cjs'));const archive=path.join(dir,'app.asar');await asar.createPackage(root,archive);const expected=new Map(['a','b'].map(n=>['desktop/'+n+'.cjs',{sha256:sha('same')}]));assert.throws(()=>policy.verifyArchive(asar,archive,expected),/Unexpected package symlink/);
});
test('RG-03b: signed production native dependency preserves code and changed code is refused',t=>{
 const cp=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'package-native-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const source=path.resolve(__dirname,'../node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node'),original=sha(fs.readFileSync(source)),copy=path.join(dir,'signed.node'),bad=path.join(dir,'changed.node'),entitlements=path.join(dir,'entitlements.plist');fs.copyFileSync(source,copy);fs.writeFileSync(entitlements,'<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
 const sign=file=>cp.execFileSync('/usr/bin/codesign',['--sign','-','--force','--timestamp=none','--entitlements',entitlements,file],{stdio:'pipe'});sign(copy);assert.notEqual(sha(fs.readFileSync(copy)),original);policy.verifySignedNative(source,copy,dir,'valid');
 const bytes=fs.readFileSync(copy);let off=32,textOffset;for(let i=0;i<bytes.readUInt32LE(16);i++){if(bytes.readUInt32LE(off)===0x19){for(let n=0;n<bytes.readUInt32LE(off+64);n++){const sec=off+72+n*80;if(bytes.toString('utf8',sec,sec+16).replace(/\0/g,'')==='__text')textOffset=bytes.readUInt32LE(sec+48);}}off+=bytes.readUInt32LE(off+4);}assert.ok(textOffset>0);bytes[textOffset]^=1;fs.writeFileSync(bad,bytes);sign(bad);assert.throws(()=>policy.verifySignedNative(source,bad,dir,'changed'),/Native executable content differs/);assert.equal(sha(fs.readFileSync(source)),original);
});
