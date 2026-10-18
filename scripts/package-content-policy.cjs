'use strict';
// Shared build selection; verification additionally proves the complete path
// set and bytes against the frozen source/dependency tree.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process'),{pathToFileURL}=require('node:url');
const ignore=[/^\/(?!(?:desktop|dist|node_modules)(?:\/|$)|package\.json$).+/,/(?:^|\/)\.DS_Store$/];
const helpers=['selection-capture','image-ocr','pdf-ocr'].map(n=>'desktop/native/bin/'+n);
const nativeDependencies=['node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node'];
const nativeFiles=[...helpers,...nativeDependencies];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function expectedFiles(root){
 const base=path.dirname(require.resolve('@electron/packager'));
 const {userPathFilter,populateIgnoredPaths}=await import(pathToFileURL(path.join(base,'copy-filter.js')));
 const {defaultSanitizePackageJson}=await import(pathToFileURL(path.join(base,'sanitize-package-json.js')));
 const opts={dir:root,out:path.join(root,'release-share/app'),prune:true,quiet:true,ignore};Object.assign(opts,populateIgnoredPaths(opts));
 const filter=userPathFilter(opts),files=new Map(),roots=[fs.realpathSync(root),fs.realpathSync(path.join(root,'node_modules'))];
 async function walk(rel){const file=path.join(root,rel);if(!await filter(file))return;const real=fs.realpathSync(file);assert.ok(roots.some(r=>real===r||real.startsWith(r+path.sep)),'Package source escaped frozen roots: '+rel);const stat=fs.statSync(file);
  if(stat.isDirectory()){for(const n of fs.readdirSync(file).sort())await walk(path.posix.join(rel,n));}
  else if(stat.isFile()){const bytes=rel==='package.json'?Buffer.from(JSON.stringify(defaultSanitizePackageJson(JSON.parse(fs.readFileSync(file,'utf8'))),null,2)+'\n'):fs.readFileSync(file);if(nativeFiles.includes(rel))assert.equal(bytes.readUInt32LE(0),0xfeedfacf,'Expected a thin Mach-O executable: '+rel);files.set(rel,{sha256:sha(bytes),native:nativeFiles.includes(rel)});}
  else throw Error('Unsupported package source entry: '+rel);
 }
 for(const name of ['desktop','dist','node_modules','package.json'])await walk(name);return files;
}
function verifyArchive(asar,archive,expected){
 const actual=asar.listPackage(archive).map(n=>n.replace(/^\//,'')).filter(n=>{const s=asar.statFile(archive,n,false);assert.ok(!s.link,'Unexpected package symlink: '+n);return !s.files;}).sort();
 assert.deepEqual(actual,[...expected.keys()].sort(),'Complete package file set differs from build selection');
 const manifest=[];for(const name of actual){const row=expected.get(name);if(!row.native)assert.equal(sha(asar.extractFile(archive,name)),row.sha256,'Package content differs from frozen source: '+name);manifest.push({file:name,sha256:row.sha256,transform:row.native?'native-signature-only':'identity'});}
 return manifest;
}
function unsignedHash(file,scratch,name){
 const copy=path.join(scratch,name);fs.copyFileSync(file,copy);cp.execFileSync('/usr/bin/codesign',['--remove-signature',copy],{stdio:'pipe'});const bytes=fs.readFileSync(copy);assert.equal(bytes.readUInt32LE(0),0xfeedfacf);let offset=32,found=0;
 for(let i=0;i<bytes.readUInt32LE(16);i++){const command=bytes.readUInt32LE(offset),size=bytes.readUInt32LE(offset+4);assert.ok(size>=8&&offset+size<=bytes.length);if(command===0x19&&bytes.toString('utf8',offset+8,offset+24).replace(/\0/g,'')==='__LINKEDIT'){bytes.fill(0,offset+32,offset+40);found++;}offset+=size;}assert.equal(found,1);return sha(bytes);
}
function verifySignedNative(source,packed,scratch,name){
 cp.execFileSync('/usr/bin/codesign',['--verify','--strict',packed],{stdio:'pipe'});
 assert.equal(unsignedHash(source,scratch,'source-'+name),unsignedHash(packed,scratch,'packed-'+name),'Native executable content differs: '+name);
}
module.exports={ignore,helpers,nativeDependencies,nativeFiles,expectedFiles,verifyArchive,unsignedHash,verifySignedNative};
