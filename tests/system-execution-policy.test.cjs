'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const policy=require('../desktop/execution-policy.cjs'),facts=require('../desktop/execution-facts.cjs'),cont=require('../desktop/continuation-control.cjs'),strategy=require('../desktop/strategy-recovery.cjs'),work=require('../desktop/work-state.cjs'),control=require('../desktop/execution-control.cjs'),journal=require('../desktop/work-journal.cjs');
const denied=()=>{throw Error('No live network/model in policy tests');};
function fixture(t,{two=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'system-policy-'));
 const a=new Assistant({dir,chat:denied,connectorRequest:denied,webRequest:denied,agentRequest:denied});
 t.after(async()=>{require('../desktop/execution.cjs').abortAll(a);await a.runPromise;require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{force:true,recursive:true});});
 a.data.providers.push({id:'test',model:'test',type:'openai',baseUrl:'https://test.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'test',execute:'test',verify:'test'};
 const job=agent.buildJob(a,{goal:'核对两个独立事实',maxActions:1,autoAccept:false});a.data.delegations.push(job);
 const make=name=>{const task=a.createTask({title:name,criteria:'遵循原事实',steps:[{key:'draft',kind:'draft',title:'原稿'}]});task.agentJobId=job.id;task.agentKey=name;task.steps[0].key='draft';job.taskIds.push(task.id);return task;};
 const A=make('A'),B=two?make('B'):null;a.save();return {a,job,A,B,dir};
}
function own(f,t){const s={tool:'plan_task',args:{existingTaskId:t.id}};assert.equal(cont.redirect(f.a,f.job,s,{code:'PLAN_ALREADY_RECONCILED',taskId:t.id,message:'已提交计划'}),true);return cont.episode(f.a,f.job,t);}
function freeze(value,seen=new Set()){if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);for(const v of Object.values(value))freeze(v,seen);Object.freeze(value);}
function files(f){return Object.fromEntries(fs.readdirSync(f.dir).filter(n=>fs.statSync(path.join(f.dir,n)).isFile()).map(n=>[n,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(f.dir,n))).digest('hex')]));}
function exhaustA(f){const e=own(f,f.A);e.blocked=true;e.cycles=3;e.reason='A 的未满足义务仍缺明确事实';f.job.status='blocked';f.job.nextRunAt=null;f.job.executionState.workEfficiency={version:2,phase:'awaiting_change',attempts:18,history:[{id:'old',outcome:'no_progress'}],tried:{old:{at:'old'}},reading:{[f.A.id]:{batches:9}},lastFailure:{code:'CONTINUATION_EXHAUSTED',message:e.reason,taskId:f.A.id,scope:'task'}};return e;}

test('P1-01: frozen inspect/UI/peek never call command probes, initialize ledger, consume forcedNext or write requirements',t=>{
 const f=fixture(t);f.job.dataPlatform='sg-readonly';delete f.job.executionState;
 const before=JSON.stringify(f.a.data),disk=files(f),ledger=JSON.stringify(f.a.spendLedger);
 for(const [obj,keys] of [[cont,['next','refresh','migrate']],[strategy,['ready','begin','next']],[require('../desktop/work-efficiency.cjs'),['sync','before']],[require('../desktop/work-obligations.cjs'),['requirements']]])for(const k of keys)t.mock.method(obj,k,()=>{throw Error('impure '+k);});
 f.a.save=denied;f.a.event=denied;freeze(f.a.data);
 for(let i=0;i<3;i++){const p=policy.inspect(f.a,f.job,{now:Date.now()});assert.ok(p.action);assert.equal(work.view(f.a,f.job).executionPolicy.reasonCode,policy.inspect(f.a,f.job).reasonCode);cont.inspect(f.a,f.job,f.A);strategy.inspect(f.a,f.job);control.peek(f.a,f.job);}
 assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(files(f),disk);assert.equal(JSON.stringify(f.a.spendLedger),ledger);
});

test('P1-01: forced action and stale review are read-only; prepare consumes neither dispatch nor budget',t=>{
 const f=fixture(t);f.job.executionState={forcedNext:{tool:'advance_task',args:{taskId:f.A.id}},recoveries:{}};
 const before=JSON.stringify(f.a.data);assert.equal(policy.inspect(f.a,f.job).action.forced,true);assert.equal(JSON.stringify(f.a.data),before);
 f.A.status='review';f.A.verification={passed:true,basis:'old'};delete f.job.executionState.forcedNext;
 const old=JSON.stringify(f.a.data);assert.equal(policy.inspect(f.a,f.job).phase,'prepare_pending');assert.equal(JSON.stringify(f.a.data),old);
 assert.equal(policy.prepare(f.a,f.job).eligible,true);assert.equal(f.A.status,'todo');assert.equal(f.A.verification,null);assert.equal(f.job.callsUsed,0);
});

for(const [label,change,reason] of [
 ['job pending',f=>f.job.projectionPending={},'projection_pending'],['task pending',f=>f.A.projectionPending={},'projection_pending'],
 ['workspace pending',f=>f.a.data.runtime.projectionPending={},'projection_pending'],['nested journal pending',f=>f.a.data.runtime.workJournal.projectionPending={},'projection_pending'],
 ['permission projection',f=>f.a.data.runtime.accessPolicyProjectionPending={},'projection_pending'],['storage failure',f=>f.a.data.runtime.workJournalError={message:'disk'},'storage'],
 ['global pause',f=>f.a.data.stewardship.paused=true,'workspace_paused'],['job pause',f=>f.job.executionPaused=true,'paused'],['sleep',f=>f.a.suspended=true,'suspended'],
 ['terminal',f=>f.job.status='completed','terminal'],['source cursor',f=>f.a.data.connectors.push({id:'sync',jobId:f.job.id,cursor:{token:'pending'}}),'source_batch_pending']
])test('P1-02: '+label+' refuses UI/tick/prepare with zero commands',t=>{
 const f=fixture(t);own(f,f.A);change(f);const before=JSON.stringify(f.a.data),disk=files(f),p=policy.inspect(f.a,f.job);
 assert.equal(p.eligible,false);assert.equal(facts.gate(f.a,f.job,label==='task pending'?f.A:null).reason,reason);
 assert.equal(work.view(f.a,f.job).executionPolicy.reasonCode,p.reasonCode);assert.equal(policy.prepare(f.a,f.job).eligible,false);assert.equal(agent.tick(f.a),false);
 assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(files(f),disk);
});

test('P1-02: manual mode retains global pause/window semantics; task pause always wins',t=>{
 const f=fixture(t);f.a.data.stewardship.paused=true;
 assert.equal(policy.inspect(f.a,f.job).eligible,false);assert.equal(policy.inspect(f.a,f.job,{mode:'manual'}).eligible,true);
 assert.equal(facts.gate(f.a,f.job,null,{automatic:false}).automaticAllowed,true);
 f.A.status='paused';assert.equal(policy.inspect(f.a,f.job,{mode:'manual'}).eligible,false);
});

test('P1-02/P1-05: live same-job/shared-project executions beat preparation and unresolved effects; only authenticated self is excluded',t=>{
 const f=fixture(t);f.job.projectId='p';f.a.data.projects.push({id:'p'});f.A.projectId='p';
 const c=new AbortController(),row={key:'job:'+f.job.id,jobId:f.job.id,projectId:'p',context:{controller:c}};f.a.executions.set(row.key,row);
 f.job.outputFolder='/original';f.a.data.agentActions.push({id:'u',jobId:f.job.id,taskId:f.A.id,status:'uncertain',tool:'write_file',target:'/original/target'});const access=require('../desktop/access-policy-store.cjs');for(const r of access.requestsForTool(f.a,f.job,'prepare_write_file',{}, {taskId:f.A.id}))access.grant(f.a,{principalScope:r.principalScope,resourceScope:r.resourceScope,operations:[r.operation]},{trusted:true,actor:'user_command',command:'policy-test-read-grant'});
 const before=JSON.stringify(f.a.data);assert.equal(policy.inspect(f.a,f.job).phase,'running');assert.equal(policy.inspect(f.a,f.job,{currentExecutionId:row.key}).phase,'running');assert.equal(policy.prepare(f.a,f.job).changed,false);assert.equal(JSON.stringify(f.a.data),before);
 f.a.controller=c;assert.equal(policy.inspect(f.a,f.job,{currentExecutionId:row.key}).mode,'reconcile_existing');
 f.a.executions.clear();f.a.executions.set('other',{key:'other',jobId:'other',projectId:'p',context:{controller:new AbortController()}});assert.equal(policy.inspect(f.a,f.job).reasonCode,'EXECUTION_CONFLICT');f.a.executions.clear();
});

test('P1-04: exhausted A cannot veto independent B or donate/reset its counters',async t=>{
 const f=fixture(t,{two:true}),e=exhaustA(f),before=JSON.stringify(e),legacy=structuredClone(f.job.executionState.workEfficiency);
 const p=policy.inspect(f.a,f.job);assert.equal(p.phase,'prepare_pending');assert.deepEqual(p.taskIds,[f.B.id]);assert.equal(JSON.stringify(e),before);
 assert.equal(policy.prepare(f.a,f.job).eligible,true);assert.equal(f.job.executionState.continuation.activeTaskId,f.B.id);assert.equal(cont.ready(f.a,f.job,{taskId:f.A.id}),false);assert.equal(cont.ready(f.a,f.job,{taskId:f.B.id}),true);
 assert.equal(JSON.stringify(e),before);for(const k of ['attempts','tried','history','reading'])assert.deepEqual(f.job.executionState.workEfficiency[k],legacy[k]);
 f.a.chat=async(_p,_k,_m,o)=>{o.onUsage({inputTokens:1,outputTokens:1});return {kind:'artifact',title:'B',content:'B 的独立结果'};};
 assert.equal(agent.tick(f.a),true);assert.equal(agent.tick(f.a),false);await f.a.runPromise;
 assert.equal(f.A.steps[0].done,false);assert.equal(f.B.steps[0].done,true);assert.equal(JSON.stringify(e),before);assert.equal(f.job.executionState.workEfficiency.attempts,18);
});

test('P1-04: dependency/resource/job-scoped legacy blockers continue to block B',t=>{
 for(const type of ['dependency','resource','job']){const f=fixture(t,{two:true});exhaustA(f);
  if(type==='dependency')f.B.dependsOn=[f.A.id];
  if(type==='resource'){f.B.steps[0].resourceKey='shared';f.job.followups.push({key:'shared',status:'waiting',scope:'resource',resourceKey:'shared'});}
  if(type==='job'){f.job.executionState.workEfficiency.lastFailure={code:'UNKNOWN_LEGACY_JOB_FAILURE',scope:'job',message:'历史不能分配到任务'};f.job.executionState.workEfficiency.waitBasis=strategy.inputBasis(f.a,f.job);}
  assert.equal(policy.prepare(f.a,f.job).eligible,false,type);assert.equal(f.B.steps[0].done,false);
 }
});

test('P1-04: two legal episodes select in stable task order and preserve the other owner',t=>{
 const f=fixture(t,{two:true}),a=own(f,f.A),b=own(f,f.B),before=JSON.stringify(b);
 assert.equal(f.job.executionState.continuation.activeTaskId,f.B.id);assert.equal(policy.inspect(f.a,f.job).reasonCode,'OWNER_SELECTION');
 policy.prepare(f.a,f.job);assert.equal(f.job.executionState.continuation.activeTaskId,f.A.id);assert.equal(JSON.stringify(b),before);assert.equal(a.cycles,0);
 const disk=files(f),state=JSON.stringify(f.a.data);assert.equal(policy.prepare(f.a,f.job).changed,false);assert.deepEqual(files(f),disk);assert.equal(JSON.stringify(f.a.data),state);
});

test('P1-02: revision race and append failure never publish an owner; committed save failure fences dispatch and replays once',t=>{
 const f=fixture(t,{two:true});own(f,f.A);own(f,f.B);
 assert.throws(()=>policy.prepare(f.a,f.job,{expectedRevision:-1}),{code:'STATE_STALE'});
 const before=JSON.stringify(f.a.data),original=journal.append;
 journal.append=()=>{throw Error('append failed');};try{assert.throws(()=>policy.prepare(f.a,f.job),/append failed/);assert.equal(JSON.stringify(f.a.data),before);}finally{journal.append=original;}
 const save=f.a.save;f.a.save=()=>{throw Error('projection save failed');};
 try{assert.throws(()=>policy.prepare(f.a,f.job),e=>e.committed&&e.projectionPending);}finally{f.a.save=save;}
 assert.equal(policy.inspect(f.a,f.job).eligible,false);assert.equal(agent.tick(f.a),false);const count=journal.read(f.a).events.length;
 journal.replay(f.a);assert.equal(policy.prepare(f.a,f.job).eligible,true);assert.equal(journal.read(f.a).events.length,count);
 const b=new Assistant({dir:f.dir,chat:denied}),job=b.data.delegations.find(j=>j.id===f.job.id);assert.equal(policy.prepare(b,job).eligible,true);assert.equal(journal.read(b).events.length,count);require('../desktop/deadline-scheduler.cjs').dispose(b);
});

test('P1-05: all four action classes preserve original identity; only reconcile may bypass budget',t=>{
 const f=fixture(t);f.job.outputFolder='/original';const action={id:'original-operation',jobId:f.job.id,taskId:f.A.id,tool:'write_file',status:'pending',target:'/original/target',version:'original-version'};f.job.fileMode='ask';f.a.data.agentActions.push(action);f.job.pendingActionId=action.id;
 assert.equal(policy.inspect(f.a,f.job).mode,'await_approval');action.approvedAt='approved';const access=require('../desktop/access-policy-store.cjs');for(const r of access.requestsForTool(f.a,f.job,'prepare_write_file',{}, {taskId:f.A.id}))access.grant(f.a,{principalScope:r.principalScope,resourceScope:r.resourceScope,operations:[r.operation]},{trusted:true,actor:'user_command',command:'policy-test-read-grant'});require('../desktop/protocol-access.cjs').authorizeAction(f.a,action);
 assert.equal(policy.inspect(f.a,f.job).mode,'execute_approved_existing');f.job.limitReason='budget';assert.equal(policy.inspect(f.a,f.job).eligible,false);
 for(const status of ['uncertain','running']){action.status=status;const p=policy.inspect(f.a,f.job);assert.equal(p.mode,'reconcile_existing');assert.equal(p.eligible,true);assert.equal(p.action.actionId,action.id);assert.equal(p.action.target,action.target);assert.equal(p.action.version,action.version);}
 f.a.data.stewardship.paused=true;assert.equal(policy.inspect(f.a,f.job).eligible,false);
});

test('D09/D10: no phantom running or planner spin for waiting, accepted or unowned blocked work',t=>{
 const f=fixture(t);f.A.status='waiting';f.job.status='running';assert.equal(policy.inspect(f.a,f.job).eligible,false);assert.notEqual(work.view(f.a,f.job).phase,'running');
 f.A.status='blocked';f.job.status='blocked';assert.equal(policy.inspect(f.a,f.job).eligible,false);
 f.job.status='completed';f.A.status='completed';assert.equal(policy.prepare(f.a,f.job).eligible,false);assert.equal(f.job.callsUsed,0);
});

test('D10: watcher and retry times use the same policy; deadline cannot bypass retry',t=>{
 const f=fixture(t),now=Date.now();f.A.status='waiting';f.job.status='watching';f.job.watchers=[{key:'watch',tool:'read_url',args:{url:'https://test.invalid'}}];f.job.nextRunAt=new Date(now+60000).toISOString();
 assert.equal(policy.inspect(f.a,f.job,{now}).reasonCode,'NOT_DUE');assert.equal(policy.inspect(f.a,f.job,{now:now+60001}).mode,'watch');
 f.job.status='retry';f.a.data.deadlineState={wakeIntents:{x:{id:'x',status:'pending',jobId:f.job.id,taskId:f.A.id}}};assert.equal(policy.inspect(f.a,f.job,{now}).reasonCode,'NOT_DUE');
});

test('D02: real permission/model/budget/window guards compose before preparation and keep usage unchanged',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-17T12:00:00Z')});
 for(const kind of ['model','permission','budget','unknown','window']){
  const f=fixture(t),eff=require('../desktop/work-efficiency.cjs');eff.request(f.a,f.job,{code:'CONTEXT_INVALID_REQUEST',taskId:f.A.id,message:'已保存资料需要切换读取方式'});
  if(kind==='model')f.a.data.settings.roles.execute='missing';
  if(kind==='permission'){const access=require('../desktop/access-policy-store.cjs');access.revoke(f.a,{principalScope:access.LOCAL,resourceScope:{kind:'model',key:'app',jobId:f.job.id},operations:['model','model_request']},{trusted:true,actor:'user_command',command:'policy-test-revoke'});}
  if(['budget','unknown'].includes(kind)){const spend=require('../desktop/spend.cjs');f.a.activeAgentJob=f.job;const account=spend.scope(f.a);f.a.activeAgentJob=null;if(kind==='budget')Object.assign(account,{spentUSD:99,heldUSD:1});else account.unreservedCalls=1;spend.persist(f.a);}
  if(kind==='window'){f.a.data.stewardship.timeZone='UTC';f.a.data.stewardship.weekdays=[1,2,3,4,5,6,7];f.a.data.stewardship.window={enabled:true,start:'01:00',end:'02:00'};}
  const before=JSON.stringify(f.a.data),disk=files(f),spend=JSON.stringify(f.a.spendLedger),p=policy.inspect(f.a,f.job);
  assert.equal(p.eligible,false,kind);assert.equal(p.commands.length,0,kind);assert.equal(work.view(f.a,f.job).executionPolicy.reasonCode,p.reasonCode);assert.equal(policy.prepare(f.a,f.job).changed,false);assert.equal(agent.tick(f.a),false);
  f.a.automaticExecution=true;await agent.run(f.a,f.job.id);assert.equal(f.job.callsUsed,0);assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(files(f),disk);assert.equal(JSON.stringify(f.a.spendLedger),spend);
  f.a.data.stewardship.paused=true;assert.equal(policy.inspect(f.a,f.job).reasonCode,'workspace_paused',kind+' plus pause must classify guard first');
  if(kind==='window'){f.a.data.stewardship.paused=false;assert.equal(policy.inspect(f.a,f.job,{mode:'manual'}).eligible,false,'a legitimate recovery still needs prepare');assert.equal(policy.inspect(f.a,f.job,{mode:'manual'}).commands[0].command,'strategy_begin');}
 }
});

test('D07: ordinary recovery passes pure policy, durable preparation, real tick and the chosen task worker',async t=>{
 const f=fixture(t),eff=require('../desktop/work-efficiency.cjs');f.A.steps.push({id:'delivery',kind:'external',tool:'write_file',done:false});eff.request(f.a,f.job,{code:'CONTEXT_INVALID_REQUEST',taskId:f.A.id,message:'原文已保存，停止反复读取'});
 const old=f.job.executionState.workEfficiency;old.attempts=17;old.tried.historical={title:'旧失败路径',at:'old'};old.reading={[f.A.id]:{batches:9}};
 const before=JSON.stringify(f.a.data),p=policy.inspect(f.a,f.job);assert.equal(p.eligible,false);assert.equal(p.phase,'recovery_pending');assert.equal(p.commands[0].command,'strategy_begin');assert.equal(JSON.stringify(f.a.data),before);
 const prepared=policy.prepare(f.a,f.job);assert.equal(prepared.eligible,true);assert.equal(prepared.owner.kind,'strategy');assert.equal(prepared.action.tool,'advance_task');assert.equal(old.attempts,17);assert.equal(old.reading[f.A.id].batches,9);assert.ok(old.tried.historical);
 const events=journal.read(f.a).events.filter(e=>e.type===policy.TYPE);assert.equal(events.filter(e=>e.payload.command==='strategy_begin').length,1);const count=events.length;assert.equal(policy.prepare(f.a,f.job).changed,false);assert.equal(journal.read(f.a).events.filter(e=>e.type===policy.TYPE).length,count);
 let requests=0;f.a.chat=async(_p,_k,m,o)=>{requests++;assert.equal(o.stage,'task_work');o.onUsage({inputTokens:3,outputTokens:2});return {kind:'artifact',title:'原稿',content:'沿原要求写成的实际正文'};};
 assert.equal(agent.tick(f.a),true);await f.a.runPromise;assert.equal(requests,1);assert.equal(f.A.steps[0].done,true);assert.equal(f.a.data.artifacts.find(r=>r.id===f.A.steps[0].artifactId).content,'沿原要求写成的实际正文');assert.ok(old.tried.historical);assert.equal(f.a.data.agentRuns[0].steps[0].tool,'advance_task');
});

test('L03: exhausted methods expose the specific unmet obligation and retry conditions without polling or invented readiness',t=>{
 const f=fixture(t),eff=require('../desktop/work-efficiency.cjs');f.A.contentVerification={passed:false,gaps:['缺少订单表写入链路的原始证据'],summary:'需要真实写入链路证据',basis:'checked'};
 eff.request(f.a,f.job,{code:'EVIDENCE_REQUIRED',taskId:f.A.id,message:'缺少订单表写入链路的原始证据'});const s=f.job.executionState.workEfficiency,basis=strategy.inputBasis(f.a,f.job);
 for(const method of [...strategy.candidates(f.a,f.job),{id:'replan',title:'重新诊断并选择其他工具'}])s.tried[basis+':'+method.id]={at:'old',title:method.title};
 s.history=[{title:'复用材料直接完成当前步骤',outcome:'no_progress'},{title:'重新诊断并选择其他工具',outcome:'no_progress'}];s.attempts=18;f.job.status='ready';
 assert.equal(policy.inspect(f.a,f.job).commands[0].command,'strategy_exhausted');assert.equal(policy.prepare(f.a,f.job).eligible,false);
 const p=policy.inspect(f.a,f.job);assert.equal(p.phase,'blocked');assert.ok(p.diagnostics.unmetObligations.some(o=>o.taskId===f.A.id&&o.text==='缺少订单表写入链路的原始证据'));assert.ok(p.diagnostics.attemptedMethods.includes('复用材料直接完成当前步骤'));assert.match(p.diagnostics.lastFailure.message,/写入链路/);assert.ok(p.diagnostics.retryConditions.some(c=>c.includes('相关的新事实')));assert.match(f.job.summary,/已尝试.*最后原因.*新的相关事实/);
 const before=JSON.stringify(f.a.data),disk=files(f);for(let i=0;i<4;i++){assert.equal(agent.tick(f.a),false);assert.equal(policy.prepare(f.a,f.job).changed,false);assert.equal(work.view(f.a,f.job).phase,'blocked');}assert.equal(f.job.callsUsed,0);assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(files(f),disk);
});

test('P1-04: suspended read failure uses an upgraded local method once under the original owner and counters',t=>{
 const f=fixture(t);f.A.steps[0].done=true;f.A.steps[0].artifactId='primary';f.A.primaryArtifactId='primary';f.a.data.artifacts.push({id:'primary',taskId:f.A.id,stepId:f.A.steps[0].id,content:'已保存且不能重生成的原稿',role:'primary'});f.A.steps.push({id:'delivery',kind:'external',tool:'write_file',done:false});
 const e=own(f,f.A);e.cycles=1;e.hops=1;e.suspendedBy={code:'CONTEXT_INVALID_REQUEST',message:'读取循环已让出控制',at:'old'};f.job.executionState.continuation.activeTaskId=null;
 const eff=require('../desktop/work-efficiency.cjs');eff.request(f.a,f.job,{code:'RECOVERY_ROUTE_REPEATED',taskId:f.A.id,message:'原读取路径重复'});const s=f.job.executionState.workEfficiency;s.phase='awaiting_change';s.attempts=17;s.waitBasis=strategy.inputBasis(f.a,f.job);s.reading={[f.A.id]:{ineffective:5,batches:8}};s.tried.historical={title:'旧方法',at:'old'};f.job.inputRecovery={used:1};f.job.status='blocked';
 const prior=structuredClone({cycles:e.cycles,hops:e.hops,reading:s.reading,input:f.job.inputRecovery}),before=JSON.stringify(f.a.data),p=policy.inspect(f.a,f.job);assert.equal(p.commands[0].command,'continuation_read_resume');assert.equal(JSON.stringify(f.a.data),before);
 const ready=policy.prepare(f.a,f.job);assert.equal(ready.eligible,true);assert.equal(ready.action.tool,'verify_content');assert.equal(f.job.executionState.continuation.activeBasis,e.basis);assert.equal(s.attempts,17);assert.deepEqual({cycles:e.cycles,hops:e.hops,reading:s.reading,input:f.job.inputRecovery},prior);assert.ok(s.tried.historical);
 const count=journal.read(f.a).events.length;assert.equal(policy.prepare(f.a,f.job).changed,false);assert.equal(journal.read(f.a).events.length,count);
 f.job.executionState.continuation.activeTaskId=null;s.phase='awaiting_change';assert.equal(policy.inspect(f.a,f.job).eligible,false);assert.equal(policy.inspect(f.a,f.job).commands.length,0,'same upgraded method cannot restore the episode twice');
});

test('P1-05: original automatic reconciliation continues result verification within the admitted run despite a future poll time',t=>{
 const f=fixture(t);f.job.nextRunAt='2099-01-01T00:00:00Z';f.a.activeAgentJob=f.job;f.a.activeAgentRun={id:'existing-run',jobId:f.job.id,status:'running'};f.job.status='running';
 const opts={mode:'automatic',operationId:'existing-run',currentExecutionId:'existing-run'};
 assert.equal(policy.inspect(f.a,f.job,opts).eligible,true);assert.equal(policy.inspect(f.a,f.job,{...opts,operationId:'another'}).eligible,false);
 f.a.activeAgentJob=null;f.a.activeAgentRun=null;assert.equal(policy.inspect(f.a,f.job,opts).reasonCode,'NOT_DUE');
});

test('D02/P1-05: exact pending revocation blocks dispatch; receipt read retains only its separate original grant',async t=>{
 const f=fixture(t),access=require('../desktop/access-policy-store.cjs');f.job.outputFolder='/original';f.job.fileMode='ask';
 const action={id:'original-approved',jobId:f.job.id,taskId:f.A.id,tool:'write_file',target:'/original/target',version:'original-version',content:'原稿',status:'pending',approvedAt:'approved'};f.a.data.agentActions.push(action);f.job.pendingActionId=action.id;
 const read=access.requestsForTool(f.a,f.job,'prepare_write_file',{}, {taskId:f.A.id})[0];access.grant(f.a,{principalScope:read.principalScope,resourceScope:read.resourceScope,operations:[read.operation]},{trusted:true,actor:'user_command',command:'policy-test-read-grant'});require('../desktop/protocol-access.cjs').authorizeAction(f.a,action);
 assert.equal(policy.inspect(f.a,f.job).eligible,true);
 const write=access.requestsForTool(f.a,f.job,action.tool,{}, {taskId:f.A.id,action})[0];access.revoke(f.a,{principalScope:write.principalScope,resourceScope:write.resourceScope,operations:[write.operation]},{trusted:true,actor:'user_command',command:'policy-test-revoke'});
 const before=JSON.stringify(f.a.data),disk=files(f),p=policy.inspect(f.a,f.job);assert.equal(p.eligible,false);assert.equal(p.mode,'execute_approved_existing');assert.match(p.reasonCode,/REVOKED/);assert.equal(p.action.actionId,action.id);assert.equal(work.view(f.a,f.job).executionPolicy.eligible,false);assert.equal(policy.prepare(f.a,f.job).changed,false);assert.equal(agent.tick(f.a),false);await agent.run(f.a,f.job.id);assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(files(f),disk);
 action.status='uncertain';f.job.limitReason='budget';const readOnly=policy.inspect(f.a,f.job);assert.equal(readOnly.mode,'reconcile_existing');assert.equal(readOnly.eligible,true);assert.equal(readOnly.action.target,action.target);assert.equal(readOnly.action.version,action.version);
 access.revoke(f.a,{principalScope:read.principalScope,resourceScope:read.resourceScope,operations:[read.operation]},{trusted:true,actor:'user_command',command:'policy-test-revoke-read'});assert.equal(policy.inspect(f.a,f.job).eligible,false);assert.equal(action.status,'uncertain');
});

test('P1-04/P1-05: an ineligible task-scoped original action never hijacks independent B at run admission',async t=>{
 for(const status of ['pending','uncertain']){
  const f=fixture(t,{two:true});f.B.steps.push({id:'delivery-B',kind:'external',tool:'write_file',done:false});
  const action={id:'original-A',jobId:f.job.id,taskId:f.A.id,tool:'write_file',target:'/original/target',version:'original-version',status,approvedAt:'approved'};f.a.data.agentActions.push(action);f.job.pendingActionId=action.id;
  const original=structuredClone(action);assert.equal(policy.inspect(f.a,f.job).eligible,true);assert.deepEqual(policy.inspect(f.a,f.job).taskIds,[f.B.id]);
  f.a.chat=async(_p,_k,_m,o)=>{o.onUsage({inputTokens:1,outputTokens:1});if(o.stage==='planner')return {tool:'advance_task',args:{taskId:f.B.id}};assert.equal(o.stage,'task_work');return {kind:'artifact',title:'B',content:'独立 B 的实际正文'};};
  const execute=t.mock.method(require('../desktop/agent-writes.cjs'),'execute',()=>{throw Error('A must remain untouched');});
  assert.equal(agent.tick(f.a),true);await f.a.runPromise;assert.equal(execute.mock.callCount(),0);execute.mock.restore();
  assert.equal(f.B.steps[0].done,true);assert.equal(f.A.steps[0].done,false);assert.deepEqual(action,original);assert.equal(f.job.pendingActionId,action.id);assert.equal(f.job.failures,0);
 }
});

for(const status of ['uncertain','pending'])for(const tool of [undefined,null,42,'','   '])test('legacy external action '+status+' with invalid tool '+JSON.stringify(tool)+' remains blocked without mutation',t=>{
 const f=fixture(t,{two:true});const r={id:'legacy',jobId:f.job.id,taskId:f.A.id,status,tool,approvedAt:new Date().toISOString(),target:'/original'};f.a.data.agentActions.push(r);f.a.save();
 const before=JSON.stringify(f.a.data),disk=files(f),guard=facts.actionGuard(f.a,f.job,r,{readOnly:status==='uncertain'});assert.equal(guard.code,'ACTION_IDENTITY_INCOMPLETE');
 const p=cont.actionInspect(f.a,f.job);assert.equal(p.eligible,false);assert.equal(p.reason,'ACTION_IDENTITY_INCOMPLETE');
 assert.doesNotThrow(()=>f.a.publicState());const selected=policy.inspect(f.a,f.job);assert.equal(selected.eligible,true);assert.deepEqual(selected.taskIds,[f.B.id]);
 assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(files(f),disk);
});
