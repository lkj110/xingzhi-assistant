'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
async function verify({executable,out}){
  const {_electron:electron,expect}=require('playwright/test');
  fs.mkdirSync(out,{recursive:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'行知 Windows smoke ')),profile=path.join(directory,'profile');
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ASSISTANT_TEST_DATA_DIR','ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_ENGINE_FIXTURE'])delete env[key];
  let app,failed;const errors=[],checks=[];const version=require('../package.json').version;
  const launch=()=>electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000});
  try{
    app=await launch();
    const actual=await app.evaluate(({app})=>({profile:app.getPath('userData'),packaged:app.isPackaged,version:app.getVersion()}));
    assert.equal(actual.profile,profile);assert.equal(actual.packaged,true);assert.equal(actual.version,version);
    const shortcut=await app.evaluate(({app,shell},directory)=>{
      const localRequire=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
      const path=localRequire('node:path'),w=localRequire(path.join(app.getAppPath(),'desktop/windows-shell.cjs'));
      const file=w.shortcut({app,shell,directory});return shell.readShortcutLink(file);
    },path.join(directory,'isolated start menu'));
    assert.equal(shortcut.appUserModelId,'local.xingzhi.assistant');assert.equal(shortcut.target,executable);
    assert.equal(shortcut.toastActivatorClsid.toLowerCase().replace(/[{}]/g,''),'9cb14368-0a71-4d19-8cc7-20b58b091361');
    checks.push('Windows 开始菜单入口、固定通知身份和通知激活 CLSID 实际写入并回读成功（隔离目录）');
    const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
    const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
    await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toBeVisible();
    const initial=await api('state');assert.equal(initial.providers.length,0);assert.equal(initial.sources.length,0);assert.equal(initial.settings.automatic,false);
    await page.getByRole('button',{name:'暂时跳过',exact:true}).click();
    checks.push('实际打包 EXE 启动，工作空间位于含中文和空格的临时目录；无模型、自动托管关闭');
    await expect.poll(async()=>(await api('quickCaptureDetectionStatus')).selectionRunning).toBe(true);
    const captureStatus=await api('quickCaptureDetectionStatus');assert.equal(captureStatus.platform,'win32');assert.equal(captureStatus.screenshotKey,'Ctrl + Shift + 2');
    checks.push('打包后的 Windows 选区组件启动并完成握手，系统快捷键状态可读取');
    await api('captureSave',{organize:false,textItems:[{title:'Windows 持久化测试',content:'重启后保留的测试材料 7200'}]});
    const fixture=require('../tests/helpers/windows-fixtures.cjs');
    await api('captureSave',{organize:false,items:[{title:'中文截图.png',base64:fixture.image().toBuffer('image/png').toString('base64')},{title:'扫描件.pdf',base64:fixture.scannedPDF().toString('base64')}]});
    let state=await api('state');
    assert.equal(state.sources.length,3);for(const source of state.sources.filter(s=>s.title!=='Windows 持久化测试'))assert.match(source.content,/行知助手.*7200/);
    assert.equal((await api('viewDetail',{kind:'modelCalls',id:'all'})).calls.length,0);checks.push('包内图片和扫描 PDF OCR 真实导入成功，原生组件从 ASAR 外正确加载，零模型请求');
    const event=app.waitForEvent('window');await api('quickCaptureOpen');const quick=await event;
    await expect(quick.getByRole('heading',{name:'快速记录事项',exact:true})).toBeVisible();
    await expect(quick.getByRole('button',{name:'框选截图',exact:true})).toBeVisible();
    await quick.getByRole('button',{name:'新建事项',exact:true}).click();await quick.getByText('标题与所属项目（可选）',{exact:true}).click();
    await quick.getByLabel('快速收集标题').fill('免安装版快速收集');await quick.getByLabel('快速收集正文').fill('Windows 快速收集已验证。');
    await quick.getByRole('button',{name:'新建并推进',exact:true}).click();await expect(quick.getByRole('region',{name:'连接 Agent 提醒'})).toBeVisible();
    await quick.getByRole('button',{name:'暂不配置，仅保存材料',exact:true}).click();await quick.getByRole('button',{name:'仅保存材料',exact:true}).click();
    await expect.poll(async()=>(await api('state')).sources.length).toBe(4);checks.push('真实快速收集窗口输入、无模型提示及仅保存流程通过');
    await page.screenshot({path:path.join(out,'windows-desktop.png'),animations:'disabled'});
    await app.close();app=null;
    app=await launch();const reopened=await app.firstWindow();await reopened.waitForFunction(()=>!!window.assistant);
    await expect.poll(async()=>reopened.evaluate(async()=>(await window.assistant.call('state')).data?.sources?.length)).toBe(4);
    assert.deepEqual(errors,[]);checks.push('完全退出再冷启动保留 4 份材料，未发生渲染错误');
  }catch(error){failed=error;}
  try{await app?.close();}catch(error){failed ||= error;}
  const report={passed:!failed,version,checks,rendererErrors:errors,liveModelCalls:0,actualUserWorkspaceTouched:false,...(failed?{error:failed.stack}:{})};
  fs.writeFileSync(path.join(out,'windows-smoke.json'),JSON.stringify(report,null,2));
  if(failed)throw failed;
  fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});return report;
}
module.exports={verify};
if(require.main===module)verify({executable:path.resolve(process.argv[2]),out:path.resolve(process.argv[3]||'artifacts/windows-smoke')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
