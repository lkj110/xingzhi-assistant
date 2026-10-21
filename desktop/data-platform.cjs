// The model supplies business parameters, never executable paths or shell text.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=process.platform==='win32'?require('./windows-process.cjs'):require('node:child_process');
const boundaries=require('./platform-boundaries.cjs');
const platformResult=require('./platform-result.cjs');
const crypto=require('node:crypto');
const operations=['identity','projects','my_tasks','task','code','outputs','upstream','downstream','table','ddl','table_lineage','table_tasks'];
const capabilities=Object.freeze({DoradoTask:['task','code','outputs','upstream','downstream'],HiveTable:['table','ddl','table_lineage','table_tasks'],ClickhouseTable:[],AeolusDataset:[]});
function assertCapability(query){
  if(!['table','ddl','table_lineage','table_tasks'].includes(query?.op))return;
  // Legacy table API was explicitly a Coral HiveTable adapter. Preserve that
  // omitted-type contract; modern callers declare the type, and an explicit
  // unknown/CH/Aeolus type must never fall back to Hive.
  const type=query.entityType===undefined?'HiveTable':boundaries.entityType(query.entityType);
  if(type!=='HiveTable')throw Object.assign(Error(type?'当前只读连接器不支持该实体类型；不能以 Hive 查询替代目标映射。':'表查询必须明确 entityType=HiveTable；未知类型不能按 Hive 猜测。'),{code:'UNSUPPORTED_ENTITY',limitation:{entityType:type,operation:query.op,supportedEntityTypes:['HiveTable'],executable:false}});
  if(query.direction!=null&&!(query.op==='table_lineage'&&query.direction==='BOTH')||['depth','page','pageSize'].some(k=>query[k]!=null))throw Object.assign(Error('当前 Hive 连接器不支持指定方向、深度或分页参数'),{code:'UNSUPPORTED_CAPABILITY',limitation:{entityType:type,operation:query.op,direction:query.op==='table_lineage'?'BOTH':null,executable:false}});
}
function positive(value,label,max=Number.MAX_SAFE_INTEGER){if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>max)throw new Error(`${label}须为 1–${max} 的整数`);return String(Number(value));}
function name(value){if(typeof value!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(value))throw new Error('数据库和表名格式无效');return value;}
function command(query){
  if(!query||!operations.includes(query.op))throw new Error('不支持的数据平台只读操作');
  if(query.region!=null&&String(query.region).toLowerCase()!=='sg')throw Object.assign(Error('此连接器仅支持 SG 区域'),{code:'UNSUPPORTED_CAPABILITY'});
  assertCapability(query);
  const base=['--json','--site','i18n-tt'];
  if(query.op==='identity')return [...base,'auth','userinfo'];
  const paging=['--page',positive(query.page??1,'页码',100000),'--page-size',positive(query.pageSize??100,'每页条数',100)];
  if(query.op==='projects')return [...base,'dorado','project','list','--region','sg',...paging];
  if(query.op==='my_tasks')return [...base,'dorado','task','list','--region','sg','--project-id',positive(query.projectId,'项目 ID'),'--only-self',...paging];
  if(['task','code','outputs','upstream','downstream'].includes(query.op)){
    const id=positive(query.taskId,'任务 ID'),op={task:'get',outputs:'data-outputs'}[query.op]||query.op;
    const args=[...base,'dorado','task',op,...(op==='get'?[id]:['--task-id',id]),'--region','sg'];
    if(['upstream','downstream'].includes(op))args.push('--depth',positive(query.depth??1,'查询深度',10));
    if(query.projectId!==undefined&&['upstream','downstream','code'].includes(op))args.push('--project-id',positive(query.projectId,'项目 ID'));
    if(op==='downstream')args.push('--no-cross-region');
    return args;
  }
  const op={table:'get',table_lineage:'lineage',table_tasks:'dorado-tasks'}[query.op]||query.op;
  return [...base,'coral','hive','table',op,'--region','sg','--db-name',name(query.database),'--table-name',name(query.table),...(op==='lineage'?['--direction','BOTH']:[])];
}
function executable(){
  if(process.platform==='win32'){const host=require('./host-process.cjs'),bin=host.executable('bytedcli')||host.npmScript('bytedcli');if(bin)return bin;throw Error('未找到 Windows bytedcli，请安装并添加到 PATH');}
  const homes=[path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin'];
  const nvm=path.join(os.homedir(),'.nvm/versions/node');
  try{homes.push(...fs.readdirSync(nvm).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(v=>path.join(nvm,v,'bin')));}catch{}
  for(const dir of [...String(process.env.PATH||'').split(path.delimiter),...homes].filter(Boolean)){
    const file=path.join(dir,'bytedcli');try{if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);return file;}}catch{}
  }
  throw new Error('未找到 bytedcli；请安装官方 CLI 并登录后继续委托');
}
function execute(args,{signal}={}){
  const bin=executable();
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const env=require('./host-process.cjs').environment();env.PATH=[path.dirname(bin),env.PATH||''].join(path.delimiter);
    for(const key of ['HOME','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];
    const nodeScript=process.platform==='win32'&&/\.[cm]?js$/i.test(bin),program=nodeScript?require('./host-process.cjs').executable('node'):bin;
    if(!program)return reject(Error('运行 npm 版 bytedcli 需要安装 Node.js 并添加到 PATH'));
    const child=spawn(program,nodeScript?[bin,...args]:args,{shell:false,env,cwd:os.tmpdir(),stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
    // Buffer first, decode once: UTF-8 characters may cross pipe chunks.
    const output=[],stderrChunks=[],stdoutHash=crypto.createHash('sha256'),stderrHash=crypto.createHash('sha256');
    const maxBytes=args[3]==='coral'&&args[4]==='hive'&&args[5]==='table'&&args[6]==='lineage'?platformResult.limits.lineageBytes:platformResult.limits.ordinaryBytes;
    let bytes=0,stderrBytes=0,stderrRetained=0,failure,hardKill;
    const kill=()=>{require('./host-process.cjs').terminate(child);hardKill||=setTimeout(()=>require('./host-process.cjs').terminate(child,'SIGKILL'),1000);};
    const abort=()=>{failure=new Error('数据平台查询已停止');kill();};
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{failure=Object.assign(new Error('数据平台查询未在 120 秒内返回'),{code:'TRANSIENT',classificationBasis:'transport_timeout'});kill();},120000);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;stdoutHash.update(chunk);if(bytes>maxBytes){failure ||= Object.assign(new Error('平台响应超过有界接收上限；须诊断或提供受控导出证据，不能将已接收片段视为完整结果'),{code:'INVALID_PLATFORM_RESPONSE',classificationBasis:'invalid_response_format',diagnostics:{stage:'transport',reason:'stdout_limit',limitBytes:maxBytes}});kill();}else if(!failure)output.push(chunk);});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;stderrHash.update(chunk);const part=chunk.subarray(0,Math.max(0,16384-stderrRetained));if(part.length){stderrChunks.push(part);stderrRetained+=part.length;}});
    child.on('error',()=>{failure=new Error('无法启动 bytedcli，请检查官方 CLI 安装');});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(hardKill);signal?.removeEventListener('abort',abort);
      const diagnostics={exitCode:code,stderr:stderrDiagnostics(Buffer.concat(stderrChunks).toString('utf8')),stdoutBytes:bytes,stderrBytes,stdoutSha256:stdoutHash.digest('hex'),stderrSha256:stderrHash.digest('hex'),stdoutComplete:!failure};
      if(failure)return reject(Object.assign(failure,{diagnostics:{...diagnostics,...failure.diagnostics}}));
      try{const data=parse(Buffer.concat(output).toString('utf8'));if(code!==0)throw Object.assign(new Error('平台进程未正常完成，请检查本机 CLI'),{code:'INVALID_PLATFORM_RESPONSE',diagnostics:{stage:'transport',reason:'process_exit'}});resolve(data);}catch(error){error.diagnostics={...error.diagnostics,...diagnostics};reject(error);}
    });
    if(signal?.aborted)abort();
  });
}
const symbolic=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value)&&!/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|BEARER)/.test(value)?value:undefined;
const numeric=value=>value!==null&&value!==undefined&&value!==''&&Number.isSafeInteger(Number(value))?Number(value):undefined;
function envelopeDiagnostics(error={}){
  const result={symbolicCode:symbolic(error.code),httpStatus:numeric(error.status_code??error.status),businessCode:numeric(error.code)};
  if(error.details&&typeof error.details==='object')result.details={code:numeric(error.details.code)??symbolic(error.details.code),statusCode:numeric(error.details.status_code)};
  return Object.fromEntries(Object.entries(result).filter(([,v])=>v!==undefined));
}
function stderrDiagnostics(raw){
  // No raw message, URL, stack or free-form detail is ever persisted, even if
  // it does not resemble a familiar token format. Extract only typed fields.
  for(const line of String(raw).split('\n').reverse())try{const row=JSON.parse(line);if(row.status==='error')return envelopeDiagnostics(row.error);}catch{}
  return {};
}
function safeDiagnostics(error={}){
  const d=error.diagnostics||{},safe=envelopeDiagnostics({code:d.symbolicCode??error.code,status_code:d.httpStatus??error.status??error.statusCode,details:d.details});
  if(numeric(error.providerCode)!==undefined)safe.providerCode=numeric(error.providerCode);
  if(numeric(d.businessCode)!==undefined)safe.businessCode=numeric(d.businessCode);
  if(numeric(d.exitCode??error.exitCode)!==undefined)safe.exitCode=numeric(d.exitCode??error.exitCode);
  if(['error_envelope','invalid_json','invalid_envelope'].includes(d.responseFormat))safe.responseFormat=d.responseFormat;
  if(d.stderr)safe.stderr=envelopeDiagnostics({code:d.stderr.symbolicCode??d.stderr.businessCode,status_code:d.stderr.httpStatus,details:d.stderr.details});
  Object.assign(safe,platformResult.diagnostics(d));
  return safe;
}
function parse(output){
  const fingerprint={stage:'parse',stdoutBytes:Buffer.byteLength(output),stdoutSha256:platformResult.digest(output),stdoutComplete:true};
  let envelope;try{envelope=JSON.parse(output);}catch{for(const line of output.split('\n').reverse())try{const row=JSON.parse(line);if(row.status){envelope=row;break;}}catch{}}
  if(envelope?.status==='error'){
    // bytedcli serializes HTTP status as status_code, alongside symbolic codes.
    const error=envelope.error||{},status=Number(error.status_code||error.status||error.code||envelope.code),permission=status===401||status===403||/没有.*访问权限|无权限|权限不足|permission denied|access denied/i.test(error.message||'');
    // Dorado reports missing tasks as business code 1004, not HTTP 404.
    // Match both code and meaning; never forward raw diagnostics/credentials.
    const missing=status===404||status===1004&&/任务不存在\s*[:：]/.test(error.message||'');
    const code=permission?'AUTH_REQUIRED':status===429||status>=500&&status<=599?'TRANSIENT':status===400?'INVALID_ARGUMENT':missing?'NOT_FOUND':'INVALID_PLATFORM_RESPONSE';
    const message=permission?'当前账号没有该资源或所属项目的读取权限；请补充只读权限或导出证据。不能将权限缺口视为无上下游。':code==='TRANSIENT'?'平台暂时不可用或请求受限，将按退避时间重试':code==='INVALID_ARGUMENT'?'平台请求参数无效，请核对参数后重试':code==='NOT_FOUND'?'平台明确返回资源不存在；请核对任务或表的标识、区域及元数据映射，保留真实缺口。不要按相同条件自动重试，也不能据此断言没有上下游或资源已删除。':'平台未返回成功的结构化结果；不能视为没有任务或没有上下游';
    throw Object.assign(new Error(message),{code,providerCode:Number.isFinite(status)?status:undefined,diagnostics:{...fingerprint,...envelopeDiagnostics(error),responseFormat:'error_envelope'},classificationBasis:permission?'explicit_permission_response':code==='NOT_FOUND'?'typed_missing_response':Number.isFinite(status)?'numeric_provider_status':'unknown_symbolic_response',retryAfterMs:Math.max(0,Number(error.retryAfterMs)||Number(error.retry_after)*1000||0)});
  }
  if(!envelope||envelope.status!=='success'||envelope.error||envelope.data===undefined)throw Object.assign(new Error('平台未返回成功的结构化结果；不能视为没有任务或没有上下游'),{code:'INVALID_PLATFORM_RESPONSE',diagnostics:{...fingerprint,responseFormat:envelope?'invalid_envelope':'invalid_json'},classificationBasis:'invalid_response_format'});
  return envelope.data;
}
function redact(value){
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:token|password|secret|cookie|authorization|credential|access.?key)/i.test(k)).map(([k,v])=>[k,redact(v)]));
  if(typeof value==='string')return value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[凭据已隐藏]').replace(/\bBearer\s+\S+/gi,'Bearer [隐藏]');
  return value;
}
async function query(job,input,{signal,request=execute,beforeRequest,afterResponse,storageScope={}}={}){
  if(job.dataPlatform!=='sg-readonly')throw new Error('此委托未授权 SG 数据平台只读查询');
  command(input);signal?.throwIfAborted();
  const initialScope=job.dataPlatform,initialPrincipal=JSON.stringify(job.platformPrincipal??null);
  // Resolve-dependent calls are separate network boundaries. In particular the
  // task lookup below must not authorize the subsequent lineage request.
  const read=async childQuery=>{
    signal?.throwIfAborted();
    if(job.dataPlatform!==initialScope||JSON.stringify(job.platformPrincipal??null)!==initialPrincipal)throw Object.assign(Error('查询期间账号或平台范围已变化'),{code:'OPERATION_STALE'});
    const args=command(childQuery);
    beforeRequest?.(childQuery,args);
    signal?.throwIfAborted();
    let data;try{data=redact(await request(args,{signal}));}catch(cause){const error=cause instanceof Error?cause:new Error('平台请求异常');error.diagnostics={stage:'request',errorSha256:platformResult.digest(String(cause?.message??cause)),...error.diagnostics};error.actualQuery=structuredClone(childQuery);error.actualParameters=args;throw error;}
    afterResponse?.(childQuery,data);
    signal?.throwIfAborted();
    if(job.dataPlatform!==initialScope||JSON.stringify(job.platformPrincipal??null)!==initialPrincipal)throw Object.assign(Error('查询期间账号或平台范围已变化'),{code:'OPERATION_STALE'});
    return data;
  };
  if(['upstream','downstream'].includes(input.op)&&input.projectId===undefined){
    const task=await read({op:'task',taskId:input.taskId});
    input={...input,projectId:positive(task?.projectId,'任务所属项目 ID')};
  }
  let data=await read(input);
  if(input.op==='identity')data={username:data?.username||data?.user_id||null,name:data?.name||null,...(data?.tenantId||data?.tenant_id?{tenantId:data.tenantId||data.tenant_id}:{})};
  try{return prepareSnapshot(job,input,data,{storageScope});}catch(error){error.actualQuery=structuredClone(input);error.actualParameters=command(input);throw error;}
}
function prepareSnapshot(job,input,data,{queriedAt=new Date().toISOString(),storageScope={}}={}){
 return platformResult.prepare({operation:input.op,region:'sg',query:input,queriedAt,data,scope:'当前登录账号可访问的 SG 元数据；跨区域节点和不可见资源需单独注明。分页、深度边界或读取失败不代表查询完整。'},{...storageScope,principal:job.platformPrincipal??null,projectId:job.projectId??null,scope:job.dataPlatform,permissionRevision:job.executionState?.permissionRevision??null});
}
// Retrieval time is an observation, not a change in platform evidence. Keep all
// business fields (including timestamps inside data) and array ordering intact.
function sameEvidence(content,snapshot,previousSource,receivedSource){
  try {
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    const basis=(value,sourceMeta)=>{const {queriedAt,query,platformResult:storage,platformArchive,data,...rest}=value;return canonical({...rest,dataDigest:platformResult.dataDigest(value,sourceMeta),query:boundaries.canonicalQuery(query)});};
    return JSON.stringify(basis(JSON.parse(content),previousSource))===JSON.stringify(basis(snapshot,receivedSource));
  }catch(error){if(error.code==='LOCAL_RESULT_INTEGRITY')throw error;return false;}
}
// A paged structural index avoids losing middle nodes in a long JSON preview.
// Large responses retain a same-source archive; authorized readers may restore
// it using restorePlatformData. Never expose the archive in model projections.
function index(snapshot,options={},sourceMeta={}){
  return indexData(snapshot,platformResult.restore(snapshot,sourceMeta),options);
}
function indexData(snapshot,restored,{start=0,limit=50}={}){
  const data=restored??{},keys=['id','name','taskId','taskName','type','owner','ownerUserName','taskOwner','projectId','projectName','status','statusAlias','frequency','scheduleTime','cronExpression','region','taskRegion','crossRegion','hasAuth','canAccess','accessDeniedMsg','taskCid','taskType','isMine','parentRelation','distanceToBaseTask','dependencies','outerDependencies','dataOutputs','hiveTable','sourceSinks'];
  const coral=snapshot.operation==='table_lineage'&&data.guidEntityMap&&typeof data.guidEntityMap==='object';
  const rows=coral?Object.entries(data.guidEntityMap).map(([guid,row])=>({...row,guid:row.guid||guid})):Array.isArray(data)?data:Array.isArray(data.projects)?data.projects:Array.isArray(data.tasks)?data.tasks:Array.isArray(data.nodes)?data.nodes:[data];
  if(!Number.isInteger(Number(start))||Number(start)<0||!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>50)throw new Error('索引位置或条数无效');
  const offset=Number(start),count=Number(limit);
  return {operation:snapshot.operation,query:snapshot.query,queriedAt:snapshot.queriedAt,scope:snapshot.scope,...(snapshot.platformResult?{platformResult:platformResult.manifest(snapshot)}:{}),platformTotal:data.total??null,page:data.page??null,pageSize:data.page_size??null,depth:data.depth??null,...(coral?Object.fromEntries(['baseEntityGuid','inputEntityCount','inputEntityDepth','outputEntityCount','outputEntityDepth','inputEntityGuids','outputEntityGuids'].filter(k=>data[k]!==undefined).map(k=>[k,boundedIndexValue(data[k])])):{}),rowsInSnapshot:rows.length,truncated:offset>0||offset+count<rows.length,storageComplete:true,next:offset+count<rows.length?offset+count:null,rows:rows.slice(offset,offset+count).map(row=>boundedIndexValue(coral?lineageEntity(row):Object.fromEntries(keys.filter(k=>row&&row[k]!==undefined).map(k=>[k,row[k]])))),note:'这是结构化索引；详细配置、SQL 和省略字段需读取原始来源。有限深度、当前页或零行不能证明整体血缘已完整。Coral 的 DummyTable 是占位实体，不等同已验证物理表；生产/消费关联与调度依赖须分开核对。'};
}
function boundedIndexValue(value){
 if(JSON.stringify(value).length<=8000)return value;
 return {incomplete:true,rawReadRequired:true,...(value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(['guid','id','typeName'].filter(k=>typeof value[k]==='string'||typeof value[k]==='number').map(k=>[k,String(value[k]).slice(0,200)])):{}),note:'此行或字段超过索引显示范围；完整内容仍保存在来源中，须用 read_source/search_source 分段读取。'};
}
function lineageEntity(entity){
  if(!entity||typeof entity!=='object')return entity;
  const fields=['guid','typeName','id','name','qualifiedName','parentName','dbName','cid','owner','userNames','userNamesDisplay','status','taskStatus','taskType','scheduleType','projectId','region','storageRegion','cluster','clusterName','analyzeResult','errorMessage'];
  const pick=value=>Object.fromEntries(fields.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
  const result=pick(entity),attributes=entity.attributes&&typeof entity.attributes==='object'?pick(entity.attributes):null;
  if(attributes)result.attributes=attributes;
  for(const [source,target] of [[entity,result],...(attributes?[[entity.attributes,attributes]]:[])])for(const key of ['inputs','outputs','inputToProcesses','outputFromProcesses'])if(Array.isArray(source[key]))target[key]=source[key].map(e=>lineageEntity(e));
  return result;
}
function fullInventory(sources){
  const nodes=new Map(),queries=[],identities=[];
  const valid=sources.filter(s=>s.platformSnapshot&&!s.deleted&&!s.projectExcluded);
  const superseded=new Set(valid.map(s=>s.previousSourceId).filter(Boolean));
  for(const source of valid){
    if(superseded.has(source.id))continue;
    let snap;try{snap=JSON.parse(source.content);}catch{if(source.platformArchive)throw require('./platform-chunks.cjs').integrity('archive_invalid');continue;}
    const data=platformResult.restore(snap,source)??{},op=snap.operation;
    if(op==='identity'){identities.push({sourceId:source.id,username:data.username});continue;}
    // Project catalogs and unrelated owner lists are not lineage evidence.
    if(['projects','my_tasks'].includes(op))continue;
    const rows=['upstream','downstream'].includes(op)?(Array.isArray(data.nodes)?data.nodes:[]):op==='task'?[data]:[];
    queries.push({sourceId:source.id,op,query:snap.query,at:source.lastCheckedAt||snap.queriedAt,...(['upstream','downstream'].includes(op)?{nodeIds:rows.map(r=>r.id??r.taskId),depth:data.depth??snap.query.depth}:{} )});
    for(const row of rows){
      const id=String(row.id??row.taskId??'');if(!/^\d+$/.test(id))continue;
      const node=nodes.get(id)||{id,parents:[],sourceIds:[]};
      for(const key of ['name','taskName','owner','ownerUserName','taskOwner','projectId','type','status','statusAlias','hasAuth','region','crossRegion'])if(row[key]!==undefined&&row[key]!==null)node[key]=row[key];
      for(const parent of row.parentRelation||[]){const parentId=String(parent?.id??parent);if(/^\d+$/.test(parentId)&&!node.parents.includes(parentId))node.parents.push(parentId);}
      if(!node.sourceIds.includes(source.id))node.sourceIds.push(source.id);
      nodes.set(id,node);
    }
  }
  const rows=[...nodes.values()];return {identities,totalNodes:rows.length,totalQueries:queries.length,nodes:rows,queries};
}
function inventory(sources,{start=0,queryStart=0,limit=100}={}){
  for(const v of [start,queryStart])if(!Number.isSafeInteger(Number(v))||Number(v)<0)throw new Error('索引起点无效');
  if(!Number.isSafeInteger(Number(limit))||Number(limit)<1||Number(limit)>100)throw new Error('索引条数须为 1–100');
  start=Number(start);queryStart=Number(queryStart);limit=Number(limit);
  const all=fullInventory(sources);
  return {...all,start,queryStart,next:start+limit<all.totalNodes?start+limit:null,nextQueries:queryStart+limit<all.totalQueries?queryStart+limit:null,truncated:start>0||queryStart>0||start+limit<all.totalNodes||queryStart+limit<all.totalQueries,nodes:all.nodes.slice(start,start+limit),queries:all.queries.slice(queryStart,queryStart+limit),note:'持续从本委托有效平台来源构建，早期查询不会随历史摘要消失。parents 为观测到的上游关系合集，是否完整需核对查询方向、深度和原始来源；不同快照冲突需复核。没有查询、查询失败或有限深度边界均不能判定无依赖。用 platform_inventory 翻页；SQL、输出配置和详细字段仍读取对应 sourceId。'};
}
// Keep ordinary investigations in persistent context, including previously read tail pages.
// Larger investigations retain explicit cursors rather than silently implying completeness.
function contextInventory(sources){
  const all=fullInventory(sources),limit=1000;
  return {...all,start:0,queryStart:0,nodes:all.nodes.slice(0,limit),queries:all.queries.slice(0,limit),next:all.totalNodes>limit?limit:null,nextQueries:all.totalQueries>limit?limit:null,truncated:all.totalNodes>limit||all.totalQueries>limit,note:'完整来源构建的有界目录；仍有 next/nextQueries 时须用 platform_inventory 翻页。目录不能证明整体血缘闭合。'};
}
function evidenceSummary(source,limit=30000){
  const summary=require('./documents.cjs').summary(source,limit);
  if(!source.platformSnapshot||source.deleted||source.projectExcluded)return summary;
  let snapshot;try{snapshot=JSON.parse(source.content);}catch{if(source.platformArchive)throw require('./platform-chunks.cjs').integrity('archive_invalid');return summary;}
  if(!['upstream','downstream','table_lineage','table_tasks'].includes(snapshot.operation))return summary;
  const data=platformResult.restore(snapshot,source),{queriedAt,...result}=indexData(snapshot,data),rows=[];
  // Preserve row cursors, including when a single large row needs raw-body
  // reading. A bounded display must never claim it contains the whole graph.
  let next=0;
  const budget=Math.max(2000,Number(limit)||30000);
  do{
    const page=indexData(snapshot,data,{start:next});
    let consumed=0;
    for(const row of page.rows){
      if(JSON.stringify({...result,rows:[...rows,row]}).length>budget)break;
      rows.push(row);consumed++;
    }
    next+=consumed;
    if(consumed<page.rows.length)break;
    if(page.next===null){next=null;break;}
  }while(next!==null);
  const truncated=next!==null;
  return {...summary,content:JSON.stringify({...result,rows,next,truncated,displayComplete:!truncated,storageComplete:true,projection:'完整来源的有界结构索引；按 next 用 read_platform 继续；大行及 SQL/配置用 read_source 分页。索引不证明整体血缘闭合。'}),truncated,structuralProjection:true};
}
module.exports={command,query,prepareSnapshot,sameEvidence,parse,redact,execute,executable,operations,index,inventory,contextInventory,fullInventory,evidenceSummary,capabilities,assertCapability,safeDiagnostics,stderrDiagnostics,restorePlatformData:platformResult.restore,fullSnapshot:platformResult.fullSnapshot,splitPlatformSnapshot:platformResult.split};
