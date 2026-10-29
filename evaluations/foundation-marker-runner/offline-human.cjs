'use strict';
// This module is required only by offline mode. No live call site can use it.
const assert=require('node:assert/strict');
async function act(page,action,id,mode){
 assert.equal(mode,'offline');
 await page.reload();await page.waitForFunction(()=>!!window.assistant);
 const state=await page.evaluate(async()=>{const r=await window.assistant.call('state');return r.data;});
 const task=state.tasks.find(t=>t.id===id);assert.ok(task);
 await page.locator('.task-card').filter({hasText:task.title}).click();
 const labels={confirm:'确认这些表达已清楚',recheck:'重新核验',accept:'验收完成'};assert.ok(labels[action]);
 await page.getByRole('button',{name:labels[action],exact:true}).click();
}
module.exports={act};
