'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const deny=()=>{throw Error('final-platform fixture: real I/O forbidden');};
require('node:child_process').spawn=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const ledger=require('../desktop/operation-ledger.cjs'),platform=require('../desktop/data-platform.cjs'),policy=require('../desktop/access-policy-store.cjs');
const storage=require('../desktop/platform-result.cjs'),recovery=require('../desktop/recovery.cjs'),{hash,canonical}=require('../desktop/evidence-basis.cjs'),f=require('./root-relation-physical-fixture.cjs');
const authorization={trusted:true,actor:'user_command',command:'final_platform_fixture'};
const q={op:'table_lineage',database:'db',table:'out'};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'final-platform-isolated-'));
 const a=new Assistant({dir,chat:deny,agentRequest:deny,connectorRequest:deny,webRequest:deny,feedRequest:deny});
 t.after(async()=>{a.stop();await a.runPromise;require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 require('./helpers/platform-fixture.cjs').install(a,{username:'alice'});
 await a.dispatch('saveProvider',{name:'offline fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 const job=agent.buildJob(a,{goal:'Inspect fixture physical lineage',dataPlatform:'sg-readonly'});a.data.delegations.push(job);
 job.platformPrincipal='alice';policy.syncTrustedJob(a,job,authorization);
 return {a,job,dir};
}
const act=(a,job)=>agent.act(a,job,'platform_query',{queries:[q]}).then(r=>r.results[0]);
function bulky(){const d=f.data('out',['up'],['tail']);d.guidEntityMap.out.attributes.useCases='metadata-'.repeat(150000);return d;}
function noEncoded(value,archive){
 const text=JSON.stringify(value);assert.ok(archive.chunks.length>0);
 for(const {body} of archive.chunks){assert.ok(body.length>80);assert.ok(!text.includes(body)&&!text.includes(body.slice(0,80))&&!text.includes(body.slice(-80)),'archive encoding escaped');}
 const visit=v=>{if(!v||typeof v!=='object')return;assert.equal(Object.hasOwn(v,'platformArchive'),false);for(const child of Object.values(v))visit(child);};visit(value);
}
function assertV2(source,data){
 const snapshot=JSON.parse(source.content),manifest=snapshot.platformResult,archive=source.platformArchive;
 assert.equal(manifest.version,2);assert.equal(manifest.format,'platform-chunks-v2');assert.equal(manifest.codec,'gzip-base64-chunks');assert.equal(manifest.dataView,'manifest_only');
 assert.equal(snapshot.data.incomplete,true);assert.equal(snapshot.data.dataView,'manifest_only');assert.equal(snapshot.data.guidEntityMap,undefined);assert.equal(archive.body,undefined);
 assert.equal(archive.chunks.length,manifest.chunkCount);assert.equal(manifest.descriptors.length,manifest.chunkCount);assert.equal(archive.manifestHash,storage.digest(JSON.stringify(canonical(manifest))));
 for(const [i,chunk] of archive.chunks.entries()){
  assert.equal(chunk.index,i);assert.ok(chunk.body.length<=storage.limits.chunkChars);
  assert.deepEqual(manifest.descriptors[i],{index:i,encodedChars:chunk.body.length,sha256:storage.digest(chunk.body)});
 }
 assert.equal(archive.chunks.reduce((n,c)=>n+c.body.length,0),manifest.encodedChars);noEncoded(snapshot,archive);
 assert.equal(hash(platform.restorePlatformData(snapshot,source)),hash(data),'every original field and relation must survive restoration');
 return snapshot;
}
function restart(t,dir){
 const a=new Assistant({dir,chat:deny,agentRequest:deny,connectorRequest:deny,webRequest:deny,feedRequest:deny});
 t.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);a.streamController?.dispose();});
 require('./helpers/platform-fixture.cjs').install(a,{username:'alice'});a.platformRequest=deny;return a;
}

test('split contract stores only a v2 manifest directory in source.content and retains complete chunks under existing source ACL',async t=>{
 const {a,job,dir}=await fixture(t),data=bulky();data.guidEntityMap.out.attributes.ddl='CREATE TABLE retained_sql_marker';a.platformRequest=async()=>data;
 const fetched=await ledger.fetch(a,job,q),split=platform.splitPlatformSnapshot(fetched.snapshot);
 const s=agent.source(a,job,'fixture-split','Split fixture',JSON.stringify(split.snapshot,null,2),{platformSnapshot:true,platformPrincipal:job.platformPrincipal,...split.sourceMeta});ledger.finish(a,job,fetched.operation,s.id);
 assertV2(s,data);assert.equal(s.platformArchive.binding.operationId,fetched.operation.id);
 const authorized=await agent.act(a,job,'read_source',{sourceId:s.id});assert.equal(authorized.ok,true);noEncoded(authorized,s.platformArchive);
 assert.equal(platform.restorePlatformData(JSON.parse(s.content),s).guidEntityMap.out.attributes.ddl,'CREATE TABLE retained_sql_marker');
 a.save();const persisted=JSON.parse(fs.readFileSync(path.join(dir,'workspace.json'),'utf8')).sources.find(x=>x.id===s.id);
 assert.equal(hash(persisted.platformArchive),hash(s.platformArchive));assertV2(persisted,data);
 s.deleted=true;assert.equal((await agent.act(a,job,'read_source',{sourceId:s.id})).ok,false);
});

test('agent persists large actual-shaped evidence, finishes operation, reuses it and restores it after restart',async t=>{
 const {a,job,dir}=await fixture(t),data=bulky();let calls=0;a.platformRequest=async()=>{calls++;return data;};
 const first=await act(a,job);assert.ok(first.sourceId);assert.equal(first.error,undefined);
 const s=a.data.sources.find(s=>s.id===first.sourceId);assertV2(s,data);noEncoded(first,s.platformArchive);
 assert.ok(s.content.length<=require('../desktop/documents.cjs').maxChars);
 const op=Object.values(job.executionState.operations).find(o=>o.query.op==='table_lineage');assert.equal(op.status,'done');assert.equal(op.sourceId,s.id);
 const second=await act(a,job);assert.equal(second.sourceId,s.id);assert.equal(second.reused,true);assert.equal(calls,1);
 assert.equal((await agent.act(a,job,'read_source',{sourceId:s.id})).sourceId,s.id);
 const page=await agent.act(a,job,'read_platform',{sourceId:s.id});assert.equal(page.rowsInSnapshot,3);assert.equal(page.platformResult.archive,undefined);noEncoded(page,s.platformArchive);
 a.save();const restored=restart(t,dir),retained=restored.data.sources.find(x=>x.id===s.id);assertV2(retained,data);
 assert.equal(restored.data.delegations.find(j=>j.id===job.id).executionState.operations[op.key].status,'done');
});

test('source versioning keeps full archived changes and unchanged observations do not create extra sources',async t=>{
 const {a,job}=await fixture(t);let data=bulky();a.platformRequest=async()=>data;
 const first=await act(a,job),initial=structuredClone(a.data.sources.find(s=>s.id===first.sourceId)),age=()=>{for(const o of Object.values(job.executionState.operations))o.completedAt='2000-01-01T00:00:00Z';};
 age();const same=await act(a,job);assert.equal(same.sourceId,first.sourceId);assert.equal(same.unchanged,true);
 const retained=a.data.sources.find(s=>s.id===first.sourceId);assert.equal(retained.content,initial.content);assert.equal(hash(retained.platformArchive),hash(initial.platformArchive));assert.equal(retained.version,initial.version);
 assert.equal(same.content,retained.content,'returned summary must describe the retained manifest, not the new query envelope');assertV2(retained,data);noEncoded(same,retained.platformArchive);
 data=structuredClone(data);data.guidEntityMap.out.attributes.useCases+='actual change';age();const changed=await act(a,job);
 assert.notEqual(changed.sourceId,first.sourceId);const old=a.data.sources.find(s=>s.id===first.sourceId),head=a.data.sources.find(s=>s.id===changed.sourceId);
 assert.equal(head.previousSourceId,old.id);assert.equal(require('../desktop/evidence-store.cjs').current(a.data,old).id,head.id);
 assert.equal(head.version,(old.version||1)+1);assert.equal(old.content,initial.content);assert.equal(hash(old.platformArchive),hash(initial.platformArchive));assertV2(head,data);
 assert.equal(platform.restorePlatformData(JSON.parse(head.content),head).guidEntityMap.out.attributes.useCases,data.guidEntityMap.out.attributes.useCases);
});

test('a response above the old 350k archive limit is fully retained in v2 chunks and reused after restart',async t=>{
 const {a,job,dir}=await fixture(t),data=f.data();data.guidEntityMap.out.attributes.useCases=require('node:crypto').randomBytes(550000).toString('base64');
 let calls=0;a.platformRequest=async()=>{calls++;return data;};
 const result=await act(a,job);assert.ok(result.sourceId);assert.equal(result.errorCode,undefined);assert.equal(a.data.sources.length,1);
 const source=a.data.sources[0],snapshot=assertV2(source,data);assert.ok(snapshot.platformResult.encodedChars>350_000);assert.ok(snapshot.platformResult.compressedBytes>350_000);assert.ok(snapshot.platformResult.chunkCount>1);noEncoded(result,source.platformArchive);
 const op=Object.values(job.executionState.operations).find(o=>o.query.op==='table_lineage');assert.equal(op.status,'done');assert.equal(op.sourceId,source.id);assert.equal(op.receipt.storageValidated,true);assert.equal(op.receipt.retained,true);
 const cached=await act(a,job);assert.equal(cached.reused,true);assert.equal(cached.sourceId,source.id);assert.equal(calls,1);noEncoded(cached,source.platformArchive);
 a.save();const restored=restart(t,dir),retained=restored.data.sources.find(s=>s.id===source.id);assertV2(retained,data);assert.equal(hash(retained.platformArchive),hash(source.platformArchive));
 const r=await act(restored,restored.data.delegations.find(j=>j.id===job.id));assert.equal(r.reused,true);assert.equal(r.sourceId,source.id);noEncoded(r,retained.platformArchive);assert.equal(calls,1);
});

test('a real response exceeding 16MB fails locally with no source or running operation and cannot automatically retry after restart',async t=>{
 const {a,job,dir}=await fixture(t),data=f.data();assert.equal(storage.limits.lineageBytes,16_000_000);
 data.guidEntityMap.out.attributes.useCases='x'.repeat(16_000_000);const rawBytes=Buffer.byteLength(JSON.stringify(canonical(data)));assert.ok(rawBytes>16_000_000);
 let calls=0;a.platformRequest=async()=>{calls++;return data;};
 await assert.rejects(act(a,job),e=>{
  assert.equal(e.code,'LOCAL_RESULT_STORAGE');assert.equal(e.stopBatch,true);assert.equal(e.diagnostics.reason,'raw_limit');assert.equal(e.diagnostics.rawBytes,rawBytes);assert.equal(e.diagnostics.rawSha256,hash(data));return true;
 });
 assert.equal(a.data.sources.length,0);assert.equal(calls,1);
 const op=Object.values(job.executionState.operations).find(o=>o.query.op==='table_lineage');assert.equal(op.status,'failed');assert.equal(op.retryAt,undefined);assert.equal(ledger.eligibility(job,op).action,'diagnose');
 assert.equal(op.errorCode,'LOCAL_RESULT_STORAGE');assert.equal(op.sourceId,undefined);assert.equal(op.receipt.classification,'LOCAL_RESULT_STORAGE');assert.equal(op.receipt.diagnostics.reason,'raw_limit');assert.equal(op.receipt.diagnostics.rawBytes,rawBytes);assert.equal(op.receipt.diagnostics.rawSha256,hash(data));
 assert.deepEqual(op.receipt.actualQuery,q);assert.ok(op.receipt.observedAt);assert.equal(op.receipt.operationId,op.id);assert.equal(op.receipt.dispatched,true);const receipt=structuredClone(op.receipt);
 const cached=await act(a,job);assert.equal(cached.errorCode,'LOCAL_RESULT_STORAGE');assert.equal(cached.reused,true);assert.equal(cached.operationId,op.id);assert.equal(calls,1);
 a.save();const restored=restart(t,dir),r=await act(restored,restored.data.delegations.find(j=>j.id===job.id));assert.equal(r.errorCode,'LOCAL_RESULT_STORAGE');assert.equal(r.reused,true);assert.deepEqual(r.receipt,receipt);assert.equal(restored.data.sources.length,0);
});

test('the actual 200MB candidate and backup bound rejects before commit/write and before reading an oversized file',async t=>{
 const {a,job,dir}=await fixture(t);a.platformRequest=async()=>bulky();await act(a,job);a.save();assert.equal(recovery.maxBackupBytes,200_000_000);
 const prior=hash(a.data),workspace=fs.readFileSync(path.join(dir,'workspace.json'),'utf8'),payload='界'.repeat(66_666_667);
 const overLimit=e=>e.code==='LOCAL_RESULT_STORAGE'&&e.diagnostics.reason==='storage_capacity'&&e.diagnostics.limitBytes===200_000_000&&e.diagnostics.workspaceBytes>200_000_000&&e.diagnostics.backupBytes>200_000_000;
 assert.throws(()=>require('../desktop/state-transitions.cjs').commit(a,()=>{a.data.capacityFixture=payload;recovery.assertStorageCapacity(a);}),overLimit);
 assert.equal(hash(a.data),prior);assert.equal(fs.readFileSync(path.join(dir,'workspace.json'),'utf8'),workspace);
 const candidate={...a.data,capacityFixture:payload};assert.throws(()=>recovery.assertStorageCapacity(a,candidate),overLimit);assert.equal(hash(a.data),prior);
 const backupDir=path.join(dir,'capacity-backup');fs.mkdirSync(backupDir);const target={dir:backupDir,data:candidate};
 assert.throws(()=>recovery.create(target),overLimit);assert.equal(target.lastBackupAt,undefined);assert.deepEqual(fs.readdirSync(backupDir),[]);
 fs.mkdirSync(path.join(backupDir,'backups'));const id='backup-2026T10-18-12345678.json',file=path.join(backupDir,'backups',id);fs.writeFileSync(file,'{}');fs.truncateSync(file,200_000_001);
 assert.throws(()=>recovery.read(target,id),/过大/);assert.equal(hash(a.data),prior);
});

test('unknown exception receipts remain attributable and safe without changing retry or permission semantics',async t=>{
 const {a,job,dir}=await fixture(t);a.platformRequest=async()=>{throw Error('opaque PRIVATE_TOKEN https://private.invalid/?secret=value');};
 const result=await act(a,job);assert.equal(result.errorCode,'INVALID_PLATFORM_RESPONSE');assert.match(result.receipt.diagnostics.errorSha256,/^[a-f0-9]{64}$/);assert.equal(result.receipt.diagnostics.stage,'request');
 assert.equal(result.receipt.classificationBasis,'unknown_response');assert.equal(result.retryAt,undefined);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_TOKEN|private.invalid|secret=value/);a.save();
 assert.doesNotMatch(fs.readFileSync(path.join(dir,'workspace.json'),'utf8'),/PRIVATE_TOKEN|private.invalid|secret=value/);
});

test('manifest-only sources use existing read ACL and revoked query authority blocks even cached evidence dispatch',async t=>{
 const {a,job}=await fixture(t);a.platformRequest=async()=>bulky();const r=await act(a,job),s=a.data.sources.find(s=>s.id===r.sourceId);
 const foreign=agent.buildJob(a,{goal:'unrelated fixture',dataPlatform:'sg-readonly'});a.data.delegations.push(foreign);
 await assert.rejects(agent.act(a,foreign,'read_platform',{sourceId:s.id}));
 s.deleted=true;await assert.rejects(agent.act(a,job,'read_platform',{sourceId:s.id}));
 const denied=await agent.act(a,job,'read_source',{sourceId:s.id});assert.equal(denied.ok,false);assert.equal(denied.content,undefined);assert.equal(denied.segments,undefined);
 policy.revoke(a,{principalScope:{kind:'account',provider:'platform',subject:'alice'},resourceScope:{kind:'platform',key:'sg-readonly',jobId:job.id},operations:['platform_query']},authorization);
 a.platformRequest=deny;await assert.rejects(act(a,job));
});
