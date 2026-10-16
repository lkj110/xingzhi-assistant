const collection=require('./collection-permissions.cjs');
const projectLifecycle=require('./project-lifecycle.cjs');
const crypto=require('node:crypto');
const net=require('node:net');
const tools=require('./agent-tools.cjs');
const documents=require('./documents.cjs');
const projects=require('./projects.cjs');
const observations=require('./source-observations.cjs');
const now=()=>new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function initialize(a,request){
  a.data.webConnections ||= [];a.data.webConnectionRuns ||= [];a.webRequest=request||tools.publicRequest;
  for(const r of a.data.webConnectionRuns)if(r.status==='running'){r.status='interrupted';r.finishedAt=now();}
}
function byId(a,id){const c=a.data.webConnections.find(c=>c.id===id);if(!c)throw new Error('网页订阅已移除');return c;}
function urlOf(value){
  if(typeof value!=='string'||value.length>2048)throw new Error('网页地址须为 1–2048 字符');
  const u=tools.webURL(value),host=u.hostname.replace(/^\[|\]$/g,'');
  if((net.isIP(host)&&!tools.publicAddress(host))||/^(localhost|localhost\.)$/i.test(host)||/\.(local|internal|localhost)\.?$/i.test(host))throw new Error('网页订阅只支持公开网页，不能连接本地或内网站点');
  return u.href;
}
function prepare(a,input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('网页订阅设置无效');
  const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>100)throw new Error('订阅名称须为 1–100 字符');
  const project=projects.byId(a,input.projectId),url=urlOf(input.url);
  if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<5||input.intervalMinutes>1440)throw new Error('检查间隔须为 5–1440 分钟的整数');
  if(typeof input.enabled!=='boolean')throw new Error('请明确选择是否自动检查');
  return {name,url,projectId:project.id,intervalMinutes:input.intervalMinutes,enabled:input.enabled};
}
function text(html){
  return html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|article|tr)>|<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[n.toLowerCase()]))
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>0&&c<=0x10ffff&&!(c>=0xd800&&c<=0xdfff)?String.fromCodePoint(c):' ';})
    .replace(/\r\n?/g,'\n').replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
}
async function read(a,c,signal){
  const allowedOrigin=new URL(urlOf(c.url)).origin;
  const response=await a.webRequest(c.url,{signal,allowedOrigin,headers:{Accept:'text/html, text/plain, application/json, application/xml;q=0.8'}});
  signal?.throwIfAborted();
  if(!response||typeof response.body!=='string'||Buffer.byteLength(response.body)>2_000_000)throw new Error('网页响应无效或超过 2 MB');
  if(response.status<200||response.status>=300)throw new Error(`网页读取失败（HTTP ${response.status}），已保留上次材料`);
  const resolvedUrl=urlOf(response.url||c.url);
  if(new URL(resolvedUrl).origin!==allowedOrigin)throw new Error('网页重定向超出已授权站点，请为新的站点单独建立订阅');
  const type=String(response.headers?.['content-type']||'').toLowerCase();
  if(type&&!/^(text\/|application\/(?:[a-z.+-]*\+)?(?:json|xml)(?:;|$))/.test(type))throw new Error('网页订阅只读取 HTML 和文本，不能导入二进制文件');
  if(type.includes('charset=')&&!/charset\s*=\s*["']?(utf-?8|us-ascii|ascii)(?:["';\s]|$)/i.test(type))throw new Error('网页编码暂不支持，请使用 UTF-8 网页');
  const html=type.includes('html')||(!type&&/^\s*</.test(response.body));
  const content=(html?text(response.body):response.body.replace(/\r\n?/g,'\n').trim());
  if(!content.trim())throw new Error('网页没有可读取正文，可能需要登录或浏览器渲染');
  if(content.length>documents.maxChars)throw new Error('网页正文超过 50 万字符，请选择更具体的页面');
  if(content.includes('\ufffd'))throw new Error('网页正文包含无法解码的字符，请检查页面编码');
  const title=html?(text(response.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||c.name).slice(0,300)||c.name):c.name;
  return {title,content,resolvedUrl,remoteRevision:response.headers?.etag||null,hash:hash(JSON.stringify([title,content]))};
}
function latest(a,c){const rows=a.data.sources.filter(s=>s.webConnectionId===c.id&&s.projectId===c.projectId&&!s.copiedFrom),replaced=new Set(rows.map(s=>s.previousSourceId));return rows.find(s=>!replaced.has(s.id))||rows[0];}
function ancestors(a,source){const result=[],seen=new Set([source?.id]);let id=source?.previousSourceId;while(id&&!seen.has(id)){seen.add(id);const previous=a.data.sources.find(s=>s.id===id&&s.projectId===source.projectId&&!s.copiedFrom);if(!previous)break;result.push(id);id=previous.previousSourceId;}return result;}
function commit(a,c,page,collectionToken){
  const previous=latest(a,c),project=projects.byId(a,c.projectId),job=projects.job(a,project);
  const descriptor={...page,id:previous?.webHash===page.hash&&!previous.deleted?previous.id:undefined,stableEventId:observations.transitionEvent(a,previous,previous?.webHash!==page.hash||previous?.deleted),resourceKey:c.url,principalScope:'public',projectId:c.projectId,origin:c.url,identity:`web:${c.id}:${c.projectId}`,webConnectionId:c.id,webHash:page.hash};
  if(previous?.projectExcluded){observations.close(a,{resourceKey:c.url,scope:{projectId:c.projectId}},'来源已撤回');return {added:0,excluded:true};}
  const checked=observations.observe(a,descriptor,{channel:'web',trustedInput:true,scope:{projectId:c.projectId,jobId:job?.id}});
  if(!checked.allowInput)return {added:0,observationId:checked.observationId,classification:checked.state};
  const changed=!previous||previous.deleted||previous.webHash!==page.hash;
  const pending=!!job&&a.data.sources.some(s=>s.projectId===project.id&&!s.projectExcluded&&!job.sourceIds.includes(s.id)&&observations.allows(a,s));
  const affectedIds=new Set(previous?[previous.id,...ancestors(a,previous)]:[]);
  const tasks=a.data.tasks.filter(t=>!t.agentCancelled&&t.sourceIds.some(id=>affectedIds.has(id)));
  const reconcile=!!previous&&tasks.some(t=>!t.sourceIds.includes(previous.id));
  if(!changed&&!pending&&!reconcile)return {added:0};
  if(tasks.some(t=>{const linked=a.data.delegations.find(j=>j.id===t.agentJobId);return t.agentJobId&&!linked||[t.projectId,linked?.projectId].some(id=>id&&id!==project.id);}))throw new Error('来源被其他项目事项错误引用，请先核对关联再同步');
  const jobs=new Set([job?.id,...tasks.map(t=>t.agentJobId)].filter(Boolean));
  const pendingActions=new Set(a.data.delegations.filter(j=>jobs.has(j.id)).map(j=>j.pendingActionId).filter(Boolean)),taskIds=new Set(tasks.map(t=>t.id));
  if(a.data.agentActions.some(r=>(jobs.has(r.jobId)||pendingActions.has(r.id)||taskIds.has(r.taskId))&&['running','uncertain'].includes(r.status)))throw new Error('关联项目有外部动作待核对，请先处理后重试订阅');
  const before=structuredClone(a.data);
  try{
    let source=changed?{...descriptor,id:crypto.randomUUID(),title:page.title,content:page.content,origin:c.url,resolvedUrl:page.resolvedUrl,identity:`web:${c.id}:${c.projectId}`,webConnectionId:c.id,webHash:page.hash,
      projectId:c.projectId,hash:hash(page.content),format:'txt',segments:documents.paragraphs(page.content),warnings:[],state:'new',createdAt:now(),processedAt:null,version:(previous?.version||0)+1,...(previous?{previousSourceId:previous.id}:{})}:previous;
    if(changed)source=collection.attach(a,'web',c,source,checked,collectionToken);
    if(changed||pending)projects.ingest(a,project);
    for(const task of tasks){
      if(task.sourceIds.includes(source.id))continue;
      task.sourceIds=[...new Set([...task.sourceIds,source.id])];task.supersededSourceIds=[...new Set([...(task.supersededSourceIds||[]),...ancestors(a,source)])];
      a.requeue(task);task.needsReplan=`网页「${c.name}」更新至第 ${source.version} 版，请核对相关产出。`;
      if(task.agentJobId)require('./agent-plan.cjs').invalidateDependents(a,task);
      else{for(const step of task.steps)if(step.kind!=='external'){step.done=false;delete step.artifactId;delete step.evidence;}if(task.status!=='paused')task.status='blocked';task.lastError=task.needsReplan;}
      task.updatedAt=now();
    }
    for(const id of jobs){
      const related=a.data.delegations.find(j=>j.id===id);if(!related)continue;
      for(const r of a.data.agentActions.filter(r=>r.jobId===id&&['pending','stale'].includes(r.status))){r.status='stale';delete r.approvedAt;}
      related.pendingActionId=null;related.completedAt=null;related.failures=0;related.resumeWatching=false;
      if(related.status!=='paused'){related.status='ready';related.nextRunAt=now();}
      related.updatedAt=now();
    }
    if(changed)c.imported=(c.imported||0)+1;
    return {added:changed?1:0};
  }catch(error){a.data=before;throw error;}
}
async function sync(a,id){
  let c=byId(a,id);projectLifecycle.assertActive(a.data,c.projectId);const run={id:crypto.randomUUID(),webConnectionId:c.id,name:c.name,startedAt:now(),status:'running',added:0};
  a.data.webConnectionRuns.unshift(run);a.data.webConnectionRuns=a.data.webConnectionRuns.slice(0,200);a.save();
  try{
    const collectionToken=collection.begin(a,'web',c);
    const page=await read(a,c,a.controller?.signal);a.controller?.signal.throwIfAborted();
    const result=commit(a,c,page,collectionToken);c=byId(a,id);
    Object.assign(run,{status:result.excluded?'excluded':result.added?'updated':'unchanged',added:result.added});
    Object.assign(c,{lastSuccessAt:now(),resolvedUrl:page.resolvedUrl,failures:0,error:'',health:result.excluded?'excluded':'healthy',nextRunAt:c.enabled?new Date(Date.now()+c.intervalMinutes*60000).toISOString():null});
    if(result.added)a.event('网页材料已归并',`${c.name}：新增第 ${latest(a,c).version} 版，已关联项目。`);
  }catch(error){
    c=byId(a,id);const stopped=!!a.controller?.signal.aborted;
    c.failures=(c.failures||0)+1;c.error=stopped?'本次读取已停止，保留上次成功材料':String(error.message||error);c.health=stopped?'paused':'error';
    c.nextRunAt=c.enabled?new Date(Date.now()+Math.max(c.intervalMinutes*60000,Math.min(3600000,60000*2**Math.min(c.failures,5)))).toISOString():null;
    Object.assign(run,{status:stopped?'paused':'error',error:c.error});
    if(!stopped&&c.failures===1)a.event('网页订阅需要处理',`${c.name}：${c.error}`,null,'warning');
  }finally{
    const saved=a.data.webConnectionRuns.find(r=>r.id===run.id);Object.assign(saved,run,{finishedAt:now()});byId(a,id).lastCheckedAt=now();a.save();
  }
}
function tick(a){
  if(a.operation||!require('./stewardship.cjs').canAutomate(a))return false;
  const c=a.data.webConnections.filter(c=>c.enabled&&projectLifecycle.isActive(a.data,c.projectId)&&c.nextRunAt&&Date.parse(c.nextRunAt)<=Date.now()).sort((x,y)=>x.nextRunAt.localeCompare(y.nextRunAt))[0];
  if(!c)return false;a.launch(`收集网页 · ${c.name}`,()=>sync(a,c.id));return true;
}
function pauseAll(a){for(const c of a.data.webConnections||[]){c.enabled=false;c.nextRunAt=null;c.health='paused';}}
async function dispatch(a,action,input={}){
  a.ensureIdle();
  if(action==='webConnectionSave'){
    const config=prepare(a,input),existing=input.id?byId(a,input.id):null;
    if(existing&&(existing.url!==config.url||existing.projectId!==config.projectId))throw new Error('来源地址或项目变化请新建订阅，原有材料继续保留');
    if(a.data.webConnections.some(c=>c.id!==existing?.id&&c.url===config.url&&c.projectId===config.projectId))throw new Error('此项目已订阅同一网页');
    const beforeCollection=existing&&structuredClone(existing);
    const row=existing||{id:crypto.randomUUID(),createdAt:now(),imported:0};
    Object.assign(row,config,{health:config.enabled?'unchecked':'paused',error:'',nextRunAt:config.enabled?now():null});
    if(!existing)a.data.webConnections.push(row);
    collection.configure(a,'web',row,{before:beforeCollection,trusted:true,command:action});
  }else{
    const c=byId(a,input.id);
    if(action==='webConnectionSync')return a.launch(`收集网页 · ${c.name}`,()=>sync(a,c.id));
    if(action==='webConnectionToggle'){
      if(typeof input.enabled!=='boolean')throw new Error('同步开关格式无效');
      c.enabled=input.enabled;c.nextRunAt=c.enabled?now():null;c.health=c.enabled?'unchecked':'paused';if(c.enabled)c.error='';
    }else if(action==='webConnectionDelete'){
      collection.remove(a,'web',c,action);
      observations.close(a,{resourceKey:c.url,scope:{projectId:c.projectId}},'网页订阅已移除');
      a.data.webConnections=a.data.webConnections.filter(r=>r.id!==c.id);a.event('已移除网页订阅',`${c.name}：已保存材料和历史保留，停止后续网页读取。`);
    }else throw new Error('未知网页订阅操作');
  }
  a.save();return a.publicState();
}
module.exports={initialize,dispatch,sync,tick,pauseAll,urlOf};
