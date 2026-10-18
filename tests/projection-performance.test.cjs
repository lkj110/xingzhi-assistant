'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const cache=require('../desktop/projection-cache.cjs'),store=require('../desktop/evidence-store.cjs');
const boundaries=require('../desktop/platform-boundaries.cjs'),work=require('../desktop/work-state.cjs'),policy=require('../desktop/execution-policy.cjs');

function fixture(){
 const job={id:'job',status:'ready',taskIds:['task'],sourceIds:[],followups:[],history:[],nextRunAt:null};
 const task={id:'task',agentJobId:job.id,status:'todo',sourceIds:[],dependsOn:[],steps:[{id:'draft',kind:'draft',done:false}]};
 return {job,task,a:{data:{tasks:[task],delegations:[job],projects:[],sources:[],artifacts:[],decisions:[],agentActions:[],agentRuns:[],operations:[],runtime:{},stewardship:{paused:false}}}};
}
function source(id,patch={}){return {id,projectId:'p',identity:'resource',...patch};}
function platform(id,patch={}){return {id,platformSnapshot:true,content:JSON.stringify({operation:'upstream',region:'sg',query:{op:'upstream',taskId:1,projectId:2},data:{root:{id:1},nodes:[{id:3,projectId:4,parentRelation:[{id:5,projectId:6}]}]}}),...patch};}

test('one policy inspection supplies both projection actions and phase; each request rechecks gates',t=>{
 const {a,job}=fixture(),inspect=policy.inspect,spy=t.mock.method(policy,'inspect',(...args)=>inspect(...args));
 const before=JSON.stringify(a.data),cpu=process.cpuUsage(),start=performance.now();
 const ready=work.view(a,job);
 assert.equal(spy.mock.callCount(),1);assert.equal(ready.phase,'ready');
 assert.deepEqual(ready.runnableActions,[{taskId:'task',phase:'work',tool:'advance_task'}]);
 assert.equal(JSON.stringify(a.data),before);
 a.data.stewardship.paused=true;
 const paused=work.view(a,job);
 assert.equal(spy.mock.callCount(),2);assert.equal(paused.phase,'paused');assert.deepEqual(paused.runnableActions,[]);
 a.data.stewardship.paused=false;a.data.runtime.projectionPending={commitId:'pending'};
 const pending=work.view(a,job);
 assert.equal(spy.mock.callCount(),3);assert.equal(pending.executionPolicy.eligible,false);assert.deepEqual(pending.runnableActions,[]);
 delete a.data.runtime.projectionPending;job.executionPaused=true;
 assert.deepEqual(work.runnableActions(a,job),[]);assert.equal(spy.mock.callCount(),4,'standalone admission remains fresh');
 t.diagnostic(JSON.stringify({elapsedMs:performance.now()-start,cpuMicros:process.cpuUsage(cpu),policyInspections:spy.mock.callCount()}));
});

test('synchronous cache handles falsey values, separate identities, nesting, errors, and await cleanup',async()=>{
 const namespace={},key={};let calls=0;const read=()=>cache.memo(namespace,[key],()=>{calls++;return null;});
 cache.run(()=>{assert.equal(read(),null);read();assert.equal(calls,1);cache.run(()=>{read();read();});assert.equal(calls,2);read();assert.equal(calls,2);});
 read();read();assert.equal(calls,4);
 assert.throws(()=>cache.run(()=>{read();throw Error('projection failed');}),/projection failed/);
 read();assert.equal(calls,6);
 await cache.run(async()=>{read();read();assert.equal(calls,7);await Promise.resolve();read();read();assert.equal(calls,9);});
 let failures=0;
 cache.run(()=>{for(let i=0;i<2;i++)assert.throws(()=>cache.memo(namespace,[key,'error'],()=>{failures++;throw Error('no memoized failure');}));});
 assert.equal(failures,2);
 let promises=0;
 await cache.run(()=>Promise.all([0,1].map(()=>cache.memo(namespace,[key],()=>{promises++;return Promise.resolve();}))));
 assert.equal(promises,2);
});

test('source resolution is once per object per synchronous projection, unchanged for ambiguous and scoped chains',t=>{
 const a=source('a'),b=source('b',{previousSourceId:'a'}),c=source('c',{previousSourceId:'a'});
 const scenarios=[
  [a,b], [a,b,c], [a,{...b,projectId:'other'}], [a,{...b,copiedFrom:'external'}],
  [a,{...b,identity:'another'}], [a,{...b,projectExcluded:true}], [a,{...b,deleted:true}],
  [a,{...b,previousSourceId:'missing'}], [{...a,previousSourceId:'b'},b], [a,b,{...c,id:'b'}]
 ];
 for(const sources of scenarios){
  const data={sources},expected=sources.map(s=>store.current(data,s));let scans=0;
  Object.defineProperty(sources,'filter',{configurable:true,value:function(...args){scans++;return Array.prototype.filter.apply(this,args);}});
  cache.run(()=>{for(let repeat=0;repeat<8;repeat++)sources.forEach((s,i)=>assert.equal(store.current(data,s),expected[i]));});
  assert.equal(scans,sources.length,'expensive descendant scan once per source');
  store.current(data,sources[0]);assert.equal(scans,sources.length+1,'no cache after return');
 }
 const data={sources:[a]};assert.equal(cache.run(()=>store.current(data,a)),a);
 data.sources.push(b);assert.equal(cache.run(()=>store.current(data,a)),b);
 data.sources.push(c);assert.equal(cache.run(()=>store.current(data,a)),null,'new branch observed next request');
 b.projectExcluded=true;assert.equal(cache.run(()=>store.current(data,a)),c);
 const other={sources:[a]};cache.run(()=>{assert.equal(store.current(data,a),c);assert.equal(store.current(other,a),a);});
});

test('platform evidence parses each content once but rechecks filtering, supersession and source IDs',t=>{
 const s=platform('s'),same=platform('copy'),parse=JSON.parse;let parses=0;
 t.mock.method(JSON,'parse',(...args)=>{if(args[0]===s.content)parses++;return parse(...args);});
 const expected=[{taskId:'1',projectId:'2',region:'sg',sourceId:'s'},{taskId:'3',projectId:'4',region:'sg',sourceId:'s'},{taskId:'5',projectId:'6',region:'sg',sourceId:'s'}];
 cache.run(()=>{
  const first=boundaries.projectEvidence([s]);assert.deepEqual(first,expected);first[0].projectId='tampered';
  assert.deepEqual(boundaries.projectEvidence([s]),expected);
  assert.deepEqual(boundaries.projectEvidence([same]),expected.map(r=>({...r,sourceId:'copy'})));
  assert.equal(parses,1);
  s.deleted=true;assert.deepEqual(boundaries.projectEvidence([s]),[]);delete s.deleted;
  s.projectExcluded=true;assert.deepEqual(boundaries.projectEvidence([s]),[]);delete s.projectExcluded;
  assert.deepEqual(boundaries.projectEvidence([s,{...same,previousSourceId:s.id}]),expected.map(r=>({...r,sourceId:'copy'})));
 });
 boundaries.projectEvidence([s]);assert.equal(parses,2);
 s.content=JSON.stringify({operation:'code',query:{taskId:9,projectId:10},data:{}});
 assert.deepEqual(cache.run(()=>boundaries.projectEvidence([s])),[{taskId:'9',projectId:'10',region:'sg',sourceId:'s'}]);
 for(const content of ['not json',JSON.stringify({region:'sg',query:{region:'us'},data:{}}),JSON.stringify({query:{taskId:1,projectId:2},data:{taskId:99}})]){
  const invalid=platform('bad',{content});assert.deepEqual(cache.run(()=>boundaries.projectEvidence([invalid])),[]);
 }
});

test('memo hits never suppress fresh ACL, principal or binding checks',t=>{
 const relations=require('../desktop/relation-obligations.cjs'),access=require('../desktop/protocol-access.cjs'),{a,job,task}=fixture();
 const s=platform('s',{projectId:null});a.data.sources=[s];task.sourceIds=job.sourceIds=['s'];
 let allowed=true;const acl=t.mock.method(access,'allowedObject',()=>allowed);
 cache.run(()=>{
  assert.deepEqual(relations.sourceRows(a,job,task,['s']),[s]);assert.equal(acl.mock.callCount(),1);
  allowed=false;assert.deepEqual(relations.sourceRows(a,job,task,['s']),[]);assert.equal(acl.mock.callCount(),2);
  allowed=true;job.platformPrincipal={user:'different'};assert.deepEqual(relations.sourceRows(a,job,task,['s']),[]);
  delete job.platformPrincipal;task.contextBindings=require('../desktop/evidence-links.cjs').bindings(a,task);
  task.contextBindings[0].contentHash='stale';assert.deepEqual(relations.sourceRows(a,job,task,['s']),[]);
 });
});

test('a projection exception releases its memoized source graph',t=>{
 const {a,job}=fixture(),s=source('a');a.data.sources=[s];
 t.mock.method(policy,'inspect',()=>{store.current(a.data,s);throw Error('inspection failed');});
 assert.throws(()=>work.view(a,job),/inspection failed/);
 const replacement=source('b',{previousSourceId:'a'});a.data.sources.push(replacement);
 assert.equal(store.current(a.data,s),replacement);
});
