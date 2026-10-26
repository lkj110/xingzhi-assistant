'use strict';
// Local source preparation only; a prior verdict is never evidence for this check.
const protocol=require('./task-context.cjs'),batches=require('./context-batch.cjs');
const MAX_CHARS=48000,MAX_SOURCES=8;
const whole=row=>row.request?.tool==='read_source'&&row.result?.ok&&row.result.complete&&row.result.start===0&&row.result.next===null&&row.result.coverage?.complete===true&&!row.result.bodyOmitted&&!row.result.truncated;
function prepare(a,job,context,{maxChars=MAX_CHARS,maxSources=MAX_SOURCES}={}){
 if(!Number.isSafeInteger(maxChars)||maxChars<1||maxChars>MAX_CHARS||!Number.isSafeInteger(maxSources)||maxSources<1||maxSources>MAX_SOURCES)throw TypeError('Invalid goal evidence budget');
 const scope={kind:'job',jobId:job.id},rows=[],used=[],prepared=[],deferred=[];
 let remaining=maxChars;
 const snapshot=protocol.buildContext(a,scope,'verify');
 const sources=snapshot.readableCatalog.filter(s=>s.type==='source'&&s.purpose==='input'&&!s.ambiguous);
 const existing=batches.mergeReadRows(context.contextReads||[]),complete=new Set(existing.filter(whole).map(r=>r.result.sourceId+':'+r.result.version));
 for(const source of sources){
  if(complete.has(source.id+':'+source.version))continue;
  const request={tool:'read_source',sourceId:source.id,version:source.version,start:0};
  if(prepared.length>=maxSources||remaining<=0){deferred.push({sourceId:source.id,reason:'preparation_limit',resumeRequest:request});continue;}
  require('./execution-gate.cjs').assert(a,{job,readOnly:true});protocol.assertCurrent(a,scope,snapshot);
  const batch=require('./generation-context.cjs').readBatch(a,scope,[request],{maxChars:remaining,maxPages:64,resolverOptions:{purpose:'verify'}});
  protocol.assertCurrent(a,scope,snapshot);
  for(const row of batch.rows)if(row.result.ok!==true)throw require('./model-errors.cjs').contextError(row.result.code||'CONTEXT_VERSION_CHANGED',row.result);
  rows.push(...batch.rows);used.push(...batch.used);remaining-=batch.stats.characters;prepared.push(source.id);
 }
 return {rows:batches.mergeReadRows([...existing,...rows]),used,diagnostic:{version:'goal-evidence-v1',preparedSourceIds:prepared,deferred,characters:maxChars-remaining,note:'仅记录本次有界原文准备，不代表模型已完整阅读或核验；实际提供范围以 contextReads 的正文、coverage、next 为准。例外未读完须继续取证，不能借用旧通过结论。'}};
}
module.exports={prepare,MAX_CHARS,MAX_SOURCES};
