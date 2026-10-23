'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),grounding=require('../desktop/grounding.cjs'),input=require('../desktop/model-input.cjs');
const sourceText='0.1 0.2（单位 kg，前项除以后项，半偶舍入，保留两位小数）\n仅计已验收记录。';
const resultText='比率为 0.50。仅计已验收记录。';
async function setup(t,chat){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-recovery-integration-'));
 t.after(()=>{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const a=new Assistant({dir,chat});a.data.settings.evidenceGrounding=true;a.contextOptimizationOverrides={B:false};
 a.addSources([{title:'原始计量记录',content:sourceText}]);const source=a.data.sources[0];
 const task=a.createTask({title:'计算说明',description:'按原始计量记录求两项数值之比',criteria:'明确比率，保留原始计数范围',sourceIds:[source.id],generationMode:'single',steps:[{title:'计算说明',kind:'draft'}]});
 await a.dispatch('saveProvider',{name:'离线协议模型',baseUrl:'http://127.0.0.1:1/v1',model:'offline-fixture',inputPrice:0,outputPrice:0,key:'fixture-only-no-network'});
 const request=scale=>({tool:'compute_evidence',operation:'ratio',inputs:[{sourceId:source.id,start:0,end:3,unit:'kg'},{sourceId:source.id,start:4,end:7,unit:'kg'}],args:{scale,rounding:'half_even'}});
 return {a,task,source,request};
}
function report(f,c){
 const s=grounding.snapshot(f.a,f.task),artifact=s.artifacts[0],receipt=c.toolEvidence.find(r=>r.operation==='ratio');
 assert.equal(c.groundingReviewRequest.reused,false);assert.equal(receipt.output.value,'0.50');
 assert.equal(c.artifacts.find(r=>r.id===artifact.id).content,resultText);
 return {passed:true,summary:'完整独立核对了比率、原文范围及标题正文一致性',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[artifact.id],consistencyIssues:[],
  citations:[{id:'e-ratio',sourceId:receipt.id,quote:receipt.resultText},{id:'e-scope',sourceId:f.source.id,quote:'仅计已验收记录。',start:sourceText.indexOf('仅计已验收记录。')}],
  requirements:s.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['c-ratio','c-scope']})),
  claims:[{id:'c-ratio',artifactId:artifact.id,text:'比率为 0.50。',kind:'fact',supported:true,citationIds:['e-ratio']},{id:'c-scope',artifactId:artifact.id,text:'仅计已验收记录。',kind:'fact',supported:true,citationIds:['e-scope']}],unsupportedClaims:[],conflicts:[]}};
}
for(const phase of ['execute','verify'])test(`real Assistant ${phase} recovers a bad compute request, retains the sibling read and completes strict review`,async t=>{
 let f,loops=0,calls=0,reviews=0;const stages=[];
 f=await setup(t,async(_provider,_key,messages,options)=>{
  calls++;options.onUsage({inputTokens:100,outputTokens:20});const c=input.materialize(JSON.parse(messages[1].content));stages.push(options.stage);
  const current=c.groundingReviewRequest?'verify':'execute';
  if(current===phase){loops++;
   if(loops===1)return {kind:'read_context',requests:[f.request(100),{tool:'read_source',sourceId:f.source.id}]};
   if(loops===2){
    const failure=c.contextReads.find(row=>row.request?.tool==='compute_evidence'&&!row.result.ok).result;
    assert.equal(failure.code,'CONTEXT_INVALID_REQUEST');assert.equal(failure.recovery,'correct_request');assert.equal(failure.retryCondition,'request_changed');assert.ok(failure.safeAlternatives.length);assert.match(failure.message,/不是百分比倍率/);
    assert.equal((f.task.toolEvidence||[]).length,0,'failed request cannot create a receipt');assert.equal((c.toolEvidence||[]).length,0);
    assert.equal(c.contextReads.find(row=>row.request?.tool==='read_source').result.ok,true);
    assert.ok(f.task.generationReads.some(row=>row.result.sourceId===f.source.id&&row.result.ok),'successful sibling was persisted before the next call');
    const reading=f.task.contextReadsLedger.reading;assert.equal(Object.keys(reading.toolCoverage||{}).length,0);for(const bucket of Object.values(reading.checks||{}))assert.equal(Object.keys(bucket.toolCoverage||{}).length,0);
    return {kind:'read_context',requests:[f.request(2)]};
   }
   assert.equal(loops,3);assert.equal(f.task.toolEvidence.length,1);assert.equal(c.toolEvidence[0].output.value,'0.50');assert.ok(require('../desktop/tool-evidence.cjs').valid(f.a,f.task,f.task.toolEvidence[0]));
  }
  if(current==='execute')return {kind:'artifact',title:'计算说明',content:resultText};
  reviews++;return report(f,c);
 });
 await f.a.dispatch('advance',{id:f.task.id});await f.a.runPromise;
 assert.equal(f.task.status,'review',f.task.lastError||f.task.verification?.gaps?.join('\n'));assert.equal(f.task.grounding.passed,true);assert.equal(f.task.verification.passed,true);
 assert.equal(calls,4);assert.equal(loops,3);assert.equal(reviews,1);assert.equal(f.a.data.modelCalls.length,4);assert.equal(f.a.data.modelCalls.reduce((n,r)=>n+r.inputTokens+r.outputTokens,0),480);
 assert.equal(stages.filter(s=>s==='task_work').length,phase==='execute'?3:1);assert.equal(stages.filter(s=>s==='task_verify').length,phase==='verify'?3:1);
 assert.equal(f.task.contextDiagnostics.length,1);assert.equal(f.task.toolEvidence.length,1);assert.equal(f.task.grounding.claims.find(c=>c.id==='c-ratio').citations[0].evidenceType,'tool');assert.equal(f.a.data.artifacts.length,1);
 const saved=JSON.parse(fs.readFileSync(path.join(f.a.dir,'workspace.json'),'utf8')).tasks.find(task=>task.id===f.task.id);assert.equal(saved.grounding.passed,true);assert.equal(saved.toolEvidence.length,1);
});
test('actual model-call accounting cannot be renewed by repeating the same bad tool request',async t=>{
 let f,calls=0;f=await setup(t,async(_provider,_key,_messages,options)=>{calls++;assert.ok(calls<=2,'existing local correction allowance must stop dispatch');options.onUsage({inputTokens:100,outputTokens:20});return {kind:'read_context',requests:[f.request(100),...(calls===1?[{tool:'read_source',sourceId:f.source.id}]:[])]};});
 await f.a.dispatch('advance',{id:f.task.id});await f.a.runPromise;
 assert.equal(calls,2);assert.equal(f.a.data.modelCalls.length,2);assert.equal(f.task.contextDiagnostics.length,1);assert.equal((f.task.toolEvidence||[]).length,0);assert.equal(f.a.data.artifacts.length,0);assert.notEqual(f.task.status,'review');assert.notEqual(f.task.verification?.passed,true);assert.match(f.task.lastError,/内部资料读取纠偏已尝试/);assert.ok(f.task.generationReads.some(row=>row.result.ok&&row.result.sourceId===f.source.id));
});
test('revocation while the actual model corrects its request stops before computation or review',async t=>{
 let f,calls=0,revoked=false;f=await setup(t,async(_provider,_key,messages,options)=>{calls++;assert.ok(calls<=2);options.onUsage({inputTokens:100,outputTokens:20});if(calls===1)return {kind:'read_context',requests:[f.request(100),{tool:'read_source',sourceId:f.source.id}]};const c=input.materialize(JSON.parse(messages[1].content));assert.equal(c.contextReads.find(row=>!row.result.ok).result.recovery,'correct_request');f.a.contextAccessCheck=()=>({allowed:false,decision:'deny',revision:2});revoked=true;return {kind:'read_context',requests:[f.request(2)]};});
 await f.a.dispatch('advance',{id:f.task.id});await f.a.runPromise;
 assert.equal(calls,2);assert.equal(revoked,true);assert.equal(f.a.data.modelCalls.length,2);assert.equal((f.task.toolEvidence||[]).length,0);assert.equal(f.a.data.artifacts.length,0);assert.notEqual(f.task.status,'review');assert.notEqual(f.task.verification?.passed,true);assert.match(f.task.lastError,/范围|依据已变化|权限/);assert.ok(f.task.generationReads.some(row=>row.result.ok&&row.result.sourceId===f.source.id));
});
