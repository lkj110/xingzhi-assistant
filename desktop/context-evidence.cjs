// Keep a complete directory; workers fetch omitted bodies through read_context.
function compact(context,snapshot){
 if(snapshot){
  const inputs=new Set(snapshot.readableCatalog.filter(r=>r.type==='source'&&r.purpose==='input').map(r=>r.id));
  context={...context,...snapshot,sourceCatalog:[...snapshot.readableCatalog,...snapshot.historyCatalog].filter(r=>r.type==='source'),sources:(context.sources||[]).filter(s=>inputs.has(s.id))};
 }
 const sources=context.sources||[];
 const bodyChars=sources.reduce((n,s)=>n+(s.content?.length||0),0)+JSON.stringify(context.retrievedEvidence||[]).length+JSON.stringify(context.generationEvidence||[]).length;
 if(bodyChars<=40000)return context;
 let remaining=32000;
 const result=sources.map(s=>{
  const allowance=Math.min(1800,Math.max(240,Math.floor(remaining/Math.max(1,sources.length))));
  if((s.content?.length||0)<=allowance){remaining-=s.content?.length||0;return s;}
  const content=s.content.slice(0,allowance);remaining-=content.length;
  return {...s,content:content+'\n[完整证据已保存，请按来源 ID 使用 read_context 读取。]',truncated:true,structuralProjection:false};
 });
 const directory=rows=>(rows||[]).map(r=>JSON.stringify(r).length>1800?{sourceId:r.sourceId,artifactId:r.artifactId,ref:r.ref,purpose:r.purpose,state:r.state,version:r.version,title:r.title,preview:JSON.stringify(r).slice(0,1800),truncated:true,readTool:'read_context'}:r);
 return {...context,sources:result,retrievedEvidence:directory(context.retrievedEvidence),generationEvidence:directory(context.generationEvidence),evidenceDirectory:{ref:'sourceCatalog',note:'完整目录由 sourceCatalog/historyCatalog 提供；未展示项使用 list_sources 分页查询。'},contextNote:'保留全部证据目录，正文按需读取；节选不能证明缺少某个事实，也不能替代完整性核验。自身交付回读只供核对，不自动成为新的输入要求。'};
}
// Call BEFORE deduplicate, on raw views. Only actual read bodies are budgeted;
// revision/current drafts and requested sections retain their original contracts.
function bounded(context,{maxChars=192000}={}){
 if(!Number.isSafeInteger(maxChars)||maxChars<0)throw new TypeError('maxChars must be a non-negative integer');
 const result=structuredClone(context),omissions=[];let remaining=maxChars;
 const entries=[];
 for(const key of ['contextReads','generationEvidence']){
  const list=result[key]||[];
  for(let i=list.length-1;i>=0;i--)entries.push({key,i,row:key==='contextReads'?list[i].result:list[i],request:key==='contextReads'?list[i].request:undefined});
 }
 for(const {key,i,row,request} of entries){
  if(!row||row.ok===false||row.directoryOnly)continue;
  const segments=Array.isArray(row.segments)?row.segments:null;
  const size=(row.content?.length||0)+(segments||[]).reduce((n,s)=>n+(s.text?.length||0),0)+(row.preview?.length||0);
  if(size<=remaining){remaining-=size;continue;}
  const start=row.start??request?.start??0,tool=request?.tool||(row.artifactId?'read_artifact':row.section?'read_section':'read_source');
  const resumeRequest=request?{...request,start}:{tool,...(row.ref?{ref:row.ref}:row.artifactId?{artifactId:row.artifactId}:{sourceId:row.sourceId}),...(row.section?{title:row.section}:{}),...(row.state==='historical'?{history:true}:{}),start};
  let keptStart=start,kept=0;
  delete row.preview;
  if(typeof row.content==='string'){
   kept=Math.min(remaining,row.content.length);keptStart=start+row.content.length-kept;
   delete row.segments;
   if(kept)row.content=row.content.slice(-kept);else delete row.content;
  }else if(segments){
   let from=segments.length;
   while(from>0&&kept+(segments[from-1].text?.length||0)<=remaining){kept+=segments[from-1].text?.length||0;from--;}
   keptStart=start+from;
   if(from<segments.length)row.segments=segments.slice(from);else delete row.segments;
  }
  remaining-=kept;
  const originalNext=row.next;
  Object.assign(row,{bodyOmitted:true,storedComplete:row.complete,complete:false,readTool:tool,next:start,cursor:start,resumeRequest,
   omittedRange:{start,end:kept?keptStart:(segments?start+segments.length:row.total??originalNext)},
   ...(kept?{start:keptStart,providedRange:{start:keptStart,next:originalNext}}:{})});
  if(row.coverage)row.coverage={...row.coverage,start:keptStart,complete:false,providedComplete:false};
  omissions.push({path:`${key}[${i}]`,characters:size-kept,resumeRequest});
 }
 if(omissions.length)result.readBodyBudget={maxChars,providedChars:maxChars-remaining,omissions,note:'只省略本次模型输入中的旧读取正文；本地成功回执及依赖仍完整保留。需要省略部分时使用 resumeRequest，不以当前窗口判断全文缺失。'};
 return result;
}
// Only the model-facing copy is deduplicated. Receipts and dependency checks keep
// their exact bodies locally. Every omitted string points to an exact supplied span.
function deduplicate(context){
 const result=structuredClone(context),fields=[];
 const add=(object,key,path,priority)=>{if(typeof object?.[key]==='string'&&object[key])fields.push({object,key,path,text:object[key],priority});};
 add(result.revision,'originalContent','revision.originalContent',0);
 add(result.workingDraft,'content','workingDraft.content',1);
 for(const [i,row] of (result.artifacts||[]).entries())add(row,'content',`artifacts[${i}].content`,2);
 const visit=(row,path,priority)=>{
  add(row,'content',path+'.content',priority);
  for(const [i,s] of (Array.isArray(row?.segments)?row.segments:[]).entries())add(s,'text',`${path}.segments[${i}].text`,priority);
 };
 for(const key of ['generationEvidence','contextReads','requestedSections','retrievedEvidence','sources'])for(const [i,row] of (result[key]||[]).entries())visit(key==='contextReads'?row.result:row,`${key}[${i}]${key==='contextReads'?'.result':''}`,key==='sources'?4:3);
 for(const [i,row] of (result.deliveryEvidence||[]).entries())visit(row.readback,`deliveryEvidence[${i}].readback`,3);
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
module.exports={compact,bounded,deduplicate};
