// Attention is a local projection of work state. Acknowledging a card never
// changes the underlying task, approval, decision or follow-up.
const crypto = require('node:crypto');
const deadlineEvents=require('./deadline-events.cjs');
const deadlineState=require('./deadline-state.cjs');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(object) : [];
const strings = value => Array.isArray(value) ? value.filter(v=>typeof v==='string') : [];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => typeof value==='string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value,max=1200) => typeof value==='string' ? value.slice(0,max) : '';
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const severityRank = {critical:0,warning:1,info:2};
const categories = {decision:'需要决定',approval:'外部动作',review:'成果验收',blocked:'推进受阻',followup:'等待跟进',deadline:'截止提醒',completion:'完成进展'};
const snoozeMinutes = [30,120,1440];
function normalize(value) {
  const seen=new Set();
  return rows(value).filter(row=>{
    if(typeof row.id!=='string'||row.id.length>1000||typeof row.revision!=='string'||!/^[a-f0-9]{64}$/.test(row.revision)||seen.has(row.id))return false;
    seen.add(row.id);return true;
  }).map(row=>({id:row.id,revision:row.revision,readAt:iso(row.readAt),snoozedUntil:iso(row.snoozedUntil),notifiedKey:typeof row.notifiedKey==='string'&&/^[a-f0-9]{64}$/.test(row.notifiedKey)?row.notifiedKey:null,notifiedAt:iso(row.notifiedAt)}));
}
function initialize(a) {a.data.attentionRecords=normalize(a.data.attentionRecords);sync(a);}
function restore() {return [];}
function parameters(data,input) {
  if(!object(input))throw new Error('关注中心参数无效');
  const projectId=own(input,'projectId')?input.projectId:'';
  if(typeof projectId!=='string'||projectId.length>300||(projectId&&projectId!=='@independent'&&!rows(data.projects).some(p=>p.id===projectId)))throw new Error('关注中心所属项目无效');
  const state=own(input,'state')?input.state:'all',category=own(input,'category')?input.category:'all';
  if(!['all','unread','read','snoozed'].includes(state))throw new Error('关注状态无效');
  if(category!=='all'&&!own(categories,category))throw new Error('关注类别无效');
  const page=own(input,'page')?input.page:1,pageSize=own(input,'pageSize')?input.pageSize:30;
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('关注中心分页无效');
  return {projectId,state,category,page,pageSize};
}
function build(a) {
  const data=object(a.data)?{...a.data,deadlineState:deadlineEvents.state(a)}:{}, now=Date.now(), cards=[], notices=[];
  const map=value=>new Map(rows(value).filter(v=>typeof v.id==='string').map(v=>[v.id,v]));
  const projects=map(data.projects),jobs=map(data.delegations),tasks=map(data.tasks),sources=map(data.sources),artifacts=map(data.artifacts);
  const records=new Map(normalize(data.attentionRecords).map(row=>[row.id,row]));
  const scope=value=>value===undefined||value===null||value===''?'':typeof value==='string'&&projects.has(value)?value:null;
  const jobScope=job=>job?scope(job.projectId):null;
  const taskScope=task=>{
    if(!task)return null;const direct=scope(task.projectId);
    if(!task.agentJobId)return direct;
    const linked=jobScope(jobs.get(task.agentJobId));
    return linked===null||direct===null||(task.projectId&&direct!==linked)?null:linked;
  };
  const sourceHashes=new Map(),taskHashes=new Map();
  const sourceBasis=ids=>strings(ids).map(id=>{if(!sourceHashes.has(id)){const s=sources.get(id);sourceHashes.set(id,hash(s?[s.title,s.content,s.deleted,s.projectExcluded,s.previousSourceId,s.version]:null));}return [id,sourceHashes.get(id)];});
  const taskBasis=task=>{if(!task)return null;if(!taskHashes.has(task.id))taskHashes.set(task.id,hash([task.title,task.description,task.criteria,task.status,task.needsReplan,sourceBasis(task.sourceIds),rows(task.steps).map(s=>[s.id,s.title,s.kind,s.tool,s.done,s.evidence,s.artifactId,artifacts.get(s.artifactId)?.content]),task.verification,task.notes]));return taskHashes.get(task.id);};
  const jobBasis=job=>job?[job.title,job.goal,sourceBasis(job.sourceIds),strings(job.taskIds).map(id=>taskBasis(tasks.get(id)))]:null;
  let invalidScope=0;
  const add=(id,category,severity,title,detail,owner,route,basis,extra={})=>{
    if(owner===null){invalidScope++;return;}
    if(projects.get(owner)?.archivedAt&&!(category==='approval'&&severity==='critical'))return;
    const projectName=owner==='@workspace'?'全部工作':owner?text(projects.get(owner)?.name,200)||'所选项目':'独立工作';
    const revision=hash([id,category,severity,title,detail,owner,basis,extra]);
    const saved=records.get(id),record=saved?.revision===revision?saved:null;
    const snoozed=!!record?.snoozedUntil&&Date.parse(record.snoozedUntil)>now;
    const state=snoozed?'snoozed':record?.readAt?'read':'unread';
    cards.push({id,revision,category,categoryLabel:categories[category],severity,title:text(title,300)||'未命名工作',detail:text(detail),projectId:owner,projectName,route,state,readAt:record?.readAt||null,snoozedUntil:record?.snoozedUntil||null,...extra});
  };
  const relevantJobs=new Set();
  for(const decision of rows(data.decisions)) {
    if(decision.status!=='open')continue;
    if(decision.kind==='task_question'){const task=tasks.get(decision.taskIds?.[0]);if(task&&!task.agentJobId)add(`decision:${decision.id}`,'decision','info',task.title,decision.question,taskScope(task),{page:'decisions',taskId:task.id},[decision.question,decision.context,decision.options,taskBasis(task)],{paused:task.status==='paused'});continue;}
    const job=jobs.get(decision.jobId),owner=jobScope(job);
    if(!job||owner===null||(decision.projectId&&scope(decision.projectId)!==owner)){invalidScope++;continue;}
    relevantJobs.add(job.id);
    add(`decision:${decision.id}`,'decision',['timeout','permission'].includes(decision.kind)?'warning':'info',job.title,decision.access?.message||decision.question||'有待处理的决定',owner,{page:'decisions',jobId:job.id},[decision.kind,decision.question,decision.context,decision.options,decision.suggestion,decision.access?.stage,decision.taskIds,decision.sourceIds,decision.basis,jobBasis(job)],{paused:job.status==='paused'});
  }
  for(const action of rows(data.agentActions)) {
    if(!['pending','uncertain'].includes(action.status))continue;
    const task=action.taskId?tasks.get(action.taskId):null,job=jobs.get(action.jobId),owner=jobScope(job);
    if(!job||owner===null||(action.projectId&&scope(action.projectId)!==owner)||(action.taskId&&(!task||task.agentJobId!==job.id||taskScope(task)!==owner))){invalidScope++;continue;}
    if(require('./decisions.cjs').approved(data,job,action))continue;
    relevantJobs.add(job.id);
    add(`action:${action.id}`,'approval',action.status==='uncertain'?'critical':'warning',task?.title||job.title,action.status==='uncertain'?'外部动作的结果尚未确认，请先核对执行记录。':'有外部动作等待批准，请查看具体动作和当前产出。',owner,{page:'agent',jobId:job.id},[action.status,action.tool,action.title,action.content,action.body,action.target,action.number,action.desired,action.baseline,action.args,action.payload,action.artifactId,action.version,action.result,action.connectorId,action.respondentId,action.expected,taskBasis(task),job.goal],{paused:job.status==='paused'});
  }
  for(const task of tasks.values()) {
    if(deadlineState.resolved(task))continue;
    const owner=taskScope(task),job=jobs.get(task.agentJobId),route={page:'board',taskId:task.id,...(owner?{projectId:owner}:{})};
    const paused=task.status==='paused'||job?.status==='paused';
    if(task.status==='review') {
      add(`review:${task.id}`,'review','info',task.title,'执行与检查已形成记录，请查看成果和当前验收依据。',owner,{...route,page:'acceptance'},taskBasis(task),{paused});
      if(job)relevantJobs.add(job.id);
    } else if(task.status==='blocked'&&!job) add(`blocked:${task.id}`,'blocked','warning',task.title,task.lastError||'事项推进受阻，请查看原因并补充信息。',owner,route,[task.lastError,taskBasis(task)],{paused});
    if(!job&&task.status==='waiting') {
      const due=!!task.followupDue||!!(iso(task.nextCheckAt)&&Date.parse(task.nextCheckAt)<=now);
      add(`waiting:${task.id}`,'followup',due?'warning':'info',task.title,task.waitingOn||(due?'已到计划跟进时间，请核对外部进展。':'事项正在等待外部结果或补充信息。'),owner,route,[task.waitingOn,task.nextCheckAt,taskBasis(task)],{paused,deadlineAt:iso(task.nextCheckAt),followupDue:due});
    }
    const risk=deadlineEvents.view(data,task,now);
    if(risk.active) {
      const id=`deadline:${task.id}`,saved=records.get(id);
      // Preserve legacy UI acknowledgements only when their exact old revision
      // still matches. Work revisions and policy revisions never inherit them.
      const legacyRevision=!task.deadlinePolicy&&task.workRevision==null?hash([id,'deadline',risk.stage==='overdue'?'critical':'warning',task.title,risk.stage==='overdue'?'事项已超过截止时间。':'事项将在 24 小时内到期。',owner,[risk.dueAt,task.status,task.priority],{paused,deadlineAt:risk.dueAt}]):null;
      const legacy=!data.deadlineState.events[risk.event.id]&&saved?.revision===legacyRevision?saved:null;
      const readAt=risk.event.readAt||legacy?.readAt||null,snoozedUntil=risk.event.snoozeUntil||legacy?.snoozedUntil||null;
      add(id,'deadline',risk.stage==='overdue'?'critical':'warning',task.title,risk.detail,owner,route,risk.event.id,{paused:risk.paused,pauseReason:risk.pauseReason,deadlineAt:risk.dueAt,deadlineStage:risk.stage,deadlineEventId:risk.event.id,legacyAttentionRevision:risk.legacyAttentionRevision,riskKey:risk.riskKey,acknowledged:risk.acknowledged,canAcknowledge:true,revision:risk.event.id,state:snoozedUntil&&Date.parse(snoozedUntil)>now?'snoozed':readAt?'read':'unread',readAt,snoozedUntil});
    } else if(!risk.terminal&&risk.precision==='date') {
      add(`deadline-date:${task.id}`,'deadline','info',task.title,'日期已记录，具体时间待确认。',owner,route,[risk.workRevision,risk.deadlineRevision],{paused,localDate:risk.localDate,timeZone:risk.timeZone,needsTime:risk.needsTime,suppressNotification:true});
    }
  }
  for(const job of jobs.values()) {
    const owner=jobScope(job),route={page:'agent',jobId:job.id},paused=job.status==='paused';
    if(['blocked','limited','retry'].includes(job.status)) add(`job:${job.id}`,'blocked',job.status==='retry'?'info':'warning',job.title,job.lastError||job.summary||'委托需要检查后继续。',owner,route,[job.status,job.limitReason,job.maxCalls,job.goal],{paused,automaticRetry:job.status==='retry'});
    else if(['needs_input','approval','review'].includes(job.status)&&!relevantJobs.has(job.id))add(`job:${job.id}`,job.status==='review'?'review':'decision','info',job.title,job.summary||'委托等待你处理。',owner,route,[job.status,jobBasis(job)],{paused});
    for(const [index,f] of rows(job.followups).entries()) {
      if(f.status!=='waiting')continue;
      const task=f.taskId?tasks.get(f.taskId):null;
      if(f.taskId&&(!task||task.agentJobId!==job.id||taskScope(task)!==owner)){invalidScope++;continue;}
      const deadlineAt=iso(f.deadlineAt),checkAt=iso(f.checkAt),overdue=!!deadlineAt&&Date.parse(deadlineAt)<=now;
      if(!overdue)continue;
      // The decision card is the actionable timeout entry when it exists.
      if(rows(data.decisions).some(d=>d.status==='open'&&d.kind==='timeout'&&d.jobId===job.id&&d.followupKey===f.key))continue;
      add(`followup:${job.id}:${f.key||index}`,'followup','warning',task?.title||job.title,`跟进期限已过：${text(f.expected||f.reason,1000)}`,owner,route,[f.key,f.createdAt,f.expected,f.reason,f.deadlineAt,f.sourceIds,f.respondentId,f.invalidatedAt],{paused,deadlineAt,checkAt});
    }
  }
  const recent=at=>!!iso(at)&&Date.parse(at)<=now&&Date.parse(at)>=now-7*86400000;
  let completionChecks;
  const validCompletion=task=>{
    if(!task||task.status!=='completed'||task.agentCancelled||!Array.isArray(task.verification?.gaps)||task.verification.gaps.length||typeof task.verification.basis!=='string')return false;
    for(const step of rows(task.steps))if(step.kind==='external'&&step.tool&&step.tool!=='manual'){let evidence;try{evidence=JSON.parse(step.evidence);}catch{}if(typeof evidence?.actionId!=='string')return false;}
    try {
      completionChecks ||= require('./acceptance.cjs').presentationChecks(a);
      return completionChecks(task,true).length===0;
    } catch { return false; }
  };
  for(const job of jobs.values()) {
    if(job.status!=='completed'||!recent(job.completedAt))continue;
    const active=strings(job.taskIds).map(id=>tasks.get(id)).filter(task=>!task?.agentCancelled);
    if(!active.length||active.some(task=>!validCompletion(task))||rows(job.followups).some(f=>f.status==='waiting')||rows(data.decisions).some(d=>d.jobId===job.id&&d.status==='open')||rows(data.agentActions).some(r=>r.jobId===job.id&&['pending','running','uncertain'].includes(r.status)))continue;
    add(`completion:job:${job.id}`,'completion','info',job.title,'委托已有完成记录，当前事项和检查依据完整。打开委托查看成果及交付记录。',jobScope(job),{page:'agent',jobId:job.id},[job.completedAt,job.summary,jobBasis(job)],{completedAt:iso(job.completedAt)});
  }
  for(const task of tasks.values())if(!task.agentJobId&&recent(task.completedAt)&&validCompletion(task))add(`completion:task:${task.id}`,'completion','info',task.title,'事项已有完成记录，当前执行步骤和检查依据完整。打开事项查看成果。',taskScope(task),{page:'board',taskId:task.id},[task.completedAt,taskBasis(task)],{completedAt:iso(task.completedAt)});
  const schedule=data.briefingSchedule;
  if(object(schedule)&&typeof schedule.error==='string'&&schedule.error.trim()) {
    const owner=schedule.projectId==='@independent'?'':schedule.projectId&&projects.has(schedule.projectId)?schedule.projectId:'@workspace';
    const failed=rows(schedule.runs).find(run=>['failed','interrupted'].includes(run.status));
    add('briefingSchedule:error','blocked','warning','定时工作简报需要处理',schedule.error,owner,{page:'briefing'},[schedule.revision,schedule.error,failed?.id,failed?.status]);
  }
  for(const [kind,label,connections] of [['feed','RSS 订阅',rows(a.data.feedConnections)],['web','网页订阅',rows(a.data.webConnections)],['connector','信息连接',rows(a.data.connectors)]]) {
    for(const connection of connections) {
      if(!['auth','permission','missing_cli','merge','error','connection','cursor','interrupted'].includes(connection.health))continue;
      const owner=connection.projectId&&projects.has(connection.projectId)?connection.projectId:'@workspace';
      add(`collection:${kind}:${connection.id}`,'blocked','warning',`${label}「${connection.name||'未命名'}」需要处理`,'最近收集未能完整结束，已保存的材料会保留。请打开信息连接查看原因并重试。',owner,{page:'connections'},[connection.health,connection.error,connection.url||connection.target],{paused:connection.enabled===false});
    }
  }
  cards.sort((a,b)=>severityRank[a.severity]-severityRank[b.severity]||(a.deadlineAt||'z').localeCompare(b.deadlineAt||'z')||a.id.localeCompare(b.id));
  if(invalidScope)notices.push(`${invalidScope} 条记录的项目或关联关系不完整，请在工作体检中核对。`);
  return {cards,records,notices,now};
}
function sync(a) {
  const {cards}=build(a),current=new Map(cards.map(row=>[row.id,row]));
  const previous=a.data.attentionRecords,next=normalize(previous).filter(row=>(current.get(row.id)?.revision===row.revision||current.get(row.id)?.legacyAttentionRevision===row.revision)&&(row.readAt||row.snoozedUntil||row.notifiedKey));
  a.data.attentionRecords=next;return JSON.stringify(previous)!==JSON.stringify(next);
}
function snapshot(a,input={}) {
  const params=parameters(a.data||{},input),{cards,notices,now}=build(a);
  const scoped=cards.filter(row=>!params.projectId||(params.projectId==='@independent'?row.projectId==='':row.projectId===params.projectId));
  const counts={all:scoped.length,unread:0,read:0,snoozed:0};for(const row of scoped)counts[row.state]++;
  const categoryCounts=Object.fromEntries(Object.keys(categories).map(key=>[key,scoped.filter(row=>row.category===key).length]));
  const selected=scoped.filter(row=>(params.state==='all'||row.state===params.state)&&(params.category==='all'||row.category===params.category));
  const total=selected.length,pageCount=Math.max(1,Math.ceil(total/params.pageSize)),page=Math.min(params.page,pageCount),start=(page-1)*params.pageSize;
  return {generatedAt:new Date(now).toISOString(),projectId:params.projectId,counts,categoryCounts,items:selected.slice(start,start+params.pageSize),total,page,pageSize:params.pageSize,pageCount,from:total?start+1:0,to:Math.min(start+params.pageSize,total),notices:params.projectId?[]:notices,modelCalls:0,networkRequests:0};
}
function notificationKey(card,record) {return hash([card.revision,record?.snoozedUntil||null]);}
function pendingNotifications(a) {
  const {cards,records}=build(a),items=[];
  for(const card of cards) {
    if(card.state!=='unread'||card.category==='deadline'||card.suppressNotification)continue;
    const previous=records.get(card.id),record=previous?.revision===card.revision?previous:null,key=notificationKey(card,record);
    if(record?.notifiedKey===key)continue;
    items.push({id:card.id,revision:card.revision,notificationKey:key,title:card.title,severity:card.severity});
  }
  const deadlineCards=new Map(cards.filter(c=>c.deadlineEventId&&c.state==='unread').map(c=>[c.id,c]));
  items.push(...deadlineEvents.pendingNotifications(a).items.filter(item=>deadlineCards.has(item.id)));
  return {count:items.length,items};
}
function persist(a,next) {
  const previous=a.data.attentionRecords;
  a.data.attentionRecords=next;
  try{a.save();}catch(error){a.data.attentionRecords=previous;throw error;}
}
function markNotified(a,items) {
  if(!Array.isArray(items))throw new Error('通知记录无效');
  const pending=new Map(pendingNotifications(a).items.map(row=>[row.id,row])),next=normalize(a.data.attentionRecords),at=new Date().toISOString();let count=0;
  for(const item of items) {
    if(!object(item)||item.eventId)continue;
    const current=pending.get(item.id);
    if(!current||item.revision!==current.revision||item.notificationKey!==current.notificationKey)continue;
    pending.delete(item.id);
    let record=next.find(row=>row.id===item.id);
    if(!record){record={id:item.id};next.push(record);}
    if(record.revision!==item.revision){record.readAt=null;record.snoozedUntil=null;}
    Object.assign(record,{revision:item.revision,notifiedKey:item.notificationKey,notifiedAt:at});count++;
  }
  if(count)persist(a,next);return count+deadlineEvents.markNotified(a,items.filter(item=>object(item)&&item.eventId));
}
function dispatch(a,action,input={}) {
  if(action==='attentionSnapshot')return snapshot(a,input);
  if(!['attentionRead','attentionUnread','attentionSnooze','attentionUnsnooze','attentionAcknowledgeDeadline'].includes(action))throw new Error('未知关注中心操作');
  if(!object(input)||typeof input.id!=='string'||typeof input.revision!=='string')throw new Error('请选择当前关注记录');
  const card=build(a).cards.find(row=>row.id===input.id);
  if(!card||card.revision!==input.revision)throw new Error('关注内容已变化或已解决，请刷新后查看最新记录');
  if(action==='attentionSnooze'&&!snoozeMinutes.includes(input.minutes))throw new Error('稍后提醒须为 30 分钟、2 小时或明天');
  if(card.deadlineEventId) {
    return deadlineEvents.act(a,{taskId:card.route.taskId,eventId:card.deadlineEventId,riskKey:input.riskKey||card.riskKey,action:{attentionRead:'read',attentionUnread:'unread',attentionSnooze:'snooze',attentionUnsnooze:'unsnooze',attentionAcknowledgeDeadline:'acknowledge'}[action],minutes:input.minutes});
  }
  if(action==='attentionAcknowledgeDeadline')throw Error('请选择截止风险提醒');
  const next=normalize(a.data.attentionRecords).filter(row=>row.id!==card.id);
  if(action==='attentionRead'||action==='attentionSnooze') {
    const previous=normalize(a.data.attentionRecords).find(row=>row.id===card.id&&row.revision===card.revision);
    next.push({id:card.id,revision:card.revision,readAt:action==='attentionRead'?new Date().toISOString():null,snoozedUntil:action==='attentionSnooze'?new Date(Date.now()+input.minutes*60000).toISOString():null,notifiedKey:previous?.notifiedKey||null,notifiedAt:previous?.notifiedAt||null});
  }
  persist(a,next);
  return {saved:true,modelCalls:0,networkRequests:0};
}
module.exports={initialize,sync,restore,snapshot,dispatch,pendingNotifications,markNotified,categories};
