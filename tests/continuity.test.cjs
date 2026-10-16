const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Assistant,modelChat}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const plans=require('../desktop/agent-plan.cjs');
const writes=require('../desktop/agent-writes.cjs');
const followup=require('../desktop/agent-followup.cjs');
const {fixture,cases,evaluateCase}=require('../desktop/agent-eval.cjs');
async function setup(t,options={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-continuity-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=path.join(dir,'input'),output=path.join(dir,'output');fs.mkdirSync(input);fs.mkdirSync(output);
  fs.writeFileSync(path.join(input,'a.md'),'A：周五发布');fs.writeFileSync(path.join(input,'b.md'),'B：周日维护');
  const env=fixture({id:'test'});
  const a=new Assistant({dir,agentRequest:env.request,chat:async(p,k,m,opts)=>{
    opts.onUsage?.({inputTokens:100,outputTokens:20});
    if(m[0].content.includes('独立判断等待条件'))return {satisfied:true,quote:'已确认周六发布',reason:'新文件明确确认'};
    if(m[0].content.includes('动作格式'))return {tool:'ask',args:{question:'测试停靠'}};
    if(m[0].content.includes('推进给定事项'))return {kind:'artifact',title:'方案',content:'# 方案\n周五发布，负责人李青，1% 回滚。'};
    return {passed:true,summary:'已核验',gaps:[]};
  }});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture',inputPrice:2,outputPrice:4});
  a.data.folders=[{id:'folder',path:input,name:'资料'}];a.data.agentSettings.outputFolder=output;
  await a.dispatch('agentSettings',{githubRepo:'eval/work',githubToken:'fixture'});
  await a.dispatch('agentCreate',{goal:'测试委托',folderIds:['folder'],useOutputFolder:true,fileMode:'auto',useGithub:true,githubMode:'auto',githubUpdateMode:'auto',githubCommentMode:'auto',...options});await a.runPromise;
  const job=a.data.delegations[0];job.status='ready';
  const act=(tool,args)=>agent.act(a,job,tool,args);
  const plan=(key,extra={})=>act('plan_task',{key,title:key,criteria:'完成方案',steps:[{key:'draft',title:'编写方案',kind:'draft'}],...extra});
  const advance=async id=>{a.activeAgentJob=job;try{await act('advance_task',{taskId:id});}finally{a.activeAgentJob=null;}};
  return {a,job,act,plan,advance,input,output,env};
}
test('Plan edits preserve unaffected completed steps, reset the changed suffix, and keep history',async t=>{
  const {a,plan,advance}=await setup(t);
  const {taskId}=await plan('report',{steps:[{key:'read',title:'分析事实',kind:'analysis'},{key:'draft',title:'写报告',kind:'draft'},{key:'save',title:'保存',kind:'external',tool:'write_file'}]});
  await advance(taskId);await advance(taskId);const task=a.task(taskId),first=task.steps[0].artifactId,second=task.steps[1].artifactId;
  await plan('report',{reason:'增加灰度说明',resetSteps:['draft'],steps:[{key:'read',title:'分析事实',kind:'analysis'},{key:'draft',title:'写报告和灰度说明',kind:'draft'},{key:'save',title:'保存',kind:'external',tool:'write_file'}]});
  assert.equal(task.steps[0].artifactId,first);assert.equal(task.steps[1].done,false);assert.equal(task.steps[1].artifactId,undefined);assert.equal(task.planHistory.length,1);assert.ok(a.data.artifacts.some(r=>r.id===second));
  const before=JSON.stringify(task);await assert.rejects(plan('report',{reason:'bad',steps:[{key:'x',title:'x',kind:'draft'},{key:'x',title:'y',kind:'draft'}]}),/重复/);assert.equal(JSON.stringify(task),before);
});
test('Dependencies block both Agent and direct advance, reject cycles, and invalidate downstream work',async t=>{
  const {a,plan,advance,act}=await setup(t);const first=await plan('分析'),second=await plan('建议',{dependsOn:[first.taskId]});
  await assert.rejects(a.advance(second.taskId),/前置/);
  await assert.rejects(plan('分析',{dependsOn:[second.taskId],reason:'循环'}),/循环/);
  await advance(first.taskId);await advance(second.taskId);assert.equal(a.task(first.taskId).status,'completed');assert.equal(a.task(first.taskId).acceptedBy,'policy');assert.equal(a.task(second.taskId).status,'review');
  await assert.rejects(act('revise_task',{taskId:first.taskId,note:'新事实'}),/不能自动修订/);
  await a.dispatch('updateTask',{id:first.taskId,criteria:'纳入用户补充的新事实'});
  await act('revise_task',{taskId:first.taskId,note:'新事实'});assert.ok(a.task(second.taskId).needsReplan);assert.equal(a.task(second.taskId).status,'todo');
});
test('Source changes affect linked tasks only, retain history and mark the superseded source',async t=>{
  const {a,job,act,plan,advance,input}=await setup(t);
  const sa=await act('read_file',{folderId:'folder',name:'a.md'}),sb=await act('read_file',{folderId:'folder',name:'b.md'});
  const ta=await plan('A',{sourceIds:[sa.sourceId]}),tb=await plan('B',{sourceIds:[sb.sourceId]});await advance(ta.taskId);await advance(tb.taskId);
  fs.writeFileSync(path.join(input,'a.md'),'A：周六发布');assert.equal(await agent.checkSources(a,job),true);
  assert.ok(a.task(ta.taskId).needsReplan);assert.equal(a.task(tb.taskId).status,'review');assert.deepEqual(a.task(tb.taskId).sourceIds,[sb.sourceId]);
  assert.deepEqual(a.context(a.task(ta.taskId)).sources.map(s=>s.content),['A：周六发布']);
  await assert.rejects(act('advance_task',{taskId:ta.taskId}),/核对/);
});
test('Canonical read args deduplicate watchers even when taskId is supplied',async t=>{
  const {a,job,act,plan}=await setup(t);const {taskId}=await plan('issue');
  await act('github_read',{number:1,taskId});await act('github_read',{taskId,number:1});assert.equal(job.watchers.length,1);assert.deepEqual(job.watchers[0].taskIds,[taskId]);assert.equal(a.task(taskId).sourceIds.length,1);
});
test('Repository discovery and folder discovery create reusable watches without URL arguments',async t=>{
  const {a,job,act}=await setup(t);const repo=await act('github_list',{}),folder=await act('list_files',{folderId:'folder'});
  assert.equal(repo.issues[0].number,1);assert.equal(folder.files.length,2);assert.equal(job.watchers.length,2);
  await act('github_list',{});await act('list_files',{folderId:'folder'});assert.equal(job.watchers.length,2);assert.equal(await agent.checkSources(a,job),false);
});
test('Cancellation preserves artifacts but cannot satisfy a dependency or finish an empty delegation',async t=>{
  const {a,act,plan,advance}=await setup(t);const first=await plan('first'),second=await plan('second',{dependsOn:[first.taskId]});await advance(first.taskId);
  await act('cancel_task',{taskId:first.taskId,reason:'无需继续'});assert.equal(a.task(first.taskId).agentCancelled,true);assert.ok(a.data.artifacts.length);
  await assert.rejects(advance(second.taskId),/变化|核对|前置/);await act('cancel_task',{taskId:second.taskId,reason:'整体取消'});await assert.rejects(act('complete',{}),/检查/);
});
test('Latest file is stable, history remains readable, and human edits are not overwritten',async t=>{
  const {a,job,act,plan,advance,output}=await setup(t);const {taskId}=await plan('report');await advance(taskId);
  const first=await act('write_file',{taskId});await act('revise_task',{taskId,note:'调整为周六'});
  a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});return {kind:'patch',edits:[{before:JSON.parse(m[1].content).revision?.originalContent||'unused',after:'周六发布'}]};};await assert.rejects(advance(taskId),e=>e.code==='MODEL_INVALID_RESPONSE'&&e.automaticRetry); // Malformed verification schedules recovery; the generated artifact survives.
  const second=await act('write_file',{taskId});assert.equal(first.latestPath,second.latestPath);assert.notEqual(first.path,second.path);assert.match(fs.readFileSync(first.path,'utf8'),/周五/);assert.equal(fs.readFileSync(second.latestPath,'utf8'),'周六发布');
  fs.writeFileSync(second.latestPath,'人工补充');await act('revise_task',{taskId,note:'再次修改'});a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});return {kind:'patch',edits:[{before:'周六发布',after:'新版'}]};};await assert.rejects(advance(taskId),e=>e.code==='MODEL_INVALID_RESPONSE'&&e.automaticRetry);
  await assert.rejects(act('write_file',{taskId}),/人工修改/);assert.equal(fs.readFileSync(second.latestPath,'utf8'),'人工补充');
  assert.ok(fs.readdirSync(output).length>=3);assert.equal(job.status,'ready');
});
test('Positive verdict cannot finish after delivery is removed or modified',async t=>{
  const {act,plan,advance}=await setup(t);const {taskId}=await plan('report');await advance(taskId);const result=await act('write_file',{taskId});fs.writeFileSync(result.path,'被篡改');await assert.rejects(act('complete',{}),/修改|丢失/);
});
test('GitHub update changes the existing issue, reads back evidence, and respects separate permissions',async t=>{
  const {a,job,act,plan,advance,env}=await setup(t);const {taskId}=await plan('新方案');await act('github_read',{number:1,taskId});await advance(taskId);
  job.githubUpdateMode='off';await assert.rejects(act('github_update',{taskId,number:1}),/未允许/);job.githubUpdateMode='auto';
  const result=await act('github_update',{taskId,number:1,state:'closed'});assert.equal(result.verified,true);assert.equal(env.issues.length,1);assert.equal(env.issues[0].state,'closed');assert.match(env.issues[0].body,/周五/);
  await act('github_update',{taskId,number:1,state:'closed'});assert.equal(env.requests.filter(r=>r.method==='PATCH').length,1);
  assert.equal(a.data.agentActions[0].status,'done');
});
test('Human GitHub edit after approval preparation prevents PATCH and exposes exact previous/next versions',async t=>{
  const {a,job,act,plan,advance,env}=await setup(t,{githubUpdateMode:'ask'});const {taskId}=await plan('新方案');await act('github_read',{number:1,taskId});await advance(taskId);
  await act('github_update',{taskId,number:1});const pending=a.data.agentActions[0];assert.match(pending.baseline.body,/尚未确认/);assert.match(pending.desired.body,/周五/);
  env.issues[0].body='人工变更';await a.dispatch('agentApprove',{id:job.id});await assert.rejects(writes.execute(a,job,pending),/被修改/);assert.equal(env.requests.filter(r=>r.method==='PATCH').length,0);assert.equal(env.issues[0].body,'人工变更');
});
test('An accepted PATCH with lost response reconciles after reload without a second PATCH',async t=>{
  const {a,job,act,plan,advance,env}=await setup(t);const {taskId}=await plan('新方案');await act('github_read',{number:1,taskId});await advance(taskId);
  const base=a.agentRequest;a.agentRequest=async(url,opts)=>{const r=await base(url,opts);if(opts?.method==='PATCH')throw new Error('lost response');return r;};
  await assert.rejects(act('github_update',{taskId,number:1}),/lost/);assert.equal(a.data.agentActions[0].status,'uncertain');
  const restored=new Assistant({dir:a.dir,agentRequest:base});await agent.act(restored,restored.data.delegations[0],'github_update',{taskId,number:1});assert.equal(env.requests.filter(r=>r.method==='PATCH').length,1);assert.equal(restored.data.agentActions[0].status,'done');
});
test('Comments use independent authorization, deduplicate content and enforce cooldown',async t=>{
  const {a,job,act,plan,advance,env}=await setup(t);const {taskId}=await plan('跟进');await act('github_read',{number:1,taskId});await advance(taskId);
  job.githubCommentMode='off';await assert.rejects(act('github_comment',{taskId,number:1,body:'请确认'}),/未允许/);job.githubCommentMode='auto';
  await act('github_comment',{taskId,number:1,body:'请确认'});await act('github_comment',{taskId,number:1,body:'请确认'});assert.equal(env.comments.length,1);
  await assert.rejects(act('github_comment',{taskId,number:1,body:'再问一次'}),/冷却/);assert.equal(a.data.agentActions.length,1);
});
test('Lost comment response is reconciled without reposting, including after restart',async t=>{
  const {a,act,plan,advance,env}=await setup(t);const {taskId}=await plan('跟进');await act('github_read',{number:1,taskId});await advance(taskId);
  const base=a.agentRequest;a.agentRequest=async(url,opts)=>{const r=await base(url,opts);if(opts?.method==='POST')throw new Error('lost');return r;};
  await assert.rejects(act('github_comment',{taskId,number:1,body:'请回复'}),/lost/);
  const restored=new Assistant({dir:a.dir,agentRequest:base});await agent.act(restored,restored.data.delegations[0],'github_comment',{taskId,number:1,body:'请回复'});assert.equal(env.comments.length,1);assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});
test('Structured follow-up requires new matching evidence and unchanged polling uses no model calls',async t=>{
  const {a,job,act,input}=await setup(t);const s=await act('read_file',{folderId:'folder',name:'a.md'});
  await act('wait',{key:'reply',reason:'等待确认',expected:'收到周六确认',sourceIds:[s.sourceId],deadlineAt:new Date(Date.now()+3600000).toISOString()});const used=job.callsUsed;
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.callsUsed,used);
  await assert.rejects(act('resolve_wait',{key:'reply',sourceId:s.sourceId,evidence:'旧材料'}),/新取得/);
  fs.writeFileSync(path.join(input,'a.md'),'已确认周六发布');await agent.checkSources(a,job);await act('resolve_wait',{key:'reply',sourceId:job.watchers[0].sourceId,evidence:'明确确认周六发布'});assert.equal(job.followups[0].status,'resolved');
});
test('Timeout notifies once without a model request; replan policy wakes the planner',async t=>{
  const {a,job,act}=await setup(t);const s=await act('read_file',{folderId:'folder',name:'a.md'});
  await act('wait',{key:'deadline',reason:'等客户',expected:'客户确认',sourceIds:[s.sourceId],deadlineAt:new Date(Date.now()-1000).toISOString(),onTimeout:'notify'});const calls=job.callsUsed;
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,'needs_input');assert.equal(job.callsUsed,calls);assert.equal(a.data.events.filter(e=>e.title==='Agent 跟进超时').length,1);
  followup.due(a,job);assert.equal(a.data.events.filter(e=>e.title==='Agent 跟进超时').length,1);
  job.followups[0].timedOutAt=null;job.followups[0].onTimeout='replan';assert.deepEqual(followup.due(a,job),{wake:true,notify:false});
});
test('Deadline reminders persist one stage without changing priority or resuming paused work',async t=>{
  const {a,job,plan}=await setup(t),scheduler=require('../desktop/deadline-scheduler.cjs'),events=require('../desktop/deadline-events.cjs');
  t.after(()=>scheduler.dispose(a));
  const {taskId}=await plan('紧急',{dueAt:new Date(Date.now()+3600000).toISOString(),priority:'low'}),task=a.task(taskId);
  job.status='watching';followup.deadlines(a,job);const first=events.view(a.data,task).event.id;followup.deadlines(a,job);
  assert.equal(job.status,'watching');assert.equal(task.priority,'low');assert.equal(events.view(a.data,task).stage,'imminent');
  assert.equal(Object.values(events.state(a).events).filter(e=>e.status==='active').length,1);assert.equal(events.view(a.data,task).event.id,first);
  job.status='paused';await a.dispatch('updateTask',{id:taskId,dueAt:new Date(Date.now()-1000).toISOString()});followup.deadlines(a,job);
  assert.equal(job.status,'paused');assert.equal(task.priority,'low');assert.equal(events.pendingNotifications(a).count,1);assert.equal(scheduler.pending(a,job).length,0);
});
test('Usage and digest survive reload without leaking credentials',async t=>{
  const {a,job,plan,advance}=await setup(t);const {taskId}=await plan('报告');await advance(taskId);
  assert.equal(job.usage.reportedCalls,3);assert.equal(job.usage.inputTokens,300);assert.ok(Math.abs(job.usage.estimatedUSD-0.00084)<1e-10);
  a.chat=async()=>({ok:true});a.activeAgentJob=job;await a.callModel(a.data.providers[0],'',[]);a.activeAgentJob=null;assert.equal(job.usage.unknownCalls,1);
  job.status='needs_input';job.summary='需要决定';a.save();const restored=new Assistant({dir:a.dir});const state=restored.publicState();assert.equal(state.agentDigest.attention[0].detail,'需要决定');assert.equal(state.delegations[0].usage.inputTokens,300);assert.equal(JSON.stringify(state).includes(a.data.agentSettings.githubToken),false);
});
test('The real-model acceptance runner uses actual agent execution in an isolated fixture workspace',async t=>{
  const {a}=await setup(t);const business=()=>{const state=structuredClone(a.data);delete state.runtime?.commitId;delete state.runtime?.revision;return JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key])=>!['modelCalls','stewardship','spendMeter'].includes(key))));};const before=business(),commitBefore=a.data.runtime.commitId,revisionBefore=a.data.runtime.revision,callsBefore=a.publicState().stewardshipStatus.used;let count=0;
  a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});if(m[0].content.includes('独立判断等待条件'))return {satisfied:true,quote:'已确认周六发布',reason:'新文件明确确认'};
    if(m[0].content.includes('动作格式')){const ctx=JSON.parse(m[1].content),taskId=ctx.tasks[0]?.id;return [
    {tool:'read_file',args:{folderId:'materials',name:'需求.md'}},
    {tool:'plan_task',args:{key:'r',title:'发布报告',criteria:'日期、负责人、回滚条件',sourceIds:ctx.sources.map(s=>s.id),steps:[{key:'draft',title:'写报告',kind:'draft'}]}},
    {tool:'advance_task',args:{taskId}},{tool:'write_file',args:{taskId}},{tool:'complete',args:{}}
  ][count++];}if(m[0].content.includes('推进给定'))return {kind:'artifact',content:'周五，李青，1% 回滚。'};return {passed:true,summary:'符合要求',gaps:[]};};
  let captured;const result=await evaluateCase(a,cases[0],{capture:value=>{captured=value;}});assert.equal(captured.files.length,2);assert.ok(captured.files.some(f=>f.content.includes('周五')));assert.equal(JSON.stringify(captured.state).includes('sealedKey'),false);assert.equal(result.passed,true);assert.equal(result.files,1);assert.equal(result.duplicateWrites,0);assert.equal(business(),before);assert.notEqual(a.data.runtime.commitId,commitBefore);assert.ok(a.data.runtime.revision>revisionBefore);assert.equal(a.publicState().stewardshipStatus.used,callsBefore+result.calls);assert.equal(a.data.modelCalls.filter(r=>r.stage==='evaluation').length,result.calls);
});
test('Identical text from different files cannot link unrelated tasks through content deduplication',async t=>{
  const {a,job,act,plan,advance,input}=await setup(t);fs.writeFileSync(path.join(input,'b.md'),'A：周五发布');
  const first=await act('read_file',{folderId:'folder',name:'a.md'}),second=await act('read_file',{folderId:'folder',name:'b.md'});assert.notEqual(first.sourceId,second.sourceId);
  const ta=await plan('a',{sourceIds:[first.sourceId]}),tb=await plan('b',{sourceIds:[second.sourceId]});await advance(ta.taskId);await advance(tb.taskId);
  fs.writeFileSync(path.join(input,'a.md'),'只改变 A');await agent.checkSources(a,job);assert.ok(a.task(ta.taskId).needsReplan);assert.equal(a.task(tb.taskId).status,'review');
});
test('Manual feedback on a prerequisite invalidates already completed downstream results',async t=>{
  const {a,plan,advance}=await setup(t);const first=await plan('a'),second=await plan('b',{dependsOn:[first.taskId]});await advance(first.taskId);await advance(second.taskId);
  await a.dispatch('updateTask',{id:first.taskId,criteria:'增加新要求'});assert.ok(a.task(second.taskId).needsReplan);await advance(first.taskId);
  await a.dispatch('updateTask',{id:first.taskId,title:'再调整'});await a.dispatch('taskAction',{id:first.taskId,command:'revise',note:'修改依据'});assert.equal(a.task(second.taskId).verification,null);
});
test('Post-approval conflicts clear the pending execution so a fresh plan can recover',async t=>{
  const {a,job,act,plan,advance,env}=await setup(t,{githubUpdateMode:'ask'});const {taskId}=await plan('方案');await act('github_read',{number:1,taskId});await advance(taskId);
  await act('github_update',{taskId,number:1});await a.dispatch('agentApprove',{id:job.id});env.issues[0].body='人工新信息';
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,'blocked');assert.equal(job.pendingActionId,null);
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,'needs_input');assert.equal(env.requests.filter(r=>r.method==='PATCH').length,0);
});
test('Comment cooldown schedules the next attempt without burning finite error retries',async t=>{
  const {a,job,act,plan,advance}=await setup(t);const {taskId}=await plan('跟进');await act('github_read',{number:1,taskId});await advance(taskId);await act('github_comment',{taskId,number:1,body:'第一问'});
  a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});return {tool:'github_comment',args:{taskId,number:1,body:'第二问'}};};await a.dispatch('agentRun',{id:job.id});await a.runPromise;
  assert.equal(job.status,'retry');assert.equal(job.failures,0);assert.ok(Date.parse(job.nextRunAt)>Date.now()+23*3600000);
});
test('A full evaluation run persists all 10 outcomes without mutating actual tasks',async t=>{
  const {a}=await setup(t);const count=a.data.tasks.length;
  a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:100,outputTokens:20});return {tool:'ask',args:{question:'缺少预算金额'}};};await a.dispatch('agentEvaluate');await a.runPromise;
  const result=a.data.agentEvaluations[0];assert.equal(result.status,'completed');assert.equal(result.cases.length,10);assert.equal(result.cases.filter(c=>c.passed).length,1);assert.equal(a.data.tasks.length,count);assert.equal(result.modelCalls,10);assert.equal(result.interventions,10);
});
test('Stopping real-model evaluation aborts the child request and leaves no running report',async t=>{
  const {a}=await setup(t);let started;const ready=new Promise(r=>started=r);
  a.chat=async(p,k,m,{signal})=>{started();await new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('stopped'));else signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});});};
  await a.dispatch('agentEvaluate');await ready;a.stop();await a.runPromise;assert.equal(a.operation,null);assert.equal(a.data.agentEvaluations[0].status,'stopped');
});
