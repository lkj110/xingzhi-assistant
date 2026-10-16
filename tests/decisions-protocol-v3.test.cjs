'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),decisions=require('../desktop/decisions.cjs'),journal=require('../desktop/work-journal.cjs');
const facts=require('../desktop/action-facts.cjs'),writes=require('../desktop/agent-writes.cjs'),policy=require('../desktop/access-policy-store.cjs');
const scheduler=require('../desktop/deadline-scheduler.cjs'),acceptance=require('../desktop/acceptance.cjs');
const trusted={trusted:true,actor:'user_command',command:'decision_test_fixture'};
async function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'decisions-v3-'))),instances=[];let calls=0;
  const forbidden=async()=>{calls++;throw Error('External boundary forbidden');};
  const create=()=>{const a=new Assistant({dir,chat:forbidden,connectorRequest:forbidden,agentRequest:forbidden,webRequest:forbidden,officeRequest:forbidden,feedRequest:forbidden});instances.push(a);return a;};
  t.after(()=>{for(const a of instances){scheduler.dispose(a);a.streamController?.dispose();}fs.rmSync(dir,{recursive:true,force:true});assert.equal(calls,0);});
  const a=create();await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
  const j=agent.buildJob(a,{goal:'Synthetic decision work',allowWeb:false,fileMode:'auto',useOutputFolder:true,githubMode:'off'},{outputFolder:dir});a.data.delegations.push(j);
  const add=()=>{const task=a.createTask({title:'Synthetic task',criteria:'Synthetic requirement',steps:[{title:'Draft',kind:'draft'}]});task.agentJobId=j.id;task.dependsOn=[];j.taskIds.push(task.id);return task;};
  const task=add();a.save();return {a,j,task,add,dir,reload:create};
}
function orphan(f,extra={},remove='all'){
  const {a,j,task,dir}=f,r={id:'old-effect',jobId:j.id,taskId:task.id,tool:'write_file',target:path.join(dir,'original.md'),latestName:'latest.md',version:writes.version(task),content:'synthetic original body',status:'running',title:'Old action',...extra};
  a.data.agentActions.push(r);facts.intent(a,r);j.pendingActionId=r.id;
  if(remove==='all'){a.data.tasks=[];a.data.delegations=[];}else if(remove==='task')a.data.tasks=[];
  facts.replay(a);require('../desktop/recovery.cjs').pause(a.data);policy.reconcile(a);a.save();return r;
}
const card=(a,id)=>a.publicState().decisionCards.find(c=>c.id===id);
const actionInput=(a,r)=>({id:'action:'+r.id,revision:card(a,'action:'+r.id).revision});
test('IR5 orphan cards preserve the exact old target and do not mutate during projection',async t=>{
  const f=await fixture(t),r=orphan(f),before=JSON.stringify(f.a.data),c=card(f.a,'action:'+r.id);
  assert.equal(c.orphan,true);assert.equal(c.jobId,null);assert.equal(c.originalJobId,r.jobId);assert.equal(c.originalTaskId,r.taskId);assert.equal(c.action.target,r.target);assert.equal(c.action.latestName,'latest.md');
  assert.equal(require('../desktop/pending-badges.cjs').count(f.a.data),1);assert.equal(JSON.stringify(f.a.data),before);
});
test('Orphan notApplied requires explicit current confirmation, persists through old snapshot replay, and never requeues',async t=>{
  const f=await fixture(t),{a,j}=f,r=orphan(f,{},'task'),input=actionInput(a,r),old=structuredClone(a.data),jobBefore=structuredClone(j);
  await assert.rejects(a.dispatch('decisionActionResolve',input),/明确确认/);
  await assert.rejects(a.dispatch('decisionActionResolve',{...input,revision:'stale',confirmedNotApplied:true}),/变化/);
  await a.dispatch('decisionActionResolve',{...input,confirmedNotApplied:true});
  assert.equal(r.effectStatus,'not_applied');assert.deepEqual(j,jobBefore);assert.equal(a.data.tasks.length,0);assert.equal(card(a,input.id),undefined);
  const length=facts.load(a).events.length;await a.dispatch('decisionActionResolve',{...input,confirmedNotApplied:true});assert.equal(facts.load(a).events.length,length);
  a.data=old;facts.replay(a);assert.equal(a.data.agentActions[0].effectStatus,'not_applied');assert.equal(card(a,input.id),undefined);assert.deepEqual(a.data.delegations[0],jobBefore);
});
test('Orphan action facts survive workspace-save failure and process restart without phantom work',async t=>{
  const f=await fixture(t),{a}=f,r=orphan(f),input=actionInput(a,r),old=fs.readFileSync(a.file),save=a.save;
  a.save=()=>{throw Error('injected workspace save failure');};
  await assert.rejects(a.dispatch('decisionActionResolve',{...input,confirmedNotApplied:true}),e=>e.committed===true);a.save=save;
  fs.writeFileSync(a.file,old);const restored=f.reload();assert.equal(restored.data.agentActions[0].effectStatus,'not_applied');assert.equal(restored.data.tasks.length,0);assert.equal(restored.data.delegations.length,0);assert.equal(card(restored,input.id),undefined);
});
test('An orphan local file can be reconciled read-only against both captured destinations',async t=>{
  const f=await fixture(t),{a,dir}=f,r=orphan(f),input=actionInput(a,r);
  fs.writeFileSync(r.target,r.content);fs.writeFileSync(path.join(dir,r.latestName),r.content);const stat=fs.statSync(r.target);
  await a.dispatch('decisionActionReconcile',input);assert.equal(r.status,'done');assert.equal(r.presentationStatus,'historical');assert.equal(r.result.verified,true);assert.equal(fs.statSync(r.target).mtimeMs,stat.mtimeMs);assert.equal(a.data.sources.length,0);assert.equal(a.data.tasks.length,0);assert.equal(a.data.delegations.length,0);
  const old=structuredClone(a.data);old.agentActions[0].status='uncertain';old.agentActions[0].factSequence=0;a.data=old;facts.replay(a);assert.equal(a.data.agentActions[0].status,'done');
});
test('Missing or different old file is never inferred as notApplied or overwritten',async t=>{
  const f=await fixture(t),{a}=f,r=orphan(f),input=actionInput(a,r),count=facts.load(a).events.length;
  await assert.rejects(a.dispatch('decisionActionReconcile',input));assert.equal(r.status,'uncertain');
  fs.writeFileSync(r.target,'unrelated new content');await assert.rejects(a.dispatch('decisionActionReconcile',input),/不一致/);assert.equal(fs.readFileSync(r.target,'utf8'),'unrelated new content');assert.equal(facts.load(a).events.length,count);
});
test('Revoked output authority blocks orphan readback; manual confirmation grants no access',async t=>{
  const f=await fixture(t),{a,dir}=f,r=orphan(f),input=actionInput(a,r);
  policy.revoke(a,{principalScope:policy.LOCAL,resourceScope:{kind:'output',key:dir,jobId:r.jobId,taskId:r.taskId},operations:['prepare_write_file']},trusted);
  await assert.rejects(a.dispatch('decisionActionReconcile',input),e=>e.code==='ACCESS_POLICY_REVOKED');
  const before=fs.readFileSync(path.join(dir,'access-policy.json'),'utf8');
  await a.dispatch('decisionActionReconcile',{...input,confirmedApplied:true,evidence:'用户在原目标核对回执 #123'});
  assert.equal(r.result.verified,false);assert.equal(r.result.confirmedBy,'user');assert.equal(r.result.reconciliation.originalTarget,r.target);assert.equal(fs.readFileSync(path.join(dir,'access-policy.json'),'utf8'),before);
});
test('Remote orphan reconciliation is explicitly human-confirmed without connector or executor calls',async t=>{
  const f=await fixture(t),{a}=f,r=orphan(f,{tool:'lark_create',target:'folder:old-folder',larkOpenId:'old-account',result:{url:'https://example.invalid/docx/original'}}),input=actionInput(a,r);
  await assert.rejects(a.dispatch('decisionActionReconcile',input),/原系统/);
  await assert.rejects(a.dispatch('decisionActionReconcile',{...input,confirmedApplied:true,evidence:''}),/人工核对依据/);
  await a.dispatch('decisionActionReconcile',{...input,confirmedApplied:true,evidence:'在原账号及原文档链接核对了完整内容'});
  assert.equal(r.status,'done');assert.equal(r.result.verified,false);assert.equal(r.result.url,'https://example.invalid/docx/original');assert.equal(a.data.delegations.length,0);assert.equal(a.data.tasks.length,0);
});
test('Missing task and completed work get one independent card; busy original scope cannot be confirmed',async t=>{
  const f=await fixture(t),{a,j,task}=f,r=orphan(f,{},'none');
  task.status='completed';task.acceptedAt=new Date().toISOString();j.status='completed';const c=card(a,'action:'+r.id);assert.equal(c.orphan,true);assert.equal(a.publicState().decisionCards.filter(c=>c.action?.id===r.id).length,1);
  a.executions.set('job:'+j.id,{key:'job:'+j.id,jobId:j.id});await assert.rejects(a.dispatch('decisionActionResolve',{id:c.id,revision:c.revision,confirmedNotApplied:true}),/正在推进/);a.executions.clear();assert.equal(r.status,'uncertain');
});
test('Damaged independent action ledger cannot be bypassed by manual reconciliation',async t=>{
  const f=await fixture(t),{a,dir}=f,r=orphan(f),input=actionInput(a,r);fs.writeFileSync(path.join(dir,'action-facts.json'),'{}');
  await assert.rejects(a.dispatch('decisionActionResolve',{...input,confirmedNotApplied:true}),/校验/);assert.equal(r.status,'uncertain');
});
function question(f,type){
  const {a,j,task}=f;
  if(type==='decisionTaskAnswer'){task.agentJobId=null;j.taskIds=[];task.status='waiting';task.waitingOn='Choose a scope';decisions.askTask(a,task,{});}
  else if(type==='decisionJobAnswer'){j.status='blocked';j.lastError='Choose a scope';}
  else if(type==='decisionTimeout'){j.followups.push({key:'wait',status:'waiting',taskId:task.id,expected:'synthetic reply',sourceIds:[]});decisions.timeout(a,j,j.followups[0]);}
  else decisions.ask(a,j,{question:'Choose a scope',taskIds:[task.id]});
  a.save();const kind={decisionTaskAnswer:'task_question',decisionJobAnswer:'blocked',decisionTimeout:'timeout',decisionAnswer:'question'}[type],c=a.publicState().decisionCards.find(c=>c.kind===kind);
  return {c,input:{id:c.id,revision:c.revision,...(type==='decisionTimeout'?{choice:'replan',note:'Keep the verified sections only'}:{answer:'Keep the verified sections only'})}};
}
for(const type of ['decisionAnswer','decisionJobAnswer','decisionTaskAnswer','decisionTimeout']){
  test(`${type} journals explicit feedback before decisions/followups mutate, and replays it from an old snapshot`,async t=>{
    const f=await fixture(t),{a,j,task}=f,{c,input}=question(f,type),before=structuredClone(a.data),method=type==='decisionTaskAnswer'?'recordUserEdit':'recordJobFeedback',original=journal[method];let called=0;
    journal[method]=(owner,command)=>{called++;assert.deepEqual(owner.data.decisions,before.decisions);assert.deepEqual(j.followups,before.delegations[0].followups);assert.ok(command.requirementRevision);assert.equal(command.noteKind,'decision');return original(owner,command);};
    try{await a.dispatch(type,input);}finally{journal[method]=original;}
    assert.equal(called,1);assert.equal(task.notes.filter(n=>n.kind==='decision').length,1);assert.ok(task.notes.at(-1).workSequence);assert.equal(a.data.decisions.find(d=>d.id===c.id)?.status||a.data.decisions[0].status,'answered');
    const events=journal.read(a).events.filter(e=>e.payload?.note?.includes('Keep the verified sections only'));assert.ok(events.length);assert.ok(events.every(e=>e.actor==='user'));
    a.data=before;journal.replay(a,{force:true,save:false});assert.ok(a.task(task.id).notes.some(n=>n.text.includes('Keep the verified sections only')&&n.workSequence));
  });
  test(`${type} cannot mutate the answer, followup or schedule if journal append fails`,async t=>{
    const f=await fixture(t),{a}=f,{input}=question(f,type),before=structuredClone(a.data),rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(to===path.join(f.dir,'work-journal.json'))throw Error('injected journal failure');return rename(from,to);};
    try{await assert.rejects(a.dispatch(type,input),/injected journal failure/);}finally{fs.renameSync=rename;}
    assert.deepEqual(a.data.decisions,before.decisions);assert.deepEqual(a.data.tasks,before.tasks);assert.deepEqual(a.data.delegations,before.delegations);
  });
}
test('Scoped explicit answer reopens only the selected accepted task and preserves sibling intent and approvals',async t=>{
  const f=await fixture(t),{a,j,task}=f,sibling=f.add();
  task.status='completed';task.acceptedAt=new Date().toISOString();task.workRevision=1;sibling.status='completed';sibling.acceptedAt=new Date().toISOString();sibling.workRevision=1;
  decisions.ask(a,j,{question:'Revise selected scope?',taskIds:[task.id]});j.status='paused';
  a.data.agentActions.push({id:'sibling-approval',jobId:j.id,taskId:sibling.id,tool:'write_file',status:'pending',version:writes.version(sibling)});
  const before=structuredClone(sibling),basis=acceptance.basis(a,sibling),feedback=structuredClone(j.feedback),c=card(a,a.data.decisions[0].id);
  await a.dispatch('decisionAnswer',{id:c.id,revision:c.revision,answer:'Revise only the selected item'});
  assert.equal(task.workRevision,2);assert.equal(task.acceptedAt,undefined);assert.equal(task.status,'todo');assert.equal(j.status,'paused');assert.deepEqual(j.feedback,feedback);assert.deepEqual(sibling,before);assert.equal(acceptance.basis(a,sibling),basis);assert.equal(a.data.agentActions[0].status,'pending');
  assert.ok(!journal.read(a).events.some(e=>e.entityId===sibling.id&&e.type==='reopened'));
});
test('Automated information resolution is not user intent and does not reopen an accepted task',async t=>{
  const f=await fixture(t),{a,j,task}=f;decisions.ask(a,j,{question:'What is the date?',decisionType:'information',taskIds:[task.id]});const d=a.data.decisions[0];
  const s={id:'new-fact',title:'Synthetic fact',content:'2026-10-20',createdAt:new Date(Date.now()+1000).toISOString()};a.data.sources.push(s);j.sourceIds.push(s.id);
  task.status='completed';task.acceptedAt=new Date().toISOString();task.workRevision=1;const before=structuredClone(task),feedback=structuredClone(j.feedback),events=journal.read(a).events.length,model=agent.model;
  agent.model=async()=>({satisfied:true,quote:s.content});
  try{assert.equal((await decisions.resolveInformation(a,j,{decisionId:d.id,sourceId:s.id})).resolved,true);}finally{agent.model=model;}
  assert.deepEqual(task,before);assert.deepEqual(j.feedback,feedback);assert.equal(journal.read(a).events.length,events);assert.ok(j.history.some(h=>h.origin==='information'));assert.ok(!(j.userDirectives||[]).some(d=>d.text.includes(s.content)));
});
