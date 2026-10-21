const evidence=require('./evidence-basis.cjs');
const groups={
 read:['read_local_result','read_url','list_files','read_file','search_web','github_list','github_read','read_lark_document','read_output_state','capability_call','platform_inventory','read_platform','platform_query','read_work_state','list_sources','read_artifact','read_source','search_source'],
 check:['verify_content','complete'],
 local:['recover_platform_result','retire_output','plan_task','cancel_task','resolve_wait','resolve_question','advance_task','revise_task','wait','ask'],
 external:[...require('./agent-local.cjs').actions,'lark_create','lark_update','write_file','github_create','github_update','github_comment','request_confirmation'],
 authorization:['request_access']
};
const registry=Object.freeze(Object.fromEntries(Object.entries(groups).flatMap(([effect,names])=>names.map(name=>[name,Object.freeze({name,effect,scope:'delegation',coverage:effect==='read'?'result_declared':'not_applicable',adapter:1})]))));
const readFields={read_url:['url','taskId'],list_files:['folderId','taskId'],read_file:['folderId','name','taskId'],search_web:['query'],github_list:['taskId'],github_read:['number','taskId'],read_lark_document:['url'],read_output_state:['taskId'],capability_call:['capabilityId','tool','input'],platform_inventory:['start','queryStart','limit'],read_platform:['sourceId','start','limit'],platform_query:['queries'],read_work_state:['section','start','limit','status'],list_sources:['start','limit','query','history','type','taskId','ref'],read_artifact:['artifactId','ref','start','history','version'],read_source:['sourceId','ref','start','limit','history','version'],search_source:['sourceId','ref','query','start','limit','history','version']};
readFields.read_local_result=['taskId','actionId','filename','start'];
function parameters(tool,args={}){const fields=readFields[tool];return structuredClone(fields?Object.fromEntries(fields.filter(k=>args[k]!==undefined).map(k=>[k,args[k]])):args);}
function get(name){const entry=registry[name];if(!entry)throw Error('Agent 返回了不可用的工具（未声明执行协议）');return entry;}
function request(job,tool,args,a){if(a&&tool==='capability_call')args=require('./capabilities.cjs').normalizeArguments(a,args);return evidence.hash({job:job.id,project:job.projectId||null,permission:job.executionState?.permissionRevision||0,...require('./operation-ledger.cjs').normalize(tool,args)});}
function facts(tool,result){
 if(!result||typeof result!=='object')return result;
 if(tool==='read_output_state')return {tasks:result.tasks?.map(t=>({taskId:t.taskId,status:t.status,needsReplan:!!t.needsReplan,steps:t.steps?.map(s=>({key:s.key,kind:s.kind,done:s.done,content:t.artifacts?.find(a=>a.id===s.artifactId)?.contentHash})),current:t.artifacts?.filter(a=>a.current).map(a=>a.contentHash)}))};
 if(tool==='platform_inventory')return {...result,queries:result.queries?.map(({at,...q})=>q),failures:result.failures?.map(({at,...f})=>f)};
 if(tool==='github_read'){const {revision,updatedAt,...value}=result;return {...value,comments:value.comments?.map(({updatedAt,...c})=>c)};}
 return result;
}
function observe(a,job,tool,args,result){
 if(get(tool).effect!=='read')return result;
 const state=require('./operation-ledger.cjs').state(job),key=request(job,tool,args,a);
 const sourceIds=[result?.sourceId,...(result?.results||[]).map(r=>r.sourceId)].filter(Boolean);
 const sources=sourceIds.map(id=>a.data.sources.find(s=>s.id===id)).filter(Boolean);
 const value=sources.length?evidence.versions(sources,null,job):facts(tool,result);
 const fingerprint=evidence.hash(value),old=state.reads[key];
 const unchanged=old?.fingerprint===fingerprint;
 state.reads[key]={tool,fingerprint,observations:(old?.observations||0)+1,unchanged,sourceIds,checkedAt:new Date().toISOString(),coverage:result?.coverage|| (sources.some(s=>s.truncated)?'partial':'unspecified')};
 if(unchanged)state.reusedReads=(state.reusedReads||0)+1;
 return result;
}
module.exports={parameters,readFields,facts,registry,get,request,observe};
