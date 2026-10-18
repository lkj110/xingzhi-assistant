'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const deny=()=>{throw Error('final-platform-shared: real external I/O forbidden');};
require('node:child_process').spawn=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),platform=require('../desktop/data-platform.cjs');
const context=require('../desktop/task-context.cjs'),policy=require('../desktop/access-policy-store.cjs'),ledger=require('../desktop/operation-ledger.cjs');
const {hash,canonical}=require('../desktop/evidence-basis.cjs'),storage=require('../desktop/platform-result.cjs'),f=require('./root-relation-physical-fixture.cjs');
const q={op:'table_lineage',database:'db',table:'out'},authorization={trusted:true,actor:'user_command',command:'final_platform_shared_fixture'};
function payload(){
 const d=f.data('out',['up'],['tail']),a=d.guidEntityMap.out.attributes;
 a.ddl='CREATE TABLE raw_only_sql_marker (id BIGINT)';a.useCases='raw_only_start_marker '+'metadata-'.repeat(100000)+' raw_only_tail_marker';
 a.password='PRIVATE_PASSWORD_MUST_NEVER_SURVIVE';a.parameters='Bearer PRIVATE_BEARER_MUST_NEVER_SURVIVE';return d;
}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'final-platform-shared-')),instances=[];
 const create=()=>{const a=new Assistant({dir,chat:deny,agentRequest:deny,connectorRequest:deny,webRequest:deny,feedRequest:deny});instances.push(a);require('./helpers/platform-fixture.cjs').install(a,{username:'alice'});return a;};
 t.after(()=>{for(const a of instances){require('../desktop/deadline-scheduler.cjs').dispose(a);a.streamController?.dispose();}fs.rmSync(dir,{recursive:true,force:true});});
 const a=create();await a.dispatch('saveProvider',{name:'offline fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 const job=agent.buildJob(a,{goal:'Shared path physical lineage fixture',dataPlatform:'sg-readonly'});a.data.delegations.push(job);job.platformPrincipal='alice';policy.syncTrustedJob(a,job,authorization);
 const state={a,job,dir,calls:0,data:payload()};a.platformRequest=async()=>{state.calls++;return structuredClone(state.data);};
 state.query=()=>agent.act(state.a,state.job,'platform_query',{queries:[q]}).then(r=>r.results[0]);
 state.scope=()=>({kind:'job',jobId:state.job.id});
 state.read=(sourceId,extra={})=>context.resolveRead(state.a,state.scope(),{tool:'read_source',sourceId,...extra});
 state.acquire=async()=>{const r=await state.query();assert.ok(r.sourceId,JSON.stringify(r));return {result:r,source:state.a.data.sources.find(s=>s.id===r.sourceId)};};
 state.restart=()=>{state.a.save();state.a=create();state.job=state.a.data.delegations.find(j=>j.id===job.id);state.a.platformRequest=async()=>{state.calls++;return structuredClone(state.data);};};
 return state;
}
function noEncoded(value,archive){
 const text=JSON.stringify(value),bodies=archive.chunks?archive.chunks.map(c=>c.body):[archive.body];
 assert.ok(bodies.length&&bodies.every(body=>typeof body==='string'&&body.length>80),'fixture must contain archive encoding');
 for(const body of bodies){assert.ok(!text.includes(body),'encoded body escaped');assert.ok(!text.includes(body.slice(0,80))&&!text.includes(body.slice(-80)),'encoded preview escaped');}
 assert.doesNotMatch(text,/PRIVATE_PASSWORD_MUST_NEVER_SURVIVE|PRIVATE_BEARER_MUST_NEVER_SURVIVE/);
 const visit=v=>{if(!v||typeof v!=='object')return;assert.equal(Object.hasOwn(v,'platformArchive'),false);for(const x of Object.values(v))visit(x);};visit(value);
}
const text=result=>(result.segments||[]).map(s=>s.text).join('');
// Independent historical fixture: never derive v1 from the production writer.
function prepareV1(snapshot){
 const raw=Buffer.from(JSON.stringify(canonical(snapshot.data))),data=storage.projectData(snapshot.data);
 const platformResult={version:1,format:'coral-structural-v1',codec:'gzip-base64',rawBytes:raw.length,rawSha256:storage.digest(raw),projectionSha256:storage.digest(JSON.stringify(canonical(data))),dataView:'structural_projection',originalDataRetained:true};
 return {...snapshot,data,platformResult,platformArchive:{...platformResult,body:require('node:zlib').gzipSync(raw,{level:9}).toString('base64')}};
}
function assertV2(source,original){
 const snapshot=JSON.parse(source.content),manifest=snapshot.platformResult,archive=source.platformArchive;
 assert.equal(manifest.version,2);assert.equal(manifest.format,'platform-chunks-v2');assert.equal(manifest.codec,'gzip-base64-chunks');assert.equal(manifest.dataView,'manifest_only');
 assert.equal(snapshot.platformArchive,undefined);assert.equal(snapshot.data.dataView,'manifest_only');assert.equal(snapshot.data.incomplete,true);assert.equal(snapshot.data.guidEntityMap,undefined);
 assert.equal(archive.body,undefined);assert.ok(archive.chunks.length>0);assert.equal(archive.chunks.length,manifest.chunkCount);assert.equal(manifest.descriptors.length,manifest.chunkCount);
 assert.equal(archive.manifestHash,storage.digest(JSON.stringify(canonical(manifest))));
 for(const [i,chunk] of archive.chunks.entries()){
  assert.equal(chunk.index,i);assert.ok(chunk.body.length<=storage.limits.chunkChars);
  assert.deepEqual(manifest.descriptors[i],{index:i,encodedChars:chunk.body.length,sha256:storage.digest(chunk.body)});
 }
 assert.equal(archive.chunks.reduce((size,c)=>size+c.body.length,0),manifest.encodedChars);
 assert.equal(hash(platform.restorePlatformData(snapshot,source)),hash(original),'restore must retain every redacted field and relation');
 return snapshot;
}
function assertIntegrityRead(result,archive){
 assert.equal(result.ok,false);assert.equal(result.code,'LOCAL_RESULT_INTEGRITY');assert.equal(result.recovery,'diagnose_local_result');
 assert.equal(result.retryCondition,'local_archive_integrity_repaired');assert.equal(result.segments,undefined);assert.equal(result.content,undefined);noEncoded(result,archive);
}
const expire=s=>{for(const o of Object.values(s.job.executionState.operations))o.completedAt='2000-01-01T00:00:00Z';};

test('real agent branch splits metadata, caches via sourceMeta and reuses persisted archives after restart',async t=>{
 const s=await fixture(t),{result,source}=await s.acquire(),archive=source.platformArchive;
 assertV2(source,platform.redact(s.data));
 noEncoded(result,archive);assert.doesNotMatch(JSON.stringify(result),/raw_only_sql_marker|raw_only_tail_marker/);
 const operation=Object.values(s.job.executionState.operations).find(o=>o.sourceId===source.id);assert.equal(operation.status,'done');
 assert.equal(archive.binding.operationId,operation.id);assert.equal(archive.binding.principal,'alice');assert.equal(archive.binding.scope,s.job.dataPlatform);assert.equal(archive.binding.permissionRevision,s.job.executionState.permissionRevision);
 const cached=await s.query();assert.equal(cached.sourceId,source.id);assert.equal(cached.reused,true);assert.equal(s.calls,1);noEncoded(cached,archive);
 s.restart();const again=await s.query();assert.equal(again.sourceId,source.id);assert.equal(again.reused,true);assert.equal(s.calls,1);noEncoded(again,archive);
 assert.equal(s.a.data.sources.length,1);assert.equal(hash(s.a.data.sources[0].platformArchive),hash(archive));assertV2(s.a.data.sources[0],platform.redact(s.data));
 const opState=require('../desktop/context-operation-state.cjs').state(s.a);assert.equal(hash(opState.sources[0].platformArchive),hash(archive));
});

test('shared read_source transparently pages ALL original redacted data and never returns archive encoding',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),archive=source.platformArchive;
 const catalog=context.buildContext(s.a,s.scope()).readableCatalog.find(r=>r.id===source.id);
 assert.equal(catalog.characters,source.content.length);assert.equal(catalog.readView.charactersDescribe,'stored_directory');assert.equal(catalog.readView.stored,'manifest_only');
 assert.equal(catalog.readView.read,'original_redacted_platform_data');noEncoded(catalog,archive);
 const pieces=[];let start=0,pages=0,first;
 do{
  const r=await agent.act(s.a,s.job,'read_source',{sourceId:source.id,start,limit:10});assert.equal(r.ok,true,JSON.stringify(r));first ||= r;
  noEncoded(r,archive);assert.ok(r.segments.length<=10);pieces.push(text(r));start=r.next;pages++;assert.ok(pages<1000);
 }while(start!==null);
 assert.ok(pages>10);assert.equal(first.coverage.complete,false);const original=JSON.parse(pieces.join(''));
 assert.equal(hash(original.data),hash(platform.redact(s.data)));assert.equal(original.platformResult,undefined);assert.equal(original.platformArchive,undefined);
 assert.ok(original.data.guidEntityMap.out.attributes.useCases.endsWith('raw_only_tail_marker'));
 assert.equal(original.data.guidEntityMap.out.attributes.password,undefined);assert.doesNotMatch(JSON.stringify(original),/PRIVATE_/);
 assertV2(source,platform.redact(s.data));
});

test('shared read_platform pages every archived entity and relation behind the v2 manifest',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),rows=[];let start=0;
 do{
  const r=await agent.act(s.a,s.job,'read_platform',{sourceId:source.id,start,limit:1});
  assert.equal(r.storageComplete,true);assert.equal(r.rowsInSnapshot,Object.keys(s.data.guidEntityMap).length);assert.equal(r.rows.length,1);
  assert.deepEqual(r.inputEntityGuids,s.data.inputEntityGuids);assert.deepEqual(r.outputEntityGuids,s.data.outputEntityGuids);
  noEncoded(r,source.platformArchive);rows.push(...r.rows);start=r.next;assert.ok(rows.length<=r.rowsInSnapshot);
 }while(start!==null);
 assert.deepEqual(rows.map(r=>r.guid),Object.keys(s.data.guidEntityMap).sort());
 assert.deepEqual(rows.find(r=>r.guid==='out').attributes.outputFromProcesses,s.data.guidEntityMap.out.attributes.outputFromProcesses);
 assert.equal(s.calls,1);assertV2(source,platform.redact(s.data));
});

test('independent v1 projection/body fixture remains fully readable after restart without a v2 rewrite',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),full=platform.fullSnapshot(source),historical=prepareV1(full);
 const {platformArchive,...snapshot}=historical;source.content=JSON.stringify(snapshot,null,2);source.platformArchive=platformArchive;source.hash=hash(source.content);
 assert.equal(snapshot.platformResult.version,1);assert.equal(snapshot.platformResult.format,'coral-structural-v1');assert.equal(snapshot.data.guidEntityMap.out.attributes.ddl,undefined);
 assert.deepEqual(snapshot.data.inputEntityGuids,full.data.inputEntityGuids);assert.deepEqual(Object.keys(snapshot.data.guidEntityMap),Object.keys(full.data.guidEntityMap));
 assert.equal(hash(platform.restorePlatformData(snapshot,source)),hash(full.data));
 s.restart();const saved=s.a.data.sources.find(row=>row.id===source.id),pieces=[];let start=0;
 do{const r=s.read(source.id,{start,limit:10});assert.equal(r.ok,true);noEncoded(r,platformArchive);pieces.push(text(r));start=r.next;}while(start!==null);
 assert.equal(hash(JSON.parse(pieces.join(''))),hash(full));assert.equal(saved.content,source.content);assert.equal(hash(saved.platformArchive),hash(platformArchive));assert.equal(s.calls,1);
 saved.platformArchive.body='AAAA';assertIntegrityRead(s.read(source.id),platformArchive);
});

test('shared search and read_segment see archived tail and ignore stale serialized source segments',async t=>{
 const s=await fixture(t),{source}=await s.acquire();source.segments=[{id:'stale',text:'STALE_ENCODED_SEGMENT '+source.platformArchive.chunks.map(c=>c.body).join('')}];
 const r=await agent.act(s.a,s.job,'search_source',{sourceId:source.id,query:'raw_only_tail_marker',limit:2});
 assert.equal(r.ok,true);assert.match(text(r),/raw_only_tail_marker/);assert.doesNotMatch(text(r),/STALE_ENCODED/);noEncoded(r,source.platformArchive);
 const segment=context.resolveRead(s.a,s.scope(),{tool:'read_segment',sourceId:source.id,index:r.segments[0].index});
 assert.equal(segment.ok,true);assert.match(segment.content,/raw_only_tail_marker/);noEncoded(segment,source.platformArchive);
});

test('all public/full/summary/detail/export/history projections exclude archive while canonical storage remains intact',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),archive=source.platformArchive;
 s.a.data.agentRuns.push({id:'shared-history',jobId:s.job.id,status:'done',steps:[{tool:'platform_query',args:{queries:[q]},result:{sourceId:source.id,platformArchive:archive,platformResult:{archive:archive.chunks.map(c=>c.body).join('')}}}]});
 const original=JSON.stringify(s.a.data);
 for(const value of [s.a.publicState(),s.a.publicState({full:true}),require('../desktop/workspace-view.cjs').projection(s.a.data),await s.a.dispatch('stateView'),await s.a.dispatch('viewDetail',{kind:'source',id:source.id}),await s.a.dispatch('viewDetail',{kind:'agentRun',id:'shared-history'}),await s.a.dispatch('viewDetail',{kind:'agentStep',id:'shared-history',stepIndex:0}),await s.a.dispatch('export')])noEncoded(value,archive);
 assert.equal(JSON.stringify(s.a.data),original);assert.equal(hash(source.platformArchive),hash(archive));
 const detail=await s.a.dispatch('viewDetail',{kind:'source',id:source.id});assert.equal(detail.platformArchiveOmitted,true);
 const legacy={nested:[{platformArchive:archive}]};require('../desktop/public-context.cjs').sanitize({requireContextAccessPolicy:false},legacy);noEncoded(legacy,archive);
});

test('authorized readSource dispatch restores archived tail without exposing or mutating canonical archive storage',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),original=hash(source),archive=source.platformArchive;
 const result=await s.a.dispatch('readSource',{id:source.id,query:'raw_only_tail_marker',limit:2});
 assert.equal(result.sourceId,source.id);assert.ok(result.totalSegments>10);assert.match(text(result),/raw_only_tail_marker/);noEncoded(result,archive);assert.equal(hash(source),original);
 policy.revoke(s.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+source.id},operations:['local_retention','local_read']},authorization);
 await assert.rejects(s.a.dispatch('readSource',{id:source.id,query:'raw_only_tail_marker'}));assert.equal(s.calls,1);
});

test('actual planner and task context plus model-input navigation carry no encoded archive before any raw read',async t=>{
 const s=await fixture(t),{source}=await s.acquire();
 const task=s.a.createTask({title:'Shared model input fixture',criteria:'Explain fixture physical lineage'});task.agentJobId=s.job.id;s.job.taskIds.push(task.id);task.sourceIds=[source.id];
 require('../desktop/evidence-links.cjs').setInputs(s.a,task,task.sourceIds);
 const planner=agent.context(s.a,s.job),writer=s.a.context(task),verifier=s.a.context(task,{verification:true});
 for(const ctx of [planner,writer,verifier]){
  noEncoded(ctx,source.platformArchive);assert.doesNotMatch(JSON.stringify(ctx),/raw_only_sql_marker|raw_only_tail_marker/);
  const prepared=require('../desktop/model-input.cjs').prepare(ctx);noEncoded(prepared,source.platformArchive);
 }
});

test('foreign jobs, missing membership, withdrawn sources and actual ACL denial never invoke raw restoration',async t=>{
 const s=await fixture(t),{source}=await s.acquire();let restores=0;const original=platform.restorePlatformData;
 platform.restorePlatformData=(...args)=>{restores++;return original(...args);};t.after(()=>platform.restorePlatformData=original);
 const foreign=agent.buildJob(s.a,{goal:'foreign',dataPlatform:'sg-readonly'});s.a.data.delegations.push(foreign);
 assert.equal(context.resolveRead(s.a,{kind:'job',jobId:foreign.id},{tool:'read_source',sourceId:source.id}).ok,false);
 const ids=s.job.sourceIds;s.job.sourceIds=[];assert.equal(s.read(source.id).ok,false);s.job.sourceIds=ids;
 source.deleted=true;assert.equal(s.read(source.id).ok,false);delete source.deleted;
 source.projectExcluded=true;assert.equal(s.read(source.id).ok,false);delete source.projectExcluded;
 policy.revoke(s.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+source.id},operations:['local_retention','local_read']},authorization);
 const denied=s.read(source.id);assert.equal(denied.ok,false);assert.equal(denied.segments,undefined);assert.equal(restores,0);noEncoded(denied,source.platformArchive);
 await assert.rejects(s.a.dispatch('viewDetail',{kind:'source',id:source.id}));noEncoded(s.a.publicState(),source.platformArchive);
 s.restart();assert.equal(s.read(source.id).ok,false);assert.equal(restores,0);
});

test('archive identity participates in modern and legacy read validity and is cloned into immutable operation snapshots',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),request={tool:'read_source',sourceId:source.id,limit:1},result=s.read(source.id,{limit:1});assert.equal(result.ok,true);
 const row={request,result},legacy={request,result:{},sourceHash:context.withContext(s.a,s.scope(),op=>op.sourceHash(source.id))};
 assert.equal(context.validRead(s.a,s.scope(),row),true);assert.equal(context.validRead(s.a,s.scope(),legacy),true);
 context.withContext(s.a,s.scope(),op=>{const captured=op.source(source.id);assert.equal(hash(captured.platformArchive),hash(source.platformArchive));assert.ok(Object.isFrozen(captured.platformArchive));assert.ok(Object.isFrozen(captured.platformArchive.chunks[0]));assert.notStrictEqual(captured.platformArchive,source.platformArchive);assert.notStrictEqual(captured.platformArchive.chunks,source.platformArchive.chunks);});
 const archive=source.platformArchive;source.platformArchive=structuredClone(archive);source.platformArchive.chunks[0].body=archive.chunks[0].body.slice(0,-4);
 assert.equal(context.validRead(s.a,s.scope(),row),false);assert.equal(context.validRead(s.a,s.scope(),legacy),false);
 const stale=s.read(source.id,{version:result.version});assert.equal(stale.ok,false);assert.equal(stale.code,'CONTEXT_VERSION_CHANGED');
 assertIntegrityRead(s.read(source.id),archive);
});

test('missing/corrupt/mismatched v2 archive reads diagnose local integrity, never fall back to the manifest directory',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),saved=structuredClone(source);
 for(const change of [v=>delete v.platformArchive,v=>v.platformArchive.chunks[0].body='AAAA',v=>v.platformArchive.chunks.pop(),v=>v.platformArchive.manifestHash='0'.repeat(64),v=>v.platformArchive.binding.operationId='unrelated-operation',v=>{const x=JSON.parse(v.content);x.platformResult.rawSha256='0'.repeat(64);v.content=JSON.stringify(x);},v=>{const x=JSON.parse(v.content);x.data.inputEntityCount=999;v.content=JSON.stringify(x);},v=>{const x=JSON.parse(v.content);x.query.table='other';v.content=JSON.stringify(x);},v=>{const x=JSON.parse(v.content);delete x.platformResult;v.content=JSON.stringify(x);}]){
  Object.assign(source,structuredClone(saved));change(source);assertIntegrityRead(s.read(source.id),saved.platformArchive);
  await assert.rejects(agent.act(s.a,s.job,'read_platform',{sourceId:source.id}),e=>e.code==='LOCAL_RESULT_INTEGRITY');assert.equal(s.calls,1);
 }
});

test('archive mutation inside permission callbacks is caught by the shared operation fence',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),original=s.a.contextAccessCheck;let checks=0;
 s.a.contextAccessCheck=args=>{const result=original(args);if(++checks===2)source.platformArchive.chunks[0].body='AAAA';return result;};
 const r=s.read(source.id);assert.equal(r.ok,false);assert.equal(r.code,'CONTEXT_VERSION_CHANGED');assert.equal(r.segments,undefined);
});

test('corrupt cache stops the batch without redispatch or replacing its original successful receipt, including after restart',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),done=structuredClone(Object.values(s.job.executionState.operations).find(o=>o.sourceId===source.id)),history=hash(s.job.executionState.history||[]);
 source.platformArchive.chunks[0].body='AAAA';const damaged=hash(source);
 for(let i=0;i<3;i++){
  if(i===2)s.restart();
  await assert.rejects(agent.act(s.a,s.job,'platform_query',{queries:[q,{op:'table_lineage',database:'db',table:'never_dispatched'}]}),e=>{
   assert.equal(e.code,'LOCAL_RESULT_INTEGRITY');assert.equal(e.stopBatch,true);assert.deepEqual(e.partialResults,[]);assert.equal(e.cause?.diagnostics.reason,'archive_integrity');return true;
  });
  assert.equal(s.calls,1);assert.equal(s.a.data.sources.length,1);assert.equal(hash(s.a.data.sources[0]),damaged);
  assert.equal(hash(Object.values(s.job.executionState.operations).find(o=>o.id===done.id)),hash(done));assert.equal(hash(s.job.executionState.history||[]),history);
  assert.equal(Object.values(s.job.executionState.operations).length,1);
 }
});

test('revoked remote authority and account changes block archive cache reuse before metadata transport',async t=>{
 for(const mode of ['revoke','account']){
  const s=await fixture(t);await s.acquire();
  if(mode==='revoke')policy.revoke(s.a,{principalScope:{kind:'account',provider:'platform',subject:'alice'},resourceScope:{kind:'platform',key:'sg-readonly',jobId:s.job.id},operations:['platform_query']},authorization);
  else s.a.platformFixture.identity={username:'bob'};
  await assert.rejects(s.query());assert.equal(s.calls,1);
 }
});

for(const missing of [true,false])test(`${missing?'missing':'corrupt'} archive cannot be automatically fetched again when its success cache expires`,async t=>{
 const s=await fixture(t),{source}=await s.acquire(),incoming=structuredClone(platform.splitPlatformSnapshot(JSON.parse(source.content),source));
 if(missing)delete source.platformArchive;else source.platformArchive.chunks[0].body='AAAA';
 expire(s);const done=structuredClone(Object.values(s.job.executionState.operations).find(o=>o.sourceId===source.id)),damaged=hash(source);
 assert.throws(()=>platform.sameEvidence(source.content,incoming.snapshot,source,incoming.sourceMeta),e=>e.code==='LOCAL_RESULT_INTEGRITY','equal incoming data cannot silently repair a missing or corrupt prior archive');
 assert.equal(hash(source),damaged);assert.equal(s.calls,1);
 assert.equal(ledger.eligibility(s.job,done).action,'execute','exercise the expired-cache branch');
 await assert.rejects(s.query(),e=>e.code==='LOCAL_RESULT_INTEGRITY'&&e.stopBatch===true);
 assert.equal(s.calls,1,'local corruption must be detected before any business redispatch');assert.equal(s.a.data.sources.length,1);assert.equal(hash(s.a.data.sources[0]),damaged);
 assert.equal(hash(Object.values(s.job.executionState.operations).find(o=>o.id===done.id)),hash(done));
});

test('fresh equal business data retains the original manifest/archive binding and evidence version',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),original=structuredClone(source);expire(s);
 const same=await s.query();assert.equal(same.sourceId,source.id);assert.equal(same.unchanged,true);assert.equal(s.calls,2);assert.equal(s.a.data.sources.length,1);
 const current=s.a.data.sources.find(v=>v.id===source.id);assert.equal(current.version,original.version);assert.equal(current.content,original.content);assert.equal(hash(current.platformArchive),hash(original.platformArchive));
 assert.equal(same.content,current.content,'returned summary must retain the original manifest/archive identity');
 assertV2(current,platform.redact(s.data));assert.equal(platform.sameEvidence(original.content,JSON.parse(current.content),original,current),true);noEncoded(same,current.platformArchive);
});

test('a real change hidden in archived business fields creates a new source version and preserves the prior evidence',async t=>{
 const s=await fixture(t),{source}=await s.acquire(),original=structuredClone(source);s.data.guidEntityMap.out.attributes.ddl+=' -- changed raw business field';expire(s);
 const changed=await s.query();assert.ok(changed.sourceId);assert.notEqual(changed.sourceId,source.id);assert.equal(changed.unchanged,false);assert.equal(s.calls,2);
 const current=s.a.data.sources.find(v=>v.id===changed.sourceId);assert.equal(current.previousSourceId,source.id);
 assert.equal(current.version,(original.version||1)+1);assert.equal(hash(s.a.data.sources.find(v=>v.id===source.id)),hash(original));assertV2(current,platform.redact(s.data));
 assert.equal(platform.sameEvidence(original.content,JSON.parse(current.content),original,current),false);assert.equal(platform.restorePlatformData(JSON.parse(current.content),current).guidEntityMap.out.attributes.name,'out');noEncoded(changed,current.platformArchive);
});
