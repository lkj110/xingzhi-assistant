// The model supplies business parameters, never executable paths or shell text.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const operations=['identity','projects','my_tasks','task','code','outputs','upstream','downstream','table','ddl','table_lineage','table_tasks'];
function positive(value,label,max=Number.MAX_SAFE_INTEGER){if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>max)throw new Error(`${label}须为 1–${max} 的整数`);return String(Number(value));}
function name(value){if(typeof value!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(value))throw new Error('数据库和表名格式无效');return value;}
function command(query){
  if(!query||!operations.includes(query.op))throw new Error('不支持的数据平台只读操作');
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
    const env={PATH:[path.dirname(bin),process.env.PATH||'/usr/bin:/bin'].join(path.delimiter)};
    for(const key of ['HOME','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];
    const child=spawn(bin,args,{shell:false,env,cwd:os.tmpdir(),stdio:['ignore','pipe','pipe'],detached:true});
    let output='',bytes=0,failure,hardKill;
    const kill=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}hardKill||=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);};
    const abort=()=>{failure=new Error('数据平台查询已停止');kill();};
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{failure=new Error('数据平台查询未在 120 秒内返回；可缩小深度或重试，已有来源已保留');kill();},120000);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>2_000_000){failure=new Error('平台返回超过 2 MB，请减小查询深度或分页读取');kill();}else output+=chunk.toString();});
    child.stderr.on('data',()=>{}); // Auth diagnostics may contain login URLs or tokens.
    child.on('error',()=>{failure=new Error('无法启动 bytedcli，请检查官方 CLI 安装');});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(hardKill);signal?.removeEventListener('abort',abort);if(failure)return reject(failure);
      try{const data=parse(output);if(code!==0)throw new Error('平台进程未正常完成，请检查本机 CLI 后重试');resolve(data);}catch(error){reject(error);}
    });
    if(signal?.aborted)abort();
  });
}
function parse(output){
  let envelope;try{envelope=JSON.parse(output);}catch{for(const line of output.split('\n').reverse())try{const row=JSON.parse(line);if(row.status){envelope=row;break;}}catch{}}
  if(envelope?.status==='error'){
    // bytedcli serializes HTTP status as status_code, alongside symbolic codes.
    const error=envelope.error||{},status=Number(error.status_code||error.status||error.code||envelope.code),permission=status===401||status===403||/没有.*访问权限|无权限|权限不足|permission denied|access denied/i.test(error.message||'');
    // Dorado reports missing tasks as business code 1004, not HTTP 404.
    // Match both code and meaning; never forward raw diagnostics/credentials.
    const missing=status===404||status===1004&&/任务不存在\s*[:：]/.test(error.message||'');
    const code=permission?'AUTH_REQUIRED':status===429||status>=500&&status<=599?'TRANSIENT':status===400?'INVALID_ARGUMENT':missing?'NOT_FOUND':'INVALID_PLATFORM_RESPONSE';
    const message=permission?'当前账号没有该资源或所属项目的读取权限；请补充只读权限或导出证据。不能将权限缺口视为无上下游。':code==='TRANSIENT'?'平台暂时不可用或请求受限，将按退避时间重试':code==='INVALID_ARGUMENT'?'平台请求参数无效，请核对参数后重试':code==='NOT_FOUND'?'平台明确返回资源不存在；请核对任务或表的标识、区域及元数据映射，保留真实缺口。不要按相同条件自动重试，也不能据此断言没有上下游或资源已删除。':'平台未返回成功的结构化结果；不能视为没有任务或没有上下游';
    throw Object.assign(new Error(message),{code,providerCode:Number.isFinite(status)?status:undefined,retryAfterMs:Math.max(0,Number(error.retryAfterMs)||Number(error.retry_after)*1000||0)});
  }
  if(!envelope||envelope.status!=='success'||envelope.error)throw new Error('平台未返回成功的结构化结果；不能视为没有任务或没有上下游');
  return envelope.data;
}
function redact(value){
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:token|password|secret|cookie|authorization|credential|access.?key)/i.test(k)).map(([k,v])=>[k,redact(v)]));
  if(typeof value==='string')return value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[凭据已隐藏]').replace(/\bBearer\s+\S+/gi,'Bearer [隐藏]');
  return value;
}
async function query(job,input,{signal,request=execute,beforeRequest,afterResponse}={}){
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
    const data=redact(await request(args,{signal}));
    afterResponse?.(childQuery,data);
    signal?.throwIfAborted();
    if(job.dataPlatform!==initialScope||JSON.stringify(job.platformPrincipal??null)!==initialPrincipal)throw Object.assign(Error('查询期间账号或平台范围已变化'),{code:'OPERATION_STALE'});
    return data;
  };
  if(input.op==='upstream'&&input.projectId===undefined){
    const task=await read({op:'task',taskId:input.taskId});
    input={...input,projectId:positive(task?.projectId,'任务所属项目 ID')};
  }
  let data=await read(input);
  if(input.op==='identity')data={username:data?.username||data?.user_id||null,name:data?.name||null,...(data?.tenantId||data?.tenant_id?{tenantId:data.tenantId||data.tenant_id}:{})};
  return {operation:input.op,region:'sg',query:input,queriedAt:new Date().toISOString(),data,scope:'当前登录账号可访问的 SG 元数据；跨区域节点和不可见资源需单独注明。分页、深度边界或读取失败不代表查询完整。'};
}
// Retrieval time is an observation, not a change in platform evidence. Keep all
// business fields (including timestamps inside data) and array ordering intact.
function sameEvidence(content,snapshot){
  try {
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    const basis=value=>{const {queriedAt,query,...rest}=value;return canonical({...rest,query:command(query)});};
    return JSON.stringify(basis(JSON.parse(content)))===JSON.stringify(basis(snapshot));
  }catch{return false;}
}
// A paged structural index avoids losing middle nodes in a long JSON preview.
// The original response remains available via read_source/search_source.
function index(snapshot,{start=0,limit=50}={}){
  const data=snapshot.data||{},keys=['id','name','taskId','taskName','type','owner','ownerUserName','taskOwner','projectId','projectName','status','statusAlias','frequency','scheduleTime','cronExpression','region','taskRegion','crossRegion','hasAuth','canAccess','accessDeniedMsg','taskCid','taskType','isMine','parentRelation','distanceToBaseTask','dependencies','outerDependencies','dataOutputs','hiveTable','sourceSinks'];
  const coral=snapshot.operation==='table_lineage'&&data.guidEntityMap&&typeof data.guidEntityMap==='object';
  const rows=coral?Object.entries(data.guidEntityMap).map(([guid,row])=>({...row,guid:row.guid||guid})):Array.isArray(data)?data:Array.isArray(data.projects)?data.projects:Array.isArray(data.tasks)?data.tasks:Array.isArray(data.nodes)?data.nodes:[data];
  if(!Number.isInteger(Number(start))||Number(start)<0||!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>50)throw new Error('索引位置或条数无效');
  const offset=Number(start),count=Number(limit);
  return {operation:snapshot.operation,query:snapshot.query,queriedAt:snapshot.queriedAt,scope:snapshot.scope,platformTotal:data.total??null,page:data.page??null,pageSize:data.page_size??null,depth:data.depth??null,...(coral?Object.fromEntries(['baseEntityGuid','inputEntityCount','inputEntityDepth','outputEntityCount','outputEntityDepth','inputEntityGuids','outputEntityGuids'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]])):{}),rowsInSnapshot:rows.length,next:offset+count<rows.length?offset+count:null,rows:rows.slice(offset,offset+count).map(row=>coral?lineageEntity(row):Object.fromEntries(keys.filter(k=>row&&row[k]!==undefined).map(k=>[k,row[k]]))),note:'这是结构化索引；详细配置、SQL 和省略字段需读取原始来源。有限深度、当前页或零行不能证明整体血缘已完整。Coral 的 DummyTable 是占位实体，不等同已验证物理表；生产/消费关联与调度依赖须分开核对。'};
}
function lineageEntity(entity){
  if(!entity||typeof entity!=='object')return entity;
  const fields=['guid','typeName','id','name','qualifiedName','parentName','cid','owner','userNames','userNamesDisplay','status','taskStatus','taskType','scheduleType','projectId','region','storageRegion','cluster','clusterName','analyzeResult','errorMessage'];
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
    let snap;try{snap=JSON.parse(source.content);}catch{continue;}
    const data=snap.data||{},op=snap.operation;
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
  return {...all,start,queryStart,next:start+limit<all.totalNodes?start+limit:null,nextQueries:queryStart+limit<all.totalQueries?queryStart+limit:null,nodes:all.nodes.slice(start,start+limit),queries:all.queries.slice(queryStart,queryStart+limit),note:'持续从本委托有效平台来源构建，早期查询不会随历史摘要消失。parents 为观测到的上游关系合集，是否完整需核对查询方向、深度和原始来源；不同快照冲突需复核。没有查询、查询失败或有限深度边界均不能判定无依赖。用 platform_inventory 翻页；SQL、输出配置和详细字段仍读取对应 sourceId。'};
}
// Keep ordinary investigations in persistent context, including previously read tail pages.
// Larger investigations retain explicit cursors rather than silently implying completeness.
function contextInventory(sources){
  const result=inventory(sources);
  while(result.next!==null&&result.nodes.length<1000){const page=inventory(sources,{start:result.next,queryStart:result.totalQueries});result.nodes.push(...page.nodes);result.next=page.next;}
  while(result.nextQueries!==null&&result.queries.length<1000){const page=inventory(sources,{start:result.totalNodes,queryStart:result.nextQueries});result.queries.push(...page.queries);result.nextQueries=page.nextQueries;}
  return result;
}
function evidenceSummary(source,limit=30000){
  const summary=require('./documents.cjs').summary(source,limit);
  if(!source.platformSnapshot||source.deleted||source.projectExcluded)return summary;
  let snapshot;try{snapshot=JSON.parse(source.content);}catch{return summary;}
  if(!['upstream','downstream','table_lineage','table_tasks'].includes(snapshot.operation))return summary;
  // Full raw responses repeat SQL/configuration in every graph node. Preserve all
  // structural rows so a character preview cannot silently drop middle/last edges.
  const {queriedAt,...result}=index(snapshot),rows=[...result.rows];let next=result.next;
  while(next!==null){const page=index(snapshot,{start:next});rows.push(...page.rows);next=page.next;}
  return {...summary,content:JSON.stringify({...result,rows,next:null,projection:'结构化血缘全行索引；配置与 SQL 请读取原始来源。'}),truncated:false,structuralProjection:true};
}
module.exports={command,query,sameEvidence,parse,redact,execute,executable,operations,index,inventory,contextInventory,fullInventory,evidenceSummary};
