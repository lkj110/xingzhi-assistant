'use strict';
// One bounded local retrieval before the existing transport. Persisted attempts
// avoid repeated indexing; only actual transport projection proves visibility.
const protocol=require('./task-context.cjs'),{hash}=require('./evidence-basis.cjs');
const VERSION='evidence-preparation-v3',MAX_CHARS=48000,MAX_MS=30000,MAX_SOURCES=8,MAX_PLAN_CHARS=262144;
function queries(task,context){
 const latest=(task.notes||[]).filter(r=>['revise','feedback'].includes(r.kind)).at(-1)?.text;
 const values=[latest,task.objective||task.description,task.criteria,context.currentStep?.title],parts=[],seen=new Set();let deferred=0;
 for(const value of values)for(const unit of String(value||'').split(/(?<=[。！？；\n])/u).map(s=>s.trim()).filter(Boolean)){
  if(seen.has(unit))continue;seen.add(unit);if(unit.length>300){deferred++;continue;}
  if(parts.length&&parts.at(-1).length+unit.length+1<=300)parts[parts.length-1]+='\n'+unit;else if(parts.length<2)parts.push(unit);else deferred++;
 }
 return {queries:parts,deferredUnits:deferred};
}
function plan(a,task,context,phase,check=()=>{}){
 check();
 const input=require('./model-input.cjs').prepare(context,{stage:phase==='execute'?'task_work':'task_verify'}),seen=new Set();require('./grounding.cjs').observe(seen,input);
 const supplied=require('./model-input.cjs').materialize(input),readRows=[...(supplied.contextReads||[]).map(r=>r.result),...(supplied.requestedSections||[]),...(supplied.generationEvidence||[]),...(supplied.retrievedEvidence||[])];
 return protocol.withContext(a,protocol.taskScope(task),op=>{
  check();const snapshot=op.context(),sources=snapshot.readableCatalog.filter(r=>r.type==='source'&&r.purpose==='input'&&!r.ambiguous),missing=[];let inspected=0,characters=0,deferredSources=0;
  for(const source of sources){check();const original=op.source(source.id);
   // Automatic preparation does not synchronously restore unbounded archives.
   // Deferred sources retain the ordinary permission-checked paged readers.
   if(inspected>=MAX_SOURCES||source.characters+characters>MAX_PLAN_CHARS||original?.platformSnapshot){deferredSources++;continue;}
   inspected++;characters+=source.characters;const body=op.snapshot().readContent(source.id),ground=require('./grounding.cjs');check();
   // Whole read_source receipts may contain exact paragraphs separately. Blank
   // canonical separators between them are not missing business evidence.
   const segments=op.sourceSegments(source.id),relevant=readRows.filter(r=>r?.ok!==false&&r?.sourceId===source.id&&r.version===source.version);check();
   const allSegments=segments.length>0&&segments.every((segment,index)=>{
    check();const parts=[];for(const row of relevant){if(row.segmentIndex===index&&typeof row.content==='string')parts.push({text:row.content,start:row.start??0});for(const s of row.segments||[])if(s.index===index&&typeof s.text==='string')parts.push({text:s.text,start:0});}
    return ground.sourceCovered(segment.text,0,segment.text.length,parts);
   });
   if(!allSegments&&!ground.sourceCovered(body,0,body.length,seen.sources?.get(source.id+':'+source.version)))missing.push(source.id);
  }
  const query=queries(task,context),identity=hash({version:VERSION,taskId:task.id,phase,workRevision:task.workRevision,requirements:require('./grounding.cjs').requirements(a,task),sources:sources.map(s=>[s.id,s.version,s.policyRevision]),query});
  check();return {...query,identity,snapshot,sourceIds:missing,deferredSources};
 });
}
async function prepare(a,task,context,{phase,remainingChars=MAX_CHARS,readBatch,save,gate}){
 if(!require('./context-optimizations.cjs').enabled(a,'B'))return null;
 const started=performance.now(),timeout=AbortSignal.timeout(MAX_MS),signal=a.controller?.signal?AbortSignal.any([a.controller.signal,timeout]):timeout,deadlineError=Object.assign(Error('自动取证达到本地时间限额'),{code:'PREPARATION_TIME_LIMIT'});
 const check=()=>{gate();signal.throwIfAborted();if(performance.now()-started>=MAX_MS)throw deadlineError;};
 let p;try{check();
  if(a.data.sources.length>128||a.data.sources.reduce((n,s)=>n+String(s.content||'').length,0)>2*1024*1024)return {rows:[],used:[],searches:[],diagnostic:{status:'planning_limit',note:'自动预取的目录规模超限，仍须按目录分页取证；没有证明完整召回。'}};
  p=plan(a,task,context,phase,check);
 }catch(error){if(error!==deadlineError&&error!==timeout.reason||a.controller?.signal.aborted)throw error;gate();return {rows:[],used:[],searches:[],diagnostic:{status:'time_limit',ms:Math.round(performance.now()-started),note:'自动预取规划未完成，仍须按目录取证。'}};}
 if(!p.sourceIds.length||!p.queries.length)return p.deferredSources?{rows:[],used:[],searches:[],diagnostic:{status:'planning_limit',deferredSources:p.deferredSources,note:'部分来源超过自动预取限额或需要归档读取，须按原目录继续取证。'}}:null;
 const records=task.evidencePreparations||[],prior=records.find(r=>r.identity===p.identity);
 if(prior)return {searches:structuredClone(prior.searches||[]),rows:[],used:[],diagnostic:{reused:true,status:prior.status,deferredUnits:p.deferredUnits}};
 const record={identity:p.identity,version:VERSION,status:'started',at:new Date().toISOString(),queries:p.queries,deferredUnits:p.deferredUnits,searches:[]};
 task.evidencePreparations=[...records,record];save();
 const result={rows:[],used:[],searches:[],diagnostic:{reused:false,deferredUnits:p.deferredUnits,deferredSources:p.deferredSources}};let remaining=Math.max(0,Math.min(MAX_CHARS,remainingChars));
 try{
  for(const query of p.queries){if(remaining<=0){record.status='budget_exhausted';break;}check();
   const batch=await require('./evidence-search.cjs').readRequests(a,task,[{tool:'search_evidence',query,limit:2}],readBatch,{maxChars:remaining,signal,sourceIds:p.sourceIds,budgetMs:Math.max(0,Math.min(20000,MAX_MS-(performance.now()-started)-1000))});
   check();protocol.withContext(a,protocol.taskScope(task),op=>op.assertCurrent(p.snapshot));
   result.rows.push(...batch.rows);result.used.push(...batch.used);result.searches.push(...batch.searches);remaining-=batch.stats.characters;
   record.searches=structuredClone(result.searches);save();
  }
  if(record.status==='started')record.status='completed';
 }catch(error){
  // A local time limit is a disclosed retrieval gap. User cancellation,
  // permission changes and lifecycle failures retain their hard-stop semantics.
  if(error!==deadlineError&&error!==timeout.reason||a.controller?.signal.aborted){record.status='failed';record.errorCode=error.code||error.name;save();throw error;}
  gate();protocol.withContext(a,protocol.taskScope(task),op=>op.assertCurrent(p.snapshot));record.status='time_limit';
 }
 record.ms=Math.round(performance.now()-started);record.characters=Math.max(0,Math.min(MAX_CHARS,remainingChars))-remaining;save();
 return {...result,diagnostic:{...result.diagnostic,status:record.status,ms:record.ms,characters:record.characters,note:'检索无命中或未完成不证明事实不存在；完整组须按实际模型输入核对。'}};
}
module.exports={VERSION,MAX_CHARS,MAX_MS,MAX_SOURCES,MAX_PLAN_CHARS,queries,plan,prepare};
