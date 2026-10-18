const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs');
const input=require('../desktop/model-input.cjs'),protocol=require('../desktop/task-context.cjs');
const batch=require('../desktop/context-batch.cjs'),generation=require('../desktop/generation-context.cjs');
const relations=require('../desktop/relation-obligations.cjs'),links=require('../desktop/evidence-links.cjs');
const bodies=require('../desktop/context-evidence.cjs');
const kinds='SQL读写、产出配置、物理表血缘、Aeolus';
function first(f,extra={}){return batch.readContextBatch(f.a,protocol.taskScope(f.task),[{tool:'read_obligations',section:'obligations',start:0,limit:1,...extra}]);}
function refText(c,ref){const body=ref.path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],c);assert.equal(typeof body,'string',ref.path);return body.slice(ref.start,ref.end);}

test('review: distinct obligation pages remain useful navigation after three reads',t=>{
 const f=fixture(t,{kinds}),state={};let request={tool:'read_obligations',section:'obligations',start:0,limit:1},visible={contextReads:[]};
 for(let i=0;i<3;i++){
  const b=batch.readContextBatch(f.a,protocol.taskScope(f.task),[request]);assert.ok(b.rows[0].result.items.length);
  const ledger=protocol.recordReadResults(state,b.rows,visible);assert.equal(ledger.empty,0);assert.equal(ledger.exhausted,false);
  visible.contextReads.push(...b.rows);request=b.next[0]?.request;
 }
});

test('review: obligation pagination rejects a changed requirement set even if sources are unchanged',t=>{
 const f=fixture(t,{kinds}),b=first(f),old=b.rows[0].result.contextRevision;
 f.job.goal+='\n额外要求：保留全部证据并明确限制。';
 const next=batch.readContextBatch(f.a,protocol.taskScope(f.task),[b.next[0].request]).rows[0].result;
 t.diagnostic(JSON.stringify({oldContextRevision:old,newContextRevision:next.contextRevision,ok:next.ok}));
 assert.equal(next.ok,false);assert.equal(next.code,'CONTEXT_VERSION_CHANGED');
});

test('review: obligation pagination rejects a changed accepted boundary',t=>{
 const f=fixture(t,{kinds}),b=first(f),o=relations.required(f.a,f.job,f.task)[1];
 f.job.executionState.gaps.push({obligationId:o.id,taskId:f.task.id,status:'accepted_gap',acceptedBy:'user',decisionId:'review-user-decision',contractBasis:o.contractBasis,entityIds:o.entities.map(e=>e.id)});
 const next=batch.readContextBatch(f.a,protocol.taskScope(f.task),[b.next[0].request]).rows[0].result;
 t.diagnostic(JSON.stringify({status:next.items?.[0]?.status,ok:next.ok}));
 assert.equal(next.ok,false);assert.equal(next.code,'CONTEXT_VERSION_CHANGED');
});

test('review: job scoped obligation lookup rejects a task moved to another project',t=>{
 const f=fixture(t,{kinds});f.task.projectId='different-project';
 const r=batch.readContextBatch(f.a,{kind:'job',jobId:f.job.id},[{tool:'read_obligations',taskId:f.task.id,section:'obligations'}]).rows[0].result;
 assert.equal(r.ok,false);assert.equal(r.code,'CONTEXT_SCOPE_DENIED');
});

test('review: foreign task, job override and deleted task are rejected',t=>{
 const f=fixture(t,{kinds});
 for(const request of [{taskId:'foreign-task'},{jobId:'foreign-job'}])assert.equal(first(f,request).rows[0].result.ok,false);
 f.task.deletedAt=new Date().toISOString();assert.equal(first(f).rows[0].result.code,'CONTEXT_SCOPE_DENIED');
});

test('review: obligation page is invalidated when a later callback withdraws its evidence',t=>{
 const f=fixture(t,{kinds}),s=f.source();
 const result=generation.readBatch(f.a,f.task,[{tool:'read_obligations',section:'obligations'}],{onRows:()=>links.withdrawSources(f.a,f.task,[s.id],{reason:'review callback withdrawal'})});
 assert.equal(result.rows[0].result.ok,false);assert.equal(result.rows[0].result.code,'CONTEXT_VERSION_CHANGED');
});

test('review: base batch revalidates earlier obligation pages after a sibling read callback',t=>{
 const f=fixture(t,{kinds}),s=f.source();let changed=false;
 const result=batch.readContextBatch(f.a,protocol.taskScope(f.task),[{tool:'read_obligations',section:'obligations'},{tool:'read_source',sourceId:s.id}],{onRead:()=>{if(!changed){changed=true;links.withdrawSources(f.a,f.task,[s.id],{reason:'review sibling callback'});}}});
 assert.equal(result.rows[0].result.ok,false);assert.equal(result.rows[0].result.code,'CONTEXT_VERSION_CHANGED');
});

test('review: a fresh 150k atomic source paragraph reaches the next model stub',async t=>{
 const text='UNIQUE_FRESH_'+'x'.repeat(150000),f=fixture(t),s=f.source('code',{taskId:123,sql:text},{taskId:123},{platformSnapshot:false,segments:[{id:'atomic-1',text}]});let calls=0;
 f.a.call=async(_role,_prompt,c)=>{
  if(++calls===1)return {kind:'read_context',requests:[{tool:'read_source',sourceId:s.id}]};
  assert.ok(bodies.suppliedBodies(c).some(text=>text.includes('UNIQUE_FRESH_')),'fresh evidence was entirely evicted after successful local read');
  return {passed:false,summary:'stub complete',gaps:[]};
 };
 await generation.call(f.a,f.task,'offline review',{},'verify');assert.equal(calls,2);
});

test('review: reducing requestedSections to metadata resets visible coverage and pins restoration version',()=>{
 const row={ok:true,sourceId:'s',version:'v1',section:'section',start:0,next:null,cursor:null,content:'z'.repeat(150000),complete:true,coverage:{unit:'characters',start:0,next:null,reachesEnd:true,complete:true},resumeRequest:{tool:'read_section',sourceId:'s',version:'v1',title:'section',start:0}};
 const projected=input.prepare({requestedSections:[row]},{maxChars:40000}),r=projected.requestedSections[0];
 assert.equal(r.bodyOmitted,true);assert.equal(r.complete,false);assert.equal(r.coverage.complete,false);assert.equal(r.coverage.reachesEnd,false);assert.equal(r.cursor,0);assert.equal(r.resumeRequest.version,'v1');
});

test('review: delivery readback restoration pins the disclosed historical version',()=>{
 const c=input.prepare({deliveryEvidence:[{tool:'update_lark_doc',artifactId:'a',current:false,result:{sourceId:'s'},readback:{id:'s',state:'historical',version:'old-version',content:'OLD BODY'}}]});
 const request=c.deliveryEvidence[0].readback.resumeRequest;
 assert.equal(request.sourceId,'s');assert.equal(request.history,true);assert.equal(request.version,'old-version');
});

test('review: pruning historical readbacks rebases deduplicated body references',()=>{
 const text='review retained body';
 const context=bodies.deduplicate({deliveryEvidence:[{current:false,readback:{id:'s',state:'historical',version:'v1',content:'prefix '+text+' suffix'}}],contextReads:[{request:{tool:'read_source',sourceId:'s'},result:{ok:true,sourceId:'s',start:0,segments:[{index:0,text}],complete:true}}]});
 const before=JSON.stringify(context),c=input.prepare(context),segment=c.contextReads[0].result.segments[0];
 assert.equal(segment.text||refText(c,segment.textRef),text);assert.equal(JSON.stringify(context),before);
});

test('review: one oversized obligation metadata record remains recoverable instead of failing immutable input',t=>{
 const f=fixture(t,{kinds}),o=relations.required(f.a,f.job,f.task)[0];
 // The page contract accepts arbitrary-sized observations, e.g. a center's very large adjacency/proof list.
 t.mock.method(relations,'context',()=>[{...o,physicalCoverage:{frontier:[{rootId:'123',reason:'missing_center',proofSourceIds:Array.from({length:20000},(_,i)=>'source-proof-'+i+'x'.repeat(20))}]}}]);
 const request={tool:'read_obligations',obligationId:o.id,section:'frontier',start:0,limit:1};
 const b=batch.readContextBatch(f.a,protocol.taskScope(f.task),[request]);assert.equal(b.rows[0].result.ok,true);
 const c=input.prepare({contextReads:b.rows});assert.ok(input.encodedSize(c)<=input.DEFAULT_MAX);
 assert.ok(c.contextReads[0].result.items?.length||c.contextReads[0].result.resumeRequest,'must retain a usable item or recovery request');
});

test('review: nested high escape metadata can be restored exactly with valid path resumes',t=>{
 const f=fixture(t,{kinds}),o=relations.required(f.a,f.job,f.task)[0],text='\\"\n\u0000'.repeat(10000);
 t.mock.method(relations,'context',()=>[{...o,physicalCoverage:{frontier:[{reason:text}]}}]);
 let request={tool:'read_obligations',obligationId:o.id,section:'frontier',start:0,limit:1},restored='';
 for(let steps=0;steps<40;steps++){
  const b=batch.readContextBatch(f.a,protocol.taskScope(f.task),[request]),r=b.rows[0].result;
  assert.equal(r.ok,true,JSON.stringify(request));assert.ok(input.encodedSize(input.prepare({contextReads:b.rows}))<=input.DEFAULT_MAX);
  const omitted=r.items.find(i=>i.detailOmitted);
  if(omitted){request=JSON.parse(JSON.stringify(omitted.resumeRequest));continue;}
  assert.equal(typeof r.items[0]?.text,'string');restored+=r.items[0].text;
  if(r.next===null){assert.equal(restored,text);return;}
  request=b.next[0].request;
 }
 assert.fail('nested detail pagination did not terminate');
});

test('review: continuation without coverageVersion and prototype paths are rejected',t=>{
 const f=fixture(t,{kinds}),b=first(f),r=b.rows[0].result;
 for(const extra of [{start:1},{path:['__proto__'],coverageVersion:r.coverageVersion},{path:['constructor'],coverageVersion:r.coverageVersion}]){
  const x=first(f,extra).rows[0].result;assert.equal(x.ok,false);assert.equal(x.code,'CONTEXT_INVALID_REQUEST');
 }
});

test('review: a changed accepted boundary during a model await rejects the late result',async t=>{
 const f=fixture(t,{kinds});let calls=0;
 f.a.call=async()=>{
  if(++calls===1)return {kind:'read_context',requests:[{tool:'read_obligations',section:'obligations'}]};
  const o=relations.required(f.a,f.job,f.task)[0];
  f.job.executionState.gaps.push({obligationId:o.id,status:'accepted_gap',acceptedBy:'user',decisionId:'during-model',contractBasis:o.contractBasis,entityIds:o.entities.map(e=>e.id)});
  return {passed:true,summary:'stale check',gaps:[]};
 };
 await assert.rejects(generation.call(f.a,f.task,'offline review',{},'verify'),e=>e.code==='CONTEXT_VERSION_CHANGED');assert.equal(calls,2);
});

test('review: ordinary current user requirements and check findings survive projection unchanged',()=>{
 const protectedFields={task:{id:'t',criteria:'不扩展用户范围',notes:[{text:'保留拒绝方向'}]},requirements:[{id:'r1',text:'精确要求'}],delegation:{contract:{text:'原合同'},feedback:[{text:'最新用户补充'}]},previousCheck:{passed:false,summary:'缺口',gaps:['真实缺口']}};
 const c=input.prepare({...protectedFields,deliveryEvidence:[{current:false,readback:{id:'s',content:'x'.repeat(1000000)}}]});
 for(const [key,value] of Object.entries(protectedFields))assert.deepEqual(c[key],value);
});

test('review: different navigation paths with identical values are different read ranges',t=>{
 const f=fixture(t,{kinds}),o=relations.required(f.a,f.job,f.task)[0],state={},visible={contextReads:[]};
 t.mock.method(relations,'context',()=>[{...o,physicalCoverage:{frontier:Array.from({length:4},(_,i)=>({rootId:String(123+i),proofSourceIds:['shared-proof']}))}}]);
 const base={tool:'read_obligations',obligationId:o.id,section:'frontier',start:0,limit:1};
 const version=batch.readContextBatch(f.a,protocol.taskScope(f.task),[base]).rows[0].result.coverageVersion;
 for(let i=0;i<4;i++){
  const b=batch.readContextBatch(f.a,protocol.taskScope(f.task),[{...base,path:[i,'proofSourceIds'],coverageVersion:version}]);
  assert.equal(b.rows[0].result.ok,true);
  const p=protocol.recordReadResults(state,b.rows,visible);assert.equal(p.duplicate,0,'different root field path must not be marked already visible');assert.equal(p.exhausted,false);
  visible.contextReads.push(...b.rows);
 }
 const restore=protocol.recordReadResults(state,[visible.contextReads[0]],{contextReads:[visible.contextReads.at(-1)]});
 assert.equal(restore.duplicate,0,'another path with equal values does not prove this omitted path was visible');assert.equal(restore.restored,1);
});

test('review: complete wire preflight rejects before spending, charging or invoking a model',async t=>{
 const f=fixture(t),p=f.a.data.providers.find(p=>p.id==='fixture');p.type='codex';f.a.activeAgentJob=f.job;
 let modelCalls=0;f.a.chat=async()=>{modelCalls++;throw Error('must not invoke model');};
 const spend=require('../desktop/spend.cjs');spend.check(f.a);const prior=JSON.stringify(f.a.spendLedger),calls=f.job.callsUsed;
 const messages=[{role:'system',content:'s'.repeat(600000)},{role:'user',content:JSON.stringify({task:{criteria:'u'.repeat(470000)}})}];
 await assert.rejects(f.a.callModel(p,'',messages,{role:'execute',stage:'task_work'}),e=>e.diagnostic?.kind==='input_too_large'&&e.automaticRetry===false);
 assert.equal(modelCalls,0);assert.equal(f.job.callsUsed,calls);assert.equal(JSON.stringify(f.a.spendLedger),prior);
});

test('review: dependency excerpts must not become read_artifact references with no target',()=>{
 // core.context currently supplies dependency artifacts as {title,content}, without id.
 const c=input.prepare({artifacts:[{id:'current',content:'\u0000'.repeat(100000)}],dependencies:[{id:'upstream-task',artifacts:[{title:'upstream evidence',content:'NEEDED DEPENDENCY'}]}]});
 const dependency=c.dependencies[0].artifacts[0];
 if(dependency.bodyOmitted)assert.doesNotThrow(()=>protocol.validateRequest(dependency.resumeRequest),'an omitted dependency must have an executable scoped reference');
 else assert.equal(dependency.content,'NEEDED DEPENDENCY');
});
