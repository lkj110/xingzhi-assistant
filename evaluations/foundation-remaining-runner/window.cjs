'use strict';
const assert=require('node:assert/strict');
async function ready(app,page,task,labels,mode){
 assert.equal(await page.evaluate(()=>window.assistant.quickCaptureWindow),false);
 await page.reload();await page.waitForFunction(()=>!!window.assistant);await page.getByLabel('搜索事项').fill(task.title);
 await page.locator('.task-card').filter({hasText:task.title}).click();const detail=page.getByRole('dialog',{name:'事项详情'}),{expect}=require('playwright/test');
 await expect(detail.getByRole('heading',{name:task.title,exact:true})).toBeVisible();for(const label of labels)await expect(detail.getByRole('button',{name:label,exact:true})).toBeEnabled();
 const window=await app.browserWindow(page);if(mode==='live')await window.evaluate(w=>{w.show();w.focus();});const proof=await window.evaluate(w=>({id:w.id,title:w.getTitle(),visible:w.isVisible()}));assert.match(proof.title,/主窗口/);if(mode==='live')assert.equal(proof.visible,true);return proof;
}
module.exports={ready};
