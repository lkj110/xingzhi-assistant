'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup}=require('./helpers/tool-observation-fixture.cjs'),tool=require('../desktop/tool-evidence.cjs'),generation=require('../desktop/generation-context.cjs');
const noReader=()=>{throw Error('unexpected source read');};
test('status request shapes fail before any file or remote refresh, without guessing an action ID',async t=>{
 const f=await setup(t),writes=require('../desktop/agent-writes.cjs');let reads=0;
 t.mock.method(writes,'observeRecordedFile',()=>{reads++;throw Error('must not read');});t.mock.method(writes,'readRecordedDelivery',async()=>{reads++;throw Error('must not read');});
 const cases=[{args:{actionId:f.action.id}},{actionId:f.action.id,args:{actionId:'other'}},{actionId:f.action.id,args:[]},{actionId:f.action.id,args:null},{actionId:f.action.id,inputs:{}},{actionId:f.action.id,inputs:[{}]},{actionId:null},{actionId:7},{actionId:' '},{actionId:' '+f.action.id},{actionId:f.action.id,output:{status:'verified'}}];
 for(const operation of ['action_status','file_observation'])for(const change of cases){
  const request={tool:'compute_evidence',operation,...change},copy=structuredClone(request),batch=await tool.readRequests(f.a,f.task,[request],noReader);
  assert.equal(batch.rows[0].result.code,'CONTEXT_INVALID_REQUEST');assert.equal(batch.rows[0].result.recovery,'correct_request');assert.equal(batch.rows[0].result.retryCondition,'request_changed');assert.deepEqual(request,copy);assert.equal(batch.toolEvidence,undefined);
 }
 assert.equal(reads,0);assert.equal(f.task.toolEvidence,undefined);assert.equal(f.task.toolExecutions,undefined);
});

for(const role of ['execute','verify'])test(role+' receives a correction then actual file evidence with unchanged scope',async t=>{
 const f=await setup(t);f.draft('本轮只读核验时，旧文件存在且正文与历史记录一致。');let calls=0;
 f.a.chat=async(_p,_k,m,o)=>{
  calls++;o.onUsage?.({inputTokens:10,outputTokens:5});const input=require('../desktop/model-input.cjs').materialize(JSON.parse(m[1].content));
  if(calls===1)return {kind:'read_context',requests:[{tool:'compute_evidence',operation:'action_status',args:{actionId:f.action.id}}]};
  if(calls===2){const result=input.contextReads.find(r=>!r.result.ok).result;assert.equal(result.code,'CONTEXT_INVALID_REQUEST');assert.match(result.message,/顶层 actionId/);assert.equal(f.task.toolExecutions,undefined);return {kind:'read_context',requests:[f.request]};}
  assert.equal(calls,3);assert.equal(input.toolEvidence[0].output.status,'readback_verified');assert.equal(f.task.toolExecutions.length,1);
  return role==='verify'?f.report(f.task.toolEvidence[0]).result:{kind:'artifact',title:'核对说明',content:'本轮只读核验时，旧文件存在且正文与历史记录一致。'};
 };
 const result=await generation.call(f.a,f.task,'',role==='verify'?f.a.context(f.task,{verification:true}):{},role);
 assert.equal(calls,3);assert.equal(role==='verify'?result.passed:result.kind,role==='verify'?true:'artifact',result.summary);assert.equal(f.task.contextDiagnostics.length,1);assert.equal(f.a.data.agentActions.length,1);
});

test('repeated nested action IDs stop at the existing correction budget',async t=>{
 const f=await setup(t);let calls=0;f.a.chat=async(_p,_k,_m,o)=>{calls++;assert.ok(calls<=2);o.onUsage?.({inputTokens:10,outputTokens:5});return {kind:'read_context',requests:[{tool:'compute_evidence',operation:'action_status',args:{actionId:f.action.id}}]};};
 await assert.rejects(generation.call(f.a,f.task,'',{}),e=>e.code==='CONTEXT_INVALID_REQUEST'&&e.noProgress);assert.equal(calls,2);assert.equal(f.task.toolEvidence,undefined);
});

test('well-formed but out-of-scope actions and withdrawn access remain hard failures',async t=>{
 const f=await setup(t);
 await assert.rejects(tool.readRequests(f.a,f.task,[{...f.request,actionId:'other'}],noReader),e=>e.code==='CONTEXT_SCOPE_DENIED');
 f.job.folderIds=[];await assert.rejects(tool.readRequests(f.a,f.task,[f.request],noReader),/授权/);assert.equal(f.task.toolEvidence,undefined);assert.equal(f.task.toolExecutions,undefined);
});
