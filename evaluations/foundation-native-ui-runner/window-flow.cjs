'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),native=require('./native.cjs');
async function ready(app,page,task,mode){
 assert.equal(await page.evaluate(()=>window.assistant?.quickCaptureWindow),false);
 await page.reload();await page.waitForFunction(()=>!!window.assistant);
 await page.getByLabel('搜索事项').fill(task.title);
 await page.locator('.task-card').filter({hasText:task.title}).click();
 const {expect}=require('playwright/test'),detail=page.getByRole('dialog',{name:'事项详情'});
 await expect(detail.getByRole('heading',{name:task.title,exact:true})).toBeVisible();
 await expect(detail.getByRole('button',{name:'验收完成',exact:true})).toBeEnabled();
 const window=await app.browserWindow(page);
 if(mode==='live')await window.evaluate(w=>{w.show();w.focus();});
 const proof=await window.evaluate(w=>({id:w.id,visible:w.isVisible(),title:w.getTitle()}));
 assert.match(proof.title,/F04 主窗口/);if(mode==='live')assert.equal(proof.visible,true);return proof;
}
async function capturePage(app){
 await app.evaluate(({Menu})=>{const menu=Menu.getApplicationMenu().items.flatMap(item=>item.submenu?.items||[]).find(item=>item.label==='快速收集');if(!menu)throw Error('Original capture menu missing');menu.click();});
 for(let i=0;i<100;i++){
  for(const page of app.windows())try{if(await page.evaluate(()=>window.assistant?.quickCaptureWindow===true))return page;}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 throw Error('Packaged capture window did not appear');
}
async function exercise({app,page,output,session,taskId,fault,checks,api}){
 assert.equal(session.mode,'offline','Native lifecycle exercise is never a human acceptance');
 const before=await api('export'),capture=await capturePage(app),file=path.join(output,'native-commands.jsonl');
 const {expect}=require('playwright/test');
 await expect(capture.getByRole('heading',{name:'快速记录事项',exact:true})).toBeVisible();
 await expect.poll(()=>native.records(file).some(r=>r.kind==='native-command'&&r.command==='quickCaptureDraft'&&r.input?.occupied===false)).toBe(true);
 await capture.getByText('标题与所属项目（可选）',{exact:true}).click();
 await capture.getByLabel('快速收集标题').fill('OFFLINE OCCUPANCY ONLY');
 await expect.poll(()=>native.records(file).some(r=>r.kind==='native-command'&&r.command==='quickCaptureDraft'&&r.input?.occupied===true)).toBe(true);
 await capture.getByLabel('快速收集标题').fill('');
 const stateCount=()=>native.records(file).filter(r=>r.kind==='native-command'&&r.command==='quickCaptureState').length,firstCount=stateCount();
 await expect.poll(stateCount).toBeGreaterThan(firstCount);session.guard();
 checks.push({kind:'actual-dynamic-capture-mount-poll-occupancy',synthetic:true});
 const invoke=(target,action,input)=>target.evaluate(({action,input})=>window.assistant.call(action,input),{action,input});
 if(fault==='capture-submit')await invoke(capture,'quickCaptureSubmit',{requestId:'OFFLINE-NOT-A-REAL-SUBMISSION',textItems:[{title:'PRIVATE_SENTINEL',content:'PRIVATE_SENTINEL'}]});
 if(fault==='wrong-window')await invoke(capture,'uiCommand',{action:'taskAction',input:{id:taskId,command:'accept'}});
 if(fault==='invalid-input')await invoke(capture,'quickCaptureDraft',{occupied:false,secret:'PRIVATE_SENTINEL'});
 if(fault==='unknown-command')await invoke(page,'unknownUiCommand',{text:'PRIVATE_SENTINEL'});
 if(fault==='stop-accept'){fs.writeFileSync(path.join(session.output,'STOP'),'OFFLINE');await invoke(page,'uiCommand',{action:'taskAction',input:{id:taskId,command:'accept'}});}
 if(fault==='phase-stop-accept'){fs.writeFileSync(path.join(output,'STOP'),'OFFLINE');await invoke(page,'uiCommand',{action:'taskAction',input:{id:taskId,command:'accept'}});}
 if(fault==='expired-accept'){
  await app.evaluate((_e,time)=>{globalThis.__offlineOriginalNow=Date.now;Date.now=()=>time;},session.deadline+1);
  try{await invoke(page,'uiCommand',{action:'taskAction',input:{id:taskId,command:'accept'}});}finally{await app.evaluate(()=>{Date.now=globalThis.__offlineOriginalNow;delete globalThis.__offlineOriginalNow;});}
 }
 session.guard();
 const hides=()=>native.records(file).filter(r=>r.kind==='native-command'&&r.command==='quickCaptureHide').length;
 await capture.getByRole('button',{name:'隐藏快速收集窗口',exact:true}).click();await expect.poll(hides).toBe(1);
 const reopened=await capturePage(app);assert.equal(reopened,capture);await capture.keyboard.press('Escape');await expect.poll(hides).toBe(2);
 // Exercise a genuinely new native capture window after the observer was installed.
 const win=await app.browserWindow(capture);await win.evaluate(w=>w.destroy());
 const recreated=await capturePage(app);assert.notEqual(recreated,capture);await expect(recreated.getByRole('heading',{name:'快速记录事项',exact:true})).toBeVisible();
 await recreated.getByRole('button',{name:'隐藏快速收集窗口',exact:true}).click();await expect.poll(hides).toBe(3);
 session.guard();const after=await api('export');
 for(const key of ['tasks','sources','artifacts','modelCalls'])assert.deepEqual(after[key],before[key],key+' changed during auxiliary UI flow');
 assert.equal(native.records(file).filter(r=>r.kind==='denied').length,0);
 checks.push({kind:'capture-button-escape-reopen-recreate',synthetic:true,applicationStateUnchanged:true});
}
module.exports={ready,exercise};
