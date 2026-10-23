'use strict';
const protocol=require('./task-context.cjs'),{hash}=require('./evidence-basis.cjs'),{contextError,contextResult}=require('./model-errors.cjs');
const VERSION='hybrid-evidence-v3',cache=new Map(),BATCH_SIZE=4,MAX_NEW_WINDOWS=16;
// Only request validation belongs to local correction; reader, authorization,
// version and lifecycle failures must escape the wrapper unchanged.
const parameterErrors=new WeakSet();
function invalidRequest(){const error=contextError('CONTEXT_INVALID_REQUEST',{message:'search_evidence 需 query（1–300 字符），limit 为 1–3；可选 sourceId 或 ref。',safeAlternatives:['仅修正失败检索的 query/limit；limit 为 1–3，可按当前目录中的 sourceId/ref 收窄范围。']});parameterErrors.add(error);throw error;}
const terms=text=>{const s=String(text).toLowerCase();return [...new Set([...(s.match(/[a-z0-9_]+/g)||[]),...(s.match(/[\p{Script=Han}]{2,}/gu)||[]).flatMap(w=>Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)))])];};
const lexical=(query,text)=>{const ts=terms(query),value=text.toLowerCase();return ts.filter(t=>value.includes(t)).length/Math.max(1,ts.length);};
function sectionHeading(text){
 const line=String(text).split('\n')[0],markdown=line.match(/^\s*(#{1,6})\s+(.*)$/),body=markdown?markdown[2]:line.trim();
 const number=body.match(/^(\d+(?:\.\d+)*)(?:\s|[、．]|\.(?!\d)|$)/);
 return markdown||number?{id:number?.[1],level:markdown?markdown[1].length:number[1].split('.').length}:null;
}
function structure(segments,index){
 const members=new Set([index]),warnings=[];let heading=-1,table=-1;
 const target=segments[index];
 for(let i=0;i<segments.length;i++)if(target.groupId&&segments[i].groupId===target.groupId||target.paragraph!==undefined&&segments[i].paragraph===target.paragraph&&segments[i].page===target.page)members.add(i);
 for(let i=0;i<=index;i++){
  const s=segments[i].text;
  if(/(^|\n)(#{1,6}\s|(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)[、.．\s])/u.test(s))heading=i;
  if(/\|.*\|\s*\r?\n\s*\|?\s*:?-{3,}/.test(s)||table<0&&/(?:^|\n)[^\n,]+,[^\n,]+,[^\n,]+/.test(s))table=i;
 }
 if(heading>=0)members.add(heading);if(table>=0&&(/\||,/.test(segments[index].text)))members.add(table);
 if(index>0)members.add(index-1);if(index+1<segments.length)members.add(index+1);
 const body=segments[index].text;
 for(let i=0;i<segments.length;i++){
  const s=segments[i].text;
  const refs=[...body.matchAll(/(?:\[\^?([\w-]+)\]|(?:见|参见|see)\s*(\d+(?:\.\d+)+))/gi)].map(m=>m[1]||m[2]);
  if(refs.some(ref=>s.includes(`[^${ref}]:`)||s.includes(`[${ref}]`)||s.match(/^\s*#{0,6}\s*([\d.]+)/)?.[1]===ref)||[...body.matchAll(/\[脚注(\d+)\]/g)].some(m=>segments[i].footnoteId===m[1]))members.add(i);
  // Explicit exceptions stay attached even when pagination split their rule.
  if((segments[i].page===segments[index].page&&segments[i].page!==undefined||Math.abs(i-index)<=2)&&/(例外|除外|但(?:是|仅)|不适用|except|unless|footnote|注[:：])/i.test(s))members.add(i);
 }
 const unresolved=new Set(),visited=new Set();let iterations=0;
 // Follow references in every included condition/header, not just the hit.
 while(iterations++<16){let changed=false;unresolved.clear();
  for(const member of [...members]){
   const content=segments[member].text;
   const references=[...content.matchAll(/\[脚注(\d+)\]|\[\^([\w-]+)\](?!:)|\[(\d+)\](?!:)|(?:见|参见|see)\s*(\d+(?:\.\d+)+)/gi)];
   for(const ref of references){const id=ref[1]||ref[2]||ref[3]||ref[4],key=(ref[4]?'section:':'note:')+id;let found=false;
    for(let i=0;i<segments.length;i++){const s=segments[i],text=s.text,match=ref[4]?text.split('\n').some(line=>line.match(/^\s*#{0,6}\s*(\d+(?:\.\d+)+)(?:\s|[、.．]|$)/)?.[1]===id):s.footnoteId===id||text.includes(`[^${id}]:`)||text.trimStart().startsWith(`[脚注${id}]`)||text.trimStart().startsWith(`[${id}]`);
     if(match){found=true;const add=j=>{if(!members.has(j)){members.add(j);changed=true;}};add(i);
      if(ref[4]){const start=sectionHeading(text);if(!start||start.id!==id){unresolved.add('section-boundary:'+id);continue;}
       for(let j=i+1;j<segments.length;j++){const next=sectionHeading(segments[j].text);if(next&&next.level<=start.level)break;add(j);}
      }
      for(let j=0;j<segments.length;j++)if(s.groupId&&segments[j].groupId===s.groupId||s.paragraph!==undefined&&segments[j].paragraph===s.paragraph&&segments[j].page===s.page)add(j);
     }
    }if(!found)unresolved.add(key);visited.add(key);
   }
  }if(!changed)break;
 }
 if(iterations>16)warnings.push('交叉引用超过有界补读深度，须按原文继续核对');
 if(unresolved.size)warnings.push('引用未定位：'+[...unresolved].join('、'));
 if(segments[index].localOCR)warnings.push('OCR 文字可能错漏，结构须核对原页');
 if(table<0&&(/\|/.test(body)||target.structure==='table'&&!target.groupId))warnings.push('表头未定位，不能确认字段口径');
 return {members:[...members].sort((a,b)=>a-b),warnings,unresolvedReferences:[...unresolved],structureComplete:unresolved.size===0&&iterations<=16};
}
function authorized(a,task,request,sourceIds){return protocol.withContext(a,protocol.taskScope(task),op=>{
 const snapshot=op.context(),sources=snapshot.readableCatalog.filter(s=>s.type==='source'&&s.purpose==='input'&&!s.ambiguous&&(!sourceIds||sourceIds.includes(s.id))&&(!request.sourceId||s.id===request.sourceId)&&(!request.ref||s.ref===request.ref));
 if((request.sourceId||request.ref)&&!sources.length)throw contextError('CONTEXT_SCOPE_DENIED');
 const docs=sources.map(s=>{
  const proof=op.resolveRead({tool:'read_source',sourceId:s.id,limit:1,version:s.version});if(!proof.ok)throw contextError(proof.code,proof);
  return {source:s,segments:op.sourceSegments(s.id).map((r,index)=>({...r,index})),warnings:op.source(s.id)?.warnings||[]};
 });return {snapshot,docs};
});}
async function search(a,task,request,{signal=a.controller?.signal,sourceIds,budgetMs=20000}={}){
 if(!request||typeof request!=='object'||Array.isArray(request)||request.tool!=='search_evidence'||Object.keys(request).some(k=>!['tool','query','limit','sourceId','ref'].includes(k))||typeof request.query!=='string'||!request.query.trim()||request.query.length>300||request.limit!==undefined&&(!Number.isInteger(request.limit)||request.limit<1||request.limit>3)||['sourceId','ref'].some(k=>request[k]!==undefined&&(typeof request[k]!=='string'||!request[k])))invalidRequest();
 signal?.throwIfAborted();
 const start=performance.now(),{snapshot,docs}=authorized(a,task,request,sourceIds),scope=hash([a.dir,task.id]),chunks=[];
 const activeKeys=new Set(docs.map(d=>hash([scope,d.source.id,d.source.version,d.source.policyRevision,VERSION])));
 for(const [k,v] of cache)if(v.scope===scope&&!activeKeys.has(k))cache.delete(k);
 let degraded=false,cacheHits=0,encodedWindows=0,vector;
 const pending=[],assertCurrent=()=>{signal?.throwIfAborted();protocol.withContext(a,protocol.taskScope(task),op=>op.assertCurrent(snapshot));};
 for(const d of docs){
  d.key=hash([scope,d.source.id,d.source.version,d.source.policyRevision,VERSION]);
  d.chunks=d.segments.flatMap(s=>{const out=[];for(let p=0;p<s.text.length;p+=320)out.push({sourceId:d.source.id,index:s.index,text:s.text.slice(p,p+384)});return out;});
  // Limits are explicit; pagination remains available through the original reader.
  if(d.chunks.length>4096){d.chunks=d.chunks.slice(0,4096);d.warnings.push('本次索引覆盖前 4096 个文本窗；其余须按原目录读取');}
  d.cached=cache.get(d.key)||{scope,byText:new Map()};if(d.cached.byText.size)cacheHits++;
  for(const text of new Set(d.chunks.map(c=>c.text)))if(!d.cached.byText.has(text))pending.push({d,text,score:lexical(request.query,text)});
 }
 // Commit only complete small batches. A local deadline keeps completed work
 // for the next query; cancellation and authority changes still escape.
 const ms=Math.max(0,Math.min(20000,Number.isFinite(budgetMs)?budgetMs:20000)),timeout=ms?AbortSignal.timeout(Math.ceil(ms)):null;
 const inferenceSignal=timeout?(signal?AbortSignal.any([signal,timeout]):timeout):signal;
 pending.sort((a,b)=>b.score-a.score);
 try{
  if(ms&&docs.some(d=>d.chunks.length)){
   vector=(await require('./evidence-encoder.cjs').encode([request.query],inferenceSignal))[0];assertCurrent();
   for(let offset=0;offset<Math.min(MAX_NEW_WINDOWS,pending.length);offset+=BATCH_SIZE){
    inferenceSignal?.throwIfAborted();const batch=pending.slice(offset,Math.min(offset+BATCH_SIZE,MAX_NEW_WINDOWS));
    const encoded=await require('./evidence-encoder.cjs').encode(batch.map(r=>r.text),inferenceSignal);assertCurrent();inferenceSignal?.throwIfAborted();
    for(let i=0;i<batch.length;i++){const {d,text}=batch[i];d.cached.byText.set(text,encoded[i]);cache.set(d.key,d.cached);encodedWindows++;}
    while(cache.size>24)cache.delete(cache.keys().next().value);
   }
  }
 }catch(error){assertCurrent();degraded=true;}
 let indexedWindows=0,totalWindows=0;
 for(const d of docs){const unique=[...new Set(d.chunks.map(c=>c.text))];totalWindows+=unique.length;indexedWindows+=unique.filter(text=>d.cached.byText.has(text)).length;
  d.chunks.forEach(c=>chunks.push({...c,vector:d.cached.byText.get(c.text)}));}
 const partial=indexedWindows<totalWindows;
 // Reacquire permissions after every asynchronous inference; no cached titles or counts escape first.
 signal?.throwIfAborted();protocol.withContext(a,protocol.taskScope(task),op=>op.assertCurrent(snapshot));
 const best=new Map();for(const c of chunks){const lex=lexical(request.query,c.text),cos=vector&&c.vector?vector.reduce((n,v,i)=>n+v*c.vector[i],0):0,score=vector&&c.vector?0.65*cos+0.35*lex:lex;if(score<0.08)continue;const k=c.sourceId+':'+c.index;if(!best.has(k)||best.get(k).score<score)best.set(k,{...c,score});}
 const ranked=[...best.values()].sort((a,b)=>b.score-a.score),groups=[],requests=[],selected=new Set();
 while(ranked.length&&groups.length<(request.limit||2)){
  ranked.sort((a,b)=>(b.score-(selected.has(b.sourceId)?0.08:0))-(a.score-(selected.has(a.sourceId)?0.08:0)));
  const c=ranked.shift();if(groups.some(g=>g.sourceId===c.sourceId&&g.members.includes(c.index)))continue;
  const d=docs.find(d=>d.source.id===c.sourceId),expanded=structure(d.segments,c.index);selected.add(c.sourceId);
  const group={id:'group:'+hash([d.key,c.index,expanded.members]).slice(0,16),sourceId:c.sourceId,version:d.source.version,hit:c.index,...expanded,memberSizes:expanded.members.map(index=>({index,characters:d.segments[index].text.length})),warnings:[...d.warnings,...expanded.warnings],state:'located_not_read'};
  groups.push(group);for(const index of group.members)if(!requests.some(r=>r.sourceId===c.sourceId&&r.index===index))requests.push({tool:'read_segment',sourceId:c.sourceId,version:d.source.version,index});
 }
 return {version:VERSION,mode:!vector?'lexical_fallback':partial?'partial_hybrid':'local_hybrid',degraded,partial,groups,requests,diagnostic:{cacheHits,encodedWindows,indexedWindows,totalWindows,ms:Math.round(performance.now()-start),encoder:require('./evidence-encoder.cjs').status()},note:'命中不代表已读；无命中不证明不存在。组内所有范围实际提供后方可作依据。'+(partial?'语义索引尚未覆盖全部文本窗，其余仅按关键词定位，必要时须分页读原文。':'')};
}
async function readRequests(a,task,requests,readBatch,{maxChars=48000,signal=a.controller?.signal,sourceIds,budgetMs}={}){
 if(!Array.isArray(requests)||requests.length<1||requests.length>4)return readBatch(a,task,requests);
 const normal=[],searches=[],failed=[];for(const r of requests){if(r?.tool==='search_evidence'){
  try{const found={...await search(a,task,r,{signal,sourceIds,budgetMs}),request:structuredClone(r)};searches.push(found);normal.push(...found.requests);}
  catch(error){if(!parameterErrors.has(error))throw error;failed.push({request:structuredClone(r),result:contextResult(error)});}
 }else normal.push(r);}
 const combined={rows:[],pageRows:[],used:[],next:[],complete:true,stats:{characters:0},searches};let remaining=Math.max(0,Math.min(48000,maxChars));
 for(let i=0;i<normal.length;i+=4){signal?.throwIfAborted();if(remaining<=0)break;const batch=readBatch(a,task,normal.slice(i,i+4),{maxChars:remaining});for(const key of ['rows','pageRows','used'])combined[key].push(...batch[key]);combined.next.push(...(batch.next||[]).map(n=>({...n,index:n.index+i})));remaining-=batch.stats.characters;combined.stats.characters+=batch.stats.characters;combined.complete&&=batch.complete;}
 for(const found of searches)for(const group of found.groups){group.state=group.members.every(index=>combined.rows.some(r=>r.result.ok&&r.result.complete&&r.result.sourceId===group.sourceId&&r.result.segmentIndex===index))?'read_pending_model_visibility':'partial';group.readRequests=found.requests.filter(r=>group.members.includes(r.index)&&r.sourceId===group.sourceId&&!combined.rows.some(row=>row.result.ok&&row.result.complete&&row.request.index===r.index&&row.request.sourceId===r.sourceId));}
 combined.rows.push(...failed);if(failed.length)combined.complete=false;
 if(!combined.rows.length){combined.rows.push({request:{tool:'list_sources',query:'',limit:1},result:{ok:true,directoryOnly:true,items:[],complete:true}});}
 return combined;
}
const instruction='\n可用 search_evidence 做本地语义＋关键词检索：read_context.requests:[{tool:"search_evidence",query:"待证问题",limit:2}]，limit 为 1–3，可选 sourceId/ref。App 补读标题/相邻条件/脚注；hybridSearch.groups 中 partial 必须按 readRequests 续读。命中不等于已读，无结果不等于不存在。生成的同轮结果可附 evidencePlan:[{requirementId,question,evidenceIds:[],readRequests:[],gap:""}]；只用当前要求 ID，未读/未找到/已读分开，未知或创作要求说明适当出口。未完成 readRequests 会先执行，保留依据缺口。';
function plan(a,task,value){
 return require('./evidence-plan.cjs').plan(a,task,value);
}
function summary(searches){const modes=[...new Set(searches.map(r=>r.mode))];return {degraded:searches.some(r=>r.degraded),partial:searches.some(r=>r.partial),mode:modes.length===1?modes[0]:'mixed',diagnostic:searches.map(r=>r.diagnostic),at:new Date().toISOString()};}
function suppliedGroups(value){
 if(!Array.isArray(value.hybridSearch))return value;
 const result=structuredClone(value),full=require('./model-input.cjs').materialize(value),rows=[...(full.generationEvidence||[]),...(full.requestedSections||[]),...(full.contextReads||[]).map(r=>r.result)];
 for(const search of result.hybridSearch)for(const group of search.groups||[]){
  const missing=[];
  for(const member of group.memberSizes||[]){
   const ranges=[];for(const r of rows)if(r?.sourceId===group.sourceId&&r.version===group.version){
    if(r.segmentIndex===member.index&&typeof r.content==='string')ranges.push([r.start||0,(r.start||0)+r.content.length]);
    for(const s of r.segments||[])if(s.index===member.index&&typeof s.text==='string')ranges.push([0,s.text.length]);
   }
   let end=0;for(const [from,to] of ranges.sort((a,b)=>a[0]-b[0])){if(from>end)break;end=Math.max(end,to);}
   if(end<member.characters)missing.push({tool:'read_segment',sourceId:group.sourceId,version:group.version,index:member.index,start:end});
  }
  group.state=group.memberSizes?.length&&!missing.length&&group.structureComplete!==false?'provided_complete':'partial';group.readRequests=missing;
 }
 return result;
}
function consumePlan(plan,batch){
 return plan.map(item=>{const pending=[];let completed=false,failure;
  for(const request of item.readRequests){
   const found=(batch.searches||[]).find(r=>hash(r.request)===hash(request));
   const rowIndex=batch.rows.findIndex(r=>Object.keys(request).every(k=>hash(r.request?.[k])===hash(request[k]))),row=batch.rows[rowIndex];
   const computed=(batch.toolEvidence||[]).find(r=>hash(r.request)===hash(request));
   if(found){pending.push(...found.groups.flatMap(g=>g.readRequests||[]));completed=true;if(found.groups.some(g=>g.structureComplete===false))failure='证据组仍有结构缺口，请核对原文引用';if(!found.groups.length)failure='检索未定位证据，不证明不存在';}
   else if(computed||row?.result?.ok&&row.result.complete)completed=true;
   else if(row?.result?.ok){const resume=(batch.next||[]).find(n=>n.index===rowIndex)?.request;pending.push(resume||request);}
   else {pending.push(request);if(row)failure=row.result.message||row.result.code||'读取失败';}
  }
  return {...item,readRequests:pending,gap:failure||(completed&&item.gap==='待定位'?'':item.gap),state:pending.length?'unread':failure?'gap':completed?'read_not_verified':item.state};
 });
}
module.exports={VERSION,search,readRequests,structure,lexical,instruction,plan,summary,suppliedGroups,consumePlan};
