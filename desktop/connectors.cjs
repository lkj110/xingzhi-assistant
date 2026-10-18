const policy=require('./access-policy-store.cjs');
const transition=require('./state-transitions.cjs');
const internals=new WeakMap(),pageTokens=new WeakMap();
function internal(a){if(!internals.has(a))internals.set(a,{previews:new Map(),runs:new Set()});return internals.get(a);}
const isLark=c=>office.kind(c)==='lark';
const conflict=()=>Object.assign(Error('连接或授权已变化，请重新预览或重试'),{code:'CONTEXT_VERSION_CHANGED',connectorCode:'auth'});
const collection=require('./collection-permissions.cjs');
const office=require('./office-connectors.cjs');
const projectLifecycle=require('./project-lifecycle.cjs');
const crypto=require('node:crypto');
const lark=require('./lark-connector.cjs');
const projects=require('./projects.cjs');
const observations=require('./source-observations.cjs');
const evidence=require('./evidence-basis.cjs');
const documents=require('./documents.cjs');
const now=()=>new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function initialize(a,request,officeRequest){a.officeRequest=officeRequest||require('./agent-tools.cjs').publicRequest;a.data.connectors ||= [];a.data.connectorRuns ||= [];a.connectorRequest=request||lark.request;for(const c of a.data.connectors)if(isLark(c)&&!validBinding(c.larkBinding)){c.health='binding_required';c.nextRunAt=null;}for(const r of a.data.connectorRuns)if(r.status==='running'){r.status='interrupted';r.finishedAt=now();}}
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
function sameVersion(previous,current){return !!previous&&(previous.semanticHash||evidence.sourceSemanticVersion(previous))===current.semanticHash;}
// Commit each page and its cursor together. A failed merge must never consume the cursor.
function commit(a,c,items,cursor,syncWindow,collectionToken,pageContext){
  const proof=isLark(c)?pageTokens.get(pageContext?.token):null;
  if(isLark(c)){if(!proof)throw conflict();proof.assertCurrent();lark.assertPinnedPage(pageContext.result,c.larkBinding.identity,proof.assertCurrent);}
  if(!Array.isArray(items)||items.length>50)throw new Error('同步页过大');
  const prepared=items.map(item=>{
    if(typeof item.remoteId!=='string'||item.remoteId.length>1200||typeof item.content!=='string'||item.content.length>documents.maxChars)throw new Error('来源 ID 或正文超出支持范围');
    const identity=`connector:${c.id}:${isLark(c)?policy.hash(c.larkBinding.identity)+':':''}${item.remoteId}`;
    const title=evidence.sourceTitle(item).slice(0,300)||evidence.sourceTitle({title:c.kind==='document'?c.name:`${c.name} · ${item.remoteId}`});
    return {...item,identity,resourceKey:item.resourceKey||(c.kind==='document'?c.target:`${office.kind(c)}:${c.target}:${item.remoteId}`),principalScope:isLark(c)?{...c.larkBinding.principalScope,appId:c.larkBinding.identity.appId,brand:c.larkBinding.identity.brand}:item.principalScope??c.principalScope,...(isLark(c)?{larkIdentity:structuredClone(c.larkBinding.identity)}:{}),projectId:c.projectId,connectorId:c.id,hash:hash(item.content),semanticHash:evidence.sourceSemanticVersion({...item,title}),title,origin:`${office.label(c)} · ${c.target}`};
  });
  const pageItems=new Map();
  for(const item of prepared){
    const previous=pageItems.get(item.identity);
    if(previous&&previous.semanticHash!==item.semanticHash)throw Object.assign(Error('同一同步页包含相同来源的冲突版本，整页未导入；原来源和同步断点已保留，请核对来源后重试。'),{code:'CONNECTOR_PAGE_CONFLICT',connectorCode:'merge'});
    if(!previous)pageItems.set(item.identity,item);
  }
  let added=0;
  return require('./state-transitions.cjs').commit(a,()=>{
    if(proof){proof.assertCurrent();lark.assertPinnedPage(pageContext.result,c.larkBinding.identity,proof.assertCurrent);}
    const p=projects.byId(a,c.projectId),job=projects.job(a,p);
    const admitted=[...pageItems.values()].filter(item=>{
      const old=latest(a,c,item.identity);if(old?.projectExcluded){closePrevious(a,c,item,old,'来源已撤回');return false;}
      const changed=!sameVersion(old,item);
      item.semanticFactSchema=changed?2:old.semanticFactSchema;
      item.stableEventId=observations.transitionEvent(a,old,changed);if(!changed)item.id=old.id;
      if(item.deleted){closePrevious(a,c,item,old,'远端来源已撤回');item.purpose='withdrawal';}
      const check=observations.observe(a,item,{channel:'connector',trustedInput:true,scope:{projectId:p.id,jobId:job?.id}});item.sourceCheck=check;
      return check.allowInput||item.deleted&&old&&!old.deleted&&old.purpose!=='delivery_readback';
    });
    const changes=admitted.filter(item=>!sameVersion(latest(a,c,item.identity),item));
    const pendingProject=!!job&&a.data.sources.some(s=>s.projectId===p.id&&!s.projectExcluded&&!job.sourceIds.includes(s.id)&&observations.allows(a,s));
    const current=a.data.sources.filter(s=>s.connectorId===c.id&&s.projectId===p.id&&(!isLark(c)||policy.hash(s.larkIdentity||null)===policy.hash(c.larkBinding.identity))&&!s.copiedFrom&&!s.projectExcluded&&latest(a,c,s.identity)?.id===s.id&&observations.allows(a,s));
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
      if(old?.projectExcluded||sameVersion(old,item))continue;
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
  const runtime=internal(a);if(runtime.runs.has(id))throw conflict();runtime.runs.add(id);
  try{
    const c=byId(a,id);try{if(isLark(c)&&c.pendingLarkBinding)recoverBinding(a,c);}catch{}
    return await syncRun(a,id,configStamp(a,c));
  }finally{runtime.runs.delete(id);}
}
async function syncRun(a,id,runStamp){
  let c=byId(a,id);projectLifecycle.assertActive(a.data,c.projectId);const record={id:crypto.randomUUID(),connectorId:id,startedAt:now(),added:0,pages:0,status:'running'};
  a.data.connectorRuns.unshift(record);a.data.connectorRuns=a.data.connectorRuns.slice(0,200);a.save();
  try {
    if(isLark(c))assertBinding(a,c);
    const collectionToken=collection.begin(a,'connector',c);
    const end=now();const window=c.cursor?.window||{start:new Date(Math.max(Date.parse(c.createdAt)-c.lookbackDays*86400000,(Date.parse(c.cursor?.through)||0)-86400000)).toISOString(),end};
    let token=c.cursor?.token||'';
    const windows=require('./sync-window.cjs');let durable=windows.begin(c,window);
    if(c.syncWindow&&c.syncWindow.scope!==durable.scope||!c.syncWindow&&c.cursor?.token)token='';
    for(let i=0;i<5;i++){
      a.controller?.signal.throwIfAborted();
      c=byId(a,id);if(configStamp(a,c)!==runStamp)throw conflict();
      const pageToken=isLark(c)?beginPage(a,c,collectionToken):null,proof=pageToken&&pageTokens.get(pageToken);
      const result=isLark(c)?await lark.pinnedPage(c,{...window,token},{identity:c.larkBinding.identity,assertCurrent:proof.assertCurrent,run:a.connectorRequest,signal:a.controller?.signal}):await office.page(a,c,{...window,token},a.controller?.signal);
      a.controller?.signal.throwIfAborted();
      if(result.hasMore&&(typeof result.token!=='string'||!result.token||result.token.length>10000))throw new Error('分页凭据无效，断点已保留');
      const cursor=result.hasMore?{through:c.cursor?.through||null,window,token:result.token}:{through:window.end};
      const nextWindow=windows.advance(durable,token,result);
      const count=commit(a,c,result.items,cursor,nextWindow,collectionToken,pageToken?{token:pageToken,result}:null);durable=nextWindow;record.added+=count;record.pages++;token=result.token;
      if(durable.status==='blocked')throw Object.assign(Error('检测到分页循环，同步未完成；点击同步可重新扫描当前窗口。'),{connectorCode:'cursor_cycle'});
      if(result.delayMs)c.pageDelayMs=result.delayMs;
      if(!result.hasMore||result.yield)break;
    }
    if(configStamp(a,byId(a,id))!==runStamp)throw conflict();
    c.lastSuccessAt=now();c.health='healthy';c.error='';c.failures=0;
    record.status=c.cursor?.token?'partial':record.added?'updated':'unchanged';
    c.nextRunAt=c.enabled?new Date(Date.now()+(c.cursor?.token?(c.pageDelayMs||30000):c.intervalMinutes*60000)).toISOString():null;
    if(record.added)a.event(`${office.label(c)}材料已归并`,`${c.name}：${record.added} 份新材料或更新，已关联项目。`);
  }catch(error){
    // A failed transaction restores the object graph; reacquire both references.
    c=a.data.connectors.find(c=>c.id===id);const saved=a.data.connectorRuns.find(r=>r.id===record.id);if(!saved)return;Object.assign(saved,record);
    if(!c||configStamp(a,c)!==runStamp){saved.status=a.controller?.signal.aborted?'paused':'interrupted';saved.error='旧同步响应已丢弃，连接状态保持当前设置';return;}
    const stopped=!!a.controller?.signal.aborted;
    c.error=stopped?'同步已暂停，恢复后从断点继续':error.message;c.health=stopped?'paused':error.connectorCode||'error';c.failures=(c.failures||0)+1;
    if(error.connectorCode==='cursor'&&c.cursor?.window){if(c.syncWindow)c.syncWindow.status='expired';require('./sync-window.cjs').restart(c);delete c.cursor.token;}
    if(!c.enabled||['auth','permission','missing_cli','merge','cursor_cycle','binding_required','identity_binding_unavailable','binding_pending'].includes(c.health))c.nextRunAt=null;
    else c.nextRunAt=new Date(Date.now()+Math.max(error.retryAfterMs||0,c.intervalMinutes*60000,Math.min(3600000,60000*2**Math.min(c.failures,5)))).toISOString();
    saved.status=stopped?'paused':'error';saved.error=c.error;saved.code=error.code||null;
    if(!stopped&&c.failures===1)a.event('信息连接需要处理',`${c.name}：${c.error}`,null,'warning');
  }finally{const row=a.data.connectorRuns.find(r=>r.id===record.id);if(row){if(row.status==='running')Object.assign(row,record);row.finishedAt=now();}const live=a.data.connectors.find(c=>c.id===id);if(live&&configStamp(a,live)===runStamp)live.lastCheckedAt=now();a.save();}
}
function tick(a){
  for(const c of a.data.connectors)if(isLark(c)&&c.pendingLarkBinding)try{if(recoverBinding(a,c))return true;}catch{}
  if(require('./chat-streams.cjs').tick(a))return true;
  const c=a.data.connectors.filter(c=>!require('./chat-streams.cjs').isStream(c)&&c.enabled&&projectLifecycle.isActive(a.data,c.projectId)&&c.nextRunAt&&Date.parse(c.nextRunAt)<=Date.now()).sort((x,y)=>x.nextRunAt.localeCompare(y.nextRunAt))[0];
  if(!c)return false;a.launch(`收集${office.label(c)} · ${c.name}`,()=>sync(a,c.id));return true;
}
function pauseAll(a){for(const c of a.data.connectors){c.controlRevision=(c.controlRevision||0)+1;c.enabled=false;c.nextRunAt=null;}}
async function dispatch(a,action,input){
  if(action==='connectorStatus'){const result=await lark.status(a.connectorRequest);a.data.larkHealth=result;a.save();return result;}
  if(action==='connectorBindingResult')return bindingResult(a,input);
  a.ensureIdle();
  if(action==='connectorIdentityPreview')return previewBinding(a,input);
  if(action==='connectorBindPrincipal')return bindPrincipal(a,input);
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
    row.controlRevision=(row.controlRevision||0)+1;internal(a).previews.delete(row.id);
    if(isLark(row)){if(!validBinding(row.larkBinding)){row.health='binding_required';row.nextRunAt=null;}}else collection.configure(a,'connector',row,{before:beforeCollection,trusted:true,command:action});
  }else{
    const c=byId(a,input.id);
    if(action==='connectorSync'&&require('./chat-streams.cjs').isStream(c)){projectLifecycle.assertActive(a.data,c.projectId);if(!c.enabled)throw Error('请先启用机器人连接');c.inboxRetryAt=null;c.error='';a.streamController?.reconnect(c.id);a.save();return a.publicState();}
    if(action==='connectorSync'){require('./sync-window.cjs').restart(c);return a.launch(`收集${office.label(c)} · ${c.name}`,()=>sync(a,c.id));}
    if(action==='connectorToggle'){c.controlRevision=(c.controlRevision||0)+1;internal(a).previews.delete(c.id);c.enabled=!!input.enabled;c.nextRunAt=c.enabled&&(!isLark(c)||validBinding(c.larkBinding))?now():null;if(c.enabled)c.error='';}
    else if(action==='connectorDelete'){
      internal(a).previews.delete(c.id);collection.remove(a,'connector',c,action);
      if(isLark(c)&&validBinding(c.larkBinding))policy.revoke(a,bindingSpecs(c,c.larkBinding)[0],{trusted:true,actor:'user_command',command:action});
      for(const o of a.data.sourceObservations||[])if(o.scope.projectId===c.projectId&&(o.resourceKey===observations.resourceKey(c.target)||o.resourceKey?.startsWith(`${office.kind(c)}:${c.target}:`)))observations.close(a,{observationId:o.observationId},'信息连接已移除');
      a.data.connectors=a.data.connectors.filter(r=>r!==c);
    }
    else throw new Error('未知连接操作');
  }
  a.save();return a.publicState();
}
module.exports={initialize,dispatch,sync,tick,pauseAll,commit};

function validBinding(b){return !!b&&b.format===1&&Number.isInteger(b.generation)&&b.generation>0&&/^cli_[A-Za-z0-9_-]{1,120}$/.test(b.identity?.appId||'')&&/^ou_[A-Za-z0-9_-]{1,120}$/.test(b.identity?.openId||'')&&['feishu','lark'].includes(b.identity?.brand)&&typeof b.identity?.tenantId==='string'&&!!b.identity.tenantId.trim()&&b.identity.tenantId.length<=200&&b.principalScope?.subject===b.identity.openId&&b.principalScope?.tenantId===b.identity.tenantId;}
function projectLifecycleRevision(a,c){return a.data.projects.find(p=>p.id===c.projectId)?.lifecycleRevision||null;}
// Missing lifecycle facts in old pending records are unknown, not permission to resume.
function bindingControlCurrent(a,c,p){return p.controlRevision===(c.controlRevision||0)&&p.projectLifecycleRevision===projectLifecycleRevision(a,c)&&projectLifecycle.isActive(a.data,c.projectId);}
function configStamp(a,c){return policy.hash({id:c.id,kind:c.kind,target:c.target,projectId:c.projectId,name:c.name,interval:c.intervalMinutes,lookback:c.lookbackDays,control:c.controlRevision||0,projectLifecycleRevision:isLark(c)?projectLifecycleRevision(a,c):null,binding:c.larkBinding||null,pending:c.pendingLarkBinding?.operationId||null});}
function bindingSpecs(c,b){return [{principalScope:b.principalScope,resourceScope:{kind:'connector',key:c.id,projectId:c.projectId,revision:policy.hash({kind:c.kind,target:c.target,projectId:c.projectId,identity:b.identity,generation:b.generation})},operations:[c.kind==='document'?'collect_lark_document':'collect_lark_messages']},collection.spec('connector',{...c,larkBinding:b})];}
function bindingChecks(a,c){
 const b=c.larkBinding;if(!validBinding(b)||c.pendingLarkBinding)throw Object.assign(Error(c.pendingLarkBinding?'绑定尚未完成，请核对原操作':'请先预览并明确绑定采集账号'),{code:'ACCESS_PRINCIPAL_UNKNOWN',connectorCode:c.pendingLarkBinding?'binding_pending':'binding_required'});
 projectLifecycle.assertActive(a.data,c.projectId);
 const checks=bindingSpecs(c,b).flatMap(spec=>spec.operations.map(operation=>policy.check(a,{...spec,operation})));
 if(checks.some(x=>!x.allowed))throw Object.assign(Error('当前采集或本地读取权限已失效，请明确重新授权'),{code:checks.find(x=>!x.allowed).code,connectorCode:'permission'});
 if(!b.receipts||checks[0].policyId!==b.receipts[0]?.policyId||checks[0].grantRevision!==b.receipts[0]?.grantRevision||checks.slice(1).some(x=>x.policyId!==b.receipts[1]?.policyId||x.grantRevision!==b.receipts[1]?.grantRevision))throw conflict();
 return checks;
}
function assertBinding(a,c){bindingChecks(a,c);}
function beginPage(a,c,collectionToken){
 const stamp=configStamp(a,c),cursor=policy.hash({cursor:c.cursor,window:c.syncWindow}),checks=bindingChecks(a,c).map(x=>[x.policyId,x.grantRevision]),signal=a.controller?.signal;
 const assertCurrent=()=>{signal?.throwIfAborted();const live=a.data.connectors.find(r=>r.id===c.id);if(!live||configStamp(a,live)!==stamp||policy.hash({cursor:live.cursor,window:live.syncWindow})!==cursor)throw conflict();if(policy.hash(bindingChecks(a,live).map(x=>[x.policyId,x.grantRevision]))!==policy.hash(checks)||!collection.current(a,collectionToken).allowed)throw conflict();};
 const token=Object.freeze({});pageTokens.set(token,{assertCurrent});assertCurrent();return token;
}
function closePrevious(a,c,item,old,reason){
 if(!isLark(c))return observations.close(a,{resourceKey:item.resourceKey,scope:{projectId:c.projectId}},reason);
 if(old?.observationId)observations.close(a,{observationId:old.observationId},reason);
}
async function previewBinding(a,{id}){
 const c=byId(a,id);if(!isLark(c))throw conflict();projectLifecycle.assertActive(a.data,c.projectId);
 const state=internal(a),entry={previewToken:crypto.randomUUID(),operationId:crypto.randomUUID(),stamp:configStamp(a,c),authority:policy.authorityStamp(a),createdAt:Date.now()};
 if(entry.authority.status!=='complete')throw Object.assign(Error('权限库不可用，不能绑定账号'),{code:'ACCESS_POLICY_UNKNOWN'});
 state.previews.set(id,entry);
 const result=await lark.identityPreview(a.connectorRequest,a.controller?.signal);
 if(state.previews.get(id)!==entry||configStamp(a,byId(a,id))!==entry.stamp||policy.hash(policy.authorityStamp(a))!==policy.hash(entry.authority))throw conflict();
 Object.assign(entry,result);
 return {id,previewToken:entry.previewToken,operationId:entry.operationId,identity:entry.identity,target:c.target,projectId:c.projectId,scope:'采集此来源并在本地保留和读取',expiresAt:new Date(entry.createdAt+300000).toISOString()};
}
function bindPrincipal(a,input){
 const entry=internal(a).previews.get(input.id);
 if(!entry||entry.previewToken!==input.previewToken||entry.operationId!==input.operationId||!entry.identity)throw conflict();
 const payload=policy.hash({id:input.id,enableAfterBind:input.enableAfterBind===true});
 if(entry.claimed){if(entry.claimed!==payload)throw conflict();return entry.promise;}
 if(Date.now()-entry.createdAt>300000)throw conflict();
 entry.claimed=payload;entry.promise=finishBinding(a,input,entry);return entry.promise;
}
async function finishBinding(a,input,entry){
 let c=byId(a,input.id);
 const assert=()=>{c=byId(a,input.id);projectLifecycle.assertActive(a.data,c.projectId);if(configStamp(a,c)!==entry.stamp||policy.hash(policy.authorityStamp(a))!==policy.hash(entry.authority))throw conflict();};
 assert();await lark.confirmIdentity(entry.capability,entry.identity,a.connectorRequest,a.controller?.signal);assert();
 const identity=entry.identity,binding={format:1,identity,principalScope:{kind:'account',provider:'lark',subject:identity.openId,tenantId:identity.tenantId},generation:(c.larkBinding?.generation||0)+1,operationId:entry.operationId,confirmedAt:now()};
 const specs=bindingSpecs(c,binding),previous=[...(validBinding(c.larkBinding)?[bindingSpecs(c,c.larkBinding)[0]]:[]),collection.spec('connector',c)];
 const pending={operationId:entry.operationId,binding,expectedSequence:entry.authority.sequence,controlRevision:c.controlRevision||0,projectLifecycleRevision:projectLifecycleRevision(a,c),enableAfterBind:input.enableAfterBind===true,oldCursor:structuredClone(c.cursor||null),oldWindow:structuredClone(c.syncWindow||null)};
 transition.commit(a,()=>{c.pendingLarkBinding=pending;c.nextRunAt=null;c.health='binding_pending';});
 try{
  policy.commitLarkBinding(a,{operationId:entry.operationId,expectedSequence:entry.authority.sequence,previous,specs},{trusted:true,actor:'user_command',command:'connectorBindPrincipal'});
  recoverBinding(a,byId(a,input.id));return bindingResult(a,input);
 }catch(error){const receipt=policy.larkBindingReceipt(a,entry.operationId,specs);if(receipt.committed)return {id:input.id,operationId:entry.operationId,status:'pending',committed:true,code:error.code||'BINDING_PROJECTION_PENDING'};throw error;}
}
function recoverBinding(a,c){
 const p=c.pendingLarkBinding;if(!p||!validBinding(p.binding)||!bindingControlCurrent(a,c,p))return false;
 const receipt=policy.larkBindingReceipt(a,p.operationId,bindingSpecs(c,p.binding));if(!receipt.committed||!receipt.valid)return false;
 transition.commit(a,()=>{
  if(c.pendingLarkBinding!==p||!bindingControlCurrent(a,c,p))throw conflict();
  (c.larkBindingHistory ||= []).push({operationId:c.larkBinding?.operationId||null,binding:c.larkBinding||null,cursor:p.oldCursor,syncWindow:p.oldWindow,archivedBy:p.operationId,at:now()});
  if(p.oldWindow)(c.syncWindowHistory ||= []).push(p.oldWindow);
  c.larkBinding={...p.binding,receipts:receipt.proofs.map(({policyId,grantRevision})=>({policyId,grantRevision}))};delete c.pendingLarkBinding;
  c.cursor=null;c.syncWindow=null;c.enabled=p.enableAfterBind;c.health='unchecked';c.error='';c.nextRunAt=c.enabled?now():null;
 });return true;
}
function bindingResult(a,{id,operationId}){
 const c=byId(a,id);if(typeof operationId!=='string')throw conflict();
 if(c.larkBinding?.operationId===operationId){const receipt=policy.larkBindingReceipt(a,operationId,bindingSpecs(c,c.larkBinding));return {id,operationId,status:receipt.valid?'bound':'revoked',committed:receipt.committed,enabled:c.enabled,identity:c.larkBinding.identity};}
 if(c.pendingLarkBinding?.operationId===operationId){const p=c.pendingLarkBinding,receipt=policy.larkBindingReceipt(a,operationId,bindingSpecs(c,p.binding));return {id,operationId,status:!bindingControlCurrent(a,c,p)?'superseded':receipt.committed&&!receipt.valid?'revoked':'pending',committed:receipt.committed,enabled:false};}
 return {id,operationId,status:c.larkBindingHistory?.some(x=>x.operationId===operationId)?'superseded':'unknown',committed:false};
}
