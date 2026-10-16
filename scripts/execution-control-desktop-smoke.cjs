const {electron}=require('./desktop-test-support.cjs');
// Isolated development fixture; never connects to the user's workspace or providers.
const {expect}=require('playwright/test'),assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const root=path.resolve(__dirname,'..'),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-control-ui-'))),out=path.join(root,'artifacts/execution-control-2026-10-15');
const input=path.join(dir,'input'),output=path.join(dir,'output');fs.mkdirSync(input);fs.mkdirSync(output);fs.writeFileSync(path.join(input,'input.md'),'发布日期：周五，负责人：李青。');
let app,calls=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const {messages}=JSON.parse(raw),system=messages[0].content,ctx=JSON.parse(messages[1].content);let result;
 if(system.includes('动作格式')){const task=ctx.tasks[0];calls.push('plan');if(!ctx.sources.length)result={tool:'read_file',args:{folderId:ctx.permissions.folders[0].id,name:'input.md'}};else if(!task)result={tool:'plan_task',args:{key:'doc',title:'发布说明',description:'整理会议事实',criteria:'包含日期和负责人，并交付文件',sourceIds:ctx.sources.map(s=>s.id),steps:[{key:'draft',title:'写稿',kind:'draft'},{key:'save',title:'保存文件',kind:'external',tool:'write_file'}]}};else if(task.steps.some(s=>!s.done&&s.kind==='draft'))result={tool:'advance_task',args:{taskId:task.id}};else if(task.steps.some(s=>!s.done&&s.kind==='external'))result={tool:'write_file',args:{taskId:task.id}};else result={tool:'read_source',args:{sourceId:ctx.sources[0].id}};
 }else if(system.includes('推进给定事项')){calls.push('draft');result={kind:'artifact',title:'发布说明',content:'# 发布说明\n\n周五发布。负责人：李青。'};}
 else {calls.push(system.includes('当前文稿内容')?'content':system.includes('整体委托')?'goal':'result');result={passed:true,summary:'事实与实际文件一致',gaps:[]};}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:20}}));});
fs.mkdirSync(out,{recursive:true});
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));app=await electron.launch({args:['.'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir},timeout:60000});const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});await expect.poll(async()=>!!await page.evaluate(()=>window.assistant)).toBe(true);
 await api('guideDismiss');await api('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'本地测试模型',model:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,inputPrice:1,outputPrice:2});
 // Seed only the isolated fixture's folder grants before creating its test job.
 await app.evaluate(async({dialog},paths)=>{let i=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[paths[i++]]});},[input,output]);
 await page.getByRole('button',{name:/^Agent 委托/}).click();await page.getByRole('button',{name:'工具与连接',exact:true}).click();await page.getByRole('button',{name:'添加资料文件夹',exact:true}).click();await page.getByRole('button',{name:'选择产出文件夹',exact:true}).click();
 const config=await api('state'),folderId=config.agentSettings.folderIds?.[0]||config.folders[0]?.id;assert.ok(folderId);
 // Use the generated folder ID in the mock's action, preserving real permission checks.
 assert.equal(config.folders.find(f=>f.id===folderId).path,input);
 const create=await api('agentCreate',{goal:'根据会议资料整理发布说明并写入指定目录',folderIds:[folderId],useOutputFolder:true,fileMode:'auto',autoAccept:false,maxActions:12});
 await expect.poll(async()=>(await api('state')).operation,{timeout:45000}).toBe(null);
 let state=await api('state');const job=state.delegations[0];assert.equal(job.status,'review',job.summary+' '+job.lastError);assert.deepEqual(calls,['plan','plan','plan','draft','content','plan','result','goal']);assert.equal(state.agentActions.filter(r=>r.status==='done').length,1);
 const summary=page.getByRole('region',{name:'实际推进状态'});await expect(summary).toBeVisible();await expect(summary).toContainText('最近动作');await expect(summary).toContainText('等待验收');
 assert.equal(job.progressSummary.lastAction.tool,'complete');assert.equal(job.progressSummary.lastProgress.tool,'advance_task');assert.equal(state.spendStatus.scopes.find(s=>s.key==='job:'+job.id).limitUSD,100);
 await page.screenshot({path:path.join(out,'desktop-progress.png'),fullPage:true});await page.reload();await page.getByRole('button',{name:/^Agent 委托/}).click();await expect(page.getByRole('region',{name:'实际推进状态'})).toBeVisible();assert.equal((await api('state')).delegations[0].status,'review');assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'desktop-check.json'),JSON.stringify({version:require('../package.json').version,calls,checks:['local file collection','automatic draft/content/delivery/result/goal stages','real file receipt','progress UI','original budget','reload persistence'],realModelCalls:0,errors},null,2));console.log('Execution controller desktop flow passed.');
 }finally{await app?.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
