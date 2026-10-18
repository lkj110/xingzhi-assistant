const {test}=require('node:test'),assert=require('node:assert/strict');
const input=require('../desktop/model-input.cjs'),bodies=require('../desktop/context-evidence.cjs');
const at=(c,path)=>path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],c);
function checkRefs(c){const visit=v=>{if(!v||typeof v!=='object')return;for(const [k,x] of Object.entries(v)){if(k.endsWith('Ref')&&x?.path){const s=at(c,x.path);assert.equal(typeof s,'string',x.path);assert.ok(x.start>=0&&x.end<=s.length&&x.end>=x.start);}else visit(x);}};visit(c);}
const text=i=>'FACT_'+i+'_'.repeat(1)+(String.fromCharCode(65+i).repeat(3000));
test('retention review: shared receipt aliases keep exact bodies and valid canonical references',()=>{
 const rows=Array.from({length:19},(_,i)=>({request:{tool:'read_source',sourceId:'s'+i},result:{ok:true,sourceId:'s'+i,ref:'ref'+i,version:'v'+i,start:0,content:text(i),complete:true}}));
 // The very same receipt may occur in both local context and saved generation
 // history; structuredClone preserves these aliases. Do not normalize them out.
 const source={generationEvidence:rows.map(r=>r.result),contextReads:rows,task:{criteria:'all nineteen facts'}};
 const before=structuredClone(source),c=input.prepare(source,{stage:'task_verify'});
 assert.equal(c.contextReads.length,19);assert.equal(c.generationEvidence.length,19);
 for(let i=0;i<19;i++)assert.ok(bodies.suppliedBodies(c).some(s=>s.includes(text(i))),'aliased fact lost '+i);
 checkRefs(c);assert.deepEqual(source,before);assert.strictEqual(source.generationEvidence[0],source.contextReads[0].result);
});
test('retention review: direct deduplication does not turn aliased segment bodies into self references',()=>{
 const segment={index:0,text:'EXACT_SHARED_SEGMENT'},shared={ok:true,sourceId:'s',version:'v',start:0,segments:[segment],complete:true};
 const source={generationEvidence:[shared],contextReads:[{request:{tool:'read_source',sourceId:'s'},result:shared}]},before=structuredClone(source);
 const c=bodies.deduplicate(source);checkRefs(c);assert.ok(bodies.suppliedBodies(c).includes(segment.text));assert.deepEqual(source,before);
});
test('retention review: all nineteen small validated facts survive level zero regardless of count',()=>{
 const rows=Array.from({length:19},(_,i)=>({request:{tool:'read_source',sourceId:'s'+i},result:{ok:true,sourceId:'s'+i,ref:'ref'+i,version:'v'+i,start:0,content:text(i),complete:true}}));
 const source={generationEvidence:rows.map(r=>structuredClone(r.result)),contextReads:rows,task:{criteria:'all nineteen facts'}};
 const before=structuredClone(source),c=input.prepare(source,{stage:'task_verify'});
 assert.equal(c.inputBudget.projectionLevel,0);assert.equal(c.contextReads.length,19);assert.equal(c.generationEvidence.length,19);
 for(let i=0;i<19;i++)assert.ok(bodies.suppliedBodies(c).some(s=>s.includes(text(i))),'missing fact '+i);
 checkRefs(c);assert.deepEqual(source,before);assert.ok(input.encodedSize(c)<=480000);
});
test('retention review: current readback remains exact while historical readback has pinned restoration',()=>{
 const current='CURRENT_RETURNED_BODY_'+'a'.repeat(60000),old='OLD_RETURNED_BODY_'+'b'.repeat(60000);
 const c=input.prepare({deliveryEvidence:[{current:false,readback:{id:'old',version:'v0',state:'historical',content:old}},{current:true,readback:{id:'current',version:'v1',state:'active',content:current}}],generationEvidence:[{ok:true,sourceId:'current',version:'v1',start:0,content:current}]});
 assert.equal(c.inputBudget.projectionLevel,0);assert.ok(bodies.suppliedBodies(c).some(s=>s===current));checkRefs(c);
 assert.equal(c.deliveryEvidence[0].readback.content,undefined);assert.deepEqual(c.deliveryEvidence[0].readback.resumeRequest,{tool:'read_source',sourceId:'old',history:true,version:'v0',start:0});
});
test('retention review: bounded recovery diagnostics stay available to the next model request',()=>{
 const workEfficiency={allowed:true,phase:'recovery_pending',failure:{code:'CONTENT_REPAIR_REQUIRED'},failedActions:[{tool:'advance_task',error:'missing proof'}],triedStrategies:['read more'],attempts:2,remainingAttempts:1,nextAction:'revise',budgetUnchanged:true};
 assert.deepEqual(input.prepare({workEfficiency}).workEfficiency,workEfficiency);
});

const {fixture}=require('./root-relation-fixture.cjs'),agent=require('../desktop/agent.cjs'),links=require('../desktop/evidence-links.cjs'),protocol=require('../desktop/task-context.cjs'),platform=require('../desktop/data-platform.cjs');
function archive(t){
 const f=fixture(t),raw=require('./root-relation-physical-fixture.cjs').snapshot();
 raw.data.guidEntityMap.out.attributes.useCases='bulk_'.repeat(110000)+' ARCHIVED_ONLY_SENTINEL';
 const split=platform.splitPlatformSnapshot(require('../desktop/platform-result.cjs').prepare(raw));
 const s=agent.source(f.a,f.job,'review-archive','archive fixture',JSON.stringify(split.snapshot,null,2),{platformSnapshot:true,...split.sourceMeta});
 links.setInputs(f.a,f.task,[s.id]);return {...f,s};
}
test('retention review: archive-only metadata is searchable and readable through the original source ACL',t=>{
 const f=archive(t),scope=protocol.taskScope(f.task),r=protocol.readContextBatch(f.a,scope,[{tool:'search_source',sourceId:f.s.id,query:'ARCHIVED_ONLY_SENTINEL'}]).rows[0].result;
 assert.equal(r.ok,true);assert.equal(r.segments.length,1);assert.ok(r.segments[0].text.includes('ARCHIVED_ONLY_SENTINEL'));
 const request={tool:'read_segment',sourceId:f.s.id,index:r.segments[0].index,version:r.version,start:0};
 const exact=protocol.readContextBatch(f.a,scope,[request]).rows[0].result;
 assert.equal(exact.ok,true);assert.ok(exact.content.includes('ARCHIVED_ONLY_SENTINEL'));assert.equal(exact.coverage.wholeSource,false);
 for(const chunk of f.s.platformArchive.chunks)assert.ok(!JSON.stringify(r).includes(chunk.body));
 f.s.platformArchive.chunks[0].body='AAAA';
 assert.equal(protocol.readContextBatch(f.a,scope,[request]).rows[0].result.code,'CONTEXT_VERSION_CHANGED');
 const fresh=protocol.readContextBatch(f.a,scope,[{tool:'read_source',sourceId:f.s.id}]).rows[0].result;
 assert.equal(fresh.ok,false);assert.equal(fresh.code,'LOCAL_RESULT_INTEGRITY');
});
test('retention review: archive restoration is never called after source withdrawal',t=>{
 const f=archive(t);links.withdrawSources(f.a,f.task,[f.s.id],{reason:'review source withdrawal'});
 let restores=0;t.mock.method(platform,'restorePlatformData',()=>{restores++;throw Error('must check scope first');});
 const r=protocol.readContextBatch(f.a,protocol.taskScope(f.task),[{tool:'read_source',sourceId:f.s.id}]).rows[0].result;
 assert.equal(r.ok,false);assert.equal(restores,0);assert.equal(r.content,undefined);assert.equal(r.segments,undefined);
});
