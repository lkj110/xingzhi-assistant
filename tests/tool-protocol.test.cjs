// Every declared read adapter must use the common observation protocol.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),ledger=require('../desktop/operation-ledger.cjs'),registry=require('../desktop/tool-registry.cjs'),efficiency=require('../desktop/efficiency.cjs');
async function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-protocol-'))),a=new Assistant({dir,chat:async()=>{throw Error('Unexpected model');},connectorRequest:async()=>{throw Error('Unexpected connector');}});
 require('./helpers/platform-fixture.cjs').install(a);
 t.after(async()=>{a.stop();await a.runPromise;fs.rmSync(dir,{recursive:true,force:true});});await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 a.data.folders.push({id:'fixture',path:dir});
 a.data.agentSettings.githubRepo='fixture/repo';const j=agent.buildJob(a,{goal:'整理已有资料',allowWeb:true,useGithub:true,folderIds:['fixture'],dataPlatform:'sg-readonly'});a.data.delegations.push(j);
 const {taskId}=await agent.act(a,j,'plan_task',{key:'report',title:'报告',criteria:'内容完整',steps:[{key:'draft',title:'写正文',kind:'draft'}]}),task=a.task(taskId);
 const source=agent.source(a,j,'text','材料','owner Alice\n\n第二段');task.sourceIds.push(source.id);
 const platformSource=agent.source(a,j,'platform','平台来源',JSON.stringify({operation:'task',query:{op:'task',taskId:1},queriedAt:'2026-01-01T00:00:00Z',data:{id:1,owner:'Alice'}}),{platformSnapshot:true});
 const artifact={id:'artifact',taskId,stepId:task.steps[0].id,title:'正文',content:'正文 Alice'};a.data.artifacts.push(artifact);
 a.platformRequest=async()=>({id:1,owner:'Alice'});a.data.agentSettings.searchKey='fixture-sealed';t.mock.method(a.vault,'open',async()=> 'fixture-key');a.agentRequest=async()=>({status:200,body:JSON.stringify({results:[{title:'结果',url:'https://fixture.invalid/result',content:'Alice'}]})});
 const tools=require('../desktop/agent-tools.cjs');
 t.mock.method(tools,'readWeb',async url=>({url,title:'网页',content:'owner Alice'}));t.mock.method(tools,'listFiles',()=>[{name:'a.md'}]);t.mock.method(tools,'readDocument',async()=>({title:'文件',content:'owner Alice'}));
 t.mock.method(tools,'github',async()=>[{number:1,title:'事项',body:'owner Alice',state:'open',html_url:'https://github.com/fixture/repo/issues/1'}]);t.mock.method(tools,'readIssue',async()=>({title:'事项',content:'owner Alice',number:1}));
 const sentinel={sourceId:source.id,unchanged:true,fixture:{shape:'must survive'}};t.mock.method(require('../desktop/access.cjs'),'read',async()=>sentinel);
 a.data.capabilities.push({id:'fixture-capability',kind:'repository',name:'能力',enabled:true,revision:'fixture-revision',allowedTools:['read_document'],tools:[{name:'read_document'}]});
 j.capabilityGrants=[{id:'fixture-capability',revision:'fixture-revision'}];
 require('../desktop/access-policy-store.cjs').syncTrustedJob(a,j,{trusted:true,actor:'user_command',command:'fixtureExplicitCapabilities'});
 t.mock.method(require('../desktop/capabilities.cjs'),'invoke',async()=>({capabilityId:'fixture-capability',capabilityName:'能力',tool:'read_document',result:{path:'README.md',content:'owner Alice',next:null,total:11},usedVersion:{contentRevision:'same',checkedAt:new Date().toISOString()},recordId:require('node:crypto').randomUUID()}));
 return {a,j,task,source,platformSource,artifact,sentinel};
}
const tools={read_url:f=>({url:'https://fixture.invalid/article'}),list_files:f=>({folderId:'fixture'}),read_file:f=>({folderId:'fixture',name:'a.md'}),search_web:f=>({query:'Alice'}),github_list:f=>({}),github_read:f=>({number:1}),read_lark_document:f=>({url:'https://fixture.feishu.cn/docx/A'}),read_output_state:f=>({taskId:f.task.id}),capability_call:f=>({capabilityId:'fixture-capability',tool:'read_document',input:{path:'README.md'}}),platform_inventory:f=>({}),read_platform:f=>({sourceId:f.platformSource.id}),platform_query:f=>({queries:[{op:'task',taskId:1}]}),read_work_state:f=>({section:'frontier'}),list_sources:f=>({}),read_artifact:f=>({artifactId:f.artifact.id}),read_source:f=>({sourceId:f.source.id}),search_source:f=>({sourceId:f.source.id,query:'Alice'})};
test('All executable read adapters have an explicit shared protocol contract',()=>{
 assert.deepEqual(Object.values(registry.registry).filter(r=>r.effect==='read').map(r=>r.name).sort(),Object.keys(tools).sort());
 for(const [name,row]of Object.entries(registry.registry)){assert.equal(registry.get(name),row);assert.equal(row.scope,'delegation');assert.equal(row.adapter,1);assert.ok(Object.isFrozen(row));}
 assert.throws(()=>registry.get('unregistered_shell_tool'),/未声明|不可用/);
});
for(const [name,argsFor]of Object.entries(tools))test(`Read protocol: ${name} records observations without inventing new business facts`,async t=>{
 const f=await fixture(t),args=argsFor(f),observe=registry.observe;let adapterResult;t.mock.method(registry,'observe',(...parameters)=>{adapterResult=parameters[4];return observe(...parameters);});const result=await agent.act(f.a,f.j,name,args),key=registry.request(f.j,name,args,f.a),first=structuredClone(ledger.state(f.j).reads[key]),before=efficiency.progress(f.a,f.j);
 assert.equal(result,adapterResult,'the shared protocol must preserve the adapter result');
 assert.equal(first.tool,name);assert.equal(first.observations,1);assert.ok(first.fingerprint);assert.equal(typeof result,'object');
 await new Promise(r=>setTimeout(r,2));const second=await agent.act(f.a,f.j,name,args),next=ledger.state(f.j).reads[key];
 assert.equal(second,adapterResult);
 assert.equal(next.observations,2);assert.equal(next.fingerprint,first.fingerprint,'observation metadata must not change business fingerprint');assert.equal(next.unchanged,true);assert.equal(efficiency.progress(f.a,f.j),before);
 if(name==='read_lark_document'){assert.deepEqual(result,f.sentinel);assert.deepEqual(second,f.sentinel);}
 if(name==='read_output_state'){assert.equal(result.source,'app_workspace');assert.equal(result.externalAuthorizationRequired,false);assert.ok(result.readAt);assert.ok(Array.isArray(result.tasks));}
});
for(const [tool,minimal,expanded]of [
 ['read_source',{sourceId:'s'},{sourceId:'s',start:0,limit:6}],
 ['search_source',{sourceId:'s',query:'owner'},{sourceId:'s',query:'owner',start:0,limit:6}],
 ['read_artifact',{artifactId:'a'},{artifactId:'a',start:0}],
 ['read_platform',{sourceId:'s'},{sourceId:'s',start:0,limit:50}],
 ['list_sources',{}, {start:0,limit:40}],
 ['platform_inventory',{}, {start:0,queryStart:0,limit:100}],
 ['capability_call',{capabilityId:'c',tool:'read_document',input:{path:'README.md'}},{capabilityId:'c',tool:'read_document',input:{path:'README.md',start:0}}],
])test(`Equivalent read defaults share one request identity: ${tool}`,()=>{const j={id:'j',sourceIds:[],taskIds:[]},a={data:{capabilities:[{id:'c',kind:'repository'}]}};assert.equal(registry.request(j,tool,minimal,a),registry.request(j,tool,expanded,a));});
test('A same-named MCP read tool preserves declared fields and omitted defaults',async t=>{
 const f=await fixture(t),cap=f.a.data.capabilities.find(c=>c.id==='fixture-capability');cap.kind='mcp';
 const minimal={capabilityId:cap.id,tool:'read_document',input:{path:'README.md',note:'server-defined value'}},explicit={...minimal,input:{...minimal.input,start:0}},before=structuredClone(minimal);
 const capabilities=require('../desktop/capabilities.cjs');assert.deepEqual(capabilities.normalizeArguments(f.a,minimal),before);assert.notEqual(registry.request(f.j,'capability_call',minimal,f.a),registry.request(f.j,'capability_call',explicit,f.a));
 let received;const invoke=capabilities.invoke;t.mock.method(capabilities,'invoke',async(a,j,args)=>{received=args;return invoke(a,j,args);});
 await agent.act(f.a,f.j,'capability_call',minimal);assert.deepEqual(received,minimal);assert.deepEqual(minimal,before);
 await agent.act(f.a,f.j,'capability_call',explicit);assert.deepEqual(received,explicit);
});
test('An unrelated new read does not erase an existing stalled action counter',async t=>{
 const f=await fixture(t),args={sourceId:f.source.id},run=async(tool,input)=>{const before=efficiency.progress(f.a,f.j),step={tool,args:input,result:await agent.act(f.a,f.j,tool,input)};efficiency.checkProgress(f.a,f.j,step,before);};
 await run('read_source',args);await run('read_source',args);await run('platform_query',{queries:[{op:'task',taskId:888}]});await assert.rejects(run('read_source',args),e=>e.noProgress);
});
test('Repeated output-state inspection is bounded despite changing readAt metadata',async t=>{
 const f=await fixture(t);let stop;
 for(let n=0;n<6;n++){const before=efficiency.progress(f.a,f.j),step={tool:'read_output_state',args:{taskId:f.task.id}};step.result=await agent.act(f.a,f.j,step.tool,step.args);try{efficiency.checkProgress(f.a,f.j,step,before);}catch(e){stop=e;break;}await new Promise(r=>setTimeout(r,2));}
 assert.equal(stop?.code,'NO_NEW_EVIDENCE');
});
for(const [name,argsFor]of Object.entries(tools))test(`Ignored adapter fields cannot evade the persistent no-progress guard: ${name}`,async t=>{
 const f=await fixture(t);let stop;
 for(let n=0;n<8;n++){
  const before=efficiency.progress(f.a,f.j),step={tool:name,args:{...argsFor(f),note:'planner explanation '+n}};
  step.result=await agent.act(f.a,f.j,step.tool,step.args);
  try{efficiency.checkProgress(f.a,f.j,step,before);}catch(e){stop=e;break;}
 }
 assert.equal(stop?.code,'NO_NEW_EVIDENCE');
});
