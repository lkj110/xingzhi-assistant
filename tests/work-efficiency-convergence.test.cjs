const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const work=require('../desktop/work-efficiency.cjs'),strategy=require('../desktop/strategy-recovery.cjs');
const policy=require('../desktop/protocol-access.cjs'),evidence=require('../desktop/evidence-basis.cjs');
const control=require('../desktop/execution-control.cjs'),acceptance=require('../desktop/acceptance.cjs');
const prohibited=async()=>{throw Error('Network/model access prohibited');};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-convergence-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited,platformRequest:prohibited});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 const job=agent.buildJob(a,{goal:'根据订单资料形成简明报告',maxActions:1});a.data.delegations.push(job);
 const task=a.createTask({title:'订单报告',criteria:'说明订单发布日期',steps:[{key:'draft',title:'正文',kind:'draft'}]});task.agentJobId=job.id;job.taskIds=[task.id];
 const source=agent.source(a,job,'orders','订单资料','订单在周五发布');task.sourceIds=[source.id];policy.retain(a,'source',source,{task,job});
 return {a,job,task,source,dir};
}
function draft(f,content='订单在周五发布。',step=f.task.steps[0]){
 const artifact={id:randomUUID(),taskId:f.task.id,stepId:step.id,title:'正文',content,createdAt:new Date().toISOString()};
 f.a.data.artifacts.push(artifact);Object.assign(step,{done:true,artifactId:artifact.id});policy.retain(f.a,'artifact',artifact,{task:f.task,job:f.job});
 require('../desktop/step-evidence.cjs').record(f.a,f.task,step);return artifact;
}
function observe(f,tool='advance_task'){return work.observe(f.a,f.job,{tool,args:{taskId:f.task.id}});}
function stall(f){work.before(f.a,f.job);for(let i=0;i<work.LIMITS.stopAt;i++)observe(f,'read_source');}
function passContent(f){f.task.contentVerification={passed:true,summary:'满足原要求',gaps:[],basis:control.contentBasis(f.a,f.job,f.task)};}
function passTask(f){f.task.status='review';f.task.verification={passed:true,summary:'满足原要求',gaps:[],basisVersion:2,basis:acceptance.basis(f.a,f.task)};}
function receipt(f,r,changes={}){
 const action={id:randomUUID(),jobId:f.job.id,taskId:f.task.id,artifactId:r.id,tool:'lark_update',content:r.content,status:'done',result:{verified:true,url:'https://fixture.invalid/doc/report'},...changes};
 f.a.data.agentActions.push(action);return action;
}

test('first draft is a milestone; repeated rewrites and gap rephrasing reach automatic recovery',t=>{
 const f=fixture(t);work.before(f.a,f.job);observe(f);draft(f);assert.equal(observe(f).attempts,0);
 for(let i=1;i<=work.LIMITS.stopAt;i++){
  draft(f,'日期仍未核实，新增版本说明 '+i);
  f.task.contentVerification={passed:false,summary:'仍有缺口',gaps:['相同日期缺口，换种说法 '+i],basis:control.contentBasis(f.a,f.job,f.task)};
  const result=observe(f);assert.equal(result.attempts,i);
  if(i===work.LIMITS.suggestAt)assert.equal(result.phase,'change_strategy');
 }
 assert.equal(work.inspect(f.job).phase,'recovery_pending');assert.equal(f.job.status,'ready');assert.notEqual(f.job.executionPaused,true);
 assert.equal(f.a.data.decisions.length,0);assert.equal((f.a.data.modelCalls||[]).length,0);
});

test('replacing step IDs, keys and titles does not turn a rewrite into another initial draft',t=>{
 const f=fixture(t);draft(f);work.before(f.a,f.job);observe(f);
 for(let i=0;i<3;i++){
  f.task.steps=[{id:randomUUID(),key:'renamed-'+i,title:'改写后的步骤 '+i,kind:'draft',done:false}];draft(f,'仅重写正文 '+i);
  assert.equal(observe(f).attempts,i+2);
 }
 const second={id:randomUUID(),key:'appendix',title:'附录',kind:'draft',done:false};f.task.steps.push(second);draft(f,'独立附录初稿',second);
 assert.equal(observe(f).attempts,0);
});

test('rewriting during recovery fails the strategy and retains tried keys across restart',t=>{
 const f=fixture(t);draft(f);f.task.steps[0].done=false;stall(f);
 const inputBasis=strategy.inputBasis(f.a,f.job);assert.equal(strategy.begin(f.a,f.job),true);
 const tried=structuredClone(f.job.executionState.workEfficiency.tried),step=strategy.next(f.a,f.job);strategy.started(f.a,f.job,step);
 draft(f,'自动纠偏生成新措辞，日期仍未核实');const result=work.observe(f.a,f.job,step);
 assert.equal(result.phase,'recovery_pending');assert.equal(f.job.executionState.workEfficiency.history.at(-1).outcome,'no_progress');
 assert.deepEqual(f.job.executionState.workEfficiency.tried,tried);assert.equal(strategy.inputBasis(f.a,f.job),inputBasis);
 f.a.save();const a=new Assistant({dir:f.dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited,platformRequest:prohibited});
 const job=a.data.delegations.find(j=>j.id===f.job.id);assert.deepEqual(job.executionState.workEfficiency.tried,tried);
 assert.equal(strategy.begin(a,job),true);assert.equal(job.executionState.workEfficiency.active.id,'replan');
});

test('v0.38.1 persisted hashes migrate without credit or loss of recovery history',t=>{
 for(const unfinished of [false,true]){
  const f=fixture(t),r=draft(f);work.before(f.a,f.job);const state=f.job.executionState.workEfficiency;
  delete state.progressVersion;state.seen=work.snapshot(f.a,f.job).facts.filter(x=>x.startsWith('evidence:'));state.seen.push('artifact:'+evidence.hash(r.content));
  Object.assign(state,{attempts:9,phase:'change_strategy',tried:{'old-route':{title:'已失败'}},history:[{id:'old-route',outcome:'no_progress'}]});
  if(unfinished)f.task.steps[0].done=false;
  const before=structuredClone({tried:state.tried,history:state.history});assert.equal(work.sync(f.a,f.job).changed,false);
  draft(f,'迁移后的改写正文');assert.equal(observe(f).attempts,10);assert.deepEqual({tried:state.tried,history:state.history},before);
 }
});

test('migration preserves adoption deduplication and lets an unchanged draft gain a real delivery',t=>{
 const f=fixture(t);require('../desktop/generation.cjs').adopt(f.a,{id:f.task.id,stepId:f.task.steps[0].id,title:'已有用户稿',content:'订单在周五发布。'});
 const r=f.a.data.artifacts.at(-1);work.before(f.a,f.job);const state=f.job.executionState.workEfficiency;
 delete state.progressVersion;state.seen=work.snapshot(f.a,f.job).facts.filter(x=>x.startsWith('evidence:'));state.seen.push('artifact:'+evidence.hash(r.content));
 Object.assign(state,{attempts:12,phase:'awaiting_change',waitBasis:strategy.inputBasis(f.a,f.job),tried:{used:{title:'已尝试'}}});f.job.status='blocked';f.a.save();
 const a=new Assistant({dir:f.dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited,platformRequest:prohibited});
 const job=a.data.delegations.find(j=>j.id===f.job.id),task=a.data.tasks.find(t=>t.id===f.task.id),restored={a,job,task};
 assert.equal(strategy.ready(a,job),false);assert.equal(work.inspect(job).attempts,12);assert.equal(job.status,'blocked');
 receipt(restored,r);assert.equal(strategy.ready(a,job),true);assert.equal(job.status,'ready');assert.equal(work.inspect(job).attempts,0);
 assert.deepEqual(job.executionState.workEfficiency.tried,{used:{title:'已尝试'}});
});

test('stale checks and deleted or renamed gaps do not count; a current passing content check does',t=>{
 const f=fixture(t);draft(f,'旧稿仍有错误');work.before(f.a,f.job);passContent(f);
 const old=f.task.contentVerification;draft(f,'补正订单发布日期为周五');observe(f);assert.equal(work.before(f.a,f.job).attempts,1);
 f.job.executionState.gaps=[{id:'same-gap',taskId:f.task.id,requirementId:'task:'+f.task.id,status:'satisfied',text:'换措辞'}];
 assert.equal(work.before(f.a,f.job).attempts,1);f.job.executionState.gaps=[];assert.equal(work.before(f.a,f.job).attempts,1);
 passContent(f);assert.notEqual(f.task.contentVerification.basis,old.basis);assert.equal(observe(f,'verify_content').attempts,0);
 for(let i=0;i<3;i++){draft(f,'核验后再次润色 '+i);passContent(f);assert.equal(observe(f,'verify_content').attempts,i+1);}
});

test('full verification is bound to current output and credited once per requirement',t=>{
 const f=fixture(t);draft(f);work.before(f.a,f.job);observe(f);passTask(f);draft(f,'改写但仍引用旧检查');
 assert.equal(work.before(f.a,f.job).attempts,1);passTask(f);assert.equal(observe(f).attempts,0);
 draft(f,'又换了新正文');passTask(f);assert.equal(observe(f).attempts,1);
 f.job.feedback.push({kind:'user_feedback',text:'新增要求：说明周六延期原因'});assert.equal(work.before(f.a,f.job).attempts,0);
 draft(f,'补充周六延期原因');observe(f);passTask(f);assert.equal(observe(f).attempts,0);
});

test('verified new deliveries and scoped evidence wake the guard, receipt replays do not',t=>{
 const f=fixture(t);draft(f);stall(f);const tried=structuredClone(f.job.executionState.workEfficiency.tried);
 const r=draft(f,'有真实交付回执的新稿');receipt(f,r);assert.equal(work.before(f.a,f.job).attempts,0);
 observe(f);receipt(f,r);assert.equal(work.before(f.a,f.job).attempts,1);
 f.source.content='新增事实：订单改为周六发布';assert.equal(work.before(f.a,f.job).attempts,0);
 assert.deepEqual(f.job.executionState.workEfficiency.tried,tried);
});

test('failed, conflicting, stale, foreign and inaccessible delivery receipts do not renew progress',t=>{
 for(const kind of ['unverified','conflict','content','foreign','readback','stale','input']){
  const f=fixture(t);draft(f);work.before(f.a,f.job);observe(f);const r=draft(f,'不能计功的新正文 '+kind),action=receipt(f,r);
  if(kind==='unverified')action.result.verified=false;
  if(kind==='conflict')action.deliveryConflict=true;
  if(kind==='content')action.content='旧稿';
  if(kind==='foreign')action.jobId='another-job';
  if(kind==='readback')action.result.sourceId='denied-readback';
  if(kind==='stale')r.stale=true;
  if(kind==='input')f.source.deleted=true;
  assert.equal(work.before(f.a,f.job).attempts,1,kind);
 }
});

test('user adoption replaces old output receipts and wakes exhausted recovery without renewing tried paths',t=>{
 const f=fixture(t);draft(f);work.before(f.a,f.job);f.task.steps[0].done=false;stall(f);
 while(strategy.begin(f.a,f.job)){strategy.next(f.a,f.job);work.request(f.a,f.job,{message:'没有新增成果'});}
 assert.equal(work.inspect(f.job).phase,'awaiting_change');const tried=structuredClone(f.job.executionState.workEfficiency.tried);
 require('../desktop/generation.cjs').adopt(f.a,{id:f.task.id,stepId:f.task.steps[0].id,title:'用户采纳稿',content:'订单已确认改为周六发布。'});
 assert.equal(strategy.ready(f.a,f.job),true);assert.equal(f.job.status,'ready');assert.equal(work.inspect(f.job).attempts,0);
 assert.deepEqual(f.job.executionState.workEfficiency.tried,tried);assert.equal(control.next(f.a,f.job).tool,'advance_task');
 observe(f);const imported=f.a.data.artifacts.at(-1);f.a.data.artifacts.push({...imported,id:randomUUID()});const replay=f.a.data.artifacts.at(-1);
 f.task.steps[0].artifactId=replay.id;policy.retain(f.a,'artifact',replay,{task:f.task,job:f.job});assert.equal(work.before(f.a,f.job).attempts,1);
});

test('scope, revocation and current input receipts gate all output milestones',t=>{
 for(const kind of ['denied','foreign','cancelled','deleted','input-revoked','input-changed','output-changed','replan']){
  const f=fixture(t);work.before(f.a,f.job);observe(f);const r=draft(f);passContent(f);passTask(f);
  if(kind==='denied')f.a.contextAccessCheck=()=>({decision:'deny'});
  if(kind==='foreign')r.projectId='foreign-project';
  if(kind==='cancelled')f.task.agentCancelled=true;
  if(kind==='deleted')f.task.deletedAt='now';
  if(kind==='input-revoked')f.source.deleted=true;
  if(kind==='input-changed'){f.task.steps[0].inputBasis.hash='obsolete';f.task.contentVerification=null;f.task.verification=null;}
  if(kind==='output-changed')r.content+=' 没有对应生成回执';
  if(kind==='replan')f.task.needsReplan='需要重新核对';
  assert.equal(work.before(f.a,f.job).attempts,1,kind);
 }
});

test('fresh outputs and new requirements cannot bypass terminal, pause, archive or budget gates',t=>{
 for(const kind of ['completed','cancelled','deleted','paused','archived','budget']){
  const f=fixture(t);draft(f);stall(f);const before=structuredClone(f.job.executionState.workEfficiency);
  if(kind==='deleted')f.job.deletedAt='now';
  else if(kind==='archived'){f.a.data.projects.push({id:'p',archivedAt:'now'});f.job.projectId='p';f.task.projectId='p';}
  else if(kind==='budget'){f.job.status='limited';f.job.limitReason='budget';}
  else f.job.status=kind;
  draft(f,'新的改写');f.job.feedback.push({kind:'user_feedback',text:'新增要求：延期原因'});
  assert.equal(work.sync(f.a,f.job).changed,false,kind);assert.deepEqual(f.job.executionState.workEfficiency,before,kind);
  assert.equal(work.next(f.a,f.job).action,null,kind);
  if(kind!=='deleted')assert.equal(strategy.schedule(f.a,f.job,{message:'无进展'}),false,kind);
 }
});

test('planning cannot defer first-draft credit until the next read',t=>{
 const f=fixture(t);work.before(f.a,f.job);draft(f);assert.equal(observe(f,'plan_task').attempts,1);
 assert.equal(work.before(f.a,f.job).attempts,1);draft(f,'重写正文');assert.equal(observe(f).attempts,2);
});

test('a retained main draft can converge after a scoped supporting repair using a current fixed snapshot',t=>{
 const f=fixture(t),revisions=require('../desktop/revision-protocol.cjs');
 const support={id:randomUUID(),key:'support',title:'辅助说明',kind:'analysis',done:false};f.task.steps.unshift(support);
 const oldSupport=draft(f,'旧辅助核验说明',support),main=draft(f,'订单在周五发布。',f.task.steps[1]);
 work.before(f.a,f.job);observe(f);
 revisions.queue(f.a,f.task,{artifactId:oldSupport.id,note:'只更正辅助说明的历史状态'});
 assert.equal(f.task.steps[1].artifactId,main.id);assert.equal(f.task.steps[1].done,true);
 draft(f,'辅助说明已按固定时点更正',support);assert.equal(observe(f).attempts,2);
 assert.notEqual(f.task.steps[1].inputBasis.hash,require('../desktop/step-evidence.cjs').snapshot(f.a,f.task,f.task.steps[1]).hash);
 passContent(f);f.task.contentVerification.snapshot=revisions.snapshot(f.a,f.task);
 assert.equal(observe(f,'verify_content').attempts,0);observe(f);
 passTask(f);f.task.verification.snapshot=revisions.snapshot(f.a,f.task);assert.equal(observe(f).attempts,0);
 assert.equal(f.task.steps[1].artifactId,main.id);
});

test('a current basis cannot relabel verification of an older fixed snapshot as progress',t=>{
 for(const full of [false,true]){
  const f=fixture(t),revisions=require('../desktop/revision-protocol.cjs');draft(f);work.before(f.a,f.job);
  const snapshot=revisions.snapshot(f.a,f.task);draft(f,'当前版本');observe(f);
  if(full)passTask(f);else passContent(f);
  const check=full?f.task.verification:f.task.contentVerification;check.snapshot=snapshot;
  assert.equal(work.before(f.a,f.job).attempts,1);
  check.snapshot=revisions.snapshot(f.a,f.task);assert.equal(work.before(f.a,f.job).attempts,0);
 }
});
