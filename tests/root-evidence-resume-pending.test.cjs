const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs'),physical=require('./root-relation-physical-fixture.cjs');
const relations=require('../desktop/relation-obligations.cjs'),continuation=require('../desktop/evidence-continuation.cjs'),journal=require('../desktop/work-journal.cjs');
function setup(t){
 const f=fixture(t,{kinds:'物理表血缘'}),mapping=f.source('outputs',{taskId:123,outputs:[{type:'partition',storageRegion:'sg',databaseName:'db',tableName:'out'}]});
 const root=f.source('table_lineage',physical.data('out',['leaf']),{database:'db',table:'out'});
 f.need({requirements:[relations.required(f.a,f.job,f.task)[0].id],gaps:['入口123物理表血缘缺失']});
 const leaf=f.source('table_lineage',physical.data('leaf',['next']),{database:'db',table:'leaf'},{},false);
 return {...f,ids:[mapping.id,root.id,leaf.id],leaf};
}
// Observe exactly the detached, applied candidate used by the real commit,
// before event construction or append. Never patch production commit code.
function beforeAppend(t,inspect){
 const commit=continuation.commit;
 t.mock.method(continuation,'commit',(a,j,task,args,options)=>commit(a,j,task,args,{...options,apply:(draft,nextJob,next)=>{
  const result=options.apply(draft,nextJob,next);inspect(draft,nextJob,next);return result;
 }}));
}
test('atomic preparation can see a minted new center; default only sees it after durable commit',t=>{
 const f=setup(t);let pending;
 beforeAppend(t,(a,j,task)=>{
  const before=JSON.stringify(a.data),count=journal.read(a).events.length;
  assert.deepEqual(relations.recoveryFacts(a,j,task),[]);
  pending=relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution});
  assert.equal(pending.length,1);assert.equal(pending[0].scope.entity.table,'leaf');assert.equal(pending[0].direction,'input');
  assert.equal(relations.physicalContext(a,j,task).closureProven,false);
  assert.equal(JSON.stringify(a.data),before);assert.equal(journal.read(a).events.length,count);
 });
 f.resolve(f.ids);assert.deepEqual(relations.recoveryFacts(f.a,f.job,f.task),pending);
 journal.replay(f.a,{force:true});assert.deepEqual(relations.recoveryFacts(f.a,f.job,f.task),pending);
});
test('cloned, invented, tampered or foreign pending objects carry no authority',t=>{
 const f=setup(t);
 beforeAppend(t,(a,j,task)=>{
  const resolution=task.lastEvidenceResolution;
  assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:structuredClone(resolution)}),[]);
  task.lastEvidenceResolution=structuredClone(resolution);
  assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution}),[]);
  task.lastEvidenceResolution=resolution;
  const unowned=relations.resolutionProof(a,j,f.task,task,{...f.task.evidenceRequest},resolution.sourceIds);
  task.lastEvidenceResolution={...resolution,recoveryProof:unowned};
  assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution}),[]);
  task.lastEvidenceResolution=resolution;
  const original=resolution.recoveryProof.facts[0].fact.contentHash;
  resolution.recoveryProof.facts[0].fact.contentHash='forged';
  assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:resolution}),[]);
  resolution.recoveryProof.facts[0].fact.contentHash=original;
  assert.deepEqual(relations.recoveryFacts({...a,dir:a.dir+'-other'},j,task,{pendingResolution:resolution}),[]);
  const ids=resolution.sourceIds;resolution.sourceIds=[];
  assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:resolution}),[]);resolution.sourceIds=ids;
  assert.equal(relations.recoveryFacts(a,j,task,{pendingResolution:resolution}).length,1);
 });
 f.resolve(f.ids);
});
test('pending proof rechecks the original request and current candidate binding/type/body',t=>{
 const f=setup(t);
 beforeAppend(t,(a,j,task)=>{
  const pending=()=>relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution});
  const request=f.task.evidenceRequest;f.task.evidenceRequest={...request};assert.deepEqual(pending(),[]);f.task.evidenceRequest=request;
  const basis=request.basis;request.basis='changed';assert.deepEqual(pending(),[]);request.basis=basis;
  const ids=task.sourceIds;task.sourceIds=ids.filter(id=>id!==f.leaf.id);assert.deepEqual(pending(),[]);task.sourceIds=ids;
  const s=a.data.sources.find(s=>s.id===f.leaf.id),content=s.content;s.content+=' ';assert.deepEqual(pending(),[]);s.content=content;
  s.deleted=true;assert.deepEqual(pending(),[]);delete s.deleted;
  const principal=s.platformPrincipal;s.platformPrincipal='other-principal';assert.deepEqual(pending(),[]);s.platformPrincipal=principal;
  assert.equal(pending().length,1);
 });
 f.resolve(f.ids);
});
test('preappend failure never creates durable credit; retry remints proof and commits once',t=>{
 const f=setup(t),before=journal.read(f.a).events.length,append=journal.append;let preparations=0;
 beforeAppend(t,(a,j,task)=>{assert.equal(relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution}).length,1);preparations++;});
 t.mock.method(journal,'append',()=>{throw Error('before append');});
 assert.throws(()=>f.resolve(f.ids),/before append/);assert.deepEqual(relations.recoveryFacts(f.a,f.job,f.task),[]);assert.equal(journal.read(f.a).events.length,before);
 journal.append=append;f.resolve(f.ids);assert.equal(preparations,2);assert.equal(relations.recoveryFacts(f.a,f.job,f.task).length,1);
 assert.equal(journal.read(f.a).events.filter(e=>e.type==='evidence_plan_committed').length,1);
});
test('pending path does not bypass projection-pending guards',t=>{
 const f=setup(t);
 beforeAppend(t,(a,j,task)=>{
  a.data.runtime.projectionPending={domain:'work'};assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution}),[]);delete a.data.runtime.projectionPending;
  task.projectionPending={};assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution}),[]);delete task.projectionPending;
 });
 f.resolve(f.ids);
});
test('ACL revoked during preparation removes pending credit and prevents append',t=>{
 const f=setup(t),policy=require('../desktop/access-policy-store.cjs'),before=journal.read(f.a).events.length;
 beforeAppend(t,(a,j,task)=>{
  policy.revoke(f.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+f.leaf.id,jobId:j.id,taskId:task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
  assert.deepEqual(relations.recoveryFacts(a,j,task,{pendingResolution:task.lastEvidenceResolution}),[]);
 });
 assert.throws(()=>f.resolve(f.ids),e=>e.code==='CONTEXT_SCOPE_DENIED');assert.equal(journal.read(f.a).events.length,before);
 assert.deepEqual(relations.recoveryFacts(f.a,f.job,f.task),[]);
});
