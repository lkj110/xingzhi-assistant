'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),ground=require('../desktop/grounding.cjs'),evaluate=require('../scripts/readiness/evaluate.cjs');
const root=path.resolve(__dirname,'..');
async function setup(t,{goalPass=true,taskPass=true,stopStage,stopPhase='initial',cap=96,malformedGoalPhase,malformedTaskPhase}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'readiness-driver-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));let phase='initial',task;const records=[];
 const a=new Assistant({dir,chat:async(p,k,m,o)=>{
  if(records.length>=cap)throw Object.assign(Error('EVAL_BUDGET_LIMIT'),{code:'EVAL_BUDGET_LIMIT'});
  const row={id:records.length+1,phase,stage:o.stage,role:o.role,status:'running'};records.push(row);
  if(o.stage===stopStage&&phase===stopPhase){row.status='failed';throw Object.assign(Error('EVAL_USAGE_UNKNOWN'),{code:'EVAL_USAGE_UNKNOWN'});}
  row.status='completed';row.usage={inputTokens:10,outputTokens:5};o.onUsage?.(row.usage);
  assert.ok(!m[0].content.includes('动作格式'));
  if(o.stage==='goal_verify')return {passed:phase===malformedGoalPhase?'invalid':goalPass,summary:goalPass?'全部完成':'整体条件未满足',gaps:goalPass?[]:['整体条件未满足']};
  if(o.role==='verify'){
   if(phase===malformedTaskPhase)throw Object.assign(Error('invalid task verification response'),{code:'MODEL_INVALID_RESPONSE'});
   const artifact=require('../desktop/deliverables.cjs').primary(a,task),source=a.data.sources[0];
   return {passed:taskPass,summary:taskPass?'证据已核对':'原文不支持',gaps:taskPass?[]:['原文不支持'],groundingReview:{format:'compact-v5',scannedArtifactIds:[artifact.id],requirements:ground.requirements(a,task).map(r=>({id:r.id,status:taskPass?'satisfied':'gap',claimIds:['c']})),claims:[{id:'c',artifactId:artifact.id,text:artifact.content,kind:'fact',supported:taskPass,citationIds:['e']}],citations:[{id:'e',sourceId:source.id,quote:source.content}],unsupportedClaims:taskPass?[]:['原文不支持'],conflicts:[],consistencyIssues:[]}};
  }
  return phase==='initial'?{kind:'artifact',title:'说明',content:'第一版记录：12件。'}:{kind:'patch',title:'修订说明',edits:[{before:'第一版记录：12件。',after:'第二版记录：18件。'}],summary:'按要求改为第二版'};
 }});
 a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;a.data.settings.autoComplete=false;
 await a.dispatch('saveProvider',{name:'offline',model:'offline',baseUrl:'http://127.0.0.1:1',key:'offline',inputPrice:0,outputPrice:0});
 a.addSources([{title:'双版本记录',content:'第一版记录：12件。第二版记录：18件。'}]);
 task=a.createTask({title:'说明',description:'引用第一版记录',criteria:'准确引用指定版本',sourceIds:[a.data.sources[0].id],generationMode:'single',steps:[{title:'说明',kind:'draft'}]});
 const job=agent.buildJob(a,{goal:'说明指定版本',autoAccept:false,allowWeb:false,maxActions:1});a.data.delegations.push(job);task.agentJobId=job.id;task.agentKey='one';job.taskIds=[task.id];job.sourceIds=[...task.sourceIds];
 return {a,task,job,records,run:lane=>evaluate.run({a,task,root,lane,revision:{description:'改为引用第二版记录',note:'改为第二版'},records,setPhase:v=>{phase=v;}})};
}
test('driver accounts for six real lifecycle calls and both accepted versions',async t=>{
 const f=await setup(t),r=await f.run('revision');assert.equal(r.procedureComplete,true,JSON.stringify(r));assert.equal(r.delivered,true);assert.equal(f.records.length,6);assert.deepEqual(r.transitions.map(t=>t.name),['acceptedInitial','reopened','revisionRequested','acceptedRevision']);
 assert.deepEqual(r.phases.map(p=>p.taskCheckCallIds.length),[1,1]);assert.deepEqual(r.phases.map(p=>p.goalCheckCallIds.length),[1,1]);assert.ok(r.phases.every(p=>p.completeCheck&&p.taskPassed&&p.goalPassed));assert.equal(f.records.reduce((n,r)=>n+r.usage.inputTokens+r.usage.outputTokens,0),90);
 assert.notEqual(r.phases[0].completionCheck.basis,r.phases[1].completionCheck.basis);assert.notEqual(r.phases[0].grounding.basis,r.phases[1].grounding.basis);
});
test('failed whole-job verification never triggers accept or revision',async t=>{
 const f=await setup(t,{goalPass:false}),r=await f.run('revision');assert.equal(r.procedureComplete,false);assert.equal(r.delivered,false);assert.equal(r.phases[0].taskPassed,true);assert.equal(r.phases[0].goalPassed,false);assert.equal(r.phases[0].goalComplete,true);assert.equal(r.technicalError,null);assert.equal(r.transitions.length,0);assert.equal(f.records.length,3);assert.equal(f.task.acceptedAt,undefined);
});

test('a completed transport call without a current whole-job result is a technical interruption',async t=>{
 for(const phase of ['initial','revision']){
  const f=await setup(t,{malformedGoalPhase:phase}),r=await f.run('revision'),last=r.phases.at(-1);
  assert.equal(last.phase,phase);assert.equal(last.taskPassed,true);assert.ok(last.goalCheckCallIds.length>0);assert.equal(last.usageKnown,true);
  assert.equal(last.goalComplete,false);assert.equal(r.technicalError,'EVAL_GOAL_CHECK_INCOMPLETE');assert.equal(r.procedureComplete,false);assert.equal(r.delivered,false);
 }
});

test('task result requires a current, intact report rather than old booleans or transport completion',async t=>{
 const f=await setup(t),successful=await f.run('e2e');assert.equal(successful.phases[0].completeCheck,true);
 const artifact=require('../desktop/deliverables.cjs').primary(f.a,f.task),original=artifact.content;artifact.content='changed after verification';
 assert.equal(f.task.verification.passed,true);assert.equal(f.task.grounding.passed,true);assert.equal(evaluate.snapshot(f.a,f.task,root,'initial',f.records).technicalError,'EVAL_TASK_CHECK_INCOMPLETE');
 artifact.content=original;f.task.grounding.issues.push('tampered');assert.equal(evaluate.snapshot(f.a,f.task,root,'initial',f.records).completeCheck,false);
 const failed=await setup(t,{malformedTaskPhase:'revision'}),r=await failed.run('revision'),last=r.phases.at(-1);
 assert.equal(last.phase,'revision');assert.equal(last.usageKnown,true);assert.ok(last.taskCheckCallIds.length>0);assert.equal(last.completeCheck,false);assert.equal(r.technicalError,'EVAL_TASK_CHECK_INCOMPLETE');assert.equal(r.procedureComplete,false);
});
test('fixed-draft lane measures rejection without automatic planner repair',async t=>{
 const f=await setup(t,{taskPass:false}),step=f.task.steps[0],artifact={id:'fixed',taskId:f.task.id,stepId:step.id,title:'说明',content:'原文没有支持的固定稿。'};
 f.a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(f.a,'artifact',artifact,{task:f.task});step.done=true;step.artifactId=artifact.id;require('../desktop/deliverables.cjs').record(f.a,f.task,step,artifact,{});
 const r=await f.run('fixed');assert.equal(r.procedureComplete,true);assert.equal(r.delivered,false);assert.equal(f.records.length,1);assert.equal(f.a.data.artifacts.length,1);assert.equal(r.phases[0].completeCheck,true);assert.equal(r.phases[0].goalCheckCallIds.length,0);
});
test('unknown usage in a goal check cannot be recorded as task rejection or successful revision',async t=>{
 const f=await setup(t,{stopStage:'goal_verify',stopPhase:'revision'}),r=await f.run('revision');assert.equal(r.procedureComplete,false);assert.equal(r.delivered,false);assert.equal(r.phases.length,2);assert.equal(r.phases[1].taskPassed,true);assert.equal(r.phases[1].goalPassed,false);assert.equal(r.phases[1].goalCheckCallIds.length,0);assert.equal(f.records.at(-1).status,'failed');assert.equal(r.transitions.at(-1).name,'revisionRequested');
});
test('global call admission also covers whole-job verification and stops without acceptance',async t=>{
 const f=await setup(t,{cap:2}),r=await f.run('e2e');assert.equal(f.records.length,2);assert.equal(r.procedureComplete,false);assert.equal(r.delivered,false);assert.equal(f.task.acceptedAt,undefined);assert.equal(r.phases[0].goalPassed,false);
});

test('each run attributes only its newly appended calls even with a shared ledger',async t=>{
 const f=await setup(t);f.records.push({id:'prior-branch',phase:'initial',stage:'goal_verify',role:'verify',status:'completed',usage:null});
 const r=await f.run('e2e');assert.equal(r.procedureComplete,true);assert.equal(r.phases[0].callCount,3);assert.equal(r.phases[0].usageKnown,true);assert.ok(!r.phases[0].goalCheckCallIds.includes('prior-branch'));
});

test('invalid or unfinished usage and post-check acceptance failures remain technical failures',async t=>{
 const f=await setup(t);await f.run('e2e');
 const record=f.records[0];record.usage.inputTokens=-1;assert.equal(evaluate.snapshot(f.a,f.task,root,'initial',f.records).technicalError,'EVAL_USAGE_UNKNOWN');
 record.usage.inputTokens=10;record.status='running';assert.equal(evaluate.snapshot(f.a,f.task,root,'initial',f.records).technicalError,'EVAL_USAGE_UNKNOWN');
 const fresh=await setup(t),dispatch=fresh.a.dispatch;fresh.a.dispatch=async function(type,args){if(type==='taskAction'&&args.command==='accept')throw Object.assign(Error('snapshot unavailable'),{code:'EVAL_STORAGE_FAILURE'});return dispatch.call(this,type,args);};
 const r=await fresh.run('e2e');assert.equal(r.phases[0].taskPassed,true);assert.equal(r.phases[0].goalPassed,true);assert.equal(r.procedureComplete,false);assert.equal(r.delivered,false);assert.equal(r.technicalError,'EVAL_STORAGE_FAILURE');
});
