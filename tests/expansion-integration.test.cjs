const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const acceptance=require('../desktop/acceptance.cjs'),plans=require('../desktop/agent-plan.cjs');
function setup(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-expansion-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Assistant({dir,chat(){throw Error('unexpected model');},agentRequest(){throw Error('unexpected network');}});}
function pair(a){
 const dep=a.createTask({title:'前置调研',criteria:'真实依据',steps:[{title:'研究',kind:'draft'}]}),task=a.createTask({title:'最终方案',steps:[{title:'整理',kind:'draft'}]});
 const job={id:'j',taskIds:[dep.id,task.id],sourceIds:[],goal:'交付方案',feedback:[],followups:[],status:'ready',projectId:null};a.data.delegations.push(job);
 for(const t of [dep,task]){t.agentJobId=job.id;t.dependsOn=[];}task.dependsOn=[dep.id];
 dep.steps[0].done=true;dep.steps[0].artifactId='artifact';a.data.artifacts.push({id:'artifact',taskId:dep.id,stepId:dep.steps[0].id,title:'研究结果',content:'核验过的研究结果'});dep.status='completed';dep.verification={passed:true,summary:'符合标准',gaps:[]};dep.verification.basis=acceptance.basis(a,dep);return {dep,task,job};
}
test('A genuinely verified predecessor allows progression without model or data mutation',t=>{const a=setup(t),{task}=pair(a),before=JSON.stringify(a.data);assert.doesNotThrow(()=>plans.assertReady(a,task));assert.equal(JSON.stringify(a.data),before);});
for(const [name,change] of [
 ['changed artifact',(a,d)=>a.data.artifacts[0].content='未经过验证的新结果'],
 ['deleted artifact',a=>a.data.artifacts=[]],
 ['source revision',(a,d)=>{a.data.sources.push({id:'s',content:'原资料'});d.sourceIds=['s'];d.verification.basis=acceptance.basis(a,d);a.data.sources.push({id:'s2',previousSourceId:'s',content:'新资料'});}],
 ['missing dependency',(a,d,t)=>t.dependsOn=['missing']],
 ['cross-job dependency',(a,d)=>d.agentJobId='foreign'],
 ['cross-project dependency',(a,d)=>d.projectId='foreign'],
 ['dependency cycle',(a,d,t)=>{d.dependsOn=[t.id];d.verification.basis=acceptance.basis(a,d);}],
 ['uncertain receipt',a=>a.data.agentActions.push({id:'uncertain',jobId:'j',status:'uncertain'})],
 ['replan pending',(a,d)=>d.needsReplan='需要核对'],
 ['unfinished predecessor step',(a,d)=>d.steps[0].done=false],
])test(`Execution blocks ${name} before any model or write`,async t=>{const a=setup(t),{dep,task}=pair(a);change(a,dep,task);const before=JSON.stringify(a.data);assert.throws(()=>plans.assertReady(a,task),/前置事项/);await assert.rejects(a.advance(task.id),/前置事项/);assert.equal(JSON.stringify(a.data),before);});
test('Collection failures are scoped, stable across retries, and recover from read state on a new failure',async t=>{
 const a=setup(t);a.data.projects.push({id:'p',name:'资料项目'},{id:'q',name:'其他项目'});a.data.feedConnections.push({id:'feed',name:'公告',projectId:'p',url:'https://example.com/private?token=secret',intervalMinutes:60,enabled:true,health:'error',error:'网络异常'});a.save();
 const get=async()=> (await a.dispatch('attentionSnapshot',{projectId:'p'})).items.find(i=>i.id==='collection:feed:feed');let card=await get();assert.ok(card);assert.equal(card.route.page,'connections');assert.ok(!JSON.stringify(card).includes('secret'));
 assert.equal((await a.dispatch('attentionSnapshot',{projectId:'q'})).items.length,0);await a.dispatch('attentionRead',{id:card.id,revision:card.revision});a.data.feedConnections[0].lastCheckedAt=new Date().toISOString();a.data.feedConnections[0].failures=4;a.save();assert.equal((await get()).state,'read');
 a.data.feedConnections[0].error='XML 损坏';a.save();assert.equal((await get()).state,'unread');a.data.feedConnections[0].health='healthy';a.save();assert.equal(await get(),undefined);a.data.feedConnections[0].health='error';a.save();assert.equal((await get()).state,'unread');
});
test('Feed health and feed recovery integrate with the normal workspace controls',async t=>{
 const a=setup(t);await a.dispatch('projectSave',{name:'订阅项目'});await a.dispatch('feedConnectionSave',{name:'项目消息',projectId:a.data.projects[0].id,url:'https://example.com/feed.xml',intervalMinutes:15});const c=a.data.feedConnections[0];assert.equal(c.enabled,false);
 c.health='error';c.error='token https://example.com/private';const health=await a.dispatch('healthSnapshot');assert.ok(health.findings.some(f=>f.code==='feed_failed'));
 const backup=await a.dispatch('backupCreate');await a.dispatch('feedConnectionToggle',{id:c.id,enabled:true});await a.dispatch('stop');assert.equal(c.enabled,false);
 await a.dispatch('feedConnectionDelete',{id:c.id});await a.dispatch('backupRestore',{id:backup[0].id});assert.deepEqual(a.data.feedConnections,[]);assert.equal((a.data.modelCalls||[]).length,0);
});

test('Planning with old and new source versions retains history but only uses current evidence',t=>{
 const a=setup(t),job={id:'j',projectId:null,taskIds:[],sourceIds:['old','middle','new'],watchers:[],history:[],followups:[],feedback:[],status:'ready'};a.data.delegations.push(job);
 a.data.sources.push({id:'old',content:'预算6800',title:'公告',version:1},{id:'middle',previousSourceId:'old',content:'预算7000',title:'公告',version:2},{id:'new',previousSourceId:'middle',content:'预算7200',title:'公告',version:3});
 const args={key:'report',title:'按最新公告交付',criteria:'预算7200',sourceIds:['old','new'],steps:[{title:'正文',kind:'draft',key:'draft'}]};const planned=plans.planTask(a,job,args),task=a.task(planned.taskId);assert.deepEqual(task.sourceIds,['old','new']);assert.deepEqual(task.supersededSourceIds,['old']);assert.deepEqual(a.context(task).sources.map(s=>s.content),['预算7200']);
 plans.planTask(a,job,{...args,sourceIds:['old'],reason:'重复引用旧资料'});assert.deepEqual(task.sourceIds,['old','new']);assert.deepEqual(a.context(task).sources.map(s=>s.content),['预算7200']);
 task.status='review';task.steps[0].done=true;task.steps[0].artifactId='result';a.data.artifacts.push({id:'result',taskId:task.id,content:'预算7200'});task.verification={passed:true,summary:'当前预算吻合',gaps:[],basis:acceptance.basis(a,task)};assert.deepEqual(acceptance.reasons(a,task),[]);
 plans.planTask(a,job,{...args,sourceIds:['new'],removeSourceIds:['old'],reason:'仅保留当前来源'});assert.deepEqual(task.supersededSourceIds,[]);assert.deepEqual(task.planHistory[0].supersededSourceIds,['old']);assert.equal(task.verification,null);
});

test('A deleted historical source may be retained when its recovered current version is selected',t=>{
 const a=setup(t),job={id:'j',projectId:null,taskIds:[],sourceIds:['old','deleted','restored'],history:[],followups:[],feedback:[],status:'ready'};a.data.delegations.push(job);a.data.sources.push({id:'old',title:'A',content:'原资料'},{id:'deleted',title:'A',content:'文件已删除',deleted:true,previousSourceId:'old'},{id:'restored',title:'A',content:'已恢复资料',previousSourceId:'deleted'});
 const args={key:'restored-plan',title:'恢复资料后继续',criteria:'使用恢复后的资料',sourceIds:job.sourceIds,steps:[{title:'整理',kind:'draft'}]};const {taskId}=plans.planTask(a,job,args);assert.deepEqual(a.task(taskId).supersededSourceIds,['old','deleted']);assert.deepEqual(a.context(a.task(taskId)).sources.map(s=>s.id),['restored']);
 a.data.sources.find(s=>s.id==='restored').deleted=true;assert.throws(()=>plans.planTask(a,job,{...args,reason:'不能用已删除资料'}),/当前版本已撤回/);
});
