const {test} = require('node:test');
const assert = require('node:assert/strict');
const {report} = require('../desktop/project-report.cjs');

const at = '2026-01-01T00:00:00.000Z';
function fixture() {
  // Formatting fixtures explicitly authorize their synthetic snapshots; B2 security tests use the real store.
  const assistant = {requireContextAccessPolicy:true,contextAccessCheck:()=>({allowed:true}),chat:() => {throw new Error('不得调用模型');},data:{projects:[{id:'p',name:'发布项目',background:'只在项目界面展示背景',createdAt:at},{id:'q',name:'另一项目'}],delegations:[{id:'j',projectId:'p',title:'推进发布',status:'watching',followups:[],sourceIds:['s'],taskIds:['t'],nextRunAt:'2027-01-01T00:00:00.000Z'}],sources:[{id:'s',projectId:'p',title:'确认材料',version:1,content:'材料正文默认不导出',origin:'/Users/test/private/evidence.md',createdAt:at}],tasks:[{id:'t',projectId:'p',agentJobId:'j',title:'发布稿',criteria:'正文含日期',status:'completed',sourceIds:['s'],verification:{passed:true,summary:'合成样例检查通过',gaps:[]},steps:[{kind:'draft',done:true,artifactId:'a',title:'完成文稿'}],createdAt:at}],artifacts:[{id:'a',taskId:'t',title:'发布文稿',content:'最新产出正文',createdAt:at}],agentActions:[{id:'w',jobId:'j',taskId:'t',artifactId:'a',tool:'write_file',title:'发布稿',status:'done',finishedAt:at,result:{verified:true,path:'/Users/test/private/report.md',latestPath:'/Users/test/private/latest.md'}}],decisions:[],workRules:[],connectors:[],providers:[{sealedKey:'DO_NOT_EXPORT_KEY'}],agentSettings:{githubToken:'DO_NOT_EXPORT_TOKEN'}}};
  assistant.data.tasks[0].verification.basis=require('../desktop/acceptance.cjs').basis(assistant,assistant.data.tasks[0]);
  return assistant;
}

test('Project report traces verified current deliverables with zero model calls and no mutation',() => {
  const a = fixture(),before = JSON.stringify(a.data),r = report(a,{projectId:'p'});
  assert.equal(r.modelCalls,0);assert.equal(r.progress.completed,1);assert.equal(r.progress.total,1);assert.equal(r.totals.deliveries,1);
  assert.equal(r.artifacts[0].accepted,true);assert.equal(r.artifacts[0].content,undefined);assert.equal(r.sources[0].ref,'S1');assert.equal(r.deliveries[0].artifactRef,'A1');assert.equal(r.deliveries[0].filename,'latest.md');
  assert.match(r.markdown,/完成并通过检查：1 \/ 1/);assert.match(r.markdown,/上次执行时读回成功/);assert.equal(JSON.stringify(a.data),before);
  for (const secret of ['DO_NOT_EXPORT','/Users/test/private','材料正文默认不导出','最新产出正文']) assert.ok(!JSON.stringify(r).includes(secret));
});
test('Optional Markdown export includes only current artifact bodies',() => {
  const a = fixture();a.data.artifacts.unshift({id:'old',taskId:'t',title:'历史文稿',content:'绝不能输出旧正文',createdAt:at});
  const r = report(a,{projectId:'p',includeArtifactContent:true});assert.equal(r.artifacts[0].content,'最新产出正文');assert.match(r.markdown,/> 最新产出正文/);assert.ok(!r.markdown.includes('绝不能输出旧正文'));assert.equal(r.excluded.artifacts,1);
});
test('Independent project tasks count even when absent from canonical delegation taskIds',() => {
  const a = fixture();a.data.tasks.push({id:'manual',projectId:'p',title:'人工事项',status:'todo',sourceIds:[],steps:[],dueAt:'2000-01-01'});
  const r=report(a,{projectId:'p'});assert.equal(r.progress.total,2);assert.equal(r.progress.completed,1);assert.equal(r.progress.overdueTasks,1);assert.ok(r.tasks.some(t=>t.id==='manual'));
});
test('Project report never follows references into another project',() => {
  const a=fixture();a.data.delegations.push({id:'other',projectId:'q',status:'watching',followups:[{key:'secret',status:'waiting',expected:'FOREIGN'}]});
  a.data.tasks.push({id:'foreign',projectId:'q',agentJobId:'j',title:'FOREIGN',status:'completed',steps:[{done:true,artifactId:'foreign-artifact'}]});a.data.delegations[0].taskIds.push('foreign');
  a.data.sources.push({id:'foreign-source',projectId:'q',title:'FOREIGN',previousSourceId:'s',content:'FOREIGN'});a.data.tasks[0].sourceIds.push('foreign-source');
  a.data.artifacts.push({id:'foreign-artifact',taskId:'foreign',title:'FOREIGN',content:'FOREIGN'});a.data.decisions.push({id:'foreign-decision',jobId:'other',projectId:'q',question:'FOREIGN',status:'open'});
  a.data.agentActions.push({id:'foreign-write',taskId:'t',jobId:'other',status:'done',title:'FOREIGN',artifactId:'a',result:{verified:true}});
  const r=report(a,{projectId:'p',includeArtifactContent:true});assert.ok(!JSON.stringify(r).includes('FOREIGN'));assert.equal(r.totals.tasks,1);assert.equal(r.totals.sources,1);assert.equal(r.progress.completed,0);assert.equal(r.tasks[0].staleSources,1);
});
test('Updated, withdrawn and excluded sources never become current evidence or completed outputs',() => {
  for(const next of [{id:'s2',previousSourceId:'s'},{id:'s',deleted:true},{id:'s',projectExcluded:true}]) {
    const a=fixture();if(next.id==='s')Object.assign(a.data.sources[0],next);else a.data.sources.unshift({...a.data.sources[0],...next,title:'新依据',content:'新内容',version:2});
    const r=report(a,{projectId:'p',includeArtifactContent:true});assert.equal(r.progress.completed,0);assert.equal(r.totals.artifacts,0);assert.equal(r.totals.deliveries,0);assert.ok(r.blockers.some(b=>b.kind==='task'));assert.ok(!r.markdown.includes('最新产出正文'));
  }
});
test('Explicit superseded source refs do not invalidate a task using the current replacement',() => {
  const a=fixture();a.data.sources.unshift({...a.data.sources[0],id:'s2',previousSourceId:'s',version:2});Object.assign(a.data.tasks[0],{sourceIds:['s','s2'],supersededSourceIds:['s']});a.data.delegations[0].sourceIds.push('s2');
  a.data.tasks[0].verification.basis=require('../desktop/acceptance.cjs').basis(a,a.data.tasks[0]);
  const r=report(a,{projectId:'p'});assert.equal(r.progress.completed,1);assert.equal(r.sources[0].id,'s2');assert.deepEqual(r.tasks[0].sourceRefs,['S1']);
});
test('Cancelled, paused, review, replan and incomplete verification never count as completed',() => {
  for(const patch of [{agentCancelled:true},{status:'paused'},{status:'review'},{needsReplan:'新的完成标准'},{verification:{passed:false,gaps:[]}},{verification:{passed:true,gaps:['缺少日期']}},{steps:[{done:false,artifactId:'a'}]},{status:'unrecognized'}]) {
    const a=fixture();Object.assign(a.data.tasks[0],patch);const r=report(a,{projectId:'p'});assert.equal(r.progress.completed,0);if(patch.agentCancelled)assert.equal(r.progress.total,0);
    if(!patch.agentCancelled && patch.steps===undefined)assert.ok(r.blockers.length>0);
  }
});
test('Uncertain and unverified external actions are separate from successful delivery',() => {
  const a=fixture();a.data.agentActions[0].status='uncertain';let r=report(a,{projectId:'p'});assert.equal(r.progress.uncertainWrites,1);assert.equal(r.progress.completed,0);assert.equal(r.deliveries.length,0);assert.equal(r.blockers[0].kind,'uncertain');
  a.data.agentActions[0].status='done';a.data.agentActions[0].result.verified=false;r=report(a,{projectId:'p'});assert.equal(r.deliveries.length,0);assert.ok(r.blockers.some(b=>b.kind==='unverified'));
});
test('Approval requests, fact questions and waiting deadlines are included with project-scoped links',() => {
  const a=fixture();a.data.agentActions[0].status='pending';a.data.delegations[0].followups=[{key:'wait',status:'waiting',taskId:'t',expected:'确认发布日期',deadlineAt:'2000-01-01',checkAt:'2027-02-01'}];a.data.decisions=[{id:'d',jobId:'j',projectId:'p',question:'哪一天？',status:'open',taskIds:['t','foreign'],suggestion:'周六'}];
  const r=report(a,{projectId:'p'});assert.equal(r.totals.decisions,2);assert.equal(r.progress.overdueFollowups,1);assert.equal(r.followups[0].taskRef,'T1');assert.deepEqual(r.decisions[0].taskRefs,['T1']);assert.equal(r.nextCheckAt,'2027-01-01T00:00:00.000Z');
  a.data.delegations[0].status='paused';assert.equal(report(a,{projectId:'p'}).nextCheckAt,null);
});
test('Messages count as verified actions only when a live completed step cites their receipt',() => {
  const a=fixture();a.data.tasks[0].steps=[{done:true,kind:'external',tool:'request_confirmation',evidence:'{"actionId":"m"}'}];a.data.agentActions=[{id:'m',jobId:'j',taskId:'t',tool:'request_confirmation',status:'done',title:'询问日期',result:{verified:true,messageId:'om_123',chatId:'oc_private',content:'消息正文不在摘要中'}}];
  let r=report(a,{projectId:'p'});assert.equal(r.deliveries.length,1);assert.equal(r.deliveries[0].receiptId,'om_123');assert.ok(!JSON.stringify(r).includes('消息正文不在摘要中'));assert.equal(r.artifacts.length,0);
  a.data.tasks[0].steps[0].evidence='旧步骤';r=report(a,{projectId:'p'});assert.equal(r.deliveries.length,0);assert.equal(r.excluded.deliveries,1);
});
test('Sources and deliveries remove local metadata paths, URL queries and embedded credentials',() => {
  const a=fixture();a.data.sources[0].url='https://example.com/docs/1?token=SECRET#secret';a.data.agentActions[0].tool='github_update';a.data.agentActions[0].result.url='https://user:SECRET@example.com/repo/issues/1';
  const r=report(a,{projectId:'p'});assert.equal(r.sources[0].url,'https://example.com/docs/1');assert.equal(r.deliveries[0].url,null);assert.ok(!JSON.stringify(r).includes('SECRET'));assert.ok(!JSON.stringify(r).includes('/Users/test/private'));
});
test('Large reports bound records and body text and disclose truncation',() => {
  const a=fixture();for(let i=0;i<110;i++){a.data.sources.push({id:`source-${i}`,projectId:'p',title:`材料${i}`,content:'正文'});a.data.artifacts.push({id:`artifact-${i}`,taskId:'t',title:`文稿${i}`,content:'正文'.repeat(10000)});a.data.tasks[0].steps.push({done:true,artifactId:`artifact-${i}`});}
  const r=report(a,{projectId:'p',includeArtifactContent:true});assert.equal(r.sources.length,100);assert.equal(r.artifacts.length,50);assert.ok(r.truncated);assert.ok(r.notices.length>=3);assert.ok(r.artifacts.reduce((n,v)=>n+v.content.length,0)<=120000);assert.ok(r.markdown.length<180000);assert.match(r.markdown,/本次内容有截断/);
});
test('Report validates project and body flag without silently widening scope',() => {
  const a=fixture();for(const input of [{},{projectId:'missing'},{projectId:'p',includeArtifactContent:'true'},null,[]])assert.throws(()=>report(a,input));
});
test('Completion needs an existing owned artifact or explicit external execution evidence',() => {
  const a=fixture();a.data.artifacts=[];assert.equal(report(a,{projectId:'p'}).progress.completed,0);
  a.data.tasks[0].steps=[{kind:'external',done:true}];assert.equal(report(a,{projectId:'p'}).progress.completed,0);
  a.data.tasks[0].steps[0].evidence='用户确认已经完成';a.data.tasks[0].verification.basis=require('../desktop/acceptance.cjs').basis(a,a.data.tasks[0]);
  const result=report(a,{projectId:'p'});assert.equal(result.progress.completed,0);assert.equal(result.progress.manualEvidence,1);assert.equal(result.tasks[0].currentCheckValid,true);
});
test('Next check reflects global pause, quota recovery, work window, suspension and metering errors',() => {
  const a=fixture(),old=Date.now;Date.now=()=>Date.parse('2026-10-01T08:00:00Z');
  try {
    a.data.delegations[0].nextRunAt='2026-10-01T07:00:00Z';a.data.stewardship={timeZone:'UTC',paused:false,dailyCallLimit:2,window:{enabled:true,start:'09:00',end:'18:00'},usage:{days:{}},meteringStartedAt:at};
    let r=report(a,{projectId:'p'});assert.equal(r.automatic.reason,'window');assert.equal(r.nextCheckAt,'2026-10-01T09:00:00.000Z');assert.equal(r.scheduledCheckAt,'2026-10-01T07:00:00.000Z');
    a.data.stewardship.paused=true;r=report(a,{projectId:'p'});assert.equal(r.nextCheckAt,null);assert.equal(r.automatic.reason,'paused');
    a.data.stewardship.paused=false;a.data.stewardship.usage.days['2026-10-01']=2;r=report(a,{projectId:'p'});assert.equal(r.automatic.reason,'window');assert.equal(r.nextCheckAt,'2026-10-01T09:00:00.000Z');
    a.suspended=true;r=report(a,{projectId:'p'});assert.equal(r.nextCheckAt,null);assert.equal(r.automatic.reason,'suspended');
    a.suspended=false;a.stewardshipError='调用账本无法读取';r=report(a,{projectId:'p'});assert.equal(r.nextCheckAt,null);assert.equal(r.automatic.reason,'meter');
    delete a.stewardshipError;a.data.stewardship.usage.days={};a.data.delegations[0].nextRunAt='2026-10-01T20:00:00Z';assert.equal(report(a,{projectId:'p'}).nextCheckAt,'2026-10-02T09:00:00.000Z');
  } finally {Date.now=old;}
});
test('Project report public dispatch includes manually created project tasks without scheduling work',async t => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Assistant}=require('../desktop/core.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-project-report-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('不应调用模型');}});await a.dispatch('projectSave',{name:'真实入口'});const p=a.data.projects[0];
  await a.dispatch('createTask',{projectId:p.id,title:'独立项目事项',criteria:'标准'});const before=JSON.stringify(a.data);const r=await a.dispatch('projectReport',{projectId:p.id});
  assert.equal(r.progress.total,1);assert.equal(r.tasks[0].title,'独立项目事项');assert.equal((a.data.modelCalls || []).length,0);assert.equal(a.operation,null);assert.equal(JSON.stringify(a.data),before);
});

test('Report uses acceptance reasons for missing, conflicting and mismatched explicit receipts',()=>{
  for(const mode of ['valid','missing','conflict','wrong_tool','unknown_job_action']){
    const assistant=fixture(),task=assistant.data.tasks[0];
    task.steps.push({kind:'external',done:true,tool:'write_file',evidence:JSON.stringify({actionId:'w'})});
    if(mode==='missing')assistant.data.agentActions=[];
    if(mode==='conflict')assistant.data.agentActions[0].deliveryConflict={reason:'Synthetic remote conflict'};
    if(mode==='wrong_tool')assistant.data.agentActions[0].tool='github_update';
    if(mode==='unknown_job_action')assistant.data.agentActions.push({id:'unknown',jobId:'j',status:'uncertain',tool:'write_file'});
    task.verification.basis=require('../desktop/acceptance.cjs').basis(assistant,task);
    const before=JSON.stringify(assistant.data),result=report(assistant,{projectId:'p'});
    assert.equal(result.progress.completed,mode==='valid'?1:0,mode);assert.equal(JSON.stringify(assistant.data),before);
    if(mode==='conflict'||mode==='missing')assert.equal(result.deliveries.length,0);
  }
});

test('Report invokes the authoritative acceptance presentation check instead of a parallel validity verdict',context=>{
  const assistant=fixture();let calls=0;
  context.mock.method(require('../desktop/acceptance.cjs'),'presentationChecks',()=>task=>{calls++;assert.equal(task.id,'t');return [{code:'changed',message:'Synthetic authoritative invalidation'}];});
  const result=report(assistant,{projectId:'p'});assert.equal(calls,1);assert.equal(result.progress.completed,0);assert.equal(result.tasks[0].completionKind,'unverified');
});

test('Current delivery never substitutes an old successful action for a missing or unknown explicit receipt',()=>{
  for(const status of ['missing','uncertain','running']){
    const assistant=fixture(),task=assistant.data.tasks[0];
    task.steps.push({kind:'external',tool:'write_file',done:true,evidence:JSON.stringify({actionId:'new-receipt'})});
    if(status!=='missing')assistant.data.agentActions.push({id:'new-receipt',taskId:'t',jobId:'j',artifactId:'a',tool:'write_file',status});
    task.verification.basis=require('../desktop/acceptance.cjs').basis(assistant,task);
    const result=report(assistant,{projectId:'p'});assert.equal(result.progress.completed,0);assert.equal(result.deliveries.length,0);assert.equal(result.excluded.deliveries,1);
  }
});
