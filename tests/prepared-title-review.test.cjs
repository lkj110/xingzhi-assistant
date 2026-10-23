'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const ground=require('../desktop/grounding.cjs'),agent=require('../desktop/agent.cjs');
const writes=require('../desktop/agent-writes.cjs'),control=require('../desktop/execution-control.cjs');
const policy=require('../desktop/execution-policy.cjs'),continuation=require('../desktop/continuation-control.cjs');

async function fixture(t,mode='auto'){
 const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'prepared-title-review-'));
 t.after(()=>{const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),base);assert.ok(path.basename(resolved).startsWith('prepared-title-review-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5});});
 let a,task,job,source,draft,verificationCalls=0,posts=0,remote,failReview=false;
 const report=()=>{
  const s=ground.snapshot(a,task);
  return {passed:!failReview,summary:failReview?'标题含未获支持的结论':'独立核验通过',gaps:failReview?['标题含未获支持的结论']:[],groundingReview:{
   format:'compact-v5',scannedArtifactIds:[draft.id],
   citations:[{id:'e',sourceId:source.id,quote:source.content}],
   claims:[{id:'c',artifactId:draft.id,field:'content',text:draft.content,kind:'fact',supported:true,citationIds:['e']}],
   requirements:s.requirements.map(r=>({id:r.id,status:failReview?'gap':'satisfied',claimIds:['c']})),
   unsupportedClaims:failReview?['标题含未获支持的结论']:[],conflicts:[],consistencyIssues:[]
  }};
 };
 const chat=async()=>{verificationCalls++;return report();};
 a=new Assistant({dir,chat});a.data.settings.evidenceGrounding=true;
 await a.dispatch('saveProvider',{name:'offline-review',baseUrl:'http://127.0.0.1:1/v1',model:'fake-only',key:'offline-only',inputPrice:0,outputPrice:0});
 a.addSources([{title:'会议记录',content:'发布仅限内测用户。'}]);source=a.data.sources[0];
 task=a.createTask({title:'发布摘要',description:'如实报告',criteria:'保留适用范围',sourceIds:[source.id],steps:[{title:'主稿',kind:'draft'},{title:'发布',kind:'external',tool:'github_create'}]});
 task.steps.forEach((step,i)=>{step.key='step-'+(i+1);});task.steps[1].tool='github_create';task.dependsOn=[];
 job={id:'prepared-title-job',projectId:null,title:'发布摘要',goal:'交付已核验摘要',taskIds:[task.id],sourceIds:[source.id],status:'ready',feedback:[],followups:[],history:[],watchers:[],githubRepo:'example/offline-review',githubMode:mode,maxCalls:50,maxActions:12,callsUsed:0};
 task.agentJobId=job.id;a.data.delegations.push(job);
 a.data.agentSettings.githubRepo=job.githubRepo;a.data.agentSettings.githubToken='offline-fixture-never-opened';
 require('../desktop/access-policy-store.cjs').syncTrustedJob(a,job,{trusted:true,actor:'user_command',command:'offline-test-fixture'});
 draft={id:'prepared-title-draft',taskId:task.id,stepId:task.steps[0].id,title:'发布摘要',content:source.content};
 a.data.artifacts.push(draft);task.steps[0].done=true;task.steps[0].artifactId=draft.id;task.primaryArtifactId=draft.id;
 const configure=()=>{
  // Scope setup is explicit. These tests exercise review routing, not credentials.
  a.requireContextAccessPolicy=false;
  a.contextAccessCheck=()=>({allowed:true,decision:'allow',revision:1});
 };
 configure();
 t.mock.method(require('../desktop/protocol-access.cjs'),'assertTool',()=>{});
 t.mock.method(require('../desktop/execution-facts.cjs'),'actionGuard',()=>null);
 t.mock.method(require('../desktop/agent-tools.cjs'),'findIssue',async()=>null);
 t.mock.method(require('../desktop/agent-tools.cjs'),'github',async(_a,_repo,_route,options={})=>{
  if(options.method==='POST'){
   posts++;
   remote={number:17,title:options.body.title,body:options.body.body,state:'open',html_url:'https://github.com/example/offline-review/issues/17',updated_at:'2026-10-23T00:00:00Z'};
  }
  assert.ok(remote,'No readback can precede the one fake write');
  return structuredClone(remote);
 });
 const snap=ground.snapshot(a,task),seen=new Set();
 ground.observe(seen,{artifacts:[draft],groundingReviewRequest:require('../desktop/verification-titles.cjs').request(a,task),contextReads:[{result:{sourceId:source.id,version:snap.sources[0].version,content:source.content}}]});
 const initial=ground.finish(a,task,report(),{seen,phase:'content'});
 assert.equal(initial.passed,true,initial.gaps.join('\n'));
 task.grounding=initial.grounding;
 task.contentVerification={...initial,basis:control.contentBasis(a,job,task),at:new Date().toISOString()};
 a.save();
 return {
  get a(){return a;},get task(){return task;},get job(){return job;},
  get calls(){return verificationCalls;},get posts(){return posts;},
  fail(){failReview=true;},
  async prepare(){return agent.act(a,job,'github_create',{taskId:task.id});},
  decision(){return policy.inspect(a,job,{mode:'manual'});},
  async check(){const claimed=policy.claim(a,job,{mode:'manual'});assert.equal(claimed.tool,'verify_content');return agent.act(a,job,claimed.tool,claimed.args);},
  async execute(){const claimed=policy.claim(a,job,{mode:'manual'});assert.equal(claimed.policyMode,'execute_approved_existing');const record=a.data.agentActions.find(r=>r.id===claimed.actionId);assert.ok(record);return writes.execute(a,job,record);},
  reload(){const ids={task:task.id,job:job.id,source:source.id,draft:draft.id};a.save();a=new Assistant({dir,chat});task=a.task(ids.task);job=a.data.delegations.find(r=>r.id===ids.job);source=a.data.sources.find(r=>r.id===ids.source);draft=a.data.artifacts.find(r=>r.id===ids.draft);configure();}
 };
}

for(const restart of [false,true])test('auto: initial check -> prepare -> exact pending review -> one execution'+(restart?' after restart':''),async t=>{
 const f=await fixture(t),prepared=await f.prepare(),original=f.a.data.agentActions[0];
 assert.equal(prepared.verificationRequired,true);assert.equal(prepared.actionId,original.id);assert.equal(original.status,'pending');assert.equal(f.posts,0);assert.equal(f.calls,0);
 assert.equal(ground.reusable(f.a,f.task),null);
 if(restart)f.reload();
 const record=f.a.data.agentActions[0],before=JSON.stringify({id:record.id,args:record.args,version:record.version,title:record.title,content:record.content});
 assert.equal(f.decision().mode,'verify_prepared_existing');
 await f.check();
 assert.equal(f.calls,1);assert.equal(f.task.contentVerification.passed,true);assert.equal(f.decision().mode,'execute_approved_existing');
 assert.equal(JSON.stringify({id:record.id,args:record.args,version:record.version,title:record.title,content:record.content}),before);
 await f.execute();assert.equal(f.posts,1);assert.equal(record.status,'done');assert.equal(f.a.data.agentActions.length,1);
});

test('ask: approval is required once and retained through pending title review',async t=>{
 const f=await fixture(t,'ask'),prepared=await f.prepare(),record=f.a.data.agentActions[0];
 assert.equal(prepared.waitingForApproval,true);assert.equal(f.decision().eligible,false);assert.equal(f.posts,0);
 // Represents the existing exact-preview approval; no new approval is issued by review.
 record.approvedAt='2026-10-23T00:00:00Z';const approved=record.approvedAt;
 assert.equal(f.decision().mode,'verify_prepared_existing');
 await f.check();assert.equal(record.approvedAt,approved);await f.execute();
 assert.equal(f.posts,1);assert.equal(f.calls,1);assert.equal(f.a.data.agentActions.length,1);
});

test('failed pending-title review blocks delivery without reprepare or fake approval',async t=>{
 const f=await fixture(t);await f.prepare();const record=f.a.data.agentActions[0];f.fail();await f.check();
 assert.equal(f.task.contentVerification.passed,false);assert.equal(f.decision().eligible,false);
 assert.equal(record.status,'pending');assert.equal(record.approvedAt,undefined);assert.equal(f.posts,0);assert.equal(f.a.data.agentActions.length,1);
});

test('unknown effect is reconciled instead of using pending-title review to send again',async t=>{
 const f=await fixture(t);await f.prepare();const record=f.a.data.agentActions[0];record.status='uncertain';record.effectStatus='applied';
 const candidate=continuation.actionInspect(f.a,f.job,{automatic:false});
 assert.equal(candidate.kind,'reconcile');assert.notEqual(f.decision().mode,'verify_prepared_existing');assert.equal(f.posts,0);
 assert.equal(control.recover(f.a,f.job,{tool:'github_create',args:{taskId:f.task.id}},Object.assign(Error('stale'),{code:'GROUNDING_REQUIRED',taskId:f.task.id})),false);
});

test('other pending action and a paused task still block the dedicated review route',async t=>{
 const f=await fixture(t);await f.prepare();const record=f.a.data.agentActions[0];
 f.a.data.agentActions.push({...record,id:'another-pending',key:'different'});
 assert.equal(f.decision().eligible,false);assert.equal(f.calls,0);
 f.a.data.agentActions.pop();f.task.status='paused';
 assert.equal(f.decision().eligible,false);assert.equal(f.calls,0);assert.equal(f.posts,0);
});

for(const mode of ['auto','ask'])test('real agent.run reviews then executes the original '+mode+' record after restart',async t=>{
 const f=await fixture(t,mode);await f.prepare();const id=f.a.data.agentActions[0].id;
 if(mode==='ask')await f.a.dispatch('uiCommand',{action:'agentApprove',input:{id:f.job.id,actionId:id,version:f.a.data.agentActions[0].version}});
 const approved=f.a.data.agentActions[0].approvedAt;
 f.job.maxActions=2;f.reload();
 await f.a.dispatch('agentRun',{id:f.job.id});await f.a.runPromise;
 assert.equal(f.posts,1,f.job.lastError||f.job.summary);assert.equal(f.calls,1);
 assert.equal(f.a.data.agentActions.length,1);assert.equal(f.a.data.agentActions[0].id,id);assert.equal(f.a.data.agentActions[0].status,'done');
 assert.deepEqual(f.job.history.filter(r=>r.tool!=='generation_read').map(r=>r.tool),['verify_content','github_create']);
 assert.equal(f.a.data.agentActions[0].approvedAt,approved);
});

test('prepared review cannot bypass an explicit nonretryable MODEL_AUTH failure',async t=>{
 const f=await fixture(t);await f.prepare();
 Object.assign(f.job,{status:'blocked',lastErrorAutomaticRetry:false,lastErrorCode:'MODEL_AUTH',lastError:'offline nonretryable verification failure'});
 const decision=f.decision();assert.equal(decision.eligible,false);assert.equal(decision.phase,'blocked');assert.equal(decision.reasonCode,'MODEL_AUTH');
 assert.equal(f.calls,0);assert.equal(f.posts,0);assert.equal(f.a.data.agentActions.length,1);
});

test('prepared review still respects paid budget and revoked writer mode',async t=>{
 const f=await fixture(t);await f.prepare();f.job.limitReason='offline budget boundary';
 assert.equal(f.decision().eligible,false);delete f.job.limitReason;
 f.job.githubMode='off';assert.equal(f.decision().eligible,false);
 assert.equal(f.calls,0);assert.equal(f.posts,0);
});

test('strict standalone mail_draft keeps its actual EML result path without inventing an artifact review',async t=>{
 const f=await fixture(t);f.a.data.artifacts=[];delete f.task.primaryArtifactId;delete f.task.grounding;delete f.task.contentVerification;
 f.task.steps=[{id:'mail-step',key:'mail-step',title:'保存草稿',kind:'external',tool:'mail_draft',done:false}];
 f.job.outputFolder=path.join(f.a.dir,'mail-output');fs.mkdirSync(f.job.outputFolder);f.job.localTools={draftMode:'auto'};
 const result=await agent.act(f.a,f.job,'mail_draft',{taskId:f.task.id,to:'offline@example.com',subject:'仅本地草稿主题',body:'仅本地草稿正文'});
 const record=f.a.data.agentActions[0];assert.equal(record.status,'done');assert.equal(result.sent,false);assert.equal(f.calls,0);assert.equal(f.posts,0);
 assert.equal(require('../desktop/verification-titles.cjs').actionReview(f.a,f.task,{...record,status:'pending'}),null);
 const receipt=f.a.context(f.task,{verification:true}).deliveryEvidence.find(r=>r.actionId===record.id);
 assert.equal(receipt.current,true);assert.equal(receipt.readback[0].mail.subject,'仅本地草稿主题');assert.equal(receipt.readback[0].mail.body,'仅本地草稿正文');assert.equal(receipt.readback[0].mail.unsent,true);
});

