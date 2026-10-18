const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./root-relation-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),f=require('./root-relation-physical-fixture.cjs'),journal=require('../desktop/work-journal.cjs');
function setup(t){
 const v=fixture(t,{kinds:'物理表血缘'}),mapping=v.source('outputs',{taskId:123,outputs:[{type:'partition',databaseName:'db',tableName:'out',storageRegion:'sg'}]});
 const center=(table='out',input=[],output=[],bind=true)=>v.source('table_lineage',f.data(table,input,output),{database:'db',table},{},bind);
 const need=()=>v.need({requirements:[r.required(v.a,v.job,v.task)[0].id],gaps:['入口123物理表血缘缺失']});
 return {...v,mapping,center,need};
}
test('new own-center adjacency for original exact direction is a semantic fact before global closure',t=>{
 const v=setup(t),root=v.center('out',['leaf']);v.need();
 const leaf=v.center('leaf',['next'],['unrelated']),other=v.center('unrelated');
 v.resolve([v.mapping.id,root.id,leaf.id,other.id]);const facts=r.recoveryFacts(v.a,v.job,v.task);
 assert.equal(facts.length,1);assert.equal(facts[0].scope.entity.table,'leaf');assert.equal(facts[0].direction,'input');
 assert.equal(r.physicalContext(v.a,v.job,v.task).closureProven,false);assert.equal(v.check(v.task.sourceIds,{kind:'physical_lineage'}).result.passed,false);
 assert.doesNotMatch(JSON.stringify(facts),/sourceId|observedAt|permissionRevision/);
});
test('ordinary association and incidental leaf properties never grant IR4 credit',t=>{
 const v=setup(t);v.need();const root=v.center('out',['leaf']);v.plan([root.id,v.mapping.id]);assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),[]);
 v.need();const clone=v.center('out',['leaf']);v.resolve([root.id,clone.id,v.mapping.id]);assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),[]);
});
test('original gap cannot grant newly discovered grandchild facts from the same acquisition',t=>{
 const v=setup(t),root=v.center('out',['leaf']);v.need();const leaf=v.center('leaf',['next']),next=v.center('next');
 v.resolve([v.mapping.id,root.id,leaf.id,next.id]);const facts=r.recoveryFacts(v.a,v.job,v.task);assert.equal(facts.length,1);assert.equal(facts[0].scope.entity.table,'leaf');
});
test('new source ID, counter, time and permission revision cannot refresh an existing adjacency fact',t=>{
 const v=setup(t),root=v.center('out',['leaf']);v.need();const leaf=v.center('leaf',['next']);v.resolve([v.mapping.id,root.id,leaf.id]);const before=r.recoveryFacts(v.a,v.job,v.task);
 v.need();const clone=v.center('leaf',['next']);v.resolve([v.mapping.id,root.id,leaf.id,clone.id]);assert.equal(v.task.lastEvidenceResolution.recoveryProof,undefined);assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),before);
 v.job.executionState.permissionRevision++;assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),before);
});
test('current path and exact new center proof are revalidated after atomic replay',t=>{
 const v=setup(t),root=v.center('out',['leaf']);v.need();const leaf=v.center('leaf',['next']);v.resolve([v.mapping.id,root.id,leaf.id]);
 const before=r.recoveryFacts(v.a,v.job,v.task),events=journal.read(v.a).events.length;assert.equal(before.length,1);
 journal.replay(v.a,{force:true});assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),before);assert.equal(journal.read(v.a).events.length,events);
 v.task.sourceIds=v.task.sourceIds.filter(id=>id!==root.id);assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),[]);
});
