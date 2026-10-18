'use strict';

// Actual recipient experience only. release-archive verifies transport, complete
// bundle identity, versions and signatures before invoking this adapter.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const {promisify} = require('node:util');
const execute = promisify(cp.execFile);

async function verify({bundle, output, source = path.resolve(__dirname, '..'), version}) {
  assert.equal(typeof bundle, 'string', 'bundle is required');
  assert.equal(typeof output, 'string', 'output is required');
  bundle = fs.realpathSync(bundle);
  const root = fs.realpathSync(source), out = path.resolve(output);
  assert.ok(!fs.lstatSync(out, {throwIfNoEntry: false}), 'experience output must be fresh');
  assert.equal(typeof version, 'string', 'frozen version is required');
  fs.mkdirSync(out, {recursive: false, mode: 0o700});
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-share-verify-')));
  const environment = {...process.env};
  for (const key of Object.keys(environment)) if (/^(NODE_OPTIONS$|NODE_PATH$|NODE_TEST_|ELECTRON_RUN_AS_NODE$|SYSTEM_RELEASE_|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(key)) delete environment[key];
  const checks = [], errors = [];
  const run = async (file, args) => {
    try {
      const result = await execute(file, args, {cwd: root, env: environment, encoding: 'utf8', timeout: 60000});
      fs.writeFileSync(path.join(out, 'fixture.stdout'), result.stdout, {flag: 'wx'});
      fs.writeFileSync(path.join(out, 'fixture.stderr'), result.stderr, {flag: 'wx'});
      return result.stdout;
    } catch (error) {
      fs.writeFileSync(path.join(out, 'fixture-failure.json'), JSON.stringify({error: error.message, stdout: error.stdout, stderr: error.stderr}, null, 2), {flag: 'wx'});
      throw error;
    }
  };
  let app, failure;
  try {
    const {_electron: electron, expect} = require('playwright/test');
 const profile=path.join(dir,'profile');
 app=await electron.launch({executablePath:path.join(bundle,'Contents/MacOS/行知助手'),args:['--user-data-dir='+profile],env:environment,timeout:30000});
 const actual=await app.evaluate(({app})=>({path:app.getPath('userData'),packaged:app.isPackaged,version:app.getVersion()}));assert.equal(actual.path,profile);assert.equal(actual.packaged,true);assert.equal(actual.version,version);
 const sdks=await app.evaluate(({app})=>{const base=app.getAppPath(),load=process.getBuiltinModule('module').createRequire(base+'/package.json');return {wecom:typeof load('@wecom/aibot-node-sdk').WSClient,dingtalk:typeof load('dingtalk-stream').DWClient,screenshot:typeof load('./desktop/screenshot.cjs').create};});assert.deepEqual(sdks,{wecom:'function',dingtalk:'function',screenshot:'function'});checks.push('分享包中的企业微信、钉钉SDK与截图模块可在真实Electron运行时加载');
 const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await expect(page.getByRole('button',{name:'快速收集',exact:true})).toBeVisible();
 const api=(action,input={})=>page.evaluate(async({action,input})=>{const result=await window.assistant.call(action,input);if(result.error)throw Error(result.error);return result.data;},{action,input});
 const initial=await api('state');assert.equal(initial.storagePath,path.join(profile,'workspace'));for(const key of ['providers','sources','tasks','projects','delegations','folders','feedConnections','webConnections','connectors'])assert.equal(initial[key].length,0,key);assert.equal(initial.settings.automatic,false);assert.equal(initial.agentSettings.outputFolder,'');
 checks.push('真实分享App从解压目录启动，独立空白profile无原用户的模型、资料、项目或目录权限');
 await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'快速记录权限'})).toBeVisible();await page.getByRole('button',{name:'暂时跳过',exact:true}).click();await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toHaveCount(0);checks.push('接收者首次启动显示快速上手与划词权限说明，显式跳过后进入工作台');
 const opened=app.waitForEvent('window');await page.getByRole('button',{name:'快速收集',exact:true}).click();const quick=await opened;quick.setDefaultTimeout(20000);quick.on('pageerror',e=>errors.push(e.message));const quickWindow=await app.browserWindow(quick);await expect(quick.getByRole('heading',{name:'快速记录事项',exact:true})).toBeVisible();assert.equal(await quick.evaluate(()=>window.assistant.quickCaptureWindow),true);await expect(quick.getByRole('button',{name:'框选截图',exact:true})).toBeVisible();await expect(quick.getByRole('button',{name:'粘贴剪贴板图片',exact:true})).toBeVisible();await quick.getByRole('button',{name:'新建事项',exact:true}).click();await quick.getByText('标题与所属项目（可选）',{exact:true}).click();await quick.getByLabel('快速收集标题').fill('分享版首次使用');await quick.getByLabel('快速收集正文').fill('这是接收者自己的第一份材料。');await quick.getByRole('button',{name:'新建并推进',exact:true}).click();await expect(quick.getByRole('region',{name:'连接 Agent 提醒'})).toBeVisible();await quick.getByRole('button',{name:'暂不配置，仅保存材料',exact:true}).click();await quick.getByRole('button',{name:'仅保存材料',exact:true}).click();await expect.poll(()=>quickWindow.evaluate(win=>win.isVisible())).toBe(false);await expect(quick.getByLabel('快速收集正文')).toHaveValue('');await expect.poll(async()=>(await api('state')).captureQueue.find(row=>row.itemTitles.includes('分享版首次使用'))?.status,{timeout:20000}).toBe('completed');const captured=await api('state');assert.equal(captured.sources.length,1);assert.equal(captured.sources[0].content,'这是接收者自己的第一份材料。');assert.equal(captured.tasks.length,0);assert.equal(captured.providers.length,0);assert.equal((captured.modelCalls||[]).length,0);checks.push('接收者未配置模型时先得到配置提醒，明确选择仅保存后小窗入队并关闭；首份材料落盘且零模型调用');
 const fixture=path.join(dir,'pdf');fs.mkdirSync(fixture);await run('/usr/bin/swift',[path.join(root,'scripts/pdf-ocr-fixture.swift'),fixture]);
 await api('captureSave',{organize:false,items:[{title:'扫描件.pdf',base64:fs.readFileSync(path.join(fixture,'scanned.pdf')).toString('base64')}]});let state=await api('state');const pdf=state.sources.find(s=>s.title==='扫描件.pdf');assert.match(pdf.content,/7200/);assert.ok(pdf.segments.every(s=>s.localOCR));assert.equal((state.modelCalls||[]).length,0);checks.push('分享App内已签名PDF识别程序真实运行，扫描内容进入材料，零模型调用');
 await page.reload();await expect(page.getByRole('button',{name:'快速收集',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'欢迎使用行知助手',exact:true})).toHaveCount(0);state=await api('state');assert.equal(state.sources.length,2);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'fresh-install.png'),animations:'disabled'});checks.push('重新载入保留接收者资料，零渲染错误');

  } catch (error) { failure = error; }
  // Close before publishing passed: shutdown failure must not leave a green
  // verification. A failed isolated profile remains available for diagnosis.
  try { await app?.close(); } catch (error) { failure ||= error; }
  const result = {passed: !failure, scope: 'share-experience', version, checks, rendererErrors: errors,
    modelCalls: failure ? null : 0, actualUserWorkspaceTouched: false, isolatedProfile: path.join(dir, 'profile'),
    signature: 'checked by release-archive', notarized: false, gatekeeperApprovalTested: false,
    at: new Date().toISOString(), ...(failure ? {error: failure.stack} : {})};
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  if (failure) { failure.evidenceDir = out; throw failure; }
  fs.rmSync(dir, {recursive: true, force: true});
  return result;
}

module.exports = {verify};
