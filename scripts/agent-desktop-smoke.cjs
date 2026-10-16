const {electron}=require('./desktop-test-support.cjs');
const {expect}=require('playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const root=path.resolve(__dirname,'..');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-agent-ui-'));
const artifacts=path.join(root,'artifacts/agent');fs.mkdirSync(artifacts,{recursive:true});
const materials=path.join(dir,'会议材料');const outputs=path.join(dir,'工作交付');fs.mkdirSync(materials);fs.mkdirSync(outputs);fs.writeFileSync(path.join(materials,'纪要.md'),'周五发布，请整理方案。');
const counters=new Map();let requests=0,app;const checks=[];
const respond=(tool,args={})=>({tool,args,reason:`${tool} 的真实桌面测试`});
const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const {messages}=JSON.parse(raw);requests++;
  const prompt=messages[0].content;const ctx=messages[1]?JSON.parse(messages[1].content):{};let result={ok:true};
  if(prompt.includes('动作格式')) {
    const index=counters.get(ctx.goal)||0;counters.set(ctx.goal,index+1);const taskId=ctx.tasks[0]?.id;
    const actions=[respond('read_file',{folderId:ctx.permissions.folders[0].id,name:'纪要.md'}),respond('plan_task',{key:'release',title:`发布方案 · ${ctx.goal.includes('持续')?'持续跟进':'自主交付'}`,description:'会议材料驱动',criteria:'包含发布日期，保存到产出文件夹',sourceIds:ctx.sources.map(s=>s.id),steps:[{title:'整理发布方案',kind:'draft'},{title:'保存 Markdown',kind:'external',tool:'write_file'}]}),respond('advance_task',{taskId}),respond('write_file',{taskId}),respond('advance_task',{taskId}),ctx.goal.includes('持续')?respond('wait',{reason:'等待纪要变化'}):respond('complete',{summary:'已交付'}),respond('revise_task',{taskId,note:'新材料改变了发布日期'}),respond('advance_task',{taskId}),respond('write_file',{taskId}),respond('advance_task',{taskId}),respond('complete')];
    result=actions[index]||respond('ask',{question:'测试序列结束'});
  } else if(ctx.revision&&prompt.includes('按修订要求'))result={kind:'patch',edits:[{before:'周五',after:'周六'}],summary:'使用更新的会议日期'};
  else if(prompt.includes('推进给定事项'))result={kind:'artifact',title:'发布方案',content:`# 发布方案\n${ctx.sources?.some(s=>s.content.includes('周六'))?'周六':'周五'}发布。\n请完成发布检查。`};
  else if(prompt.includes('独立'))result={passed:true,summary:'发布日期和实际产出均有证据',gaps:[]};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
});
(async()=>{
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));app=await electron.launch({args:['.'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir},timeout:60000});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'配置模型',exact:true}).waitFor();
  const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw new Error(r.error);return r.data;},{action,input});
  const state=()=>api('state');const idle=()=>expect.poll(async()=>(await state()).operation,{timeout:15000}).toBe(null);
  await api('guideDismiss');
  await api('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,inputPrice:0,outputPrice:0,name:'桌面 Agent 测试',model:'fixture',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`});
  await page.getByRole('button',{name:/^Agent 委托/}).click();await page.getByRole('button',{name:'工具与连接',exact:true}).click();
  await app.evaluate(({dialog},paths)=>{let n=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[paths[n++]]});},[materials,outputs]);
  await page.getByRole('button',{name:'添加资料文件夹',exact:true}).click();await page.getByRole('button',{name:'选择产出文件夹',exact:true}).click();
  await page.getByLabel('GitHub 仓库',{exact:true}).fill('acme/example');await page.getByRole('button',{name:'保存工具连接',exact:true}).click();assert.equal((await state()).agentSettings.githubRepo,'acme/example');checks.push('授权目录及工具设置保存');
  await page.getByRole('button',{name:'工具与连接',exact:true}).click();
  async function newJob(goal,mode='auto'){const previous=(await state()).delegations.length;await page.getByRole('button',{name:'新建委托',exact:true}).click();await page.getByLabel('委托目标',{exact:true}).fill(goal);await page.getByLabel('委托类型',{exact:true}).selectOption(goal.includes('持续')?'continuous':'one_shot');await page.getByLabel('本地产出模式',{exact:true}).selectOption(mode);await page.getByLabel('委托每批动作数').fill('12');await page.getByRole('button',{name:'开始自主推进',exact:true}).click();await expect.poll(async()=>(await state()).delegations.length).toBe(previous+1);await idle();}
  await newJob('自主整理会议材料并交付发布方案');await expect.poll(async()=>(await state()).delegations[0].status).toBe('completed');
  assert.equal(fs.readdirSync(outputs).filter(n=>!n.endsWith('-最新.md')).length,1);assert.match(fs.readFileSync(path.join(outputs,fs.readdirSync(outputs)[0]),'utf8'),/周五/);checks.push('目标→自动读文件→填事项→生成文稿→实际写入→验收');
  await page.getByRole('button',{name:/发布方案 · 自主交付/}).click();await page.getByRole('dialog',{name:'事项详情',exact:true}).waitFor();await page.getByRole('button',{name:'关闭事项详情',exact:true}).click();checks.push('自动事项与原看板详情联通');
  await newJob('持续跟进会议变化并更新发布方案');let current=(await state()).delegations[0];assert.equal(current.status,'watching');const used=current.callsUsed;
  await page.getByRole('button',{name:'立即检查来源',exact:true}).click();await idle();assert.equal((await state()).delegations[0].callsUsed,used);checks.push('来源无变化不消耗模型调用');
  await page.getByRole('button',{name:'暂停委托',exact:true}).click();await expect.poll(async()=>(await state()).delegations[0].status).toBe('paused');await page.getByRole('button',{name:'恢复委托',exact:true}).click();await expect.poll(async()=>(await state()).delegations[0].status).toBe('watching');checks.push('暂停与恢复');
  fs.writeFileSync(path.join(materials,'纪要.md'),'发布调整至周六，请更新方案。');await api('agentRun',{id:current.id});await idle();current=(await state()).delegations[0];assert.equal(current.status,'watching');assert.equal((await state()).tasks.length,2);assert.equal(fs.readdirSync(outputs).filter(n=>!n.endsWith('-最新.md')).length,3);assert.ok(fs.readdirSync(outputs).some(name=>fs.readFileSync(path.join(outputs,name),'utf8').includes('周六')));checks.push('新材料触发同一事项续办及新版本实际交付');
  await newJob('确认一次后交付会议方案','ask');const approvalJob=(await state()).delegations[0];assert.equal(approvalJob.status,'approval');assert.equal(fs.readdirSync(outputs).filter(n=>!n.endsWith('-最新.md')).length,3);await page.getByRole('button',{name:'批准此动作并继续',exact:true}).click();await expect.poll(async()=>(await state()).agentActions.find(a=>a.id===approvalJob.pendingActionId)?.approvedAt).toBeTruthy();await api('agentRun',{id:approvalJob.id});await idle();assert.equal((await state()).delegations[0].status,'completed');assert.equal(fs.readdirSync(outputs).filter(n=>!n.endsWith('-最新.md')).length,4);checks.push('具体写入确认后继续执行并交付');
  await page.reload();await page.getByRole('button',{name:/^Agent 委托/}).click();assert.equal((await state()).delegations.length,3);assert.equal((await state()).agentActions.filter(a=>a.status==='done').length,4);checks.push('重新加载保留委托、任务和动作记录');
  await page.screenshot({path:path.join(artifacts,'agent-desktop.png')});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,760));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);checks.push('1000 像素布局及无渲染异常');
  fs.writeFileSync(path.join(artifacts,'desktop-results.json'),JSON.stringify({passed:true,checks,modelRequests:requests,rendererErrors:errors},null,2));console.log(JSON.stringify({passed:true,checks,modelRequests:requests}));
})().catch(async error=>{console.error(error);if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(artifacts,'failure.png')});const r=await page.evaluate(async()=> (await window.assistant.call('state')).data);fs.writeFileSync(path.join(artifacts,'failed-state.json'),JSON.stringify(r,null,2));}process.exitCode=1;}).finally(async()=>{if(app)await app.close();await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});});
