const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),capture=require('../desktop/capture.cjs');
function setup(t,chat=async()=>{throw new Error('No model expected');}){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-autonomy-integration-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Assistant({dir,chat});}
async function project(a,name){await a.dispatch('projectSave',{name});return a.data.projects.find(p=>p.name===name);}
async function route(a,p,keywords=['青禾']){await a.dispatch('intakeRoutingSave',{name:p.name+'归类',projectId:p.id,field:'all',match:'any',keywords,enabled:true});return a.data.intakeRoutingRules.at(-1);}
async function model(a){await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});}
test('Auto routing joins the existing paused delegation without granting or resuming execution',async t=>{
 const a=setup(t),p=await project(a,'青禾');await model(a);const j=agent.buildJob(a,{projectId:p.id,goal:'持续工作',allowWeb:false});j.status='paused';p.jobId=j.id;a.data.delegations.push(j);await route(a,p);
 await a.dispatch('captureSave',{textItems:[{title:'最新预算',content:'青禾预算5200元'}]});const s=a.data.sources[0];assert.equal(s.projectId,p.id);assert.equal(s.routing.status,'routed');assert.ok(j.sourceIds.includes(s.id));assert.equal(j.status,'paused');assert.equal(j.allowWeb,false);assert.equal(a.data.delegations.length,1);assert.equal((a.data.modelCalls||[]).length,0);
});
test('Durable mixed capture uses import-time routes, organizes only remaining independent sources, retains exact receipt links',async t=>{
 let count=0;const a=setup(t,async(_p,_k,m)=>{count++;const c=JSON.parse(m[1].content);assert.ok(c.sources.every(s=>!s.projectId));return {tasks:[],summary:'仅整理未归类材料'};});await model(a);const p=await project(a,'青禾');let release;a.launch('busy',()=>new Promise(r=>{release=r;}));
 await a.dispatch('captureEnqueue',{items:[{title:'独立.txt',base64:Buffer.from('其他工作的材料').toString('base64')}],textItems:[{title:'项目材料',content:'青禾发布需要确认预算'}],organize:true});const row=a.data.captureQueue.at(-1);release();await a.runPromise;await route(a,p);capture.tick(a);await a.runPromise;
 assert.equal(row.status,'completed',row.lastError);assert.equal(row.sourceIds.length,2);assert.equal(a.data.sources.filter(s=>s.projectId===p.id).length,1);assert.equal(count,1);assert.equal(row.organizedSourceIds.length,1);assert.equal(a.data.sources.find(s=>s.title==='独立.txt').state,'processed');
});
test('Conflicting routes neither create tasks nor consume model calls in collection or automatic extraction',async t=>{
 const a=setup(t);await model(a);const p=await project(a,'青禾'),q=await project(a,'财务');await route(a,p);await route(a,q,['预算']);
 await a.dispatch('captureEnqueue',{textItems:[{title:'冲突材料',content:'青禾预算需要确认'}],organize:true});await a.runPromise;assert.equal(a.data.captureQueue.at(-1).status,'completed');assert.equal(a.data.sources[0].routing.status,'conflict');assert.equal(a.data.sources[0].state,'new');await a.cycle();assert.equal(a.data.tasks.length,0);assert.equal((a.data.modelCalls||[]).length,0);assert.ok(!a.data.events.some(e=>e.title==='材料整理未完成'));
});
test('Explicit project overrides matching routes and uncertain destination refuses the entire source batch',async t=>{
 const a=setup(t),p=await project(a,'青禾'),q=await project(a,'手选');await route(a,p);await a.dispatch('import',{items:[{title:'手选内容',content:'青禾指定归入手选项目',projectId:q.id}]});assert.equal(a.data.sources[0].projectId,q.id);assert.equal(a.data.sources[0].routing,undefined);
 await model(a);const j=agent.buildJob(a,{projectId:p.id,goal:'目标'});p.jobId=j.id;a.data.delegations.push(j);a.data.agentActions.push({id:'uncertain',jobId:j.id,status:'uncertain',tool:'write_file'});const before=JSON.stringify(a.data.sources);await assert.rejects(a.dispatch('import',{items:[{title:'独立',content:'不能部分保存'},{title:'青禾',content:'命中受阻项目'}]}),/待核对/);assert.equal(JSON.stringify(a.data.sources),before);
});
test('Single and batch acceptance share verification basis and cannot accept a changed artifact',async t=>{
 const a=setup(t,async(_p,_k,m)=>m[0].content.includes('推进给定事项')?{kind:'artifact',title:'报告',content:'真实内容'}:{passed:true,summary:'检查通过',gaps:[]});await model(a);const t1=a.createTask({title:'待验收报告',steps:[{title:'写报告',kind:'draft'}]});await a.dispatch('advance',{id:t1.id});await a.runPromise;assert.equal(t1.status,'review');assert.ok(t1.verification.basis);const snap=await a.dispatch('acceptanceSnapshot');assert.equal(snap.items[0].ready,true);
 a.data.artifacts[0].content='检查后的变更';await assert.rejects(a.dispatch('taskAction',{id:t1.id,command:'accept'}),/变化|检查|依据/);await assert.rejects(a.dispatch('acceptanceAccept',{projectId:'',items:[{id:t1.id,revision:snap.items[0].revision}]}));assert.equal(t1.status,'review');
});

test('Acceptance reports malformed historical steps as blocked instead of accepting or crashing the entire center',t=>{
 const a=setup(t),task=a.createTask({title:'旧记录',steps:[{title:'旧步骤',kind:'draft'}]});task.status='review';task.verification={passed:true,summary:'旧结论',gaps:[]};task.steps[0].done=true;task.steps[0].artifactId='old-artifact';a.data.artifacts.push({id:'old-artifact',taskId:task.id,content:'保留旧成果'});
 for(const steps of [[{...task.steps[0],kind:'unknown'}],[task.steps[0],null]]){task.steps=steps;const acceptance=require('../desktop/acceptance.cjs');const result=acceptance.snapshot(a);assert.equal(result.items[0].ready,false);assert.throws(()=>acceptance.acceptOne(a,{id:task.id}));assert.equal(task.status,'review');}
});

async function manualReady(a){await model(a);const j=agent.buildJob(a,{goal:'完成这份正文',allowWeb:false});a.data.delegations.push(j);const result=await agent.act(a,j,'plan_task',{key:'report',title:'验收后的报告',criteria:'包含正文',steps:[{key:'draft',title:'写作',kind:'draft'}]});const t=a.task(result.taskId);t.steps[0].done=true;t.steps[0].artifactId='accepted-draft';a.data.artifacts.push({id:'accepted-draft',taskId:t.id,title:'正文',content:'已完成且检查过的正文',createdAt:new Date().toISOString()});t.status='review';t.verification={passed:true,summary:'正文完整',gaps:[],at:new Date().toISOString(),basis:require('../desktop/acceptance.cjs').basis(a,t)};j.status='review';return {j,t};}
test('Explicit acceptance closes locally after the overall check without asking a planner again',async t=>{
 const stages=[],a=setup(t,async(_p,_k,_m,o)=>{stages.push(o.stage);assert.equal(o.stage,'goal_verify');return {passed:true,summary:'整体目标满足',gaps:[]};}),{j,t:task}=await manualReady(a);j.autoAccept=false;
 await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(j.completionCheck.passed,true);assert.equal(j.status,'review');
 await a.dispatch('taskAction',{id:task.id,command:'accept'});assert.equal(task.acceptedBy,'user');assert.equal(j.status,'completed');assert.equal(j.finishAfterAcceptance,undefined);assert.ok(j.history.some(r=>r.tool==='user_acceptance'));const ctx=agent.context(a,j);assert.equal(ctx.tasks[0].acceptedBy,'user');if(ctx.memory)assert.equal(ctx.memory.nextSteps[0].next,'用户已验收完成');
 assert.deepEqual(stages,['goal_verify']);assert.equal(agent.tick(a),false);assert.equal(a.data.decisions.length,0);await assert.rejects(a.dispatch('agentRun',{id:j.id}),/已完成/);assert.deepEqual(stages,['goal_verify']);
});
test('Explicit new goal feedback opens a new revision and returns to planning while retaining acceptance history',async t=>{
 const stages=[],a=setup(t,async(_p,_k,_m,o)=>{stages.push(o.stage);return {tool:'ask',args:{key:'new-goal',question:'新的目标缺少交付要求',taskIds:[]}};}),{j,t:task}=await manualReady(a);
 const acceptance=require('../desktop/acceptance.cjs');acceptance.recordCompletionCheck(a,j,{passed:true,summary:'整体目标满足',gaps:[]},{basis:acceptance.completionBasis(a,j)});await a.dispatch('taskAction',{id:task.id,command:'accept'});
 await a.dispatch('agentFeedback',{id:j.id,note:'新增其他交付，请确认范围'});assert.equal(task.workRevision,2);assert.equal(j.workRevision,2);assert.equal(task.acceptanceHistory.length,1);await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.deepEqual(stages,['planner']);assert.equal(j.status,'needs_input');assert.equal(j.finishAfterAcceptance,undefined);
});
