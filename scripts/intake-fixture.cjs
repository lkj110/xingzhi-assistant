const fs=require('node:fs'),path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Independent test workspace required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs');
core.Assistant=class extends Base {
  constructor(options){super({...options,chat:async(_p,_k,m)=>{
    if(m[0].content.includes('从材料提取')){const context=JSON.parse(m[1].content);return {tasks:[{title:'整理快捷收集',description:'独立桌面测试',criteria:'保留准确来源',sourceIds:context.sources.map(s=>s.id),steps:[{title:'整理材料',kind:'analysis'}]}],summary:'本次内容已拆解'};}
    return {ok:true};
  },agentRequest:async()=>{throw new Error('No external network in desktop fixtures');},connectorRequest:async()=>{throw new Error('No external messages in desktop fixtures');}});}
  tick(){}
};
(async()=>{
  const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'桌面隔离模型',model:'fixture',baseUrl:'https://example.invalid/v1'});
  await a.dispatch('projectSave',{name:'发布项目',background:'核对需求、评审和发布'});const p=a.data.projects[0];
  await a.dispatch('projectSave',{name:'隔离项目',background:'此项目材料不应跨入发布项目'});
  const input=path.join(dir,'inputs'),output=path.join(dir,'output');fs.mkdirSync(input);fs.mkdirSync(output);fs.writeFileSync(path.join(input,'需求.md'),'第一版：发布日期 10 月 12 日，预算 4800 元');
  a.data.folders.push({id:'fixture-folder',name:'项目资料目录',path:input,enabled:false,projectId:null});a.data.agentSettings.outputFolder=output;
  const j=agent.buildJob(a,{projectId:p.id,goal:'整理发布项目资料并持续跟进',useOutputFolder:true,fileMode:'auto'});a.data.delegations.push(j);p.jobId=j.id;
  const planned=await agent.act(a,j,'plan_task',{key:'csv',title:'发布分工表',criteria:'交付 CSV 列明任务和负责人',steps:[{key:'draft',title:'撰写分工表',kind:'draft'},{key:'save',title:'保存分工表',kind:'external',tool:'write_file'}]});
  const t=a.task(planned.taskId);t.steps[0].done=true;t.steps[0].artifactId='csv-artifact';a.data.artifacts.push({id:'csv-artifact',taskId:t.id,title:'发布分工 CSV',content:'任务,负责人\n发布,陈明\n验收,林青\n',createdAt:new Date().toISOString()});await writes.execute(a,j,await writes.prepare(a,j,'write_file',{taskId:t.id,filename:'分工表.csv'}));t.status='completed';t.verification={passed:true,gaps:[]};j.status='paused';
  const first=a.createTask({title:'校对需求',projectId:p.id,priority:'low',dueAt:new Date(Date.now()-86400000).toISOString()});first.status='paused';
  a.createTask({title:'安排评审',projectId:p.id,dueAt:new Date(Date.now()+86400000).toISOString()});a.createTask({title:'独立备忘',priority:'normal'});
  await a.dispatch('import',{items:[{title:'之前的材料',content:'不应被快捷收集一起整理。'}]});a.save();
  const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
