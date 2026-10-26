'use strict';
// Narrow planner adapters. A receipt can resume work, never certify completion.
function owned(a,job,id){const task=a.task(id);require('./task-trash.cjs').assertTask(task);if(task.agentJobId!==job.id||!job.taskIds.includes(id))throw Error('事项不属于当前委托');require('./execution-gate.cjs').assert(a,{job,task,readOnly:true});return task;}
async function compute(a,job,args){
 const task=owned(a,job,args.taskId);
 if(!require('./context-optimizations.cjs').enabled(a,'C'))throw Error('当前未启用白名单求证');
 const {taskId,...request}=args;
 const batch=await require('./tool-evidence.cjs').readRequests(a,task,[{...request,tool:'compute_evidence'}],()=>{throw Error('不支持的求证请求');});
 if(batch.rows[0]?.result?.ok!==true)return {...batch.rows[0]?.result,taskId};
 return {...batch.rows[0].result,taskId,nextAction:task.evidenceRequest?{tool:'resume_evidence',args:{taskId,basis:task.evidenceRequest.basis,toolEvidenceIds:batch.toolEvidence?.map(r=>r.id)||[],reason:'取得本轮真实求证结果，交回原事项重新判断缺口'}}:{tool:'advance_task',args:{taskId}}};
}
async function read(a,job,args){
 const task=owned(a,job,args.taskId),record=a.data.agentActions.find(r=>r.id===args.actionId&&r.jobId===job.id&&r.taskId===task.id&&r.status==='done');
 if(!record)throw Error('执行结果不属于本事项或尚未完成');
 if(record.tool!=='write_file')return require('./agent-local.cjs').read(a,job,args);
 if(args.filename!==undefined&&![record.result?.path,record.result?.latestPath].filter(Boolean).some(p=>require('node:path').basename(p)===args.filename))throw Error('文件不在本次已核对的产出列表');
 if(args.start!==undefined&&args.start!==0)throw Error('文件动作回读执行完整比较并返回有界摘录；全文分页请使用已授权目录的 read_file');
 return compute(a,job,{taskId:task.id,operation:'action_status',actionId:record.id});
}
function resume(a,job,args){
 if(!args||Object.keys(args).some(k=>!['taskId','basis','sourceIds','toolEvidenceIds','reason'].includes(k)))throw Error('补证接续参数无效');
 const task=owned(a,job,args.taskId);
 const requestId=task.evidenceRequest?require('./evidence-request.cjs').identity(task.evidenceRequest):task.lastEvidenceResolution?.requestId;
 const plan={commandId:'resume_evidence:'+require('./evidence-basis.cjs').hash({requestId,args}),key:task.agentKey,existingTaskId:task.id,title:task.title,description:task.description,criteria:task.criteria,sourceIds:args.sourceIds||[],reason:args.reason,evidenceResolution:{basis:args.basis,sourceIds:args.sourceIds||[],toolEvidenceIds:args.toolEvidenceIds||[],reason:args.reason}};
 // A successful commit removes evidenceRequest before its response is sent.
 // Replay that exact durable command after a lost response; never synthesize a
 // new resolution or erase a later request from an older command.
 const prior=!task.evidenceRequest&&require('./evidence-continuation.cjs').recover(a,job,task,plan);
 if(!prior&&task.evidenceRequest?.kind!=='needs_evidence')throw Error('仅能接续当前补证请求；计划调整仍使用 plan_task');
 const result=prior||require('./agent-plan.cjs').planTask(a,job,plan);
 return {...result,nextAction:{tool:'advance_task',args:{taskId:task.id}},note:'新证据已绑定原事项，缺口仍由工作模型与独立核验判断。'};
}
function guidance(a,job,sourceId){
 if(!sourceId)return undefined;
 const tasks=job.taskIds.map(id=>a.task(id)).filter(t=>!t.deletedAt&&!t.agentCancelled&&t.evidenceRequest?.kind==='needs_evidence');
 return tasks.map(task=>({tool:'resume_evidence',args:{taskId:task.id,basis:task.evidenceRequest.basis,sourceIds:[sourceId],reason:'读取到新材料，绑定原事项继续核实'},note:'仅选择此来源对应的原事项；已有证据不等于全部缺口已满足。'}));
}
const prompt='\n补证接续：resume_evidence {taskId,basis,sourceIds?:[],toolEvidenceIds?:[],reason} 仅将本轮新来源/求证回执绑定 evidenceRequest.basis 对应的原事项，保留计划与稿件，再 advance_task 继续核实；不需要重写整份 plan_task。若需改变业务计划仍用 plan_task。compute_evidence {taskId,operation,inputs?,args?,actionId?} 使用同一白名单求证协议，可做来源绑定的计算或 action_status 观察，无需 run_code 权限。read_local_result 对 write_file 返回本次全文件比较与有界摘录，对代码工具返回实际产出。不要反复读同一已提供全文；返回 sourceId 后应接续对应事项。';
module.exports={compute,read,resume,guidance,prompt};
