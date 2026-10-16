const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const stewardship=require('../desktop/stewardship.cjs'),agent=require('../desktop/agent.cjs'),recovery=require('../desktop/recovery.cjs');
async function setup(t,chat=async()=>({ok:true}),extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-stewardship-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat,...extra});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  return a;
}
const request=a=>a.callModel(a.data.providers[0],'',[{role:'user',content:'private body'}],{});
const current=a=>stewardship.status(a);
const configured=(a,value)=>a.dispatch('stewardshipSettings',value);
async function at(time,callback){const old=Date.now;Date.now=()=>Date.parse(time);try{return await callback();}finally{Date.now=old;}}
function gated(a,timeZone,window,days={}){a.data.stewardship={...a.data.stewardship,timeZone,window,usage:{days}};return a;}

test('Defaults preserve scheduling and every successful or failed request is durably counted',async t=>{
  let n=0;const a=await setup(t,async()=>{n++;if(n===2)throw new Error('network failure');return {ok:true};});
  assert.equal(current(a).automaticAllowed,true);assert.equal(current(a).limit,0);
  await request(a);await assert.rejects(request(a),error=>error.code==='MODEL_FAILED'&&!error.message.includes('network failure'));
  assert.equal(current(a).used,2);assert.equal(a.data.modelCalls.length,2);
  const ledger=JSON.parse(fs.readFileSync(path.join(a.dir,'stewardship-ledger.json'),'utf8'));
  assert.equal(ledger.state.usage.days[current(a).day],2);assert.equal(JSON.stringify(ledger).includes('private body'),false);
  const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(b).used,2);
});
test('Connection testing, extraction, task generation and verification share durable usage statistics',async t=>{
  const a=await setup(t,async(_p,_k,m)=>{
    const prompt=m[0].content;if(prompt.includes('Reply with'))return {ok:true};
    if(prompt.includes('从材料提取'))return {tasks:[],summary:'背景已记录'};
    if(prompt.includes('推进给定事项'))return {kind:'artifact',title:'正文',content:'周五发布'};
    return {passed:true,summary:'通过',gaps:[]};
  });
  await configured(a,{dailyCallLimit:4});await a.dispatch('testProvider',{id:a.data.providers[0].id});
  await a.dispatch('import',{items:[{title:'背景',content:'资料'}]});await a.dispatch('extract');await a.runPromise;
  const task=a.createTask({title:'报告'});await a.dispatch('advance',{id:task.id});await a.runPromise;
  assert.equal(task.status,'review');assert.equal(current(a).used,4);assert.equal(a.data.modelCalls.length,4);
  await a.dispatch('testProvider',{id:a.data.providers[0].id});
  assert.equal(current(a).used,5);assert.equal(a.data.modelCalls.length,5);
});
test('Concurrent requests preserve usage without applying obsolete count caps',async t=>{
  let calls=0;const a=await setup(t,async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {ok:true};});
  await configured(a,{dailyCallLimit:3});const results=await Promise.allSettled(Array.from({length:12},()=>request(a)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,12);assert.equal(calls,12);assert.equal(current(a).used,12);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.stewardshipBudget));
});


test('Legacy global count caps do not interrupt draft generation or verification',async t=>{
  let a;const chat=async(_p,_k,m)=>{
    const prompt=m[0].content;
    if(prompt.includes('动作格式')){
      const task=a.data.tasks[0];
      if(!task)return {tool:'plan_task',args:{key:'report',title:'报告',criteria:'给出日期',steps:[{key:'draft',title:'写报告',kind:'draft'}]}};
      if(task.status!=='completed')return {tool:'advance_task',args:{taskId:task.id}};
      return {tool:'complete',args:{summary:'已完成'}};
    }
    if(prompt.includes('推进给定事项'))return {kind:'artifact',title:'发布报告',content:'项目周五发布。'};
    return {passed:true,summary:'日期与目标一致',gaps:[]};
  };
  a=await setup(t,chat);await configured(a,{dailyCallLimit:3});
  await a.dispatch('agentCreate',{goal:'写报告',maxActions:12,maxCalls:40,autoAccept:true});await a.runPromise;
  const j=a.data.delegations[0],task=a.data.tasks[0];
  assert.equal(j.status,'completed');assert.equal(task.status,'completed');assert.equal(a.data.tasks.length,1);assert.equal(a.data.artifacts.length,1);assert.equal(current(a).used,5);
});




test('A new budget day wakes deferred work without refunding earlier dates',async t=>{
  const a=await setup(t);a.data.stewardship.timeZone='UTC';
  await at('2026-10-01T23:59:00Z',async()=>{await configured(a,{dailyCallLimit:1});await request(a);});
  const job=agent.buildJob(a,{goal:'明日继续'});job.status='retry';job.limitReason='workspace_daily';job.nextRunAt='2026-10-02T00:00:00Z';a.data.delegations.push(job);
  await at('2026-10-02T00:00:01Z',async()=>{assert.equal(current(a).used,0);assert.equal(stewardship.reconcile(a),true);assert.equal(job.status,'ready');await request(a);assert.equal(current(a).used,1);});
  await at('2026-10-01T23:59:10Z',async()=>{assert.equal(current(a).used,1);await request(a);});
});
test('Automatic pause does not change project permissions, manual pauses or model access',async t=>{
  const a=await setup(t);const ready=agent.buildJob(a,{goal:'继续',fileMode:'auto'}),paused=agent.buildJob(a,{goal:'暂停'});paused.status='paused';a.data.delegations.push(ready,paused);
  a.data.workRules.push({id:'r',status:'enabled',config:{dailyCalls:10},usage:{day:'2099',calls:0}});a.data.connectors.push({id:'c',enabled:true,sendPolicy:{mode:'auto'}});
  await a.dispatch('stewardshipPause');const before=JSON.stringify({jobs:a.data.delegations,rules:a.data.workRules,connectors:a.data.connectors});
  a.tick();assert.equal(a.operation,null);assert.equal(stewardship.canAutomate(a),false);await request(a);assert.equal(current(a).used,1);
  await a.dispatch('stewardshipResume');assert.equal(JSON.stringify({jobs:a.data.delegations,rules:a.data.workRules,connectors:a.data.connectors}),before);assert.equal(ready.fileMode,'auto');assert.equal(paused.status,'paused');
});
test('The running round completes when global pause is requested, then no new round starts',async t=>{
  let entered,finish;const started=new Promise(r=>entered=r),response=new Promise(r=>finish=r);
  const a=await setup(t,async()=>{entered();await response;return {tool:'ask',args:{question:'已经保留'}};});
  await a.dispatch('agentCreate',{goal:'一轮工作'});await started;await a.dispatch('stewardshipPause');finish();await a.runPromise;
  assert.equal(a.data.delegations[0].status,'needs_input');assert.equal(current(a).reason,'paused');assert.equal(a.data.agentRuns[0].status,'done');a.tick();assert.equal(a.operation,null);
});
test('Fixed-zone daytime windows include the start and exclude the end; manual calls remain available',async t=>{
  const a=gated(await setup(t),'Asia/Shanghai',{enabled:true,start:'09:00',end:'18:00'});
  assert.equal(stewardship.status(a,Date.parse('2026-10-01T01:00:00Z')).automaticAllowed,true);
  const off=stewardship.status(a,Date.parse('2026-10-01T10:00:00Z'));
  assert.equal(off.reason,'window');assert.equal(off.nextAllowedAt,'2026-10-02T01:00:00.000Z');
  await at('2026-10-01T10:00:00Z',async()=>{await request(a);assert.equal(current(a).used,1);a.tick();assert.equal(a.operation,null);});
});
test('Cross-midnight windows schedule the next actual opening and daily quota plus window agree',async t=>{
  const a=gated(await setup(t),'UTC',{enabled:true,start:'22:00',end:'06:00'});
  for(const time of ['2026-10-01T22:00:00Z','2026-10-02T05:59:00Z'])assert.equal(stewardship.status(a,Date.parse(time)).automaticAllowed,true);
  assert.equal(stewardship.status(a,Date.parse('2026-10-02T06:00:00Z')).nextAllowedAt,'2026-10-02T22:00:00.000Z');
  a.data.stewardship.dailyCallLimit=1;a.data.stewardship.usage.days['2026-10-01']=1;
  assert.equal(stewardship.status(a,Date.parse('2026-10-01T23:00:00Z')).automaticAllowed,true);
});
test('Daylight-saving gaps and repeated hours use real instants, never nonexistent local start times',async t=>{
  const a=gated(await setup(t),'America/New_York',{enabled:true,start:'02:30',end:'04:00'});
  assert.equal(stewardship.status(a,Date.parse('2026-03-08T06:59:00Z')).nextAllowedAt,'2026-03-08T07:00:00.000Z');
  a.data.stewardship.window={enabled:true,start:'01:15',end:'01:45'};
  assert.equal(stewardship.status(a,Date.parse('2026-11-01T05:30:00Z')).automaticAllowed,true);
  assert.equal(stewardship.status(a,Date.parse('2026-11-01T06:30:00Z')).automaticAllowed,true);
});
test('Restoring an older backup keeps the newest global configuration and all spent calls',async t=>{
  const a=await setup(t);await configured(a,{dailyCallLimit:10});const backup=recovery.create(a);
  await request(a);await request(a);await configured(a,{dailyCallLimit:2,window:{enabled:true,start:'10:00',end:'15:00'}});await a.dispatch('stewardshipPause');
  await a.dispatch('backupRestore',{id:backup});assert.equal(current(a).used,2);assert.equal(current(a).limit,0);assert.equal(a.data.stewardship.paused,true);assert.equal(a.data.stewardship.window.start,'10:00');
  await request(a);
});
test('Ledger survives damaged or missing workspaces and overrides old snapshot usage',async t=>{
  const a=await setup(t);await configured(a,{dailyCallLimit:2});recovery.create(a);await request(a);await request(a);await a.dispatch('stewardshipPause');
  fs.writeFileSync(a.file,'damaged');const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(b).used,2);assert.equal(b.data.stewardship.paused,true);
  await request(b);fs.unlinkSync(b.file);const c=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(c).used,3);
});
test('The durable reservation wins after a crash between ledger and workspace writes',async t=>{
  const a=await setup(t);await configured(a,{dailyCallLimit:1});stewardship.reserve(a);
  const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(b).used,1);await request(b);
});
test('Damaged or unwritable ledgers stop before model invocation and keep original bytes',async t=>{
  let calls=0;const a=await setup(t,async()=>{calls++;return {ok:true};});const file=path.join(a.dir,'stewardship-ledger.json');fs.writeFileSync(file,'DAMAGED');
  const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(b).reason,'meter');await assert.rejects(request(b),e=>e.stewardshipMeter&&!e.modelFailure);assert.equal(fs.readFileSync(file,'utf8'),'DAMAGED');assert.equal(calls,0);
  const c=await setup(t,async()=>{calls++;return {ok:true};});fs.mkdirSync(path.join(c.dir,'stewardship-ledger.json.tmp'));
  const job=agent.buildJob(c,{goal:'账本写入失败'});c.data.delegations.push(job);c.activeAgentJob=job;
  await assert.rejects(request(c),e=>e.stewardshipMeter);assert.equal(current(c).used,0);assert.equal(calls,0);assert.equal(job.callsUsed,0);
});
test('Upgrade seeds retained calls for today once and does not infer prior-day calls',async t=>{
  const a=await setup(t),today=new Date().toISOString();a.data.modelCalls=[{id:'a',at:today,status:'done'},{id:'b',at:today,status:'error'},{id:'c',at:'2001-01-01T00:00:00Z',status:'done'}];delete a.data.stewardship;a.save();fs.unlinkSync(path.join(a.dir,'stewardship-ledger.json'));
  const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(b).used,2);const c=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(c).used,2);assert.ok(c.data.stewardship.meteringStartedAt);
});
test('Changing system time zone or sending unrecognized setting fields cannot change the saved zone',async t=>{
  const a=await setup(t),zone=a.data.stewardship.timeZone;await configured(a,{timeZone:'Pacific/Honolulu',usage:{days:{}},dailyCallLimit:2});
  assert.equal(a.data.stewardship.timeZone,zone);await request(a);
  const old=process.env.TZ;try{process.env.TZ=zone==='UTC'?'Asia/Shanghai':'UTC';const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(b.data.stewardship.timeZone,zone);assert.equal(current(b).used,1);}finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});
test('Invalid policies are rejected atomically without silently converting empty or fractional limits',async t=>{
  const a=await setup(t);const before=JSON.stringify(a.data.stewardship);
  for(const dailyCallLimit of [-1,1.5,'4',null,100001])await assert.rejects(configured(a,{dailyCallLimit}),/每日调用上限/);
  for(const window of [{enabled:true,start:'25:00'},{enabled:'yes'},{start:'09:00',end:'09:00'}])await assert.rejects(configured(a,{dailyCallLimit:4,window}));
  assert.equal(JSON.stringify(a.data.stewardship),before);
});
test('Isolated evaluation helpers share the parent allowance and parent telemetry exactly once',async t=>{
  let calls=0;const parent=await setup(t,async(_p,_k,_m,o)=>{calls++;o.onUsage?.({inputTokens:12,outputTokens:3});return {ok:true};});await configured(parent,{dailyCallLimit:2});
  const child=await setup(t,parent.chat,{modelBudgetOwner:parent});const job=agent.buildJob(child,{goal:'验收'});child.data.delegations.push(job);child.activeAgentJob=job;
  await request(child);await request(child);await request(child);
  assert.equal(calls,3);assert.equal(job.callsUsed,3);assert.equal(current(parent).used,3);assert.equal(parent.data.modelCalls.length,3);assert.equal(child.data.modelCalls.length,3);
  assert.ok(parent.data.modelCalls.every(r=>r.stage==='evaluation'&&r.inputTokens===12));
});


test('A malformed workspace policy is repaired from a valid meter without bypassing the budget',async t=>{
  const a=await setup(t);await configured(a,{dailyCallLimit:1});await request(a);
  a.data.stewardship={timeZone:'not/a/zone'};a.save();const b=new Assistant({dir:a.dir,chat:a.chat});
  assert.equal(current(b).used,1);assert.equal(current(b).limit,0);assert.equal(b.stewardshipError,undefined);await request(b);
});
test('Backup restore pauses automatic folder collection across restart until explicit global resume',async t=>{
  const a=await setup(t),folder=path.join(a.dir,'materials');fs.mkdirSync(folder);a.data.folders.push({id:'materials',name:'资料',path:fs.realpathSync(folder)});
  const backup=recovery.create(a);fs.writeFileSync(path.join(folder,'new.md'),'恢复后不应自动读取');
  await a.dispatch('backupRestore',{id:backup});assert.equal(stewardship.canAutomate(a),false);assert.equal(a.data.stewardship.paused,true);
  const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(stewardship.canAutomate(b),false);assert.equal(b.data.sources.length,0);
  assert.equal(b.data.folders[0].path,fs.realpathSync(folder));await b.dispatch('stewardshipResume');assert.equal(stewardship.canAutomate(b),true);
  await require('../desktop/folders.cjs').syncAllFolders(b);assert.equal(b.data.sources.length,1);
  const c=new Assistant({dir:a.dir,chat:a.chat});assert.equal(c.data.stewardship.paused,false);
});
test('Automatic damage recovery pauses collection even when the newest ledger was running',async t=>{
  const a=await setup(t);recovery.create(a);await request(a);fs.writeFileSync(a.file,'broken');
  const b=new Assistant({dir:a.dir,chat:a.chat});assert.equal(current(b).used,1);assert.equal(stewardship.canAutomate(b),false);
  const c=new Assistant({dir:a.dir,chat:a.chat});assert.equal(c.data.stewardship.paused,true);assert.equal(current(c).used,1);
});
