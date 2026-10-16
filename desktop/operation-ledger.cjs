const evidence=require('./evidence-basis.cjs');
const platform=require('./data-platform.cjs');
const now=()=>new Date().toISOString();
const freshMs=15*60000;
const processes=new WeakMap();
function unverifiedScope(a){if(!processes.has(a))processes.set(a,require('node:crypto').randomUUID());return processes.get(a)+':'+(a.activeAgentRun?.id||'direct');}
function state(job){return job.executionState ||= {version:2,permissionRevision:0,operations:{},requirements:[],gaps:[],reads:{},recoveries:{},events:[]};}
function epoch(job){return evidence.hash({goal:job.executionContract?.revision||job.goal,feedback:evidence.feedback(job.feedback),permissionRevision:job.executionState?.permissionRevision||0});}
function key(job,query){return evidence.hash({jobId:job.id,projectId:job.projectId||null,scope:job.dataPlatform,principal:job.platformPrincipal||null,request:platform.command(query)});}
function classify(error){
 if(['AUTH_REQUIRED','TRANSIENT','INVALID_PLATFORM_RESPONSE','INVALID_ARGUMENT','NOT_FOUND'].includes(error.code))return error.code;
 const code=Number(error.providerCode||error.status||error.statusCode||error.code);
 if(code===429||code>=500&&code<=599)return 'TRANSIENT';
 if(code===401||code===403)return 'AUTH_REQUIRED';
 if(error.connectorCode==='permission'||/没有.*读取权限|没有.*访问权限|权限不足|无访问权限|无权限|无权|permission denied|access denied/i.test(error.message))return 'AUTH_REQUIRED';
 if(/120 秒|timeout|网络|暂时|连接|ECONN|unavailable/i.test(error.message))return 'TRANSIENT';
 if(/未返回成功的结构化结果/.test(error.message))return 'INVALID_PLATFORM_RESPONSE';
 if(code===404)return 'NOT_FOUND';
 if(code===400||/参数|argument|invalid input/i.test(error.message))return 'INVALID_ARGUMENT';
 return 'INVALID_PLATFORM_RESPONSE';
}
const permissionFailure=operation=>operation?.status==='failed'&&operation.errorCode==='AUTH_REQUIRED';
const stableFailure=operation=>operation?.status==='failed'&&['AUTH_REQUIRED','NOT_FOUND'].includes(operation.errorCode);
// A typed denial or missing-resource response is a negative fact, not a
// successful evidence cache or an acceptance decision. Business feedback/work
// revisions cannot change it. Missing resources match exact query parameters;
// only permission denials may reuse the same direction across depth changes.
// V2 records omitted permissionRevision: only revision zero is provable there.
function valid(job,operation,a){
 if(!operation||evidence.hash(operation.principal||null)!==evidence.hash(job.platformPrincipal||null)||(operation.scope!==undefined&&operation.scope!==job.dataPlatform)||(operation.projectId!==undefined&&operation.projectId!==(job.projectId||null)))return false;
 if(stableFailure(operation)){
  if((operation.permissionRevision??0)!==(state(job).permissionRevision||0))return false;
  if(operation.scope===undefined&&job.dataPlatform!=='sg-readonly')return false;
  if(operation.scope===undefined&&operation.key&&operation.key!==key(job,operation.query))return false;
  if(a?.dir&&job.platformPrincipal){const check=require('./access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[operation.query]});if(!check.allowed||(operation.policy?policyProof(check)!==operation.policy:check.grantRevision!==1))return false;}
  return true;
 }
 return (!operation.epoch?state(job).permissionRevision===0:operation.epoch===epoch(job))&&(operation.workRevision===undefined||operation.workRevision===(job.workRevision??1));
}
// Depth changes do not change the denied task/direction. Keep explicit project
// IDs distinct: an omitted project is not proof of a particular project ID.
function permissionRequest(query){return platform.command(['upstream','downstream'].includes(query.op)?{...query,depth:1}:query);}
function eligibility(job,operation,time=Date.now()){
 if(!valid(job,operation))return {action:'execute',reason:'scope_changed'};
 if(operation.status==='failed'){
  if(operation.errorCode==='AUTH_REQUIRED')return {action:'request_access',reason:operation.error};
  if(['INVALID_ARGUMENT','NOT_FOUND'].includes(operation.errorCode))return {action:'repair_input',reason:operation.error};
  const retryAt=Date.parse(operation.retryAt||'')||Date.parse(operation.completedAt||'')+freshMs;
  return retryAt>time?{action:'wait_until',retryAt:new Date(retryAt).toISOString(),reason:operation.error}:{action:'execute',reason:'retry_due'};
 }
 return {action:operation.status==='done'&&time-Date.parse(operation.completedAt)<freshMs?'reuse':'execute'};
}
function activeFailure(job,query,a){
 const request=JSON.stringify(platform.command(query)),resource=JSON.stringify(permissionRequest(query));
 const operation=Object.values(state(job).operations).reverse().filter(o=>o.query&&(JSON.stringify(platform.command(o.query))===request||permissionFailure(o)&&JSON.stringify(permissionRequest(o.query))===resource)&&valid(job,o,a)).sort((x,y)=>(Date.parse(y.startedAt||y.completedAt)||0)-(Date.parse(x.startedAt||x.completedAt)||0))[0];
 return operation?.status==='failed'&&eligibility(job,operation).action!=='execute'?operation:null;
}
function lookup(a,job,query){
 let operation=state(job).operations[key(job,query)];
 if(!operation||!valid(job,operation,a)){const failure=activeFailure(job,query,a);operation=stableFailure(failure)?failure:null;}
 if(!operation||!valid(job,operation,a)||!stableFailure(operation)&&operation.epoch!==epoch(job)||!job.platformPrincipal&&operation.unverifiedScope!==unverifiedScope(a))return null;
 if(operation.status==='done'){
  const source=a.data.sources.find(s=>s.id===operation.sourceId&&job.sourceIds.includes(s.id)&&!s.deleted&&!s.projectExcluded);
  if(!source||evidence.hash(source.platformPrincipal||null)!==evidence.hash(job.platformPrincipal||null)||!require('./protocol-access.cjs').allowedObject(a,'source',source,job)||a.data.sources.some(s=>s.previousSourceId===source.id&&!s.projectExcluded)||Date.now()-Date.parse(operation.completedAt)>=freshMs)return null;
  try{return {snapshot:JSON.parse(source.content),operation,reused:true};}catch{return null;}
 }
 if(operation.status==='failed'&&eligibility(job,operation).action!=='execute')return {operation,error:operation.error,errorCode:operation.errorCode,reused:true};
 return null;
}
const batches=new WeakSet();
const boundary=job=>evidence.hash({id:job.id,projectId:job.projectId||null,scope:job.dataPlatform,principal:job.platformPrincipal||null,epoch:epoch(job),workRevision:job.workRevision??1});
const stale=()=>Object.assign(Error('查询期间账号、权限或执行范围已变化；旧结果保留为历史，不作为当前证据'),{code:'OPERATION_STALE'});
function policyProof(result){return evidence.hash({policyId:result?.policyId,grantRevision:result?.grantRevision});}
function assertCurrent(a,job,batch,query){
 if(!batches.has(batch)||batch.a!==a||batch.job!==job||boundary(job)!==batch.boundary||a.data.delegations?.find(j=>j.id===job.id)!==job)throw stale();
 require('./execution-gate.cjs').assert(a,{job,readOnly:true});
 const check=require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[query]});
 if(policyProof(check)!==batch.policy)throw stale();
 return check;
}
async function prepareBatch(a,job){
 const policy=require('./access-policy-store.cjs');
 require('./execution-gate.cjs').assert(a,{job,readOnly:true});
 // Only the authority can prove a pending explicit bootstrap intent. A field
 // restored from workspace, a cached identity, or a CLI credential cannot do so.
 const token=policy.beginPlatformIdentity(a,job);
 const initial=boundary(job);
 const identity=await platform.query(job,{op:'identity'},{signal:a.controller?.signal,request:a.platformRequest,beforeRequest:()=>{
  require('./execution-gate.cjs').assert(a,{job,readOnly:true});
  if(boundary(job)!==initial)throw stale();
  require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[{op:'identity'}]});
 }});
 require('./execution-gate.cjs').assert(a,{job,readOnly:true});
 if(boundary(job)!==initial)throw stale();
 const username=identity.data.username;
 if(typeof username!=='string'||!username.trim()||username.length>4096||/[\x00-\x1f]/.test(username))throw Object.assign(Error('无法验证当前平台账号；请重新登录后继续查询'),{code:'AUTH_REQUIRED'});
 policy.bindPlatformIdentity(a,job,identity.data,token);
 const check=require('./protocol-access.cjs').assertTool(a,job,'platform_query',{queries:[{op:'projects'}]});
 const s=state(job);s.principalRun=a.activeAgentRun?.id||null;s.principalCheckedAt=now();
 const batch=Object.freeze({a,job,boundary:boundary(job),policy:policyProof(check),identity});batches.add(batch);a.save();return batch;
}
function preserveHistorical(a,job,operation,observations){
 Object.assign(operation,{status:'superseded',presentationStatus:'historical',completedAt:now()});
 const policy=require('./access-policy-store.cjs');
 const liveJob=a.data.delegations?.find(j=>j.id===job.id);
 const retained=!!a.dir&&liveJob&&!liveJob.deletedAt&&policy.check(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',jobId:job.id},operation:'local_retention'}).allowed;
 operation.observations=observations.map(({query,data})=>({query,principal:operation.principal,observedAt:now(),contentHash:evidence.hash(data),...(retained?{data}:{bodyOmitted:true})}));
 // Recovery can replace the in-memory job while the CLI is outstanding. Keep
 // its fact in the current workspace, without reattaching a deleted job.
 if(liveJob!==job){
  const current=liveJob&&state(liveJob),copy=structuredClone(operation);
  if(current?.operations[operation.key]?.id===operation.id)Object.assign(current.operations[operation.key],copy);
  else {
   const owner=current||(a.data.runtime ||= {}),key=current?'history':'platformOperationHistory';
   const history=owner[key] ||= [],prior=history.find(r=>r.id===operation.id);
   if(prior)Object.assign(prior,copy);else history.push({...copy,jobId:job.id});
  }
 }
 a.save();
}
async function fetch(a,job,query,{batch,retry=false}={}){
 platform.command(query);
 // Authenticate once for each batch, even when every result will be cached.
 batch ||= await prepareBatch(a,job);
 assertCurrent(a,job,batch,query);
 // retry is an explicit caller option, never inferred from feedback or passed
 // through model query arguments. It still runs identity/policy/gate checks.
 const found=query.op==='identity'||retry===true?null:lookup(a,job,query);if(found&&(!found.operation.policy||found.operation.policy===batch.policy)){state(job).reusedQueries=(state(job).reusedQueries||0)+1;return found;}
 const ledger=state(job),requestKey=key(job,query),prior=ledger.operations[requestKey];
 const operation={id:require('node:crypto').randomUUID(),key:requestKey,query:structuredClone(query),epoch:epoch(job),permissionRevision:ledger.permissionRevision||0,scope:job.dataPlatform,projectId:job.projectId||null,workRevision:job.workRevision??1,principal:structuredClone(job.platformPrincipal||null),policy:batch.policy,unverifiedScope:job.platformPrincipal?null:unverifiedScope(a),status:'running',attempt:(prior?.attempt||0)+1,startedAt:now(),previousSourceId:prior?.sourceId||null};
 if(prior)(ledger.history ||= []).push(structuredClone(prior));
 if(retry===true)for(const old of Object.values(ledger.operations))if(permissionFailure(old)&&valid(job,old,a)&&JSON.stringify(permissionRequest(old.query))===JSON.stringify(permissionRequest(query)))Object.assign(old,{status:'superseded',resolvedBy:operation.id});
 ledger.operations[requestKey]=operation;a.save();
 const observations=[];
 try{
  const snapshot=query.op==='identity'?structuredClone(batch.identity):await platform.query(job,query,{signal:a.controller?.signal,request:a.platformRequest,
   beforeRequest:child=>assertCurrent(a,job,batch,child),
   afterResponse:(child,data)=>{observations.push({query:structuredClone(child),data});assertCurrent(a,job,batch,child);}
  });
  assertCurrent(a,job,batch,query);
  if(!valid(job,operation)||ledger.operations[requestKey]!==operation)throw stale();
  return {snapshot,operation,reused:false};
 }catch(error){
  let changed=false;try{assertCurrent(a,job,batch,query);}catch{changed=true;}
  if(error.code==='OPERATION_STALE'||changed){preserveHistorical(a,job,operation,observations);throw stale();}
  a.controller?.signal.throwIfAborted();Object.assign(operation,{status:'failed',error:error.message,errorCode:classify(error),completedAt:now()});
  if(!['AUTH_REQUIRED','INVALID_ARGUMENT','NOT_FOUND'].includes(operation.errorCode))operation.retryAt=new Date(Date.now()+Math.max(Number(error.retryAfterMs)||0,Math.min(900000,60000*2**Math.min(operation.attempt-1,4))*(.9+Math.random()*.2))).toISOString();
  if(error.providerCode)operation.providerCode=error.providerCode;
  a.save();return {operation,error:operation.error,errorCode:operation.errorCode,reused:false};
 }
}
function finish(a,job,operation,sourceId){
 Object.assign(operation,{status:'done',sourceId,completedAt:now()});const s=state(job);
 for(const old of Object.values(s.operations))if(old!==operation&&old.status==='failed'&&valid(job,old)){
  const query={...operation.query};if(old.query.projectId===undefined)delete query.projectId;
  if(JSON.stringify(platform.command(old.query))===JSON.stringify(platform.command(query))||permissionFailure(old)&&JSON.stringify(permissionRequest(old.query))===JSON.stringify(permissionRequest(operation.query)))Object.assign(old,{status:'superseded',resolvedBy:operation.id});
 }
 s.operations[key(job,operation.query)]=operation;
}
function snapshot(job){return Object.values(state(job).operations).map(o=>({query:o.query,status:o.status,sourceId:o.sourceId,errorCode:o.errorCode,error:o.error,completedAt:o.completedAt,retryAt:o.retryAt,decision:eligibility(job,o)}));}
function normalize(tool,args={}){
 const value=require('./tool-registry.cjs').parameters(tool,args);delete value.reason;
 if(tool==='platform_query')return {tool,queries:(value.queries||[]).map(platform.command).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
 if(['read_source','search_source','read_artifact','read_platform','list_sources','read_work_state','platform_inventory'].includes(tool)){
  value.start=Number(value.start||0);if(tool==='read_source'||tool==='search_source')value.limit=Number(value.limit||6);
  if(tool==='read_platform')value.limit=Number(value.limit||50);
  if(tool==='list_sources'||tool==='read_work_state')value.limit=Number(value.limit||40);
  if(tool==='platform_inventory'){value.limit=Number(value.limit||100);value.queryStart=Number(value.queryStart||0);}
 }
 if(Array.isArray(value.sourceIds))value.sourceIds=[...new Set(value.sourceIds)].sort();
 if(tool==='plan_task'){delete value.title;delete value.description;delete value.reason;value.steps=value.steps?.map(s=>({key:s.key,kind:s.kind,tool:s.tool}));}
 return {tool,args:value};
}
function event(job,row){const s=state(job);s.events=[...s.events,structuredClone({...row,at:now()})].slice(-150);}
module.exports={state,epoch,key,lookup,prepareBatch,fetch,finish,snapshot,normalize,event,freshMs,classify,valid,eligibility,activeFailure};
