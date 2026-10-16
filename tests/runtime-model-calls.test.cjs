const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

test('runtime complete model-call detail, export, revision invalidation and failures',{timeout:60000},async t=>{
  const {build,preview}=await import('vite');
  const {chromium}=require('playwright');
  const {expect}=require('playwright/test');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-runtime-calls-'));
  let server,browser;
  t.after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});});
  fs.writeFileSync(path.join(temporary,'index.html'),`<div id="root"></div><script type="module" src="/@fs/${path.join(__dirname,'runtime-model-calls.fixture.jsx')}"></script>`);
  await build({root:temporary,configFile:false,logLevel:'error',build:{outDir:path.join(temporary,'dist')}});
  server=await preview({root:temporary,configFile:false,logLevel:'error',build:{outDir:path.join(temporary,'dist')},preview:{host:'127.0.0.1',port:0}});
  browser=await chromium.launch({headless:true,...(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?{channel:'chrome'}:{})});
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>window.fixtureReady);
  const section=page.getByRole('region',{name:'执行效率'}),exportButton=section.getByRole('button',{name:'导出统计'});
  const render=(viewRevision='v1',revision=1)=>page.evaluate(({viewRevision,revision})=>window.renderRuntime(viewRevision,revision),{viewRevision,revision});
  const requestCount=count=>expect.poll(()=>page.evaluate(()=>window.requests.length)).toBe(count);
  const row=(id)=>({id,model:id,stage:'planner',status:'done',inputChars:500,inputTokens:10,outputTokens:4,durationMs:2000});
  const calls=Array.from({length:1000},(_,i)=>({...row(`full-model-${i}`),status:i<900?'done':'error',inputTokens:i%2?null:10,outputTokens:i%2?null:4,cachedInputTokens:i%2?null:2,errorCode:'failure-code',errorMessage:'fixture-error',diagnostic:{fingerprint:'fixture-diagnostic'}}));

  await t.test('uses the complete 1000 rows for statistics, pagination and downloaded JSON',async()=>{
    await render();await requestCount(1);
    assert.deepEqual(await page.evaluate(()=>window.requests[0]),{action:'viewDetail',input:{kind:'modelCalls',id:'all'}});
    await expect(exportButton).toBeDisabled();await expect(section.getByRole('status')).toContainText('正在加载完整调用记录');
    await expect(section.locator('tbody tr')).toHaveCount(0);
    await page.evaluate(calls=>window.resolveCalls(0,calls),calls);
    await expect(section.locator('.runtime-facts strong')).toHaveText(['900 / 1000','2.0 秒','3','5,000 / 2,000']);
    await expect(section).toContainText('500 次返回了 token 用量，500 次未知');
    await expect(section).toContainText('已报告的缓存输入：1,000（500 次提供该字段）');
    await expect(section.locator('tbody tr')).toHaveCount(30);
    await section.getByLabel('调用记录分页跳转页码').fill('34');await expect(section.locator('tbody tr')).toHaveCount(10);
    await expect(section.locator('tbody tr').last()).toContainText('full-model-999');
    await expect(section.locator('tbody tr').last()).toContainText('failure-code · fixture-error · 诊断 fixture-diagnostic');
    const downloaded=page.waitForEvent('download');await exportButton.click();const download=await downloaded;
    assert.equal(download.suggestedFilename(),'行知调用统计.json');
    const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);
    const exported=JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(exported,{calls,repeatedActions:3});
    assert.equal(await page.evaluate(()=>window.previewReads),0);
    await render();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.requests.length),1);
  });

  await t.test('view revisions hide old rows immediately and discard out-of-order responses',async()=>{
    const stale=await page.evaluate(()=>{window.renderRuntime('v2',1);return {text:document.querySelector('[aria-label="执行效率"]').textContent,disabled:[...document.querySelectorAll('button')].find(b=>b.textContent==='导出统计').disabled};});
    assert.equal(stale.text.includes('full-model-999'),false);assert.equal(stale.text.includes('900 / 1000'),false);assert.equal(stale.disabled,true);
    await requestCount(2);await render('v3',1);await requestCount(3);
    await page.evaluate(calls=>window.resolveCalls(2,calls),[row('fresh-response')]);
    await expect(section.locator('tbody tr')).toContainText('fresh-response');
    await page.evaluate(calls=>window.resolveCalls(1,calls),[row('stale-response')]);
    await expect(section.locator('tbody tr')).toContainText('fresh-response');await expect(section).not.toContainText('stale-response');
  });

  await t.test('runtime revision refreshes, failures and malformed payloads allow retry, empty detail is valid',async()=>{
    await render('v3',2);await requestCount(4);await expect(exportButton).toBeDisabled();await expect(section.locator('tbody tr')).toHaveCount(0);
    await page.evaluate(()=>window.pending[3]({error:'isolated-detail-failure'}));
    await expect(section.getByRole('alert')).toContainText('isolated-detail-failure');await expect(exportButton).toBeDisabled();
    await section.getByRole('button',{name:'重试加载调用记录'}).click();await requestCount(5);
    await page.evaluate(()=>window.pending[4]({data:{}}));
    await expect(section.getByRole('alert')).toContainText('调用记录响应不完整');await expect(exportButton).toBeDisabled();
    await section.getByRole('button',{name:'重试加载调用记录'}).click();await requestCount(6);
    await page.evaluate(()=>window.resolveCalls(5,[]));
    await expect(section).toContainText('推进一个事项后，这里会出现调用记录');await expect(exportButton).toBeEnabled();
    await expect(section.locator('.runtime-facts strong').first()).toHaveText('0 / 0');
  });

  await t.test('unmount cancels late results and remount requests current details',async()=>{
    await render('v4',2);await requestCount(7);await page.evaluate(()=>window.hideRuntime());
    await page.evaluate(calls=>window.resolveCalls(6,calls),[row('unmounted-response')]);
    await expect(page.locator('#root')).toBeEmpty();
    await render('v4',2);await requestCount(8);await page.evaluate(calls=>window.resolveCalls(7,calls),[row('remounted-response')]);
    await expect(section.locator('tbody tr')).toContainText('remounted-response');await expect(section).not.toContainText('unmounted-response');
    assert.equal(await page.evaluate(()=>window.previewReads),0);assert.deepEqual(errors,[]);
  });
});
