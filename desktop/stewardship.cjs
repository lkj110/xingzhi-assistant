const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {optionalISO}=require('./date-time.cjs');
const everyDay=[0,1,2,3,4,5,6];
const formatters=new Map();
const now=()=>new Date().toISOString();
const clock=/^([01]\d|2[0-3]):[0-5]\d$/;
function formatter(timeZone){
  if(!formatters.has(timeZone))formatters.set(timeZone,new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
  return formatters.get(timeZone);
}
function local(at,timeZone){
  const p=Object.fromEntries(formatter(timeZone).formatToParts(new Date(at)).map(v=>[v.type,v.value]));
  const day=`${p.year}-${p.month}-${p.day}`;return {day,weekday:new Date(day+'T00:00:00Z').getUTCDay(),minute:Number(p.hour)*60+Number(p.minute)};
}
const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
function inWindow(window,minute){
  if(!window.enabled)return true;
  const start=minutes(window.start),end=minutes(window.end);
  return start<end?minute>=start&&minute<end:minute>=start||minute<end;
}
function migrate(value){
  if(value&&typeof value==='object')value.dailyCallLimit=0;
  if(value&&typeof value==='object'){if(value.weekdays===undefined)value.weekdays=[...everyDay];if(value.pauseUntil===undefined)value.pauseUntil=null;if(value.policyRevision===undefined)value.policyRevision=crypto.randomUUID();}
  return value;
}
function schedule(s,p){
  const previous=s.window.enabled&&minutes(s.window.start)>minutes(s.window.end)&&p.minute<minutes(s.window.end);
  const weekday=previous?(p.weekday+6)%7:p.weekday;
  return {weekday,workday:(s.weekdays||everyDay).includes(weekday),inWindow:inWindow(s.window,p.minute)};
}
function revision(s){return crypto.createHash('sha256').update(JSON.stringify([s.policyRevision,s.paused,s.pauseUntil,s.weekdays,s.window,s.dailyCallLimit,s.timeZone])).digest('hex');}
function revokeResume(data){if(data.stewardship){data.stewardship.paused=true;data.stewardship.pauseUntil=null;data.stewardship.policyRevision=crypto.randomUUID();}}
function pauseForStop(a){
  a.data.runtime ||= {};a.data.runtime.stewardshipResumeHold=true;revokeResume(a.data);
  try{persist(a);}catch{a.stewardshipError='停止状态无法保存，自动工作与模型调用已暂停。请检查本地存储目录。';}
}
function resumeExpired(a,at=Date.now()){
  const s=a.data.stewardship;if(s.pauseUntil){try{optionalISO(s.pauseUntil,'自动恢复时间');}catch{a.stewardshipError='自动恢复授权无效，自动托管继续暂停。请检查本地设置。';return false;}}if(a.stewardshipError||(a.data.runtime?.stewardshipRecoveryHold||a.data.runtime?.stewardshipResumeHold)||!s.paused||!s.pauseUntil||Date.parse(s.pauseUntil)>at)return false;
  const value={...s,paused:false,pauseUntil:null,policyRevision:crypto.randomUUID(),lastTimedResumeAt:new Date(at).toISOString()};
  try{persist(a,value);}catch{a.stewardshipError='定时恢复状态无法保存，自动托管继续暂停。请检查本地存储目录。';return false;}
  a.data.stewardship=value;a.event('定时暂停已结束','全局托管暂停已解除；后续仍遵循工作星期、时段、费用上限和各项手动暂停。');return true;
}
function validDays(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('调用账本格式无效');
  for(const [day,count] of Object.entries(value))if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isSafeInteger(count)||count<0)throw new Error('调用账本格式无效');
  return value;
}
function settings(value){
  if(!value||!Number.isSafeInteger(value.dailyCallLimit)||value.dailyCallLimit<0||value.dailyCallLimit>100000||typeof value.paused!=='boolean'||typeof value.timeZone!=='string')throw new Error('托管设置格式无效');
  formatter(value.timeZone);
  if(!Array.isArray(value.weekdays)||value.weekdays.length<1||value.weekdays.length>7||value.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)||new Set(value.weekdays).size!==value.weekdays.length)throw new Error('请选择至少一个不重复的工作星期');
  if(typeof value.policyRevision!=='string'||!value.policyRevision)throw new Error('托管策略版本无效');
  const until=optionalISO(value.pauseUntil,'自动恢复时间');if(until&&!value.paused)throw new Error('未暂停时不能保留自动恢复授权');value.pauseUntil=until;
  const w=value.window;
  if(!w||typeof w.enabled!=='boolean'||!clock.test(w.start)||!clock.test(w.end)||w.start===w.end)throw new Error('自动工作时间须为不同的 HH:mm 时刻');
  validDays(value.usage?.days);
  if(!Number.isFinite(Date.parse(value.meteringStartedAt)))throw new Error('调用账本开始时间无效');
  return value;
}
function ledgerFile(a){return path.join(a.dir,'stewardship-ledger.json');}
function persist(a,value=a.data.stewardship){
  const file=ledgerFile(a),temp=file+'.tmp';
  const body=JSON.stringify({format:1,updatedAt:now(),state:value});
  const fd=fs.openSync(temp,'w',0o600);
  try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
}
function initialize(a){
  const previous=a.data.stewardship;
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  const fallback={timeZone,dailyCallLimit:0,paused:false,weekdays:[...everyDay],pauseUntil:null,policyRevision:crypto.randomUUID(),window:{enabled:false,start:'09:00',end:'18:00'},configuredAt:null,meteringStartedAt:now(),usage:{days:{}}};
  const value=migrate(previous||fallback);
  a.data.stewardship=value;
  try{
    if(fs.existsSync(ledgerFile(a))){
      const stat=fs.lstatSync(ledgerFile(a));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2_000_000)throw new Error('调用账本文件无效');
      const saved=JSON.parse(fs.readFileSync(ledgerFile(a),'utf8'));if(saved.format!==1)throw new Error('调用账本版本无效');settings(migrate(saved.state));
      // This ledger is newer than restored snapshots; settings and the original zone stay authoritative.
      try{settings(value);if(saved.state.timeZone===value.timeZone)for(const [day,count] of Object.entries(value.usage.days))saved.state.usage.days[day]=Math.max(count,saved.state.usage.days[day]||0);if(saved.state.pauseUntil&&(saved.state.pauseUntil!==value.pauseUntil||saved.state.policyRevision!==value.policyRevision))revokeResume({stewardship:saved.state});}catch{if(saved.state.pauseUntil)revokeResume({stewardship:saved.state});}
      a.data.stewardship=saved.state;
    }else{
      settings(value);
      if(!previous){const day=local(Date.now(),timeZone).day;value.usage.days[day]=(a.data.modelCalls||[]).filter(r=>Number.isFinite(Date.parse(r.at))&&local(Date.parse(r.at),timeZone).day===day).length;}
    }
    if(a.data.runtime?.stewardshipRecoveryHold||a.data.runtime?.stewardshipResumeHold)revokeResume(a.data);
    resumeExpired(a);persist(a);
  }catch{
    // Never silently recreate a damaged meter, which would grant a second daily budget.
    try{settings(a.data.stewardship);}catch{a.data.stewardship=fallback;}
    a.stewardshipError='调用账本无法读取或保存，自动工作与模型调用已暂停。请保留原文件并检查存储目录。';
  }
}
function nextAllowed(state,at,budgetDay,includeCurrent=false){
  // Walk actual minutes so gaps and repeated hours use real instants. Weekday ownership is local calendar based.
  const cacheKey=JSON.stringify([state.timeZone,includeCurrent?at:Math.floor(at/60000),budgetDay,includeCurrent,state.window,state.weekdays,state.dailyCallLimit,state.usage.days]);
  if(cacheKey===nextAllowed.lastKey)return nextAllowed.lastValue;
  const available=time=>{const point=local(time,state.timeZone),slot=schedule(state,point);return (!budgetDay||point.day!==budgetDay)&&slot.workday&&slot.inWindow;};
  let result=null;
  if(includeCurrent&&available(at))result=new Date(at).toISOString();
  else for(let time=Math.floor(at/60000)*60000+60000;time<=at+14*86400000;time+=60000)if(available(time)){result=new Date(time).toISOString();break;}
  nextAllowed.lastKey=cacheKey;nextAllowed.lastValue=result;return result;
}
function status(a,at=Date.now()){
  const s=a.data.stewardship,p=local(at,s.timeZone),used=s.usage.days[p.day]||0,limit=0,slot=schedule(s,p);
  const reason=a.stewardshipError?'meter':s.paused?'paused':!slot.workday?'offday':!slot.inWindow?'window':null;
  const resumeAt=reason==='paused'&&s.pauseUntil?nextAllowed(s,Math.max(at,Date.parse(s.pauseUntil)),null,true):['offday','window'].includes(reason)?nextAllowed(s,at,null):null;
  const message=reason==='meter'?a.stewardshipError:reason==='paused'?(s.pauseUntil?'自动托管已定时暂停，到期解除全局暂停后按工作计划继续':'自动托管已暂停，恢复后按原计划继续'):reason==='offday'?'当前不是已选工作日，到下个工作时段继续':reason==='window'?'当前不在自动工作时段，到时继续':'可按计划自动收集与推进';
  return {revision:revision(s),day:p.day,timeZone:s.timeZone,weekdays:s.weekdays||everyDay,windowWeekday:slot.weekday,workday:slot.workday,pauseUntil:s.pauseUntil||null,used,limit,remaining:null,automaticAllowed:!reason,reason,message,nextAllowedAt:resumeAt,meteringStartedAt:s.meteringStartedAt};
}
function canAutomate(a,at=Date.now()){return !a.suspended&&status(a,at).automaticAllowed;}
function preflight(a){
  if(a.stewardshipError)throw Object.assign(new Error(a.stewardshipError),{stewardshipMeter:true});
}
function reserve(a){
  preflight(a);
  const state=structuredClone(a.data.stewardship),day=local(Date.now(),state.timeZone).day;
  state.usage.days[day]=(state.usage.days[day]||0)+1;
  // Save before calling a model. A failed request still consumes one attempt, including crashes.
  try{persist(a,state);}catch{a.stewardshipError='调用账本无法保存，自动工作与模型调用已暂停。请检查存储目录。';throw Object.assign(new Error(a.stewardshipError),{stewardshipMeter:true});}
  a.data.stewardship=state;
}
function defer(a,error,job){
  if(!error.stewardshipBudget)return;
  if(job&&job.status!=='paused'){
    job.status='retry';job.limitReason='workspace_daily';job.failures=0;job.retryCheck=false;
    job.nextRunAt=error.deferredUntil;job.summary=error.message;job.lastError=error.message;
  }
  if(!job)a.data.runtime.stewardshipDeferredWork=true;
}
function reconcile(a,at=Date.now()){
  let changed=resumeExpired(a,at);
  const s=a.data.stewardship,p=local(at,s.timeZone);
  if(a.stewardshipError)return changed;
  for(const j of a.data.delegations)if(j.limitReason==='workspace_daily'&&['retry','limited'].includes(j.status)){
    j.status='ready';j.nextRunAt=new Date(at).toISOString();j.lastError='';j.summary='已取消调用次数限制，将从已保存步骤继续';delete j.limitReason;changed=true;
  }
  for(const t of a.data.tasks)if(t.stewardshipDeferredUntil&&t.status!=='paused'){
    delete t.stewardshipDeferredUntil;if(t.status==='todo')t.lastError='';changed=true;
  }
  if(a.data.runtime.stewardshipDeferredWork){delete a.data.runtime.stewardshipDeferredWork;a.data.settings.lastCycleAt=null;a.lastTick=0;changed=true;}
  return changed;
}
function retain(a,current,restored){
  restored.stewardship=structuredClone(current.stewardship);revokeResume(restored);
  persist(a,restored.stewardship);
}
async function dispatch(a,action,input={}){
  if(action==='stewardshipStatus')return status(a);
  if(a.stewardshipError)throw new Error(a.stewardshipError);
  const value=structuredClone(a.data.stewardship);
  if(action==='stewardshipSettings'){
    if(input.dailyCallLimit!==undefined){if(!Number.isSafeInteger(input.dailyCallLimit)||input.dailyCallLimit<0||input.dailyCallLimit>100000)throw new Error('每日调用上限须为 0–100000 的整数，0 表示不限制');value.dailyCallLimit=0;}
    if(input.window!==undefined){if(!input.window||typeof input.window!=='object'||Array.isArray(input.window))throw new Error('自动工作时段格式无效');value.window={...value.window,...Object.fromEntries(['enabled','start','end'].filter(k=>input.window[k]!==undefined).map(k=>[k,input.window[k]]))};}
    if(input.weekdays!==undefined)value.weekdays=Array.isArray(input.weekdays)?[...input.weekdays].sort((a,b)=>a-b):input.weekdays;
    if(JSON.stringify(value.window)!==JSON.stringify(a.data.stewardship.window)||JSON.stringify(value.weekdays)!==JSON.stringify(a.data.stewardship.weekdays))value.pauseUntil=null;
    value.configuredAt=now();
  }else if(action==='stewardshipPause'){
    const until=optionalISO(input.until,'自动恢复时间');
    if(until){if(input.revision!==revision(a.data.stewardship))throw new Error('托管策略已变化，请刷新后重新设置自动恢复时间');if(Date.parse(until)<=Date.now())throw new Error('自动恢复时间必须晚于当前时刻');}
    value.paused=true;value.pauseUntil=until;
  }
  else if(action==='stewardshipResume'){value.paused=false;value.pauseUntil=null;}
  else throw new Error('未知托管操作');
  value.policyRevision=crypto.randomUUID();settings(value);
  const title=action==='stewardshipSettings'?'托管策略已更新':value.paused?'自动托管已暂停':'自动托管已恢复';
  const detail=value.paused?(value.pauseUntil?`当前请求返回并保存断点后暂停；已设置 ${value.pauseUntil} 解除全局暂停，各项手动暂停继续保留。`:'当前请求返回并保存断点后暂停；各项目的计划与授权保留。'):'将按各项目原有计划和当前托管时段继续。';
  // Commit workspace and event before the authoritative ledger; no trailing save can fail after granting consent.
  if(action==='stewardshipPause'&&value.pauseUntil){
    const previous=a.data.stewardship,events=a.data.events.slice(),runtime=structuredClone(a.data.runtime);
    a.data.stewardship=value;delete a.data.runtime.stewardshipRecoveryHold;delete a.data.runtime.stewardshipResumeHold;a.event(title,detail);
    try{a.save();persist(a,value);}catch(error){a.data.stewardship=previous;a.data.events=events;a.data.runtime=runtime;try{a.save();}catch{}throw error;}
    return a.publicState();
  }
  persist(a,value);a.data.stewardship=value;reconcile(a);
  if(action==='stewardshipResume'){delete a.data.runtime.stewardshipRecoveryHold;delete a.data.runtime.stewardshipResumeHold;}
  a.event(title,detail);a.save();return a.publicState();
}
module.exports={revokeResume,pauseForStop,resumeExpired,initialize,status,canAutomate,preflight,reserve,defer,reconcile,retain,dispatch,local,inWindow};
