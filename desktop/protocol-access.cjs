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
 if(!remoteTools.has(tool)&&!tool.startsWith('prepare_')&&!['model','model_request','write_file','lark_create','lark_update','github_create','github_update','github_comment','request_confirmation','read_message'].includes(tool))return;
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
