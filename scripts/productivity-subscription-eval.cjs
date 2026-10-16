// Uses the existing official Codex subscription, with isolated local sources and output.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Assistant,modelChat}=require('../desktop/core.cjs'),subscription=require('../desktop/subscription.cjs');
const out=path.resolve(process.argv[2]||'artifacts/productivity/subscription');
if(fs.existsSync(path.join(out,'report.json')))throw new Error('Choose a fresh report directory');fs.mkdirSync(out,{recursive:true});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v08-model-'))),delivery=path.join(dir,'delivery');fs.mkdirSync(delivery);
const report={startedAt:new Date().toISOString(),status:'running',checks:[],memoryStages:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
let a;const timeout=setTimeout(()=>a?.stop(),15*60*1000);
(async()=>{try{
 const provider=await subscription.status();assert.equal(provider.loggedIn,true);Object.assign(report,{model:provider.model,reasoning:provider.reasoning});save();
 const chat=async(p,k,m,options)=>{
  const body=m.find(v=>v.role==='user')?.content;let context;try{context=JSON.parse(body);}catch{}
  if(context?.workMemory){assert.ok(context.workMemory.items.every(item=>!item.content.includes('隔离项目标记')));report.memoryStages.push({stage:options.stage,items:context.workMemory.items.length});}
  return modelChat(p,k,m,options);
 };
 a=new Assistant({dir:path.join(dir,'workspace'),chat});await a.dispatch('saveProvider',{name:'当前订阅模型',type:'codex',model:provider.model,reasoning:provider.reasoning});
 a.data.agentSettings.outputFolder=delivery;
 await a.dispatch('projectSave',{name:'隔离项目'});const other=a.data.projects[0];
 await a.dispatch('memorySave',{title:'另一项目约束',kind:'term',projectId:other.id,content:'隔离项目标记，不可用于其他项目。'});
 await a.dispatch('projectSave',{name:'青禾交付测试'});const project=a.data.projects[0];
 await a.dispatch('memorySave',{title:'交付格式',kind:'preference',content:'对短报告使用「结论」「依据」「下一步」三个小标题，不要写应用内部ID。'});
 await a.dispatch('memorySave',{title:'项目简称',kind:'term',projectId:project.id,content:'这个项目的对外交付简称固定为「青禾」。文稿标题要包含这个简称。'});
 await a.dispatch('import',{items:[{title:'已确认要求',projectId:project.id,content:'负责人已确认：交付日期 2026 年 10 月 12 日，预算 4800 元。完成标准：用一份简短 Markdown 摘要说明日期、预算和下一步。引用这份已确认要求作为依据。'}]});
 await a.dispatch('playbookSave',{title:'短摘要交付',goalTemplate:'根据项目材料完成 {{主题}}。',taskRequirements:'{{要求}}',maxCalls:28,maxActions:12,intervalMinutes:30,autoAccept:true});
 const template=a.data.playbooks.find(p=>p.title==='短摘要交付');
 const draft=await a.dispatch('playbookPrepare',{id:template.id,revision:template.revision,values:{主题:'交付摘要',要求:'只需要一个事项，生成不超过 250 字的短报告并实际保存为 Markdown 到所选产出目录。无需额外询问日期或格式，参考已确认要求和生效工作记忆。'}});
 assert.equal(a.data.delegations.length,0);report.checks.push('方案预览不启动模型、不继承工具权限');
 await a.dispatch('agentCreate',{...draft,projectId:project.id,allowWeb:false,folderIds:[],useOutputFolder:true,fileMode:'auto'});await a.runPromise;
 const j=a.data.delegations.find(j=>j.id===project.jobId);
 for(let round=0;round<5&&['ready','retry'].includes(j.status);round++){await a.dispatch('agentRun',{id:j.id});await a.runPromise;}
 assert.equal(j.status,'completed',`${j.status}: ${j.lastError||j.summary}`);assert.equal(j.taskIds.length,1);assert.equal(j.template.id,template.id);
 const write=a.data.agentActions.findLast(r=>r.jobId===j.id&&r.tool==='write_file'&&r.status==='done');assert.ok(write);
 const content=fs.readFileSync(write.result.latestPath,'utf8');for(const token of ['青禾','4800','结论','依据','下一步'])assert.ok(content.includes(token),`Missing ${token}`);
 assert.doesNotMatch(content,/隔离项目标记/);fs.writeFileSync(path.join(out,'delivery.md'),content);
 assert.ok(report.memoryStages.some(r=>r.stage==='planner'&&r.items===2));assert.ok(report.memoryStages.some(r=>r.stage==='task_work'&&r.items===2));assert.ok(report.memoryStages.some(r=>r.stage==='task_verify'&&r.items===2));
 report.checks.push('规划、写作与验收实际收到全局和本项目记忆','其他项目记忆未进入上下文','真实模型完成拆解、写作、保存和独立验收');
 const calls=j.callsUsed,found=await a.dispatch('librarySearch',{query:'青禾',type:'artifact',projectId:project.id});assert.ok(found.items.some(r=>r.id===write.artifactId));assert.equal(j.callsUsed,calls);report.checks.push('交付可从成果库查回，搜索不消耗模型调用');
 const backup=(await a.dispatch('backupCreate'))[0];await a.dispatch('backupRestore',{id:backup.id});assert.ok(a.data.memories.length===3&&a.data.playbooks.some(p=>p.id===template.id));assert.equal(a.data.delegations.find(r=>r.id===j.id).status,'paused');report.checks.push('备份恢复保留方案与记忆并暂停自动工作');
 Object.assign(report,{passed:true,status:'completed',calls:j.callsUsed,usage:j.usage,tasks:j.taskIds.length,externalMessages:0});
}catch(error){Object.assign(report,{passed:false,status:'failed',error:error.message});process.exitCode=1;}
finally{clearTimeout(timeout);if(a)fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(a.publicState(),null,2));report.finishedAt=new Date().toISOString();report.durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt);save();console.log(JSON.stringify(report));a?.stop();await a?.runPromise;fs.rmSync(dir,{recursive:true,force:true});}})();
