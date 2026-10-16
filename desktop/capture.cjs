const projectLifecycle=require('./project-lifecycle.cjs');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const documents=require('./documents.cjs');
const {fallbackEligible,safeErrorCode,persistenceError}=require('./model-errors.cjs');
const retryDelays=[1,5,15];
const {optionalISO}=require('./date-time.cjs');
const now=()=>new Date().toISOString();
const statuses=new Set(['queued','processing','completed','failed','cancelled']);
const limits={files:10,fileBytes:10_000_000,batchBytes:25_000_000,pending:50,pendingBytes:100_000_000};
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function required(value,label,max){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}须为 1–${max} 字符`);return value.trim();}
function project(a,id,{importing=true}={}){
  if(!id)return null;
  projectLifecycle.assertActive(a.data,id);
  const p=require('./projects.cjs').byId(a,id),job=require('./projects.cjs').job(a,p);
  if(importing&&job&&a.data.agentActions.some(r=>r.jobId===job.id&&['running','uncertain'].includes(r.status)))throw new Error('项目有外部动作待核对，请先处理后导入');
  return p;
}
function validate(a,input,{importing=false}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('收集参数无效');
  if(input.autoRetry!==undefined&&typeof input.autoRetry!=='boolean')throw new Error('自动重试选项须为布尔值');
  if(input.organize!==undefined&&typeof input.organize!=='boolean')throw new Error('是否整理须为布尔值');
  if(input.projectId!==undefined&&input.projectId!==null&&typeof input.projectId!=='string')throw new Error('归属项目无效');
  const files=input.items??[],text=input.textItems??[];
  if(!Array.isArray(files)||files.length>limits.files||!Array.isArray(text)||text.length>1||!files.length&&!text.length)throw new Error('每次收集 1 段文字或最多 10 份文件');
  const advancement=require('./capture-advance.cjs').normalize(input.advancement);
  const target=require('./capture-target.cjs').normalize(a,input.target),provenance=require('./capture-provenance.cjs').normalize(input.provenance);
  const task=target?.kind==='task'?a.task(target.taskId):null;
  if(task&&input.projectId&&input.projectId!==task.projectId)throw Error('补充事项与所属项目不一致');
  const p=project(a,task?task.projectId:input.projectId,{importing});let bytes=0;
  const items=files.map(item=>{
    if(!item||typeof item!=='object')throw new Error('文件格式无效');
    const title=required(item.title,'文件名',300);
    if(!documents.extensions.has(path.extname(title).toLowerCase()))throw new Error('支持 TXT、MD、CSV、JSON、PDF、DOCX 及 PNG/JPG/JPEG 图片');
    if(typeof item.base64!=='string'||!item.base64.length||item.base64.length>13_333_336||item.base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))throw new Error('文件编码无效或超过 10 MB');
    const buffer=Buffer.from(item.base64,'base64');
    if(!buffer.length||buffer.length>limits.fileBytes||buffer.toString('base64')!==item.base64)throw new Error('单份文件须在 10 MB 以内且编码有效');
    bytes+=buffer.length;
    return {title,base64:item.base64,...(item.provenance?{provenance:require('./capture-provenance.cjs').normalize(item.provenance)}:{})};
  });
  const textItems=text.map(item=>{
    if(!item||typeof item!=='object')throw new Error('手动材料格式无效');
    const title=required(item.title,'材料名称',300),content=required(item.content,'材料内容',200000);
    if(item.origin!==undefined&&typeof item.origin!=='string')throw new Error('材料来源无效');
    bytes+=Buffer.byteLength(content);
    return {title,content,origin:item.origin?.trim().slice(0,500)||'手动输入'};
  });
  if(bytes>limits.batchBytes)throw new Error('本次收集合计超过 25 MB，请拆分提交');
  return {payload:{items,textItems,projectId:p?.id||null,organize:target?.kind==='task'?false:!!input.organize,...(target?{target}:{}),...(provenance?{provenance}:{}),...(advancement?{advancement}:{}),...(input.autoRetry===true?{autoRetry:true}:{})},bytes,projectName:p?.name||'独立材料'};
}
function directory(a){
  const dir=path.join(a.dir,'capture-payloads');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('收集暂存目录无效');
  return dir;
}
function filename(a,id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new Error('收集记录编号无效');return path.join(directory(a),`${id}.json`);}
function removePayload(a,row){try{fs.unlinkSync(filename(a,row.id));}catch{}}
function readPayload(a,row){
  const file=filename(a,row.id);let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>35_000_000||stat.size!==row.payloadBytes)throw new Error('收集材料校验失败，请取消后重新提交');
    const body=fs.readFileSync(fd,'utf8');
    if(hash(body)!==row.payloadHash)throw new Error('收集材料校验失败，请取消后重新提交');
    const {payload}=validate(a,JSON.parse(body));
    if(payload.projectId!==row.projectId||payload.organize!==row.organize)throw new Error('收集归属或整理设置已变化，请取消后重新提交');
    return payload;
  }catch(error){if(error.code==='ENOENT')throw new Error('暂存材料缺失，请取消此记录并重新提交材料');throw error;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function pendingSourceIds(data){
  const pending=new Set();for(const row of data.captureQueue||[])if(row.status!=='completed')for(const id of row.sourceIds||[])if(!(row.organizedSourceIds||[]).includes(id)&&data.sources.some(source=>source.id===id&&source.state!=='processed'))pending.add(id);return pending;
}
function retryState(row){
  return row.autoRetry||{enabled:false,used:0,nextRetryAt:null,retryable:false,lastErrorCode:null,lastHttpStatus:null,lastAttemptAt:null};
}
function retryRevision(row){return hash(JSON.stringify([row.id,row.status,row.attempts,row.importedAt,row.sourceIds,row.updatedAt,retryState(row)]));}
function knownTransient(value){return fallbackEligible({modelFailure:true,automaticRetry:true,code:value.lastErrorCode,httpStatus:value.lastHttpStatus});}
function normalizeRetry(row){
  const value=retryState(row),used=Number.isSafeInteger(value.used)&&value.used>=0?Math.min(3,value.used):3;
  let parsedNext=null,dateValid=true;try{parsedNext=optionalISO(value.nextRetryAt);}catch{dateValid=false;}
  const valid=dateValid&&typeof value.enabled==='boolean'&&typeof value.retryable==='boolean'&&Number.isSafeInteger(value.used)&&value.used>=0&&value.used<=3&&(!value.retryable||knownTransient(value))&&(!parsedNext||row.status==='failed');
  const retryable=valid&&value.retryable&&knownTransient(value);
  row.autoRetry={enabled:valid&&value.enabled,used,nextRetryAt:valid&&value.enabled&&retryable&&used<3&&row.status==='failed'&&parsedNext?parsedNext:null,retryable,lastErrorCode:typeof value.lastErrorCode==='string'?value.lastErrorCode:null,lastHttpStatus:Number.isInteger(value.lastHttpStatus)?value.lastHttpStatus:null,lastAttemptAt:typeof value.lastAttemptAt==='string'?value.lastAttemptAt:null};
  return row.autoRetry;
}
function revokeOne(row){const policy=normalizeRetry(row);policy.enabled=false;policy.nextRetryAt=null;}
function revokeRetries(data,{projectId}={}){
  for(const row of data.captureQueue||[])if(projectId===undefined||row.projectId===projectId)revokeOne(row);
}
function storageHold(row){revokeOne(row);row.autoRetry.retryable=false;row.autoRetry.lastErrorCode='MODEL_STORAGE';if(!['completed','cancelled'].includes(row.status))row.status='failed';row.lastError='收集处理记录无法保存，自动重试已关闭。请检查本地存储后手动重试；已保存的材料和事项保留。';row.updatedAt=now();}
function retryDue(row){const policy=retryState(row);let at;try{at=optionalISO(policy.nextRetryAt);}catch{return false;}return row.status==='failed'&&policy.enabled===true&&policy.retryable===true&&knownTransient(policy)&&Number.isSafeInteger(policy.used)&&policy.used>=0&&policy.used<3&&!!at&&Date.parse(at)<=Date.now();}
function retryEligible(a,error){return !a.controller?.signal.aborted&&!error?.localPersistence&&!error?.stewardshipBudget&&!error?.stewardshipMeter&&!error?.ruleBudget&&!error?.rulePaused&&fallbackEligible(error);}
function nextRetry(row){const policy=retryState(row);return policy.enabled&&policy.retryable&&policy.used<3?new Date(Date.now()+retryDelays[policy.used]*60000).toISOString():null;}
function restoreRow(row,previous){for(const key of Object.keys(row))delete row[key];Object.assign(row,previous);}
function commitRow(a,row,change){const previous=structuredClone(row),events=a.data.events.slice();try{change();a.save();}catch(error){restoreRow(row,previous);a.data.events=events;try{a.save();}catch{}throw error;}}
function initialize(a){
  a.data.captureQueue ||= [];
  if(!Array.isArray(a.data.captureQueue))throw new Error('收集队列格式无效');
  for(const row of a.data.captureQueue){
    row.sourceIds ||= [];row.organizedSourceIds ||= [];normalizeRetry(row);
    if(!statuses.has(row.status)||row.status==='processing'){
      revokeOne(row);row.autoRetry.retryable=false;row.status='failed';row.lastError='上次收集在应用退出时中断。已导入和整理的内容会保留，请重试剩余步骤。';row.updatedAt=now();
    }
  }
}
function sanitize(state){
  const keys=['id','intakeRequestId','status','stage','projectId','projectName','organize','itemTitles','fileCount','textCount','bytes','sourceIds','organizedSourceIds','createdAt','updatedAt','startedAt','completedAt','importedAt','attempts','lastError','cancelRequestedAt','advancement','advancedAt','advanceMessage','jobId','taskId','target','provenance','attachedAt'];
  state.captureQueue=(state.captureQueue||[]).map(row=>({...Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]])),autoRetry:{...retryState(row),revision:retryRevision(row),maxAttempts:3,delayMinutes:retryDelays}}));
}
function pause(data){
  revokeRetries(data);
  for(const row of data.captureQueue||[])if(['queued','processing'].includes(row.status)){
    row.status='failed';row.updatedAt=now();row.lastError='收集处理已暂停。已导入和整理的内容保留，请检查后重试。';
  }
}
function retain(current,restored){
  const rows=new Map((restored.captureQueue||[]).map(row=>[row.id,structuredClone(row)]));
  for(const row of current.captureQueue||[])rows.set(row.id,structuredClone(row));
  restored.captureQueue=[...rows.values()];
  revokeRetries(restored);
  const captured=new Set((current.captureQueue||[]).flatMap(row=>row.sourceIds||[]));
  for(const id of captured){
    const source=current.sources.find(s=>s.id===id),old=restored.sources.find(s=>s.id===id);
    if(source?.state==='processed'&&old){old.state=source.state;old.processedAt=source.processedAt;}
  }
  // A finished receipt must keep its later material-to-work associations after an older backup.
  // Restore plans, but make old outcomes visibly stale when those plans omitted accepted material.
  for(const task of restored.tasks||[]){
    const live=current.tasks.find(t=>t.id===task.id);if(!live||task.agentCancelled)continue;
    const additions=(live.sourceIds||[]).filter(id=>captured.has(id)&&!task.sourceIds.includes(id)&&current.sources.some(s=>s.id===id&&!s.projectExcluded)&&restored.sources.some(s=>s.id===id&&!s.projectExcluded));
    if(!additions.length)continue;
    task.sourceIds=[...new Set([...task.sourceIds,...additions])];
    task.verification=null;delete task.completedAt;
    task.needsReplan='从备份恢复后保留了后续收集的材料，请核对新增要求与旧产出。';
    for(const step of task.steps)if(step.kind!=='external'){step.done=false;delete step.artifactId;delete step.evidence;}
    if(task.status==='paused')task.previousStatus='blocked';else task.status='blocked';
    task.lastError=task.needsReplan;task.updatedAt=now();
    task.notes ||= [];task.notes.push({id:crypto.randomUUID(),kind:'source',at:now(),text:task.needsReplan});
  }
  for(const job of restored.delegations||[]){
    const live=current.delegations.find(j=>j.id===job.id);if(!live)continue;
    const additions=(live.sourceIds||[]).filter(id=>captured.has(id)&&!job.sourceIds.includes(id)&&current.sources.some(s=>s.id===id&&!s.projectExcluded)&&restored.sources.some(s=>s.id===id&&!s.projectExcluded));
    if(additions.length){job.sourceIds=[...new Set([...job.sourceIds,...additions])];job.summary='从备份恢复后保留了后续收集的材料，继续前请核对新增要求。';}
  }
}
function byId(a,id){const row=a.data.captureQueue?.find(r=>r.id===id);if(!row)throw new Error('收集记录不存在');return row;}
function enqueue(a,input,metadata={}){
  const {payload,bytes,projectName}=validate(a,input);
  const advancement=payload.advancement,capabilityGrants=advancement?require('./capabilities.cjs').grants(a,advancement.capabilityIds):[];
  if(advancement)require('./capture-advance.cjs').assertCapabilityChoice(a,payload);
  if(advancement)for(const role of ['organize','execute','verify'])a.available(role);
  a.data.captureQueue ||= [];
  const held=a.data.captureQueue.filter(r=>!r.importedAt&&!['completed','cancelled'].includes(r.status));
  if(held.length>=limits.pending||held.reduce((sum,r)=>sum+(r.bytes||0),0)+bytes>limits.pendingBytes)throw new Error('收集暂存已达 50 批或 100 MB，请先处理或取消现有材料');
  const id=crypto.randomUUID(),body=JSON.stringify(payload),at=now();
  const file=filename(a,id);let fd,created=false;
  try{fd=fs.openSync(file,'wx',0o600);created=true;fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;}
  catch(error){if(fd!==undefined){try{fs.closeSync(fd);}catch{}}if(created){try{fs.unlinkSync(file);}catch{}}throw error;}
  const row={id,...(payload.target?{target:payload.target,targetAgentJobId:payload.target.kind==='task'?(a.task(payload.target.taskId).agentJobId||null):null}:{}),...(payload.provenance?{provenance:payload.provenance}:{}),...(advancement?{advancement,capabilityGrants}:{}),status:'queued',stage:'import',projectId:payload.projectId,projectName,organize:payload.organize,itemTitles:[...payload.textItems,...payload.items].map(item=>item.title),fileCount:payload.items.length,textCount:payload.textItems.length,bytes,payloadBytes:Buffer.byteLength(body),payloadHash:hash(body),sourceIds:[],organizedSourceIds:[],createdAt:at,updatedAt:at,attempts:0,lastError:'',autoRetry:{enabled:input.autoRetry===true,used:0,nextRetryAt:null,retryable:false,lastErrorCode:null,lastHttpStatus:null,lastAttemptAt:null}};
  if(metadata.intakeRequestId){row.intakeRequestId=metadata.intakeRequestId;row.intakeTextHash=metadata.intakeTextHash;}
  a.data.captureQueue.push(row);
  try{a.event('材料已加入收集队列',`${row.itemTitles.length} 份材料，归属${projectName}。`);a.save();}catch(error){a.data.captureQueue=a.data.captureQueue.filter(r=>r.id!==id);removePayload(a,row);throw error;}
  tick(a);return a.publicState();
}
async function processRow(a,row){
  a.captureProcessingId=row.id;
  try{
    project(a,row.projectId);
    require('./task-trash.cjs').assertTask(a.data.tasks.find(t=>t.id===row.taskId));
    if(row.target?.kind==='task'){require('./capture-target.cjs').normalize(a,row.target);a.assertTaskChange(a.task(row.target.taskId));}
    if(!row.importedAt){
      const payload=readPayload(a,row),prepared=[];
      for(const item of payload.items){a.controller.signal.throwIfAborted();prepared.push({...await documents.parse(item.title,Buffer.from(item.base64,'base64'),a.controller.signal),origin:`文件导入 · ${item.title}`,projectId:row.projectId,...(item.provenance?{provenance:item.provenance}:{})});}
      prepared.push(...payload.textItems.map(item=>({...item,...(payload.provenance?{origin:require('./capture-provenance.cjs').label(payload.provenance)}:{}),projectId:row.projectId})));
      a.controller.signal.throwIfAborted();project(a,row.projectId);
      for(const item of prepared){const base=item.provenance||payload.provenance;const kind=/\.(png|jpe?g)$/i.test(item.title)?'screenshot':base?.kind||'file';if(payload.provenance||payload.items.some(f=>f.title===item.title))item.provenance={...base,kind,...(payload.items.some(f=>f.title===item.title)?{fileName:item.title}:{}),capturedAt:base?.capturedAt||row.createdAt};}
      a.addSources(prepared,{captureId:row.id});
      if(!row.importedAt)throw new Error('收集导入未生成有效回执');
      removePayload(a,row);
    }
    if(row.target?.kind==='task'){row.stage='supplement';require('./capture-target.cjs').apply(a,row);}
    else if(row.advancement){row.stage='delegate';require('./capture-advance.cjs').perform(a,row);}
    if(row.organize&&!row.projectId&&!row.advancement&&row.target?.kind!=='task'){
      const sources=row.sourceIds.map(id=>{const s=a.data.sources.find(s=>s.id===id);if(!s)throw new Error('已导入材料不存在，请核对工作空间后再重试');if(s.projectId&&s.routing?.status!=='routed')throw new Error('材料归属已变化，请到对应项目继续整理');return s;});
      const pending=sources.filter(s=>!s.projectId&&s.routing?.status!=='conflict'&&s.state==='new'&&!row.organizedSourceIds.includes(s.id)&&!s.deleted&&!s.projectExcluded&&!a.data.sources.some(n=>!n.projectExcluded&&n.previousSourceId===s.id));
      for(let start=0;start<pending.length;start+=6){
        a.controller.signal.throwIfAborted();
        if(row.status!=='processing')throw new Error('收集处理已暂停');
        await a.extract(pending.slice(start,start+6).map(s=>s.id));
        row.organizedSourceIds=[...new Set([...row.organizedSourceIds,...sources.filter(s=>s.state==='processed').map(s=>s.id)])];row.updatedAt=now();a.save();
      }
    }
    if(row.status!=='processing')return;
    row.status='completed';row.stage='complete';row.completedAt=now();row.updatedAt=now();row.lastError='';revokeOne(row);row.autoRetry.retryable=false;removePayload(a,row);
    a.event('收集处理已完成',`本次新增 ${row.sourceIds.length} 份材料${row.sourceIds.length?'':'，重复内容已跳过'}。`);
  }catch(error){
    row=byId(a,row.id);
    if(row.cancelRequestedAt)row.status='cancelled';
    else if(row.status==='processing'){row.status='failed';row.lastError=String(error.message||'收集处理失败').slice(0,1000);const policy=normalizeRetry(row);policy.retryable=retryEligible(a,error);policy.lastErrorCode=error.modelFailure?safeErrorCode(error):error.stewardshipBudget?'WORKSPACE_BUDGET':'CAPTURE_FAILED';policy.lastHttpStatus=Number.isInteger(error.httpStatus)?error.httpStatus:null;policy.nextRetryAt=nextRetry(row);}
    row.updatedAt=now();
    if(error.stewardshipBudget)require('./stewardship.cjs').defer(a,error);
    if(row.status==='failed')a.event('收集需要处理',row.lastError,null,'warning');
  }finally{
    if(row.cancelRequestedAt){row.status='cancelled';revokeOne(row);row.autoRetry.retryable=false;row.lastError='已取消后续处理，已保存材料和事项保留。';removePayload(a,row);}
    delete a.captureProcessingId;try{a.save();}catch{storageHold(row);try{a.save();}catch{}throw persistenceError();}
  }
}
function tick(a){
  if(a.operation||a.suspended||!require('./stewardship.cjs').canAutomate(a))return false;
  const allowed=r=>!a.data.projects.some(p=>p.id===r.projectId&&p.archivedAt),rows=a.data.captureQueue||[];
  const queued=rows.find(r=>r.status==='queued'&&allowed(r));
  const automatic=!queued&&rows.filter(r=>allowed(r)&&retryDue(r)).sort((x,y)=>Date.parse(x.autoRetry.nextRetryAt)-Date.parse(y.autoRetry.nextRetryAt))[0];
  const row=queued||automatic;if(!row)return false;
  const previous=structuredClone(row),policy=normalizeRetry(row);if(automatic){policy.used++;policy.lastAttemptAt=now();}policy.nextRetryAt=null;policy.retryable=false;
  row.status='processing';row.attempts=(row.attempts||0)+1;row.startedAt=now();row.updatedAt=now();row.lastError='';delete row.cancelRequestedAt;
  try{a.save();}catch(error){
    // No worker has started: keep the durable payload and let a later attempt
    // retry this same receipt instead of leaving it stuck as processing.
    restoreRow(row,previous);if(automatic){storageHold(row);try{a.save();}catch{}}throw error;
  }
  a.launch('处理收集队列',()=>processRow(a,row));return true;
}
// Preserve the original immediate-save behavior when idle; busy submissions get a durable receipt.
async function save(a,input={}) {
  if(a.operation||input?.autoRetry===true||input?.advancement||input?.target||input?.provenance)return enqueue(a,input);
  a.ensureIdle();
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('收集参数无效');
  if(input.autoRetry!==undefined&&typeof input.autoRetry!=='boolean')throw new Error('自动重试选项须为布尔值');
  if(input.organize!==undefined&&typeof input.organize!=='boolean')throw new Error('是否整理须为布尔值');
  const files=input.items??[],text=input.textItems??[];
  if(!Array.isArray(files)||files.length>10||!Array.isArray(text)||text.length>1||!files.length&&!text.length)throw new Error('每次收集 1 段文字或最多 10 份文件');
  if(input.projectId)require('./projects.cjs').byId(a,input.projectId);
  if(input.organize&&!input.projectId)a.available('organize');
  const before=new Set(a.data.sources.map(s=>s.id));
  if(files.length)await a.dispatch('importDocuments',{items:files,textItems:text,projectId:input.projectId||null});
  else a.addSources(text.map(s=>({...s,projectId:input.projectId||null})));
  const ids=a.data.sources.filter(s=>!before.has(s.id)&&!s.projectId&&s.routing?.status!=='conflict').map(s=>s.id);
  if(!input.organize||input.projectId||!ids.length)return a.publicState();
  return a.launch('整理本次收集的材料',async()=>{
    try {
      for(let start=0;start<ids.length;start+=6){a.controller.signal.throwIfAborted();await a.extract(ids.slice(start,start+6));}
      a.event('本次收集已整理',`已处理本次新增的 ${ids.length} 份材料。`);
    }catch(error){if(error.stewardshipBudget)require('./stewardship.cjs').defer(a,error);throw error;}
  });
}
async function dispatch(a,action,input={}){
  if(action==='captureSave')return save(a,input);
  if(action==='captureEnqueue')return enqueue(a,input);
  if(action==='captureRetryPolicy'){
    const row=byId(a,input.id);if(typeof input.enabled!=='boolean'||input.revision!==retryRevision(row))throw new Error('收集记录或重试设置已变化，请刷新后重新操作');
    if(!['queued','processing','failed'].includes(row.status))throw new Error('此收集已结束，不能修改自动重试');
    if(input.enabled){require('./task-trash.cjs').assertTask(a.data.tasks.find(t=>t.id===(row.target?.taskId||row.taskId)));project(a,row.projectId);if(retryState(row).used>=3)throw new Error('本批已用完 3 次自动重试，请手动检查后重试；开关不会重置次数');}
    commitRow(a,row,()=>{const policy=normalizeRetry(row);policy.enabled=input.enabled;policy.nextRetryAt=row.status==='failed'?nextRetry(row):null;row.updatedAt=now();a.event(input.enabled?'已启用收集自动重试':'已关闭收集自动重试',input.enabled?'仅明确临时服务故障重试，最多累计 3 次，间隔 1、5、15 分钟；每次模型尝试照常计量。':'已取消计划中的自动重试，已保存材料保留。');});return a.publicState();
  }
  if(action==='captureRetry'){
    const row=byId(a,input.id);if(row.status!=='failed')throw new Error('只有处理失败的收集可以重试');
    require('./task-trash.cjs').assertTask(a.data.tasks.find(t=>t.id===(row.target?.taskId||row.taskId)));
    project(a,row.projectId);if(!row.importedAt)readPayload(a,row);
    commitRow(a,row,()=>{const policy=normalizeRetry(row);policy.nextRetryAt=null;policy.retryable=false;row.status='queued';row.lastError='';row.updatedAt=now();delete row.cancelRequestedAt;});tick(a);return a.publicState();
  }
  if(action==='captureCancel'){
    const row=byId(a,input.id);if(!['queued','processing','failed'].includes(row.status))throw new Error('此收集已结束');
    row.cancelRequestedAt=now();row.updatedAt=now();revokeOne(row);row.autoRetry.retryable=false;
    if(row.status==='processing'&&a.captureProcessingId===row.id){a.controller?.abort();row.lastError='正在停止，已保存材料和事项会保留。';}
    else {row.status='cancelled';row.lastError='已取消后续处理，已保存材料和事项保留。';removePayload(a,row);}
    a.save();return a.publicState();
  }
  throw new Error('未知收集操作');
}
module.exports={validate,enqueue,pendingSourceIds,revokeRetries,retryRevision,retryState,dispatch,initialize,sanitize,tick,pause,retain,limits};
