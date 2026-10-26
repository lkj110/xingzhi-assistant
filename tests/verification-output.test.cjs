'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const contract=require('../desktop/verification-output.cjs');
const report=()=>({passed:true,summary:'逐项核对',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:['a'],citations:[{id:'e',sourceId:'s',quote:'条件：限定同一人员。'}],requirements:[{id:'r',status:'satisfied',claimIds:['c']}],claims:[{id:'c',artifactId:'a',field:'content',text:'null 只是正文，不是控制字段。',kind:'fact',supported:true,citationIds:['e']}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}});
const decode=value=>contract.decode(JSON.stringify({response_json:value}));
test('strict schema recursively closes every object and declares every property required',()=>{
 let objects=0;const walk=node=>{if(node.type==='object'){objects++;assert.equal(node.additionalProperties,false);assert.deepEqual(node.required,Object.keys(node.properties));Object.values(node.properties).forEach(walk);}if(node.items)walk(node.items);node.anyOf?.forEach(walk);};walk(contract.schema);assert.ok(objects>20);
 assert.equal(contract.metadata.utf8Bytes,Buffer.byteLength(contract.serialized));assert.ok(contract.metadata.sha256.match(/^[a-f0-9]{64}$/));
 assert.equal(contract.overhead({type:'openai'},{responseContract:contract.ID}),null);
 assert.equal(contract.overhead({type:'codex'},{role:'verify',stage:'goal_verify'}),null);
 assert.deepEqual(contract.overhead({type:'codex'},{responseContract:contract.ID}),contract.metadata);
});
test('structured compact report roundtrips exact quotes and optional null slots only',()=>{
 const value=report();value.groundingReview.claims[0].qualification=null;value.groundingReview.claims[0].start=null;value.groundingReview.sourceConflicts=null;value.gapDetails=null;
 assert.deepEqual(decode(value),report());
 const limited=report();limited.groundingReview.claims[0].qualification={field:'content',quote:limited.groundingReview.claims[0].text,start:0};assert.deepEqual(decode(limited),limited);
});
test('no guessed syntax, string envelope escape, extra null field or required-null removal',()=>{
 for(const value of [JSON.stringify({response_json:'{"passed":true,"gaps":[] stray}'}),'{"response_json":{"passed":true,} }'])assert.throws(()=>contract.decode(value),e=>e.code==='MODEL_INVALID_RESPONSE'&&e.automaticRetry===false&&!e.jsonRepairable&&e.responseText===value&&!JSON.stringify(e).includes('responseText')&&!JSON.stringify(e).includes('stray'));
 for(const mutate of [r=>r.gaps=null,r=>r.groundingReview.claims=null,r=>r.groundingReview.claims[0].supported=null,r=>r.groundingReview.claims[0].foreign=null,r=>r.groundingReview.requirements[0].claimIds=[null],r=>delete r.passed]){const value=report();mutate(value);assert.throws(()=>decode(value));}
});
test('rejections, conflicts and business coverage survive exact normalization',()=>{
 const value=report();value.passed=false;value.gaps=['执行未证实'];value.groundingReview.claims[0].supported=false;value.groundingReview.claims[0].reason='只有计划，缺回执';
 value.groundingReview.unsupportedClaims=[{claimId:'c',reason:'缺回执'}];value.groundingReview.conflicts=[{claimIds:['c'],citationIds:['e'],reason:'来源否定执行'}];
 value.gapDetails=[{requirementId:'r',text:'执行未证实',sourceIds:['s'],relationKind:'physical_lineage',rootIds:['root'],artifactId:'a',stepId:'step',kind:'delivery'}];
 value.relationCoverage=[{obligationId:'o',status:'analyzed',coverage:'complete',rootIds:['root'],sourceIds:['s'],summary:'受限边界'}];value.suggestions=['保留缺口'];
 assert.deepEqual(decode(value),value);
});
test('every read family, computation, pagination and retryFull retain application protocol',()=>{
 const requests=[
  ...['read_source','search_source','read_section','read_segment'].map(tool=>({tool,sourceId:'s',...(tool==='search_source'?{query:'source terms'}:tool==='read_section'?{title:'条件'}:tool==='read_segment'?{index:2}:{}),start:0})),
  {tool:'read_artifact',artifactId:'a',start:0},
  {tool:'list_sources',query:'历史',start:24,limit:24,history:true},
  {tool:'list_sources',ref:'s1',start:0,limit:24},
  {tool:'list_sources',type:'artifact',taskId:'t',start:0,limit:24},
  {tool:'search_evidence',query:'待证问题',limit:2,ref:'ref'},
  {tool:'read_obligations',taskId:'t',obligationId:'o',section:'frontier',path:['x',2],start:0,limit:8,coverageVersion:'version'},
  {tool:'compute_evidence',operation:'ratio',inputs:[{sourceId:'s',start:0,end:2,unit:'人'},{sourceId:'s',start:3,end:5,unit:'人'}],args:{scale:2,rounding:'half_even'}},
  {tool:'compute_evidence',operation:'count',inputs:[{sourceId:'s',whole:true},{sourceId:'s',start:1,end:2}],args:{format:'json',filter:{column:'status',op:'eq',inputIndex:1}}},
  ...['file_observation','action_status'].map(operation=>({tool:'compute_evidence',operation,actionId:'action'})),
 ];
 for(const request of requests){const result=decode({kind:'read_context',requests:[request]});assert.deepEqual(result,{kind:'read_context',requests:[request]});if(require('../desktop/task-context.cjs').readTools.includes(request.tool))require('../desktop/task-context.cjs').validateRequest(result.requests[0]);}
 assert.deepEqual(decode({retryFull:true}),{retryFull:true});assert.deepEqual(decode({kind:'need_input',question:'哪一版本生效？'}),{kind:'need_input',question:'哪一版本生效？'});
 const nullable={tool:'read_source',sourceId:'s',artifactId:null,ref:null,title:null,query:null,index:null};assert.deepEqual(decode({kind:'read_context',requests:[nullable]}).requests,[{tool:'read_source',sourceId:'s'}]);
});
test('transport schema overhead is visible, conservatively budgeted and never actual usage',()=>{
 const messages=[{role:'user',content:'test'}],p={type:'codex',model:'offline'},profile={contextWindow:100000,maxOutputTokens:null};
 const budget=require('../desktop/input-budget.cjs'),attribution=require('../desktop/input-attribution.cjs');
 const before=budget.measure(p,messages,profile),after=budget.measure(p,messages,profile,contract.metadata);
 assert.equal(after.visibleRequestBytes-before.visibleRequestBytes,contract.metadata.utf8Bytes);
 const plain=attribution.measure(messages),measured=attribution.measure(messages,contract.metadata);assert.equal(measured.visibleUtf8Bytes-plain.visibleUtf8Bytes,contract.metadata.utf8Bytes);assert.deepEqual(measured.transportSchema,contract.metadata);assert.equal(measured.observedUsage,null);
 const settled=attribution.settle(measured,{inputTokens:101,outputTokens:17,cachedInputTokens:0});assert.equal(settled.observedUsage.totalTokens,118);assert.equal(Object.values(settled.categories).reduce((n,r)=>n+(r.estimatedInputTokens||0),0),101);
});
module.exports={report};
