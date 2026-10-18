'use strict';
// Same-source, lossless storage. No filesystem, transport, ACL or retry policy.
const crypto=require('node:crypto');
const chunks=require('./platform-chunks.cjs');
const {integrity,storageFailure,rawLimit,validateShape}=chunks;
const {canonical}=require('./evidence-basis.cjs');
const limits=Object.freeze({ordinaryBytes:2_000_000,lineageBytes:16_000_000,archiveChars:350_000,chunkChars:131072,maxChunks:192,compressedBytes:18_874_368});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const relationKeys=['inputs','outputs','inputToProcesses','outputFromProcesses'];
// Include every identity/conflict field consumed by physical-lineage-coverage
// and relation-obligations. Missing, malformed and contradictory values survive.
const fields=new Set(('guid typeName id name qualifiedName parentName dbName database table cid owner userNames userNamesDisplay status taskStatus taskType scheduleType projectId region storageRegion cluster clusterName analyzeResult errorMessage hasAuth canAccess accessDeniedMsg crossRegion complete coverage truncated hasMore has_more noMore next nextPage next_page nextCursor page pagination error sourceFlags').split(' '));
function projectEntity(value,depth=0){
 if(depth>64)throw failure('projection_depth');
 if(!object(value))return value;
 return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>{
  if(key==='attributes')return [[key,projectEntity(item,depth+1)]];
  if(relationKeys.includes(key))return [[key,Array.isArray(item)?item.map(v=>projectEntity(v,depth+1)):item]];
  return fields.has(key)||/auth|permission|denied|error|partial|truncat|incomplete/i.test(key)?[[key,item]]:[];
 }));
}
function projectData(data){
 if(!object(data)||!object(data.guidEntityMap))throw failure('projection_shape');
 // Keep ALL envelope fields, counts, layer order and map keys. In particular,
 // never synthesize node.guid from its map key or replace absent arrays by [].
 return {...data,guidEntityMap:Object.fromEntries(Object.entries(data.guidEntityMap).map(([guid,node])=>[guid,projectEntity(node)]))};
}
const failure=integrity;
// Scope is supplied by trusted local code, never by the model or snapshot.
function prepare(snapshot,scope={}){
 if(snapshot?.platformResult!==undefined){restore(snapshot,scope.sourceMeta||{});return snapshot;}
 if(snapshot?.platformArchive!==undefined)throw integrity('archive_invalid');
 const raw=Buffer.from(JSON.stringify(canonical(snapshot.data))??'');
 const info={rawBytes:raw.length,rawSha256:digest(raw)};
 if(scope.stdoutComplete===false)throw integrity('stdout_limit');
 if(!raw.length||raw.length>rawLimit(snapshot))throw storageFailure('raw_limit',info);
 validateShape(snapshot, snapshot.data);
 if(raw.length<=require('./documents.cjs').maxChars&&require('./platform-storage-capacity.cjs').sizes(snapshot).pretty<=require('./documents.cjs').maxChars)return snapshot;
 return chunks.prepare(snapshot,raw,scope);
}
function validateManifest(snapshot){
 const r=snapshot?.platformResult;
 if(r?.version===2)return chunks.validateManifest(snapshot);
 if(!object(r)||snapshot.operation!=='table_lineage'||r.version!==1||r.format!=='coral-structural-v1'||r.codec!=='gzip-base64'||!Number.isSafeInteger(r.rawBytes)||r.rawBytes<1||r.rawBytes>limits.lineageBytes||!(/^[a-f0-9]{64}$/).test(r.rawSha256)||!(/^[a-f0-9]{64}$/).test(r.projectionSha256)||r.dataView!=='structural_projection'||r.originalDataRetained!==true)throw integrity('archive_invalid');
 if(digest(JSON.stringify(canonical(snapshot.data)))!==r.projectionSha256)throw integrity('archive_integrity');
 return r;
}
function restore(snapshot,sourceMeta={}){
 if(snapshot?.platformResult===undefined){
  if(snapshot?.platformArchive!==undefined||sourceMeta?.platformArchive!==undefined)throw integrity('archive_invalid');
  return snapshot?.data;
 }
 if(snapshot.platformResult.version===2)return chunks.restore(snapshot,sourceMeta);
 const r=validateManifest(snapshot),a=sourceMeta.platformArchive??snapshot.platformArchive;
 if(!object(a)||['version','format','codec','rawBytes','rawSha256','projectionSha256','dataView','originalDataRetained'].some(k=>a[k]!==r[k])||typeof a.body!=='string'||!a.body.length||a.body.length>limits.archiveChars)throw integrity('archive_invalid');
 try{
  const encoded=chunks.decode(a.body),raw=chunks.inflate(encoded,r.rawBytes);
  if(raw.length!==r.rawBytes||digest(raw)!==r.rawSha256)throw integrity('archive_integrity');
  const data=JSON.parse(raw.toString('utf8'));
  if(digest(JSON.stringify(canonical(projectData(data))))!==r.projectionSha256)throw integrity('archive_integrity');
  return data;
 }catch{throw integrity('archive_integrity');}
}
function split(snapshot,sourceMeta={}){
 restore(snapshot,sourceMeta);
 const {platformArchive,...publicSnapshot}=snapshot;
 const archive=sourceMeta.platformArchive??platformArchive;
 return {snapshot:publicSnapshot,sourceMeta:archive?{platformArchive:archive}:{}};
}
// Internal only: the caller must have checked the current source ACL. Never
// accepts a path, reads a file, grants access, or falls back to a directory.
function fullSnapshot(source){
 if(!object(source)||source.platformSnapshot!==true||typeof source.content!=='string')throw integrity('archive_invalid');
 let snapshot;try{snapshot=JSON.parse(source.content);}catch{throw integrity('archive_invalid');}
 const data=restore(snapshot,source),{platformResult,platformArchive,...envelope}=snapshot;
 return {...envelope,data};
}
function dataDigest(snapshot,sourceMeta){
 if(sourceMeta!==undefined||snapshot.platformArchive)return digest(JSON.stringify(canonical(restore(snapshot,sourceMeta)))??'undefined');
 return snapshot.platformResult?validateManifest(snapshot).rawSha256:digest(JSON.stringify(canonical(snapshot.data))??'undefined');
}
function manifest(snapshot){
 const r=snapshot?.platformResult;
 if(!r)return undefined;
 validateManifest(snapshot);
 if(r.version===2)return {...r,note:'仅为完整存储目录，不是完整图。按来源权限通过 restorePlatformData 恢复全文，再使用 read_platform/read_source 分页。',originalDataRetained:true};
 return {version:r.version,format:r.format,codec:r.codec,rawBytes:r.rawBytes,rawSha256:r.rawSha256,projectionSha256:r.projectionSha256,
  dataView:'structural_projection',originalDataRetained:true,
  note:'当前 data 仅保留全实体结构字段；原文须经原来源权限检查后用 restorePlatformData 恢复并分段读取；投影不证明整体血缘闭合。'};
}
function storageIntegrityVersion(source){
 let snapshot;try{snapshot=JSON.parse(source.content);}catch{return digest(source.content||'');}
 return digest(JSON.stringify(canonical({content:snapshot,archive:source.platformArchive})));
}
// Fixed vocabulary prevents arbitrary caller errors becoming persisted text.
const reasons=new Set(['snapshot_limit','raw_limit','structural_limit','archive_limit','projection_depth','projection_shape','archive_invalid','archive_integrity','stdout_limit','process_exit','transport_error','binding_mismatch','data_shape','compressed_limit','chunk_limit','storage_capacity']);
function diagnostics(value={}){
 const out={};
 if(['storage','transport','parse','request'].includes(value.stage))out.stage=value.stage;
 if(reasons.has(value.reason))out.reason=value.reason;
 for(const k of ['rawBytes','snapshotChars','limitChars','archiveChars','stdoutBytes','stderrBytes','limitBytes','compressedBytes','encodedChars','chunkCount','workspaceBytes','backupBytes'])if(Number.isSafeInteger(value[k])&&value[k]>=0)out[k]=value[k];
 for(const k of ['rawSha256','stdoutSha256','stderrSha256','errorSha256'])if(typeof value[k]==='string'&&/^[a-f0-9]{64}$/.test(value[k]))out[k]=value[k];
 if(typeof value.stdoutComplete==='boolean')out.stdoutComplete=value.stdoutComplete;
 return out;
}
module.exports={prepare,restore,split,dataDigest,manifest,projectData,limits,digest,diagnostics,fullSnapshot,storageIntegrityVersion,validateManifest};
