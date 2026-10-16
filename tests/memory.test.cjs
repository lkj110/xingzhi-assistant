const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const memory=require('../desktop/memory.cjs');

async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-memory-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('Memory changes must not call a model');}});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'离线测试模型',model:'fixture',baseUrl:'https://example.invalid/v1'});
  await a.dispatch('projectSave',{name:'项目甲'});await a.dispatch('projectSave',{name:'项目乙'});const [p2,p1]=a.data.projects;
  const save=input=>memory.dispatch(a,'memorySave',{kind:'preference',title:'简洁写作',content:'文档先说明结论，再列出依据。',...input});
  const source=(projectId=null,extra={})=>{const s={id:require('node:crypto').randomUUID(),title:'项目依据',content:'已确认周六交付',version:1,projectId,createdAt:new Date().toISOString(),...extra};a.data.sources.unshift(s);return s;};
  const job=projectId=>{const j=agent.buildJob(a,{projectId,goal:'交付调研结论',fileMode:'off',allowWeb:false,maxCalls:20});a.data.delegations.push(j);return j;};
  const task=async j=>{const result=await agent.act(a,j,'plan_task',{key:'report',title:'完成报告',criteria:'包含结论与引用',steps:[{kind:'draft',title:'编写报告'}]});return a.task(result.taskId);};
  return {a,p1,p2,save,source,job,task};
}

test('Work memory has explicit global and project boundaries and persists after restart',async t=>{
  const {a,p1,p2,save}=await setup(t);await save({title:'通用偏好'});await save({projectId:p1.id,title:'甲项目术语',kind:'term'});await save({projectId:p2.id,title:'乙项目事实',kind:'fact'});
  assert.deepEqual(memory.context(a,null).items.map(m=>m.title),['通用偏好']);
  assert.deepEqual(memory.context(a,p1.id).items.map(m=>m.title),['甲项目术语','通用偏好']);
  assert.deepEqual(memory.context(a,p2.id).items.map(m=>m.title),['乙项目事实','通用偏好']);
  const reloaded=new Assistant({dir:a.dir});assert.equal(reloaded.data.memories.length,3);assert.equal(memory.context(reloaded,p1.id).items[0].scope,'project');
  assert.ok(reloaded.publicState().memories.every(m=>m.effective&&m.confirmedBy==='user'));
});
test('Memory citations cannot expose project materials to global or another project context',async t=>{
  const {a,p1,p2,save,source}=await setup(t);const s=source(p1.id),global=source();
  await assert.rejects(save({sourceId:s.id}),/相同作用范围/);await assert.rejects(save({projectId:p2.id,sourceId:s.id}),/相同作用范围/);
  await assert.rejects(save({projectId:p1.id,sourceId:global.id}),/相同作用范围/);await save({projectId:p1.id,sourceId:s.id});
  const c=memory.context(a,p1.id).items[0];assert.equal(c.sourceId,s.id);assert.equal(c.sourceVersion,1);assert.equal(c.version,1);
});
test('Superseded, withdrawn, excluded, changed and missing citations never reach the model',async t=>{
  const {a,p1,save,source}=await setup(t);const original=source(p1.id);await save({projectId:p1.id,sourceId:original.id});
  const reason=()=>memory.enrich(a.data).memories[0].reason;
  original.deleted=true;assert.equal(memory.context(a,p1.id).items.length,0);assert.match(reason(),/撤回/);delete original.deleted;
  original.projectExcluded=true;assert.equal(memory.context(a,p1.id).items.length,0);assert.match(reason(),/撤销/);delete original.projectExcluded;
  original.content='编辑后改为周日';assert.equal(memory.context(a,p1.id).items.length,0);assert.match(reason(),/内容已变化/);original.content='已确认周六交付';
  source(p1.id,{previousSourceId:original.id,version:2});assert.equal(memory.context(a,p1.id).items.length,0);assert.match(reason(),/新版本/);
  a.data.sources=a.data.sources.filter(s=>s.id!==original.id);assert.equal(memory.context(a,p1.id).items.length,0);assert.match(reason(),/删除/);
});
test('Expired memories and removed projects are clearly inactive',async t=>{
  const {a,p1,save}=await setup(t);await save({projectId:p1.id,expiresAt:new Date(Date.now()+3600000).toISOString()});const m=a.data.memories[0];
  assert.equal(memory.context(a,p1.id).items.length,1);m.expiresAt='2020-01-01T00:00:00Z';assert.equal(memory.context(a,p1.id).items.length,0);assert.match(memory.enrich(a.data).memories[0].reason,/过期/);
  m.expiresAt=null;a.data.projects=[];assert.equal(memory.context(a,p1.id).items.length,0);assert.match(memory.enrich(a.data).memories[0].reason,/项目已不存在/);
});
test('Save validates scope, fields, types and expiry before changing state',async t=>{
  const {a,save}=await setup(t);
  for(const [bad,pattern] of [[{title:''},/标题/],[{content:'x'.repeat(2001)},/内容/],[{projectId:'missing'},/项目/],[{kind:'authorization'},/请选择/],[{enabled:'true'},/状态/],[{expiresAt:'bad'},/未来时间/],[{expiresAt:'2020-01-01'},/未来时间/]])await assert.rejects(save(bad),pattern);
  assert.equal(a.data.memories.length,0);
});
test('Updates, toggles and deletion enforce optimistic versions',async t=>{
  const {a,save}=await setup(t);await save({});let m=a.data.memories[0];const original={...m};
  await memory.dispatch(a,'memorySave',{...m,content:'每项结论须有来源'});m=a.data.memories[0];assert.equal(m.version,2);
  await assert.rejects(memory.dispatch(a,'memoryToggle',{id:m.id,version:original.version,enabled:false}),/版本已变化/);
  await assert.rejects(memory.dispatch(a,'memoryDelete',{id:m.id}),/版本已变化/);
  await memory.dispatch(a,'memoryToggle',{id:m.id,version:2,enabled:false});m=a.data.memories[0];assert.equal(m.version,3);assert.equal(memory.context(a).items.length,0);
  await memory.dispatch(a,'memoryToggle',{id:m.id,version:3,enabled:true});assert.equal(memory.context(a).items.length,1);
  await memory.dispatch(a,'memoryDelete',{id:m.id,version:4});assert.equal(a.data.memories.length,0);
});
test('Enabling invalid memory requires correcting it instead of reviving stale evidence',async t=>{
  const {a,save}=await setup(t);await save({enabled:false});const m=a.data.memories[0];m.expiresAt='2020-01-01';
  await assert.rejects(memory.dispatch(a,'memoryToggle',{id:m.id,version:m.version,enabled:true}),/过期/);assert.equal(m.enabled,false);
});
test('Project memory edits invalidate only affected pending approvals and preserve manual pauses',async t=>{
  const {a,p1,p2,save,job,task}=await setup(t);const j1=job(p1.id),j2=job(p2.id),t1=await task(j1),t2=await task(j2);
  j1.status='paused';a.data.agentActions.push({id:'pending',jobId:j1.id,status:'pending'});j1.pendingActionId='pending';
  const permissions=JSON.stringify([j1.fileMode,j1.allowWeb,j1.githubMode,j1.folderIds]);await save({projectId:p1.id});
  assert.equal(j1.status,'paused');assert.equal(j1.pendingActionId,null);assert.equal(a.data.agentActions[0].status,'stale');assert.match(t1.needsReplan,/记忆/);assert.ok(!t2.needsReplan);assert.equal(j2.feedback.length,0);
  assert.equal(JSON.stringify([j1.fileMode,j1.allowWeb,j1.githubMode,j1.folderIds]),permissions);
});
test('Global edits affect unfinished jobs while completed work stays completed',async t=>{
  const {a,p1,p2,save,job,task}=await setup(t);const unfinished=job(p1.id),completed=job(p2.id);const current=await task(unfinished),old=await task(completed);completed.status='completed';old.status='completed';
  await save({});assert.match(current.needsReplan,/记忆/);assert.equal(completed.status,'completed');assert.equal(old.status,'completed');assert.ok(!old.needsReplan);
});
test('Uncertain external results reject the whole memory mutation atomically',async t=>{
  const {a,p1,save,job,task}=await setup(t);const j=job(p1.id),item=await task(j);a.data.agentActions.push({id:'uncertain',jobId:j.id,status:'uncertain'});
  await assert.rejects(save({}),/尚未确认/);assert.equal(a.data.memories.length,0);assert.equal(j.feedback.length,0);assert.ok(!item.needsReplan);
  await save({enabled:false});assert.equal(a.data.memories.length,1,'inactive changes cannot alter the job context');
});
test('Ongoing operations reject all mutations and decision draft reads',async t=>{
  const {a,save}=await setup(t);a.operation={label:'执行中'};
  await assert.rejects(save({}),/助手正在处理/);await assert.rejects(memory.dispatch(a,'memoryDraftDecision',{id:'anything'}),/助手正在处理/);assert.equal(a.data.memories.length,0);
});
test('Decision drafts remain unsaved and require an explicit user save',async t=>{
  const {a,p1,source}=await setup(t);const s=source(p1.id);a.data.decisions.push({id:'decision',projectId:p1.id,kind:'question',status:'answered',question:'发布日期？',answer:'周六发布',sourceIds:[s.id]});
  const {draft,warning}=await memory.dispatch(a,'memoryDraftDecision',{id:'decision'});assert.equal(a.data.memories.length,0);assert.equal(draft.sourceId,s.id);assert.equal(warning,'');
  await memory.dispatch(a,'memorySave',draft);assert.equal(a.data.memories.length,1);assert.equal(a.data.memories[0].originDecisionId,'decision');assert.equal(a.data.memories[0].confirmedBy,'user');
  a.data.decisions[0].status='resolved';await assert.rejects(memory.dispatch(a,'memoryDraftDecision',{id:'decision'}),/用户回答/);
});
test('Oversized decision answers are visibly shortened in the draft only',async t=>{
  const {a}=await setup(t);a.data.decisions.push({id:'long',kind:'question',status:'answered',question:'格式要求',answer:'字'.repeat(2500),sourceIds:[]});
  const result=await memory.dispatch(a,'memoryDraftDecision',{id:'long'});assert.equal(result.draft.content.length,2000);assert.match(result.warning,/截取/);assert.equal(a.data.memories.length,0);
});
test('Context is fully bounded and reports every omitted effective record',async t=>{
  const {a,p1,save}=await setup(t);for(let i=0;i<12;i++)await save({projectId:i<2?p1.id:null,title:`记忆${i}`,content:'重要事实。'.repeat(400)});
  const c=memory.context(a,p1.id);assert.ok(JSON.stringify(c).length<=16000);assert.ok(c.omittedCount>0);assert.equal(c.items.length+c.omittedCount,12);assert.match(c.warning,/未纳入/);assert.equal(c.items[0].projectId,p1.id);
  assert.equal(memory.enrich(a.data).memoryUsage.find(u=>u.projectId===p1.id).omittedCount,c.omittedCount);
});
test('Maximum record count is enforced before a new save',async t=>{
  const {a,save}=await setup(t);await save({});const seed=a.data.memories[0];a.data.memories=Array.from({length:100},(_,i)=>({...seed,id:`memory-${i}`}));
  await assert.rejects(save({title:'第101条'}),/最多保存 100/);assert.equal(a.data.memories.length,100);
});
test('Unconfirmed or malformed persisted records stay out of model context',async t=>{
  const {a,save}=await setup(t);await save({});const m=a.data.memories[0];m.confirmedBy='agent';assert.equal(memory.context(a).items.length,0);assert.match(memory.enrich(a.data).memories[0].reason,/用户确认/);
  m.confirmedBy='user';m.content={text:'malformed'};assert.equal(memory.context(a).items.length,0);assert.match(memory.enrich(a.data).memories[0].reason,/内容无效/);
});
test('Reconcile invalidates approval after expiry without changing a running job status',async t=>{
  const {a,p1,save,job,task}=await setup(t);await save({expiresAt:new Date(Date.now()+3600000).toISOString()});const j=job(p1.id);await task(j);memory.reconcile(a,j);j.status='running';a.data.agentActions.push({id:'pending',jobId:j.id,status:'pending'});j.pendingActionId='pending';
  a.data.memories[0].expiresAt='2020-01-01';assert.equal(memory.reconcile(a,j),true);assert.equal(j.status,'running');assert.equal(j.pendingActionId,null);assert.equal(a.data.agentActions[0].status,'stale');assert.equal(memory.reconcile(a,j),false);
});
test('Reconcile respects uncertain outcomes until the external result is checked',async t=>{
  const {a,p1,save,job}=await setup(t);await save({});const j=job(p1.id);memory.reconcile(a,j);a.data.memories[0].enabled=false;a.data.agentActions.push({id:'uncertain',jobId:j.id,status:'uncertain'});
  const before=j.memorySignature;assert.throws(()=>memory.reconcile(a,j),/尚未确认/);assert.equal(j.memorySignature,before);assert.equal(a.data.agentActions[0].status,'uncertain');
});
test('Actual planner, execution, task verification and goal verification payloads contain only effective scoped memory',async t=>{
  const {a,p1,p2,save,job,source}=await setup(t);await save({title:'全局可见',content:'global-visible'});await save({projectId:p1.id,title:'甲可见',content:'p1-visible'});await save({projectId:p2.id,title:'乙隔离',content:'p2-secret'});await save({title:'已过期',content:'expired-secret',expiresAt:new Date(Date.now()+3600000).toISOString()});a.data.memories[0].expiresAt='2020-01-01';
  const s=source(p1.id);await save({projectId:p1.id,title:'来源撤回',content:'withdrawn-secret',sourceId:s.id});s.deleted=true;
  const captured=[];a.chat=async(_provider,_key,messages)=>{captured.push({prompt:messages[0].content,payload:JSON.parse(messages[1].content)});if(messages[0].content.includes('动作格式'))return {tool:'plan_task',args:{key:'report',title:'完整报告',criteria:'结论与引用',steps:[{kind:'draft',title:'编写报告'}]},reason:'开始'};if(messages[0].content.includes('推进给定事项'))return {kind:'artifact',title:'报告',content:'已依据有效工作记忆形成报告'};return {passed:true,summary:'符合目标',gaps:[]};};
  const j=job(p1.id);j.maxActions=1;await agent.run(a,j.id);assert.equal(captured.length,1);await a.advance(j.taskIds[0]);await agent.act(a,j,'complete',{});assert.equal(j.status,'completed');assert.equal(captured.length,4);
  for(const call of captured){assert.deepEqual(new Set(call.payload.workMemory.items.map(m=>m.content)),new Set(['global-visible','p1-visible']));assert.ok(!JSON.stringify(call.payload).includes('p2-secret'));assert.ok(!JSON.stringify(call.payload).includes('expired-secret'));assert.ok(!JSON.stringify(call.payload).includes('withdrawn-secret'));}
  assert.ok(captured.some(c=>c.prompt.includes('独立检查事项')));assert.ok(captured.some(c=>c.prompt.includes('独立核对整体')));
});
test('Information extraction uses global memory and never unrelated project facts',async t=>{
  const {a,p1,save,source}=await setup(t);await save({content:'global-extraction'});await save({projectId:p1.id,content:'project-secret'});const s=source();s.state='new';let payload;
  a.chat=async(_provider,_key,messages)=>{payload=JSON.parse(messages[1].content);return {tasks:[],summary:'背景材料无需新建事项'};};await a.extract([s.id]);assert.equal(payload.workMemory.items.length,1);assert.equal(payload.workMemory.items[0].content,'global-extraction');assert.ok(!JSON.stringify(payload).includes('project-secret'));
});
test('Expired memory invalidates a waiting approval before authorization is saved',async t=>{
  const {a,p1,save,job,task}=await setup(t);await save({expiresAt:new Date(Date.now()+3600000).toISOString()});const j=job(p1.id);await task(j);j.status='approval';j.pendingActionId='pending';a.data.agentActions.push({id:'pending',jobId:j.id,status:'pending',tool:'write_file',taskId:j.taskIds[0],version:'fixture'});a.data.memories[0].expiresAt='2020-01-01';
  await assert.rejects(a.dispatch('agentApprove',{id:j.id,actionId:'pending',version:'fixture'}),/工作记忆已变化/);assert.equal(a.data.agentActions[0].status,'stale');assert.ok(!a.data.agentActions[0].approvedAt);assert.equal(j.pendingActionId,null);
});
test('Source changes while watching trigger planning even when remote polling finds no further change',async t=>{
  const {a,p1,save,source,job}=await setup(t);const s=source(p1.id);await save({projectId:p1.id,sourceId:s.id});const j=job(p1.id);j.status='watching';s.deleted=true;let calls=0;
  a.chat=async()=>{calls++;return {tool:'ask',args:{question:'来源已撤回，需要新的依据'},reason:'核对来源'};};await agent.run(a,j.id,{check:true});assert.equal(calls,1);assert.equal(j.status,'needs_input');
});
test('Backup restore preserves current memory deletions and edits while pausing restored work',async t=>{
  const {a,p1,save,job}=await setup(t);await save({title:'稍后删除'});const deleted=a.data.memories[0];await save({title:'稍后修改'});const kept=a.data.memories[0];const j=job(p1.id);a.save();const recovery=require('../desktop/recovery.cjs'),backup=recovery.create(a);
  await memory.dispatch(a,'memoryDelete',{id:deleted.id,version:deleted.version});await memory.dispatch(a,'memorySave',{...kept,content:'恢复备份后也应使用最新用户确认'});recovery.restore(a,backup);
  assert.equal(a.data.memories.length,1);assert.equal(a.data.memories[0].content,'恢复备份后也应使用最新用户确认');assert.equal(a.data.memories[0].version,2);assert.equal(a.data.delegations.find(r=>r.id===j.id).status,'paused');assert.equal(a.data.settings.automatic,false);
});
test('Library hides inactive memories by default and exposes the reason only with history enabled',async t=>{
  const {a,p1,save}=await setup(t);await save({projectId:p1.id,title:'发布条件',expiresAt:new Date(Date.now()+3600000).toISOString()});a.data.memories[0].expiresAt='2020-01-01';
  const library=require('../desktop/library.cjs');assert.equal(library.search(a,{query:'发布条件',type:'memory'}).total,0);const result=library.search(a,{query:'发布条件',type:'memory',history:true});assert.equal(result.total,1);assert.match(result.items[0].status,/过期/);assert.equal(result.items[0].current,false);
});
test('Project imports invalidate cited memory before a delegation exists and preserve reverted versions',async t=>{
  const {a,p1,save}=await setup(t);const material={title:'交付要求',projectId:p1.id,origin:'手动输入'};
  await a.dispatch('import',{items:[{...material,content:'周五发布'}]});const first=a.data.sources[0];await save({projectId:p1.id,title:'发布时间',content:'周五发布',sourceId:first.id});
  await a.dispatch('import',{items:[{...material,content:'周六发布'}]});assert.equal(a.data.sources[0].previousSourceId,first.id);assert.equal(memory.context(a,p1.id).items.length,0);assert.match(memory.enrich(a.data).memories[0].reason,/新版本/);
  await a.dispatch('import',{items:[{...material,content:'周五发布'}]});const latest=a.data.sources[0];assert.equal(latest.version,3);assert.notEqual(latest.id,first.id);assert.equal(memory.context(a,p1.id).items.length,0,'reverting content does not silently reconfirm old memory');
  await memory.dispatch(a,'memorySave',{...a.data.memories[0],sourceId:latest.id});assert.equal(memory.context(a,p1.id).items[0].sourceVersion,3);assert.equal(a.data.delegations.length,0);
});
test('A copied source in another project cannot supersede memory from its original scope',async t=>{
  const {a,p1,p2,save,source}=await setup(t);const s=source(p1.id);await save({projectId:p1.id,sourceId:s.id});source(p2.id,{previousSourceId:s.id});assert.equal(memory.context(a,p1.id).items.length,1);
});
test('An automatic memory change with an uncertain external write reports required input',async t=>{
  const {a,p1,save,job}=await setup(t);await save({});const j=job(p1.id);a.data.memories[0].enabled=false;j.pendingActionId='uncertain';a.data.agentActions.push({id:'uncertain',jobId:j.id,status:'uncertain'});
  assert.throws(()=>memory.reconcile(a,j),error=>error.requiresInput===true);assert.equal(j.callsUsed,0);assert.equal(a.data.agentActions[0].status,'uncertain');assert.equal(j.pendingActionId,'uncertain');
});
