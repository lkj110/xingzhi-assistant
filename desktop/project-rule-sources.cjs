const crypto=require('node:crypto'),path=require('node:path');
const limits={history:2000,current:200,characters:10000000};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows=value=>Array.isArray(value)?value:[];
const channels=['feedConnectionId','webConnectionId','connectorId','folderId'];
function assertScope(config){
 if(!config||typeof config.projectId!=='string'||!config.projectId)throw Error('项目资料变化规则必须选择项目');
 if(['folderIds','urls'].some(k=>config[k]!==undefined&&(!Array.isArray(config[k])||config[k].length))||config.useGithub!==undefined&&config.useGithub!==false||config.filename!==undefined&&(typeof config.filename!=='string'||config.filename.trim()))throw Error('项目资料变化规则仅使用已入库材料，不能混用目录、网址、GitHub扫描或文件名筛选');
}
function family(s){
 const types=channels.filter(k=>s[k]!=null&&s[k]!=='');if(types.length>1||types.some(k=>typeof s[k]!=='string'))throw Error('项目资料的来源标识冲突，请核对后重试');
 const type=types[0]||'manual';
 if(s.identity!=null&&typeof s.identity!=='string')throw Error('项目资料来源标识无效');
 if(type==='feedConnectionId'&&(!s.feedEntryKey||typeof s.feedEntryKey!=='string'))throw Error('RSS项目资料缺少稳定条目标识');
 return JSON.stringify([type,s[type]||'',s.feedEntryKey||'',s.identity||'',type==='folderId'?s.fileName||'':'',!s.identity&&!types.length?s.title:'',!s.identity&&!types.length?s.origin||'':'']);
}
function generated(a,s){
 // An explicit user-attached copy is a new project input, even when the original
 // came from another delegation. Its history starts inside this project.
 if(s.copiedFrom)return false;
 if(s.agentJobId||String(s.origin||'').startsWith('Agent ·')||s.artifactId)return true;
 const file=s.folderId&&s.fileName?path.join(rows(a.data.folders).find(f=>f.id===s.folderId)?.path||'',s.fileName):null;
 return rows(a.data.agentActions).some(r=>r.tool==='write_file'&&[r.target,r.result?.path,r.result?.latestPath].filter(p=>typeof p==='string').some(p=>p===s.origin||p===file));
}
function current(a,config){
 assertScope(config);require('./project-lifecycle.cjs').assertActive(a.data,config.projectId);
 const all=rows(a.data.sources),selected=all.filter(s=>s.projectId===config.projectId&&!generated(a,s));
 if(selected.length>limits.history)throw Error('项目资料超过2000条历史版本，请缩小项目范围后重试');
 const map=new Map(),duplicates=new Set();for(const s of all){if(map.has(s.id))duplicates.add(s.id);else map.set(s.id,s);}
 const nodes=new Map(selected.map(s=>[s.id,s])),parents=new Map(),children=new Map(),families=new Map();
 for(const s of selected){if(typeof s.id!=='string'||!s.id||duplicates.has(s.id)||typeof s.title!=='string'||typeof s.content!=='string')throw Error('项目资料编号或正文无效，请核对后重试');families.set(s.id,family(s));}
 for(const s of selected){
  if(!s.previousSourceId)continue;
  const previous=map.get(s.previousSourceId);
  if(s.copiedFrom&&(!previous||previous.projectId!==config.projectId))continue;
  if(!previous||previous.projectId!==config.projectId||!nodes.has(previous.id)||families.get(previous.id)!==families.get(s.id))throw Error('项目资料版本链断开或指向其他项目/来源，请核对后重试');
  parents.set(s.id,previous.id);const childrenOf=children.get(previous.id)||[];childrenOf.push(s.id);children.set(previous.id,childrenOf);
  if(childrenOf.length>1)throw Error('项目资料版本链存在分支，请先核对当前版本');
 }
 const roots=new Map();for(const s of selected){const seen=new Set();let id=s.id;while(parents.has(id)){if(seen.has(id))throw Error('项目资料版本链存在循环，请先修复');seen.add(id);id=parents.get(id);}roots.set(s.id,id);}
 const active=selected.filter(s=>!children.has(s.id)&&!s.deleted&&!s.projectExcluded&&s.routing?.status!=='conflict');
 if(active.length>limits.current)throw Error('当前有效项目资料超过200份，请缩小项目范围');
 let chars=0;const records=active.map(s=>{chars+=s.title.length+s.content.length;if(chars>limits.characters)throw Error('当前项目资料正文超过1000万字符，请缩小项目范围');return {key:`project_source:${config.projectId}:${roots.get(s.id)}`,tool:'project_source',args:{projectId:config.projectId,sourceId:s.id},digest:hash([s.id,s.title,s.content]),title:s.title,result:{sourceId:s.id,title:s.title,content:s.content},sourceId:s.id};});
 return records.sort((a,b)=>a.key.localeCompare(b.key));
}
function scan(a,config){const records=current(a,config),keyword=String(config.keyword||'').normalize('NFKC').toLowerCase();return keyword?records.filter(r=>`${r.title}\n${r.result.content}`.normalize('NFKC').toLowerCase().includes(keyword)):records;}
function signature(a,config){return hash(scan(a,config).map(r=>[r.key,r.digest]));}
function inspect(a,project,job){
 const materialIds=new Set(rows(a.data.sources).filter(s=>s.projectId===project.id).map(s=>s.id));
 const tasks=rows(a.data.tasks).filter(t=>!t.agentCancelled&&(t.projectId===project.id||job&&t.agentJobId===job.id||rows(t.sourceIds).some(id=>materialIds.has(id))));
 for(const task of tasks){const owner=task.agentJobId?rows(a.data.delegations).find(j=>j.id===task.agentJobId):null;
  if(task.projectId&&task.projectId!==project.id||task.agentJobId&&!owner||owner&&rows(a.data.projects).some(p=>p.jobId===owner.id&&p.id!==project.id)||owner?.projectId&&owner.projectId!==project.id)throw Error('项目资料关联到其他项目或无效委托，请先核对事项归属');
 }
 const taskIds=new Set(tasks.map(t=>t.id)),jobIds=new Set([job?.id,...tasks.map(t=>t.agentJobId)].filter(Boolean)),pendingIds=new Set(rows(a.data.delegations).filter(j=>jobIds.has(j.id)).map(j=>j.pendingActionId).filter(Boolean));
 const actions=rows(a.data.agentActions).filter(r=>r.projectId===project.id||jobIds.has(r.jobId)||taskIds.has(r.taskId)||pendingIds.has(r.id));
 return {tasks,actions,held:actions.some(r=>['running','uncertain','pending'].includes(r.status))};
}
function apply(a,project,job,records,inspection){
 const old=job.projectRuleMaterials||{},next=Object.fromEntries(records.map(r=>[r.key,{sourceId:r.sourceId,digest:r.digest}]));
 const changedIds=new Set();for(const [key,previous]of Object.entries(old))if(!next[key]||next[key].digest!==previous.digest){changedIds.add(previous.sourceId);if(next[key])changedIds.add(next[key].sourceId);}
 // Include ancestors when a version arrived via another connector before this check.
 for(const r of records){let s=a.data.sources.find(s=>s.id===r.sourceId);const seen=new Set();while(s?.previousSourceId&&!seen.has(s.id)){seen.add(s.id);const previous=a.data.sources.find(p=>p.id===s.previousSourceId&&p.projectId===project.id);if(!previous)break;if(job.sourceIds.includes(previous.id)&&!job.sourceIds.includes(r.sourceId)){changedIds.add(previous.id);changedIds.add(r.sourceId);}s=previous;}}
 const byId=new Map(a.data.sources.map(s=>[s.id,s]));
 for(const r of records){if(!job.sourceIds.includes(r.sourceId))job.sourceIds.push(r.sourceId);const s=byId.get(r.sourceId);s.state='processed';s.processedAt ||= new Date().toISOString();}
 for(const task of inspection.tasks){if(!rows(task.sourceIds).some(id=>changedIds.has(id)))continue;
  const additions=records.filter(r=>changedIds.has(r.sourceId));for(const r of additions){let s=byId.get(r.sourceId),related=task.sourceIds.includes(s.id);const seen=new Set();while(!related&&s?.previousSourceId&&!seen.has(s.id)){seen.add(s.id);s=byId.get(s.previousSourceId);if(s?.projectId!==project.id)break;related=task.sourceIds.includes(s.id);}if(related&&!task.sourceIds.includes(r.sourceId))task.sourceIds.push(r.sourceId);}
  task.needsReplan='项目资料发生变化或撤回，请核对现有计划与产出';a.requeue(task);for(const step of task.steps)if(step.kind!=='external'){step.done=false;delete step.artifactId;delete step.evidence;}if(task.agentJobId)require('./agent-plan.cjs').invalidateDependents(a,task);else{for(const step of task.steps)if(step.kind!=='external'){step.done=false;delete step.artifactId;delete step.evidence;}if(task.status!=='paused')task.status='blocked';task.lastError=task.needsReplan;}
 }
 for(const id of changedIds)require('./agent-followup.cjs').invalidateEvidence(a,job,{previousSourceId:id});
 job.projectRuleMaterials=next;project.updatedAt=new Date().toISOString();
}
module.exports={assertScope,current,scan,signature,inspect,apply,limits};
