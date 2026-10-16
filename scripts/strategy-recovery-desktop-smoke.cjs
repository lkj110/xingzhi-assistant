const {electron}=require('./desktop-test-support.cjs');
const {expect}=require('playwright/test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'..'),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-strategy-ui-'))),out=path.join(root,'artifacts/strategy-recovery-desktop');
let app,reads=0,drafts=0,modelCalls=0;const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const {messages}=JSON.parse(raw),system=messages[0].content,ctx=JSON.parse(messages[1].content);modelCalls++;let result;
 if(system.includes('动作格式')){const task=ctx.tasks[0];if(!task)result={tool:'plan_task',args:{key:'report',title:'订单报告',description:'使用用户已提供事实',criteria:'包含周五发布日期',steps:[{key:'draft',title:'生成正文',kind:'draft'}]}};else {reads++;result={tool:'read_output_state',args:{taskId:task.id}};}}
 else if(system.includes('推进给定事项')){drafts++;result={kind:'artifact',title:'订单报告',content:'# 订单报告\n\n订单于周五发布。',summary:'已完成当前正文'};}
 else result={passed:true,summary:'符合用户事实和要求',gaps:[]};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:20}}));});
fs.mkdirSync(out,{recursive:true});
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));app=await electron.launch({args:['.'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir},timeout:60000});const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
 await expect.poll(async()=>!!await page.evaluate(()=>window.assistant)).toBe(true);await api('guideDismiss');await api('saveProvider',{name:'本地模拟模型',model:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,inputPrice:0,outputPrice:0});
 await page.getByRole('button',{name:/^Agent 委托/}).click();await api('agentCreate',{goal:'已知订单在周五发布，根据该事实整理报告',autoAccept:false,maxActions:12});
 await expect.poll(async()=>(await api('state')).delegations[0]?.status,{timeout:60000}).toBe('review');const state=await api('state'),job=state.delegations[0];
 assert.equal(reads,3);assert.equal(drafts,1);assert.equal(state.decisions.filter(d=>d.status==='open').length,0);assert.notEqual(job.executionPaused,true,'recovery must not introduce a user pause');assert.equal(state.agentRuns.filter(r=>r.recovery).length,1);assert.ok(state.agentRuns.some(r=>r.steps.some(s=>s.strategyRecovery)));assert.equal(state.spendStatus.scopes.find(s=>s.key==='job:'+job.id).limitUSD,100);
 await page.getByText('运行记录',{exact:true}).scrollIntoViewIfNeeded();await page.locator('details.agent-run').last().locator('summary').first().click();await expect(page.locator('details.agent-run').last().getByText('正在自动纠偏：诊断重复原因，切换执行方式后继续推进',{exact:true})).toBeVisible();assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({version:require('../package.json').version,passed:true,reads,drafts,modelCalls,realModelCalls:0,status:job.status,checks:['automatic loop recovery without resume click','actual artifact generated','verification retained','recovery run UI','original budget preserved'],errors},null,2));console.log('Automatic strategy correction desktop flow passed.');
 }finally{await app?.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
