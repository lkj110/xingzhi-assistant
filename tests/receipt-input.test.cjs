'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const receipt=require('../desktop/receipt-input.cjs'),input=require('../desktop/model-input.cjs'),view=require('../desktop/context-evidence.cjs');
const version='v'.repeat(64),revision='r'.repeat(64);
function row(overrides={}){return {ok:true,sourceId:'source-identity-001',version,ref:'s:identity',purpose:'input',state:'active',policyRevision:1,contextRevision:revision,canonical:{schema:1,resource:'source:source-identity-001',version,origin:0},content:'原文：只有东库在周二执行；西库例外，仍待确认。'.repeat(30),start:0,next:null,complete:true,coverage:{unit:'characters',start:0,next:null,complete:true,source:null},resumeRequest:{tool:'read_source',sourceId:'source-identity-001',start:0,version},...overrides};}
test('exact receipt reuse keeps original bytes, source binding and executable resume request',()=>{
 const r=row(),raw={contextRevision:revision,generationEvidence:[r],contextReads:[{request:{tool:'read_source',sourceId:r.sourceId},result:structuredClone(r)}]},wire=view.deduplicate(raw),before=structuredClone(wire),packed=receipt.project(wire),materialized=input.materialize(packed);
 assert.ok(JSON.stringify(packed).length<JSON.stringify(wire).length);assert.deepEqual(wire,before);
 assert.equal(packed.contextReads[0].result.receiptRef,'generationEvidence[0]');
 for(const value of [materialized.generationEvidence[0],materialized.contextReads[0].result]){
  for(const field of ['content','sourceId','version','purpose','state','policyRevision','start','next','complete','coverage','resumeRequest'])assert.deepEqual(value[field],r[field],field);
  assert.equal(value.canonical.origin,0);
 }
});
test('different source, version, position, completeness and errors never share a receipt',()=>{
 for(const delta of [{sourceId:'other'}, {version:'old'}, {start:1}, {complete:false}, {ok:false,code:'CONTEXT_SCOPE_DENIED'}, {canonical:{schema:1,version,resource:'source:source-identity-001',origin:1}}]){
  const result=receipt.project(view.deduplicate({contextRevision:revision,generationEvidence:[row()],contextReads:[{result:row(delta)}]}));
  assert.equal(result.contextReads[0].result.receiptRef,undefined);for(const [key,v] of Object.entries(delta))if(key!=='canonical')assert.deepEqual(result.contextReads[0].result[key],v);
 }
});
test('projection preserves partial segments, empty searches, recovery diagnostics and different context revision',()=>{
 const r=row({contextRevision:'older',complete:false,content:undefined,segments:[{text:'同文',sourceStart:9,index:2,truncated:true}],next:3,coverage:{unit:'segments',complete:false,providedComplete:false,next:3},code:'NOTICE',diagnostic:{kind:'partial'}}),context={contextRevision:revision,generationEvidence:[r]};
 const out=receipt.project(context).generationEvidence[0];
 for(const key of ['segments','next','coverage','code','diagnostic','contextRevision'])assert.deepEqual(out[key],r[key]);
 const failure={ok:false,code:'CONTEXT_SCOPE_DENIED',recovery:'correct_request'};assert.deepEqual(receipt.project({contextReads:[{result:failure}]}).contextReads[0].result,failure);
});
test('reference expansion rejects dangling, circular, foreign-identity and arbitrary-object references',()=>{
 for(const ref of ['generationEvidence[9]','generationEvidence[0]','task','contextReads[0].result']){
  const stub={sourceId:'s',version:'v',receiptRef:ref},c={task:{sourceId:'s',version:'v',content:'private'},generationEvidence:[stub],contextReads:[{result:{sourceId:'other',version:'v',content:'different'}}]};
  assert.equal(input.materialize(c).generationEvidence[0].content,undefined);
 }
});
test('body references remain resolvable even when a repeated receipt is itself another body target',()=>{
 const first=row(),second=row({title:'different metadata'}),wire=view.deduplicate({contextRevision:revision,generationEvidence:[first,second],contextReads:[{result:structuredClone(second)}]});
 const before=input.materialize(wire),after=input.materialize(receipt.project(wire));
 assert.equal(after.contextReads[0].result.content,before.contextReads[0].result.content);assert.equal(after.generationEvidence[1].content,before.generationEvidence[1].content);
});
