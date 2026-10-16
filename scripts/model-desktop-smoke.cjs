const {electron}=require('./desktop-test-support.cjs');
const { }=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {Assistant}=require('../desktop/core.cjs');const agent=require('../desktop/agent.cjs');
const output=path.resolve('artifacts/fixes');fs.mkdirSync(output,{recursive:true});
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-model-ui-'));let app,requests=0;const checks=[],errors=[];
  const server=http.createServer((req,res)=>{requests++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:null,refusal:'FIXTURE_PRIVATE_RESPONSE'},finish_reason:'stop'}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const a=new Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'本地测试服务',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture'});
    const job=agent.buildJob(a,{goal:'模型服务拦截后的暂停检查',allowWeb:false});job.nextRunAt=new Date(Date.now()+3600000).toISOString();a.data.delegations.push(job);a.save();
    app=await electron.launch({args:['.'],cwd:path.resolve(__dirname,'..'),env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir}});
    const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    const state=()=>page.evaluate(async()=>(await window.assistant.call('state')).data);
    await page.getByRole('button',{name:/^Agent 委托/}).click();await page.getByRole('button',{name:'继续推进',exact:true}).click();
    await page.waitForFunction(async()=>!(await window.assistant.call('state')).data.operation);
    await page.getByText('模型服务拦截了本次请求，已停止自动推进。请检查任务与材料；执行记录和已有产出已保留。',{exact:true}).first().waitFor();
    assert.equal((await state()).delegations[0].status,'blocked');assert.equal(await page.locator('.agent-summary p').count(),0);assert.equal(await page.locator('.version').innerText(),'v'+require('../package.json').version);assert.equal(requests,1);checks.push('服务拒绝只调用一次，委托进入需要处理');
    assert.ok(!(await page.locator('body').innerText()).includes('FIXTURE_PRIVATE_RESPONSE'));assert.equal((await state()).agentDigest.attention[0].jobId,job.id);checks.push('今日摘要显示可处理提示，不展示原始服务正文');
    await page.reload();await page.getByRole('button',{name:/^Agent 委托/}).click();assert.equal((await state()).delegations[0].status,'blocked');assert.equal((await state()).delegations[0].nextRunAt,null);checks.push('重新加载保留拦截状态和执行记录');
    await page.screenshot({path:path.join(output,'model-blocked-desktop.png'),fullPage:true});assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'model-desktop-results.json'),JSON.stringify({passed:true,checks,modelRequests:requests,rendererErrors:errors},null,2));console.log(JSON.stringify({passed:true,checks,modelRequests:requests}));
  }finally{if(app)await app.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
