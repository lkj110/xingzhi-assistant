const collection=require('./collection-permissions.cjs');
const office=require('./office-connectors.cjs');
const projectLifecycle=require('./project-lifecycle.cjs');
const crypto=require('node:crypto');
const lark=require('./lark-connector.cjs');
const projects=require('./projects.cjs');
const observations=require('./source-observations.cjs');
const documents=require('./documents.cjs');
const now=()=>new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function initialize(a,request,officeRequest){a.officeRequest=officeRequest||require('./agent-tools.cjs').publicRequest;a.data.connectors ||= [];a.data.connectorRuns ||= [];a.connectorRequest=request||lark.request;for(const r of a.data.connectorRuns)if(r.status==='running'){r.status='interrupted';r.finishedAt=now();}}
function byId(a,id){const row=a.data.connectors.find(c=>c.id===id);if(!row)throw new Error('信息连接不存在');return row;}
function prepare(a,input){
  const p=projects.byId(a,input.projectId),name=String(input.name||'').trim();
  if(!name||name.length>100)throw new Error('连接名称须为 1–100 字符');
  if(input.provider&&input.provider!=='lark')return {name,projectId:p.id,...office.prepare(input)};
  if(!['document','chat'].includes(input.kind))throw new Error('请选择文档或会话');
  const target=input.kind==='document'?lark.docTarget(input.target):String(input.target||'').trim();
  if(input.kind==='chat'&&!/^oc_[A-Za-z0-9_-]{3,150}$/.test(target))throw new Error('会话 ID 应为 oc_ 开头');
  return {name,kind:input.kind,target,projectId:p.id,intervalMinutes:Math.max(5,Math.min(1440,Number(input.intervalMinutes)||15)),lookbackDays:Math.max(1,Math.min(30,Number(input.lookbackDays)||7))};
}
function latest(a,c,identity){
  const rows=a.data.sources.filter(s=>s.identity===identity&&s.connectorId===c.id&&s.projectId===c.projectId&&!s.copiedFrom);
  const replaced=new Set(rows.map(s=>s.previousSourceId));return rows.find(s=>!replaced.has(s.id))||rows[0];
}
function ancestors(a,source){return require('./evidence-store.cjs').ancestors(a.data,source);}
// Commit each page and its cursor together. A failed merge must never consume the cursor.
function commit(a,c,items,cursor,syncWindow,collectionToken){
  if(!Array.isArray(items)||items.length>50)throw new Error('同步页过大');
  const prepared=items.map(item=>{
    if(typeof item.remoteId!=='string'||item.remoteId.length>1200||typeof item.content!=='string'||item.content.length>documents.maxChars)throw new Error('来源 ID 或正文超出支持范围');
    const identity=`connector:${c.id}:${item.remoteId}`;
    return {...item,identity,resourceKey:item.resourceKey||(c.kind==='document'?c.target:`${office.kind(c)}:${c.target}:${item.remoteId}`),principalScope:item.principalScope??c.principalScope??(office.kind(c)==='lark'?a.data.larkHealth?.openId:null),projectId:c.projectId,connectorId:c.id,hash:hash(item.content),title:item.title?.slice(0,300)||(c.kind==='document'?c.name:`${c.name} · ${item.remoteId}`),origin:`${office.label(c)} · ${c.target}`};
  });
  let added=0;
  return require('./state-transitions.cjs').commit(a,()=>{
    const p=projects.byId(a,c.projectId),job=projects.job(a,p);
    const admitted=prepared.filter(item=>{
      const old=latest(a,c,item.identity);if(old?.projectExcluded){observations.close(a,{resourceKey:item.resourceKey,scope:{projectId:p.id}},'来源已撤回');return false;}
      const changed=!old||old.hash!==item.hash||!!old.deleted!==!!item.deleted;
      item.stableEventId=observations.transitionEvent(a,old,changed);if(!changed)item.id=old.id;
      if(item.deleted){observations.close(a,{resourceKey:item.resourceKey,scope:{projectId:p.id}},'远端来源已撤回');item.purpose='withdrawal';}
      const check=observations.observe(a,item,{channel:'connector',trustedInput:true,scope:{projectId:p.id,jobId:job?.id}});item.sourceCheck=check;
      return check.allowInput||item.deleted&&old&&!old.deleted&&old.purpose!=='delivery_readback';
    });
    const changes=admitted.filter(item=>{const old=latest(a,c,item.identity);return !old||old.hash!==item.hash||!!old.deleted!==!!item.deleted;});
    const pendingProject=!!job&&a.data.sources.some(s=>s.projectId===p.id&&!s.projectExcluded&&!job.sourceIds.includes(s.id)&&observations.allows(a,s));
    const current=a.data.sources.filter(s=>s.connectorId===c.id&&s.projectId===p.id&&!s.copiedFrom&&!s.projectExcluded&&latest(a,c,s.identity)?.id===s.id&&observations.allows(a,s));
    const reconcile=current.filter(s=>s.previousSourceId&&a.data.tasks.some(t=>!t.agentCancelled&&!t.sourceIds.includes(s.id)&&ancestors(a,s).some(id=>t.sourceIds.includes(id))));
    const affectedIds=new Set([...changes.flatMap(item=>{const old=latest(a,c,item.identity);return old?[old.id,...ancestors(a,old)]:[];}),...reconcile.flatMap(s=>ancestors(a,s))]);
    const tasks=a.data.tasks.filter(t=>!t.agentCancelled&&t.sourceIds.some(id=>affectedIds.has(id)));
    const jobs=new Set([job?.id,...tasks.map(t=>t.agentJobId),...a.data.delegations.filter(j=>j.sourceIds.some(id=>affectedIds.has(id))).map(j=>j.id)].filter(Boolean));
    const relatedJobs=a.data.delegations.filter(j=>jobs.has(j.id)),pendingIds=new Set(relatedJobs.map(j=>j.pendingActionId).filter(Boolean));
    if(tasks.some(t=>t.projectId&&t.projectId!==p.id||t.agentJobId&&!a.data.delegations.some(j=>j.id===t.agentJobId))||relatedJobs.some(j=>j.projectId&&j.projectId!==p.id))throw Object.assign(new Error('连接材料存在跨项目或委托缺失的事项关联，请先核对关联再同步；原材料和同步断点已保留。'),{connectorCode:'merge'});
    const taskIds=new Set([...tasks.map(t=>t.id),...relatedJobs.flatMap(j=>j.taskIds||[]),...a.data.tasks.filter(t=>jobs.has(t.agentJobId)).map(t=>t.id)]);
    const related=r=>jobs.has(r.jobId)||pendingIds.has(r.id)||taskIds.has(r.taskId);
    if((changes.length||pendingProject||reconcile.length)&&a.data.agentActions.some(r=>related(r)&&['uncertain','running'].includes(r.status)))throw Object.assign(new Error('项目或关联事项有外部动作待核对，同步断点已保留。'),{connectorCode:'merge'});
    const additions=[];
    for(const item of admitted){
      const old=latest(a,c,item.identity);
      if(old?.projectExcluded||(old?.hash===item.hash&&!!old.deleted===!!item.deleted))continue;
      const {sourceCheck,...body}=item;
      const s={id:crypto.randomUUID(),...body,connectorId:c.id,projectId:c.projectId,state:'new',createdAt:now(),processedAt:null,format:'md',segments:documents.paragraphs(item.content),warnings:item.warnings||[],version:(old?.version||0)+1,...(old?{previousSourceId:old.id}:{})};
      const saved=item.deleted?s:collection.attach(a,'connector',c,s,sourceCheck,collectionToken);if(item.deleted)a.data.sources.unshift(s);if(saved){additions.push(saved);added++;}
    }
    if(added||pendingProject)projects.ingest(a,p);
    for(const source of [...additions,...reconcile]){
      const replaced=ancestors(a,source);
      for(const task of tasks.filter(t=>!t.sourceIds.includes(source.id)&&replaced.some(id=>t.sourceIds.includes(id)))){
        task.sourceIds=[...new Set([...task.sourceIds,source.id])];task.supersededSourceIds=[...new Set([...(task.supersededSourceIds||[]),...replaced])];
        a.requeue(task);task.needsReplan=`${office.label(c)}材料「${source.title}」${source.deleted?'已撤回':`更新至第 ${source.version} 版`}，请核对相关产出。`;
        if(task.agentJobId)require('./agent-plan.cjs').invalidateDependents(a,task);
        else{for(const step of task.steps)if(step.kind!=='external'){step.done=false;delete step.artifactId;delete step.evidence;}if(task.status!=='paused')task.status='blocked';task.lastError=task.needsReplan;}
        task.updatedAt=now();
      }
      for(const related of a.data.delegations.filter(j=>jobs.has(j.id)))for(const f of related.followups||[])if(f.status==='resolved'&&replaced.includes(f.sourceId))require('./agent-followup.cjs').invalidateEvidence(a,related,{...source,previousSourceId:f.sourceId});
    }
    if(added||pendingProject||reconcile.length){
      for(const r of a.data.agentActions.filter(r=>related(r)&&['pending','stale'].includes(r.status))){r.status='stale';delete r.approvedAt;}
      for(const j of relatedJobs){j.pendingActionId=null;j.completedAt=null;j.failures=0;j.resumeWatching=false;if(j.status!=='paused'){j.status='ready';j.nextRunAt=now();}j.updatedAt=now();}
    }
    Object.assign(c,{cursor,imported:(c.imported||0)+added,...(syncWindow?{syncWindow}:{})});return added;
  });
}
async function sync(a,id){
  let c=byId(a,id);projectLifecycle.assertActive(a.data,c.projectId);const record={id:crypto.randomUUID(),connectorId:id,startedAt:now(),added:0,pages:0,status:'running'};
  a.data.connectorRuns.unshift(record);a.data.connectorRuns=a.data.connectorRuns.slice(0,200);a.save();
  try {
    const collectionToken=collection.begin(a,'connector',c);
    const end=now();const window=c.cursor?.window||{start:new Date(Math.max(Date.parse(c.createdAt)-c.lookbackDays*86400000,(Date.parse(c.cursor?.through)||0)-86400000)).toISOString(),end};
    let token=c.cursor?.token||'';
    const windows=require('./sync-window.cjs');let durable=windows.begin(c,window);
    if(c.syncWindow&&c.syncWindow.scope!==durable.scope||!c.syncWindow&&c.cursor?.token)token='';
    for(let i=0;i<5;i++){
      a.controller?.signal.throwIfAborted();
      const result=office.kind(c)==='lark'?await lark.page(c,{...window,token},a.connectorRequest,a.controller?.signal):await office.page(a,c,{...window,token},a.controller?.signal);
      a.controller?.signal.throwIfAborted();
      if(result.hasMore&&(typeof result.token!=='string'||!result.token||result.token.length>10000))throw new Error('分页凭据无效，断点已保留');
      const cursor=result.hasMore?{through:c.cursor?.through||null,window,token:result.token}:{through:window.end};
      const nextWindow=windows.advance(durable,token,result);
      const count=commit(a,c,result.items,cursor,nextWindow,collectionToken);durable=nextWindow;record.added+=count;record.pages++;token=result.token;
      if(durable.status==='blocked')throw Object.assign(Error('检测到分页循环，同步未完成；点击同步可重新扫描当前窗口。'),{connectorCode:'cursor_cycle'});
      if(result.delayMs)c.pageDelayMs=result.delayMs;
      if(!result.hasMore||result.yield)break;
    }
    c.lastSuccessAt=now();c.health='healthy';c.error='';c.failures=0;
    record.status=c.cursor?.token?'partial':record.added?'updated':'unchanged';
    c.nextRunAt=c.enabled?new Date(Date.now()+(c.cursor?.token?(c.pageDelayMs||30000):c.intervalMinutes*60000)).toISOString():null;
    if(record.added)a.event(`${office.label(c)}材料已归并`,`${c.name}：${record.added} 份新材料或更新，已关联项目。`);
  }catch(error){
    // A failed transaction restores the object graph; reacquire both references.
    c=byId(a,id);const saved=a.data.connectorRuns.find(r=>r.id===record.id);Object.assign(saved,record);
    const stopped=!!a.controller?.signal.aborted;
    c.error=stopped?'同步已暂停，恢复后从断点继续':error.message;c.health=stopped?'paused':error.connectorCode||'error';c.failures=(c.failures||0)+1;
    if(error.connectorCode==='cursor'&&c.cursor?.window){if(c.syncWindow)c.syncWindow.status='expired';require('./sync-window.cjs').restart(c);delete c.cursor.token;}
    if(!c.enabled||['auth','permission','missing_cli','merge','cursor_cycle'].includes(c.health))c.nextRunAt=null;
    else c.nextRunAt=new Date(Date.now()+Math.max(error.retryAfterMs||0,c.intervalMinutes*60000,Math.min(3600000,60000*2**Math.min(c.failures,5)))).toISOString();
    saved.status=stopped?'paused':'error';saved.error=c.error;
    if(!stopped&&c.failures===1)a.event('信息连接需要处理',`${c.name}：${c.error}`,null,'warning');
  }finally{const row=a.data.connectorRuns.find(r=>r.id===record.id);if(row.status==='running')Object.assign(row,record);row.finishedAt=now();byId(a,id).lastCheckedAt=now();a.save();}
}
function tick(a){
  if(require('./chat-streams.cjs').tick(a))return true;
  const c=a.data.connectors.filter(c=>!require('./chat-streams.cjs').isStream(c)&&c.enabled&&projectLifecycle.isActive(a.data,c.projectId)&&c.nextRunAt&&Date.parse(c.nextRunAt)<=Date.now()).sort((x,y)=>x.nextRunAt.localeCompare(y.nextRunAt))[0];
  if(!c)return false;a.launch(`收集${office.label(c)} · ${c.name}`,()=>sync(a,c.id));return true;
}
function pauseAll(a){for(const c of a.data.connectors){c.enabled=false;c.nextRunAt=null;}}
async function dispatch(a,action,input){
  if(action==='connectorStatus'){const result=await lark.status(a.connectorRequest);a.data.larkHealth=result;a.save();return result;}
  a.ensureIdle();
  if(action==='connectorSave'){
    const config=prepare(a,input),existing=input.id?byId(a,input.id):null;
    if(existing&&(office.kind(existing)!==office.kind(config)||existing.kind!==config.kind||existing.target!==config.target||existing.projectId!==config.projectId))throw new Error('来源或项目变化请新建连接，原断点继续保留');
    if(a.data.connectors.some(c=>c.id!==existing?.id&&office.kind(c)===office.kind(config)&&c.target===config.target&&c.projectId===config.projectId))throw new Error('此项目已连接同一来源');
    if(require('./chat-streams.cjs').isStream(config)&&a.data.connectors.some(c=>c.id!==existing?.id&&c.provider===config.provider&&c.target===config.target))throw Error('同一机器人只能绑定一个项目，请使用已有连接');
    const row=existing||{id:crypto.randomUUID(),createdAt:now(),cursor:null,imported:0};
    const beforeCollection=existing&&structuredClone(existing);
    let sealedToken=row.sealedToken;
    if(office.kind(config)!=='lark'){
      if(input.token!==undefined&&(typeof input.token!=='string'||input.token.length>16000||/[\r\n]/.test(input.token)))throw Error('访问令牌格式无效');
      if(input.token?.trim())sealedToken=await a.vault.seal(input.token.trim());
      if(!sealedToken&&config.provider!=='json')throw Error('请填写访问令牌');
    }
    Object.assign(row,...(sealedToken?[{sealedToken}]:[]),config,{enabled:input.enabled===true,health:row.health||'unchecked',nextRunAt:input.enabled===true?now():null});
    if(!existing)a.data.connectors.push(row);
    collection.configure(a,'connector',row,{before:beforeCollection,trusted:true,command:action});
  }else{
    const c=byId(a,input.id);
    if(action==='connectorSync'&&require('./chat-streams.cjs').isStream(c)){projectLifecycle.assertActive(a.data,c.projectId);if(!c.enabled)throw Error('请先启用机器人连接');c.inboxRetryAt=null;c.error='';a.streamController?.reconnect(c.id);a.save();return a.publicState();}
    if(action==='connectorSync'){require('./sync-window.cjs').restart(c);return a.launch(`收集${office.label(c)} · ${c.name}`,()=>sync(a,c.id));}
    if(action==='connectorToggle'){c.enabled=!!input.enabled;c.nextRunAt=c.enabled?now():null;if(c.enabled)c.error='';}
    else if(action==='connectorDelete'){
      collection.remove(a,'connector',c,action);
      for(const o of a.data.sourceObservations||[])if(o.scope.projectId===c.projectId&&(o.resourceKey===observations.resourceKey(c.target)||o.resourceKey?.startsWith(`${office.kind(c)}:${c.target}:`)))observations.close(a,{observationId:o.observationId},'信息连接已移除');
      a.data.connectors=a.data.connectors.filter(r=>r!==c);
    }
    else throw new Error('未知连接操作');
  }
  a.save();return a.publicState();
}
module.exports={initialize,dispatch,sync,tick,pauseAll,commit};
