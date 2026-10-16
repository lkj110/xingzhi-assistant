// Build a clean macOS bundle and portable archives without workspace data.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
const release=path.join(root,'release-share'),out=path.join(release,`v${pkg.version}`),artifacts=path.join(root,'artifacts/share');
const run=(file,args,options={})=>cp.execFileSync(file,args,{cwd:root,stdio:'inherit',...options});
(async()=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('This release script targets Apple Silicon macOS.');
 fs.mkdirSync(out,{recursive:true});fs.mkdirSync(artifacts,{recursive:true});
 const name=`Xingzhi-${pkg.version}-macOS-arm64`,dmg=path.join(out,name+'.dmg'),zip=path.join(out,name+'.zip');
 if(fs.existsSync(dmg)||fs.existsSync(zip))throw Error('Release files already exist. Move them aside before rebuilding.');
 let bundleDir=path.join(release,'app','行知助手-darwin-arm64');
 if(!process.argv.includes('--archives-only')){
 run('npm',['run','build']);
 const {packager}=await import('@electron/packager');
 [bundleDir]=await packager({dir:root,name:'行知助手',platform:'darwin',arch:'arm64',out:path.join(release,'app'),overwrite:true,
  asar:{unpackDir:'desktop/native/bin',unpack:'**/{.**,**}/**/*.node'},icon:path.join(root,'desktop/assets/icon.icns'),
  appBundleId:'local.xingzhi.assistant',appCategoryType:'public.app-category.productivity',appVersion:pkg.version,
  ignore:[/^\/(?!(?:desktop|dist|node_modules)(?:\/|$)|package\.json$|LICENSE$|THIRD_PARTY_NOTICES\.md$).+/,/(?:^|\/)\.DS_Store$/],
  osxSign:{identity:'-',identityValidation:false,preAutoEntitlements:false,preEmbedProvisioningProfile:false,continueOnError:false,
   optionsForFile:()=>({hardenedRuntime:false,entitlements:['com.apple.security.cs.allow-jit'],timestamp:'none'})}
 });
 }
 const app=path.join(bundleDir,'行知助手.app');
 run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
 const staging=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-share-'));
 try{
  run('/usr/bin/ditto',['--norsrc','--noextattr',app,path.join(staging,'行知助手.app')]);
  fs.symlinkSync('/Applications',path.join(staging,'Applications'));
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']){fs.copyFileSync(path.join(root,name),path.join(staging,name));fs.copyFileSync(path.join(root,name),path.join(out,name));}
  fs.copyFileSync(path.join(root,'docs/SHARING.md'),path.join(staging,'开始使用.md'));
  fs.copyFileSync(path.join(root,'docs/SHARING.md'),path.join(out,'开始使用.md'));
  fs.copyFileSync(path.join(root,'docs/USER_GUIDE.md'),path.join(staging,'完整使用说明.md'));
  fs.copyFileSync(path.join(root,'docs/USER_GUIDE.md'),path.join(out,'完整使用说明.md'));
  fs.writeFileSync(path.join(staging,'开始使用.txt'),fs.readFileSync(path.join(root,'docs/SHARING.md'),'utf8'));
  if(!process.argv.includes('--zip-only'))run('/usr/bin/hdiutil',['create','-volname',`行知助手 ${pkg.version}`,'-srcfolder',staging,'-fs','HFS+','-format','UDZO','-ov',dmg]);
  // ZIP keeps macOS bundle permissions and symlinks; docs accompany the app.
  fs.unlinkSync(path.join(staging,'Applications'));
  run('/usr/bin/ditto',['-c','-k','--norsrc','--noextattr',staging,zip]);
 }finally{fs.rmSync(staging,{recursive:true,force:true});}
 const files=(process.argv.includes('--zip-only')?[zip]:[dmg,zip]).map(file=>({name:path.basename(file),bytes:fs.statSync(file).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
 fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),files.map(f=>`${f.sha256}  ${f.name}`).join('\n')+'\n');
 const report={version:pkg.version,platform:'darwin',arch:'arm64',minimumMacOS:'13.0',app,files,signing:'ad-hoc',developerId:false,notarized:false,at:new Date().toISOString()};
 fs.writeFileSync(path.join(artifacts,'build.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
