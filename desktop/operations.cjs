const crypto = require('node:crypto');
const stewardship = require('./stewardship.cjs');
const statuses = {todo:'待推进',running:'正在推进',waiting:'等待反馈',review:'待验收',blocked:'需要关注',paused:'已暂停'};
const buckets = ['overdue','today','upcoming','undated','later'];
const editable = new Set(['todo','waiting','review','blocked','paused']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value,max=500) => String(value || '').slice(0,max);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function scope(a,value='') {
  if(typeof value !== 'string' || value && value !== '@independent' && !a.data.projects.some(p=>p.id===value))throw new Error('安排所属项目无效，请刷新后重新选择');
  return value;
}
function projectOf(a,t) {return t.projectId || a.data.delegations.find(j=>j.id===t.agentJobId)?.projectId || null;}
function includes(projectId,scopeId) {return !scopeId || (scopeId === '@independent' ? !projectId : projectId === scopeId);}
function jobOf(a,t) {return a.data.delegations.find(j=>j.id===t.agentJobId && (j.projectId || null) === projectOf(a,t));}
function unsettled(a,t) {return a.data.agentActions.some(r=>(r.taskId===t.id || t.agentJobId && r.jobId===t.agentJobId) && ['running','uncertain'].includes(r.status));}
function revision(a,t) {
  const job=jobOf(a,t),rule=a.data.workRules.find(r=>r.id===job?.ruleId);
  return crypto.createHash('sha256').update(JSON.stringify([t,job && {id:job.id,status:job.status,projectId:job.projectId,ruleId:job.ruleId,ruleRevision:job.ruleRevision},rule && {status:rule.status,revision:rule.revision},unsettled(a,t)])).digest('hex');
}
function timezone(a) {return a.data.stewardship?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';}
function gate(a,at) {
  if(a.suspended)return {automaticAllowed:false,reason:'suspended',message:'电脑休眠中，唤醒后按原计划继续',nextAllowedAt:null};
  return a.data.stewardship ? stewardship.status(a,at) : {automaticAllowed:true,reason:null,message:'可按原计划自动推进',nextAllowedAt:null};
}
function bucket(at,now,timeZone) {
  if(!at)return 'undated';
  if(Date.parse(at)<=now)return 'overdue';
  const day=stewardship.local(Date.parse(at),timeZone).day,today=stewardship.local(now,timeZone).day;
  const delta=(Date.parse(day)-Date.parse(today))/86400000;
  return delta===0?'today':delta<=7?'upcoming':'later';
}
function explain(a,t,j,automatic,now) {
  const reasons=[],add=(code,label)=>reasons.push({code,label});
  if(unsettled(a,t))add('uncertain','所属事项或委托有外部结果待核对');
  if(t.status==='paused')add('task_paused','事项已手动暂停');
  if(t.agentJobId&&!j)add('missing_job','所属委托不存在或项目关联不一致');
  if(j?.status==='paused')add('job_paused','所属委托已暂停');
  if(j?.ruleId&&!require('./work-rules.cjs').canRun(a,j))add('rule_paused','工作规则已暂停、移除或版本已变化');
  for(const id of t.dependsOn || []) {
    const dep=a.data.tasks.find(v=>v.id===id && projectOf(a,v)===projectOf(a,t) && (!t.agentJobId || v.agentJobId===t.agentJobId));
    if(!dep)add('dependency','前置事项不存在或已移出当前工作范围');
    else if(dep.status!=='completed'||!dep.verification?.passed||dep.agentCancelled)add('dependency',`前置事项尚未验收：${text(dep.title,160)}`);
  }
  if(t.needsReplan)add('replan','材料或计划发生变化，需由 Agent 重新核对');
  if(j&&a.data.decisions.some(d=>d.jobId===j.id&&d.status==='open'))add('decision','所属委托有待处理的决定');
  if(j&&a.data.agentActions.some(r=>r.jobId===j.id&&r.status==='pending'))add('approval','所属委托有外部动作待确认');
  if(t.status==='review')add('review','产出等待人工验收');
  if(t.status==='blocked')add('blocked','推进遇到问题，请打开事项处理');
  if(t.status==='waiting')add('waiting','等待外部结果或补充反馈');
  if(j&&['needs_input','approval','review','blocked','completed'].includes(j.status))add('job_attention',j.status==='completed'?'所属委托已结束，需先核对事项与目标':'所属委托等待处理，打开委托查看原因');
  if(j&&(j.status==='limited'))add('job_budget',j.summary||'推进费用需要确认');
  if(j&&a.data.connectors.some(c=>c.projectId===j.projectId&&c.cursor?.token))add('sync','项目资料同步尚未完成');
  if(!j&&!a.data.settings.automatic)add('manual','独立事项自动推进尚未开启');
  if(!automatic.automaticAllowed)add(automatic.reason,automatic.message);
  const roles=j?['organize','execute','verify']:['execute','verify'];
  if(roles.some(role=>!a.data.providers.some(p=>p.id===a.data.settings.roles?.[role])))add('model','所需模型尚未配置完整');
  if(j&&Date.parse(j.nextRunAt)>now)add('scheduled',`委托已安排下次${j.status==='watching'?'检查':'推进'}`);
  if(!statuses[t.status])add('unknown','事项状态无法识别，请打开核对');
  if(t.status==='running')add('running','正在执行当前事项');
  if(a.operation&&t.status!=='running')add('busy','当前正在处理其他工作，空闲后按计划继续');
  if(!reasons.length)add('ready',j?'由 Agent 按已有计划继续':'已进入独立事项自动推进范围');
  return reasons;
}
function agenda(a,input={}) {
  if(!object(input))throw new Error('今日安排参数无效');
  const projectId=scope(a,input.projectId),filter=input.bucket || 'all';
  if(filter!=='all'&&!buckets.includes(filter))throw new Error('安排时间筛选无效');
  const offset=input.offset??0,limit=input.limit??50;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('安排分页参数无效');
  const now=Date.now(),timeZone=timezone(a),automatic=gate(a,now),rows=[];
  for(const t of a.data.tasks) {
    const pid=projectOf(a,t);
    if(t.deletedAt||t.agentCancelled||t.status==='completed'||!includes(pid,projectId))continue;
    const j=jobOf(a,t),dueAt=iso(t.dueAt),nextCheckAt=iso(t.nextCheckAt),reasons=explain(a,t,j,automatic,now);
    rows.push({id:`task:${t.id}`,kind:'task',taskId:t.id,jobId:j?.id || null,projectId:pid,projectName:pid?text(a.data.projects.find(p=>p.id===pid)?.name || '项目已移除',100):'独立工作',title:text(t.title,160),status:t.status,statusLabel:statuses[t.status] || '状态待核对',priority:['high','normal','low'].includes(t.priority)?t.priority:'normal',dueAt,nextCheckAt,scheduledAt:iso(j?.nextRunAt),at:dueAt,bucket:bucket(dueAt,now,timeZone),dateKind:'事项截止',reasons,canSchedule:editable.has(t.status)&&!unsettled(a,t)&&(!t.agentJobId||!!j),revision:revision(a,t)});
    if(!t.agentJobId&&nextCheckAt&&(t.status==='waiting'||t.status==='paused'&&t.previousStatus==='waiting'))rows.push({id:`task-followup:${t.id}`,kind:'followup',taskId:t.id,jobId:null,projectId:pid,projectName:pid?text(a.data.projects.find(p=>p.id===pid)?.name || '项目已移除',100):'独立工作',title:text(t.waitingOn || t.title,500),status:t.status,statusLabel:'事项跟进',priority:t.priority || 'normal',nextCheckAt,at:nextCheckAt,bucket:bucket(nextCheckAt,now,timeZone),dateKind:'再次检查',reasons:[{code:'manual_followup',label:'到期后提醒补充反馈，打开事项记录实际结果'},...reasons.filter(r=>['task_paused','paused','budget','window','suspended','meter','uncertain'].includes(r.code))],canSchedule:false});
  }
  for(const j of a.data.delegations) {
    if(!includes(j.projectId || null,projectId))continue;
    for(const f of j.followups || []) {
      if(f.status!=='waiting')continue;
      const task=f.taskId?a.data.tasks.find(t=>t.id===f.taskId&&projectOf(a,t)===(j.projectId || null)&&t.agentJobId===j.id):null;
      if(f.taskId&&(!task||task.agentCancelled))continue;
      const deadlineAt=iso(f.deadlineAt),checkAt=f.checkedAt?null:iso(f.checkAt),at=deadlineAt || checkAt,reasons=[];
      if(j.status==='paused')reasons.push({code:'job_paused',label:'所属委托已暂停，恢复后再检查'});
      if(j.ruleId&&!require('./work-rules.cjs').canRun(a,j))reasons.push({code:'rule_paused',label:'工作规则已暂停、移除或版本已变化'});
      if(!automatic.automaticAllowed)reasons.push({code:automatic.reason,label:automatic.message});
      if(['needs_input','review','blocked','approval'].includes(j.status))reasons.push({code:'decision',label:'所属委托等待处理，请打开委托查看原因'});
      if(j.status==='limited')reasons.push({code:'job_budget',label:j.summary||'推进费用需要确认'});
      if(a.data.agentActions.some(r=>r.jobId===j.id&&['running','uncertain'].includes(r.status)))reasons.push({code:'uncertain',label:'所属委托有外部结果待核对'});
      if(['organize','execute','verify'].some(role=>!a.data.providers.some(p=>p.id===a.data.settings.roles?.[role])))reasons.push({code:'model',label:'所需模型尚未配置完整'});
      if(j.status==='completed')reasons.push({code:'job_attention',label:'委托已结束但仍有等待记录，请打开委托核对'});
      if(!reasons.length)reasons.push({code:'waiting',label:'等待符合条件的新证据，检查时间不代表完成时间'});
      const row={id:`followup:${j.id}:${f.key}`,kind:'followup',taskId:task?.id || null,jobId:j.id,projectId:j.projectId || null,projectName:j.projectId?text(a.data.projects.find(p=>p.id===j.projectId)?.name || '项目已移除',100):'独立工作',title:text(f.expected || f.reason,500),status:'waiting',statusLabel:'持续跟进',priority:task?.priority || 'normal',deadlineAt,nextCheckAt:checkAt,scheduledAt:iso(j.nextRunAt),at,bucket:bucket(at,now,timeZone),dateKind:deadlineAt?'跟进期限':checkAt?'再次检查':'跟进未设日期',reasons,canSchedule:false};
      rows.push(row);
      if(deadlineAt&&checkAt&&bucket(checkAt,now,timeZone)!==row.bucket)rows.push({...row,id:`followup-check:${j.id}:${f.key}`,at:checkAt,bucket:bucket(checkAt,now,timeZone),dateKind:'再次检查'});
    }
  }
  const counts=Object.fromEntries(buckets.map(key=>[key,rows.filter(r=>r.bucket===key).length]));
  const rank={high:0,normal:1,low:2};
  rows.sort((x,y)=>buckets.indexOf(x.bucket)-buckets.indexOf(y.bucket)||(rank[x.priority]??1)-(rank[y.priority]??1)||(x.at || 'z').localeCompare(y.at || 'z')||x.id.localeCompare(y.id));
  const selected=filter==='all'?rows:rows.filter(r=>r.bucket===filter);
  return {generatedAt:new Date(now).toISOString(),timeZone,today:stewardship.local(now,timeZone).day,projectId,bucket:filter,rows:selected.slice(offset,offset+limit),counts,total:selected.length,offset,limit,more:offset+limit<selected.length,automatic,modelCalls:0};
}
function localDeadline(value,timeZone) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('截止时间格式无效');
  const naive=Date.parse(value+'Z');
  if(!Number.isFinite(naive)||new Date(naive).toISOString().slice(0,16)!==value)throw new Error('截止时间无效');
  const matches=[];
  // A local wall time can be missing or repeated at a daylight saving transition.
  for(let at=naive-18*3600000;at<=naive+18*3600000;at+=60000) {
    const p=stewardship.local(at,timeZone),minute=Number(value.slice(11,13))*60+Number(value.slice(14,16));
    if(p.day===value.slice(0,10)&&p.minute===minute)matches.push(at);
  }
  if(matches.length!==1)throw new Error(matches.length?'该时刻因夏令时重复，请选择其他时间':'该时刻在此时区不存在，请选择其他时间');
  return new Date(matches[0]).toISOString();
}
function schedule(a,input) {
  a.ensureIdle();
  if(!object(input)||typeof input.projectId!=='string')throw new Error('请提交当前安排项目范围');
  const projectId=scope(a,input.projectId),changes=input.changes;
  if(!object(changes)||!Object.keys(changes).length||Object.keys(changes).some(k=>!['priority','dueAt','dueLocal'].includes(k)))throw new Error('批量安排只能修改优先级与截止时间');
  const patch={};
  if(Object.hasOwn(changes,'priority')) {if(!['high','normal','low'].includes(changes.priority))throw new Error('优先级无效');patch.priority=changes.priority;}
  if(Object.hasOwn(changes,'dueAt')&&Object.hasOwn(changes,'dueLocal'))throw new Error('只能指定一种截止时间');
  if(Object.hasOwn(changes,'dueAt')) {
    if(changes.dueAt!==null&&(typeof changes.dueAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(changes.dueAt)||!iso(changes.dueAt)))throw new Error('截止时间须包含时区，清空时请传 null');
    if(changes.dueAt!==null) {const wall=changes.dueAt.slice(0,16),check=Date.parse(wall+'Z');if(!Number.isFinite(check)||new Date(check).toISOString().slice(0,16)!==wall)throw new Error('截止日期或时间无效');}
    patch.dueAt=changes.dueAt===null?null:iso(changes.dueAt);
  }
  if(Object.hasOwn(changes,'dueLocal'))patch.dueAt=localDeadline(changes.dueLocal,timezone(a));
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>100||new Set(input.items.map(v=>v?.id)).size!==input.items.length)throw new Error('每次请选择 1–100 个不同事项');
  const tasks=input.items.map(item=>{
    if(!object(item)||typeof item.id!=='string'||typeof item.revision!=='string')throw new Error('所选事项版本无效');
    const t=a.data.tasks.find(t=>t.id===item.id);
    if(!t||!includes(projectOf(a,t),projectId))throw new Error('事项已移除或不属于当前项目范围，请刷新');
    if(t.deletedAt||t.agentCancelled||!editable.has(t.status)||t.agentJobId&&!jobOf(a,t))throw new Error('所选事项当前不能批量安排，请刷新');
    if(unsettled(a,t))throw new Error('请先核对所属事项或委托的外部动作结果');
    if(item.revision!==revision(a,t))throw new Error('所选事项已发生变化，本次未修改任何事项，请刷新后重新选择');
    return t;
  });
  // Validation is complete before the first mutation. Scheduling metadata does not
  // rewrite task evidence, invalidate drafts, resume jobs or grant execution rights.
  const at=new Date().toISOString();
  for(const t of tasks)Object.assign(t,patch,{updatedAt:at});
  a.event('已批量安排事项',`更新 ${tasks.length} 个事项的${Object.hasOwn(patch,'priority')?'优先级':''}${Object.keys(patch).length===2?'与':''}${Object.hasOwn(patch,'dueAt')?'截止时间':''}`);
  a.save();return a.publicState();
}
function dispatch(a,action,input={}) {
  if(action==='operationsAgenda')return agenda(a,input);
  if(action==='operationsSchedule')return schedule(a,input);
  throw new Error('未知今日安排操作');
}
module.exports={agenda,schedule,dispatch,revision,localDeadline};
