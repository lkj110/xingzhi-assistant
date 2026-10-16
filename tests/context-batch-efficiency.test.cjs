const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const protocol=require('../desktop/task-context.cjs');
const batch=require('../desktop/context-batch.cjs');
const generation=require('../desktop/generation-context.cjs');
const evidence=require('../desktop/context-evidence.cjs');
const access=require('../desktop/protocol-access.cjs');
const policy=require('../desktop/access-policy-store.cjs');
const links=require('../desktop/evidence-links.cjs');

// The real Assistant is used only with a new temporary workspace. Fail closed
// at model, connector, HTTP and socket boundaries; no user UI or remote services.
const forbidden=()=>{throw Error('real model/network forbidden in isolated test');};
const restore=[];
for(const [object,key] of [[globalThis,'fetch'],[require('node:http'),'request'],[require('node:http'),'get'],[require('node:https'),'request'],[require('node:https'),'get'],[require('node:net').Socket.prototype,'connect']]){
 const original=object[key];object[key]=forbidden;restore.push(()=>{object[key]=original;});
}
after(()=>restore.forEach(f=>f()));
function fixture(t,{job=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-batch-isolated-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const options={dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,officeRequest:forbidden,webRequest:forbidden,feedRequest:forbidden};
 const a=new Assistant(options);
 const task=a.createTask({title:'本地文稿',criteria:'保留来源事实',generationMode:'single',steps:[{title:'正文',kind:'draft'}]});
 let delegation;
 if(job){delegation={id:'job',taskIds:[task.id],sourceIds:[],goal:'核对本地文稿',status:'running',history:[],feedback:[],followups:[],projectId:null};a.data.delegations.push(delegation);task.agentJobId=delegation.id;}
 const scope=protocol.taskScope(task);
 const source=(id,content,extra={})=>{
  const s={id,title:id,content,projectId:null,...extra};a.data.sources.push(s);task.sourceIds.push(id);delegation?.sourceIds.push(id);
  access.retain(a,'source',s,{task,job:delegation});return s;
 };
 const artifact=(id,content,{current=false,...extra}={})=>{
  const r={id,title:id,content,taskId:task.id,stepId:task.steps[0].id,createdAt:'2026-01-01',...extra};a.data.artifacts.push(r);
  access.retain(a,'artifact',r,{task,job:delegation});if(current){task.steps[0].artifactId=id;task.steps[0].done=true;}return r;
 };
 return {a,task,scope,job:delegation,source,artifact,options,reopen:()=>new Assistant(options)};
}
const request=(sourceId,extra={})=>({tool:'read_source',sourceId,...extra});
const paragraphs=n=>Array.from({length:n},(_,i)=>`UNIQUE_PARAGRAPH_${i}: `+'正文依据。'.repeat(100)).join('\n\n');
const textOf=result=>result.content??result.segments.map(s=>s.text).join('\n\n');

test('84 segments are assembled by one bounded request; every page has an independent durable receipt',t=>{
 const f=fixture(t);f.source('s',paragraphs(84));
 const result=generation.readBatch(f.a,f.task,[request('s')]);
 assert.equal(result.complete,true);assert.equal(result.rows.length,1);assert.equal(result.stats.pages,14);assert.equal(result.used.length,14);
 assert.equal(result.rows[0].result.pages,14);assert.equal(result.rows[0].result.segments.length,84);assert.equal(result.rows[0].result.next,null);
 assert.equal(result.rows[0].result.coverage.complete,true);assert.match(textOf(result.rows[0].result),/UNIQUE_PARAGRAPH_83/);
 const reopened=f.reopen(),task=reopened.task(f.task.id);
 assert.equal(task.generationReads.length,14);assert.ok(task.generationReads.every(r=>r.sourceHash&&r.bodyHash&&protocol.validRead(reopened,protocol.taskScope(task),r)));
 const merged=batch.mergeReadRows(result.pageRows);assert.equal(merged.length,1);assert.equal(merged[0].result.segments.length,84);
 assert.equal(batch.mergeReadRows(result.rows)[0].result.pages,14);
});

test('generation accepts args.requests and needs two mocked calls for fourteen old pages',async t=>{
 const f=fixture(t);f.source('s',paragraphs(84));let calls=0,chars=0;
 f.a.call=async(_role,_prompt,context)=>{
  calls++;chars+=JSON.stringify(context).length;
  if(calls===1)return {tool:'read_context',args:{requests:[request('s')]}};
  assert.equal(context.contextReads[0].result.segments.length,84);
  assert.equal(context.contextReads[0].result.complete,true);
  assert.equal(JSON.parse(fs.readFileSync(f.a.file)).tasks.find(r=>r.id===f.task.id).generationReads.length,14);
  return {kind:'artifact',content:'完成'};
 };
 assert.equal((await generation.call(f.a,f.task,'',{})).content,'完成');assert.equal(calls,2);
 assert.ok(chars<100000,`mock input serialized characters: ${chars}`);
 t.diagnostic(`84 segments / 14 pages: ${calls} mocked model calls, ${chars} serialized input characters (not billed tokens)`);
});

test('page and character budgets expose exact resumable cursors without silent truncation',t=>{
 const f=fixture(t);f.source('s',paragraphs(18));
 const first=batch.readContextBatch(f.a,f.scope,[request('s')],{maxPages:1});
 assert.equal(first.complete,false);assert.equal(first.rows[0].result.segments.length,6);assert.equal(first.next[0].request.start,6);
 const rest=batch.readContextBatch(f.a,f.scope,[first.next[0].request]);
 assert.equal(rest.complete,true);assert.equal(rest.rows[0].result.coverage.complete,false);
 assert.equal(batch.mergeReadRows([...first.pageRows,...rest.pageRows])[0].result.segments.length,18);
 const limited=batch.readContextBatch(f.a,f.scope,[request('s')],{maxChars:1100});
 assert.equal(limited.rows[0].result.segments.length,2);assert.equal(limited.next[0].request.start,2);assert.ok(limited.stats.characters<=1100);
 f.artifact('draft','0123456789'.repeat(6000));
 const partial=batch.readContextBatch(f.a,f.scope,[{tool:'read_artifact',artifactId:'draft'}],{maxChars:25000});
 assert.equal(partial.rows[0].result.content.length,25000);assert.equal(partial.next[0].request.start,25000);
 const tail=batch.readContextBatch(f.a,f.scope,[partial.next[0].request]);
 assert.equal(partial.rows[0].result.content+tail.rows[0].result.content,'0123456789'.repeat(6000));
});

test('long imported segments are expanded only in the helper; legacy APIs keep their page contract',t=>{
 const f=fixture(t),text='LONG_SEGMENT_'+'证据'.repeat(8000)+'TAIL';
 f.source('s',text,{segments:[{id:'p1',text,label:'long'}],coverage:{complete:false,reason:'remote_snapshot_partial'}});
 const legacy=protocol.resolveRead(f.a,f.scope,request('s'));assert.equal(legacy.segments[0].text.length,8000);assert.equal(legacy.segments[0].truncated,true);
 assert.equal(protocol.readBatch(f.a,f.scope,[request('s')])[0].result.segments[0].text.length,8000);
 const tooSmall=batch.readContextBatch(f.a,f.scope,[request('s')],{maxChars:8000});
 assert.equal(tooSmall.complete,false);assert.equal(tooSmall.next[0].request.start,0);assert.equal(tooSmall.next[0].requiredChars,text.length);
 const full=batch.readContextBatch(f.a,f.scope,[request('s')]);assert.equal(textOf(full.rows[0].result),text);
 assert.equal(full.rows[0].result.segments[0].truncated,false);assert.equal(full.rows[0].result.coverage.source.complete,false);
});

test('search completeness applies to ranked matches, and duplicate IDs/text retain source positions',t=>{
 const f=fixture(t);f.source('s','saved',{segments:[{id:'same',text:'needle first'},{id:'same',text:'unmatched'},{id:'same',text:'needle first'},{id:'same',text:'needle last'}]});
 const r=batch.readContextBatch(f.a,f.scope,[{tool:'search_source',sourceId:'s',query:'needle',limit:1}]).rows[0].result;
 assert.deepEqual(r.segments.map(s=>s.index),[0,2,3]);assert.equal(r.matchesComplete,true);assert.equal(r.coverage.complete,false);
 const empty=batch.readContextBatch(f.a,f.scope,[{tool:'search_source',sourceId:'s',query:'absent'}]).rows[0].result;
 assert.equal(empty.segments.length,0);assert.equal(empty.matchesComplete,true);assert.equal(empty.coverage.complete,false);
});

test('long sections and job artifacts paginate without changing character offsets',t=>{
 const f=fixture(t,{job:true}),content='## 2.3 Needed\n'+'section-text-'.repeat(5000);
 f.source('s',content+'\n## Other\nnot selected');f.artifact('draft','D'.repeat(36001));
 const s=batch.readContextBatch(f.a,f.scope,[{tool:'read_section',sourceId:'s',title:'2.3 Needed'}]);
 assert.equal(s.stats.pages,3);assert.equal(s.rows[0].result.content,content+'\n');assert.equal(s.rows[0].result.complete,true);
 const j=generation.readBatch(f.a,{kind:'job',jobId:f.job.id},[{tool:'read_artifact',artifactId:'draft'}]);
 assert.equal(j.stats.pages,4);assert.equal(f.job.contextReads.length,4);assert.equal(j.rows[0].result.content.length,36001);
 assert.equal(f.reopen().data.delegations.find(r=>r.id===f.job.id).contextReads.length,4);
});

for(const change of ['content','policy','withdrawal','ownership'])test(`a ${change} change between pages fails closed while keeping successful receipts durable`,t=>{
 const f=fixture(t,{job:true}),s=f.source('s',paragraphs(18));let changed=false;
 const r=generation.readBatch(f.a,f.task,[request('s')],{onRead:()=>{
  if(changed)return;changed=true;
  if(change==='content')s.content+='\n\nnew revision';
  if(change==='policy')policy.revoke(f.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:s',jobId:f.job.id,taskId:f.task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command',command:'isolated_revoke'});
  if(change==='withdrawal')s.deleted=true;
  if(change==='ownership')f.task.agentJobId='other-job';
 }});
 assert.equal(r.rows[0].result.ok,false);assert.equal(r.used.length,1);assert.doesNotMatch(JSON.stringify(r.rows),/UNIQUE_PARAGRAPH/);
 assert.equal(JSON.parse(fs.readFileSync(f.a.file)).tasks.find(r=>r.id===f.task.id).generationReads.length,1);
 assert.equal(protocol.validRead(f.a,f.scope,r.used[0]),false);
});

test('a later failed sibling preserves the complete successful sibling and a restart can reuse it',t=>{
 const f=fixture(t);f.source('s',paragraphs(18));
 const r=generation.readBatch(f.a,f.task,[request('s'),{tool:'read_section',sourceId:'s',title:'missing'}]);
 assert.deepEqual(r.rows.map(r=>r.result.ok),[true,false]);assert.equal(r.used.length,3);
 const reopened=f.reopen(),task=reopened.task(f.task.id);
 const cached=generation.readBatch(reopened,task,[request('s',{start:6,limit:2})],{maxPages:1});
 assert.equal(cached.stats.cacheHits,2);assert.equal(cached.rows[0].result.segments[0].index,6);
});

for(const kind of ['task','job'])test(`${kind} read helper saves success on cancellation and unexpected later exceptions`,t=>{
 for(const abort of [true,false]){
  const f=fixture(t,{job:true});f.source('s',paragraphs(18));f.a.controller=new AbortController();
  assert.throws(()=>generation.readBatch(f.a,kind==='task'?f.task:{kind:'job',jobId:f.job.id},[request('s')],{onRead:()=>{if(abort)f.a.controller.abort();else throw Error('later observer failed');}}));
  const saved=JSON.parse(fs.readFileSync(f.a.file));
  const rows=kind==='task'?saved.tasks.find(t=>t.id===f.task.id).generationReads:saved.delegations.find(j=>j.id===f.job.id).contextReads;
  assert.equal(rows.length,1);assert.equal(rows[0].result.segments.length,6);
 }
});

test('storage failures stop before another model call, with a local typed error',async t=>{
 const f=fixture(t);f.source('s',paragraphs(18));let calls=0;
 f.a.call=async()=>{calls++;return {kind:'read_context',requests:[request('s')]};};
 f.a.save=()=>{throw Error('disk unavailable');};
 await assert.rejects(generation.call(f.a,f.task,'',{}),e=>e.code==='STORAGE_FAILURE'&&e.localPersistence&&!e.modelFailure);
 assert.equal(calls,1);
});

test('later local ranges reuse validated cache, while edits and revocation cannot reuse old bodies',t=>{
 const f=fixture(t),s=f.source('s',paragraphs(18));generation.readBatch(f.a,f.task,[request('s')]);
 let checks=0;const check=f.a.contextAccessCheck;f.a.contextAccessCheck=args=>{checks++;return check(args);};
 const r=generation.readBatch(f.a,f.task,[request('s',{start:4,limit:2})],{maxPages:1});
 assert.equal(r.stats.cacheHits,2);assert.ok(checks>=4);assert.deepEqual(r.rows[0].result.segments.map(s=>s.index),[4,5]);
 s.content='NEW_CONTENT';const changed=generation.readBatch(f.a,f.task,[request('s')]);
 assert.equal(changed.stats.cacheHits,0);assert.equal(textOf(changed.rows[0].result),'NEW_CONTENT');
 s.deleted=true;const denied=generation.readBatch(f.a,f.task,[request('s')]);assert.equal(denied.rows[0].result.ok,false);assert.equal(denied.used.length,0);
});

test('historical sources require history and delivery readbacks never become new input',t=>{
 const f=fixture(t,{job:true});f.source('old',paragraphs(8));f.source('new','new business',{previousSourceId:'old'});
 f.task.supersededSourceIds=['old'];
 assert.equal(batch.readContextBatch(f.a,f.scope,[request('old')]).rows[0].result.ok,false);
 const old=generation.readBatch(f.a,f.task,[request('old',{history:true})]);assert.equal(old.rows[0].result.state,'historical');
 const artifact=f.artifact('draft','delivery draft',{current:true});
 const source={id:'readback',title:'回读',projectId:null,content:paragraphs(8),deliveryActionId:'action',purpose:'delivery_readback',principalScope:'account',resourceKey:'https://fixture.invalid/doc',remoteId:'https://fixture.invalid/doc',remoteRevision:1};
 const action={id:'action',jobId:f.job.id,taskId:f.task.id,artifactId:artifact.id,status:'done',effectStatus:'applied',larkOpenId:'account',target:source.remoteId,result:{sourceId:source.id,verified:true,url:source.remoteId,revision:1}};
 const before=protocol.buildContext(f.a,f.scope).inputBasis;
 f.a.data.sources.push(source);f.job.sourceIds.push(source.id);f.a.data.agentActions.push(action);access.retain(f.a,'source',source,{task:f.task,job:f.job});links.bindDelivery(f.a,action,source);
 const delivery=generation.readBatch(f.a,f.task,[request(source.id)]);
 assert.equal(delivery.rows[0].result.purpose,'delivery_readback');assert.equal(protocol.buildContext(f.a,f.scope).inputBasis,before);
 assert.ok(!f.task.sourceIds.includes(source.id));
 const prepared=generation.prepare(f.a,f.task,{sources:[source]});assert.equal(prepared.sources.length,0);
 assert.ok(prepared.generationEvidence.some(r=>r.state==='historical'));
});

test('list_sources discovers omitted refs and sections without body dependencies, checking current access',t=>{
 const f=fixture(t);for(let i=0;i<32;i++)f.source('s'+i,'## Section\nPRIVATE_BODY_'+i);
 const one=generation.readBatch(f.a,f.task,[{tool:'list_sources',history:false,start:0,limit:24}]);
 assert.equal(one.rows[0].result.total,32);assert.equal(one.next[0].request.start,24);assert.equal(one.used.length,0);assert.equal(f.task.generationReads,undefined);
 const two=generation.readBatch(f.a,f.task,[one.next[0].request]);assert.equal(two.rows[0].result.sources.length,8);
 assert.doesNotMatch(JSON.stringify(one.rows),/PRIVATE_BODY/);
 const ref=two.rows[0].result.sources.at(-1).ref;
 const section=generation.readBatch(f.a,f.task,[{tool:'list_sources',ref,taskId:f.task.id}]);
 // Source bindings may not carry taskId; ref without the optional filter is authoritative.
 const exact=generation.readBatch(f.a,f.task,[{tool:'list_sources',ref}]);assert.equal(exact.rows[0].result.sections[0].title,'Section');assert.equal(section.used.length,0);
 f.a.data.sources.at(-1).deleted=true;
 assert.equal(generation.readBatch(f.a,f.task,[{tool:'list_sources',ref}]).rows[0].result.total,0);
 assert.equal(generation.readBatch(f.a,f.task,[{tool:'list_sources',scope:{kind:'job'}}]).rows[0].result.ok,false);
});

test('identical draft/read bodies appear once, with exact resolvable references and intact receipts',async t=>{
 const f=fixture(t),content='UNIQUE_DRAFT_BEGIN\n'+paragraphs(60)+'\nUNIQUE_DRAFT_END';f.artifact('draft',content);
 generation.readBatch(f.a,f.task,[{tool:'read_artifact',artifactId:'draft'}]);
 let calls=0;
 f.a.call=async(_role,_prompt,c)=>{
  assert.equal(JSON.stringify(c).split('UNIQUE_DRAFT_BEGIN').length-1,1);
  assert.equal(c.workingDraft.content,content);
  if(++calls===1)return {kind:'read_context',requests:[{tool:'read_artifact',artifactId:'draft'}]};
  assert.equal(c.contextReads[0].result.content,undefined);assert.equal(c.contextReads[0].result.contentRef.path,'workingDraft.content');
  return {kind:'artifact',content:'done'};
 };
 await generation.call(f.a,f.task,'',{currentStep:{id:f.task.steps[0].id}});
 assert.ok(f.task.generationReads.every(r=>typeof r.result.content==='string'));
});

test('incremental verification never restores historical full reads or a working draft',t=>{
 const f=fixture(t),old=f.artifact('old','HISTORICAL_PRIVATE_BODY'.repeat(3000));
 generation.readBatch(f.a,f.task,[{tool:'read_artifact',artifactId:old.id}]);
 const current=f.artifact('current','FULL_CURRENT_BODY'.repeat(3000),{current:true});
 generation.readBatch(f.a,f.task,[{tool:'read_artifact',artifactId:current.id}]);
 const p=generation.prepare(f.a,f.task,{currentStep:{id:f.task.steps[0].id},previousCheck:{requirementsAndSourcesUnchanged:true},artifacts:[{id:current.id,content:'only changed chunk',partialVerification:true}]});
 assert.doesNotMatch(JSON.stringify(p),/HISTORICAL_PRIVATE_BODY|FULL_CURRENT_BODY/);assert.equal(p.workingDraft,undefined);assert.equal(p.artifacts[0].content,'only changed chunk');
 assert.ok(p.generationEvidence.every(r=>r.bodyOmitted));
});

test('all used historical page dependencies survive model-facing bounds and later changes reject output',async t=>{
 const f=fixture(t);for(let i=0;i<14;i++)f.artifact('old'+i,'OLD_'+i+'x'.repeat(15000));
 for(let i=0;i<14;i++)generation.readBatch(f.a,f.task,[{tool:'read_artifact',artifactId:'old'+i}]);
 f.a.call=async()=>{f.a.data.artifacts[0].content='changed first of fourteen';return {kind:'artifact',content:'stale'};};
 await assert.rejects(generation.call(f.a,f.task,'',{}),e=>e.code==='CONTEXT_VERSION_CHANGED');assert.equal(f.task.generationReads.length,14);
});

test('read-body bounds keep newest suffix, explicit omitted ranges, full drafts, and no dangling refs',()=>{
 const old='A'.repeat(160000),newest='B'.repeat(160000),draft='DRAFT_UNCHANGED';
 const context={workingDraft:{id:'draft',content:draft},requestedSections:[{content:'required exact section'}],generationEvidence:[{ok:true,artifactId:'older',start:0,next:null,total:160000,complete:true,content:old}],contextReads:[{request:{tool:'read_artifact',artifactId:'newest'},result:{ok:true,artifactId:'newest',start:0,next:null,total:160000,complete:true,content:newest}}]};
 const bounded=evidence.bounded(context),projected=evidence.deduplicate(bounded);
 assert.equal(projected.workingDraft.content,draft);assert.equal(projected.requestedSections[0].content,'required exact section');
 assert.equal(projected.contextReads[0].result.content.length,160000);assert.equal(projected.generationEvidence[0].content.length,32000);
 assert.equal(projected.generationEvidence[0].bodyOmitted,true);assert.equal(projected.generationEvidence[0].next,0);assert.equal(projected.generationEvidence[0].complete,false);
 assert.deepEqual(projected.generationEvidence[0].omittedRange,{start:0,end:128000});assert.equal(projected.readBodyBudget.providedChars,192000);
 assert.equal(context.generationEvidence[0].content.length,160000);assert.doesNotMatch(JSON.stringify(projected),/contentRef|textRef/);
 const full={contextReads:[{request:{tool:'read_artifact',artifactId:'long'},result:{ok:true,artifactId:'long',start:0,next:null,total:500000,complete:true,content:'x'.repeat(499990)+'NEWEST_END'}}]};
 const limited=evidence.bounded(full);assert.equal(limited.contextReads[0].result.content.length,192000);assert.ok(limited.contextReads[0].result.content.endsWith('NEWEST_END'));
});

test('prefetched numbered sections expose incomplete budget boundaries instead of skipping requirements',t=>{
 const f=fixture(t);f.task.criteria='§2.3–§2.5';f.source('s','## 2.3 A\n'+'a'.repeat(30000)+'\n## 2.4 B\n'+'b'.repeat(30000)+'\n## 2.5 C\nc');
 const p=generation.prepare(f.a,f.task,{});assert.equal(p.requestedSections.length,3);
 assert.equal(p.requestedSections[0].complete,true);assert.equal(p.requestedSections[1].complete,false);assert.ok(p.requestedSections[1].next>0);assert.equal(p.requestedSections[2].next,0);
 assert.ok(p.requestedSections.reduce((n,r)=>n+(r.content?.length||0),0)<=48000);
});

test('work-efficiency counts model read attempts, exposes suggestions, and yields to correction without model failure',async t=>{
 const f=fixture(t,{job:true});f.source('s',paragraphs(18));const work=require('../desktop/work-efficiency.cjs');
 work.assertAllowed(f.a,f.job);f.job.executionState.workEfficiency.attempts=work.LIMITS.stopAt-1;
 let calls=0;f.a.call=async(_role,_prompt,c)=>{calls++;assert.ok(c.workEfficiency);return {kind:'read_context',requests:[request('s')]};};
 await assert.rejects(generation.call(f.a,f.task,'',{}),e=>e.workEfficiency&&e.noProgress&&!e.modelFailure);
 assert.equal(calls,1);assert.notEqual(f.job.status,'paused');assert.equal(f.job.executionState.workEfficiency.phase,'recovery_pending');assert.equal(f.job.executionState.workEfficiency.attempts,work.LIMITS.stopAt);
 assert.equal(f.task.generationReads.length,3);assert.equal(f.reopen().data.delegations.find(j=>j.id===f.job.id).executionState.workEfficiency.phase,'recovery_pending');
});
