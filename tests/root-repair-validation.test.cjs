const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const rv=require('../desktop/repair-validation.cjs'),journal=require('../desktop/work-journal.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const at=n=>new Date(Date.UTC(2026,9,16,10)+n*1000).toISOString();
const note='先设计根本性的方案，然后派另一个subagent审核方案，确认最终版之后，再进行实施，最后继续推进sg事项';
function legacy(a,j,t){
 const actionKey=tool=>tool==='plan_task'?hash({tool,taskId:t.id}):hash({tool,args:{taskId:t.id}});
 const old={intent:'original-obligation',phase:'awaiting_change',waitBasis:'original-wait',lastFailure:{code:'PLAN_ALREADY_RECONCILED',taskId:t.id},blocker:{at:at(100)},history:[],tried:{}};
 j.executionState ||= {};j.executionState.workEfficiency=old;j.createdAt=t.createdAt=at(-20);j.status='blocked';j.nextRunAt=null;
 a.data.agentRuns=[{id:'prior-unknown',jobId:j.id,startedAt:at(-10),steps:[{tool:'advance_task',args:{taskId:t.id},at:at(-9),errorCode:'MODEL_INVALID_RESPONSE'}]}];
 for(const [n,tool,errorCode] of [[0,'advance_task','MODEL_INVALID_RESPONSE'],[90,'plan_task','PLAN_ALREADY_RECONCILED']]){
  const id=tool+':'+t.id,step={tool,args:{taskId:t.id},at:at(n+1),errorCode,strategyRecovery:{id}};
  old.history.push({id,basis:old.waitBasis,startedAt:at(n),finishedAt:at(n+5),outcome:'no_progress',actionKeys:[actionKey(tool)],executedActions:[{tool,args:step.args}]});
  old.tried[old.waitBasis+':'+id]={at:at(n)};
  a.data.agentRuns.unshift({id:'run-'+n,jobId:j.id,startedAt:at(n),finishedAt:at(n+6),steps:[step]});
 }
 return old;
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-validation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const task={id:'task',agentJobId:'job',workRevision:1,status:'todo',sourceIds:['source'],primaryArtifactId:'original',steps:[{id:'draft',kind:'draft',artifactId:'original',done:false},{id:'file',kind:'external',tool:'write_file',done:false}]};
 const job={id:'job',workRevision:1,goal:'原稿修复并交付',taskIds:[task.id],sourceIds:['source'],fileMode:'auto',outputFolder:dir,executionState:{}};
 const data={tasks:[task],delegations:[job],sources:[{id:'source',content:'bound evidence'}],artifacts:[{id:'original',taskId:task.id,stepId:'draft',content:'原稿',createdAt:at(-10)}],agentActions:[],decisions:[],runtime:{},projects:[]};
 const a={data,file:path.join(dir,'workspace.json'),workJournalFile:path.join(dir,'work-journal.json'),save(){this.data.runtime.commitId=randomUUID();fs.writeFileSync(this.file,JSON.stringify(this.data));}};
 legacy(a,job,task);a.save();
 const f={a,dir,get job(){return a.data.delegations[0];},get task(){return a.data.tasks[0];},input(extra={}){return {commandId:'click',taskId:task.id,artifactId:'original',expectedWorkRevision:1,expectedTaskRevision:1,authorizationNote:note,executedBy:'supervisor',...extra};},reload(){a.data=JSON.parse(fs.readFileSync(a.file));journal.replay(a);return f;}};
 return f;
}
const advance=task=>({tool:'advance_task',args:{taskId:task.id}});
function claim(f){rv.authorize(f.a,f.job,f.input());const step=advance(f.task);rv.before(f.a,f.job,step);return step;}
function savedGeneration(f){
 const g=rv.active(f.job),artifact={id:'generated',taskId:f.task.id,stepId:g.originalRepairTarget.stepId,content:'修复后的稿件',createdAt:new Date().toISOString(),generationSnapshot:require('../desktop/revision-protocol.cjs').snapshot(f.a,f.task)};
 assert.deepEqual(artifact.generationSnapshot,g.claim.snapshot);
 f.a.data.artifacts.push(artifact);f.task.primaryArtifactId=artifact.id;Object.assign(f.task.steps[0],{done:true,artifactId:artifact.id});f.a.save();return artifact;
}
function check(f,passed,phase='content'){
 const result={passed,basis:'check-'+phase,snapshot:require('../desktop/revision-protocol.cjs').snapshot(f.a,f.task),at:new Date().toISOString(),gaps:passed?[]:['仍缺真实证据']};
 require('../desktop/state-transitions.cjs').commit(f.a,()=>{f.task[phase==='content'?'contentVerification':'verification']=result;assert.equal(rv.noteCheck(f.a,f.job,f.task,result,{phase}),true);});return result;
}
test('pure allowlisted admission preserves unknown history and all old ledgers',t=>{
 const f=fixture(t),before=JSON.stringify(f.a.data),p=rv.preview(f.a,f.job);
 assert.equal(p.eligibility,true,JSON.stringify(p));assert.equal(p.proof.knownCycles,1);assert.deepEqual([...new Set(p.proof.unknown.map(u=>u.code))],['PRIOR_BUDGET_ATTRIBUTION_UNKNOWN']);assert.equal(JSON.stringify(f.a.data),before);
 const old=clone(f.job.executionState.workEfficiency),g=rv.authorize(f.a,f.job,f.input());assert.equal(g.outcome,null);assert.equal(g.repairAttemptLimit,1);assert.equal(g.prerequisiteHopLimit,4);assert.deepEqual(g.legacyWorkEfficiency,old);assert.equal(g.proof.complete,false);
 for(const key of ['history','tried','reads'])assert.deepEqual(f.job.executionState.workEfficiency[key],old[key]);
 assert.equal(Object.values(f.job.executionState.continuation.episodes)[0].validationGrantId,g.grantId);assert.equal(f.job.status,'ready');assert.ok(f.job.nextRunAt);
});
const clone=x=>structuredClone(x);
test('view is constant-work and never reads history/proof/sources/runs',t=>{
 const f=fixture(t);Object.defineProperty(f.job.executionState.workEfficiency,'history',{get(){throw Error('scan');}});
 const v=rv.view(f.job,f.task);assert.equal(v.candidate,true);assert.equal(v.expectedTaskRevision,1);assert.equal(v.target.artifactId,'original');assert.equal(rv.view(f.job).target,null);
});
test('both explicitly allowlisted unknown types retain known lower bound',t=>{
 const f=fixture(t);while(f.a.data.agentRuns.length<200)f.a.data.agentRuns.push({id:'unrelated-'+f.a.data.agentRuns.length,jobId:'other',startedAt:at(-10),steps:[]});
 const p=rv.preview(f.a,f.job);assert.equal(p.eligibility,true);assert.deepEqual([...new Set(p.proof.unknown.map(u=>u.code))].sort(),['BUDGET_HISTORY_TRUNCATED','PRIOR_BUDGET_ATTRIBUTION_UNKNOWN']);assert.equal(p.proof.knownCycles,1);
});
for(const kind of ['other_unknown','missing_precondition','known_three','controller_exhausted','wrong_target'])test('admission rejects '+kind,t=>{
 const f=fixture(t),old=f.job.executionState.workEfficiency;
 if(kind==='other_unknown')old.tried['missing:strategy']={};
 if(kind==='missing_precondition')f.a.data.agentRuns[0].steps[0].errorCode='PLAN_INPUT_INVALID';
 if(kind==='known_three')for(let i=1;i<=2;i++){
  const step={tool:'advance_task',args:{taskId:f.task.id},at:at(i*10+1),errorCode:'MODEL_INVALID_RESPONSE'};
  f.a.data.agentRuns.push({id:'extra-'+i,jobId:f.job.id,startedAt:at(i*10),steps:[step]});
 }
 if(kind==='controller_exhausted')f.job.executionState.continuation={episodes:{prior:{taskId:f.task.id,cycles:3,blocked:true}}};
 if(kind==='wrong_target')f.a.data.artifacts[0].stepId='other';
 assert.equal(rv.preview(f.a,f.job).eligibility,false);assert.throws(()=>rv.authorize(f.a,f.job,f.input()));assert.equal(rv.active(f.job),null);
});
test('same click, different command, cold restart, changed draft and implementation never renew grant',t=>{
 const f=fixture(t),g=rv.authorize(f.a,f.job,f.input());
 assert.deepEqual(rv.authorize(f.a,f.job,f.input()),g);
 f.reload();f.task.primaryArtifactId='different';f.job.executionState.workEfficiency.waitBasis='new-diagnostic';rv.active(f.job).implementationVersion='future-upgrade';f.a.save();
 const again=rv.authorize(f.a,f.job,f.input({commandId:'second',artifactId:'different'}));assert.equal(again.grantId,g.grantId);assert.equal(journal.read(f.a).events.filter(e=>e.payload.kind==='grant').length,1);
 assert.throws(()=>rv.authorize(f.a,f.job,f.input({authorizationNote:'different request'})),{code:'WORK_JOURNAL_CONFLICT'});
});
test('grant journals full legacy audit even after later explicit user requirements replace active history',t=>{
 const f=fixture(t);f.job.executionState.workEfficiency.reads={source:{ranges:[[0,15]],count:2}};f.job.executionState.workEfficiency.reading={task:{emptyReads:1}};
 const old=clone(f.job.executionState.workEfficiency),g=rv.authorize(f.a,f.job,f.input());assert.deepEqual(g.legacyWorkEfficiency,old);
 f.job.executionState.workEfficiency.history.length=0;assert.deepEqual(rv.active(f.job).legacyWorkEfficiency,old,'snapshot must not share old ledger references');
 f.job.workRevision++;f.task.workRevision++;f.task.requirementRevision='explicit-new-user-requirement';f.job.executionState.workEfficiency={intent:'new explicit requirement',history:[],tried:{}};f.a.save();f.reload();
 assert.deepEqual(rv.active(f.job).legacyWorkEfficiency,old);assert.deepEqual(journal.read(f.a).events.find(e=>e.payload.kind==='grant').payload.grant.legacyWorkEfficiency,old);
 assert.equal(rv.authorize(f.a,f.job,f.input({commandId:'later-click'})).grantId,g.grantId);assert.equal(rv.allowedAction(f.a,f.job,advance(f.task)).reason,'VALIDATION_BASIS_CHANGED');
});
test('UI revisions, caller, and audit identity are mandatory',t=>{
 const f=fixture(t);
 for(const edit of [{expectedTaskRevision:2},{expectedWorkRevision:2},{artifactId:'other'},{executedBy:'planner'},{authorizationNote:''}])assert.throws(()=>rv.authorize(f.a,f.job,f.input(edit)));
 f.a.activeAgentRun={status:'running'};assert.throws(()=>rv.authorize(f.a,f.job,f.input()),{code:'TRUSTED_UI_COMMAND_REQUIRED'});assert.equal(rv.active(f.job),null);
});
for(const kind of ['paused','revoked','budget','held','unknown_usage','uncertain','dependency'])test('admission and claim retain '+kind+' guard',t=>{
 const f=fixture(t);rv.authorize(f.a,f.job,f.input());
 if(kind==='paused')f.job.executionPaused=true;
 if(kind==='revoked')f.a.data.sources[0].accessPolicyQuarantined=true;
 if(['budget','held','unknown_usage'].includes(kind))f.a.spendLedger={scopes:{'job:job':{limitUSD:200,spentUSD:kind==='budget'?200:100,heldUSD:kind==='held'?100:0,unknownAcknowledged:0,usage:{unknownCalls:kind==='unknown_usage'?1:0,unpricedCalls:0}}}};
 if(kind==='uncertain')f.a.data.agentActions.push({id:'effect',jobId:'job',taskId:'task',status:'uncertain'});
 if(kind==='dependency')f.task.dependsOn=['unfinished'];
 const saved=JSON.stringify(f.a.spendLedger);assert.equal(rv.allowedAction(f.a,f.job,advance(f.task)).allowed,false);assert.throws(()=>rv.before(f.a,f.job,advance(f.task)));assert.equal(rv.active(f.job).claimedAttemptId,null);assert.equal(JSON.stringify(f.a.spendLedger),saved);
});
test('acknowledged historical unknown usage retains dollars without inventing an extra gate',t=>{
 const f=fixture(t);f.a.spendLedger={scopes:{'job:job':{limitUSD:200,spentUSD:157.1,heldUSD:0,unknownAcknowledged:4,usage:{unknownCalls:4,unpricedCalls:0}}}};
 const before=JSON.stringify(f.a.spendLedger);assert.equal(rv.preview(f.a,f.job).eligibility,true);claim(f);assert.equal(JSON.stringify(f.a.spendLedger),before);
});
for(const fault of ['before_append','after_append','projection','save','response'])test('durable grant fault: '+fault,t=>{
 const f=fixture(t),append=journal.append,project=journal.project,save=f.a.save;
 if(fault==='before_append')t.mock.method(journal,'append',()=>{throw Error('before append');});
 if(fault==='after_append')t.mock.method(journal,'append',(...args)=>{const receipt=append(...args);throw Object.assign(Error('after append'),{committed:true,commitReceipt:receipt});});
 // commit calls the lexical projector; a throwing executionState setter tests
 // the actual projector boundary after a durable append.
 if(fault==='projection'){const exec=f.job.executionState;Object.defineProperty(exec,'repairValidation',{configurable:true,get(){return undefined;},set(){throw Error('project');}});}
 if(fault==='save')f.a.save=()=>{throw Error('save');};
 if(fault==='response')f.a.save=function(){save.call(this);throw Error('response lost');};
 assert.throws(()=>rv.authorize(f.a,f.job,f.input()));t.mock.restoreAll();journal.project=project;f.a.save=save;
 if(fault==='before_append'){assert.equal(journal.read(f.a).events.length,0);assert.equal(rv.active(f.job),null);}
 f.a.data=JSON.parse(fs.readFileSync(f.a.file));const g=rv.authorize(f.a,f.job,f.input());assert.ok(g.grantId);assert.equal(journal.read(f.a).events.filter(e=>e.payload.kind==='grant').length,1);assert.equal(f.a.data.runtime.projectionPending,undefined);
});
test('claim survives restart, denies every second generation and allows only saved-artifact checking',t=>{
 const f=fixture(t);claim(f);f.reload();assert.equal(rv.allowedAction(f.a,f.job,advance(f.task)).reason,'CLAIMED_RESULT_UNKNOWN');assert.throws(()=>rv.before(f.a,f.job,advance(f.task)));
 savedGeneration(f);f.reload();const s={tool:'verify_content',args:{taskId:f.task.id}};assert.equal(rv.allowedAction(f.a,f.job,s).kind,'check');assert.equal(rv.allowedAction(f.a,f.job,advance(f.task)).allowed,false);
 for(const tool of ['plan_task','platform_query','read_source','revise_task'])assert.equal(rv.allowedAction(f.a,f.job,{tool,args:{taskId:f.task.id,artifactId:'generated'}}).allowed,false);
});
test('saved artifact must prove this exact claim and generation snapshot',t=>{
 const f=fixture(t);claim(f);savedGeneration(f);f.a.data.artifacts.at(-1).generationSnapshot.id='unrelated';assert.equal(rv.allowedAction(f.a,f.job,{tool:'verify_content',args:{taskId:f.task.id}}).reason,'CLAIMED_RESULT_UNKNOWN');
});
test('claim append with response loss cannot dispatch another generation after replay',t=>{
 const f=fixture(t);rv.authorize(f.a,f.job,f.input());const save=f.a.save;f.a.save=function(){save.call(this);throw Error('response lost');};assert.throws(()=>rv.before(f.a,f.job,advance(f.task)));f.a.save=save;f.reload();assert.ok(rv.active(f.job).claimedAttemptId);assert.throws(()=>rv.before(f.a,f.job,advance(f.task)));assert.equal(journal.read(f.a).events.filter(e=>e.payload.kind==='claim').length,1);
});
for(const failure of ['generation','check','hops','interruption'])test('terminal '+failure+' failure never creates another attempt',t=>{
 const f=fixture(t),s=claim(f),old=clone(f.job.executionState.workEfficiency);
 if(failure==='generation'){s.errorCode='MODEL_INVALID_RESPONSE';rv.after(f.a,f.job,s);}
 if(failure==='check'){savedGeneration(f);check(f,false);}
 if(failure==='hops')rv.finish(f.a,f.job,'PREREQUISITE_HOPS_EXHAUSTED');
 if(failure==='interruption')rv.after(f.a,f.job,s);
 f.reload();assert.equal(rv.active(f.job).outcome,'failed');assert.equal(rv.allowedAction(f.a,f.job,advance(f.task)).reason,'VALIDATION_EXHAUSTED');assert.deepEqual(f.job.executionState.workEfficiency,old);assert.equal(rv.authorize(f.a,f.job,f.input({commandId:'retry'})).outcome,'failed');
});
test('check outcome and task check commit together; replay does not erase outcome',t=>{
 const f=fixture(t);claim(f);savedGeneration(f);check(f,false);f.reload();journal.replay(f.a,{force:true});assert.equal(rv.active(f.job).outcome,'failed');assert.equal(f.task.contentVerification.passed,false);assert.equal(rv.active(f.job).knownFailures,1);
});
test('passed content permits original delivery only; final failed check cannot authorize repair',t=>{
 const f=fixture(t);claim(f);savedGeneration(f);check(f,true);f.reload();const write={tool:'write_file',args:{taskId:f.task.id}};
 assert.equal(rv.allowedAction(f.a,f.job,write).kind,'delivery');assert.equal(f.task.acceptedAt,undefined);assert.equal(rv.active(f.job).proof.complete,false);
 f.job.outputFolder+='/other';assert.equal(rv.allowedAction(f.a,f.job,write).reason,'VALIDATION_BASIS_CHANGED');f.job.outputFolder=f.dir;
 f.task.steps[1].done=true;assert.equal(rv.allowedAction(f.a,f.job,advance(f.task)).kind,'check');check(f,false,'result');f.reload();assert.equal(rv.active(f.job).committedCheckRef.phase,'final');assert.equal(rv.active(f.job).outcome,'failed');
});
test('cold journal replay lazy loads the independent grant projector',t=>{
 const f=fixture(t),before=clone(f.a.data);rv.authorize(f.a,f.job,f.input());fs.writeFileSync(f.a.file,JSON.stringify(before));
 const script=`const fs=require('node:fs');const journal=require(${JSON.stringify(require.resolve('../desktop/work-journal.cjs'))});const a={file:process.argv[1],workJournalFile:process.argv[2],data:JSON.parse(fs.readFileSync(process.argv[1])),save(){}};journal.replay(a);process.stdout.write(a.data.delegations[0].executionState.repairValidation.activeGrantId);`;
 const output=require('node:child_process').execFileSync(process.execPath,['-e',script,f.a.file,f.a.workJournalFile],{encoding:'utf8'});assert.ok(output.startsWith('repair-validation:'));
});

async function realFixture(t,{uncertain=false,failure}={}){
 const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),access=require('../desktop/access.cjs');
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'repair-validation-loop-'))),output=path.join(dir,'output');fs.mkdirSync(output);
 const denied=()=>{throw Error('No real network/planner/query in repair validation');};
 for(const [obj,key] of [[globalThis,'fetch'],[require('node:net').Socket.prototype,'connect']])t.mock.method(obj,key,denied);
 const remote={body:'原稿中保留已核实事实',revision:1},audit={generation:0,planner:0,verify:[],connector:[]},url='https://fixture.feishu.cn/docx/RepairValidation123';let seeding=true;
 const connectorRequest=async(args,options={})=>{
  audit.connector.push({args:[...args],seeding});
  if(args[1]==='status')return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'ou_validation',scope:access.scopes('my_library').join(' ')}}};
  if(args[1]==='+create'){assert.ok(seeding);remote.body=options.input;return {ok:true,data:{document:{document_id:'RepairValidation123',url}}};}
  if(args[1]==='+fetch')return {ok:true,data:{document:{content:remote.body,revision_id:remote.revision}}};
  if(args[1]==='+update'){assert.ok(!seeding);assert.ok(args.includes(url)||args.includes('RepairValidation123'));remote.body=options.input;remote.revision++;if(uncertain)throw Error('lost response after original update');return {ok:true,data:{result:'success',document:{document_id:'RepairValidation123',revision_id:remote.revision}}};}
  return denied();
 };
 const chat=async(_p,_k,m,o)=>{
  o.onUsage?.({inputTokens:10,outputTokens:5});const ctx=JSON.parse(m[1].content);
  if(m[0].content.includes('动作格式')){audit.planner++;return denied();}
  if(o.stage==='task_work'){
   if(seeding)return {kind:'artifact',title:'报告',content:remote.body};
   audit.generation++;assert.equal(audit.generation,1,'one repair maximum');assert.ok(ctx.revision?.artifactId);
   if(failure==='generation')throw require('../desktop/model-errors.cjs').modelError('MODEL_INVALID_RESPONSE','fixture invalid generation',true);
   return {kind:'patch',edits:[{before:'原稿中保留已核实事实',after:'修复稿中保留已核实事实，并明确尚缺证据的边界'}]};
  }
  if(!seeding){const phase=ctx.verificationPhase|| (m[0].content.includes('整体委托')?'goal':'final');audit.verify.push(phase);if(failure===phase)return {passed:false,summary:'fixture 仍缺真实证据',gaps:['仍缺真实证据']};}
  return {passed:true,summary:'已检查当前正文与原交付回执',gaps:[]};
 };
 const options={dir,chat,connectorRequest,webRequest:denied,platformRequest:denied,agentRequest:denied},a=new Assistant(options),instances=[a];
 t.after(()=>{for(const x of instances){require('../desktop/execution.cjs').abortAll(x);require('../desktop/deadline-scheduler.cjs').dispose(x);access.cancel(x);}fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:1,outputPrice:1});a.data.agentSettings.outputFolder=output;
 const job=agent.buildJob(a,{goal:'沿原授权修订主稿，保存文件并更新原飞书文档，回读后由用户验收',useOutputFolder:true,fileMode:'auto',autoAccept:false,maxActions:12});a.data.delegations.push(job);
 const source=agent.source(a,job,'input','原始事实','已核实事实');
 const plan={key:'report',title:'报告',sourceIds:[source.id],criteria:'原稿修复，同一文件和飞书回读后等待用户验收',steps:[{key:'draft',kind:'draft',title:'正文'},{key:'publish',kind:'external',tool:'lark_create',title:'飞书'}]};
 const planned=await agent.act(a,job,'plan_task',plan),task=a.task(planned.taskId);task.generationMode='single';await agent.act(a,job,'advance_task',{taskId:task.id});const original=task.primaryArtifactId;
 const requested=access.request(a,job,{kind:'lark_create',target:'my_library',reason:'fixture existing document'}),decision=a.data.decisions.find(d=>d.id===requested.decisionId);
 await a.dispatch('accessRetry',{id:decision.id,revision:require('../desktop/decisions.cjs').revision(a.data,decision)});await a.runPromise;
 await a.dispatch('agentLarkCreatePolicy',{id:job.id,taskId:task.id,mode:'auto',allowUpdate:true,target:job.larkCreateGrant.target,openId:job.larkCreateGrant.openId});
 await agent.act(a,job,'lark_create',{taskId:task.id});
 await agent.act(a,job,'plan_task',{...plan,existingTaskId:task.id,primaryArtifactId:original,steps:[plan.steps[0],{key:'file',kind:'external',tool:'write_file',title:'文件'},{...plan.steps[1],tool:'lark_update'}],resetSteps:['publish'],reason:'原文件和原飞书交付'});
 await agent.act(a,job,'revise_task',{taskId:task.id,artifactId:original,note:'明确原要求的事实与未知边界'});
 const old=legacy(a,job,task);old.intent=require('../desktop/work-efficiency.cjs').intent(a,job);old.version=2;old.reads={retained:'original legacy reads'};delete job.executionState.continuation;seeding=false;a.save();
 const input={id:job.id,taskId:task.id,artifactId:original,expectedWorkRevision:job.workRevision??1,expectedTaskRevision:task.workRevision??1,authorizationNote:note,executedBy:'supervisor',commandId:'integration-click'};
 const f={a,job,task,dir,output,audit,remote,input,old:clone(old),options,restart(){const b=new Assistant(options);instances.push(b);f.a=b;f.job=b.data.delegations.find(j=>j.id===job.id);f.task=b.task(task.id);return f;}};
 return f;
}
function loopDetails(f){return JSON.stringify({status:f.job.status,error:f.job.lastError,grant:rv.view(f.job).grant,steps:f.a.data.agentRuns[0]?.steps?.map(s=>({tool:s.tool,error:s.error,code:s.errorCode})),task:f.task.status,verification:f.task.verification,controller:f.job.executionState.continuation},null,2);}
test('real agent.run: one repair → independent verify → file → same Lark readback → final check → user review',async t=>{
 const f=await realFixture(t),agent=require('../desktop/agent.cjs');assert.equal(rv.preview(f.a,f.job).eligibility,true,JSON.stringify(rv.preview(f.a,f.job)));
 await f.a.dispatch('agentRepairValidation',f.input);assert.equal(f.audit.generation,0,'authorize alone must not generate');await agent.run(f.a,f.job.id);
 assert.equal(f.audit.generation,1,loopDetails(f));assert.equal(f.task.status,'review',loopDetails(f));assert.equal(rv.active(f.job).outcome,'passed',loopDetails(f));assert.equal(rv.active(f.job).committedCheckRef.phase,'final');
 assert.equal(rv.active(f.job).goalCheckRef?.passed,true,loopDetails(f));assert.equal(f.audit.planner,0);assert.equal(rv.allowedAction(f.a,f.job,{tool:'complete',args:{}}).reason,'VALIDATION_GOAL_ALREADY_CHECKED');
 const steps=f.a.data.agentRuns[0].steps.map(s=>s.tool);assert.deepEqual(steps.slice(0,5),['advance_task','verify_content','write_file','lark_update','advance_task']);assert.ok(!steps.includes('plan_task')&&!steps.includes('platform_query'));
 assert.equal(f.audit.connector.filter(c=>!c.seeding&&c.args[1]==='+update').length,1);assert.equal(f.audit.connector.filter(c=>!c.seeding&&c.args[1]==='+create').length,0);assert.ok(f.audit.connector.some(c=>!c.seeding&&c.args[1]==='+fetch'));
 assert.ok(f.remote.body.includes('修复稿'));assert.ok(fs.readdirSync(f.output).length);assert.equal(f.task.acceptedAt,undefined);
 for(const key of ['history','tried','reads'])assert.deepEqual(f.job.executionState.workEfficiency[key],f.old[key],key+' must be retained');
 assert.equal(rv.active(f.job).proof.complete,false);assert.equal(rv.active(f.job).proof.ledgerHash,hash({intent:f.old.intent,waitBasis:f.old.waitBasis,blocker:f.old.blocker,tried:f.old.tried,history:f.old.history}));
});

for(const mode of ['same','different'])test('RV2 grant → manual pause → '+mode+' command replay preserves pause and schedule',async t=>{
 const f=await realFixture(t),agent=require('../desktop/agent.cjs');await f.a.dispatch('agentRepairValidation',f.input);const original=clone(rv.active(f.job));
 await f.a.dispatch('agentPause',{id:f.job.id});const paused={status:f.job.status,executionPaused:f.job.executionPaused,nextRunAt:f.job.nextRunAt,continuation:clone(f.job.executionState.continuation)};
 f.restart();await f.a.dispatch('agentRepairValidation',{...f.input,commandId:mode==='same'?f.input.commandId:'another-click'});
 assert.equal(f.job.status,'paused');assert.equal(f.job.nextRunAt,paused.nextRunAt);assert.equal(f.job.executionPaused,paused.executionPaused);assert.deepEqual(f.job.executionState.continuation,paused.continuation);assert.deepEqual(rv.active(f.job),original);assert.equal(agent.tick(f.a),false);assert.equal(f.audit.generation,0);
 // Replaying the grant itself also cannot replace a newer manual pause.
 const event=journal.read(f.a).events.find(e=>e.type===rv.TYPE&&e.payload.kind==='grant');journal.project(f.a,{committed:true,commitId:event.commitId,sequence:event.sequence,events:[event]},{force:true});assert.equal(f.job.status,'paused');assert.equal(f.job.nextRunAt,paused.nextRunAt);
});
for(const fault of ['append','takeover','save','response'])test('RV2 '+fault+' failure → cold replay → actual tick claims and generates once',async t=>{
 const f=await realFixture(t),c=require('../desktop/continuation-control.cjs'),agent=require('../desktop/agent.cjs'),append=journal.append,save=f.a.save;
 if(fault==='append')t.mock.method(journal,'append',(...args)=>{const receipt=append(...args);throw Object.assign(Error('crash after append'),{committed:true,commitReceipt:receipt});});
 if(fault==='takeover')t.mock.method(c,'takeoverValidation',()=>{throw Error('crash before takeover');});
 if(fault==='save')f.a.save=()=>{throw Error('crash before snapshot');};
 if(fault==='response')f.a.save=function(){save.call(this);throw Error('snapshot saved, response lost');};
 assert.throws(()=>rv.authorize(f.a,f.job,f.input));t.mock.restoreAll();f.a.save=save;f.restart();
 assert.equal(f.job.status,'ready',loopDetails(f));assert.ok(f.job.nextRunAt);assert.equal(rv.active(f.job).claimedAttemptId,null);
 assert.equal(agent.tick(f.a),true,loopDetails(f));await f.a.runPromise;
 assert.equal(f.audit.generation,1,loopDetails(f));assert.equal(f.audit.planner,0);assert.equal(f.task.status,'review',loopDetails(f));
 const events=journal.read(f.a).events.filter(e=>e.type===rv.TYPE);assert.equal(events.filter(e=>e.payload.kind==='grant').length,1);assert.equal(events.filter(e=>e.payload.kind==='claim').length,1);assert.equal(agent.tick(f.a),false);assert.equal(f.audit.generation,1);
});
test('RV2 unprojected grant replay respects a newer paused snapshot',async t=>{
 const f=await realFixture(t),append=journal.append;
 t.mock.method(journal,'append',(...args)=>{const receipt=append(...args);throw Object.assign(Error('crash'),{committed:true,commitReceipt:receipt});});assert.throws(()=>rv.authorize(f.a,f.job,f.input));t.mock.restoreAll();
 const disk=JSON.parse(fs.readFileSync(f.a.file));const j=disk.delegations.find(j=>j.id===f.job.id);j.status='paused';j.executionPaused=true;j.nextRunAt=null;fs.writeFileSync(f.a.file,JSON.stringify(disk));f.restart();
 assert.equal(f.job.status,'paused');assert.equal(f.job.nextRunAt,null);assert.equal(rv.active(f.job).takeoverPending,true);assert.equal(require('../desktop/agent.cjs').tick(f.a),false);assert.equal(f.audit.generation,0);
 await f.a.dispatch('agentRepairValidation',{...f.input,commandId:'paused-retry'});assert.equal(f.job.status,'paused');assert.equal(f.job.nextRunAt,null);
});
test('RV1 real whole-goal failure never escapes to planner or another repair, including cold tick',async t=>{
 const f=await realFixture(t,{failure:'goal'}),agent=require('../desktop/agent.cjs');await f.a.dispatch('agentRepairValidation',f.input);await agent.run(f.a,f.job.id);
 assert.equal(f.audit.generation,1,loopDetails(f));assert.equal(f.audit.planner,0);assert.equal(f.audit.verify.filter(p=>p==='goal').length,1);assert.equal(rv.active(f.job).goalCheckRef?.passed,false,loopDetails(f));assert.equal(rv.active(f.job).outcome,'failed');assert.equal(f.job.status,'blocked');assert.equal(f.task.acceptedAt,undefined);
 f.restart();assert.equal(agent.tick(f.a),false);await agent.run(f.a,f.job.id);assert.equal(f.audit.generation,1);assert.equal(f.audit.planner,0);assert.equal(f.job.status,'blocked');assert.equal(rv.active(f.job).proof.complete,false);
});
test('RV1 completion journal append before projector crash replays goal failure and grant atomically',async t=>{
 const f=await realFixture(t),agent=require('../desktop/agent.cjs'),acceptance=require('../desktop/acceptance.cjs');f.job.maxActions=5;await f.a.dispatch('agentRepairValidation',f.input);await agent.run(f.a,f.job.id);
 assert.equal(f.task.status,'review',loopDetails(f));assert.equal(rv.active(f.job).goalCheckRef,null);const basis=acceptance.completionBasis(f.a,f.job),append=journal.append;
 t.mock.method(journal,'append',(...args)=>{const receipt=append(...args);throw Object.assign(Error('crash after goal check append'),{committed:true,commitReceipt:receipt});});
 assert.throws(()=>acceptance.recordCompletionCheck(f.a,f.job,{passed:false,summary:'整体缺口仍存在',gaps:['整体缺口']},{basis}));t.mock.restoreAll();f.restart();
 assert.equal(f.job.completionCheck.passed,false);assert.equal(rv.active(f.job).goalCheckRef.passed,false);assert.equal(rv.active(f.job).outcome,'failed');assert.equal(f.job.status,'blocked');assert.equal(agent.tick(f.a),false);assert.equal(f.audit.generation,1);assert.equal(f.audit.planner,0);
});
test('real uncertain delivery preserves passed repair, reconciles original action read-only, then final check',async t=>{
 const f=await realFixture(t,{uncertain:true}),agent=require('../desktop/agent.cjs');await f.a.dispatch('agentRepairValidation',f.input);await agent.run(f.a,f.job.id);
 const action=f.a.data.agentActions.find(r=>r.tool==='lark_update');assert.equal(action?.status,'uncertain',loopDetails(f));assert.equal(rv.active(f.job).outcome,'passed',loopDetails(f));assert.equal(f.audit.generation,1);
 const id=action.id;f.restart();await agent.run(f.a,f.job.id);
 assert.equal(f.a.data.agentActions.find(r=>r.id===id).status,'done',loopDetails(f));assert.equal(f.task.status,'review',loopDetails(f));assert.equal(rv.active(f.job).committedCheckRef.phase,'final');assert.equal(rv.active(f.job).outcome,'passed');
 assert.equal(f.audit.connector.filter(c=>!c.seeding&&c.args[1]==='+update').length,1);assert.equal(f.audit.generation,1);assert.equal(f.a.data.agentActions.filter(r=>r.tool==='lark_update').length,1);assert.equal(f.task.acceptedAt,undefined);
});
for(const failure of ['generation','content','final'])test('real agent '+failure+' failure terminates grant and does not autoRepair after restart',async t=>{
 const f=await realFixture(t,{failure}),agent=require('../desktop/agent.cjs');await f.a.dispatch('agentRepairValidation',f.input);await agent.run(f.a,f.job.id);
 assert.equal(rv.active(f.job).outcome,'failed',loopDetails(f));assert.equal(f.audit.generation,1,loopDetails(f));assert.notEqual(f.task.status,'review');
 f.restart();await agent.run(f.a,f.job.id);assert.equal(f.audit.generation,1);assert.equal(rv.active(f.job).outcome,'failed');assert.equal(f.task.acceptedAt,undefined);
});
for(const saved of [false,true])test('real agent cold restart after claim '+(saved?'with saved artifact continues checking':'without saved artifact never regenerates'),async t=>{
 const f=await realFixture(t),agent=require('../desktop/agent.cjs'),c=require('../desktop/continuation-control.cjs');await f.a.dispatch('agentRepairValidation',f.input);
 const step=advance(f.task);c.started(f.a,f.job,step);f.a.save();
 if(saved){step.result=await agent.act(f.a,f.job,'advance_task',{taskId:f.task.id});f.a.save();assert.equal(f.audit.generation,1);}
 f.restart();await agent.run(f.a,f.job.id);
 assert.equal(f.audit.generation,saved?1:0,loopDetails(f));assert.equal(f.task.status,saved?'review':'todo',loopDetails(f));assert.equal(rv.active(f.job).outcome,saved?'passed':'failed',loopDetails(f));
});

test('authorized retained legacy input can be read without becoming remote-identity proof',async t=>{
 const f=await realFixture(t),s=f.a.data.sources.find(s=>s.id===f.task.sourceIds[0]);
 s.platformSnapshot=true;delete s.platformPrincipal;f.job.platformPrincipal='current-platform-account';
 assert.equal(require('../desktop/relation-obligations.cjs').sourceRows(f.a,f.job,f.task,[s.id]).length,0,'unknown original remote identity cannot close typed obligations');
 assert.equal(rv.preview(f.a,f.job).eligibility,true,'existing local read ACL may still allow revision from retained history');
 const policy=require('../desktop/access-policy-store.cjs');
 const local=require('../desktop/task-context.cjs').buildContext(f.a,require('../desktop/task-context.cjs').taskScope(f.task));
 assert.ok(local.readableCatalog.some(r=>r.id===s.id&&r.purpose==='input'&&!r.ambiguous));
 policy.revoke(f.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+s.id,jobId:f.job.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'test_revoke'});
 assert.equal(rv.preview(f.a,f.job).eligibility,false,'revoked authoritative local read permission remains guarded');
});

const policy=require('../desktop/execution-policy.cjs');
function unknownClaimSetup(t){const f=fixture(t);claim(f);return f;}
function outcomeEvents(f){return journal.read(f.a).events.filter(e=>e.type===rv.TYPE&&e.payload.kind==='failed');}
test('policy settles only the original consumed unknown claim once and preserves history after replay',t=>{
 const f=unknownClaimSetup(t),g=clone(rv.active(f.job)),episode=clone(f.job.executionState.continuation),old=clone(f.job.executionState.workEfficiency),data=JSON.stringify(f.a.data);
 const p=policy.inspect(f.a,f.job);assert.equal(p.commands[0]?.command,'validation_finish',JSON.stringify(p));assert.equal(p.eligible,false);assert.equal(JSON.stringify(f.a.data),data);
 assert.equal(policy.prepare(f.a,f.job).eligible,false);assert.equal(rv.active(f.job).outcome,'failed');assert.equal(rv.active(f.job).outcomeReason,'CLAIMED_RESULT_UNKNOWN');
 assert.equal(rv.active(f.job).claimedAttemptId,g.claimedAttemptId);assert.deepEqual(rv.active(f.job).claim,g.claim);assert.deepEqual(f.job.executionState.continuation,episode);assert.deepEqual(f.job.executionState.workEfficiency,old);
 const finished=JSON.stringify(f.a.data);assert.equal(policy.prepare(f.a,f.job).changed,false);assert.equal(JSON.stringify(f.a.data),finished);f.reload();policy.prepare(f.a,f.job);assert.equal(outcomeEvents(f).length,1);assert.deepEqual(rv.active(f.job).claim,g.claim);
});
for(const guard of ['paused','conflict','budget','revision','handoff','passed','wrongEpisode','wrongClaim','saved'])test('unknown claim settlement retains '+guard+' boundary',t=>{
 const f=unknownClaimSetup(t),g=rv.active(f.job),e=f.job.executionState.continuation.episodes['validation:'+g.grantIdentity];
 if(guard==='paused')f.a.data.stewardship={paused:true};
 if(guard==='conflict')f.a.executions=new Map([['other',{jobId:f.job.id,key:'other'}]]);
 if(guard==='budget')f.a.spendLedger={scopes:{'job:job':{limitUSD:200,spentUSD:200,heldUSD:0,usage:{unknownCalls:0,unpricedCalls:0}}}};
 if(guard==='revision')f.job.workRevision++;
 if(guard==='handoff')f.job.executionState.continuation.validationHandoffs={[g.grantId]:{appliedAt:at(200)}};
 if(guard==='passed')g.outcome='passed';
 if(guard==='wrongEpisode')e.validationGrantId='other';
 if(guard==='wrongClaim')g.claimedAttemptId='other';
 if(guard==='saved')savedGeneration(f);
 f.a.save();const data=JSON.stringify(f.a.data),disk=fs.readFileSync(f.a.file),log=fs.readFileSync(f.a.workJournalFile),ledger=JSON.stringify(f.a.spendLedger);
 assert.notEqual(policy.inspect(f.a,f.job).commands[0]?.command,'validation_finish');
 if(['paused','conflict','budget','revision','passed','wrongEpisode','wrongClaim'].includes(guard)){policy.prepare(f.a,f.job);assert.equal(JSON.stringify(f.a.data),data);assert.deepEqual(fs.readFileSync(f.a.file),disk);assert.deepEqual(fs.readFileSync(f.a.workJournalFile),log);}
 assert.equal(outcomeEvents(f).length,0);assert.equal(JSON.stringify(f.a.spendLedger),ledger);
 if(guard==='saved')assert.equal(policy.prepare(f.a,f.job).action?.tool,'verify_content');
});
for(const fault of ['before_append','after_append','save','response'])test('unknown claim durable settlement recovers '+fault+' without another claim',t=>{
 const f=unknownClaimSetup(t),claimBefore=clone(rv.active(f.job).claim),old=clone(f.job.executionState.workEfficiency),save=f.a.save,append=journal.append;
 if(fault==='before_append')t.mock.method(journal,'append',()=>{throw Error('before append');});
 if(fault==='after_append')t.mock.method(journal,'append',(...args)=>{const receipt=append(...args);throw Object.assign(Error('after append'),{committed:true,commitReceipt:receipt});});
 if(fault==='save')f.a.save=()=>{throw Error('save');};
 if(fault==='response')f.a.save=function(){save.call(this);throw Error('response lost');};
 assert.throws(()=>policy.prepare(f.a,f.job));t.mock.restoreAll();f.a.save=save;f.reload();policy.prepare(f.a,f.job);
 assert.equal(outcomeEvents(f).length,1);assert.equal(rv.active(f.job).outcome,'failed');assert.deepEqual(rv.active(f.job).claim,claimBefore);assert.deepEqual(f.job.executionState.workEfficiency,old);
 assert.equal(journal.read(f.a).events.filter(e=>e.payload.kind==='claim').length,1);
});
