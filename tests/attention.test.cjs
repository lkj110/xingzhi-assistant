const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const attention=require('../desktop/attention.cjs');
const NOW=Date.now(),date=hours=>new Date(NOW+hours*3600000).toISOString();
function fixture() {
  const a={saveCount:0,chat(){throw Error('must not call model');},request(){throw Error('must not call network');},save(){this.saveCount++;attention.sync(this);},data:{projects:[{id:'p',name:'青禾项目'},{id:'q',name:'其他项目'}],delegations:[{id:'j',projectId:'p',title:'青禾委托',goal:'交付本周方案',status:'needs_input',taskIds:['t'],sourceIds:['s'],followups:[]}],tasks:[{id:'t',agentJobId:'j',projectId:'p',title:'制作方案',status:'waiting',steps:[],notes:[],sourceIds:['s']}],sources:[{id:'s',projectId:'p',title:'背景',content:'预算 1000',version:1}],artifacts:[],agentActions:[],decisions:[{id:'d',jobId:'j',projectId:'p',status:'open',kind:'question',question:'选择哪个方案？',suggestion:'方案 A',taskIds:['t'],sourceIds:['s'],createdAt:date(-1)}],attentionRecords:[]}};
  attention.initialize(a);return a;
}
const card=(a,id='decision:d')=>attention.snapshot(a).items.find(row=>row.id===id);
function action(a,kind='Read',id='decision:d',extra={}) {const item=card(a,id);return attention.dispatch(a,`attention${kind}`,{id:item.id,revision:item.revision,...extra});}
function deepFreeze(v){if(v&&typeof v==='object'){Object.freeze(v);Object.values(v).forEach(deepFreeze);}return v;}

test('Attention snapshot reads current work without calls, saves or mutation',()=>{
  const a=fixture(),before=JSON.stringify(a.data);deepFreeze(a.data);
  const r=attention.snapshot(a);assert.equal(r.counts.all,1);assert.equal(r.counts.unread,1);assert.equal(r.items[0].category,'decision');assert.equal(r.items[0].projectName,'青禾项目');assert.equal(r.modelCalls,0);assert.equal(r.networkRequests,0);assert.equal(a.saveCount,0);assert.equal(JSON.stringify(a.data),before);
});
test('Reading changes only attention state and never resolves, accepts or authorizes work',()=>{
  const a=fixture(),before=structuredClone(a.data);action(a);
  assert.equal(card(a).state,'read');assert.equal(a.saveCount,1);
  for(const key of Object.keys(before).filter(k=>k!=='attentionRecords'))assert.deepEqual(a.data[key],before[key]);
  assert.equal(a.data.decisions[0].status,'open');assert.equal(attention.pendingNotifications(a).count,0);
  action(a,'Unread');assert.equal(card(a).state,'unread');assert.equal(a.data.attentionRecords.length,0);
});
test('Material, decision and linked artifact changes re-open read attention',()=>{
  for(const change of [a=>a.data.sources[0].content='预算 2000',a=>a.data.decisions[0].question='方案 A 还是 C？',a=>{a.data.tasks[0].steps=[{id:'step',kind:'draft',done:true,artifactId:'v'}];a.data.artifacts.push({id:'v',content:'新产出'});},a=>a.data.tasks[0].criteria='新验收标准']) {
    const a=fixture();action(a);change(a);assert.equal(card(a).state,'unread');attention.sync(a);assert.equal(a.data.attentionRecords.length,0);
  }
});
test('Routine polling and timestamps do not continually re-open a read question',()=>{
  const a=fixture();action(a);a.data.delegations[0].nextRunAt=date(1);a.data.delegations[0].updatedAt=date(0);a.data.decisions[0].updatedAt=date(0);a.data.tasks[0].updatedAt=date(0);
  assert.equal(card(a).state,'read');attention.sync(a);assert.equal(a.data.attentionRecords.length,1);
});
test('Stale revisions and resolved cards cannot be acknowledged',()=>{
  const a=fixture(),r=card(a);a.data.decisions[0].question='已变化';
  assert.throws(()=>attention.dispatch(a,'attentionRead',{id:r.id,revision:r.revision}),/已变化/);assert.equal(a.saveCount,0);
  const current=card(a);a.data.decisions[0].status='answered';a.data.delegations[0].status='ready';
  assert.throws(()=>attention.dispatch(a,'attentionSnooze',{id:current.id,revision:current.revision,minutes:30}),/已变化/);
});
test('Resolved risk removes its acknowledgement, so recurrence with identical text is unread',()=>{
  const a=fixture();action(a);a.data.decisions[0].status='answered';a.data.delegations[0].status='ready';a.save();assert.equal(a.data.attentionRecords.length,0);assert.equal(attention.snapshot(a).counts.all,0);
  a.data.decisions[0].status='open';a.data.delegations[0].status='needs_input';a.save();assert.equal(card(a).state,'unread');
});
test('Snoozed attention expires into unread and changes can end snooze early',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();action(a,'Snooze','decision:d',{minutes:30});assert.equal(card(a).state,'snoozed');assert.equal(attention.pendingNotifications(a).count,0);
  t.mock.method(Date,'now',()=>NOW+30*60000);assert.equal(card(a).state,'unread');assert.equal(attention.pendingNotifications(a).count,1);
  t.mock.method(Date,'now',()=>NOW);a.data.decisions[0].question='更紧急的问题';assert.equal(card(a).state,'unread');
});
test('Snooze requires a supported bounded interval and can be cancelled',()=>{
  const a=fixture();for(const minutes of [null,0,-1,1,31,Infinity,'30',2880])assert.throws(()=>action(a,'Snooze','decision:d',{minutes}),/稍后提醒/);
  action(a,'Snooze','decision:d',{minutes:1440});assert.equal(card(a).state,'snoozed');action(a,'Unsnooze');assert.equal(card(a).state,'unread');
});
test('Failed persistence rolls back attention reads and notification markers',()=>{
  const a=fixture();a.save=()=>{throw Error('disk full');};const before=structuredClone(a.data.attentionRecords);
  assert.throws(()=>action(a),/disk full/);assert.deepEqual(a.data.attentionRecords,before);
  assert.throws(()=>attention.markNotified(a,attention.pendingNotifications(a).items),/disk full/);assert.deepEqual(a.data.attentionRecords,before);
});
test('Notification delivery is separate from reading and de-duplicates across restart',()=>{
  const a=fixture(),pending=attention.pendingNotifications(a);assert.equal(pending.count,1);assert.equal(attention.markNotified(a,pending.items),1);assert.equal(card(a).state,'unread');assert.equal(attention.pendingNotifications(a).count,0);
  const b=fixture();b.data=JSON.parse(JSON.stringify(a.data));attention.initialize(b);assert.equal(card(b).state,'unread');assert.equal(attention.pendingNotifications(b).count,0);
  assert.equal(attention.markNotified(a,pending.items),0);assert.equal(a.saveCount,1);
});
test('Expired snooze sends a new notification even after a previous delivery',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture(),first=attention.pendingNotifications(a);attention.markNotified(a,first.items);action(a,'Snooze','decision:d',{minutes:30});
  t.mock.method(Date,'now',()=>NOW+31*60000);const second=attention.pendingNotifications(a);assert.equal(second.count,1);assert.notEqual(second.items[0].notificationKey,first.items[0].notificationKey);attention.markNotified(a,second.items);assert.equal(attention.pendingNotifications(a).count,0);assert.equal(card(a).state,'unread');
});
test('Changed and read cards reject a stale notification acknowledgement',()=>{
  const a=fixture(),first=attention.pendingNotifications(a);a.data.decisions[0].question='新问题';assert.equal(attention.markNotified(a,first.items),0);assert.equal(attention.pendingNotifications(a).count,1);
  const fresh=attention.pendingNotifications(a);action(a);assert.equal(attention.markNotified(a,fresh.items),0);assert.equal(a.saveCount,1);
});
test('Notification acknowledgements ignore duplicates and malformed records',()=>{
  const a=fixture(),p=attention.pendingNotifications(a).items[0];assert.equal(attention.markNotified(a,[null,{},p,p]),1);assert.throws(()=>attention.markNotified(a,{}));
});
test('Backup restore resets acknowledgement and notification state without changing underlying work',()=>{
  const a=fixture();attention.markNotified(a,attention.pendingNotifications(a).items);action(a,'Snooze','decision:d',{minutes:30});a.data.attentionRecords=attention.restore();attention.initialize(a);assert.equal(card(a).state,'unread');assert.equal(attention.pendingNotifications(a).count,1);assert.equal(a.data.decisions[0].status,'open');
});
test('Read, snooze and notification fields survive isolated disk round-trip',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-attention-'));
  try{const a=fixture();attention.markNotified(a,attention.pendingNotifications(a).items);action(a,'Snooze','decision:d',{minutes:120});fs.writeFileSync(path.join(dir,'work.json'),JSON.stringify(a.data));const b=fixture();b.data=JSON.parse(fs.readFileSync(path.join(dir,'work.json'),'utf8'));attention.initialize(b);assert.equal(card(b).state,'snoozed');assert.equal(attention.pendingNotifications(b).count,0);action(b);fs.writeFileSync(path.join(dir,'work.json'),JSON.stringify(b.data));a.data=JSON.parse(fs.readFileSync(path.join(dir,'work.json'),'utf8'));attention.initialize(a);assert.equal(card(a).state,'read');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Imminent and overdue stages have different fingerprints and remain visible for paused work',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.tasks[0].dueAt=date(1);a.data.delegations[0].status='paused';assert.equal(card(a,'deadline:t').severity,'warning');assert.equal(card(a,'deadline:t').paused,true);action(a,'Read','deadline:t');
  t.mock.method(Date,'now',()=>NOW+3600000);assert.equal(card(a,'deadline:t').state,'unread');assert.equal(card(a,'deadline:t').severity,'critical');
  a.data.tasks[0].status='completed';assert.equal(card(a,'deadline:t'),undefined);
});
test('Only next 24 hours appear as deadline risks and routine clock advance preserves read state',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.tasks[0].dueAt=date(24.1);assert.equal(card(a,'deadline:t'),undefined);a.data.tasks[0].dueAt=date(24);action(a,'Read','deadline:t');
  t.mock.method(Date,'now',()=>NOW+60*60000);assert.equal(card(a,'deadline:t').state,'read');
});
test('Independent review, blocked and due waiting tasks have actionable routes',()=>{
  const a=fixture();a.data.tasks.push({id:'review',title:'独立成果',status:'review'},{id:'blocked',title:'受阻工作',status:'blocked',lastError:'认证失效'},{id:'waiting',title:'待反馈',status:'waiting',nextCheckAt:date(-1),waitingOn:'需要外部回执'});
  const r=attention.snapshot(a,{projectId:'@independent'});assert.equal(r.counts.all,3);assert.equal(r.items.find(c=>c.id==='review:review').route.page,'acceptance');assert.equal(r.items.find(c=>c.id==='blocked:blocked').route.taskId,'blocked');assert.equal(r.items.find(c=>c.id==='waiting:waiting').category,'followup');
});
test('Agent actions show pending approval and uncertain outcomes but not routine running or done actions',()=>{
  const a=fixture();a.data.decisions=[];a.data.delegations[0].status='approval';
  for(const status of ['pending','uncertain','running','done','stale'])a.data.agentActions.push({id:status,jobId:'j',taskId:'t',projectId:'p',status,title:'写入文件',tool:'write_file'});
  const r=attention.snapshot(a);assert.equal(r.counts.all,2);assert.equal(card(a,'action:uncertain').severity,'critical');assert.equal(card(a,'action:pending').category,'approval');
  action(a,'Read','action:pending');a.data.agentActions[0].args={content:'新文案'};assert.equal(card(a,'action:pending').state,'unread');
});
test('Job blockers, limited quotas and automatic retries disclose their distinct status',()=>{
  const a=fixture();a.data.decisions=[];const j=a.data.delegations[0];
  for(const status of ['blocked','limited','retry']){j.status=status;j.summary=status==='limited'?'调用额度用尽':'暂时无法执行';assert.equal(card(a,'job:j').category,'blocked');assert.equal(card(a,'job:j').automaticRetry,status==='retry');}
  j.status='watching';assert.equal(card(a,'job:j'),undefined);
});
test('Overdue follow-ups are visible before the scheduler creates a timeout decision',()=>{
  const a=fixture();a.data.decisions=[];a.data.delegations[0].status='paused';a.data.delegations[0].followups=[{key:'confirm',taskId:'t',status:'waiting',expected:'提供验收结论',deadlineAt:date(-1),createdAt:date(-10)}];
  assert.equal(card(a,'followup:j:confirm').category,'followup');assert.equal(card(a,'followup:j:confirm').paused,true);
  a.data.decisions.push({id:'timeout',jobId:'j',projectId:'p',kind:'timeout',status:'open',followupKey:'confirm',question:'等待超时'});assert.equal(card(a,'followup:j:confirm'),undefined);assert.equal(card(a,'decision:timeout').severity,'warning');
});
test('Valid inherited scope works; conflicting references never broaden project visibility',()=>{
  const a=fixture();delete a.data.tasks[0].projectId;a.data.tasks[0].status='review';assert.ok(attention.snapshot(a,{projectId:'p'}).items.some(c=>c.id==='review:t'));
  a.data.tasks.push({id:'foreign',projectId:'q',agentJobId:'j',status:'review',title:'FOREIGN'});a.data.decisions.push({id:'bad',jobId:'j',projectId:'q',status:'open',question:'FOREIGN'});a.data.agentActions.push({id:'bad',taskId:'foreign',jobId:'j',status:'uncertain',title:'FOREIGN'});
  const scoped=attention.snapshot(a,{projectId:'p'});assert.ok(!JSON.stringify(scoped).includes('FOREIGN'));assert.equal(scoped.notices.length,0);assert.ok(attention.snapshot(a).notices.length>0);assert.equal(attention.snapshot(a,{projectId:'@independent'}).counts.all,0);
});
test('Malformed persisted acknowledgement records cannot suppress current risks or break sparse workspaces',()=>{
  const a=fixture();a.data.attentionRecords=[null,{id:'decision:d',revision:'anything',readAt:date(-1)},{id:22,revision:'a'.repeat(64)},[]];attention.initialize(a);assert.equal(a.data.attentionRecords.length,0);assert.equal(card(a).state,'unread');
  assert.doesNotThrow(()=>attention.snapshot({data:{projects:[],tasks:[null,{id:'missing',agentJobId:'gone',status:'review'},{id:'bad',projectId:2,status:'review'}],delegations:[null],decisions:[null],agentActions:[null]}}));
});
test('Filtering and pagination preserve accurate totals',()=>{
  const a=fixture();for(let i=0;i<65;i++)a.data.tasks.push({id:`r${String(i).padStart(2,'0')}`,title:`成果 ${i}`,status:'review'});
  action(a,'Read','review:r00');action(a,'Snooze','review:r01',{minutes:30});
  const r=attention.snapshot(a,{projectId:'@independent',state:'unread',page:99,pageSize:20});assert.equal(r.counts.all,65);assert.equal(r.counts.unread,63);assert.equal(r.counts.read,1);assert.equal(r.counts.snoozed,1);assert.equal(r.total,63);assert.equal(r.page,4);assert.equal(r.items.length,3);assert.equal(r.from,61);assert.equal(r.to,63);
  assert.equal(attention.snapshot(a,{category:'decision'}).total,1);assert.equal(attention.snapshot(a,{state:'read'}).total,1);
});
test('Unsupported queries, states, mutations and project inputs reject explicitly',()=>{
  const a=fixture();for(const input of [null,[],{projectId:null},{projectId:0},{projectId:'missing'},{state:'resolved'},{category:'__proto__'},{page:0},{pageSize:101},{page:'2'},{pageSize:null}])assert.throws(()=>attention.snapshot(a,input));
  for(const input of [null,{},[],{id:0,revision:'x'}])assert.throws(()=>attention.dispatch(a,'attentionRead',input));assert.throws(()=>attention.dispatch(a,'attentionApprove',{}));
});

test('External action body, target and desired state invalidate read acknowledgements',()=>{
  for(const [key,value] of [['content','修改后的消息'],['body','修改后的正文'],['target','new/repository'],['number',22],['desired',{state:'closed'}],['respondentId','ou_new']]) {
    const a=fixture();a.data.agentActions.push({id:'a',jobId:'j',taskId:'t',status:'pending',tool:'request_confirmation',content:'原消息',target:'oc_chat'});action(a,'Read','action:a');a.data.agentActions[0][key]=value;assert.equal(card(a,'action:a').state,'unread',key);assert.equal(card(a,'action:a').route.page,'agent');
  }
});
test('Briefing save failures show actionable local cards and clear after resolution',()=>{
  const a=fixture();a.data.briefingSchedule={revision:'config1',projectId:'p',error:'目录无法写入',runs:[{id:'failed1',status:'failed'}]};
  assert.equal(card(a,'briefingSchedule:error').route.page,'briefing');assert.equal(card(a,'briefingSchedule:error').projectId,'p');action(a,'Read','briefingSchedule:error');assert.equal(card(a,'briefingSchedule:error').state,'read');
  a.data.briefingSchedule.runs[0].status='interrupted';assert.equal(card(a,'briefingSchedule:error').state,'unread');a.data.briefingSchedule.error=null;attention.sync(a);assert.equal(card(a,'briefingSchedule:error'),undefined);
});
test('Workspace briefing failure is not misattributed to independent or project work',()=>{
  const a=fixture();a.data.briefingSchedule={revision:'r',projectId:'',error:'保存失败',runs:[]};assert.equal(card(a,'briefingSchedule:error').projectName,'全部工作');assert.equal(attention.snapshot(a,{projectId:'@independent'}).counts.all,0);assert.equal(attention.snapshot(a,{projectId:'q'}).counts.all,0);
  a.data.briefingSchedule.projectId='@independent';assert.equal(attention.snapshot(a,{projectId:'@independent'}).counts.all,1);
});

test('An approved pending action stops asking for approval until a new problem occurs',()=>{
  const a=fixture();a.data.decisions=[];a.data.delegations[0].status='ready';a.data.agentActions.push({id:'a',jobId:'j',taskId:'t',status:'pending',tool:'write_file'});action(a,'Read','action:a');a.data.agentActions[0].approvedAt=date(0);a.data.agentActions[0].version=require('../desktop/agent-writes.cjs').version(a.data.tasks[0]);a.save();assert.equal(card(a,'action:a'),undefined);assert.equal(a.data.attentionRecords.length,0);a.data.agentActions[0].status='uncertain';assert.equal(card(a,'action:a').state,'unread');
});
test('Independent requests appear immediately and become unread again when follow-up is due',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.tasks.push({id:'waiting',title:'需补充背景',status:'waiting',waitingOn:'请说明目标受众',nextCheckAt:date(2)});assert.equal(card(a,'waiting:waiting').severity,'info');action(a,'Read','waiting:waiting');t.mock.method(Date,'now',()=>NOW+2*3600000);assert.equal(card(a,'waiting:waiting').severity,'warning');assert.equal(card(a,'waiting:waiting').state,'unread');
});

function complete(a) {
  a.data.decisions=[];const j=a.data.delegations[0],t=a.data.tasks[0];j.status='completed';j.completedAt=date(-1);
  Object.assign(t,{status:'completed',completedAt:date(-1),criteria:'方案已生成',steps:[{id:'draft',kind:'draft',done:true,artifactId:'v'}],verification:{passed:true,summary:'内容满足要求',gaps:[]}});a.data.artifacts=[{id:'v',taskId:t.id,stepId:'draft',content:'方案正文'}];t.verification.basis=require('../desktop/acceptance.cjs').basis(a,t);return {j,t};
}
test('Recently completed jobs create one durable result notification backed by current evidence',()=>{
  const a=fixture();complete(a);const item=card(a,'completion:job:j');assert.equal(item.category,'completion');assert.equal(item.route.page,'agent');assert.equal(attention.pendingNotifications(a).count,1);attention.markNotified(a,attention.pendingNotifications(a).items);assert.equal(attention.pendingNotifications(a).count,0);assert.equal(item.state,'unread');action(a,'Read',item.id);assert.equal(card(a,item.id).state,'read');assert.equal(attention.snapshot(a,{category:'completion'}).total,1);
});
test('Completed progress expires after seven days and future completion timestamps do not appear',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture(),{j}=complete(a);j.completedAt=date(-168);assert.ok(card(a,'completion:job:j'));j.completedAt=date(-168.001);assert.equal(card(a,'completion:job:j'),undefined);j.completedAt=date(1);assert.equal(card(a,'completion:job:j'),undefined);
});
test('Changed goals, sources, receipts, artifacts and open waits invalidate completion notifications',()=>{
  for(const change of [a=>a.data.sources[0].content='修改预算',a=>a.data.artifacts[0].content='修改产出',a=>a.data.delegations[0].goal='新目标',a=>a.data.delegations[0].followups.push({status:'waiting'}),a=>a.data.decisions.push({id:'new',jobId:'j',status:'open',question:'仍需补充'}),a=>a.data.agentActions.push({id:'uncertain',jobId:'j',status:'uncertain'}),a=>{delete a.data.tasks[0].verification.basis;},a=>{a.data.tasks[0].needsReplan='新要求';}]){
    const a=fixture();complete(a);assert.ok(card(a,'completion:job:j'));change(a);assert.equal(card(a,'completion:job:j'),undefined);
  }
});
test('Independent completed tasks with current evidence have task routes and no duplicate job notification',()=>{
  const a=fixture(),{t}=complete(a);delete t.agentJobId;delete t.projectId;t.sourceIds=[];t.verification.basis=require('../desktop/acceptance.cjs').basis(a,t);a.data.delegations=[];assert.equal(card(a,'completion:task:t').route.taskId,'t');assert.equal(attention.snapshot(a,{projectId:'@independent',category:'completion'}).total,1);
});
test('Unstructured external assertions never create an automatically verified completion notification',()=>{
  const a=fixture(),{t}=complete(a);t.steps=[{kind:'external',tool:'write_file',done:true,evidence:'claimed done'}];t.verification.basis=require('../desktop/acceptance.cjs').basis(a,t);assert.equal(card(a,'completion:job:j'),undefined);
});
test('A stale approvedAt flag does not hide a changed action awaiting re-preparation',()=>{
  const a=fixture();a.data.agentActions.push({id:'a',jobId:'j',taskId:'t',status:'pending',tool:'write_file',version:'old',approvedAt:date(0)});assert.equal(card(a,'action:a').category,'approval');
});
