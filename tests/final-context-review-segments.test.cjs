const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs');
const protocol=require('../desktop/task-context.cjs'),batch=require('../desktop/context-batch.cjs'),input=require('../desktop/model-input.cjs'),generation=require('../desktop/generation-context.cjs');
const links=require('../desktop/evidence-links.cjs');
// Platform snapshots now restore and resegment their authoritative JSON. Use a
// normal retained document to exercise explicitly stored atomic segments.
function source(f,texts){
 const s=require('../desktop/agent.cjs').source(f.a,f.job,'segment-document-'+require('node:crypto').randomUUID(),'普通分段文档',texts.join('\n'),{platformSnapshot:false,segments:texts.map((text,index)=>({id:'seg-'+index,text}))});
 links.setInputs(f.a,f.task,[...f.task.sourceIds,s.id]);return s;
}
const content=(c,r)=>r.content??(r.contentRef?ref(c,r.contentRef):undefined);
function ref(c,r){return r.path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((x,k)=>x?.[k],c).slice(r.start,r.end);}

test('segment review: prefix plus pinned segment recovery reproduces exactly one large source segment',t=>{
 const f=fixture(t),text='PREFIX_'+'abc'.repeat(50000)+'_TAIL',s=source(f,[text,'another paragraph']);
 const read=batch.readContextBatch(f.a,protocol.taskScope(f.task),[{tool:'read_source',sourceId:s.id}]);
 const c=input.prepare({contextReads:read.rows}),r=c.contextReads[0].result,part=r.segments[0];
 assert.equal(part.text,text.slice(0,12000));assert.equal(part.resumeRequest.version,read.rows[0].result.version);
 const tail=batch.readContextBatch(f.a,protocol.taskScope(f.task),[part.resumeRequest]).rows[0].result;
 assert.equal(tail.ok,true);assert.equal(part.text+tail.content,text);assert.equal(tail.segmentIndex,0);assert.equal(tail.coverage.wholeSource,false);assert.equal(tail.coverage.complete,false);
});

test('segment review: same character offset in different segments never merges across segment identity',t=>{
 const f=fixture(t),texts=['AAAA'+('a'.repeat(30000)),'BBBB'+('b'.repeat(30000))],s=source(f,texts);
 const read=batch.readContextBatch(f.a,protocol.taskScope(f.task),[0,1].map(index=>({tool:'read_segment',sourceId:s.id,index,start:0})));
 assert.ok(read.rows.every(r=>r.result.ok));const merged=batch.mergeReadRows(read.pageRows);
 assert.equal(merged.length,2);for(let index=0;index<2;index++){const r=merged.find(r=>r.result.segmentIndex===index);assert.equal(r.result.content,texts[index]);assert.equal(r.result.coverage.wholeSource,false);}
});

for(const mutation of ['segment-version','withdraw'])test('segment review: '+mutation+' between pages invalidates the merged result',t=>{
 const f=fixture(t),s=source(f,['x'.repeat(50000)]);let changed=false;
 const b=batch.readContextBatch(f.a,protocol.taskScope(f.task),[{tool:'read_segment',sourceId:s.id,index:0}],{onRead:()=>{
  if(changed)return;changed=true;
  if(mutation==='segment-version')s.segments[0].text='MUTATED'+s.segments[0].text;
  else links.withdrawSources(f.a,f.task,[s.id],{reason:'segment review withdrawal'});
 }});
 assert.equal(b.rows[0].result.ok,false);assert.equal(b.rows[0].result.content,undefined);
});

test('segment review: stale version and foreign source remain rejected',t=>{
 const f=fixture(t),s=source(f,['x'.repeat(50000)]),scope=protocol.taskScope(f.task);
 for(const request of [{tool:'read_segment',sourceId:s.id,index:0,version:'stale'},{tool:'read_segment',sourceId:'foreign-source',index:0},{tool:'read_segment',sourceId:s.id,index:0,taskId:'other'}])assert.equal(batch.readContextBatch(f.a,scope,[request]).rows[0].result.ok,false);
});

for(const revoke of [false,true])test('segment review: '+(revoke?'revoked':'changed')+' policy between pages rejects the old segment',t=>{
 const f=fixture(t),s=source(f,['x'.repeat(50000)]);let revision=1;
 const read=batch.readContextBatch(f.a,protocol.taskScope(f.task),[{tool:'read_segment',sourceId:s.id,index:0}],{resolverOptions:{checkAccess:()=>({decision:revoke&&revision===2?'deny':'allow',revision})},onRead:()=>{revision=2;}});
 assert.equal(read.rows[0].result.ok,false);assert.equal(read.rows[0].result.content,undefined);
});

test('segment review: following high escape segment recovery makes progress until all characters are visible',async t=>{
 const f=fixture(t),text='\\'.repeat(150000),s=source(f,[text]);let calls=0;const windows=new Map();
 f.a.call=async(_role,_prompt,c)=>{
  if(++calls===1)return {kind:'read_context',requests:[{tool:'read_source',sourceId:s.id}]};
  for(const row of c.contextReads||[]){
   const r=row.result;
   if(r.segments?.[0]){const segment=r.segments[0],body=segment.text??ref(c,segment.textRef);assert.equal(body,text.slice(0,body.length));windows.set('prefix',{start:0,end:body.length});}
   if(r.segmentIndex===0){const body=content(c,r);if(body){assert.equal(body,text.slice(r.start,r.start+body.length));windows.set(r.start+':'+body.length,{start:r.start,end:r.start+body.length});}}
  }
  let end=0;for(const w of [...windows.values()].sort((a,b)=>a.start-b.start))if(w.start<=end)end=Math.max(end,w.end);
  if(end>=text.length)return {passed:false,summary:'all windows observed',gaps:[]};
  const last=c.contextReads.at(-1).result,request=last.partialSegments?.[0]||last.resumeRequest;
  t.diagnostic(JSON.stringify({call:calls,coveredPrefix:end,request,windows:[...windows.values()]}));
  assert.ok(calls<6,'same recovery request keeps returning an already visible suffix; missing prefix never reaches model');
  assert.ok(request);return {kind:'read_context',requests:[request]};
 };
 const result=await generation.call(f.a,f.task,'offline segment review',{},'verify');
 assert.equal(result.summary,'all windows observed');
 let end=0;for(const w of [...windows.values()].sort((a,b)=>a.start-b.start))if(w.start<=end)end=Math.max(end,w.end);
 assert.equal(end,text.length);assert.ok(calls<6);
});

test('segment review: JSON-escaped content with ambiguous unescaped stored segments earns no canonical progress',t=>{
 const f=fixture(t),text='\\'.repeat(150000),s=f.source('code',{taskId:123,sql:text},{taskId:123},{platformSnapshot:false,segments:[{id:'seg-0',text}]});
 assert.notEqual(s.content.indexOf(text),s.content.lastIndexOf(text),'stored segment cannot prove one original position');
 const rows=batch.readContextBatch(f.a,protocol.taskScope(f.task),[{tool:'read_source',sourceId:s.id}]).rows,state={};
 assert.equal(rows[0].result.ok,true);assert.equal(rows[0].result.segments[0].sourceStart,undefined);
 for(let i=0;i<3;i++){
  const r=require('../desktop/check-reading.cjs').record(state,rows,{}, {semanticCheckId:'ambiguous-old-fixture'});
  assert.equal(r.fresh,0);assert.equal(r.restored,0);assert.equal(r.unmapped,1);assert.equal(r.exhausted,i===2);
 }
});
