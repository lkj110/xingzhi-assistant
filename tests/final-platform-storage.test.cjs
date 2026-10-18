'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
// This suite performs no external I/O, including accidental default transport.
const deny=()=>{throw Error('final-platform fixture: external I/O forbidden');};
require('node:child_process').spawn=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
const platform=require('../desktop/data-platform.cjs'),storage=require('../desktop/platform-result.cjs');
const {project}=require('../desktop/physical-lineage-coverage.cjs');
const f=require('./root-relation-physical-fixture.cjs'),{maxChars}=require('../desktop/documents.cjs');
const source=s=>({id:'large',title:'large fixture',platformSnapshot:true,content:JSON.stringify(s)});
function large({count=80,pad=30000}={}){
 const s=f.snapshot('out',Array.from({length:count},(_,i)=>'up_'+i),['tail']);
 for(const n of Object.values(s.data.guidEntityMap)){n.attributes.parameters='完整元数据🧭'.repeat(pad);n.attributes.dbName='db';}
 return {...s,queriedAt:'2026-01-01T00:00:00Z'};
}
// Explicit historical writer fixture. Production prepare now writes v2; these
// cases keep reading authentic v1 projection/body layouts across the upgrade.
function prepareV1(snapshot){
 if(JSON.stringify(snapshot,null,2).length<=maxChars)return snapshot;
 const raw=Buffer.from(JSON.stringify(require('../desktop/evidence-basis.cjs').canonical(snapshot.data))),data=storage.projectData(snapshot.data);
 const platformResult={version:1,format:'coral-structural-v1',codec:'gzip-base64',rawBytes:raw.length,rawSha256:storage.digest(raw),projectionSha256:storage.digest(JSON.stringify(require('../desktop/evidence-basis.cjs').canonical(data))),dataView:'structural_projection',originalDataRetained:true};
 return {...snapshot,data,platformResult,platformArchive:{...platformResult,body:require('node:zlib').gzipSync(raw,{level:9}).toString('base64')}};
}
const coverage=s=>project({roots:[f.root()],snapshots:[s]});

test('large multi-MB Coral snapshot stores every center/neighbor/process with a lossless same-source archive',async()=>{
 const s=large({pad:2500}),rawBytes=Buffer.byteLength(JSON.stringify(s.data));assert.ok(rawBytes>2_000_000);
 const snapshot=prepareV1(s);
 assert.ok(JSON.stringify(snapshot,null,2).length<=maxChars);assert.equal(snapshot.platformResult.format,'coral-structural-v1');
 assert.deepEqual(platform.restorePlatformData(snapshot),s.data);
 assert.deepEqual(snapshot.data.inputEntityGuids,s.data.inputEntityGuids);
 assert.deepEqual(Object.keys(snapshot.data.guidEntityMap),Object.keys(s.data.guidEntityMap));
 assert.deepEqual(snapshot.data.guidEntityMap.out.attributes.outputFromProcesses,s.data.guidEntityMap.out.attributes.outputFromProcesses);
 assert.deepEqual(coverage({...snapshot,sourceId:s.sourceId}),coverage(s));
 const result=coverage({...snapshot,sourceId:s.sourceId});assert.equal(result.directObserved,true);assert.equal(result.closureProven,false);
 assert.ok(result.frontier.some(x=>x.identity.table==='up_79'));assert.ok(result.frontier.some(x=>x.identity.table==='tail'));
 const summary=JSON.parse(platform.evidenceSummary(source(snapshot)).content);
 assert.ok(summary.rows.length>0&&summary.rows.length<=82);assert.equal(summary.truncated,summary.next!==null);assert.equal(summary.platformResult.archive,undefined);
 const rows=[];let next=0;do{const page=platform.index(snapshot,{start:next});rows.push(...page.rows);next=page.next;}while(next!==null);assert.equal(rows.length,82);
 assert.doesNotMatch(JSON.stringify(summary),/完整元数据/);assert.match(summary.platformResult.note,/restorePlatformData/);
});

test('small responses preserve original shape and large storage is redacted before compression',async()=>{
 const small=f.snapshot(),prepared=prepareV1(small);assert.strictEqual(prepared,small);assert.equal(prepared.platformResult,undefined);
 const s=large({count:0,pad:90000});s.data.guidEntityMap.out.attributes.accessToken='PRIVATE_SECRET';s.data.guidEntityMap.out.attributes.parameters+=' Bearer PRIVATE_TOKEN';
 const result=await platform.query({dataPlatform:'sg-readonly'},s.query,{request:async()=>s.data});
 const original=platform.restorePlatformData(result);assert.equal(original.guidEntityMap.out.attributes.accessToken,undefined);
 assert.doesNotMatch(JSON.stringify(original),/PRIVATE_/);assert.ok(JSON.stringify(result,null,2).length<maxChars);
});

test('storage split keeps encoded body only in independent metadata; public content and indexes never expose it',()=>{
 const internal=prepareV1(large({count:0,pad:90000}));
 const split=platform.splitPlatformSnapshot(internal);
 assert.equal(split.snapshot.platformArchive,undefined);assert.equal(split.snapshot.platformResult.archive,undefined);
 assert.equal(split.snapshot.platformResult.dataView,'structural_projection');assert.equal(split.sourceMeta.platformArchive.body,internal.platformArchive.body);
 assert.ok(!JSON.stringify(split.snapshot).includes(internal.platformArchive.body));
 assert.deepEqual(platform.restorePlatformData(split.snapshot,split.sourceMeta),platform.restorePlatformData(internal));
 assert.deepEqual(platform.splitPlatformSnapshot(split.snapshot,split.sourceMeta),split,'cached public snapshot can use source metadata after ACL');
 assert.throws(()=>platform.restorePlatformData(split.snapshot),e=>e.diagnostics.reason==='archive_invalid');
 assert.equal(platform.sameEvidence(JSON.stringify(split.snapshot),internal),true);
 const summary=platform.evidenceSummary({...source(split.snapshot),...split.sourceMeta});
 assert.ok(!JSON.stringify(summary).includes(internal.platformArchive.body));assert.equal(summary.platformArchive,undefined);
});

test('projection cannot repair incomplete, mismatched, malformed, non-SG or incidental evidence',()=>{
 const variants=[
  d=>d.truncated=true,d=>d.complete=false,d=>d.coverage='partial',d=>d.pagination={nextCursor:'more'},d=>d.hasMore=true,
  d=>d.inputEntityCount++,d=>d.inputEntityGuids[0].push('up_0'),d=>d.inputEntityDepth=2,
  d=>delete d.guidEntityMap.out.guid,d=>d.guidEntityMap.out.guid='different-center',
  d=>d.guidEntityMap.out.attributes.dbName='other_db',d=>d.guidEntityMap.out.attributes.cid=9,
  d=>delete d.guidEntityMap.out.attributes.outputFromProcesses,
  d=>d.guidEntityMap.out.attributes.outputFromProcesses[0].attributes.errorMessage='cannot resolve producer',
  d=>d.guidEntityMap.out.attributes.outputFromProcesses[0].attributes.qualifiedName='DoradoTask:///999@6',
  d=>delete d.guidEntityMap.up_0,d=>d.guidEntityMap.up_0.typeName='DummyTable',d=>d.guidEntityMap.up_0.attributes.qualifiedName='HiveTable:///db/up_0@9',
  d=>d.guidEntityMap.up_0.attributes.parentName='conflicting_db',d=>d.guidEntityMap.up_0.guid=null,
 ];
 for(const mutate of variants){
  const s=large({count:2,pad:30000});mutate(s.data);const result=prepareV1(s);
  assert.ok(result.platformResult);assert.deepEqual(coverage(result),coverage(s));assert.equal(coverage(result).closureProven,false);
  assert.deepEqual(platform.restorePlatformData(result),s.data);
 }
 const center=large({count:0,pad:90000});center.data=f.data('out');center.data.guidEntityMap.out.attributes.parameters='x'.repeat(600000);
 assert.equal(coverage(prepareV1(center)).closureProven,true,'only an actual terminal own center proves closure');
 const incidental=large({count:1,pad:60000}),p=prepareV1(incidental);assert.ok(coverage(p).frontier.some(g=>g.reason==='missing_own_center'));
});

test('archive integrity, decompression length and projection correspondence are checked without accepting a prefix',()=>{
 const s=prepareV1(large({count:0,pad:90000}));
 const mutations=[x=>x.platformArchive.body='AAAA',x=>x.platformArchive.body=x.platformArchive.body.slice(0,-4),x=>x.platformResult.rawSha256='0'.repeat(64),x=>x.platformResult.rawBytes=10,x=>x.platformResult.rawBytes=storage.limits.lineageBytes+1,x=>x.data.inputEntityCount=123,x=>x.platformResult.codec='untrusted'];
 for(const mutate of mutations){const broken=structuredClone(s);mutate(broken);assert.throws(()=>platform.restorePlatformData(broken),e=>e.code==='LOCAL_RESULT_INTEGRITY'&&/^archive_/.test(e.diagnostics.reason));}
 const swapped=structuredClone(s);swapped.data.guidEntityMap.out.guid='forged';swapped.platformResult.projectionSha256=swapped.platformArchive.projectionSha256=storage.digest(JSON.stringify(require('../desktop/evidence-basis.cjs').canonical(swapped.data)));
 assert.throws(()=>storage.restore(swapped),e=>e.diagnostics.reason==='archive_integrity','a self-consistent projected hash still must match archived data');
});

test('unchanged data ignores observation time/JSON key order; a change hidden in archived fields creates new evidence',()=>{
 const s=large({count:0,pad:90000}),first=prepareV1(s);
 assert.equal(platform.sameEvidence(JSON.stringify(first),{...s,queriedAt:'new'}),true);
 const reordered={...s,data:Object.fromEntries(Object.entries(s.data).reverse()),queriedAt:'later'};
 assert.equal(platform.sameEvidence(JSON.stringify(first),prepareV1(reordered)),true);
 const changed=structuredClone(s);changed.data.guidEntityMap.out.attributes.parameters+='changed';
 assert.equal(platform.sameEvidence(JSON.stringify(first),prepareV1(changed)),false);
 assert.equal(platform.sameEvidence(JSON.stringify(first),{...first,query:{...first.query,table:'different'}}),false);
});

test('v1 reader retains its historical size bounds while the production v2 writer handles formerly rejected layouts',()=>{
 const entropy=f.snapshot();entropy.data.guidEntityMap.out.attributes.parameters=require('node:crypto').randomBytes(550000).toString('hex');
 const old=prepareV1(entropy);assert.ok(old.platformArchive.body.length>storage.limits.archiveChars);
 assert.throws(()=>storage.restore(old),e=>e.code==='LOCAL_RESULT_INTEGRITY');
 for(const value of [entropy,large({count:1900,pad:0}),{operation:'code',query:{op:'code',taskId:123},data:{code:'x'.repeat(maxChars)}}]){
  const current=storage.prepare(value);assert.equal(current.platformResult.version,2);assert.deepEqual(storage.restore(current),value.data);
 }
 const raw=f.snapshot();raw.data.guidEntityMap.out.attributes.parameters='x'.repeat(storage.limits.lineageBytes+1);
 assert.throws(()=>storage.prepare(raw),e=>e.code==='LOCAL_RESULT_STORAGE'&&e.diagnostics.reason==='raw_limit');
});
