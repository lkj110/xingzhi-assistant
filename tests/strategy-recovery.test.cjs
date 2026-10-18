const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),work=require('../desktop/work-efficiency.cjs'),strategy=require('../desktop/strategy-recovery.cjs'),policy=require('../desktop/protocol-access.cjs');
const prohibited=async()=>{throw Error('Unexpected network/model call');};
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-strategy-'))),a=new Assistant({dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited});
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',type:'openai',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const job=agent.buildJob(a,{goal:'根据已有订单资料生成报告',autoAccept:false,maxActions:12});a.data.delegations.push(job);
 const task=a.createTask({title:'订单报告',criteria:'如实记录订单日期',steps:[{key:'draft',title:'生成正文',kind:'draft'}]});task.agentJobId=job.id;job.taskIds=[task.id];
 const source=agent.source(a,job,'orders','订单信息','订单在周五发布。');task.sourceIds=[source.id];policy.retain(a,'source',source,{task,job});a.save();return {a,job,task,source,dir};
}
function stall(f){work.before(f.a,f.job);for(let i=0;i<work.LIMITS.stopAt;i++)work.observe(f.a,f.job,{tool:'read_source',args:{sourceId:f.source.id,start:i}});}
function failStrategy(f){strategy.next(f.a,f.job);work.request(f.a,f.job,{code:'NO_NEW_EVIDENCE',message:'没有新增结果'});}
test('threshold changes strategy without pausing; App produces and verifies a real artifact automatically',async t=>{
 const f=fixture(t);stall(f);assert.equal(f.job.status,'ready');assert.notEqual(f.job.executionPaused,true);assert.equal(work.inspect(f.job).phase,'recovery_pending');
 let planner=0,worker=0;f.a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:10,outputTokens:5});if(m[0].content.includes('动作格式')){planner++;throw Error('Recovery should not need another planner');}if(o.role==='verify')return {passed:true,summary:'日期准确',gaps:[]};worker++;assert.match(m[0].content,/重复读取或反复规划/);return {kind:'artifact',title:'订单报告',content:'订单在周五发布。',summary:'已完成'};};
 await agent.run(f.a,f.job.id);assert.equal(planner,0);assert.equal(worker,1);assert.equal(f.task.status,'review');assert.equal(f.job.status,'review');assert.equal(f.a.data.decisions.length,0);assert.equal(f.a.data.artifacts[0].content,'订单在周五发布。');assert.ok(f.a.data.agentRuns[0].steps.some(s=>s.strategyRecovery));
});
test('repeated planner state reads route into a different executable path on next run',async t=>{
 const f=fixture(t);f.a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:2,outputTokens:2});return {tool:'read_output_state',args:{taskId:f.task.id}};};
 await agent.run(f.a,f.job.id);assert.equal(f.job.status,'ready');assert.equal(work.inspect(f.job).phase,'recovery_pending');assert.equal(f.a.data.decisions.length,0);
 assert.equal(strategy.begin(f.a,f.job),true);assert.equal(strategy.next(f.a,f.job).tool,'advance_task');
});
test('worker read loop yields through core to automatic correction instead of blocking the task',async t=>{
 const f=fixture(t),calls={planner:0,task_work:0},ineffective=[];
 f.a.chat=async(p,k,m,o)=>{
  o.onUsage({inputTokens:2,outputTokens:1});assert.ok(Object.hasOwn(calls,o.stage));calls[o.stage]++;
  if(o.stage==='planner')return {tool:'advance_task',args:{taskId:f.task.id}};
  const c=JSON.parse(m[1].content);ineffective.push(f.job.executionState.workEfficiency.reading?.[f.task.id]?.ineffective??0);
  if(calls.task_work===1)return {kind:'read_context',requests:[{tool:'read_source',sourceId:f.source.id}]};
  assert.match(m[1].content,/订单在周五发布。/,'repeated body must actually be visible to the model');
  const ref=c.sourceCatalog.find(s=>s.id===f.source.id).ref;
  return {kind:'read_context',requests:[{tool:'read_source',ref,start:0,limit:6,history:false}]};
 };
 await agent.run(f.a,f.job.id);assert.equal(f.job.status,'ready');assert.equal(f.task.status,'todo');assert.equal(work.inspect(f.job).phase,'recovery_pending');assert.equal(f.a.data.decisions.length,0);
 // One planner + one fresh read + three ineffective repeats; no fifth worker call.
 assert.deepEqual(calls,{planner:1,task_work:4});assert.deepEqual(ineffective,[0,0,1,2]);
 const reading=f.job.executionState.workEfficiency.reading[f.task.id];
 assert.equal(reading.ineffective,3);assert.equal(reading.batches,4);assert.equal(Object.keys(reading.coverage).length,1);
 const saved=JSON.parse(fs.readFileSync(f.a.file));assert.deepEqual(saved.delegations.find(j=>j.id===f.job.id).executionState.workEfficiency.reading[f.task.id],reading);
 assert.equal(f.a.data.agentRuns[0].steps[0].errorCode,'WORK_STRATEGY_CHANGE');assert.equal(f.a.data.agentRuns[0].modelCalls,5);
});
test('six distinct worker read batches are consumed during recovery without renewing business progress',async t=>{
 const f=fixture(t),sections=Array.from({length:6},(_,i)=>({title:'证据段'+i,text:'ORDER_EVIDENCE_'+i+': 周五发布，第'+i+'项已核对。'}));
 f.source.content=sections.map(s=>'## '+s.title+'\n'+s.text).join('\n\n');f.task.generationMode='single';stall(f);
 let worker=0,baseline;
 f.a.chat=async(p,k,m,o)=>{
  o.onUsage({inputTokens:2,outputTokens:1});assert.notEqual(o.stage,'planner','recovery uses the current task');
  if(o.role==='verify')return {passed:true,summary:'六项事实已核对',gaps:[]};
  assert.equal(o.stage,'task_work');const c=JSON.parse(m[1].content),state=f.job.executionState.workEfficiency;
  const business={attempts:state.attempts,tried:state.tried,history:state.history,lastFailure:state.lastFailure,phase:state.phase,strategy:state.active.id};
  if(!baseline)baseline=structuredClone(business);else assert.deepEqual(business,baseline,'reading cannot clear failure history or renew business attempts');
  assert.equal(state.phase,'recovering');assert.equal(state.attempts,work.LIMITS.stopAt);
  if(worker){
   const previous=sections[worker-1];assert.ok(m[1].content.includes(previous.text),'the next serialized model input consumes the previous batch body');
   assert.equal(state.reading[f.task.id].ineffective,0);assert.equal(state.reading[f.task.id].batches,worker);
   const saved=JSON.parse(fs.readFileSync(f.a.file));assert.equal(saved.delegations.find(j=>j.id===f.job.id).executionState.workEfficiency.reading[f.task.id].batches,worker);
  }
  if(worker<sections.length){const s=sections[worker++];return {kind:'read_context',requests:[{tool:'read_section',sourceId:f.source.id,title:s.title}]};}
  worker++;assert.equal(c.contextRecovery.batches,6);assert.equal(c.contextRecovery.coveredRanges,6);
  for(const s of sections)assert.ok(m[1].content.includes(s.text));
  return {kind:'artifact',title:'订单报告',content:sections.map(s=>s.text).join('\n\n'),summary:'六项事实已形成报告'};
 };
 await agent.run(f.a,f.job.id);
 assert.equal(worker,7);assert.equal(f.task.status,'review');assert.equal(f.job.status,'review');assert.equal(f.a.data.decisions.length,0);
 assert.equal(f.a.data.artifacts[0].content,sections.map(s=>s.text).join('\n\n'));
 const reading=f.job.executionState.workEfficiency.reading[f.task.id];assert.equal(reading.batches,6);assert.equal(reading.ineffective,0);assert.equal(Object.keys(reading.coverage).length,6);
 assert.deepEqual(f.job.executionState.workEfficiency.tried,baseline.tried);
});
test('changing empty-search wording remains bounded through the real worker loop',async t=>{
 const f=fixture(t),queries=['missing_alpha','missing_beta','missing_gamma'];let planner=0,worker=0;
 f.a.chat=async(p,k,m,o)=>{
  o.onUsage({inputTokens:2,outputTokens:1});
  if(o.stage==='planner'){planner++;return {tool:'advance_task',args:{taskId:f.task.id}};}
  assert.equal(o.stage,'task_work');assert.ok(worker<queries.length,'no fourth empty search is allowed');
  return {kind:'read_context',requests:[{tool:'search_source',sourceId:f.source.id,query:queries[worker++]}]};
 };
 await agent.run(f.a,f.job.id);assert.equal(planner,1);assert.equal(worker,3);
 const reading=f.job.executionState.workEfficiency.reading[f.task.id];assert.equal(reading.ineffective,3);assert.equal(Object.keys(reading.coverage).length,0);
 assert.equal(work.inspect(f.job).phase,'recovery_pending');assert.equal(f.job.status,'ready');assert.equal(f.task.status,'todo');assert.equal(f.a.data.artifacts.length,0);assert.equal(f.a.data.decisions.length,0);
});
test('failed strategies persist across restart and status/plan wording cannot renew their identity',t=>{
 const f=fixture(t);stall(f);strategy.begin(f.a,f.job);const before=strategy.inputBasis(f.a,f.job),first=strategy.next(f.a,f.job);assert.equal(first.tool,'advance_task');work.request(f.a,f.job,{message:'已尝试无进展'});
 f.task.status='running';f.task.steps[0].title='改写同一步骤标题';f.task.steps[0].key='renamed';f.task.criteria='同一完成标准的改写';assert.equal(strategy.inputBasis(f.a,f.job),before);
 f.task.status='todo';f.a.save();const a=new Assistant({dir:f.dir,chat:prohibited}),j=a.data.delegations.find(j=>j.id===f.job.id);assert.equal(strategy.begin(a,j),true);assert.equal(j.executionState.workEfficiency.active.id,'replan');
});
test('exhaustion waits for actual condition changes with zero repeated dispatch or model calls',t=>{
 const f=fixture(t);stall(f);strategy.begin(f.a,f.job);failStrategy(f);strategy.begin(f.a,f.job);assert.equal(strategy.planning(f.job),true);work.request(f.a,f.job,{message:'其他工具也无法取得缺少的事实'});
 assert.equal(strategy.begin(f.a,f.job),false);assert.equal(f.job.status,'blocked');assert.notEqual(f.job.executionPaused,true);
 for(let i=0;i<5;i++){assert.equal(strategy.ready(f.a,f.job),false);assert.equal(agent.tick(f.a),false);}
 assert.equal((f.a.data.modelCalls||[]).length,0);f.source.content='订单改为周六发布。';assert.equal(strategy.ready(f.a,f.job),true);assert.equal(f.job.status,'ready');assert.equal(strategy.begin(f.a,f.job),true);
});
test('recovery cannot resume a user pause even after fresh evidence or user requirements',t=>{
 const f=fixture(t);stall(f);f.job.status='paused';f.job.executionPaused=true;f.source.content='新的有效订单事实';work.before(f.a,f.job);assert.equal(strategy.schedule(f.a,f.job,{message:'需纠偏'}),false);assert.equal(f.job.status,'paused');assert.equal(f.job.executionPaused,true);
});
test('recovery does not override completed, archived, blocked budget or pending side effects',t=>{
 for(const kind of ['completed','archived','budget','uncertain','pending','running']){
  const f=fixture(t);stall(f);
  if(kind==='completed')f.job.status='completed';
  if(kind==='archived'){f.job.projectId='p';f.a.data.projects.push({id:'p',archivedAt:'now'});}
  if(kind==='budget'){f.job.status='limited';f.job.limitReason='budget';}
  if(['uncertain','pending','running'].includes(kind))f.a.data.agentActions.push({id:'side-effect',jobId:f.job.id,taskId:f.task.id,status:kind,tool:'lark_create'});
  const before=JSON.stringify({status:f.job.status,limit:f.job.limitReason,actions:f.a.data.agentActions});assert.equal(strategy.schedule(f.a,f.job,{message:'重复'}),false,kind);assert.equal(JSON.stringify({status:f.job.status,limit:f.job.limitReason,actions:f.a.data.agentActions}),before,kind);
 }
});
test('correction preserves cumulative spend, permissions and user acceptance criteria',t=>{
 const f=fixture(t);stall(f);f.a.spendLedger.scopes['job:'+f.job.id]={limitUSD:100,spentUSD:50,heldUSD:3};
 const before=JSON.stringify({ledger:f.a.spendLedger,grant:f.job.capabilityGrants,criteria:f.task.criteria,contract:f.job.executionContract});strategy.schedule(f.a,f.job,{message:'重复读取'});strategy.begin(f.a,f.job);assert.equal(JSON.stringify({ledger:f.a.spendLedger,grant:f.job.capabilityGrants,criteria:f.task.criteria,contract:f.job.executionContract}),before);
});
test('legacy automatic pause migrates to correction, while manual pause stays paused',t=>{
 for(const manual of [false,true]){const f=fixture(t);work.before(f.a,f.job);Object.assign(f.job.executionState.workEfficiency,{version:1,phase:'paused',pausedByGuard:true,attempts:12});f.job.status='paused';f.job.executionPaused=true;f.job.summary=manual?'已暂停，执行记录已保留':'无有效成果的尝试已达到上限，已暂停。请改用针对缺口的策略';work.initialize(f.a);assert.equal(f.job.status,manual?'paused':'ready');assert.equal(f.job.executionPaused,manual);}
});
test('a repair strategy executes revision and generation as one recovery attempt',async t=>{
 const f=fixture(t),r={id:'artifact',taskId:f.task.id,stepId:f.task.steps[0].id,title:'报告',content:'错误正文'};f.a.data.artifacts.push(r);Object.assign(f.task.steps[0],{done:true,artifactId:r.id});policy.retain(f.a,'artifact',r,{task:f.task,job:f.job});f.task.verification={passed:false,gaps:['日期错误'],summary:'需修复'};f.task.status='blocked';stall(f);
 strategy.begin(f.a,f.job);failStrategy(f);strategy.begin(f.a,f.job);assert.equal(f.job.executionState.workEfficiency.active.id,'repair:'+f.task.id);const revise=strategy.next(f.a,f.job);assert.equal(revise.tool,'revise_task');assert.equal(strategy.next(f.a,f.job),null);revise.result=await agent.act(f.a,f.job,revise.tool,revise.args);strategy.settled(f.a,f.job,revise);work.observe(f.a,f.job,revise);assert.equal(work.inspect(f.job).phase,'recovering');assert.equal(strategy.next(f.a,f.job).tool,'advance_task');
});
test('a real user-adopted artifact wakes verification without renewing failed strategy keys',t=>{
 const f=fixture(t);stall(f);strategy.begin(f.a,f.job);failStrategy(f);strategy.begin(f.a,f.job);work.request(f.a,f.job,{message:'没有新路径'});strategy.begin(f.a,f.job);
 const tried=structuredClone(f.job.executionState.workEfficiency.tried);
 require('../desktop/generation.cjs').adopt(f.a,{id:f.task.id,stepId:f.task.steps[0].id,title:'补充稿件',content:'订单在周五发布。'});
 assert.equal(strategy.ready(f.a,f.job),true);assert.equal(f.job.status,'ready');assert.deepEqual(f.job.executionState.workEfficiency.tried,tried);assert.equal(require('../desktop/execution-control.cjs').next(f.a,f.job).tool,'advance_task');
});

function broadFrontier(t,f){
 f.job.dataPlatform='sg-readonly';let serial=0;
 t.mock.method(require('../desktop/work-obligations.cjs'),'frontier',()=>Array.from({length:30},()=>({status:'unexpanded',scopeProven:true,query:{op:'upstream',taskId:String(++serial),depth:1}})));
}
test('a growing frontier cannot starve the current task step or renew the same recovery family',t=>{
 const f=fixture(t);broadFrontier(t,f);stall(f);
 strategy.begin(f.a,f.job);assert.equal(strategy.next(f.a,f.job).tool,'advance_task');work.request(f.a,f.job,{message:'生成仍缺少事实'});
 for(let i=0;i<3;i++){strategy.begin(f.a,f.job);assert.match(f.job.executionState.workEfficiency.active.id,/^boundary:/);failStrategy(f);}
 // New IDs continue arriving, but these are the same method and task inputs.
 strategy.begin(f.a,f.job);assert.equal(strategy.planning(f.job),true);assert.equal(f.job.executionState.workEfficiency.active.id,'replan');
 assert.match(f.job.executionState.workEfficiency.active.instruction,/一次性纳入对应事项/);
});
test('legacy failed frontier attempts remain bounded across restart and history truncation',t=>{
 const f=fixture(t);broadFrontier(t,f);stall(f);strategy.begin(f.a,f.job);failStrategy(f);
 const state=f.job.executionState.workEfficiency,basis=strategy.inputBasis(f.a,f.job);
 for(let i=0;i<70;i++)state.tried[basis+':boundary:old-'+i]={at:'2026-01-01',title:'历史边界查询'};
 state.history=[];f.a.save();const a=new Assistant({dir:f.dir,chat:prohibited}),job=a.data.delegations.find(j=>j.id===f.job.id);
 strategy.begin(a,job);assert.equal(job.executionState.workEfficiency.active.id,'replan');
});
test('fresh task-bound evidence permits a new bounded exploration cycle, job catalog growth does not',t=>{
 const f=fixture(t);broadFrontier(t,f);stall(f);strategy.begin(f.a,f.job);failStrategy(f);
 for(let i=0;i<3;i++){strategy.begin(f.a,f.job);failStrategy(f);}
 const basis=strategy.inputBasis(f.a,f.job);
 agent.source(f.a,f.job,'unrelated','目录中的新材料','与事项未关联的其他事实');
 assert.equal(strategy.inputBasis(f.a,f.job),basis);strategy.begin(f.a,f.job);assert.equal(strategy.planning(f.job),true);failStrategy(f);
 f.source.content='新增相关事实：订单经过审批后在周六发布。';stall(f);
 assert.notEqual(strategy.inputBasis(f.a,f.job),basis);strategy.begin(f.a,f.job);assert.equal(strategy.next(f.a,f.job).tool,'advance_task');
});
test('content checking and authorized delivery take precedence over generic frontier expansion',t=>{
 const f=fixture(t);broadFrontier(t,f);
 const r={id:'draft-current',taskId:f.task.id,stepId:f.task.steps[0].id,title:'报告',content:'订单在周五发布。'};f.a.data.artifacts.push(r);Object.assign(f.task.steps[0],{done:true,artifactId:r.id});policy.retain(f.a,'artifact',r,{task:f.task,job:f.job});
 f.task.steps.push({id:'external',key:'deliver',title:'保存',kind:'external',tool:'write_file',done:false});stall(f);
 strategy.begin(f.a,f.job);assert.equal(strategy.next(f.a,f.job).tool,'verify_content');work.request(f.a,f.job,{message:'已核对'});
 f.task.contentVerification={basis:require('../desktop/execution-control.cjs').contentBasis(f.a,f.job,f.task),passed:true,summary:'日期准确',gaps:[]};
 work.request(f.a,f.job,{message:'继续已核验交付'});strategy.begin(f.a,f.job);assert.equal(strategy.next(f.a,f.job).tool,'write_file');
});

test('upgraded local read method wakes only its own route; old boundaries and planner stay consumed',t=>{
 const f=fixture(t);broadFrontier(t,f);
 const r={id:'current',taskId:f.task.id,stepId:f.task.steps[0].id,title:'报告',content:'订单在周五发布。'};
 f.a.data.artifacts.push(r);f.task.primaryArtifactId=r.id;Object.assign(f.task.steps[0],{done:true,artifactId:r.id});policy.retain(f.a,'artifact',r,{task:f.task,job:f.job});
 f.task.steps.push({id:'external',key:'deliver',title:'保存',kind:'external',tool:'write_file',done:false});stall(f);
 const s=f.job.executionState.workEfficiency,basis=strategy.inputBasis(f.a,f.job);
 s.reading={[f.task.id]:{ineffective:5}};s.phase='awaiting_change';s.waitBasis=basis;f.job.status='blocked';f.job.nextRunAt=null;
 for(const id of ['check:'+f.task.id,'boundary:1','boundary:2','boundary:3','replan'])s.tried[basis+':'+id]={title:'old',at:'old'};
 const old=structuredClone(s.tried);assert.equal(strategy.ready(f.a,f.job),true);assert.equal(strategy.inputBasis(f.a,f.job),basis);
 assert.equal(strategy.begin(f.a,f.job),true);assert.equal(strategy.next(f.a,f.job).tool,'verify_content');
 work.request(f.a,f.job,{code:'CONTEXT_INVALID_REQUEST',message:'结论路径仍未返回有效结果'});
 assert.equal(strategy.begin(f.a,f.job),false);assert.equal(f.job.status,'blocked');assert.equal(strategy.ready(f.a,f.job),false);
 for(const [k,v] of Object.entries(old))assert.deepEqual(s.tried[k],v);
 assert.equal(Object.keys(s.tried).length,Object.keys(old).length+1);assert.equal(s.reading[f.task.id].ineffective,5);
 f.a.save();const a=new Assistant({dir:f.dir,chat:prohibited}),job=a.data.delegations.find(j=>j.id===f.job.id);
 assert.equal(strategy.ready(a,job),false);assert.equal(agent.tick(a),false);assert.equal((a.data.modelCalls||[]).length,0);
});
