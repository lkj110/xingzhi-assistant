'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const protocol=require('../desktop/task-context.cjs');
const generation=require('../desktop/generation-context.cjs');
const links=require('../desktop/evidence-links.cjs');
const documents=require('../desktop/documents.cjs');

// Entirely synthetic, in memory. No Assistant construction, workspace files,
// credentials, connectors, native application, network or real model calls.
function fixture(n=8,artifactCount=2){
 const task={id:'task',agentJobId:'job',projectId:null,status:'todo',title:'Synthetic',criteria:'Read section 2.3',sourceIds:[],steps:[],notes:[],workRevision:1};
 const job={id:'job',projectId:null,taskIds:[task.id],sourceIds:[],goal:'Synthetic only',status:'running',history:[],feedback:[],followups:[]};
 const sources=Array.from({length:n},(_,i)=>({id:'source-'+i,title:'Source '+i,projectId:null,content:'## 2.3 Facts\n'+Array.from({length:18},(_,p)=>`Source ${i} paragraph ${p}: ${'local evidence '.repeat(16)}`).join('\n\n')}));
 task.sourceIds=sources.map(s=>s.id);job.sourceIds=[...task.sourceIds];
 const artifacts=Array.from({length:artifactCount},(_,i)=>({id:'artifact-'+i,taskId:task.id,title:'Saved '+i,stepId:'step-'+i,content:'Historical draft '+i}));
 const stats={checks:0},a={data:{tasks:[task],delegations:[job],sources,artifacts,agentActions:[],projects:[],modelCalls:[]},save(){},event(){},contextAccessCheck(){stats.checks++;return {decision:'allow',revision:1};}};
 const scope=protocol.taskScope(task);
 const request=(id=sources[0]?.id,extra={})=>({tool:'read_source',sourceId:id,...extra});
 const receipt=(q=request())=>({request:q,result:protocol.resolveRead(a,scope,q)});
 return {a,task,job,sources,artifacts,scope,stats,request,receipt};
}
function countWork(fn){
 const original=links.bindings,paragraphs=documents.paragraphs;let catalogs=0,parses=0;
 links.bindings=(...args)=>{catalogs++;return original(...args);};
 documents.paragraphs=(...args)=>{parses++;return paragraphs(...args);};
 try{return {value:fn(),get catalogs(){return catalogs;},get parses(){return parses;}};}
 finally{links.bindings=original;documents.paragraphs=paragraphs;}
}
function receipts(f,count){
 return protocol.withContext(f.a,f.scope,op=>Array.from({length:count},(_,i)=>{
  const request=f.request(f.sources[i%f.sources.length].id,{start:i%3*6});
  return {request,result:op.resolveRead(request)};
 }));
}

for(const [n,artifacts,count] of [[16,4,192],[128,16,192],[528,77,192],[528,77,1536]])test(`one catalog for ${n} sources, ${artifacts} artifacts and ${count} receipts`,t=>{
 const f=fixture(n,artifacts),rows=receipts(f,count);f.stats.checks=0;
 const start=performance.now(),work=countWork(()=>protocol.validateReads(f.a,f.scope,rows));
 assert.equal(work.value.reads.length,count);assert.ok(work.value.valid.every(Boolean));
 assert.equal(work.catalogs,1);assert.equal(f.stats.checks,2*(n+artifacts));
 assert.ok(work.parses<=Math.min(n,count));
 t.diagnostic(`${work.catalogs} catalog, ${f.stats.checks} access checks, ${work.parses} body parses, ${(performance.now()-start).toFixed(1)} ms (synthetic, not production)`);
 f.stats.checks=0;
 const rechecked=countWork(()=>protocol.assertReadsCurrent(f.a,f.scope,work.value.context,rows));
 assert.equal(rechecked.catalogs,1);assert.equal(f.stats.checks,2*(n+artifacts));
});

test('bulk validity matches individual reads, including legacy hashes, bad requests and stale handles',()=>{
 const f=fixture(),rows=receipts(f,8),legacy={...rows[0],result:{},sourceHash:require('../desktop/evidence-basis.cjs').hash(f.sources[0].content)};
 rows.push(legacy,{request:{tool:'shell'},result:{}},{...rows[0],result:{...rows[0].result,version:'stale'}},{...rows[0],request:{tool:'read_source',ref:'expired'}},null);
 const expected=rows.map(row=>protocol.validRead(f.a,f.scope,row));
 assert.deepEqual(protocol.validateReads(f.a,f.scope,rows).valid,expected);
 assert.equal(protocol.validateReads(f.a,f.scope,[]).context.readableCatalog.length,f.sources.length);
});

test('core contextBatch and prepare share directory, saved reads and section prefetch',()=>{
 const f=fixture(32,4);f.task.generationReads=receipts(f,192);
 for(const run of [()=>generation.contextBatch(f.a,f.task,{verification:true}),()=>generation.prepare(f.a,f.task,{contextReads:f.task.generationReads})]){
  f.stats.checks=0;const work=countWork(run);
  assert.equal(work.catalogs,1);assert.equal(f.stats.checks,72);
  assert.ok(work.value.requestedSections.some(r=>r.ok&&r.content));
 }
});

test('pagination and sibling requests share one catalog and parse each source once',()=>{
 const f=fixture(32,4);f.stats.checks=0;
 const work=countWork(()=>protocol.readContextBatch(f.a,f.scope,[f.request(),f.request('source-1'),{tool:'list_sources',limit:24}]));
 assert.equal(work.value.stats.pages,6);assert.equal(work.value.pageRows.length,6);
 assert.equal(work.catalogs,1);assert.equal(f.stats.checks,72);assert.equal(work.parses,2);
});

test('durable generation pagination builds once, then once after persistence callbacks, regardless of page count',()=>{
 const f=fixture(32,4);f.stats.checks=0;
 const work=countWork(()=>generation.readBatch(f.a,f.task,[f.request(),f.request('source-1')]));
 assert.equal(work.value.pageRows.length,6);assert.equal(f.task.generationReads.length,6);
 assert.equal(work.catalogs,2);assert.equal(f.stats.checks,144);
});

test('generation model pre/post checks are batched even with hundreds of saved receipts',async()=>{
 const f=fixture(32,4);f.task.criteria='facts';f.task.generationReads=receipts(f,192);
 let calls=0;f.a.call=async()=>{calls++;return {kind:'artifact',content:'completed'};};
 f.stats.checks=0;
 assert.equal((await generation.call(f.a,f.task,'synthetic',{})).content,'completed');
 // Preparation, pre-await, post-await, plus work-efficiency's independent audit.
 assert.equal(calls,1);assert.equal(f.stats.checks,4*2*36);
});

const changes={
 body:f=>f.sources[0].content+=' changed',segments:f=>f.sources[0].segments=[{id:'changed',text:'new'}],
 coverage:f=>f.sources[0].coverage={complete:false},revision:f=>f.sources[0].revisionId='v2',
 principal:f=>f.sources[0].principalScope='other',deleted:f=>f.sources[0].deleted=true,
 permission:f=>f.a.contextAccessCheck=()=>({decision:'deny',revision:2}),
 policyRevision:f=>f.a.contextAccessCheck=()=>({decision:'allow',revision:2}),
 binding:f=>f.task.contextBindings[0].state='withdrawn',
 bindingTombstone:f=>f.task.withdrawnBindingIds=[f.task.contextBindings[0].bindingId],
 jobMembership:f=>f.job.sourceIds=[],taskScope:f=>f.task.agentJobId='other',
 ancestry:f=>{f.sources.push({id:'next',projectId:null,previousSourceId:'source-0',content:'new head'});f.task.sourceIds.push('next');f.job.sourceIds.push('next');},
 artifact:f=>f.artifacts[0].content+=' changed'
};
for(const [name,change] of Object.entries(changes))test(`${name} mutation is rechecked after await with no explicit invalidation token`,async()=>{
 const f=fixture();links.setInputs(f.a,f.task,f.task.sourceIds);
 const request=name==='artifact'?{tool:'read_artifact',artifactId:'artifact-0'}:f.request(),row=f.receipt(request);
 const baseline=protocol.validateReads(f.a,f.scope,[row]);assert.deepEqual(baseline.valid,[true]);
 await Promise.resolve();change(f);
 assert.throws(()=>protocol.assertReadsCurrent(f.a,f.scope,baseline.context,[row]),e=>['CONTEXT_SCOPE_DENIED','CONTEXT_VERSION_CHANGED'].includes(e.code));
 assert.equal(protocol.validRead(f.a,f.scope,row),false);
});

for(const name of ['permission','body','binding','artifact'])test(`late model ${name} mutation rejects output, including saved historical artifacts`,async()=>{
 const f=fixture();f.task.criteria='facts';links.setInputs(f.a,f.task,f.task.sourceIds);
 f.task.generationReads=[f.receipt(name==='artifact'?{tool:'read_artifact',artifactId:'artifact-0'}:f.request())];
 f.a.call=async()=>{await Promise.resolve();changes[name](f);return {kind:'artifact',content:'stale'};};
 await assert.rejects(generation.call(f.a,f.task,'synthetic',{}),e=>e.code==='CONTEXT_VERSION_CHANGED');
});

test('snapshots are detached and deeply immutable, and operation capabilities expire on return',async()=>{
 const f=fixture();let escaped;
 const snapshot=protocol.withContext(f.a,f.scope,op=>{escaped=op;return op.context();});
 assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.readableCatalog[0].sections));
 assert.equal(Object.isFrozen(f.sources[0]),false);
 assert.throws(()=>snapshot.readableCatalog.pop(),TypeError);
 f.sources[0].title='changed';assert.equal(snapshot.readableCatalog[0].title,'Source 0');
 await Promise.resolve();assert.throws(()=>escaped.resolveRead(f.request()),e=>e.code==='CONTEXT_INVALID_REQUEST');
 assert.throws(()=>escaped.validRead(f.receipt()),e=>e.code==='CONTEXT_INVALID_REQUEST');
 assert.throws(()=>protocol.withContext(f.a,f.scope,()=>Promise.resolve()),e=>e.code==='CONTEXT_INVALID_REQUEST');
});

test('onRead invalidates at the final page and sibling changes remove earlier usable bodies',()=>{
 const f=fixture();let calls=0;
 const result=protocol.readContextBatch(f.a,f.scope,[f.request(),f.request('source-1')],{onRead(){if(++calls===6)f.sources[0].content='replacement';}});
 assert.equal(result.rows[0].result.ok,false);assert.equal(result.rows[1].result.ok,true);assert.equal(result.used.length,6);
 assert.equal(JSON.stringify(result.rows[0]).includes('local evidence'),false);
});

test('save/onRows callbacks cannot return evidence after revocation',()=>{
 for(const where of ['save','onRows']){
  const f=fixture(),revoke=()=>{f.a.contextAccessCheck=()=>({decision:'deny',revision:2});};
  if(where==='save')f.a.save=revoke;
  const batch=generation.readBatch(f.a,f.task,[f.request()],where==='onRows'?{onRows:revoke}:{});
  assert.equal(batch.complete,false);assert.equal(batch.rows[0].result.ok,false);assert.equal(f.task.generationReads.length,3);
 }
});

test('policy recheck cannot mutate a previously checked source or binding and leak snapshot bodies',()=>{
 for(const mutation of ['body','binding']){
  const f=fixture(2,0);links.setInputs(f.a,f.task,f.task.sourceIds);let calls=0;
  f.a.contextAccessCheck=()=>{if(++calls===4)changes[mutation](f);return {decision:'allow',revision:1};};
  const result=protocol.resolveRead(f.a,f.scope,f.request());
  assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes('local evidence'),false);
 }
});

test('old cached bodies and access do not survive a later call or a workspace replacement',()=>{
 const f=fixture();const first=generation.readBatch(f.a,f.task,[f.request()]);assert.equal(first.complete,true);
 const old=f.task.generationReads;
 f.a.data=structuredClone(f.a.data);f.a.data.sources[0].content='replacement body';
 const second=protocol.readContextBatch(f.a,f.scope,[f.request()],{cacheRows:old});
 assert.equal(second.stats.cacheHits,0);assert.equal(second.rows[0].result.segments[0].text,'replacement body');
 f.a.contextAccessCheck=()=>({decision:'deny',revision:2});
 const denied=protocol.readContextBatch(f.a,f.scope,[f.request()],{cacheRows:old});
 assert.equal(denied.rows[0].result.ok,false);assert.equal(denied.used.length,0);
});

test('persisted long segments cannot substitute a forged suffix even with a recomputed receipt hash',()=>{
 const f=fixture(1,0),text='x'.repeat(9000)+'EXACT_SUFFIX';
 f.sources[0].segments=[{id:'long',text}];
 const first=protocol.readContextBatch(f.a,f.scope,[f.request()]),saved=structuredClone(first.pageRows);
 saved[0].result.segments[0].text='x'.repeat(8000)+'FORGED_SUFFIX';
 saved[0].bodyHash=require('../desktop/evidence-basis.cjs').hash({content:saved[0].result.content,segments:saved[0].result.segments});
 const next=protocol.readContextBatch(f.a,f.scope,[f.request()],{cacheRows:saved});
 assert.equal(next.rows[0].result.segments[0].text,text);assert.equal(next.stats.cacheHits,0);
});

test('asynchronous page observers are rejected instead of retaining a snapshot across await',()=>{
 const f=fixture();
 assert.throws(()=>protocol.readContextBatch(f.a,f.scope,[f.request()],{onRead:()=>Promise.resolve()}),e=>e.code==='CONTEXT_INVALID_REQUEST');
});
