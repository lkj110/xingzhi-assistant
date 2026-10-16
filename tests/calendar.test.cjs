const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const calendar=require('../desktop/calendar.cjs');
const operations=require('../desktop/operations.cjs');
const current='2026-10-01T00:00:00.000Z';
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-calendar-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('日历不得调用模型');},webRequest:async()=>{throw new Error('日历不得联网');}});
  a.data.stewardship.timeZone='Asia/Shanghai';a.data.projects=[{id:'p',name:'青禾项目'},{id:'q',name:'清风项目'}];return a;
}
const task=(a,patch={})=>Object.assign(a.createTask({title:'复核上线材料',criteria:'核对全部日期'}),{dueAt:'2026-10-02T09:00:00+08:00',...patch});
const job=(a,patch={})=>{const j={id:'j',projectId:'p',title:'推进青禾项目',status:'watching',taskIds:[],sourceIds:[],followups:[],maxCalls:30,callsUsed:0,...patch};a.data.delegations.push(j);return j;};
function at(time,fn){const old=Date.now;Date.now=()=>Date.parse(time);try{return fn();}finally{Date.now=old;}}
const exportAt=(a,input={},time=current)=>at(time,()=>calendar.exportCalendar(a,input));
const unfold=text=>text.replace(/\r\n[ \t]/g,'');
const events=report=>unfold(report.content).split('BEGIN:VEVENT\r\n').slice(1).map(part=>part.split('END:VEVENT\r\n')[0]);
const ids=report=>events(report).map(event=>event.match(/^UID:(.+)$/m)[1].trim());

test('Calendar export is a read-only snapshot with no model, network, raw bodies or paths',t=>{
  const a=setup(t);task(a,{description:'PRIVATE_BODY',notes:[{text:'PRIVATE_NOTE'}]});a.data.agentSettings.githubToken='PRIVATE_TOKEN';const before=JSON.stringify(a.data),file=fs.readFileSync(a.file,'utf8');
  const report=exportAt(a);assert.equal(report.eventCount,1);assert.equal(report.modelCalls,0);assert.equal(report.networkRequests,0);assert.equal(report.mime,'text/calendar;charset=utf-8');assert.equal(report.filename,'行知安排-2026-10-01-30d.ics');
  assert.equal(JSON.stringify(a.data),before);assert.equal(fs.readFileSync(a.file,'utf8'),file);assert.ok(!report.content.includes('PRIVATE_'));assert.ok(!report.content.includes(a.dir));assert.match(unfold(report.content),/不会回写助手/);assert.match(report.content,/TRANSP:TRANSPARENT/);assert.match(report.content,/CLASS:PRIVATE/);
});
test('Calendar project scopes cover all, one project and independent work with no cross-project leakage',t=>{
  const a=setup(t);job(a);task(a,{title:'青禾独立事项',projectId:'p'});task(a,{title:'青禾委托事项',agentJobId:'j'});task(a,{title:'清风秘密',projectId:'q'});task(a,{title:'完全独立'});
  assert.equal(exportAt(a).eventCount,4);const p=exportAt(a,{projectId:'p'}),i=exportAt(a,{projectId:'@independent'});assert.equal(p.eventCount,2);assert.ok(!p.content.includes('清风秘密'));assert.ok(!p.content.includes('完全独立'));assert.equal(i.eventCount,1);assert.match(i.content,/完全独立/);assert.equal(p.scopeLabel,'青禾项目');
  for(const projectId of [null,5,{},'missing'])assert.throws(()=>exportAt(a,{projectId}),/项目无效/);
});
test('Export reads all agenda pages, never only the first 50 or 100 records',t=>{
  const a=setup(t);for(let i=0;i<113;i++)task(a,{title:`事项 ${i}`});const report=exportAt(a);assert.equal(report.eventCount,113);assert.equal(new Set(ids(report)).size,113);
});
test('Deadline and check events are both exported even within the same agenda bucket',t=>{
  const a=setup(t);const j=job(a),v=task(a,{projectId:'p',agentJobId:'j'});j.followups=[{key:'same',status:'waiting',taskId:v.id,expected:'等待报价',deadlineAt:'2026-10-02T05:00:00Z',checkAt:'2026-10-02T04:00:00Z'}];
  const report=exportAt(a);assert.equal(report.eventCount,3);assert.match(unfold(report.content),/SUMMARY:跟进检查｜等待报价/);assert.match(unfold(report.content),/SUMMARY:跟进期限｜等待报价/);assert.equal(events(report).filter(e=>e.includes('DTSTART:20261002T040000Z')).length,1);
});
test('Separate agenda check rows deduplicate by source identity across time buckets',t=>{
  const a=setup(t);job(a,{followups:[{key:'soon',status:'waiting',expected:'等待反馈',deadlineAt:'2026-10-02T02:00:00Z',checkAt:'2026-10-01T01:00:00Z'}]});
  assert.equal(at(current,()=>operations.agenda(a)).total,2);const report=exportAt(a);assert.equal(report.eventCount,2);assert.equal(new Set(ids(report)).size,2);
});
test('Checked followups omit old checks while preserving their unfulfilled deadline',t=>{
  const a=setup(t);job(a,{followups:[{key:'wait',status:'waiting',expected:'等待报价',deadlineAt:'2026-10-02T02:00:00Z',checkAt:'2026-10-01T01:00:00Z',checkedAt:'2026-10-01T01:01:00Z'},{key:'closed',status:'resolved',expected:'已经结束',checkAt:'2026-10-02T00:00:00Z'}]});
  const report=exportAt(a);assert.equal(report.eventCount,1);assert.match(report.content,/DTSTART:20261002T020000Z/);assert.ok(!report.content.includes('已经结束'));
});
test('Standalone waiting work can export a check without a task deadline',t=>{
  const a=setup(t);task(a,{title:'无截止跟进',dueAt:null,status:'waiting',waitingOn:'等待同事确认',nextCheckAt:'2026-10-02T01:00:00Z'});const report=exportAt(a);assert.equal(report.eventCount,1);assert.match(unfold(report.content),/SUMMARY:跟进检查｜等待同事确认/);assert.equal(report.skipped.undated,1);
});
test('Closed or cancelled tasks and delegations never export stale waiting followups',t=>{
  const a=setup(t);job(a,{status:'completed',followups:[{key:'orphan',status:'waiting',expected:'已结束委托残留',checkAt:'2026-10-02T00:00:00Z'}]});
  task(a,{status:'completed'});task(a,{agentCancelled:true});task(a,{status:'cancelled'});task(a,{agentJobId:'j',projectId:'p'});
  const j=job(a,{id:'j2',status:'watching'}),v=task(a,{agentJobId:'j2',projectId:'p',status:'completed'});j.followups=[{key:'done-task',status:'waiting',taskId:v.id,expected:'已完成事项残留',checkAt:'2026-10-02T00:00:00Z'}];
  assert.equal(exportAt(a).eventCount,0);
});
test('Paused work retains dates and marks pause in event descriptions',t=>{
  const a=setup(t);task(a,{status:'paused'});const report=exportAt(a);assert.equal(report.eventCount,1);assert.match(unfold(report.content),/工作已暂停/);
});
test('Invalid or missing project/job associations do not become independent calendar work',t=>{
  const a=setup(t);job(a);task(a,{projectId:'q',agentJobId:'j',title:'归属冲突'});task(a,{agentJobId:'missing',title:'丢失委托'});task(a,{projectId:'deleted',title:'丢失项目'});
  const report=exportAt(a);assert.equal(report.eventCount,0);assert.equal(report.skipped.invalidScope,3);assert.ok(!report.content.includes('归属冲突'));
});
test('UID remains stable after a deadline/title change and across project filters',t=>{
  const a=setup(t),v=task(a,{projectId:'p'});const first=ids(exportAt(a))[0];v.title='新标题';v.dueAt='2026-10-03T09:00:00+08:00';const next=exportAt(a,{projectId:'p'});assert.equal(ids(next)[0],first);assert.match(next.content,/DTSTART:20261003T010000Z/);assert.match(unfold(next.content),/新标题/);
});
test('Distinct deadline, check and independent event UIDs remain distinct when timestamps match',t=>{
  const a=setup(t);job(a,{followups:[{key:'same',status:'waiting',expected:'相同时间',deadlineAt:'2026-10-02T01:00:00Z',checkAt:'2026-10-02T01:00:00Z'}]});task(a,{dueAt:'2026-10-02T01:00:00Z',nextCheckAt:'2026-10-02T01:00:00Z',status:'waiting'});const report=exportAt(a);assert.equal(report.eventCount,4);assert.equal(new Set(ids(report)).size,4);
});
test('Time window includes lower boundary, excludes upper boundary and bounds overdue lookback',t=>{
  const a=setup(t);for(const dueAt of ['2026-09-01T00:00:00.000Z','2026-08-31T23:59:59.999Z',current,'2026-10-07T23:59:59.999Z','2026-10-08T00:00:00.000Z'])task(a,{dueAt});
  const all=exportAt(a,{range:'7d'});assert.equal(all.eventCount,3);assert.equal(all.from,'2026-09-01T00:00:00.000Z');assert.equal(all.to,'2026-10-08T00:00:00.000Z');assert.equal(exportAt(a,{range:'7d',includeOverdue:false}).eventCount,2);
});
test('No dates or an empty requested range returns a valid empty calendar',t=>{
  const a=setup(t);task(a,{dueAt:null});task(a,{dueAt:'2027-01-01T00:00:00Z'});const report=exportAt(a,{range:'7d'});assert.equal(report.eventCount,0);assert.match(report.content,/^BEGIN:VCALENDAR\r\n/);assert.ok(report.content.endsWith('END:VCALENDAR\r\n'));assert.equal(report.skipped.undated,1);assert.equal(report.skipped.outsideRange,1);
});
test('Offset times, fractional offset zones, midnight and DST occurrences convert to exact UTC',t=>{
  const a=setup(t);a.data.stewardship.timeZone='America/New_York';
  for(const dueAt of ['2026-11-01T01:30:00-04:00','2026-11-01T01:30:00-05:00','2026-10-02T00:00:00+08:00','2026-10-02T09:30:00+05:45'])task(a,{dueAt});
  const report=exportAt(a,{range:'90d'});for(const stamp of ['20261101T053000Z','20261101T063000Z','20261001T160000Z','20261002T034500Z'])assert.match(report.content,new RegExp('DTSTART:'+stamp));assert.equal(report.timeZone,'America/New_York');assert.equal(report.filename,'行知安排-2026-09-30-90d.ics');assert.ok(!report.content.includes('TZID='));
});
test('Invalid and timezone-free dates are not silently normalized into calendar events',t=>{
  const a=setup(t);for(const dueAt of ['2026-02-30T10:00:00Z','2026-10-02T10:00:00','2026-10-02','2026-10-02T24:00:00Z','2026-10-02T10:00:99Z','garbage'])task(a,{dueAt});const report=exportAt(a,{range:'90d'});assert.equal(report.eventCount,0);assert.equal(report.skipped.invalidDate,6);
});
test('Chinese, emoji and escaped punctuation round trip without injected properties or broken UTF-8',t=>{
  const a=setup(t),title='中文😀材料,'.repeat(12)+';\\结尾\r\nBEGIN:VEVENT\nATTENDEE:坏值\u0000';task(a,{title});a.data.projects[0].name='青禾,;\\项目\n新行';
  const report=exportAt(a),physical=report.content.split('\r\n');assert.ok(physical.every(line=>Buffer.byteLength(line,'utf8')<=75));assert.ok(physical.some(line=>line.startsWith(' ')));assert.ok(!report.content.includes('\ufffd'));assert.ok(!report.content.includes('\u0000'));
  const value=unfold(report.content);assert.equal((value.match(/^BEGIN:VEVENT$/gm)||[]).length,1);assert.ok(!/^ATTENDEE:/m.test(value));assert.match(value,/\\,/);assert.match(value,/\\;/);assert.match(value,/\\\\结尾\\nBEGIN:VEVENT\\nATTENDEE/);
});
test('Display alarms use chosen offsets and omit alarms whose trigger is already past',t=>{
  const a=setup(t);task(a,{dueAt:'2026-10-01T01:00:00Z'});task(a,{dueAt:'2026-10-01T00:10:00Z'});task(a,{dueAt:'2026-09-30T23:00:00Z'});
  const defaultReport=exportAt(a);assert.equal((defaultReport.content.match(/BEGIN:VALARM/g)||[]).length,1);assert.match(defaultReport.content,/TRIGGER:-PT15M/);
  assert.equal((exportAt(a,{reminderMinutes:0}).content.match(/BEGIN:VALARM/g)||[]).length,2);assert.match(exportAt(a,{reminderMinutes:0}).content,/TRIGGER:PT0S/);assert.match(exportAt(a,{reminderMinutes:60}).content,/TRIGGER:-PT60M/);assert.ok(!exportAt(a,{reminderMinutes:null}).content.includes('VALARM'));
});
test('Exports remain available while another operation runs and do not mutate automatic controls',t=>{
  const a=setup(t);task(a);a.operation={label:'忙碌'};a.data.stewardship.paused=true;const before=JSON.stringify(a.data);assert.equal(exportAt(a).eventCount,1);assert.equal(JSON.stringify(a.data),before);assert.equal(a.operation.label,'忙碌');
});
test('Unsupported operations and malformed inputs reject without side effects',t=>{
  const a=setup(t);task(a);const before=JSON.stringify(a.data);
  for(const input of [null,[],{range:'365d'},{range:null},{range:['7d']},{range:'constructor'},{includeOverdue:'true'},{includeOverdue:null},{reminderMinutes:'15'},{reminderMinutes:-1},{reminderMinutes:30}])assert.throws(()=>calendar.exportCalendar(a,input));
  assert.throws(()=>calendar.dispatch(a,'calendarSync',{}),/未知/);assert.equal(JSON.stringify(a.data),before);assert.equal(at(current,()=>calendar.dispatch(a,'calendarExport',{})).eventCount,1);
});
test('UTF-8 folding counts continuation spaces and retains full code points',()=>{
  const input='SUMMARY:'+('中文😀'.repeat(100)),folded=calendar.fold(input);assert.equal(unfold(folded),input);assert.ok(folded.split('\r\n').every(line=>Buffer.byteLength(line)<=75));assert.ok(folded.split('\r\n').slice(1).every(line=>line.startsWith(' ')));
});
test('Calendar public dispatch returns its export directly without launching or persisting work',async t=>{
  const a=setup(t);task(a,{dueAt:new Date(Date.now()+86400000).toISOString()});const before=JSON.stringify(a.data),report=await a.dispatch('calendarExport',{projectId:'@independent',range:'7d',reminderMinutes:null});assert.equal(report.eventCount,1);assert.equal(report.tasks,undefined);assert.equal(a.operation,null);assert.equal(JSON.stringify(a.data),before);assert.equal(report.modelCalls,0);
});
