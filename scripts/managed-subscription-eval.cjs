// Production workflow against the current Codex subscription; all workspace data is temporary.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Assistant,modelChat}=require('../desktop/core.cjs'),subscription=require('../desktop/subscription.cjs');
const out=path.resolve(process.argv[2]||'artifacts/managed/subscription');
if(fs.existsSync(path.join(out,'report.json')))throw new Error('Choose a fresh report directory');
fs.mkdirSync(out,{recursive:true});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v09-model-'))),delivery=path.join(dir,'delivery');fs.mkdirSync(delivery);
const report={startedAt:new Date().toISOString(),status:'running',checks:[],actualCalls:0,stages:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
let a;const timeout=setTimeout(()=>a?.stop(),15*60*1000);
(async()=>{try{
  const provider=await subscription.status();assert.equal(provider.loggedIn,true);
  Object.assign(report,{model:provider.model,reasoning:provider.reasoning});save();
  const chat=async(p,k,m,options)=>{report.actualCalls++;report.stages.push(options?.stage||'unknown');save();return modelChat(p,k,m,options);};
  a=new Assistant({dir:path.join(dir,'workspace'),chat});
  await a.dispatch('saveProvider',{name:'当前订阅模型',type:'codex',model:provider.model,reasoning:provider.reasoning});a.data.agentSettings.outputFolder=delivery;
  await a.dispatch('projectSave',{name:'另一项目'});const other=a.data.projects[0];
  await a.dispatch('import',{items:[{title:'隔离材料',projectId:other.id,content:'隔离项目标记：不能出现在其他项目简报里。'}]});
  await a.dispatch('projectSave',{name:'青禾托管验证'});const project=a.data.projects[0];
  await a.dispatch('import',{items:[{title:'确认的交付要求',projectId:project.id,content:'青禾交付的日期为 2026 年 10 月 12 日，预算 4800 元。已确认：只需要一份不超过 200 字的 Markdown 摘要，说明日期、预算和下一步，并保存为 qinghe.md。无需联网查询，无需联系任何人。'}]});
  await a.dispatch('playbookSave',{title:'定时交付摘要',goalTemplate:'根据项目资料完成 {{主题}}。',taskRequirements:'{{要求}}',maxCalls:40,maxActions:12,intervalMinutes:17,autoAccept:true});
  const template=a.data.playbooks.find(p=>p.title==='定时交付摘要');
  const draft=await a.dispatch('playbookPrepare',{id:template.id,revision:template.revision,values:{主题:'青禾交付摘要',要求:'只创建一个事项，生成摘要，引用项目材料，独立验收，并实际保存 qinghe.md 到所选产出目录。不要询问已在材料确认的信息。'}});
  await a.dispatch('stewardshipSettings',{dailyCallLimit:3});
  await a.dispatch('ruleSave',{...draft,name:'青禾每日摘要',projectId:project.id,trigger:'daily',time:'09:00',enabled:true,folderIds:[],urls:[],allowWeb:false,useGithub:false,useOutputFolder:true,fileMode:'auto',dailyCalls:80,dailyStarts:2});
  const rule=a.data.workRules[0];assert.equal(report.actualCalls,0);assert.equal(a.data.delegations.length,0);
  await a.dispatch('playbookArchive',{id:template.id,revision:template.revision,archived:true});
  await a.dispatch('ruleRun',{id:rule.id});await a.runPromise;
  const j=a.data.delegations.find(j=>j.id===project.jobId);assert.ok(j);assert.equal(j.template.id,template.id);assert.equal(j.intervalMinutes,17);
  report.checks.push('方案转为自动规则不消耗模型调用，归档原方案后规则仍使用保存快照');
  await a.dispatch('agentRun',{id:j.id});await a.runPromise;
  let state=a.publicState();assert.equal(state.stewardshipStatus.used,3);assert.equal(report.actualCalls,3);assert.equal(j.limitReason,'workspace_daily');assert.notEqual(j.status,'completed');assert.ok(j.taskIds.length);
  report.beforeResume={jobId:j.id,status:j.status,tasks:[...j.taskIds],calls:report.actualCalls,limitReason:j.limitReason};
  report.checks.push('真实模型第 4 次调用被额度拦截，计划与事项保留，未误报完成');save();
  const taskIds=[...j.taskIds];await a.dispatch('stewardshipSettings',{dailyCallLimit:30});assert.equal(j.status,'ready');
  for(let round=0;round<6&&['ready','retry'].includes(j.status);round++){await a.dispatch('agentRun',{id:j.id});await a.runPromise;}
  assert.equal(j.status,'completed',`${j.status}: ${j.lastError||j.summary}`);assert.equal(a.data.delegations.length,1);assert.equal(j.taskIds.length,1);assert.deepEqual(j.taskIds,taskIds);
  const write=a.data.agentActions.findLast(r=>r.jobId===j.id&&r.tool==='write_file'&&r.status==='done');assert.ok(write);
  assert.equal(path.basename(write.result.latestPath),'qinghe.md');const content=fs.readFileSync(write.result.latestPath,'utf8');assert.match(content,/4800/);assert.match(content,/青禾/);assert.match(content,/10.{0,4}12/);assert.doesNotMatch(content,/隔离项目标记/);fs.writeFileSync(path.join(out,'delivery.md'),content);
  report.checks.push('提高额度后同一委托和事项继续完成写作、独立验收与实际文件交付');
  const calls=report.actualCalls,brief=await a.dispatch('projectReport',{projectId:project.id,includeArtifactContent:true});
  assert.equal(report.actualCalls,calls);assert.equal(brief.modelCalls,0);assert.equal(brief.progress.completed,1);assert.ok(brief.artifacts.some(v=>v.id===write.artifactId));assert.match(brief.markdown,/4800/);assert.doesNotMatch(brief.markdown,/隔离项目标记/);assert.ok(!brief.markdown.includes(dir));
  fs.writeFileSync(path.join(out,'project-report.md'),brief.markdown);report.checks.push('项目简报反映已验收成果和交付证据、隔离其他项目，生成简报不调用模型');
  const backup=(await a.dispatch('backupCreate'))[0];await a.dispatch('stewardshipSettings',{dailyCallLimit:35});await a.dispatch('backupRestore',{id:backup.id});
  state=a.publicState();assert.equal(state.stewardshipStatus.used,calls);assert.equal(state.stewardship.dailyCallLimit,35);assert.equal(state.stewardship.paused,true);assert.equal(state.delegations.find(r=>r.id===j.id).status,'paused');
  report.checks.push('恢复旧备份保留当前额度与计数，并暂停委托等待恢复');
  Object.assign(report,{passed:true,status:'completed',usage:j.usage,tasks:j.taskIds.length,externalMessages:0});
}catch(error){Object.assign(report,{passed:false,status:'failed',error:error.stack||error.message});process.exitCode=1;}
finally{clearTimeout(timeout);if(a)fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(a.publicState(),null,2));report.finishedAt=new Date().toISOString();report.durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt);save();console.log(JSON.stringify(report));a?.stop();await a?.runPromise;fs.rmSync(dir,{recursive:true,force:true});}})();
