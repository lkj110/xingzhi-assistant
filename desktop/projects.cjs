const crypto=require('node:crypto');
const observations=require('./source-observations.cjs');
const now=()=>new Date().toISOString();
const uid=()=>crypto.randomUUID();
const required=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}须为 1–${max} 字符`);return value.trim();};
const permissionKeys=['localTools','capabilityGrants','dataPlatform','folderIds','urls','allowWeb','outputFolder','githubRepo','fileMode','githubMode','githubUpdateMode','githubCommentMode','commentIntervalMinutes','maxComments','autoAccept'];
const mutableKeys=['goal','sourceIds','taskIds','feedback','watchers','summary','completedAt','followups'];
function initialize(a){a.data.projects ||= [];a.data.projectChanges ||= [];}
function byId(a,id){const project=a.data.projects.find(p=>p.id===id);if(!project)throw new Error('项目不存在');return project;}
function context(a,id){if(!id)return null;const p=byId(a,id);return {id:p.id,name:p.name,background:p.background,principle:'后续材料与要求继续关联已有事项。核对来源时间和冲突；矛盾事实保留来源并提出具体待确认项，不凭空覆盖。'};}
function job(a,project){return a.data.delegations.find(j=>j.id===project.jobId);}
function snapshot(a,project,label){
  const j=job(a,project);if(!j)return null;
  const record={id:uid(),projectId:project.id,label,at:now(),status:'applied',snapshot:{project:{name:project.name,background:project.background},job:Object.fromEntries(mutableKeys.map(k=>[k,structuredClone(j[k]??null)])),tasks:j.taskIds.map(id=>structuredClone(a.task(id))),actionIds:a.data.agentActions.filter(r=>r.jobId===j.id).map(r=>r.id)}};
  a.data.projectChanges.unshift(record);
  const older=a.data.projectChanges.filter(r=>r.projectId===project.id).slice(20);
  a.data.projectChanges=a.data.projectChanges.filter(r=>!older.includes(r));return record;
}
function relatedActions(a,j){
  const taskIds=new Set([...(j.taskIds||[]),...a.data.tasks.filter(t=>t.agentJobId===j.id).map(t=>t.id)]);
  return a.data.agentActions.filter(r=>r.jobId===j.id||r.id===j.pendingActionId||taskIds.has(r.taskId));
}
function assertSettled(a,j){
  if(relatedActions(a,j).some(r=>['uncertain','running'].includes(r.status)))throw new Error('外部执行结果尚未确认，请先处理待核对的外部动作');
}
function invalidateApproval(a,j){
  assertSettled(a,j);
  for(const r of relatedActions(a,j))if(r.status==='pending'){r.status='stale';delete r.approvedAt;}
  j.pendingActionId=null;
}
function wake(j){j.completedAt=null;j.failures=0;j.resumeWatching=false;if(j.status!=='paused')j.status='ready';j.nextRunAt=now();j.updatedAt=now();}
function ingest(a,project,{note='',checkpoint=true,explicitSourceIds=[]}={}){
  require('./project-lifecycle.cjs').assertActive(a.data,project.id);
  const j=job(a,project);if(!j)return;
  // Previously collected ancestors are history, not new evidence for this job.
  const projectSources=a.data.sources.filter(s=>s.projectId===project.id);
  const ancestors=new Set(projectSources.map(s=>s.previousSourceId).filter(Boolean));
  const additions=projectSources.filter(s=>!s.projectExcluded&&!j.sourceIds.includes(s.id)&&!ancestors.has(s.id)&&observations.allows(a,s,{channel:'project_ingest',scope:{projectId:project.id,jobId:j.id},explicitInput:explicitSourceIds.includes(s.id),eventId:explicitSourceIds.includes(s.id)?(s.explicitInputEventId||='attach:'+uid()):undefined})).reverse();
  if(!additions.length&&!note){require('./evidence-store.cjs').reconcile(a);return;}
  invalidateApproval(a,j);
  require('./work-rules.cjs').projectIngest(a,j,{note,additions:additions.length});
  const record=checkpoint?snapshot(a,project,note?'补充项目要求':`归并 ${additions.length} 份材料`):null;
  if(record){record.note=note;record.sourceIds=additions.map(s=>s.id);}
  if(note)require('./work-journal.cjs').recordJobFeedback(a,{id:j.id,requirementRevision:uid(),note});
  for(const source of additions){
    const versions=a.data.sources.filter(s=>j.sourceIds.includes(s.id)&&(source.identity?s.identity===source.identity:s.title===source.title&&s.origin===source.origin)&&s.id!==source.id);
    const previous=(source.previousSourceId?projectSources.find(s=>s.id===source.previousSourceId):null)||versions.filter(s=>!versions.some(next=>next.previousSourceId===s.id)).sort((x,y)=>(y.version||1)-(x.version||1)||y.createdAt.localeCompare(x.createdAt))[0];
    if(previous&&!source.previousSourceId){source.previousSourceId=previous.id;source.version=(previous.version||1)+1;}
    j.sourceIds.push(source.id);source.state='processed';source.processedAt=now();
    require('./agent-followup.cjs').invalidateEvidence(a,j,source);
    for(const id of j.taskIds){const task=a.task(id);if(!previous||!task.sourceIds.includes(previous.id)||task.agentCancelled)continue;
      task.sourceIds=[...new Set([...task.sourceIds,source.id])];task.supersededSourceIds=[...new Set([...(task.supersededSourceIds||[]),previous.id])];
      if(!source.deleted)require('./evidence-links.cjs').setInputs(a,task,task.sourceIds.filter(id=>!a.data.sources.find(s=>s.id===id)?.deleted),task.supersededSourceIds,{kind:explicitSourceIds.includes(source.id)?'explicit_input':'source_observation',observationId:source.observationId});
      task.needsReplan=`材料「${source.title}」更新至第 ${source.version} 版`;a.requeue(task);require('./agent-plan.cjs').invalidateDependents(a,task);
    }
  }
  const message=[note,additions.length?`项目新增材料：${additions.map(s=>s.title).join('、')}。先检查这些材料是否补充已有事项，沿用原事项标识；保留冲突并说明依据。`:''].filter(Boolean).join('\n');
  if(additions.length)j.feedback.push({at:now(),text:message.slice(note?note.length+1:0),origin:'source_update'});j.feedback=j.feedback.slice(-30);
  if(note)for(const id of j.taskIds){const t=a.task(id);if(t.agentCancelled)continue;t.needsReplan='项目收到新的要求，请核对已有计划';a.requeue(t);}
  wake(j);j.summary='项目收到新信息，将沿用已有事项继续推进';project.updatedAt=now();
  a.event('项目已归并新信息',`${project.name}：${additions.length} 份材料${note?'，含补充要求':''}`);
}
function compatible(existing,proposed){
  return permissionKeys.every(key=>key==='localTools'?JSON.stringify(require('./agent-local.cjs').settings(existing.localTools))===JSON.stringify(require('./agent-local.cjs').settings(proposed.localTools)):key==='dataPlatform'?(existing[key]||'off')===(proposed[key]||'off'):JSON.stringify(Array.isArray(existing[key])?[...existing[key]].sort():existing[key])===JSON.stringify(Array.isArray(proposed[key])?[...proposed[key]].sort():proposed[key]));
}
function createDelegation(a,input){
  const project=byId(a,input.projectId),agent=require('./agent.cjs');
  require('./project-lifecycle.cjs').assertActive(a.data,project.id);
  if(a.data.workRules.some(r=>r.config.projectId===project.id&&r.status!=='archived'))throw new Error('这个项目由工作规则推进，请在项目中补充要求或材料');
  a.ensureIdle({projectId:project.id,jobId:project.jobId});
  const proposed=agent.buildJob(a,input);let j=job(a,project);
  if(j){
    if(j.ruleId)throw new Error('这个项目由工作规则推进，请在项目中补充要求或材料');
    if(!compatible(j,proposed))throw new Error('项目已有委托，请沿用原授权配置；可在项目页补充要求');
    ingest(a,project,{note:required(input.goal,'补充要求',10000)});
  }else{
    j=proposed;project.jobId=j.id;a.data.delegations.unshift(j);ingest(a,project,{checkpoint:false});
    a.event('创建项目委托',project.name);
  }
  a.save();
  if(j.status==='paused')return a.publicState();
  return require('./execution.cjs').launch(a,{jobId:j.id},`Agent · ${project.name}`,view=>agent.run(view,j.id));
}
// Undo replays a bounded business command, never a saved task/workspace object.
// Lifecycle revisions, acceptance history, user edits and external effects stay
// under their own journals; only the selected plan and associations are reversed.
const undoHash=value=>require('./evidence-basis.cjs').hash(value);
const undoNoteKey=note=>undoHash({at:note.at,text:note.text});
const undoPick=(row,keys)=>Object.fromEntries(keys.filter(key=>row?.[key]!==undefined).map(key=>[key,structuredClone(row[key])]));
function undoNotes(target,event){
  const {noteEventIds=[],noteSequences=[],noteKeys=[],withdrawnRequirementId,requirementRevision}=event.payload;
  const keep=n=>n.eventId?!noteEventIds.includes(n.eventId):n.workSequence?!noteSequences.includes(n.workSequence):!noteKeys.includes(undoNoteKey(n));
  for(const key of ['feedback','notes','userDirectives'])if(Array.isArray(target[key]))target[key]=target[key].filter(keep);
  if(withdrawnRequirementId&&target.requirementRevision===withdrawnRequirementId)target.requirementRevision=requirementRevision;
}
function projectUndo(a,j,event){
  const p=event.payload,project=a.data.projects?.find(r=>r.id===p.projectId);
  if(!j||j.projectId!==p.projectId||!project||project.jobId!==j.id)return;
  Object.assign(project,structuredClone(p.project),{updatedAt:event.at});
  Object.assign(j,structuredClone(p.job));undoNotes(j,event);
  j.sourceIds=p.sourceIds.filter(id=>a.data.sources.some(s=>s.id===id&&s.projectId===project.id&&!require('./evidence-links.cjs').withdrawn(s)));
  j.taskIds=[...new Set([...j.taskIds,...p.taskIds])].filter(id=>a.data.tasks.some(t=>t.id===id&&t.agentJobId===j.id));
  for(const s of a.data.sources)if(s.projectId===project.id&&p.excludedSourceIds.includes(s.id))s.projectExcluded=true;
  for(const r of relatedActions(a,j))if(r.status==='pending'){r.status='stale';delete r.approvedAt;}
  require('./work-journal.cjs').clearSchedule(j);j.status='paused';j.nextRunAt=null;j.resumeWatching=false;j.retryCheck=false;j.verification=null;
  j.history ||= [];
  if(!j.history.some(r=>r.eventId===event.eventId))j.history.push({eventId:event.eventId,at:event.at,tool:'project_undo',result:{recordId:p.recordId,detail:'已恢复归并前的计划；外部交付与执行记录保留，恢复时必须重新核对'}});
  const rule=a.data.workRules?.find(r=>r.id===j.ruleId&&r.config?.projectId===project.id);
  if(rule&&rule.status!=='archived'){rule.status='paused';rule.summary='项目归并已撤销，等待恢复并核对';rule.nextRunAt=null;}
  a.data.projectChanges ||= [];
  let record=a.data.projectChanges.find(r=>r.id===p.recordId&&r.projectId===project.id);
  if(!record){record={id:p.recordId,projectId:project.id,label:p.label,at:p.recordAt};a.data.projectChanges.unshift(record);}
  record.status='undone';record.undoneAt=event.at;record.undoEventId=event.eventId;
}
function projectTaskUndo(a,t,event){
  const p=event.payload,j=a.data.delegations.find(r=>r.id===p.jobId);
  if(!t||t.deletedAt||t.trashRevision||t.agentJobId!==j?.id||t.projectId!==p.projectId||!j.taskIds.includes(t.id))return;
  undoNotes(t,event);
  if(p.cancel){t.agentCancelled=true;t.status='paused';t.cancelReason='撤销项目归并，历史记录保留';}
  else if(!t.agentCancelled){
    Object.assign(t,structuredClone(p.plan));t.planVersion=Math.max(t.planVersion||1,p.planVersion);
    const links=require('./evidence-links.cjs'),rows=links.bindings(a,t);
    const ids=p.sourceIds.filter(id=>j.sourceIds.includes(id)&&!rows.some(b=>b.sourceId===id&&b.purpose==='input'&&b.state==='withdrawn')&&!(t.contextWithdrawals||[]).some(w=>w.sourceId===id&&w.purpose==='input'));
    links.setInputs(a,t,ids,p.supersededSourceIds.filter(id=>ids.includes(id)),{kind:'project_undo',eventId:event.eventId});
    if(t.status==='paused')t.previousStatus='todo';else t.status='todo';
    t.needsReplan='已撤销项目归并，恢复推进前请核对计划与当前交付';
  }
  require('./work-journal.cjs').clearSchedule(t);t.verification=null;delete t.completionCheck;t.waitingOn='';t.nextCheckAt=null;
}
require('./work-journal.cjs').registerProjector('project_undone',projectUndo);
require('./work-journal.cjs').registerProjector('project_task_undone',projectTaskUndo);
function undo(a,project,record){
  const j=job(a,project);
  if(!j||!record?.snapshot||record.status!=='applied')throw new Error('此归并记录已撤销或不可恢复');
  if(a.data.projectChanges.find(r=>r.projectId===project.id&&r.status==='applied')?.id!==record.id)throw new Error('请先撤销最新一次归并');
  assertSettled(a,j);
  const journal=require('./work-journal.cjs'),links=require('./evidence-links.cjs'),log=journal.read(a).events,old=record.snapshot;
  const sourceIds=(old.job.sourceIds||[]).filter(id=>a.data.sources.some(s=>s.id===id&&s.projectId===project.id&&!links.withdrawn(s)));
  const excludedSourceIds=[...new Set([...j.sourceIds,...(record.sourceIds||[])])].filter(id=>!sourceIds.includes(id));
  // A project note is one explicit command. Match its durable identity, never
  // all later notes or all notes with the same text.
  const priorNoteSequence=Math.max(0,...(old.job.feedback||[]).map(n=>n.workSequence||0));
  const noteEvent=record.note&&log.find(e=>e.entityKind==='job'&&e.entityId===j.id&&e.sequence>priorNoteSequence&&e.at>=record.at&&e.payload?.note===record.note);
  const noteEvents=noteEvent?log.filter(e=>e.commitId===noteEvent.commitId):[];
  const notePayload=(target,kind)=>{
    const notes=noteEvents.filter(e=>e.entityKind===kind&&e.entityId===target.id&&e.payload?.note),legacy=kind==='job'?(target.feedback||[]).filter(n=>!(old.job.feedback||[]).some(o=>undoNoteKey(o)===undoNoteKey(n))&&(n.origin==='source_update'||!noteEvent&&record.note&&n.text===record.note)):[];
    return {noteEventIds:notes.map(e=>e.eventId),noteSequences:notes.map(e=>e.sequence),noteKeys:[...notes.map(e=>undoNoteKey({at:e.at,text:e.payload.note})),...legacy.map(undoNoteKey)],...(noteEvent?.payload?.requirementRevision?{withdrawnRequirementId:noteEvent.payload.requirementRevision,requirementRevision:uid()}:{})};
  };
  const protectedFields=(id,kind,saved)=>new Set(log.filter(e=>e.entityId===id&&e.entityKind===kind&&['user_edited','reopened'].includes(e.type)&&(saved?.workEvent?e.sequence>saved.workEvent.sequence:e.at>=record.at)).flatMap(e=>Object.keys(e.payload?.changes||{})));
  const events=[],begin=(target,kind)=>{
    let workRevision=target.workRevision??1;
    if(target.status==='completed'||target.acceptedAt){workRevision++;events.push({entityKind:kind,entityId:target.id,type:'reopened',actor:'user',workRevision,payload:{status:'paused'},basisRefs:{command:'projectUndo',recordId:record.id}});}
    return {entityKind:kind,entityId:target.id,actor:'user',workRevision,basisRefs:{command:'projectUndo',recordId:record.id}};
  };
  const jobPatch=undoPick(old.job,['goal','watchers','followups']);
  if(protectedFields(j.id,'job').has('goal')||j.executionContract)delete jobPatch.goal;
  if(typeof jobPatch.goal==='string')jobPatch.title=jobPatch.goal.split('\n')[0].slice(0,70);
  // Follow-up evidence/verification can contain entire external bodies. Keep
  // only the waiting contract and references; the resumed plan must recheck it.
  if(jobPatch.followups)jobPatch.followups=jobPatch.followups.map(f=>undoPick(f,['key','taskId','reason','expected','sourceIds','watchKeys','feedConnectionIds','respondentId','baselineIds','deadlineAt','checkAt','onTimeout','status','createdAt','sourceId','resolvedAt']));
  if(jobPatch.watchers)jobPatch.watchers=jobPatch.watchers.map(w=>undoPick(w,['key','sourceId','type','url','repo','number','folderId','fileName','operation','query']));
  const jobBase=begin(j,'job'),jobNotes=notePayload(j,'job');
  if(jobNotes.withdrawnRequirementId)events.push({...jobBase,type:'requirement_withdrawn',payload:{requirementId:jobNotes.withdrawnRequirementId}});
  events.push({...jobBase,type:'project_undone',payload:{projectId:project.id,project:undoPick(old.project,['name','background']),recordId:record.id,label:record.label,recordAt:record.at,job:jobPatch,sourceIds,excludedSourceIds,taskIds:[...new Set([...(old.job.taskIds||[]),...j.taskIds])],...jobNotes}});
  for(const t of a.data.tasks.filter(t=>t.agentJobId===j.id&&j.taskIds.includes(t.id)&&t.projectId===project.id&&!t.deletedAt&&!t.trashRevision)){
    const saved=old.tasks.find(s=>s.id===t.id),base=begin(t,'task'),rows=links.bindings(a,t),ids=saved?(saved.sourceIds||[]).filter(id=>sourceIds.includes(id)&&(!links.isDelivery(a.data.sources.find(s=>s.id===id))||saved.contextBindings?.some(b=>b.sourceId===id&&b.purpose==='input'&&b.state!=='withdrawn'&&b.provenance?.kind==='explicit_input'))):[];
    const removed=[...new Set(rows.filter(b=>!saved||excludedSourceIds.includes(b.sourceId)||b.purpose==='input'&&!ids.includes(b.sourceId)).map(b=>b.sourceId))];
    for(const id of removed){
      const purpose=!saved||excludedSourceIds.includes(id)?'all':'input';
      events.push(...links.withdrawalEvents(a,t,[id],{purpose,actor:'user',reason:'用户撤销项目归并',command:'projectUndo'}).map(e=>({...e,workRevision:base.workRevision})));
    }
    const notes=notePayload(t,'task');if(notes.withdrawnRequirementId)events.push({...base,type:'requirement_withdrawn',payload:{requirementId:notes.withdrawnRequirementId}});
    const protectedKeys=protectedFields(t.id,'task',saved),plan=undoPick(saved,['title','description','objective','criteria','priority','agentKey','dependsOn']);
    for(const key of protectedKeys)delete plan[key];
    if(saved)plan.steps=(saved.steps||[]).map(s=>undoPick(s,['id','key','title','kind','tool','done','artifactId']));
    events.push({...base,type:'project_task_undone',payload:{jobId:j.id,projectId:project.id,cancel:!saved,plan,planVersion:(t.planVersion||1)+1,sourceIds:ids,supersededSourceIds:saved?.supersededSourceIds||[],...notes}});
  }
  journal.commit(a,events);
  a.event('已撤销项目归并',`${project.name}：委托已暂停，历史产出与外部文件保留`);
}
async function dispatch(a,action,input){
  a.ensureIdle();
  if(action==='projectSave'){
    const name=required(input.name,'项目名称',100),background=String(input.background||'').trim().slice(0,10000);
    const existing=input.id?byId(a,input.id):null;
    if(existing)require('./project-lifecycle.cjs').assertActive(a.data,existing.id);
    if(existing){if(existing.background!==background)ingest(a,existing,{note:`项目背景已更新：${background||'无额外背景'}`});Object.assign(existing,{name,background,updatedAt:now()});}
    else a.data.projects.unshift({id:uid(),name,background,createdAt:now(),updatedAt:now(),jobId:null});
  }else{
    const p=byId(a,input.id);
    require('./project-lifecycle.cjs').assertActive(a.data,p.id);
    if(action==='projectFeedback'){if(!job(a,p))throw new Error('请先为项目创建 Agent 委托');ingest(a,p,{note:required(input.note,'补充要求',10000)});}
    else if(action==='projectUndo')undo(a,p,a.data.projectChanges.find(r=>r.id===input.changeId&&r.projectId===p.id));
    else if(action==='projectAttach'){
      if(!Array.isArray(input.sourceIds)||!input.sourceIds.length)throw new Error('请选择材料');
      const sources=input.sourceIds.map(id=>{const s=a.data.sources.find(s=>s.id===id);if(!s)throw new Error('材料不存在');return s;});
      const active=job(a,p);if(active)invalidateApproval(a,active);const attached=[];
      for(const s of sources){
        if(s.projectId===p.id&&s.purpose!=='delivery_readback'&&!s.deliveryActionId){delete s.projectExcluded;attached.push(s.id);continue;}
        let copy=a.data.sources.find(old=>old.projectId===p.id&&old.copiedFrom===s.id);
        if(!copy){copy={...structuredClone(s),id:uid(),projectId:p.id,agentJobId:null,copiedFrom:s.id,purpose:'input',copiedFromDeliveryActionId:s.deliveryActionId||null,state:'new',createdAt:now()};delete copy.deliveryActionId;delete copy.observationId;delete copy.observationResolutionEventId;a.data.sources.unshift(copy);}
        attached.push(copy.id);
      }
      ingest(a,p,{explicitSourceIds:attached});
    }else throw new Error('未知项目操作');
  }
  a.save();return a.publicState();
}
module.exports={initialize,byId,context,ingest,snapshot,job,compatible,createDelegation,dispatch,relatedActions,assertSettled};
