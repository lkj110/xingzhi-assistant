'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {gzipSync}=require('node:zlib');
const deny=()=>{throw Error('controlled fixture: real network/transport forbidden');};
require('node:child_process').spawn=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
const storage=require('../desktop/platform-result.cjs'),platform=require('../desktop/data-platform.cjs');
const e=require('../desktop/evidence-basis.cjs'),documents=require('../desktop/documents.cjs'),context=require('../desktop/task-context.cjs');
const f=require('./root-relation-physical-fixture.cjs'),coverage=require('../desktop/physical-lineage-coverage.cjs');
const scope={principal:'alice',projectId:null,scope:'sg-readonly',permissionRevision:3,operationId:'op-original'};
function snapshot(count=70){const s=f.snapshot('out',Array.from({length:count},(_,i)=>'neighbor_'+i),['tail']);s.queriedAt='2026-10-18T00:00:00Z';s.data.guidEntityMap.out.attributes.sql='SELECT raw_tail_marker FROM controlled';s.data.guidEntityMap.out.attributes.parameters='界🧭'.repeat(200000);return s;}
function source(s=snapshot(),options=scope){const internal=storage.prepare(s,options),split=storage.split(internal);return {id:'stored',title:'Controlled graph',version:1,platformSnapshot:true,platformPrincipal:options.principal??null,projectId:options.projectId??null,platformOperationId:options.operationId,platformScope:options.scope,platformPermissionRevision:options.permissionRevision,content:JSON.stringify(split.snapshot),...split.sourceMeta};}
function legacy(s){const raw=Buffer.from(JSON.stringify(e.canonical(s.data))),data=storage.projectData(s.data),platformResult={version:1,format:'coral-structural-v1',codec:'gzip-base64',rawBytes:raw.length,rawSha256:storage.digest(raw),projectionSha256:storage.digest(JSON.stringify(e.canonical(data))),dataView:'structural_projection',originalDataRetained:true};return {id:'stored',title:'Controlled graph',platformSnapshot:true,platformPrincipal:'alice',projectId:null,content:JSON.stringify({...s,data,platformResult}),platformArchive:{...platformResult,body:gzipSync(raw,{level:9}).toString('base64')}};}
function noEncoded(value,s){const text=JSON.stringify(value);for(const c of s.platformArchive.chunks||[{body:s.platformArchive.body}]){assert.ok(!text.includes(c.body));assert.ok(!text.includes(c.body.slice(0,100)));}assert.equal(text.includes('"platformArchive"'),false);}
const invalid=fn=>assert.throws(fn,error=>error.code==='LOCAL_RESULT_INTEGRITY'&&error.diagnostics.stage==='storage');
function rehash(s){const r=JSON.parse(s.content);s.platformArchive.manifestHash=e.hash(r.platformResult);return r;}
function replaceCompressed(s,compressed){const p=JSON.parse(s.content),r=p.platformResult,encoded=compressed.toString('base64'),chunks=[];for(let at=0;at<encoded.length;at+=131072)chunks.push({index:chunks.length,body:encoded.slice(at,at+131072)});Object.assign(r,{compressedBytes:compressed.length,compressedSha256:storage.digest(compressed),encodedChars:encoded.length,chunkCount:chunks.length,descriptors:chunks.map(c=>({index:c.index,encodedChars:c.body.length,sha256:storage.digest(c.body)}))});s.platformArchive.chunks=chunks;s.platformArchive.manifestHash=e.hash(r);s.content=JSON.stringify(p);}

test('exact canonical bytes, multi-piece gzip over former 350k limit; every node/edge survives',()=>{
 const original=snapshot(2200);original.data.guidEntityMap.out.attributes.parameters=crypto.randomBytes(550000).toString('hex');
 const s=source(original),p=JSON.parse(s.content),r=p.platformResult;
 assert.ok(Buffer.byteLength(JSON.stringify(original.data))>500000);assert.ok(r.compressedBytes>350000);assert.ok(r.chunkCount>3);
 assert.equal(r.dataView,'manifest_only');assert.equal(p.data.guidEntityMap,undefined);assert.equal(p.data.incomplete,true);
 assert.ok(r.descriptors.slice(0,-1).every(d=>d.encodedChars===131072));assert.ok(s.content.length<50000);
 const restored=storage.fullSnapshot(s);assert.deepEqual(restored.data,original.data);
 assert.equal(r.rawSha256,storage.digest(Buffer.from(JSON.stringify(e.canonical(original.data)))));
 assert.deepEqual(coverage.project({roots:[f.root()],snapshots:[restored]}),coverage.project({roots:[f.root()],snapshots:[original]}));
 const clone=JSON.parse(JSON.stringify(s));assert.deepEqual(storage.fullSnapshot(clone),restored);
 noEncoded(platform.index(p,{},s),s);noEncoded(documents.summary(s),s);
});

test('formerly rejected ordinary data, wide graph, archive and snapshot all retain full results',()=>{
 for(const original of [snapshot(2500),{operation:'code',query:{op:'code',taskId:123},data:{code:'x'.repeat(650000)}},snapshot(0),snapshot(1)]){
  const s=source(original);assert.equal(JSON.parse(s.content).platformResult.version,2);assert.deepEqual(storage.fullSnapshot(s).data,original.data);
 }
});

test('transport and raw limits apply before acceptance, including compact multibyte data',()=>{
 const ordinary={operation:'code',query:{op:'code',taskId:123},data:'界'.repeat(700000)};
 assert.throws(()=>storage.prepare(ordinary),error=>error.code==='LOCAL_RESULT_STORAGE'&&error.diagnostics.reason==='raw_limit');
 const huge=snapshot(0);huge.data.guidEntityMap.out.attributes.parameters='x'.repeat(16000000);
 assert.throws(()=>storage.prepare(huge),error=>error.code==='LOCAL_RESULT_STORAGE');
 invalid(()=>storage.prepare(snapshot(),{stdoutComplete:false}));
 const p=source(),r=JSON.parse(p.content);r.platformResult.rawBytes=16000001;invalid(()=>storage.restore(r,p));
});

test('missing, reordered, duplicated, changed, overlong chunks and hash/binding swaps fail closed',()=>{
 const original=snapshot();original.data.guidEntityMap.out.attributes.parameters=crypto.randomBytes(400000).toString('hex');const good=source(original);
 const mutations=[s=>s.platformArchive.chunks.pop(),s=>s.platformArchive.chunks.reverse(),s=>s.platformArchive.chunks[1]=s.platformArchive.chunks[0],s=>s.platformArchive.chunks[0].body='A'+s.platformArchive.chunks[0].body.slice(1),s=>s.platformArchive.chunks[0].body+='AAAA',s=>s.platformArchive.manifestHash='0'.repeat(64),s=>s.platformArchive.binding.principal='bob',s=>s.platformPrincipal='bob',s=>s.projectId='other',s=>s.platformOperationId='new-operation',s=>s.platformScope='other',s=>s.platformPermissionRevision=4,s=>delete s.platformArchive];
 for(const mutate of mutations){const s=structuredClone(good);mutate(s);invalid(()=>storage.fullSnapshot(s));}
 for(const mutate of [p=>p.query.table='other',p=>p.queriedAt='later',p=>p.scope='different',p=>p.data.guidEntityMap={},p=>p.platformResult.chunkCount=193,p=>p.platformResult.rawSha256='0'.repeat(64),p=>p.platformResult.rawBytes=2,p=>p.platformResult.descriptors[0].index=1,p=>p.platformResult.descriptors[0].sha256='0'.repeat(64),p=>p.platformResult.codec='gzip-base64',p=>delete p.platformResult]){const s=structuredClone(good),p=JSON.parse(s.content);mutate(p);s.content=JSON.stringify(p);invalid(()=>storage.fullSnapshot(s));}
 const other=source({...original,query:{...original.query,table:'other'}});const swapped={...good,platformArchive:other.platformArchive};invalid(()=>storage.fullSnapshot(swapped));
 const bound=source(original,{...scope,sourceId:'stored',sourceVersion:1});invalid(()=>storage.fullSnapshot({...bound,id:'other'}));invalid(()=>storage.fullSnapshot({...bound,version:2}));
});

test('canonical base64, single gzip, CRC, UTF-8/JSON shape are independently verified after rehash',()=>{
 const good=source(snapshot(0)),encoded=good.platformArchive.chunks.map(c=>c.body).join(''),compressed=Buffer.from(encoded,'base64');
 for(const bytes of [Buffer.concat([compressed,gzipSync(Buffer.from('{}'))]),Buffer.concat([compressed,Buffer.from([0])]),Buffer.concat([compressed.subarray(0,-8),Buffer.alloc(8)])]){const s=structuredClone(good);replaceCompressed(s,bytes);invalid(()=>storage.fullSnapshot(s));}
 for(const body of [' '+encoded.slice(1),encoded.slice(0,-1)+'!',encoded.slice(0,-1)+(encoded.at(-1)==='A'?'B':'A')]){
  const s=structuredClone(good),p=JSON.parse(s.content);s.platformArchive.chunks=[{index:0,body}];p.platformResult.descriptors[0].sha256=storage.digest(body);s.content=JSON.stringify(p);rehash(s);invalid(()=>storage.fullSnapshot(s));
 }
 // Same compressed bytes with nonzero unused padding bits must not be accepted.
 const {decode}=require('../desktop/platform-chunks.cjs');assert.deepEqual(decode('Zg=='),Buffer.from('f'));invalid(()=>decode('Zh=='));invalid(()=>decode('Zg==\n'));invalid(()=>decode('Zg'));
 for(const raw of [Buffer.from('{"guidEntityMap":{}, "x":1}'),Buffer.from('{"guidEntityMap":[]}'),Buffer.from([0xff]),Buffer.from('null')]){
  const s=structuredClone(good);replaceCompressed(s,gzipSync(raw));const p=JSON.parse(s.content);p.platformResult.rawBytes=raw.length;p.platformResult.rawSha256=storage.digest(raw);s.content=JSON.stringify(p);rehash(s);invalid(()=>storage.fullSnapshot(s));
 }
});

test('v1 remains readable; inline/v1/v2 same semantics do not renew facts, real changes do',()=>{
 const original=snapshot(1),archived=source(original),old=legacy(original),inline={...archived,content:JSON.stringify(original)};delete inline.platformArchive;
 assert.deepEqual(storage.fullSnapshot(old).data,original.data);
 const task={criteria:'核对物理表血缘'},versions=[inline,old,archived].map(s=>e.semanticFactVersion(s,task));
 assert.equal(new Set(versions).size,1);assert.equal(e.relevantChange(inline,archived,task),false);
 assert.equal(new Set([inline,old,archived].map(e.storageIntegrityVersion)).size,3);
 const observed=structuredClone(original);observed.queriedAt='later';observed.data.guidEntityMap.out.attributes.tableSize=999;
 assert.equal(e.semanticFactVersion(archived,task),e.semanticFactVersion(source(observed),task));
 assert.notEqual(e.semanticFactVersion(archived,{criteria:'核对存储量'}),e.semanticFactVersion(source(observed),{criteria:'核对存储量'}));
 const changed=structuredClone(original);changed.data.guidEntityMap.out.attributes.sql+=' changed';assert.notEqual(e.semanticFactVersion(source(changed),task),versions[0]);
 const bad=structuredClone(archived);bad.platformArchive.chunks[0].body='AAAA';invalid(()=>e.semanticFactVersion(bad,task));
 const same=source({...original,queriedAt:'later'});assert.equal(platform.sameEvidence(archived.content,JSON.parse(same.content)),true);
});

test('index, bounded summary and inventories enumerate the complete saved data and expose honest cursors',()=>{
 const original=snapshot(160),s=source(original),p=JSON.parse(s.content),rows=[];let next=0;
 do{const page=platform.index(p,{start:next,limit:50},s);noEncoded(page,s);rows.push(...page.rows);next=page.next;}while(next!==null);
 assert.equal(rows.length,162);assert.ok(rows.some(r=>r.guid==='neighbor_159'));
 const summary=platform.evidenceSummary(s,7000),body=JSON.parse(summary.content);assert.ok(body.next>0);assert.equal(summary.truncated,true);assert.equal(body.storageComplete,true);assert.ok(summary.content.length<10000);noEncoded(summary,s);
 const small=source(snapshot(0)),smallSummary=platform.evidenceSummary(small);assert.equal(smallSummary.truncated,false);
 const graph={operation:'upstream',query:{op:'upstream',taskId:123},data:{depth:1,nodes:Array.from({length:1200},(_,i)=>({id:i+1,name:'node-'+i,parentRelation:i?[i]:[],config:'x'.repeat(500)}))}},g=source(graph);
 assert.equal(platform.fullInventory([g]).totalNodes,1200);assert.equal(platform.inventory([g],{start:1100}).nodes.at(-1).id,'1200');
 const inventory=platform.contextInventory([g]);assert.equal(inventory.nodes.length,1000);assert.equal(inventory.next,1000);assert.equal(inventory.truncated,true);
 g.platformArchive.chunks.pop();invalid(()=>platform.fullInventory([g]));
});

function localContext(s){const job={id:'job',projectId:null,sourceIds:[s.id],taskIds:[],goal:'controlled',platformPrincipal:'alice'},a={requireContextAccessPolicy:true,data:{tasks:[],delegations:[job],sources:[s],artifacts:[],agentActions:[],projects:[]},contextAccessCheck:()=>({decision:'allow',revision:1})};return {a,job,scope:{kind:'job',jobId:job.id}};}
test('authorized context reads ALL raw segments and search, with stable version and no encoded bytes',()=>{
 const original=snapshot(2),s=source(original);s.segments=[{text:'SHOULD_NOT_READ '+s.platformArchive.chunks[0].body}];const f=localContext(s),parts=[];let next=0;
 const cat=context.buildContext(f.a,f.scope);assert.equal(cat.readableCatalog[0].readView.stored,'manifest_only');noEncoded(cat,s);
 context.withContext(f.a,f.scope,op=>{do{const r=op.resolveRead({tool:'read_source',sourceId:s.id,start:next,limit:10});assert.equal(r.ok,true);noEncoded(r,s);parts.push(...r.segments.map(s=>s.text));next=r.next;}while(next!==null);});
 assert.deepEqual(JSON.parse(parts.join('')).data,original.data);
 const r=context.resolveRead(f.a,f.scope,{tool:'search_source',sourceId:s.id,query:'raw_tail_marker'});assert.equal(r.ok,true);assert.match(r.segments.map(s=>s.text).join(''),/raw_tail_marker/);
 const segment=context.resolveRead(f.a,f.scope,{tool:'read_segment',sourceId:s.id,index:r.segments[0].index});assert.equal(segment.ok,true);noEncoded(segment,s);
 assert.match(documents.excerpts(s,{query:'raw_tail_marker'}).segments.map(s=>s.text).join(''),/raw_tail_marker/);
 const version=r.version;s.platformArchive.chunks[0].body='AAAA';assert.equal(context.resolveRead(f.a,f.scope,{tool:'read_source',sourceId:s.id,version}).code,'CONTEXT_VERSION_CHANGED');
 const damaged=context.resolveRead(f.a,f.scope,{tool:'read_source',sourceId:s.id});assert.equal(damaged.ok,false);assert.equal(damaged.code,'LOCAL_RESULT_INTEGRITY');assert.equal(damaged.segments,undefined);
});

test('current ACL, ownership, withdrawal and policy callback mutations fence hydration',t=>{
 const s=source(),f=localContext(s);let restores=0;const original=platform.restorePlatformData;
 t.mock.method(platform,'restorePlatformData',(...args)=>{restores++;return original(...args);});
 for(const mode of ['deny','foreign','missing','deleted','project']){
  const clone=localContext(structuredClone(s));let sc=clone.scope;
  if(mode==='deny')clone.a.contextAccessCheck=()=>({decision:'deny',revision:2});
  if(mode==='foreign'){clone.a.data.delegations.push({id:'other',taskIds:[],sourceIds:[]});sc={kind:'job',jobId:'other'};}
  if(mode==='missing')clone.job.sourceIds=[];
  if(mode==='deleted')clone.a.data.sources[0].deleted=true;
  if(mode==='project')clone.a.data.sources[0].projectId='foreign';
  assert.equal(context.resolveRead(clone.a,sc,{tool:'read_source',sourceId:s.id}).ok,false);
 }
 assert.equal(restores,0);
 const row={request:{tool:'read_source',sourceId:s.id},result:context.resolveRead(f.a,f.scope,{tool:'read_source',sourceId:s.id})};assert.equal(row.result.ok,true);
 f.a.contextAccessCheck=()=>({decision:'deny',revision:2});assert.equal(context.validRead(f.a,f.scope,row),false);const prior=restores;assert.equal(context.resolveRead(f.a,f.scope,row.request).ok,false);assert.equal(restores,prior);
 const changed=localContext(structuredClone(s));let calls=0;changed.a.contextAccessCheck=()=>{if(++calls===2)changed.a.data.sources[0].platformArchive.chunks[0].body='AAAA';return {decision:'allow',revision:1};};
 assert.equal(context.resolveRead(changed.a,changed.scope,row.request).code,'CONTEXT_VERSION_CHANGED');
});

test('controlled query redacts before archival and binds trusted job scope, never model data',async()=>{
 const original=snapshot(0);original.data.password='PRIVATE_PASSWORD';original.data.guidEntityMap.out.attributes.sql+=' Bearer PRIVATE_TOKEN';
 const result=await platform.query({dataPlatform:'sg-readonly',platformPrincipal:'alice',projectId:null,executionState:{permissionRevision:3}},original.query,{request:async()=>original.data,storageScope:{operationId:'original'}});
 const split=storage.split(result),read=storage.restore(split.snapshot,split.sourceMeta);
 assert.doesNotMatch(JSON.stringify(read),/PRIVATE_/);assert.equal(split.sourceMeta.platformArchive.binding.principal,'alice');assert.equal(split.sourceMeta.platformArchive.binding.operationId,'original');
});

test('catalog/summary never inflate data and internal archive encoding never escapes into summary',t=>{
 const s=source(),f=localContext(s),internal=storage.prepare(snapshot(),scope);
 t.mock.method(platform,'restorePlatformData',()=>{throw Error('catalog must not hydrate');});
 t.mock.method(storage,'restore',()=>{throw Error('catalog must not hydrate');});
 noEncoded(context.buildContext(f.a,f.scope),s);noEncoded(documents.summary(s),s);
 noEncoded(documents.summary({...s,content:JSON.stringify(internal)}),s);
});

test('rehashing descriptors cannot bypass output size limits or successful split validation',()=>{
 const s=source(),p=JSON.parse(s.content);p.platformResult.rawBytes=16;s.content=JSON.stringify(p);rehash(s);
 invalid(()=>storage.restore(JSON.parse(s.content),s));invalid(()=>storage.split(JSON.parse(s.content),s));
});

test('archival preserves incomplete and contradictory graph observations for the full structural checker',()=>{
 for(const mutate of [d=>d.truncated=true,d=>d.hasMore=true,d=>d.inputEntityCount++,d=>delete d.guidEntityMap.out.guid,d=>d.guidEntityMap.out.guid='wrong',d=>delete d.guidEntityMap.neighbor_0,d=>d.guidEntityMap.neighbor_0.typeName='DummyTable',d=>d.guidEntityMap.out.attributes.cid=9,d=>delete d.guidEntityMap.out.attributes.outputFromProcesses]){
  const original=snapshot(1);mutate(original.data);const stored=source(original),full=storage.fullSnapshot(stored);
  assert.deepEqual(full.data,original.data);assert.deepEqual(coverage.project({roots:[f.root()],snapshots:[full]}),coverage.project({roots:[f.root()],snapshots:[original]}));
  assert.equal(coverage.project({roots:[f.root()],snapshots:[full]}).closureProven,false);
 }
});


test('task context preserves trusted operation/scope metadata through its immutable ACL snapshot',()=>{
 for(const field of ['platformOperationId','platformScope','platformPermissionRevision']){
  const s=source(),f=localContext(s),request={tool:'read_source',sourceId:s.id};
  const first=context.resolveRead(f.a,f.scope,request);assert.equal(first.ok,true);
  s[field]=field==='platformPermissionRevision'?999:'changed';
  assert.equal(context.resolveRead(f.a,f.scope,{...request,version:first.version}).code,'CONTEXT_VERSION_CHANGED');
  const result=context.resolveRead(f.a,f.scope,request);assert.equal(result.code,'LOCAL_RESULT_INTEGRITY');assert.equal(result.ok,false);
 }
});


test('full archived pagination preserves spaces, tabs, newlines and Unicode at segment boundaries',()=>{
 const original=snapshot(0);original.data.guidEntityMap.out.attributes.parameters=('  SQL \t\n界🧭 \r\n').repeat(70000);
 const s=source(original),f=localContext(s),parts=[];
 context.withContext(f.a,f.scope,op=>{let start=0;do{const result=op.resolveRead({tool:'read_source',sourceId:s.id,start,limit:10});assert.equal(result.ok,true);parts.push(...result.segments.map(s=>s.text));start=result.next;}while(start!==null);});
 const raw=documents.readContent(s);assert.equal(parts.join(''),raw);assert.deepEqual(JSON.parse(parts.join('')).data,original.data);
 assert.equal(documents.platformSegments(raw).map(s=>s.text).join(''),raw);
});
