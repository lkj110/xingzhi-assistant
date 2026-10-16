// Verify the archives and launch the actual packaged app in a fresh isolated profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {_electron:electron,expect}=require('playwright/test'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/share'),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-share-verify-')));
const version=require('../package.json').version;
const release=path.join(root,'release-share',`v${version}`),zip=path.join(release,`Xingzhi-${version}-macOS-arm64.zip`),dmg=path.join(release,`Xingzhi-${version}-macOS-arm64.dmg`);
const run=(file,args)=>cp.execFileSync(file,args,{cwd:root,encoding:'utf8',timeout:60000,stdio:['pipe','pipe','pipe']});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');let app,mount;const checks=[],errors=[];
(async()=>{try{
 const build=JSON.parse(fs.readFileSync(path.join(out,'build.json'),'utf8'));assert.equal(build.version,version,'Share manifest must match the version being verified');
 for(const item of build.files)assert.equal(sha(fs.readFileSync(path.join(release,item.name))),item.sha256);
 checks.push('DMG与ZIP的SHA-256和生成记录一致');
 run('/usr/bin/hdiutil',['verify',dmg]);
 const plist=run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-plist',dmg]);
 const info=JSON.parse(cp.execFileSync('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{input:plist,encoding:'utf8'}));
 mount=info['system-entities'].find(e=>e['mount-point'])?.['mount-point'];assert.ok(mount);
 assert.ok(fs.existsSync(path.join(mount,'行知助手.app')));assert.equal(fs.readlinkSync(path.join(mount,'Applications')),'/Applications');assert.ok(fs.existsSync(path.join(mount,'开始使用.txt')));
 run('/usr/bin/codesign',['--verify','--deep','--strict',path.join(mount,'行知助手.app')]);
 checks.push('DMG校验、实际只读挂载、应用签名和Applications安装入口通过');
 const unpacked=path.join(dir,'unpacked');run('/usr/bin/ditto',['-x','-k',zip,unpacked]);
 const bundle=path.join(unpacked,'行知助手.app'),archive=path.join(bundle,'Contents/Resources/app.asar');
 run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
 assert.equal(sha(fs.readFileSync(archive)),sha(fs.readFileSync(path.join(mount,'行知助手.app/Contents/Resources/app.asar'))));
 checks.push('ZIP实际解压保持签名、执行权限及符号链接，应用ASAR与DMG一致');
 const entries=asar.listPackage(archive),tops=[...new Set(entries.map(e=>e.split('/')[1]))].sort();assert.deepEqual(tops,['LICENSE','THIRD_PARTY_NOTICES.md','desktop','dist','node_modules','package.json']);
 for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']){assert.equal(sha(asar.extractFile(archive,name)),sha(fs.readFileSync(path.join(root,name))));assert.equal(sha(fs.readFileSync(path.join(unpacked,name))),sha(fs.readFileSync(path.join(root,name))));}assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).license,'MIT');
 const publicDependencyTests=entries.filter(e=>e.startsWith('/node_modules/zod/')&&/(^|\/)tests(\/|$)/.test(e));const allowedDependencyTests=new Set(publicDependencyTests);
 const bad=entries.filter(e=>/(^|\/)(workspace\.json|auth\.json|\.env[^/]*|\.codex|backups|capture-payloads|artifacts)(\/|$)/.test(e)||/(^|\/)tests(\/|$)/.test(e)&&!allowedDependencyTests.has(e));assert.deepEqual(bad,[]);
 const runtimeFiles=[];function collect(relative){for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){const file=path.posix.join(relative,entry.name);if(entry.isDirectory())collect(file);else if(entry.isFile()&&entry.name!=='.DS_Store'&&!/^desktop\/native\/bin\/(selection-capture|image-ocr|pdf-ocr)$/.test(file))runtimeFiles.push(file);}}collect('desktop');collect('dist');
 let verifiedFiles=0;for(const file of runtimeFiles){assert.equal(sha(asar.extractFile(archive,file)),sha(fs.readFileSync(path.join(root,file))),file);verifiedFiles++;}
 checks.push(`包内仅运行目录和元数据，无工作空间、凭据、本仓库或未知测试目录；含 ${publicDependencyTests.length} 项 Zod 公共依赖自带测试；${verifiedFiles} 个非签名变动文件与当前源码一致`);
 // Re-signing alters LC_CODE_SIGNATURE and __LINKEDIT's reserved mapping size.
 // Compare complete temporary unsigned binaries after normalizing only that size;
 // executable instructions, data, all other load commands and metadata still match.
 const nativeHelpers=['selection-capture','image-ocr','pdf-ocr'];
 function unsignedHash(file,name){const copy=path.join(dir,name);fs.copyFileSync(file,copy);run('/usr/bin/codesign',['--remove-signature',copy]);const bytes=fs.readFileSync(copy);assert.equal(bytes.readUInt32LE(0),0xfeedfacf,'Expected native 64-bit Mach-O');let offset=32,found=0;for(let i=0;i<bytes.readUInt32LE(16);i++){const command=bytes.readUInt32LE(offset),size=bytes.readUInt32LE(offset+4);assert.ok(size>=8&&offset+size<=bytes.length);if(command===0x19&&bytes.toString('utf8',offset+8,offset+24).replace(/\0/g,'')==='__LINKEDIT'){bytes.fill(0,offset+32,offset+40);found++;}offset+=size;}assert.equal(found,1);return sha(bytes);}
 for(const name of nativeHelpers){const packed=path.join(bundle,'Contents/Resources/app.asar.unpacked/desktop/native/bin',name);run('/usr/bin/codesign',['--verify','--strict',packed]);assert.equal(unsignedHash(packed,'package-'+name),unsignedHash(path.join(root,'desktop/native/bin',name),'source-'+name),'Signed native helper content: '+name);}
 checks.push('三个原生助手逐个通过严格签名校验；临时副本仅去除签名与其映射容量后，全部代码及其余字节与源码产物一致');

 const profile=path.join(dir,'profile');
 app=await electron.launch({executablePath:path.join(bundle,'Contents/MacOS/行知助手'),args:['--user-data-dir='+profile],timeout:30000});
 const actual=await app.evaluate(({app})=>({path:app.getPath('userData'),packaged:app.isPackaged,version:app.getVersion()}));assert.equal(actual.path,profile);assert.equal(actual.packaged,true);assert.equal(actual.version,version);
 const sdks=await app.evaluate(({app})=>{const base=app.getAppPath(),load=process.getBuiltinModule('module').createRequire(base+'/package.json');return {wecom:typeof load('@wecom/aibot-node-sdk').WSClient,dingtalk:typeof load('dingtalk-stream').DWClient,screenshot:typeof load('./desktop/screenshot.cjs').create};});assert.deepEqual(sdks,{wecom:'function',dingtalk:'function',screenshot:'function'});checks.push('分享包中的企业微信、钉钉SDK与截图模块可在真实Electron运行时加载');
 const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await expect(page.getByRole('button',{name:'快速收集',exact:true})).toBeVisible();
 const api=(action,input={})=>page.evaluate(async({action,input})=>{const result=await window.assistant.call(action,input);if(result.error)throw Error(result.error);return result.data;},{action,input});
 const initial=await api('state');assert.equal(initial.storagePath,path.join(profile,'workspace'));for(const key of ['providers','sources','tasks','projects','delegations','folders','feedConnections','webConnections','connectors'])assert.equal(initial[key].length,0,key);assert.equal(initial.settings.automatic,false);assert.equal(initial.agentSettings.outputFolder,'');
 checks.push('真实分享App从解压目录启动，独立空白profile无原用户的模型、资料、项目或目录权限');
 await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'快速记录权限'})).toBeVisible();await page.getByRole('button',{name:'暂时跳过',exact:true}).click();await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toHaveCount(0);checks.push('接收者首次启动显示快速上手与划词权限说明，显式跳过后进入工作台');
 const opened=app.waitForEvent('window');await page.getByRole('button',{name:'快速收集',exact:true}).click();const quick=await opened;quick.setDefaultTimeout(20000);quick.on('pageerror',e=>errors.push(e.message));const quickWindow=await app.browserWindow(quick);await expect(quick.getByRole('heading',{name:'快速记录事项',exact:true})).toBeVisible();assert.equal(await quick.evaluate(()=>window.assistant.quickCaptureWindow),true);await expect(quick.getByRole('button',{name:'框选截图',exact:true})).toBeVisible();await expect(quick.getByRole('button',{name:'粘贴剪贴板图片',exact:true})).toBeVisible();await quick.getByRole('button',{name:'新建事项',exact:true}).click();await quick.getByText('标题与所属项目（可选）',{exact:true}).click();await quick.getByLabel('快速收集标题').fill('分享版首次使用');await quick.getByLabel('快速收集正文').fill('这是接收者自己的第一份材料。');await quick.getByRole('button',{name:'新建并推进',exact:true}).click();await expect(quick.getByRole('region',{name:'连接 Agent 提醒'})).toBeVisible();await quick.getByRole('button',{name:'暂不配置，仅保存材料',exact:true}).click();await quick.getByRole('button',{name:'仅保存材料',exact:true}).click();await expect.poll(()=>quickWindow.evaluate(win=>win.isVisible())).toBe(false);await expect(quick.getByLabel('快速收集正文')).toHaveValue('');await expect.poll(async()=>(await api('state')).captureQueue.find(row=>row.itemTitles.includes('分享版首次使用'))?.status,{timeout:20000}).toBe('completed');const captured=await api('state');assert.equal(captured.sources.length,1);assert.equal(captured.sources[0].content,'这是接收者自己的第一份材料。');assert.equal(captured.tasks.length,0);assert.equal(captured.providers.length,0);assert.equal((captured.modelCalls||[]).length,0);checks.push('接收者未配置模型时先得到配置提醒，明确选择仅保存后小窗入队并关闭；首份材料落盘且零模型调用');
 const fixture=path.join(dir,'pdf');fs.mkdirSync(fixture);run('/usr/bin/swift',[path.join(root,'scripts/pdf-ocr-fixture.swift'),fixture]);
 await api('captureSave',{organize:false,items:[{title:'扫描件.pdf',base64:fs.readFileSync(path.join(fixture,'scanned.pdf')).toString('base64')}]});let state=await api('state');const pdf=state.sources.find(s=>s.title==='扫描件.pdf');assert.match(pdf.content,/7200/);assert.ok(pdf.segments.every(s=>s.localOCR));assert.equal((state.modelCalls||[]).length,0);checks.push('分享App内已签名PDF识别程序真实运行，扫描内容进入材料，零模型调用');
 await page.reload();await expect(page.getByRole('button',{name:'快速收集',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toHaveCount(0);state=await api('state');assert.equal(state.sources.length,2);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'fresh-install.png'),animations:'disabled'});checks.push('重新载入保留接收者资料，零渲染错误');
 const result={passed:true,version,checks,verifiedFiles,nativeHelpers,archiveRoots:tops,archiveEntries:entries.length,publicDependencyTests:{package:'zod',entries:publicDependencyTests.length},privateFiles:bad,rendererErrors:errors,modelCalls:0,actualUserWorkspaceTouched:false,signature:'ad-hoc (not Apple Developer ID)',notarized:false,gatekeeperApprovalTested:false,at:new Date().toISOString()};fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({passed:false,checks,error:e.stack},null,2));throw e;}
finally{await app?.close();if(mount)run('/usr/bin/hdiutil',['detach',mount]);fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
