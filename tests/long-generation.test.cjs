const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant,modelChat}=require('../desktop/core.cjs'),policy=require('../desktop/model-policy.cjs'),errors=require('../desktop/model-errors.cjs'),{processCall}=require('../desktop/subscription.cjs');
async function setup(t,chat,extra={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-sections-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'日常模型',model:'fixture',baseUrl:'http://localhost:9999/v1',...extra});return a;}
const input={title:'完成交接文档',criteria:'包含来源及运行说明',generationMode:'sections',steps:[{title:'交接正文',kind:'draft'}]};
const plan={title:'交接文档',sections:['来源','运行说明']},passed={passed:true,summary:'正文满足交接标准',gaps:[]};
const parse=m=>JSON.parse(m[1].content);
const result=s=>({kind:'artifact',content:`## ${s}\n已核实的业务正文。`,summary:`${s}的依据与结论`});
async function advance(a,t){await a.dispatch('advance',{id:t.id});await a.runPromise;}

test('A 4-minute silent response is allowed by default; idle and total limits are independent',()=>{
  assert.deepEqual(policy.normalize(),{idleMinutes:15,totalMinutes:0,retries:0});
  assert.equal(policy.normalize({idleMinutes:0,totalMinutes:0,retries:1}).idleMinutes,0);
  for(const value of [{idleMinutes:-1},{totalMinutes:1.5},{retries:2},{totalMinutes:'bad'}])assert.throws(()=>policy.normalize(value),/等待/);
});
test('Waiting resets on activity, total deadline does not reset, and timers clean up',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const w=policy.watch({idleMs:15*60000,totalMs:0});t.mock.timers.tick(240001);assert.equal(w.signal.aborted,false);w.touch();t.mock.timers.tick(14*60000);assert.equal(w.signal.aborted,false);t.mock.timers.tick(60000);assert.equal(w.signal.reason.timeoutKind,'idle');w.close();
  const total=policy.watch({idleMs:100,totalMs:150});t.mock.timers.tick(80);total.touch();t.mock.timers.tick(70);assert.equal(total.signal.reason.timeoutKind,'total');total.close();
  const unlimited=policy.watch();t.mock.timers.tick(100000000);assert.equal(unlimited.signal.aborted,false);unlimited.close();
});
test('Codex subprocess activity extends idle window without a total deadline',async()=>{
  // Allow real Windows process startup under concurrent suites. Keep emitting
  // longer than the idle window so this still checks reset, not just startup.
  let updates=0,receipt;const r=await processCall(process.execPath,['-e','let i=0;const t=setInterval(()=>{console.log(++i);if(i===6){clearInterval(t);}},300)'],{timeoutMs:0,idleTimeoutMs:1500,onProgress:()=>updates++,onClose:v=>receipt=v});assert.equal(r.code,0);assert.ok(updates>=7);assert.ok(receipt.durationMs>1500);
});
test('Codex subprocess distinguishes idle timeout from explicit total deadline',async()=>{
  await assert.rejects(processCall(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeoutMs:0,idleTimeoutMs:100}),e=>e.code==='MODEL_TIMEOUT'&&e.timeoutKind==='idle');
  let receipt;await assert.rejects(processCall(process.execPath,['-e','setInterval(()=>console.log("active"),30)'],{timeoutMs:4000,idleTimeoutMs:1500,onClose:v=>receipt=v}),e=>e.timeoutKind==='total');assert.ok(receipt.stdoutBytes>0,'process must actually emit before total deadline');
});
test('Unlimited API wait still responds to user cancellation',async t=>{
  const previous=global.fetch;t.after(()=>{global.fetch=previous;});
  let started;const ready=new Promise(r=>started=r);
  global.fetch=async(_url,{signal})=>{started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const c=new AbortController(),p=modelChat({type:'openai',model:'fixture',baseUrl:'http://localhost:9999',requestPolicy:{idleMinutes:0,totalMinutes:0}},'',[],{signal:c.signal});await ready;c.abort();await assert.rejects(p,e=>e.code==='MODEL_CANCELLED');
});
test('A saved directory and finished section survive timeout/restart; only unfinished section is requested',async t=>{
  const seen=[];let failed=false;const chat=async(_p,_k,m)=>{const c=parse(m);if(m[0].content.includes('制定分段生成目录')){seen.push('plan');return plan;}if(c.section){seen.push(c.section.title);if(c.section.index===2&&!failed){failed=true;throw errors.transportError('MODEL_TIMEOUT');}return result(c.section.title);}return passed;};
  const a=await setup(t,chat),task=a.createTask(input);await advance(a,task);assert.equal(task.status,'blocked');assert.equal(task.steps[0].done,false);assert.equal(task.steps[0].checkpoint.sections[0].content,result('来源').content);assert.equal(a.data.artifacts.length,0);
  const b=new Assistant({dir:a.dir,chat}),restored=b.task(task.id);await advance(b,restored);assert.deepEqual(seen,['plan','来源','运行说明','运行说明']);assert.equal(restored.status,'review');assert.equal(b.data.artifacts.length,1);assert.match(b.data.artifacts[0].content,/来源[\s\S]*运行说明/);assert.equal(restored.steps[0].checkpoint,undefined);await b.dispatch('taskAction',{id:task.id,command:'accept'});assert.equal(restored.status,'completed');
});
test('Changed requirements archive old sections and generate a fresh directory',async t=>{
  let plans=0;const a=await setup(t,async(_p,_k,m)=>{const c=parse(m);if(m[0].content.includes('制定分段生成目录')){plans++;return plan;}if(c.section?.index===1)return result('来源');throw errors.transportError();}),task=a.createTask(input);await advance(a,task);await a.dispatch('taskAction',{id:task.id,command:'feedback',note:'改用新的运行时间。'});await advance(a,task);assert.equal(plans,2);assert.equal(task.steps[0].checkpointHistory.length,1);assert.equal(task.steps[0].checkpointHistory[0].sections[0].content,result('来源').content);
});
test('Malformed second section does not mark the step done or lose the first one',async t=>{
  const a=await setup(t,async(_p,_k,m)=>{const c=parse(m);return m[0].content.includes('制定分段生成目录')?plan:c.section.index===1?result('来源'):{kind:'artifact',content:''};}),task=a.createTask(input);await advance(a,task);assert.equal(task.status,'blocked');assert.equal(task.steps[0].done,false);assert.equal(task.steps[0].checkpoint.sections[0].content,result('来源').content);assert.equal(a.data.artifacts.length,0);
});
test('Cancel during second section preserves the first section without false completion',async t=>{
  let second;const entered=new Promise(r=>second=r);const a=await setup(t,async(_p,_k,m,{signal})=>{const c=parse(m);if(m[0].content.includes('制定分段生成目录'))return plan;if(c.section.index===1)return result('来源');second();return new Promise((r,j)=>signal.addEventListener('abort',()=>j(errors.cancelledError()),{once:true}));}),task=a.createTask(input);await a.dispatch('advance',{id:task.id});await entered;await a.dispatch('stop');await a.runPromise;assert.equal(task.status,'blocked');assert.equal(task.steps[0].checkpoint.sections[0].content,result('来源').content);assert.equal(task.steps[0].done,false);
});
test('Long material selects sections automatically; explicit single mode avoids the plan call',async t=>{
  let plans=0;const a=await setup(t,async(_p,_k,m)=>{if(m[0].content.includes('制定分段生成目录')){plans++;return {title:'正文',sections:['正文']};}return m[0].content.includes('独立检查')?passed:result('正文');});for(const generationMode of ['auto','single']){const task=a.createTask({...input,generationMode,description:'已知业务背景'.repeat(1600)});task.notes.push({text:'附加证据'.repeat(3000)});await advance(a,task);assert.equal(task.status,'review');}assert.equal(plans,1);
});
test('Adopting an existing long document does not generate it; verification sees its tail and can retry',async t=>{
  let calls=0;const content='交接正文\n'+'业务依据。'.repeat(5000)+'\n末尾验收标记';
  const a=await setup(t,async(_p,_k,m)=>{calls++;assert.ok(m[0].content.includes('独立检查'));assert.ok(parse(m).artifacts[0].content.endsWith('末尾验收标记'));assert.equal(parse(m).artifacts[0].origin,'user_import');assert.equal(parse(m).artifacts[0].storageEvidence.savedInWorkspace,true);assert.match(parse(m).artifacts[0].storageEvidence.contentSHA256,/^[a-f0-9]{64}$/);assert.match(m[0].content,/不能替代外部交付证据/);if(calls===1)throw errors.transportError();return passed;}),task=a.createTask(input);
  await a.dispatch('adoptArtifact',{id:task.id,stepId:task.steps[0].id,title:'既有交接文档',content,fileName:'交接.md'});assert.equal(calls,0);assert.equal(task.status,'todo');assert.equal(task.steps[0].done,true);assert.equal(task.verification,null);await advance(a,task);assert.equal(task.status,'blocked');await advance(a,task);assert.equal(calls,2);assert.equal(task.status,'review');assert.equal(a.data.artifacts.length,1);assert.equal(a.data.artifacts[0].origin,'user_import');
});
test('Adoption rejects stale step, external step, archived project, busy app and storage failure',async t=>{
  const a=await setup(t,async()=>passed),task=a.createTask(input),payload={id:task.id,stepId:task.steps[0].id,title:'标题',content:'正文'};
  await assert.rejects(a.dispatch('adoptArtifact',{...payload,stepId:'old'}),/变化/);task.steps[0].kind='external';await assert.rejects(a.dispatch('adoptArtifact',payload),/外部/);task.steps[0].kind='draft';
  a.operation={label:'busy'};await assert.rejects(a.dispatch('adoptArtifact',payload),/正在/);a.operation=null;
  a.data.projects.push({id:'project',jobId:null,archivedAt:new Date().toISOString()});task.projectId='project';await assert.rejects(a.dispatch('adoptArtifact',payload),/归档/);task.projectId=null;
  const before=JSON.stringify(a.data);a.save=()=>{throw Error('disk full');};await assert.rejects(a.dispatch('adoptArtifact',payload),/disk full/);assert.equal(JSON.stringify(a.data),before);
});
test('Opted-in retry is bounded to one additional charged request and can be cancelled during backoff',async t=>{
  let calls=0;const a=await setup(t,async()=>{calls++;throw errors.transportError();},{requestPolicy:{retries:1}}),p=a.available('execute');await assert.rejects(a.callModel(p,'',[],{role:'execute'}));assert.equal(calls,2);assert.deepEqual(a.data.modelCalls.map(r=>r.attempt),[2,1]);assert.equal(a.data.modelCalls[0].fallbackFrom,null);
  const c=new AbortController();const promise=a.callModel(p,'',[],{role:'execute',signal:c.signal});setTimeout(()=>c.abort(),30);await assert.rejects(promise,e=>e.code==='MODEL_CANCELLED');assert.equal(calls,3);
});
test('Retry no longer uses count caps and still excludes authentication and connection tests',async t=>{
  let calls=0;const a=await setup(t,async()=>{calls++;throw errors.transportError();},{requestPolicy:{retries:1}});await a.dispatch('stewardshipSettings',{dailyCallLimit:1});await assert.rejects(a.callModel(a.available('execute'),'',[],{role:'execute'}),e=>e.code==='MODEL_NETWORK');assert.equal(calls,2);
  await a.dispatch('stewardshipSettings',{dailyCallLimit:50});await assert.rejects(a.dispatch('testProvider',{id:a.available('execute').id}));assert.equal(calls,3);
  a.chat=async()=>{calls++;throw errors.httpError(401);};await assert.rejects(a.callModel(a.available('execute'),'',[],{role:'execute'}));assert.equal(calls,4);
});

test('Explicitly restoring archived sections resumes the full outline without rewriting completed business text',async t=>{
  const seen=[];let phase=0;
  const a=await setup(t,async(_p,_k,m)=>{const c=parse(m);if(m[0].content.includes('制定分段生成目录')){seen.push('plan');return phase===0?plan:{title:'仅剩章节',sections:['运行说明']};}if(c.section){seen.push(c.section.title);if(phase<2&&c.section.title==='运行说明')throw errors.transportError();return result(c.section.title);}return passed;});
  const task=a.createTask(input);await advance(a,task);phase=1;
  await a.dispatch('taskAction',{id:task.id,command:'feedback',note:'运行额度已经恢复，业务内容不变。'});await advance(a,task);
  const saved=task.steps[0].checkpointHistory[0],request={id:task.id,stepId:task.steps[0].id,archivedAt:saved.archivedAt,basis:saved.basis,confirmUnchanged:true};
  await a.dispatch('restoreGenerationCheckpoint',request);assert.equal(task.steps[0].done,false);assert.equal(task.verification,null);assert.deepEqual(task.steps[0].checkpoint.sections.map(s=>s.title),plan.sections);assert.equal(task.steps[0].checkpoint.sections[0].content,result('来源').content);assert.equal(a.data.artifacts.length,0);
  phase=2;const b=new Assistant({dir:a.dir,chat:a.chat}),resumed=b.task(task.id);await advance(b,resumed);
  assert.deepEqual(seen,['plan','来源','运行说明','plan','运行说明','运行说明']);assert.equal(resumed.status,'review');assert.match(b.data.artifacts[0].content,/来源[\s\S]*运行说明/);assert.equal(b.data.artifacts[0].origin,undefined);
});
test('Checkpoint restoration rejects stale identity, missing confirmation, busy/archived tasks and rolls back storage failure',async t=>{
  const a=await setup(t,async()=>passed),task=a.createTask(input),step=task.steps[0];
  step.checkpointHistory=[{basis:'old',title:'正文',archivedAt:new Date().toISOString(),sections:[{title:'来源',content:'原始已核对正文',summary:'来源'},{title:'运行',content:null,summary:''}]}];
  const request={id:task.id,stepId:step.id,basis:'old',archivedAt:step.checkpointHistory[0].archivedAt,confirmUnchanged:true};
  for(const change of [{stepId:'old'},{basis:'stale'},{confirmUnchanged:false}])await assert.rejects(a.dispatch('restoreGenerationCheckpoint',{...request,...change}));
  a.operation={label:'busy'};await assert.rejects(a.dispatch('restoreGenerationCheckpoint',request),/正在/);a.operation=null;
  a.data.projects.push({id:'p',jobId:null,archivedAt:new Date().toISOString()});task.projectId='p';await assert.rejects(a.dispatch('restoreGenerationCheckpoint',request),/归档/);task.projectId=null;
  const before=JSON.stringify(a.data);a.save=()=>{throw Error('disk full');};await assert.rejects(a.dispatch('restoreGenerationCheckpoint',request),/disk full/);assert.equal(JSON.stringify(a.data),before);
});
test('Restoring a checkpoint does not suppress invalidation by a later business requirement change',async t=>{
  let plans=0;const a=await setup(t,async(_p,_k,m)=>{if(m[0].content.includes('制定分段生成目录')){plans++;return plan;}throw errors.transportError();}),task=a.createTask(input),step=task.steps[0];
  const saved={basis:'old',title:'正文',archivedAt:new Date().toISOString(),sections:[{title:'来源',content:'旧业务正文',summary:'旧依据'},{title:'运行说明',content:null,summary:''}]};step.checkpointHistory=[saved];
  await a.dispatch('restoreGenerationCheckpoint',{id:task.id,stepId:step.id,basis:saved.basis,archivedAt:saved.archivedAt,confirmUnchanged:true});
  await a.dispatch('taskAction',{id:task.id,command:'feedback',note:'改为新日期与新地区，之前结论不再适用。'});await advance(a,task);assert.equal(plans,1);assert.equal(step.checkpoint.sections[0].content,null);assert.ok(step.checkpointHistory.some(c=>c.sections[0].content==='旧业务正文'));
});
test('Restoring an Agent checkpoint schedules the same delegation and still generates only missing sections',async t=>{
  const agent=require('../desktop/agent.cjs');const seen=[];
  const a=await setup(t,async(_p,_k,m)=>{const c=parse(m);if(c.section){seen.push(c.section.title);return result(c.section.title);}return passed;}),task=a.createTask(input),job=agent.buildJob(a,{goal:'完成交接',allowWeb:false,autoAccept:false});a.data.delegations.push(job);job.taskIds=[task.id];task.agentJobId=job.id;job.status='blocked';
  const saved={basis:'old',title:'正文',archivedAt:new Date().toISOString(),sections:[{title:'来源',content:result('来源').content,summary:'已核对来源'},{title:'运行说明',content:null,summary:''}]};task.steps[0].checkpointHistory=[saved];
  const request={id:task.id,stepId:task.steps[0].id,basis:saved.basis,archivedAt:saved.archivedAt,confirmUnchanged:true};task.needsReplan='需核对';await assert.rejects(a.dispatch('restoreGenerationCheckpoint',request),/plan_task/);task.needsReplan=null;
  await a.dispatch('restoreGenerationCheckpoint',request);assert.equal(job.status,'ready');assert.deepEqual(job.taskIds,[task.id]);await agent.act(a,job,'advance_task',{taskId:task.id});assert.deepEqual(seen,['运行说明']);assert.equal(task.status,'review');assert.equal(task.acceptedBy,undefined);
});
