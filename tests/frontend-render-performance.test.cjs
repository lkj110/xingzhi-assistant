const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('render bounds preserve every record and Unicode text page', async () => {
  const {pageBounds, textPage, needsTextPaging} = await import('../src/render-bounds.mjs');
  const seen = [];
  for (let page = 1; page <= 51; page++) {
    const bounds = pageBounds(1005, page, 20);
    for (let i = bounds.start; i < bounds.end; i++) seen.push(i);
  }
  assert.deepEqual(seen, Array.from({length: 1005}, (_, i) => i));
  assert.equal(pageBounds(3, 99).page, 1);
  const text = 'aaa😀TAIL';
  assert.equal(textPage(text, 1, 4).text, 'aaa😀');
  assert.equal(textPage(text, 2, 4).text, '😀TAI');
  assert.equal(textPage(text, 3, 4).text, 'L');
  assert.equal(needsTextPaging('normal\ntext'), false);
  assert.equal(needsTextPaging('\n'.repeat(400)), true);
  assert.equal(needsTextPaging('x'.repeat(24001)), true);
});

test('snapshot keys use versions without reading bodies, arguments or nested evidence', async () => {
  const {metadataVersion} = await import('../src/render-bounds.mjs');
  const forbidden = () => {throw new Error('full payload traversed');};
  const row = {id: 's', projectId: 'p', _viewRevision: 1};
  for (const key of ['content', 'args', 'result', 'verification', 'steps']) Object.defineProperty(row, key, {get: forbidden});
  const data = {viewRevision: 'same', sources: [row], tasks: [row], artifacts: [row], agentActions: [row]};
  const before = metadataVersion(data, {projectId: 'p'});
  assert.equal(metadataVersion({...data, sources: [row]}, {projectId: 'p'}), before);
  row._viewRevision = 2;
  assert.notEqual(metadataVersion(data, {projectId: 'p'}), before);
  assert.notEqual(metadataVersion({runtime: {revision: 1}}), metadataVersion({runtime: {revision: 2}}));
});

test('isolated renderer: lazy mount, bounded DOM, all pages, memo and deferred API races', {timeout: 60000}, async t => {
  // Standalone synthetic fixture only. No Electron, workspace, model or real API.
  const {build, preview} = await import('vite');
  const {chromium} = require('playwright');
  const {expect} = require('playwright/test');
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-render-test-'));
  let server, browser;
  t.after(async () => {await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); fs.rmSync(temporary, {recursive: true, force: true});});
  fs.writeFileSync(path.join(temporary, 'index.html'), `<div id="root"></div><script type="module" src="/@fs/${path.join(__dirname, 'frontend-render.fixture.jsx')}"></script>`);
  await build({root: temporary, configFile: false, logLevel: 'error', build: {outDir: path.join(temporary, 'dist')}});
  server = await preview({root: temporary, configFile: false, logLevel: 'error', build: {outDir: path.join(temporary, 'dist')}, preview: {host: '127.0.0.1', port: 0}});
  browser = await chromium.launch({headless: true, ...(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel: 'chrome'} : {})});
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.fixtureReady);
  const render = (name, options = {}) => page.evaluate(({name, options}) => window.renderCase(name, options), {name, options});

  await render('lazy'); await expect(page.locator('summary')).toHaveText('展开详情');
  assert.equal(await page.evaluate(() => window.lazyCalls || 0), 0);
  await page.locator('summary').click(); await expect(page.locator('.row')).toHaveCount(20);
  await page.getByLabel('测试记录分页跳转页码').fill('51'); await expect(page.locator('.row')).toHaveCount(5);
  await expect(page.locator('.row').last()).toHaveText('row-1004');
  await render('lazy', {total: 3}); await expect(page.locator('.row')).toHaveCount(3);
  await page.locator('summary').click(); await expect(page.locator('.row')).toHaveCount(0);

  await render('json'); await expect(page.locator('.json-preview > details')).toHaveCount(3);
  assert.equal(await page.evaluate(() => window.nestedReads || 0), 0);
  assert.ok((await page.locator('#root').textContent()).length < 1000);
  await page.locator('summary').filter({hasText: /^body：/}).click();
  await page.getByLabel('JSON 字段内容分页跳转页码').fill('51');
  await expect(page.locator('pre')).toHaveText('END');
  await page.locator('summary').filter({hasText: /^rows：/}).click();
  await page.getByLabel('JSON 字段内容字段分页跳转页码').fill('501');
  await expect(page.locator('summary').filter({hasText: '10004：10004'})).toHaveCount(1);

  await render('markdown'); await expect(page.locator('table tbody tr')).toHaveCount(1);
  const splits = await page.evaluate(() => window.splitCount);
  await render('markdown', {tick: 1}); await expect(page.locator('#root > div > span')).toHaveText('1');
  assert.equal(await page.evaluate(() => window.splitCount), splits);
  await render('markdown', {long: true}); await expect(page.locator('pre')).toHaveCount(1);
  assert.ok((await page.locator('pre').textContent()).length <= 8002);
  await page.getByLabel('文档原文分页跳转页码').fill('88'); await expect(page.locator('pre')).toContainText('END-MARKDOWN');

  await render('results'); await expect(page.locator('.result-card')).toHaveCount(12);
  await expect(page.locator('.result-history-file')).toHaveCount(0);
  await page.locator('.result-card').first().locator('summary').click();
  await expect(page.locator('.result-history-file')).toHaveCount(20);
  await page.getByLabel('成果历史分页跳转页码').fill('51');
  await page.getByRole('button', {name: /历史文稿-1004/}).click();
  assert.equal(await page.evaluate(() => window.opened.at(-1).id), 'history-1004');
  await page.getByLabel('成果事项分页跳转页码').fill('84'); await expect(page.locator('.result-card')).toHaveCount(7);
  await expect(page.locator('.result-card').last()).toContainText('事项-1002');
  await page.getByLabel('搜索当前成果').fill('事项-1002'); await expect(page.locator('.result-card')).toHaveCount(1);

  await page.evaluate(() => {window.requests = [];});
  await render('snapshot'); await expect(page.getByRole('button', {name: '下载成果 ZIP'})).toHaveCount(1);
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  await render('snapshot'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  await render('snapshot', {version: 2}); await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(2);

  await page.evaluate(() => {window.requests = [];});
  await render('run'); await expect(page.locator('summary')).toHaveText('展开运行详情');
  assert.equal(await page.evaluate(() => window.requests.length), 0);
  await page.locator('summary').click(); await expect(page.locator('.agent-run-step')).toHaveCount(20);
  assert.deepEqual(await page.evaluate(() => window.requests[0]), {action: 'viewDetail', kind: 'agentRun', id: 'r', start: 0, limit: 20});
  await page.getByLabel('运行步骤分页跳转页码').fill('3'); await expect(page.locator('.agent-run-step')).toHaveCount(5);
  await expect(page.locator('.agent-run-step').last()).toContainText('step-44');
  await page.locator('.agent-run-step').last().getByText('查看完整步骤参数与结果', {exact: true}).click();
  await expect.poll(() => page.evaluate(() => window.requests.at(-1).kind)).toBe('agentStep');
  assert.equal(await page.evaluate(() => window.requests.at(-1).stepIndex), 44);
  await expect(page.locator('.agent-run-step').last()).toContainText('FULL-44');
  assert.ok((await page.locator('#root').textContent()).length < 10000);
  await page.getByText('展开运行详情', {exact: true}).click(); await expect(page.locator('.agent-run-step')).toHaveCount(0);

  await page.evaluate(() => {window.deferRequests = true; window.pending = [];});
  await page.getByText('展开运行详情', {exact: true}).click(); await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(1);
  await page.getByLabel('运行步骤分页跳转页码').fill('2'); await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(2);
  await page.evaluate(() => window.pending[1]({id: 'r', start: 20, total: 45, steps: [{reason: 'fresh-response', args: {}}]}));
  await expect(page.locator('.agent-run-step')).toContainText('fresh-response');
  await page.evaluate(() => window.pending[0]({id: 'r', start: 0, total: 45, steps: [{reason: 'stale-response'}]}));
  await expect(page.locator('.agent-run-step')).toContainText('fresh-response');
  await render('run', {version: 2}); await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(3);
  await expect(page.locator('.agent-run-step')).toHaveCount(0);
  await page.getByText('展开运行详情', {exact: true}).click();
  await page.evaluate(() => window.pending[2]({id: 'r', start: 20, total: 45, steps: [{reason: 'unmounted'}]}));
  await expect(page.locator('.agent-run-step')).toHaveCount(0);

  await page.evaluate(() => {window.argsReads = 0; window.deferRequests = false;});
  await render('legacy'); await expect(page.locator('summary')).toHaveText('展开旧运行');
  assert.equal(await page.evaluate(() => window.argsReads), 0);
  await page.locator('summary').click(); await expect(page.locator('.agent-run-step')).toHaveCount(20);
  assert.equal(await page.evaluate(() => window.argsReads), 20);
  await expect(page.locator('.run-call')).toHaveCount(0);
  await page.getByText('逐次调用：模型、选模原因与费用（1003 次）').click(); await expect(page.locator('.run-call')).toHaveCount(20);
  await page.getByLabel('模型调用分页跳转页码').fill('51'); await expect(page.locator('.run-call')).toHaveCount(3);
  await expect(page.locator('.run-call').last()).toContainText('reason-1002');
  await page.getByLabel('运行步骤分页跳转页码').fill('51'); await expect(page.locator('.agent-run-step')).toHaveCount(3);
  await expect(page.locator('.agent-run-step').last()).toContainText('legacy-1002');

  await render('agent'); await expect(page.locator('.agent-run')).toHaveCount(12);
  await page.getByLabel('运行记录分页跳转页码').fill('3'); await expect(page.locator('.agent-run')).toHaveCount(1);
  await expect(page.locator('.agent-run')).toContainText('trigger-24');
  assert.deepEqual(errors, []);
});
