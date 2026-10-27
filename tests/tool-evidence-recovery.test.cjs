'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),tool=require('../desktop/tool-evidence.cjs'),generation=require('../desktop/generation-context.cjs');
const protocol=require('../desktop/task-context.cjs'),{contextError}=require('../desktop/model-errors.cjs');
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-recovery-'));
 t.after(()=>{assert.ok(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const a=new Assistant({dir});a.data.settings.evidenceGrounding=true;a.contextOptimizationOverrides={B:false};
 a.addSources([{title:'计量依据',content:'0.1 0.2，质量单位 kg，比率保留两位小数，半偶舍入。'}]);
 const source=a.data.sources[0],task=a.createTask({title:'比率',description:'求第一项与第二项的比率',criteria:'依据给定精度',sourceIds:[source.id],steps:[{title:'计算',kind:'draft'}]});
 const request=scale=>({tool:'compute_evidence',operation:'ratio',inputs:[{sourceId:source.id,start:0,end:3,unit:'kg'},{sourceId:source.id,start:4,end:7,unit:'kg'}],args:{scale,rounding:'half_even'}});
 return {a,task,source,request};
}
const noReader=()=>{throw Error('unexpected normal reader');};
test('invalid scale is an explicit correction row, never evidence or fresh progress',async t=>{
 const f=setup(t),request=f.request(100),batch=await tool.readRequests(f.a,f.task,[request],noReader),row=batch.rows[0];
 assert.deepEqual(row.request,request);assert.equal(row.result.ok,false);assert.equal(row.result.code,'CONTEXT_INVALID_REQUEST');
 assert.equal(row.result.recovery,'correct_request');assert.equal(row.result.retryCondition,'request_changed');assert.ok(row.result.safeAlternatives.length);
 assert.match(row.result.message,/小数位数 0–12，不是百分比倍率/);assert.equal(batch.complete,false);assert.equal(batch.toolEvidence,undefined);assert.equal(f.task.toolEvidence,undefined);
 const progress=protocol.recordReadResults({},batch.rows,{});assert.equal(progress.fresh,0);assert.equal(progress.failed,1);
});
test('mixed batches preserve successful computation, normal reads and original failed request',async t=>{
 const f=setup(t),good=f.request(2),bad=f.request(100),normal={tool:'read_source',sourceId:f.source.id};
 const batch=await tool.readRequests(f.a,f.task,[bad,good,normal],requests=>generation.readBatch(f.a,f.task,requests));
 assert.equal(batch.rows.length,3);assert.equal(batch.complete,false);assert.equal(batch.toolEvidence.length,1);assert.equal(batch.toolEvidence[0].output.value,'0.50');
 assert.equal(batch.rows.find(row=>row.request.tool==='read_source').result.ok,true);assert.equal(batch.rows.find(row=>row.request.args?.scale===100).result.ok,false);
 assert.equal(batch.rows.find(row=>row.request.args?.scale===2).result.computedEvidence.output.value,'0.50');assert.equal(batch.pageRows.length,1);assert.equal(batch.used.length,1);
 assert.equal(f.task.toolEvidence.length,1);assert.equal(f.task.generationReads.length,1);
 const persisted=JSON.parse(fs.readFileSync(path.join(f.a.dir,'workspace.json'),'utf8')).tasks.find(row=>row.id===f.task.id);assert.equal(persisted.toolEvidence.length,1);assert.equal(persisted.generationReads.length,1);
});
for(const role of ['execute','verify'])test(`${role} model sees one parameter error, corrects it, then receives a valid receipt`,async t=>{
 const f=setup(t);let calls=0;
 f.a.call=async(_role,system,input)=>{
  const c=require('../desktop/model-input.cjs').materialize(input);calls++;
  assert.match(system,/scale 是 0–12 的小数位数，不是百分比倍率/);
  if(calls===1)return {kind:'read_context',requests:[f.request(100)]};
  if(calls===2){const failure=c.contextReads.find(row=>!row.result.ok).result;assert.equal(failure.code,'CONTEXT_INVALID_REQUEST');assert.equal(failure.recovery,'correct_request');assert.ok(failure.safeAlternatives.length);assert.equal(f.task.contextDiagnostics.length,1);return {kind:'read_context',requests:[f.request(2)]};}
  assert.equal(calls,3);assert.equal(c.toolEvidence[0].output.value,'0.50');assert.equal(c.contextReads.find(row=>row.result.computedEvidence).result.computedEvidence.output.value,'0.50');
  return role==='verify'?{passed:false,summary:'已读正确工具结果，测试没有交付稿',gaps:['缺少交付稿']}:{kind:'artifact',content:'比率为 0.50。'};
 };
 const result=await generation.call(f.a,f.task,'',{},role);assert.equal(calls,3);assert.equal(role==='verify'?result.passed:result.kind,role==='verify'?false:'artifact');assert.equal(f.task.toolEvidence.length,1);assert.equal(f.task.contextDiagnostics.length,1);
});
test('repeated invalid requests exhaust existing correction allowance without a new loop',async t=>{
 const f=setup(t);let calls=0;f.a.call=async()=>{calls++;assert.ok(calls<=2);return {kind:'read_context',requests:[f.request(100)]};};
 await assert.rejects(generation.call(f.a,f.task,'',{}),e=>e.code==='CONTEXT_INVALID_REQUEST'&&e.noProgress);
 assert.equal(calls,2);assert.equal(f.task.contextDiagnostics.length,1);assert.equal(f.task.toolEvidence,undefined);
});
test('verification repetition uses one existing bounded finalization',async t=>{
 const f=setup(t);let calls=0;
 f.a.call=async(_role,_system,input,options)=>{calls++;assert.ok(calls<=3);if(calls<3)return {kind:'read_context',requests:[f.request(100)]};assert.ok(options.boundedFinalization);assert.equal(input.checkFinalization.reason,'local_correction_exhausted');return {passed:false,summary:'参数仍无效，未完成求证',gaps:['计算精度无效']};};
 const result=await generation.call(f.a,f.task,'',{},'verify');assert.equal(result.passed,false);assert.equal(calls,3);assert.equal(f.task.toolEvidence,undefined);assert.equal(Object.values(f.task.contextFinalizations).length,1);
});
test('scope denial is a hard failure, even with a sibling parameter error',async t=>{
 const f=setup(t);f.a.contextAccessCheck=()=>({allowed:false,decision:'deny',revision:2});
 await assert.rejects(tool.readRequests(f.a,f.task,[{tool:'compute_evidence',operation:'ratio',inputs:[],args:{}},f.request(2)],noReader),e=>e.code==='CONTEXT_SCOPE_DENIED');assert.equal(f.task.toolEvidence,undefined);
});
for(const code of ['CONTEXT_VERSION_CHANGED','CONTEXT_INVALID_REQUEST'])test(`reader ${code} is not mistaken for a tool parameter error`,async t=>{
 const f=setup(t),failure=contextError(code,{message:'reader failed'}),withContext=protocol.withContext;
 t.mock.method(protocol,'withContext',(a,scope,callback,options)=>withContext(a,scope,op=>callback({...op,resolveRead(){throw failure;}}),options));
 await assert.rejects(tool.readRequests(f.a,f.task,[f.request(2)],noReader),e=>e===failure);assert.equal(f.task.toolEvidence,undefined);
});
for(const mode of ['version','paused','cancelled','abort'])test(`${mode} during model response remains a hard failure`,async t=>{
 const f=setup(t);let calls=0;f.a.controller=new AbortController();f.a.call=async()=>{calls++;if(mode==='version')f.source.content+=' changed';if(mode==='paused')f.task.status='paused';if(mode==='cancelled')f.task.agentCancelled=true;if(mode==='abort')f.a.controller.abort();return {kind:'read_context',requests:[f.request(100)]};};
 // Snapshot/scope validation precedes the execution gate on this response path.
 await assert.rejects(generation.call(f.a,f.task,'',{}),e=>mode==='abort'?e.name==='AbortError':e.code===(mode==='cancelled'?'CONTEXT_SCOPE_DENIED':'CONTEXT_VERSION_CHANGED'));assert.equal(calls,1);assert.equal(f.task.toolEvidence,undefined);assert.equal(f.task.contextDiagnostics,undefined);
});
