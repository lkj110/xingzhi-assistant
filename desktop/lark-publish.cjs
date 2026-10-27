const crypto=require('node:crypto');
const lark=require('./lark-connector.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function destination(value='my_library'){
  if(value==='my_library'||typeof value==='string'&&/^folder:[A-Za-z0-9]{8,128}$/.test(value))return value;
  throw Error('飞书保存位置须为 my_library 或 folder:文件夹token');
}
async function checkGrant(a,job,record){
  if(a.activeAgentJob)require('./execution-gate.cjs').assert(a,{job,readOnly:true});
  if(record.tool)require('./protocol-access.cjs').assertTool(a,job,'prepare_'+record.tool,record.args,{taskId:record.taskId});
  const grant=job.larkCreateGrant;
  if(!grant||grant.target!==record.target||grant.openId!==record.larkOpenId)throw Error('飞书创建授权或目标位置已变化，请重新准备文稿');
  const state=await lark.status(a.connectorRequest);a.controller?.signal.throwIfAborted();
  if(!state.loggedIn||state.openId!==grant.openId)throw Object.assign(Error('飞书用户身份已变化，请重新连接并确认'),{connectorCode:'auth'});
  if(['docx:document:create','docx:document:write_only','docx:document:readonly'].some(scope=>!state.scopes.includes(scope)))throw Object.assign(Error('飞书文档创建权限需补齐'),{connectorCode:'permission',permissionKind:'scope'});
}
function assertWrite(a,record){
  const job=a.data.delegations.find(j=>j.id===record.jobId);
  if(!job)throw Error('原委托不存在，不能重新写入');
  require('./execution-gate.cjs').assert(a,{job,task:a.data.tasks.find(t=>t.id===record.taskId)});
  const mode=require('./agent-writes.cjs').mode(job,record.tool,record.taskId);
  require('./protocol-access.cjs').assertTool(a,job,record.tool,record.args,{taskId:record.taskId,...(mode==='ask'?{action:record}:{})});
  return job;
}
async function checkWrite(a,record){const job=assertWrite(a,record);await checkGrant(a,job,record);assertWrite(a,record);}
function assertGrounded(a,record){const grounding=require('./grounding.cjs');if(grounding.enabled(a))grounding.assertAction(a,a.data.tasks.find(t=>t.id===record.taskId),record);}
async function create(a,record,onSubmit=()=>{}){
  await checkWrite(a,record);
  require('./execution-gate.cjs').assert(a,{job:a.data.delegations.find(j=>j.id===record.jobId)});
  const target=destination(record.target);
  const args=['docs','+create','--as','user','--doc-format','markdown','--title',record.title,'--content','-',...(target==='my_library'?['--parent-position','my_library']:['--parent-token',target.slice(7)]),'--format','json'];
  assertGrounded(a,record);onSubmit();const result=await a.connectorRequest(args,{signal:a.controller?.signal,input:record.content});
  const doc=result?.data?.document,url=lark.docTarget(doc?.url);
  if(!doc?.document_id||!url.endsWith('/docx/'+doc.document_id))throw Error('飞书未返回可核对的文档回执；请核对云空间，不会重复创建');
  // Persist the receipt before the readback so recovery only reads this document.
  record.result={url,documentId:doc.document_id,created:true,verified:false,submittedHash:hash(record.content)};require('./action-facts.cjs').receipt(a,record);a.save();
  return readback(a,record);
}
function priorDocument(a,job,taskId,url){
  const records=a.data.agentActions.filter(r=>r.jobId===job.id&&r.taskId===taskId&&['lark_create','lark_update'].includes(r.tool)&&r.status==='done'&&r.result?.verified&&r.larkOpenId===job.larkCreateGrant?.openId&&r.target===job.larkCreateGrant?.target);
  const prior=records.findLast(r=>!url||r.result.url===lark.docTarget(url));
  if(!prior)throw Error('只能更新此事项、账号和保存位置中由 App 创建并回读的文档');
  return prior;
}
async function prepareUpdate(a,job,task,record,url){
  const prior=priorDocument(a,job,task.id,url);
  if(!prior.result.readbackHash||!Number.isSafeInteger(Number(prior.result.revision)))throw Error('原交付没有完整回读版本证据，请先核对文档，不能自动覆盖');
  await checkGrant(a,job,record);
  const value=await readback(a,prior);
  if(Number(value.revision)!==Number(prior.result.revision))throw Object.assign(Error('飞书文档版本已变化，请核对后再更新，原文档已保留'),{conflict:true});
  if(!Number.isSafeInteger(Number(value.revision))||Number(value.revision)<0)throw Error('未取得飞书文档版本号，不能安全更新');
  if(value.warnings.length||/<(?:img|sheet|bitable|source|whiteboard|file)\b|!\[/.test(value.readbackContent))throw Error('原文档包含图片或嵌入对象，请保留这些内容并人工合并，不能整体替换');
  record.baseline={sourceId:prior.result.sourceId,url:value.url,documentId:value.documentId,readbackHash:value.readbackHash,revision:Number(value.revision),content:value.readbackContent};
  record.priorActionId=prior.id;
}
async function update(a,record,onSubmit){
  const baseline=record.baseline;
  const value=await readback(a,{...record,result:baseline});
  if(Number(value.revision)!==baseline.revision)throw Object.assign(Error('飞书文档版本已变化，请核对后再更新，原文档已保留'),{conflict:true});
  // This replaces only an unchanged App-created document, with an exact revision
  // precondition. Arbitrary documents and embedded resources are never eligible.
  record.result={url:baseline.url,documentId:baseline.documentId,updated:true,verified:false,submittedHash:hash(record.content)};a.save();
  await checkWrite(a,record);
  assertGrounded(a,record);onSubmit();
  const result=await a.connectorRequest(['docs','+update','--as','user','--doc',baseline.url,'--command','overwrite','--content','-','--doc-format','markdown','--revision-id',String(baseline.revision),'--format','json'],{signal:a.controller?.signal,input:record.content});
  if(result?.ok===false||result?.data?.result!=='success')throw Error('飞书更新未返回完整成功回执，需核对原文档；不会重复更新');
  record.result.updateAcknowledged=true;require('./action-facts.cjs').receipt(a,record);a.save();
  return readback(a,record);
}
async function readback(a,record){
  require('./execution-gate.cjs').assert(a,{job:a.data.delegations?.find(j=>j.id===record.jobId),readOnly:true});
  if(!record.result?.url)throw Object.assign(Error('上次创建没有返回链接，请核对飞书云空间；系统不会重复创建'),{requiresInput:true});
  const job=a.data.delegations?.find(j=>j.id===record.jobId);
  if(job&&record.tool)require('./protocol-access.cjs').assertTool(a,job,'prepare_'+record.tool,record.args,{taskId:record.taskId});
  const url=lark.docTarget(record.result.url);
  if(!job)throw Error('原委托的读取授权无法核对，请恢复该账号和文档的具体权限');
  const {result:value}=await require('./protocol-access.cjs').readLarkDocument(a,job,url,{signal:a.controller?.signal,action:record});
  a.controller?.signal.throwIfAborted();
  const doc=value.items[0];
  if(!doc?.content||doc.content==='（文档内容为空）')throw Error('创建的飞书文档未读到正文，请核对原文档；不会重复创建');
  const bodyHash=hash(doc.content);
  if(record.result.readbackHash&&record.result.readbackHash!==bodyHash)throw Error('飞书文档在交付后已变化，请核对当前正文后再验收');
  if(record.tool==='lark_update'&&!record.result.updateAcknowledged&&!record.result.readbackHash){
    const normalized=s=>String(s).replace(/\r\n/g,'\n').trim();
    if(normalized(doc.content)!==normalized(record.content))throw Error('上次更新未返回成功回执，当前正文无法精确证明写入结果，请核对原文档；不会重复更新');
  }
  return {...record.result,verified:true,verification:'created_and_readable',contentVerified:false,readbackHash:bodyHash,readbackContent:doc.content,warnings:doc.warnings||[],revision:doc.remoteRevision};
}
module.exports={destination,checkGrant,create,update,readback,priorDocument,prepareUpdate};
