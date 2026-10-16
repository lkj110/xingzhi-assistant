const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const rules=require('../desktop/work-rules.cjs');

async function setup(t,{models=false}={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-recurring-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0,requests=0;
  const a=new Assistant({dir,chat:async()=>{calls++;return {tool:'ask',args:{question:'测试停靠'}};},agentRequest:async()=>{requests++;throw new Error('不应访问外部网络');}});
  if(models)await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'隔离测试',model:'fixture',baseUrl:'https://example.invalid/v1'});
  const folder=path.join(dir,'input'),output=path.join(dir,'output');fs.mkdirSync(folder);fs.mkdirSync(output);fs.writeFileSync(path.join(folder,'note.md'),'第一版计划');
  a.data.folders.push({id:'folder',name:'资料',path:folder});a.data.agentSettings.outputFolder=output;a.data.agentSettings.githubRepo='test/private';
  await a.dispatch('playbookSave',{title:'每周复盘',description:'保持来源',goalTemplate:'复盘 {{主题}}',taskRequirements:'列出风险和 {{要求}}',maxCalls:37,maxActions:4,intervalMinutes:17,autoAccept:false});
  const book=a.data.playbooks[0];
  const draft=await a.dispatch('playbookPrepare',{id:book.id,revision:book.revision,values:{主题:'发布进度',要求:'下一步'}});
  const config={...draft,name:'复盘自动运行',trigger:'daily',time:'09:00',folderIds:[],urls:[],allowWeb:false,useGithub:false,githubRepo:'',useOutputFolder:false,fileMode:'off',githubMode:'off',githubUpdateMode:'off',githubCommentMode:'off'};
  const save=async(extra={})=>{await a.dispatch('ruleSave',{...config,enabled:false,...extra});return a.data.workRules[0];};
  const check=async(rule)=>{await a.dispatch('ruleRun',{id:rule.id});await a.runPromise;return a.data.ruleRuns[0];};
  return {a,dir,folder,book,draft,config,save,check,calls:()=>calls,requests:()=>requests};
}

test('Prepared recurring recipes save paused without models or inheriting configured grants',async t=>{
  const {a,book,save,calls,requests}=await setup(t);const r=await save();
  assert.equal(r.status,'paused');assert.equal(r.config.trigger,'daily');assert.equal(r.config.time,'09:00');
  assert.deepEqual(r.config.template,{id:book.id,revision:1,title:'每周复盘'});assert.equal(r.config.templateId,undefined);
  assert.deepEqual(r.config.folderIds,[]);assert.deepEqual(r.config.urls,[]);assert.equal(r.config.allowWeb,false);assert.equal(r.config.githubRepo,'');assert.equal(r.config.outputFolder,'');
  for(const key of ['fileMode','githubMode','githubUpdateMode','githubCommentMode'])assert.equal(r.config[key],'off');
  assert.equal(r.config.maxCalls,undefined);assert.equal(r.config.maxActions,4);assert.equal(r.config.intervalMinutes,17);assert.equal(r.config.autoAccept,false);
  assert.equal(a.data.delegations.length,0);assert.equal(calls(),0);assert.equal(requests(),0);
});

test('Recipe-based rule previews read only the selected scope and invoke no model',async t=>{
  const {a,config,calls,requests}=await setup(t);await a.dispatch('rulePreview',{...config,requestId:'empty'});await a.runPromise;
  assert.equal(a.rulePreview.status,'done');assert.equal(a.rulePreview.matched,0);assert.equal(a.data.workRules.length,0);assert.equal(a.data.delegations.length,0);
  await a.dispatch('rulePreview',{...config,trigger:'changes',folderIds:['folder'],requestId:'source'});await a.runPromise;
  assert.equal(a.rulePreview.matched,1);assert.equal(a.rulePreview.changes[0].title,'note.md');assert.equal(a.data.sources.length,0);assert.equal(calls(),0);assert.equal(requests(),0);
});

test('Enabling or resuming a prepared rule still requires every model role',async t=>{
  const {a,save}=await setup(t);await assert.rejects(save({enabled:true}),/模型/);assert.equal(a.data.workRules.length,0);
  const r=await save();await assert.rejects(a.dispatch('ruleResume',{id:r.id}),/模型/);assert.equal(r.status,'paused');
});

test('A recipe edited after preview rejects a stale rule save before any mutation',async t=>{
  const {a,book,save}=await setup(t);await a.dispatch('playbookSave',{...book,title:'新版方案'});
  const before=JSON.stringify(a.data);await assert.rejects(save(),/工作方案已更新/);assert.equal(JSON.stringify(a.data),before);
});

test('A stale recipe is rejected before a rule preview reads any sources',async t=>{
  const {a,book,config,requests}=await setup(t);await a.dispatch('playbookSave',{...book,title:'新版方案'});
  await assert.rejects(a.dispatch('rulePreview',{...config,urls:['https://example.com/input'],allowWeb:true,requestId:'stale'}),/工作方案已更新/);
  assert.equal(a.operation,null);assert.equal(requests(),0);assert.equal(a.rulePreview?.requestId,undefined);
});

test('Archived recipes reject new rules even with the latest revision',async t=>{
  const {a,book,config}=await setup(t);await a.dispatch('playbookArchive',{id:book.id,revision:book.revision,archived:true});
  for(const action of ['ruleSave','rulePreview'])await assert.rejects(a.dispatch(action,{...config,templateRevision:book.revision,requestId:'archived'}),/已归档/);
  assert.equal(a.data.workRules.length,0);
});

test('Unknown recipe provenance and forged snapshot fields cannot create a trusted template reference',async t=>{
  const {a,config,save}=await setup(t);await assert.rejects(save({templateId:'missing'}),/工作方案不存在/);
  const {templateId,templateRevision,...plain}=config;
  await a.dispatch('ruleSave',{...plain,template:{id:'forged',revision:88,title:'伪造'},enabled:false});assert.equal(a.data.workRules[0].config.template,undefined);
});

test('An existing rule ID cannot be used to replace its recipe or grant scope through recipe fields',async t=>{
  const {a,book,save}=await setup(t);const r=await save();const before=JSON.stringify(r);
  for(const action of ['ruleSave','rulePreview'])await assert.rejects(a.dispatch(action,{...r.config,id:r.id,templateId:'builtin-delivery',templateRevision:1,allowWeb:true,folderIds:['folder']}),/已有规则沿用/);
  assert.equal(JSON.stringify(r),before);assert.equal(r.config.template.id,book.id);
});

test('Existing rules keep their saved recipe when its source changes or is archived',async t=>{
  const {a,book,save}=await setup(t);const r=await save();const snapshot={...r.config.template};
  await a.dispatch('playbookSave',{...book,title:'新标题',goalTemplate:'新的目标'});await a.dispatch('playbookArchive',{id:book.id,revision:book.revision,archived:true});
  await a.dispatch('ruleSave',{...r.config,id:r.id,name:'改到下午',time:'15:30',template:{id:'forged',revision:99,title:'不可信'},enabled:false});
  assert.deepEqual(r.config.template,snapshot);assert.equal(r.config.time,'15:30');assert.match(r.config.goal,/复盘 发布进度/);
  await a.dispatch('rulePreview',{...r.config,id:r.id,requestId:'kept'});await a.runPromise;assert.equal(a.rulePreview.status,'done');
});

test('Each scheduled round uses the saved snapshot even after recipe archival',async t=>{
  const {a,book,save,check,calls}=await setup(t,{models:true});const r=await save({enabled:true});const snapshot={...r.config.template};
  await a.dispatch('playbookArchive',{id:book.id,revision:book.revision,archived:true});assert.equal((await check(r)).status,'created');const first=a.data.delegations[0];
  assert.deepEqual(first.template,snapshot);assert.equal(first.maxCalls,undefined);assert.equal(first.allowWeb,false);first.status='completed';
  assert.equal((await check(r)).status,'created');const second=a.data.delegations[0];assert.notEqual(first.id,second.id);assert.deepEqual(second.template,snapshot);
  second.template.title='修改单次副本';assert.equal(r.config.template.title,'每周复盘');assert.equal(first.template.title,'每周复盘');assert.equal(calls(),0);
});

test('Recipe snapshots and permissions survive a restart before the first scheduled run',async t=>{
  const {a,dir,book,save}=await setup(t,{models:true});const r=await save({enabled:true});await a.dispatch('playbookArchive',{id:book.id,revision:book.revision,archived:true});
  const restored=new Assistant({dir,chat:async()=>{throw new Error('规则检查不应调用模型');}});await restored.dispatch('ruleRun',{id:r.id});await restored.runPromise;
  assert.equal(restored.data.ruleRuns[0].status,'created');assert.deepEqual(restored.data.delegations[0].template,r.config.template);assert.equal(restored.data.delegations[0].outputFolder,'');assert.equal(restored.data.delegations[0].allowWeb,false);
});

test('A project can reserve only one rule, including recipe-based paused rules',async t=>{
  const {a,save}=await setup(t);await a.dispatch('projectSave',{name:'发布项目'});const p=a.data.projects[0];const r=await save({projectId:p.id});
  await assert.rejects(save({projectId:p.id,name:'另一条'}),/每个项目/);assert.equal(a.data.workRules.length,1);assert.equal(r.config.projectId,p.id);
});

test('A project with a manual delegation rejects a conflicting recipe-based rule',async t=>{
  const {a,save}=await setup(t,{models:true});await a.dispatch('projectSave',{name:'发布项目'});const p=a.data.projects[0];
  await a.dispatch('agentCreate',{projectId:p.id,goal:'手动委托',allowWeb:false,fileMode:'off'});await a.runPromise;
  await assert.rejects(save({projectId:p.id}),/每个项目/);assert.equal(a.data.workRules.length,0);assert.equal(a.data.delegations.length,1);
});

test('A recipe-based project rule reuses its canonical delegation and protects its grants on edit',async t=>{
  const {a,book,save,check}=await setup(t,{models:true});await a.dispatch('projectSave',{name:'发布项目'});const p=a.data.projects[0];const r=await save({projectId:p.id,enabled:true});
  await check(r);const j=a.data.delegations[0];j.status='completed';await a.dispatch('playbookArchive',{id:book.id,revision:book.revision,archived:true});await check(r);
  assert.equal(a.data.delegations.length,1);assert.equal(p.jobId,j.id);assert.equal(j.status,'ready');assert.equal(a.data.ruleRuns[0].status,'merged');assert.equal(j.template.revision,1);
  await assert.rejects(a.dispatch('ruleSave',{...r.config,id:r.id,allowWeb:true,enabled:true}),/授权范围/);assert.equal(r.revision,1);assert.equal(j.allowWeb,false);
});

test('Recipe-based change rules require a source, preserve custom intervals, and skip unchanged material',async t=>{
  const {a,folder,save,check,calls}=await setup(t,{models:true});await assert.rejects(save({trigger:'changes'}),/至少需要/);
  const r=await save({trigger:'changes',folderIds:['folder'],enabled:true});assert.equal((await check(r)).status,'created');const j=a.data.delegations[0];assert.equal(j.intervalMinutes,17);
  assert.equal((await check(r)).status,'unchanged');assert.equal(calls(),0);fs.writeFileSync(path.join(folder,'note.md'),'第二版计划');assert.equal((await check(r)).status,'merged');assert.equal(a.data.delegations.length,1);
});

test('Rule schedule and budget customization remain validated after preparing a recipe',async t=>{
  const {a,save}=await setup(t);
  for(const extra of [{time:'25:00'},{maxActions:0},{intervalMinutes:4},{dailyStarts:21}])await assert.rejects(save(extra));
  const r=await save({trigger:'weekly',weekday:4,time:'18:20',maxCalls:80,maxActions:3,dailyCalls:160,dailyStarts:2});
  assert.equal(r.config.maxCalls,undefined);assert.equal(r.config.maxActions,3);assert.equal(r.config.weekday,4);assert.equal(r.config.time,'18:20');assert.equal(a.data.workRules.length,1);
  assert.equal(new Date(rules.nextRun(r.config,new Date(2026,9,1,18,21).getTime())).getDay(),4);
});

test('Editing a project rule updates the canonical job goal, budget and cadence without refunding calls',async t=>{
  const {a,save,check}=await setup(t,{models:true});await a.dispatch('projectSave',{name:'长期项目'});const p=a.data.projects[0];const r=await save({projectId:p.id,enabled:true});await check(r);const j=a.data.delegations[0],id=j.id,oldGoal=j.goal;j.callsUsed=37;j.status='limited';
  await a.dispatch('ruleSave',{...r.config,id:r.id,goal:'新目标：列出延期风险',maxCalls:80,maxActions:2,intervalMinutes:60,enabled:true});
  assert.equal(j.id,id);assert.equal(p.jobId,id);assert.equal(j.goal,'新目标：列出延期风险');assert.equal(j.title,j.goal);assert.equal(j.maxCalls,undefined);assert.equal(j.maxActions,2);assert.equal(j.intervalMinutes,60);assert.equal(j.callsUsed,37);assert.equal(j.status,'ready');assert.equal(j.allowWeb,false);assert.equal(j.outputFolder,'');assert.equal(a.data.projectChanges[0].snapshot.job.goal,oldGoal);
});

test('Editing deprecated count fields preserves call statistics and explicit pause',async t=>{
  const {a,save,check}=await setup(t,{models:true});await a.dispatch('projectSave',{name:'长期项目'});const r=await save({projectId:a.data.projects[0].id,enabled:true});await check(r);const j=a.data.delegations[0];j.callsUsed=30;
  await a.dispatch('ruleSave',{...r.config,id:r.id,maxCalls:20,enabled:true});assert.equal(j.status,'ready');assert.equal(j.callsUsed,30);assert.equal(j.maxCalls,undefined);
  await a.dispatch('ruleSave',{...r.config,id:r.id,maxCalls:40,enabled:false});assert.equal(j.status,'paused');assert.equal(j.callsUsed,30);assert.equal(j.maxCalls,undefined);await a.dispatch('ruleResume',{id:r.id});assert.equal(j.status,'ready');
});

test('An uncertain project write rejects rule edits before mutating either rule or delegation',async t=>{
  const {a,save,check}=await setup(t,{models:true});await a.dispatch('projectSave',{name:'长期项目'});const r=await save({projectId:a.data.projects[0].id,enabled:true});await check(r);const j=a.data.delegations[0];j.status='needs_input';j.pendingActionId='uncertain-write';a.data.agentActions.push({id:'uncertain-write',jobId:j.id,status:'uncertain',tool:'write_file'});const before=JSON.stringify({r,j});
  await assert.rejects(a.dispatch('ruleSave',{...r.config,id:r.id,goal:'修改目标',maxCalls:80,enabled:true}),/外部执行结果尚未确认/);assert.equal(JSON.stringify({r,j}),before);
});

test('Undoing a project rule goal edit restores the displayed job title and retains consumed calls',async t=>{
  const {a,save,check}=await setup(t,{models:true});await a.dispatch('projectSave',{name:'长期项目'});const p=a.data.projects[0],r=await save({projectId:p.id,enabled:true});await check(r);const j=a.data.delegations[0],oldGoal=j.goal,oldTitle=j.title;j.callsUsed=12;
  await a.dispatch('ruleSave',{...r.config,id:r.id,goal:'更新后的目标\n新要求',maxCalls:80,enabled:true});assert.equal(j.title,'更新后的目标');
  await a.dispatch('projectUndo',{id:p.id,changeId:a.data.projectChanges[0].id});assert.equal(j.goal,oldGoal);assert.equal(j.title,oldTitle);assert.equal(j.callsUsed,12);assert.equal(j.maxCalls,undefined);assert.equal(j.status,'paused');assert.equal(r.status,'paused');
});

test('An existing project rule can be edited and saved paused after model configuration is removed',async t=>{
  const {a,save,check}=await setup(t,{models:true});await a.dispatch('projectSave',{name:'长期项目'});const r=await save({projectId:a.data.projects[0].id,enabled:true});await check(r);const j=a.data.delegations[0];await a.dispatch('deleteProvider',{id:a.data.providers[0].id});
  await a.dispatch('ruleSave',{...r.config,id:r.id,time:'16:20',maxCalls:60,enabled:false});assert.equal(r.status,'paused');assert.equal(r.config.time,'16:20');assert.equal(j.status,'paused');assert.equal(j.maxCalls,undefined);
  await assert.rejects(a.dispatch('ruleResume',{id:r.id}),/模型/);assert.equal(j.status,'paused');
});
