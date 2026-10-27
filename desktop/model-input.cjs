// Model navigation is a bounded view; authoritative receipts stay in the resolver.
const view=require('./context-evidence.cjs'),{pick}=require('./context-index.cjs');
const DEFAULT_MAX=480000;
// Only an actual input-policy change may reopen an old input-size failure.
const POLICY_VERSION='bounded-input-1';
const encodedSize=value=>JSON.stringify(JSON.stringify(value)).length;
function materialize(context){
 const expanded=require('./receipt-input.cjs').expand(context),result=structuredClone(expanded);
 const at=path=>path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],expanded);
 const visit=value=>{
  if(!value||typeof value!=='object')return;
  for(const key of ['content','text','originalContent'])if(value[key+'Ref']){
   const ref=value[key+'Ref'],body=at(ref.path||'');
   if(typeof body==='string'&&Number.isSafeInteger(ref.start)&&Number.isSafeInteger(ref.end)&&ref.start>=0&&ref.end>=ref.start&&ref.end<=body.length)value[key]=body.slice(ref.start,ref.end);
   delete value[key+'Ref'];
  }
  for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);
 };visit(result);return result;
}
function omitted(row,request){
 const {content,segments,preview,...meta}=row||{};
 const resumeRequest=request||view.resume(row||{});
 const start=resumeRequest.start??0;
 return {...meta,bodyOmitted:true,complete:false,storedComplete:row?.complete,...(row?.coverage?{storedCoverage:row.coverage,coverage:{...row.coverage,complete:false,reachesEnd:false,providedComplete:false,next:start}}:{}),resumeRequest,readTool:resumeRequest.tool,next:start,cursor:start};
}
function relation(o){
 const {physicalCoverage:p,lastReceipt,...base}=o;
 return {...base,...(lastReceipt?{lastReceipt:pick(lastReceipt,['checkBasis','summary']),receiptSources:{count:lastReceipt.sourceIds?.length||0,request:{tool:'read_obligations',taskId:o.taskId,obligationId:o.id,section:'receipt',start:0}}}:{}),...(p?{physicalCoverage:{...pick(p,['status','satisfied','closureProven','directObserved','required','obligationId','rootIds']),
  frontierCount:p.frontier?.length||0,observationCount:p.observations?.length||0,proofSourceCount:p.proofSourceIds?.length||0,
  details:{tool:'read_obligations',taskId:o.taskId,obligationId:o.id,section:'frontier',start:0,limit:8},
  note:'仅覆盖摘要，不代表详情已读。frontier、observations、proofSourceIds、roots 可用 read_obligations 分页；完整性由本地证据再次校验。'}}:{})};
}
function navigation(context,level){
 const c=materialize(context);
 for(const row of [...(c.contextReads||[]).map(r=>r.result),...(c.generationEvidence||[])]){
  // Preserve the requested prefix before budget allocation. Otherwise a long
  // escaped segment can repeatedly retain only its suffix on every recovery.
  if(row?.segmentIndex!==undefined&&typeof row.content==='string'&&row.content.length>48000){
   const start=row.start??0,next=start+48000;
   const resumeRequest={...row.resumeRequest,tool:'read_segment',sourceId:row.sourceId,index:row.segmentIndex,start:next,...(row.version?{version:row.version}:{}),...(row.state==='historical'?{history:true}:{})};
   Object.assign(row,{content:row.content.slice(0,48000),complete:false,bodyOmitted:true,storedComplete:row.complete,next,cursor:next,more:true,resumeRequest,providedRange:{start,next},omittedRange:{start:next,end:row.total},coverage:{...row.coverage,start,next,complete:false,reachesEnd:false,providedComplete:false}});
  }
  if(!row?.sourceId||!Array.isArray(row.segments))continue;
  const requests=[];
  row.segments=row.segments.map(s=>{
   if(s.text.length<=12000)return s;
   const resumeRequest={tool:'read_segment',sourceId:row.sourceId,index:s.index,start:12000,...(row.version?{version:row.version}:{}),...(row.state==='historical'?{history:true}:{})};requests.push(resumeRequest);
   return {...s,text:s.text.slice(0,12000),truncated:true,providedCharacters:12000,totalCharacters:s.text.length,resumeRequest};
  });
  if(requests.length)Object.assign(row,{complete:false,storedComplete:row.complete,partialSegments:requests,resumeRequest:requests[0],...(row.coverage?{coverage:{...row.coverage,complete:false,providedComplete:false,reachesEnd:false}}:{})});
 }
 if(c.businessObligations)c.businessObligations=c.businessObligations.map(relation);
 if(c.executionControl?.businessObligations)c.executionControl.businessObligations=c.executionControl.businessObligations.map(relation);
 if(c.deliveryEvidence)c.deliveryEvidence=c.deliveryEvidence.map(d=>({...pick(d,['tool','artifactId','current']),result:pick(d.result||{},['url','documentId','sourceId','updated','verified','verification','contentVerified','submittedHash','readbackHash','revision','updateAcknowledged','path','latestPath','hash','bytes','format','created','commit','number']),...(d.readback?{readback:d.current===true&&!level?d.readback:omitted(d.readback,{tool:'read_source',sourceId:d.readback.id||d.result?.sourceId,...(d.readback.state==='historical'?{history:true}:{}),version:d.readback.version,start:0})}:{})}));
 if(c.sources){c.sourceSummaryCount=c.sources.length;c.sources=c.sources.slice(0,level?8:24).map(s=>omitted(pick(s,['id','title','ref','version','purpose','state','origin','characters']),{tool:'read_source',sourceId:s.id,...(s.state==='historical'?{history:true}:{}),start:0}));}
 if(c.artifactHistory){c.artifactHistoryCount=c.artifactHistory.length;c.artifactHistory=c.artifactHistory.slice(-8);}
 // Keep useful validated reads when they fit; budget pressure selects a recent window.
 // A fixed count can make a small multi-source check oscillate forever.
 if(c.generationEvidence){c.savedReadCount=c.generationEvidence.length;if(level)c.generationEvidence=c.generationEvidence.slice(-2);}
 if(c.contextReads){c.readHistoryCount=c.contextReads.length;if(level)c.contextReads=c.contextReads.slice(-2);}
 if(c.retrievedEvidence)c.retrievedEvidence=c.retrievedEvidence.slice(-(level?1:4));
 if(c.workEfficiency)c.workEfficiency=pick(c.workEfficiency,['allowed','phase','reason','code','nextAction','lastFailure','attempts','remainingAttempts','suggestion','failure','triedStrategies','failedActions','strategy','requiresConfirmation','budgetUnchanged']);
 if(level>=2){
  if(c.generationEvidence)c.generationEvidence=[];
  if(c.requestedSections)c.requestedSections=c.requestedSections.map(r=>omitted(r));
  if(c.retrievedEvidence)c.retrievedEvidence=c.retrievedEvidence.map(r=>omitted(r));
 }
 if(level>=3){
  if(c.artifacts)c.artifacts=c.artifacts.map(r=>({...omitted(r,{tool:'read_artifact',artifactId:r.id,start:0}),truncated:true}));
  if(c.workingDraft)c.workingDraft=omitted(c.workingDraft,{tool:'read_artifact',artifactId:c.workingDraft.id,start:0});
  if(c.revision?.originalContent){delete c.revision.originalContent;c.revision.originalOmitted=true;c.revision.resumeRequest={tool:'read_artifact',artifactId:c.revision.artifactId,start:0};}
  // Dependency excerpts have no independently readable artifact handle in this
  // scope. Keep them verbatim rather than inventing an unauthorized resume URL.
 }
 return c;
}
function prepare(context,{stage='task_work',maxChars=DEFAULT_MAX}={}){
 if(!Number.isSafeInteger(maxChars)||maxChars<32000)throw new TypeError('Model request budget must be at least 32000 characters');
 for(let level=0;level<4;level++){
  const result=require('./model-context.cjs').project(view.bounded(navigation(context,level),{maxChars:level?64000:192000}),{stage});
  result.inputBudget={maxSerializedChars:maxChars,projectionLevel:level,note:'完整序列化输入预算；省略正文可通过列出的读取请求恢复。省略不代表已核验或不存在。'};
  if(encodedSize(result)<=maxChars)return result;
 }
 const error=require('./model-errors.cjs').contextError('CONTEXT_INVALID_REQUEST',{message:'当前必需的要求或不可分页信息超过单轮输入预算，已保留原稿；需要拆分核验要求，不能重试同一超限请求。'});
 error.diagnostic={kind:'input_budget_exceeded',maxChars};throw error;
}
module.exports={prepare,encodedSize,navigation,materialize,relation,DEFAULT_MAX,POLICY_VERSION};
