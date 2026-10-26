'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),ground=require('../desktop/grounding.cjs');
function setup(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'r7-independent-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));
 const a=new Assistant({dir,chat:async()=>{throw Error('Offline review must never call a model');}});a.data.settings.evidenceGrounding=true;
 a.data.providers.push({id:'offline',name:'offline',model:'offline',baseUrl:'http://127.0.0.1:1',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'offline',execute:'offline',verify:'offline'};
 const task=a.createTask({title:'方案说明',description:'采用 Q1 方案。',criteria:'保留未知边界。',steps:[{title:'完整稿',kind:'draft'}]});
 const job=agent.buildJob(a,{goal:task.description+'\n不得发送通知。',autoAccept:false});job.taskIds=[task.id];task.agentJobId=job.id;a.data.delegations.push(job);a.save();return {a,task,job};
}
for(const surface of ['planner','content_check'])test(`retired goal and wrapped directives stay retired in production ${surface} requirement surfaces`,async t=>{
 const f=setup(t),old=f.task.description,note='新增 Q2 附录。';await f.a.dispatch('updateTask',{id:f.task.id,description:'改用 Q2 方案。'});
 await f.a.dispatch('taskAction',{id:f.task.id,command:'feedback',note});
 f.job.feedback.push({taskId:f.task.id,kind:'task_feedback',at:f.job.feedback.at(-1).at,text:'事项「方案说明」收到补充：'+note});
 const context=surface==='planner'?agent.context(f.a,f.job):require('../desktop/execution-control.cjs').contentRequest(f.a,f.job,f.task).context;
 const requirements=surface==='planner'?context.executionControl.requirements:context.requirements;
 const goal=requirements.find(r=>r.id==='goal');assert.ok(!goal.text.split('\n').includes(old),'retired original goal must not re-enter another authoritative requirement surface');
 assert.equal(goal.userDirectives.filter(r=>r.text===note).length,1);assert.ok(!goal.userDirectives.some(r=>r.text.startsWith('事项「')));
 assert.match(goal.text,/不得发送通知/);
});
test('later user feedback in the same clock tick as a contract keeps journal precedence',async t=>{
 const f=setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});
 await f.a.dispatch('agentContract',{id:f.job.id,text:'以 Q2 为当前方案。'});
 await f.a.dispatch('taskAction',{id:f.task.id,command:'feedback',note:'另须保留第三方审批条件。'});
 const latest=f.task.notes.at(-1);assert.ok(latest.workSequence>f.job.executionContract.workSequence);
 assert.ok(ground.requirements(f.a,f.task).some(r=>r.text==='另须保留第三方审批条件。'),'a later committed requirement cannot disappear due to equal wall-clock timestamp');
});
test('multiline requirement dedup retains the precedence of a later reasserted line',()=>{
 const task={id:'t',agentJobId:'j',title:'方案',description:'说明',criteria:'',notes:[]};
 const job={id:'j',taskIds:['t'],goal:'说明',feedback:[{at:'1',text:'采用 Q1。\n保留审批条件。'},{at:'2',text:'采用 Q2。'},{at:'3',text:'采用 Q1。'}]};
 const texts=ground.requirements({data:{delegations:[job]}},task).map(r=>r.text);
 assert.ok(texts.indexOf('采用 Q1。')>texts.indexOf('采用 Q2。'),'latest reassertion must remain after the intervening conflicting directive');
 assert.equal(texts.filter(r=>r==='采用 Q1。').length,1);assert.ok(texts.includes('保留审批条件。'));
});
function addGoalSources(f,count){
 f.a.addSources(Array.from({length:count},(_,i)=>({title:'来源 '+i,content:'规则 '+i+'：'+String.fromCharCode(65+i).repeat(1000)+'\n例外 '+i+'：须另行审批。'})));
 f.job.sourceIds=f.a.data.sources.map(s=>s.id);f.task.sourceIds=[...f.job.sourceIds];
 for(const source of f.a.data.sources)require('../desktop/protocol-access.cjs').retain(f.a,'source',source,{job:f.job});f.a.save();
}
test('whole-goal preparation caps source count and exposes every deferred continuation',t=>{
 const f=setup(t);addGoalSources(f,10);const value=require('../desktop/goal-evidence.cjs').prepare(f.a,f.job,{contextReads:[]});
 assert.equal(value.diagnostic.preparedSourceIds.length,8);assert.equal(value.diagnostic.deferred.length,2);assert.ok(value.diagnostic.characters<=48000);
 const accounted=new Set([...value.diagnostic.preparedSourceIds,...value.diagnostic.deferred.map(r=>r.sourceId)]);assert.equal(accounted.size,10);
 for(const deferred of value.diagnostic.deferred){assert.equal(deferred.resumeRequest.tool,'read_source');assert.equal(deferred.resumeRequest.sourceId,deferred.sourceId);assert.ok(deferred.resumeRequest.version);}
});
test('trimming prepared goal bodies revokes complete coverage while retaining scope and resume identity',t=>{
 const f=setup(t);addGoalSources(f,2);const value=require('../desktop/goal-evidence.cjs').prepare(f.a,f.job,{contextReads:[]});
 assert.ok(value.rows.every(r=>r.result.coverage.complete));
 const input=require('../desktop/model-input.cjs').materialize(require('../desktop/context-evidence.cjs').bounded({contextReads:value.rows,goalEvidencePreparation:value.diagnostic},{maxChars:12}));
 for(const [index,row] of input.contextReads.entries()){
  assert.equal(row.result.complete,false);assert.equal(row.result.coverage.complete,false);assert.equal(row.result.bodyOmitted,true);assert.notEqual(row.result.next,null);
  assert.equal(row.result.version,value.rows[index].result.version);assert.equal(row.result.policyRevision,value.rows[index].result.policyRevision);
  assert.equal(row.result.resumeRequest.sourceId,row.request.sourceId);assert.equal(row.result.resumeRequest.version,row.result.version);
 }
 assert.equal(input.goalEvidencePreparation.complete,undefined);assert.match(input.goalEvidencePreparation.note,/不代表模型已完整阅读/);
});
test('a retired goal line invalidates gaps recorded for the previous projected requirement',async t=>{
 const f=setup(t),obligations=require('../desktop/work-obligations.cjs');
 const old={...obligations.requirements(f.a,f.job).find(r=>r.id==='goal')};
 f.job.executionState.gaps.push({id:'old-q1-gap',requirementId:'goal',requirementRevision:old.revision,text:'尚未采用 Q1 方案。',status:'open'});
 await f.a.dispatch('updateTask',{id:f.task.id,description:'改用 Q2 方案。'});
 const current=obligations.requirements(f.a,f.job).find(r=>r.id==='goal');
 assert.notEqual(current.text,old.text);assert.notEqual(current.revision,old.revision,'requirement revision must fence the projected requirement content');
 assert.equal(f.job.executionState.gaps.find(g=>g.id==='old-q1-gap').status,'superseded');
});
for(const migrateFirst of [false,true])test(`legacy requirement gap expires when its goal is retired (migrateFirst=${migrateFirst})`,async t=>{
 const f=setup(t),obligations=require('../desktop/work-obligations.cjs'),evidence=require('../desktop/evidence-basis.cjs');
 const oldRevision=evidence.hash({id:'goal',intent:evidence.intent(f.job,null)}),state=require('../desktop/operation-ledger.cjs').state(f.job);
 state.requirements=[{id:'goal',text:f.job.goal,revision:oldRevision}];
 state.gaps=[{id:'legacy-q1-gap',requirementId:'goal',requirementRevision:oldRevision,text:'尚未采用 Q1 方案。',status:'open'}];
 if(migrateFirst){
  const before=structuredClone(state.gaps),goal=obligations.requirements(f.a,f.job).find(r=>r.id==='goal');
  assert.equal(goal.revision,oldRevision);assert.deepEqual(state.gaps,before,'migration alone cannot erase unchanged open obligations');
 }
 await f.a.dispatch('updateTask',{id:f.task.id,description:'改用 Q2 方案。'});
 const current=obligations.requirements(f.a,f.job).find(r=>r.id==='goal');
 assert.notEqual(current.revision,oldRevision);assert.equal(state.gaps.find(g=>g.id==='legacy-q1-gap').status,'superseded');
});
