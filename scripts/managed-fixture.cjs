// Native desktop tests use only an isolated workspace and deterministic transports.
const path=require('node:path'),fs=require('node:fs');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Test directory required');
const core=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),Base=core.Assistant;
core.Assistant=class extends Base {
  constructor(options){super({...options,chat:async()=>({tool:'ask',args:{key:'fixture-stop',question:'测试委托等待检查',suggestion:'采用已确认的目标'}}),agentRequest:async()=>{throw new Error('测试不能访问外部网络');},connectorRequest:async()=>{throw new Error('测试不能访问外部服务');}});}
  tick() {}
};
(async()=>{
  const a=new core.Assistant({dir:path.join(dir,'workspace')});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'隔离测试模型',model:'fixture',baseUrl:'https://example.invalid/v1'});
  fs.mkdirSync(path.join(dir,'authorized'),{recursive:true});fs.mkdirSync(path.join(dir,'deliveries'),{recursive:true});fs.writeFileSync(path.join(dir,'authorized','计划.md'),'本周发布计划：周五发布，陈明负责。');
  a.data.folders.push({id:'fixture-folder',name:'隔离资料目录',path:path.join(dir,'authorized')});a.data.agentSettings.outputFolder=path.join(dir,'deliveries');a.data.agentSettings.githubRepo='fixture/private';
  await a.dispatch('projectSave',{name:'日常发布',background:'本周发布进度'});const p=a.data.projects[0];
  await a.dispatch('import',{items:[{title:'发布需求',content:'周五发布，陈明负责。',projectId:p.id}]});
  const job=agent.buildJob(a,{projectId:p.id,goal:'整理日常发布计划',allowWeb:false,fileMode:'off',githubMode:'off'});job.sourceIds=[a.data.sources[0].id];a.data.delegations.push(job);p.jobId=job.id;
  const planned=await agent.act(a,job,'plan_task',{key:'report',title:'发布计划报告',criteria:'列出日期、负责人和风险',sourceIds:job.sourceIds,steps:[{key:'draft',title:'写报告',kind:'draft'}]});
  const task=a.task(planned.taskId);task.status='completed';task.verification={passed:true,summary:'日期、负责人和风险已核对',gaps:[]};task.steps[0].done=true;task.steps[0].artifactId='fixture-report';job.status='paused';job.summary='测试委托保持暂停';
  a.data.artifacts.push({id:'fixture-report',taskId:task.id,title:'发布交付报告',content:'# 发布交付报告\n正文独有标记：周五发布，陈明负责，回滚方案待检查。',createdAt:new Date().toISOString()});
  require('../desktop/protocol-access.cjs').retain(a,'artifact',a.data.artifacts.find(r=>r.id==='fixture-report'),{job,task,command:'managed_fixture_output'});
  fs.writeFileSync(path.join(dir,'deliveries','发布报告.md'),a.data.artifacts[0].content);
  a.data.agentActions.push({id:'fixture-delivery',jobId:job.id,projectId:p.id,taskId:task.id,tool:'write_file',title:'发布报告',artifactId:'fixture-report',status:'done',result:{verified:true,path:path.join(dir,'deliveries','发布报告.md')},finishedAt:new Date().toISOString()});
  job.followups.push({key:'delivery-confirmation',status:'waiting',taskId:task.id,expected:'确认发布验收结果',deadlineAt:new Date(Date.now()-60000).toISOString(),checkAt:new Date(Date.now()+60000).toISOString()});
  const named=agent.buildJob(a,{goal:'命名文件审批演示',allowWeb:false,useOutputFolder:true,fileMode:'ask',githubMode:'off'});a.data.delegations.unshift(named);
  const delivery=await agent.act(a,named,'plan_task',{key:'named-report',title:'保存命名周报',criteria:'交付每周进展.md',steps:[{key:'draft',title:'准备文稿',kind:'draft'},{key:'save',title:'保存到命名文件',kind:'external',tool:'write_file'}]});
  const deliveryTask=a.task(delivery.taskId);deliveryTask.steps[0].done=true;deliveryTask.steps[0].artifactId='fixture-named-report';a.data.artifacts.push({id:'fixture-named-report',taskId:deliveryTask.id,title:'命名周报',content:'# 周报\n这是隔离测试待审批的文稿。',createdAt:new Date().toISOString()});require('../desktop/protocol-access.cjs').retain(a,'artifact',a.data.artifacts.find(r=>r.id==='fixture-named-report'),{job:named,task:deliveryTask,command:'managed_fixture_output'});await agent.act(a,named,'write_file',{taskId:deliveryTask.id,filename:'每周进展.md'});
  await a.dispatch('projectSave',{name:'其他项目私密',background:'其他项目内容不应出现在发布简报'});await a.dispatch('import',{items:[{title:'隔离材料',content:'另一项目独有秘密',projectId:a.data.projects[0].id}]});a.save();
  const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
