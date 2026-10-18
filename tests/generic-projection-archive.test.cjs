'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{gzipSync}=require('node:zlib');
const {fixture}=require('./root-relation-fixture.cjs'),f=require('./root-relation-physical-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),cache=require('../desktop/projection-cache.cjs'),links=require('../desktop/evidence-links.cjs');
const result=require('../desktop/platform-result.cjs'),platform=require('../desktop/data-platform.cjs'),basis=require('../desktop/evidence-basis.cjs');
function archived(t,version=2){
 const v=fixture(t,{kinds:'物理表血缘'});v.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123});
 const data=f.data();data.guidEntityMap.out.attributes.fullText='a'.repeat(600000);
 const snapshot={operation:'table_lineage',region:'sg',query:{op:'table_lineage',database:'db',table:'out'},data};
 let encoded;
 if(version===2)encoded=result.prepare(snapshot,{principal:v.job.platformPrincipal??null,projectId:v.job.projectId??null});
 else {
  const raw=Buffer.from(JSON.stringify(basis.canonical(data))),projection=result.projectData(data);
  const manifest={version:1,format:'coral-structural-v1',codec:'gzip-base64',dataView:'structural_projection',rawBytes:raw.length,rawSha256:result.digest(raw),projectionSha256:result.digest(JSON.stringify(basis.canonical(projection))),originalDataRetained:true};
  encoded={...snapshot,data:projection,platformResult:manifest,platformArchive:{...manifest,body:gzipSync(raw).toString('base64')}};
 }
 const split=result.split(encoded);
 const center=require('../desktop/agent.cjs').source(v.a,v.job,'archive-controlled','table_lineage',JSON.stringify(split.snapshot),{platformSnapshot:true,platformPrincipal:v.job.platformPrincipal??null,platformArchive:split.sourceMeta.platformArchive});
 links.setInputs(v.a,v.task,[...v.task.sourceIds,center.id]);
 return {...v,center,snapshot};
}
for(const version of [1,2])test('v'+version+' both relation read paths restore full data once and keep source immutable',t=>{
 const v=archived(t,version),restore=platform.restorePlatformData,seen=[];
 t.mock.method(platform,'restorePlatformData',(raw,s)=>{seen.push(s.id);return restore(raw,s);});
 const before=JSON.stringify(v.a.data);
 cache.scope(()=>{r.required(v.a,v.job,v.task);const projected=r.physicalContext(v.a,v.job,v.task);assert.equal(projected.closureProven,true,JSON.stringify(projected.frontier));});
 assert.deepEqual(seen,[v.center.id]);assert.equal(JSON.stringify(v.a.data),before);
});
for(const mode of ['missing','corrupt','orphan','envelope','json'])test('archive '+mode+' throws integrity, never missing_center or a new query',t=>{
 const v=archived(t),obligation=r.required(v.a,v.job,v.task)[0];
 if(mode==='json')v.center.content='invalid archived JSON';
 if(mode==='missing')delete v.center.platformArchive;
 if(mode==='corrupt')v.center.platformArchive.chunks[0].body='AAAA'+v.center.platformArchive.chunks[0].body.slice(4);
 if(mode==='orphan'){const raw=JSON.parse(v.center.content);delete raw.platformResult;v.center.content=JSON.stringify(raw);}
 if(mode==='envelope'){const raw=JSON.parse(v.center.content);raw.query.table='changed';v.center.content=JSON.stringify(raw);}
 v.task.contextBindings=v.task.contextBindings.filter(b=>b.sourceId!==v.center.id);links.setInputs(v.a,v.task,v.task.sourceIds);
 for(const read of [()=>r.required(v.a,v.job,v.task),()=>r.physicalContext(v.a,v.job,v.task),()=>r.evidenceNeeds(v.a,v.job,v.task),()=>r.physicalContext(v.a,v.job,v.task,{obligation})])assert.throws(read,{code:'LOCAL_RESULT_INTEGRITY'});
});
test('inline sources never enter the archive decoder',t=>{
 const v=fixture(t,{kinds:'物理表血缘'});v.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123});v.source('table_lineage',f.data(),{database:'db',table:'out'});
 const spy=t.mock.method(platform,'restorePlatformData',()=>{throw Error('unexpected restore');});assert.equal(r.physicalContext(v.a,v.job,v.task).closureProven,true);assert.equal(spy.mock.callCount(),0);
});
test('archived Dorado scope graphs and output configurations expand before typed target selection',t=>{
 const v=fixture(t,{kinds:'SQL读写、产出配置'});
 const snapshots=[{operation:'downstream',region:'sg',query:{op:'downstream',taskId:123},data:{root:{id:123},nodes:[{id:456,parentRelation:[123]}],padding:'x'.repeat(600000)}},
  {operation:'outputs',region:'sg',query:{op:'outputs',taskId:123},data:{outputs:[{database:'db',table:'out'}],padding:'x'.repeat(600000)}}];
 for(const [i,snapshot] of snapshots.entries()){
  const split=result.split(result.prepare(snapshot,{principal:v.job.platformPrincipal??null,projectId:v.job.projectId??null}));
  const source=require('../desktop/agent.cjs').source(v.a,v.job,'scope-archive-'+i,snapshot.operation,JSON.stringify(split.snapshot),{platformSnapshot:true,platformPrincipal:v.job.platformPrincipal??null,...split.sourceMeta});
  links.setInputs(v.a,v.task,[...v.task.sourceIds,source.id]);
 }
 const required=r.required(v.a,v.job,v.task);assert.ok(required.find(o=>o.kind==='sql_read_write').entities.some(e=>e.nodeId==='456'&&e.scopeProven));
 v.source('sql',{sql:'SELECT 1'},{taskId:123});v.source('sql',{sql:'SELECT 2'},{taskId:456});v.source('outputs',{outputs:[]},{taskId:456});
 assert.equal(r.coverageReady(v.a,v.job,v.task),true);
});
test('scheduling adapters preserve all typed targets and project conflicts from full inline physical sources',t=>{
 const v=fixture(t,{kinds:'SQL读写、产出配置、物理表血缘、风神'});
 v.source('downstream',{root:{id:123},nodes:[{id:456,parentRelation:[123],projectId:7}]},{taskId:123,projectId:7});
 v.source('task',{id:456,projectId:7,type:'hive2ch'},{taskId:456,projectId:7});
 v.source('table_lineage',f.data(),{database:'db',table:'out',taskId:456,projectId:8});
 const scope=require('../desktop/lineage-scope.cjs').resolve(v.job),req=require('../desktop/relation-requirements.cjs');
 const sources=r.sourceRows(v.a,v.job,v.task,v.task.sourceIds),descriptors=req.inspect(v.job,v.task,scope);
 for(const o of r.required(v.a,v.job,v.task).filter(o=>o.kind!=='physical_lineage')){
  const expected=req.targets(descriptors.find(d=>d.kind===o.kind),scope,sources);
  assert.deepEqual(o.entities.map(({id,...e})=>e),expected.entities);
  assert.deepEqual(o.unresolvedRootIds,expected.unresolvedRootIds);
 }
});
