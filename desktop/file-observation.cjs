'use strict';
// Durable evidence of a past comparison. This never authorizes current delivery.
const {hash}=require('./evidence-basis.cjs');
function identity(a,task,request){
 const records=a.data.agentActions.filter(r=>r.id===request.actionId&&r.taskId===task.id&&r.jobId===task.agentJobId);
 const jobs=a.data.delegations.filter(j=>j.id===task.agentJobId&&!j.deletedAt);
 if(records.length!==1||jobs.length!==1)throw require('./model-errors.cjs').contextError('CONTEXT_SCOPE_DENIED');
 const record=records[0],job=jobs[0];
 const paths=require('./agent-writes.cjs').recordedFileAccess(a,job,task,record);
 const context=require('./task-context.cjs').buildContext(a,require('./task-context.cjs').taskScope(task),'verify');
 const artifact=[...context.readableCatalog,...context.historyCatalog].find(r=>r.id===record.artifactId);
 if(!artifact)throw require('./model-errors.cjs').contextError('CONTEXT_SCOPE_DENIED');
 return {record,job,basis:hash({record,taskId:task.id,jobId:job.id,projectId:task.projectId||null,paths,artifact:[artifact.id,artifact.version,artifact.policyRevision]})};
}
function observe(a,task,request){
 const before=identity(a,task,request),files=require('./agent-writes.cjs').observeRecordedFile(a,before.job,task,before.record);
 if(identity(a,task,request).basis!==before.basis)throw require('./model-errors.cjs').contextError('CONTEXT_VERSION_CHANGED');
 const matched=files.every(f=>f.exists&&f.contentMatches);
 return {inputs:[],basis:before.basis,dynamic:false,temporalScope:'observed_at',output:{actionId:before.record.id,tool:'write_file',comparison:files.some(f=>!f.exists)?'file_missing':matched?'matches_recorded_content':'differs_from_recorded_content',files,readbackHash:hash(files),note:'仅证明 observedAt 时点的完整文件比较；不证明文件现在仍一致，不证明当前主稿已交付，也不证明对外发送。当前状态须另用 action_status 新鲜回读。'}};
}
function valid(a,task,receipt){
 return receipt.temporalScope==='observed_at'&&receipt.dynamic===false&&receipt.validUntil===null&&Number.isFinite(Date.parse(receipt.observedAt))&&receipt.output?.observedAt===receipt.observedAt&&receipt.output?.temporalScope==='observed_at'&&receipt.output.readbackHash===hash(receipt.output.files)&&receipt.resultText===JSON.stringify(receipt.output)&&require('./tool-execution-events.cjs').rows(task,receipt).length>0&&identity(a,task,receipt.request).basis===receipt.basis;
}
// action_status keeps its short current-state validity, while the actual file
// comparison remains an observation. Old receipts without this capture cannot
// acquire a historical proof by replaying a read during validation.
function validStatus(a,task,receipt){
 return receipt.request?.operation==='action_status'&&receipt.dynamic===true&&
  typeof receipt.observationBasis==='string'&&Number.isFinite(Date.parse(receipt.observedAt))&&
  receipt.output?.tool==='write_file'&&receipt.output.observedAt===receipt.observedAt&&
  Array.isArray(receipt.output.files)&&receipt.output.files.length>0&&
  receipt.output.readbackHash===hash(receipt.output.files)&&receipt.resultText===JSON.stringify(receipt.output)&&
  require('./tool-execution-events.cjs').rows(task,receipt).length>0&&identity(a,task,receipt.request).basis===receipt.observationBasis;
}
module.exports={observe,valid,identity,validStatus};
