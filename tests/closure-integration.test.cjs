const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),lifecycle=require('../desktop/project-lifecycle.cjs');
async function setup(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-closure-integration-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;
 const forbidden=async()=>{calls++;throw new Error('unexpected external call');};
 const a=new Assistant({dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,webRequest:forbidden,feedRequest:forbidden});
 await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
 await a.dispatch('projectSave',{name:'已交付项目'});const p=a.data.projects[0];const j=agent.buildJob(a,{projectId:p.id,goal:'写成果',fileMode:'off'});a.data.delegations.push(j);p.jobId=j.id;
 const result=await agent.act(a,j,'plan_task',{key:'report',title:'待办',criteria:'符合资料',steps:[{key:'draft',title:'成果',kind:'draft'}]});const task=a.task(result.taskId);
 await a.dispatch('import',{items:[{projectId:p.id,title:'项目资料',content:'旧资料'}]});
 const archive=async()=>a.dispatch('projectLifecycleArchive',{id:p.id,revision:lifecycle.preview(a,{id:p.id}).revision});return{a,p,j,task,archive,calls:()=>calls};
}
test('archived project rejects every intake and execution request before mutations while readonly history remains available',async t=>{
 const {a,p,j,task,archive,calls}=await setup(t);await archive();
 for(const [action,input] of [['import',{items:[{projectId:p.id,title:'新资料',content:'新内容'}]}],['importDocuments',{projectId:p.id,items:[{title:'x.pdf',base64:'invalid'}]}],['captureEnqueue',{projectId:p.id,textItems:[{title:'新',content:'内容'}]}],['agentFeedback',{id:j.id,note:'新要求'}],['updateTask',{id:task.id,title:'修改'}],['advance',{id:task.id}],['agentResume',{id:j.id}],['projectSave',{id:p.id,name:'更名'}],['extract',{ids:[a.data.sources[0].id]}]]){
  const before=structuredClone(a.data);await assert.rejects(a.dispatch(action,input),/归档/);assert.deepEqual(a.data,before,action);
 }
 assert.equal((await a.dispatch('readSource',{id:a.data.sources[0].id})).sourceId,a.data.sources[0].id);
 assert.ok((await a.dispatch('projectReport',{projectId:p.id})).markdown.includes('已交付项目'));
 assert.ok((await a.dispatch('workmapSnapshot',{projectId:p.id})).items.some(row=>row.taskId===task.id));
 assert.equal(calls(),0);
});
test('background collection and agent queues refuse archived scopes even if stale persisted enable flags reappear',async t=>{
 const {a,p,j,task,archive,calls}=await setup(t);await archive();j.status='ready';task.status='waiting';task.nextCheckAt='2020-01-01T00:00:00Z';
 j.followups.push({key:'old-wait',status:'waiting',taskId:task.id,deadlineAt:'2020-01-01T00:00:00Z',expected:'回复'});
 for(const [module,key] of [['feeds','feedConnections'],['web-connections','webConnections'],['connectors','connectors']]){
  a.data[key].push({id:'archived-'+key,name:'旧订阅',projectId:p.id,enabled:true,nextRunAt:null});assert.equal(require('../desktop/'+module+'.cjs').tick(a),false);
 }
 assert.equal(agent.tick(a),false);assert.equal(a.data.decisions.length,0);assert.equal(calls(),0);
 a.tick();await a.runPromise;assert.equal(task.followupDue,undefined);assert.equal(a.data.decisions.length,0);assert.equal(calls(),0);
});
test('archived project does not halt independent work and reopening requires explicit resume',async t=>{
 const {a,p,j,archive}=await setup(t);await archive();
 await a.dispatch('import',{items:[{title:'独立新材料',content:'继续独立工作'}]});assert.ok(a.data.sources.some(s=>!s.projectId&&s.title==='独立新材料'));
 await a.dispatch('projectSave',{name:'另一项目'});const other=a.data.projects[0];await a.dispatch('import',{items:[{projectId:other.id,title:'另一份',content:'可继续'}]});
 await a.dispatch('projectLifecycleReopen',{id:p.id,revision:lifecycle.preview(a,{id:p.id}).revision});assert.equal(j.status,'paused');assert.equal(j.nextRunAt,null);
 await a.dispatch('agentResume',{id:j.id});assert.equal(j.status,'ready');
});
test('archive stops routine attention cards while preserving unresolved external result attention',async t=>{
 const {a,p,j,task,archive}=await setup(t);await a.dispatch('updateTask',{id:task.id,dueAt:'2020-01-01T00:00:00Z'});
 j.followups.push({key:'old-wait',status:'waiting',taskId:task.id,deadlineAt:'2020-01-01T00:00:00Z',expected:'回复'});
 a.data.agentActions.push({id:'unknown',taskId:task.id,jobId:j.id,status:'uncertain',tool:'write_file'});
 assert.ok((await a.dispatch('attentionSnapshot',{projectId:p.id})).items.some(row=>row.category==='deadline'));
 await archive();const cards=(await a.dispatch('attentionSnapshot',{projectId:p.id})).items;assert.equal(cards.length,1);assert.equal(cards[0].id,'action:unknown');assert.equal(cards[0].severity,'critical');
});
test('global memory updates preserve archived job history and unknown receipts',async t=>{
 const {a,j,task,archive}=await setup(t);a.data.agentActions.push({id:'unknown',taskId:task.id,jobId:j.id,status:'uncertain',tool:'write_file'});j.pendingActionId='unknown';await archive();const previous=structuredClone(j);
 await a.dispatch('memorySave',{title:'全局偏好',content:'简洁中文',kind:'preference'});assert.deepEqual(j,previous);assert.equal(a.data.agentActions[0].status,'uncertain');
});
test('memory changes preflight task-only unknown receipts atomically',async t=>{
 const {a,j,task}=await setup(t);a.data.agentActions.push({id:'unknown',taskId:task.id,status:'uncertain',tool:'write_file'});const before=structuredClone(a.data);
 await assert.rejects(a.dispatch('memorySave',{title:'全局偏好',content:'简洁中文',kind:'preference'}),/外部|核对/);assert.deepEqual(a.data,before);assert.equal(j.pendingActionId,null);
});
test('legacy task-only receipt can be explicitly resolved without automatically repeating the action',async t=>{
 const {a,j,task,calls}=await setup(t);a.data.agentActions.push({id:'unknown',taskId:task.id,status:'uncertain',tool:'write_file'});
 await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(calls(),0);assert.equal(j.pendingActionId,'unknown');
 await a.dispatch('agentResolve',{id:j.id,actionId:'unknown',confirmedNotApplied:true});assert.equal(a.data.agentActions[0].status,'failed');assert.equal(calls(),0);assert.equal(j.pendingActionId,null);
});
