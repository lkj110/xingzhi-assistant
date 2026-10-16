const {electron}=require('./desktop-test-support.cjs');
const {navigate}=require('./navigation-helper.cjs');
const {  expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'artifacts/audit');fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-gui-audit-'));
const checks=[];let app;
const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const {messages}=JSON.parse(raw);const prompt=messages[0].content;const c=messages[1]?JSON.parse(messages[1].content):{};
  let result={ok:true};
  if(prompt.includes('推进给定事项'))result={kind:'artifact',title:'UI 测试产出',content:'# 实际导出测试\n周五发布。'};
  if(prompt.includes('独立检查'))result={passed:true,summary:'测试通过',gaps:[]};
  if(c.task?.description==='slow')await new Promise(r=>setTimeout(r,5000));
  if(c.task?.description==='failure'){res.writeHead(503);res.end('unavailable');return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
});
(async()=>{
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${mock.address().port}/v1`;
  app=await electron.launch({args:['.'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir},timeout:60000});
  const page=await app.firstWindow();page.setDefaultTimeout(12000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.getByRole('button',{name:'配置模型',exact:true}).waitFor();
  const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw new Error(r.error);return r.data;},{action,input});
  const state=()=>api('state');
  const idle=()=>expect.poll(async()=>(await state()).operation,{timeout:15000}).toBe(null);
  const closeDrawer=async()=>{const b=page.getByRole('button',{name:'关闭事项详情',exact:true});if(await b.count())await b.click();};
  const board=async()=>{await closeDrawer();await navigate(page,'工作看板');};
  const check=async(name,fn)=>{try{await fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});await page.screenshot({path:path.join(output,`failure-${checks.length}.png`)});process.stdout.write(e.message.slice(0,450)+'\n');const close=page.getByRole('button',{name:'关闭',exact:true});if(await close.count())await close.click();await closeDrawer();}process.stdout.write(`${checks.at(-1).passed?'PASS':'FAIL'} ${name}\n`);};
  await api('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'UI 模型 A',model:'fixture',baseUrl:base});

  await check('B13 自动产生的跟进时间即时显示在详情输入框',async()=>{
    const result=await api('createTask',{title:'等待外部确认',steps:[{title:'联系同事',kind:'external'}]});
    await board();await page.getByRole('button').filter({has:page.getByRole('heading',{name:'等待外部确认',exact:true})}).click();
    await page.getByRole('button',{name:'推进下一步',exact:true}).click();await page.getByLabel('下次跟进时间').waitFor();
    assert.ok(await page.getByLabel('下次跟进时间').inputValue(),'跟进日期已保存，但输入框显示为空');
    const value='2030-01-01T10:30';await page.getByLabel('下次跟进时间').fill(value);await page.getByRole('button',{name:'保存',exact:true}).click();
    assert.equal(new Date((await state()).tasks.find(t=>t.id===result.tasks[0].id).nextCheckAt).getFullYear(),2030);
  });
  await check('B14 看板列切换列表保留该列的全部状态',async()=>{
    await closeDrawer();const a=await api('createTask',{title:'暂停的事项'});await api('taskAction',{id:a.tasks[0].id,command:'pause'});
    const b=await api('createTask',{title:'模型失败的事项',description:'failure'});await api('advance',{id:b.tasks[0].id});await idle();
    await board();await page.getByRole('button',{name:'在待推进查看全部',exact:true}).click();
    await page.getByRole('button').filter({has:page.getByText('暂停的事项',{exact:true})}).waitFor();
    await page.getByRole('button').filter({has:page.getByText('模型失败的事项',{exact:true})}).waitFor();
  });
  await check('手动新建、编辑、搜索及暂停恢复',async()=>{
    await board();const savedRoles=(await state()).settings.roles;await api('settings',{roles:{organize:'',execute:'',verify:''}});await page.getByRole('button',{name:'新建事项',exact:true}).click();await page.getByLabel('事项原文').fill('手动创建的验证事项');await page.getByRole('button',{name:'暂不配置，手动创建',exact:true}).click();await page.getByLabel('事项标题').fill('手动创建的验证事项');await page.getByLabel('完成标准',{exact:true}).fill('包含具体结论');await page.getByRole('button',{name:'创建事项',exact:true}).click();
    await api('settings',{roles:savedRoles});await page.getByLabel('搜索事项').fill('手动创建');await page.getByRole('button').filter({has:page.getByText('手动创建的验证事项',{exact:true})}).click();
    await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('事项标题').fill('编辑后的验证事项');await page.getByRole('dialog',{name:'编辑事项',exact:true}).locator('select').selectOption('high');await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await page.getByRole('heading',{name:'编辑后的验证事项',exact:true}).waitFor();await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByRole('button',{name:'恢复事项',exact:true}).click();await page.getByRole('button',{name:'推进下一步',exact:true}).waitFor();await closeDrawer();
  });
  await check('四种文本格式导入、非法格式报错及重复去重',async()=>{
    await navigate(page,'信息收件箱');await page.getByRole('button',{name:'添加材料',exact:true}).first().click();
    const files=['md','txt','json','csv'].map(ext=>{const file=path.join(dir,`材料.${ext}`);fs.writeFileSync(file,`测试 ${ext} 内容`);return file;});
    await page.getByLabel('导入材料文件').setInputFiles(files);await page.getByRole('button',{name:'保存材料',exact:true}).click();await page.getByRole('dialog',{name:'把信息交给助手',exact:true}).waitFor({state:'hidden'});assert.equal((await state()).sources.length,4);
    await page.getByRole('button',{name:'添加材料',exact:true}).first().click();await page.getByLabel('导入材料文件').setInputFiles(files[0]);await page.getByRole('button',{name:'保存材料',exact:true}).click();await page.getByRole('dialog',{name:'把信息交给助手',exact:true}).waitFor({state:'hidden'});assert.equal((await state()).sources.length,4);
    await page.getByRole('button',{name:'添加材料',exact:true}).first().click();const bad=path.join(dir,'不支持.doc');fs.writeFileSync(bad,'not PDF');await page.getByLabel('导入材料文件').setInputFiles(bad);await page.getByText(/不支持 不支持.doc/).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
  });
  await check('模型角色、自动化开关、频率和工作偏好保存',async()=>{
    await page.getByRole('button',{name:'模型与设置',exact:true}).click();await page.getByRole('button',{name:'添加模型',exact:true}).click();await page.getByLabel('接口类型').selectOption('openai');await page.getByLabel('配置名称').fill('UI 模型 B');await page.getByLabel('服务地址').fill(base);await page.getByLabel('模型名称').fill('fixture-b');await page.getByLabel('请求 JSON 输出模式').uncheck();await page.getByLabel('输入单价',{exact:true}).fill('0');await page.getByLabel('缓存输入单价',{exact:true}).fill('0');await page.getByLabel('输出单价',{exact:true}).fill('0');await page.getByRole('button',{name:'保存模型',exact:true}).click();
    const id=(await state()).providers.find(p=>p.name==='UI 模型 B').id;await page.getByLabel('结果检查模型').selectOption(id);await page.getByLabel('自动推进间隔').selectOption('30');assert.equal(await page.getByLabel('每轮最多推进').count(),0);await page.getByLabel('我的工作偏好').fill('先给结论，注明依据');await page.getByRole('button',{name:'保存偏好',exact:true}).click();
    await page.getByRole('switch',{name:'开启自动推进',exact:true}).click();await page.getByRole('switch',{name:'检查通过后自动完成',exact:true}).click();await page.getByRole('switch',{name:'开启自动推进',exact:true}).click();
    const s=await state();assert.equal(s.settings.automatic,false);assert.equal(s.settings.autoComplete,true);assert.equal(s.settings.intervalMinutes,30);assert.equal(s.settings.profile,'先给结论，注明依据');assert.equal(s.settings.roles.verify,id);assert.equal(s.providers.find(p=>p.id===id).jsonMode,false);
    await api('settings',{autoComplete:false});
  });
  await check('本地文件夹选择、同步、重复检查及取消同步',async()=>{
    const folder=path.join(dir,'授权材料目录');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'新增.txt'),'文件夹里的独立内容');
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);
    const previous=(await state()).sources.length;await page.getByRole('button',{name:'添加文件夹',exact:true}).click();await page.getByRole('button',{name:'立即同步',exact:true}).click();assert.equal((await state()).sources.length,previous+1);
    await page.getByRole('button',{name:'取消同步 授权材料目录',exact:true}).click();assert.equal((await state()).folders.length,0);
  });
  await check('完整工作空间导出不含模型密钥',async()=>{
    const target=path.join(dir,'backup.json');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},target);
    await page.getByRole('button',{name:'导出数据（不含密钥）',exact:true}).click();await page.waitForTimeout(100);const data=JSON.parse(fs.readFileSync(target,'utf8'));assert.ok(data.sources.length>=4);assert.equal(JSON.stringify(data).includes('sealedKey'),false);
  });
  await check('停止当前推进后不生成虚假完成记录',async()=>{
    const result=await api('createTask',{title:'可以停止的事项',description:'slow'});const id=result.tasks[0].id;await api('advance',{id});await page.getByRole('button',{name:/^停止(本轮|全部推进)$/}).waitFor();await page.getByRole('button',{name:/^停止(本轮|全部推进)$/}).click();await idle();const s=await state();assert.equal(s.tasks.find(t=>t.id===id).status,'blocked');assert.equal(s.artifacts.filter(a=>a.taskId===id).length,0);
  });
  await check('Markdown 产出查看与实际下载',async()=>{
    const result=await api('createTask',{title:'导出产出的事项'});const id=result.tasks[0].id;await api('advance',{id});await idle();await page.getByRole('button',{name:/^工作产出/}).click();await page.locator('.result-card').filter({has:page.getByRole('heading',{name:'导出产出的事项',exact:true})}).getByRole('button',{name:/打开当前成果/}).click();
    const target=path.join(dir,'export.md');await app.evaluate(({session},target)=>{globalThis.auditDownload=null;session.defaultSession.once('will-download',(_event,item)=>{item.setSavePath(target);item.once('done',(_event,state)=>{globalThis.auditDownload=state;});});},target);
    await page.getByRole('button',{name:'导出 Markdown',exact:true}).click();await expect.poll(()=>app.evaluate(()=>globalThis.auditDownload),{timeout:12000}).toBe('completed');assert.ok(fs.readFileSync(target,'utf8').includes('周五发布'));await page.getByRole('button',{name:'关闭',exact:true}).click();
  });
  await check('模型编辑、删除确认及受影响的自动推进暂停',async()=>{
    await page.getByRole('button',{name:'模型与设置',exact:true}).click();await page.getByRole('button',{name:'编辑 UI 模型 B',exact:true}).click();await page.getByLabel('配置名称').fill('编辑后的模型 B');await page.getByRole('button',{name:'保存模型',exact:true}).click();
    await page.getByRole('switch',{name:'开启自动推进',exact:true}).click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除 编辑后的模型 B',exact:true}).click();
    await expect.poll(async()=>(await state()).providers.length).toBe(1);const s=await state();assert.equal(s.settings.automatic,false);assert.equal(s.settings.roles.verify,'');await page.getByLabel('结果检查模型').selectOption(s.providers[0].id);
  });
  await check('手动粘贴、来源内容查看及推进记录',async()=>{
    await navigate(page,'信息收件箱');await page.getByRole('button',{name:'添加材料',exact:true}).first().click();await page.getByLabel('材料标题',{exact:true}).fill('粘贴的会议记录');await page.getByLabel('内容',{exact:true}).fill('需要确认下一版发布时间。');await page.getByRole('button',{name:'保存材料',exact:true}).click();
    await page.getByRole('button').filter({has:page.getByRole('heading',{name:'粘贴的会议记录',exact:true})}).click();await page.getByRole('dialog').locator('pre').filter({hasText:'需要确认下一版发布时间。'}).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();await navigate(page,'推进记录');await page.getByText('保存模型配置',{exact:true}).first().waitFor();
  });
  await check('窄桌面布局、重新加载和后台窗口行为',async()=>{
    await board();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,760));await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const count=(await state()).tasks.length;await page.reload();await page.getByRole('button',{name:/^工作看板/}).waitFor();assert.equal((await state()).tasks.length,count);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());assert.deepEqual(pageErrors,[]);
  });
  await page.screenshot({path:path.join(output,'desktop-audit.png')});
})().catch(error=>{checks.push({name:'测试环境',passed:false,error:error.stack});}).finally(async()=>{
  if(app)await app.close();await new Promise(resolve=>mock.close(resolve));fs.rmSync(dir,{recursive:true,force:true});
  const report={at:new Date().toISOString(),passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks};fs.writeFileSync(path.join(output,process.env.AUDIT_REPORT||'desktop-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.failed)process.exitCode=1;
});
