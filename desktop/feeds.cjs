const collection=require('./collection-permissions.cjs');
const projectLifecycle=require('./project-lifecycle.cjs');
const crypto=require('node:crypto');
const {DOMParser}=require('@xmldom/xmldom');
const tools=require('./agent-tools.cjs');
const documents=require('./documents.cjs');
const projects=require('./projects.cjs');
const observations=require('./source-observations.cjs');
const filtering=require('./feed-filter.cjs');
const {urlOf}=require('./web-connections.cjs');
const now=()=>new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const limits={connections:100,entries:100,bytes:2_000_000,characters:500_000,nodes:20000,depth:40};
const ATOM='http://www.w3.org/2005/Atom',CONTENT='http://purl.org/rss/1.0/modules/content/';
function initialize(a,request){
  a.data.feedConnections ||= [];a.data.feedConnectionRuns ||= [];a.feedRequest=request||tools.publicRequest;
  for(const c of a.data.feedConnections){try{c.filter=filtering.normalize(c.filter);delete c.filterError;}catch(error){c.filterError=error.message;c.enabled=false;c.nextRunAt=null;c.health='error';c.error=error.message;}c.filterRevision=filtering.revision(c.filter);}
  for(const run of a.data.feedConnectionRuns)if(run.status==='running'){run.status='interrupted';run.finishedAt=now();}
}
function byId(a,id){const c=a.data.feedConnections.find(c=>c.id===id);if(!c)throw new Error('RSS 订阅已移除');return c;}
function prepare(a,input,existing){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('RSS 订阅设置无效');
  const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>100)throw new Error('订阅名称须为 1–100 字符');
  const project=projects.byId(a,input.projectId),url=urlOf(input.url);
  if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<5||input.intervalMinutes>1440)throw new Error('检查间隔须为 5–1440 分钟的整数');
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('自动检查开关格式无效');
  const hasFilter=Object.hasOwn(input,'filter'),filter=filtering.normalize(hasFilter?input.filter:existing?.filter);
  const filterRevision=filtering.revision(filter);
  if(existing&&hasFilter&&filterRevision!==filtering.revision(existing.filter)&&input.filterRevision!==filtering.revision(existing.filter))throw Error('RSS筛选规则已变化，请重新打开编辑后保存');
  return {name,url,projectId:project.id,intervalMinutes:input.intervalMinutes,enabled:input.enabled===undefined?existing?.enabled===true:input.enabled===true,filter,filterRevision};
}
function children(node,name,namespace=''){return Array.from(node?.childNodes||[]).filter(n=>n.nodeType===1&&n.localName===name&&(n.namespaceURI||'')===namespace);}
const first=(node,name,namespace='')=>children(node,name,namespace)[0];
const value=node=>node?.textContent?.trim()||'';
function htmlText(html){
  return html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|article|tr)>|<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[n.toLowerCase()]))
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>0&&c<=0x10ffff&&!(c>=0xd800&&c<=0xdfff)?String.fromCodePoint(c):' ';})
    .replace(/\r\n?/g,'\n').replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
}
function atomText(node){
  if(!node||node.hasAttribute('src'))return '';
  const type=node.getAttribute('type')||'text';
  if(type==='text'||type==='text/plain')return value(node);
  if(type==='html'||type==='text/html')return htmlText(value(node));
  if(type==='xhtml')return htmlText(Array.from(node.childNodes||[]).map(n=>n.toString()).join(''));
  throw new Error('Atom 条目正文类型暂不支持，请使用文本或 HTML 内容');
}
function linkURL(raw,base){
  if(!raw)return '';
  if(raw.length>2048)throw new Error('订阅条目链接过长');
  try{return urlOf(new URL(raw,base).href);}catch{throw new Error('订阅条目包含无效或非公开 HTTP(S) 链接');}
}
function publishedDate(raw,format){
  if(!raw)return null;
  if(format==='atom'||/^\d{4}-\d{2}-\d{2}/.test(raw)){
    try{return require('./date-time.cjs').optionalISO(raw,'订阅来源时间');}catch{return null;}
  }
  // RSS uses RFC 822 dates. Validate the calendar day and require its timezone
  // before Date.parse so an invalid day cannot silently roll into next month.
  const match=raw.match(/^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2}|\d{4})\s+\d{2}:\d{2}(?::\d{2})?\s+(?:UT|GMT|[ECMP][SD]T|[+-]\d{4}|Z)$/i);
  if(!match)return null;
  const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].toLowerCase());let year=Number(match[3]);if(year<100)year+=year<50?2000:1900;
  const day=Number(match[1]);if(day<1||day>new Date(Date.UTC(year,month+1,0)).getUTCDate())return null;
  return Number.isFinite(Date.parse(raw))?new Date(raw).toISOString():null;
}
function parse(xml,base){
  if(typeof xml!=='string'||Buffer.byteLength(xml)>limits.bytes)throw new Error('RSS 响应无效或超过 2 MB');
  if(!xml.trim()||xml.includes('\ufffd')||/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml))throw new Error('RSS XML 为空、编码无效或包含不支持的实体声明');
  const encoding=xml.match(/^\s*<\?xml\s[^?]*encoding\s*=\s*['"]([^'"]+)/i)?.[1];
  if(encoding&&!/^(utf-?8|us-ascii|ascii)$/i.test(encoding))throw new Error('RSS 仅支持 UTF-8 编码');
  let document;
  try{document=new DOMParser({onError(){throw new Error('XML 格式错误');}}).parseFromString(xml,'application/xml');}catch{throw new Error('RSS XML 格式损坏，请检查订阅地址');}
  let count=0;const pending=[[document,0]];
  while(pending.length){const [node,depth]=pending.pop();if(++count>limits.nodes||depth>limits.depth)throw new Error('RSS XML 结构过大或嵌套过深');for(const child of Array.from(node.childNodes||[]))pending.push([child,depth+1]);}
  const root=document.documentElement;let items,format;
  if(root?.localName==='rss'&&!root.namespaceURI&&root.getAttribute('version')==='2.0'){
    const channels=children(root,'channel');if(channels.length!==1)throw new Error('RSS 2.0 必须有一个 channel');items=children(channels[0],'item');format='rss';
  }else if(root?.localName==='feed'&&root.namespaceURI===ATOM){items=children(root,'entry',ATOM);format='atom';}
  else throw new Error('此地址不是支持的 RSS 2.0 或 Atom 1.0 订阅');
  if(items.length>limits.entries)throw new Error(`单次订阅超过 ${limits.entries} 条，请选择条目更少的订阅地址`);
  const entries=[],keys=new Map();let total=0;
  for(const item of items){
    const ns=format==='atom'?ATOM:'';
    // xml:base can change link identity and scope; use its declared public URL without fetching it.
    let itemBase=base;const chain=[];for(let n=item;n?.nodeType===1;n=n.parentNode)chain.unshift(n);
    for(const n of chain){const declared=n.getAttributeNS('http://www.w3.org/XML/1998/namespace','base');if(declared)itemBase=linkURL(declared,itemBase);}
    const title=(format==='atom'?atomText(first(item,'title',ns)):htmlText(value(first(item,'title')))).trim();
    if(title.length>300)throw new Error('订阅条目标题超过 300 字符');
    let id=value(first(item,format==='atom'?'id':'guid',ns)),rawLink;
    if(format==='atom')rawLink=children(item,'link',ATOM).find(n=>!n.getAttribute('rel')||n.getAttribute('rel')==='alternate')?.getAttribute('href')||'';
    else rawLink=value(first(item,'link'));
    const url=linkURL(rawLink,itemBase);
    if(id.length>2048)throw new Error('订阅条目标识超过 2048 字符');
    if(!id&&!url)throw new Error('订阅条目缺少稳定 ID 或公开链接，无法安全去重');
    const body=format==='atom'?(atomText(first(item,'content',ATOM))||atomText(first(item,'summary',ATOM))):htmlText(value(first(item,'encoded',CONTENT))||value(first(item,'description')));
    if(!title&&!body)throw new Error('订阅条目没有可读取文本');
    const rawDate=value(first(item,format==='atom'?'updated':'pubDate',ns))||(format==='atom'?value(first(item,'published',ATOM)):'');
    const publishedAt=publishedDate(rawDate,format);
    const content=[title,url?`原文链接：${url}`:'',publishedAt?`来源时间：${publishedAt}`:rawDate?`来源时间（未能识别）：${rawDate}`:'',body].filter(Boolean).join('\n\n');
    total+=content.length;if(content.length>documents.maxChars||total>limits.characters)throw new Error('RSS 正文总量超过 50 万字符，请缩小订阅范围');
    const entry={body,filterTitle:title,key:hash(`${id?'id':'url'}:${id||url}`),title:title||'无标题订阅条目',content,url,publishedAt,warnings:rawDate&&!publishedAt?['来源日期格式无效或缺少时区，已保留原文，未作为有效时间使用']:[]};
    entry.hash=hash(JSON.stringify([entry.title,entry.content]));
    if(keys.has(entry.key)){if(keys.get(entry.key)!==entry.hash)throw new Error('同一订阅条目标识出现不同内容，请修复来源后重试');continue;}
    keys.set(entry.key,entry.hash);entries.push(entry);
  }
  return {entries,format};
}
async function read(a,c,signal){
  const allowedOrigin=new URL(urlOf(c.url)).origin;
  const response=await a.feedRequest(c.url,{signal,allowedOrigin,headers:{Accept:'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.8'}});
  signal?.throwIfAborted();
  if(!response||!Number.isInteger(response.status)||response.status<200||response.status>=300)throw new Error(`RSS 读取失败（HTTP ${response?.status||'未知'}），保留上次材料`);
  const resolvedUrl=urlOf(response.url||c.url);if(new URL(resolvedUrl).origin!==allowedOrigin)throw new Error('RSS 重定向超出已授权站点，请为新站点单独建立订阅');
  const type=String(response.headers?.['content-type']||'').toLowerCase();
  if(type&&!/^(application\/(?:rss\+xml|atom\+xml|xml)|text\/(?:xml|plain))(?:\s*;|$)/.test(type))throw new Error('RSS 订阅只读取 XML 文本，不能导入此响应类型');
  if(/charset\s*=/.test(type)&&!/charset\s*=\s*["']?(utf-?8|us-ascii|ascii)(?:["';\s]|$)/i.test(type))throw new Error('RSS 仅支持 UTF-8 编码');
  return {...parse(response.body,resolvedUrl),resolvedUrl};
}
function latest(a,c,key){const rows=a.data.sources.filter(s=>s.feedConnectionId===c.id&&s.feedEntryKey===key&&s.projectId===c.projectId&&!s.copiedFrom),replaced=new Set(rows.map(s=>s.previousSourceId));return rows.find(s=>!replaced.has(s.id))||rows[0];}
function ancestors(a,source){const result=[],seen=new Set([source?.id]);let id=source?.previousSourceId;while(id&&!seen.has(id)){seen.add(id);const p=a.data.sources.find(s=>s.id===id&&s.projectId===source.projectId&&!s.copiedFrom);if(!p)break;result.push(id);id=p.previousSourceId;}return result;}
function commit(a,c,page,filter,collectionToken){
  const project=projects.byId(a,c.projectId),job=projects.job(a,project),updates=[],tasks=new Map(),decisions=[];let excluded=0,filtered=0,received=0;
  const record=(entry,accepted,code,reason)=>{if(decisions.length<filtering.limits.decisions)decisions.push({title:entry.title,accepted,code,reason});};
  const outcome=()=>({received,filtered,excluded,skipped:filtered+excluded,decisions,decisionsTruncated:Math.max(0,page.entries.length-decisions.length),filter,filterRevision:filtering.revision(filter)});
  for(const entry of page.entries){
    const previous=latest(a,c,entry.key),resourceKey=`feed:${c.url}:${entry.key}`;
    if(previous?.projectExcluded){observations.close(a,{resourceKey,scope:{projectId:c.projectId}},'来源已撤回');excluded++;record(entry,false,'withdrawn','材料已从项目撤回，保持撤回状态');continue;}
    if(!previous){const decision=filtering.evaluate(filter,{title:entry.filterTitle,body:entry.body});if(!decision.accepted){filtered++;record(entry,false,decision.code,decision.reason);continue;}record(entry,true,decision.code,decision.reason);}
    else record(entry,true,'tracked','已收录条目，继续核对后续修订，不重新应用新条目筛选');
    const checked=observations.observe(a,{...entry,id:previous?.feedHash===entry.hash&&!previous.deleted?previous.id:undefined,stableEventId:observations.transitionEvent(a,previous,previous?.feedHash!==entry.hash||previous?.deleted),resourceKey,principalScope:'public',projectId:c.projectId,identity:`feed:${c.id}:${c.projectId}:${entry.key}`,feedConnectionId:c.id,feedEntryKey:entry.key,feedHash:entry.hash},{channel:'feed',trustedInput:true,scope:{projectId:c.projectId,jobId:job?.id}});
    if(!checked.allowInput){record(entry,false,checked.state,checked.observation.reason);continue;}
    received++;
    const ids=new Set(previous?[previous.id,...ancestors(a,previous)]:[]);
    for(const task of a.data.tasks.filter(t=>!t.agentCancelled&&t.sourceIds.some(id=>ids.has(id))))tasks.set(task.id,task);
    updates.push({entry,previous,checked,changed:!previous||previous.deleted||previous.feedHash!==entry.hash});
  }
  const pending=!!job&&a.data.sources.some(s=>s.projectId===project.id&&!s.projectExcluded&&!job.sourceIds.includes(s.id)&&observations.allows(a,s));
  const changed=updates.some(u=>u.changed),reconcile=updates.some(u=>u.previous&&[...tasks.values()].some(t=>t.sourceIds.some(id=>ancestors(a,u.previous).includes(id))&&!t.sourceIds.includes(u.previous.id)));
  if(!changed&&!pending&&!reconcile)return {added:0,...outcome()};
  for(const task of tasks.values()){
    const owner=task.agentJobId?a.data.delegations.find(j=>j.id===task.agentJobId):null;
    const explicit=id=>id!==undefined&&id!==null&&id!=='';
    if((task.agentJobId&&!owner)||(explicit(task.projectId)&&task.projectId!==c.projectId)||(owner&&explicit(owner.projectId)&&owner.projectId!==c.projectId))throw new Error('RSS 材料关联到其他项目或无效委托，请先核对事项归属后重试');
  }
  const jobs=new Set([job?.id,...[...tasks.values()].map(t=>t.agentJobId)].filter(Boolean));
  const relatedJobs=a.data.delegations.filter(j=>jobs.has(j.id)),pendingIds=new Set(relatedJobs.map(j=>j.pendingActionId).filter(Boolean));
  const taskIds=new Set([...tasks.keys(),...relatedJobs.flatMap(j=>j.taskIds||[]),...a.data.tasks.filter(t=>jobs.has(t.agentJobId)).map(t=>t.id)]);
  const related=r=>jobs.has(r.jobId)||pendingIds.has(r.id)||taskIds.has(r.taskId);
  if(a.data.agentActions.some(r=>related(r)&&['running','uncertain'].includes(r.status)))throw new Error('关联项目有外部动作待核对，请先处理后重试 RSS 订阅');
  let added=0;
  for(const update of updates){
    const {entry,previous}=update;
    let source=update.changed?{id:crypto.randomUUID(),resourceKey:`feed:${c.url}:${entry.key}`,principalScope:'public',title:entry.title,content:entry.content,origin:entry.url||c.url,feedUrl:c.url,resolvedUrl:page.resolvedUrl,identity:`feed:${c.id}:${c.projectId}:${entry.key}`,feedConnectionId:c.id,feedEntryKey:entry.key,feedHash:entry.hash,
      projectId:c.projectId,hash:hash(entry.content),format:'txt',segments:documents.paragraphs(entry.content),warnings:entry.warnings,state:'new',createdAt:now(),remoteCreatedAt:entry.publishedAt,processedAt:null,version:(previous?.version||0)+1,...(previous?{previousSourceId:previous.id}:{})}:previous;
    if(update.changed){source=collection.attach(a,'feed',c,source,update.checked,collectionToken);added++;}update.source=source;
  }
  if(changed||pending)projects.ingest(a,project);
  for(const {source} of updates){
    const older=ancestors(a,source);
    for(const task of tasks.values()){
      if(task.sourceIds.includes(source.id)||!task.sourceIds.some(id=>older.includes(id)))continue;
      task.sourceIds=[...new Set([...task.sourceIds,source.id])];task.supersededSourceIds=[...new Set([...(task.supersededSourceIds||[]),...older])];a.requeue(task);task.needsReplan=`RSS 条目「${source.title}」更新至第 ${source.version} 版，请核对产出。`;
      if(task.agentJobId)require('./agent-plan.cjs').invalidateDependents(a,task);
      else{for(const step of task.steps)if(step.kind!=='external'){step.done=false;delete step.artifactId;delete step.evidence;}if(task.status!=='paused')task.status='blocked';task.lastError=task.needsReplan;}
      task.updatedAt=now();
    }
  }
  for(const r of a.data.agentActions.filter(r=>related(r)&&['pending','stale'].includes(r.status))){r.status='stale';delete r.approvedAt;}
  for(const j of relatedJobs){j.pendingActionId=null;j.completedAt=null;j.failures=0;j.resumeWatching=false;if(j.status!=='paused'){j.status='ready';j.nextRunAt=now();}j.updatedAt=now();}
  c.imported=(c.imported||0)+added;return {added,...outcome()};
}
async function sync(a,id){
  let c=byId(a,id);projectLifecycle.assertActive(a.data,c.projectId);const run={id:crypto.randomUUID(),feedConnectionId:id,name:c.name,startedAt:now(),status:'running',added:0,excluded:0};
  const beforeStart=structuredClone(a.data);
  a.data.feedConnectionRuns.unshift(run);a.data.feedConnectionRuns=a.data.feedConnectionRuns.slice(0,200);
  try{a.save();}catch(error){a.data=beforeStart;throw error;}
  let before;
  try{
    const filter=filtering.normalize(c.filter);
    const collectionToken=collection.begin(a,'feed',c);
    const page=await read(a,c,a.controller?.signal);a.controller?.signal.throwIfAborted();before=structuredClone(a.data);
    const result=commit(a,c,page,filter,collectionToken);
    Object.assign(run,{status:result.added?'updated':result.excluded?'excluded':result.filtered?'filtered':'unchanged',...result,entries:page.entries.length,finishedAt:now()});
    Object.assign(c,{lastCheckedAt:now(),lastSuccessAt:now(),resolvedUrl:page.resolvedUrl,format:page.format,failures:0,error:'',health:result.excluded?'excluded':'healthy',nextRunAt:c.enabled?new Date(Date.now()+c.intervalMinutes*60000).toISOString():null});
    if(result.added)a.event('RSS 材料已归并',`${c.name}：新增 ${result.added} 份条目版本，已关联项目。`);
    a.save();
  }catch(error){
    if(before)a.data=before;c=byId(a,id);const stopped=!!a.controller?.signal.aborted;
    c.failures=(c.failures||0)+1;c.error=stopped?'本次读取已停止，保留上次成功材料':String(error.message||error);c.health=stopped?'paused':'error';c.lastCheckedAt=now();
    c.nextRunAt=c.enabled?new Date(Date.now()+Math.max(c.intervalMinutes*60000,Math.min(3600000,60000*2**Math.min(c.failures,5)))).toISOString():null;
    Object.assign(a.data.feedConnectionRuns.find(r=>r.id===run.id),{status:stopped?'paused':'error',added:0,received:0,filtered:0,excluded:0,skipped:0,decisions:[],decisionsTruncated:0,error:c.error,finishedAt:now()});
    if(!stopped&&c.failures===1)a.event('RSS 订阅需要处理',`${c.name}：${c.error}`,null,'warning');a.save();
  }
}
function tick(a){
  if(a.operation||!require('./stewardship.cjs').canAutomate(a))return false;
  const c=a.data.feedConnections.filter(c=>c.enabled&&projectLifecycle.isActive(a.data,c.projectId)&&c.nextRunAt&&Date.parse(c.nextRunAt)<=Date.now()).sort((x,y)=>x.nextRunAt.localeCompare(y.nextRunAt))[0];
  if(!c)return false;a.launch(`收集 RSS · ${c.name}`,()=>sync(a,c.id));return true;
}
function pauseAll(a){for(const c of a.data.feedConnections||[]){c.enabled=false;c.nextRunAt=null;c.health='paused';}}
function retain(current,restored){
  restored.feedConnections=structuredClone(current.feedConnections||[]);restored.feedConnectionRuns=structuredClone(current.feedConnectionRuns||[]);
  for(const s of restored.sources||[]){const live=current.sources?.find(r=>r.id===s.id&&r.feedConnectionId);if(live){if(live.projectExcluded)s.projectExcluded=true;else delete s.projectExcluded;if(live.deleted)s.deleted=true;}}
  pauseAll({data:restored});
}
async function dispatch(a,action,input={}){
  if(action==='feedConnectionFilterPreview')return filtering.preview(input);
  a.ensureIdle();const before=structuredClone(a.data);
  try{
    if(action==='feedConnectionSave'){
      const existing=input.id?byId(a,input.id):null,config=prepare(a,input,existing);
      if(existing&&(existing.url!==config.url||existing.projectId!==config.projectId))throw new Error('来源地址或项目变化请新建 RSS 订阅，原有材料继续保留');
      if(a.data.feedConnections.some(c=>c.id!==existing?.id&&c.url===config.url&&c.projectId===config.projectId))throw new Error('此项目已订阅同一 RSS 地址');
      if(!existing&&a.data.feedConnections.length>=limits.connections)throw new Error('最多保存 100 个 RSS 订阅');
      const beforeCollection=existing&&structuredClone(existing);
      const row=existing||{id:crypto.randomUUID(),createdAt:now(),imported:0};Object.assign(row,config,{health:config.enabled?'unchecked':'paused',error:'',nextRunAt:config.enabled?now():null});delete row.filterError;if(!existing)a.data.feedConnections.push(row);
      collection.configure(a,'feed',row,{before:beforeCollection,trusted:true,command:action});
    }else{
      const c=byId(a,input.id);
      if(action==='feedConnectionSync')return a.launch(`收集 RSS · ${c.name}`,()=>sync(a,c.id));
      if(action==='feedConnectionToggle'){if(typeof input.enabled!=='boolean')throw new Error('同步开关格式无效');if(input.enabled)filtering.normalize(c.filter);c.enabled=input.enabled;c.nextRunAt=c.enabled?now():null;c.health=c.enabled?'unchecked':'paused';if(c.enabled)c.error='';}
      else if(action==='feedConnectionDelete'){collection.remove(a,'feed',c,action);for(const o of a.data.sourceObservations||[])if(o.scope.projectId===c.projectId&&o.resourceKey?.startsWith(`feed:${c.url}:`))observations.close(a,{observationId:o.observationId},'RSS 订阅已移除');a.data.feedConnections=a.data.feedConnections.filter(r=>r.id!==c.id);a.event('已移除 RSS 订阅',`${c.name}：已保存条目与历史保留，停止后续读取。`);}
      else throw new Error('未知 RSS 订阅操作');
    }
    a.save();return a.publicState();
  }catch(error){if(!error.committed)a.data=before;throw error;}
}
module.exports={initialize,dispatch,sync,tick,pauseAll,retain,parse,limits};
