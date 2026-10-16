const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const deadline=require('../desktop/deadline-state.cjs');
const events=require('../desktop/deadline-events.cjs');
const attention=require('../desktop/attention.cjs');
const badges=require('../desktop/pending-badges.cjs');
const followup=require('../desktop/agent-followup.cjs');
const journal=require('../desktop/work-journal.cjs');
const NOW=Date.parse('2026-10-15T12:00:00Z'),at=minutes=>new Date(NOW+minutes*60000).toISOString();
function fixture(t,{minutes=30,status='todo',jobStatus='ready',steps=[{id:'s',kind:'draft',done:false}],durable=false}={}) {
  t.mock.method(Date,'now',()=>NOW);
  const task={id:'t',title:'截止事项',status,workRevision:1,priority:'low',dueAt:at(minutes),steps,sourceIds:[],agentJobId:'j',projectId:'p'};
  const job={id:'j',projectId:'p',title:'委托',status:jobStatus,workRevision:1,taskIds:['t'],sourceIds:[],followups:[],history:[]};
  const a={saveCount:0,data:{tasks:[task],delegations:[job],projects:[{id:'p',name:'项目'}],agentActions:[],decisions:[],sources:[],artifacts:[],attentionRecords:[]},save(){this.saveCount++;attention.sync(this);if(this.file)fs.writeFileSync(this.file,JSON.stringify(this.data));},task(id){return this.data.tasks.find(t=>t.id===id);},chat(){throw Error('no model');},request(){throw Error('no network');}};
  if(durable){a.dir=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-protocol-v3-'));a.file=path.join(a.dir,'workspace.json');t.after(()=>fs.rmSync(a.dir,{recursive:true,force:true}));journal.initialize(a,{migrate:true});events.connectJournal(a);}
  return {a,task,job};
}
const v=a=>events.view({...a.data,deadlineState:events.state(a)},a.data.tasks[0],NOW);
const wake=a=>Object.values(events.state(a).wakeIntents).find(w=>w.status!=='cancelled');
function act(a,action,extra={}){return events.act(a,{taskId:'t',eventId:v(a).event.id,action,now:NOW,...extra});}
function claim(a,extra={}){return events.claim(a,wake(a).id,{epoch:'one',gate:{allowed:true},hasNextStep:true,now:NOW,...extra});}
const op=w=>({id:w.operationId,taskId:w.taskId,workRevision:w.workRevision,status:'running'});
function freeze(obj){if(obj&&typeof obj==='object'){Object.freeze(obj);Object.values(obj).forEach(freeze);}return obj;}

test('One evaluator supplies exact boundaries; legacy never gains an hour reminder',t=>{
  const {task}=fixture(t,{minutes:1500});assert.equal(deadline.evaluate(task,NOW).stage,'scheduled');assert.equal(deadline.evaluate(task,NOW).nextBoundary,at(60));
  assert.equal(deadline.evaluate(task,NOW+60*60000).stage,'soon');assert.equal(deadline.evaluate(task,NOW+1440*60000).stage,'soon');assert.equal(deadline.evaluate(task,NOW+1500*60000).stage,'overdue');
  deadline.updatePolicy(task,{dueAt:at(1500)});assert.equal(deadline.evaluate(task,NOW+1440*60000).stage,'imminent');
  assert.equal(deadline.evaluate(task,NOW+1440*60000).nextBoundary,at(1500));
});
test('No deadline stays empty; date-only never becomes midnight, imminent or overdue',t=>{
  const {a,task}=fixture(t);task.dueAt=null;assert.equal(deadline.evaluate(task,NOW).stage,'none');
  deadline.updatePolicy(task,{precision:'date',localDate:'2026-10-14',timeZone:'Asia/Shanghai',requireTime:true});
  assert.equal(task.dueAt,null);assert.equal(deadline.evaluate(task,NOW).stage,'scheduled');assert.equal(deadline.evaluate(task,NOW).nextBoundary,null);
  assert.equal(events.pendingNotifications(a).count,0);assert.equal(badges.count(a.data),1);assert.match(attention.snapshot(a).items[0].detail,/具体时间待确认/);
  deadline.updatePolicy(task,{keepDateOnly:true});assert.equal(badges.count(a.data),0);
});
test('Invalid wall times reject before mutation; explicit DST offsets select either repeated time',t=>{
  const {task}=fixture(t);const before=JSON.stringify(task);
  for(const input of [{precision:'date',localDate:'2026-02-30',timeZone:'Asia/Shanghai'},{dueAt:'2026-10-15'},{dueAt:'2026-03-08T02:30:00-05:00',timeZone:'America/New_York'}]){assert.throws(()=>deadline.updatePolicy(task,input));assert.equal(JSON.stringify(task),before);}
  deadline.updatePolicy(task,{dueAt:'2026-11-01T01:30:00-04:00',timeZone:'America/New_York'});assert.equal(task.dueAt,'2026-11-01T05:30:00.000Z');
  deadline.updatePolicy(task,{dueAt:'2026-11-01T01:30:00-05:00',timeZone:'America/New_York'});assert.equal(task.dueAt,'2026-11-01T06:30:00.000Z');
  const instant=task.dueAt;deadline.updatePolicy(task,{timeZone:'Asia/Shanghai'});assert.equal(task.dueAt,instant);
});
test('Policy is semantic and monotonic: duplicate does nothing, A -> B -> A cancels old obligations',t=>{
  const {a,task}=fixture(t,{durable:true});events.setPolicy(a,{taskId:'t',input:{dueAt:at(30)},now:NOW});events.reconcile(a,{now:NOW});const first=v(a).event.id,revision=task.deadlinePolicy.deadlineRevision;
  events.setPolicy(a,{taskId:'t',input:{dueAt:at(30),remindBeforeMinutes:[60,1440,60]},now:NOW});assert.equal(task.deadlinePolicy.deadlineRevision,revision);assert.equal(v(a).event.id,first);
  events.setPolicy(a,{taskId:'t',input:{dueAt:at(45)},now:NOW});events.setPolicy(a,{taskId:'t',input:{dueAt:at(30)},now:NOW});assert.equal(task.deadlinePolicy.deadlineRevision,revision+2);assert.notEqual(v(a).event.id,first);assert.equal(events.state(a).events[first].status,'cancelled');
});
test('Snapshots remain pure and polling changes no identity, state or priority',t=>{
  const {a,task}=fixture(t);events.reconcile(a,{now:NOW});const id=v(a).event.id,saved=a.saveCount;
  task.updatedAt=at(1);a.data.delegations[0].nextRunAt=at(1);events.reconcile(a,{now:NOW+15000});assert.equal(v(a).event.id,id);assert.equal(a.saveCount,saved);assert.equal(task.priority,'low');
  const before=JSON.stringify(a.data);freeze(a.data);attention.snapshot(a);events.pendingNotifications(a);events.nextBoundary(a.data,NOW);badges.counts(a.data);assert.equal(JSON.stringify(a.data),before);
});
test('Blocked and paused work keep reminders and original status; neither can be claimed',t=>{
  for(const status of ['blocked','needs_input','limited','approval','paused']){
    const {a,task,job}=fixture(t,{jobStatus:status,durable:true});followup.deadlines(a,job,{now:NOW});assert.equal(events.pendingNotifications(a).count,1);assert.equal(task.priority,'low');assert.equal(job.status,status);
    assert.equal(claim(a,{operationId:'existing'}),null);assert.equal(wake(a).status,'pending');
    if(status==='paused')assert.ok(attention.snapshot(a).items.find(c=>c.category==='deadline').pauseReason);
  }
});
test('Global execution gate leaves an obligation pending; reminder still submits',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});assert.equal(claim(a,{gate:{allowed:false,reason:'global_pause'}}),null);assert.equal(wake(a).retryCondition,'global_pause');
  const attempts=events.beginNotifications(a,events.pendingNotifications(a).items,{epoch:'one',now:NOW});events.finishNotifications(a,attempts,{now:NOW});assert.equal(wake(a).status,'pending');assert.ok(claim(a));
});
test('Terminal tasks and terminal jobs cancel both events and future wake obligations',t=>{
  for(const status of ['completed','deleted','cancelled','canceled'])for(const owner of ['task','job']){
    const {a,task,job}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});const w=claim(a);(owner==='task'?task:job).status=status;events.reconcile(a,{now:NOW});
    assert.equal(events.state(a).wakeIntents[w.id].status,'cancelled');assert.equal(events.pendingNotifications(a).count,0);assert.equal(events.nextBoundary(a.data,NOW),null);assert.equal(attention.snapshot(a).items.filter(c=>c.category==='deadline').length,0);
  }
});
test('DeletedAt and cancelled agents are terminal without rewriting a status',t=>{
  for(const patch of [{deletedAt:at(0)},{agentCancelled:true}]){const {a,task}=fixture(t);Object.assign(task,patch);assert.equal(events.pendingNotifications(a).count,0);assert.equal(deadline.evaluate(task,NOW).stage,'resolved');}
});
test('Read and snooze never solve the overdue decision; acknowledgement closes only its risk',t=>{
  const {a,task}=fixture(t,{minutes:-1,steps:[]});events.reconcile(a,{now:NOW});assert.equal(badges.count(a.data),1);
  act(a,'read');assert.equal(badges.count(a.data),1);assert.equal(wake(a).status,'pending');assert.equal(events.pendingNotifications(a).count,0);
  act(a,'snooze',{minutes:30});assert.equal(badges.count(a.data),1);act(a,'acknowledge');assert.equal(badges.count(a.data),0);assert.equal(task.status,'todo');
  task.updatedAt=at(1);task.status='ready';events.reconcile(a,{now:NOW+15000});assert.equal(badges.count(a.data),0);
  task.requirementRevision=2;assert.equal(badges.count(a.data),1);
});
test('Review and multiple independent business nodes retain their identities; risk is an annotation',t=>{
  const {a,task,job}=fixture(t,{minutes:-1,jobStatus:'review',status:'review',steps:[]});assert.deepEqual(badges.counts(a.data),{total:1,progress:0,review:1});
  job.status='needs_input';task.status='waiting';
  a.data.decisions=[{id:'permission',jobId:'j',taskIds:['t'],sourceIds:[],kind:'permission',status:'open',question:'授权'},{id:'budget',jobId:'j',taskIds:['t'],sourceIds:[],kind:'question',status:'open',question:'额度'}];
  const nodes=badges.cards(a.data);assert.equal(nodes.length,2);assert.ok(nodes.every(c=>c.deadlineRisks.length===1));
  act(a,'acknowledge');assert.equal(badges.count(a.data),2);assert.ok(a.data.decisions.every(d=>d.status==='open'));
});
test('Snooze gets a new notification generation, shares wake, and urgent stage bypasses the snooze',t=>{
  const {a,task}=fixture(t,{minutes:90});deadline.updatePolicy(task,{dueAt:at(90)});events.reconcile(a,{now:NOW});const old=v(a),oldWake=wake(a).id;
  act(a,'snooze',{minutes:120});assert.notEqual(v(a).event.id,old.event.id);assert.equal(wake(a).id,oldWake);assert.equal(events.pendingNotifications(a,{now:NOW+29*60000}).count,0);
  events.reconcile(a,{now:NOW+30*60000});assert.equal(events.pendingNotifications(a,{now:NOW+30*60000}).count,1);assert.equal(wake(a).stage,'imminent');assert.equal(events.state(a).wakeIntents[oldWake].status,'cancelled');
});
test('A sleep spanning all thresholds creates only the current most urgent stage',t=>{
  const {a,task}=fixture(t,{minutes:1500});deadline.updatePolicy(task,{dueAt:at(1500)});events.reconcile(a,{now:NOW});assert.equal(Object.keys(events.state(a).events).length,0);
  events.reconcile(a,{now:NOW+2000*60000});assert.deepEqual(Object.values(events.state(a).events).map(e=>e.stage),['overdue']);
});
test('Archived projects suppress pushes, then restore only the current stage',t=>{
  const {a}=fixture(t);a.data.projects[0].archivedAt=at(0);events.reconcile(a,{now:NOW});assert.equal(events.pendingNotifications(a).count,0);
  delete a.data.projects[0].archivedAt;events.reconcile(a,{now:NOW+60*60000});assert.equal(events.pendingNotifications(a,{now:NOW+60*60000}).count,1);assert.equal(wake(a).stage,'overdue');
});
test('Legacy notices remain deduplicated through migration without adding an hour stage',t=>{
  const {a,task,job}=fixture(t);job.deadlineNotices=[`t:${task.dueAt}:soon`];deadline.migrate(task);events.reconcile(a,{now:NOW});assert.equal(v(a).stage,'soon');assert.equal(events.pendingNotifications(a).count,0);assert.equal(attention.snapshot(a).items.filter(c=>c.category==='deadline').length,1);
});
test('Legacy read/notified card is adopted without inventing a new notification',t=>{
  const {a,task}=fixture(t);const crypto=require('node:crypto'),hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const revision=hash(['deadline:t','deadline','warning',task.title,'事项将在 24 小时内到期。','p',[task.dueAt,task.status,task.priority],{paused:false,deadlineAt:task.dueAt}]);
  a.data.attentionRecords=[{id:'deadline:t',revision,readAt:at(-1),notifiedKey:hash([revision,null])}];deadline.migrate(task);events.reconcile(a,{now:NOW});assert.equal(v(a).state,'read');assert.equal(events.pendingNotifications(a).count,0);
});
test('Claimed-before-enqueue failure releases to the same stable operation identity',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});const first=claim(a);
  events.release(a,first.id,{epoch:'one',lookupOperation:()=>null,now:NOW});assert.equal(wake(a).status,'pending');const second=claim(a,{operationId:'must-not-replace'});assert.equal(first.operationId,second.operationId);
});
test('Restart recovers claimed without operation to pending, with operation to attached',t=>{
  for(const exists of [false,true]){const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});const first=claim(a);
    events.recover(a,{epoch:'two',lookupOperation:()=>exists?op(first):null,now:NOW});assert.equal(wake(a).status,exists?'attached':'pending');assert.equal(wake(a).operationId,first.operationId);
  }
});
test('Attach is idempotent; uncertain execution stays with its original operation',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});const w=claim(a),operation=op(w);
  assert.throws(()=>events.attach(a,w.id,{epoch:'one',operationId:w.operationId,lookupOperation:()=>({...operation,workRevision:2}),now:NOW}),/工作修订/);
  events.attach(a,w.id,{epoch:'one',operationId:w.operationId,lookupOperation:()=>operation,now:NOW});const saves=a.saveCount;
  events.attach(a,w.id,{epoch:'one',operationId:w.operationId,lookupOperation:()=>operation,now:NOW});assert.equal(a.saveCount,saves);
  operation.status='uncertain';events.recover(a,{epoch:'two',lookupOperation:()=>operation,now:NOW});assert.equal(wake(a).status,'attached');assert.equal(claim(a),null);
});
test('An existing operation adopts the wake; no second execution is launched',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});a.operation={taskId:'t'};assert.equal(claim(a),null);assert.equal(wake(a).retryCondition,'execution_in_flight');
  const w=claim(a,{operationId:'existing',lookupOperation:()=>({id:'existing',taskId:'t',workRevision:1})});events.attach(a,w.id,{epoch:'one',operationId:'existing',lookupOperation:()=>op(w),now:NOW});assert.equal(wake(a).operationId,'existing');
});
test('Waiting only permits an authorized, already-due source check',t=>{
  const {a}=fixture(t,{durable:true,status:'waiting'});events.reconcile(a,{now:NOW});assert.equal(claim(a),null);
  assert.equal(claim(a,{nextStep:{kind:'source_check',authorized:true,dueAt:at(1)}}),null);
  assert.equal(claim(a,{nextStep:{kind:'source_check',authorized:false,dueAt:at(-1)}}),null);
  assert.ok(claim(a,{nextStep:{kind:'source_check',authorized:true,dueAt:at(-1)}}));
});
test('Notification prepared before crash becomes uncertain and is not repeatedly submitted',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});const p=events.pendingNotifications(a).items;
  const attempts=events.beginNotifications(a,p,{epoch:'one',now:NOW});assert.equal(attempts.length,1);assert.equal(events.pendingNotifications(a).count,0);
  events.recover(a,{epoch:'two',lookupOperation:()=>null,now:NOW});assert.equal(events.state(a).notificationAttempts[p[0].eventId].status,'uncertain');assert.equal(wake(a).status,'pending');assert.equal(v(a).state,'unread');
});
test('Submission failure retains an unread in-app card and no notification poll storm',t=>{
  const {a}=fixture(t);const p=events.pendingNotifications(a).items,attempts=events.beginNotifications(a,p,{epoch:'one',now:NOW});events.finishNotifications(a,attempts,{status:'failed',now:NOW});
  assert.equal(v(a).state,'unread');assert.equal(events.pendingNotifications(a).count,0);assert.equal(wake(a).status,'pending');assert.equal(attention.snapshot(a).items.filter(c=>c.category==='deadline').length,1);
});
test('Reopening gets a new work identity and inherits neither read nor acknowledgement',t=>{
  const {a,task}=fixture(t,{minutes:-1,steps:[],durable:true});events.reconcile(a,{now:NOW});act(a,'read');act(a,'acknowledge');const first=v(a).event.id;
  journal.commit(a,[{entityKind:'task',entityId:'t',type:'reopened',workRevision:2}]);events.reconcile(a,{now:NOW});assert.equal(task.workRevision,2);assert.notEqual(v(a).event.id,first);assert.equal(v(a).state,'unread');assert.equal(v(a).acknowledged,false);assert.equal(badges.count(a.data),1);
});
test('Old workspace backup cannot overwrite journaled policy, read, acknowledgement or attached wake',t=>{
  const {a}=fixture(t,{durable:true});const backup=structuredClone(a.data);
  events.setPolicy(a,{taskId:'t',input:{dueAt:at(-1)},now:NOW});act(a,'read');act(a,'acknowledge');const w=claim(a);events.attach(a,w.id,{epoch:'one',operationId:w.operationId,lookupOperation:()=>op(w),now:NOW});
  a.data=backup;journal.replay(a,{force:true,save:false});events.project(a);
  assert.equal(a.data.tasks[0].dueAt,at(-1));assert.equal(v(a).state,'read');assert.equal(v(a).acknowledged,true);assert.equal(wake(a).status,'attached');
});
test('Journal commit survives workspace projection failure; retry replays instead of duplicating',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});const save=a.save;a.save=()=>{throw Error('disk full');};
  assert.throws(()=>act(a,'read'),e=>e.committed===true&&e.projectionPending===true);assert.equal(v(a).state,'read');assert.ok(a.data.tasks[0].projectionPending);
  a.save=save;journal.replay(a,{force:true});events.project(a);const before=journal.read(a).events.length;act(a,'read');assert.equal(journal.read(a).events.length,before);assert.equal(v(a).state,'read');
});
test('Precommit failure leaves all state unchanged; wake requires durable journal',t=>{
  const {a}=fixture(t);events.reconcile(a,{now:NOW});assert.throws(()=>claim(a),/独立工作记录/);const before=JSON.stringify(a.data);
  events.configure(a,{read:()=>a.data.deadlineState,commit(){throw Error('cannot fsync');}});assert.throws(()=>act(a,'read'),/cannot fsync/);assert.equal(JSON.stringify(a.data),before);
});
test('Attention IPC separates read and acknowledgement, and rejects stale event buttons',t=>{
  const {a,task}=fixture(t,{minutes:-1,steps:[]});const card=attention.snapshot(a).items.find(c=>c.category==='deadline');
  attention.dispatch(a,'attentionRead',{id:card.id,revision:card.revision});assert.equal(badges.count(a.data),1);
  attention.dispatch(a,'attentionAcknowledgeDeadline',{id:card.id,revision:card.revision,riskKey:card.riskKey});assert.equal(badges.count(a.data),0);
  deadline.updatePolicy(task,{dueAt:at(60)});assert.throws(()=>attention.dispatch(a,'attentionRead',{id:card.id,revision:card.revision}),/已变化/);
});

test('Startup attention normalization preserves a valid legacy read until durable reconciliation',t=>{
  const {a,task}=fixture(t);const crypto=require('node:crypto'),hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const revision=hash(['deadline:t','deadline','warning',task.title,'事项将在 24 小时内到期。','p',[task.dueAt,task.status,task.priority],{paused:false,deadlineAt:task.dueAt}]);
  a.data.attentionRecords=[{id:'deadline:t',revision,readAt:at(-1)}];deadline.migrate(task);attention.initialize(a);
  assert.equal(a.data.attentionRecords.length,1);events.reconcile(a,{now:NOW});assert.equal(v(a).state,'read');assert.equal(a.data.attentionRecords.length,0);
});
test('Execution proxy shares its root durable adapter and cannot bypass paused gates',t=>{
  const {a,task}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});const proxy=new Proxy(a,{get(target,key){return key==='executionOwner'?target:Reflect.get(target,key);}});
  task.status='paused';assert.equal(claim(proxy),null);task.status='todo';assert.ok(claim(proxy));
});
test('A closed event never reopens without a new work revision',t=>{
  const {a,task}=fixture(t);events.reconcile(a,{now:NOW});task.status='completed';events.reconcile(a,{now:NOW});task.status='todo';events.reconcile(a,{now:NOW});
  assert.equal(events.pendingNotifications(a).count,0);assert.ok(Object.values(events.state(a).wakeIntents).every(w=>w.status==='cancelled'));
  task.workRevision=2;events.reconcile(a,{now:NOW});assert.equal(events.pendingNotifications(a).count,1);
});
test('Repeated closed-gate checks do not create a stream of journal events',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});claim(a,{gate:{allowed:false,reason:'global_pause'}});const before=journal.read(a).events.length;
  events.reconcile(a,{now:NOW+15000});claim(a,{gate:{allowed:false,reason:'global_pause'}});assert.equal(journal.read(a).events.length,before);
});

test('Hard removal after reopening cancels persisted obligations without recreating a task',t=>{
  const {a}=fixture(t,{durable:true});events.reconcile(a,{now:NOW});journal.commit(a,[{entityKind:'task',entityId:'t',type:'reopened',workRevision:2}]);events.reconcile(a,{now:NOW});a.data.tasks=[];
  events.reconcile(a,{now:NOW});assert.ok(Object.values(events.state(a).wakeIntents).every(w=>w.status==='cancelled'));assert.equal(a.data.tasks.length,0);
});
test('Scope gaps do not leak standalone deadline notifications outside the attention projection',t=>{
  const {a,task,job}=fixture(t);job.projectId=null;assert.equal(events.pendingNotifications(a).count,0);assert.equal(events.nextBoundary(a.data,NOW),null);
  task.agentJobId='missing';assert.equal(events.pendingNotifications(a).count,0);
});

test('Delivery preparation and remaining verification do not invent a human deadline decision',t=>{
  const {a,task}=fixture(t,{minutes:-1,steps:[{kind:'external',tool:'write_file',done:false}]});assert.equal(badges.count(a.data),0);
  task.steps[0].done=true;assert.equal(badges.count(a.data),0);task.verification={passed:true};assert.equal(badges.count(a.data),1);
  task.steps[0]={kind:'manual',done:false};assert.equal(badges.count(a.data),1);
});

// Production integration: real Assistant, IPC, fsynced journal and execution
// queue; only model/network/native notification boundaries are substituted.
const scheduler=require('../desktop/deadline-scheduler.cjs');
async function production(t,{job=true,dueMinutes=30,status='todo'}={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'deadline-production-'))),instances=[];
  t.after(()=>{for(const a of instances){scheduler.dispose(a);a.streamController?.dispose();}fs.rmSync(dir,{recursive:true,force:true});});
  const calls=[],forbidden=async()=>{throw Error('No external request allowed');};
  const create=()=>{const a=new(require('../desktop/core.cjs').Assistant)({dir,agentRequest:forbidden,webRequest:forbidden,feedRequest:forbidden,connectorRequest:forbidden,chat:async(_p,_k,m)=>{calls.push(m[0].content);if(m[0].content.includes('推进给定事项'))return {kind:'artifact',title:'隔离产出',content:'已完成当前要求。'};if(m[0].content.includes('动作格式'))return {tool:'ask',args:{question:'请确认下一步'}};return {passed:true,summary:'已检查',gaps:[]};}});instances.push(a);return a;};
  const a=create();await a.dispatch('saveProvider',{name:'isolated',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
  let j=null;if(job){j=require('../desktop/agent.cjs').buildJob(a,{goal:'隔离截止委托',fileMode:'off',allowWeb:false,maxActions:1,autoAccept:false});a.data.delegations.push(j);}
  const task=a.createTask({title:'截止工作',criteria:'完成当前要求',priority:'low',dueAt:new Date(Date.now()+dueMinutes*60000).toISOString(),steps:[{title:'起草结果',kind:'draft'}]});
  task.status=status;if(j){task.agentJobId=j.id;j.taskIds.push(task.id);j.nextRunAt=new Date(Date.now()+86400000).toISOString();}
  scheduler.reconcile(a);a.save();return {a,task,job:j,calls,reload:create};
}
const liveWake=(a,id)=>Object.values(events.state(a).wakeIntents).find(w=>w.taskId===id&&w.status!=='cancelled');
test('Production IPC shares deadline nodes with badges; read/snooze/ack preserve business and revision',async t=>{
  const {a,task}=await production(t,{job:false,dueMinutes:-1});task.steps=[];a.save();
  let card=a.publicState().decisionCards.find(c=>c.kind==='deadline');assert.ok(card);assert.equal(badges.count(a.data),a.publicState().decisionCards.length);
  const input=()=>({id:`deadline:${task.id}`,revision:events.view(a.data,task).event.id});
  const work=task.workRevision,policy=task.deadlinePolicy.deadlineRevision;
  await a.dispatch('attentionRead',input());assert.equal(badges.count(a.data),1);
  await a.dispatch('attentionSnooze',{...input(),minutes:30});assert.equal(badges.count(a.data),1);
  card=a.publicState().decisionCards.find(c=>c.kind==='deadline');await a.dispatch('attentionAcknowledgeDeadline',{...input(),riskKey:card.deadlineRisks[0].riskKey});
  assert.equal(badges.count(a.data),0);assert.equal(task.status,'todo');assert.equal(task.priority,'low');assert.equal(task.workRevision,work);assert.equal(task.deadlinePolicy.deadlineRevision,policy);assert.equal(liveWake(a,task.id).status,'pending');
  const dueAt=task.dueAt;await a.dispatch('updateTask',{id:task.id,dueAt:new Date(Date.parse(dueAt)+60000).toISOString(),expectedDeadlineRevision:policy});await a.dispatch('updateTask',{id:task.id,dueAt});
  assert.equal(task.deadlinePolicy.deadlineRevision,policy+2);assert.equal(badges.count(a.data),1);
  await assert.rejects(a.dispatch('updateTask',{id:task.id,dueAt,expectedDeadlineRevision:policy}),/变化/);
});
test('Production date-only creation and keep-date command never create an instant or notification',async t=>{
  const {a}=await production(t,{job:false});await a.dispatch('createTask',{title:'仅日期',deadlinePolicy:{precision:'date',localDate:'2026-11-01',timeZone:'America/New_York',requireTime:true}});
  const task=a.data.tasks[0],rev=task.deadlinePolicy.deadlineRevision;assert.equal(task.dueAt,null);assert.ok(a.publicState().decisionCards.some(c=>c.taskId===task.id&&c.kind==='deadline_time'));
  await a.dispatch('updateTask',{id:task.id,deadlinePolicy:{keepDateOnly:true},expectedDeadlineRevision:rev});assert.equal(task.dueAt,null);assert.ok(!a.publicState().decisionCards.some(c=>c.taskId===task.id));
  const before=JSON.stringify(task);await assert.rejects(a.dispatch('updateTask',{id:task.id,deadlinePolicy:{dueAt:'2026-03-08T02:30:00-05:00'}}));assert.equal(JSON.stringify(task),before);
  assert.ok(!events.pendingNotifications(a).items.some(i=>i.id===`deadline:${task.id}`));
});
test('Production core tick persists reminders during global pause and commits before OS submission',async t=>{
  const {a,task,calls,reload}=await production(t,{job:false});await a.dispatch('stewardshipPause');a.tick();
  assert.equal(calls.length,0);assert.equal(liveWake(a,task.id).status,'pending');let shown=0;
  class Notification {static isSupported(){return true;}on(){}show(){shown++;assert.equal(Object.values(journal.read(a).events.findLast(e=>e.type==='deadline_protocol').payload.state.notificationAttempts)[0].status,'prepared');}}
  assert.equal(scheduler.notify(a,{Notification}).status,'submitted');assert.equal(shown,1);scheduler.notify(a,{Notification});assert.equal(shown,1);
  scheduler.dispose(a);const restored=reload();scheduler.notify(restored,{Notification});assert.equal(shown,1);assert.equal(liveWake(restored,task.id).status,'pending');assert.ok(attention.snapshot(restored).items.some(c=>c.id===`deadline:${task.id}`));
});
test('Production notification failure and crash after prepare remain visible and never repeatedly submit',async t=>{
  const {a,task,reload}=await production(t,{job:false});let shown=0;class Notification {static isSupported(){return true;}on(){}show(){shown++;throw Error('OS unavailable');}}
  assert.equal(scheduler.notify(a,{Notification}).status,'uncertain');scheduler.notify(a,{Notification});assert.equal(shown,1);
  await a.dispatch('updateTask',{id:task.id,dueAt:new Date(Date.now()+40*60000).toISOString()});events.beginNotifications(a,events.pendingNotifications(a).items,{epoch:scheduler.epoch(a)});
  scheduler.dispose(a);const restored=reload();assert.ok(Object.values(events.state(restored).notificationAttempts).every(n=>n.status==='uncertain'));scheduler.notify(restored,{Notification});assert.equal(shown,1);assert.equal(attention.snapshot(restored).items.find(c=>c.id===`deadline:${task.id}`).state,'unread');
});
test('Production core tick launches actual Agent with a durable identity even before nextRunAt',async t=>{
  const {a,task,job,calls}=await production(t);const id=liveWake(a,task.id).operationId;a.tick();assert.ok(a.runPromise);await a.runPromise;
  assert.ok(calls.length>0);const record=scheduler.records(a)[id];assert.ok(record);assert.equal(record.status,'finished');assert.equal(record.tasks[0].id,task.id);assert.equal(record.runId,a.data.agentRuns[0].id);assert.equal(a.data.agentRuns[0].id,id);assert.equal(task.priority,'low');
  const count=a.data.agentRuns.length;scheduler.reconcile(a);scheduler.tick(a);await a.runPromise;assert.equal(a.data.agentRuns.length,count);assert.ok(!scheduler.pending(a,job).length);
});
test('Production independent task uses the same durable deadline handoff',async t=>{
  const {a,task,calls}=await production(t,{job:false});a.data.settings.automatic=true;const id=liveWake(a,task.id).operationId;a.tick();await a.runPromise;
  assert.ok(calls.length>0);assert.equal(scheduler.records(a)[id].status,'finished');assert.equal(task.priority,'low');assert.ok(!['pending','claimed'].includes(events.state(a).wakeIntents[`wake:${events.view(a.data,task).stageKey}`]?.status));
});
test('Production synchronous launch failure releases claim and retry reuses the returned operation ID',async t=>{
  const {a,task,job}=await production(t);const id=liveWake(a,task.id).operationId;
  assert.throws(()=>scheduler.launchJob(a,job,{launch:()=>{throw Error('enqueue failed');}}),/enqueue failed/);assert.equal(liveWake(a,task.id).status,'pending');assert.equal(liveWake(a,task.id).operationId,id);assert.equal(scheduler.records(a)[id],undefined);
  assert.equal(scheduler.launchJob(a,job),true);await a.runPromise;assert.equal(a.data.agentRuns[0].id,id);assert.equal(scheduler.records(a)[id].status,'finished');
});
test('Production pre-attach asynchronous failure and gate closure release without running a model',async t=>{
  const {a,task,job,calls}=await production(t);scheduler.launchJob(a,job,{run:async()=>{throw Error('run preamble failed');}});await a.runPromise;
  assert.equal(liveWake(a,task.id).status,'pending');assert.equal(Object.keys(scheduler.records(a)).length,0);
  scheduler.launchJob(a,job);a.data.stewardship.paused=true;await a.runPromise;assert.equal(calls.length,0);assert.equal(liveWake(a,task.id).status,'pending');
});
test('Production journal restores attached execution identity over an older workspace snapshot',async t=>{
  const {a,task,job,reload}=await production(t);const old=fs.readFileSync(a.file);const claims=scheduler.claimJob(a,job,'stable-operation');const run={id:claims[0].operationId,jobId:job.id};scheduler.attachRun(a,run,claims);
  assert.equal(scheduler.records(a)[run.id].status,'started');scheduler.dispose(a);fs.writeFileSync(a.file,old);
  const restored=reload();assert.equal(liveWake(restored,task.id).status,'attached');assert.equal(scheduler.lookup(restored,run.id,claims[0]).taskId,task.id);assert.equal(restored.data.deadlineExecutions[run.id].status,'started');assert.equal(scheduler.pending(restored,restored.data.delegations.find(j=>j.id===job.id)).length,0);
  assert.ok(restored.data.recoveryReviews.some(r=>r.operationId===run.id));
});
test('Production claim crash without execution returns pending with stable identity after restart',async t=>{
  const {a,task,job,reload}=await production(t);const [claim]=scheduler.claimJob(a,job,'stable-operation');scheduler.dispose(a);const restored=reload();
  assert.equal(liveWake(restored,task.id).status,'pending');assert.equal(liveWake(restored,task.id).operationId,claim.operationId);
  const [again]=scheduler.claimJob(restored,restored.data.delegations.find(j=>j.id===job.id),'different-operation');assert.equal(again.operationId,claim.operationId);
});
test('Production boundary timer reconciles and notifies while paused without the 15 second poll',async t=>{
  const {a,task,calls}=await production(t,{job:false});a.data.stewardship.paused=true;let boundaries=0;scheduler.subscribe(a,()=>boundaries++);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  events.setPolicy(a,{taskId:task.id,input:{dueAt:new Date(Date.now()+1000).toISOString(),remindBeforeMinutes:[]}});
  assert.equal(events.view(a.data,task).stage,'scheduled');t.mock.timers.tick(1001);
  assert.equal(events.view(a.data,task).stage,'overdue');assert.equal(boundaries,1);assert.equal(calls.length,0);assert.equal(liveWake(a,task.id).status,'pending');
});
test('Production waiting deadline reads only due authorized local watchers and never invokes the planner',async t=>{
  const {a,task,job,calls}=await production(t),agent=require('../desktop/agent.cjs');
  const folder=path.join(a.dir,'input');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'due.md'),'原始内容');fs.writeFileSync(path.join(folder,'later.md'),'以后再读');
  a.data.folders.push({id:'input',path:folder});job.folderIds=['input'];require('../desktop/access-policy-store.cjs').syncTrustedJob(a,job,{trusted:true,actor:'user_command',command:'createDelegation'});
  const args={folderId:'input',name:'due.md'},result=await agent.read(a,job,'read_file',args);
  job.watchers=[{key:'due',tool:'read_file',args,hash:require('../desktop/evidence-basis.cjs').hash(require('../desktop/tool-registry.cjs').facts('read_file',result))},{key:'later',tool:'read_file',args:{folderId:'input',name:'later.md'}},{key:'denied',tool:'read_file',args:{folderId:'ungranted',name:'secret.md'}}];
  job.followups=[{key:'wait',taskId:task.id,status:'waiting',checkAt:new Date(Date.now()-1000).toISOString(),watchKeys:['due','denied']},{key:'later',taskId:task.id,status:'waiting',checkAt:new Date(Date.now()+60000).toISOString(),watchKeys:['later']}];
  job.status='watching';task.status='waiting';scheduler.reconcile(a);const reads=[],read=agent.read;t.mock.method(agent,'read',async(...args)=>{reads.push(args[3].name);return read(...args);});
  a.tick();await a.runPromise;assert.deepEqual(reads,['due.md']);assert.equal(calls.length,0);assert.equal(job.status,'watching');assert.equal(a.data.agentRuns.length,0);assert.equal(liveWake(a,task.id).status,'attached');assert.equal(Object.values(scheduler.records(a))[0].resultStatus,'checked');assert.equal(job.followups[0].checkedAt,undefined);
});
test('Production terminal transition after enqueue cancels the wake before any business execution',async t=>{
  const {a,task,job,calls}=await production(t);const id=liveWake(a,task.id).id;scheduler.launchJob(a,job);task.status='completed';scheduler.reconcile(a);await a.runPromise;
  assert.equal(calls.length,0);assert.equal(events.state(a).wakeIntents[id].status,'cancelled');assert.equal(Object.keys(scheduler.records(a)).length,0);
});
test('Production execution commit survives workspace failure and recovery never creates a second operation',async t=>{
  const {a,task,job,reload}=await production(t);const [claim]=scheduler.claimJob(a,job),save=a.save;t.mock.method(a,'save',()=>{throw Error('projection disk failed');});
  assert.throws(()=>scheduler.attachRun(a,{id:claim.operationId,jobId:job.id},[claim]),e=>e.committed===true);
  assert.equal(scheduler.lookup(a,claim.operationId,claim).taskId,task.id);a.save=save;scheduler.dispose(a);
  const restored=reload();assert.equal(liveWake(restored,task.id).status,'attached');assert.equal(Object.keys(scheduler.records(restored)).length,1);
});
test('Production trusted planner deadline edits and clears reconcile without restoring an old dueAt',async t=>{
  const {a,task,job}=await production(t);const original=task.dueAt,revision=task.deadlinePolicy.deadlineRevision;
  task.dueAt=null;followup.deadlines(a,job);assert.equal(task.dueAt,null);assert.equal(task.deadlinePolicy.dueAt,null);assert.equal(task.deadlinePolicy.deadlineRevision,revision+1);assert.equal(liveWake(a,task.id),undefined);
  task.dueAt=original;followup.deadlines(a,job);assert.equal(task.deadlinePolicy.dueAt,original);assert.equal(task.deadlinePolicy.deadlineRevision,revision+2);assert.ok(liveWake(a,task.id));
});
test('Production Agent tick uses the same durable launcher and never randomizes a released claim',async t=>{
  const {a,task,job}=await production(t),agent=require('../desktop/agent.cjs');const [claim]=scheduler.claimJob(a,job,'stable-agent-tick');scheduler.releaseClaims(a,[claim]);
  assert.equal(agent.tick(a),true);await a.runPromise;assert.equal(a.data.agentRuns[0].id,'stable-agent-tick');assert.equal(scheduler.records(a)['stable-agent-tick'].status,'finished');assert.equal(task.priority,'low');
});
test('Production deadline tick preserves retry cooldown, explicit execution pause and pending ingestion',async t=>{
  const {a,task,job,calls}=await production(t);job.status='retry';assert.equal(scheduler.pending(a,job).length,0);assert.equal(scheduler.tick(a),false);
  job.status='ready';job.executionPaused=true;assert.equal(scheduler.tick(a),false);assert.equal(events.view(a.data,task).paused,true);
  job.executionPaused=false;a.data.connectors.push({id:'batch',jobId:job.id,cursor:{token:'more'}});assert.equal(scheduler.tick(a),false);assert.equal(calls.length,0);assert.equal(liveWake(a,task.id).status,'pending');
});
test('Empty deadlines create no journal events and do not rewrite unrelated work cursors',async t=>{
  const {a}=await production(t,{job:false});const task=a.createTask({title:'没有截止安排'}),before=structuredClone(task),sequence=journal.read(a).events.length;
  scheduler.reconcile(a);assert.equal(journal.read(a).events.length,sequence);assert.deepEqual(task,before);assert.equal(events.state(a).policies[task.id],undefined);
});
test('Production planner immediately journals A -> B -> A and a clear before any timer tick',async t=>{
  const {a,job}=await production(t),plans=require('../desktop/agent-plan.cjs');const input={key:'deadline-plan',title:'明确截止',criteria:'按时完成',steps:[{key:'draft',title:'起草',kind:'draft'}],dueAt:new Date(Date.now()+20*60000).toISOString()};
  const {taskId}=plans.planTask(a,job,input),task=a.task(taskId),id=events.view(a.data,task).event.id,rev=task.deadlinePolicy.deadlineRevision;
  plans.planTask(a,job,{...input,dueAt:new Date(Date.now()+40*60000).toISOString()});plans.planTask(a,job,input);
  assert.equal(task.deadlinePolicy.deadlineRevision,rev+2);assert.notEqual(events.view(a.data,task).event.id,id);assert.equal(events.state(a).events[id].status,'cancelled');
  plans.planTask(a,job,{...input,dueAt:null});assert.equal(task.dueAt,null);assert.equal(liveWake(a,taskId),undefined);
});
test('Production notification and execution projection never invalidate business acceptance cursors',async t=>{
  const {a,task,job,reload}=await production(t),acceptance=require('../desktop/acceptance.cjs');
  const before=acceptance.revision(a,task),cursor=structuredClone(task.workEvent);
  await a.dispatch('attentionRead',{id:`deadline:${task.id}`,revision:events.view(a.data,task).event.id});
  const claims=scheduler.claimJob(a,job);scheduler.attachRun(a,{id:claims[0].operationId,jobId:job.id},claims);
  assert.equal(acceptance.revision(a,task),before);assert.deepEqual(task.workEvent,cursor);
  scheduler.dispose(a);const restored=reload();assert.deepEqual(restored.task(task.id).workEvent,cursor);assert.equal(liveWake(restored,task.id).status,'attached');assert.equal(events.view(restored.data,restored.task(task.id)).state,'read');
});
test('Production work-state and attention use the same stage for tasks and their job',async t=>{
  const {a,task,job}=await production(t),state=require('../desktop/work-state.cjs');
  assert.equal(state.workState(a,task).deadlineStage,events.view(a.data,task).stage);assert.equal(state.workState(a,job).deadlineStage,'imminent');
  await a.dispatch('updateTask',{id:task.id,dueAt:new Date(Date.now()-1000).toISOString()});assert.equal(state.workState(a,task).deadlineStage,'overdue');assert.equal(state.workState(a,job).deadlineStage,'overdue');
});
test('Production read-only journal recovery keeps cards but never claims or submits notifications',async t=>{
  const {a,task}=await production(t);a.readOnlyRecovery=true;const before=journal.read(a).events.length;
  class Notification {static isSupported(){throw Error('No native notification in read-only recovery');}}
  assert.deepEqual(scheduler.reconcile(a),[]);assert.equal(scheduler.tick(a),false);assert.equal(scheduler.notify(a,{Notification}).count,0);a.tick();
  assert.equal(journal.read(a).events.length,before);assert.ok(attention.snapshot(a).items.some(c=>c.id===`deadline:${task.id}`));
});
