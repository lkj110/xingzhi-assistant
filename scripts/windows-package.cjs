'use strict';
// Windows has its own reproducible, local verification. It does not
// satisfy or bypass the macOS private-history formal release gate.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function run(args){const r=cp.spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});if(r.error||r.status!==0)throw Error('Windows validation failed: '+args.join(' '));}
async function build(){
  assert.equal(process.platform,'win32','Windows packaging requires a Windows host');assert.equal(process.arch,'x64','This build targets Windows x64');
  const out=path.join(root,'release-windows',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(out,{recursive:true});
  require('./build-windows-native.cjs').build();run(['node_modules/vite/bin/vite.js','build']);
  run(['scripts/windows-tests.cjs']);
  return packageApplication(out);
}
async function packageApplication(out){
  assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');
  const pkg=require('../package.json');fs.mkdirSync(out,{recursive:true});
  const {createCanvas,loadImage}=require('@napi-rs/canvas'),canvas=createCanvas(256,256);canvas.getContext('2d').drawImage(await loadImage(path.join(root,'desktop/assets/icon.png')),0,0,256,256);
  const png=canvas.toBuffer('image/png'),ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
  const icon=path.join(root,'desktop/native/bin/windows.ico');fs.writeFileSync(icon,Buffer.concat([ico,png]));
  const {packager}=await import('@electron/packager');
  const [bundle]=await packager({dir:root,name:'XingzhiAssistant',executableName:'XingzhiAssistant',platform:'win32',arch:'x64',out:path.join(out,'app'),tmpdir:path.join(out,'tmp'),overwrite:false,icon,
    ...(process.env.ELECTRON_ZIP_DIR?{electronZipDir:process.env.ELECTRON_ZIP_DIR}:{}),electronVersion:pkg.devDependencies.electron,
    appVersion:pkg.version,buildVersion:pkg.version,appCopyright:'Copyright (c) lkj110 and contributors',
    win32metadata:{CompanyName:'Xingzhi Assistant',FileDescription:'行知助手 Windows',ProductName:'行知助手'},
    asar:{unpack:'**/*.{node,exe,dll,ps1}'},prune:true,
    ignore:[/^\/(?!(?:desktop|dist|node_modules)(?:\/|$)|package\.json$).+/,/\/desktop\/native\/.*\.(?:swift|cs)$/, /\/desktop\/native\/bin\/(?!windows-(?:capture|process)\.exe$).+/,/\.DS_Store$/]});
  return verifyBundle(bundle,out);
}
async function verifyBundle(bundle,out){
  const pkg=require('../package.json'),archive=path.join(bundle,'resources/app.asar'),asar=await import('@electron/asar'),manifest=[];
  for(const file of asar.listPackage(archive).map(s=>s.replace(/^[/\\]/,'').replace(/\\/g,'/'))){const entry=asar.statFile(archive,path.normalize(file));if(entry.files)continue;assert.ok(!entry.link,'Unexpected package symlink');
    if(file.startsWith('desktop/')||file.startsWith('dist/')){const source=fs.readFileSync(path.join(root,file)),packed=asar.extractFile(archive,path.normalize(file));assert.equal(sha(packed),sha(source),file);manifest.push({file,sha256:sha(source)});}}
  assert.ok(manifest.some(r=>r.file==='desktop/native/bin/windows-process.exe'));assert.ok(manifest.some(r=>r.file==='desktop/native/WindowsOCR.ps1'));assert.ok(manifest.some(r=>r.file==='desktop/native/bin/windows-capture.exe'));
  fs.copyFileSync(path.join(root,'LICENSE'),path.join(bundle,'XINGZHI-LICENSE.txt'));fs.copyFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(bundle,'THIRD_PARTY_NOTICES.md'));
  fs.copyFileSync(path.join(root,'docs/WINDOWS.md'),path.join(bundle,'Windows使用说明.md'));fs.copyFileSync(path.join(root,'docs/WINDOWS_PARITY.md'),path.join(bundle,'Windows功能验证.md'));
  fs.copyFileSync(path.join(root,'docs/WINDOWS_R4_STATUS.md'),path.join(bundle,'WINDOWS_R4_STATUS.md'));
  const smoke=await require('./windows-smoke.cjs').verify({executable:path.join(bundle,'XingzhiAssistant.exe'),out:path.join(out,'verification')});
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({version:pkg.version,platform:'win32',arch:'x64',releaseKind:'windows-port',portRevision:4,signature:'unsigned',upstream:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),files:manifest,smoke},null,2));
  console.log(JSON.stringify({passed:true,bundle,evidence:out}));return {bundle,out};
}
module.exports={build,packageApplication,verifyBundle};if(require.main===module)build().catch(error=>{console.error(error);process.exitCode=1;});
