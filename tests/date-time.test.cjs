const {test}=require('node:test');

const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),plans=require('../desktop/agent-plan.cjs'),followup=require('../desktop/agent-followup.cjs');
const invalid=['2026-02-30T10:00:00Z','2026-02-29T10:00:00+08:00','2026-04-31T10:00:00Z','2026-10-02T10:00:00','2026-10-02','2026-10-02T24:00:00Z','2026-10-02T10:00:61Z','2026-10-02T10:00:00+24:00',123,0,false,true,[],{},['2026-10-02T10:00:00Z']];
function fixture(t,chat){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-date-time-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});a.data.providers.push({id:'fixture',type:'openai',model:'fixture',baseUrl:'https://example.invalid/v1'});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};const j=agent.buildJob(a,{goal:'验证日期',allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.push(j);const s={id:'s',title:'时间来源',content:'等待结果',createdAt:new Date().toISOString()};a.data.sources.push(s);j.sourceIds=['s'];j.watchers=[{key:'watch',sourceId:'s'}];return {a,j};}
const planInput={key:'date',title:'带日期事项',criteria:'日期明确',steps:[{key:'draft',title:'起草',kind:'draft'}]};
const waitInput={key:'reply',reason:'等待新结果',expected:'收到明确确认',sourceIds:['s']};

test('New tasks reject invalid calendar dates, missing timezone and non-string values without mutation',t=>{
  const {a}=fixture(t);for(const dueAt of invalid){const before=JSON.stringify(a.data);assert.throws(()=>a.createTask({title:'日期事项',dueAt}),/时间|日期|时区/);assert.equal(JSON.stringify(a.data),before);}
});
test('Task date updates validate before changing a title, priority or previous deadline',async t=>{
  const {a}=fixture(t),task=a.createTask({title:'原事项',dueAt:'2026-10-02T10:00:00Z'});
  for(const value of invalid)for(const key of ['dueAt','nextCheckAt']){const before=JSON.stringify(a.data);await assert.rejects(a.dispatch('updateTask',{id:task.id,title:'不能部分修改',priority:'high',[key]:value}),/时间|日期|时区/);assert.equal(JSON.stringify(a.data),before);}
});
test('Agent task planning rejects a malformed deadline before any plan revision or priority update',t=>{
  const {a,j}=fixture(t);const task=plans.planTask(a,j,{...planInput,dueAt:'2026-10-02T10:00:00Z'});
  for(const dueAt of invalid){const before=JSON.stringify(a.data);assert.throws(()=>plans.planTask(a,j,{...planInput,title:'不能修改此标题',reason:'修改标题',priority:'high',dueAt}),/时间|日期|时区/);assert.equal(JSON.stringify(a.data),before);assert.equal(a.task(task.taskId).title,'带日期事项');}
});
test('Agent waits reject invalid dates before altering the existing followup or job schedule',t=>{
  const {a,j}=fixture(t);followup.wait(a,j,{...waitInput,deadlineAt:'2026-10-02T10:00:00Z',checkAt:'2026-10-01T10:00:00Z'});
  for(const value of invalid)for(const key of ['deadlineAt','checkAt']){const before=JSON.stringify(a.data);assert.throws(()=>followup.wait(a,j,{...waitInput,reason:'新等待原因',[key]:value}),/时间|日期|时区/);assert.equal(JSON.stringify(a.data),before);}
});
test('Invalid false-like wait dates also reject when no explicit expected condition was supplied',t=>{
  const {a,j}=fixture(t);for(const value of [false,0])for(const key of ['deadlineAt','checkAt']){const before=JSON.stringify(a.data);assert.throws(()=>followup.wait(a,j,{reason:'等待来源变化',[key]:value}),/时间|日期|时区/);assert.equal(JSON.stringify(a.data),before);}
});
test('Valid leap dates, UTC and fractional offsets normalize correctly, while empty values stay optional',async t=>{
  const {a,j}=fixture(t);const task=a.createTask({title:'闰日事项',dueAt:'2028-02-29T09:30:00+05:45'});assert.equal(task.dueAt,'2028-02-29T03:45:00.000Z');
  for(const dueAt of [null,undefined,''])assert.equal(a.createTask({title:'不设截止',dueAt}).dueAt,null);
  await a.dispatch('updateTask',{id:task.id,dueAt:'2026-10-02T10:00Z',nextCheckAt:'2026-10-02T10:00:00.1-04:00'});assert.equal(task.dueAt,'2026-10-02T10:00:00.000Z');assert.equal(task.nextCheckAt,'2026-10-02T14:00:00.100Z');
  await a.dispatch('updateTask',{id:task.id,dueAt:'',nextCheckAt:null});assert.equal(task.dueAt,null);assert.equal(task.nextCheckAt,null);
  const result=plans.planTask(a,j,{...planInput,dueAt:'2026-10-02T10:00:00Z'});plans.planTask(a,j,planInput);assert.equal(a.task(result.taskId).dueAt,'2026-10-02T10:00:00.000Z');plans.planTask(a,j,{...planInput,dueAt:''});assert.equal(a.task(result.taskId).dueAt,null);
});
test('Wait omission preserves existing dates while explicit null or empty clears them',t=>{
  const {a,j}=fixture(t);followup.wait(a,j,{...waitInput,checkAt:'2026-10-01T10:00:00Z',deadlineAt:'2026-10-02T10:00:00Z'});followup.wait(a,j,waitInput);assert.equal(j.followups[0].deadlineAt,'2026-10-02T10:00:00.000Z');
  followup.wait(a,j,{reason:'继续等待',key:'reply',sourceIds:['s'],deadlineAt:null,checkAt:''});assert.equal(j.followups[0].deadlineAt,null);assert.equal(j.followups[0].checkAt,null);
});
test('Existing stored timestamps are not migrated and omitted dates do not revalidate old plans',t=>{
  const {a,j}=fixture(t);const result=plans.planTask(a,j,planInput),task=a.task(result.taskId);delete task.deadlinePolicy;task.dueAt='2026-10-02T10:00:00';followup.wait(a,j,waitInput);j.followups[0].deadlineAt='2026-10-03T10:00:00';a.save();
  const reopened=new Assistant({dir:a.dir});assert.equal(reopened.task(task.id).dueAt,'2026-10-02T10:00:00');assert.equal(reopened.data.delegations[0].followups[0].deadlineAt,'2026-10-03T10:00:00');
  plans.planTask(a,j,planInput);followup.wait(a,j,waitInput);assert.equal(task.dueAt,'2026-10-02T10:00:00');assert.equal(j.followups[0].deadlineAt,'2026-10-03T10:00:00');
});
test('A malformed date in the second extracted task rejects the whole batch before creating any tasks',async t=>{
  const {a}=fixture(t,async(_p,_key,m)=>{const source=JSON.parse(m[1].content).sources[0].id;return {tasks:[{title:'第一项',criteria:'目标',sourceIds:[source],dueAt:'2026-10-02T10:00:00Z',steps:[{title:'整理',kind:'analysis'}]},{title:'第二项',criteria:'目标',sourceIds:[source],dueAt:'2026-02-30T10:00:00Z',steps:[{title:'整理',kind:'analysis'}]}]};});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'隔离模型',model:'fixture',baseUrl:'https://example.invalid/v1'});await a.dispatch('import',{items:[{title:'输入',content:'两个有截止日期的任务'}]});const source=a.data.sources.find(s=>s.title==='输入');await assert.rejects(a.extract([source.id]),/时间|日期|时区/);assert.equal(a.data.tasks.length,0);assert.equal(source.state,'new');
});
test('Confirmation requests reject false or numeric deadlines before applying a default',async()=>{
  const communication=require('../desktop/communications.cjs');
  for(const deadlineAt of [false,0,123,'2026-02-30T10:00:00Z'])await assert.rejects(communication.prepare({}, {}, {deadlineAt}),/期限|日期|时区/);
});
