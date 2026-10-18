// Verify the built bundle in a disposable profile, never the installed workspace.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const asar=require('@electron/asar'),{_electron:electron}=require('playwright'),{expect}=require('playwright/test');
const root=path.resolve(__dirname,'..'),bundle=path.resolve(process.argv[2]);
const archive=path.join(bundle,'Contents/Resources/app.asar'),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-system-package-')));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),errors=[];let app;
(async()=>{try{
 cp.execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
 const entries=asar.listPackage(archive),tops=[...new Set(entries.map(e=>e.split('/')[1]))].sort();assert.deepEqual(tops,['desktop','dist','node_modules','package.json']);
 assert.deepEqual(entries.filter(e=>/(^|\/)(workspace\.json|auth\.json|\.env[^/]*|\.codex|backups|capture-payloads|artifacts)(\/|$)/.test(e)),[]);
 const helpers=['selection-capture','image-ocr','pdf-ocr'];
 const content=require('./package-content-policy.cjs'),manifest=content.verifyArchive(asar,archive,await content.expectedFiles(root));
 const pkg=require('../package.json'),packed=JSON.parse(asar.extractFile(archive,'package.json'));
 for(const key of ['name','version','main','dependencies'])assert.deepEqual(packed[key],pkg[key]);
 for(const helper of helpers){const file='desktop/native/bin/'+helper;assert.equal(asar.statFile(archive,file).unpacked,true);assert.ok(fs.statSync(archive+'.unpacked/'+file).mode&0o111);cp.execFileSync('/usr/bin/codesign',['--verify','--strict',archive+'.unpacked/'+file]);}
 for(const file of content.nativeFiles){assert.equal(asar.statFile(archive,file,false).unpacked,true);content.verifySignedNative(path.join(root,file),archive+'.unpacked/'+file,dir,path.basename(file));}
 const profile=path.join(dir,'profile');
 app=await electron.launch({executablePath:path.join(bundle,'Contents/MacOS/行知助手'),args:['--user-data-dir='+profile],timeout:30000});
 assert.deepEqual(await app.evaluate(({app})=>({path:app.getPath('userData'),version:app.getVersion(),packaged:app.isPackaged})),{path:profile,version:pkg.version,packaged:true});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'暂时跳过',exact:true}).click();
 const call=(action,input={})=>page.evaluate(async({action,input})=>{const result=await window.assistant.call(action,input);if(result.error)throw Error(result.error);return result.data;},{action,input});
 const initial=await call('state');assert.equal(initial.storagePath,path.join(profile,'workspace'));
 for(const key of ['tasks','delegations','sources','providers','folders','connectors'])assert.equal(initial[key].length,0,key);
 await call('import',{items:[{title:'安装包独立验证',content:'仅保存在临时测试目录，不推进实际事项。'}]});
 let state=await call('state');assert.equal(state.sources[0].content,'仅保存在临时测试目录，不推进实际事项。');assert.equal((state.modelCalls||[]).length,0);
 await page.reload();state=await call('state');assert.equal(state.sources.length,1);assert.deepEqual(errors,[]);
 const report={passed:true,version:pkg.version,bundle,archiveSha256:sha(fs.readFileSync(archive)),verifiedFiles:manifest.length,manifest,nativeHelpers:helpers,rendererErrors:errors,modelCalls:0,actualUserWorkspaceTouched:false,at:new Date().toISOString()};
 fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,manifest:undefined}));
}finally{await app?.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
