const {test,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const protocol=require('../desktop/task-context.cjs'),reads=require('../desktop/generation-context.cjs');
const work=require('../desktop/work-efficiency.cjs'),view=require('../desktop/context-evidence.cjs');
const revision=require('../desktop/revision-protocol.cjs'),generation=require('../desktop/generation.cjs');
const access=require('../desktop/protocol-access.cjs'),policies=require('../desktop/access-policy-store.cjs');
const hash=require('../desktop/evidence-basis.cjs').hash;
const forbidden=()=>{throw Error('fixture prohibits real model/network');},restores=[];
for(const [object,key] of [[globalThis,'fetch'],[require('node:http'),'request'],[require('node:http'),'get'],[require('node:https'),'request'],[require('node:https'),'get'],[require('node:net').Socket.prototype,'connect']]){
 const prior=object[key];object[key]=forbidden;restores.push(()=>object[key]=prior);
}
after(()=>restores.forEach(f=>f()));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-reading-revision-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const options={dir,chat:forbidden,connectorRequest:forbidden,webRequest:forbidden,platformRequest:forbidden};
 const a=new Assistant(options);
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:1});a.data.settings.roles={execute:'fixture',verify:'fixture',organize:'fixture'};
 const job=agent.buildJob(a,{goal:'依据当前来源修订交接稿',autoAccept:false});a.data.delegations.push(job);
 a.activeAgentJob=job;const cost=require('../desktop/spend.cjs').scope(a);Object.assign(cost,{limitUSD:200,spentUSD:153,heldUSD:3});require('../desktop/spend.cjs').persist(a);
 const task=a.createTask({title:'事实核对',criteria:'保留事实和必要章节',generationMode:'single',steps:[{title:'正文',kind:'draft'}]});task.agentJobId=job.id;job.taskIds=[task.id];
 const source=(id,content)=>{const s={id,title:id,content,projectId:null};a.data.sources.push(s);task.sourceIds.push(id);job.sourceIds.push(id);access.retain(a,'source',s,{task,job});return s;};
 const artifact=(id,content,step=task.steps[0])=>{const r={id,title:id,content,taskId:task.id,stepId:step.id,createdAt:'2026-01-01'};a.data.artifacts.push(r);access.retain(a,'artifact',r,{task,job});step.done=true;step.artifactId=id;return r;};
 return {a,job,task,step:task.steps[0],source,artifact,dir,options,cost};
}
const request=id=>({tool:'read_source',sourceId:id});
const at=(object,path)=>path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],object);
function assertRefs(value,root=value){
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){
  if(['contentRef','textRef','originalContentRef'].includes(key)){const body=at(root,child.path);assert.equal(typeof body,'string',child.path);assert.ok(child.start>=0&&child.end<=body.length);}
  else assertRefs(child,root);
 }
}
const report=(f,batch,visibleContext={})=>work.readResult(f.a,f.job,{taskId:f.task.id,rows:batch.rows,visibleContext});
function recovery(f,id='cached:fixture'){
 work.before(f.a,f.job);const state=f.job.executionState.workEfficiency;
 Object.assign(state,{attempts:11,phase:'recovering',history:[{id:'old-failure',outcome:'no_progress'}],tried:{old:3},active:{id,reads:5,attempts:2,inFlight:{tool:'advance_task'},queue:[]}});
 return state;
}
const original='## 来源\n事实一。\n\n## 风险\n旧风险。\n\n## 结论\n保留结论。';
function revise(f){
 const artifact=f.artifact('main',original);f.step.done=false;delete f.step.artifactId;f.step.targetArtifactId=artifact.id;
 f.task.notes.push({kind:'revise',at:'2026-02-01',text:'更正风险，保留原有章节',targetArtifactId:artifact.id,targetStepId:f.step.id,baseHash:hash(original)});
 recovery(f,'full_rewrite:'+f.task.id);delete f.job.executionState.workEfficiency.active.inFlight;return artifact;
}
function diskText(dir){return fs.readdirSync(dir,{withFileTypes:true}).map(e=>e.isDirectory()?diskText(path.join(dir,e.name)):fs.readFileSync(path.join(dir,e.name)).toString()).join('\n');}

test('U02: 19 related sources in six distinct batches reach revision without consuming business failures',async t=>{
 const f=fixture(t);for(let i=0;i<19;i++)f.source('s'+i,'相关证据 '+i);
 const artifact=revise(f),state=f.job.executionState.workEfficiency;state.active.id='cached:fixture';
 const before=JSON.stringify({attempts:state.attempts,history:state.history,tried:state.tried,active:state.active,budget:f.cost});let calls=0;
 f.a.call=async(_role,_prompt,input)=>{
  assertRefs(input);const n=calls++;
  if(n<6)return {kind:'read_context',requests:Array.from({length:n===5?4:3},(_,i)=>request('s'+(n*3+i)))};
  assert.equal(f.task.generationReads.length,19);
  return {kind:'patch',edits:[{before:'旧风险。',after:'已核对风险。'}]};
 };
 const result=await generation.run(f.a,f.task,f.step,'',{});
 assert.equal(calls,7);assert.equal(result.content,original.replace('旧风险。','已核对风险。'));assert.equal(artifact.content,original);
 assert.equal(JSON.stringify({attempts:state.attempts,history:state.history,tried:state.tried,active:state.active,budget:f.cost}),before);
 assert.equal(Object.keys(state.reading[f.task.id].coverage).length,19);assert.equal(state.reading[f.task.id].ineffective,0);
});

test('result API requires actual outcomes; failed requests and empty searches do not earn coverage',t=>{
 const f=fixture(t);f.source('s','有内容');work.before(f.a,f.job);
 assert.throws(()=>work.readResult(f.a,f.job,{taskId:f.task.id,requests:[request('s')]}),TypeError);
 assert.throws(()=>work.readResult(f.a,f.job,{taskId:'foreign',rows:[],visibleContext:{}}),/范围/);
 const batch=reads.readBatch(f.a,f.task,[{tool:'read_section',sourceId:'s',title:'missing'},{tool:'search_source',sourceId:'s',query:'absent'}]);
 const status=report(f,batch);assert.equal(status.reading.failed,1);assert.equal(status.reading.empty,1);assert.equal(status.reading.fresh,0);
 assert.equal(Object.keys(f.job.executionState.workEfficiency.reading[f.task.id].coverage).length,0);
});

test('duplicate and empty-query loops remain bounded across wording changes and restart, with old history retained',async t=>{
 for(const kind of ['empty','duplicate']){
  const f=fixture(t);f.source('s','固定内容');const state=recovery(f);let n=0;
  f.a.call=async()=>({kind:'read_context',requests:[kind==='empty'?{tool:'search_source',sourceId:'s',query:'missing'+n++}:request('s')]});
  await assert.rejects(reads.call(f.a,f.task,'',{}),e=>e.workEfficiency&&e.noProgress);
  assert.equal(state.attempts,11);assert.equal(state.tried.old,3);assert.equal(state.history[0].id,'old-failure');assert.equal(f.cost.limitUSD,200);assert.equal(f.cost.spentUSD,153);assert.equal(f.cost.heldUSD,3);
  assert.equal(state.reading[f.task.id].ineffective,3);assert.equal(state.phase,'recovery_pending');
  const restarted=new Assistant(f.options),job=restarted.data.delegations.find(j=>j.id===f.job.id);
  assert.equal(job.executionState.workEfficiency.reading[f.task.id].ineffective,3);assert.throws(()=>work.assertAllowed(restarted,job),e=>e.noProgress);
 }
});

test('changing search wording without changing returned content cannot manufacture reading progress',async t=>{
 const f=fixture(t);f.source('s','needle one two three');recovery(f);let calls=0;
 f.a.call=async()=>({kind:'read_context',requests:[{tool:'search_source',sourceId:'s',query:['needle','one','two','three'][calls++]}]});
 await assert.rejects(reads.call(f.a,f.task,'',{}),e=>e.workEfficiency&&e.noProgress);
 assert.equal(calls,4);assert.equal(f.job.executionState.workEfficiency.reading[f.task.id].ineffective,3);
 assert.equal(Object.keys(f.job.executionState.workEfficiency.reading[f.task.id].coverage).length,1);
});

test('the cumulative $200 fixture budget still stops a model call before new reading',async t=>{
 const f=fixture(t);f.source('s','new range');recovery(f);f.cost.spentUSD=197;f.cost.heldUSD=3;require('../desktop/spend.cjs').persist(f.a);
 await assert.rejects(reads.call(f.a,f.task,'',{}),e=>e.spendLimit);
 assert.equal(f.cost.limitUSD,200);assert.equal(f.cost.spentUSD,197);assert.equal(f.cost.heldUSD,3);
 assert.equal(f.task.generationReads,undefined);assert.equal(f.job.executionState.workEfficiency.attempts,11);
});

test('a validated cache hit can restore omitted evidence; only an already visible repeat is ineffective',t=>{
 const f=fixture(t);f.source('s','CACHE_CONTENT');work.before(f.a,f.job);
 const first=reads.readBatch(f.a,f.task,[request('s')]);assert.equal(report(f,first).reading.fresh,1);
 const omitted=view.bounded({contextReads:first.rows},{maxChars:0});assert.equal(omitted.contextReads[0].result.bodyOmitted,true);assertRefs(omitted);
 const again=reads.readBatch(f.a,f.task,[omitted.contextReads[0].result.resumeRequest]);assert.ok(again.stats.cacheHits);
 assert.equal(report(f,again,omitted).reading.restored,1);
 const visible=view.bounded({contextReads:again.rows});assert.equal(report(f,again,visible).reading.duplicate,1);
 assert.equal(f.job.executionState.workEfficiency.attempts,0);
});

test('mixed useful and duplicate reads deliver the useful sibling even with historical duplicate debt',async t=>{
 const f=fixture(t);f.source('old','OLD_VISIBLE');f.source('new','NEW_FACT');const state=recovery(f);
 const prior=reads.readBatch(f.a,f.task,[request('old')]);report(f,prior);state.reading[f.task.id].ineffective=3;
 let calls=0;f.a.call=async(_role,_system,input)=>{
  if(!calls++)return {kind:'read_context',requests:[request('old'),request('new')]};
  assert.ok(view.suppliedBodies(input).includes('NEW_FACT'));
  return {passed:false,summary:'已读新事实，但仍需具体业务证据',gaps:['缺口']};
 };
 const result=await reads.call(f.a,f.task,'',{},'verify');assert.equal(result.passed,false);assert.equal(calls,2);
 assert.equal(state.reading[f.task.id].ineffective,4);assert.equal(state.history[0].id,'old-failure');assert.equal(state.phase,'recovering');
 assert.equal(f.task.contextFinalizations,undefined);
});

test('pure duplicate verification switches once to a persisted concluding call without accepting missing evidence',async t=>{
 const f=fixture(t);f.source('s','FACT');const state=recovery(f);let calls=0,finals=0;
 f.a.call=async(_role,system)=>{calls++;if(system.includes('本轮改为形成检查结论')){finals++;return {passed:false,summary:'尚缺具体映射依据',gaps:['未核实消费者映射']};}return {kind:'read_context',requests:[request('s')]};};
 const result=await reads.call(f.a,f.task,'',{},'verify');assert.equal(result.passed,false);assert.equal(finals,1);assert.equal(calls,5);
 assert.equal(state.reading[f.task.id].ineffective,3);assert.equal(state.history[0].id,'old-failure');assert.equal(f.cost.spentUSD,153);
 assert.equal(Object.values(f.task.contextFinalizations)[0].status,'returned');
 let reissued=0;f.a.call=async()=>{reissued++;return {kind:'read_context',requests:[request('s')]};};
 await assert.rejects(reads.call(f.a,f.task,'',{},'verify'),e=>e.noProgress);
 assert.equal(reissued,0,'a consumed same-check conclusion cannot be retried as an ordinary paid check');
 const restarted=new Assistant(f.options),task=restarted.task(f.task.id),job=restarted.data.delegations.find(j=>j.id===f.job.id);
 let again=0;restarted.call=async()=>{again++;return {kind:'read_context',requests:[request('s')]};};
 await assert.rejects(reads.call(restarted,task,'',{},'verify'),e=>e.noProgress);assert.equal(again,0);
 assert.equal(Object.keys(task.contextFinalizations).length,1);assert.equal(job.executionState.workEfficiency.reading[task.id].ineffective,3);
});

test('a verifier ignoring the concluding mode is bounded and cannot query platform boundaries',async t=>{
 const f=fixture(t);f.source('s','FACT');recovery(f);let calls=0;
 f.a.call=async()=>{calls++;return {kind:'read_context',requests:[request('s')]};};
 await assert.rejects(reads.call(f.a,f.task,'',{},'verify'),e=>e.noProgress);assert.equal(calls,5);
 assert.equal(Object.values(f.task.contextFinalizations)[0].status,'failed');assert.equal(f.task.generationReads.length,4);
});

test('U10: duplicate bodies cost zero before allocating the second unique body, and all refs resolve',()=>{
 const a='A'.repeat(600),b='B'.repeat(600),row=(id,content)=>({ok:true,sourceId:id,version:'v',start:0,next:null,content,complete:true,total:content.length});
 const raw={generationEvidence:[row('b',b),row('a',a)],contextReads:[{request:request('a'),result:row('a',a)}]};
 const result=view.bounded(raw,{maxChars:1200});assertRefs(result);
 assert.deepEqual(new Set(view.suppliedBodies(result)),new Set([a,b]));assert.equal(result.readBodyBudget,undefined);
 assert.equal(JSON.stringify(raw).includes('contentRef'),false);
 const again=view.bounded(result,{maxChars:1200});assertRefs(again);assert.deepEqual(new Set(view.suppliedBodies(again)),new Set([a,b]));
});

test('a fresh omitted prefix takes priority over its older full-body canonical copy without dangling refs',()=>{
 const full='PREFIX-'.repeat(100)+'TAIL-'.repeat(100),prefix=full.slice(0,240);
 const row=(content,start=0)=>({ok:true,artifactId:'a',version:'v',start,next:null,total:full.length,content,complete:true});
 const old=view.bounded({generationEvidence:[row(full)]},{maxChars:240});assert.equal(old.generationEvidence[0].resumeRequest.start,0);
 const recovered=view.bounded({generationEvidence:[row(full)],contextReads:[{request:{tool:'read_artifact',artifactId:'a',start:0},result:row(prefix)}]},{maxChars:240});
 assertRefs(recovered);assert.ok(view.suppliedBodies(recovered).some(body=>body.includes(prefix)));
 assert.equal(recovered.contextReads[0].result.bodyOmitted,undefined);assert.equal(recovered.generationEvidence[0].resumeRequest.start,240);
});

test('literal multiword search declares OR ranking and regex-style queries give a correction rule',t=>{
 const f=fixture(t);f.source('sql','insert into target\n\nselect from source join other\n\nno sql');
 const search=query=>reads.readBatch(f.a,f.task,[{tool:'search_source',sourceId:'sql',query}]).rows[0].result;
 const regex=search('insert|from|join');assert.equal(regex.totalMatches,0);assert.equal(regex.search.mode,'literal');assert.equal(regex.search.warning,'REGEX_NOT_SUPPORTED');
 const literal=search('insert from join');assert.equal(literal.totalMatches,2);assert.equal(literal.search.match,'any');assert.equal(literal.segments[0].score,2);
 assert.equal(require('../desktop/documents.cjs').excerpts(f.a.data.sources[0],{query:'insert|from'}).search.warning,'REGEX_NOT_SUPPORTED');
});

test('U07: explicit consistent target overrides auxiliary evidence; real conflicts, foreign IDs and revocation reject',t=>{
 const f=fixture(t),main=f.artifact('main',original),supportStep={id:'support',kind:'analysis',done:true};f.task.steps.push(supportStep);const support=f.artifact('support','辅助事实',supportStep);
 const check={gapDetails:[{artifactId:main.id,stepId:f.step.id,sourceIds:[support.id,'historical-evidence']}],gaps:[support.title]};
 assert.equal(revision.target(f.a,f.task,check).id,main.id);
 assert.equal(revision.target(f.a,f.task,{gapDetails:[{artifactId:main.id,stepId:supportStep.id}]}),null);
 assert.equal(revision.target(f.a,f.task,{gapDetails:[{artifactId:main.id},{artifactId:support.id}]}),null);
 assert.equal(revision.target(f.a,f.task,{gapDetails:[{artifactId:main.id,stepId:'foreign'}]}),null);
 policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+main.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command'});
 assert.equal(revision.target(f.a,f.task,check),null);
});

test('U08: ATX closures, emphasis, escapes, entities and Setext preserve section identity; fenced headings are ignored',()=>{
 const a=protocol.sections({content:'## Facts & risks\nbody\n\n## Next # step\nbody'});
 const b=protocol.sections({content:'  ## **Facts &amp; risks** ###  \r\nbody\n\nNext \\# step\n---\nbody\n```md\n## fake\n```'});
 assert.deepEqual(a.map(s=>s.id),b.map(s=>s.id));assert.deepEqual(a.map(s=>s.level),b.map(s=>s.level));assert.equal(b.length,2);
 assert.notEqual(protocol.headingIdentity('Fact A'),protocol.headingIdentity('Fact B'));
});

test('equivalent full rewrite is accepted; headings alone still cannot erase existing section prose',async t=>{
 const f=fixture(t);revise(f);f.a.call=async()=>({kind:'artifact',title:'新稿',content:original.replace(/^## (.+)$/gm,'## **$1** ###')});
 assert.equal((await generation.run(f.a,f.task,f.step,'',{})).kind,'artifact');
 f.a.call=async()=>({kind:'artifact',content:original.replace('旧风险。','')});
 await assert.rejects(generation.run(f.a,f.task,f.step,'',{}),e=>e.revisionDiagnostic?.errors.some(r=>r.type==='empty_section'));
});

test('duplicate heading occurrences and headings inside fences cannot hide a truly missing section',async t=>{
 const f=fixture(t),artifact=revise(f);
 artifact.content='## Same\nfirst\n## Same\nsecond\n## End\nlast';
 f.a.call=async()=>({kind:'artifact',content:'## Same\nfirst\n```md\n## Same\nsecond\n```\n## End\nlast'});
 await assert.rejects(generation.run(f.a,f.task,f.step,'',{}),e=>e.revisionDiagnostic?.errors.some(error=>error.type==='missing_section'&&error.index===1));
 assert.equal(f.a.data.artifacts.length,1);
});

test('R4: missing chapters persist only bounded structure diagnostics; restart requests a targeted patch of the legal original',async t=>{
 let f=fixture(t);const artifact=revise(f),sentinel='FAILED_CANDIDATE_BODY_SENTINEL';
 f.a.chat=async(_p,_k,_m,o)=>{o.onUsage({inputTokens:10,outputTokens:5});return {kind:'artifact',title:sentinel,content:'## 来源\n'+sentinel,summary:sentinel};};
 let error;try{await generation.run(f.a,f.task,f.step,'',{});}catch(e){error=e;}
 assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.deepEqual(error.revisionDiagnostic.errors.map(e=>e.type),['missing_section','missing_section']);
 assert.deepEqual(error.revisionDiagnostic.errors.map(e=>e.start),protocol.sections({content:original}).slice(1).map(s=>s.start));
 assert.equal(error.revisionDiagnostic.baseHash,hash(original));assert.equal(f.a.data.artifacts.length,1);assert.equal(artifact.content,original);
 assert.doesNotMatch(JSON.stringify(error),new RegExp(sentinel));assert.doesNotMatch(diskText(f.dir),new RegExp(sentinel));assert.doesNotMatch(JSON.stringify(f.a.publicState()),new RegExp(sentinel));
 const costs=JSON.stringify(f.a.spendLedger);assert.ok(f.a.data.modelCalls.length>0);
 const a=new Assistant(f.options),task=a.task(f.task.id),step=task.steps[0];let calls=0;
 a.call=async(_role,prompt,input)=>{calls++;assert.match(prompt,/逐字匹配 originalContent/);assert.equal(input.revision.originalContent,original);assert.equal(input.revisionRecovery.strategy,'targeted_patch');assert.doesNotMatch(JSON.stringify(input),new RegExp(sentinel));return {kind:'patch',edits:[{before:'旧风险。',after:'新风险。'}]};};
 assert.equal((await generation.run(a,task,step,'',{})).content,original.replace('旧风险。','新风险。'));assert.equal(calls,1);assert.equal(step.revisionDiagnostic,undefined);
 assert.equal(JSON.stringify(a.spendLedger),costs);assert.equal(a.data.artifacts.length,1);
});

for(const kind of ['revoked_before','revoked_during','unbind_during','delete_during','account_during','version_during'])test('R4 rejects '+kind+' without persisting candidate or deleting the legal original',async t=>{
 const f=fixture(t),source=f.source('evidence','AUTHORIZED_INPUT'),artifact=revise(f),sentinel='FAILED_CANDIDATE_'+kind;let calls=0;
 const revoke=()=>policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+artifact.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command'});
 if(kind==='revoked_before')revoke();
 f.a.chat=async(_p,_k,_m,o)=>{
  calls++;o.onUsage({inputTokens:10,outputTokens:5});
  if(kind==='revoked_during')revoke();
  if(kind==='unbind_during'){f.task.sourceIds=[];for(const b of f.task.contextBindings||[])if(b.sourceId===source.id)b.state='withdrawn';}
  if(kind==='delete_during')source.deleted=true;
  if(kind==='account_during')source.principalScope={accountId:'another-account'};
  if(kind==='version_during')source.content+='CHANGED';
  return {kind:'artifact',title:sentinel,content:'## 来源\n'+sentinel,summary:sentinel};
 };
 await assert.rejects(generation.run(f.a,f.task,f.step,'',{}),e=>['CONTEXT_SCOPE_DENIED','CONTEXT_VERSION_CHANGED'].includes(e.code));
 assert.equal(calls,kind==='revoked_before'?0:1);assert.equal(f.a.data.artifacts.length,1);assert.equal(artifact.content,original);assert.equal(f.step.revisionDiagnostic,undefined);f.a.save();
 assert.doesNotMatch(diskText(f.dir),new RegExp(sentinel));assert.doesNotMatch(JSON.stringify(f.a.publicState()),new RegExp(sentinel));
 const restarted=new Assistant(f.options);assert.equal(restarted.data.artifacts[0].content,original);assert.doesNotMatch(JSON.stringify(restarted.data),new RegExp(sentinel));
 if(calls)assert.ok(f.a.data.modelCalls.length>0,'completed model cost/usage is retained');
});
