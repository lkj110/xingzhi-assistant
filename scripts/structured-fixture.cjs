const fs=require('node:fs'),path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated test directory required');
const core=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs'),Base=core.Assistant;
core.Assistant=class extends Base {
  constructor(options){super({...options,chat:async()=>({tool:'ask',args:{key:'fixture-stop',question:'结构化桌面测试已保存文件，请检查结果'}}),agentRequest:async()=>{throw new Error('测试未授权外部网络');},connectorRequest:async()=>{throw new Error('测试未授权外部服务');}});}
  tick(){}
};
(async()=>{
  const a=new core.Assistant({dir:path.join(dir,'workspace')});
  if(!a.data.providers.length){
    await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'结构化测试模型',model:'fixture',baseUrl:'https://example.invalid/v1'});const output=path.join(dir,'delivery');fs.mkdirSync(output,{recursive:true});a.data.agentSettings.outputFolder=output;
    await a.dispatch('projectSave',{name:'结构化桌面项目'});const project=a.data.projects[0];
    const job=agent.buildJob(a,{projectId:project.id,goal:'结构化审批演示',useOutputFolder:true,fileMode:'ask',allowWeb:false,maxActions:2});a.data.delegations.push(job);project.jobId=job.id;
    const taskId=(await agent.act(a,job,'plan_task',{key:'json',title:'青禾JSON清单',criteria:'交付预算4800的JSON清单',steps:[{key:'draft',title:'生成JSON正文',kind:'draft'},{key:'save',title:'实际交付JSON',kind:'external',tool:'write_file'}]})).taskId,task=a.task(taskId);
    task.steps[0].done=true;task.steps[0].artifactId='fixture-json-artifact';a.data.artifacts.push({id:'fixture-json-artifact',taskId,title:'青禾JSON清单',content:'{"project":"青禾","budget":4800}',createdAt:new Date().toISOString()});await agent.act(a,job,'write_file',{taskId,filename:'qinghe.json'});
    const done=agent.buildJob(a,{goal:'结构化格式展示',useOutputFolder:true,fileMode:'auto',allowWeb:false});a.data.delegations.push(done);
    for(const [format,content] of [['csv','project,budget,adjustment\n青禾,4800,-12.5\n'],['txt','青禾预算4800元']]){
      const taskId=(await agent.act(a,done,'plan_task',{key:format,title:`青禾${format.toUpperCase()}`,criteria:'保存对应格式',steps:[{key:'draft',kind:'draft',title:'正文'}]})).taskId,task=a.task(taskId);task.steps[0].done=true;task.steps[0].artifactId=`fixture-${format}-artifact`;a.data.artifacts.push({id:task.steps[0].artifactId,taskId,title:task.title,content,createdAt:new Date().toISOString()});await writes.execute(a,done,await writes.prepare(a,done,'write_file',{taskId,filename:`qinghe.${format}`}));task.status='completed';task.verification={passed:true};
    }
    done.status='paused';done.summary='两份已核对交付';a.save();
  }
  const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
