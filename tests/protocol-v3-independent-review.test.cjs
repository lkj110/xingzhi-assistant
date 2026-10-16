'use strict';
// Independent review: real Assistant, journals and policy checks; synthetic data
// and temporary directories only. Assertions describe the required protocol.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs');
const acceptance=require('../desktop/acceptance.cjs'),journal=require('../desktop/work-journal.cjs');
const observations=require('../desktop/source-observations.cjs'),facts=require('../desktop/action-facts.cjs');
const policy=require('../desktop/access-policy-store.cjs'),scheduler=require('../desktop/deadline-scheduler.cjs');
const recovery=require('../desktop/recovery.cjs');
const trusted={trusted:true,actor:'user_command',command:'independent_review_fixture'};

async function fixture(t,{project=false,output=false}={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'protocol-v3-independent-'))),instances=[];
  let externalCalls=0;
  const forbidden=async()=>{externalCalls++;throw Error('External boundary is forbidden in this review');};
  const create=()=>{const a=new Assistant({dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,officeRequest:forbidden,webRequest:forbidden,feedRequest:forbidden});instances.push(a);return a;};
  t.after(()=>{for(const a of instances){scheduler.dispose(a);a.streamController?.dispose();}fs.rmSync(dir,{recursive:true,force:true});assert.equal(externalCalls,0);});
  const a=create();
  await a.dispatch('saveProvider',{name:'offline fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
  if(project)a.data.projects.push({id:'project',name:'Synthetic project',background:'',createdAt:new Date().toISOString()});
  const job=agent.buildJob(a,{goal:'Review synthetic delivery',projectId:project?'project':null,allowWeb:false,autoAccept:false,fileMode:output?'auto':'off',useOutputFolder:output},{outputFolder:dir});
  a.data.delegations.push(job);if(project)a.data.projects[0].jobId=job.id;
  const task=a.createTask({title:'Synthetic task',projectId:job.projectId,criteria:'Complete synthetic content',steps:[{title:'Draft',kind:'draft'}]});
  Object.assign(task,{agentJobId:job.id,workRevision:1,dependsOn:[]});job.taskIds.push(task.id);
  const artifact={id:'draft',taskId:task.id,stepId:task.steps[0].id,title:'Draft',content:'synthetic delivered body'};
  task.steps[0].key='draft';task.steps[0].done=true;task.steps[0].artifactId=artifact.id;a.data.artifacts.push(artifact);
  require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task,job});
  a.save();return {a,job,task,artifact,dir,reload:create};
}
function ready(a,job,task){
  delete task.needsReplan;task.status='review';job.status='review';
  task.verification={passed:true,summary:'Synthetic check',gaps:[],basis:acceptance.basis(a,task)};
  acceptance.recordCompletionCheck(a,job,{passed:true,summary:'Synthetic overall check',gaps:[]},{basis:acceptance.completionBasis(a,job)});
}
function observedSource(job,task,extra={}){return {title:'Synthetic observation',content:'synthetic source body',agentJobId:job.id,projectId:job.projectId,resourceKey:'https://example.invalid/resource',principalScope:'fixture-account',remoteRevision:'1',...extra};}
const scope=(job,task)=>({scope:{jobId:job.id,projectId:job.projectId,taskId:task?.id||null},channel:'independent_review'});

test('IR1: external conflict must invalidate a previously passing completion check',async t=>{
  const {a,job,task}=await fixture(t,{output:true});
  task.steps.push({id:'write',key:'write',title:'Write',kind:'external',tool:'write_file',done:false});
  const record=await writes.prepare(a,job,'write_file',{taskId:task.id});
  await writes.execute(a,job,record);ready(a,job,task);
  fs.writeFileSync(record.result.latestPath,'actual external human edit');
  const result=observations.observe(a,observedSource(job,task,{resourceKey:record.result.latestPath,principalScope:'local',remoteRevision:null,content:fs.readFileSync(record.result.latestPath,'utf8')}),{...scope(job,task),trustedInput:true});
  assert.equal(result.state,'resolved_conflict');assert.ok(record.deliveryConflict);
  t.diagnostic(JSON.stringify({checkStillCurrent:acceptance.currentCompletionCheck(a,job),blockers:acceptance.completionCandidate(a,job).blockers}));
  assert.throws(()=>acceptance.acceptOne(a,{id:task.id}),/核对|变化|检查|交付/,'Known delivery conflict must block final acceptance');
});

test('IR2: project feedback after acceptance must survive an older workspace restore',async t=>{
  const {a,job,task}=await fixture(t,{project:true});ready(a,job,task);acceptance.acceptOne(a,{id:task.id});
  const before=structuredClone(a.data),sequence=journal.read(a).events.length;
  await a.dispatch('projectFeedback',{id:'project',note:'Add the newly requested conclusion'});
  t.diagnostic(JSON.stringify({status:task.status,workRevision:task.workRevision,journalEventsAdded:journal.read(a).events.length-sequence}));
  a.data=before;recovery.reconcileAuthorities(a,a.data);
  assert.equal(a.data.tasks[0].status,'todo','The later explicit feedback must defeat the earlier acceptance');
  assert.equal(a.data.tasks[0].workRevision,2);
  assert.ok(a.data.delegations[0].feedback.some(f=>f.text.includes('newly requested conclusion')));
});

test('IR3: replay of consumed input must not reopen subsequently accepted work',async t=>{
  const {a,job,task}=await fixture(t);const before=structuredClone(a.data);
  const pending=observations.observe(a,observedSource(job,task),{...scope(job,task),trustedInput:false});
  assert.equal(pending.state,'pending');observations.resolve(a,pending.observationId,{purpose:'input',eventId:'user-choice-once'});
  ready(a,job,task);acceptance.acceptOne(a,{id:task.id});
  const sequence=journal.read(a).events.length;
  a.data=before;recovery.reconcileAuthorities(a,a.data);
  t.diagnostic(JSON.stringify({taskStatus:a.data.tasks[0].status,jobStatus:a.data.delegations[0].status,revision:a.data.tasks[0].workRevision,eventsAdded:journal.read(a).events.length-sequence}));
  assert.equal(a.data.tasks[0].status,'completed','Replaying old input must preserve later acceptance');
  assert.equal(a.data.delegations[0].status,'completed');
});

for(const damage of ['revoked','unknown'])test(`IR4-${damage}: pending input replay must not restore an unauthorized body`,async t=>{
  const {a,job,task}=await fixture(t);
  const pending=observations.observe(a,observedSource(job,task),{...scope(job,task),trustedInput:false});
  const before=structuredClone(a.data);
  observations.resolve(a,pending.observationId,{purpose:'input',eventId:'explicit-purpose'});
  const spec={principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+pending.sourceId},operations:['local_retention','local_read']};
  if(damage==='revoked')policy.revoke(a,spec,trusted);
  else fs.unlinkSync(policy.locations(a).store);
  a.data=before;recovery.reconcileAuthorities(a,a.data);
  assert.equal(policy.check(a,{...spec,operation:'local_retention'}).decision,damage);
  const restored=a.data.sources.find(s=>s.id===pending.sourceId);
  const visible=a.publicState().sources.find(s=>s.id===pending.sourceId);
  let readBodyReturned=false;
  try{const result=await a.dispatch('readSource',{id:pending.sourceId});readBodyReturned=JSON.stringify(result).includes('synthetic source body');}catch{}
  t.diagnostic(JSON.stringify({decision:damage,bodyRestored:!!restored?.content,quarantined:restored?.accessPolicyQuarantined,publicBodyVisible:!!visible?.content,readBodyReturned}));
  assert.ok(!visible?.content&&!readBodyReturned,'Unauthorized observation content must remain isolated from UI and readSource');
});

test('IR5: an orphan uncertain action remains in the actionable pending projection',async t=>{
  const {a,job,task}=await fixture(t);
  const record={id:'orphan-effect',jobId:job.id,taskId:task.id,tool:'write_file',target:path.join(a.dir,'unconfirmed.md'),version:writes.version(task),status:'running',title:'Unconfirmed effect'};
  a.data.agentActions.push(record);facts.intent(a,record);a.save();
  a.data.tasks=[];a.data.delegations=[];facts.replay(a);recovery.pause(a.data);
  assert.ok(a.data.recoveryReviews.some(r=>r.actionId===record.id));
  const cards=a.publicState().decisionCards;
  const card=cards.find(c=>c.action?.id===record.id||c.actionId===record.id);
  assert.ok(card,'Orphan reconciliation must be reachable independently of active jobs');
  await a.dispatch('decisionActionResolve',{id:card.id,revision:card.revision,confirmedNotApplied:true});
  assert.equal(a.data.agentActions.find(r=>r.id===record.id).effectStatus,'not_applied');
  assert.deepEqual(a.data.tasks,[]);assert.deepEqual(a.data.delegations,[]);
  assert.ok(!a.publicState().decisionCards.some(c=>c.action?.id===record.id));
});

test('IR-control: local effect plus failed workspace save replays without a second write',async t=>{
  const {a,job,task,reload}=await fixture(t,{output:true});
  task.steps.push({id:'write',key:'write',title:'Write',kind:'external',tool:'write_file',done:false});
  const record=await writes.prepare(a,job,'write_file',{taskId:task.id}),old=fs.readFileSync(a.file),save=a.save;
  a.save=function(){if(record.effectStatus==='applied'&&record.status==='done')throw Error('injected workspace save failure');return save.call(this);};
  await assert.rejects(writes.execute(a,job,record),e=>e.committed===true);
  const delivered=record.result.latestPath,mtime=fs.statSync(delivered).mtimeMs;
  a.save=save;fs.writeFileSync(a.file,old);scheduler.dispose(a);const restored=reload();
  const result=restored.data.agentActions.find(r=>r.id===record.id);
  assert.equal(result.status,'done');assert.equal(fs.statSync(delivered).mtimeMs,mtime);
  assert.equal(restored.data.agentActions.filter(r=>r.tool==='write_file').length,1);
});

for(const damage of ['revoked','unknown'])test(`IR6-${damage}: uncertain message reconciliation must authorize before reading the receipt`,async t=>{
  const {a,job,task}=await fixture(t,{project:true});
  const c={id:'synthetic-chat',projectId:job.projectId,kind:'chat',target:'oc_synthetic',sendPolicy:{openId:'ou_synthetic',mode:'auto',revision:'fixture-revision',expiresAt:new Date(Date.now()+86400000).toISOString(),intervalMinutes:60,maxSends:2}};
  a.data.connectors.push(c);
  const spec={principalScope:{kind:'account',provider:'lark',subject:c.sendPolicy.openId},resourceScope:{kind:'connector',key:c.id,projectId:c.projectId,revision:c.sendPolicy.revision},operations:['read_message','prepare_request_confirmation','request_confirmation']};
  policy.grant(a,spec,trusted);
  const r={id:'message-effect',jobId:job.id,projectId:job.projectId,taskId:task.id,tool:'request_confirmation',connectorId:c.id,target:c.target,larkOpenId:c.sendPolicy.openId,status:'running',messageId:'om_synthetic',content:'Synthetic confirmation',createdAt:new Date().toISOString()};
  a.data.agentActions.push(r);facts.intent(a,r);facts.receipt(a,r);r.status='uncertain';
  assert.equal(policy.check(a,{...spec,operation:'read_message'}).allowed,true);
  if(damage==='revoked')policy.revoke(a,spec,trusted);else fs.unlinkSync(policy.locations(a).store);
  assert.equal(policy.check(a,{...spec,operation:'read_message'}).decision,damage);
  const requests=[];a.connectorRequest=async args=>{requests.push(args.slice(0,2).join(' '));throw Error('Synthetic request boundary reached');};
  await assert.rejects(require('../desktop/communications.cjs').execute(a,job,r));
  t.diagnostic(JSON.stringify({decision:damage,requests}));
  assert.deepEqual(requests,[],'Revoked/unknown permission must stop message readback before its request boundary');
});

test('IR7: revocation during Lark update preflight must stop the subsequent overwrite request',async t=>{
  const {a,job,task,artifact}=await fixture(t);
  const url='https://fixture.feishu.cn/docx/SyntheticDocument',principalScope={kind:'account',provider:'lark',subject:'ou_synthetic'};
  const before=structuredClone(job);
  job.larkCreateGrant={target:'my_library',openId:principalScope.subject};
  job.larkCreatePolicies=[{taskId:task.id,mode:'auto',allowUpdate:true,target:'my_library',openId:principalScope.subject,approvedAt:new Date().toISOString()}];
  policy.syncTrustedJob(a,job,{...trusted,before});
  const updateSpec={principalScope,resourceScope:{kind:'lark_destination',key:'my_library',jobId:job.id,taskId:task.id},operations:['lark_update']};
  let revokeOnRead=false;const requests=[];
  a.connectorRequest=async args=>{
    requests.push(args.slice(0,2).join(' '));
    if(args[0]==='auth')return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:principalScope.subject,scope:'docx:document:create docx:document:write_only docx:document:readonly'}}};
    if(args[1]==='+create')return {ok:true,data:{document:{document_id:'SyntheticDocument',url}}};
    if(args[1]==='+fetch'){
      if(revokeOnRead){policy.revoke(a,updateSpec,trusted);revokeOnRead=false;}
      return {ok:true,data:{document:{content:artifact.content,revision_id:1}}};
    }
    throw Error('Synthetic mutation boundary reached');
  };
  const created=await writes.prepare(a,job,'lark_create',{taskId:task.id});await writes.execute(a,job,created);
  const record=await writes.prepare(a,job,'lark_update',{taskId:task.id});
  assert.equal(policy.checkTool(a,job,'lark_update',record.args,{taskId:task.id}).allowed,true);
  requests.length=0;revokeOnRead=true;
  await assert.rejects(writes.execute(a,job,record));
  assert.equal(policy.check(a,{...updateSpec,operation:'lark_update'}).decision,'revoked');
  t.diagnostic(JSON.stringify({decision:'revoked',requests}));
  assert.equal(requests.includes('docs +update'),false,'Each remote write must use current authorization after asynchronous preflight');
});

for(const damage of ['revoked','unknown'])test(`IR8-${damage}: publicState must isolate body copies in actions and job history`,async t=>{
  const {a,job,task,artifact}=await fixture(t,{output:true});
  const record=await writes.prepare(a,job,'write_file',{taskId:task.id});await writes.execute(a,job,record);
  const args={artifactId:artifact.id},result=await agent.act(a,job,'read_artifact',args);
  assert.ok(JSON.stringify(result).includes(artifact.content));
  job.history.push({tool:'read_artifact',args,result:structuredClone(result),at:new Date().toISOString()});
  const spec={principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+artifact.id},operations:['local_retention','local_read']};
  if(damage==='revoked')policy.revoke(a,spec,trusted);else fs.unlinkSync(policy.locations(a).store);
  policy.reconcile(a);
  assert.equal(policy.check(a,{...spec,operation:'local_retention'}).decision,damage);
  const state=a.publicState(),publicArtifact=state.artifacts.find(r=>r.id===artifact.id),publicAction=state.agentActions.find(r=>r.id===record.id),publicJob=state.delegations.find(r=>r.id===job.id);
  assert.equal(publicArtifact.content,'');
  const actionBodyVisible=JSON.stringify(publicAction).includes(artifact.content),historyBodyVisible=JSON.stringify(publicJob.history).includes(artifact.content);
  t.diagnostic(JSON.stringify({decision:damage,artifactQuarantined:publicArtifact.accessPolicyQuarantined,actionBodyVisible,historyBodyVisible}));
  assert.ok(!actionBodyVisible&&!historyBodyVisible,'Quarantining canonical snapshots must also protect duplicate public body projections');
});

test('IR8-baseline: revoking only an old delivery source must isolate a prepared update baseline',async t=>{
  const {a,job,task,artifact}=await fixture(t),before=structuredClone(job);
  const url='https://fixture.feishu.cn/docx/SyntheticBaseline',body='synthetic remote baseline body';
  job.larkCreateGrant={target:'my_library',openId:'ou_synthetic'};
  job.larkCreatePolicies=[{taskId:task.id,mode:'auto',allowUpdate:true,target:'my_library',openId:'ou_synthetic',approvedAt:new Date().toISOString()}];
  policy.syncTrustedJob(a,job,{...trusted,before});
  a.connectorRequest=async args=>{
    if(args[0]==='auth')return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'ou_synthetic',scope:'docx:document:create docx:document:write_only docx:document:readonly'}}};
    if(args[1]==='+create')return {ok:true,data:{document:{document_id:'SyntheticBaseline',url}}};
    if(args[1]==='+fetch')return {ok:true,data:{document:{content:body,revision_id:1}}};
    throw Error('Unexpected synthetic request');
  };
  const created=await writes.prepare(a,job,'lark_create',{taskId:task.id});await writes.execute(a,job,created);
  const update=await writes.prepare(a,job,'lark_update',{taskId:task.id});assert.equal(update.baseline.content,body);
  policy.revoke(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+created.result.sourceId},operations:['local_retention','local_read']},trusted);
  policy.reconcile(a);
  const state=a.publicState(),source=state.sources.find(s=>s.id===created.result.sourceId),publicUpdate=state.agentActions.find(r=>r.id===update.id);
  assert.equal(source.content,'');assert.equal(state.artifacts.find(r=>r.id===artifact.id).content,artifact.content);
  t.diagnostic(JSON.stringify({sourceQuarantined:source.accessPolicyQuarantined,baselineBodyVisible:publicUpdate.baseline?.content===body,currentArtifactAllowed:true}));
  assert.notEqual(publicUpdate.baseline?.content,body,'Baseline retention follows its original source, independently of the current artifact');
});
