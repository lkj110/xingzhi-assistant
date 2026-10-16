'use strict';
// Independent review: all model/connector responses are local doubles. No live app.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),work=require('../desktop/work-efficiency.cjs');
const strategy=require('../desktop/strategy-recovery.cjs'),protocol=require('../desktop/protocol-access.cjs');
const policies=require('../desktop/access-policy-store.cjs'),spend=require('../desktop/spend.cjs');
const control=require('../desktop/execution-control.cjs');
const prohibited=async()=>{throw new Error('Review fixture prohibits live model/network/connector calls');};
function temporary(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'strategy-review-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function open(dir){return new Assistant({dir,chat:prohibited,agentRequest:prohibited,connectorRequest:prohibited,officeRequest:prohibited,webRequest:prohibited,feedRequest:prohibited});}
function fixture(t){
 const dir=temporary(t),a=open(dir);a.platformRequest=prohibited;
 a.data.providers.push({id:'review',name:'review',model:'review',type:'openai',baseUrl:'https://review.invalid',inputPrice:1,outputPrice:1});
 a.data.settings.roles={organize:'review',execute:'review',verify:'review'};
 const job=agent.buildJob(a,{goal:'根据订单事实写报告',autoAccept:false,maxActions:12});a.data.delegations.push(job);
 const task=a.createTask({title:'订单报告',criteria:'如实记录订单日期',steps:[{key:'draft',title:'正文',kind:'draft'}]});task.agentJobId=job.id;task.dependsOn=[];task.planHistory=[];task.planVersion=1;task.steps[0].key='draft';job.taskIds=[task.id];
 const source=agent.source(a,job,'orders','订单事实','订单在周五发布。');task.sourceIds=[source.id];protocol.retain(a,'source',source,{task,job});a.save();
 return {a,job,task,source,dir};
}
function stalled(f){work.before(f.a,f.job);for(let i=0;i<work.LIMITS.stopAt;i++)work.observe(f.a,f.job,{tool:'read_source',args:{sourceId:f.source.id,start:i}});}
function finishWithoutProgress(f){const action=strategy.next(f.a,f.job);if(action)strategy.started(f.a,f.job,action);work.request(f.a,f.job,{code:'NO_NEW_EVIDENCE',message:'已执行但没有新结果'});}
function exhausted(f){stalled(f);assert.equal(strategy.begin(f.a,f.job),true);finishWithoutProgress(f);assert.equal(strategy.begin(f.a,f.job),true);assert.equal(strategy.planning(f.job),true);work.request(f.a,f.job,{message:'没有其他可执行路径'});assert.equal(strategy.begin(f.a,f.job),false);}
function artifact(f,content='订单在周五发布。'){
 const step=f.task.steps[0],r={id:crypto.randomUUID(),taskId:f.task.id,stepId:step.id,title:'报告',content,createdAt:'2026-01-01T00:00:00.000Z'};
 f.a.data.artifacts.push(r);Object.assign(step,{done:true,artifactId:r.id});protocol.retain(f.a,'artifact',r,{task:f.task,job:f.job});return r;
}
function usage(o){o.onUsage({inputTokens:10,outputTokens:5});}
const planner=m=>m[0].content.includes('动作格式');
function state(f){return f.job.executionState?.workEfficiency;}

test('review: intent and input basis ignore task/step labels, status, output text and artifact policy',t=>{
 const f=fixture(t);exhausted(f);const intent=work.intent(f.a,f.job),basis=strategy.inputBasis(f.a,f.job),tried=structuredClone(state(f).tried);
 f.task.title='同一报告的新标题';f.task.status='running';f.task.criteria='模型改写的标准说明';f.task.steps[0].title='同一步骤的新措辞';f.task.steps[0].key='renamed';
 const r=artifact(f,'同一输出的措辞变化。');f.job.summary='再次重写状态说明';f.task.verification={passed:false,gaps:['另一种缺口描述']};
 assert.equal(work.intent(f.a,f.job),intent);assert.equal(strategy.inputBasis(f.a,f.job),basis);assert.equal(strategy.ready(f.a,f.job),false);
 r.content='再次改写输出措辞';assert.equal(strategy.inputBasis(f.a,f.job),basis);assert.deepEqual(state(f).tried,tried);
});

test('review: unrelated authorization counter must not renew input strategy eligibility',t=>{
 const f=fixture(t);exhausted(f);const basis=strategy.inputBasis(f.a,f.job);
 const before=require('../desktop/task-context.cjs').buildContext(f.a,require('../desktop/task-context.cjs').taskScope(f.task)).readableCatalog.filter(r=>r.purpose==='input');
 // access.complete increments this same job-wide counter for output-only authorization too.
 f.job.executionState.permissionRevision++;
 const after=require('../desktop/task-context.cjs').buildContext(f.a,require('../desktop/task-context.cjs').taskScope(f.task)).readableCatalog.filter(r=>r.purpose==='input');
 assert.deepEqual(after,before);assert.equal(strategy.inputBasis(f.a,f.job),basis,'No input facts or input policy changed');
 assert.equal(strategy.ready(f.a,f.job),false);
});

test('review: completed failed strategies remain exhausted after restart without additional billed calls',async t=>{
 const f=fixture(t);stalled(f);let calls=0;
 f.a.chat=async(p,k,m,o)=>{usage(o);calls++;return planner(m)?{tool:'read_output_state',args:{taskId:f.task.id}}:{kind:'read_context',requests:[{tool:'read_source',sourceId:f.source.id}]};};
 for(let i=0;i<4&&state(f).phase!=='awaiting_change';i++)await agent.run(f.a,f.job.id);
 assert.equal(state(f).phase,'awaiting_change');assert.ok(calls>0);
 const spent=f.a.spendLedger.scopes['job:'+f.job.id].spentUSD;assert.ok(spent>0);f.a.save();
 const a=open(f.dir),job=a.data.delegations.find(j=>j.id===f.job.id);
 for(let i=0;i<5;i++)assert.equal(agent.tick(a),false);
 assert.equal(job.executionState.workEfficiency.phase,'awaiting_change');assert.equal(a.spendLedger.scopes['job:'+job.id].spentUSD,spent);assert.equal(job.callsUsed,f.job.callsUsed);
});

test('review: crash during a charged recovery worker must not replay the same strategy on restart',async t=>{
 const f=fixture(t),crashDir=temporary(t);stalled(f);let copied=false;
 f.a.chat=async(p,k,m,o)=>{
  assert.equal(planner(m),false);assert.equal(state(f).active.id,'cached:'+f.task.id);
  // Snapshot exactly after spend.reserve/save and before receiving the worker result.
  fs.cpSync(f.dir,crashDir,{recursive:true});copied=true;usage(o);
  return {kind:'need_input',question:'需要尚未取得的审批日期',decisionType:'information'};
 };
 await agent.run(f.a,f.job.id);assert.equal(copied,true);
 const a=open(crashDir),job=a.data.delegations.find(j=>j.id===f.job.id),task=a.task(f.task.id),attempts=[];
 const spentBefore=job.callsUsed,heldBefore=a.spendLedger.scopes['job:'+job.id].heldUSD;assert.ok(heldBefore>0);
 a.chat=async(p,k,m,o)=>{usage(o);attempts.push({planner:planner(m),strategy:job.executionState.workEfficiency.active?.id});return planner(m)?{tool:'advance_task',args:{taskId:task.id}}:{kind:'need_input',question:'仍缺少同一审批日期',decisionType:'information'};};
 await agent.run(a,job.id);
 assert.equal(attempts.filter(r=>!r.planner&&r.strategy==='cached:'+task.id).length,0,JSON.stringify({attempts,callsAdded:job.callsUsed-spentBefore}));
});

test('review: real agentPause during the recovery response prevents artifact commit and future dispatch',async t=>{
 const f=fixture(t);stalled(f);f.a.controller=new AbortController();let calls=0;
 f.a.chat=async(p,k,m,o)=>{usage(o);calls++;await agent.dispatch(f.a,'agentPause',{id:f.job.id});return {kind:'artifact',title:'迟到结果',content:'订单在周五发布。'};};
 await agent.run(f.a,f.job.id);assert.equal(calls,1);assert.equal(f.job.status,'paused');assert.equal(f.a.data.artifacts.length,0);assert.equal(agent.tick(f.a),false);
 f.source.content='新增订单事实';assert.equal(strategy.schedule(f.a,f.job,{message:'仍需恢复'}),false);assert.equal(f.job.status,'paused');
});

test('review: spent plus held budget blocks recovery before any provider call or extra reservation',async t=>{
 const f=fixture(t);stalled(f);f.a.activeAgentJob=f.job;const account=spend.scope(f.a);f.a.activeAgentJob=null;
 Object.assign(account,{spentUSD:99,heldUSD:1});spend.persist(f.a);const before=JSON.stringify({spent:account.spentUSD,held:account.heldUSD,limit:account.limitUSD,pending:account.pending});
 await agent.run(f.a,f.job.id);assert.equal(f.job.status,'limited');assert.equal(f.job.limitReason,'spend');assert.equal(f.job.callsUsed,0);
 assert.equal(JSON.stringify({spent:account.spentUSD,held:account.heldUSD,limit:account.limitUSD,pending:account.pending}),before);
});

test('review: revoked model permission remains revoked during deterministic recovery',async t=>{
 const f=fixture(t);stalled(f);let calls=0;f.a.chat=async()=>{calls++;throw Error('Revoked model must not run');};
 policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'model',key:'app',jobId:f.job.id},operations:['model','model_request']},{trusted:true,actor:'user_command',command:'review revoke model'});
 await agent.run(f.a,f.job.id);assert.equal(calls,0);assert.equal(f.job.callsUsed,0);assert.throws(()=>protocol.assertTool(f.a,f.job,'model_request'));
});

test('review: source revocation inside the worker rejects late content and stale cached reads',async t=>{
 const f=fixture(t);stalled(f);let calls=0;f.job.maxActions=1;
 f.a.chat=async(p,k,m,o)=>{usage(o);calls++;policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+f.source.id,jobId:f.job.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'review revoke source'});return {kind:'artifact',title:'迟到结果',content:'订单在周五发布。'};};
 await agent.run(f.a,f.job.id);assert.equal(calls,1);assert.equal(f.a.data.artifacts.length,0);
 assert.equal(require('../desktop/task-context.cjs').resolveRead(f.a,{kind:'task',taskId:f.task.id,jobId:f.job.id},{tool:'read_source',sourceId:f.source.id}).ok,false);
});

test('review: uncertain external action is reconciled before strategy/planner and never replaced',async t=>{
 const f=fixture(t);stalled(f);const record={id:'uncertain-action',jobId:f.job.id,taskId:f.task.id,status:'uncertain',tool:'write_file',target:'/unavailable/review-only.md',args:{taskId:f.task.id},content:'已尝试的稿件'};
 f.a.data.agentActions.push(record);f.job.pendingActionId=record.id;let models=0;f.a.chat=async()=>{models++;throw Error('No planning before reconciliation');};
 await agent.run(f.a,f.job.id);assert.equal(models,0);assert.equal(f.a.data.agentActions.length,1);assert.equal(record.status,'uncertain');assert.equal(f.job.pendingActionId,record.id);assert.equal(Object.keys(state(f).tried).length,0);
});

test('review: targeted repair actually patches, verifies, and preserves the complete original',async t=>{
 const f=fixture(t),r=artifact(f,'订单在周四发布。\n保留这条事实。');
 f.task.verification={passed:false,gaps:['发布日期必须为周五'],summary:'日期错误'};f.task.status='blocked';stalled(f);strategy.begin(f.a,f.job);finishWithoutProgress(f);
 let patches=0;f.a.chat=async(p,k,m,o)=>{usage(o);assert.equal(planner(m),false);if(o.role==='verify')return {passed:true,summary:'日期正确，完整内容保留',gaps:[]};patches++;assert.match(m[0].content,/精确替换|替换后的片段/);return {kind:'patch',edits:[{before:'周四',after:'周五'}],summary:'修正订单日期'};};
 await agent.run(f.a,f.job.id);assert.equal(patches,1);assert.equal(f.task.status,'review');assert.equal(f.a.data.artifacts.at(-1).content,'订单在周五发布。\n保留这条事实。');assert.equal(r.content,'订单在周四发布。\n保留这条事实。');
 assert.ok(f.a.data.agentRuns[0].steps.some(s=>s.tool==='revise_task'));assert.ok(f.a.data.agentRuns[0].steps.some(s=>s.tool==='advance_task'));
});

test('review: renamed external step must not renew an already attempted delivery strategy',t=>{
 const f=fixture(t);artifact(f);f.task.steps.push({id:'external',key:'deliver',title:'文件交付',kind:'external',tool:'write_file',done:false});
 f.task.contentVerification={basis:control.contentBasis(f.a,f.job,f.task),passed:true,gaps:[],summary:'内容正确'};stalled(f);assert.equal(strategy.begin(f.a,f.job),true);const original=state(f).active.id;assert.match(original,/^deliver:/);finishWithoutProgress(f);
 const basis=strategy.inputBasis(f.a,f.job);f.task.steps[1].key='same-delivery-renamed';f.task.steps[1].title='改写交付步骤名称';assert.equal(strategy.inputBasis(f.a,f.job),basis);
 strategy.begin(f.a,f.job);assert.equal(state(f).active.id,'replan','Renaming an identical external action must not make it a new deterministic strategy');
});

test('review: a user-completed task and archived project cannot start recovery via tick',t=>{
 for(const terminal of ['completed','archived']){
  const f=fixture(t);stalled(f);
  if(terminal==='completed'){f.job.status='completed';f.task.status='completed';f.task.acceptedBy='user';}
  else{f.job.projectId='review-project';f.task.projectId='review-project';f.a.data.projects.push({id:'review-project',archivedAt:new Date().toISOString()});}
  const before=f.job.status;assert.equal(agent.tick(f.a),false);assert.equal(strategy.schedule(f.a,f.job,{message:'重复'}),false);assert.equal(f.job.status,before);assert.equal(f.job.callsUsed,0);
 }
});

test('review: invalid-output migration excludes auth, quota, transport, policy and permanent failures',t=>{
 const f=fixture(t);work.before(f.a,f.job);
 const failures=[
  {code:'MODEL_HTTP',httpStatus:401},{code:'MODEL_QUOTA'},{code:'MODEL_NETWORK'},
  {code:'MODEL_TIMEOUT'},{code:'MODEL_BLOCKED',automaticRetry:false},{code:'ACCESS_POLICY_REVOKED'},
  {code:'MODEL_INVALID_RESPONSE',automaticRetry:false},{code:'MODEL_CLI'},
 ];
 for(const failure of failures)for(let i=0;i<3;i++){
  const error=Object.assign(Error(failure.code),{modelFailure:true,automaticRetry:true,recoveryContext:{taskId:f.task.id,stage:'task_work'},...failure});
  assert.equal(strategy.invalidOutput(f.a,f.job,error),false,failure.code);
 }
 assert.equal(state(f).phase,'working');assert.equal(f.job.executionState.invalidOutputs,undefined);
});

test('review: invalid-output count is scoped to task/stage/basis and survives restart',t=>{
 const f=fixture(t);work.before(f.a,f.job);
 const error=stage=>Object.assign(Error('结构校验失败'),{code:'MODEL_INVALID_RESPONSE',modelFailure:true,automaticRetry:true,recoveryContext:{taskId:f.task.id,stage}});
 assert.equal(strategy.invalidOutput(f.a,f.job,error('task_work')),false);
 assert.equal(strategy.invalidOutput(f.a,f.job,error('task_verify')),false);
 assert.equal(strategy.invalidOutput(f.a,f.job,{...error('task_work'),recoveryContext:{taskId:'foreign',stage:'task_work'}}),false);
 f.a.save();const a=open(f.dir),job=a.data.delegations.find(j=>j.id===f.job.id);
 assert.equal(strategy.invalidOutput(a,job,error('task_work')),true);
 assert.equal(job.executionState.workEfficiency.phase,'recovery_pending');
});

test('review: repeated missing-chapter output reaches bounded strategy exhaustion without dropping the original',async t=>{
 const f=fixture(t),original=artifact(f,'# 订单\n订单在周四发布。\n# 边界\n尚未核实审批日期。');
 f.task.steps[0].done=false;delete f.task.steps[0].artifactId;f.task.notes.push({kind:'revise',text:'核对并修正订单事实，保留原有边界',at:new Date().toISOString()});
 const requests=[];f.a.chat=async(p,k,m,o)=>{
  usage(o);requests.push({role:o.role,planner:planner(m),strategy:state(f)?.active?.id||null,prompt:m[0].content});
  return planner(m)?{tool:'advance_task',args:{taskId:f.task.id}}:{kind:'artifact',title:'订单报告',content:'# 订单\n订单在周五发布。',summary:'缺少边界章节的无效替代稿'};
 };
 for(let i=0;i<7&&state(f)?.phase!=='awaiting_change';i++)await agent.run(f.a,f.job.id);
 assert.equal(state(f).phase,'awaiting_change');assert.equal(f.a.data.artifacts.length,1);assert.equal(f.a.data.artifacts[0].content,original.content);
 const calls=f.job.callsUsed,cost=f.a.spendLedger.scopes['job:'+f.job.id].spentUSD;
 for(let i=0;i<5;i++)assert.equal(agent.tick(f.a),false);
 assert.equal(f.job.callsUsed,calls);assert.equal(f.a.spendLedger.scopes['job:'+f.job.id].spentUSD,cost);
 const cached=requests.filter(r=>r.strategy?.startsWith('cached:')&&!r.planner),full=requests.filter(r=>r.strategy?.startsWith('full_rewrite:')&&!r.planner);
 t.diagnostic(JSON.stringify({calls,cachedWorkerCalls:cached.length,fullRewriteCalls:full.length}));
 assert.ok(full.length>0,'The alternative full-rewrite route must actually execute');
 assert.equal(cached.length,0,'A failed replan must not erase the invalid-revision root cause and revive the old cached patch/full-replacement route');
});

test('review: crash during charged recovery planning must not replay the same planning strategy',async t=>{
 const f=fixture(t),crashDir=temporary(t);stalled(f);strategy.begin(f.a,f.job);finishWithoutProgress(f);let copied=false;
 f.a.chat=async(p,k,m,o)=>{assert.equal(planner(m),true);assert.equal(state(f).active.id,'replan');fs.cpSync(f.dir,crashDir,{recursive:true});copied=true;usage(o);return {tool:'read_output_state',args:{taskId:f.task.id}};};
 await agent.run(f.a,f.job.id);assert.equal(copied,true);
 const a=open(crashDir),job=a.data.delegations.find(j=>j.id===f.job.id);assert.ok(a.spendLedger.scopes['job:'+job.id].heldUSD>0);
 let repeats=0;a.chat=async(p,k,m,o)=>{usage(o);if(job.executionState.workEfficiency.active?.id==='replan')repeats++;return {tool:'read_output_state',args:{taskId:f.task.id}};};
 const before=job.callsUsed;await agent.run(a,job.id);
 assert.equal(repeats,0,JSON.stringify({repeatedRecoveryPlannerCalls:repeats,extraBilledCalls:job.callsUsed-before}));
});

test('review: restart between completed local revision and generation preserves remaining queue only',async t=>{
 const f=fixture(t);artifact(f,'订单在周四发布。');f.task.verification={passed:false,gaps:['改为周五'],summary:'日期错误'};f.task.status='blocked';stalled(f);
 strategy.begin(f.a,f.job);finishWithoutProgress(f);strategy.begin(f.a,f.job);assert.equal(state(f).active.id,'repair:'+f.task.id);
 const revise=strategy.next(f.a,f.job);strategy.started(f.a,f.job,revise);f.a.save();revise.result=await agent.act(f.a,f.job,revise.tool,revise.args);strategy.settled(f.a,f.job,revise);work.observe(f.a,f.job,revise);f.a.save();
 assert.equal(state(f).active.inFlight,undefined);const a=open(f.dir),job=a.data.delegations.find(j=>j.id===f.job.id);
 assert.equal(strategy.begin(a,job),true);assert.equal(job.executionState.workEfficiency.active.id,'repair:'+f.task.id);
 assert.equal(strategy.next(a,job).tool,'advance_task');assert.equal(strategy.next(a,job),null);assert.equal(job.callsUsed,0);
});

test('review: invalid recovery planner output must exhaust instead of billing the same strategy after restart',async t=>{
 const f=fixture(t);stalled(f);strategy.begin(f.a,f.job);finishWithoutProgress(f);
 let calls=0;const invalid=async(p,k,m,o)=>{assert.equal(planner(m),true);usage(o);calls++;return {tool:'advance_task',args:null};};
 f.a.chat=invalid;
 for(let i=0;i<4&&state(f).phase!=='awaiting_change';i++)await agent.run(f.a,f.job.id);
 assert.equal(state(f).active?.inFlight,undefined,'A handled response error must not remain in flight');
 f.a.save();const a=open(f.dir),job=a.data.delegations.find(j=>j.id===f.job.id),before=calls;
 a.chat=invalid;
 if(job.executionState.workEfficiency.phase==='awaiting_change')assert.equal(agent.tick(a),false);
 else await agent.run(a,job.id);
 t.diagnostic(JSON.stringify({calls,replayedAfterRestart:calls-before,phase:job.executionState.workEfficiency.phase,status:job.status,retries:job.autoRecovery?.consecutive}));
 assert.equal(job.executionState.workEfficiency.phase,'awaiting_change','Invalid schema from the last recovery strategy must reach a durable bound');
 assert.equal(calls,before,'Unchanged facts must not reopen a failed recovery planner on restart');
});

test('review: recovery planner receives concrete failed actions and failure cause',async t=>{
 const f=fixture(t);stalled(f);strategy.begin(f.a,f.job);finishWithoutProgress(f);let inspected=false;
 f.a.chat=async(p,k,m,o)=>{
  assert.equal(planner(m),true);const payload=JSON.parse(m[1].content),recovery=payload.workEfficiency;
  assert.ok(recovery.triedStrategies.some(s=>s.outcome==='no_progress'));
  assert.ok(recovery.failedActions.some(s=>s.tool==='advance_task'&&s.args.taskId===f.task.id));
  assert.equal(recovery.failure.code,'NO_NEW_EVIDENCE');assert.equal(recovery.failure.message,'已执行但没有新结果');
  inspected=true;usage(o);return {tool:'read_output_state',args:{taskId:f.task.id}};
 };
 await agent.run(f.a,f.job.id);assert.equal(inspected,true);
});
