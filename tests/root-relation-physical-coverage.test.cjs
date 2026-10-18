const {test}=require('node:test'),assert=require('node:assert/strict');
const {project}=require('../desktop/physical-lineage-coverage.cjs'),f=require('./root-relation-physical-fixture.cjs');
const run=(snapshots,extra={})=>project({roots:[f.root()],snapshots,...extra});
test('missing own center yields exact existing Hive query; no synthetic API fields',()=>{
 const p=run([]);assert.equal(p.closureProven,false);assert.equal(p.directObserved,false);
 assert.deepEqual(p.queries,[{op:'table_lineage',database:'db',table:'out'}]);assert.ok(p.frontier.every(g=>g.reason==='missing_own_center'));
});
test('leaf incidental empty processes do not close a missing own center',()=>{
 const p=run([f.snapshot('out',['leaf'])]);assert.equal(p.directObserved,true);assert.equal(p.closureProven,false);
 assert.equal(p.frontier.length,1);assert.equal(p.frontier[0].direction,'input');assert.equal(p.frontier[0].identity.table,'leaf');
 assert.equal(p.observations.length,2);assert.deepEqual(p.proofSourceIds,['mapping-123','source-out']);
});
test('real own centered zero closes; process inputs/outputs alone never prove a terminal',()=>{
 const p=run([f.snapshot('out',['leaf']),f.snapshot('leaf')]);assert.equal(p.closureProven,true);assert.equal(p.satisfied,true);assert.equal(p.frontier.length,0);
 assert.equal(p.observations.find(o=>o.identity.table==='out'&&o.direction==='input').adjacency.processes[0].taskId,'123');
});
for(const change of [d=>delete d.guidEntityMap.out.attributes.outputFromProcesses,d=>delete d.inputEntityCount,d=>delete d.inputEntityGuids,d=>d.inputEntityCount='0',d=>d.inputEntityCount=1,d=>d.guidEntityMap.out.attributes.outputFromProcesses=[f.process()],d=>d.inputEntityGuids=[['absent']],d=>d.inputEntityDepth=2])test('missing or contradictory fields never become zero: '+change.toString(),()=>{
 const s=f.snapshot();change(s.data);const p=run([s]);assert.equal(p.closureProven,false);assert.equal(p.queries.length,0);
});
test('truncated / paginated real centers cannot be repaired by invented positive flags',()=>{
 for(const delta of [{truncated:true},{hasMore:true},{pagination:{hasMore:true}},{nextPage:2},{error:'failed'}]){
  const s=f.snapshot();Object.assign(s.data,{complete:true,noMore:true,...delta});assert.equal(run([s]).closureProven,false);
 }
});
test('directions follow their own first layer and their actual process attribute',()=>{
 const p=run([f.snapshot('out',['up'],['down']),f.snapshot('up',[],['unrelated']),f.snapshot('down',['also_unrelated'],[])]);
 assert.equal(p.closureProven,true);assert.equal(p.observations.length,4);
 assert.equal(p.observations.find(o=>o.identity.table==='out'&&o.direction==='output').adjacency.processes[0].taskId,'456');
});
test('visited never exempts an unexpanded cycle outlet; fully expanded cycle closes',()=>{
 const a=f.snapshot('out',['b']),b=f.snapshot('b',['out','exit']);
 const p=run([a,b]);assert.equal(p.closureProven,false);assert.equal(p.frontier[0].identity.table,'exit');
 assert.equal(run([a,b,f.snapshot('exit')]).closureProven,true);
 assert.equal(run([a,f.snapshot('b',['out'])]).closureProven,true);
});
test('every output table and every root must be covered',()=>{
 const roots=[f.root(),f.root('other','456')];assert.equal(run([f.snapshot()],{roots}).closureProven,false);
 assert.equal(run([f.snapshot(),f.snapshot('other')],{roots}).closureProven,true);
});
test('unsupported and cross-region neighbors retain identity and never get coerced Hive queries',()=>{
 for(const type of ['DummyTable','DummyOutput','ClickhouseTable','HdfsFile']){
  const s=f.snapshot('out',['other']);s.data.guidEntityMap.other.typeName=type;
  const p=run([s]);assert.equal(p.closureProven,false);assert.equal(p.frontier[0].status,'unsupported');assert.equal(p.queries.length,0);assert.equal(p.frontier[0].attempt,undefined);
 }
 const s=f.snapshot('out',['other']);Object.assign(s.data.guidEntityMap.other.attributes,{cid:1,qualifiedName:'HiveTable:///db/other@1'});
 const p=run([s]);assert.equal(p.frontier[0].reason,'entity_region_outside_sg');assert.equal(p.queries.length,0);
});
test('center and neighbor query/type/address/CID conflicts fail closed',()=>{
 for(const mutate of [s=>s.data.guidEntityMap.out.attributes.name='wrong',s=>delete s.data.guidEntityMap.out.attributes.cid,s=>s.data.guidEntityMap.out.attributes.qualifiedName='HiveTable:///wrong/out@6',s=>s.data.guidEntityMap.out.typeName='DummyTable',s=>s.data.guidEntityMap.out.guid='wrong',s=>s.region='us']){
  const s=f.snapshot();mutate(s);assert.equal(run([s]).closureProven,false);
 }
 const s=f.snapshot('out',['other']);delete s.data.guidEntityMap.other.attributes.qualifiedName;
 const p=run([s]);assert.equal(p.frontier[0].status,'unresolved');assert.equal(p.queries.length,0);
});
test('current conflicting centers cannot be selected by timestamp or model claim',()=>{
 assert.equal(run([f.snapshot(),f.snapshot('out',['new'],[],'different')]).closureProven,false);
 assert.equal(run([f.snapshot(),f.snapshot('out',[],[],'clone')]).closureProven,true);
});
test('center GUID must agree with the parent neighbor even if its address matches',()=>{
 const root=f.snapshot('out',['leaf']),leaf=f.snapshot('leaf');
 leaf.data.guidEntityMap.changed={...leaf.data.guidEntityMap.leaf,guid:'changed'};delete leaf.data.guidEntityMap.leaf;leaf.data.baseEntityGuid='changed';
 const p=run([root,leaf]);assert.equal(p.closureProven,false);assert.equal(p.frontier[0].reason,'neighbor_center_identity_conflict');assert.equal(p.queries.length,0);
});
test('adjacency ordering is not a conflicting or new semantic observation',()=>{
 const one=f.snapshot('out',['a','b']),two=f.snapshot('out',['b','a'],[],'copy');
 assert.equal(run([one,two,f.snapshot('a'),f.snapshot('b')]).closureProven,true);
});
test('exact accepted boundary satisfies but does not prove physical closure',()=>{
 const b={query:{op:'table_lineage',database:'db',table:'leaf'},operationId:'actual-attempt',errorCode:'AUTH_REQUIRED',decision:{decisionId:'user-decision'},direction:'input'};
 const p=run([f.snapshot('out',['leaf'])],{acceptedBoundaries:[b]});assert.equal(p.satisfied,true);assert.equal(p.closureProven,false);assert.equal(p.status,'accepted_boundary');assert.equal(p.queries.length,0);
 assert.equal(p.frontier[0].boundary.operationId,'actual-attempt');
 for(const change of [{query:{op:'downstream',taskId:123}},{direction:'output'},{query:{...b.query,table:'other'}},{query:{...b.query,region:'us'}}])assert.equal(run([f.snapshot('out',['leaf'])],{acceptedBoundaries:[{...b,...change}]}).satisfied,false);
});
test('real failed attempt remains diagnostic; unsupported never invents an attempt',()=>{
 const failure={query:{op:'table_lineage',database:'db',table:'leaf'},operationId:'attempt',errorCode:'AUTH_REQUIRED',reason:'denied'};
 const p=run([f.snapshot('out',['leaf'])],{failures:[failure]});assert.equal(p.satisfied,false);assert.equal(p.frontier[0].attempt.operationId,'attempt');assert.equal(p.frontier[0].status,'failed');assert.equal(p.queries.length,0);
});
for(const bucket of ['acceptedBoundaries','failures']){
 test(bucket+' matches the exact candidate including canonical defaults',()=>{
  const candidate={op:'table_lineage',database:'db',table:'leaf'};
  for(const query of [candidate,{...candidate,region:'sg',entityType:'HiveTable'}]){
   const record={query,operationId:'exact-attempt',errorCode:'AUTH_REQUIRED',decision:{decisionId:'exact-decision'}};
   const p=run([f.snapshot('out',['leaf'])],{[bucket]:[record]}),gap=p.frontier[0];
   assert.equal(p.frontier.length,1);assert.equal(p.closureProven,false);
   assert.equal(p.satisfied,bucket==='acceptedBoundaries');assert.deepEqual(p.queries,[]);
   assert.equal(gap.direction,'input');assert.equal(gap.status,bucket==='acceptedBoundaries'?'accepted_boundary':'failed');
   assert.equal((gap.boundary||gap.attempt).operationId,'exact-attempt');
  }
 });
 test(bucket+' cannot erase project or query parameters for the same table',()=>{
  const candidate={op:'table_lineage',database:'db',table:'leaf'};
  for(const delta of [{projectId:'7'},{taskId:'123'},{direction:'BOTH'},{depth:1},{page:1},{pageSize:100}]){
   const record={query:{...candidate,...delta},operationId:'other-scope',errorCode:'AUTH_REQUIRED',decision:{decisionId:'other-decision'}};
   const p=run([f.snapshot('out',['leaf'])],{[bucket]:[record]}),gap=p.frontier[0],label=JSON.stringify(delta);
   assert.equal(p.status,'unclosed',label);assert.equal(p.satisfied,false,label);assert.equal(p.closureProven,false,label);
   assert.equal(p.frontier.length,1,label);assert.equal(gap.status,'unexpanded',label);assert.equal(gap.reason,'missing_own_center',label);
   assert.equal(gap.boundary,undefined,label);assert.equal(gap.attempt,undefined,label);
   assert.deepEqual(gap.query,candidate,label);assert.deepEqual(p.queries,[candidate],label);
  }
 });
}
test('projection is deterministic and does not mutate frozen input',()=>{
 const input={roots:[f.root()],snapshots:[f.snapshot('out',['leaf'])]};const before=JSON.stringify(input);
 const freeze=v=>{if(v&&typeof v==='object'){Object.freeze(v);Object.values(v).forEach(freeze);}};freeze(input);
 assert.deepEqual(project(input),project(input));assert.equal(JSON.stringify(input),before);
});
