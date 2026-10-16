// Refresh only first-party code in an already signed build; retain signed native dependencies.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),bundle=path.resolve(process.argv[2]),archive=path.join(bundle,'Contents/Resources/app.asar'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-code-bundle-'));
(async()=>{try{
 const stage=path.join(temp,'app');asar.extractAll(archive,stage);
 for(const name of ['desktop','dist'])fs.cpSync(path.join(root,name),path.join(stage,name),{recursive:true,filter:file=>!file.startsWith(path.join(root,'desktop/native/bin'))&&!file.endsWith('/.DS_Store')});
 fs.copyFileSync(path.join(root,'package.json'),path.join(stage,'package.json'));
 for(const name of ['selection-capture','image-ocr','pdf-ocr']){const rel='desktop/native/bin/'+name;fs.copyFileSync(archive+'.unpacked/'+rel,path.join(stage,rel));fs.chmodSync(path.join(stage,rel),0o755);}
 const next=path.join(temp,'app.asar');await asar.createPackageWithOptions(stage,next,{unpackDir:'desktop/native/bin',unpack:'**/{.**,**}/**/*.node'});
 fs.copyFileSync(next,archive);fs.cpSync(next+'.unpacked',archive+'.unpacked',{recursive:true});
 const plist=path.join(temp,'entitlements.plist');fs.writeFileSync(plist,'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
 cp.execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none','--entitlements',plist,bundle],{stdio:'inherit'});cp.execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});console.log('Bundle code refreshed and signature verified');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
