const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),capture=require('../desktop/capture.cjs'),web=require('../desktop/web-connections.cjs'),followup=require('../desktop/agent-followup.cjs');
function setup(t,options={}){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-reliable-integration-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Assistant({dir,chat:async()=>({tasks:[],summary:'done'}),...options});}
test('Incoming collections and subscriptions rotate with rules, Agent work and standalone tasks',async t=>{
 const a=setup(t),calls=[];for(const [name,module] of [['capture',capture],['web',web],['connectors',require('../desktop/connectors.cjs')],['rules',require('../desktop/work-rules.cjs')],['agent',agent]])t.mock.method(module,'tick',()=>{calls.push(name);return true;});
 a.data.settings.automatic=true;t.mock.method(a,'parallelTasks',()=>{calls.push('tasks');return true;});
 for(let n=0;n<12;n++){a.lastTick=0;a.tick();await a.runPromise;}
 assert.deepEqual(calls,['capture','web','connectors','rules','agent','tasks','capture','web','connectors','rules','agent','tasks']);
});
test('A due standalone feedback reminder is recorded even when another work family is ready',t=>{
 const a=setup(t);const item=a.createTask({title:'等待确认'});item.status='waiting';item.nextCheckAt=new Date(Date.now()-1000).toISOString();
 t.mock.method(capture,'tick',()=>true);a.tick();assert.equal(item.followupDue,true);assert.equal(a.data.events.filter(e=>e.title==='到了跟进时间').length,1);a.tick();assert.equal(a.data.events.filter(e=>e.title==='到了跟进时间').length,1);
});
test('Global pause and active work block every automatic work family without dropping queue data',async t=>{
 const a=setup(t),calls=[];for(const m of [capture,web,agent,require('../desktop/connectors.cjs'),require('../desktop/work-rules.cjs')])t.mock.method(m,'tick',()=>{calls.push(true);return true;});
 await a.dispatch('stewardshipPause');a.tick();assert.equal(calls.length,0);await a.dispatch('stewardshipResume');a.operation={label:'busy'};a.tick();assert.equal(calls.length,0);a.operation=null;
});
test('Internal capture import requires the active matching processing receipt',t=>{
 const a=setup(t);a.operation={label:'busy'};a.data.captureQueue.push({id:'receipt',status:'processing'});
 assert.throws(()=>a.addSources([{title:'材料',content:'数据'}],{captureId:'receipt'}),/当前处理阶段/);assert.equal(a.data.sources.length,0);
 a.captureProcessingId='receipt';a.addSources([{title:'材料',content:'数据'}],{captureId:'receipt'});const row=a.data.captureQueue[0];assert.equal(row.sourceIds.length,1);assert.equal(row.stage,'organize');assert.equal(a.data.sources[0].captureId,row.id);const saved=JSON.parse(fs.readFileSync(a.file,'utf8'));assert.equal(saved.captureQueue[0].sourceIds[0],saved.sources[0].id);a.operation=null;
});
test('Project capture checks all unresolved actions before creating sources, even without a pending pointer',async t=>{
 const a=setup(t);await a.dispatch('projectSave',{name:'项目'});const p=a.data.projects[0];await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});const j=agent.buildJob(a,{projectId:p.id,goal:'目标'});a.data.delegations.push(j);p.jobId=j.id;j.pendingActionId=null;
 a.data.agentActions.push({id:'unknown-action',jobId:j.id,status:'uncertain',tool:'write_file'});
 await assert.rejects(a.dispatch('captureSave',{projectId:p.id,textItems:[{title:'新版资料',content:'不得部分保存'}]}),/待核对/);assert.equal(a.data.sources.length,0);
});
test('Project webpage versions are current model evidence and can satisfy scoped followup without duplicate watchers',async t=>{
 let body='<title>发布</title><p>尚未确认时间</p>';const a=setup(t,{webRequest:async url=>({status:200,headers:{'content-type':'text/html'},body,url}),chat:async()=>({satisfied:true,quote:'确认10月12日发布',reason:'新的页面明确确认'})});
 await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});await a.dispatch('projectSave',{name:'项目'});const p=a.data.projects[0],j=agent.buildJob(a,{projectId:p.id,goal:'等待公告',allowWeb:false});j.status='paused';a.data.delegations.push(j);p.jobId=j.id;
 await a.dispatch('webConnectionSave',{name:'公告',url:'https://example.com/news',projectId:p.id,intervalMinutes:30,enabled:false});const c=a.data.webConnections[0];await a.dispatch('webConnectionSync',{id:c.id});await a.runPromise;const first=a.data.sources[0];assert.equal(agent.context(a,j).sources.find(s=>s.id===first.id).current,true);
 followup.wait(a,j,{key:'publish',sourceIds:[first.id],reason:'等待确认',expected:'确认发布时间'});body='<title>发布</title><p>确认10月12日发布</p>';await a.dispatch('webConnectionSync',{id:c.id});await a.runPromise;const second=a.data.sources[0];const ctx=agent.context(a,j);assert.equal(ctx.sources.some(s=>s.id===first.id),false);assert.ok(ctx.historyCatalog.some(s=>s.id===first.id));assert.equal(ctx.sources.find(s=>s.id===second.id).webConnectionId,c.id);
 const result=await followup.resolve(a,j,{key:'publish',sourceId:second.id,evidence:'公告已明确日期'});assert.equal(result.status,'resolved');assert.equal(j.watchers.length,0);
});
