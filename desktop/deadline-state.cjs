// Pure deadline projection. Call updatePolicy only for an explicit scheduling
// change; polling, reads and execution never change a user's priority or dates.
const crypto = require('node:crypto');
const dates = require('./date-time.cjs');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TERMINAL = new Set(['completed','deleted','cancelled','canceled']);
const stages = {none:0,scheduled:0,soon:1,imminent:2,overdue:3,resolved:0};
function resolved(task) {return !task || !!(task.deletedAt || task.deleted || task.agentCancelled) || TERMINAL.has(task.status);}
function workRevision(task) {return task.workRevision ?? 1;}
function legacyPolicy(task) {
  let dueAt=null;try{dueAt=dates.optionalISO(task.dueAt);}catch{}
  return {deadlineRevision:`legacy:${hash([task.dueAt||null])}`,dueAt,timeZone:null,precision:'instant',localDate:null,remindBeforeMinutes:[1440],notifyAtDue:true,overdueRepeat:'off',origin:'legacy',legacyDueAt:task.dueAt??null};
}
function policy(task) {return task.deadlinePolicy || legacyPolicy(task);}
function rules(value) {
  if(!Array.isArray(value)||value.some(n=>!Number.isSafeInteger(n)||n<=0||n>525600))throw Error('提醒提前分钟数无效');
  return [...new Set(value)].sort((a,b)=>b-a);
}
function scheduling(p) {return [p.dueAt,p.timeZone||null,p.precision,p.localDate||null,p.remindBeforeMinutes,p.notifyAtDue,p.overdueRepeat,p.requireTime===true,p.keepDateOnly===true];}
function updatePolicy(task, input={}, {legacy=false}={}) {
  if(!input || typeof input!=='object'||Array.isArray(input))throw Error('截止策略无效');
  const previous=policy(task),base=task.deadlinePolicy||{...previous,remindBeforeMinutes:legacy?[1440]:[1440,60]};
  const next={...base,...input};
  next.precision=input.precision || (Object.hasOwn(input,'dueAt')?'instant':base.precision);
  next.timeZone=dates.optionalTimeZone(next.timeZone);
  if(next.precision==='date') {
    next.localDate=dates.optionalDate(next.localDate);
    if(!next.localDate||!next.timeZone)throw Error('日期型截止须提供日期和时区');
    if(Object.hasOwn(input,'dueAt')&&![null,undefined,''].includes(input.dueAt))throw Error('仅日期截止不能同时指定时刻');
    next.dueAt=null;
  } else if(next.precision==='instant') {
    next.dueAt=dates.optionalISO(next.dueAt,'截止时间');next.localDate=null;
    if(next.dueAt&&next.timeZone&&Object.hasOwn(input,'dueAt')&&!input.dueAt.endsWith('Z'))dates.assertOffsetInZone(input.dueAt,next.timeZone);
  } else throw Error('截止时间精度无效');
  next.remindBeforeMinutes=rules(next.remindBeforeMinutes);
  if(typeof next.notifyAtDue!=='boolean'||next.overdueRepeat!=='off')throw Error('截止提醒规则无效');
  if(task.deadlinePolicy&&JSON.stringify(scheduling(previous))===JSON.stringify(scheduling(next)))return previous;
  // Reverting A -> B -> A is a new arrangement, never a hash of the due date.
  const revision=Number.isSafeInteger(previous.deadlineRevision)?previous.deadlineRevision:0;
  next.deadlineRevision=revision+1;next.origin=input.origin || (legacy?'legacy':'user');
  if(next.origin!=='legacy')delete next.legacyDueAt;
  for(const key of ['snoozeUntil','acknowledgedStage','snoozeGeneration'])delete next[key];
  task.deadlinePolicy=next;task.dueAt=next.dueAt;
  return next;
}
function migrate(task) {
  if(!task.deadlinePolicy){task.deadlinePolicy=legacyPolicy(task);}
  return task.deadlinePolicy;
}
function evaluate(task, now=Date.now(), input=policy(task||{})) {
  const result={stage:'none',nextBoundary:null,dueAt:null,precision:input.precision||'instant',localDate:input.localDate||null,timeZone:input.timeZone||null,workRevision:workRevision(task||{}),deadlineRevision:input.deadlineRevision,notify:false};
  if(resolved(task))return {...result,stage:'resolved'};
  if(input.precision==='date')return {...result,stage:'scheduled',needsTime:input.requireTime===true&&input.keepDateOnly!==true};
  let dueAt;try{dueAt=dates.optionalISO(input.dueAt);}catch{return {...result,invalidTime:true};}
  if(!dueAt)return result;
  const time=typeof now==='number'?now:Date.parse(now);if(!Number.isFinite(time))throw Error('截止评估时间无效');
  const due=Date.parse(dueAt),remaining=due-time;
  const offsets=rules(input.remindBeforeMinutes||[]),reached=offsets.filter(n=>remaining<=n*60000);
  const stage=remaining<=0?'overdue':reached.length?(reached.some(n=>n<=60)?'imminent':'soon'):'scheduled';
  const boundaries=[due,...offsets.map(n=>due-n*60000)].filter(at=>at>time);
  return {...result,stage,dueAt,remainingMs:remaining,nextBoundary:boundaries.length?new Date(Math.min(...boundaries)).toISOString():null,notify:stage==='overdue'?input.notifyAtDue!==false:stages[stage]>0};
}
function stageKey(task, evaluated=evaluate(task)) {return hash([task.id,evaluated.workRevision,evaluated.deadlineRevision,evaluated.stage]);}
function eventKey(task,evaluated=evaluate(task),snoozeGeneration=0) {return hash([task.id,evaluated.workRevision,evaluated.deadlineRevision,evaluated.stage,snoozeGeneration]);}
function effectivePriority(task, now=Date.now()) {const {stage}=evaluate(task,now);return {priority:task.priority,deadlineStage:stage,urgency:stages[stage]};}
module.exports={evaluate,policy,legacyPolicy,updatePolicy,migrate,resolved,workRevision,stageKey,eventKey,effectivePriority,stages};
