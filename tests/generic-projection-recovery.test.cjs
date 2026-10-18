'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs'),physical=require('./root-relation-physical-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),cache=require('../desktop/projection-cache.cjs'),links=require('../desktop/evidence-links.cjs');
const journal=require('../desktop/work-journal.cjs'),projector=require('../desktop/physical-lineage-coverage.cjs'),policy=require('../desktop/access-policy-store.cjs');
function setup(t){
 const v=fixture(t,{roots:['123','456'],kinds:'物理表血缘'});v.job.platformPrincipal='controlled';
 policy.grant(v.a,{principalScope:{kind:'account',provider:'platform',subject:'controlled'},resourceScope:{kind:'platform',key:v.job.dataPlatform,jobId:v.job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'fixture'});
 const mapping=v.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123});
 v.source('outputs',{outputs:[{database:'db',table:'other'}]},{taskId:456});
 const o=r.required(v.a,v.job,v.task)[0],anchor=r.requestProof(v.a,v.job,v.task,{requirements:[o.id]});
 const center=v.source('table_lineage',physical.data('out'),{database:'db',table:'out'});
 const request={kind:'needs_evidence',basis:'controlled-basis',recoveryRequest:anchor};
 const proof=r.resolutionProof(v.a,v.job,v.task,v.task,request,[center.id]);assert.ok(proof?.facts.length);
 const resolution={basis:request.basis,recoveryProof:proof,sourceIds:[center.id]};
 return {...v,mapping,center,o,resolution};
}
function events(v,count){return Array.from({length:count},()=>({type:'evidence_plan_committed',entityId:v.task.id,workRevision:v.task.workRevision??1,payload:{task:{set:{lastEvidenceResolution:structuredClone(v.resolution)}}}}));}
for(const count of [1,13,26,52])test(count+' historical proofs share one current graph and every proof is checked',t=>{
 const v=setup(t),list=events(v,count);let checked=0;
 for(const event of list){const resolution=event.payload.task.set.lastEvidenceResolution;Object.defineProperty(event.payload.task.set,'lastEvidenceResolution',{enumerable:true,get(){checked++;return resolution;}});}
 t.mock.method(journal,'read',()=>({events:list}));const original=projector.project,project=t.mock.method(projector,'project',(...args)=>original(...args));
 const memo=cache.memo,misses={};t.mock.method(cache,'memo',(ns,keys,read)=>memo(ns,keys,()=>{misses[ns.name||'anonymous']=(misses[ns.name||'anonymous']||0)+1;return read();}));
 const before=JSON.stringify(v.a.data);let actual;
 cache.scope(()=>{actual=r.recoveryFacts(v.a,v.job,v.task);const bad=r.recoveryFacts(v.a,v.job,v.task);bad[0].rootId='tampered';assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),actual);});
 assert.equal(checked,count);assert.equal(project.mock.callCount(),1);assert.equal(misses.recoveryFacts,1);assert.equal(misses.currentFactIndex,1);assert.equal(misses.facts,1);assert.equal(misses.physicalContext,1);assert.equal(misses.sourceRows,1);
 assert.equal(JSON.stringify(v.a.data),before);
 // Disable all memoization as an independent semantic comparison on controlled data.
 t.mock.method(cache,'memo',(_ns,_keys,read)=>read());assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),actual);assert.equal(checked,count*2);
 t.diagnostic(JSON.stringify({proofCount:count,heavyProjections:1,currentFactIndexes:misses.currentFactIndex,historyChecked:count}));
});
test('every historical source, prior fact and request anchor is revalidated, including the last event',t=>{
 const v=setup(t),list=events(v,52),expected=r=>r.recoveryProof.facts.map(p=>p.fact);
 for(const event of list.slice(0,-1))event.payload.task.set.lastEvidenceResolution.recoveryProof.facts.forEach(p=>p.sourceId='absent');
 t.mock.method(journal,'read',()=>({events:list}));assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),expected(v.resolution).sort((a,b)=>require('../desktop/evidence-basis.cjs').hash(a).localeCompare(require('../desktop/evidence-basis.cjs').hash(b))));
 const last=list.at(-1).payload.task.set.lastEvidenceResolution;
 last.recoveryProof.request.priorFacts=last.recoveryProof.facts.map(p=>require('../desktop/evidence-basis.cjs').hash(p.fact));assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),[]);
 last.recoveryProof.request.priorFacts=[];last.recoveryProof.request.workRevision++;assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),[]);
});
test('root/source subsets remain distinct; equivalent root/source order shares a graph and public consumers cannot poison it',t=>{
 const v=setup(t),original=projector.project,spy=t.mock.method(projector,'project',(...args)=>original(...args));
 cache.scope(()=>{
  const first=r.physicalContext(v.a,v.job,v.task,{obligation:v.o}),expected=structuredClone(first);first.frontier.length=0;first.roots[0].rootId='tampered';
  assert.deepEqual(r.physicalContext(v.a,v.job,v.task,{obligation:{...v.o,rootIds:[...v.o.rootIds].reverse()},sourceIds:[...v.task.sourceIds].reverse()}),expected);assert.equal(spy.mock.callCount(),1);
  const subset=r.physicalContext(v.a,v.job,v.task,{obligation:{...v.o,rootIds:['123']}});assert.equal(subset.closureProven,true);assert.equal(spy.mock.callCount(),2);
  assert.equal(r.physicalContext(v.a,v.job,v.task,{obligation:{...v.o,rootIds:['123']},sourceIds:[v.mapping.id]}).closureProven,false);assert.equal(spy.mock.callCount(),3);
  const refs=r.sourceRows(v.a,v.job,v.task,v.task.sourceIds);refs[0].content='consumer mutation';assert.notEqual(r.sourceRows(v.a,v.job,v.task,v.task.sourceIds)[0].content,'consumer mutation');
 });
});
for(const change of ['content','version','principal','withdrawal','replacement','acl','lineageOnly','permissionRevision','rootContract'])test('a new pure scope observes '+change,t=>{
 const v=setup(t),list=events(v,1);t.mock.method(journal,'read',()=>({events:list}));assert.ok(r.recoveryFacts(v.a,v.job,v.task).length);
 const original=projector.project,spy=t.mock.method(projector,'project',(...args)=>original(...args));
 if(change==='content')v.center.content+=' ';
 if(change==='version')v.center.version='changed';
 if(change==='principal')v.center.platformPrincipal='other';
 if(change==='withdrawal')v.task.contextBindings.find(b=>b.sourceId===v.center.id).state='withdrawn';
 if(change==='replacement')v.a.data.sources.push({...v.center,id:'replacement',previousSourceId:v.center.id});
 if(change==='acl')policy.revoke(v.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+v.center.id,jobId:v.job.id,taskId:v.task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
 if(change==='lineageOnly')v.task.criteria+='；也核对容量';
 if(change==='permissionRevision')v.job.executionState.permissionRevision++;
 if(change==='rootContract')v.job.goal=v.job.goal.replace('123,456','789');
 const result=r.recoveryFacts(v.a,v.job,v.task);
 if(['content','version','principal','withdrawal','replacement','acl'].includes(change))assert.deepEqual(result,[]);
 // Changed intent may reject the anchor before graph construction. Otherwise recompute.
 if(!['rootContract'].includes(change))assert.ok(spy.mock.callCount()>0);
});
test('frozen inputs and proof history survive repeated pure projections',t=>{
 const v=setup(t),list=events(v,13);t.mock.method(journal,'read',()=>({events:list}));
 const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.freeze(x);Object.values(x).forEach(freeze);}};
 const before=JSON.stringify(v.a.data);freeze(v.a.data);freeze(list);
 const deny=()=>{throw Error('pure projection attempted a side effect');};
 t.mock.method(v.a,'save',deny);for(const name of ['writeFileSync','appendFileSync','createWriteStream'])t.mock.method(require('node:fs'),name,deny);
 t.mock.method(globalThis,'setInterval',deny);
 cache.scope(()=>{r.recoveryFacts(v.a,v.job,v.task);r.physicalContext(v.a,v.job,v.task);r.evidenceNeeds(v.a,v.job,v.task);});assert.equal(JSON.stringify(v.a.data),before);
});
