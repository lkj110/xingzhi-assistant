const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs');
const tools=require('../desktop/agent-tools.cjs');

function response(tool,args={}){return {tool,args,reason:'测试动作'};}
async function setup(t,actions=[],agentRequest){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-agent-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const queue=[...actions];
  const chat=async(_provider,_key,messages)=>{
    const system=messages[0].content;const ctx=JSON.parse(messages[1].content);
    if(system.includes('动作格式')){const next=queue.shift();if(!next)throw new Error('测试动作已用完');return typeof next==='function'?next(ctx):next;}
    if(system.includes('推进给定事项'))return {kind:'artifact',title:'发布方案',content:'# 方案\n来源表明周五发布。'};
    return {passed:true,summary:'完成标准满足',gaps:[]};
  };
  const a=new Assistant({dir,chat,agentRequest});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture'});
  const folder=path.join(dir,'materials'),output=path.join(dir,'output');fs.mkdirSync(folder);fs.mkdirSync(output);fs.writeFileSync(path.join(folder,'会议.md'),'周五发布，需要整理方案。');
  a.data.folders=[{id:'folder',path:folder,name:'materials'}];a.data.agentSettings.outputFolder=output;a.save();return {a,queue,dir,folder,output,chat};
}
const plan=ctx=>response('plan_task',{key:'release',title:'整理发布方案',description:'来自会议记录',criteria:'包含发布日期并保存产出',sourceIds:ctx.sources.map(s=>s.id),steps:[{title:'编写方案',kind:'draft'},{title:'保存或创建任务',kind:'external',tool:ctx.permissions.githubRepo?'github_create':'write_file'}]});
const current=(tool)=>ctx=>response(tool,{taskId:ctx.tasks[0].id});
async function create(a,extra={}){await a.dispatch('agentCreate',{goal:'读取会议记录，整理方案并保存',folderIds:['folder'],useOutputFolder:true,fileMode:'auto',maxCalls:40,maxActions:12,...extra});await a.runPromise;return a.data.delegations[0];}

test('Agent autonomously reads, fills a task, executes a file write and verifies the full delegation',async t=>{
  const {a,output}=await setup(t,[response('read_file',{folderId:'folder',name:'会议.md'}),plan,current('advance_task'),current('write_file'),current('advance_task'),response('complete',{summary:'完成'})]);
  const job=await create(a);assert.equal(job.status,'completed');assert.equal(a.data.tasks.length,1);assert.equal(a.data.tasks[0].status,'completed');assert.equal(job.callsUsed,8);
  assert.equal(fs.readdirSync(output).filter(n=>!n.endsWith('-最新.md')).length,1);assert.match(fs.readFileSync(path.join(output,fs.readdirSync(output)[0]),'utf8'),/周五/);
  assert.equal(a.data.agentActions[0].status,'done');assert.equal(a.data.agentRuns[0].status,'done');assert.ok(a.data.tasks[0].steps[1].evidence.includes('verified'));
  const restored=new Assistant({dir:a.dir});assert.equal(restored.data.delegations[0].status,'completed');assert.equal(restored.data.tasks[0].id,job.taskIds[0]);
});
test('Repeated planning keys and repeated writes do not create duplicate tasks or files',async t=>{
  const {a,output}=await setup(t,[plan,plan,current('advance_task'),current('write_file'),current('write_file'),current('advance_task'),response('complete')]);
  const job=await create(a);assert.equal(job.status,'completed');assert.equal(a.data.tasks.length,1);assert.equal(fs.readdirSync(output).filter(n=>!n.endsWith('-最新.md')).length,1);assert.equal(a.data.agentActions.length,1);
});
test('Exact write approval pauses execution and rejects approval after an input version change',async t=>{
  const {a,output}=await setup(t,[plan,current('advance_task'),current('write_file')]);const job=await create(a,{fileMode:'ask'});
  assert.equal(job.status,'approval');assert.equal(fs.readdirSync(output).filter(n=>!n.endsWith('-最新.md')).length,0);
  await a.dispatch('updateTask',{id:job.taskIds[0],criteria:'增加回滚方案'});
  await assert.rejects(a.dispatch('agentApprove',{id:job.id}),/失效/);assert.equal(a.data.agentActions[0].status,'stale');assert.equal(fs.readdirSync(output).filter(n=>!n.endsWith('-最新.md')).length,0);
});
test('Approved prepared content executes without another approval and survives reload',async t=>{
  const {a,queue,output,chat}=await setup(t,[plan,current('advance_task'),current('write_file')]);const job=await create(a,{fileMode:'ask'});
  await a.dispatch('agentApprove',{id:job.id});queue.push(current('advance_task'),response('complete'));
  const restored=new Assistant({dir:a.dir,chat});await restored.dispatch('agentRun',{id:job.id});await restored.runPromise;
  assert.equal(restored.data.delegations[0].status,'completed');assert.equal(fs.readdirSync(output).filter(n=>!n.endsWith('-最新.md')).length,1);
});
test('Unchanged source checks consume no model calls; changed sources update the same task',async t=>{
  const {a,queue,folder}=await setup(t,[response('read_file',{folderId:'folder',name:'会议.md'}),plan,response('wait',{reason:'等待会议记录更新'})]);const job=await create(a);const used=job.callsUsed;
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,'watching');assert.equal(job.callsUsed,used);assert.equal(a.data.agentRuns[0].status,'unchanged');
  fs.writeFileSync(path.join(folder,'会议.md'),'发布已调整至周六。');queue.push(response('wait',{reason:'继续跟进'}));
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(a.data.tasks.length,1);assert.equal(a.data.tasks[0].sourceIds.length,2);assert.equal(job.callsUsed,used+1);assert.equal(job.sourceIds.length,2);
});
test('GitHub create/readback uses the scoped repo, stable marker and attaches replies to the existing task',async t=>{
  let issue=null,posts=0,comments=[];const routes=[];
  const request=async(url,options={})=>{
    routes.push(url);assert.ok(url.startsWith('https://api.github.com/repos/acme/work/'));
    if(options.method==='POST'){posts++;issue={number:42,title:JSON.parse(options.body).title,body:JSON.parse(options.body).body,state:'open',html_url:'https://github.com/acme/work/issues/42',updated_at:'2026-09-30T00:00:00Z'};return {body:JSON.stringify(issue)};}
    if(url.includes('/comments?'))return {body:JSON.stringify(comments)};
    if(url.includes('/issues?'))return {body:JSON.stringify(url.includes('/issues?')?(issue?[issue]:[]):issue)};
    return {body:JSON.stringify({...issue,comments:comments.length})};
  };
  const followupPlan=ctx=>{const next=plan(ctx);next.args.steps.push({title:'根据同事回复整理最终方案',kind:'draft'});return next;};
  const {a,queue}=await setup(t,[response('read_file',{folderId:'folder',name:'会议.md'}),followupPlan,current('advance_task'),current('github_create'),current('github_create'),response('github_read',{number:42}),response('wait',{reason:'等同事回复'})],request);
  await a.dispatch('agentSettings',{githubRepo:'acme/work',githubToken:'test-token'});
  const job=await create(a,{mode:'continuous',goal:'整理发布方案并创建任务，持续跟进同事回复，再整理最终方案',useGithub:true,githubMode:'auto',useOutputFolder:false});assert.equal(posts,1);assert.equal(job.status,'watching',job.lastError);assert.equal(a.data.agentActions[0].result.number,42);assert.equal(job.watchers.filter(w=>w.tool==='github_read').length,1);assert.equal(a.data.agentActions.length,1);assert.ok(a.data.sources.every(s=>!s.content.includes('<!-- xingzhi:')),'own readback stays an observation');
  const used=job.callsUsed;await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.callsUsed,used);
  comments=[{id:9,user:{login:'reviewer'},body:'确认周五发布',updated_at:'2026-09-30T01:00:00Z',html_url:'https://github.com/acme/work/issues/42#issuecomment-9'}];queue.push(response('wait',{reason:'收到回复，继续等最终结果'}));
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(a.data.tasks.length,1);assert.ok(a.data.tasks[0].sourceIds.length>=1);assert.ok(a.data.sources.some(s=>s.content.includes('确认周五')));assert.equal(posts,1);
});
test('An uncertain GitHub POST is reconciled after restart without repeating its side effect',async t=>{
  let issue=null,posts=0;const request=async(url,options={})=>{
    if(options.method==='POST'){posts++;issue={number:8,body:JSON.parse(options.body).body,title:JSON.parse(options.body).title,state:'open',html_url:'https://github.com/acme/work/issues/8'};throw new Error('network ended after commit');}
    return {body:JSON.stringify(url.includes('/issues?')?(issue?[issue]:[]):issue)};
  };
  const {a,queue,chat}=await setup(t,[plan,current('advance_task'),current('github_create')],request);await a.dispatch('agentSettings',{githubRepo:'acme/work',githubToken:'test-token'});const job=await create(a,{useGithub:true,githubMode:'auto',useOutputFolder:false});
  assert.equal(a.data.agentActions[0].status,'uncertain');queue.push(current('github_create'),current('advance_task'),response('complete'));
  const restored=new Assistant({dir:a.dir,chat,agentRequest:request});await restored.dispatch('agentRun',{id:job.id});await restored.runPromise;
  assert.equal(posts,1);assert.equal(restored.data.agentActions[0].status,'done');assert.equal(restored.data.delegations[0].status,'completed');
});
test('Permissions reject unscoped files, unknown tasks and arbitrary tools; credentials are never exported',async t=>{
  const {a,folder}=await setup(t,[response('ask',{question:'测试停靠'})]);await a.dispatch('agentSettings',{githubRepo:'acme/work',githubToken:'GITHUB_SYNTHETIC_SECRET',searchKey:'SEARCH_SYNTHETIC_SECRET'});const job=await create(a,{allowWeb:false});
  await assert.rejects(agent.act(a,job,'read_file',{folderId:'missing',name:'会议.md'}),/授权/);
  await assert.rejects(agent.act(a,job,'read_file',{folderId:'folder',name:'../vault.key'}));
  fs.symlinkSync(a.file,path.join(folder,'link.md'));await assert.rejects(agent.act(a,job,'read_file',{folderId:'folder',name:'link.md'}));
  await assert.rejects(agent.act(a,job,'read_url',{url:'https://example.com'}),/权限/);
  await assert.rejects(agent.act(a,job,'shell',{command:'true'}),/不可用/);
  const exported=JSON.stringify(await a.dispatch('export'));assert.equal(exported.includes('SYNTHETIC_SECRET'),false);assert.equal(exported.includes(a.data.agentSettings.githubToken),false);assert.equal(a.publicState().agentSettings.hasGithubToken,true);
});
test('Legacy call limits no longer interrupt planning, execution or verification',async t=>{
  const {a}=await setup(t,[plan,current('advance_task'),current('write_file'),current('advance_task'),response('complete')]);const job=await create(a,{maxCalls:5});
  assert.equal(job.callsUsed,7);assert.equal(job.status,'completed');assert.equal(a.data.artifacts.length,1);assert.equal(a.data.agentActions[0].status,'done');
});
test('Pause and global stop remain paused across feedback and normal scheduler ticks',async t=>{
  const {a}=await setup(t,[response('read_file',{folderId:'folder',name:'会议.md'}),response('wait',{reason:'等待变化'})]);const job=await create(a);
  await a.dispatch('agentPause',{id:job.id});await a.dispatch('agentFeedback',{id:job.id,note:'补充要求但不要运行'});a.tick();assert.equal(a.operation,null);assert.equal(job.status,'paused');
  await a.dispatch('agentResume',{id:job.id});a.stop();a.tick();assert.equal(job.status,'paused');assert.equal(a.operation,null);
});
test('Plaintext web extraction preserves references and refuses local/private hosts',async t=>{
  const result=await tools.readWeb('https://example.com',async()=>({body:'<title>官方公告</title><script>secret()</script><h1>周五上线</h1><a href="/news">说明</a>',headers:{'content-type':'text/html'},url:'https://example.com'}));
  assert.match(result.content,/周五/);assert.equal(result.content.includes('secret()'),false);assert.equal(result.links[0].url,'https://example.com/news');
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fe80::1','2001::1234','2001:0000:1234::1','2002:7f00:1::'])assert.equal(tools.publicAddress(ip),false);
  assert.equal(tools.publicAddress('203.0.10.1'),true);
  assert.equal(tools.publicAddress('1.1.1.1'),true);await assert.rejects(tools.publicRequest('http://127.0.0.1'),/公网/);
});
test('Finite retries survive persistence and do not turn into an endless error loop',async t=>{
  const {a}=await setup(t,[]);const job=await create(a);assert.equal(job.status,'retry');
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,'retry');
  await a.dispatch('agentRun',{id:job.id});await a.runPromise;assert.equal(job.status,'blocked');const calls=job.callsUsed;a.tick();assert.equal(job.callsUsed,calls);
});
test('Manual acceptance closes the delegation locally after its current overall check',async t=>{
  const {a}=await setup(t,[plan,current('advance_task'),current('write_file'),current('advance_task'),response('complete')]);const job=await create(a,{autoAccept:false});
  assert.equal(job.status,'review');assert.equal(a.task(job.taskIds[0]).status,'review');assert.equal(job.completedAt,undefined);
  await a.dispatch('taskAction',{id:job.taskIds[0],command:'accept'});assert.equal(job.status,'completed');assert.equal(job.nextRunAt,undefined);assert.equal(job.completionCheck.passed,true);
});
test('Feedback invalidates prepared approval and paused feedback resumes actual planning',async t=>{
  const {a}=await setup(t,[response('read_file',{folderId:'folder',name:'会议.md'}),plan,current('advance_task'),current('write_file')]);const job=await create(a,{fileMode:'ask'});
  await a.dispatch('agentFeedback',{id:job.id,note:'文件必须补充回滚计划'});assert.equal(job.pendingActionId,null);assert.equal(a.data.agentActions[0].status,'stale');
  job.status='watching';await a.dispatch('agentPause',{id:job.id});await a.dispatch('agentFeedback',{id:job.id,note:'先补充计划'});await a.dispatch('agentResume',{id:job.id});assert.equal(job.status,'ready');assert.ok(a.task(job.taskIds[0]).notes.some(n=>n.text==='先补充计划'));
});
test('An independent Agent read does not claim an unassigned source merely because its text is identical',async t=>{
  const {a}=await setup(t,[response('read_file',{folderId:'folder',name:'会议.md'}),response('wait',{reason:'等待变化'})]);a.addSources([{title:'已同步纪要',content:'周五发布，需要整理方案。',origin:'文件夹'}]);const sourceId=a.data.sources[0].id;
  const job=await create(a);assert.equal(a.data.sources.length,2);assert.equal(a.data.sources.find(s=>s.id===sourceId).state,'new');assert.equal(job.sourceIds.length,1);assert.notEqual(job.sourceIds[0],sourceId);assert.equal(a.data.sources.find(s=>s.id===job.sourceIds[0]).agentJobId,job.id);
});
test('A positive model verdict cannot replace the required actual file delivery',async t=>{
  const {a,output}=await setup(t,[response('plan_task',{key:'one',title:'交付报告',criteria:'产出并保存',steps:[{title:'写报告',kind:'draft'}]}),current('advance_task'),response('complete'),response('ask',{question:'需要实际交付'})]);
  const job=await create(a);assert.notEqual(job.status,'completed');assert.equal(fs.readdirSync(output).filter(n=>!n.endsWith('-最新.md')).length,0);assert.ok(job.history.some(r=>r.error?.includes('尚未保存')));
});
test('Follow-up retrieves the latest replies even when an issue has more than 300 comments',async()=>{
  const pages=[];
  const a={data:{agentSettings:{githubToken:''}},agentRequest:async url=>{
    if(!url.includes('/comments?'))return {body:JSON.stringify({number:1,title:'large thread',body:'work',comments:350,state:'open'})};
    const page=Number(new URL(url).searchParams.get('page'));pages.push(page);
    return {body:JSON.stringify(Array.from({length:page===4?50:100},(_,i)=>({id:(page-1)*100+i+1,body:`reply ${(page-1)*100+i+1}`})))};
  }};
  const result=await tools.readIssue(a,'acme/work',1);assert.deepEqual(pages,[2,3,4]);assert.equal(result.comments.at(-1).id,350);assert.equal(result.comments.length,12);assert.equal(result.commentsTruncated,true);
});
test('Delegation uses the configured organize, execute and verification model roles',async t=>{
  const {a}=await setup(t,[plan,current('advance_task'),current('write_file'),current('advance_task'),response('complete')]);
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'organizer',baseUrl:'https://example.com/v1',model:'organizer'});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'checker',baseUrl:'https://example.com/v1',model:'checker'});
  await a.dispatch('settings',{roles:{organize:a.data.providers[1].id,verify:a.data.providers[2].id}});
  const called=[];const original=a.chat;a.chat=async(p,...args)=>{called.push(p.model);return original(p,...args);};const job=await create(a);
  assert.equal(job.status,'completed');assert.equal(called[0],'organizer');assert.ok(called.includes('fixture'));assert.equal(called.filter(name=>name==='checker').length,3);
});
test('Writing a file cannot masquerade as completing an unrelated external action',async t=>{
  const {a,output}=await setup(t,[response('plan_task',{key:'deployment',title:'部署上线',criteria:'真实部署',steps:[{title:'写部署计划',kind:'draft'},{title:'部署生产环境',kind:'external',tool:'manual'}]}),current('advance_task'),current('write_file'),current('advance_task'),response('ask',{question:'请提供实际部署结果'})]);
  const job=await create(a);const task=a.task(job.taskIds[0]);assert.equal(fs.readdirSync(output).filter(n=>!n.endsWith('-最新.md')).length,1);assert.equal(task.steps[1].done,false);assert.equal(task.steps[1].evidence,undefined);assert.equal(task.status,'waiting');assert.notEqual(job.status,'completed');
});
