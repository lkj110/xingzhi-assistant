// Real desktop Worker transport, synthetic history, no providers or external jobs.
const {electron}=require('./desktop-test-support.cjs');
const {expect}=require('playwright/test'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Assistant}=require('../desktop/core.cjs');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-performance-desktop-'));
const out=path.join(root,'artifacts/performance-repair');fs.mkdirSync(out,{recursive:true});
let app;const report={checks:[],errors:[],realModels:false,liveWorkspaceTouched:false};
(async()=>{try{
 const a=new Assistant({dir:path.join(dir,'workspace')});
 const materials=Array.from({length:80},(_,i)=>({title:'性能材料 '+i,content:('资料内容 '+i+'\n').repeat(18000).slice(0,150000)}));
 for(let offset=0;offset<materials.length;offset+=20)await a.dispatch('import',{items:materials.slice(offset,offset+20)});
 a.createTask({title:'性能测试事项',description:'确认大历史下窗口仍可操作'});
 a.data.agentRuns=Array.from({length:40},(_,i)=>({id:'run-'+i,jobId:'historical',status:'done',steps:Array.from({length:20},()=>({tool:'read_source',args:{},result:{text:'合成历史返回'.repeat(5000)}}))}));
 a.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};a.save();require('../desktop/deadline-scheduler.cjs').dispose(a);
 report.workspaceBytes=fs.statSync(a.file).size;
 const workerFixture=path.join(dir,'worker-fixture.cjs');fs.writeFileSync(workerFixture,"exports.create=({Assistant,options})=>{const deny=async()=>{throw Error('External calls forbidden in performance test');};return new Assistant({...options,chat:deny,agentRequest:deny,connectorRequest:deny,officeRequest:deny,webRequest:deny,feedRequest:deny});};");
 app=await electron.launch({args:['scripts/performance-worker-fixture.cjs'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir,ASSISTANT_ENGINE_WORKER:'1',ASSISTANT_ENGINE_FIXTURE:workerFixture},timeout:60000});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
 const call=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
 const initial=await call('stateView');report.initialViewBytes=Buffer.byteLength(JSON.stringify(initial));
 const unchanged=await call('stateView',{revision:initial.revision});assert.equal(unchanged.unchanged,true);report.unchangedViewBytes=Buffer.byteLength(JSON.stringify(unchanged));
 assert.ok(report.initialViewBytes<report.workspaceBytes/10);report.checks.push('history omitted from state and unchanged refresh is tiny');
 await app.evaluate(()=>{globalThis.performanceTicks=[];let last=performance.now();globalThis.performanceTimer=setInterval(()=>{const now=performance.now();globalThis.performanceTicks.push(now-last);last=now;},10);});
 // Each command still performs a real durable full save, entirely in the Worker.
 const work=call('uiCommand',{action:'settings',input:{profile:'窗口持续响应测试'}});
 const start=Date.now();await page.getByLabel('搜索事项').fill('性能测试');await expect(page.getByLabel('搜索事项')).toHaveValue('性能测试');report.inputMs=Date.now()-start;
 await work;
 await page.locator('.sidebar').getByRole('button',{name:'信息收集',exact:true}).click();await expect(page.locator('.source-row')).toHaveCount(40);
 await page.getByRole('navigation',{name:'材料列表分页'}).getByRole('button',{name:'下一页'}).click();await expect(page.locator('.source-row')).toHaveCount(40);report.checks.push('materials are paged at 40 rows and later pages remain accessible');
 const openedTitle=await page.locator('.source-row h3').first().innerText();await page.locator('.source-row').first().click();await expect(page.getByRole('dialog')).toContainText('正文定位');report.checks.push('source excerpt detail loads on demand');
 const openedSource=initial.state.sources.find(row=>row.title===openedTitle);await call('uiCommand',{action:'deleteSource',input:{id:openedSource.id}});await expect(page.getByRole('dialog')).toContainText('旧正文已关闭');await expect(page.locator('.source-segment')).toHaveCount(0);report.checks.push('deleting an open source removes cached text immediately after state refresh');
 report.mainThreadGaps=await app.evaluate(()=>{clearInterval(globalThis.performanceTimer);const sorted=globalThis.performanceTicks.sort((a,b)=>a-b);return {samples:sorted.length,maxMs:sorted.at(-1),p95Ms:sorted[Math.floor(sorted.length*.95)]};});
 assert.ok(report.mainThreadGaps.maxMs<500,JSON.stringify(report.mainThreadGaps));assert.deepEqual(report.errors,[]);report.checks.push('main process remains responsive during large durable saves');
 await page.screenshot({path:path.join(out,'large-workspace.png')});
 console.log(JSON.stringify(report));
}finally{await app?.close();fs.rmSync(dir,{recursive:true,force:true});fs.writeFileSync(path.join(out,'desktop-performance.json'),JSON.stringify(report,null,2));}})().catch(error=>{console.error(error);process.exitCode=1;});
