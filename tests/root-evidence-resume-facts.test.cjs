const {test}=require('node:test'),assert=require('node:assert/strict');
const physical=require('./root-relation-physical-fixture.cjs');
const {fixture,deny}=require('./root-relation-fixture.cjs'),r=require('../desktop/relation-obligations.cjs'),links=require('../desktop/evidence-links.cjs'),e=require('../desktop/evidence-basis.cjs'),journal=require('../desktop/work-journal.cjs');
test('IR4 explicit missing SQL plus a committed current relevant resolution exposes one fact before analysis',t=>{
 const f=fixture(t);f.need();const s=f.source('code',undefined,undefined,{},false);f.resolve([s.id]);
 const facts=r.recoveryFacts(f.a,f.job,f.task);assert.equal(facts.length,1);assert.equal(facts[0].kind,'sql_read_write');assert.equal(facts[0].rootId,'123');
 assert.notEqual(r.context(f.a,f.job,f.task)[0].status,'analyzed');assert.equal(f.task.evidenceRequest,undefined);
 const log=journal.read(f.a).events.findLast(e=>e.type==='evidence_plan_committed');assert.equal(log.payload.task.set.lastEvidenceResolution.recoveryProof.request.basis,f.task.lastEvidenceResolution.basis);
 assert.doesNotMatch(JSON.stringify(facts),/sourceId|queriedAt|request-|artifactId|planVersion/);
});
test('acquisition and ordinary plan association do not become recovery facts without resolution',t=>{
 const f=fixture(t);f.need();const s=f.source();assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);f.plan([s.id]);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});
for(const type of ['calendar','wrong_root','broad_request','replan'])test('IR4 '+type+' is not a related new fact token',t=>{
 const f=fixture(t);f.need(type==='broad_request'?{gaps:['缺资料'],requirements:['task:'+f.task.id]}:type==='replan'?{kind:'needs_replan'}:{});
 const s=type==='calendar'?f.source('calendar',{date:'2026-10-17'}):type==='wrong_root'?f.source('code',{taskId:999,sql:'SELECT 1'},{taskId:999}):f.source();
 f.resolve([s.id]);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});
test('operation failure retries and error wording produce diagnostics, never new content facts',t=>{
 for(const errorCode of ['AUTH_REQUIRED','UNSUPPORTED_CAPABILITY','TRANSIENT']){
  const f=fixture(t);f.need();const op={id:'failed',key:'failed',query:{op:'code',taskId:123},status:'failed',errorCode,scope:'sg-readonly',permissionRevision:0,principal:null,completedAt:new Date().toISOString()};
  f.job.executionState.operations.failed=op;f.resolve([],{operationKeys:['failed']});assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
  op.id='new-attempt';op.error='different words';op.completedAt=new Date().toISOString();assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
 }
});
test('same semantic content under a new ID, operation method or observation time never adds tokens',t=>{
 const f=fixture(t);f.need();const first=f.source();f.resolve([first.id]);const before=r.recoveryFacts(f.a,f.job,f.task);
 f.need();const clone=f.source('sql',{taskId:123,code:'SELECT a FROM orders',observedAt:'later',method:'alternative'},{taskId:123});
 f.resolve([clone.id]);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);assert.equal(f.task.lastEvidenceResolution.recoveryProof,undefined);
 relationsCheck();function relationsCheck(){r.record(f.job,f.check([clone.id]).receipts);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);}
 f.task.planVersion++;f.task.steps[0].method='another';assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);
});
test('fake lastEvidenceResolution without its committed event is not authority',t=>{
 const f=fixture(t);f.need();const s=f.source();const proof=r.resolutionProof(f.a,f.job,f.task,f.task,f.task.evidenceRequest,[s.id]);
 f.task.lastEvidenceResolution={basis:f.task.evidenceRequest.basis,sourceIds:[s.id],recoveryProof:proof};delete f.task.evidenceRequest;
 assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});
test('readability and typed bindings are revalidated after commit and before resume',t=>{
 for(const change of ['withdraw','delete','revoke','version','scope','project']){
  const f=fixture(t);f.need();const s=f.source();f.resolve([s.id]);assert.equal(r.recoveryFacts(f.a,f.job,f.task).length,1);
  if(change==='withdraw')links.withdrawSources(f.a,f.task,[s.id],{reason:'withdraw'});
  if(change==='delete')s.deleted=true;
  if(change==='revoke')require('../desktop/access-policy-store.cjs').revoke(f.a,{principalScope:require('../desktop/access-policy-store.cjs').LOCAL,resourceScope:{kind:'snapshot',key:'source:'+s.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
  if(change==='version')s.content+=' ';
  if(change==='scope')f.job.executionContract={revision:'new',text:'入口 IDs: 456\n\n范围：\nSQL读写'};
  if(change==='project')f.task.projectId='moved-project';
  assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[],change);
 }
});
test('Coral observation times and size/query counters are not new relationship facts',t=>{
 const f=fixture(t,{kinds:'物理表血缘'}),q={database:'db',table:'out'},mapping=f.source('outputs',{taskId:123,outputs:[{type:'partition',storageRegion:'sg',databaseName:'db',tableName:'out'}]});
 const o=r.required(f.a,f.job,f.task)[0];f.need({requirements:[o.id],gaps:['入口123物理表血缘缺失']});
 const body=n=>{const d=physical.data();Object.assign(d.guidEntityMap.out.attributes,{sourceUpdateTime:n,lastModifiedTime:n,tableSize:n,queryCount30Days:n});return d;};
 const first=f.source('table_lineage',body(1),q);f.resolve([first.id,mapping.id]);const before=r.recoveryFacts(f.a,f.job,f.task);assert.equal(before.length,2);
 f.need({requirements:[o.id],gaps:['入口123物理表血缘缺失']});const clone=f.source('table_lineage',body(2),q);f.resolve([first.id,clone.id,mapping.id]);
 assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);assert.equal(f.task.lastEvidenceResolution.recoveryProof,undefined);
});
test('restart and response retry reuse semantic proof; no new event or facts',t=>{
 const f=fixture(t);f.need();const s=f.source(),basis=f.task.evidenceRequest.basis;f.resolve([s.id]);
 const before=r.recoveryFacts(f.a,f.job,f.task),count=journal.read(f.a).events.length;
 const {Assistant}=require('../desktop/core.cjs'),a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 const job=a.data.delegations.find(j=>j.id===f.job.id),task=a.task(f.task.id);assert.deepEqual(r.recoveryFacts(a,job,task),before);
 require('../desktop/agent-plan.cjs').planTask(a,job,{key:'report',title:task.title,criteria:task.criteria,sourceIds:[s.id],reason:'关联原缺口证据',evidenceResolution:{basis,sourceIds:[s.id],reason:'处理原缺口'}});
 assert.equal(journal.read(a).events.length,count);assert.deepEqual(r.recoveryFacts(a,job,task),before);
});
test('resolution proof survives committed snapshot failure and lazy journal replay',t=>{
 const f=fixture(t);f.need();const s=f.source(),backup=structuredClone(f.a.data),save=f.a.save;f.a.save=()=>{throw Error('snapshot');};
 assert.throws(()=>f.resolve([s.id]),err=>err.committed&&err.projectionPending);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
 f.a.save=save;f.a.data=backup;journal.replay(f.a,{force:true});const job=f.a.data.delegations.find(j=>j.id===f.job.id),task=f.a.task(f.task.id);
 assert.equal(r.recoveryFacts(f.a,job,task).length,1);const before=e.hash(r.recoveryFacts(f.a,job,task));journal.replay(f.a,{force:true});assert.equal(e.hash(r.recoveryFacts(f.a,job,task)),before);
});
test('request snapshots keep original gap roots and cannot widen via resolution reason',t=>{
 const f=fixture(t,{roots:['123','456']});f.need({gaps:['入口123 SQL缺失']});
 const other=f.source('code',{taskId:456,sql:'SELECT 1'},{taskId:456});f.resolve([other.id],{reason:'顺便扩大为456'});assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});
test('related scope proof must remain bound and readable even when SQL itself is unchanged',t=>{
 const f=fixture(t);f.need();const sql=f.source('code',{taskId:999,sql:'SELECT 1'},{taskId:999}),map=f.source('downstream',{taskId:123,nodes:[{id:999,parentRelation:[123]}]});
 f.resolve([sql.id,map.id]);assert.equal(r.recoveryFacts(f.a,f.job,f.task).length,1);f.task.sourceIds=f.task.sourceIds.filter(id=>id!==map.id);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});

test('validated relation path uses semantic facts too; new source IDs and check IDs never refresh it',t=>{
 const f=fixture(t),s=f.source();r.record(f.job,f.check([s.id]).receipts);const before=r.recoveryFacts(f.a,f.job,f.task);assert.equal(before.length,1);
 const clone=f.source('sql',{taskId:123,code:'SELECT a FROM orders',method:'new method'},{taskId:123});r.record(f.job,f.check([clone.id]).receipts);
 assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);
 f.job.executionState.permissionRevision++;assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before,'permission observations are not semantic facts');
 assert.doesNotMatch(JSON.stringify(before),/permissionRevision/);
});
test('only the explicit relation requirement grants targets; a generic task requirement does not',t=>{
 const f=fixture(t),o=r.required(f.a,f.job,f.task)[0];f.need({gaps:['缺读写证据'],requirements:[o.id]});const s=f.source();f.resolve([s.id]);assert.equal(r.recoveryFacts(f.a,f.job,f.task).length,1);
});
test('semantic fact value excludes contract revision wrappers and request wording',t=>{
 const f=fixture(t),s=f.source();r.record(f.job,f.check([s.id]).receipts);const before=r.recoveryFacts(f.a,f.job,f.task);
 f.job.executionContract={revision:'metadata-only-revision',text:f.job.goal};r.record(f.job,f.check([s.id]).receipts);
 assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);
});
test('done operation without referenced actual content remains a diagnostic-only resolution',t=>{
 const f=fixture(t);f.need();f.job.executionState.operations.done={id:'done',key:'done',query:{op:'code',taskId:123},status:'done',completedAt:new Date().toISOString(),principal:null};
 f.resolve([],{operationKeys:['done']});assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});
test('partial but actual new related content may reopen analysis without certifying full coverage',t=>{
 const f=fixture(t);f.need();const s=f.source('code',undefined,undefined,{coverage:'partial'});f.resolve([s.id]);
 assert.equal(r.recoveryFacts(f.a,f.job,f.task).length,1);assert.equal(f.check([s.id]).result.passed,false);
});
test('new data cannot borrow an earlier claimed semantic fact after an in-place body change',t=>{
 const f=fixture(t);f.need();const s=f.source();f.resolve([s.id]);
 const snap=JSON.parse(s.content);snap.data.sql='SELECT changed FROM elsewhere';s.content=JSON.stringify(snap);links.setInputs(f.a,f.task,f.task.sourceIds);
 assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});

