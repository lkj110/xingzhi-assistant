'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks'),crypto=require('node:crypto');
const deny=()=>{throw Error('controlled integration forbids real model/network/connector');};
require('node:child_process').spawn=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
const {fixture}=require('./root-relation-fixture.cjs'),f=require('./root-relation-physical-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),links=require('../desktop/evidence-links.cjs'),e=require('../desktop/evidence-basis.cjs');
const p=require('../desktop/platform-result.cjs'),context=require('../desktop/task-context.cjs'),policy=require('../desktop/access-policy-store.cjs'),backup=require('../desktop/recovery.cjs');
function representation(snapshot,kind){
 if(kind==='inline')return {snapshot,sourceMeta:{}};
 if(kind==='v2')return p.split(p.prepare(snapshot,{principal:null,projectId:null,scope:'sg-readonly'}));
 const raw=Buffer.from(JSON.stringify(e.canonical(snapshot.data))),data=p.projectData(snapshot.data),platformResult={version:1,format:'coral-structural-v1',codec:'gzip-base64',rawBytes:raw.length,rawSha256:p.digest(raw),projectionSha256:p.digest(JSON.stringify(e.canonical(data))),dataView:'structural_projection',originalDataRetained:true};
 return {snapshot:{...snapshot,data,platformResult},sourceMeta:{platformArchive:{...platformResult,body:require('node:zlib').gzipSync(raw).toString('base64')}}};
}
function add(v,snapshot,kind){
 const stored=representation(snapshot,kind),s=v.source('table_lineage',{},snapshot.query,{},false);
 Object.assign(s,{content:JSON.stringify(stored.snapshot),...stored.sourceMeta});s.hash=e.hash(s.content);return s;
}

test('typed physical facts and existing recovery budget remain identical through inline/v1/v2 sources',t=>{
 const v=fixture(t,{kinds:'物理表血缘'}),mapping=v.source('outputs',{taskId:123,outputs:[{type:'partition',storageRegion:'sg',databaseName:'db',tableName:'out'}]});
 const s=f.snapshot();s.data.guidEntityMap.out.attributes.parameters='controlled '.repeat(60000);
 const o=r.required(v.a,v.job,v.task)[0],need=()=>v.need({requirements:[o.id],gaps:['入口123物理表血缘缺失']});
 need();const first=add(v,s,'inline');v.resolve([first.id,mapping.id]);
 const facts=r.recoveryFacts(v.a,v.job,v.task);assert.equal(facts.length,2);const quota={callsUsed:v.job.callsUsed,usage:v.job.usage};
 const ids=[first.id,mapping.id];
 for(const kind of ['v1','v2']){
  need();const next=add(v,s,kind);ids.push(next.id);v.resolve(ids);
  assert.deepEqual(r.recoveryFacts(v.a,v.job,v.task),facts);assert.equal(v.task.lastEvidenceResolution.recoveryProof,undefined);
  assert.equal(r.physicalContext(v.a,v.job,v.task).closureProven,true);
  assert.deepEqual({callsUsed:v.job.callsUsed,usage:v.job.usage},quota);
 }
 const archived=v.a.data.sources.find(s=>s.platformArchive?.chunks);archived.platformArchive.chunks[0].body='AAAA';
 assert.throws(()=>r.physicalContext(v.a,v.job,v.task),error=>error.code==='LOCAL_RESULT_INTEGRITY');
 assert.throws(()=>r.evidenceNeeds(v.a,v.job,v.task),error=>error.code==='LOCAL_RESULT_INTEGRITY');
});

test('backup restore and process restart preserve archive and current denied source ACL',t=>{
 const v=fixture(t,{kinds:'物理表血缘'}),s=f.snapshot();s.data.guidEntityMap.out.attributes.parameters='controlled '.repeat(60000);
 const source=add(v,s,'v2');links.setInputs(v.a,v.task,[source.id]);v.a.save();const id=backup.create(v.a);
 const scope={kind:'job',jobId:v.job.id},request={tool:'read_source',sourceId:source.id};assert.equal(context.resolveRead(v.a,scope,request).ok,true);
 const grant={principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+source.id,jobId:v.job.id,taskId:v.task.id},operations:['local_read']};
 policy.revoke(v.a,grant,{trusted:true,actor:'user_command',command:'controlled'});
 backup.restore(v.a,id);assert.equal(context.resolveRead(v.a,scope,request).ok,false);
 const {Assistant}=require('../desktop/core.cjs'),restarted=new Assistant({dir:v.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});
 t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(restarted));
 assert.equal(context.resolveRead(restarted,scope,request).ok,false);
 assert.deepEqual(restarted.data.sources.find(row=>row.id===source.id).platformArchive,source.platformArchive);
});

test('large graph prepare/hydrate memory and runtime are measured on controlled data',t=>{
 const snapshot=f.snapshot('out',Array.from({length:3000},(_,i)=>'n'+i));snapshot.data.guidEntityMap.out.attributes.parameters=crypto.randomBytes(700000).toString('hex');
 const start=performance.now(),rss=process.memoryUsage().rss,internal=p.prepare(snapshot),prepared=performance.now(),split=p.split(internal),restored=p.restore(split.snapshot,split.sourceMeta);
 t.diagnostic(JSON.stringify({rawBytes:internal.platformResult.rawBytes,compressedBytes:internal.platformResult.compressedBytes,chunkCount:internal.platformResult.chunkCount,prepareMs:Math.round(prepared-start),validateSplitAndHydrateMs:Math.round(performance.now()-prepared),rssDeltaBytes:process.memoryUsage().rss-rss}));
 assert.deepEqual(restored,snapshot.data);assert.ok(internal.platformResult.chunkCount>5);
});
