const {electron}=require('./desktop-test-support.cjs');
const {expect}=require('playwright/test'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-contract-ui-')),out=path.join(root,'artifacts/execution-continuity-2026-10-15');let app;
fs.mkdirSync(out,{recursive:true});
(async()=>{try{
 app=await electron.launch({args:['scripts/execution-contract-fixture.cjs'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir},timeout:30000});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state=()=>page.evaluate(async()=>(await window.assistant.call('state')).data);
 await page.getByRole('button',{name:'Agent 委托',exact:true}).click();await page.getByRole('button',{name:'调整范围与验收标准',exact:true}).click();
 await page.getByRole('textbox',{name:'当前执行约定',exact:true}).fill('只检查六个入口的上下游；已确认权限缺口单列；主稿精简。');
 await page.getByRole('button',{name:'保存执行约定',exact:true}).click();await expect(page.getByRole('button',{name:'调整范围与验收标准',exact:true})).toBeVisible();
 let data=await state();assert.match(data.delegations[0].executionContract.text,/六个入口/);assert.equal(data.delegations[0].status,'paused');assert.ok(data.tasks[0].needsReplan);
 await page.getByRole('button',{name:'允许本事项自动更新已有飞书文档',exact:true}).click();await expect(page.getByRole('button',{name:'改为每次更新前确认',exact:true})).toBeEnabled();data=await state();assert.equal(data.delegations[0].larkCreatePolicies[0].allowUpdate,true);assert.equal(data.agentActions.length,0);
 await page.reload();await page.getByRole('button',{name:'Agent 委托',exact:true}).click();await expect(page.getByRole('region',{name:'当前执行约定'})).toContainText('只检查六个入口');await expect(page.getByRole('button',{name:'恢复委托',exact:true})).toBeEnabled();
 await page.getByRole('region',{name:'当前执行约定'}).screenshot({path:path.join(out,'scope-panel.png')});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,760));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'desktop-results.json'),JSON.stringify({passed:true,isolatedData:true,mockModels:true,checks:['scope saves through visible UI','pause preserved','scope visible after reload','scoped update policy saves without writing','1000px layout','no renderer errors'],errors},null,2));console.log('Execution contract desktop checks passed.');
}finally{await app?.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
