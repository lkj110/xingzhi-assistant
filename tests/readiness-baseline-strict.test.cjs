'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const evaluate=require('../scripts/readiness/evaluate.cjs');

test('frozen baseline strict v3 reports complete the shared revision evaluator through both real acceptances',{skip:!process.env.XINGZHI_READINESS_BASELINE},async t=>{
 const root=path.resolve(process.env.XINGZHI_READINESS_BASELINE),load=name=>require(path.join(root,'desktop',name+'.cjs'));
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'readiness-baseline-strict-')));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));
 const grounding=load('grounding'),deliverables=load('deliverables'),records=[];let task,phase='initial';
 assert.equal(grounding.VERSION,3,'This compatibility probe targets the sealed compact-v3 baseline.');
 const a=new (load('core').Assistant)({dir,chat:async(p,k,m,o)=>{
  records.push({id:records.length+1,phase,role:o.role,stage:o.stage,status:'completed',usage:{inputTokens:10,outputTokens:5}});
  o.onUsage?.({inputTokens:10,outputTokens:5});
  assert.ok(!m[0].content.includes('动作格式'),'The product must claim its actual completion candidate.');
  if(o.stage==='goal_verify')return {passed:true,summary:'当前版本已完成整体核验',gaps:[]};
  if(o.role==='verify'){
   const artifact=deliverables.primary(a,task);
   return {passed:true,summary:'当前稿准确转述用户记录',gaps:[],groundingReview:{format:'compact-v3',scannedArtifactIds:[artifact.id],requirements:grounding.requirements(a,task).map(r=>({id:r.id,status:'satisfied',claimIds:['c']})),claims:[{id:'c',artifactId:artifact.id,text:artifact.content,kind:'fact',supported:true,citationIds:['e']}],citations:[{id:'e',sourceId:'user:description',quote:artifact.content}],unsupportedClaims:[],conflicts:[]}};
  }
  return phase==='initial'?{kind:'artifact',title:'记录说明',content:'用户记录：第一版12件。'}:{kind:'patch',edits:[{before:'用户记录：第一版12件。',after:'用户记录：第二版18件。'}],summary:'按要求引用第二版'};
 }});
 a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;a.data.settings.autoComplete=false;
 await a.dispatch('saveProvider',{name:'offline',model:'offline',baseUrl:'http://127.0.0.1:1',key:'offline',inputPrice:0,outputPrice:0});
 // Capture facts through the real user command. The baseline has no source
 // prefetch; this six-call lifecycle probe uses its genuine userInputs path.
 await a.dispatch('createTask',{title:'记录说明',description:'请整理用户记录：第一版12件。',criteria:'准确转述用户提供的当前记录',sourceIds:[],generationMode:'single',steps:[{title:'说明',kind:'draft'}]});task=a.data.tasks[0];
 const job=load('agent').buildJob(a,{goal:'说明指定版本记录',autoAccept:false,allowWeb:false,maxActions:1});
 a.data.delegations.push(job);task.agentJobId=job.id;task.agentKey='one';job.taskIds=[task.id];job.sourceIds=[...task.sourceIds];
 const result=await evaluate.run({a,task,root,lane:'revision',revision:{description:'请整理用户记录：第二版18件。',note:'改为第二版'},records,setPhase:value=>{phase=value;}});
 assert.equal(result.procedureComplete,true,JSON.stringify(result));assert.equal(result.delivered,true);assert.equal(result.technicalError,null);
 assert.equal(records.length,6);assert.deepEqual(records.map(r=>r.phase),['initial','initial','initial','revision','revision','revision']);
 assert.deepEqual(result.transitions.map(r=>r.name),['acceptedInitial','reopened','revisionRequested','acceptedRevision']);
 assert.ok(result.phases.every(r=>r.completeCheck&&r.taskPassed&&r.goalComplete&&r.goalPassed&&r.usageKnown&&r.grounding.version===3));
 assert.deepEqual(result.phases.map(r=>r.taskCheckCallIds.length),[1,1]);assert.deepEqual(result.phases.map(r=>r.goalCheckCallIds.length),[1,1]);
 assert.notEqual(result.phases[0].grounding.basis,result.phases[1].grounding.basis);assert.notEqual(result.phases[0].completionCheck.basis,result.phases[1].completionCheck.basis);
 assert.equal(deliverables.primary(a,task).content,'用户记录：第二版18件。');assert.equal(task.status,'completed');assert.equal(job.status,'completed');
 const reopened=new (load('core').Assistant)({dir});assert.equal(reopened.task(task.id).status,'completed');assert.equal(reopened.task(task.id).grounding.passed,true);
});
