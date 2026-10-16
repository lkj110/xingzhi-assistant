// Bounded local reads. Pages share an operation-local immutable catalog. Every
// external callback ends that operation's snapshot, even on the final page.
const protocol=require('./task-context.cjs');
const {hash}=require('./evidence-basis.cjs');
const {contextError,contextResult}=require('./model-errors.cjs');
const defaults=Object.freeze({maxPages:64,maxChars:160000});
const failure=message=>contextResult(contextError('CONTEXT_INVALID_REQUEST',{message}));
const identity=r=>hash([r.ref,r.version,r.policyRevision,r.purpose,r.state]);
const bodySize=r=>r.content?.length??(r.segments||[]).reduce((n,s)=>n+s.text.length,0);
const bodyKey=r=>hash({content:r.content,segments:r.segments});
function checkedPage(operation,request,contextRevision,cache,stats,cacheRows){
 const fresh=operation.resolveRead(request,contextRevision);
 if(!fresh.ok)return fresh;
 const key=identity(fresh);
 // Persisted receipts can warm the cache after restart, but only after current
 // scope/version/policy validation and an integrity check of their saved body.
 if(!cache.has(key))for(const row of cacheRows.get(key)||[])if(row.bodyHash&&row.bodyHash===bodyKey(row.result)&&operation.validRead(row))remember(cache,row);
 const saved=cache.get(key);
 let page={...fresh};
 if(fresh.segments){
  const segments=operation.sourceSegments(fresh.sourceId);
  page.segments=fresh.segments.map(segment=>{
   const previous=saved?.segments.get(segment.index);
   // Index, rather than text/id alone, preserves repeated paragraphs and duplicate IDs.
   if(previous&&previous.id===segment.id&&previous.text===segments[segment.index]?.text&&previous.text.slice(0,8000)===segment.text){stats.cacheHits++;return {...segment,text:previous.text,truncated:false};}
   if(!segment.truncated)return {...segment};
   const original=segments[segment.index];
   if(!original||original.id!==segment.id||original.text.slice(0,8000)!==segment.text)throw contextError('CONTEXT_VERSION_CHANGED');
   return {...segment,text:original.text,truncated:false};
  });
 }else if(saved){
  const range=saved.ranges.find(r=>r.start<=fresh.start&&r.start+r.content.length>=fresh.start+fresh.content.length);
  if(range){const content=range.content.slice(fresh.start-range.start,fresh.start-range.start+fresh.content.length);if(content===fresh.content){page.content=content;stats.cacheHits++;}}
 }
 // Expansion uses the same frozen body that was authorized, without a callback
 // or asynchronous boundary. The single-page resolver contract is unchanged.
 page.coverage={...fresh.coverage,complete:fresh.start===0&&fresh.next===null&&request.tool!=='search_source'};
 return page;
}
function remember(cache,row){
 const r=row.result,key=identity(r);let saved=cache.get(key);
 if(!saved)cache.set(key,saved={segments:new Map(),ranges:[],characters:0});
 if(r.segments)for(const s of r.segments){if(!saved.segments.has(s.index))saved.characters+=s.text.length;saved.segments.set(s.index,{id:s.id,text:s.text});}
 else if(!saved.ranges.some(p=>p.start===r.start&&p.content===r.content)){saved.ranges.push({start:r.start,content:r.content});saved.characters+=r.content.length;}
 // Cache eviction never evicts dependency receipts or changes completion status.
 let size=[...cache.values()].reduce((n,s)=>n+s.characters,0);
 for(const [id,s] of cache){if(size<=1000000)break;cache.delete(id);size-=s.characters;}
}
function resultOf(request,pages,next,reason,requiredChars){
 if(!pages.length)return {ok:true,pending:true,complete:false,start:request.start??0,next,cursor:next,more:true,stopReason:reason,...(requiredChars?{requiredChars}:{}),coverage:{start:request.start??0,next,reachesEnd:false,complete:false}};
 const first=pages[0].result,last=pages.at(-1).result;
 const result={...first,start:request.start??0,next,cursor:next,more:next!==null,complete:next===null,stopReason:reason||null,
  coverage:{...first.coverage,next,reachesEnd:next===null,complete:(request.start??0)===0&&next===null&&request.tool!=='search_source'},
  pages:pages.length,...(requiredChars?{requiredChars}:{})};
 if(first.segments){const seen=new Set();result.segments=pages.flatMap(p=>p.result.segments).filter(s=>{if(seen.has(s.index))return false;seen.add(s.index);return true;});}
 else result.content=pages.map(p=>p.result.content).join('');
 if(request.tool==='search_source')result.matchesComplete=next===null;
 result.contextRevision=last.contextRevision;
 return result;
}
/**
 * readContextBatch(a, trustedScope, requests, options)
 * requests: 1-4 unchanged protocol requests. limit is PAGE size, not total size.
 * options: maxPages (1-256), maxChars (1-500000), contextRevision, resolverOptions,
 *          onRead(row) (trusted synchronous observer, called for every successful page).
 * rows: one merged result per request; pageRows/used: all successful page receipts.
 * complete means the requested suffix/matches reached the end. coverage.complete
 * additionally requires start=0 and a non-search request; source coverage is retained.
 * next: {index,request,reason,requiredChars?} entries. A large atomic segment can
 * require a larger maxChars; it is never silently cut or falsely marked complete.
 */
function readContextBatch(a,scope,requests,options={},pageRows=[]){
 // Internal receipt sink lets persistence wrappers retain partial success on
 // cancellation without adding a callback (and invalidation) to every page.
 return protocol.withContext(a,scope,operation=>readInContext(a,scope,requests,options,operation,pageRows),options.resolverOptions||{});
}
function readInContext(a,scope,requests,options,operation,pageRows=[]){
 const rows=[],next=[],stats={pages:0,characters:0,cacheHits:0};
 const output=()=>({rows,pageRows,used:pageRows,complete:rows.length>0&&rows.every(r=>r.result.ok&&r.result.complete),next,stats});
 const maxPages=options.maxPages??defaults.maxPages,maxChars=options.maxChars??defaults.maxChars;
 if(!Array.isArray(requests)||requests.length<1||requests.length>4||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>256||!Number.isSafeInteger(maxChars)||maxChars<1||maxChars>500000){rows.push({request:null,result:failure('批读取须为 1–4 项，maxPages 为 1–256，maxChars 为 1–500000 的整数')});return output();}
 const cache=new Map(),cacheRows=new Map();
 for(const row of options.cacheRows||[]){if(!row.result?.ok)continue;const key=identity(row.result);if(!cacheRows.has(key))cacheRows.set(key,[]);cacheRows.get(key).push(row);}
 for(const [index,request] of requests.entries()){
  if(request?.tool==='list_sources'){
   try{
    const {tool,...args}=request;
    if(Object.keys(args).some(k=>!['start','limit','query','history','type','ref','taskId'].includes(k)))throw contextError('CONTEXT_INVALID_REQUEST');
    const snapshot=operation.context();
    const page=require('./context-index.cjs').page(snapshot,args);
    rows.push({request,result:{...page,ok:page.ok!==false,directoryOnly:true,complete:page.next===null}});
    if(page.next!==null)next.push({index,request:{...request,start:page.next},reason:'catalog'});
   }catch(e){if(!e.contextFailure)throw e;rows.push({request,result:contextResult(e)});}
   continue;
  }
  let cursor=request?.start??0,pages=[],error,reason,requiredChars,pin;
  try{protocol.validateRequest(request);}catch(e){if(!e.contextFailure)throw e;rows.push({request,result:contextResult(e)});continue;}
  while(cursor!==null){
   a.controller?.signal.throwIfAborted();
   if(stats.pages>=maxPages||stats.characters>=maxChars){reason=stats.pages>=maxPages?'maxPages':'maxChars';break;}
   const pageRequest={...request,start:cursor,...(pin?{version:pin.version}:{})};
   let result;
   try{result=checkedPage(operation,pageRequest,options.contextRevision,cache,stats,cacheRows);}catch(e){if(!e.contextFailure)throw e;result=contextResult(e);}
   stats.pages++;
   if(!result.ok){error=result;break;}
   if(pin&&identity(result)!==pin.identity){error=contextResult(contextError('CONTEXT_VERSION_CHANGED'));break;}
   pin||={version:result.version,identity:identity(result)};
   const remaining=maxChars-stats.characters;
   if(bodySize(result)>remaining){
    reason='maxChars';
    if(result.segments){
     let size=0,count=0;for(const s of result.segments){if(size+s.text.length>remaining){requiredChars=s.text.length;break;}size+=s.text.length;count++;}
     if(!count)break;
     result={...result,segments:result.segments.slice(0,count),next:cursor+count,cursor:cursor+count,more:true};pageRequest.limit=count;
    }else result={...result,content:result.content.slice(0,remaining),next:cursor+remaining,cursor:cursor+remaining};
    result.coverage={...result.coverage,next:result.next,reachesEnd:false,complete:false};
   }
   const row={request:pageRequest,result:{...result,complete:result.next===null},at:new Date().toISOString()};
   row.bodyHash=bodyKey(row.result);
   if(result.sourceId)row.sourceHash=operation.sourceHash(result.sourceId);
   pages.push(row);pageRows.push(row);stats.characters+=bodySize(result);remember(cache,row);
   if(options.onRead)operation.boundary(()=>options.onRead(row));
   const previous=cursor;cursor=result.next;
   if(cursor!==null&&(!Number.isSafeInteger(cursor)||cursor<=previous)){error=failure('分页游标未前进');break;}
   if(reason)break;
  }
  // A callback can revoke access/change a body between pages, including the last.
  if(!error&&pages.some(row=>!operation.validRead(row)))error=contextResult(contextError('CONTEXT_VERSION_CHANGED'));
  const result=error?{...error,complete:false,next:cursor}:resultOf(request,pages,cursor,reason,requiredChars);
  rows.push({request,result});
  if(!error&&cursor!==null)next.push({index,request:{...request,start:cursor,...(pin?{version:pin.version}:{})},reason,...(requiredChars?{requiredChars}:{})});
 }
 // Later sibling callbacks may invalidate earlier successes. Receipts stay durable,
 // but stale bodies are not returned as usable merged evidence.
 const invalidRefs=new Set(pageRows.filter(p=>!operation.validRead(p)).map(p=>p.result.ref));
 for(const row of rows)if(row.result.ok&&invalidRefs.has(row.result.ref))row.result={...contextResult(contextError('CONTEXT_VERSION_CHANGED')),complete:false};
 a.controller?.signal.throwIfAborted();
 return output();
}
// Projection only: callers must validate the input receipts in their own scope
// and retain ALL originals as used dependencies. Gaps stay separate, never filled.
function mergeReadRows(pageRows){
 const groups=new Map(),other=[];
 for(const row of pageRows||[]){
  if(!row.result?.ok||row.result.directoryOnly||row.result.bodyOmitted||row.result.truncated||(!Array.isArray(row.result.segments)&&typeof row.result.content!=='string')){other.push(row);continue;}
  const r=row.result,q=row.request||{};
  const key=hash([identity(r),q.tool,r.section,q.query?protocol.normalizeRequest(q).query:null]);
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
 }
 const merged=[];
 for(const rows of groups.values()){
  rows.sort((a,b)=>a.result.start-b.result.start);
  let current,end;
  for(const row of rows){
   const r=row.result,isSegments=Array.isArray(r.segments),rowEnd=r.start+(isSegments?r.segments.length:r.content.length);
   const overlap=current&&!isSegments?Math.max(0,Math.min(end,rowEnd)-r.start):0;
   const matches=!overlap||current.result.content.slice(r.start-current.result.start,r.start-current.result.start+overlap)===r.content.slice(0,overlap);
   if(!current||r.start>end||!matches){current=structuredClone(row);current.result.pages=r.pages||1;merged.push(current);end=rowEnd;continue;}
   if(isSegments){const seen=new Set(current.result.segments.map(s=>s.index));current.result.segments.push(...r.segments.filter(s=>!seen.has(s.index)));}
   else if(rowEnd>end)current.result.content+=r.content.slice(end-r.start);
   current.result.pages=rowEnd<=end?Math.max(current.result.pages,r.pages||1):current.result.pages+(r.pages||1);
   if(rowEnd>=end){current.result.next=r.next;current.result.cursor=r.next;current.result.more=r.next!==null;end=rowEnd;}
   current.result.complete=current.result.next===null;
   current.result.coverage={...current.result.coverage,next:current.result.next,reachesEnd:current.result.next===null,complete:current.result.start===0&&current.result.next===null&&current.request.tool!=='search_source'};
   delete current.bodyHash;
   if(row.at)current.at=row.at;
  }
 }
 return [...merged,...other];
}
module.exports={readContextBatch,readInContext,mergeReadRows,defaults,bodySize};
