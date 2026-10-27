'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const repo='../';
const {setup}=require(repo+'tests/helpers/tool-observation-fixture.cjs');
const tool=require(repo+'desktop/tool-evidence.cjs');

for(const content of ['当前计划','已交付','当前计划。已交付'])for(const explicit of [false,true])test('a historical literal quotation is not a current or delivery assertion: '+content+' explicit='+explicit,async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});
 f.action.content=content;f.a.data.artifacts.find(a=>a.id===f.action.artifactId).content=content;fs.writeFileSync(f.action.target,content);
 const r=tool.execute(f.a,f.task,f.request),review=f.report(r,'本轮核验时，文件正文为“'+content+'”。');t.mock.timers.tick(90000);
 if(explicit)review.result.groundingReview.claims[0].qualification={field:'content',quote:review.artifact.content};
 assert.equal(review.finish().passed,true,review.finish().summary);
});

for(const content of [
 '本轮核验时，文件正文为“当前计划”，现在仍然一致。',
 '本轮核验时，文件正文为“已交付”，已经交付。',
 '本轮核验时，“现在旧文件仍存在且内容一致”。',
 '本轮核验时，旧文件一致，不能据此证明已交付，但已交付。',
 '本轮核验时，旧文件一致，不能据此证明当前状态，现在仍然一致。',
 '本轮核验时，旧文件一致。现在仍然一致。',
 '本轮核验时，旧文件一致，尚未证明已交付，现在已经交付。'
])for(const explicit of [false,true])test('attribution and disclaimer never cover a current affirmative: '+content+' explicit='+explicit,async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const r=tool.execute(f.a,f.task,f.request),review=f.report(r,content);t.mock.timers.tick(90000);
 if(explicit)review.result.groundingReview.claims[0].qualification={field:'content',quote:review.artifact.content};
 assert.equal(review.finish().passed,false,content);
});

for(const explicit of [false,true])test('an explicit delivery disclaimer does not assert delivery, explicit='+explicit,async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const r=tool.execute(f.a,f.task,f.request),review=f.report(r,'本轮核验时，旧文件存在且正文与历史记录一致，不能据此证明已交付。');t.mock.timers.tick(90000);
 if(explicit)review.result.groundingReview.claims[0].qualification={field:'content',quote:review.artifact.content};
 assert.equal(review.finish().passed,true,review.finish().summary);
});

for(const limit of ['不证明文件现在仍一致','不能据此证明当前状态'])for(const explicit of [false,true])test('tool-note current-state disclaimer does not assert current state: '+limit+' explicit='+explicit,async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const r=tool.execute(f.a,f.task,f.request),review=f.report(r,'本轮核验时，旧文件存在且正文与历史记录一致，'+limit+'。');t.mock.timers.tick(90000);
 if(explicit)review.result.groundingReview.claims[0].qualification={field:'content',quote:review.artifact.content};
 assert.equal(review.finish().passed,true,review.finish().summary);
});

for(const code of ['CONTEXT_INVALID_REQUEST','CONTEXT_VERSION_CHANGED','CONTEXT_SCOPE_DENIED','ABORT_ERR'])test('reader errors stay hard failures: '+code,async t=>{
 const f=await setup(t),writes=require(repo+'desktop/agent-writes.cjs'),failure=Object.assign(Error('reader error'),{code});
 t.mock.method(writes,'observeRecordedFile',()=>{throw failure;});
 await assert.rejects(tool.readRequests(f.a,f.task,[f.request],()=>{throw Error('unexpected next');}),e=>e===failure);
 assert.equal(f.task.toolEvidence,undefined);assert.equal(f.task.toolExecutions,undefined);
});

test('capture identity changes during file comparison fail closed',async t=>{
 const f=await setup(t),writes=require(repo+'desktop/agent-writes.cjs'),original=writes.observeRecordedFile;
 t.mock.method(writes,'observeRecordedFile',(...args)=>{const result=original(...args);f.action.finishedAt='2024-01-01T00:00:00Z';return result;});
 assert.throws(()=>tool.execute(f.a,f.task,f.request),e=>e.code==='CONTEXT_VERSION_CHANGED');
 assert.equal(f.task.toolEvidence,undefined);assert.equal(f.task.toolExecutions,undefined);
});

test('exact observedAt anchors reject a different receipt time',async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});const r=tool.execute(f.a,f.task,f.request);t.mock.timers.tick(90000);
 const good=f.report(r,'在'+r.observedAt+'时，旧文件存在且正文与历史记录一致。');assert.equal(good.finish().passed,true,good.finish().summary);
 const bad=f.report(r,'在'+new Date(Date.parse(r.observedAt)+1).toISOString()+'时，旧文件存在且正文与历史记录一致。');assert.equal(bad.finish().passed,false);
});

test('expiry boundary preserves historical evidence but never current validity',async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});const r=tool.execute(f.a,f.task,f.request);
 t.mock.timers.tick(59999);assert.equal(tool.valid(f.a,f.task,r),true);
 t.mock.timers.tick(1);assert.equal(tool.valid(f.a,f.task,r),false);assert.equal(tool.observationValid(f.a,f.task,r),true);
});

test('legacy status remains fresh-only and an explicit reread creates the new capture',async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const hash=require(repo+'desktop/evidence-basis.cjs').hash,events=require(repo+'desktop/tool-execution-events.cjs');
 const legacy=structuredClone(tool.execute(f.a,f.task,f.request));
 delete legacy.id;delete legacy.contentHash;delete legacy.observationBasis;delete legacy.output.observedAt;legacy.resultText=JSON.stringify(legacy.output);
 legacy.id='tool:'+hash(legacy).slice(0,24);legacy.contentHash=hash(legacy);f.task.toolEvidence=[legacy];f.task.toolExecutions=[];events.record(f.task,legacy,false);
 assert.equal(tool.valid(f.a,f.task,legacy),true);assert.equal(tool.observationValid(f.a,f.task,legacy),false);
 const ground=require(repo+'desktop/grounding.cjs'),checked=f.report(legacy).finish();assert.equal(checked.passed,true);f.task.grounding=checked.grounding;
 t.mock.timers.tick(60000);assert.equal(tool.readable(f.a,f.task).length,0);assert.equal(ground.reusable(f.a,f.task),null);
 const fresh=tool.execute(f.a,f.task,f.request);assert.notEqual(fresh.id,legacy.id);assert.ok(fresh.observationBasis);assert.equal(fresh.output.observedAt,fresh.observedAt);
 assert.equal(tool.observationValid(f.a,f.task,fresh),true);
});

test('a fresh historical claim keeps its cache through expiry and later file change',async t=>{
 const f=await setup(t),ground=require(repo+'desktop/grounding.cjs');t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const r=tool.execute(f.a,f.task,f.request),checked=f.report(r).finish();assert.equal(checked.passed,true);f.task.grounding=checked.grounding;
 assert.equal(checked.grounding.claims[0].citations[0].temporalScope,'observed_at');
 t.mock.timers.tick(60000);assert.ok(ground.reusable(f.a,f.task));
 fs.writeFileSync(f.action.target,'后续变化');assert.ok(ground.reusable(f.a,f.task));
 f.job.folderIds=[];assert.equal(ground.reusable(f.a,f.task),null);
});

test('shared receipt keeps historical and current claim use distinct in cache',async t=>{
 const f=await setup(t),ground=require(repo+'desktop/grounding.cjs');t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const historical='本轮核验时，旧文件存在且内容一致。',current='现在旧文件仍存在且内容一致。';
 const r=tool.execute(f.a,f.task,f.request),review=f.report(r,historical+'\n'+current),base=review.result.groundingReview.claims[0];
 review.result.groundingReview.claims=[{...base,id:'history',text:historical,qualification:{field:'content',quote:historical}},{...base,id:'current',text:current}];
 review.result.groundingReview.requirements=review.result.groundingReview.requirements.map(row=>({...row,claimIds:['history','current']}));
 const checked=review.finish();assert.equal(checked.passed,true,checked.summary);f.task.grounding=checked.grounding;
 assert.equal(checked.grounding.claims[0].citations[0].temporalScope,'observed_at');
 assert.equal(checked.grounding.claims[1].citations[0].temporalScope,undefined);assert.ok(ground.reusable(f.a,f.task));
 t.mock.timers.tick(60000);assert.equal(ground.reusable(f.a,f.task),null);
});

test('delivery refresh rereads current use but leaves historical-only observations untouched',async t=>{
 const f=await setup(t),writes=require(repo+'desktop/agent-writes.cjs'),original=writes.observeRecordedFile;
 const r=tool.execute(f.a,f.task,f.request);f.task.grounding=f.report(r).finish().grounding;
 let reads=0;t.mock.method(writes,'observeRecordedFile',(...args)=>{reads++;return original(...args);});
 await tool.refreshForDelivery(f.a,f.task);assert.equal(reads,0);
 f.task.grounding=f.report(r,'现在旧文件仍存在且内容一致。').finish().grounding;reads=0;
 await tool.refreshForDelivery(f.a,f.task);assert.ok(reads>0);
});

test('a time-bound statement verified while fresh remains acceptable after slow goal verification',async t=>{
 const f=await setup(t),path=require('node:path'),ground=require(repo+'desktop/grounding.cjs');
 t.mock.timers.enable({apis:['Date'],now:Date.now()});let workers=0,checks=0,goals=0;
 const content='本轮只读核验时，旧文件存在且正文与历史记录一致。';
 f.a.chat=async(_p,_k,_m,o)=>{
  o.onUsage?.({inputTokens:10,outputTokens:5});
  if(o.stage==='goal_verify'){goals++;t.mock.timers.tick(90000);return {passed:true,summary:'时点说明已完成',gaps:[]};}
  if(o.role==='verify'){
   checks++;const draft=require(repo+'desktop/deliverables.cjs').primary(f.a,f.task),r=f.task.toolEvidence[0];
   return {passed:true,summary:'仅按明确观察时点核验',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[draft.id],requirements:ground.requirements(f.a,f.task).map(q=>({id:q.id,status:'satisfied',claimIds:['c']})),claims:[{id:'c',artifactId:draft.id,field:'content',text:content,kind:'fact',supported:true,citationIds:['e'],qualification:{field:'content',quote:content}}],citations:[{id:'e',sourceId:r.id,quote:r.resultText}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}};
  }
  workers++;if(workers===1)return {kind:'read_context',requests:[f.request]};assert.equal(workers,2);return {kind:'artifact',title:'只读说明',content};
 };
 const result=await require(repo+'scripts/readiness/lifecycle.cjs').advance(f.a,f.task,path.resolve(__dirname,repo));
 assert.equal(result.completionChecked,true,JSON.stringify({result,verification:f.task.verification,grounding:f.task.grounding}));
 await f.a.dispatch('taskAction',{id:f.task.id,command:'accept'});assert.equal(f.task.status,'completed');assert.equal(f.job.status,'completed');
 assert.equal(workers,2);assert.equal(checks,1);assert.equal(goals,1);
});
