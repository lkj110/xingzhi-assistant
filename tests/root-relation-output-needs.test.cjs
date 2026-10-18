const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./root-relation-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),policy=require('../desktop/access-policy-store.cjs');
function setup(t,roots=['123']){
 const f=fixture(t,{roots,kinds:'物理表血缘'});f.job.platformPrincipal='fixture-platform';
 const grant={principalScope:{kind:'account',provider:'platform',subject:'fixture-platform'},resourceScope:{kind:'platform',key:'sg-readonly',jobId:f.job.id},operations:['platform_query']};
 policy.grant(f.a,grant,{trusted:true,actor:'user_command',command:'fixture'});return {...f,grant};
}
test('six explicit roots with no typed sources yield exactly six scoped outputs needs',t=>{
 const f=setup(t,['101','102','103','104','105','106']),before=JSON.stringify(f.a.data),needs=r.evidenceNeeds(f.a,f.job,f.task);
 assert.equal(needs.length,6);assert.deepEqual(needs.flatMap(n=>n.rootIds).sort(),['101','102','103','104','105','106']);
 for(const n of needs){assert.equal(n.identity,null);assert.equal(n.direction,null);assert.equal(n.kind,'physical_lineage');assert.equal(n.reason,'root_output_mapping_missing');assert.deepEqual(n.query,{op:'outputs',taskId:n.rootIds[0]});assert.deepEqual(n.proofSourceIds,[]);}
 assert.equal(r.physicalContext(f.a,f.job,f.task).closureProven,false);assert.equal(JSON.stringify(f.a.data),before);
 const request=r.requestProof(f.a,f.job,f.task,{requirements:[needs[0].obligationId],gaps:['root_output_mapping_missing']});
 assert.equal(request.targets[0].physicalGaps.length,6);
 for(const n of needs)assert.ok(request.targets[0].physicalGaps.some(g=>g.rootId===n.rootIds[0]&&g.direction===n.direction&&g.identity===n.identity));
});
test('project ID is inferred only from current typed root evidence; unknown principal stays unknown',t=>{
 const f=setup(t),old=f.source('task',{id:123,projectId:99},{taskId:123,projectId:99},{platformPrincipal:null});
 const before=JSON.stringify(old);assert.deepEqual(r.evidenceNeeds(f.a,f.job,f.task)[0].query,{op:'outputs',taskId:'123'});
 const current=f.source('task',{id:123,projectId:7},{taskId:123,projectId:7});
 const n=r.evidenceNeeds(f.a,f.job,f.task)[0];assert.deepEqual(n.query,{op:'outputs',taskId:'123',projectId:'7'});assert.deepEqual(n.proofSourceIds,[current.id]);assert.equal(JSON.stringify(old),before);
});
test('ambiguous current projects block outputs suggestions instead of dropping scope',t=>{
 const f=setup(t);for(const projectId of [7,8])f.source('task',{id:123,projectId},{taskId:123,projectId});
 assert.deepEqual(r.evidenceNeeds(f.a,f.job,f.task),[]);assert.ok(r.physicalContext(f.a,f.job,f.task).frontier.every(g=>g.queryBlockedReason==='root_project_conflict'));
});
test('mapping needs do not bypass current remote permission or task ownership',t=>{
 const f=setup(t);policy.revoke(f.a,f.grant,{trusted:true,actor:'user_command',command:'fixture'});assert.deepEqual(r.evidenceNeeds(f.a,f.job,f.task),[]);
 const other=setup(t);other.task.agentJobId='other';assert.deepEqual(r.evidenceNeeds(other.a,other.job,other.task),[]);
});
test('actual output failure and exact accepted output boundary remain gaps without reprobes',t=>{
 for(const accept of [false,true]){
  const f=setup(t),op={id:'failure',query:{op:'outputs',taskId:'123'},principal:f.job.platformPrincipal,permissionRevision:0,scope:'sg-readonly',status:'failed',errorCode:'AUTH_REQUIRED',error:'actual denial',completedAt:'2026-10-16T00:00:00Z'};
  if(accept)op.acceptedBoundary={authority:'user',policy:'document_and_continue',decisionId:'decision',coverage:'query'};
  f.job.executionState.operations.failure=op;
  const p=r.physicalContext(f.a,f.job,f.task);assert.equal(p.closureProven,false);assert.equal(p.satisfied,false);assert.deepEqual(r.evidenceNeeds(f.a,f.job,f.task),[]);
  assert.ok(p.frontier.every(g=>g.queryBlockedReason===(accept?'accepted_outputs_boundary':'observed_outputs_failure')));
 }
});
