const policies=require('./access-policy-store.cjs');
const remoteTools=new Set(['read_url','search_web','list_files','read_file','read_lark_document','github_list','github_read','platform_query','capability_call']);
function initialize(a){
 a.requireContextAccessPolicy=true;
 a.contextAccessCheck=({objectType,objectId,jobId,taskId})=>{
  const resourceScope={kind:'snapshot',key:`${objectType}:${objectId}`,...(jobId?{jobId}:{}),...(taskId?{taskId}:{})};
  const checks=['local_retention','local_read'].map(operation=>policies.check(a,{principalScope:policies.LOCAL,resourceScope,operation}));
  return checks.find(c=>!c.allowed)||checks[0];
 };
}
function assertTool(a,job,tool,args={},options={}){
 // Lightweight in-memory protocol fixtures have no persisted policy store.
 if(!a.dir)return;
 if(!remoteTools.has(tool)&&!tool.startsWith('prepare_')&&![...require('./agent-local.cjs').actions,'model','model_request','write_file','lark_create','lark_update','github_create','github_update','github_comment','request_confirmation','read_message'].includes(tool))return;
 return policies.assertTool(a,job,tool==='list_files'?'list_folder':tool,args,options);
}
function allowedObject(a,type,row,job,task){
 if(!row||row.deleted||row.deletedAt||row.projectExcluded)return false;
 if(!a.requireContextAccessPolicy)return !row.accessPolicyQuarantined;
 return a.contextAccessCheck({objectType:type,objectId:row.id,jobId:job?.id,taskId:task?.id}).allowed===true;
}
function retain(a,type,row,{job,task,command='authorized_material',actor='authorization_policy'}={}){
 if(!a.dir)return;
 if(!row||row.deleted||row.deletedAt||row.projectExcluded)return;
 return policies.retainCreated(a,type,row,{job,task,command,actor,trusted:true});
}
function authorizeAction(a,record,command='agentApprove'){
 if(!a.dir)return;
 const job=a.data.delegations.find(j=>j.id===record.jobId);
 for(const request of policies.requestsForTool(a,job,record.tool,record.args,{action:record,taskId:record.taskId}))policies.grant(a,{principalScope:request.principalScope,resourceScope:request.resourceScope,operations:[request.operation]},{trusted:true,actor:'user_command',command});
}
async function currentLarkPrincipal(a,{signal}={}){
 const lark=require('./lark-connector.cjs');let raw;
 const status=await lark.status(async(args,options)=>{raw=await a.connectorRequest(args,{...options,signal});return raw;});signal?.throwIfAborted();
 if(!status.installed)throw Object.assign(Error('飞书 CLI 不可用'),{connectorCode:'missing_cli'});
 if(!status.loggedIn||!status.openId)throw Object.assign(Error('飞书当前用户身份未验证，请重新登录并授权'),{connectorCode:'auth',code:'ACCESS_PRINCIPAL_UNKNOWN'});
 const tenantId=raw?.identities?.user?.tenantId;
 return {status,principalScope:{kind:'account',provider:'lark',subject:status.openId,...(tenantId?{tenantId}:{})}};
}
async function readLarkDocument(a,job,target,{signal=a.controller?.signal,principalScope,assert=()=>{},action}={}){
 const lark=require('./lark-connector.cjs');target=lark.docTarget(target);
 const args={url:target},options=principalScope?{principalScope}:{};
 // Unknown/revoked scopes do not even issue an identity request. An action
 // readback must name its actual original receipt, under the current policy.
 const authorize=p=>{
   if(action){if(action.jobId!==job.id||lark.docTarget(action.result?.url)!==target)throw Error('交付核对超出原动作授权范围');return assertTool(a,job,'prepare_'+action.tool,action.args,{taskId:action.taskId,principalScope:p});}
   return assertTool(a,job,'read_lark_document',args,{...options,...(p?{principalScope:p}:{})});
 };
 authorize(principalScope);assert();
 const expected=principalScope||(action?{kind:'account',provider:'lark',subject:action.larkOpenId}:policies.requestsForTool(a,job,'read_lark_document',args)[0].principalScope);
 const identity=await currentLarkPrincipal(a,{signal});assert();
 if(!expected||identity.principalScope.subject!==expected.subject||(expected.tenantId&&identity.principalScope.tenantId!==expected.tenantId))throw Object.assign(Error('飞书账号已变化，当前账号未获此资源授权，请重新确认授权范围'),{connectorCode:'auth',code:'ACCESS_PRINCIPAL_CHANGED'});
 authorize(identity.principalScope);
 if(a.activeAgentJob)require('./execution-gate.cjs').assert(a,{job,readOnly:true});
 const result=await lark.page({kind:'document',target},{},async(args,options)=>{
   signal?.throwIfAborted();assert();authorize(identity.principalScope);
   return a.connectorRequest(args,{...options,signal});
 },signal);
 signal?.throwIfAborted();assert();authorize(identity.principalScope);
 return {result,principalScope:identity.principalScope};
}
module.exports={initialize,assertTool,allowedObject,retain,authorizeAction,currentLarkPrincipal,readLarkDocument};

// Only ownership metadata is indexed, for one synchronous read attempt. Policy
// decisions are always rechecked and no index survives a request or its retry.
const readContexts=new WeakMap();
function canonical(rows){
 const index=new Map();
 for(const row of rows||[])index.set(row.id,index.has(row.id)?null:row);
 return index;
}
function buildReadContext(a){
 const sources=canonical(a.data.sources),artifacts=canonical(a.data.artifacts),tasks=canonical(a.data.tasks),jobs=canonical(a.data.delegations);
 const taskContexts=new Map(),sourceOwners=new Map(),sourceJobs=new Map(),jobSources=new Map(),jobTasks=new Map();
 for(const job of jobs.values())if(job&&!job.deleted&&!job.deletedAt){jobSources.set(job,new Set(job.sourceIds||[]));jobTasks.set(job,new Set(job.taskIds||[]));}
 const append=(index,id,value)=>{if(!index.has(id))index.set(id,[]);index.get(id).push(value);};
 for(const task of tasks.values()){
  if(!task||task.deleted||task.deletedAt||task.agentCancelled)continue;
  const job=task.agentJobId?jobs.get(task.agentJobId):null;
  if(task.agentJobId&&(!jobTasks.get(job)?.has(task.id)||(task.projectId||null)!==(job.projectId||null)))continue;
  const context={task,job,projectId:task.projectId||null,scope:{taskId:task.id,...(job?{jobId:job.id}:{})}};
  taskContexts.set(task.id,context);
  const excluded=new Set(task.supersededSourceIds||[]);
  const ids=new Set([...(task.sourceIds||[]),...(task.contextBindings||[]).filter(b=>b.state==='active').map(b=>b.sourceId)]);
  for(const id of ids)if(!excluded.has(id)&&(!job||jobSources.get(job).has(id)))append(sourceOwners,id,context);
 }
 for(const job of jobs.values())if(job&&!job.deleted&&!job.deletedAt)for(const id of new Set(job.sourceIds||[]))append(sourceJobs,id,job);
 return {sources,artifacts,tasks,jobs,taskContexts,sourceOwners,sourceJobs,jobSources};
}
function readContext(a){return readContexts.get(a)||buildReadContext(a);}
function readTaskContext(a,task){
 const context=task&&readContext(a).taskContexts.get(task.id);
 return context?.task===task?context:null;
}
function readScopes(a,type,row,{task,projectId}={}){
 if(!['source','artifact'].includes(type)||require('./evidence-links.cjs').withdrawn(row)||row.state==='withdrawn')return [];
 const index=readContext(a),table=type==='source'?index.sources:index.artifacts;
 if(table.get(row.id)!==row)return [];
 const declaredJob=row.jobId||row.agentJobId;
 if(row.jobId&&row.agentJobId&&row.jobId!==row.agentJobId)return [];
 if(declaredJob){const job=index.jobs.get(declaredJob);if(!index.jobSources.has(job)||row.projectId&&(row.projectId||null)!==(job.projectId||null)||type==='source'&&!index.jobSources.get(job).has(row.id))return [];}
 const owner=type==='artifact'?index.taskContexts.get(row.taskId):null;
 const contexts=type==='artifact'?(owner&&(!declaredJob||declaredJob===owner.job?.id)?[owner]:[]):index.sourceOwners.get(row.id)||[];
 const compatible=c=>(type==='artifact'?(!row.projectId||row.projectId===c.projectId):(row.projectId||null)===c.projectId)&&(!projectId||c.projectId===projectId)&&(!declaredJob||declaredJob===c.job?.id)&&(!row.taskId||row.taskId===c.task.id);
 // A declared owner must itself be canonical and hold this source. A global
 // grant cannot repair a dangling/conflicting declaration or admit another task.
 if(type==='source'&&row.taskId&&!contexts.some(c=>c.task.id===row.taskId&&compatible(c)))return [];
 if(type==='artifact'&&!contexts.some(compatible))return [];
 if(task){const c=contexts.find(c=>c.task===task);return c&&compatible(c)?[c.scope]:[];}
 if(projectId&&(row.projectId||owner?.projectId||null)!==projectId)return [];
 const scopes=[{},...contexts.filter(compatible).map(c=>c.scope)];
 if(type==='source'){
  const direct=declaredJob&&index.jobs.get(declaredJob);
  const jobs=new Set(index.sourceJobs.get(row.id)||[]);if(direct)jobs.add(direct);
  for(const j of jobs)if(!j.deleted&&!j.deletedAt&&(!declaredJob||declaredJob===j.id)&&(!row.taskId||index.taskContexts.get(row.taskId)?.job===j)&&(row.projectId||null)===(j.projectId||null)&&(!projectId||j.projectId===projectId))scopes.push({jobId:j.id});
 }
 return scopes;
}
function canReadSnapshot(a,type,row,options={}){
 if(typeof a.contextAccessCheck!=='function')return false;
 return readScopes(a,type,row,options).some(scope=>a.contextAccessCheck({objectType:type,objectId:row.id,...scope}).allowed===true);
}
function readStamp(a){
 const metadata=['sources','artifacts','tasks','delegations'].map(table=>(a.data[table]||[]).map(r=>[r.id,r.taskId,r.jobId,r.agentJobId,r.projectId,r.deleted,r.deletedAt,r.withdrawn,r.withdrawnAt,r.contentDeleted,r.state,r.projectExcluded,r.agentCancelled,r.taskIds,r.sourceIds,r.supersededSourceIds,r.contextBindings,r.updatedAt]));
 return policies.hash({authority:a.dir?policies.authorityStamp(a):null,metadata});
}
function derivedRead(a,read){
 if(readContexts.has(a))return read(); // The outer attempt owns the freshness check.
 for(let i=0;i<2;i++){
  const stamp=readStamp(a);readContexts.set(a,buildReadContext(a));
  try{const result=read();if(stamp===readStamp(a))return result;}
  finally{readContexts.delete(a);}
 }
 throw Object.assign(Error('读取期间权限或归属发生变化，请重试'),{code:'CONTEXT_VERSION_CHANGED'});
}
Object.assign(module.exports,{readTaskContext,readScopes,canReadSnapshot,derivedRead});
