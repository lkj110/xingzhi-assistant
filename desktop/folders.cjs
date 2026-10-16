const collection=require('./collection-permissions.cjs');
const projectLifecycle=require('./project-lifecycle.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const projects = require('./projects.cjs');
const observations = require('./source-observations.cjs');
const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const textTypes = new Set(['.txt', '.md', '.csv', '.json']);
const identity = (folder, name) => `folder:${hash(JSON.stringify([folder.id, folder.projectId || null, name]))}`;
function initializeFolder(folder) {
  if (folder.enabled === undefined) folder.enabled = true;
  folder.projectId ||= null; folder.manifest ||= {};
}
function byId(a, id) { const folder = a.data.folders.find(f => f.id === id); if (!folder) throw new Error('资料目录已移除'); initializeFolder(folder); return folder; }
function ownOutput(a, folder, name) {
  if (/^行知-[a-f0-9]{8}-/i.test(name)) return true;
  const target = path.join(folder.path, name);
  return a.data.agentActions.some(r => r.tool === 'write_file' && [r.target, r.result?.path, r.result?.latestPath,
    r.latestName && path.join(path.dirname(r.target || r.result?.path || ''), r.latestName)].includes(target));
}
function listing(a, folder, textOnly) {
  projectLifecycle.assertActive(a.data,folder.projectId);
  initializeFolder(folder);
  if (folder.projectId) projects.byId(a, folder.projectId);
  if (fs.realpathSync(folder.path) !== folder.path || !fs.lstatSync(folder.path).isDirectory()) throw new Error('授权目录路径已变化，请重新选择目录');
  if (folder.path === a.dir) throw new Error('不能将助手自身的数据目录作为材料来源');
  const all = fs.readdirSync(folder.path, {withFileTypes:true});
  const candidates = all.filter(e => !e.name.startsWith('.') && documents.extensions.has(path.extname(e.name).toLowerCase()));
  const regular = candidates.filter(e => e.isFile()).sort((a,b) => a.name.localeCompare(b.name));
  const names = new Set(candidates.map(e => e.name));
  const warnings = [];
  if (regular.length > 100) warnings.push(`目录共有 ${regular.length} 份支持的文件，每次仅检查按名称排序的前 100 份；请拆分目录。此次不判断文件删除。`);
  if (candidates.some(e => !e.isFile())) warnings.push('已跳过子目录和符号链接。');
  return {entries:regular.slice(0,100).filter(e => !textOnly || textTypes.has(path.extname(e.name).toLowerCase())),names,warnings,complete:regular.length<=100 && !textOnly,total:regular.length};
}
function readBuffer(folder, name, remaining=50_000_000) {
  if(fs.realpathSync(folder.path)!==folder.path)throw new Error('授权目录路径已变化，请重新选择目录');
  const fd = fs.openSync(path.join(folder.path,name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > documents.maxBytes) throw new Error('文件不是常规文件或超过 10 MB');
    if(stat.size>remaining)throw Object.assign(new Error('本轮已达到 50 MB 扫描上限，请拆分目录；剩余文件未读取，此次不判断删除'),{scanLimit:true});
    const buffer = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (buffer.length > documents.maxBytes) throw new Error('文件超过 10 MB');
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('文件正在更新，本轮保留上一版本，下轮重试');
    buffer.observationRevision=`${after.dev}:${after.ino}:${after.mtimeMs}:${after.ctimeMs}:${after.size}`;
    return buffer;
  } finally { fs.closeSync(fd); }
}
function latest(a, folder, name) {
  const key = identity(folder,name),rows=a.data.sources.filter(s=>s.identity===key&&(s.projectId||null)===(folder.projectId||null)&&!s.copiedFrom);
  if(rows.length){const replaced=new Set(rows.map(s=>s.previousSourceId));return rows.find(s=>!replaced.has(s.id))||rows[0];}
  return a.data.sources.find(s=>!s.identity&&!s.copiedFrom&&(s.projectId||null)===(folder.projectId||null)&&s.origin===path.join(folder.path,name)&&s.title===name);
}
function ancestors(a,source){
  const ids=[],seen=new Set([source.id]);let id=source.previousSourceId;
  while(id&&!seen.has(id)){
    const previous=a.data.sources.find(s=>s.id===id&&(s.projectId||null)===(source.projectId||null));
    if(!previous||previous.copiedFrom)break;ids.push(id);seen.add(id);id=previous.previousSourceId;
  }
  return ids;
}
function prepared(a, folder, name, buffer, scan) {
  const previous = latest(a,folder,name), key = identity(folder,name), rawHash = hash(buffer), cached = folder.manifest[key];
  if (previous?.projectExcluded) {observations.close(a,{resourceKey:path.join(folder.path,name),scope:{projectId:folder.projectId||null}},'来源已撤回');scan.warnings.push(`「${name}」已从项目撤回，自动同步保持撤回；请在项目页明确重新关联后继续。`);return null;}
  if (previous && !previous.deleted && cached?.rawHash === rawHash && cached.sourceId === previous.id) {scan.unchanged++;return null;}
  if(!previous&&cached?.rawHash===rawHash&&cached?.remoteRevision===buffer.observationRevision&&cached?.observationId){scan.unchanged++;return null;}
  return {name,previous,key,rawHash,remoteRevision:buffer.observationRevision,buffer};
}
function textDocument(name, buffer) {
  const content = buffer.toString('utf8');
  if (!content.trim()) throw new Error('文件没有可读取文字');
  if (content.length > documents.maxChars) throw new Error('文件超过 50 万字符');
  return {title:name,content,segments:documents.paragraphs(content),format:path.extname(name).slice(1),warnings:[]};
}
function affected(a, folder, entries, removed, pendingProject=false) {
  const ids = new Set([...entries.map(e=>e.previous?.id),...removed.map(s=>s.id)].filter(Boolean));
  const tasks = a.data.tasks.filter(t=>!t.agentCancelled&&t.sourceIds.some(id=>ids.has(id)));
  const jobs = new Set(tasks.map(t=>t.agentJobId).filter(Boolean));
  for(const job of a.data.delegations)if(job.sourceIds.some(id=>ids.has(id)))jobs.add(job.id);
  if (folder.projectId) {const j=projects.job(a,projects.byId(a,folder.projectId));if(j)jobs.add(j.id);}
  const taskIds=new Set(tasks.map(t=>t.id)),actions=new Set(a.data.agentActions.filter(r=>taskIds.has(r.taskId)));
  for(const job of a.data.delegations.filter(j=>jobs.has(j.id)))for(const action of projects.relatedActions(a,job))actions.add(action);
  if ((entries.length||removed.length||pendingProject)&&[...actions].some(r=>['running','uncertain'].includes(r.status))) throw new Error('项目或关联事项有外部动作待核对，请先处理后同步');
  return {tasks,jobs,actions};
}
function invalidateTask(a, task, reason, source) {
  if (source) {task.sourceIds=[...new Set([...task.sourceIds,source.id])];task.supersededSourceIds=[...new Set([...(task.supersededSourceIds||[]),...ancestors(a,source)])];}
  a.requeue(task);
  if (task.agentJobId) {task.needsReplan=reason;require('./agent-plan.cjs').invalidateDependents(a,task);}
  else {
    // Standalone tasks need a human review before their completed evidence is reused.
    for (const step of task.steps) if (step.kind!=='external') {step.done=false;delete step.artifactId;delete step.evidence;}
    task.needsReplan=reason;task.lastError=reason;
    if(task.status!=='paused')task.status='blocked';
    task.notes.push({id:crypto.randomUUID(),kind:'source',at:now(),text:reason});
  }
  task.updatedAt=now();
}
function commit(a, folder, scan) {
  const admitted=scan.parsed.filter(e=>{
    const descriptor={...e.document,id:e.previous?.hash===hash(e.document.content.trim())&&!e.previous.deleted?e.previous.id:undefined,resourceKey:path.join(folder.path,e.name),principalScope:'local',remoteRevision:e.remoteRevision,projectId:folder.projectId||null,folderId:folder.id,fileName:e.name,identity:e.key,origin:path.join(folder.path,e.name)};
    e.sourceCheck=observations.observe(a,descriptor,{channel:'folder',trustedInput:!/^行知-[a-f0-9]{8}-/i.test(e.name)});
    if(!e.sourceCheck.allowInput){folder.manifest[e.key]={rawHash:e.rawHash,remoteRevision:e.remoteRevision,observationId:e.sourceCheck.observationId,name:e.name,projectId:folder.projectId||null};return false;}
    return true;
  });
  const candidates = admitted.filter(e=>!e.previous||e.previous.deleted||e.previous.hash!==hash(e.document.content.trim()));
  const removed = scan.complete ? a.data.sources.filter(s=>s.folderId===folder.id&&(s.projectId||null)===(folder.projectId||null)&&!s.deleted&&!s.projectExcluded&&latest(a,folder,s.fileName)?.id===s.id&&!scan.names.has(s.fileName)) : [];
  if(scan.complete)for(const entry of Object.values(folder.manifest))if(!scan.names.has(entry.name)&&entry.observationId)observations.close(a,{observationId:entry.observationId},'完整目录扫描确认来源已删除');
  // Restores retain later sources and current scan fingerprints. A cache hit must still
  // reconcile that evidence with an older restored plan, without unpausing it.
  const project=folder.projectId?projects.byId(a,folder.projectId):null, projectJob=project?projects.job(a,project):null;
  const pendingProject=!!projectJob&&a.data.sources.some(s=>s.projectId===project.id&&!s.projectExcluded&&!projectJob.sourceIds.includes(s.id)&&observations.allows(a,s));
  const reconcile=a.data.sources.filter(s=>s.folderId===folder.id&&(s.projectId||null)===(folder.projectId||null)&&!s.projectExcluded&&latest(a,folder,s.fileName)?.id===s.id&&s.previousSourceId&&observations.allows(a,s)&&a.data.tasks.some(t=>!t.agentCancelled&&ancestors(a,s).some(id=>t.sourceIds.includes(id))&&!t.sourceIds.includes(s.id)));
  const change=affected(a,folder,[...candidates,...reconcile.flatMap(s=>ancestors(a,s).map(id=>({previous:{id}})))],removed,pendingProject), additions=[];
  for (const entry of admitted) {
    let source = entry.previous;
    if (candidates.includes(entry)) {
      source={id:crypto.randomUUID(),...entry.document,origin:path.join(folder.path,entry.name),resourceKey:path.join(folder.path,entry.name),principalScope:'local',remoteRevision:entry.remoteRevision,projectId:folder.projectId||null,folderId:folder.id,fileName:entry.name,identity:entry.key,
        hash:hash(entry.document.content.trim()),state:'new',createdAt:now(),processedAt:null,version:(entry.previous?.version||0)+1,...(entry.previous?{previousSourceId:entry.previous.id}:{})};
      source=collection.attach(a,'folder',folder,source,entry.sourceCheck,scan.collectionToken);additions.push(source);
    } else if (source) {
      Object.assign(source,{folderId:folder.id,fileName:entry.name,identity:entry.key,version:source.version||1});scan.unchanged++;
    }
    folder.manifest[entry.key]={rawHash:entry.rawHash,remoteRevision:entry.remoteRevision,sourceId:source.id,observationId:entry.sourceCheck.observationId,name:entry.name,projectId:folder.projectId||null};
  }
  for (const old of removed) {
    observations.close(a,{sourceId:old.id},'完整目录扫描确认来源已删除');
    const source={...old,id:crypto.randomUUID(),purpose:'withdrawal',previousSourceId:old.id,version:(old.version||1)+1,deleted:true,deletedAt:now(),createdAt:now(),state:'new',processedAt:null,withdrawalReason:'完整扫描确认原文件已从授权目录移除；正文保留供追溯。'};
    a.data.sources.unshift(source);additions.push(source);
    for(const job of a.data.delegations.filter(j=>j.sourceIds.includes(old.id)))require('./agent-followup.cjs').invalidateEvidence(a,job,source);
  }
  if (project && (additions.length||pendingProject)) projects.ingest(a,project);
  for(const source of [...additions,...reconcile])if(source.previousSourceId)for(const task of change.tasks.filter(t=>ancestors(a,source).some(id=>t.sourceIds.includes(id)))) {
    // Project ingestion handles its canonical tasks; a source may also be used by an independent task.
    if(!task.sourceIds.includes(source.id))invalidateTask(a,task,source.deleted?`材料「${source.title}」已从目录移除，原内容不再作为当前依据。`:`材料「${source.title}」更新至第 ${source.version} 版，请核对相关产出。`,source);
  }
  for(const source of additions.filter(s=>s.deleted&&!s.projectId))source.state='processed';
  if(additions.length||reconcile.length||pendingProject){
    for(const action of change.actions)if(action.status==='pending'){action.status='stale';delete action.approvedAt;}
    for(const id of change.jobs) {
    const job=a.data.delegations.find(j=>j.id===id);if(!job)continue;
    job.pendingActionId=null;job.completedAt=null;job.failures=0;job.resumeWatching=false;
    if(job.status!=='paused'){job.status='ready';job.nextRunAt=now();}
    job.updatedAt=now();job.summary=`资料目录更新：新增 ${candidates.length} 份版本，移除 ${removed.length} 份来源，请核对受影响事项。`;
    }
  }
  folder.lastSyncedAt=now();folder.lastSuccessAt=scan.errors.length?folder.lastSuccessAt:folder.lastSyncedAt;
  folder.error=scan.errors.slice(0,5).join('\n');folder.warnings=scan.warnings.slice(0,12);
  folder.health=scan.errors.length?'error':scan.warnings.length?'attention':'healthy';
  folder.stats={checked:scan.checked,total:scan.total,added:candidates.length,removed:removed.length,unchanged:scan.unchanged,complete:scan.complete};
  if(additions.length)a.event('资料目录已同步',`${folder.name||path.basename(folder.path)}：新增 ${candidates.length} 份版本，移除 ${removed.length} 份来源。`);
  if(folder.error)a.event('资料目录需要处理',folder.error,null,'warning');
  a.save();return candidates.length;
}
function newScan(a,folder,textOnly){return {...listing(a,folder,textOnly),errors:[],parsed:[],checked:0,unchanged:0,bytes:0};}
function scanError(scan,name,error){scan.errors.push(`${name}：${error.message}`);if(error.scanLimit)scan.warnings.unshift(error.message);scan.complete=false;}
function folderFailure(a,folder,error){folder.health='error';folder.error=error.message;folder.lastSyncedAt=now();folder.stats={...(folder.stats||{}),complete:false};a.event('资料目录需要处理',`${folder.name||folder.path}：${error.message}`,null,'warning');a.save();}
function addBytes(scan,buffer){scan.bytes+=buffer.length;if(scan.bytes>50_000_000)throw new Error('本轮已超过 50 MB 扫描上限，请拆分目录');}
// Synchronous compatibility for original text-only integrations; desktop uses syncAllFolders.
function syncFolders(a){
  if(a.operation)return 0;let count=0;
  for(const folder of a.data.folders){
    initializeFolder(folder);if(!folder.enabled||!projectLifecycle.isActive(a.data,folder.projectId))continue;
    try{const scan=newScan(a,folder,true);scan.collectionToken=collection.begin(a,'folder',folder);for(const entry of scan.entries)try{const buffer=readBuffer(folder,entry.name,50_000_000-scan.bytes);addBytes(scan,buffer);scan.checked++;const item=prepared(a,folder,entry.name,buffer,scan);if(item)scan.parsed.push({...item,document:textDocument(entry.name,buffer),buffer:undefined});}catch(error){scanError(scan,entry.name,error);if(error.scanLimit)break;}count+=commit(a,folder,scan);}catch(error){folderFailure(a,folder,error);}
  }
  return count;
}
async function syncAllFolders(a,{id,force=false}={}){
  if(a.operation)return 0;
  const folders=id?[byId(a,id)]:a.data.folders;
  const controller=new AbortController(),operation={label:'同步授权资料目录',startedAt:now()};a.controller=controller;a.operation=operation;
  const work=(async()=>{
    let count=0;
    for(const folder of folders){
      initializeFolder(folder);if(!projectLifecycle.isActive(a.data,folder.projectId)||!folder.enabled&&!force)continue;
      try{
        const scan=newScan(a,folder,false);scan.collectionToken=collection.begin(a,'folder',folder);
        for(const entry of scan.entries){
          controller.signal.throwIfAborted();
          try{
            const buffer=readBuffer(folder,entry.name,50_000_000-scan.bytes);addBytes(scan,buffer);scan.checked++;
            const item=prepared(a,folder,entry.name,buffer,scan);if(!item)continue;
            const document=textTypes.has(path.extname(entry.name).toLowerCase())?textDocument(entry.name,buffer):await documents.parse(entry.name,buffer,controller.signal);
            controller.signal.throwIfAborted();scan.parsed.push({...item,document,buffer:undefined});
          }catch(error){controller.signal.throwIfAborted();scanError(scan,entry.name,error);if(error.scanLimit)break;}
        }
        controller.signal.throwIfAborted();count+=commit(a,folder,scan);
      }catch(error){if(controller.signal.aborted)throw error;folderFailure(a,folder,error);}
    }
    return count;
  })();
  a.runPromise=work;
  try{return await work;}finally{if(a.operation===operation){a.operation=null;a.controller=null;}a.save();}
}
async function dispatch(a,action,input={}){
  a.ensureIdle();
  if(action==='folderSync'){await syncAllFolders(a,{id:input.id,force:!!input.id});return a.publicState();}
  const folder=byId(a,input.id);
  if(action==='folderConfigure'){
    const beforeCollection=structuredClone(folder);
    const projectId=input.projectId||null;if(projectId)projects.byId(a,projectId);
    if(typeof input.enabled!=='boolean')throw new Error('请明确选择是否自动同步');
    const name=input.name===undefined?folder.name:input.name;
    if(typeof name!=='string'||!name.trim()||name.length>100)throw new Error('目录名称须为 1–100 字符');
    Object.assign(folder,{name:name.trim(),projectId,enabled:input.enabled,health:input.enabled?'unchecked':'paused',error:'',warnings:[],configuredAt:now()});
    collection.configure(a,'folder',folder,{before:beforeCollection,trusted:true,command:action});
    a.event('资料目录设置已更新',`${folder.name}：${projectId?projects.byId(a,projectId).name:'独立材料'}，${folder.enabled?'自动同步':'已暂停'}。`);
  }else if(action==='folderToggle'){
    if(typeof input.enabled!=='boolean')throw new Error('同步开关格式无效');
    folder.enabled=input.enabled;folder.health=folder.enabled?'unchecked':'paused';
  }else if(action==='folderRemove'){
    const beforeData=structuredClone(a.data);
    for(const o of a.data.sourceObservations||[])if(o.resourceKey?.startsWith('file:'+folder.path+path.sep))observations.close(a,{observationId:o.observationId},'资料目录授权已撤回');
    a.data.folders=a.data.folders.filter(f=>f.id!==folder.id);
    require('./access-policy-store.cjs').grantLegacyDelta(a,beforeData,{trusted:true,actor:'user_command',command:action});
    a.event('已取消资料目录授权',`${folder.name||folder.path}：已保存的材料和历史保留。`);
  }else throw new Error('未知资料目录操作');
  a.save();return a.publicState();
}
module.exports={syncFolders,syncAllFolders,dispatch};
