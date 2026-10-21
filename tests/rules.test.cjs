const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const rules=require('../desktop/work-rules.cjs'),agent=require('../desktop/agent.cjs');
const {fixture}=require('../desktop/agent-eval.cjs');
async function setup(t,{models=true}={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-rules-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=path.join(dir,'input'),output=path.join(dir,'output');fs.mkdirSync(input);fs.mkdirSync(output);fs.writeFileSync(path.join(input,'纪要.md'),'星桥：周五发布，李青负责。');
  const env=fixture({id:'rule'}),queue=[];let calls=0;
  const chat=async(p,k,m)=>{calls++;const ctx=JSON.parse(m[1].content);if(m[0].content.includes('动作格式')){const next=queue.shift();return next?(typeof next==='function'?next(ctx):next):{tool:'ask',args:{question:'测试停靠'}};}if(m[0].content.includes('推进给定事项'))return {kind:'artifact',title:'发布报告',content:'# 星桥报告\n周五发布，李青负责。'};return {passed:true,summary:'符合要求',gaps:[]};};
  const a=new Assistant({dir,chat,agentRequest:env.request});
  if(models)await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture'});
  a.data.folders=[{id:'folder',name:'资料',path:input}];a.data.agentSettings.outputFolder=output;a.data.agentSettings.githubRepo='eval/work';a.save();
  const config={name:'纪要整理',goal:'整理星桥纪要并保存报告',folderIds:['folder'],useOutputFolder:true,fileMode:'auto',maxActions:12};
  const save=async(extra={})=>{await a.dispatch('ruleSave',{...config,enabled:models,...extra});return a.data.workRules[0];};
  const check=async rule=>{await a.dispatch('ruleRun',{id:rule.id});await a.runPromise;return a.data.ruleRuns[0];};
  return {a,dir,input,output,env,queue,chat,config,save,check,calls:()=>calls};
}
const plan=ctx=>({tool:'plan_task',args:{key:'report',title:'星桥报告',criteria:'发布日期和负责人',sourceIds:ctx.sources.map(s=>s.id),steps:[{key:'draft',title:'写报告',kind:'draft'},{key:'save',title:'保存报告',kind:'external',tool:'write_file'}]}});
const current=tool=>ctx=>({tool,args:{taskId:ctx.tasks[0].id}});
test('Rules can preview and save without models; enabling requires all model roles',async t=>{
  const {a,config,save,calls}=await setup(t,{models:false});
  await a.dispatch('rulePreview',{...config,requestId:'preview'});await a.runPromise;
  assert.equal(a.publicState().rulePreview.matched,1);assert.equal(calls(),0);assert.equal(a.data.sources.length,0);assert.equal(a.data.workRules.length,0);
  const r=await save();assert.equal(r.status,'paused');await assert.rejects(a.dispatch('ruleResume',{id:r.id}),/模型/);await assert.rejects(a.dispatch('ruleRun',{id:r.id}),/启用/);
});
test('Invalid rule scope and schedule are rejected without changing saved rules',async t=>{
  const {a,config,input}=await setup(t);
  for(const extra of [{folderIds:['missing']},{time:'25:00'},{urls:['file:///private/file.md']},{urls:['https://example.com'],allowWeb:false},{folderIds:[],trigger:'changes'}])await assert.rejects(a.dispatch('ruleSave',{...config,...extra}));
  a.data.agentSettings.outputFolder=input;await assert.rejects(a.dispatch('ruleSave',config),/资料目录/);assert.equal(a.data.workRules.length,0);
});
test('Preview is read-only; first trigger completes actual task and file delivery through the existing Agent',async t=>{
  const {a,save,check,queue,output,calls}=await setup(t);const r=await save();const before=JSON.stringify(r);
  await a.dispatch('rulePreview',{...r.config,id:r.id,requestId:'p'});await a.runPromise;assert.equal(JSON.stringify(r),before);assert.equal(calls(),0);
  assert.equal((await check(r)).status,'created');const job=a.data.delegations[0];assert.equal(job.ruleId,r.id);assert.equal(job.sourceIds.length,1);
  queue.push(plan,current('advance_task'),current('write_file'),current('advance_task'),{tool:'complete',args:{}});
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,'completed');assert.equal(r.usage.calls,calls());assert.equal(job.callsUsed,calls());
  assert.equal(a.data.tasks[0].status,'completed');assert.match(fs.readFileSync(path.join(output,fs.readdirSync(output)[0]),'utf8'),/周五/);assert.equal((await check(r)).status,'unchanged');assert.equal(a.data.delegations.length,1);
});
test('Baseline opt-out and repeated unchanged checks do not create work or call models',async t=>{
  const {a,save,check,input,calls}=await setup(t);const r=await save({includeExisting:false});assert.equal((await check(r)).status,'baseline');
  fs.utimesSync(path.join(input,'纪要.md'),new Date(),new Date());assert.equal((await check(r)).status,'unchanged');assert.equal(calls(),0);assert.equal(a.data.delegations.length,0);
  fs.writeFileSync(path.join(input,'新纪要.md'),'星桥：周六确认。');assert.equal((await check(r)).status,'created');assert.equal(a.data.delegations[0].sourceIds.length,1);
});
test('Filename and content filters use full text, skip symlinks, and detect changes beyond 30,000 characters',async t=>{
  const {a,save,check,input}=await setup(t);fs.writeFileSync(path.join(input,'长纪要.md'),'x'.repeat(40000)+'目标');{if(!require('./helpers/symlink.cjs').link(t,path.join(input,'长纪要.md'),path.join(input,'链接纪要.md')))return;}
  const r=await save({keyword:'目标',filename:'纪要',includeExisting:false});await check(r);assert.equal(Object.keys(r.fingerprints).length,1);
  fs.writeFileSync(path.join(input,'长纪要.md'),'x'.repeat(40000)+'目标更新');assert.equal((await check(r)).status,'created');assert.equal(a.data.delegations.length,1);
  assert.equal((await check(r)).status,'unchanged');
});
test('A source edit merges into unfinished work, invalidates only its linked task, and never duplicates the delegation',async t=>{
  const {a,save,check,input}=await setup(t);fs.writeFileSync(path.join(input,'其他.md'),'其他项目');const r=await save();await check(r);const job=a.data.delegations[0];
  const make=async(key,sourceId)=>agent.act(a,job,'plan_task',{key,title:key,criteria:'报告',sourceIds:[sourceId],steps:[{title:'编写',kind:'draft'}]});
  const first=await make('星桥',job.watchers.find(w=>w.args.name==='纪要.md').sourceId),second=await make('其他',job.watchers.find(w=>w.args.name==='其他.md').sourceId);
  await a.advance(first.taskId);await a.advance(second.taskId);fs.writeFileSync(path.join(input,'纪要.md'),'星桥改为周六');assert.equal((await check(r)).status,'merged');
  assert.ok(a.task(first.taskId).needsReplan);assert.equal(a.task(second.taskId).status,'review');assert.equal(a.task(second.taskId).verification.passed,true);assert.equal(a.task(second.taskId).needsReplan,undefined);assert.equal(a.data.delegations.length,1);
});
test('Deleting a source invalidates linked work and removes its watcher instead of retrying a missing file',async t=>{
  const {a,save,check,input}=await setup(t);const r=await save();await check(r);const j=a.data.delegations[0];const {taskId}=await agent.act(a,j,'plan_task',{key:'r',title:'报告',criteria:'报告',sourceIds:[j.sourceIds[0]],steps:[{title:'写报告',kind:'draft'}]});
  fs.unlinkSync(path.join(input,'纪要.md'));const result=await check(r);assert.equal(result.status,'merged');assert.equal(result.changes[0].change,'removed');assert.equal(j.watchers.length,0);assert.ok(a.task(taskId).needsReplan);assert.match(a.context(a.task(taskId)).sources[0].content,/已移除/);
});
test('Completed work starts a new delegation on new material; restart preserves checkpoint and avoids duplicates',async t=>{
  const {a,save,check,input,chat}=await setup(t);const r=await save();await check(r);const old=a.data.delegations[0];old.status='completed';fs.writeFileSync(path.join(input,'纪要.md'),'新一轮纪要');await check(r);assert.equal(a.data.delegations.length,2);assert.notEqual(r.activeJobId,old.id);
  const restored=new Assistant({dir:a.dir,chat});await restored.dispatch('ruleRun',{id:r.id});await restored.runPromise;assert.equal(restored.data.delegations.length,2);assert.equal(restored.data.ruleRuns[0].status,'unchanged');
});
test('New material stays queued during manual pause, approval or missing input, then drains after recovery',async t=>{
  const {a,save,check,input}=await setup(t);const r=await save({trigger:'daily'});await check(r);const j=a.data.delegations[0];
  for(const status of ['paused','approval','needs_input','review']){j.status=status;fs.writeFileSync(path.join(input,'纪要.md'),status);assert.equal((await check(r)).status,'queued');assert.equal(j.status,status);assert.equal(r.pending.length,1);}
  j.status='ready';a.tick();await a.runPromise;assert.equal(a.data.ruleRuns[0].status,'merged');assert.equal(r.pending.length,0);assert.equal(a.data.delegations.length,1);
});
test('Daily start limit retains new material and resumes after the local calendar day changes',async t=>{
  const {a,save,check,input}=await setup(t);const r=await save({dailyStarts:1});await check(r);a.data.delegations[0].status='completed';fs.writeFileSync(path.join(input,'纪要.md'),'第二轮');assert.equal((await check(r)).status,'limited');assert.equal(a.data.delegations.length,1);assert.equal(r.pending.length,1);
  r.usage.day='old';r.nextRunAt=new Date(0).toISOString();a.tick();await a.runPromise;assert.equal(a.data.delegations.length,2);assert.equal(r.usage.starts,1);assert.equal(r.usage.day,rules.day());
});
test('Daily model statistics include all rule jobs without enforcing a call cap',async t=>{
  const {a,save,check,input,calls}=await setup(t);const r=await save({dailyCalls:5});await check(r);const first=a.data.delegations[0];
  for(let i=0;i<2;i++){const {taskId}=await agent.act(a,first,'plan_task',{key:`t${i}`,title:'报告',criteria:'完成',steps:[{title:'写报告',kind:'draft'}]});await a.advance(taskId);}
  assert.equal(r.usage.calls,4);first.status='completed';fs.writeFileSync(path.join(input,'纪要.md'),'第二轮');await check(r);const second=a.data.delegations[0];const {taskId}=await agent.act(a,second,'plan_task',{key:'second',title:'报告',criteria:'完成',steps:[{title:'写报告',kind:'draft'}]});await a.advance(taskId);
  assert.equal(calls(),6);assert.equal(r.usage.calls,6);assert.equal(second.status,'ready');assert.equal(second.limitReason,undefined);assert.equal(second.callsUsed,2);assert.equal(a.task(taskId).status,'review');assert.equal(a.task(taskId).verification.passed,true);
  r.usage.day='old';r.nextRunAt=new Date(Date.now()+3600000).toISOString();rules.tick(a);assert.equal(second.status,'ready');assert.equal(r.usage.calls,0);
});
test('Pausing a rule stops its jobs and survives restart; explicitly paused jobs stay paused on rule resume',async t=>{
  const {a,save,check,chat}=await setup(t);const r=await save();await check(r);const j=a.data.delegations[0];j.status='watching';await a.dispatch('rulePause',{id:r.id});assert.equal(j.status,'paused');await assert.rejects(a.dispatch('agentResume',{id:j.id}),/规则/);
  const restored=new Assistant({dir:a.dir,chat});restored.tick();assert.equal(restored.operation,null);await restored.dispatch('ruleResume',{id:r.id});assert.equal(restored.data.delegations[0].status,'watching');
  await restored.dispatch('agentPause',{id:j.id});await restored.dispatch('rulePause',{id:r.id});await restored.dispatch('ruleResume',{id:r.id});assert.equal(restored.data.delegations[0].status,'paused');
});
test('Global stop, configuration revisions and archiving never silently resume old work',async t=>{
  const {a,save,check}=await setup(t);const r=await save();await check(r);const j=a.data.delegations[0];a.stop();assert.equal(r.status,'paused');assert.equal(j.status,'paused');a.tick();assert.equal(a.operation,null);
  await a.dispatch('ruleSave',{...r.config,id:r.id,enabled:true,name:'改版规则'});assert.equal(r.revision,2);assert.equal(r.activeJobId,null);assert.equal(j.status,'paused');await assert.rejects(a.dispatch('agentResume',{id:j.id}),/规则/);
  await check(r);await a.dispatch('ruleArchive',{id:r.id});assert.equal(r.status,'archived');assert.equal(a.data.ruleRuns.length,2);await assert.rejects(a.dispatch('ruleResume',{id:r.id}),/无需/);
});
test('Consecutive configuration failures block after three attempts without losing the checkpoint',async t=>{
  const {a,save,check}=await setup(t);const r=await save();a.data.providers=[];
  for(let i=0;i<3;i++)assert.equal((await check(r)).status,'error');assert.equal(r.status,'blocked');assert.equal(r.failures,3);assert.equal(r.initialized,false);assert.equal(a.data.delegations.length,0);
  assert.equal(a.data.events.filter(e=>e.title==='工作规则需要处理').length,1);
});
test('Source failures retry finitely and interrupted checks recover without a phantom success',async t=>{
  const {a,save,check}=await setup(t);const r=await save({folderIds:[],urls:['https://example.com/news']});a.agentRequest=async()=>{throw new Error('offline');};
  for(let i=0;i<3;i++)await check(r);assert.equal(r.status,'blocked');assert.equal(a.data.sources.length,0);assert.equal(r.initialized,false);
  a.data.ruleRuns[0].status='running';a.save();const restored=new Assistant({dir:a.dir});assert.equal(restored.data.ruleRuns[0].status,'interrupted');
});
test('Rule pause aborts an in-flight source request and cannot create a late delegation',async t=>{
  const {a,save}=await setup(t);const r=await save({folderIds:[],urls:['https://example.com/news']});let ready;const started=new Promise(resolve=>ready=resolve);
  a.agentRequest=async(url,{signal})=>new Promise((resolve,reject)=>{ready();signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
  await a.dispatch('ruleRun',{id:r.id});await started;await a.dispatch('rulePause',{id:r.id});await a.runPromise;assert.equal(r.status,'paused');assert.equal(a.data.delegations.length,0);assert.equal(a.data.ruleRuns[0].status,'paused');
});
test('Daily and weekly schedules use local wall time, run once after downtime, and permit source-free goals',async t=>{
  const {a,save}=await setup(t);const after=new Date(2026,8,30,10,0,0).getTime();
  const daily=new Date(rules.nextRun({trigger:'daily',time:'09:00'},after));assert.equal(daily.getDate(),1);assert.equal(daily.getHours(),9);
  const weekly=new Date(rules.nextRun({trigger:'weekly',time:'09:00',weekday:3},after));assert.equal(weekly.getDay(),3);assert.equal(weekly.getDate(),7);
  const r=await save({trigger:'daily',folderIds:[]});r.nextRunAt=new Date(0).toISOString();a.tick();await a.runPromise;assert.equal(a.data.delegations.length,1);assert.equal(a.data.ruleRuns.length,1);assert.ok(Date.parse(r.nextRunAt)>Date.now());assert.equal(rules.tick(a),false);
});
test('GitHub changes ignore own comments and updates but include human replies',async t=>{
  const {a,save,check,env}=await setup(t);await a.dispatch('agentSettings',{githubToken:'fixture'});const r=await save({folderIds:[],useGithub:true,githubRepo:'eval/work',githubUpdateMode:'auto',githubCommentMode:'auto'});const firstRun=await check(r);assert.equal(firstRun.status,'created',JSON.stringify(firstRun));const j=a.data.delegations[0];
  const {taskId}=await agent.act(a,j,'plan_task',{key:'r',title:'报告',criteria:'报告',sourceIds:j.sourceIds,steps:[{title:'写报告',kind:'draft'}]});await a.advance(taskId);
  await agent.act(a,j,'github_comment',{taskId,number:1,body:'请确认'});assert.equal((await check(r)).status,'unchanged');
  await agent.act(a,j,'github_update',{taskId,number:1});assert.equal((await check(r)).status,'unchanged');
  env.reply();assert.equal((await check(r)).status,'merged');assert.ok(a.task(taskId).needsReplan);assert.equal(a.data.delegations.length,1);
});
test('App-created outputs are excluded from inputs and broad scans report explicit limits',async t=>{
  const {a,save,check,input}=await setup(t);a.data.agentActions.push({id:'synthetic-file-output',status:'done',effectStatus:'applied',tool:'write_file',result:{path:path.join(input,'纪要.md')}});const r=await save();assert.equal((await check(r)).status,'unchanged');assert.equal(a.data.delegations.length,0);
  a.data.agentActions=[];for(let i=0;i<21;i++)fs.writeFileSync(path.join(input,`${i}.md`),String(i));assert.equal((await check(r)).status,'error');assert.match(r.summary,/20 份/);assert.equal(r.fingerprints['read_file:{"folderId":"folder","name":"纪要.md"}'],undefined);
});
test('Scheduled preview shows actual inputs even when unchanged; scheduled deletions also invalidate linked work',async t=>{
  const {a,save,check,input}=await setup(t);const r=await save({trigger:'daily',includeExisting:false});await check(r);const j=a.data.delegations[0];const {taskId}=await agent.act(a,j,'plan_task',{key:'r',title:'报告',criteria:'报告',sourceIds:j.sourceIds,steps:[{title:'写报告',kind:'draft'}]});
  await a.dispatch('rulePreview',{...r.config,id:r.id,requestId:'scheduled'});await a.runPromise;assert.equal(a.rulePreview.baseline,false);assert.equal(a.rulePreview.changes.length,1);assert.equal(a.rulePreview.changes[0].change,'scheduled');
  fs.unlinkSync(path.join(input,'纪要.md'));await check(r);assert.equal(j.watchers.length,0);assert.ok(a.task(taskId).needsReplan);assert.equal(a.data.ruleRuns[0].changes[0].change,'removed');
});
