'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs');
const grounding=require('../desktop/grounding.cjs');
const tools=require('../desktop/agent-tools.cjs');
const lark=require('../desktop/lark-publish.cjs');
const input='会议确认：产品定于周五发布，仅限内测用户。';
const content='产品定于周五发布，仅限内测用户。';
const url='https://test.feishu.cn/docx/GroundingRace123';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const ready=()=>({verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'ou_grounding',scope:'docx:document:create docx:document:write_only docx:document:readonly'}}});

function fixture(t,tool='github_create'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-grounding-race-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const a=new Assistant({dir});a.data.settings.evidenceGrounding=true;
 a.addSources([{title:'会议原文',content:input}]);const source=a.data.sources[0];
 const task=a.createTask({title:'发布摘要',description:'根据原文编写摘要',criteria:'说明日期和适用范围',sourceIds:[source.id],steps:[{title:'摘要',kind:'draft'}]});
 const job={id:'grounding-race-job',projectId:null,title:'发布摘要',goal:'交付核验后的摘要',taskIds:[task.id],sourceIds:[source.id],status:'ready',feedback:[],followups:[],history:[],watchers:[],githubRepo:'example/grounding-race',githubMode:'auto',githubUpdateMode:'auto',githubCommentMode:'auto',larkCreateGrant:{target:'my_library',openId:'ou_grounding'}};
 task.agentJobId=job.id;a.data.delegations.push(job);
 const step=task.steps[0],draft={id:'grounding-race-draft',taskId:task.id,stepId:step.id,title:'发布摘要',content};
 a.data.artifacts.push(draft);step.done=true;step.artifactId=draft.id;task.primaryArtifactId=draft.id;
 // Isolate the delivery race from permission setup. Original evidence resolution,
 // grounding validation, hashing and transport-boundary guards remain real.
 a.contextAccessCheck=()=>({allowed:true,decision:'allow',revision:1});
 t.mock.method(require('../desktop/protocol-access.cjs'),'assertTool',()=>{});
 t.mock.method(require('../desktop/execution-gate.cjs'),'assert',()=>{});
 const record={id:'grounding-race-action',jobId:job.id,taskId:task.id,tool,target:tool.startsWith('lark_')?'my_library':job.githubRepo,larkOpenId:'ou_grounding',key:'abc123',number:7,title:task.title,content,artifactId:draft.id,args:{taskId:task.id},status:'running'};
 if(tool==='github_update')record.desired={body:content};
 if(tool==='lark_update')record.baseline={url,documentId:'GroundingRace123',revision:1,readbackHash:hash(content)};
 a.data.agentActions.push(record);
 const snapshot=grounding.snapshot(a,task),seen=new Set();
 grounding.observe(seen,{artifacts:[draft],contextReads:[{result:{sourceId:source.id,version:snapshot.sources[0].version,content:input}}]});
 const report=grounding.finish(a,task,{passed:true,summary:'独立核验通过',gaps:[],groundingReview:{scannedArtifactIds:[draft.id],requirements:snapshot.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['c1'],reason:'原文明确说明'})),claims:[{id:'c1',artifactId:draft.id,text:content,kind:'fact',supported:true,reason:'与会议原文一致',citations:[{sourceId:source.id,quote:input}]}],unsupportedClaims:[],conflicts:[]}},{seen,phase:'content'});
 assert.equal(report.passed,true,report.gaps.join('\n'));task.grounding=report.grounding;
 task.contentVerification={passed:true,summary:'独立核验通过',gaps:[],basis:require('../desktop/execution-control.cjs').contentBasis(a,job,task),at:new Date().toISOString()};
 a.data.agentSettings.githubRepo=job.githubRepo;a.data.agentSettings.githubToken='fixture-sealed-token';
 return {a,job,task,source,draft,record};
}
function change(f,kind){if(kind==='source')f.source.content+='\n更正：发布时间改为周六。';else f.draft.content+='\n建议延后发布。';}
function requestFor(record){return record.tool==='github_create'?{route:'issues',method:'POST',body:{title:record.title,body:`${record.content}\n\n<!-- xingzhi:${record.key} -->`}}:record.tool==='github_comment'?{route:'issues/7/comments',method:'POST',body:{body:`${record.content}\n\n<!-- xingzhi:${record.key} -->`}}:{route:'issues/7',method:'PATCH',body:record.desired};}

for(const tool of ['github_create','github_comment','github_update'])for(const kind of ['source','draft'])test(`${tool}: ${kind} changed while opening credentials blocks the final write`,async t=>{
 const f=fixture(t,tool);let opens=0,posts=0;
 f.a.vault={open:async()=>{opens++;await Promise.resolve();change(f,kind);return 'fixture-token';}};
 f.a.agentRequest=async()=>{posts++;return {body:'{}'};};
 const {route,...request}=requestFor(f.record);
 await assert.rejects(tools.github(f.a,f.job.githubRepo,route,{...request,action:f.record}),{code:'GROUNDING_REQUIRED'});
 assert.equal(opens,1,'the asynchronous credential boundary was reached');assert.equal(posts,0);
});

test('GitHub GET reconciliation remains available when grounding is stale',async t=>{
 const f=fixture(t);change(f,'source');let gets=0;
 f.a.vault={open:async()=>'fixture-token'};f.a.agentRequest=async(_url,options)=>{assert.equal(options.method,'GET');gets++;return {body:'{"number":7}'};};
 assert.equal((await tools.github(f.a,f.job.githubRepo,'issues/7',{permissionScope:f.job})).number,7);assert.equal(gets,1);
});

test('unchanged grounded GitHub update accepts only its preserved transport marker suffix',async t=>{
 const f=fixture(t,'github_update');let writes=0;
 f.record.baseline={body:'旧正文\n\n<!-- xingzhi:deadbeef -->'};
 f.record.desired.body=content+'\n\n<!-- xingzhi:deadbeef -->';
 f.a.vault={open:async()=>'fixture-token'};
 f.a.agentRequest=async(_url,options)=>{writes++;assert.equal(JSON.parse(options.body).body,f.record.desired.body);return {body:'{"number":7}'};};
 const {route,...request}=requestFor(f.record);
 assert.equal((await tools.github(f.a,f.job.githubRepo,route,{...request,action:f.record})).number,7);assert.equal(writes,1);
 f.record.desired.body+='\n未经核验的新结论';
 await assert.rejects(tools.github(f.a,f.job.githubRepo,route,{...request,action:f.record}),{code:'GROUNDING_REQUIRED'});assert.equal(writes,1);
});

test('disabled grounding preserves the existing GitHub delivery behavior',async t=>{
 const f=fixture(t);f.a.data.settings.evidenceGrounding=false;let posts=0;
 f.a.vault={open:async()=>{await Promise.resolve();change(f,'source');return 'fixture-token';}};
 f.a.agentRequest=async()=>{posts++;return {body:'{"number":7}'};};
 const {route,...request}=requestFor(f.record);
 assert.equal((await tools.github(f.a,f.job.githubRepo,route,{...request,action:f.record})).number,7);assert.equal(posts,1);
});

for(const tool of ['lark_create','lark_update'])for(const kind of ['source','draft'])test(`${tool}: ${kind} changed during final identity lookup blocks submission`,async t=>{
 const f=fixture(t,tool);let statuses=0,posts=0,submitted=0;
 t.mock.method(require('../desktop/protocol-access.cjs'),'readLarkDocument',async()=>({result:{items:[{content,remoteRevision:1,warnings:[]}]}}));
 f.a.connectorRequest=async args=>{if(args[1]==='status'){statuses++;await Promise.resolve();change(f,kind);return ready();}posts++;throw Error('Unexpected publish');};
 const run=tool==='lark_create'?lark.create:lark.update;
 await assert.rejects(run(f.a,f.record,()=>{submitted++;}),{code:'GROUNDING_REQUIRED'});
 assert.equal(statuses,1);assert.equal(submitted,0);assert.equal(posts,0);
});

test('Lark update rechecks evidence after awaiting the original document readback',async t=>{
 const f=fixture(t,'lark_update');let reads=0,posts=0,submitted=0;
 t.mock.method(require('../desktop/protocol-access.cjs'),'readLarkDocument',async()=>{reads++;await Promise.resolve();change(f,'source');return {result:{items:[{content,remoteRevision:1,warnings:[]}]}};});
 f.a.connectorRequest=async args=>{if(args[1]==='status')return ready();posts++;throw Error('Unexpected publish');};
 await assert.rejects(lark.update(f.a,f.record,()=>{submitted++;}),{code:'GROUNDING_REQUIRED'});
 assert.equal(reads,1);assert.equal(submitted,0);assert.equal(posts,0);
});
