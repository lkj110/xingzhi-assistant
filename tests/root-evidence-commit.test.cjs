const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),plans=require('../desktop/agent-plan.cjs');
const continuation=require('../desktop/evidence-continuation.cjs'),journal=require('../desktop/work-journal.cjs'),links=require('../desktop/evidence-links.cjs'),outputs=require('../desktop/deliverables.cjs');
const access=require('../desktop/protocol-access.cjs'),policies=require('../desktop/access-policy-store.cjs'),evidence=require('../desktop/evidence-basis.cjs');
const deny=async()=>{throw Error('No real model, connector, or network is allowed');};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-evidence-commit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:deny,connectorRequest:deny,webRequest:deny});
  t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
  a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',type:'openai',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
  const job=agent.buildJob(a,{goal:'核对来源并修订同一主稿',autoAccept:false});a.data.delegations.push(job);
  const task=a.createTask({title:'交接稿',criteria:'SQL与物理消费均须核对',steps:[{title:'已有外部准备',kind:'external'},{title:'核对事实',kind:'analysis'},{title:'主稿',kind:'draft'},{title:'交付',kind:'external'}]});
  Object.assign(task,{agentJobId:job.id,agentKey:'handoff',planVersion:1,dependsOn:[],planHistory:[]});job.taskIds=[task.id];
  task.steps.forEach((s,i)=>Object.assign(s,{key:['prepared','analyze','draft','deliver'][i],done:true,...(s.kind==='external'?{tool:'write_file',evidence:{actionId:'old-'+i}}:{artifactId:i===2?'main':'analysis'})}));
  for(const s of task.steps.filter(s=>s.kind!=='external')){const r={id:s.artifactId,taskId:task.id,stepId:s.id,title:s.title,content:'PRIVATE_OLD_BODY_'+s.key};a.data.artifacts.push(r);access.retain(a,'artifact',r,{job,task});}
  const original=agent.source(a,job,'original','原始证据','PRIVATE_ORIGINAL_SOURCE');links.setInputs(a,task,[original.id]);
  for(const s of task.steps)require('../desktop/step-evidence.cjs').record(a,task,s);
  task.contentVerification={passed:false,basis:'old-content',gaps:['缺物理消费者'],gapDetails:[{id:'physical',text:'缺物理消费者',artifactId:'main'}]};
  task.verification={passed:false,basis:'old-final',gaps:['未回读']};task.status='review';
  job.executionState={...require('../desktop/operation-ledger.cjs').state(job),requirements:[{id:'task:'+task.id,revision:'contract'}],gaps:[{id:'physical',taskId:task.id,status:'open',text:'缺物理消费者'},{id:'sql',taskId:task.id,status:'open',text:'需核对SQL'}]};
  const fresh=agent.source(a,job,'fresh','新增证据','PRIVATE_FRESH_SOURCE'),unrelated=agent.source(a,job,'other','无关证据','PRIVATE_UNRELATED_SOURCE');
  const input={key:'handoff',title:task.title,criteria:task.criteria,sourceIds:[fresh.id],reason:'显式关联本事项新证据'};
  a.save();return {a,job,task,original,fresh,unrelated,input,dir};
}
const events=a=>journal.read(a).events.filter(e=>e.type===continuation.TYPE);
function commit(f,args=f.input){return plans.planTask(f.a,f.job,args);}
function assertReopened(f){
  assert.deepEqual(f.task.steps.map(s=>s.done),[true,false,false,false]);
  assert.equal(f.task.steps[2].artifactId,'main');assert.equal(f.task.steps[2].targetArtifactId,'main');assert.equal(outputs.primary(f.a,f.task).id,'main');
  assert.equal(f.task.contentVerification,null);assert.equal(f.task.verification,null);assert.equal(f.task.steps[3].evidence,undefined);
  assert.ok(f.task.sourceIds.includes(f.fresh.id));assert.ok(!f.task.sourceIds.includes(f.unrelated.id));
}
test('explicit association commits binding, ordered text/external invalidation, primary refs and old gaps together',t=>{
  const f=fixture(t),gaps=structuredClone(f.job.executionState),sources=structuredClone(f.a.data.sources),artifacts=structuredClone(f.a.data.artifacts),result=commit(f);
  assertReopened(f);assert.deepEqual(f.job.executionState,gaps);assert.deepEqual(f.a.data.sources,sources);assert.deepEqual(f.a.data.artifacts,artifacts);
  const [event]=events(f.a);assert.equal(events(f.a).length,1);assert.equal(event.commitId,result.commitId);assert.equal(event.payload.bindings.filter(b=>b.state==='active').length,2);
  assert.equal(event.payload.invalidatedChecks.length,2);assert.equal(f.task.invalidatedChecks.length,2);assert.equal(event.payload.affectedStepIds.length,3);
  assert.doesNotMatch(JSON.stringify(event),/PRIVATE_/);assert.equal(event.payload.primary.artifactId,'main');
  const version=f.task.planVersion;assert.deepEqual(commit(f),result);assert.equal(f.task.planVersion,version);assert.equal(f.task.planHistory.length,1);assert.equal(events(f.a).length,1);
});
test('job source inventory alone never attaches evidence to the task',t=>{
  const f=fixture(t);commit(f,{...f.input,sourceIds:undefined});assert.deepEqual(f.task.sourceIds,[f.original.id]);assert.ok(f.task.steps.every(s=>s.done));
});
test('updated source version reopens in the same commit and preserves the historical input',t=>{
  const f=fixture(t),next=agent.source(f.a,f.job,'original','新版证据','PRIVATE_CHANGED_SOURCE');
  commit(f,{...f.input,sourceIds:[next.id]});assert.ok(f.task.sourceIds.includes(f.original.id));assert.deepEqual(f.task.supersededSourceIds,[f.original.id]);assert.deepEqual(f.task.steps.map(s=>s.done),[true,false,false,false]);assert.equal(outputs.primary(f.a,f.task).id,'main');
});
test('in-place evidence update is detected by typed binding version even with unchanged IDs',t=>{
  const f=fixture(t);f.original.content+=' changed';commit(f,{...f.input,sourceIds:[f.original.id]});assert.equal(f.task.steps[1].done,false);assert.equal(f.task.planVersion,2);assert.equal(events(f.a)[0].payload.inputsChanged,true);
});
test('implicit command identity includes retained inputs omitted from the additive sourceIds argument',t=>{
  const f=fixture(t),first=commit(f);f.original.content+=' new facts';
  const second=commit(f);assert.notEqual(second.commitId,first.commitId);assert.equal(f.task.planVersion,3);assert.equal(events(f.a).length,2);
  assert.equal(events(f.a)[1].payload.inputsChanged,true);assertReopened(f);
  assert.deepEqual(commit(f),second);assert.equal(events(f.a).length,2);
});
test('append failure leaves all live objects and checks untouched and retry uses one commit',t=>{
  const f=fixture(t),before=JSON.stringify(f.a.data),append=journal.append;let attempts=[];
  t.mock.method(journal,'append',(a,events,options)=>{attempts.push(options.commitId);throw Error('before append');});
  assert.throws(()=>commit(f),/before append/);assert.equal(JSON.stringify(f.a.data),before);assert.equal(f.a.task(f.task.id),f.task);assert.equal(events(f.a).length,0);
  journal.append=append;const result=commit(f);assert.equal(result.commitId,attempts[0]);assertReopened(f);
});
for(const fault of ['after_append','during_projection','snapshot'])test(`${fault}: durable event recovers and repeats return the original result without reopening twice`,t=>{
  const f=fixture(t),input={...f.input,commandId:'stable-'+fault},backup=structuredClone(f.a.data),save=f.a.save;
  if(fault==='after_append'){const append=journal.append;t.mock.method(journal,'append',(...args)=>{const receipt=append(...args);throw Object.assign(Error(fault),{committed:true,commitReceipt:receipt});});}
  if(fault==='during_projection')t.mock.method(journal,'project',()=>{throw Error(fault);});
  if(fault==='snapshot')f.a.save=()=>{throw Error(fault);};
  assert.throws(()=>commit(f,input),e=>e.committed&&e.projectionPending);assert.equal(events(f.a).length,1);assert.ok(f.a.data.runtime.projectionPending);
  assert.throws(()=>require('../desktop/execution-gate.cjs').assert(f.a,{job:f.job,task:f.task,readOnly:true}),e=>e.code==='EXECUTION_GATE_CLOSED');
  t.mock.restoreAll();f.a.save=save;
  // A process restart has only the old workspace plus the independent journal.
  f.a.data=backup;const job=f.a.data.delegations.find(j=>j.id===f.job.id),task=f.a.task(f.task.id),result=plans.planTask(f.a,job,input);
  const restored={...f,job,task};assertReopened(restored);assert.equal(task.planHistory.length,1);assert.equal(task.planVersion,2);assert.equal(task.projectionPending,undefined);
  assert.deepEqual(plans.planTask(f.a,job,input),result);assert.equal(events(f.a).length,1);assert.equal(task.invalidatedChecks.length,2);
});
test('saved projection with a lost response returns its committed receipt after a real restart',t=>{
  const f=fixture(t),input={...f.input,commitId:'response-lost'},save=f.a.save;
  f.a.save=function(){save.call(this);throw Object.assign(Error('lost response'),{committed:true});};
  assert.throws(()=>commit(f,input),e=>e.committed);f.a.save=save;
  const b=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(b));
  const job=b.data.delegations.find(j=>j.id===f.job.id),task=b.task(f.task.id),result=plans.planTask(b,job,input);
  assert.equal(result.commitId,events(b)[0].commitId);assert.equal(task.planVersion,2);assert.equal(task.planHistory.length,1);assert.equal(events(b).length,1);
});
test('journal-only cold replay lazily loads the projector without core or agent',t=>{
  const f=fixture(t),backup=JSON.stringify(f.a.data);commit(f);
  const script=`const fs=require('node:fs'),path=require('node:path');const journal=require(process.argv[1]);const a={dir:process.argv[2],data:JSON.parse(fs.readFileSync(0,'utf8')),save(){}};journal.replay(a,{force:true});process.stdout.write(JSON.stringify({data:a.data,coreLoaded:Object.keys(require.cache).some(k=>k.endsWith('/core.cjs'))}));`;
  const run=spawnSync(process.execPath,['-e',script,require.resolve('../desktop/work-journal.cjs'),f.dir],{input:backup,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout),task=result.data.tasks.find(t=>t.id===f.task.id);
  assert.equal(result.coreLoaded,false);assert.equal(task.planVersion,2);assert.equal(task.primaryArtifactId,'main');assert.deepEqual(task.steps.map(s=>s.done),[true,false,false,false]);
});
test('forced replay over an already-applied snapshot preserves later step and check progress',t=>{
  const f=fixture(t);const result=commit(f);f.task.steps[1].done=true;f.task.contentVerification={passed:true,basis:'new-check',gaps:[]};const before=JSON.stringify(f.task);
  journal.replay(f.a,{force:true});assert.equal(JSON.stringify(f.task),before);assert.deepEqual(commit(f),result);assert.equal(JSON.stringify(f.task),before);
});
test('explicit command reuse with different input is a conflict, not a new plan',t=>{
  const f=fixture(t),input={...f.input,commandId:'unique'};commit(f,input);const before=JSON.stringify(f.a.data);
  assert.throws(()=>commit(f,{...input,sourceIds:[f.unrelated.id]}),e=>e.code==='WORK_JOURNAL_CONFLICT');assert.equal(JSON.stringify(f.a.data),before);
});
test('source deletion authority wins over an old workspace and journal replay cannot resurrect its binding or body',t=>{
  const f=fixture(t),backup=structuredClone(f.a.data),input={...f.input,commandId:'delete-after-commit'};commit(f,input);
  require('../desktop/source-deletions.cjs').record(f.a,f.fresh.id,{trusted:true});f.a.data=backup;journal.replay(f.a,{force:true});
  const task=f.a.task(f.task.id);assert.ok(!f.a.data.sources.some(s=>s.id===f.fresh.id));assert.ok(!task.sourceIds.includes(f.fresh.id));assert.ok(task.needsReplan);
  const job=f.a.data.delegations.find(j=>j.id===f.job.id);assert.equal(plans.planTask(f.a,job,input).commitId,events(f.a)[0].commitId);assert.ok(!task.sourceIds.includes(f.fresh.id));
});
test('later explicit withdrawal survives forced replay and cannot be rebound by a duplicate command',t=>{
  const f=fixture(t),input={...f.input,commandId:'withdraw-after-commit'};commit(f,input);links.withdrawSources(f.a,f.task,[f.fresh.id],{reason:'用户撤回此事项关联'});
  journal.replay(f.a,{force:true});assert.ok(!f.task.sourceIds.includes(f.fresh.id));commit(f,input);assert.ok(!f.task.sourceIds.includes(f.fresh.id));assert.equal(events(f.a).length,1);
});
for(const condition of ['task_pause','job_pause','global_pause','accepted','deleted','budget','unknown_reservation','uncertain','revoked'])test(`precommit ${condition} guard does not grant permission, schedule work or reset fees`,t=>{
  const f=fixture(t);
  if(condition==='task_pause')f.task.status='paused';
  if(condition==='job_pause')f.job.executionPaused=true;
  if(condition==='global_pause'){f.a.automaticExecution=true;f.a.data.settings.automatic=false;f.a.data.stewardship.paused=true;}
  if(condition==='accepted'){f.task.status='completed';f.task.acceptedAt='2026-01-01T00:00:00Z';}
  if(condition==='deleted')f.task.deletedAt='2026-01-01T00:00:00Z';
  if(condition==='budget'||condition==='unknown_reservation')f.a.spendLedger.scopes['job:'+f.job.id]={limitUSD:200,spentUSD:157,heldUSD:condition==='budget'?43:9,unreservedCalls:condition==='unknown_reservation'?1:0};
  if(condition==='uncertain')f.a.data.agentActions.push({id:'unknown',jobId:f.job.id,taskId:f.task.id,status:'uncertain',tool:'lark_update'});
  if(condition==='revoked')policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+f.fresh.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
  const before=JSON.stringify(f.a.data),spend=JSON.stringify(f.a.spendLedger);assert.throws(()=>commit(f));assert.equal(JSON.stringify(f.a.data),before);assert.equal(JSON.stringify(f.a.spendLedger),spend);assert.equal(events(f.a).length,0);
});
test('replay after pause, revocation and budget exhaustion restores facts but keeps every execution gate closed',t=>{
  const f=fixture(t),backup=structuredClone(f.a.data),input={...f.input,commandId:'later-guards'};commit(f,input);
  policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+f.fresh.id,jobId:f.job.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
  f.a.data=backup;const task=f.a.task(f.task.id),job=f.a.data.delegations.find(j=>j.id===f.job.id);task.status='paused';job.executionPaused=true;
  f.a.spendLedger.scopes['job:'+job.id]={limitUSD:200,spentUSD:157,heldUSD:43,unreservedCalls:0};const fees=JSON.stringify(f.a.spendLedger);
  journal.replay(f.a,{force:true});assert.equal(task.status,'paused');assert.equal(job.executionPaused,true);assert.equal(access.allowedObject(f.a,'source',f.fresh,job,task),false);
  assert.deepEqual(plans.planTask(f.a,job,input),events(f.a)[0].payload.result);assert.equal(continuation.inspect(f.a,job,task).nextStepId,null);assert.equal(JSON.stringify(f.a.spendLedger),fees);
});
test('inspect is read-only for healthy, blocked and legacy task shapes',t=>{
  const f=fixture(t);
  for(const state of ['legacy','committed','paused']){
    if(state==='committed')commit(f);if(state==='paused')f.task.status='paused';
    const before=JSON.stringify(f.a.data),spend=JSON.stringify(f.a.spendLedger),log=fs.readFileSync(journal.file(f.a),'utf8');
    for(let i=0;i<3;i++)continuation.inspect(f.a,f.job,f.task);
    assert.equal(JSON.stringify(f.a.data),before);assert.equal(JSON.stringify(f.a.spendLedger),spend);assert.equal(fs.readFileSync(journal.file(f.a),'utf8'),log);
  }
});
test('preappend workRevision and source version checks reject changes during detached validation',t=>{
  for(const change of ['work','source']){
    const f=fixture(t),bind=outputs.bind;t.mock.method(outputs,'bind',(...args)=>{const value=bind(...args);if(change==='work')f.task.workRevision=(f.task.workRevision??1)+1;else f.fresh.content+=' concurrent change';return value;});
    assert.throws(()=>commit(f),e=>['STATE_STALE','CONTEXT_VERSION_CHANGED'].includes(e.code));assert.equal(events(f.a).length,0);assert.equal(f.task.planVersion,1);assert.equal(f.task.steps[2].done,true);t.mock.restoreAll();
  }
});
test('dependent task checks invalidate with the same event and unrelated task state stays intact',t=>{
  const f=fixture(t),child=f.a.createTask({title:'依赖事项',criteria:'等待主稿',steps:[{title:'整理',kind:'draft'}]}),other=f.a.createTask({title:'无关事项',criteria:'不变'});
  Object.assign(child,{agentJobId:f.job.id,dependsOn:[f.task.id],contentVerification:{passed:false,gaps:['仍缺独立结果']}});Object.assign(other,{agentJobId:f.job.id,dependsOn:[]});f.job.taskIds.push(child.id,other.id);
  const before=JSON.stringify(other);commit(f);assert.ok(child.needsReplan);assert.equal(child.contentVerification,null);assert.equal(child.invalidatedChecks[0].check.gaps[0],'仍缺独立结果');assert.equal(JSON.stringify(other),before);
});
test('deadline changes retain A -> B -> A semantics and are replayed in the plan batch',t=>{
  const f=fixture(t),now=Date.now(),dueA=new Date(now+7200000).toISOString(),dueB=new Date(now+10800000).toISOString();
  const a={...f.input,dueAt:dueA},b={...f.input,dueAt:dueB};commit(f,a);const first=f.task.deadlinePolicy.deadlineRevision;
  commit(f,b);commit(f,a);assert.equal(f.task.dueAt,dueA);assert.equal(f.task.deadlinePolicy.deadlineRevision,first+2);
  const revision=f.task.deadlinePolicy.deadlineRevision;commit(f,a);assert.equal(f.task.deadlinePolicy.deadlineRevision,revision);
  commit(f,{...f.input,dueAt:null});assert.equal(f.task.dueAt,null);assert.equal(f.task.deadlinePolicy.deadlineRevision,revision+1);
});
test('authorized delivery cannot publish the retained old main while evidence repair is pending',async t=>{
  const f=fixture(t);f.job.outputFolder=f.dir;f.job.fileMode='auto';policies.syncTrustedJob(f.a,f.job,{trusted:true,actor:'user_command',command:'fixture_output'});
  commit(f);assert.equal(f.task.steps[2].outputRole,'primary');
  await assert.rejects(agent.act(f.a,f.job,'write_file',{taskId:f.task.id}),/主稿修订尚未完成/);
  assert.equal(f.a.data.agentActions.length,0);assert.equal(outputs.primary(f.a,f.task).content,'PRIVATE_OLD_BODY_draft');
});
test('source association cannot remove all business text and proceed straight to delivery',t=>{
  const f=fixture(t),before=JSON.stringify(f.a.data);
  assert.throws(()=>commit(f,{...f.input,steps:[{key:'deliver',title:'交付旧稿',kind:'external',tool:'write_file'}]}),e=>e.code==='PLAN_INPUT_INVALID');assert.equal(JSON.stringify(f.a.data),before);
});
test('unaffected step checkpoints survive a title-only plan edit and forced replay',t=>{
  const f=fixture(t);f.task.steps[1].checkpoint={sections:[{title:'保留进展',content:'PRIVATE_CHECKPOINT'}]};
  const args={...f.input,sourceIds:[],steps:f.task.steps.map(s=>({...s,title:s.title+' 更新标题'}))},backup=structuredClone(f.a.data);commit(f,args);
  assert.equal(f.task.steps[1].checkpoint.sections[0].content,'PRIVATE_CHECKPOINT');assert.match(f.task.steps[1].title,/更新标题/);assert.doesNotMatch(JSON.stringify(events(f.a)),/PRIVATE_CHECKPOINT/);
  f.a.data=backup;journal.replay(f.a,{force:true});assert.equal(f.a.task(f.task.id).steps[1].checkpoint.sections[0].content,'PRIVATE_CHECKPOINT');assert.match(f.a.task(f.task.id).steps[1].title,/更新标题/);
});
test('implicit stable reset and evidence-resolution command returns its original receipt across restart',t=>{
  const f=fixture(t),request=require('../desktop/evidence-request.cjs');
  f.task.evidenceRequest=request.normalize(f.a,f.task,{kind:'needs_evidence',summary:'核对消费者',gaps:['缺物理消费者']},'request-basis');
  const input={...f.input,resetSteps:['analyze'],evidenceResolution:{basis:'request-basis',reason:'已查得实际回执',sourceIds:[f.fresh.id]}},result=commit(f,input);
  const b=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(b));
  const job=b.data.delegations.find(j=>j.id===f.job.id);assert.deepEqual(plans.planTask(b,job,input),result);assert.equal(events(b).length,1);assert.equal(b.task(f.task.id).evidenceRequest,undefined);
});
test('a backup check cannot remain current merely because the live check was already empty at commit time',t=>{
  const f=fixture(t),backup=structuredClone(f.a.data);f.task.verification=null;f.task.contentVerification=null;commit(f);
  f.a.data=backup;journal.replay(f.a,{force:true});const task=f.a.task(f.task.id);assert.equal(task.verification,null);assert.equal(task.contentVerification,null);
});
test('cold replay of a plan with a deadline retains the original deadline protocol and batch identity',t=>{
  const f=fixture(t),backup=JSON.stringify(f.a.data),dueAt=new Date(Date.now()+3600000).toISOString(),result=commit(f,{...f.input,dueAt});
  const batch=journal.read(f.a).events.filter(e=>e.commitId===result.commitId);assert.ok(batch.some(e=>e.type==='deadline_protocol'));
  const script=`const fs=require('node:fs'),journal=require(process.argv[1]);const a={dir:process.argv[2],data:JSON.parse(fs.readFileSync(0,'utf8')),save(){}};journal.replay(a,{force:true});process.stdout.write(JSON.stringify(a.data.tasks));`;
  const run=spawnSync(process.execPath,['-e',script,require.resolve('../desktop/work-journal.cjs'),f.dir],{input:backup,encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).find(t=>t.id===f.task.id).dueAt,dueAt);
});
test('actual background execution Proxy keeps live object identity, save, and event methods intact',async t=>{
  const f=fixture(t),root=f.a.data,save=f.a.save,notice=f.a.event;let failure,result;
  require('../desktop/execution.cjs').launch(f.a,{jobId:f.job.id},'evidence fixture',async view=>{
    try{
      const before=JSON.stringify(f.a.data);continuation.inspect(view,f.job,f.task);assert.equal(JSON.stringify(f.a.data),before);
      result=plans.planTask(view,f.job,f.input);assert.equal(f.a.data,root);assert.equal(f.a.task(f.task.id),f.task);assert.equal(f.a.save,save);assert.equal(f.a.event,notice);assertReopened(f);
    }catch(e){failure=e;throw e;}
  });
  await f.a.runPromise;if(failure)throw failure;assert.ok(result.commitId);assert.equal(JSON.parse(fs.readFileSync(f.a.file,'utf8')).tasks.find(t=>t.id===f.task.id).planVersion,2);
});
test('replacing the old text slot still binds the pending business revision to the same primary',async t=>{
  const f=fixture(t);f.job.outputFolder=f.dir;f.job.fileMode='auto';policies.syncTrustedJob(f.a,f.job,{trusted:true,actor:'user_command',command:'fixture_output'});
  commit(f,{...f.input,steps:[{key:'new-draft',title:'定向修订',kind:'draft'},{key:'deliver',title:'交付',kind:'external',tool:'write_file'}]});
  assert.equal(f.task.steps[0].outputRole,'primary');assert.equal(f.task.steps[0].targetArtifactId,'main');assert.equal(outputs.primary(f.a,f.task).id,'main');
  await assert.rejects(agent.act(f.a,f.job,'write_file',{taskId:f.task.id}),/主稿修订尚未完成/);assert.equal(f.a.data.agentActions.length,0);
});
test('withdrawal plus new association is one replayable event, including snapshot failure and duplicate recovery',t=>{
  const f=fixture(t),backup=structuredClone(f.a.data),save=f.a.save,input={...f.input,removeSourceIds:[f.original.id]};
  f.a.save=()=>{throw Error('combined transaction snapshot failed');};assert.throws(()=>commit(f,input),e=>e.committed&&e.projectionPending);
  const [event]=events(f.a);assert.equal(events(f.a).length,1);assert.equal(event.payload.withdrawals.length,1);assert.equal(event.payload.withdrawals[0].sourceId,f.original.id);
  assert.equal(event.payload.bindings.find(b=>b.sourceId===f.fresh.id).state,'active');assert.equal(event.payload.bindings.find(b=>b.sourceId===f.original.id).state,'withdrawn');
  assert.deepEqual(f.task.sourceIds,[f.fresh.id]);assert.equal(f.task.steps[2].done,false);assert.equal(f.task.contentVerification,null);
  f.a.save=save;f.a.data=backup;const job=f.a.data.delegations.find(j=>j.id===f.job.id),result=plans.planTask(f.a,job,input),task=f.a.task(f.task.id);
  assert.deepEqual(task.sourceIds,[f.fresh.id]);assert.equal(task.planVersion,2);assert.equal(outputs.primary(f.a,task).id,'main');assert.equal(task.invalidatedChecks.length,2);
  assert.deepEqual(plans.planTask(f.a,job,input),result);assert.equal(events(f.a).length,1);
  assert.throws(()=>links.setInputs(f.a,task,[f.original.id]),e=>e.code==='CONTEXT_SCOPE_DENIED');
  assert.deepEqual(f.job.executionState.gaps.map(g=>g.status),['open','open']);
});
test('stable withdrawal with omitted sourceIds recovers before validating already-removed IDs',t=>{
  const f=fixture(t),input={key:'handoff',title:f.task.title,criteria:f.task.criteria,removeSourceIds:[f.original.id],reason:'明确撤回输入'};
  const first=commit(f,input);assert.deepEqual(f.task.sourceIds,[]);assert.deepEqual(commit(f,input),first);assert.equal(events(f.a).length,1);
});
