// SOURCECHECK is local and deterministic. Observing a resource is not business progress.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {hash: digest, canonical} = require('./evidence-basis.cjs');
const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const rows = value => Array.isArray(value) ? value : [];
const clone = value => structuredClone(value);
const journal = require('./work-journal.cjs');
function initialize(a) { a.data.sourceObservations ||= []; a.data.sourceObservationEvents ||= []; a.data.decisions ||= []; }
function resourceKey(value) {
  if (typeof value !== 'string' || !value) return null;
  if (path.isAbsolute(value)) return 'file:' + path.resolve(value);
  try { const u = new URL(value); if (['http:', 'https:'].includes(u.protocol)) { u.hash = ''; return u.href.replace(/\/$/, ''); } } catch {}
  return value;
}
function principal(value) { return value == null || value === '' ? null : canonical(value); }
function same(a, b) { return digest(a) === digest(b); }
function scopeFor(a, source, options = {}) {
  const projectId = options.scope?.projectId ?? source.projectId ?? null;
  const jobId = options.scope?.jobId ?? source.agentJobId ?? rows(a.data.projects).find(p => p.id === projectId)?.jobId ?? null;
  return {projectId, jobId, taskId:options.scope?.taskId ?? source.taskId ?? null};
}
function descriptor(a, source, options = {}) {
  const scope = scopeFor(a, source, options);
  const key = resourceKey(source.resourceKey || source.url || source.remoteId || source.origin || source.identity || (source.id && 'source:' + source.id));
  const contentHash = typeof source.content === 'string' ? hash(source.content) : source.contentHash || source.fullContentHash || null;
  return {scope, resourceKey:key, principalScope:principal(source.principalScope ?? options.principalScope),
    remoteRevision:source.remoteRevision == null ? null : String(source.remoteRevision), contentHash,
    stableEventId:source.stableEventId || options.eventId || null, coverage:source.coverage ?? null};
}
function transitionEvent(a, previous, changed) {
  if(!previous)return null;
  if(changed)return 'after:'+previous.id;
  return rows(a.data.sourceObservations).find(o=>o.observationId===previous.observationId)?.stableEventId || previous.stableEventId || null;
}
function identity(d) {
  // Wall clock polling timestamps are never an identity. Separate projects and null-project jobs.
  return 'observation-' + digest([d.scope.projectId, d.scope.projectId ? null : d.scope.jobId, d.principalScope, d.resourceKey,
    d.remoteRevision, d.contentHash, d.stableEventId, d.coverage]);
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = file + '.' + crypto.randomUUID() + '.tmp'; let renamed = false;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file); renamed = true;
    const fdDir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); }
  } catch (error) { if (renamed) error.committed = true; throw error; }
  finally { if (!renamed) try { fs.unlinkSync(tmp); } catch {} }
}
function storeFile(a) { return a.dir && path.join(a.dir, 'source-observations.json'); }
function events(a) {
  initialize(a); const file = storeFile(a);
  if (!file || !fs.existsSync(file)) return a.data.sourceObservationEvents;
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (store.version !== 1 || !Array.isArray(store.events) || store.checksum !== digest(store.events)) throw Error('来源观察记录校验失败，请恢复本地分类记录');
  if (store.events.some((e,i) => e.sequence !== i + 1)) throw Error('来源观察事件顺序不完整');
  return store.events;
}
function saveBody(a, observationId, source) {
  const ref = {id:digest([observationId, source]), hash:typeof source.content === 'string' ? hash(source.content) : null};
  if (a.dir) atomic(path.join(a.dir, 'observation-content', ref.id + '.json'), source);
  else (a.observationContent ||= {})[ref.id] = clone(source);
  return ref;
}
function readBody(a, ref) {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.id)) return null;
  try { const source = a.dir ? JSON.parse(fs.readFileSync(path.join(a.dir, 'observation-content', ref.id + '.json'), 'utf8')) : a.observationContent?.[ref.id];
    return source && (!ref.hash || typeof source.content === 'string' && hash(source.content) === ref.hash) ? clone(source) : null;
  } catch { return null; }
}
function mayRestoreBody(a,o,source) {
  if(!a.requireContextAccessPolicy)return true;
  const policy=require('./access-policy-store.cjs');
  // Check the prospective object's recorded scope without loading its body or
  // creating a grant. A specific denial still overrides a collection grant.
  const metadata=source||{id:o.sourceId,agentJobId:o.scope.jobId,projectId:o.scope.projectId};
  const view=source?a:Object.assign(Object.create(a),{data:{...a.data,sources:[...rows(a.data.sources),metadata]}});
  // Retention belongs to the job before the new input is bound to any task.
  // A task-only scope is used only for observations without a delegation.
  return policy.check(view,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+metadata.id,
    ...(o.scope.jobId?{jobId:o.scope.jobId}:o.scope.taskId?{taskId:o.scope.taskId}:{})},operation:'local_retention'}).allowed===true;
}
function consumptionSnapshot(a,job) {
  return {job:clone(job),tasks:rows(a.data.tasks).filter(t=>t.agentJobId===job.id).map(clone),
    afterWorkSequence:(a.dir||a.workJournalFile)?journal.read(a).events.length:0};
}
function changedFields(before,after) {
  const set={},unset=[];
  for(const key of new Set([...Object.keys(before),...Object.keys(after)])) {
    if(['workEvent','workRevision','projectionPending'].includes(key)||same(before[key],after[key]))continue;
    if(after[key]===undefined)unset.push(key);else set[key]=clone(after[key]);
  }
  return {set,unset};
}
function reopenConsumedInput(a,o,job,before) {
  if(!a.dir&&!a.workJournalFile)return before.afterWorkSequence;
  const commitId='source-reopen-'+digest([o.observationId,o.sourceId,o.userPurposeEventId]);
  const log=journal.read(a),saved=log.events.filter(e=>e.commitId===commitId);
  let receipt=saved.length?{committed:true,commitId,sequence:saved.at(-1).sequence,events:saved}:null;
  if(!receipt&&!rows(before.job.sourceIds).includes(o.sourceId)){
    const active=row=>row&&!row.deletedAt&&!row.agentCancelled&&!['completed','archived'].includes(row.status);
    const revision=row=>row.workRevision??1;
    const tasks=before.tasks.map(old=>({old,current:rows(a.data.tasks).find(t=>t.id===old.id&&t.agentJobId===job.id),kind:'task'}))
      .filter(({old,current})=>(old.status==='completed'||old.acceptedAt)&&active(current)&&revision(old)===revision(current));
    const targets=[...tasks];
    if(active(job)&&revision(before.job)===revision(job)&&(tasks.length||['completed','finalizing','watching'].includes(before.job.status)||before.job.acceptedAt))targets.push({old:before.job,current:job,kind:'job'});
    if(targets.length)receipt=journal.append(a,targets.map(({old,current,kind})=>({type:'reopened',entityKind:kind,entityId:current.id,
      actor:'source',workRevision:revision(old)+1,payload:{status:current.status},
      basisRefs:{observationId:o.observationId,resolutionEventId:o.resolutionEventId,sourceId:o.sourceId}})),{commitId});
  }
  // Project a durable retry without creating another revision. The following
  // consumption delta must follow these reopens, including any earlier batch member.
  if(receipt)journal.project(a,receipt);
  return journal.read(a).events.length;
}
function consume(a,o,job,before) {
  if(o.inputConsumption||!rows(job.sourceIds).includes(o.sourceId))return;
  const afterWorkSequence=reopenConsumedInput(a,o,job,before);
  const inputConsumption={id:'consumed:'+digest([o.observationId,o.sourceId,o.userPurposeEventId]),jobId:job.id,
    observationSequence:events(a).length+1,afterWorkSequence,job:changedFields(before.job,job),tasks:before.tasks.map(t=>{
      const current=rows(a.data.tasks).find(v=>v.id===t.id);return current?{id:t.id,...changedFields(t,current)}:null;
    }).filter(Boolean)};
  commit(a,{...o,inputConsumption});
}
function projectConsumption(a,consumed) {
  const apply=(target,patch)=>{
    // A later lifecycle/explicit-edit fact wins even when a lost mirror is
    // appended during repair. Replaying consumption never creates a reopen.
    if(!target||target.deletedAt||(target.workEvent?.sequence||0)>consumed.afterWorkSequence)return;
    Object.assign(target,clone(patch.set));for(const key of patch.unset)delete target[key];
  };
  apply(rows(a.data.delegations).find(j=>j.id===consumed.jobId),consumed.job);
  for(const patch of consumed.tasks)apply(rows(a.data.tasks).find(t=>t.id===patch.id&&t.agentJobId===consumed.jobId),patch);
}
function actionFacts(a) {
  const facts = new Map(rows(a.data.agentActions).map(r => [r.id, r]));
  // The durable outcome can precede its workspace projection.
  for (const e of require('./action-facts.cjs').load(a).events) {
    const old = facts.get(e.actionId) || e.record;
    if (e.kind === 'outcome') facts.set(e.actionId, {...old, ...e.record, id:e.actionId, status:'done', effectStatus:'applied', result:{...e.detail.result, readbackHash:e.detail.contentRef?.hash || e.detail.result?.readbackHash || e.detail.discardedContentHash}, factEventId:e.eventId, factSequence:e.sequence});
    else if(e.kind==='not_applied')facts.set(e.actionId,{...old,...e.record,id:e.actionId,status:'failed',effectStatus:'not_applied',factEventId:e.eventId,factSequence:e.sequence});
    else if (!facts.has(e.actionId)) facts.set(e.actionId, {...e.record, id:e.actionId, status:'uncertain'});
  }
  return [...facts.values()];
}
function actionResources(r) { return [r.resourceKey, r.result?.url, r.result?.path, r.result?.latestPath, r.target,
  r.latestName && r.target && path.join(path.dirname(r.target), r.latestName)].filter(Boolean).map(resourceKey); }
function actionScope(a, r) { return r.projectId ?? rows(a.data.delegations).find(j => j.id === r.jobId)?.projectId ?? null; }
function candidate(a, o, r) {
  if(r.effectStatus==='not_applied')return false;
  const unacknowledgedCreate=r.tool==='lark_create'&&['pending','running','uncertain'].includes(r.status)&&!r.result?.url&&/^https:\/\/[^/]+\/(docx|wiki)\//.test(o.resourceKey||'');
  if ((!actionResources(r).includes(o.resourceKey)&&!unacknowledgedCreate) || actionScope(a, r) !== o.scope.projectId) return false;
  if (!o.scope.projectId && o.scope.jobId && r.jobId !== o.scope.jobId) return false;
  const p = principal(r.principalScope ?? r.larkOpenId ?? (r.tool === 'write_file' ? 'local' : null));
  return !p || !o.principalScope || same(p, o.principalScope);
}
function fact(a, r, o) {
  const readback = rows(a.data.sources).find(s => s.deliveryActionId === r.id || s.id === r.result?.sourceId);
  const p = principal(r.principalScope ?? r.larkOpenId ?? readback?.principalScope ?? (r.tool === 'write_file' ? 'local' : null));
  const latestFile = resourceKey(r.result?.latestPath) === o.resourceKey;
  const receiptHash=r.result?.readbackHash || (latestFile ? r.result?.latestHash : r.result?.hash) || (readback?.content != null ? hash(readback.content) : null);
  return {id:r.id, principalScope:p, confirmed:r.status === 'done' && (r.effectStatus === 'applied' || r.result?.verified===true && !!receiptHash),
    revision:r.result?.revision == null ? readback?.remoteRevision == null ? null : String(readback.remoteRevision) : String(r.result.revision),
    hash:receiptHash,
    coverage:readback?.coverage ?? null, taskId:r.taskId, jobId:r.jobId, factEventId:r.factEventId || null,
    receiptBasis:digest([r.tool,r.result,r.desired,r.baseline])};
}
function githubDecision(a,o,actions) {
  if(!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(o.resourceKey||''))return null;
  let actual;try{actual=JSON.parse(readBody(a,o.contentRef)?.content);}catch{return null;}
  const [,repo,number]=o.resourceKey.match(/^https:\/\/github\.com\/(.+\/[^/]+)\/issues\/(\d+)$/)||[];
  if(!repo||actual.number!==Number(number)||resourceKey(actual.url)!==o.resourceKey)return null;
  const verified=actions.filter(r=>r.status==='done'&&r.result?.verified===true&&r.target===repo&&(r.number||r.result?.number)===actual.number&&r.jobId===o.scope.jobId&&
    (!r.principalScope&&!o.principalScope||same(principal(r.principalScope),o.principalScope)));
  if(!verified.length)return null;
  const complete=v=>v.coverage==='complete'||v.commentsTruncated===false&&v.bodyTruncated===false;
  if(!complete(actual))return {state:'pending',reason:'GitHub 回读未完整覆盖正文或评论，不能认领为自身更新'};
  const normalize=v=>({title:v.title,state:v.state,bodyHash:v.bodyHash||hash(v.body||''),comments:v.commentFingerprints||(v.comments||[]).map(c=>({id:c.id,author:c.author,contentHash:c.contentHash||hash(c.body||'')}))});
  let previous;
  for(const s of rows(a.data.sources))if((s.projectId||null)===o.scope.projectId&&(!o.scope.projectId?s.agentJobId===o.scope.jobId:true)&&resourceKey(s.resourceKey||s.url)===o.resourceKey&&s.id!==o.sourceId)try{const v=JSON.parse(s.content);if(complete(v)){previous=v;break;}}catch{}
  const writes=verified.filter(r=>['github_update','github_create'].includes(r.tool)),write=writes.at(-1);
  const original=previous&&normalize(previous),current=normalize(actual);
  const ownComments=new Map(verified.filter(r=>r.tool==='github_comment'&&r.result.commentId&&typeof r.result.body==='string').map(r=>[r.result.commentId,hash(r.result.body)]));
  const strip=comments=>comments.filter(c=>ownComments.get(c.id)!==c.contentHash);
  const expected=original?{...original,comments:strip(original.comments)}:write?{title:write.result.title,state:write.result.state,bodyHash:hash(write.result.body||''),comments:[]}:null;
  if(!expected)return {state:'pending',reason:'缺少 GitHub 原版完整依据，无法证明仅新增自身评论'};
  if(write){for(const field of ['title','state'])if(typeof write.result[field]==='string')expected[field]=write.result[field];if(typeof write.result.body==='string'&&write.result.body.length<25000)expected.bodyHash=hash(write.result.body);else if(write.desired?.body!==undefined)expected.bodyHash=hash(write.desired.body);else if(!original)return {state:'pending',reason:'GitHub 旧回执正文不完整，需核对完整内容'};}
  if(!['title','state','bodyHash'].every(k=>expected[k]===current[k]))return {state:'resolved_conflict',reason:'GitHub 已交付正文或状态存在外部修改',actionId:write?.id||verified[0].id};
  if(!same(strip(current.comments),expected.comments))return {state:'resolved_input',reason:'GitHub 收到自身已确认写入之外的新评论或评论修改'};
  return {state:'resolved_observation',reason:'GitHub 完整回读仅含本委托已核对的更新或评论',actionId:write?.id||verified[0].id};
}
function classify(a, o) {
  if (o.state === 'closed') return {state:'closed', reason:o.closeReason, basis:o.lastEvaluatedBasis, candidateActionIds:o.candidateActionIds || []};
  const actions=actionFacts(a).filter(r=>candidate(a,o,r)),candidates=actions.map(r => fact(a,r,o));
  const basis = digest([o.scope,o.principalScope,o.resourceKey,o.remoteRevision,o.contentHash,o.coverage,o.explicitInput,o.trustedInput,o.userPurpose,o.userPurposeEventId,candidates]);
  const result = (state, reason, extra = {}) => ({state, reason, basis, candidateActionIds:candidates.map(r=>r.id), ...extra});
  if (o.explicitInput) return result('resolved_input', '用户明确指定为新材料或提出修改要求');
  if (o.userPurpose==='observation') return result('resolved_observation','用户指定仅保留观察');
  if (!o.resourceKey || !o.contentHash) return result('pending', '资源身份或完整正文指纹缺失，需要核对来源用途');
  const github=githubDecision(a,o,actions);if(github&&!actions.some(r=>['running','uncertain'].includes(r.status)))return result(github.state,github.reason,github);
  const confirmed = candidates.filter(r => r.confirmed && r.principalScope && o.principalScope && same(r.principalScope,o.principalScope) && r.hash && same(r.coverage,o.coverage));
  const exact = confirmed.filter(r=>r.hash === o.contentHash && (!o.remoteRevision || !r.revision || r.revision === o.remoteRevision));
  if (exact.length === 1 && !candidates.some(r=>!r.confirmed)) return result('resolved_observation', '自身已确认的交付版本', {actionId:exact[0].id});
  if (exact.length > 1) return result('pending', '多个动作对应同一版本，需核对原动作归属');
  if (candidates.some(r=>!r.confirmed)) return result('pending', '同一资源的外部动作结果尚未核对，等待原动作回执');
  if (confirmed.length) {
    const numeric = value => typeof value === 'string' && /^\d+$/.test(value);
    const newer = confirmed.filter(r=>numeric(r.revision) && numeric(o.remoteRevision) && BigInt(r.revision)>BigInt(o.remoteRevision));
    if (newer.length) return result('resolved_observation','乱序旧版本，仅保留历史观察',{historical:true});
    if (confirmed.some(r=>r.hash === o.contentHash)) return result('resolved_observation','新远端版本没有实质内容或范围变化');
    if (confirmed.length === 1) return result('resolved_conflict','已交付目标存在实际差异，需要独立核对',{actionId:confirmed[0].id,taskId:confirmed[0].taskId});
    return result('pending','多个已确认动作对应此资源，需核对差异所属交付');
  }
  if (candidates.length) return result('pending','该资源可能来自自身交付，但账号、完整正文或版本依据不足');
  if (o.trustedInput) return result('resolved_input','已配置的业务来源，未关联本范围的自身写入');
  return result('pending','尚未明确这份资源的用途，请选择作为新材料、核对交付或忽略');
}
function project(a, event) {
  initialize(a); const next = clone(event.observation);
  let o = a.data.sourceObservations.find(o=>o.observationId===next.observationId);
  if (o?.eventSequence >= event.sequence) return o;
  const consumptionChanged=next.inputConsumption&&o?.inputConsumption?.id!==next.inputConsumption.id;
  if (o) Object.assign(o,next); else {o=next;a.data.sourceObservations.push(o);}
  o.eventSequence=event.sequence;
  if(consumptionChanged)projectConsumption(a,next.inputConsumption);
  const decision = a.data.decisions.find(d=>d.id===o.decisionId);
  if (o.state === 'pending' || o.state === 'resolved_conflict') {
    const fields = {id:o.decisionId,kind:'source_classification',observationId:o.observationId,jobId:o.scope.jobId,projectId:o.scope.projectId,
      status:'open',taskIds:o.scope.taskId?[o.scope.taskId]:[],sourceIds:[],question:`核对来源「${o.title || o.resourceKey}」的用途`,
      context:o.reason,resourceKey:o.resourceKey,principalScope:o.principalScope,createdAt:o.createdAt,updatedAt:o.evaluatedAt,
      choices:['input','observation','ignore'],classificationOnly:true,blocking:false,blockingTaskIds:o.scope.taskId?[o.scope.taskId]:[]};
    if (decision) Object.assign(decision,fields); else a.data.decisions.push(fields);
  } else if (decision) Object.assign(decision,{status:o.state==='closed'?'closed':'resolved',answer:o.reason,answeredAt:o.evaluatedAt});
  if (o.state === 'resolved_conflict' && o.actionId) {
    const r=rows(a.data.agentActions).find(r=>r.id===o.actionId);
    if(r){r.deliveryConflict={observationId:o.observationId,resolutionEventId:o.resolutionEventId,reason:o.reason};r.presentationStatus='historical';}
  }
  return o;
}
journal.registerProjector('source_observation', (a,target,event) => {
  const observationEvent=event.payload.observationEvent;
  project(a,observationEvent);
  const consumed=observationEvent.observation.inputConsumption;
  // Forced lifecycle replay also needs this delta when observation metadata was
  // already projected in the restored snapshot. Only its original event applies it.
  if(consumed?.observationSequence===observationEvent.sequence)projectConsumption(a,consumed);
});
function commit(a, observation) {
  const all=events(a),eventId='source-event-'+digest([observation.observationId,observation.lastEvaluatedBasis,observation.state,observation.channels,observation.closeReason,observation.sourceId,...(observation.inputConsumption?[observation.inputConsumption]:[])]);
  let event=all.find(e=>e.eventId===eventId);
  if(!event){const prior=all.findLast(e=>e.observation.observationId===observation.observationId)?.observation;
    const resolutionEventId=observation.state==='pending'?null:prior?.state===observation.state&&prior?.lastEvaluatedBasis===observation.lastEvaluatedBasis?prior.resolutionEventId:eventId;
    event={eventId,sequence:all.length+1,observation:{...clone(observation),resolutionEventId}};
    all.push(event);if(storeFile(a))atomic(storeFile(a),{version:1,events:all,checksum:digest(all)});
  }
  a.data.sourceObservationEvents=all;
  const job=rows(a.data.delegations).find(j=>j.id===observation.scope.jobId);
  if(job&&(a.dir||a.workJournalFile)){
    const receipt=journal.append(a,[{type:'source_observation',entityKind:'job',entityId:job.id,actor:'source',payload:{observationEvent:event}}],{commitId:eventId});
    // Classification alone changes no lifecycle state; a consumed input carries
    // only its already-applied local delta for recovery in causal order.
    project(a,event);a.data.runtime ||= {};a.data.runtime.sourceObservationCommit=receipt.commitId;
  } else project(a,event);
  return a.data.sourceObservations.find(o=>o.observationId===observation.observationId);
}
function result(o) { return {observation:o,state:o.state,allowInput:o.state==='resolved_input',sourceId:o.sourceId,observationId:o.observationId,resolutionEventId:o.resolutionEventId}; }
function observe(a, source, options = {}) {
  initialize(a); const d=descriptor(a,source,options);let id=identity(d);
  let old=a.data.sourceObservations.find(o=>o.observationId===id);
  if(!old) { const saved=events(a).findLast(e=>e.observation.observationId===id);if(saved)old=project(a,saved); }
  if(old?.state==='closed'&&options.explicitInput){
    if(!options.eventId)throw Error('重新关联已关闭来源需要稳定用户事件 ID');
    id='observation-'+digest([id,'explicit_input',options.eventId]);old=a.data.sourceObservations.find(o=>o.observationId===id);
  }
  const existing=rows(a.data.sources).find(s=>(s.projectId||null)===d.scope.projectId&&(!d.scope.jobId||d.scope.projectId||s.agentJobId===d.scope.jobId)&&resourceKey(s.resourceKey||s.url||s.remoteId||s.origin||s.identity)===d.resourceKey&&same(principal(s.principalScope),d.principalScope)&&typeof s.content==='string'&&hash(s.content)===d.contentHash&&(s.remoteRevision==null?null:String(s.remoteRevision))===d.remoteRevision&&!s.deleted&&!s.projectExcluded&&!rows(a.data.sources).some(n=>n.previousSourceId===s.id));
  const o={...old,...d,observationId:id,sourceId:old?.sourceId||source.id||existing?.id||'source-'+digest(id),title:source.title||d.resourceKey,
    channels:[...new Set([...(old?.channels||[]),options.channel||'source'])].sort(),createdAt:old?.createdAt||now(),
    explicitInput:old?.explicitInput||options.explicitInput===true,trustedInput:old?.trustedInput||options.trustedInput===true,
    decisionId:old?.decisionId||'source-decision-'+digest(id)};
  if(options.explicitInput&&options.eventId)o.userPurposeEventId=options.eventId;
  if(!o.contentRef)o.contentRef=saveBody(a,id,{...source,id:o.sourceId,resourceKey:d.resourceKey,principalScope:d.principalScope});
  if(source.deleted||source.projectExcluded){o.state='closed';o.closeReason=source.deleted?'资源已删除':'资源已撤回';}
  const decision=classify(a,o);
  if(old&&old.lastEvaluatedBasis===decision.basis&&same(old.channels,o.channels)&&old.state===decision.state)return result(old);
  Object.assign(o,decision,{lastEvaluatedBasis:decision.basis,evaluatedAt:now()});
  return result(commit(a,o));
}
function allows(a,source,options={}) {
  if(source.projectExcluded)return false;
  if(source.deleted)return source.purpose==='withdrawal';
  const existing=source.observationId&&rows(a.data.sourceObservations).find(o=>o.observationId===source.observationId);
  if(existing&&!options.explicitInput)return existing.state==='resolved_input';
  if(source.purpose==='delivery_readback'&&!options.explicitInput) {observe(a,source,{...options,channel:options.channel||'delivery_readback'});return false;}
  const checked=observe(a,source,{trustedInput:true,...options});
  if(options.explicitInput&&checked.allowInput)link(a,source,checked);
  return checked.allowInput;
}
function attach(a,source,checked) {
  if(!checked.allowInput)return null;
  const old=rows(a.data.sources).find(s=>s.id===checked.sourceId)||rows(a.data.sources).find(s=>s.observationId===checked.observationId&&!(checked.observation.explicitInput&&s.purpose==='delivery_readback'));
  if(old)return old;
  const scope=checked.observation.scope;
  const previous=rows(a.data.sources).find(s=>(s.projectId||null)===scope.projectId&&(scope.projectId||!scope.jobId||s.agentJobId===scope.jobId||rows(a.data.delegations).find(j=>j.id===scope.jobId)?.sourceIds?.includes(s.id))&&resourceKey(s.resourceKey)===checked.observation.resourceKey&&same(principal(s.principalScope),checked.observation.principalScope)&&!rows(a.data.sources).some(n=>n.previousSourceId===s.id));
  Object.assign(source,{hash:typeof source.content==='string'?hash(source.content):source.hash,format:source.format||'txt',segments:source.segments||require('./documents.cjs').paragraphs(source.content||''),warnings:source.warnings||[],state:source.state||'new',createdAt:source.createdAt||now(),processedAt:source.processedAt||null,version:source.version||((previous?.version||0)+1),...(previous&&!source.previousSourceId?{previousSourceId:previous.id}:{}),id:checked.sourceId,observationId:checked.observationId,observationResolutionEventId:checked.resolutionEventId});
  a.data.sources.unshift(source);return source;
}
function link(a,source,checked) {
  const o=checked.observation||rows(a.data.sourceObservations).find(o=>o.observationId===(checked.observationId||checked));
  if(!o||!source?.id||!rows(a.data.sources).some(s=>s===source)||o.scope.projectId!==(source.projectId||null))throw Error('观察与已保存材料的范围不一致');
  if(o.scope.projectId===null&&o.scope.jobId&&source.agentJobId!==o.scope.jobId&&
    (source.agentJobId||!rows(a.data.delegations).find(j=>j.id===o.scope.jobId)?.sourceIds?.includes(source.id)))throw Error('不能把独立委托的观察关联到其他委托');
  source.observationId=o.observationId;source.observationResolutionEventId=o.resolutionEventId;
  if(o.sourceId!==source.id)commit(a,{...o,sourceId:source.id});
  return source;
}
function close(a,selector,reason='用户明确忽略', {deleteContent=false}={}) {
  initialize(a); const matches=o=>Object.entries(selector).every(([key,value])=>key==='scope'?Object.entries(value).every(([k,v])=>o.scope[k]===v):key==='sourceId'?o.sourceId===value:key==='resourceKey'?o.resourceKey===resourceKey(value):o[key]===value);
  const closed=[];
  for(const o of [...a.data.sourceObservations].filter(matches)) {
    if(o.state==='closed'){if(deleteContent&&o.contentRef){if(a.dir)fs.rmSync(path.join(a.dir,'observation-content',o.contentRef.id+'.json'),{force:true});else delete a.observationContent?.[o.contentRef.id];}continue;}
    const next={...o,state:'closed',closeReason:reason,reason,lastEvaluatedBasis:digest([o.lastEvaluatedBasis,'closed',reason]),evaluatedAt:now()};
    closed.push(commit(a,next));
    if(deleteContent&&o.contentRef){if(a.dir)fs.rmSync(path.join(a.dir,'observation-content',o.contentRef.id+'.json'),{force:true});else delete a.observationContent?.[o.contentRef.id];}
  }
  return closed;
}
function resolve(a,observationId,{purpose,eventId,reason}={}) {
  initialize(a); const o=a.data.sourceObservations.find(o=>o.observationId===observationId);if(!o)throw Error('待判定来源不存在');
  if(purpose==='ignore'){
    if(o.state==='closed')return o;
    return commit(a,{...o,state:'closed',userPurpose:purpose,userPurposeEventId:eventId||'user-ignore:'+observationId,closeReason:reason||'用户明确忽略',reason:reason||'用户明确忽略',lastEvaluatedBasis:digest([o.lastEvaluatedBasis,'ignore',eventId]),evaluatedAt:now()});
  }
  if(o.state==='closed')throw Error('该来源已关闭，请明确重新导入材料');
  if(purpose==='observation'){const next={...o,explicitInput:false,userPurpose:purpose,userPurposeEventId:eventId||'user-observation:'+observationId},decision=classify(a,next);return commit(a,{...next,...decision,lastEvaluatedBasis:decision.basis,evaluatedAt:now()});}
  if(purpose!=='input'||!eventId)throw Error('请提供明确的新材料用途及稳定用户事件 ID');
  if(!mayRestoreBody(a,o,rows(a.data.sources).find(s=>s.id===o.sourceId)))throw Error('来源正文保留权限已撤回或待核对，请先恢复权限');
  const source=readBody(a,o.contentRef);if(!source)throw Error('来源正文已清理，请重新导入');
  const next={...o,explicitInput:true,userPurpose:purpose,userPurposeEventId:eventId};
  if(source.purpose==='delivery_readback'||source.deliveryActionId){
    next.sourceId='source-input-'+digest([observationId,eventId]);
    const input={...source,id:next.sourceId,purpose:'input',copiedFrom:o.sourceId,explicitInputEventId:eventId};
    delete input.deliveryActionId;delete input.observationId;
    next.contentRef=saveBody(a,observationId,input);
  }
  const decision=classify(a,next);
  commit(a,{...next,...decision,lastEvaluatedBasis:decision.basis,evaluatedAt:now()});
  return reclassify(a).find(r=>r.observationId===observationId)||result(o);
}
function ingestStandalone(a,o,source,job){
  if(!job||job.sourceIds.includes(source.id))return;
  const api=require('./projects.cjs'),actions=api.relatedActions(a,job);
  if(actions.some(r=>['uncertain','running'].includes(r.status)))return;
  for(const r of actions)if(r.status==='pending'){r.status='stale';delete r.approvedAt;}
  job.pendingActionId=null;job.sourceIds.push(source.id);source.state='processed';source.processedAt=now();
  require('./agent-followup.cjs').invalidateEvidence(a,job,source);
  const taskIds=new Set(o.scope.taskId?[o.scope.taskId]:[]);
  for(const watcher of rows(job.watchers))if(watcher.observationId===o.observationId)for(const id of rows(watcher.taskIds))taskIds.add(id);
  for(const t of rows(a.data.tasks))if(t.agentJobId===job.id&&!t.deletedAt&&!t.agentCancelled&&(taskIds.has(t.id)||source.previousSourceId&&rows(t.sourceIds).includes(source.previousSourceId))&&!rows(t.sourceIds).includes(source.id)){
    require('./evidence-links.cjs').bind(a,t,{sourceId:source.id,purpose:'input',provenance:{kind:o.explicitInput?'explicit_input':'source_observation',observationId:o.observationId}});
    if(source.previousSourceId)t.supersededSourceIds=[...new Set([...rows(t.supersededSourceIds),source.previousSourceId])];
    t.needsReplan=`来源「${source.title}」有新材料`;a.requeue(t);require('./agent-plan.cjs').invalidateDependents(a,t);
  }
  job.feedback=[...rows(job.feedback),{at:now(),origin:'source_update',text:`新增材料：${source.title}。核对与已有事项的关系，沿用原事项。`}].slice(-30);
  job.completedAt=null;job.failures=0;job.nextRunAt=now();if(job.status!=='paused')job.status='ready';
}
function reclassify(a, {actionId} = {}) {
  initialize(a);
  const saved=events(a),journalIds=(a.dir||a.workJournalFile)?new Set(journal.read(a).events.map(e=>e.commitId)):null;
  for(const event of saved){
    // Recover the window between durable observation and work-journal append.
    const job=rows(a.data.delegations).find(j=>j.id===event.observation.scope.jobId);
    if(job&&journalIds&&!journalIds.has(event.eventId)){
      journal.append(a,[{type:'source_observation',entityKind:'job',entityId:job.id,actor:'source',payload:{observationEvent:event}}],{commitId:event.eventId});journalIds.add(event.eventId);
    }
    project(a,event);
  }
  const results=[],projects=new Set(),pendingOrigins=new Set(saved.filter(e=>['pending','resolved_conflict'].includes(e.observation.state)).map(e=>e.observation.observationId));
  for(const old of [...a.data.sourceObservations]){
    const source=rows(a.data.sources).find(s=>s.id===old.sourceId)||rows(a.data.sources).find(s=>s.observationId===old.observationId&&!(old.explicitInput&&s.purpose==='delivery_readback'));
    const task=old.scope.taskId&&rows(a.data.tasks).find(t=>t.id===old.scope.taskId),job=old.scope.jobId&&rows(a.data.delegations).find(j=>j.id===old.scope.jobId);
    if(source?.deleted||source?.projectExcluded||task?.deletedAt||task?.agentCancelled||job?.deletedAt||old.scope.jobId&&!job||old.scope.taskId&&!task||old.scope.projectId&&!require('./project-lifecycle.cjs').isActive(a.data,old.scope.projectId)){close(a,{observationId:old.observationId},'来源或所属工作已删除/撤回');continue;}
    if(old.state==='closed')continue;
    // A newly persisted action may not have been a candidate at first observation.
    if(actionId&&!old.explicitInput&&old.candidateActionIds?.length&&!old.candidateActionIds.includes(actionId)&&!actionFacts(a).some(r=>r.id===actionId&&candidate(a,old,r)))continue;
    const decision=classify(a,old);
    const o=old.lastEvaluatedBasis===decision.basis?old:commit(a,{...old,...decision,lastEvaluatedBasis:decision.basis,evaluatedAt:now()});
    if(o.state==='resolved_input'){
      // Ordinary ingestion owns its transaction. A classification recorded before a
      // failed source/cursor commit must wait for that adapter's retry, not replay as input.
      if(!source&&!o.explicitInput&&!pendingOrigins.has(o.observationId)){results.push(result(o));continue;}
      if(!mayRestoreBody(a,o,source)){if(source)source.accessPolicyQuarantined=true;results.push(result(o));continue;}
      const body=source||readBody(a,o.contentRef);
      if(body){
        const saved=attach(a,body,result(o));
        if(saved&&!o.inputConsumption){
          if(o.scope.projectId)projects.add(o.scope.projectId);
          else if(job){const before=consumptionSnapshot(a,job);ingestStandalone(a,o,saved,job);consume(a,o,job,before);}
        }
      }
    }
    results.push(result(o));
  }
  for(const id of projects){
    const p=rows(a.data.projects).find(p=>p.id===id),api=require('./projects.cjs'),job=p&&api.job(a,p);
    // Keep the user's input choice durable while the original write is unresolved.
    // Its eventual outcome retries ingestion; no decision or unknown action is discarded.
    if(job&&api.relatedActions(a,job).some(r=>['uncertain','running'].includes(r.status)))continue;
    if(p&&require('./project-lifecycle.cjs').isActive(a.data,id)){
      const before=job&&consumptionSnapshot(a,job);api.ingest(a,p);
      if(job)for(const o of a.data.sourceObservations.filter(o=>o.scope.projectId===id&&o.state==='resolved_input'&&!o.inputConsumption&&job.sourceIds.includes(o.sourceId)))consume(a,o,job,before);
    }
  }
  if(a.requireContextAccessPolicy)require('./access-policy-store.cjs').reconcile(a);
  return results;
}
module.exports={initialize,observe,allows,attach,link,resolve,close,reclassify,reconcile:reclassify,resourceKey,descriptor,identity,transitionEvent};
