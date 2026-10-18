// Model projection is a JSON tree. Separate aliases before assigning path refs;
// structuredClone preserves aliases, which could delete a canonical body twice.
const copyTree=v=>Array.isArray(v)?v.map(copyTree):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copyTree(x)])):v;
// Keep a complete directory; workers fetch omitted bodies through read_context.
function compact(context,snapshot){
 if(snapshot){
  const inputs=new Set(snapshot.readableCatalog.filter(r=>r.type==='source'&&r.purpose==='input').map(r=>r.id));
  context={...context,...snapshot,sourceCatalog:[...snapshot.readableCatalog,...snapshot.historyCatalog].filter(r=>r.type==='source'),sources:(context.sources||[]).filter(s=>inputs.has(s.id))};
 }
 const sources=context.sources||[];
 const bodyChars=suppliedBodies(deduplicate({sources,retrievedEvidence:context.retrievedEvidence,generationEvidence:context.generationEvidence})).reduce((n,s)=>n+s.length,0);
 if(bodyChars<=40000)return context;
 let remaining=32000;const seen=new Map(),sourceCount=new Set(sources.map(s=>s.content)).size;
 const result=sources.map(s=>{
  if(seen.has(s.content)){const cached=seen.get(s.content);return {...s,...cached,...(cached.truncated?{resumeRequest:{tool:'read_source',sourceId:s.id,start:0}}:{})};}
  const allowance=Math.min(1800,Math.max(240,Math.floor(remaining/Math.max(1,sourceCount))));
  if((s.content?.length||0)<=allowance){remaining-=s.content?.length||0;seen.set(s.content,{content:s.content});return s;}
  const content=s.content.slice(0,allowance);remaining-=content.length;
  const projection={content:content+'\n[完整证据已保存，请按来源 ID 使用 read_context 读取。]',truncated:true,structuralProjection:false};seen.set(s.content,projection);
  return {...s,...projection,resumeRequest:{tool:'read_source',sourceId:s.id,start:0}};
 });
 const directory=rows=>(rows||[]).map(r=>JSON.stringify(r).length>1800?{sourceId:r.sourceId,artifactId:r.artifactId,ref:r.ref,purpose:r.purpose,state:r.state,version:r.version,title:r.title,preview:JSON.stringify(r).slice(0,1800),truncated:true,readTool:'read_context',resumeRequest:r.resumeRequest||resume(r)}:r);
 return {...context,sources:result,retrievedEvidence:directory(context.retrievedEvidence),generationEvidence:directory(context.generationEvidence),evidenceDirectory:{ref:'sourceCatalog',note:'完整目录由 sourceCatalog/historyCatalog 提供；未展示项使用 list_sources 分页查询。'},contextNote:'保留全部证据目录，正文按需读取；节选不能证明缺少某个事实，也不能替代完整性核验。自身交付回读只供核对，不自动成为新的输入要求。'};
}
const atPath=(value,path)=>path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],value);
// Exact body fields only. Catalog titles, diagnostics and query strings are not
// visible evidence; refs contribute only through their retained string target.
function bodyFields(context){
 const fields=[];
 const add=(object,key,path,priority)=>{if(typeof object?.[key]==='string'&&object[key])fields.push({object,key,path,text:object[key],priority});};
 add(context.revision,'originalContent','revision.originalContent',0);
 add(context.workingDraft,'content','workingDraft.content',1);
 for(const [i,row] of (context.artifacts||[]).entries())add(row,'content',`artifacts[${i}].content`,2);
 const visit=(row,path,priority)=>{
  add(row,'content',path+'.content',priority);
  for(const [i,segment] of (Array.isArray(row?.segments)?row.segments:[]).entries())add(segment,'text',`${path}.segments[${i}].text`,priority);
 };
 for(const key of ['generationEvidence','contextReads','requestedSections','retrievedEvidence','sources'])for(const [i,row] of (context[key]||[]).entries())visit(key==='contextReads'?row.result:row,`${key}[${i}]${key==='contextReads'?'.result':''}`,key==='sources'?4:3);
 for(const [i,row] of (context.deliveryEvidence||[]).entries())visit(row.readback,`deliveryEvidence[${i}].readback`,3);
 return fields;
}
function suppliedBodies(context){return bodyFields(context).map(f=>f.text);}
function resume(row,request){
 const start=row.start??request?.start??0,tool=request?.tool||(row.artifactId?'read_artifact':row.section?'read_section':'read_source');
 return request?{...request,start}:row.resumeRequest?{...row.resumeRequest,start}:{tool,...(row.ref?{ref:row.ref}:row.artifactId?{artifactId:row.artifactId}:{sourceId:row.sourceId}),...(row.section?{title:row.section}:{}),...(row.state==='historical'?{history:true}:{}),...(row.version?{version:row.version}:{}),start};
}
// Canonicalize unique bodies BEFORE allocating the read budget. Then reconstruct
// each supplied span and rebase refs, so eviction can never leave a dangling ref.
function bounded(context,{maxChars=192000}={}){
 if(!Number.isSafeInteger(maxChars)||maxChars<0)throw new TypeError('maxChars must be a non-negative integer');
 const result=copyTree(context);
 // Accept an already deduplicated view too. Never expand a dangling reference.
 const hydrate=value=>{
  if(!value||typeof value!=='object')return;
  for(const key of ['content','text','originalContent'])if(value[key+'Ref']){
   const ref=value[key+'Ref'],body=atPath(context,ref.path);
   if(typeof body==='string'&&Number.isSafeInteger(ref.start)&&Number.isSafeInteger(ref.end)&&ref.start>=0&&ref.end<=body.length)value[key]=body.slice(ref.start,ref.end);
   delete value[key+'Ref'];
  }
  for(const child of Object.values(value))if(child&&typeof child==='object')hydrate(child);
 };
 hydrate(result);
 const canonical=deduplicate(result),fields=bodyFields(result),entries=[];
 for(const key of ['contextReads','generationEvidence'])for(let i=(result[key]||[]).length-1;i>=0;i--){
  const row=key==='contextReads'?result[key][i].result:result[key][i];
  if(!row||row.ok===false||row.directoryOnly)continue;
  const path=`${key}[${i}]${key==='contextReads'?'.result':''}`;
  entries.push({row,path,request:key==='contextReads'?result[key][i].request:undefined});
  delete row.preview;
 }
 const spans=new Map(),supplied=new Map();
 const merge=intervals=>{
  const result=[];
  for(const interval of intervals.sort((a,b)=>a.start-b.start)){
   const last=result.at(-1);if(last&&interval.start<=last.end)last.end=Math.max(last.end,interval.end);else result.push({...interval});
  }
  return result;
 };
 const add=span=>supplied.set(span.path,merge([...(supplied.get(span.path)||[]),{start:span.start,end:span.end}]));
 for(const field of fields){
  const parent=field.path.slice(0,field.path.lastIndexOf('.')),object=atPath(canonical,parent),ref=object?.[field.key+'Ref'];
  const span=ref||{path:field.path,start:0,end:field.text.length};spans.set(field.path,span);
  if(!entries.some(e=>field.path.startsWith(e.path+'.')))add(span);
 }
 let remaining=maxChars;
 // Allocate actual requested spans, not the entire larger canonical body that
 // contains them. This lets a re-read prefix displace an old retained suffix.
 for(const {path} of entries){
  const owned=fields.filter(f=>f.path.startsWith(path+'.')).reverse();
  for(const field of owned){
   const span=spans.get(field.path),missing=[];let cursor=span.start;
   for(const interval of supplied.get(span.path)||[]){
    if(interval.end<=cursor)continue;if(interval.start>=span.end)break;
    if(interval.start>cursor)missing.push({start:cursor,end:Math.min(interval.start,span.end)});
    cursor=Math.max(cursor,interval.end);
   }
   if(cursor<span.end)missing.push({start:cursor,end:span.end});
   const size=missing.reduce((n,r)=>n+r.end-r.start,0);
   if(field.key==='text'&&size>remaining)continue;
   for(const interval of missing.reverse()){
    const keep=Math.min(remaining,interval.end-interval.start);if(!keep)continue;
    add({path:span.path,start:interval.end-keep,end:interval.end});remaining-=keep;
   }
  }
 }
 const retained=path=>{
  const span=spans.get(path);if(!span)return {text:'',offset:0};
  const intersections=(supplied.get(span.path)||[]).map(r=>({start:Math.max(r.start,span.start),end:Math.min(r.end,span.end)})).filter(r=>r.end>r.start);
  // One field represents one contiguous window. Separate requested fields still
  // retain their own spans; the final dedup builds refs only to those real strings.
  const kept=intersections.sort((a,b)=>(b.end-b.start)-(a.end-a.start)||b.start-a.start)[0];
  return kept?{text:atPath(canonical,span.path).slice(kept.start,kept.end),offset:kept.start-span.start}:{text:'',offset:0};
 };
 const omissions=[];
 for(const {row,path,request} of entries){
  const start=row.start??request?.start??0,originalNext=row.next,resumeRequest=resume(row,request);
  let size=0,kept=0,keptStart=start,omitted=false,end=start,providedEnd=start;
  if(typeof row.content==='string'){
   size=row.content.length;const span=retained(path+'.content');kept=span.text.length;
   if(kept)row.content=span.text;else delete row.content;
   keptStart=kept?start+span.offset:start+size;end=start+size;providedEnd=keptStart+kept;omitted=kept<size;
  }else if(Array.isArray(row.segments)){
   const segments=row.segments;size=segments.reduce((n,s)=>n+(s.text?.length||0),0);
   // Preserve a contiguous suffix of atomic segments and exact search positions.
   let from=segments.length;
   while(from>0){const s=segments[from-1],span=retained(`${path}.segments[${from-1}].text`);if(span.text!==s.text)break;from--;}
   keptStart=start+from;end=start+segments.length;providedEnd=end;row.segments=segments.slice(from);kept=row.segments.reduce((n,s)=>n+(s.text?.length||0),0);omitted=from>0;
   if(!row.segments.length)delete row.segments;
  }
  if(!omitted)continue;
  const omittedRanges=[...(keptStart>start?[{start,end:keptStart}]:[]),...(kept&&providedEnd<end?[{start:providedEnd,end}]:[])];
  const next=omittedRanges[0]?.start??start;resumeRequest.start=next;
  Object.assign(row,{bodyOmitted:true,storedComplete:row.complete,complete:false,readTool:resumeRequest.tool,next,cursor:next,resumeRequest,
   omittedRange:omittedRanges[0],omittedRanges,...(kept?{start:keptStart,providedRange:{start:keptStart,next:providedEnd===end?originalNext:providedEnd}}:{})});
  if(row.coverage)row.coverage={...row.coverage,start:keptStart,complete:false,providedComplete:false};
  omissions.push({path,characters:size-kept,resumeRequest});
 }
 if(omissions.length)result.readBodyBudget={maxChars,providedChars:maxChars-remaining,omissions,note:'正文按唯一内容计入预算；省略窗口可按 resumeRequest 重新读取。磁盘已读不代表本次模型已见。'};
 else delete result.readBodyBudget;
 return deduplicate(result);
}
// Only the model-facing copy is deduplicated. Receipts and dependency checks keep
// their exact bodies locally. Every omitted string points to an exact supplied span.
function deduplicate(context){
 const result=copyTree(context),fields=bodyFields(result);
 // Prefer a full draft and then the largest exact span; never collapse distinct
 // occurrences inside the same field or infer equality from a source title.
 fields.sort((a,b)=>a.priority-b.priority||b.text.length-a.text.length);
 const supplied=[];
 for(const field of fields){
  const same=supplied.find(p=>p.text.includes(field.text));
  if(same){const start=same.text.indexOf(field.text);delete field.object[field.key];field.object[field.key+'Ref']={path:same.path,start,end:start+field.text.length};}
  else supplied.push(field);
 }
 if(fields.length!==supplied.length)result.bodyReferenceNote='contentRef/textRef 指向本次上下文中已提供的完全相同正文区间；不代表缺失、截断或新增业务输入。';
 if(Array.isArray(result.evidenceDirectory))result.evidenceDirectory={ref:'sourceCatalog',note:'历史及未展示项使用 list_sources 查询。'};
 return result;
}
module.exports={compact,bounded,deduplicate,suppliedBodies,resume};
