'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),search=require('../desktop/evidence-search.cjs'),generation=require('../desktop/generation-context.cjs');
const protocol=require('../desktop/task-context.cjs'),{contextError}=require('../desktop/model-errors.cjs'),encoder=require('../desktop/evidence-encoder.cjs');
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-recovery-'));
 t.after(()=>{assert.ok(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const a=new Assistant({dir});a.data.settings.evidenceGrounding=true;a.contextOptimizationOverrides={C:false};
 a.addSources([{title:'办公规定',content:'# 地点\n\n员工可在家办公。\n\n例外：涉密岗位须到公司。'}]);
 const source=a.data.sources[0],task=a.createTask({title:'办公安排',description:'说明地点及例外',criteria:'保留限制',sourceIds:[source.id],steps:[{title:'撰写',kind:'draft'}]});
 // Protocol recovery tests do not load the CPU encoder or call a real model.
 let encoded=0;t.mock.method(encoder,'encode',async texts=>{encoded++;return texts.map(()=>[1,0]);});
 const request=limit=>({tool:'search_evidence',query:'办公规定',limit});return {a,task,source,request,encoded:()=>encoded};
}
test('invalid search limit returns one correction row and never starts inference',async t=>{
 const f=setup(t),request=f.request(4),batch=await search.readRequests(f.a,f.task,[request],generation.readBatch),row=batch.rows[0];
 assert.equal(batch.rows.length,1);assert.deepEqual(row.request,request);assert.equal(row.result.ok,false);assert.equal(row.result.code,'CONTEXT_INVALID_REQUEST');assert.equal(row.result.recovery,'correct_request');assert.equal(row.result.retryCondition,'request_changed');assert.ok(row.result.safeAlternatives.length);assert.match(row.result.message,/limit 为 1–3/);
 assert.equal(f.encoded(),0);assert.deepEqual(batch.searches,[]);assert.equal(batch.complete,false);assert.equal(batch.pageRows.length,0);
 const progress=protocol.recordReadResults({},batch.rows,{});assert.equal(progress.fresh,0);assert.equal(progress.failed,1);
});
test('bad search preserves successful search groups and ordinary read siblings',async t=>{
 const f=setup(t),bad=f.request(4),good=f.request(1),normal={tool:'read_source',sourceId:f.source.id};
 const batch=await search.readRequests(f.a,f.task,[bad,good,normal],generation.readBatch);
 assert.equal(batch.searches.length,1);assert.deepEqual(batch.searches[0].request,good);assert.ok(batch.searches[0].groups.length);assert.ok(batch.searches[0].groups.every(g=>g.state==='read_pending_model_visibility'));
 assert.equal(batch.rows.find(row=>row.request.tool==='read_source').result.ok,true);assert.equal(batch.rows.find(row=>row.request.tool==='search_evidence').result.ok,false);assert.equal(batch.complete,false);assert.ok(batch.pageRows.length>=2);
 assert.match(batch.rows.filter(row=>row.result.ok).map(row=>row.result.content||'').join('\n'),/涉密/);assert.ok(f.task.generationReads.length>=2);
 const plan=search.consumePlan([{readRequests:[bad],gap:''},{readRequests:[good],gap:''}],batch);assert.deepEqual(plan[0].readRequests,[bad]);assert.match(plan[0].gap,/limit 为 1–3/);assert.deepEqual(plan[1].readRequests,[]);
});
for(const role of ['execute','verify'])test(`${role} corrects a search limit after seeing the local failure`,async t=>{
 const f=setup(t);let calls=0;f.a.call=async(_role,system,input)=>{calls++;const c=require('../desktop/model-input.cjs').materialize(input);if(system.includes('本轮改为形成检查结论'))assert.doesNotMatch(system,/limit 为 1–3/);else assert.match(system,/limit 为 1–3/);
  if(calls===1)return {kind:'read_context',requests:[f.request(4)]};
  if(calls===2){assert.equal(c.contextReads.find(row=>!row.result.ok).result.recovery,'correct_request');assert.equal(f.task.contextDiagnostics.length,1);assert.equal(f.encoded(),0);return {kind:'read_context',requests:[f.request(1)]};}
  assert.equal(calls,3);assert.ok(c.hybridSearch[0].groups.length);assert.match(c.contextReads.map(row=>row.result.content||'').join('\n'),/涉密/);return role==='verify'?{passed:false,summary:'已读原文，测试无交付稿',gaps:['缺少交付稿']}:{kind:'artifact',content:'员工可在家办公，涉密岗位须到公司。'};
 };
 const result=await generation.call(f.a,f.task,'',{},role);assert.equal(calls,3);assert.equal(role==='verify'?result.passed:result.kind,role==='verify'?false:'artifact');assert.equal(f.task.contextDiagnostics.length,1);
});
test('same invalid search cannot renew the existing correction budget',async t=>{
 const f=setup(t);let calls=0;f.a.call=async()=>{calls++;assert.ok(calls<=2);return {kind:'read_context',requests:[f.request(4)]};};
 await assert.rejects(generation.call(f.a,f.task,'',{}),e=>e.code==='CONTEXT_INVALID_REQUEST'&&e.noProgress);assert.equal(calls,2);assert.equal(f.encoded(),0);assert.equal(f.task.contextDiagnostics.length,1);
});
test('repeated invalid verification search consumes only one bounded finalization',async t=>{
 const f=setup(t);let calls=0;f.a.call=async(_role,_system,input,options)=>{calls++;assert.ok(calls<=3);if(calls<3)return {kind:'read_context',requests:[f.request(4)]};assert.ok(options.boundedFinalization);assert.equal(input.checkFinalization.reason,'local_correction_exhausted');return {passed:false,summary:'检索参数仍无效',gaps:['检索未完成']};};
 const result=await generation.call(f.a,f.task,'',{},'verify');assert.equal(result.passed,false);assert.equal(calls,3);assert.equal(Object.values(f.task.contextFinalizations).length,1);assert.equal(f.encoded(),0);
});
test('unknown source remains a scope failure after a sibling bad request',async t=>{
 const f=setup(t);await assert.rejects(search.readRequests(f.a,f.task,[f.request(4),{...f.request(1),sourceId:'foreign'}],generation.readBatch),e=>e.code==='CONTEXT_SCOPE_DENIED');assert.equal(f.encoded(),0);
});
for(const code of ['CONTEXT_VERSION_CHANGED','CONTEXT_INVALID_REQUEST'])test(`search reader ${code} remains a hard error`,async t=>{
 const f=setup(t),failure=contextError(code,{message:'reader failed'}),withContext=protocol.withContext;
 t.mock.method(protocol,'withContext',(a,scope,callback,options)=>withContext(a,scope,op=>callback({...op,resolveRead(){throw failure;}}),options));
 await assert.rejects(search.readRequests(f.a,f.task,[f.request(1)],generation.readBatch),e=>e===failure);assert.equal(f.encoded(),0);
});
for(const mode of ['permission','version','paused','cancelled','abort'])test(`${mode} during async search prevents returning results`,async t=>{
 const f=setup(t);f.a.controller=new AbortController();t.mock.method(encoder,'encode',async texts=>{if(mode==='permission')f.a.contextAccessCheck=()=>({allowed:false,decision:'deny',revision:2});if(mode==='version')f.source.content+=' changed';if(mode==='paused')f.task.status='paused';if(mode==='cancelled')f.task.agentCancelled=true;if(mode==='abort')f.a.controller.abort();return texts.map(()=>[1,0]);});
 await assert.rejects(search.readRequests(f.a,f.task,[f.request(1)],generation.readBatch),e=>mode==='abort'?e.name==='AbortError':e.code===(mode==='cancelled'?'CONTEXT_SCOPE_DENIED':'CONTEXT_VERSION_CHANGED'));assert.equal(f.task.generationReads,undefined);
});
