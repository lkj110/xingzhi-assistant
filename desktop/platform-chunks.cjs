'use strict';
// Byte codec only. Authorization and transaction ownership remain with callers.
const crypto=require('node:crypto');
const {gzipSync,inflateRawSync,crc32}=require('node:zlib');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const json=v=>JSON.stringify(canonical(v));
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const hash=v=>digest(json(v));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const CHUNK=131072,COUNT=192,COMPRESSED=CHUNK*COUNT/4*3;
const directory=()=>({dataView:'manifest_only',incomplete:true,note:'完整脱敏数据保存在同一来源归档。此目录没有图实体或边；须经来源权限后分页读取。'});
function integrity(reason,extra={}){return Object.assign(Error('本地平台结果完整性校验失败，不能使用部分内容或自动重新取得。'),{code:'LOCAL_RESULT_INTEGRITY',classificationBasis:'local_result_integrity',diagnostics:{stage:'storage',reason,...extra}});}
function storageFailure(reason,extra={}){return Object.assign(Error('本地平台结果超过存储资源上限，未保存为成功；请检查本地容量。'),{code:'LOCAL_RESULT_STORAGE',classificationBasis:'local_result_storage',diagnostics:{stage:'storage',reason,...extra}});}
const rawLimit=s=>s?.operation==='table_lineage'?16_000_000:2_000_000;
function validateShape(s,data){
 if(data===undefined||s?.operation!==s?.query?.op)throw integrity('data_shape');
 if(s.operation==='table_lineage'&&(!object(data)||!object(data.guidEntityMap)))throw integrity('data_shape');
 if(['identity','task','table','upstream','downstream'].includes(s.operation)&&!object(data))throw integrity('data_shape');
 if(['upstream','downstream'].includes(s.operation)&&data.nodes!==undefined&&!Array.isArray(data.nodes))throw integrity('data_shape');
}
function envelope(snapshot){const {data,platformResult,platformArchive,...rest}=snapshot;return rest;}
function bindingScope(scope={}){
 return canonical({principal:scope.principal??null,projectId:scope.projectId??null,scope:scope.scope??null,permissionRevision:scope.permissionRevision??null,operationId:scope.operationId??null,sourceId:scope.sourceId??null,sourceVersion:scope.sourceVersion??null});
}
function bindingHash(snapshot,binding){return hash({envelopeHash:hash(envelope(snapshot)),query:require('./platform-boundaries.cjs').canonicalQuery(snapshot.query),operation:snapshot.operation,...binding});}
function prepare(snapshot,raw,scope){
 let compressed;try{compressed=gzipSync(raw,{level:9});}catch{throw storageFailure('compressed_limit',{rawBytes:raw.length});}
 if(compressed.length>COMPRESSED)throw storageFailure('compressed_limit',{compressedBytes:compressed.length});
 const encoded=compressed.toString('base64'),chunks=[];
 for(let i=0;i<encoded.length;i+=CHUNK)chunks.push({index:chunks.length,body:encoded.slice(i,i+CHUNK)});
 if(chunks.length>COUNT)throw storageFailure('chunk_limit');
 const binding=bindingScope(scope);
 const platformResult={version:2,format:'platform-chunks-v2',codec:'gzip-base64-chunks',dataView:'manifest_only',rawBytes:raw.length,rawSha256:digest(raw),compressedBytes:compressed.length,compressedSha256:digest(compressed),encodedChars:encoded.length,chunkCount:chunks.length,descriptors:chunks.map(c=>({index:c.index,encodedChars:c.body.length,sha256:digest(c.body)})),envelopeHash:hash(envelope(snapshot)),bindingHash:bindingHash(snapshot,binding)};
 const result={...snapshot,data:directory(),platformResult,platformArchive:{manifestHash:hash(platformResult),binding,chunks}};
 if(require('./platform-storage-capacity.cjs').sizes({...result,platformArchive:undefined}).pretty>500000)throw storageFailure('snapshot_limit',{rawBytes:raw.length});
 restore(result); // Do not hand a success to the transaction before all checks.
 return result;
}
const manifestKeys=['version','format','codec','dataView','rawBytes','rawSha256','compressedBytes','compressedSha256','encodedChars','chunkCount','descriptors','envelopeHash','bindingHash'];
function validateManifest(snapshot){
 const r=snapshot?.platformResult;
 if(!object(r)||Object.keys(r).length!==manifestKeys.length||manifestKeys.some(k=>!Object.hasOwn(r,k))||r.version!==2||r.format!=='platform-chunks-v2'||r.codec!=='gzip-base64-chunks'||r.dataView!=='manifest_only')throw integrity('archive_invalid');
 if(!Number.isSafeInteger(r.rawBytes)||r.rawBytes<1||r.rawBytes>rawLimit(snapshot)||!Number.isSafeInteger(r.compressedBytes)||r.compressedBytes<18||r.compressedBytes>COMPRESSED||!Number.isSafeInteger(r.encodedChars)||r.encodedChars!==4*Math.ceil(r.compressedBytes/3)||!Number.isSafeInteger(r.chunkCount)||r.chunkCount<1||r.chunkCount>COUNT||r.chunkCount!==Math.ceil(r.encodedChars/CHUNK))throw integrity('archive_invalid');
 if(!['rawSha256','compressedSha256','envelopeHash','bindingHash'].every(k=>hex(r[k]))||!Array.isArray(r.descriptors)||r.descriptors.length!==r.chunkCount)throw integrity('archive_invalid');
 for(let i=0;i<r.chunkCount;i++){const d=r.descriptors[i];if(!object(d)||Object.keys(d).sort().join(',')!=='encodedChars,index,sha256'||d.index!==i||d.encodedChars!==(i<r.chunkCount-1?CHUNK:r.encodedChars-i*CHUNK)||!hex(d.sha256))throw integrity('archive_invalid');}
 if(hash(envelope(snapshot))!==r.envelopeHash||json(snapshot.data)!==json(directory()))throw integrity('archive_integrity');
 return r;
}
function decode(encoded){
 // Buffer.from(base64) is deliberately permissive. Round trip and alphabet
 // checks reject whitespace, ignored suffixes, missing padding and unused bits.
 if(encoded.length%4||/[^A-Za-z0-9+/=]/.test(encoded)||!encoded.length)throw integrity('archive_integrity');
 const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw integrity('archive_integrity');return bytes;
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);return c;});
function crc(bytes){
 if(crc32)return crc32(bytes); // Electron runtimes predating node:zlib.crc32.
 let c=0xffffffff;for(const b of bytes)c=(c>>>8)^crcTable[(c^b)&255];return (c^0xffffffff)>>>0;
}
function inflate(bytes,limit){
 // gunzip accepts concatenated members and trailing zeroes. Locate the exact
 // single DEFLATE member and verify its trailer instead of accepting a prefix.
 if(bytes.length<18||bytes[0]!==31||bytes[1]!==139||bytes[2]!==8||(bytes[3]&0xe0))throw integrity('archive_integrity');
 const flags=bytes[3];let at=10;
 if(flags&4){if(at+2>bytes.length-8)throw integrity('archive_integrity');at+=2+bytes.readUInt16LE(at);}
 for(const bit of [8,16])if(flags&bit){while(at<bytes.length-8&&bytes[at]!==0)at++;at++;}
 if(flags&2){if(at+2>bytes.length-8||(crc(bytes.subarray(0,at))&0xffff)!==bytes.readUInt16LE(at))throw integrity('archive_integrity');at+=2;}
 if(at>bytes.length-8)throw integrity('archive_integrity');
 const decoded=inflateRawSync(bytes.subarray(at),{maxOutputLength:limit,info:true});
 const end=at+decoded.engine.bytesWritten,raw=decoded.buffer;
 if(end+8!==bytes.length||bytes.readUInt32LE(end)!==crc(raw)||bytes.readUInt32LE(end+4)!==(raw.length>>>0))throw integrity('archive_integrity');
 return raw;
}
function checkBinding(snapshot,a,source){
 if(!object(a.binding)||json(a.binding)!==json(bindingScope(a.binding))||bindingHash(snapshot,a.binding)!==snapshot.platformResult.bindingHash)throw integrity('binding_mismatch');
 for(const [key,field] of [['principal','platformPrincipal'],['projectId','projectId'],['scope','platformScope'],['permissionRevision','platformPermissionRevision'],['operationId','platformOperationId'],['sourceId','id'],['sourceVersion','version']]){
  if(Object.hasOwn(source,field)&&(a.binding[key]!==null||['principal','projectId'].includes(key))&&json(source[field]??null)!==json(a.binding[key]))throw integrity('binding_mismatch');
 }
}
function restore(snapshot,source={}){
 try{
  const r=validateManifest(snapshot),a=source.platformArchive??snapshot.platformArchive;
  if(!object(a)||a.manifestHash!==hash(r)||!Array.isArray(a.chunks)||a.chunks.length!==r.chunkCount)throw integrity('archive_invalid');
  checkBinding(snapshot,a,source);
  for(let i=0;i<r.chunkCount;i++){const c=a.chunks[i],d=r.descriptors[i];if(!object(c)||c.index!==i||Object.keys(c).sort().join(',')!=='body,index'||typeof c.body!=='string'||c.body.length!==d.encodedChars||digest(c.body)!==d.sha256)throw integrity('archive_integrity');}
  const compressed=decode(a.chunks.map(c=>c.body).join(''));
  if(compressed.length!==r.compressedBytes||digest(compressed)!==r.compressedSha256)throw integrity('archive_integrity');
  const raw=inflate(compressed,r.rawBytes);
  if(raw.length!==r.rawBytes||digest(raw)!==r.rawSha256)throw integrity('archive_integrity');
  const data=JSON.parse(raw.toString('utf8'));
  if(!Buffer.from(json(data)).equals(raw))throw integrity('archive_integrity');
  validateShape(snapshot,data);return data;
 }catch(error){if(error.code==='LOCAL_RESULT_INTEGRITY')throw error;throw integrity('archive_integrity');}
}
module.exports={prepare,restore,validateManifest,decode,inflate,integrity,storageFailure,rawLimit,validateShape};
