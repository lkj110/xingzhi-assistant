// UI projections are separate from execution data. Never persist this projection.
const crypto=require('node:crypto'),fs=require('node:fs');
const {AsyncLocalStorage}=require('node:async_hooks');
const request=new AsyncLocalStorage(),cache=new WeakMap(),bodies=new WeakMap();
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function body(row){let previous=bodies.get(row);if(previous?.content===row.content)return previous;const content=String(row.content||'');previous={content,revision:hash(content),preview:content.slice(0,1000).replace(/\s+/g,' ').slice(0,130)};bodies.set(row,previous);return previous;}
const omit=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)));
function source(row){const b=body(row);return {...omit(row,['content','segments','platformArchive']),...(row.platformArchive?{platformArchiveOmitted:true}:{}),content:b.preview,preview:b.preview,segments:[],contentChars:b.content.length,bodyRevision:b.revision,detailDeferred:true};}
function artifact(row){const b=body(row);return {...row,content:'',contentChars:b.content.length,bodyRevision:b.revision,detailDeferred:true};}
function run(row){return {...row,steps:[],stepCount:row.steps?.length||0,detailDeferred:true};}
function projection(data){
 const value={...data,
  sources:data.sources.map(source),artifacts:data.artifacts.map(artifact),
  tasks:data.tasks.map(row=>({...omit(row,['planHistory','generationReads','contextBindings']),planHistory:(row.planHistory||[]).map(entry=>({at:entry.at,version:entry.version,reason:entry.reason,steps:(entry.steps||[]).map(step=>({id:step.id,title:step.title,kind:step.kind,done:step.done}))})),generationReads:[],contextBindings:[]})),
  delegations:data.delegations.map(row=>({...omit(row,['executionState','history','contextReads']),history:[],contextReads:[]})),
  agentRuns:data.agentRuns.map(run),
  agentActions:data.agentActions.map(row=>['pending','running','uncertain'].includes(row.status)?row:{...omit(row,['content','baseline']),content:'',detailDeferred:true}),
  modelCalls:(data.modelCalls||[]).slice(0,8),
  projectChanges:(data.projectChanges||[]).map(row=>omit(row,['snapshot']))
 };
 return require('./public-context.cjs').excludePlatformArchives(clone(value));
}
function stamp(a){
 const paths=require('./access-policy-store.cjs').locations(a);
 const signature=file=>{try{const s=fs.statSync(file);return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs];}catch{return 'unavailable';}};
 return hash([a.data.runtime?.revision,a.data.runtime?.commitId,signature(paths.store),signature(paths.migration),
  require('./execution.cjs').snapshot(a),a.operation,a.streamController?.snapshot(),
  [...(a.accessSessions||[])].map(([id,s])=>[id,s.expiresAt]),
  (a.data.modelCalls||[]).slice(0,8).map(r=>[r.id,r.status,r.lastActivityAt,r.inputTokens,r.outputTokens]),Math.floor(Date.now()/15000)]);
}
function finalize(state){
 for(const value of Object.values(state))if(Array.isArray(value))for(const row of value)if(row&&typeof row==='object'&&row.id)row._viewRevision=hash(row);
 return state;
}
function view(a,input={}){
 const revision=stamp(a);let current=cache.get(a);
 if(current?.revision!==revision){
  const state=a.publicState({summary:true});state.viewRevision=revision;
  const previous=current;current={revision,state,previous:previous?{revision:previous.revision,state:previous.state}:null};cache.set(a,current);
 }
 if(input.revision===revision)return {revision,unchanged:true};
 if(input.revision&&current.previous?.revision===input.revision){
  const patch={},old=current.previous.state;
  for(const [key,value] of Object.entries(current.state)){
   if(JSON.stringify(old[key])===JSON.stringify(value))continue;
   if(Array.isArray(value)&&Array.isArray(old[key])&&[...value,...old[key]].every(r=>r&&typeof r==='object'&&typeof r.id==='string')){
    const prior=new Map(old[key].map(r=>[r.id,r]));
    patch[key]={entities:true,order:value.map(r=>r.id),upsert:value.filter(r=>prior.get(r.id)?._viewRevision!==r._viewRevision)};
   }else patch[key]={value};
  }
  return {revision,baseRevision:input.revision,patch};
 }
 return {revision,state:current.state};
}
function sanitized(a,value){return require('./public-context.cjs').sanitize(a,clone(value));}
function detail(a,input={}){
 if(typeof input.id!=='string'||input.id.length>300)throw Error('详情标识无效');
 const {kind,id}=input;
 if(kind==='modelCalls'&&id==='all')return sanitized(a,{calls:a.data.modelCalls||[]});
 if(kind==='source'||kind==='artifact'){
  const row=a.data[kind==='source'?'sources':'artifacts'].find(r=>r.id===id);
  if(!row||row.deleted||row.projectExcluded)throw Error('内容不存在或已撤回');
  const result=sanitized(a,{[kind]:row})[kind];
  if(result.accessPolicyQuarantined)throw Error('正文权限已撤回或需要恢复');
  return {...result,bodyRevision:body(row).revision,detailDeferred:false};
 }
 if(kind==='agentRun'||kind==='agentStep'){
  const row=a.data.agentRuns.find(r=>r.id===id);if(!row)throw Error('运行记录不存在');
  if(kind==='agentStep'){
   if(!Number.isSafeInteger(input.stepIndex)||input.stepIndex<0||!row.steps?.[input.stepIndex])throw Error('步骤不存在');
   return sanitized(a,{step:row.steps[input.stepIndex]}).step;
  }
  const start=input.start??0,limit=input.limit??20;
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('运行记录分页参数无效');
  const steps=row.steps||[],result=sanitized(a,{...run(row),steps:steps.slice(start,start+limit)});
  // Bound collapsed previews; the explicit step endpoint retains full inspection.
  result.steps=result.steps.map((step,index)=>{const trim=value=>{const text=JSON.stringify(value??null,null,2);return text.length>4000?{preview:text.slice(0,4000),truncated:true}:value;};return {...step,args:trim(step.args),result:trim(step.result),stepIndex:start+index};});
  return {...result,start,total:steps.length,more:start+limit<steps.length};
 }
 throw Error('不支持的详情类型');
}
function command(a,input){if(!input||typeof input.action!=='string'||['uiCommand','stateView','viewDetail'].includes(input.action))throw Error('界面操作无效');return request.run({summary:true,assistant:a,action:input.action},()=>a.dispatch(input.action,input.input||{}));}
module.exports={projection,view,detail,command,summaryRequested:()=>request.getStore()?.summary===true,trustedCommand:(a,action)=>request.getStore()?.assistant===a&&request.getStore()?.action===action,finalize,stamp};
