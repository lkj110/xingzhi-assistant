const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const operations=require('../desktop/operations.cjs');
async function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-operations-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('今日安排不得调用模型');}});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  a.data.stewardship.timeZone='Asia/Shanghai';
  a.data.projects=[{id:'p',name:'发布项目'},{id:'q',name:'另一个项目'}];
  return a;
}
const task=(a,patch={})=>Object.assign(a.createTask({title:'准备发布材料',criteria:'包含版本日期'}),patch);
const job=(a,patch={})=>{const j={id:'j',projectId:'p',title:'推进发布',status:'ready',taskIds:[],sourceIds:[],followups:[],maxCalls:30,callsUsed:0,...patch};a.data.delegations.push(j);return j;};
const items=(a,ids)=>ids.map(id=>({id,revision:operations.revision(a,a.task(id))}));
const update=(a,ids,changes,projectId='')=>operations.schedule(a,{projectId,items:items(a,ids),changes});
async function at(value,fn){const old=Date.now;Date.now=()=>Date.parse(value);try{return await fn();}finally{Date.now=old;}}

test('Agenda stays read only, performs no model calls and omits private bodies',async t=>{
  const a=await setup(t);task(a,{description:'PRIVATE_DESCRIPTION',notes:[{text:'PRIVATE_NOTE'}]});a.data.agentSettings.githubToken='PRIVATE_TOKEN';const before=JSON.stringify(a.data);
  const result=operations.agenda(a);assert.equal(result.rows.length,1);assert.equal(result.modelCalls,0);assert.equal(result.tasks,undefined);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(JSON.stringify(a.data),before);assert.equal((a.data.modelCalls || []).length,0);
});
test('Time buckets use the saved time zone and deadlines include exact time',async t=>{
  const a=await setup(t);for(const dueAt of ['2026-09-30T23:00:00Z','2026-10-01T01:00:00Z','2026-10-01T23:00:00Z','2026-10-08T14:00:00Z','2026-10-08T17:00:00Z',null])task(a,{dueAt});
  await at('2026-10-01T00:00:00Z',()=>{const r=operations.agenda(a);assert.equal(r.today,'2026-10-01');assert.deepEqual(r.counts,{overdue:1,today:1,upcoming:2,undated:1,later:1});});
});
test('Project filters retain standalone project tasks and exclude other-project links',async t=>{
  const a=await setup(t);job(a);task(a,{projectId:'p'});task(a,{agentJobId:'j'});task(a,{projectId:'q',agentJobId:'j',title:'FOREIGN'});task(a);
  assert.equal(operations.agenda(a,{projectId:'p'}).rows.length,2);assert.ok(!JSON.stringify(operations.agenda(a,{projectId:'p'})).includes('FOREIGN'));
  assert.equal(operations.agenda(a,{projectId:'@independent'}).rows.length,1);assert.throws(()=>operations.agenda(a,{projectId:'missing'}),/项目无效/);
});
test('Completed and cancelled tasks stay out; paused tasks remain visible but never labelled ready',async t=>{
  const a=await setup(t);task(a,{status:'completed'});task(a,{agentCancelled:true});task(a,{status:'paused',dueAt:'2000-01-01T00:00:00Z'});
  const r=operations.agenda(a);assert.equal(r.rows.length,1);assert.equal(r.rows[0].canSchedule,true);assert.ok(r.rows[0].reasons.some(r=>r.code==='task_paused'));assert.ok(!r.rows[0].reasons.some(r=>r.code==='ready'));
});
test('Dependency explanations distinguish missing, cancelled and not-accepted tasks without leaking projects',async t=>{
  const a=await setup(t),j=job(a),dep=task(a,{projectId:'p',agentJobId:'j',status:'completed',verification:{passed:true},agentCancelled:true}),foreign=task(a,{projectId:'q',title:'SECRET_FOREIGN'}),target=task(a,{projectId:'p',agentJobId:j.id,dependsOn:[dep.id,foreign.id,'missing']});
  const r=operations.agenda(a,{projectId:'p'}).rows.find(r=>r.taskId===target.id);assert.equal(r.reasons.filter(r=>r.code==='dependency').length,3);assert.ok(!JSON.stringify(r).includes('SECRET_FOREIGN'));
  dep.agentCancelled=false;target.dependsOn=[dep.id];assert.ok(!operations.agenda(a,{projectId:'p'}).rows.find(r=>r.taskId===target.id).reasons.some(r=>r.code==='dependency'));
});
test('Task, job, decision, rule and global gates explain why automatic work is delayed',async t=>{
  const a=await setup(t),j=job(a,{status:'paused',ruleId:'r',ruleRevision:1});a.data.workRules.push({id:'r',revision:2,status:'paused'});a.data.decisions.push({id:'d',jobId:j.id,status:'open'});task(a,{projectId:'p',agentJobId:j.id,status:'review'});a.data.stewardship.paused=true;
  const codes=operations.agenda(a).rows[0].reasons.map(r=>r.code);for(const expected of ['job_paused','rule_paused','decision','review','paused'])assert.ok(codes.includes(expected));
});
test('Global budget, work window, suspension and current operation are reflected without changing data',async t=>{
  const a=await setup(t);task(a);a.data.settings.automatic=true;
  await at('2026-10-01T00:00:00Z',()=>{a.data.stewardship.window={enabled:true,start:'09:00',end:'18:00'};let r=operations.agenda(a);assert.equal(r.automatic.reason,'window');a.data.stewardship.dailyCallLimit=1;a.data.stewardship.usage.days['2026-10-01']=1;r=operations.agenda(a);assert.equal(r.automatic.reason,'window');a.suspended=true;assert.equal(operations.agenda(a).automatic.reason,'suspended');a.operation={label:'正在工作'};assert.ok(operations.agenda(a).rows[0].reasons.some(r=>r.code==='busy'));});
});
test('Followup deadlines and check times are distinct from task due dates',async t=>{
  const a=await setup(t),j=job(a,{status:'watching'}),v=task(a,{projectId:'p',agentJobId:'j',dueAt:'2026-10-08T00:00:00Z'});
  j.followups=[{key:'deadline',status:'waiting',taskId:v.id,expected:'等待确认',deadlineAt:'2026-10-02T00:00:00Z',checkAt:'2026-10-01T01:00:00Z'},{key:'check',status:'waiting',expected:'再次查看',checkAt:'2026-10-01T02:00:00Z'},{key:'closed',status:'resolved',expected:'不应展示'},{key:'bad',status:'waiting',taskId:'missing',expected:'不应展示'}];
  await at('2026-10-01T00:00:00Z',()=>{const r=operations.agenda(a);assert.equal(r.rows.length,4);assert.equal(r.rows.find(r=>r.kind==='task').dateKind,'事项截止');const waiting=r.rows.filter(r=>r.kind==='followup');assert.ok(waiting.every(r=>!r.canSchedule));assert.ok(waiting.some(r=>r.title==='等待确认'&&r.dateKind==='跟进期限'));assert.ok(waiting.some(r=>r.title==='等待确认'&&r.dateKind==='再次检查'&&r.bucket==='today'));assert.equal(waiting.find(r=>r.title==='再次查看').dateKind,'再次检查');assert.ok(!JSON.stringify(r).includes('不应展示'));});
});
test('Already performed checks do not remain in the next-check agenda or hide waiting deadlines',async t=>{
  const a=await setup(t);job(a,{followups:[{key:'wait',status:'waiting',expected:'等待确认',deadlineAt:'2026-10-02T00:00:00Z',checkAt:'2026-10-01T01:00:00Z',checkedAt:'2026-10-01T01:00:01Z'}]});
  await at('2026-10-01T02:00:00Z',()=>{const r=operations.agenda(a);assert.equal(r.rows.length,1);assert.equal(r.rows[0].dateKind,'跟进期限');assert.equal(r.rows[0].nextCheckAt,null);assert.equal(r.counts.overdue,0);});
});
test('Agenda paginates with whole-filter counts and validates every filter',async t=>{
  const a=await setup(t);for(let i=0;i<12;i++)task(a,{priority:i===0?'high':'normal'});const r=operations.agenda(a,{offset:5,limit:5});assert.equal(r.rows.length,5);assert.equal(r.total,12);assert.equal(r.counts.undated,12);assert.equal(r.more,true);
  for(const input of [null,[],{bucket:'invalid'},{limit:0},{limit:101},{offset:-1},{offset:0.5},{projectId:null}])assert.throws(()=>operations.agenda(a,input));
});
test('Standalone waiting checks appear on their own dates even when the task has no deadline',async t=>{
  const a=await setup(t),v=task(a,{status:'waiting',waitingOn:'收到采购确认',nextCheckAt:'2026-10-01T02:00:00Z'});
  await at('2026-10-01T00:00:00Z',()=>{const r=operations.agenda(a,{bucket:'today'});assert.equal(r.rows.length,1);assert.equal(r.rows[0].kind,'followup');assert.equal(r.rows[0].dateKind,'再次检查');assert.equal(r.rows[0].canSchedule,false);assert.equal(r.counts.undated,1);});
  v.previousStatus='waiting';v.status='paused';const row=operations.agenda(a).rows.find(r=>r.kind==='followup');assert.ok(row.reasons.some(r=>r.code==='task_paused'));
});
test('Followup rows retain delegation quota and unresolved-write explanations',async t=>{
  const a=await setup(t);job(a,{status:'limited',limitReason:'rule_daily',followups:[{key:'wait',status:'waiting',expected:'等待反馈'}]});a.data.agentActions.push({id:'unknown',jobId:'j',status:'uncertain'});
  const row=operations.agenda(a).rows[0];assert.ok(row.reasons.some(r=>r.code==='job_budget'));assert.ok(row.reasons.some(r=>r.code==='uncertain'));
});
test('Bulk changes scheduling metadata while preserving drafts, acceptance and paused jobs',async t=>{
  const a=await setup(t),j=job(a,{status:'paused'}),v=task(a,{projectId:'p',agentJobId:j.id,status:'review',verification:{passed:true,summary:'核对通过'},steps:[{id:'step',done:true,artifactId:'artifact'}],notes:[{text:'原要求'}]});
  const old=structuredClone(v),oldJob=JSON.stringify(j);update(a,[v.id],{priority:'high',dueAt:'2026-10-02T09:30:00+08:00'},'p');assert.equal(v.priority,'high');assert.equal(v.dueAt,'2026-10-02T01:30:00.000Z');for(const key of ['status','verification','steps','notes'])assert.deepEqual(v[key],old[key]);assert.equal(JSON.stringify(j),oldJob);assert.equal((a.data.modelCalls || []).length,0);
});
test('Clear deadline is explicit and wall-clock times use the fixed workspace time zone',async t=>{
  const a=await setup(t),v=task(a);update(a,[v.id],{dueLocal:'2026-10-02T09:30'});assert.equal(v.dueAt,'2026-10-02T01:30:00.000Z');update(a,[v.id],{dueAt:null});assert.equal(v.dueAt,null);
});
test('DST missing or ambiguous local times are rejected; normal and fractional-offset zones work',()=>{
  assert.throws(()=>operations.localDeadline('2026-03-08T02:30','America/New_York'),/不存在/);assert.throws(()=>operations.localDeadline('2026-11-01T01:30','America/New_York'),/重复/);
  assert.equal(operations.localDeadline('2026-11-01T03:30','America/New_York'),'2026-11-01T08:30:00.000Z');assert.equal(operations.localDeadline('2026-10-02T09:30','Asia/Kathmandu'),'2026-10-02T03:45:00.000Z');
  for(const value of ['2026-02-30T12:00','2026-01-01T24:00','not-a-date'])assert.throws(()=>operations.localDeadline(value,'UTC'));
});
test('Stale selection rejects an entire batch without partial modification or events',async t=>{
  const a=await setup(t),v=task(a),other=task(a),selected=items(a,[v.id,other.id]);other.criteria='标准已更新';const before=JSON.stringify(a.data);
  assert.throws(()=>operations.schedule(a,{projectId:'',items:selected,changes:{priority:'high'}}),/已发生变化/);assert.equal(JSON.stringify(a.data),before);
});
test('Cross-project and moved tasks reject every selected change atomically',async t=>{
  const a=await setup(t),v=task(a,{projectId:'p'}),other=task(a,{projectId:'q'}),before=JSON.stringify(a.data);
  assert.throws(()=>update(a,[v.id,other.id],{priority:'high'},'p'),/范围/);assert.equal(JSON.stringify(a.data),before);
  const selected=items(a,[v.id]);v.projectId='q';const moved=JSON.stringify(a.data);assert.throws(()=>operations.schedule(a,{projectId:'p',items:selected,changes:{priority:'high'}}),/范围/);assert.equal(JSON.stringify(a.data),moved);
});
test('Uncertain external writes anywhere in the same delegation block scheduling',async t=>{
  const a=await setup(t);job(a);const v=task(a,{agentJobId:'j',projectId:'p'}),other=task(a);a.data.agentActions.push({id:'write',jobId:'j',taskId:'other-task',status:'uncertain'});const before=JSON.stringify(a.data);
  assert.equal(operations.agenda(a).rows.find(r=>r.taskId===v.id).canSchedule,false);assert.throws(()=>update(a,[other.id,v.id],{priority:'high'}),/外部动作/);assert.equal(JSON.stringify(a.data),before);
});
test('Invalid batch data and unsupported changes never mutate any task',async t=>{
  const a=await setup(t),v=task(a),before=JSON.stringify(a.data),selected=items(a,[v.id]);
  for(const input of [{items:selected,changes:{priority:'high'}},{projectId:undefined,items:selected,changes:{priority:'high'}},{projectId:'',items:[],changes:{priority:'high'}},{projectId:'',items:[...selected,...selected],changes:{priority:'high'}},{projectId:'',items:selected,changes:{}},{projectId:'',items:selected,changes:{status:'completed'}},{projectId:'',items:selected,changes:{priority:'urgent'}},{projectId:'',items:selected,changes:{dueAt:''}},{projectId:'',items:selected,changes:{dueAt:'2026-02-30T00:00:00Z'}},{projectId:'',items:selected,changes:{dueAt:'2026-10-01T10:00'}},{projectId:'',items:selected,changes:{dueAt:null,dueLocal:'2026-10-01T10:00'}}])assert.throws(()=>operations.schedule(a,input));
  assert.equal(JSON.stringify(a.data),before);
});
test('Completed, running, cancelled and corrupt job references cannot be batch changed',async t=>{
  const a=await setup(t);for(const patch of [{status:'completed'},{status:'running'},{agentCancelled:true},{agentJobId:'missing'}]){const v=task(a,patch),before=JSON.stringify(a.data);assert.throws(()=>update(a,[v.id],{priority:'high'}));assert.equal(JSON.stringify(a.data),before);}
});
test('Bulk schedule refuses changes during active execution and does not call the scheduler',async t=>{
  const a=await setup(t),v=task(a);a.operation={label:'active'};const before=JSON.stringify(a.data);assert.throws(()=>update(a,[v.id],{priority:'high'}));assert.equal(JSON.stringify(a.data),before);a.operation=null;a.tick=()=>{throw new Error('不应唤醒');};update(a,[v.id],{priority:'high'});assert.equal(v.priority,'high');
});
test('Priority order is suggested and independent tasks explain whether automation is enabled',async t=>{
  const a=await setup(t),low=task(a,{priority:'low'}),high=task(a,{priority:'high'});let r=operations.agenda(a);assert.equal(r.rows[0].taskId,high.id);assert.ok(r.rows.every(r=>r.reasons.some(r=>r.code==='manual')));a.data.settings.automatic=true;r=operations.agenda(a);assert.ok(r.rows.every(r=>r.reasons.some(r=>r.code==='ready')));assert.equal(r.rows[1].taskId,low.id);
});
test('Unsupported actions never fall through to state mutation',async t=>{const a=await setup(t);assert.throws(()=>operations.dispatch(a,'operationsApprove',{}),/未知/);});
test('Public agenda and batch APIs return their separate result shapes without launching work',async t=>{
  const a=await setup(t),v=task(a,{status:'paused',previousStatus:'todo'});const result=await a.dispatch('operationsAgenda',{projectId:''});assert.equal(result.rows[0].taskId,v.id);assert.equal(result.tasks,undefined);
  const state=await a.dispatch('operationsSchedule',{projectId:'',items:[{id:v.id,revision:result.rows[0].revision}],changes:{priority:'low'}});assert.ok(Array.isArray(state.tasks));assert.equal(state.tasks.find(t=>t.id===v.id).priority,'low');assert.equal(v.status,'paused');assert.equal(a.operation,null);
});
