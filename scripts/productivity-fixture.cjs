// Isolated data and mocked transport for native desktop tests.
const path = require('node:path');
const fs = require('node:fs');
const dir = process.env.ASSISTANT_TEST_DATA_DIR;
if (!dir) throw new Error('Test directory required');
const core = require('../desktop/core.cjs');
const agent = require('../desktop/agent.cjs');
const Base = core.Assistant;
core.Assistant = class extends Base {
  constructor(options) {super({...options,chat:async () => ({tool:'ask',args:{key:'fixture',question:'桌面测试已收到委托',suggestion:'确认本次目标即可'}}),agentRequest:async () => {throw new Error('桌面测试不能访问外部服务');},connectorRequest:async () => {throw new Error('桌面测试不能访问外部服务');}});}
  tick() {}
};
(async () => {
  const a = new core.Assistant({dir:path.join(dir,'workspace')});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'测试模型',model:'fixture',baseUrl:'https://example.invalid/v1'});
  fs.mkdirSync(path.join(dir,'authorized'),{recursive:true});fs.mkdirSync(path.join(dir,'deliveries'),{recursive:true});
  a.data.folders.push({id:'fixture-folder',name:'隔离资料目录',path:path.join(dir,'authorized')});
  a.data.agentSettings.outputFolder = path.join(dir,'deliveries');a.data.agentSettings.githubRepo = 'fixture/private-repository';
  await a.dispatch('projectSave',{name:'北辰发布',background:'用于测试个人工作管理'});
  const p = a.data.projects[0];
  await a.dispatch('import',{items:[{title:'北辰会议材料',content:'历史暗号：南风旧版。预算 3500。',projectId:p.id}]});const oldSource = a.data.sources[0];
  await a.dispatch('import',{items:[{title:'北辰会议材料',content:'当前暗号：北辰新约。预算 4500。发布负责人为陈明。',projectId:p.id}]});const currentSource = a.data.sources[0];currentSource.previousSourceId = oldSource.id;currentSource.version = 2;
  const job = agent.buildJob(a,{projectId:p.id,goal:'整理北辰发布计划',allowWeb:false,fileMode:'off'});job.sourceIds = [oldSource.id,currentSource.id];a.data.delegations.push(job);p.jobId = job.id;
  const planned = await agent.act(a,job,'plan_task',{key:'report',title:'北辰发布报告',criteria:'包含日期、负责人和风险',sourceIds:[currentSource.id],steps:[{key:'draft',kind:'draft',title:'形成报告'}]});
  const task = a.task(planned.taskId);task.status = 'paused';task.steps[0].done = true;task.steps[0].artifactId = 'fixture-current-artifact';
  a.data.artifacts.push({id:'fixture-old-artifact',taskId:task.id,stepId:task.steps[0].id,title:'北辰旧成果',content:'南风旧版方案，已被更新。',createdAt:new Date(Date.now()-60000).toISOString()}, {id:'fixture-current-artifact',taskId:task.id,stepId:task.steps[0].id,title:'北辰交付报告',content:'# 北辰新约\n\n预算 4500，负责人陈明。',createdAt:new Date().toISOString()});
  job.status = 'paused';job.summary = '测试项目保持暂停';
  a.data.decisions.push({id:'fixture-decision',jobId:job.id,projectId:p.id,kind:'question',decisionType:'choice',status:'answered',key:'budget',question:'北辰采用哪个预算？',answer:'采用 4500 元预算',sourceIds:[currentSource.id],taskIds:[task.id],createdAt:new Date().toISOString(),answeredAt:new Date().toISOString()});
  a.save();
  const electron = require('electron');electron.dialog.showErrorBox = (title,message) => {console.error(title,message);electron.app.exit(1);};
  require('../desktop/main.cjs');
})().catch(error => {console.error(error);require('electron').app.exit(1);});
