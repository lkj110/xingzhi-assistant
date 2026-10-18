'use strict';
const fs=require('node:fs'),path=require('node:path');
const {rows,sha,digest,rawDigest,fail,inside,manifest,installIsolation}=require('./offline-test-support.cjs');
const SOURCE=path.resolve(__dirname,'../..');
const moduleAt=name=>require(path.join(SOURCE,'desktop',name+'.cjs'));
function record(list, id, passed, detail) {
  const item = {id, passed: passed === true, ...(detail === undefined ? {} : {detail})}; list.push(item); return item.passed;
}
function chain(events, {perEntity = false, previous = true} = {}) {
  const ids = new Set(), heads = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i], key = perEntity ? `${e.entityKind}:${e.entityId}` : 'all';
    if (!e.eventId || ids.has(e.eventId) || e.sequence !== i + 1 || (previous && e.previousEventId !== (heads.get(key) || null))) return false;
    heads.set(key, e.eventId); ids.add(e.eventId);
  }
  return true;
}
function businessBasis(j,t){return {notes:t.notes,requirement:t.userRequirement,needsReplan:t.needsReplan,requirementRevision:t.requirementRevision,jobNotes:j.notes,goal:j.goal,feedback:j.feedback};}
function preserved(a,jobId,taskId) {
  const j = a.data.delegations.find(j => j.id === jobId), t = a.data.tasks.find(t => t.id === taskId), e = j.executionState || {};
  return {
    contract:digest({contract:j.executionContract, contractHistory:j.contractHistory, userDirectives:j.userDirectives, userRequirement:t.userRequirement, criteria:t.criteria}),
    primary:digest({id:t.primaryArtifactId, artifact:a.data.artifacts.find(r => r.id === t.primaryArtifactId)}),
    sourceBodies:digest(a.data.sources.map(s => ({id:s.id, content:s.content, hash:s.hash, segments:s.segments}))),
    sourceObjects:digest(a.data.sources), plan:digest(t.steps), failedCheck:digest(t.contentVerification),
    workRevisions:digest({job:j.workRevision,task:t.workRevision}),
    businessBasis:digest(businessBasis(j,t)),
    taskSources:digest(t.sourceIds), artifacts:digest(a.data.artifacts), runs:digest(a.data.agentRuns), calls:digest(a.data.modelCalls),
    spend:digest(a.spendLedger), permissions:sha(fs.readFileSync(path.join(a.dir,'access-policy.json'))),
    authorization:sha(fs.readFileSync(path.join(a.dir,'authorization-migration.json'))),
    actions:digest(a.data.agentActions.map(r => ({id:r.id, tool:r.tool, status:r.status, content:r.content, result:r.result, target:r.target}))),
    acceptedBoundaries:digest(e.acceptedBoundaries), tried:digest(e.workEfficiency?.tried), oldHistory:digest(e.workEfficiency?.history),
    lastFailure:digest(e.workEfficiency?.lastFailure),
    reading:digest({reads:e.reads, reading:e.workEfficiency?.reading, finalizations:t.contextFinalizations}),
    counters:digest({attempts:e.workEfficiency?.attempts, episodes:Object.entries(e.continuation?.episodes || {}).map(([id,r]) => ({id,hops:r.hops,cycles:r.cycles,executions:r.executions,factKeys:r.factKeys}))}),
    grant:digest(e.repairValidation), inputRecovery:digest(e.inputRecovery),
  };
}
function assertPreserved(assertions, before, after, label, exceptions = []) {
  for (const key of Object.keys(before)) if (!exceptions.includes(key)) record(assertions, `${label}.${key}`, before[key] === after[key], before[key] === after[key] ? undefined : {before:before[key],after:after[key]});
}
function assertReadResumeAddition(assertions, originalTried, job, event) {
  const tried=job.executionState.workEfficiency?.tried||{},added=Object.keys(tried).filter(k=>!Object.hasOwn(originalTried,k));
  const proof=event?.payload?.proof;
  const proven=event?.entityId===job.id&&event?.type==='execution_policy_prepared'
    &&event?.payload?.command==='continuation_read_resume'&&typeof event.at==='string'&&event.at.length>0
    &&['inputBasis','methodId','basis','title'].every(k=>typeof proof?.[k]==='string'&&proof[k].length>0);
  record(assertions,'prepared.original_tried_entries_preserved',Object.entries(originalTried)
    .every(([k,v])=>Object.hasOwn(tried,k)&&digest(tried[k])===digest(v)));
  record(assertions,'prepared.only_proven_new_read_method_appended',added.length===1&&proven
    &&added[0]===proof.inputBasis+':'+proof.methodId
    &&digest(tried[added[0]])===digest({at:event.at,title:proof.title,ownerEpisodeId:proof.basis})
    &&digest(job.executionState.continuation?.episodes?.[proof.basis]?.readingResumes?.[proof.methodId])
      ===digest({at:event.at,inputBasis:proof.inputBasis}));
  return {addedKey:added[0]||null,commandId:event?.commitId||null,originalEntries:Object.keys(originalTried).length};
}
const CONSUMPTION_NOTE='将本轮已关联证据局部纳入当前主稿及其附录，保留已核实内容、读者可读性和真实受限边界。正文不写内部执行记录。具体新增事实与修改位置通过 evidenceIntegration 返回，整体完整性由后续独立检查判断。';
function consumptionHistory(job,task){
  const e=job.executionState||{};
  return digest({jobHistory:job.history,operations:e.operations,operationHistory:e.history,planHistory:task.planHistory,
    checks:[task.contentVerification,task.verification],episodes:Object.entries(e.continuation?.episodes||{}).map(([basis,v])=>({basis,checks:v.checks,pendingCheck:v.pendingCheck,
      cycles:v.cycles,hops:v.hops,executions:v.executions,factKeys:v.factKeys,evidenceAcquisition:v.evidenceAcquisition}))});
}
function captureConsumption(a,job,task){
  return {task:structuredClone(task),job:structuredClone(job),primary:structuredClone(moduleAt('deliverables').primary(a,task)),
    generation:moduleAt('revision-protocol').snapshot(a,task),journal:structuredClone(moduleAt('work-journal').read(a).events),
    protected:preserved(a,job.id,task.id),history:consumptionHistory(job,task),intent:moduleAt('continuation-control').intentBasis(job,task)};
}
// This oracle derives the only permitted plan/note delta from the original
// draft and the durable command. It never calls queue/applyPrepared or repairs
// the replay. Unrelated routes continue to use their original preservation rules.
function assertConsumptionPreparation(assertions,before,a,job,task,view,events){
  return moduleAt('projection-cache').scope(()=>{
    const start=assertions.length,check=(id,ok)=>record(assertions,'consume.'+id,ok),old=before.task.evidenceConsumption;
    const added=events.slice(before.journal.length).filter(e=>e.type==='execution_policy_prepared'&&e.payload?.command==='evidence_consume');
    check('journal_prefix',digest(events.slice(0,before.journal.length))===digest(before.journal)&&chain(events,{perEntity:true}));
    const event=added[0],proof=event?.payload?.proof,primary=before.primary;
    const journalIdentity=added.length===1&&event.entityKind==='job'&&event.entityId===job.id&&event.actor==='system'&&event.workRevision===(job.workRevision??1)
      &&event.payload.taskId===task.id&&proof?.jobId===job.id&&proof?.taskId===task.id&&proof.version===1&&Number.isFinite(Date.parse(event.at))
      &&Array.isArray(proof.targetFacts)&&proof.targetFacts.length>0&&Array.isArray(proof.additionalFacts);
    check('one_exact_journal_command',journalIdentity);
    if(!journalIdentity||!primary){check('original_primary_present',!!primary);return {proven:false,expected:before.protected};}
    const {attemptId,...identity}=proof,step=before.task.steps.find(s=>s.id===primary.stepId);
    check('command_and_attempt_identity',attemptId===digest(identity)&&event.commitId==='execution_policy_prepared:'+digest({jobId:job.id,revision:job.workRevision??1,...event.payload})
      &&digest(event.command)===digest({type:event.type,entityKind:event.entityKind,entityId:event.entityId,workRevision:event.workRevision,actor:event.actor,basisRefs:event.basisRefs,payload:event.payload,at:event.at})
      &&Object.keys(proof).sort().join(',')==='additionalFacts,attemptId,baseArtifactId,baseHash,intent,jobId,primaryLineageId,scope,stepId,targetFacts,taskId,version'
      &&digest(job.executionState.policyCommands?.[event.commitId])===digest({command:'evidence_consume',proof,at:event.at}));
    check('original_draft_binding',primary.id===before.task.primaryArtifactId&&primary.taskId===task.id&&step?.kind==='draft'&&proof.stepId===step.id
      &&proof.baseArtifactId===primary.id&&proof.baseHash===digest(primary.content)&&proof.primaryLineageId===(old?.primaryLineageId||primary.id)&&proof.intent===before.intent);
    const valid=new Set(moduleAt('relation-obligations').recoveryFacts(a,job,task).map(digest));
    const sources=new Map(moduleAt('relation-obligations').sourceRows(a,job,task,task.sourceIds).map(s=>[s.id,s])),provenFacts=new Map();
    for(const e of before.journal){
      if(e.type!=='evidence_plan_committed'||e.entityKind!=='task'||e.entityId!==task.id||e.workRevision!==(task.workRevision??1))continue;
      const p=e.payload?.task?.set?.lastEvidenceResolution?.recoveryProof;
      for(const f of rows(p?.facts)){
        if(!f?.fact||typeof f.fact!=='object')continue;
        const factKey=digest(f.fact),source=sources.get(f.sourceId),target=rows(p.request?.targets).find(v=>v.kind===f.fact.kind&&rows(v.rootIds).includes(f.fact.rootId));
        if(!valid.has(factKey)||!source||!target)continue;
        provenFacts.set(factKey,{eventId:e.eventId,value:{factKey,obligationId:target.obligationId,sourceId:source.id,semanticVersion:f.fact.contentHash,
          bindingVersion:digest({content:source.content,principal:source.platformPrincipal,version:source.version,archive:source.platformArchive}),fact:f.fact}});
      }
    }
    const all=[...provenFacts.values()].map(v=>v.value).sort((x,y)=>x.factKey.localeCompare(y.factKey));
    const tried=new Set(Object.values(old?.attempts||{}).filter(p=>p.intent===before.intent).flatMap(p=>rows(p.targetFacts).map(f=>f.factKey)));
    const integrated=new Set(rows(old?.receipts).flatMap(r=>rows(r.integration).map(f=>f.factKey)));
    const targets=all.filter(f=>!tried.has(f.factKey)).slice(0,24),additional=all.filter(f=>!integrated.has(f.factKey)&&!targets.some(t=>t.factKey===f.factKey)).slice(0,24-targets.length);
    check('exact_untried_journal_facts',targets.length>0&&digest(proof.targetFacts)===digest(targets)&&digest(proof.additionalFacts)===digest(additional));
    const affected=step?[step.id]:[];
    for(const s of before.task.steps.filter(s=>s.kind==='external')){
      const bound=s.inputArtifactId||s.args?.artifactId,records=rows(a.data.agentActions).filter(r=>r.taskId===task.id&&r.tool===s.tool&&rows(s.evidence).includes(r.id));
      if(bound===primary.id||records.some(r=>r.artifactId===primary.id)||!bound&&!records.length)affected.push(s.id);
    }
    const expectedTask=structuredClone(before.task);
    for(const s of expectedTask.steps){
      if(s.id===step?.id){s.outputRole='primary';s.targetArtifactId=primary.id;}
      if(affected.includes(s.id)){s.done=false;delete s.artifactId;delete s.evidence;}
    }
    const notes=rows(task.notes),note=notes[rows(before.task.notes).length];
    check('one_bound_revision_note',notes.length===rows(before.task.notes).length+1&&typeof note?.id==='string'&&note.id.length>0
      &&!rows(before.task.notes).some(n=>n.id===note.id)&&Number.isFinite(Date.parse(note.at))&&Date.parse(note.at)>=Date.parse(event.at));
    const expectedNote={id:note?.id,at:note?.at,kind:'revise',text:CONSUMPTION_NOTE,origin:'evidence_consumption',targetArtifactId:primary.id,targetStepId:step?.id,
      baseHash:digest(primary.content),verificationSnapshot:before.generation,gapDetails:[],affectedStepIds:affected};
    expectedTask.notes=[...rows(before.task.notes),expectedNote];expectedTask.needsReplan=null;
    const expectedApp={...a,data:{...a.data,tasks:a.data.tasks.map(t=>t.id===task.id?expectedTask:t)}};
    const originalInputBasis=step&&moduleAt('step-evidence').snapshot(expectedApp,expectedTask,expectedTask.steps.find(s=>s.id===step.id));
    const originalGenerationSnapshot=moduleAt('revision-protocol').snapshot(expectedApp,expectedTask);
    const expectedAttempt={...proof,status:'prepared',preparedAt:event.at,commandId:event.commitId,requests:[],originalInputBasis,originalGenerationSnapshot};
    const expectedState={...(old||{version:1,primaryLineageId:proof.primaryLineageId,attempts:{},receipts:[]}),activeAttemptId:attemptId,attempts:{...old?.attempts,[attemptId]:expectedAttempt}};
    check('one_prepared_attempt_no_model_or_receipt',!Object.hasOwn(old?.attempts||{},attemptId)&&digest(task.evidenceConsumption)===digest(expectedState));
    check('original_history_preserved',consumptionHistory(job,task)===before.history);
    check('same_original_input_and_scope',!!originalInputBasis&&moduleAt('evidence-consumption').current(a,job,task,task.evidenceConsumption?.attempts?.[attemptId]));
    const episode=job.executionState.continuation?.episodes?.[job.executionState.continuation?.activeBasis];
    check('selected_original_draft_only',view.eligible===true&&view.route==='consume'&&view.owner?.kind==='continuation'&&view.owner?.taskId===task.id&&view.owner?.basis===episode?.basis
      &&episode?.taskId===task.id&&view.action?.tool==='advance_task'&&view.action.args?.taskId===task.id&&moduleAt('evidence-consumption').selectedStep(a,job,task)?.id===step?.id);
    const expected={...before.protected,plan:digest(expectedTask.steps),businessBasis:digest(businessBasis(before.job,expectedTask))};
    // Keep the same protection IDs; these are exact expected hashes, not exemptions.
    check('exact_plan_delta',digest(task.steps)===expected.plan);check('exact_business_delta',digest(businessBasis(job,task))===expected.businessBasis);
    const after=preserved(a,job.id,task.id);
    for(const key of ['contract','primary','sourceBodies','sourceObjects','workRevisions','taskSources','artifacts','runs','calls','spend','permissions','authorization','actions','counters','grant'])check('unchanged_'+key,before.protected[key]===after[key]);
    return {proven:assertions.slice(start).every(r=>r.passed),expected,attemptId,commandId:event.commitId,eventId:event.eventId,baseArtifactId:primary.id,stepId:step?.id,
      originalInputHash:originalInputBasis?.hash,generationSnapshotId:originalGenerationSnapshot.id,
      journalFacts:targets.map(f=>({factKey:f.factKey,sourceId:f.sourceId,eventId:provenFacts.get(f.factKey).eventId}))};
  });
}
function pureInspect(a, fn, assertions, label) {
  const before = rawDigest({data:a.data, spend:a.spendLedger}), disk = digest(manifest(a.dir));
  const save = a.save, event = a.event;
  let attempted = false;
  const originalData=a.data, originalSpend=a.spendLedger, proxies=new WeakMap(), targets=new WeakMap(), clone=globalThis.structuredClone;
  const forbidden=()=>{attempted=true;throw fail('INSPECT_MUTATION');};
  const diskUndo=[];
  for(const key of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','rmSync','rmdirSync','truncateSync','chmodSync','utimesSync','writeSync','ftruncateSync','renameSync','linkSync','copyFileSync','cpSync','symlinkSync']){
    const old=fs[key];fs[key]=forbidden;diskUndo.push(()=>{fs[key]=old;});
  }
  const open=fs.openSync;
  fs.openSync=(file,flags,...args)=>{
    if(typeof flags==='number'?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT))!==0:/[wa+]/.test(flags))return forbidden();
    return open(file,flags,...args);
  };
  diskUndo.push(()=>{fs.openSync=open;});
  // Read-only proxies cover the actual input, without a clone that could hide
  // side effects. They also catch writes in modules lacking strict mode.
  const readonly=value=>{
    if(!value||typeof value!=='object')return value;
    if(proxies.has(value))return proxies.get(value);
    const proxy=new Proxy(value,{get:(target,key)=>readonly(Reflect.get(target,key)),
      set:forbidden,deleteProperty:forbidden,defineProperty:forbidden,setPrototypeOf:forbidden});
    proxies.set(value,proxy);targets.set(proxy,value);return proxy;
  };
  a.data=readonly(originalData);a.spendLedger=readonly(originalSpend);
  const unwrap=value=>{
    if(!value||typeof value!=='object')return value;
    if(targets.has(value))return targets.get(value);
    if(Array.isArray(value))return value.map(unwrap);
    if(Object.getPrototypeOf(value)===Object.prototype)return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unwrap(v)]));
    return value;
  };
  globalThis.structuredClone=(value,options)=>{
    try{return clone(targets.get(value)||value,options);}catch(error){if(error.name!=='DataCloneError')throw error;return clone(unwrap(value),options);}
  };
  a.save = a.event = () => { attempted = true; throw fail('INSPECT_MUTATION'); };
  let value;
  try { value = fn();if(value&&typeof value.then==='function')throw fail('ASYNC_INSPECT_UNSUPPORTED'); }
  finally {
    const unchanged=before === rawDigest({data:a.data,spend:a.spendLedger});
    a.data=originalData;a.spendLedger=originalSpend;a.save = save; a.event = event;globalThis.structuredClone=clone;
    for(const restore of diskUndo.reverse())restore();
    record(assertions, label + '.pure', !attempted && unchanged && disk === digest(manifest(a.dir)));
  }
  return value;
}
const SNAPSHOTS=Object.fromEntries(['S57','S62-input','S62-read','S63-paused'].map(id=>[id,true]));
function parseArgs(args) {
  const options={snapshots:{}};
  for(let i=0;i<args.length;i++) {
    const flag=args[i], value=args[++i]; if(!value)throw fail('MISSING_ARGUMENT');
    if(flag==='--snapshot-root')options.snapshotRoot=path.resolve(value);
    else if(flag==='--output')options.output=path.resolve(value);
    else if(flag==='--scenario')(options.scenarioIds||=[]).push(value);
    else if(flag==='--snapshot'){const at=value.indexOf('=');if(at<1||!SNAPSHOTS[value.slice(0,at)])throw fail('UNKNOWN_SNAPSHOT');options.snapshots[value.slice(0,at)]=path.resolve(value.slice(at+1));}
    else throw fail('UNKNOWN_ARGUMENT');
  }
  return options;
}
function validateInputs({snapshots={},scenarioIds,output}={}){
 const allowed=Object.keys(SNAPSHOTS).flatMap(id=>(id==='S57'?['original']:['original','counterfactual']).map(variant=>id+':'+variant));
 if(output){
  const absolute=path.resolve(output);if(fs.existsSync(absolute)&&fs.lstatSync(absolute).isSymbolicLink())throw fail('REPORT_SYMLINK_FORBIDDEN');
  const target=path.join(fs.realpathSync(path.dirname(absolute)),path.basename(absolute));
  if(inside(SOURCE,target))throw fail('REPORT_IN_SOURCE_FORBIDDEN');
  if(/[/\\]Library[/\\]Application Support[/\\]/.test(target)||Object.values(snapshots).some(root=>inside(fs.existsSync(root)?fs.realpathSync(root):path.resolve(root),target)))throw fail('REPORT_OVERLAPS_SNAPSHOT');
 }
 if(scenarioIds&&(!scenarioIds.length||scenarioIds.some(id=>!allowed.includes(id))))throw fail('UNKNOWN_SCENARIO');
 return {scenarioIds:scenarioIds||allowed};
}
module.exports={digest,manifest,installIsolation,pureInspect,assertReadResumeAddition,captureConsumption,assertConsumptionPreparation,parseArgs,validateInputs};
