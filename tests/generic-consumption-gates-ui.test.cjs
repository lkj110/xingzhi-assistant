'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('B6 controlled renderer labels draft facts and proven zero calls without implying acceptance', {timeout:60000},async t=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'consumption-gates-ui-'));
 const {build,preview}=await import('vite'),{chromium}=require('playwright');let server,browser;
 t.after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});});
 const imports={react:path.join(root,'node_modules/react/index.js'),client:path.join(root,'node_modules/react-dom/client.js'),page:path.join(root,'src/AgentPage.jsx'),usage:path.join(root,'src/SpendControls.jsx')};
 fs.writeFileSync(path.join(temporary,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
 fs.writeFileSync(path.join(temporary,'entry.jsx'),`import React from ${JSON.stringify(imports.react)};import {createRoot} from ${JSON.stringify(imports.client)};import {EvidenceConsumptionProgress} from ${JSON.stringify(imports.page)};import {RunUsageSummary} from ${JSON.stringify(imports.usage)};const root=createRoot(document.getElementById('root'));root.render(<><EvidenceConsumptionProgress items={[{taskId:'controlled',title:'受控报告',obtained:8,incorporatedAwaitingCheck:5,remaining:3,draftOnly:true,lastDraftAt:'2026-01-01T00:00:00Z'}]}/><div id="zero"><RunUsageSummary run={{status:'done',modelCalls:0,modelCallsDetail:[],finishedAt:'2026-01-01T00:01:00Z'}}/></div><div id="unknown"><RunUsageSummary run={{status:'done',modelCalls:0,finishedAt:'2026-01-01T00:01:00Z',usage:{unknownCalls:1}}}/></div></>);`);
 await build({root:temporary,configFile:false,logLevel:'error',resolve:{alias:{'react/jsx-runtime':path.join(root,'node_modules/react/jsx-runtime.js')}},build:{outDir:path.join(temporary,'dist')}});
 server=await preview({root:temporary,configFile:false,logLevel:'error',build:{outDir:path.join(temporary,'dist')},preview:{host:'127.0.0.1',port:0}});
 browser=await chromium.launch({headless:true,...(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?{channel:'chrome'}:{})});
 const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());await page.goto(server.resolvedUrls.local[0]);
 await page.getByLabel('证据纳入进展').waitFor();const text=await page.getByLabel('证据纳入进展').innerText();
 assert.match(text,/已取得 8 项事实/);assert.match(text,/已纳入修订待核验 5 项/);assert.match(text,/尚未纳入 3 项/);assert.match(text,/当前为增量草稿/);assert.match(text,/最近纳入原稿/);assert.doesNotMatch(text,/事实已验证|验收通过/);
 assert.match(await page.locator('#zero').innerText(),/0 token · 折算 \$0.0000 · 未调用模型/);assert.match(await page.locator('#unknown').innerText(),/用量未知/);assert.doesNotMatch(await page.locator('#unknown').innerText(),/\$0|未调用模型/);assert.deepEqual(errors,[]);
});
