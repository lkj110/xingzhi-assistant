const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs'),f=require('./root-relation-physical-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),links=require('../desktop/evidence-links.cjs'),policy=require('../desktop/access-policy-store.cjs');
function setup(t,roots=['123']){
 const v=fixture(t,{kinds:'物理表血缘',roots});v.job.platformPrincipal='fixture-platform';
 const grant={principalScope:{kind:'account',provider:'platform',subject:'fixture-platform'},resourceScope:{kind:'platform',key:v.job.dataPlatform,jobId:v.job.id},operations:['platform_query']};
 policy.grant(v.a,grant,{trusted:true,actor:'user_command',command:'fixture'});
 const map=(table='out',taskId=123)=>v.source('outputs',{taskId,outputs:[{type:'partition',databaseName:'db',tableName:table,storageRegion:'sg'}]},{taskId});
 const center=(table='out',input=[],output=[],bind=true)=>v.source('table_lineage',f.data(table,input,output),{database:'db',table},{},bind);
 return {...v,map,center,grant};
}
test('public evidenceNeeds is exact, deduplicated across roots, scoped and pure',t=>{
 const v=setup(t,['123','456']),a=v.map(),b=v.map('out',456),before=JSON.stringify(v.a.data);
 const needs=r.evidenceNeeds(v.a,v.job,v.task);assert.equal(needs.length,2);assert.deepEqual(needs[0].rootIds,['123','456']);
 for(const n of needs){assert.deepEqual(n.query,{op:'table_lineage',database:'db',table:'out'});assert.deepEqual(n.proofSourceIds,[a.id,b.id].sort());assert.equal(n.kind,'physical_lineage');assert.equal(n.reason,'missing_own_center');}
 assert.equal(JSON.stringify(v.a.data),before);
 policy.revoke(v.a,v.grant,{trusted:true,actor:'user_command',command:'fixture'});
 assert.deepEqual(r.evidenceNeeds(v.a,v.job,v.task),[]);assert.ok(r.physicalContext(v.a,v.job,v.task).frontier.every(g=>!g.query&&(g.queryBlockedReason||g.reason==='root_output_mapping_missing')));
});
test('context, checks and saved receipt revalidation use the same real closure',t=>{
 const v=setup(t),map=v.map(),root=v.center('out',['leaf']);
 assert.equal(v.check([map.id,root.id],{kind:'physical_lineage'}).result.passed,false);
 assert.equal(r.context(v.a,v.job,v.task)[0].physicalCoverage.closureProven,false);
 const leaf=v.center('leaf'),result=v.check([map.id,root.id,leaf.id],{kind:'physical_lineage'});
 assert.equal(result.result.passed,true);assert.equal(result.receipts[0].closureProven,true);r.record(v.job,result.receipts);
 assert.equal(r.context(v.a,v.job,v.task)[0].status,'analyzed');
 links.withdrawSources(v.a,v.task,[leaf.id],{reason:'withdraw'});
 const c=r.context(v.a,v.job,v.task)[0];assert.equal(c.status,'acquired');assert.equal(c.physicalCoverage.closureProven,false);assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),[]);
 assert.equal(r.evidenceNeeds(v.a,v.job,v.task)[0].identity.table,'leaf');
});
for(const mutation of ['unbind','revoke','version','principal'])test('physical proof is rechecked after '+mutation,t=>{
 const v=setup(t),map=v.map(),root=v.center(),ids=[map.id,root.id];r.record(v.job,v.check(ids,{kind:'physical_lineage'}).receipts);
 assert.equal(r.context(v.a,v.job,v.task)[0].status,'analyzed');
 if(mutation==='unbind')v.task.sourceIds=v.task.sourceIds.filter(id=>id!==map.id);
 if(mutation==='revoke')policy.revoke(v.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+root.id,jobId:v.job.id,taskId:v.task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
 if(mutation==='version')root.content+=' ';
 if(mutation==='principal')root.platformPrincipal='different';
 assert.equal(r.context(v.a,v.job,v.task)[0].physicalCoverage.closureProven,false);assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),[]);
});
test('current contradictory center cannot be hidden by model source selection or saved receipt',t=>{
 const v=setup(t),map=v.map(),root=v.center(),ids=[map.id,root.id];r.record(v.job,v.check(ids,{kind:'physical_lineage'}).receipts);
 v.center('out',['leaf']);assert.equal(v.check(ids,{kind:'physical_lineage'}).result.passed,false);assert.equal(r.context(v.a,v.job,v.task)[0].status,'acquired');
});
test('all configured root outputs are required, and conflicting mappings are explicit gaps',t=>{
 const v=setup(t),mapping=v.source('outputs',{taskId:123,outputs:[{database:'db',table:'out'},{database:'db',table:'other'}]}),root=v.center();
 assert.equal(v.check([mapping.id,root.id],{kind:'physical_lineage'}).result.passed,false);
 assert.ok(r.evidenceNeeds(v.a,v.job,v.task).every(n=>n.identity.table==='other'));
 v.map('different');assert.ok(r.physicalContext(v.a,v.job,v.task).frontier.every(g=>g.reason==='root_output_mapping_conflict'));
});
test('old locally readable source is not typed proof; explicit root can request fresh outputs',t=>{
 const v=setup(t),map=v.map();delete map.platformPrincipal;
 assert.equal(require('../desktop/protocol-access.cjs').allowedObject(v.a,'source',map,v.job,v.task),true);
 assert.deepEqual(r.sourceRows(v.a,v.job,v.task,[map.id]),[]);
 const needs=r.evidenceNeeds(v.a,v.job,v.task);assert.equal(needs.length,1);assert.deepEqual(needs[0].query,{op:'outputs',taskId:'123'});assert.equal(needs[0].identity,null);
 assert.ok(r.physicalContext(v.a,v.job,v.task).frontier.every(g=>g.reason==='root_output_mapping_missing'));
});
test('actual exact accepted Coral denial satisfies with retained provenance, never closed',t=>{
 const v=setup(t),map=v.map(),root=v.center('out',['leaf']);
 const op={id:'actual-denial',key:'actual-denial',query:{op:'table_lineage',database:'db',table:'leaf'},principal:v.job.platformPrincipal,permissionRevision:0,scope:'sg-readonly',status:'failed',errorCode:'AUTH_REQUIRED',error:'no access',completedAt:'2026-10-16T00:00:00Z',acceptedBoundary:{authority:'user',policy:'document_and_continue',decisionId:'exact-user-decision',coverage:'query'}};
 v.job.executionState.operations[op.key]=op;
 const p=r.physicalContext(v.a,v.job,v.task);assert.equal(p.satisfied,true);assert.equal(p.closureProven,false);assert.equal(p.frontier[0].boundary.operationId,op.id);assert.deepEqual(r.evidenceNeeds(v.a,v.job,v.task),[]);
 const checked=v.check([map.id,root.id],{kind:'physical_lineage'});assert.equal(checked.result.passed,true);assert.equal(checked.receipts[0].status,'accepted_boundary');assert.equal(checked.receipts[0].closureProven,false);
 r.record(v.job,checked.receipts);assert.equal(r.context(v.a,v.job,v.task)[0].status,'accepted_boundary');
 v.job.executionState.permissionRevision++;assert.equal(r.physicalContext(v.a,v.job,v.task).satisfied,false);assert.equal(r.context(v.a,v.job,v.task)[0].status,'acquired');
});
test('whole exact obligation acceptance suppresses queries while preserving unknown closure',t=>{
 const v=setup(t);v.map();const o=r.required(v.a,v.job,v.task)[0];v.job.executionState.gaps=[{obligationId:o.id,taskId:v.task.id,status:'accepted_gap',acceptedBy:'user',decisionId:'user-decision'}];
 const p=r.physicalContext(v.a,v.job,v.task);assert.equal(p.satisfied,true);assert.equal(p.closureProven,false);assert.deepEqual(r.evidenceNeeds(v.a,v.job,v.task),[]);
});
test('local failures are explicit context gaps, not fabricated attempts or automatic retries',t=>{
 const v=setup(t);v.map();v.center('out',['leaf']);
 v.job.executionState.operations.denied={id:'actual-denied',query:{op:'table_lineage',database:'db',table:'leaf'},principal:v.job.platformPrincipal,scope:'sg-readonly',permissionRevision:0,status:'failed',errorCode:'AUTH_REQUIRED',error:'observed denial',completedAt:'2026-10-16T00:00:00Z'};
 const gap=r.physicalContext(v.a,v.job,v.task).frontier[0];assert.equal(gap.status,'failed');assert.equal(gap.attempt.operationId,'actual-denied');assert.equal(gap.attempt.reason,'observed denial');assert.deepEqual(r.evidenceNeeds(v.a,v.job,v.task),[]);
});
for(const accepted of [true,false])test((accepted?'accepted Coral denial':'Coral failure')+' with different query scope cannot satisfy or suppress the candidate',t=>{
 const v=setup(t),map=v.map(),root=v.center('out',['leaf']);
 const candidate={op:'table_lineage',database:'db',table:'leaf'},boundaries=require('../desktop/platform-boundaries.cjs');
 for(const delta of [{projectId:'7'},{taskId:'123'},{direction:'BOTH'},{depth:1},{page:1},{pageSize:100}]){
  const op={id:'scoped-denial',query:{...candidate,...delta},principal:v.job.platformPrincipal,permissionRevision:0,scope:'sg-readonly',status:'failed',errorCode:'AUTH_REQUIRED',error:'scoped denial',completedAt:'2026-10-16T00:00:00Z'};
  if(accepted)op.acceptedBoundary={authority:'user',policy:'document_and_continue',decisionId:'scoped-decision',coverage:'query'};
  v.job.executionState.operations.denied=op;
  const label=JSON.stringify(delta);
  if(accepted)assert.equal(boundaries.inspect(v.job,op.query).status,'accepted_boundary',label);
  assert.equal(boundaries.inspect(v.job,candidate).status,'ready',label);
  const p=r.physicalContext(v.a,v.job,v.task),gap=p.frontier[0];
  assert.equal(p.satisfied,false,label);assert.equal(p.closureProven,false,label);assert.equal(p.frontier.length,1,label);
  assert.equal(gap.status,'unexpanded',label);assert.equal(gap.boundary,undefined,label);assert.equal(gap.attempt,undefined,label);
  assert.deepEqual(p.queries,[candidate],label);
  const needs=r.evidenceNeeds(v.a,v.job,v.task);assert.equal(needs.length,1,label);
  assert.deepEqual(needs[0].query,candidate,label);assert.deepEqual(needs[0].rootIds,['123'],label);assert.equal(needs[0].direction,'input',label);
  const checked=v.check([map.id,root.id],{kind:'physical_lineage'});
  assert.equal(checked.result.passed,false,label);assert.deepEqual(checked.receipts,[],label);
 }
});
test('saved exact Coral acceptance is revalidated after its query scope changes',t=>{
 const v=setup(t),map=v.map(),root=v.center('out',['leaf']),candidate={op:'table_lineage',database:'db',table:'leaf'};
 const op={id:'exact-denial',query:{...candidate,region:'sg',entityType:'HiveTable'},principal:v.job.platformPrincipal,permissionRevision:0,scope:'sg-readonly',status:'failed',errorCode:'AUTH_REQUIRED',error:'exact denial',completedAt:'2026-10-16T00:00:00Z',acceptedBoundary:{authority:'user',policy:'document_and_continue',decisionId:'exact-decision',coverage:'query'}};
 v.job.executionState.operations.denied=op;
 const checked=v.check([map.id,root.id],{kind:'physical_lineage'});
 assert.equal(checked.result.passed,true);assert.equal(checked.receipts[0].status,'accepted_boundary');assert.equal(checked.receipts[0].closureProven,false);
 r.record(v.job,checked.receipts);assert.equal(r.context(v.a,v.job,v.task)[0].status,'accepted_boundary');assert.deepEqual(r.evidenceNeeds(v.a,v.job,v.task),[]);
 op.query={...op.query,projectId:'7'};
 const current=r.context(v.a,v.job,v.task)[0];
 assert.equal(current.status,'acquired');assert.equal(current.physicalCoverage.satisfied,false);assert.equal(current.physicalCoverage.closureProven,false);
 assert.deepEqual(r.evidenceNeeds(v.a,v.job,v.task).map(n=>n.query),[candidate]);
 assert.equal(v.check([map.id,root.id],{kind:'physical_lineage'}).result.passed,false);
});
