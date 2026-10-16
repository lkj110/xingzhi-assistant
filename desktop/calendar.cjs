const crypto = require('node:crypto');
const operations = require('./operations.cjs');

const ranges = {'7d':7,'30d':30,'90d':90};
const day = 86400000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const closed = value => value?.agentCancelled || ['completed','cancelled','canceled'].includes(value?.status);
const text = value => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
const escape = value => text(value).replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');

// RFC 5545 content lines use CRLF and at most 75 UTF-8 octets. The continuation
// space counts toward the next physical line; never split a multi-byte character.
function fold(line) {
  const lines=[];let current='',bytes=0;
  for(const character of line) {
    const size=Buffer.byteLength(character,'utf8');
    if(bytes+size>75){lines.push(current);current=' ';bytes=1;}
    current+=character;bytes+=size;
  }
  lines.push(current);return lines.join('\r\n');
}
function validInstant(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return null;
  const naive=Date.parse(value.slice(0,16)+'Z'),at=Date.parse(value);
  if(!Number.isFinite(naive)||new Date(naive).toISOString().slice(0,16)!==value.slice(0,16)||!Number.isFinite(at))return null;
  const result=new Date(at).toISOString();
  return /^\d{4}-/.test(result)?result:null;
}
const stamp = value => new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
const uid = identity => crypto.createHash('sha256').update(JSON.stringify(['xingzhi-calendar-v1',...identity])).digest('hex')+'@xingzhi.local';

function exportCalendar(a,input={}) {
  if(!object(input))throw new Error('日历导出参数无效');
  const range=input.range===undefined?'30d':input.range;
  if(typeof range!=='string'||!Object.hasOwn(ranges,range))throw new Error('日历时间范围须为未来 7、30 或 90 天');
  const includeOverdue=input.includeOverdue===undefined?true:input.includeOverdue;
  if(typeof includeOverdue!=='boolean')throw new Error('是否包含逾期安排须为布尔值');
  const reminderMinutes=input.reminderMinutes===undefined?15:input.reminderMinutes;
  if(![null,0,15,60].includes(reminderMinutes))throw new Error('日历提醒须为不提醒、到点、提前 15 或 60 分钟');
  // The agenda provides the same project scope and titles as the visible page.
  // Read every page synchronously so background work cannot change this snapshot.
  const now=Date.now(),from=now-(includeOverdue?30*day:0),to=now+ranges[range]*day;
  const first=operations.agenda(a,{projectId:input.projectId,limit:100}),rows=[...first.rows];
  for(let offset=100;offset<first.total;offset+=100)rows.push(...operations.agenda(a,{projectId:first.projectId,limit:100,offset}).rows);
  const tasks=new Map(a.data.tasks.map(t=>[t.id,t])),jobs=new Map(a.data.delegations.map(j=>[j.id,j])),events=new Map(),seen=new Set();
  const skipped={undated:0,outsideRange:0,closed:0,invalidDate:0,invalidScope:0};
  const add=(identity,row,kind,rawAt)=>{
    const id=uid(identity);if(seen.has(id))return;seen.add(id);
    if(rawAt===null||rawAt===undefined||rawAt===''){skipped.undated++;return;}
    const at=validInstant(rawAt);
    if(!at){skipped.invalidDate++;return;}
    if(Date.parse(at)<from||Date.parse(at)>=to){skipped.outsideRange++;return;}
    events.set(id,{id,at,title:row.title,project:row.projectName,kind,paused:row.reasons.some(r=>['task_paused','job_paused','rule_paused','paused'].includes(r.code))});
  };
  for(const row of rows) {
    const task=row.taskId?tasks.get(row.taskId):null,job=row.jobId?jobs.get(row.jobId):null;
    if(closed(task)||closed(job)){skipped.closed++;continue;}
    // Do not export ambiguous associations merely because the all-project view
    // can show them as a repairable agenda entry.
    if(task?.agentJobId&&(!job||job.id!==task.agentJobId||(task.projectId && task.projectId!==(job.projectId||null)))||row.projectId&&!a.data.projects.some(p=>p.id===row.projectId)){skipped.invalidScope++;continue;}
    if(row.kind==='task')add(['task',row.taskId,'deadline'],row,'事项截止',task?.dueAt);
    else if(!row.jobId)add(['task',row.taskId,'check'],row,'跟进检查',task?.nextCheckAt);
    else {
      // The agenda may render a second row for a check in a different bucket.
      // Both times must export even when they share a bucket; stable IDs dedupe.
      const prefix=row.id.startsWith('followup-check:')?`followup-check:${job.id}:`:`followup:${job.id}:`;
      const followup=(job.followups||[]).find(f=>prefix+f.key===row.id);
      if(!followup||followup.status!=='waiting')continue;
      if(followup.deadlineAt)add(['job',job.id,followup.key,'deadline'],row,'跟进期限',followup.deadlineAt);
      if(!followup.checkedAt&&followup.checkAt)add(['job',job.id,followup.key,'check'],row,'跟进检查',followup.checkAt);
      if(!followup.deadlineAt&&!followup.checkAt)skipped.undated++;
    }
  }
  const generatedAt=new Date(now).toISOString(),scopeLabel=first.projectId==='@independent'?'独立工作':first.projectId?a.data.projects.find(p=>p.id===first.projectId).name:'全部项目与独立工作';
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Xingzhi Assistant//Calendar Snapshot//ZH','CALSCALE:GREGORIAN',`X-WR-CALNAME:${escape('行知助手 · '+scopeLabel)}`];
  const sorted=[...events.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  for(const event of sorted) {
    const summary=`${event.kind}｜${event.title}`,description=[`项目：${event.project}`,`类型：${event.kind}`,event.paused?'工作已暂停；本条仅保留已有时间安排。':'',event.kind==='事项截止'?'截止时间表示目标期限。':'跟进时间表示计划检查或等待期限，不表示结果已经完成。','这是导出时的安排快照；日历中的修改不会回写助手，后续变化也不会自动同步。'].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT',`UID:${event.id}`,`DTSTAMP:${stamp(generatedAt)}`,`DTSTART:${stamp(event.at)}`,`SUMMARY:${escape(summary)}`,`DESCRIPTION:${escape(description)}`,'CLASS:PRIVATE','TRANSP:TRANSPARENT');
    // Avoid creating alarms already in the past when importing overdue entries
    // or a deadline whose requested advance-notice window has elapsed.
    if(reminderMinutes!==null&&Date.parse(event.at)-reminderMinutes*60000>=now)lines.push('BEGIN:VALARM','ACTION:DISPLAY',`TRIGGER:${reminderMinutes?'-PT'+reminderMinutes+'M':'PT0S'}`,`DESCRIPTION:${escape(summary)}`,'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return {filename:`行知安排-${first.today}-${range}.ics`,mime:'text/calendar;charset=utf-8',content:lines.map(fold).join('\r\n')+'\r\n',eventCount:sorted.length,generatedAt,from:new Date(from).toISOString(),to:new Date(to).toISOString(),range,includeOverdue,reminderMinutes,projectId:first.projectId,scopeLabel,timeZone:first.timeZone,skipped,modelCalls:0,networkRequests:0,limitations:['导出包含所属项目范围内所有页的截止与跟进时间，不受今日安排的时间标签或勾选事项限制。','时间窗口从导出时刻起计算，结束边界不包含在内；勾选逾期时额外包含过去 30 天。','未设日期、已结束或取消的工作不导出；已暂停工作保留日期并标注暂停。','这是单次日历快照，没有双向同步；再次导入是否覆盖同一 UID 取决于日历客户端。结束或删除后，已导入的旧日历事件需要自行移除。','事件时间以 UTC 写入，日历按自己的时区显示；提醒由日历客户端负责，已过提醒时间的事件不加提醒。']};
}
function dispatch(a,action,input={}) {
  if(action==='calendarExport')return exportCalendar(a,input);
  throw new Error('未知日历操作');
}
module.exports={exportCalendar,dispatch,fold,escape,validInstant};
