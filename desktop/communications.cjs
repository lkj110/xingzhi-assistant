const crypto=require('node:crypto');
const lark=require('./lark-connector.cjs');
const followup=require('./agent-followup.cjs');
const plan=require('./agent-plan.cjs');
const now=()=>new Date().toISOString();
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text=(v,label,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`${label}须为 1–${max} 字符`);return v.trim();};
const needs=message=>Object.assign(new Error(message),{requiresInput:true});
function policySpec(c){return {principalScope:{kind:'account',provider:'lark',subject:c.sendPolicy.openId},resourceScope:{kind:'connector',key:c.id,projectId:c.projectId,revision:c.sendPolicy.revision},operations:['read_message','prepare_request_confirmation',...(c.sendPolicy.mode==='auto'?['request_confirmation']:[])]};}
function connection(a,j,id){const c=a.data.connectors.find(c=>c.id===id&&c.projectId===j.projectId&&c.kind==='chat');if(!c)throw needs('只能在本项目已连接的飞书会话内确认或催办');return c;}
function allowed(c){const p=c.sendPolicy;if(!p||p.mode==='off')throw needs('此会话尚未授权发送消息，请到信息连接中设置');if(!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.now())throw needs('会话发送授权已到期，请在信息连接中更新');return p;}
function version(a,j,r){const f=j.followups.find(f=>f.key===r.followupKey),c=a.data.connectors.find(c=>c.id===r.connectorId);return hash([require('./agent-writes.cjs').version(a.task(r.taskId)),f?.createdAt,f?.expected,f?.respondentId,f?.status,c?.sendPolicy?.revision,r.content]);}
function rate(a,j,c,r){
  const p=allowed(c),sent=a.data.agentActions.filter(x=>x.id!==r?.id&&x.tool==='request_confirmation'&&x.projectId===j.projectId&&x.target===c.target&&['done','running','uncertain'].includes(x.status));
  if(sent.length>=p.maxSends)throw needs('此项目会话已达到发送次数上限，请在信息连接中调整');
  const last=sent.sort((x,y)=>(y.startedAt||y.createdAt).localeCompare(x.startedAt||x.createdAt))[0];
  if(last&&Date.parse(last.startedAt||last.createdAt)+p.intervalMinutes*60000>Date.now())throw Object.assign(new Error('会话仍在发送间隔内，将稍后跟进'),{deferredUntil:new Date(Date.parse(last.startedAt||last.createdAt)+p.intervalMinutes*60000).toISOString()});
}
async function prepare(a,j,args){
  require('./date-time.cjs').optionalISO(args.deadlineAt,'跟进期限');
  if(args.reminder!==undefined&&typeof args.reminder!=='boolean')throw new Error('催办标记必须为布尔值');
  const c=connection(a,j,args.connectorId);allowed(c);
  if(a.dir)require('./access-policy-store.cjs').assert(a,{...policySpec(c),operation:'prepare_request_confirmation'});
  const task=a.task(args.taskId);if(task.agentJobId!==j.id||task.status==='paused')throw new Error('请选择当前委托中未暂停的事项');plan.assertReady(a,task);
  const body=text(args.body,'消息正文'),key=text(args.key,'跟进标识',100),expected=text(args.expected,'预期结果');
  const previous=j.followups.find(f=>f.key===key);
  if(previous?.status==='resolved')throw new Error('此跟进已取得结果，不再发送催办');
  const prior=a.data.agentActions.filter(r=>r.jobId===j.id&&r.followupKey===key&&r.tool==='request_confirmation');
  if(prior.some(r=>['uncertain','running'].includes(r.status)))throw needs('上次消息结果待核对，请先处理执行记录');
  const same=prior.findLast(r=>r.content===body&&r.expected===expected&&r.respondentId===args.respondentId&&r.connectorId===c.id&&['pending','done','rejected'].includes(r.status));
  if(same?.status==='done'&&!args.reminder)return same;
  if(same?.status==='pending'&&same.version===version(a,j,same))return same;
  if(same?.status==='rejected'&&same.version===version(a,j,same))throw needs('这条消息已被拒绝，请修改内容或方案');
  rate(a,j,c);
  const status=j.status;
  followup.wait(a,j,{key,taskId:task.id,connectorIds:[c.id],sourceIds:[],reason:body,expected,respondentId:args.respondentId,deadlineAt:args.deadlineAt||previous?.deadlineAt||new Date(Date.now()+86400000).toISOString(),onTimeout:args.onTimeout||'notify'});
  j.status=status;
  const r={id:crypto.randomUUID(),jobId:j.id,projectId:j.projectId,taskId:task.id,tool:'request_confirmation',connectorId:c.id,target:c.target,identity:'user',followupKey:key,expected,respondentId:args.respondentId,content:body,title:task.title,status:'pending',createdAt:now()};
  r.larkOpenId=c.sendPolicy.openId;r.sendPolicyRevision=c.sendPolicy.revision;r.key=hash([j.id,task.id,c.target,key,j.followups.find(f=>f.key===key).createdAt,body,prior.length]);r.version=version(a,j,r);
  for(const old of prior)if(old.status==='pending')old.status='stale';
  a.data.agentActions.push(r);a.save();return r;
}
function automatic(c,r){return allowed(c).mode==='auto'&&c.sendPolicy.template===r.content;}
async function request(a,j,args){
  const r=await prepare(a,j,args);
  if(r.status==='done')return {...r.result,reused:true};
  const c=connection(a,j,r.connectorId);
  if(!r.approvedAt&&!automatic(c,r)){j.status='approval';j.pendingActionId=r.id;j.summary='确认消息已准备好，等待你预览';a.save();return {waitingForApproval:true,actionId:r.id};}
  return execute(a,j,r);
}
async function verifyReceipt(a,j,r,signal){
  const c=connection(a,j,r.connectorId);
  const assertRead=()=>{
    signal?.throwIfAborted();require('./execution-gate.cjs').assert(a,{job:null,readOnly:true});
    if(c.target!==r.target||!r.larkOpenId||c.sendPolicy?.openId!==r.larkOpenId)throw needs('原消息的账号或会话授权已变化，请核对原账号的读取权限');
    if(a.dir)require('./access-policy-store.cjs').assert(a,{principalScope:{kind:'account',provider:'lark',subject:r.larkOpenId},resourceScope:{kind:'connector',key:r.connectorId,projectId:r.projectId||j.projectId,revision:c.sendPolicy?.revision},operation:'read_message'});
  };
  assertRead();
  const identity=await lark.status(a.connectorRequest);assertRead();
  if(!identity.loggedIn||identity.openId!==r.larkOpenId)throw needs('飞书当前账号与原消息账号不一致，请核对原账号的读取权限');
  const result=await a.connectorRequest(['im','+messages-mget','--as','user','--message-ids',r.messageId,'--no-reactions','--format','json'],{signal});
  signal?.throwIfAborted();
  const m=result.data?.messages?.find(m=>m.message_id===r.messageId);
  if(!m||m.deleted||m.msg_type!=='text'||lark.messageText(m.content)!==r.content||(m.chat_id&&m.chat_id!==r.target)||(!m.chat_id&&r.receiptMessageId!==r.messageId)||(r.senderId&&lark.senderId(m.sender)!==r.senderId))throw needs('消息回读不一致或缺少目标会话与发送者证明，请在飞书核对；系统不会自动重发');
  const task=a.task(r.taskId),current=r.version===version(a,j,r)&&!task.needsReplan;
  r.result={messageId:r.messageId,chatId:r.target,senderId:lark.senderId(m.sender),content:r.content,verified:true};require('./action-facts.cjs').outcome(a,r,r.result);r.status='done';r.finishedAt=now();delete r.error;
  if(task.deletedAt||task.agentCancelled||task.status==='completed'||j.status==='completed'){
    r.presentationStatus='historical';if(j.pendingActionId===r.id)j.pendingActionId=null;
    a.event('已核对历史消息结果','原消息已确认发送，已结束的事项保持原状态',task.id,'success');a.save();return r.result;
  }
  if(!current){
    // A receipt proves the old send succeeded; it cannot finish a revised/restored plan.
    task.needsReplan ||= '历史消息已核对，当前事项、等待条件或发送授权已变化，请先核对计划';
    a.requeue(task);
    if(j.pendingActionId===r.id)j.pendingActionId=null;
    if(j.status!=='paused'){j.status='ready';j.nextRunAt=now();}
    j.summary='历史消息已核对成功，当前计划需重新核对，未重复发送';
    a.event('Agent 已核对执行结果',j.summary,task.id,'success');a.save();return r.result;
  }
  const step=task.steps.find(s=>!s.done);
  if(step?.kind==='external'&&step.tool==='request_confirmation'){step.done=true;step.evidence=JSON.stringify({actionId:r.id,...r.result});a.requeue(task);}
  const f=j.followups.find(f=>f.key===r.followupKey);if(f?.status==='waiting'){
    f.sentAt ||= r.startedAt;f.messageIds=[...new Set([...(f.messageIds||[]),r.messageId])];
    const c=a.data.connectors.find(c=>c.id===r.connectorId),checkAt=Date.parse(r.startedAt||r.createdAt)+(c?.sendPolicy?.intervalMinutes||1440)*60000;
    f.checkAt=new Date(Math.max(Date.now(),checkAt)).toISOString();delete f.checkedAt;
  }
  j.pendingActionId=null;if(j.status!=='paused')j.status='watching';j.summary=`消息已发送，等待确认：${r.expected}`;followup.schedule(j);
  a.event('Agent 已执行动作',`飞书确认消息已发送 · ${r.target}`,task.id,'success');a.save();return r.result;
}
async function execute(a,j,r){
  require('./execution-gate.cjs').assert(a,{job:j});
  require('./project-lifecycle.cjs').assertJobActive(a.data,j);
  if(r.status==='done')return {...r.result,reused:true};
  if(['running','uncertain'].includes(r.status)){
    if(!r.messageId)throw needs('上次发送结果不明且未取得回执，请在飞书核对；不会自动重发');
    return verifyReceipt(a,j,r,a.controller?.signal);
  }
  if(require('./projects.cjs').relatedActions(a,j).some(other=>other.id!==r.id&&['running','uncertain'].includes(other.status)))throw needs('请先核对之前的外部执行结果');
  const c=connection(a,j,r.connectorId);allowed(c);
  if(c.target!==r.target||r.version!==version(a,j,r)){r.status='stale';a.save();throw Object.assign(new Error('事项、等待条件或发送授权已变化，请重新准备消息'),{conflict:true});}
  if(!r.approvedAt&&!automatic(c,r))throw needs('请先在待我决策中确认这条消息');
  const task=a.task(r.taskId);plan.assertReady(a,task);if(j.status==='paused'||task.status==='paused')throw needs('委托或事项已暂停');
  rate(a,j,c,r);
  const signal=a.controller?.signal;signal?.throwIfAborted();
  const identity=await lark.status(a.connectorRequest);a.data.larkHealth=identity;
  if(!identity.loggedIn)throw needs(identity.message);
  if(identity.openId!==r.larkOpenId)throw needs('飞书当前账号与消息授权不一致，请在原会话重新确认发送权限');
  if(a.dir){const policy=require('./access-policy-store.cjs');if(automatic(c,r))policy.assert(a,{...policySpec(c),operation:'request_confirmation'});else policy.assertTool(a,j,'request_confirmation',{}, {action:r,taskId:r.taskId});}
  signal?.throwIfAborted();require('./execution-gate.cjs').assert(a,{job:j,task});r.status='running';r.startedAt=now();r.senderId=identity.openId||null;j.pendingActionId=r.id;require('./action-facts.cjs').intent(a,r);a.save();
  try{
    const response=await a.connectorRequest(['im','+messages-send','--as','user','--chat-id',r.target,'--text',r.content,'--idempotency-key',r.key.slice(0,50),'--format','json'],{signal});
    const receipt=response.data;
    if(typeof receipt?.message_id!=='string'||!/^om_[\w-]+$/.test(receipt.message_id)||receipt.chat_id!==r.target)throw needs('飞书未返回有效消息回执，请核对会话');
    r.messageId=receipt.message_id;r.receiptMessageId=receipt.message_id;r.result={messageId:r.messageId,chatId:r.target,senderId:r.senderId};require('./action-facts.cjs').receipt(a,r);a.save();signal?.throwIfAborted();
    return await verifyReceipt(a,j,r,signal);
  }catch(error){if(r.effectStatus==='applied'&&r.status==='done'){error.committed=true;throw error;}r.status='uncertain';r.error=error.message;a.save();throw needs(error.message);}
}
async function dispatch(a,action,input){
  a.ensureIdle();
  if(action==='communicationPolicy'){
    const c=a.data.connectors.find(c=>c.id===input.connectorId&&c.kind==='chat');if(!c)throw new Error('请选择已连接的会话');
    if(!['off','ask','auto'].includes(input.mode))throw new Error('发送模式无效');
    const intervalMinutes=Number(input.intervalMinutes),maxSends=Number(input.maxSends);
    if(!Number.isInteger(intervalMinutes)||intervalMinutes<60||intervalMinutes>10080||!Number.isInteger(maxSends)||maxSends<1||maxSends>10)throw new Error('间隔须为 60–10080 分钟，累计上限须为 1–10 次');
    const expiresAt=input.mode==='off'?null:new Date(text(input.expiresAt,'授权到期时间')).toISOString();
    if(input.mode!=='off'&&(Date.parse(expiresAt)<=Date.now()||Date.parse(expiresAt)>Date.now()+90*86400000))throw new Error('授权有效期须在未来 90 天内');
    const template=input.mode==='auto'?text(input.template,'自动发送固定文案'):'';
    const prior=structuredClone(c.sendPolicy),identity=input.mode==='off'?null:await lark.status(a.connectorRequest);a.ensureIdle();
    if(identity&&(!identity.loggedIn||!identity.openId))throw needs(identity.message||'请先连接飞书用户身份');
    const policy=require('./access-policy-store.cjs');
    if(prior?.openId)policy.revoke(a,policySpec(c),{trusted:true,actor:'user_command',command:'communicationPolicy'});
    c.sendPolicy={mode:input.mode,intervalMinutes,maxSends,expiresAt,template,identity:'user',openId:identity?.openId||null,revision:crypto.randomUUID(),updatedAt:now()};
    if(input.mode!=='off')policy.grant(a,policySpec(c),{trusted:true,actor:'user_command',command:'communicationPolicy'});
    for(const r of a.data.agentActions)if(r.connectorId===c.id&&r.status==='pending'){r.status='stale';const j=a.data.delegations.find(j=>j.id===r.jobId);if(j?.pendingActionId===r.id){j.pendingActionId=null;if(j.status!=='paused')j.status='needs_input';j.summary='会话发送授权已变化，请重新准备消息';}}
    a.event('更新会话发送授权',`${c.name}：${input.mode}；身份：当前飞书用户`);
  }else{
    const r=a.data.agentActions.find(r=>r.id===input.actionId&&r.tool==='request_confirmation');if(!r)throw new Error('消息动作不存在');
    const j=a.data.delegations.find(j=>j.id===r.jobId);if(!j)throw new Error('委托不存在');
    if(action==='communicationEdit'){
      if(r.status!=='pending'||j.pendingActionId!==r.id||input.version!==r.version)throw new Error('消息已变化，请刷新后编辑');
      r.content=text(input.content,'消息正文');delete r.approvedAt;r.version=version(a,j,r);r.editedAt=now();a.event('用户修改了待发消息',r.title,r.taskId);
    }else if(action==='communicationCheck'){
      if(r.status!=='uncertain')throw new Error('这条消息无需核对');
      const id=input.messageId||r.messageId;if(!/^om_[\w-]+$/.test(id||''))throw new Error('请输入飞书中该消息的 om_ ID');
      r.messageId=id;const previous=j.status;a.save();
      return a.launch('核对飞书消息回执',async()=>{try{await verifyReceipt(a,j,r,a.controller.signal);}catch(error){r.status='uncertain';r.error=error.message;j.status=previous==='paused'||j.status==='paused'||a.controller.signal.aborted?'paused':'needs_input';j.summary=error.message;}finally{if(previous==='paused')j.status='paused';a.save();}});
    }else throw new Error('未知会话操作');
  }
  a.save();return a.publicState();
}
module.exports={request,prepare,execute,version,dispatch};
