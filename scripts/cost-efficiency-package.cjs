// Build only application code and production dependencies; never package workspace data.
const path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
(async()=>{
 cp.execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
 const {packager}=await import('@electron/packager');
 const bundles=await packager({dir:root,name:'行知助手',platform:'darwin',arch:'arm64',out:path.join(root,process.env.XINGZHI_PACKAGE_OUT||'release-v038'),overwrite:true,
  asar:{unpackDir:'desktop/native/bin',unpack:'**/{.**,**}/**/*.node'},icon:path.join(root,'desktop/assets/icon.icns'),appBundleId:'local.xingzhi.assistant',appCategoryType:'public.app-category.productivity',appVersion:pkg.version,
  ignore:[/^\/(?!(?:desktop|dist|node_modules)(?:\/|$)|package\.json$).+/,/(?:^|\/)\.DS_Store$/],
  osxSign:{identity:'-',identityValidation:false,preAutoEntitlements:false,preEmbedProvisioningProfile:false,continueOnError:false,optionsForFile:()=>({hardenedRuntime:false,entitlements:['com.apple.security.cs.allow-jit'],timestamp:'none'})}
 });console.log(JSON.stringify({version:pkg.version,bundles}));
})().catch(e=>{console.error(e);process.exitCode=1;});
