// Real renderer/IPC -> model HTTP adapters, with only loopback model services.
const {electron} = require('./desktop-test-support.cjs');
const {navigate} = require('./navigation-helper.cjs');
const {expect} = require('playwright/test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..'), out = process.env.MODEL_ACCESS_REPORT_DIR || path.join(root,'artifacts/model-access-20261016');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-providers-ui-')));
const requests = [], errors = [], checks = [];
let app;
const server = http.createServer(async(req,res) => {
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString(); requests.push({method:req.method,url:req.url,body:raw?JSON.parse(raw):null});
  const kind=req.url.split('/')[1],model=kind+'-fixture';
  let answer;
  if(req.method==='GET') answer=kind==='gemini'?{models:[{name:'models/'+model,supportedGenerationMethods:['generateContent']}]}:kind==='ollama'?{models:[{name:model}]}:{data:[{id:model}]};
  else if(kind==='anthropic')answer={content:[{type:'text',text:'{"ok":true}'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:3}};
  else if(kind==='gemini')answer={candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:3}};
  else if(kind==='responses')answer={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:10,output_tokens:3}};
  else if(kind==='ollama')answer={done:true,message:{content:'{"ok":true}'},prompt_eval_count:10,eval_count:3};
  else answer={choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}],usage:{prompt_tokens:10,completion_tokens:3}};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(answer));
});
(async()=>{try {
  fs.mkdirSync(out,{recursive:true}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  app=await electron.launch({args:['.'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir,DESKTOP_TEST_REPORT_DIR:out}});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
  await navigate(page,'模型与设置');
  for(const [preset,type,route] of [['deepseek','openai','deepseek/v1'],['kimi','openai','kimi/v1'],['claude','anthropic','anthropic/v1'],['gemini','gemini','gemini/v1beta'],['openai','responses','responses/v1'],['ollama','ollama','ollama'],['azure','azure','azure/openai/v1']]) {
    await page.getByRole('button',{name:'添加模型',exact:true}).click();
    const modal=page.getByRole('dialog',{name:'连接你的模型',exact:true});
    await modal.getByLabel('服务商预设',{exact:true}).selectOption(preset);await expect(modal.getByLabel('接口类型',{exact:true})).toHaveValue(type);
    await modal.getByLabel('服务地址',{exact:true}).fill(base+'/'+route);await modal.getByLabel('API Key',{exact:true}).fill('SYNTHETIC_UI_TOKEN');
    await modal.getByRole('button',{name:'读取模型列表',exact:true}).click();
    await modal.getByLabel('服务返回的模型',{exact:true}).selectOption(route.split('/')[0]+'-fixture');
    await expect(modal.getByLabel('模型名称',{exact:true})).toHaveValue(route.split('/')[0]+'-fixture');
    // A model absent from the fetched list is still a valid manual choice.
    if(preset==='kimi')await modal.getByLabel('模型名称',{exact:true}).fill('kimi-new-open-model');
    await modal.getByLabel('配置名称',{exact:true}).fill('测试 '+preset);
    await modal.getByLabel('输入单价',{exact:true}).fill('0');await modal.getByLabel('输出单价',{exact:true}).fill('0');
    if(preset==='deepseek') {
      await modal.locator('summary').filter({hasText:'高级接口设置'}).click();
      await modal.getByLabel('最大输出 token',{exact:true}).fill('8192');
      await modal.getByLabel('高级生成参数',{exact:true}).fill('{"thinking":{"type":"enabled"}}');
    }
    if(preset==='claude'){await page.getByRole('dialog').locator('.modal-body').evaluate(el=>{document.activeElement?.blur();el.scrollTop=0;});await page.screenshot({path:path.join(out,'provider-claude.png'),animations:'disabled'});}
    await modal.getByRole('button',{name:'保存模型',exact:true}).click();await expect(modal).toHaveCount(0);
    const card=page.locator('.provider').filter({has:page.getByRole('heading',{name:'测试 '+preset,exact:false})});
    await card.getByRole('button',{name:'测试连接',exact:true}).click();await expect(card).toContainText('已连接');
    checks.push(preset+': 选择预设 → 读取模型 → 保存 → 实际 HTTP 测试连接');
  }
  const state=await api('state');assert.equal(state.providers.length,7);assert.equal(state.modelCalls.length,7);assert.ok(state.modelCalls.every(r=>r.status==='done'&&r.usageReported));
  assert.ok(!JSON.stringify(state).includes('SYNTHETIC_UI_TOKEN'));
  const deepseek=state.providers.find(p=>p.name==='测试 deepseek');assert.deepEqual(deepseek.extraBody,{thinking:{type:'enabled'}});assert.equal(deepseek.maxOutputTokens,8192);
  const kimi=state.providers.find(p=>p.name==='测试 kimi');await page.getByLabel('事项推进模型',{exact:true}).selectOption(kimi.id);
  await expect.poll(async()=>(await api('state')).settings.roles.execute).toBe(kimi.id);
  await page.getByRole('button',{name:'编辑 测试 deepseek',exact:true}).click();
  const edit=page.getByRole('dialog',{name:'编辑模型配置',exact:true});await expect(edit.getByLabel('API Key',{exact:true})).toHaveValue('');
  await edit.locator('summary').filter({hasText:'高级接口设置'}).click();await expect(edit.getByLabel('最大输出 token',{exact:true})).toHaveValue('8192');
  await edit.getByLabel('高级生成参数',{exact:true}).fill('{"tools":[]}');await edit.getByRole('button',{name:'保存模型',exact:true}).click();
  await expect(edit.getByRole('alert')).toContainText('不能覆盖');
  await edit.getByRole('button',{name:'取消',exact:true}).click();
  await page.screenshot({path:path.join(out,'provider-settings.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);checks.push('自定义 Kimi 模型 ID、角色分配、加密密钥回显、编辑保留与非法参数校验');
  const result={passed:true,checks,rendererErrors:errors,modelHTTPCalls:requests.filter(r=>r.method==='POST').length,modelListCalls:requests.filter(r=>r.method==='GET').length,liveProviderCalls:0};
  fs.writeFileSync(path.join(out,'desktop-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error) {fs.writeFileSync(path.join(out,'desktop-results.json'),JSON.stringify({passed:false,checks,error:error.stack},null,2));throw error;}
finally {if(app)await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
