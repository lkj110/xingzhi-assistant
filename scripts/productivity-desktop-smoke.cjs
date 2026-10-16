const {electron}=require('./desktop-test-support.cjs');
const {navigate}=require('./navigation-helper.cjs');
const {expect} = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),path = require('node:path'),os = require('node:os');
const root = path.resolve(__dirname,'..'),out = path.join(root,'artifacts/productivity');fs.mkdirSync(out,{recursive:true});
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-productivity-ui-')),checks = [],errors = [];let app;
(async () => {try {
  app = await electron.launch({timeout:20000,args:['scripts/productivity-fixture.cjs'],cwd:root,env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir}});
  const page = await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error => errors.push(error.message));
  const api = (action,input={}) => page.evaluate(async ({action,input}) => {const response = await window.assistant.call(action,input);if(response.error)throw new Error(response.error);return response.data;},{action,input});
  await navigate(page,'工作方案');await expect(page.getByRole('article')).toHaveCount(4);
  await page.getByRole('button',{name:'使用方案 专题调研与比较',exact:true}).click();
  await page.getByLabel('方案变量主题').fill('桌面方案验收');await page.getByLabel('方案变量要求').fill('附来源，生成简短报告');await page.getByRole('button',{name:'预览本次目标',exact:true}).click();
  await expect(page.getByLabel('工作方案预览')).toContainText('桌面方案验收');await page.getByLabel('方案变量要求').fill('更新后的要求');await expect(page.getByRole('button',{name:'选择资料并委托',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'预览本次目标',exact:true}).click();await page.getByRole('button',{name:'选择资料并委托',exact:true}).click();
  await expect(page.getByLabel('委托目标',{exact:true})).toContainText('更新后的要求');await expect(page.getByLabel('隔离资料目录',{exact:true})).not.toBeChecked();await expect(page.getByLabel(/允许读取公网网页/)).not.toBeChecked();
  await expect(page.getByLabel('本地产出模式')).toHaveValue('off');await expect(page.getByLabel('GitHub 接入模式')).toHaveValue('disabled');
  await page.getByRole('button',{name:'开始自主推进',exact:true}).click();await expect.poll(async () => (await api('state')).delegations.some(j => j.goal.includes('桌面方案验收'))).toBe(true);
  const created = (await api('state')).delegations.find(j => j.goal.includes('桌面方案验收'));assert.deepEqual(created.folderIds,[]);assert.equal(created.outputFolder,'');assert.equal(created.githubRepo,'');assert.equal(created.allowWeb,false);
  checks.push('方案变量预览、修改后重审、进入委托与授权范围清空');

  await navigate(page,'工作方案');await page.getByRole('button',{name:'复制方案 专题调研与比较',exact:true}).click();
  await page.getByRole('button',{name:'编辑方案 专题调研与比较（副本）',exact:true}).click();await page.getByLabel('方案名称',{exact:true}).fill('桌面自定义方案');await page.getByLabel('方案跟进间隔').fill('17');await page.getByRole('button',{name:'保存工作方案',exact:true}).click();
  await page.getByRole('button',{name:'归档方案 桌面自定义方案',exact:true}).click();await expect(page.getByRole('heading',{name:'桌面自定义方案',exact:true})).toHaveCount(0);
  await page.getByLabel('工作方案筛选').selectOption('archived');await page.getByRole('button',{name:'恢复方案 桌面自定义方案',exact:true}).click();await page.getByLabel('工作方案筛选').selectOption('active');await page.getByRole('heading',{name:'桌面自定义方案',exact:true}).waitFor();
  const restored = (await api('state')).playbooks.find(p => p.title==='桌面自定义方案');assert.equal(restored.revision,4);assert.equal(restored.intervalMinutes,17);
  const sourceJob = (await api('state')).delegations.find(j => j.goal==='整理北辰发布计划');await page.getByLabel('提炼方案的委托').selectOption(sourceJob.id);await page.getByRole('button',{name:'提炼为方案',exact:true}).click();await expect(page.getByLabel('方案处理方法')).toContainText('包含日期、负责人和风险');await page.getByRole('button',{name:'关闭工作方案',exact:true}).click();
  await page.screenshot({path:path.join(out,'playbooks-desktop.png'),animations:'disabled'});checks.push('内置方案复制、编辑、归档恢复、任意间隔保存及从委托提炼');

  await navigate(page,'工作记忆');await page.getByLabel('记忆标题').fill('先列风险');await page.getByLabel('记忆内容').fill('所有报告先列风险，再列进展。');await page.getByRole('button',{name:'确认并保存记忆',exact:true}).click();
  const memoryCard = page.getByRole('article').filter({has:page.getByRole('heading',{name:'先列风险',exact:true})});await expect(memoryCard).toContainText('当前生效');await memoryCard.getByRole('button',{name:'停用',exact:true}).click();await expect(memoryCard).toContainText('已停用');await memoryCard.getByRole('button',{name:'启用',exact:true}).click();await expect(memoryCard).toContainText('当前生效');
  await memoryCard.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('记忆内容').fill('先列风险，再列负责人和进展。');await page.getByRole('button',{name:'确认并保存记忆',exact:true}).click();await expect(memoryCard).toContainText('负责人');checks.push('工作记忆新增、停用、启用与修订');
  await page.getByText('从已回答的问题整理',{exact:true}).click();await page.getByLabel('选择已回答的决定').selectOption('fixture-decision');await page.getByRole('button',{name:'填写为草稿',exact:true}).click();await expect(page.getByLabel('记忆内容')).toHaveValue('采用 4500 元预算');await page.getByRole('button',{name:'确认并保存记忆',exact:true}).click();
  const state = await api('state'),scoped = state.memories.find(m => m.originDecisionId==='fixture-decision');assert.equal(scoped.projectId,state.projects.find(p => p.name==='北辰发布').id);
  const oldSource = state.sources.find(s => s.id===scoped.sourceId);await api('import',{items:[{title:oldSource.title,content:'修订的预算是 4600 元。',projectId:scoped.projectId}]});await page.getByRole('button',{name:'刷新工作空间'}).click();
  await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'北辰采用哪个预算？',exact:true})})).toContainText('新版本');await page.screenshot({path:path.join(out,'memory-desktop.png'),animations:'disabled'});checks.push('已回答决定生成项目记忆，来源更新后停止采用');

  await page.getByRole('button',{name:/^全局检索/}).click();await page.getByLabel('全局检索关键词').fill('南风旧版');await expect(page.getByRole('heading',{name:'没有找到相关内容',exact:true})).toBeVisible();await page.getByLabel('包含历史与已失效内容').check();await expect.poll(async () => page.locator('.library-result').count()).toBe(2);
  await page.getByLabel('包含历史与已失效内容').uncheck();await page.getByLabel('全局检索关键词').fill('4600');await page.getByLabel('检索内容类型').selectOption('source');await expect(page.locator('.library-result')).toHaveCount(1);await page.locator('.library-result').click();await expect(page.getByRole('dialog')).toContainText('北辰会议材料');await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByLabel('检索内容类型').selectOption('memory');await page.getByLabel('全局检索关键词').fill('先列风险');await expect(page.locator('.library-result h3')).toHaveText('先列风险');await page.screenshot({path:path.join(out,'library-desktop.png'),animations:'disabled'});await page.locator('.library-result').click();await page.getByRole('heading',{name:'工作记忆',exact:true}).waitFor();
  await page.getByRole('button',{name:'来源：北辰会议材料',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('北辰会议材料');await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:/^全局检索/}).click();await page.getByLabel('检索内容类型').selectOption('project');await page.getByLabel('检索所属项目').selectOption(scoped.projectId);await page.getByLabel('全局检索关键词').fill('北辰发布');await expect(page.locator('.library-result h3')).toHaveText('北辰发布');await page.locator('.library-result').click();await expect(page.locator('.agent-detail>header h2')).toHaveText('北辰发布');
  await page.getByRole('button',{name:/^全局检索/}).click();await page.getByLabel('检索内容类型').selectOption('artifact');await page.getByLabel('包含历史与已失效内容').check();await page.getByLabel('全局检索关键词').fill('北辰交付报告');await expect(page.locator('.library-result h3')).toHaveText('北辰交付报告');await page.locator('.library-result').click();await expect(page.getByRole('dialog')).toContainText('预算 4500');await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByLabel('检索内容类型').selectOption('task');await page.getByLabel('全局检索关键词').fill('北辰发布报告');await expect(page.locator('.library-result h3')).toHaveText('北辰发布报告');await page.locator('.library-result').click();await expect(page.getByRole('dialog',{name:'事项详情'})).toContainText('包含日期、负责人和风险');await page.getByRole('button',{name:'关闭事项详情',exact:true}).click();
  checks.push('完整文本检索、历史与项目筛选、材料/项目/产出/事项/记忆回跳及记忆来源预览');
  assert.deepEqual(errors,[]);const report = {passed:true,checks,rendererErrors:errors};fs.writeFileSync(path.join(out,'desktop-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch (error) {
  fs.writeFileSync(path.join(out,'desktop-results.json'),JSON.stringify({passed:false,checks,rendererErrors:errors,error:error.stack},null,2));throw error;
} finally {if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(error => {console.error(error);process.exitCode=1;});
