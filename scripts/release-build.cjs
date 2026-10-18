#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const gate=require('./system-release-gate.cjs');
function admission(env=process.env, parentPid=process.ppid) {
  if (!env.SYSTEM_RELEASE_GATE || env.SYSTEM_RELEASE_GROUP !== 'build' || !env.SYSTEM_RELEASE_RUN_ID) throw Error('BUILD_CONTEXT_REQUIRED: use release.cjs build --gate <frozen-gate>');
  const dir=fs.realpathSync(env.SYSTEM_RELEASE_GATE),f=gate.loadFreeze(dir),claim=gate.unseal(dir,path.join(dir,'.running'));
  if (claim.group!=='build'||claim.runId!==env.SYSTEM_RELEASE_RUN_ID||claim.parentPid!==parentPid||claim.freezeDigest!==f.freezeDigest||claim.sourceDigest!==f.sourceDigest||env.SYSTEM_RELEASE_SOURCE_DIGEST!==f.sourceDigest) throw Error('BUILD_CONTEXT_MISMATCH');
  if(fs.realpathSync(path.resolve(__dirname,'..'))!==f.source)throw Error('BUILD_SOURCE_MISMATCH');
  gate.assertEngineeringAdmission(f);
  gate.assertSource(f);
  const bundle=path.resolve(f.source,f.plan.build.output);
  if(claim.bundle!==bundle||env.SYSTEM_RELEASE_PACKAGE!==bundle||fs.existsSync(bundle))throw Error('BUILD_OUTPUT_MISMATCH: new declared output required');
  if(!bundle.endsWith('/行知助手-darwin-arm64/行知助手.app'))throw Error('BUILD_LAYOUT_UNSUPPORTED');
  return {dir,f,bundle};
}
async function build() {
  const {f,bundle}=admission();
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('PLATFORM_UNSUPPORTED: this candidate targets macOS arm64');
  cp.execFileSync('npm',['run','build'],{cwd:f.source,stdio:'inherit'});
  const pkg=JSON.parse(fs.readFileSync(path.join(f.source,'package.json'),'utf8'));
  const {packager}=await import('@electron/packager');
  const [produced]=await packager({dir:f.source,name:'行知助手',platform:'darwin',arch:'arm64',out:path.dirname(path.dirname(bundle)),overwrite:false,
    asar:{unpackDir:'desktop/native/bin',unpack:'**/{.**,**}/**/*.node'},icon:path.join(f.source,'desktop/assets/icon.icns'),
    appBundleId:'local.xingzhi.assistant',appCategoryType:'public.app-category.productivity',appVersion:pkg.version,buildVersion:pkg.version,
    ignore:require('./package-content-policy.cjs').ignore,
    osxSign:{identity:'-',identityValidation:false,preAutoEntitlements:false,preEmbedProvisioningProfile:false,continueOnError:false,
      optionsForFile:()=>({hardenedRuntime:false,entitlements:['com.apple.security.cs.allow-jit'],timestamp:'none'})}});
  if(path.resolve(produced,'行知助手.app')!==bundle)throw Error('BUILD_OUTPUT_MISMATCH: packager produced a different target');
  cp.execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
  return {candidate:bundle,version:pkg.version,distributionReady:false,productionDelivery:'not_verified'};
}
module.exports={admission,build};
if(require.main===module)build().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
