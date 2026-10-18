const crypto=require('node:crypto');
const lark=require('./lark-connector.cjs');
const decisions=require('./decisions.cjs');
const now=()=>new Date().toISOString();
const text=(v,max=2000)=>typeof v==='string'?v.trim().slice(0,max):'';
const permissionPattern=/授权|权限|登录|未允许|permission|forbidden|unauthenticated|unauthorized|access.denied|missing.scope|\b(?:401|403)\b/i;
// Legacy message matching is restricted to these actual external tool contracts.
// File and app-local tools must retain their own scope/controller diagnostics.
const recoveryTools=new Set(['read_url','search_web','read_lark_document','lark_create','lark_update','github_list','github_read','github_create','github_update','github_comment','platform_inventory','read_platform','platform_query','capability_call']);
const connectorAccessCodes=new Set(['auth','permission','missing_cli']);
const externalAccessCodes=new Set(['AUTH_REQUIRED','ACCESS_POLICY_UNKNOWN','ACCESS_POLICY_REVOKED','ACCESS_PRINCIPAL_UNKNOWN','ACCESS_PRINCIPAL_CHANGED']);
const internalRecoveryPrefixes=['CONTEXT_','MODEL_','STORAGE_','EXECUTION_','POLICY_','BUDGET_','SPEND_','STEWARDSHIP_','WORK_JOURNAL_','ENGINE_'];
const internalRecoveryCodes=new Set(['EXTERNAL_EFFECT_UNCERTAIN','ACCESS_POLICY_STORAGE_FAILURE','ACCESS_POLICY_INVALID_REQUEST','EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO']);
function recoveryCandidate(tool,error){
  if(!error||error.contextFailure||error.modelFailure||error.localPersistence||error.gateClosed||error.spendLimit||error.stewardshipBudget||error.stewardshipMeter||error.noProgress||error.planInputInvalid||error.invalidDelivery||error.conflict||error.name==='AbortError')return false;
  const code=String(error.code||'');
  // Stronger internal domains win even when connector metadata also says auth.
  if(internalRecoveryCodes.has(code)||internalRecoveryPrefixes.some(prefix=>code.startsWith(prefix))||['diagnose_storage','system_diagnostic'].includes(error.recovery))return false;
  if(code==='ACCESS_POLICY_UNKNOWN'&&['unwritable','corrupt_or_incomplete'].includes(error.reason))return false;
  if(!recoveryTools.has(tool))return false;
  // An unknown typed failure is not a legacy permission message or connector
  // authorization failure. Known internal codes stay authoritative above.
  if(code&&!externalAccessCodes.has(code)&&!['401','403'].includes(code))return false;
  if(error.connectorCode)return connectorAccessCodes.has(error.connectorCode);
  if(externalAccessCodes.has(code)||['401','403'].includes(code))return true;
  return [401,403].includes(error.httpStatus)||permissionPattern.test(error.message||'');
}
const labels={lark_create:'在飞书创建文档',lark_document:'读取飞书文档',web:'读取公开网页',external:'检查外部访问权限'};
function localToolRequest(args={}){
  const q=typeof args.question==='string'?args.question:'',context=typeof args.context==='string'?args.context:'';
  return q.length<=2000&&/(?:应用|app|advance_task|read_artifact|read_output_state)/i.test(q)&&/(?:没有|未提供|未开放|未启用|不可用|缺少|无法调用)/.test(q)&&/工具/.test(q)&&/(?:推进事项|读取(?:稿件|文稿)|advance_task|read_artifact|read_output_state)/.test(q)&&!/(?:是否|还是|选择|同意|确认|授权|权限|登录|费用|预算|飞书|lark|github|仓库|外部|生产|数据库|删除|发送|发布)/i.test(q+' '+context);
}
function localToolEvidence(a,j,args={}){
  active(a,j);
  if(args.taskIds&&(!Array.isArray(args.taskIds)||args.taskIds.some(id=>!j.taskIds.includes(id))))throw Error('问题只能关联本委托事项');
  const state=localOutput(a,j,{});
  return {...state,availableApplicationTools:['advance_task','read_artifact','read_output_state','read_source','search_source'],guidance:'这些应用工具已提供，通过返回 JSON 的 tool 与 args 调用，由 App 执行；不是模型宿主的工具列表。请基于当前事项继续，读取工具存在不代表缺失的业务事实已经补齐。'};
}
function resumeLocalTool(a,j){
  if(['paused','completed','limited','approval','review'].includes(j.status)||a.data.decisions.some(d=>d.jobId===j.id&&d.status==='open')||require('./projects.cjs').relatedActions(a,j).some(r=>['pending','running','uncertain'].includes(r.status)))return;
  const tasks=j.taskIds.map(id=>a.task(id)).filter(t=>!t.deletedAt&&!t.agentCancelled&&!t.needsReplan&&['todo','blocked'].includes(t.status)&&t.steps.length&&t.steps.every(s=>['analysis','draft'].includes(s.kind)));
  if(tasks.length!==1)return;
  const task=tasks[0];try{require('./agent-plan.cjs').assertReady(a,task);}catch{return;}
  const error=require('./model-errors.cjs').modelError('MODEL_INVALID_RESPONSE','已核对应用内置工具可用，将从原事项继续',true);
  error.recoveryContext={taskId:task.id,stage:task.steps.every(s=>s.done)?'task_verify':'task_work'};
  require('./auto-recovery.cjs').schedule(a,j,error);
}
function localOutputRequest(args={}){
  if(args.kind&&args.kind!=='external')return false;
  const value=[args.target,args.reason,args.question,args.key].filter(Boolean).join(' ');
  return /(?:本应用|本地工作台|应用中|App\s*内|事项的?产出|委托的?产出|app_workspace)/i.test(value)&&/(?:版本(?:状态|记录|元数据)|current\s*\/\s*archive|产出.*(?:状态记录|元数据)|artifact.*(?:state|metadata))/i.test(value)&&!docURLs(args.target).length;
}
function localOutput(a,j,args){active(a,j);return {needsAuthorization:false,...require('./output-state.cjs').read(a,j,args.taskId?{taskId:args.taskId}:{})};}
function docURLs(value){
  return [...new Set((String(value||'').match(/https:\/\/[^\s/]+\/(?:docx|wiki)\/[A-Za-z0-9]+/g)||[]).flatMap(url=>{try{return [lark.docTarget(url)];}catch{return [];}}))];
}
function jobURLs(a,j){return docURLs([j.goal,...j.urls,...a.data.sources.filter(s=>j.sourceIds.includes(s.id)&&!s.deleted&&!s.projectExcluded).map(s=>s.content)].join('\n'));}
function active(a,j){require('./project-lifecycle.cjs').assertJobActive(a.data,j);if(!a.data.delegations.includes(j)||j.status==='completed')throw Error('委托已结束或已变化');if(j.taskIds.length&&!j.taskIds.some(id=>{const t=a.data.tasks.find(t=>t.id===id);return t&&!t.deletedAt&&!t.agentCancelled;}))throw Error('关联事项已删除或取消');}
function assertCurrent(a,j,d){active(a,j);if(!a.data.decisions.includes(d)||d.status!=='open')throw Error('授权请求已变化，请刷新');}
function wantsLarkCreate(args={}){return /飞书|lark/i.test([args.target,args.reason,args.question].join(' '))&&/(?:创建|新建|发布|转成|转为).{0,30}(?:文档|交接)|文档创建/.test([args.target,args.reason,args.question].join(' '));}
function request(a,j,args={}){
  active(a,j);
  if(localOutputRequest(args))return localOutput(a,j,args);
  const kind=(!args.kind||args.kind==='external')&&wantsLarkCreate(args)?'lark_create':Object.hasOwn(labels,args.kind)?args.kind:'external';
  const target=kind==='lark_create'?require('./lark-publish.cjs').destination(args.kind==='lark_create'?args.target:undefined):kind==='lark_document'?lark.docTarget(args.target):kind==='web'?'当前委托的公开网页读取':text(args.target||'当前工具的访问范围',1000);
  const key=`access:${kind}:${target}`;
  let d=a.data.decisions.find(d=>d.jobId===j.id&&d.kind==='permission'&&d.key===key&&d.status==='open');
  if(!d){d={id:crypto.randomUUID(),jobId:j.id,projectId:j.projectId||null,kind:'permission',decisionType:'choice',key,status:'open',question:`需要授权：${labels[kind]}`,suggestion:kind==='lark_create'?'连接你的飞书身份并校验创建权限；Agent 准备好文稿后，会单独展示内容与保存位置供你确认。':kind==='lark_document'?'先连接你的飞书用户身份，再验证这份文档是否可读。授权成功后，原事项会继续。':kind==='web'?'允许此委托读取公开网页；登录后的私有内容需要对应连接器。':'请在对应平台或委托设置中补齐访问权限，再回来重新检查。',taskIds:j.taskIds.filter(id=>{const t=a.task(id);return !t.deletedAt&&!t.agentCancelled;}),sourceIds:[...j.sourceIds].slice(-10),createdAt:now(),updatedAt:now(),access:{kind,target,reason:text(args.reason||'完成事项所需材料暂时无法读取'),stage:'requested'}};a.data.decisions.unshift(d);a.event('事项需要授权',`${labels[kind]}：${target}`,d.taskIds[0]||null,'warning');}
  if(j.status!=='paused')j.status='needs_input';j.nextRunAt=null;j.summary=d.question;a.save();return {needsAuthorization:true,decisionId:d.id,kind,target};
}
function fromQuestion(a,j,args){
  if(localToolRequest(args)){const result=localToolEvidence(a,j,args);resumeLocalTool(a,j);a.event('已纠正应用工具可用性误判',result.guidance);a.save();return result;}
  if(localOutputRequest(args))return localOutput(a,j,args);
  if(!permissionPattern.test(`${args.question||''} ${args.key||''}`)||/额度|美元|预算|用量|花费/.test(args.question||''))return null;
  if(wantsLarkCreate(args))return request(a,j,{kind:'lark_create',reason:args.question});
  const urls=jobURLs(a,j);if(urls.length===1&&/飞书|lark|文档/i.test(`${args.question} ${args.key||''}`)){
    const source=a.data.sources.find(s=>j.sourceIds.includes(s.id)&&s.remoteId===urls[0]&&!s.deleted&&!s.projectExcluded);
    if(source&&(j.documentGrants||[]).some(g=>g.target===urls[0]))return {alreadyAuthorized:true,sourceId:source.id,message:'原文已读取，请使用已取得的来源继续；读取失败时再申请恢复。'};
    return request(a,j,{kind:'lark_document',target:urls[0],reason:args.question});
  }
  return request(a,j,{kind:'external',target:text(args.key||'当前工具的访问范围',200),reason:args.question});
}
function initialize(a){
  cancel(a);a.accessSessions=new Map();
  for(const d of a.data.decisions.filter(d=>d.status==='open'&&d.kind==='question'&&localToolRequest(d))){
    const j=a.data.delegations.find(j=>j.id===d.jobId);if(!j)continue;
    try{const evidence=localToolEvidence(a,j,d);Object.assign(d,{status:'resolved',answer:evidence.guidance,answeredAt:now(),updatedAt:now(),localEvidence:evidence});j.feedback.push({at:now(),text:evidence.guidance,origin:'app_recovery'});j.feedback=j.feedback.slice(-30);
      if(j.status==='needs_input'&&!a.data.decisions.some(x=>x.jobId===j.id&&x.status==='open')){j.status='ready';j.nextRunAt=now();j.summary='已核对应用工具可用，将继续原事项';}
      resumeLocalTool(a,j);a.event('已纠正应用工具可用性误判',evidence.guidance,d.taskIds?.[0]||null);
    }catch{/* Keep deleted or archived work and genuine user decisions unchanged. */}
  }
  // Correct only app-local metadata requests. This does not grant external
  // access, confirm a version change, or alter the existing spending scope.
  for(const d of a.data.decisions.filter(d=>d.status==='open'&&(d.kind==='permission'&&localOutputRequest(d.access)||d.kind==='question'&&localOutputRequest(d)))){
    const j=a.data.delegations.find(j=>j.id===d.jobId);if(!j)continue;
    try{
      const state=localOutput(a,j,{}),note='此前误将本地产出版本状态当作外部授权。应用已提供 read_output_state；先核对真实状态，再按原目标继续。读取不代表旧稿已归档，外部权限和累计预算均保持原样。';
      Object.assign(d,{status:'resolved',answer:note,answeredAt:now(),updatedAt:now(),localEvidence:state});if(d.access)d.access.stage='local';
      j.feedback.push({at:now(),text:note,origin:'app_recovery'});j.feedback=j.feedback.slice(-30);
      if(j.status==='needs_input'&&!a.data.decisions.some(x=>x.jobId===j.id&&x.status==='open')){j.status='ready';j.nextRunAt=now();j.lastError='';j.summary='本地产出状态已可读取，Agent 将继续核对';}
      a.event('已纠正本地产出状态的授权误判',note,d.taskIds?.[0]||null);
    }catch{/* Deleted or archived scopes stay blocked until explicitly restored. */}
  }
  for(const d of a.data.decisions.filter(d=>d.kind==='permission'&&d.status==='open'))if(['checking','waiting_login','authorized'].includes(d.access?.stage)){d.access.stage='retry';d.access.message='上次授权检查已中断，请重新连接或检查。';d.updatedAt=now();}
  // Upgrade unsupported generic Lark creation prompts without granting or writing.
  for(const d of a.data.decisions.filter(d=>d.kind==='permission'&&d.status==='open'&&d.access?.kind==='external'&&wantsLarkCreate(d.access))){
    d.access={...d.access,kind:'lark_create',target:'my_library',stage:'requested',message:'已接入飞书文档创建。请连接并检查；创建前会展示文稿供你确认。'};
    d.key='access:lark_create:my_library';d.question='需要授权：在飞书创建文档';d.updatedAt=now();
    const j=a.data.delegations.find(j=>j.id===d.jobId);if(j)j.summary=d.question;
  }
  // Upgrade unresolved authorization questions only. Earlier answers remain as audit evidence.
  for(const d of [...a.data.decisions])if(d.kind==='question'&&d.status==='open'){
    const j=a.data.delegations.find(j=>j.id===d.jobId);if(!j)continue;
    try{const result=fromQuestion(a,j,{question:d.question,key:d.key});if(result){d.status='superseded';d.answer='已转换为可操作的授权请求';d.answeredAt=now();d.authorizationRequestId=result.decisionId;}}catch{}
  }
}
function cancel(a,jobId){for(const [id,s] of a.accessSessions||[]){if(jobId&&s.jobId!==jobId)continue;s.controller?.abort();a.accessSessions.delete(id);}}
function view(a,state){state.accessSessions=[...(a.accessSessions||[])].filter(([id,s])=>s.expiresAt>Date.now()&&a.data.decisions.some(d=>d.id===id&&d.status==='open')).map(([id,s])=>({id,url:s.url,expiresAt:new Date(s.expiresAt).toISOString()}));}
function scopes(target){if(target==='my_library'||String(target).startsWith('folder:'))return ['docx:document:create','docx:document:write_only','docx:document:readonly'];return ['docx:document:readonly',...(new URL(target).pathname.startsWith('/wiki/')?['wiki:node:read']:[])];}
function failed(a,j,d,error){
  if(!a.data.decisions.includes(d)||d.status!=='open')return;
  const code=error.connectorCode;
  d.access.stage=code==='auth'?'login':code==='missing_cli'?'setup':code==='permission'?error.permissionKind==='scope'?'scope':'resource':'retry';
  d.access.message={login:'飞书用户身份尚未登录或已过期，请连接飞书。',setup:'未找到飞书 CLI。请安装官方 @larksuite/cli，并通过 lark-cli config init 配置应用后重试。',scope:'应用缺少文档读取权限。请在飞书开放平台为当前应用开通下方只读权限，再重新连接飞书；组织限制可能需要管理员处理。',resource:'当前账号或应用无法访问此文档。请打开原文检查账号，并向文档所有者或组织管理员申请阅读权限，然后重新检查。',retry:'检查未完成。请检查网络或 CLI 配置后重试；已保留事项进度。'}[d.access.stage];
  if(d.access.kind==='lark_create'&&d.access.stage==='scope')d.access.message='缺少文档创建或读写权限。点击连接飞书授权；若应用未开通这些接口权限，请由应用管理员开通后重试。';
  if(d.access.kind==='lark_create'&&d.access.stage==='resource')d.access.message='飞书拒绝在所选位置创建文档。请向该文件夹所有者或组织管理员申请创建权限，再重新检查；也可自行填写新的目标位置。重新登录不能替代文件夹权限。';
  d.updatedAt=now();if(j.status!=='paused')j.status='needs_input';j.summary=d.question;j.nextRunAt=null;a.event('授权仍需处理',d.access.message,d.taskIds[0]||null,'warning');a.save();
}
async function fetchDocument(a,j,target,{signal,assert=()=>active(a,j),principalScope}={}){
  if(a.activeAgentJob)require('./execution-gate.cjs').assert(a,{job:j,readOnly:true});
  const read=await require('./protocol-access.cjs').readLarkDocument(a,j,target,{signal,assert,principalScope});
  const result=read.result,principal=read.principalScope;
  const item=result.items[0],content=String(item.content);
  if(content.length>require('./documents.cjs').maxChars)throw Error('文档超过当前单份材料上限，请拆分后读取');
  const metadata={format:'markdown',url:target,resourceKey:target,remoteId:target,remoteRevision:item.remoteRevision,warnings:item.warnings,principalScope:principal};
  const observation=require('./source-observations.cjs').observe(a,{agentJobId:j.id,projectId:j.projectId||null,title:'飞书文档',content,...metadata},{scope:{jobId:j.id,projectId:j.projectId||null},channel:'lark_read',trustedInput:true});
  if(!observation.allowInput)return {observationId:observation.observationId,classification:observation.state,businessChanged:false,summary:observation.observation.reason};
  const s=require('./agent.cjs').source(a,j,`lark:${j.id}:${target}`,`飞书文档 · ${new URL(target).pathname.split('/').pop()}`,content,{...metadata,observationId:observation.observationId});
  for(const id of j.taskIds){const t=a.task(id);if(t.deletedAt||t.agentCancelled||t.acceptedAt)continue;
    if(!t.sourceIds.includes(s.id)){require('./evidence-links.cjs').bind(a,t,{sourceId:s.id,purpose:'input',provenance:{kind:'lark_document'}});if(s.previousSourceId||t.verification?.passed){t.needsReplan='飞书文档已有新内容，请核对受影响的计划和产出';a.requeue(t);require('./agent-plan.cjs').invalidateDependents(a,t);}}
  }
  return {...require('./documents.cjs').summary(s,16000),sourceId:s.id,warnings:item.warnings};
}
async function read(a,j,args){
  const target=lark.docTarget(args.url);if(!(j.documentGrants||[]).some(g=>g.target===target))return request(a,j,{kind:'lark_document',target,reason:'需要读取此文档作为事项依据'});
  try{const result=await fetchDocument(a,j,target,{signal:a.controller?.signal});a.save();return result;}
  catch(error){if(['auth','permission','missing_cli'].includes(error.connectorCode)||/^ACCESS_POLICY_/.test(error.code||'')){const r=request(a,j,{kind:'lark_document',target,reason:'文档读取权限需恢复'});failed(a,j,a.data.decisions.find(d=>d.id===r.decisionId),error);return r;}throw error;}
}
function complete(a,j,d,note,verified=true){
  assertCurrent(a,j,d);decisions.assertNoUncertain(a,j);
  Object.assign(d,{status:'resolved',answer:note,answeredAt:now(),updatedAt:now()});d.access.stage=verified?'verified':'recheck_requested';
  if(verified){const s=require('./operation-ledger.cjs').state(j);s.permissionRevision=(s.permissionRevision||0)+1;}
  decisions.feedback(a,j,note,d.taskIds.filter(id=>{const t=a.task(id);return !t.deletedAt&&!t.agentCancelled;}),{authorization:true});a.event(verified?'授权检查已完成':'已安排重新检查权限',note,d.taskIds[0]||null,verified?'success':'info');a.save();
}
async function check(a,j,d,{login=false}={}){
  try{
    assertCurrent(a,j,d);decisions.assertNoUncertain(a,j);
    const create=d.access.kind==='lark_create';
    let rawStatus;const status=await lark.status(async(args,options)=>{rawStatus=await a.connectorRequest(args,{...options,signal:a.controller?.signal});return rawStatus;});a.controller?.signal.throwIfAborted();assertCurrent(a,j,d);
    const tenantScope=rawStatus?.identities?.user?.tenantId?{tenantId:rawStatus.identities.user.tenantId}:{};
    if(!status.installed)throw Object.assign(Error('missing'),{connectorCode:'missing_cli'});
    const missingCreateScope=create&&(!status.openId||scopes(d.access.target).some(scope=>!status.scopes?.includes(scope)));
    if(!status.loggedIn||!status.openId||login||missingCreateScope){
      if(!login)throw Object.assign(Error('auth'),{connectorCode:missingCreateScope?'permission':'auth',permissionKind:missingCreateScope?'scope':undefined});
      if([...a.accessSessions.values()].some(s=>s.jobId!==j.id&&s.expiresAt>Date.now()&&!s.done))throw Error('请先完成或取消另一事项的飞书授权');
      const value=await a.connectorRequest(['auth','login','--scope',scopes(d.access.target).join(' '),'--no-wait','--json'],{signal:a.controller?.signal});
      a.controller?.signal.throwIfAborted();assertCurrent(a,j,d);
      const url=lark.authURL(value.verification_url||value.verification_uri_complete),code=value.device_code;
      if(typeof code!=='string'||!code||code.length>4096)throw Error('飞书未返回有效登录会话');
      const expiresAt=Date.now()+Math.max(30,Math.min(900,Number(value.expires_in)||240))*1000;
      a.accessSessions.set(d.id,{url,code,expiresAt,jobId:j.id});d.access.stage='waiting_login';d.access.message=create?'请打开授权页确认文档创建与读写权限；创建方式可在委托中按事项设置为自动创建或每次确认。':'请打开授权页并确认只读权限。授权完成后，应用会验证文档并继续此事项。';d.updatedAt=now();a.save();return;
    }
    if(create){
      const policy=require('./access-policy-store.cjs'),principalScope={kind:'account',provider:'lark',subject:status.openId,...tenantScope};
      const metadata={userName:status.userName,approvedAt:d.access.approvedAt};
      const specs=[{principalScope,resourceScope:{kind:'lark_destination',key:d.access.target,jobId:j.id},operations:['prepare_lark_create','prepare_lark_update'],metadata}];
      if(d.access.createMode==='auto')for(const taskId of (d.access.createTaskIds||[]).filter(id=>d.taskIds.includes(id)&&j.taskIds.includes(id)&&a.data.tasks.some(t=>t.id===id&&!t.deletedAt&&!t.agentCancelled)))specs.push({principalScope,resourceScope:{kind:'lark_destination',key:d.access.target,jobId:j.id,taskId},operations:['lark_create'],metadata});
      for(const spec of specs)policy.grant(a,spec,{trusted:true,actor:'user_command',command:'accessRetry'});
      complete(a,j,d,'飞书身份与文档创建接口权限已校验。请使用 lark_create 导入当前已保存文稿；遵循 permissions.larkCreate.taskModes：auto 时直接创建；ask 时直接调用工具，由 App 展示具体文稿审批，不要另外 ask 或发送聊天确认。不得编造文档链接。');a.accessSessions.delete(d.id);return;
    }
    const principalScope={kind:'account',provider:'lark',subject:status.openId,...tenantScope};
    require('./access-policy-store.cjs').grant(a,{principalScope,resourceScope:{kind:'document',key:d.access.target,jobId:j.id},operations:['read_lark_document','read_url'],metadata:{approvedAt:d.access.approvedAt,userName:status.userName}},{trusted:true,actor:'user_command',command:'accessRetry'});
    const result=await fetchDocument(a,j,d.access.target,{signal:a.controller?.signal,principalScope,assert:()=>{assertCurrent(a,j,d);decisions.assertNoUncertain(a,j);}});
    complete(a,j,d,`已验证飞书用户身份并读取文档：${d.access.target}；来源 ${result.sourceId}。请根据原目标继续，保留既有预算。`);
    a.accessSessions.delete(d.id);
  }catch(error){if(a.controller?.signal.aborted){d.access.stage='retry';d.access.message='已停止授权检查，可稍后重试。';a.save();return;}failed(a,j,d,error);}
}
function poll(a,j,d){
  const session=a.accessSessions.get(d.id);if(!session||session.polling||session.done)return;
  if(session.expiresAt<=Date.now()){a.accessSessions.delete(d.id);failed(a,j,d,Object.assign(Error('expired'),{connectorCode:'auth'}));return;}
  session.polling=true;session.controller=new AbortController();
  // This waits outside the model/work queue. Credentials stay inside the CLI keychain.
  session.promise=(async()=>{try{
    await a.connectorRequest(['auth','login','--device-code',session.code,'--json'],{signal:session.controller.signal,timeoutMs:Math.max(1000,session.expiresAt-Date.now())});
    if(a.accessSessions.get(d.id)!==session||session.controller.signal.aborted)return;
    assertCurrent(a,j,d);session.done=true;delete session.code;d.access.stage='authorized';d.access.message='登录已完成，正在排队验证所需权限。';d.updatedAt=now();a.save();
  }catch(error){if(a.accessSessions.get(d.id)!==session||session.controller.signal.aborted)return;a.accessSessions.delete(d.id);failed(a,j,d,error);}})();
}
function tick(a){
  if(a.exclusiveOperation)return false;
  for(const [id,s] of a.accessSessions||[]){const d=a.data.decisions.find(d=>d.id===id&&d.status==='open'),j=a.data.delegations.find(j=>j.id===s.jobId);
    try{if(!d||!j)throw Error('gone');assertCurrent(a,j,d);}catch{s.controller?.abort();a.accessSessions.delete(id);continue;}
    if(s.done&&j.status!=='paused'&&!require('./execution.cjs').conflict(a,{jobId:j.id})){d.access.stage='checking';require('./execution.cjs').launch(a,{jobId:j.id},'验证飞书文档访问权限',view=>check(view,j,d));return true;}
    if(s.expiresAt<=Date.now()&&!s.done){s.controller?.abort();a.accessSessions.delete(id);failed(a,j,d,Object.assign(Error('expired'),{connectorCode:'auth'}));}
  }return false;
}
function opening(a,input){const d=a.data.decisions.find(d=>d.id===input.id&&d.status==='open'&&d.kind==='permission');if(!d)throw Error('授权请求已处理');const j=a.data.delegations.find(j=>j.id===d.jobId);assertCurrent(a,j,d);if(input.kind==='document'){if(d.access.kind!=='lark_document')throw Error('尚未创建文档，暂时没有文档链接');return {url:lark.docTarget(d.access.target)};}const s=a.accessSessions.get(d.id);if(!s||s.expiresAt<=Date.now())throw Error('授权链接已失效，请重新连接飞书');return {url:lark.authURL(s.url),start:()=>poll(a,j,d)};}
async function dispatch(a,action,input){
  const d=a.data.decisions.find(d=>d.id===input.id&&d.kind==='permission'&&d.status==='open');if(!d)throw Error('授权请求已处理，请刷新');
  a.ensureIdle({jobId:d.jobId});
  if(input.revision!==decisions.revision(a.data,d))throw Error('事项或权限请求已变化，请核对后重试');
  const j=a.data.delegations.find(j=>j.id===d.jobId);assertCurrent(a,j,d);decisions.assertNoUncertain(a,j);
  if(action==='accessAlternative'){
    if(!['provide_text','custom'].includes(input.mode))throw Error('请选择提供材料或自行填写');
    const answer=typeof input.answer==='string'?input.answer.trim():'';
    if(!answer||answer.length>3000)throw Error('请填写 1–3000 字符的材料或处理方案');
    const s=a.accessSessions.get(d.id);s?.controller?.abort();a.accessSessions.delete(d.id);
    const label=input.mode==='provide_text'?'我提供所需材料':'自行填写';
    Object.assign(d,{status:'answered',answer,answerMode:input.mode,selectedOption:{id:input.mode,label},answeredAt:now(),updatedAt:now()});
    d.access.stage='alternative';delete d.access.approvedAt;
    let sourceId;
    if(input.mode==='provide_text'){
      const item=require('./agent.cjs').source(a,j,`user-access:${j.id}:${d.id}`,`用户补充材料 · ${j.title}`,answer,{format:'text',providedBy:'user',accessDecisionId:d.id});sourceId=item.id;
      for(const id of d.taskIds){const task=a.task(id);if(!task.deletedAt&&!task.agentCancelled&&!task.sourceIds.includes(item.id))task.sourceIds.push(item.id);}
      d.sourceIds=[...new Set([...d.sourceIds,item.id])];
    }
    decisions.feedback(a,j,`用户选择「${label}」处理权限问题：${d.access.target}\n${answer}\n${sourceId?`用户提供的材料来源：${sourceId}。`:''}此次没有新增访问授权，也没有验证外部权限。请核对新方案与原目标的关系，基于用户材料或可执行部分继续；关键材料仍缺失时继续提问，不能宣称已读取原文。`,d.taskIds.filter(id=>{const t=a.task(id);return !t.deletedAt&&!t.agentCancelled;}));
    a.event('收到权限问题的补充方案',label,d.taskIds[0]||null);a.save();return a.publicState();
  }
  if(action==='accessCancel'){
    if(input.note){const note=text(input.note,3000);d.access.userNote=note;j.feedback.push({at:now(),text:`用户暂不授权，补充说明：${note}`,origin:'user_decision'});j.feedback=j.feedback.slice(-30);}
    const s=a.accessSessions.get(d.id);s?.controller?.abort();a.accessSessions.delete(d.id);d.access.stage='deferred';d.access.message='你暂未授权，事项保留等待；可随时重新连接。';delete d.access.approvedAt;d.updatedAt=now();a.save();return a.publicState();
  }
  if(['accessStart','accessRetry'].includes(action)&&typeof input.note==='string'&&input.note.trim()){j.feedback.push({at:now(),text:`用户选择补齐权限，补充说明：${text(input.note,3000)}`,origin:'user_decision'});j.feedback=j.feedback.slice(-30);a.save();}
  if(action==='accessRetry'&&!['lark_document','lark_create'].includes(d.access.kind)){
    if(d.access.kind==='web'){const policy=require('./access-policy-store.cjs');policy.grant(a,{principalScope:policy.PUBLIC,resourceScope:{kind:'web',key:'public',jobId:j.id},operations:['read_url','search_web']},{trusted:true,actor:'user_command',command:'accessRetry'});}
    complete(a,j,d,d.access.kind==='web'?'用户允许此委托读取公开网页，将继续验证实际访问结果。':'用户已按指引处理权限，请先重新检查原工具；未验证前不得声称权限已可用。',false);return a.publicState();
  }
  if(!['accessStart','accessRetry'].includes(action)||!['lark_document','lark_create'].includes(d.access.kind))throw Error('未知授权操作');
  if(d.access.kind==='lark_create'&&input.createMode!==undefined){if(!['auto','ask'].includes(input.createMode))throw Error('飞书创建方式无效');d.access.createMode=input.createMode;d.access.createTaskIds=[...d.taskIds];}
  d.access.approvedAt ||= now();
  const s=a.accessSessions.get(d.id);if(s&&!s.done&&s.expiresAt>Date.now()){poll(a,j,d);return a.publicState();}
  s?.controller?.abort();a.accessSessions.delete(d.id);d.access.stage='checking';d.access.message='正在检查飞书用户身份和所需接口权限';d.updatedAt=now();a.save();
  return require('./execution.cjs').launch(a,{jobId:j.id},'连接并检查飞书授权',view=>check(view,j,d,{login:action==='accessStart'}));
}
function recover(a,j,tool,args,error){
  if(!recoveryCandidate(tool,error))return null;
  if(tool==='read_lark_document'||tool==='read_url'&&docURLs(args.url).length){const r=request(a,j,{kind:'lark_document',target:lark.docTarget(args.url),reason:'文档读取权限需恢复'});failed(a,j,a.data.decisions.find(d=>d.id===r.decisionId),error);return r;}
  if(['read_url','search_web'].includes(tool)&&!j.allowWeb)return request(a,j,{kind:'web',reason:'当前委托尚未允许读取公开网页'});
  if(['lark_create','lark_update'].includes(tool)){const r=request(a,j,{kind:'lark_create',target:j.larkCreateGrant?.target,reason:'飞书文档创建权限需恢复'});failed(a,j,a.data.decisions.find(d=>d.id===r.decisionId),error);return r;}
  const resource=tool==='capability_call'?args.capabilityId:tool.startsWith('github_')?j.githubRepo:tool==='read_url'?args.url:tool==='read_platform'?args.sourceId:['platform_inventory','platform_query'].includes(tool)?j.dataPlatform:null;
  return request(a,j,{kind:'external',target:text(`${tool}${resource?` · ${resource}`:''}`,500),reason:'工具返回登录或权限问题。请在对应平台完成授权或在委托设置补齐范围，再检查。'});
}
module.exports={initialize,request,fromQuestion,read,dispatch,tick,opening,view,cancel,recover,recoveryCandidate,docURLs,scopes};
