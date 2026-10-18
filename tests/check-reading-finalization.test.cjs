'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const generation=require('../desktop/generation-context.cjs'),protocol=require('../desktop/task-context.cjs');
const reading=require('../desktop/check-reading.cjs'),finalization=require('../desktop/check-finalization.cjs');
const work=require('../desktop/work-efficiency.cjs'),input=require('../desktop/model-input.cjs'),view=require('../desktop/context-evidence.cjs');
const hash=require('../desktop/evidence-basis.cjs').hash,access=require('../desktop/protocol-access.cjs');
const deny=()=>{throw Error('R2 fixture forbids real model/network');},restore=[];
for(const [object,key] of [[globalThis,'fetch'],[require('node:http'),'request'],[require('node:http'),'get'],[require('node:https'),'request'],[require('node:https'),'get'],[require('node:net').Socket.prototype,'connect']]){const old=object[key];object[key]=deny;restore.push(()=>object[key]=old);}
after(()=>restore.forEach(fn=>fn()));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r2-check-')),options={dir,chat:deny,connectorRequest:deny,platformRequest:deny,webRequest:deny};
 const a=new Assistant(options);t.after(()=>{require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={execute:'fixture',verify:'fixture',organize:'fixture'};
 const job=agent.buildJob(a,{goal:'检查原稿现有事实',autoAccept:false});a.data.delegations.push(job);a.activeAgentJob=job;
 const task=a.createTask({title:'原稿检查',criteria:'保留事实',steps:[{title:'正文',kind:'draft'}]});task.agentJobId=job.id;job.taskIds=[task.id];
 const source=(id,content,extra={})=>{const s={id,title:id,content,projectId:null,...extra};a.data.sources.push(s);task.sourceIds.push(id);job.sourceIds.push(id);access.retain(a,'source',s,{task,job});return s;};
 const artifact={id:'draft',title:'原稿',taskId:task.id,stepId:task.steps[0].id,content:'当前原稿',createdAt:'2026-01-01'};
 a.data.artifacts.push(artifact);access.retain(a,'artifact',artifact,{task,job});Object.assign(task.steps[0],{done:true,artifactId:artifact.id});task.primaryArtifactId=artifact.id;
 work.before(a,job);const state=job.executionState.workEfficiency;Object.assign(state,{attempts:9,tried:{old:2},history:[{id:'legacy-failure'}]});
 const cost=require('../desktop/spend.cjs').scope(a);Object.assign(cost,{limitUSD:200,spentUSD:153,heldUSD:3});require('../desktop/spend.cjs').persist(a);a.save();
 return {a,job,task,source,artifact,state,cost,dir,options};
}
const request=(id,extra={})=>({tool:'read_source',sourceId:id,...extra});
const initial={verificationPhase:'content'};
const conclusion={passed:false,summary:'保留原稿，尚缺具体证据',gaps:['未核实映射'],gapDetails:[{text:'未核实映射'}]};
const isFinal=system=>system.includes('本轮改为形成检查结论');
const ledger=f=>f.state.reading?.[f.task.id];
const raw=(f,requests,options)=>protocol.readContextBatch(f.a,protocol.taskScope(f.task),requests,options);
const record=(f,state,rows,context={},options={})=>protocol.recordReadResults(state,rows,context,{semanticCheckId:generation.finalizationState(f.a,f.task,{initial}).semanticCheckId,...options});
function force(t,f,overrides={}){
 const state=generation.finalizationState(f.a,f.task,{initial});
 t.mock.method(require('../desktop/pending-check.cjs'),'claim',()=>({forceFinalization:{semanticCheckId:state.semanticCheckId,repairCommandId:'approved-repair',reason:'internal_context_authorization',...overrides}}));
 return state;
}
function noise(seed,n){let x=seed;return Array.from({length:n},()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return String.fromCharCode(33+(x%90));}).join('');}

test('canonical original coordinates survive pagination, overlap, ref/search/segment/section aliases and repeated text',t=>{
 const f=fixture(t),body='## Alpha\nfirst needle\n\n## Beta\nsecond needle\n\nrepeat\n\nrepeat';f.source('s',body);
 const state={},full=raw(f,[request('s')]).rows[0],c=reading.coverage(full.result);
 assert.deepEqual(c.ranges,[[0,21],[23,44],[46,52],[54,60]].map(([s,e])=>[s,Math.min(e,body.length)]));
 const first=record(f,state,[full]);assert.equal(first.fresh,1);
 const visible=input.prepare({contextReads:[full]},{stage:'task_verify'});
 for(const q of [request('s',{limit:1}),{tool:'read_source',ref:full.result.ref,start:1,limit:2},{tool:'search_source',sourceId:'s',query:'needle Alpha'}, {tool:'read_segment',sourceId:'s',index:0,start:3},{tool:'read_section',sourceId:'s',title:'Alpha',start:3}]){
  const result=record(f,state,raw(f,[q]).rows,visible);assert.equal(result.freshChars,0,JSON.stringify(q));
 }
 const segment=raw(f,[{tool:'read_segment',sourceId:'s',index:1,start:4}],{maxChars:8}).rows[0];
 assert.deepEqual(reading.coverage(segment.result).ranges,[[body.indexOf('## Beta')+4,body.indexOf('## Beta')+12]]);
 assert.equal(record(f,state,[segment],visible).fresh,0);
});

test('real A/B/C model-input budget projections permit only each original interval first recovery and then conclude',async t=>{
 const f=fixture(t);for(const [i,id] of ['A','B','C'].entries())f.source(id,noise(i+1,90000));
 work.before(f.a,f.job);Object.assign(f.state,{attempts:9,phase:'recovering',active:{id:'cached:fixture',reads:7,attempts:2,inFlight:{tool:'advance_task'},queue:[]}});
 let calls=0,finals=0,omissions=0;const restored=[];
 f.a.call=async(_role,system,modelInput)=>{
  calls++;assert.ok(input.encodedSize(modelInput)<=input.DEFAULT_MAX);
  omissions+=(modelInput.readBodyBudget?.omissions.length||0);
  if(ledger(f))restored.push(Object.values(ledger(f).checks)[0].lastBatch.restoredChars);
  if(isFinal(system)){finals++;const durable=JSON.parse(fs.readFileSync(f.a.file)).tasks.find(x=>x.id===f.task.id);assert.equal(Object.values(durable.contextFinalizations)[0].status,'started');return conclusion;}
  assert.ok(calls<25,'restoration must converge');
  const id=['A','B','C'][(calls-1)%3];
  const q=request(id,{limit:calls%2?1:6});
  return {kind:'read_context',requests:[q]};
 };
 assert.deepEqual(await generation.call(f.a,f.task,'',initial,'verify'),conclusion);
 assert.equal(finals,1);assert.ok(omissions>0);assert.ok(restored.some(n=>n>0));assert.ok(calls<25);
 assert.equal(f.state.attempts,9);assert.equal(f.state.tried.old,2);assert.equal(f.cost.spentUSD,153);assert.equal(f.cost.heldUSD,3);
 const check=Object.values(ledger(f).checks)[0];for(const [key,ranges] of Object.entries(check.restoredCoverage))assert.deepEqual(reading.subtract(ranges,check.seenCoverage[key]),[]);
 t.diagnostic(`A/B/C: ${calls} model inputs; ${restored.filter(n=>n>0).length} bounded recovery batches, ${omissions} actual omitted spans`);
});

test('overlapping recovery is only a difference, repeated siblings cannot renew it, and fresh siblings survive old debt',t=>{
 const f=fixture(t);f.source('s','## Head\n'+noise(2,1000));f.source('new','new body');const state={};
 const first=raw(f,[{tool:'read_section',sourceId:'s',title:'Head'}],{maxChars:600}).rows;
 assert.equal(record(f,state,first).freshChars,600);
 const overlap=raw(f,[{tool:'read_section',sourceId:'s',title:'Head',start:300}],{maxChars:600}).rows;
 const next=record(f,state,overlap);assert.equal(next.freshChars,300);assert.equal(next.restoredChars,300);
 const repeat=record(f,state,[...overlap,...overlap]);assert.equal(repeat.freshChars,0);assert.equal(repeat.restoredChars,300);
 assert.equal(record(f,state,overlap).restoredChars,0);
 state.ineffective=30;
 const mixed=record(f,state,[...overlap,...raw(f,[request('new')]).rows]);assert.equal(mixed.exhausted,false);assert.equal(mixed.fresh,1);assert.equal(state.ineffective,31);
 assert.equal(record(f,state,overlap).exhausted,true);
});

test('historical unproved restoration is consumed; inconsistent and ambiguous legacy bodies never get credit',t=>{
 const f=fixture(t);f.source('s','known');f.source('bad','actual text',{segments:[{id:'p',text:'other text'}]});f.source('ambiguous','again again',{segments:[{id:'p',text:'again'}]});
 const old=raw(f,[request('s')]).pageRows;for(const row of old){delete row.result.canonical;for(const s of row.result.segments)delete s.sourceStart;delete row.bodyHash;}
 const historyRows=protocol.withContext(f.a,protocol.taskScope(f.task),op=>old.map(r=>op.canonicalRead(r)));
 const state={coverage:{old:true},contentCoverage:{old:true},ineffective:2,batches:5};const snapshot=structuredClone(state.coverage);
 const r=record(f,state,raw(f,[request('s')]).rows,{}, {historyRows});assert.equal(r.fresh+r.restored,0);assert.equal(r.exhausted,true);assert.deepEqual(state.coverage,snapshot);
 for(const id of ['bad','ambiguous']){const result=record(f,state,raw(f,[request(id)]).rows);assert.equal(result.unmapped,1);assert.equal(result.fresh+result.restored,0);}
});

test('nineteen proven current-generation reads remain available to both verification phases despite inherited ineffective debt',async t=>{
 const f=fixture(t),ids=Array.from({length:19},(_,i)=>'source-'+i);
 for(const [i,id] of ids.entries())f.source(id,'UNIQUE_FACT_'+i+' '+noise(i+1,2400));
 for(let i=0;i<ids.length;i+=4)generation.readBatch(f.a,f.task,ids.slice(i,i+4).map(id=>request(id)));
 assert.ok(f.task.generationReads.every(row=>row.canonicalProof));
 work.before(f.a,f.job);Object.assign(f.state,{attempts:9,phase:'recovering',active:{id:'cached:fixture',reads:7,attempts:2,inFlight:{tool:'advance_task'},queue:[]},reading:{[f.task.id]:{coverage:{legacy:true},ineffective:8,batches:5}}});
 for(const phase of ['content','result']){
  let calls=0;const seen=new Set();
  f.a.call=async(_role,system,modelInput)=>{
   assert.equal(isFinal(system),false,'newly generated evidence must reach ordinary verification');
   for(const body of view.suppliedBodies(modelInput))for(const id of body.matchAll(/UNIQUE_FACT_(\d+)/g))seen.add(Number(id[1]));
   if(calls===5){assert.equal(seen.size,19,'all nineteen actual source bodies must have reached model inputs');calls++;return conclusion;}
   const requests=ids.slice(calls*4,calls*4+4).map(id=>request(id));calls++;return {kind:'read_context',requests};
  };
  const context={...f.a.context(f.task,{verification:true}),verificationPhase:phase};
  assert.deepEqual(await generation.call(f.a,f.task,'',context,'verify'),conclusion);assert.equal(calls,6);
 }
 assert.equal(f.task.contextFinalizations,undefined);assert.equal(ledger(f).ineffective,8);assert.equal(f.state.attempts,9);
 const cold=new Assistant(f.options),task=cold.task(f.task.id);
 assert.ok(protocol.withContext(cold,protocol.taskScope(task),op=>task.generationReads.every(row=>op.canonicalRead(row).restorationEligible)));
});

test('pure directories get only one navigation round across changing queries and cold state',async t=>{
 const f=fixture(t);f.source('s','fact');let calls=0;
 f.a.call=async(_role,system)=>{calls++;if(isFinal(system))return conclusion;return {kind:'read_context',requests:[{tool:'list_sources',query:calls%2?'s':'',limit:calls}]};};
 await generation.call(f.a,f.task,'',initial,'verify');assert.equal(calls,5);
 assert.equal(ledger(f).ineffective,3);assert.equal(Object.values(ledger(f).checks)[0].navigationUsed,true);
 const cold=new Assistant(f.options),task=cold.task(f.task.id);assert.equal(generation.finalizationState(cold,task,{initial}).available,false);
 assert.equal(Object.values(cold.data.delegations.find(j=>j.id===f.job.id).executionState.workEfficiency.reading[task.id].checks)[0].navigationUsed,true);
});

test('coverage capacity stops credit without evicting old coverage or resetting counters',t=>{
 const f=fixture(t);f.source('s','fresh');const id=generation.finalizationState(f.a,f.task,{initial}).semanticCheckId;
 const old=Array.from({length:reading.LIMIT},(_,i)=>[i*2,i*2+1]);
 const state={ineffective:2,checks:{[id]:{seenCoverage:{old},restoredCoverage:{},navigationUsed:true,batches:1}}};
 const r=record(f,state,raw(f,[request('s')]).rows);assert.equal(r.saturated,true);assert.equal(r.exhausted,true);assert.deepEqual(state.checks[id].seenCoverage.old,old);
 assert.equal(record(f,state,raw(f,[request('s')]).rows).fresh,0);
});

test('finalization API is pure, shares the call identity and preserves the exact legacy algorithm',t=>{
 const f=fixture(t),context=f.a.context(f.task,{verification:true});f.a.save();const before=JSON.stringify(f.a.data),disk=fs.readFileSync(f.a.file);
 const state=generation.finalizationState(f.a,f.task,{initial:context});assert.deepEqual(Object.keys(state).sort(),['available','legacyKey','reason','semanticCheckId']);
 const prepared=generation.prepare(f.a,f.task,context),snapshot=protocol.buildContext(f.a,protocol.taskScope(f.task),'verify');
 assert.equal(state.legacyKey,hash({policy:'useful-siblings-final-check-1',role:'verify',checkPhase:'content',taskId:f.task.id,input:snapshot.inputBasis,artifact:prepared.artifacts,revision:prepared.revision,workingDraft:prepared.workingDraft}));
 assert.equal(generation.READ_POLICY_VERSION,'useful-siblings-final-check-1');assert.equal(JSON.stringify(f.a.data),before);assert.deepEqual(fs.readFileSync(f.a.file),disk);
 f.a.activeAgentRun={id:'different-run'};assert.equal(generation.finalizationState(f.a,f.task,{initial:{...context,currentTime:'other'}}).semanticCheckId,state.semanticCheckId);
 assert.notEqual(generation.finalizationState(f.a,f.task,{phase:'result',initial:context}).semanticCheckId,state.semanticCheckId);
 f.artifact.content+='new draft';assert.notEqual(generation.finalizationState(f.a,f.task,{initial:context}).semanticCheckId,state.semanticCheckId);
});

test('legacy statuses, exact keys, semantic identity and ambiguous same-phase history conservatively consume',t=>{
 const f=fixture(t),s=generation.finalizationState(f.a,f.task,{initial});
 for(const status of ['started','returned','failed','unknown'])for(const type of ['exact','semantic','ambiguous']){
  f.task.contextFinalizations={[type==='exact'?s.legacyKey:'old-key']:{status,checkPhase:'content',...(type==='semantic'?{semanticCheckId:s.semanticCheckId}:{})}};
  assert.equal(generation.finalizationState(f.a,f.task,{initial}).available,false,`${type}/${status}`);
 }
 f.task.contextFinalizations={old:{status:'returned',checkPhase:'result'}};assert.equal(generation.finalizationState(f.a,f.task,{initial}).available,true);
 f.task.contextFinalizations={old:{status:'returned'}};assert.equal(generation.finalizationState(f.a,f.task,{initial}).reason,'ambiguous_consumed');
 f.task.contextFinalizations={old:{status:'returned',phase:'result',checkPhase:'content'}};assert.equal(generation.finalizationState(f.a,f.task,{initial}).available,false);
 const snapshot=protocol.buildContext(f.a,protocol.taskScope(f.task),'verify'),identity=finalization.identity(f.a,f.task,generation.prepare(f.a,f.task,f.a.context(f.task,{verification:true})),snapshot,'content');
 f.task.contextFinalizations={old:{...identity,status:'returned'}};f.artifact.content+='real changed draft';assert.equal(generation.finalizationState(f.a,f.task).available,true);
});

test('an already supplied draft is visible evidence, not a restored page, including deduplicated references',t=>{
 const f=fixture(t),row=raw(f,[{tool:'read_artifact',artifactId:f.artifact.id}]).rows[0],state={};
 const projected=input.prepare({artifacts:[{id:f.artifact.id,content:f.artifact.content}],contextReads:[row]});
 const result=record(f,state,[row],projected);assert.equal(result.fresh+result.restored,0);
 const onlyDraft=input.prepare({artifacts:[{id:f.artifact.id,content:f.artifact.content}]});
 assert.equal(record(f,state,[row],onlyDraft).restored,0);
});

test('old consumed conclusions cannot be reissued as ordinary calls after a cold restart or policy metadata change',async t=>{
 const f=fixture(t);let calls=0;f.a.call=async()=>{calls++;return conclusion;};
 const identity=generation.finalizationState(f.a,f.task,{initial});
 for(const status of ['started','returned','failed','unknown']){
  f.task.contextFinalizations={old:{semanticCheckId:identity.semanticCheckId,status,checkPhase:'content',policy:'other-policy'}};
  await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>e.noProgress);
 }
 assert.equal(calls,0);f.a.save();const cold=new Assistant(f.options),task=cold.task(f.task.id);cold.call=f.a.call;
 await assert.rejects(generation.call(cold,task,'',initial,'verify'),e=>e.noProgress);assert.equal(calls,0);
});

test('mixed valid siblings and repeated local invalid parameters converge through the single bounded conclusion',async t=>{
 const f=fixture(t);f.source('s','SAVED_SUCCESS');let calls=0;
 const invalid={tool:'read_section',sourceId:'s',title:'missing'};
 f.a.call=async(_role,system,modelInput)=>{
  calls++;
  if(calls>1)assert.ok(view.suppliedBodies(modelInput).some(x=>x.includes('SAVED_SUCCESS')));
  if(isFinal(system)){assert.equal(calls,3);assert.match(system,/当前只检查内容/);assert.ok(modelInput.contextReads.some(r=>r.result.code==='CONTEXT_INVALID_REQUEST'));return conclusion;}
  return {kind:'read_context',requests:[invalid,request('s')]};
 };
 assert.deepEqual(await generation.call(f.a,f.task,'',initial,'verify'),conclusion);
 assert.equal(f.task.generationReads.length,2);assert.equal(Object.values(f.task.contextFinalizations)[0].reason,'local_correction_exhausted');
 assert.equal(Object.values(f.task.contextFinalizations)[0].status,'returned');assert.equal(f.job.executionState.recoveries[Object.keys(f.job.executionState.recoveries)[0]].result,'correction_returned');
});

for(const kind of ['scope','version','integrity','unknown_tool'])test('mixed local invalid + successful body + '+kind+' never takes the weak finalization route',async t=>{
 const f=fixture(t);f.source('s','SAVED_SUCCESS');let calls=0;
 if(kind==='integrity')f.source('broken',JSON.stringify({platformResult:{format:1}}),{platformSnapshot:true,platformArchive:{}});
 f.a.save();const savedBefore=fs.readFileSync(f.a.file,'utf8');
 const stronger=kind==='scope'?request('foreign'):kind==='version'?request('s',{version:'stale'}):kind==='integrity'?request('broken'):{tool:'unknown_local_tool',sourceId:'s'};
 f.a.call=async()=>{calls++;return {kind:'read_context',requests:[{tool:'read_section',sourceId:'s',title:'missing'},request('s'),stronger]};};
 await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>kind==='integrity'?e.code==='LOCAL_RESULT_INTEGRITY':e.contextFailure);
 // Corrupt business evidence is now rejected while building the semantic
 // basis, before sending any context to a model or attempting a body read.
 assert.equal(calls,kind==='integrity'?0:1);assert.equal((f.task.generationReads||[]).length,kind==='integrity'?0:1);assert.equal(f.task.contextFinalizations,undefined);
 assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(f.a.file))).includes('SAVED_SUCCESS'));
 if(kind==='integrity')assert.equal(fs.readFileSync(f.a.file,'utf8'),savedBefore,'early integrity rejection does not mutate saved evidence');
});

test('forced R3 permit uses same semantic identity, persists reserve before first request and never traverses read_context',async t=>{
 const f=fixture(t);f.source('s','SAVED_SUCCESS');generation.readBatch(f.a,f.task,[request('s')]);
 const state=force(t,f);let calls=0;
 t.mock.method(protocol,'readContextBatch',()=>{throw Error('forced repair must not traverse reads');});
 f.a.call=async(_role,system,modelInput)=>{
  calls++;assert.ok(isFinal(system));assert.ok(view.suppliedBodies(modelInput).some(x=>x.includes('SAVED_SUCCESS')));
  const record=Object.values(JSON.parse(fs.readFileSync(f.a.file)).tasks.find(x=>x.id===f.task.id).contextFinalizations)[0];
  assert.equal(record.semanticCheckId,state.semanticCheckId);assert.equal(record.legacyKey,state.legacyKey);assert.equal(record.status,'started');assert.equal(record.repairCommandId,'approved-repair');
  return conclusion;
 };
 assert.deepEqual(await generation.call(f.a,f.task,'',initial,'verify'),conclusion);assert.equal(calls,1);
 await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>e.noProgress);assert.equal(calls,1);
});

test('forced semantic mismatch and legacy consumed records cannot dispatch even one model request',async t=>{
 const f=fixture(t);let calls=0;f.a.call=async()=>{calls++;return conclusion;};
 force(t,f,{semanticCheckId:'wrong'});await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>e.code==='CONTEXT_VERSION_CHANGED');assert.equal(calls,0);
 t.mock.restoreAll();force(t,f);f.task.contextFinalizations={legacy:{checkPhase:'content',status:'started'}};
 await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>e.finalizationReason==='ambiguous_consumed');assert.equal(calls,0);
});

for(const fault of ['transport','response_save'])test('a '+fault+' uncertainty preserves started on disk and cold restart never reissues',async t=>{
 const f=fixture(t);force(t,f);let calls=0;const save=f.a.save.bind(f.a);
 f.a.call=async()=>{calls++;if(fault==='transport')throw Object.assign(Error('network unknown'),{code:'MODEL_NETWORK'});f.a.save=()=>{throw Error('response storage unknown');};return conclusion;};
 await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>fault==='transport'?e.code==='MODEL_NETWORK':e.code==='STORAGE_FAILURE');
 const disk=JSON.parse(fs.readFileSync(f.a.file)),record=Object.values(disk.tasks.find(x=>x.id===f.task.id).contextFinalizations)[0];assert.equal(record.status,'started');
 const cold=new Assistant(f.options),task=cold.task(f.task.id);assert.equal(generation.finalizationState(cold,task,{initial}).available,false);
 cold.call=async()=>{calls++;return conclusion;};await assert.rejects(generation.call(cold,task,'',initial,'verify'),e=>e.noProgress);assert.equal(calls,1);f.a.save=save;
});

test('failure to persist reserve prevents transport, while a verifier refusing final mode consumes failed exactly once',async t=>{
 const f=fixture(t);force(t,f);let calls=0;const save=f.a.save.bind(f.a);
 f.a.save=()=>{throw Error('reserve storage failure');};f.a.call=async()=>{calls++;return conclusion;};
 await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>e.code==='STORAGE_FAILURE');assert.equal(calls,0);
 f.a.save=save;delete f.task.contextFinalizations;
 f.a.call=async()=>{calls++;return {kind:'read_context',requests:[request('s')]};};
 await assert.rejects(generation.call(f.a,f.task,'',initial,'verify'),e=>e.noProgress);assert.equal(calls,1);assert.equal(Object.values(f.task.contextFinalizations)[0].status,'failed');assert.equal(f.task.generationReads,undefined);
});

for(const kind of ['pause','budget','unknown_usage','input_budget','scope'])test(kind+' guard rejects forced finalization before reserve',async t=>{
 const f=fixture(t);force(t,f);let calls=0;f.a.call=async()=>{calls++;return conclusion;};
 let context=initial;
 if(kind==='pause')f.task.status='paused';
 if(kind==='budget')f.cost.spentUSD=197;
 if(kind==='unknown_usage')f.cost.unreservedCalls=1;
 if(kind==='input_budget')context={...initial,task:{criteria:'immutable requirement '.repeat(100000)}};
 if(kind==='scope')require('../desktop/access-policy-store.cjs').revoke(f.a,{principalScope:require('../desktop/access-policy-store.cjs').LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+f.artifact.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command'});
 await assert.rejects(generation.call(f.a,f.task,'',context,'verify'));assert.equal(calls,0);assert.equal(f.task.contextFinalizations,undefined);
});
