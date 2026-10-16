// A successful check can be reused only against the same requirements and evidence.
// Chunks retain position and headings: moved, deleted or edited chunks are rechecked.
const crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidence=require('./evidence-basis.cjs');
function basis(a,task){
 const context=a.context(task,{verification:true}),{artifacts,artifactHistory,currentTime,retrievedEvidence,sources,generationEvidence,sourceCatalog,evidenceDirectory,contextNote,requestedSections,...stable}=context;
 const sourceIds=task.sourceIds||[],job=a.data.delegations.find(j=>j.id===task.agentJobId);
 const {primaryArtifactId,evidenceRequest,...stableTask}=stable.task,primary=require('./deliverables.cjs').primary(a,task);
 if(stable.delegation)stable.delegation={...stable.delegation,feedback:(stable.delegation.feedback||[]).filter(f=>!(f.kind==='task_revision'&&f.taskId===task.id)),userDirectives:(stable.delegation.userDirectives||[]).filter(f=>!(f.kind==='task_revision'&&f.taskId===task.id))};
 if(stable.delegation)stable.delegation={...stable.delegation,feedback:evidence.feedback(stable.delegation.feedback),userDirectives:evidence.feedback(stable.delegation.userDirectives)};
 return hash({...stable,task:{...stableTask,primaryStepId:primary?.stepId||null,evidenceRequest,notes:evidence.notes(task.notes).filter(n=>n.kind!=='revise'),steps:task.steps.map(s=>{const {artifactId,targetArtifactId,outputRole,...rest}=evidence.step(s);return {...rest,outputRole:outputRole||(s.id===primary?.stepId?'primary':'supporting')};})},
   sourceVersions:evidence.taskSources(a,task),
   replacements:a.data.sources.filter(s=>sourceIds.includes(s.previousSourceId)&&evidence.relevantChange(a.data.sources.find(p=>p.id===s.previousSourceId),s,task,job)).map(s=>[s.id,s.deleted,s.projectExcluded]),
   dependencies:(task.dependsOn||[]).map(id=>{const t=a.task(id);return {id,verification:t.verification,artifacts:a.data.artifacts.filter(r=>r.taskId===id&&t.steps.some(s=>s.done&&s.artifactId===r.id))};})});
}
function chunks(content){
 const parts=[];let heading='正文',offset=0;
 for(const section of content.split(/(?=^#{1,6} )/m)){
  heading=section.match(/^#{1,6} (.+)/)?.[1]||heading;
  for(let start=0;start<section.length;start+=4000){const text=section.slice(start,start+4000);parts.push({index:parts.length,heading,hash:hash(text),text,chars:text.length,offset:offset+start});}
  offset+=section.length;
 }
 return parts;
}
function current(a,task){return a.data.artifacts.filter(r=>r.taskId===task.id&&(r.id===task.primaryArtifactId||task.steps.some(s=>s.done&&s.artifactId===r.id)));}
// Incremental reuse is also evidence reuse. Never retain a passed fragment after
// its evidence/dependency authorization disappears, even when bytes are unchanged.
function policyBasis(a,task){
 try{
  const protocol=require('./task-context.cjs'),records=[];
  for(const t of [task,...(task.dependsOn||[]).map(id=>a.task(id))]){
   const scope=protocol.taskScope(t),snapshot=protocol.buildContext(a,scope,'verify'),allowed=new Set(snapshot.readableCatalog.filter(r=>!r.ambiguous).map(r=>r.id));
   if((t.sourceIds||[]).filter(id=>!t.supersededSourceIds?.includes(id)).some(id=>!allowed.has(id))||current(a,t).some(r=>!allowed.has(r.id)))return null;
   if((t.generationReads||[]).some(r=>!protocol.validRead(a,scope,r)))return null;
   // A revision creates a new output object, but the same logical step. Its
   // current permission was checked above; source and dependency permissions
   // must still match. Object IDs must not force every editorial patch to full.
   records.push({taskId:t.id,outputSteps:current(a,t).map(r=>r.stepId).sort(),rows:[...snapshot.readableCatalog,...snapshot.historyCatalog].filter(r=>r.type==='source'||t.id!==task.id&&current(a,t).some(x=>x.id===r.id)).map(r=>({id:r.id,type:r.type,state:r.state,purpose:r.purpose,policyRevision:r.policyRevision,...(r.type==='source'?{version:r.version}:{})}))});
  }
  return evidence.hash(records);
 }catch{return null;}
}
function prepare(a,task,context,options={}){
 const checkpoint=task.verificationCheckpoint,signature=basis(a,task);
 const full={context,signature,policyBasis:policyBasis(a,task),mode:'full',reusedChunks:0,checkedChunks:current(a,task).reduce((n,r)=>n+chunks(r.content).length,0)};
 if(options.allowExact===true&&typeof options.verifierKey==='string'&&options.verifierKey.trim()){
  full.verifierKey=options.verifierKey;full.exactBasis=exactBasis(a,task,options.verifierKey);
  const hit=exactResult(a,task,full);
  if(hit)return {...full,mode:'exact',reuseCandidate:true,reusedChunks:full.checkedChunks,checkedChunks:0,metrics:{modelCalls:0,avoidedModelCalls:1,reusedResults:1}};
 }
 if(![1,2].includes(checkpoint?.version)||checkpoint.basis!==signature||checkpoint.passed!==true||!checkpoint.summary||!full.policyBasis||checkpoint.policyBasis!==full.policyBasis)return full;
 // Two distinct drafts can occupy one legacy step. They cannot share a chunk
 // identity; require a full check rather than borrowing the sibling's result.
 if(new Set(current(a,task).map(r=>r.stepId)).size!==current(a,task).length)return full;
 // New feedback can change the factual scope. Only editorial revision notes are
 // eligible; changed business requirements always require a complete check.
 const revisions=(task.notes||[]).filter(n=>n.kind==='revise');
 if(!Array.isArray(checkpoint.revisions)||checkpoint.revisions.some((h,i)=>hash(revisions[i])!==h))return full;
 const newNotes=revisions.slice(checkpoint.revisions.length);
 if(newNotes.some(n=>!require('./model-routing.cjs').isEditorial(n.text)))return full;
 let reused=0,checked=0,deleted=[];
 const artifacts=context.artifacts.map(r=>{
  const old=checkpoint.artifacts.find(p=>p.stepId===r.stepId&&p.title===r.title),parts=chunks(r.content);
  if(!old){checked+=parts.length;return r;}
  const unchanged=parts.map((p,i)=>old.chunks[i]?.hash===p.hash&&old.chunks[i]?.heading===p.heading);
  // Send adjacent unchanged chunks as context for consistency checks.
  const omitted=parts.map((p,i)=>unchanged[i]&&unchanged[i-1]!==false&&unchanged[i+1]!==false);
  const count=omitted.filter(Boolean).length;if(!count){checked+=parts.length;return r;}
  reused+=count;checked+=parts.length-count;
  if(old.chunks.length>parts.length)deleted.push({stepId:r.stepId,removedChunks:old.chunks.slice(parts.length)});
  return {...r,content:parts.map((p,i)=>omitted[i]?`\n[已复核未变化片段 ${i+1}：${p.heading}，${p.chars}字符，SHA256 ${p.hash}]\n`:p.text).join(''),reusedChunks:count,partialVerification:true};
 });
 for(const old of checkpoint.artifacts)if(!context.artifacts.some(r=>r.stepId===old.stepId))deleted.push({stepId:old.stepId,removedArtifact:true});
 if(!reused)return full;
 const incremental={...full,signature,mode:'incremental',reusedChunks:reused,checkedChunks:checked,context:{...context,artifacts,previousCheck:{at:checkpoint.at,summary:checkpoint.summary,requirementsAndSourcesUnchanged:true,deleted,note:'应用按位置、标题、内容哈希匹配已通过的片段。省略部分可沿用原检查；仍须检查本次修改、删除、整体连贯性及所有完成标准。无法确认影响范围时返回 retryFull=true，不得猜测。'}}};
 // Small documents can be cheaper to check in full than to send reuse metadata.
 return JSON.stringify(incremental.context).length<JSON.stringify(context).length?incremental:full;
}
// The exact path is explicitly opted into by the parent. verifierKey MUST change
// when the verification prompt/schema/policy changes. A hit is not acceptance:
// parent calls reuse immediately before consuming it, validates the result as usual,
// checks acceptance.basis again, and follows the existing acceptance/gate pipeline.
function passed(result){return result?.passed===true&&typeof result.summary==='string'&&!!result.summary.trim()&&Array.isArray(result.gaps)&&result.gaps.every(g=>typeof g==='string'&&!g.trim())&&result.retryFull!==true;}
function exactBasis(a,task,verifierKey){
 try{
  const acceptance=require('./acceptance.cjs'),protocol=require('./task-context.cjs');
  require('./project-lifecycle.cjs').assertTaskActive(a.data,task);
  const signature=acceptance.basis(a,task),snapshot=protocol.buildContext(a,protocol.taskScope(task),'verify');
  const all=[...snapshot.readableCatalog,...snapshot.historyCatalog],allowed=new Set(snapshot.readableCatalog.filter(r=>!r.ambiguous).map(r=>r.id));
  // A synthesized check is used ONLY to evaluate structural preconditions. The
  // saved passed result and its exact acceptance basis are independently required.
  if(acceptance.reasons(a,{...task,status:'review',verification:{passed:true,summary:'cache preflight',gaps:[],basis:signature}}).length)return null;
  if(current(a,task).some(r=>!allowed.has(r.id)))return null;
  if((task.sourceIds||[]).filter(id=>!task.supersededSourceIds?.includes(id)).some(id=>!allowed.has(id)))return null;
  const actions=(a.data.agentActions||[]).filter(r=>r.taskId===task.id);
  if(actions.some(r=>r.deliveryConflict||['pending','running','uncertain'].includes(r.status)||r.status==='done'&&(r.result?.verified!==true||r.result?.sourceId&&!allowed.has(r.result.sourceId))))return null;
  if((task.generationReads||[]).some(r=>!protocol.validRead(a,protocol.taskScope(task),r)))return null;
  for(const id of task.dependsOn||[]){
   const dep=a.task(id),depContext=protocol.buildContext(a,protocol.taskScope(dep),'verify'),depIds=new Set(depContext.readableCatalog.filter(r=>!r.ambiguous).map(r=>r.id));
   if(current(a,dep).some(r=>!depIds.has(r.id))||(dep.sourceIds||[]).filter(id=>!dep.supersededSourceIds?.includes(id)).some(id=>!depIds.has(id)))return null;
  }
  return evidence.hash({version:1,verifierKey,acceptance:signature,basis:basis(a,task),
   contextRevision:snapshot.contextRevision,inputBasis:snapshot.inputBasis,deliveryBasis:snapshot.deliveryBasis,
   workRevision:snapshot.workRevision,requirementRevision:snapshot.requirementRevision,
   catalog:all,dependencies:(task.dependsOn||[]).map(id=>protocol.buildContext(a,protocol.taskScope(a.task(id)),'verify'))});
 }catch{return null;} // A denied/incomplete/stale context can never seed a hit.
}
function exactResult(a,task,prepared){
 const checkpoint=task.verificationCheckpoint,exact=checkpoint?.exact;
 if(checkpoint?.version!==2||checkpoint.passed!==true||!exact||!prepared.exactBasis||!passed(exact.result)||evidence.hash(exact.result)!==exact.resultHash||exact.basis!==prepared.exactBasis||exact.verifierKey!==prepared.verifierKey)return null;
 const check=task.verification;
 if(check?.basisVersion!==2||!passed(check)||check.basis!==exact.acceptanceBasis||check.basis!==require('./acceptance.cjs').basis(a,task))return null;
 if(exactBasis(a,task,prepared.verifierKey)!==exact.basis)return null;
 return structuredClone(exact.result);
}
function reuse(a,task,prepared,{verifierKey}={}){
 if(prepared?.mode!=='exact'||verifierKey!==prepared.verifierKey)return null;
 return exactResult(a,task,prepared);
}
function remember(a,task,result,prepared){
 if(result.passed!==true||typeof result.summary!=='string'||!result.summary.trim()||result.retryFull===true||result.gaps!==undefined&&!passed(result)){delete task.verificationCheckpoint;return;}
 // Never seed a checkpoint from a stale asynchronous response.
 if(prepared.signature!==basis(a,task)||prepared.policyBasis!==policyBasis(a,task)){delete task.verificationCheckpoint;return;}
 task.verificationCheckpoint={version:2,basis:prepared.signature,policyBasis:prepared.policyBasis,passed:true,summary:result.summary,at:new Date().toISOString(),revisions:(task.notes||[]).filter(n=>n.kind==='revise').map(hash),artifacts:current(a,task).map(r=>({stepId:r.stepId,title:r.title,chunks:chunks(r.content).map(({text,offset,...p})=>p)}))};
 if(passed(result)&&prepared.exactBasis&&exactBasis(a,task,prepared.verifierKey)===prepared.exactBasis){
  const saved={passed:true,summary:result.summary,gaps:[...result.gaps],...(result.gapDetails?{gapDetails:structuredClone(result.gapDetails)}:{})};
  task.verificationCheckpoint.exact={basis:prepared.exactBasis,verifierKey:prepared.verifierKey,acceptanceBasis:require('./acceptance.cjs').basis(a,task),result:saved,resultHash:evidence.hash(saved)};
 }
}
module.exports={basis,chunks,prepare,remember,reuse};
