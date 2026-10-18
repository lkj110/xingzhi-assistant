const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./root-relation-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),continuation=require('../desktop/evidence-continuation.cjs'),journal=require('../desktop/work-journal.cjs');
const output={type:'partition',storageRegion:'sg',databaseName:'db',tableName:'out',path:null,partitions:[{key:'day',value:'${date}'}]};
function setup(t,roots=['123']){
 const f=fixture(t,{roots,kinds:'物理表血缘'}),need=()=>f.need({requirements:[r.required(f.a,f.job,f.task)[0].id],gaps:['入口'+roots[0]+'物理表血缘缺失']});
 return {...f,need};
}
test('actual Dorado outputs envelope grants one original missing-mapping fact before closure',t=>{
 const f=setup(t);f.need();const s=f.source('outputs',{taskId:123,outputs:[output]},{taskId:123,projectId:7},{},false);
 let pending;const commit=continuation.commit;
 t.mock.method(continuation,'commit',(a,j,task,args,options)=>commit(a,j,task,args,{...options,apply:(draft,nextJob,next)=>{
  const result=options.apply(draft,nextJob,next);pending=r.recoveryFacts(draft,nextJob,next,{pendingResolution:next.lastEvidenceResolution});
  assert.equal(pending.length,1);assert.equal(pending[0].factType,'root_output_mapping');assert.equal(pending[0].rootId,'123');assert.equal(r.physicalContext(draft,nextJob,next).closureProven,false);return result;
 }}));
 f.resolve([s.id]);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),pending);assert.equal(f.check([s.id],{kind:'physical_lineage'}).result.passed,false);
 journal.replay(f.a,{force:true});assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),pending);
});
test('mapping semantic identity ignores equivalent task/outputs wrapper, ID, time and partitions',t=>{
 const f=setup(t);f.need();const s=f.source('outputs',{taskId:123,outputs:[output]});f.resolve([s.id]);const before=r.recoveryFacts(f.a,f.job,f.task);assert.equal(before.length,1);
 f.need();const clone=f.source('task',{id:123,type:'hsql',conf:{configuration:{operator:{parameter:{targets:[{...output,partitions:[{key:'day',value:'later'}]}]}}}},observedAt:'later'});
 f.resolve([s.id,clone.id]);assert.equal(f.task.lastEvidenceResolution.recoveryProof,undefined);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);
 f.job.executionState.permissionRevision++;assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),before);
});
test('ordinary association, unrelated root and an existing mapping do not mint mapping credit',t=>{
 const a=setup(t);a.need();const s=a.source('outputs',{taskId:123,outputs:[output]});a.plan([s.id]);assert.deepEqual(r.recoveryFacts(a.a,a.job,a.task),[]);
 const b=setup(t);b.need();const wrong=b.source('outputs',{taskId:999,outputs:[output]},{taskId:999});b.resolve([wrong.id]);assert.deepEqual(r.recoveryFacts(b.a,b.job,b.task),[]);
 const c=setup(t);const known=c.source('task',{id:123,outputs:[output]});c.need();const copy=c.source('outputs',{taskId:123,outputs:[output]});c.resolve([known.id,copy.id]);assert.deepEqual(r.recoveryFacts(c.a,c.job,c.task),[]);
});
test('partial, mismatched or conflicting mappings cannot be new typed mapping facts',t=>{
 for(const mode of ['partial','mismatch','conflict']){
  const f=setup(t);f.need();const s=f.source('outputs',{taskId:mode==='mismatch'?999:123,outputs:[output]},undefined,mode==='partial'?{truncated:true}:{});
  const ids=[s.id];if(mode==='conflict')ids.push(f.source('outputs',{taskId:123,outputs:[{...output,tableName:'different'}]}).id);
  f.resolve(ids);assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[],mode);
 }
});
test('explicit empty outputs is a real mapping observation, never physical closure',t=>{
 const f=setup(t);f.need();const s=f.source('outputs',{taskId:123,outputs:[]});f.resolve([s.id]);
 assert.equal(r.recoveryFacts(f.a,f.job,f.task).length,1);assert.equal(r.physicalContext(f.a,f.job,f.task).closureProven,false);assert.equal(f.check([s.id],{kind:'physical_lineage'}).result.passed,false);
});
test('real nullable Dorado output row cannot disappear behind a valid partition mapping',t=>{
 const f=setup(t);f.job.platformPrincipal='fixture-platform';
 const legacy=f.source('task',{id:123,type:'mysql->hive'},{taskId:123},{platformPrincipal:null});
 f.need();
 // Shape observed in retained metadata: one all-null output and one valid
 // partition. Preserve the unknown row; it is not an explicit empty outputs.
 const unknown={databaseName:null,partitions:null,path:null,storageRegion:null,tableName:null,type:null};
 const s=f.source('outputs',{taskId:123,outputs:[unknown,output]},undefined,{},false);
 f.resolve([s.id]);
 const p=r.physicalContext(f.a,f.job,f.task);
 assert.equal(p.closureProven,false);assert.equal(p.satisfied,false);
 assert.deepEqual(p.frontier.map(g=>({direction:g.direction,reason:g.reason})).sort((a,b)=>a.direction.localeCompare(b.direction)),[
  {direction:'input',reason:'root_output_mapping_incomplete'},
  {direction:'output',reason:'root_output_mapping_incomplete'}
 ]);
 assert.deepEqual(r.evidenceNeeds(f.a,f.job,f.task),[]);
 assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
 assert.equal(f.task.lastEvidenceResolution.recoveryProof,undefined);
 assert.equal(f.check([s.id],{kind:'physical_lineage'}).result.passed,false);
 assert.equal(legacy.platformPrincipal,null);
});
test('mapping facts lose authority when their current binding or content changes',t=>{
 const f=setup(t);f.need();const s=f.source('outputs',{taskId:123,outputs:[output]});f.resolve([s.id]);assert.equal(r.recoveryFacts(f.a,f.job,f.task).length,1);
 s.content+=' ';assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});
