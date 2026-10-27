'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {setup}=require('./helpers/tool-observation-fixture.cjs'),tool=require('../desktop/tool-evidence.cjs'),ground=require('../desktop/grounding.cjs'),{hash}=require('../desktop/evidence-basis.cjs');

for(const change of ['unchanged','changed','missing'])test(`expired action_status preserves only the actual observation (${change})`,async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const r=tool.execute(f.a,f.task,f.request),review=f.report(r);assert.equal(r.output.observedAt,r.observedAt);
 t.mock.timers.tick(90000);
 if(change==='changed')fs.writeFileSync(f.action.target,'后来修改。');
 if(change==='missing')fs.unlinkSync(f.action.target);
 assert.equal(tool.valid(f.a,f.task,r),false);assert.equal(tool.observationValid(f.a,f.task,r),true);
 assert.equal(tool.current(f.a,f.task).length,0);assert.equal(tool.readable(f.a,f.task).length,1);
 const checked=review.finish();assert.equal(checked.passed,true,checked.summary);assert.equal(checked.grounding.claims[0].citations[0].temporalScope,'observed_at');
 assert.equal(checked.grounding.claims[0].qualification.quote,review.artifact.content);
 assert.equal(f.task.toolExecutions.length,1,'validation is not an explicit tool execution');
 f.a.save();const restored=new(require('../desktop/core.cjs').Assistant)({dir:f.dir});assert.equal(tool.observationValid(restored,restored.task(f.task.id),restored.task(f.task.id).toolEvidence[0]),true);
 const fresh=tool.execute(f.a,f.task,f.request);assert.notEqual(fresh.id,r.id);assert.equal(fresh.output.status,change==='changed'?'content_mismatch':change==='missing'?'file_missing':'readback_verified');
});

test('a slow real verification lifecycle accepts time-bound observation without a second model call',async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});const r=tool.execute(f.a,f.task,f.request),review=f.report(r);let calls=0;
 f.a.chat=async(_provider,_key,messages,options)=>{
  calls++;assert.match(messages[0].content,/观察时点/);const context=require('../desktop/model-input.cjs').materialize(JSON.parse(messages[1].content));assert.ok(context.toolEvidence.some(e=>e.id===r.id));
  options.onUsage?.({inputTokens:10,outputTokens:5});t.mock.timers.tick(90000);return review.result;
 };
 const result=await require('../desktop/generation-context.cjs').call(f.a,f.task,'独立核验',f.a.context(f.task,{verification:true}),'verify');
 assert.equal(result.passed,true,result.summary);assert.equal(calls,1);assert.equal(f.task.toolExecutions.length,1);
});

test('readback, generation, slow task verification, goal verification and acceptance complete on the production path',async t=>{
 const f=await setup(t),path=require('node:path');t.mock.timers.enable({apis:['Date'],now:Date.now()});let workers=0,checks=0,goals=0;
 const content='本轮只读核验时，旧文件存在且正文与历史记录一致。';
 f.a.chat=async(_p,_k,_m,o)=>{
  o.onUsage?.({inputTokens:10,outputTokens:5});
  if(o.stage==='goal_verify'){goals++;return {passed:true,summary:'时点说明已完成',gaps:[]};}
  if(o.role==='verify'){
   checks++;const draft=require('../desktop/deliverables.cjs').primary(f.a,f.task),r=f.task.toolEvidence[0];t.mock.timers.tick(90000);
   return {passed:true,summary:'仅按明确观察时点核验',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[draft.id],requirements:ground.requirements(f.a,f.task).map(q=>({id:q.id,status:'satisfied',claimIds:['c']})),claims:[{id:'c',artifactId:draft.id,field:'content',text:content,kind:'fact',supported:true,citationIds:['e']}],citations:[{id:'e',sourceId:r.id,quote:r.resultText}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}};
  }
  workers++;if(workers===1)return {kind:'read_context',requests:[f.request]};assert.equal(workers,2);return {kind:'artifact',title:'只读说明',content};
 };
 const result=await require('../scripts/readiness/lifecycle.cjs').advance(f.a,f.task,path.resolve(__dirname,'..'));
 assert.equal(result.completionChecked,true,JSON.stringify({result,verification:f.task.verification}));assert.equal(workers,2);assert.equal(checks,1);assert.equal(goals,1);
 await f.a.dispatch('taskAction',{id:f.task.id,command:'accept'});assert.equal(f.task.status,'completed');assert.equal(f.job.status,'completed');assert.equal(f.a.data.agentActions.length,1);
});

for(const content of ['现在旧文件仍存在且内容一致。','本轮核验时，文件一致，现在仍然一致。','本轮核验时，文件已经交付。','文件存在且内容一致。','本轮核验时，另一文件存在。\n\n旧文件现在仍存在。'])test('expired observation cannot certify a current or unbound claim: '+content,async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});const r=tool.execute(f.a,f.task,f.request),review=f.report(r,content);t.mock.timers.tick(90000);
 assert.equal(review.finish().passed,false);assert.match(review.finish().summary,/历史观察须绑定/);
});

test('fresh current proof expires in cache; qualified historical proof does not gain current validity',async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});const r=tool.execute(f.a,f.task,f.request),fresh=f.report(r,'现在旧文件仍存在且内容一致。').finish();
 assert.equal(fresh.passed,true);f.task.grounding=fresh.grounding;assert.ok(ground.reusable(f.a,f.task));
 t.mock.timers.tick(90000);assert.equal(ground.reusable(f.a,f.task),null);
 const old=f.report(r).finish();assert.equal(old.passed,true);f.task.grounding=old.grounding;assert.ok(ground.reusable(f.a,f.task));
 fs.writeFileSync(f.action.target,'之后改变。');assert.ok(ground.reusable(f.a,f.task));assert.equal(tool.valid(f.a,f.task,r),false);
 f.job.folderIds=[];assert.equal(ground.reusable(f.a,f.task),null);
});

for(const change of ['permission','artifact','action','cross-task','forged','no-event','legacy'])test('historical status evidence fails closed after '+change,async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});let r=tool.execute(f.a,f.task,f.request);t.mock.timers.tick(90000);
 if(change==='permission')f.job.folderIds=[];
 if(change==='artifact')f.a.data.artifacts.find(a=>a.id===f.action.artifactId).withdrawn=true;
 if(change==='action')f.action.content+=' change';
 if(change==='cross-task')f.action.taskId='other';
 if(change==='no-event')f.task.toolExecutions=[];
 if(change==='legacy'||change==='forged'){
  r=structuredClone(r);if(change==='legacy')delete r.observationBasis;else {r.output.files[0].excerpt='伪造';r.output.readbackHash=hash(r.output.files);r.resultText=JSON.stringify(r.output);}
  r.contentHash=hash({...r,contentHash:undefined});f.task.toolEvidence=[r];
 }
 assert.equal(tool.observationValid(f.a,f.task,r),false);assert.equal(tool.readable(f.a,f.task).length,0);
});

test('scope binds visible complete sentence only, including a sibling claim in that sentence',async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});const r=tool.execute(f.a,f.task,f.request),review=f.report(r,'本轮核验时，旧文件存在，正文与历史记录一致。后续安排未核验。');
 const c=review.result.groundingReview.claims[0];c.text='正文与历史记录一致';c.start=review.artifact.content.indexOf(c.text);t.mock.timers.tick(90000);
 assert.equal(review.finish().passed,true);
 c.qualification={field:'content',quote:'正文与历史记录一致'};assert.equal(review.finish().passed,false);
 delete c.qualification;review.seen.claimFields.clear();assert.equal(review.finish().passed,false);
});
