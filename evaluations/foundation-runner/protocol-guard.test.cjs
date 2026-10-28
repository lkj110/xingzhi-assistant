'use strict';
// Synthetic objects and local files only. Importing invocation does not create a
// broker, launch a CLI, inspect login state, or dispatch any model request.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const guard=require('./protocol-guard.cjs'),{invocation}=require('./broker.cjs');
const protocol=require('../../desktop/subscription-protocol.cjs');
const {project}=require('../foundation-acceptance-20261028/inputs.cjs');
const suite=require('../foundation-acceptance-20261028/stimuli.json'),plan=require('../foundation-acceptance-20261028/plan.json');
const copy=v=>JSON.parse(JSON.stringify(v));
const envelope=v=>JSON.stringify({response_json:JSON.stringify(v)});
function fixture(spec=suite.cases[0]){
 const input=project(spec),sources=input.sources.map((s,i)=>({...s,id:'source-'+i}));
 const context={id:spec.id,taskId:'task-control',title:input.title,description:input.description,criteria:input.criteria,sources};
 const payload={task:{id:context.taskId,title:context.title,description:context.description,criteria:context.criteria,sourceIds:sources.map(s=>s.id)},sources:copy(sources),
  sourceCatalog:sources.map(s=>({id:s.id,title:s.title,type:'source',purpose:'input'})),contextReads:sources.map(s=>({result:{sourceId:s.id,content:s.content.slice(0,12)}}))};
 return {context,payload,messages:[{role:'system',content:'Synthetic application protocol'},{role:'user',content:JSON.stringify(payload)}]};
}
function invocationFixture(t){
 const tmp=fs.realpathSync(os.tmpdir()),cwd=fs.realpathSync(fs.mkdtempSync(path.join(tmp,'xingzhi-model-guard-test-')));
 t.after(()=>{assert.ok(cwd.startsWith(tmp+path.sep)&&path.basename(cwd).startsWith('xingzhi-model-guard-test-'));fs.rmSync(cwd,{recursive:true,force:true});});
 const schemaPath=path.join(cwd,'schema.json'),output=path.join(cwd,'response.json');
 const schema={type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false};
 fs.writeFileSync(schemaPath,JSON.stringify(schema));
 const f=fixture(),body={cwd,args:['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--color','never','--json','--model',plan.model.id,
  ...protocol.configuration(),'-c',`model_reasoning_effort=${JSON.stringify(plan.model.reasoning)}`,'--output-schema',schemaPath,'--output-last-message',output,'-'],input:protocol.serialize(f.messages)};
 return {...f,body,schema,schemaPath};
}
const verify=()=>({passed:true,summary:'Synthetic structural review only',gaps:[],groundingReview:{scannedArtifactIds:['draft-1'],requirements:[],claims:[],unsupportedClaims:[],conflicts:[]}});

for(const spec of suite.cases)test(spec.id+': sealed business projection accepts normal task, sources, catalog and partial reads',()=>{
 const f=fixture(spec);assert.doesNotThrow(()=>guard.request(f.messages,f.payload,f.context));
 if(spec.revision){f.context.revised=true;f.context.revisionNote=spec.revision.note;f.payload.revision={note:spec.revision.note,originalContent:'合成初稿，尚未领取。'};f.messages[1].content=JSON.stringify(f.payload);assert.doesNotThrow(()=>guard.request(f.messages,f.payload,f.context));}
});

test('foreign task identity and changed requirements cannot enter a sealed case',()=>{
 for(const key of ['id','title','description','criteria']){const f=fixture();f.payload.task[key]+=' altered';assert.throws(()=>guard.request(f.messages,f.payload,f.context),key);}
});
test('foreign source ids, altered source bodies, catalogs and read results are rejected',()=>{
 const changes=[
  f=>f.payload.task.sourceIds.push('foreign'),
  f=>f.payload.sources.push({id:'foreign',content:'unapproved'}),
  f=>f.payload.sources[0].content+=' invented',
  f=>f.payload.sourceCatalog.push({id:'foreign',type:'source',purpose:'input'}),
  f=>f.payload.contextReads.push({result:{sourceId:'foreign',content:'unapproved'}}),
  f=>f.payload.contextReads[0].result.content='A synthetic fragment absent from the sealed source',
 ];
 for(const change of changes){const f=fixture();change(f);assert.throws(()=>guard.request(f.messages,f.payload,f.context));}
});
test('extra assistant/repair messages and non-string message content are rejected',()=>{
 for(const extra of [{role:'assistant',content:'repair'},{role:'user',content:'repair'}]){const f=fixture();f.messages.push(extra);assert.throws(()=>guard.request(f.messages,f.payload,f.context),/Unplanned repair/);}
 const f=fixture();f.messages[1].content={};assert.throws(()=>guard.request(f.messages,f.payload,f.context));
});
test('unplanned revision, changed revision note and revisionRecovery are rejected',()=>{
 let f=fixture();f.payload.revisionRecovery={retry:true};assert.throws(()=>guard.request(f.messages,f.payload,f.context),/revision recovery/);
 f=fixture();f.payload.revision={note:'new instruction',originalContent:'draft'};assert.throws(()=>guard.request(f.messages,f.payload,f.context));
 f.context.revised=true;f.context.revisionNote='frozen instruction';assert.throws(()=>guard.request(f.messages,f.payload,f.context));
});
test('actual invocation accepts the fixed outer schema and exact subscription serialization',t=>{
 const f=invocationFixture(t),call=invocation(f.body,plan);assert.equal(call.role,'execute');assert.equal(call.payload.task.id,f.context.taskId);assert.equal(call.serializedInputBytes,Buffer.byteLength(f.body.input));assert.equal(call.schemaBytes,fs.statSync(f.schemaPath).size);guard.request(call.messages,call.payload,f.context);
});
test('gold canary anywhere in application input is rejected before the request guard',t=>{
 const f=invocationFixture(t);for(const marker of ['FOUNDATION_GOLD_ONLY_SYNTHETIC','FOUNDATION_CANDIDATE_GOLD_ONLY_SYNTHETIC'])for(const index of [0,1]){const messages=copy(f.messages);messages[index].content+=' '+marker;assert.throws(()=>invocation({...f.body,input:protocol.serialize(messages)},plan));}
});
test('outer CLI schema or invocation drift is rejected',t=>{
 const f=invocationFixture(t);
 for(const schema of [{...f.schema,additionalProperties:true},{...f.schema,required:[]},{...f.schema,properties:{response_json:{type:'object'}}},null]){fs.writeFileSync(f.schemaPath,JSON.stringify(schema));assert.throws(()=>invocation(f.body,plan));}
 fs.writeFileSync(f.schemaPath,JSON.stringify(f.schema));
 const wrongModel=copy(f.body);wrongModel.args[wrongModel.args.indexOf('--model')+1]='unexpected-model';assert.throws(()=>invocation(wrongModel,plan),/CLI protocol changed/);
 assert.throws(()=>invocation({...f.body,input:'Not the frozen application protocol'},plan));
});

test('valid artifact, verifier structure and local read requests are accepted',()=>{
 const artifact={kind:'artifact',title:'合成稿',content:'这是测试文稿。'};assert.deepEqual(guard.response(envelope(artifact),{payload:{},role:'execute'}),artifact);
 assert.deepEqual(guard.response(envelope(verify()),{payload:{},role:'verify'}),verify());
 for(const tool of ['read_source','search_source','read_section','read_artifact','read_segment','list_sources']){
  const r={kind:'read_context',requests:[{tool,sourceId:'source-0'}]};
  for(const role of ['execute','verify'])assert.deepEqual(guard.response(envelope(r),{payload:{},role}),r);
 }
});
test('invalid envelope JSON, shape, extra fields and invalid inner JSON are rejected',()=>{
 const invalid=['not-json','null','[]','"string"','{}',JSON.stringify({response_json:{}}),JSON.stringify({response_json:'{}',extra:true}),JSON.stringify({response_json:'broken'}),JSON.stringify({response_json:'[]'}),JSON.stringify({response_json:'null'})];
 for(const raw of invalid)assert.throws(()=>guard.response(raw,{payload:{},role:'execute'}),raw);
});
test('generation and verifier structural errors fail before any semantic judgement',()=>{
 for(const value of [{kind:'artifact',title:'',content:'x'},{kind:'artifact',title:'x',content:''},{kind:'artifact',title:'x',content:7},{kind:'unknown',title:'x',content:'x'}])assert.throws(()=>guard.response(envelope(value),{payload:{},role:'execute'}));
 const changes=[v=>v.passed='true',v=>v.summary=null,v=>v.gaps=[{}],v=>delete v.groundingReview];
 for(const key of ['scannedArtifactIds','requirements','claims','unsupportedClaims','conflicts'])changes.push(v=>v.groundingReview[key]={});
 for(const change of changes){const v=verify();change(v);assert.throws(()=>guard.response(envelope(v),{payload:{},role:'verify'}));}
});
test('read_context rejects empty/excess requests, unknown or host tools and non-object entries',()=>{
 for(const requests of [[],Array.from({length:5},()=>({tool:'read_source'})),[{tool:'exec'}],[{tool:'command_execution'}],[null],['read_source']])assert.throws(()=>guard.response(envelope({kind:'read_context',requests}),{payload:{},role:'execute'}));
});
test('exact non-overlapping Unicode patches and revision source reads are accepted',()=>{
 const payload={revision:{originalContent:'甲：10套；乙：20套。'}},r={kind:'patch',edits:[{before:'乙：20套',after:'乙：21套'},{before:'甲：10套',after:'甲：11套'}]};
 assert.deepEqual(guard.response(envelope(r),{payload,role:'execute'}),r);
 assert.doesNotThrow(()=>guard.response(envelope({kind:'read_context',requests:[{tool:'read_source',sourceId:'source-0'}]}),{payload,role:'execute'}));
});
test('patches must bind once to the original and cannot overlap',()=>{
 const payload={revision:{originalContent:'abcde repeated repeated tail'}};
 for(const edits of [[{before:'missing',after:'x'}],[{before:'repeated',after:'x'}],[{before:'abc',after:'x'},{before:'bcd',after:'y'}],[{before:'tail',after:'x'},{before:'tail',after:'y'}]])assert.throws(()=>guard.response(envelope({kind:'patch',edits}),{payload,role:'execute'}));
});
test('invalid, no-op, oversized and empty-result patches cannot trigger repair or a full rewrite',()=>{
 const payload={revision:{originalContent:'original'}};
 const invalid=[{kind:'artifact',title:'rewrite',content:'new'}, {kind:'patch',edits:[]},{kind:'patch',edits:Array.from({length:13},()=>({before:'original',after:'x'}))},
  ...[{before:'',after:'x'},{before:'original',after:'original'},{before:'original',after:null},{before:'original',after:''},{before:'original',after:'x'.repeat(25001)},{before:'x'.repeat(12001),after:'x'}].map(edit=>({kind:'patch',edits:[edit]}))];
 for(const value of invalid)assert.throws(()=>guard.response(envelope(value),{payload,role:'execute'}));
});

test('inner Markdown JSON fences and string wrapping match the frozen model-json decoder',()=>{
 const parser=require('../../desktop/model-json.cjs'),artifact={kind:'artifact',title:'编码兼容稿',content:'只对JSON编码解包，不改变业务正文。'},json=JSON.stringify(artifact);
 const innerVariants=['```json\n'+json+'\n```',JSON.stringify(json),JSON.stringify('```JSON\n'+json+'\n```'),'\uFEFF  '+json];
 for(const inner of innerVariants){const raw=JSON.stringify({response_json:inner});assert.deepEqual(parser.subscription(raw),artifact);assert.deepEqual(guard.response(raw,{payload:{},role:'execute'}),artifact);}
 const missingBody=JSON.stringify({response_json:'```json\n'+JSON.stringify({kind:'artifact',title:'缺正文'})+'\n```'});
 assert.equal(parser.subscription(missingBody).kind,'artifact');assert.throws(()=>guard.response(missingBody,{payload:{},role:'execute'}),'Encoding compatibility must not waive required business fields');
});
test('read_context tool alias with args.requests preserves valid local read behavior',()=>{
 const r={tool:'read_context',args:{requests:[{tool:'read_source',sourceId:'source-0'},{tool:'read_artifact',artifactId:'draft-1'}]}};
 for(const role of ['execute','verify'])assert.deepEqual(guard.response(envelope(r),{payload:{},role}),r);
 for(const requests of [[],Array.from({length:5},()=>({tool:'read_source'})),[{tool:'exec'}],[null]])assert.throws(()=>guard.response(envelope({tool:'read_context',args:{requests}}),{payload:{},role:'verify'}));
});
test('retryFull only accepts the verifier incremental previousCheck branch',()=>{
 const r={retryFull:true};assert.deepEqual(guard.response(envelope(r),{payload:{previousCheck:{basis:'synthetic-previous-basis'}},role:'verify'}),r);
 for(const previousCheck of [undefined,null,false])assert.throws(()=>guard.response(envelope(r),{payload:{previousCheck},role:'verify'}));
 assert.throws(()=>guard.response(envelope(r),{payload:{previousCheck:{basis:'synthetic'}},role:'execute'}));
});
test('explicit reused evidence permits no new groundingReview but retains verification fields',()=>{
 const r={passed:true,summary:'相同依据的事实核验已复用，本次交付要求也已核对。',gaps:[]};
 assert.deepEqual(guard.response(envelope(r),{payload:{groundingReviewRequest:{reused:true}},role:'verify'}),r);
 for(const reused of [undefined,false,'true'])assert.throws(()=>guard.response(envelope(r),{payload:{groundingReviewRequest:{reused}},role:'verify'}));
 for(const changed of [{...r,summary:''},{...r,passed:'true'},{...r,gaps:['仍有未满足要求']},{...r,gaps:null}])assert.throws(()=>guard.response(envelope(changed),{payload:{groundingReviewRequest:{reused:true}},role:'verify'}));
});
