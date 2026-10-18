'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs'),f=require('./root-relation-physical-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),requirements=require('../desktop/relation-requirements.cjs');
test('coverageReady is false for missing own centers and true only at complete physical closure, without receipts',t=>{
 const v=fixture(t,{kinds:'物理表血缘'});
 assert.equal(r.coverageReady(v.a,v.job,v.task),false);
 v.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123});v.source('table_lineage',f.data('out',['leaf']),{database:'db',table:'out'});
 assert.equal(r.coverageReady(v.a,v.job,v.task),false);
 v.source('table_lineage',f.data('leaf'),{database:'db',table:'leaf'});
 const before=JSON.stringify(v.a.data),prepare=t.mock.method(requirements,'prepare',()=>{throw Error('coverageReady must not prepare');});
 assert.equal(r.coverageReady(v.a,v.job,v.task),true);assert.equal(r.context(v.a,v.job,v.task)[0].status,'unqueried');
 assert.equal(prepare.mock.callCount(),0);assert.equal(JSON.stringify(v.a.data),before);
});
test('coverageReady requires every typed obligation, not just physical closure or no evidenceNeeds',t=>{
 const v=fixture(t,{kinds:'SQL读写、产出配置、物理表血缘'});
 v.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123});v.source('table_lineage',f.data(),{database:'db',table:'out'});
 assert.deepEqual(r.evidenceNeeds(v.a,v.job,v.task),[]);assert.equal(r.coverageReady(v.a,v.job,v.task),false);
 const sql=v.source('sql',{sql:'SELECT 1'},{taskId:123});assert.equal(r.coverageReady(v.a,v.job,v.task),true);
 sql.content+=' changed';assert.equal(r.coverageReady(v.a,v.job,v.task),false);
});
test('coverageReady accepts exact user boundaries but rejects another obligation and malformed/empty contracts',t=>{
 const v=fixture(t,{kinds:'物理表血缘'}),o=r.required(v.a,v.job,v.task)[0];
 v.job.executionState.gaps=[{obligationId:'other',taskId:v.task.id,status:'accepted_gap',acceptedBy:'user',decisionId:'controlled'}];assert.equal(r.coverageReady(v.a,v.job,v.task),false);
 v.job.executionState.gaps[0].obligationId=o.id;assert.equal(r.coverageReady(v.a,v.job,v.task),true);
 v.job.dataPlatform='none';assert.equal(r.coverageReady(v.a,v.job,v.task),false);
 v.job.dataPlatform='sg-readonly';v.job.executionContract={text:v.job.goal,relationRequirements:[{kind:'invalid'}]};assert.equal(r.coverageReady(v.a,v.job,v.task),false);
});
test('coverageReady also requires the selected final dataset mapping',t=>{
 const v=fixture(t,{kinds:'SQL读写、产出配置、物理表血缘、最终风神映射'});
 v.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123});v.source('table_lineage',f.data(),{database:'db',table:'out'});v.source('sql',{sql:'SELECT 1'},{taskId:123});
 assert.equal(r.coverageReady(v.a,v.job,v.task),false);
 v.source('dataset_mapping',{mappings:[{datasetId:'controlled-dataset',table:'db.out'}]},{taskId:123});
 assert.equal(r.coverageReady(v.a,v.job,v.task),true);
});
test('coverageReady admits an exact accepted physical boundary without claiming closure',t=>{
 const v=fixture(t,{kinds:'物理表血缘'});v.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123});v.source('table_lineage',f.data('out',['leaf']),{database:'db',table:'out'});
 const op={id:'controlled-denial',query:{op:'table_lineage',database:'db',table:'leaf'},principal:v.job.platformPrincipal??null,permissionRevision:0,scope:'sg-readonly',status:'failed',errorCode:'AUTH_REQUIRED',error:'denied',completedAt:'2026-10-18T00:00:00Z',acceptedBoundary:{authority:'user',policy:'document_and_continue',decisionId:'controlled-decision',coverage:'query'}};
 v.job.executionState.operations.denied=op;
 assert.equal(r.physicalContext(v.a,v.job,v.task).closureProven,false);assert.equal(r.coverageReady(v.a,v.job,v.task),true);
 op.query.table='other';assert.equal(r.coverageReady(v.a,v.job,v.task),false);
});
