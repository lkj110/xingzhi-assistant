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
function computed(){return {id:'tool:current',version:'deterministic-evidence-v1',operation:'sum',parameters:{unit:'kg'},inputs:Array.from({length:8},(_,i)=>({sourceId:'source-'+i,version,policyRevision:1,start:i,end:i+1,value:'1',inputHash:version})),output:{value:'8',unit:'kg'},resultText:'{"value":"8","unit":"kg"}',contentHash:version,progressKey:version,observedAt:'2028-01-01T00:00:00Z',validUntil:null};}
test('A2 removes duplicate tool receipts while restoring exact operands, result and freshness',()=>{
 const r=computed(),raw={toolEvidence:[r],contextReads:[{request:{tool:'compute_evidence',operation:'sum'},result:{ok:true,computedEvidence:structuredClone(r),complete:true}}]},packed=receipt.project(raw,{toolReferences:true}),restored=input.materialize(packed);
 assert.ok(Buffer.byteLength(JSON.stringify(packed))<Buffer.byteLength(JSON.stringify(raw)));assert.equal(packed.contextReads[0].result.computedEvidence.toolEvidenceRef,'toolEvidence[0]');assert.deepEqual(restored.contextReads[0].result,raw.contextReads[0].result);assert.deepEqual(restored.toolEvidence,raw.toolEvidence);assert.deepEqual(receipt.project(raw),raw);
});
for(const delta of [{contentHash:'old'},{version:'old'},{id:'other'},{validUntil:'2028-02-01'},{output:{value:'9',unit:'kg'}}])test('A2 never aliases a changed tool receipt '+JSON.stringify(delta),()=>{
 const r=computed(),raw={toolEvidence:[r],contextReads:[{result:{ok:true,computedEvidence:{...r,...delta},complete:true}}]};assert.equal(receipt.project(raw,{toolReferences:true}).contextReads[0].result.computedEvidence.toolEvidenceRef,undefined);
});
test('tool reference expansion rejects missing, circular and foreign receipt targets',()=>{
 for(const [ref,patch] of [['toolEvidence[9]',{}],['task',{}],['toolEvidence[0]',{contentHash:'wrong'}],['toolEvidence[0]',{id:'other'}]]){
  const r=computed(),raw={toolEvidence:[r],contextReads:[{result:{computedEvidence:{id:r.id,version:r.version,contentHash:r.contentHash,toolEvidenceRef:ref,...patch}}}]};assert.equal(input.materialize(raw).contextReads[0].result.computedEvidence.output,undefined);
 }
});
