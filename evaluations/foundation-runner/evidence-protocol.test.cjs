'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {evidenceProtocol}=require('./evidence-protocol.cjs'),guard=require('./protocol-guard.cjs');
const replay=require('../../tests/fixtures/foundation-evidence-format-replays.json');
const fixture=()=>({format:'compact-v3',scannedArtifactIds:['a1'],citations:[{id:'e1',sourceId:'s1',quote:'原文',start:0}],requirements:[{id:'r1',status:'satisfied',claimIds:['c1']}],claims:[{id:'c1',artifactId:'a1',text:'原文',kind:'fact',supported:true,citationIds:['e1']}],unsupportedClaims:[],conflicts:[]});
const envelope=r=>JSON.stringify({response_json:JSON.stringify(r)});
const verify=g=>({passed:true,summary:'离线合成结构检查',gaps:[],groundingReview:g});
test('compact and legacy inline reports keep their existing structures',()=>{
 const g=fixture();assert.equal(evidenceProtocol(g),g);
 const legacy=fixture();delete legacy.format;delete legacy.citations;legacy.claims[0].citations=[{sourceId:'s1',quote:'原文'}];delete legacy.claims[0].citationIds;
 assert.equal(evidenceProtocol(legacy),legacy);legacy.sourceConflicts=[];assert.equal(evidenceProtocol(legacy),legacy);
});
test('semantic refusals and unbound references are not reclassified as structural errors',()=>{
 const g=fixture();g.claims[0].supported=false;g.claims[0].reason='没有依据';g.requirements[0].status='gap';g.requirements[0].reason='不满足要求';g.conflicts=['同级原文相互冲突'];g.unsupportedClaims=['c1'];
 assert.doesNotThrow(()=>guard.response(envelope({...verify(g),passed:false,gaps:['没有依据']}),{payload:{},role:'verify'}));
 g.claims[0].citationIds=['unbound'];g.citations[0].quote='并非实际原文';assert.doesNotThrow(()=>evidenceProtocol(g),'Evidence semantics remain product-owned');
});
test('nested array element types, enums and reference formats are validated before release',()=>{
 const mutations=[
  g=>g.scannedArtifactIds=[{}],g=>g.requirements=[null],g=>g.requirements[0].id=7,g=>g.requirements[0].status='unmet',g=>g.requirements[0].claimIds=[{}],g=>g.requirements[0].reason={},g=>g.requirements[0].deferredStepId=0,
  g=>g.claims=[[]],g=>g.claims[0].id=7,g=>g.claims[0].artifactId=null,g=>g.claims[0].text={},g=>g.claims[0].kind='directive',g=>g.claims[0].supported='true',g=>g.claims[0].citationIds=[{}],g=>g.claims[0].reason=[],g=>g.claims[0].citations=[],
  g=>g.citations=[null],g=>g.citations[0].id=3,g=>g.citations[0].sourceId={},g=>g.citations[0].quote=[],g=>g.citations[0].start=0.5,g=>g.citations[0].start=-1,g=>delete g.citations,
  g=>g.unsupportedClaims=[{}],g=>g.conflicts=[{reason:'未解决的冲突'}],g=>g.conflicts=[null],g=>g.format='compact-v99',g=>g.sourceConflicts=[null],g=>g.sourceConflicts={},
 ];
 for(const mutate of mutations){const g=fixture();mutate(g);assert.throws(()=>evidenceProtocol(g),e=>e.code==='RUNNER_EVIDENCE_FORMAT'&&e.field.startsWith('groundingReview'));}
});
test('source-conflict structure keeps semantic disclosure bindings product-owned',()=>{
 const g=fixture();g.sourceConflicts=[{disposition:'disclosed_unknown',claimIds:['c1'],requirementIds:['r1'],citationIds:['e1'],reason:'结构通过不代表披露或双方原文已满足'}];
 assert.doesNotThrow(()=>evidenceProtocol(g));
 for(const mutate of [c=>c.claimIds=[{}],c=>c.requirementIds=null,c=>c.citationIds=7,c=>c.reason=[],c=>c.disposition='unresolved']){const copy=structuredClone(g);mutate(copy.sourceConflicts[0]);assert.throws(()=>evidenceProtocol(copy),{code:'RUNNER_EVIDENCE_FORMAT'});}
});
test('existing report limits, duplicate record ids and mixed citation formats fail as protocol errors',()=>{
 const mutations=[g=>g.claims.push(structuredClone(g.claims[0])),g=>g.requirements.push(structuredClone(g.requirements[0])),g=>g.citations.push(structuredClone(g.citations[0])),
  g=>g.claims=Array.from({length:161},(_,i)=>({...g.claims[0],id:'c'+i})),g=>g.requirements=Array.from({length:81},(_,i)=>({...g.requirements[0],id:'r'+i})),g=>g.citations=Array.from({length:1281},(_,i)=>({...g.citations[0],id:'e'+i})),
  g=>g.claims[0].citationIds=['e1','e1'],g=>g.claims[0].citationIds=Array.from({length:9},(_,i)=>'e'+i),g=>g.claims[0].text='x'.repeat(3001),g=>g.citations[0].quote='x'.repeat(1201),
  g=>g.sourceConflicts=Array.from({length:81},()=>({})),g=>g.sourceConflicts=[{disposition:'disclosed_unknown',claimIds:['c1'],requirementIds:['r1'],citationIds:['e1','e1'],reason:'duplicate'}],
 ];
 for(const mutate of mutations){const g=fixture();mutate(g);assert.throws(()=>evidenceProtocol(g),{code:'RUNNER_EVIDENCE_FORMAT'});}
 const legacy=fixture();delete legacy.format;delete legacy.citations;delete legacy.claims[0].citationIds;legacy.claims[0].citations=Array.from({length:9},()=>({sourceId:'s1',quote:'q'}));
 assert.throws(()=>evidenceProtocol(legacy),{code:'RUNNER_EVIDENCE_FORMAT'});
});
for(const sample of replay.cases)test(sample.caseId+': exact recorded model response is rejected at conflicts field',()=>{
 assert.equal(crypto.createHash('sha256').update(sample.rawOutput).digest('hex'),sample.rawOutputSha256);
 assert.throws(()=>guard.response(sample.rawOutput,{payload:{},role:'verify'}),e=>e.code==='RUNNER_EVIDENCE_FORMAT'&&e.field==='groundingReview.conflicts');
 const valid=JSON.parse(JSON.parse(sample.rawOutput).response_json);valid.groundingReview.conflicts=valid.groundingReview.conflicts.map(c=>c.reason);
 assert.equal(guard.response(envelope(valid),{payload:{},role:'verify'}).passed,false,'Same negative semantics with valid string[] remains a business refusal');
});
