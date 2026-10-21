const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const now=()=>new Date().toISOString();
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
function atomic(file,text){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);require('./filesystem-platform.cjs').syncDirectory(path.dirname(file));}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
const terminal=row=>row?.status==='completed'||row?.status==='archived'||!!row?.deletedAt;
function validate(data){
  if(!data||data.version!==1||!data.settings||!['tasks','sources','providers','artifacts','events'].every(k=>Array.isArray(data[k])))throw new Error('工作空间或备份格式无效');
  for(const key of ['tasks','sources','providers','artifacts','projects','delegations','agentActions','memories','playbooks','webConnections','feedConnections','feedConnectionRuns','captureQueue','intakeRoutingRules','workRules','ruleRuns']){const rows=data[key]||[];if(!Array.isArray(rows)||rows.some(r=>!r||typeof r.id!=='string')||new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('工作空间存在无效或重复记录');}
  if(data.tasks.some(t=>!Array.isArray(t.steps)||!Array.isArray(t.sourceIds)))throw new Error('备份事项格式无效');
  for(const j of data.delegations||[])if(!Array.isArray(j.taskIds)||!Array.isArray(j.sourceIds)||j.taskIds.some(id=>!data.tasks.some(t=>t.id===id)))throw new Error('备份委托引用不完整');
  return data;
}
const maxBackupBytes=200_000_000;
function capacityFailure(workspaceBytes,backupBytes){return Object.assign(Error('候选工作空间或备份超过 200MB，本次本地结果未提交。'),{code:'LOCAL_RESULT_STORAGE',classificationBasis:'local_result_storage',diagnostics:{stage:'storage',reason:'storage_capacity',workspaceBytes,backupBytes,limitBytes:maxBackupBytes}});}
function capacity(data,reason='before-restore',at=now()){
 const count=require('./platform-storage-capacity.cjs').sizes;
 const sizes=count(data),workspaceBytes=sizes.pretty;
 const backupBytes=count({format:1,at,reason,checksum:'0'.repeat(64)}).compact+8+sizes.compact;
 if(workspaceBytes>maxBackupBytes||backupBytes>maxBackupBytes)throw capacityFailure(workspaceBytes,backupBytes);
 return {workspaceBytes,backupBytes,limitBytes:maxBackupBytes};
}
function storageSerialization(data,reason,at){
 const sizes=capacity(data,reason,at),body=JSON.stringify(data),checksum=digest(body);
 const prefix=JSON.stringify({format:1,at,reason,checksum}).slice(0,-1)+',"data":';
 return {...sizes,text:prefix+body+'}'};
}
// candidate is the COMPLETE post-transaction workspace, including source,
// ledger, ACL retention and acquisition receipt. It is never mutated or saved.
function assertStorageCapacity(a,candidate=a.data){return capacity(candidate);}
function validateArchives(data){
 const storage=require('./platform-result.cjs');
 for(const source of data.sources||[]){
  if(!source.platformSnapshot&&!source.platformArchive)continue;
  let snapshot;try{snapshot=JSON.parse(source.content);}catch{if(source.platformArchive)throw require('./platform-chunks.cjs').integrity('archive_invalid');continue;}
  if(snapshot?.platformResult||source.platformArchive||snapshot?.platformArchive)storage.restore(snapshot,source);
 }
 return data;
}
function directory(a){const dir=path.join(a.dir,'backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
function filename(a,id){if(typeof id!=='string'||!/^backup-[\dT_-]+-[a-f0-9]{8}\.json$/.test(id))throw new Error('备份 ID 无效');return path.join(directory(a),id);}
function read(a,id){const file=filename(a,id);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBackupBytes)throw new Error('备份文件无效或过大');const item=JSON.parse(fs.readFileSync(file,'utf8'));if(item.format!==1||digest(JSON.stringify(item.data))!==item.checksum)throw new Error('备份校验失败');validate(item.data);validateArchives(item.data);assertStorageCapacity(a,item.data);return item;}
function list(a){return fs.readdirSync(directory(a)).filter(n=>/^backup-.*\.json$/.test(n)).sort().reverse().map(id=>{try{const r=read(a,id);return {id,at:r.at,reason:r.reason,bytes:fs.statSync(filename(a,id)).size,tasks:r.data.tasks.length,sources:r.data.sources.length,projects:r.data.projects?.length||0};}catch{return {id,invalid:true};}});}
function create(a,reason='manual'){
  const at=now();capacity(a.data,reason,at);
  const data=structuredClone(a.data);validate(data);const id=`backup-${at.replace(/[:.Z]/g,'-')}-${crypto.randomBytes(4).toString('hex')}.json`;
  const serialized=storageSerialization(data,reason,at);validateArchives(data);
  atomic(filename(a,id),serialized.text);
  a.lastBackupAt=Date.now();
  const rows=list(a);for(const r of rows.filter(r=>!r.invalid).slice(30))fs.unlinkSync(filename(a,r.id));return id;
}
function pause(data,current=data){
  require('./local-tools.cjs').recover(data);
  const pauseIntent=new Map((current.delegations||[]).map(j=>[j.id,{status:j.status,rulePausedState:j.rulePausedState,projectRuleRecoveryHold:j.projectRuleRecoveryHold}]));
  require('./model-fallback.cjs').revoke(data,'restore');
  require('./model-routing.cjs').revoke(data,'restore');
  require('./stewardship.cjs').revokeResume(data);
  data.attentionRecords=[];
  require('./briefing-schedule.cjs').pause(data);
  data.settings.automatic=false;
  for(const c of data.capabilities||[]){c.enabled=false;c.revision=crypto.randomUUID();}
  for(const r of data.intakeRoutingRules||[])r.enabled=false;
  for(const c of data.webConnections||[]){c.enabled=false;c.nextRunAt=null;}
  require('./feeds.cjs').pauseAll({data});
  require('./capture.cjs').pause(data);
  if(data.stewardship)data.stewardship.paused=true;
  for(const c of data.connectors||[]){c.enabled=false;c.nextRunAt=null;if(c.sendPolicy)c.sendPolicy={...c.sendPolicy,mode:'off',revision:crypto.randomUUID()};}
  for(const r of data.workRules||[]){if(r.status!=='archived')r.status='paused';r.nextRunAt=null;r.waitingForJob=false;delete r.projectAuthorizedSignature;delete r.projectReauthorize;for(const key of ['fileMode','githubMode','githubUpdateMode','githubCommentMode'])if(r.config?.[key]==='auto')r.config[key]='ask';}
  for(const j of data.delegations||[]){if(!terminal(j)&&j.status!=='finalizing')j.status='paused';j.nextRunAt=null;j.resumeWatching=false;j.retryCheck=false;j.pendingActionId=null;
    j.larkCreatePolicies=[];
    for(const key of ['fileMode','githubMode','githubUpdateMode','githubCommentMode'])if(j[key]&&j[key]!=='off')j[key]='ask';
    if((data.workRules||[]).some(r=>r.id===j.ruleId&&r.config?.trigger==='project_changes')){j.projectRuleAwaitingTrigger=true;const live=pauseIntent.get(j.id);if(live?.status==='paused'&&!live.rulePausedState&&!live.projectRuleRecoveryHold)delete j.projectRuleRecoveryHold;else j.projectRuleRecoveryHold=true;}
    if(!terminal(j)&&j.status!=='finalizing')j.summary='工作空间已恢复，继续前请核对计划和外部交付。';}
  for(const t of data.tasks){if(t.status==='running')t.status='blocked';if(!terminal(t)&&t.agentJobId&&!t.agentCancelled)t.needsReplan='从备份恢复，请核对当前来源、计划和外部执行记录';}
  for(const r of data.agentActions||[]){
    if(r.status==='running')r.status='uncertain';
    if(r.status==='pending'){r.status='stale';delete r.approvedAt;}
    if(r.status==='uncertain'){delete r.approvedAt;const j=data.delegations?.find(j=>j.id===r.jobId);if(j&&!terminal(j))j.pendingActionId=r.id;
      data.recoveryReviews ||= [];if(!data.recoveryReviews.some(v=>v.actionId===r.id))data.recoveryReviews.push({id:'action:'+r.id,actionId:r.id,jobId:r.jobId,taskId:r.taskId,code:'EXTERNAL_EFFECT_UNCERTAIN',status:'open'});}
  }
  delete data.runtime?.interruptedJobId;
  data.runtime={...data.runtime,suspended:false,stewardshipRecoveryHold:true,recoveryAt:now(),recoveryNotice:'已恢复本地数据。自动收集与推进已暂停；外部文件和 GitHub 不会回滚，恢复后的写入需要逐项确认。'};
}
// Compatibility ledger only. action-facts.json owns new protocol outcomes.
// Stale workspace saves cannot downgrade a durable outcome or lose its receipt.
function mergeAction(old,next){
  if(!old)return structuredClone(next);
  const known=r=>['applied','not_applied'].includes(r.effectStatus)||r.status==='done';
  const identity=['jobId','taskId','tool','target','version','artifactId'];
  const resultConflict=known(old)&&known(next)&&['url','number','sourceId','hash','contentHash'].some(k=>old.result?.[k]!==undefined&&next.result?.[k]!==undefined&&old.result[k]!==next.result[k]);
  const conflict=old.recoveryConflict||next.recoveryConflict||resultConflict||identity.some(k=>old[k]!==undefined&&next[k]!==undefined&&old[k]!==next[k])||known(old)&&known(next)&&old.effectStatus&&next.effectStatus&&old.effectStatus!==next.effectStatus;
  const rank=r=>known(r)?5:r.status==='uncertain'?4:r.status==='running'?3:['rejected','stale','failed'].includes(r.status)?2:r.status==='pending'?1:0;
  const newerFact=(next.factSequence||0)>(old.factSequence||0);
  const winner=newerFact||rank(next)>rank(old)?next:old,other=winner===old?next:old;
  const merged={...structuredClone(other),...structuredClone(winner)};
  if(old.result||next.result)merged.result={...structuredClone(other.result||{}),...structuredClone(winner.result||{})};
  if(conflict){
    merged.status='uncertain';merged.presentationStatus='historical';merged.recoveryConflict=true;
    const observations=[...(old.recoveryObservations||[]),...(next.recoveryObservations||[]),old,next].map(r=>{const value=structuredClone(r);delete value.recoveryObservations;return value;});
    merged.recoveryObservations=[...new Map(observations.map(r=>[digest(JSON.stringify(r)),r])).values()];
  }
  return merged;
}
function mergeLedger(data,records){if(!Array.isArray(records))throw Error('动作账本格式无效');const map=new Map((data.agentActions||[]).map(r=>[r.id,r]));for(const r of records){if(!r||typeof r.id!=='string')throw Error('动作账本记录无效');map.set(r.id,mergeAction(map.get(r.id),r));}data.agentActions=[...map.values()];}
function loadLedger(a,data){try{mergeLedger(data,JSON.parse(fs.readFileSync(path.join(a.dir,'action-ledger.json'),'utf8')));}catch(error){if(error.code!=='ENOENT'){data.runtime ||= {};data.runtime.actionLedgerError='独立动作记录需核对，禁止重试外部写入';}}}
function retainLifecycle(current,restored){
  // Without an event log retain the current entity's known terminal/deletion
  // facts. Do not guess a reopen from timestamps or an older snapshot.
  for(const key of ['tasks','delegations'])for(const live of current[key]||[]){const row=restored[key]?.find(r=>r.id===live.id);if(!row)continue;
    if(terminal(live)||live.workRevision&&live.workRevision>(row.workRevision||1)||terminal(row)&&!terminal(live))Object.assign(row,structuredClone(live));
  }
  for(const key of ['sources','artifacts'])for(const live of current[key]||[]){const row=restored[key]?.find(r=>r.id===live.id);if(row&&(live.deleted||live.deletedAt||live.withdrawnAt||live.state==='withdrawn'))Object.assign(row,structuredClone(live));}
}
function reconcileAuthorities(a,data){
  const view=Object.assign(Object.create(a),{data});
  const journalPath=path.join(__dirname,'work-journal.cjs');
  if(fs.existsSync(journalPath)){
    const journal=require(journalPath);
    if(fs.existsSync(journal.file(view))||data.runtime?.workJournal?.appliedSequence)try{journal.replay(view,{force:true,save:false});}
    catch(error){data.runtime ||= {};data.runtime.workJournalError={code:error.code||'WORK_JOURNAL_INVALID',message:'工作记录无法核对，恢复保持暂停'};}
  }
  require('./access-policy-store.cjs').reconcile(view);
  require('./protocol-access.cjs').initialize(view);
  require('./source-observations.cjs').initialize(view);
  require('./action-facts.cjs').replay(view);
  // replay reports failures on the view; preserve them on the live execution gate.
  if(Object.hasOwn(view,'actionFactsError')&&view.actionFactsError){a.actionFactsError=view.actionFactsError;data.runtime.actionFactsError=view.actionFactsError;}
  else {delete a.actionFactsError;delete data.runtime.actionFactsError;}
  try{require('./source-observations.cjs').reclassify(view);}
  catch(error){data.runtime.sourceObservationError={message:error.message};a.actionFactsError ||= error.message;}
  // Outcomes and source observations may materialize retained objects after the
  // first policy projection. Apply current restrictions to every new source.
  require('./access-policy-store.cjs').reconcile(view);

  // Explicit source deletion survives every older mirror and late readback.
  require('./source-deletions.cjs').replay(view);
  for(const task of data.tasks||[])if(task.status==='completed'&&task.finalDelivery?.artifactId&&!data.artifacts.some(r=>r.id===task.finalDelivery.artifactId&&!r.deletedAt&&!r.deleted))task.recoveryReview={code:'ACCEPTED_DELIVERY_MISSING',message:'历史已验收，交付资料需核对'};
  return data;
}
function latestValidBackup(a){
  for(const id of fs.readdirSync(directory(a)).filter(n=>/^backup-.*\.json$/.test(n)).sort().reverse()){
    try{const item=read(a,id);return {id,at:item.at};}catch{}
  }
  return null;
}
function load(a,initial){
  const latest=latestValidBackup(a);
  a.lastBackupAt=Date.parse(latest?.at||'')||0;
  const exists=fs.existsSync(a.file);
  if(!exists&&!latest)return initial;
  try{if(!exists)throw new Error('workspace missing');return validate(JSON.parse(fs.readFileSync(a.file,'utf8')));}catch(error){
    if(!latest)throw new Error('工作空间损坏且没有有效备份，原文件已保留。');
    const data=read(a,latest.id).data;
    if(exists)fs.copyFileSync(a.file,path.join(a.dir,`workspace-damaged-${Date.now()}.json`));
    a.recoveryFromBackup=true;loadLedger(a,data);reconcileAuthorities(a,data);
    pause(data);require('./quick-capture.cjs').revoke(data);data.runtime.recoveredBackup=latest.id;return data;
  }
}
function afterSave(a){
  // Keep receipts outside rotating work snapshots so a restore cannot erase later writes.
  const file=path.join(a.dir,'action-ledger.json'),merged={agentActions:[]};
  if(fs.existsSync(file))mergeLedger(merged,JSON.parse(fs.readFileSync(file,'utf8')));
  mergeLedger(merged,a.data.agentActions||[]);
  const ledger=JSON.stringify(merged.agentActions);if(ledger!==a.lastLedger||!fs.existsSync(file)){atomic(file,ledger);a.lastLedger=ledger;}
  if(Date.now()-(a.lastBackupAt||0)>=3600000){try{create(a,'automatic');delete a.data.runtime?.backupError;}catch(error){a.data.runtime ||= {};a.data.runtime.backupError='自动备份失败，请检查磁盘空间和目录权限';}}
}
function restore(a,id){
  require('./access.cjs').cancel(a);
  a.ensureIdle();const item=read(a,id),current=a.data,restored=structuredClone(item.data);create(a,'before-restore');
  // Retain current credentials and grants; restoring work must not restore revoked access.
  restored.capabilities=structuredClone(current.capabilities||[]);restored.capabilityRuns=structuredClone(current.capabilityRuns||[]);
  restored.providers=current.providers;restored.folders=current.folders;restored.agentSettings=current.agentSettings;restored.settings.roles=current.settings.roles;
  require('./model-fallback.cjs').retain(current,restored);
  require('./model-routing.cjs').retain(current,restored);
  require('./quick-capture.cjs').retain(current,restored);
  for(const key of ['sources','artifacts','tasks','delegations']){restored[key] ||= [];for(const row of current[key]||[])if(!restored[key].some(r=>r.id===row.id))restored[key].push(structuredClone(row));}
  restored.sources.sort((x,y)=>(y.createdAt||'').localeCompare(x.createdAt||''));
  for(const t of restored.tasks){const j=restored.delegations.find(j=>j.id===t.agentJobId);if(j&&!j.taskIds.includes(t.id)){j.taskIds.push(t.id);if(!terminal(t)){t.agentCancelled=true;t.status='paused';t.cancelReason='恢复较早计划，后续新增事项保留供核对';}}}
  mergeLedger(restored,current.agentActions);
  loadLedger(a,restored);
  const grants=['dataPlatform','folderIds','allowWeb','urls','outputFolder','githubRepo','fileMode','githubMode','githubUpdateMode','githubCommentMode','commentIntervalMinutes','maxComments','autoAccept'];
  for(const j of restored.delegations){const live=current.delegations.find(r=>r.id===j.id);if(live){for(const key of grants)j[key]=structuredClone(live[key]);j.callsUsed=Math.max(j.callsUsed||0,live.callsUsed||0);j.usage=structuredClone(live.usage);}}
  for(const j of restored.delegations){const live=current.delegations.find(r=>r.id===j.id);j.documentGrants=structuredClone(live?.documentGrants||[]);j.larkCreateGrant=structuredClone(live?.larkCreateGrant);}
  // Rule configuration is current authorization, not historical task content.
  // Keep revoked scopes, archived rules and today's usage across a plan restore.
  restored.workRules=structuredClone(current.workRules||[]);
  restored.ruleRuns=structuredClone(current.ruleRuns||[]);
  for(const j of restored.delegations){
    const live=current.delegations.find(row=>row.id===j.id);
    if(live?.ruleId){for(const key of ['ruleId','ruleRevision','ruleName','goal','title','maxCalls','maxActions','intervalMinutes'])if(Object.hasOwn(live,key))j[key]=structuredClone(live[key]);}
  }
  restored.decisions=current.decisions||[];
  // Restoring task history must not resurrect a deleted preference or archived workflow.
  restored.memories=structuredClone(current.memories||[]);
  restored.playbooks=structuredClone(current.playbooks||[]);
  require('./memory.cjs').initialize({data:restored});
  require('./playbooks.cjs').initialize({data:restored});
  // Use current connection scopes, including revoked send grants, then pause them.
  restored.connectors=structuredClone(current.connectors||[]);
  restored.webConnections=structuredClone(current.webConnections||[]);
  restored.webConnectionRuns=structuredClone(current.webConnectionRuns||[]);
  require('./feeds.cjs').retain(current,restored);
  require('./capture.cjs').retain(current,restored);
  require('./intake-routing.cjs').retain(current,restored);
  require('./briefing-schedule.cjs').retain(current,restored);
  restored.spendMeter=structuredClone(a.spendLedger);
  restored.modelCalls=current.modelCalls;restored.agentRuns=current.agentRuns;
  for(const task of restored.tasks){const live=current.tasks.find(t=>t.id===task.id);if(live?.progressRuns)task.progressRuns=structuredClone(live.progressRuns);}
  require('./stewardship.cjs').retain(a,current,restored);
  // A later external write stays visible even if its project was created after the snapshot.
  restored.projects ||= [];for(const p of current.projects||[])if(!restored.projects.some(r=>r.id===p.id))restored.projects.push(structuredClone(p));
  require('./project-lifecycle.cjs').retain(current,restored);
  require('./project-setup.cjs').retain(restored,current);
  require('./task-trash.cjs').retain(current,restored);
  require('./requirements.cjs').retain(current,restored);
  restored.runtime={...restored.runtime,revision:current.runtime?.revision,commitId:current.runtime?.commitId,executionSchema:current.runtime?.executionSchema,executionMigration:current.runtime?.executionMigration};
  retainLifecycle(current,restored);reconcileAuthorities(a,restored);
  pause(restored,current);validate(restored);validateArchives(restored);assertStorageCapacity(a,restored);a.data=restored;
  require('./evidence-store.cjs').reconcile(a);
  a.event('工作空间已恢复',`备份时间：${item.at}。后续记录保留供核对；自动推进已暂停。`,null,'warning');a.save();return a.publicState();
}
async function dispatch(a,action,input){
  if(action==='backupList')return list(a);
  if(action==='backupPreview'){const r=read(a,input.id);return {id:input.id,at:r.at,reason:r.reason,tasks:r.data.tasks.length,sources:r.data.sources.length,projects:r.data.projects?.length||0,notice:'恢复备份中的计划和材料，保留较新的执行记录、产出和当前授权。外部交付不会回滚；所有自动工作将暂停，写入改为逐项确认。'};}
  a.ensureIdle();if(action==='backupCreate'){create(a);return list(a);}
  if(action==='backupRestore')return restore(a,input.id);
  throw new Error('未知备份操作');
}
module.exports={assertStorageCapacity,maxBackupBytes,read,validateArchives,load,afterSave,list,create,restore,dispatch,validate,pause,mergeLedger,reconcileAuthorities,retainLifecycle};
