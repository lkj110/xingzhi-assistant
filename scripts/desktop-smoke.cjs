const {electron}=require('./desktop-test-support.cjs');
const {navigate}=require('./navigation-helper.cjs');
const { } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-native-'));
  const fixture = path.join(dir, '会议记录.md');
  fs.writeFileSync(fixture, '这是一份独立测试材料。请准备一份周五发布说明，包含目标与待确认项。');
  let modelCalls = 0;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { messages } = JSON.parse(raw); const prompt = messages[0].content;
    const context = messages[1] ? JSON.parse(messages[1].content) : {};
    let result = { ok: true };
    if (prompt.includes('从材料提取')) result = { tasks: [{ title: '完成周五发布说明', description: '来自独立桌面测试材料', criteria: '写明周五发布及待确认事项', sourceIds: [context.sources[0].id], steps: [{ title: '撰写发布说明', kind: 'draft' }] }], summary: '测试提取完成' };
    else if (prompt.includes('推进给定事项')) result = { kind: 'artifact', title: '发布说明（测试）', content: '# 发布说明\n计划周五发布。\n待确认：负责人与设计反馈。', summary: '固定测试响应' };
    else if (prompt.includes('独立检查')) result = { passed: true, summary: '固定测试响应：完成标准满足', gaps: [] };
    modelCalls++;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const port = mock.address().port;
  let app;
  try {
    app = await electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, ASSISTANT_TEST_DATA_DIR: dir }, timeout: 60000 });
    const page = await app.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '配置模型', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.assistant.desktop), true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    await page.getByRole('button', { name: '配置模型', exact: true }).click();
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    await page.getByLabel('接口类型').selectOption('openai');await page.getByLabel('配置名称').fill('桌面测试服务');
    await page.getByLabel('服务地址').fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('模型名称').fill('local-fixture');
    await page.getByLabel('输入单价',{exact:true}).fill('0'); await page.getByLabel('缓存输入单价',{exact:true}).fill('0'); await page.getByLabel('输出单价',{exact:true}).fill('0');
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByText('已连接 local-fixture', { exact: true }).waitFor();
    await navigate(page,'信息收件箱');
    await page.getByRole('button', { name: '添加材料', exact: true }).first().click();
    await page.getByLabel('导入材料文件').setInputFiles(fixture);
    await page.getByRole('button', { name: '保存材料', exact: true }).click();
    await page.getByRole('button', { name: '整理并拆解', exact: true }).click();
    await page.getByText('已整理', { exact: true }).waitFor({ timeout: 15000 });
    await navigate(page,'工作看板');
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: '完成周五发布说明', exact: true }) }).click();
    await page.getByRole('button', { name: '推进下一步', exact: true }).click();
    await page.getByRole('button', { name: '验收完成', exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '验收完成', exact: true }).click();
    await page.getByText('已完成并保存结果', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭事项详情', exact: true }).click();
    const state = await page.evaluate(async () => (await window.assistant.call('state')).data);
    assert.equal(state.tasks[0].status, 'completed'); assert.equal(state.artifacts.length, 1); assert.equal(modelCalls, 4);
    assert.ok(fs.existsSync(path.join(dir, 'workspace/workspace.json')));
    const settings = await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration };
    });
    assert.deepEqual(settings, { contextIsolation: true, sandbox: true, nodeIntegration: false });
    await page.screenshot({ path: path.join(__dirname, '../artifacts/desktop-flow-test.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ passed: true, tested: ['native IPC', 'file import', 'provider connection', 'extraction', 'execution', 'verification', 'acceptance', 'persisted data', 'sandbox', 'hide-to-background'], modelCalls, rendererErrors: errors.length }) + '\n');
  } finally {
    if (app) await app.close();
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
