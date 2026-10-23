'use strict';
// Model-facing projection only. Resolver receipts, read coverage and guards keep
// the full originals. Never merge different versions, ranges, errors or sources.
const VERSION='receipt-input-v2';
const IMPLEMENTATION_HASH=require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex');
const fields=['generationEvidence','contextReads','requestedSections','retrievedEvidence'];
const allowed=/^(generationEvidence|requestedSections|retrievedEvidence)\[\d+\]$|^contextReads\[\d+\]\.result$/;
const at=(root,path)=>path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],root);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function entries(root){return fields.flatMap(key=>(root[key]||[]).map((row,i)=>({row:key==='contextReads'?row.result:row,path:`${key}[${i}]${key==='contextReads'?'.result':''}`,set:value=>{if(key==='contextReads')root[key][i].result=value;else root[key][i]=value;}})));}
function expand(context){
 const result=structuredClone(context);
 for(const {row,set} of entries(result))if(row?.receiptRef){
  const source=typeof row.receiptRef==='string'&&allowed.test(row.receiptRef)?at(context,row.receiptRef):null;
  // Only direct same-identity references; missing/cyclic refs supply no body.
  if(source&&!source.receiptRef&&source.sourceId===row.sourceId&&source.artifactId===row.artifactId&&source.version===row.version)set(structuredClone(source));
 }
 for(const row of result.contextReads||[]){const stub=row?.result?.computedEvidence;
  if(!stub?.toolEvidenceRef)continue;
  const source=typeof stub.toolEvidenceRef==='string'&&/^toolEvidence\[\d+\]$/.test(stub.toolEvidenceRef)?at(context,stub.toolEvidenceRef):null;
  if(source&&!source.toolEvidenceRef&&source.id===stub.id&&source.version===stub.version&&source.contentHash===stub.contentHash)row.result.computedEvidence=structuredClone(source);
 }
 return result;
}
function project(context,{toolReferences=false}={}){
 const result=structuredClone(context),targets=[];
 const refs=[];
 const scan=value=>{if(!value||typeof value!=='object')return;for(const [k,v] of Object.entries(value)){if(['contentRef','textRef','originalContentRef'].includes(k)&&v?.path)refs.push(v.path);else scan(v);}};scan(context);
 // Reconstruct bodies for equality only. Never move canonical body targets.
 const hydrated=require('./model-input.cjs').materialize(context),full=new Map(entries(hydrated).map(r=>[r.path,r.row]));
 let duplicates=0,omittedFields=0,toolDuplicates=0;
 for(const {row,path,set} of entries(result)){
  if(!row||row.ok!==true||!row.version||(!row.sourceId&&!row.artifactId)||row.directoryOnly)continue;
  const signature=JSON.stringify(stable(full.get(path)));
  const same=targets.find(r=>r.signature===signature);
  if(same&&!refs.some(ref=>ref.startsWith(path+'.'))){
   const stub={...(row.sourceId?{sourceId:row.sourceId}:{}),...(row.artifactId?{artifactId:row.artifactId}:{}),version:row.version,receiptRef:same.path};
   if(JSON.stringify(stub).length<JSON.stringify(row).length){set(stub);duplicates++;continue;}
  }
  targets.push({path,signature});
  // Only values provably duplicated in this exact input are omitted.
  if(row.contextRevision&&row.contextRevision===context.contextRevision){delete row.contextRevision;omittedFields++;}
  if(row.canonical?.schema===1){
   const c=row.canonical,id=row.sourceId||row.artifactId,type=row.sourceId?'source':'artifact';
   if(c.version===row.version){delete c.version;omittedFields++;}
   if(c.resource===type+':'+id){delete c.resource;omittedFields++;}
   // schema is only the local canonical-coordinate implementation marker.
   delete c.schema;omittedFields++;
   if(!Object.keys(c).length)delete row.canonical;
  }
 }
 if(toolReferences)for(const row of result.contextReads||[]){const evidence=row?.result?.computedEvidence;
  if(row?.result?.ok!==true||!evidence?.id||!evidence.version||!evidence.contentHash||evidence.toolEvidenceRef)continue;
  const index=(context.toolEvidence||[]).findIndex(target=>!target.toolEvidenceRef&&JSON.stringify(stable(target))===JSON.stringify(stable(evidence)));
  if(index<0||refs.some(ref=>ref.startsWith('contextReads['+result.contextReads.indexOf(row)+'].result.computedEvidence.')))continue;
  const stub={id:evidence.id,version:evidence.version,contentHash:evidence.contentHash,toolEvidenceRef:`toolEvidence[${index}]`};
  if(JSON.stringify(stub).length<JSON.stringify(evidence).length){row.result.computedEvidence=stub;toolDuplicates++;}
 }
 if(!duplicates&&!omittedFields&&!toolDuplicates)return context;
 if(duplicates)result.receiptReferenceNote='receiptRef指向本次输入中同来源、版本及范围的完整回执，直接复用其正文和元数据。';
 if(toolDuplicates)result.toolEvidenceReferenceNote='toolEvidenceRef直接引用本次输入中同ID、版本、contentHash的完整toolEvidence回执。';
 // Do not increase a short request just to carry the projection explanation.
 return JSON.stringify(result).length<JSON.stringify(context).length?result:context;
}
module.exports={VERSION,IMPLEMENTATION_HASH,project,expand};
