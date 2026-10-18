const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),policy=require('../desktop/access-policy-store.cjs'),target=require('../desktop/capture-target.cjs');
const secret='846219735';
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b2-access-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat:async()=>{throw Error('No model');},connectorRequest:async()=>{throw Error('No CLI');}});
 await a.dispatch('projectSave',{name:'Project'});const p=a.data.projects[0];
 await a.dispatch('import',{items:[{title:'Material',content:'private '+secret,projectId:p.id,origin:'test'}]});const s=a.data.sources[0];s.projectId=p.id;
 const task=a.createTask({title:'Public task title',projectId:p.id,sourceIds:[s.id],steps:[{title:'Write',kind:'analysis'}]});task.status='completed';task.verification={passed:true,gaps:[]};task.steps[0].done=true;task.steps[0].artifactId='artifact';
 const artifact={id:'artifact',taskId:task.id,title:'Output',content:'private '+secret,createdAt:new Date().toISOString()};a.data.artifacts.push(artifact);
 for(const [kind,row] of [['source',s],['artifact',artifact]])for(const scope of [{},{taskId:task.id}])policy.grant(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:kind+':'+row.id,...scope},operations:['local_retention','local_read']},{trusted:true,actor:'user_command',command:'test_fixture'});
 s.provenance={url:'https://example.invalid/private',windowTitle:'Private window',appName:'Editor'};a.save();
 return {a,p,s,task,artifact};
}
function revoke(a,kind,row,operations=['local_read'],scope={}){policy.revoke(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:kind+':'+row.id,...scope},operations},{trusted:true,actor:'user_command',command:'test_revoke'});}
for(const operations of [['local_read'],['local_retention','local_read']]){
 test('D01 report guards body, length and completion '+operations,async t=>{const {a,p,artifact}=await setup(t);assert.match((await a.dispatch('projectReport',{projectId:p.id,includeArtifactContent:true})).markdown,new RegExp(secret));revoke(a,'artifact',artifact,operations);const denied=await a.dispatch('projectReport',{projectId:p.id,includeArtifactContent:true});assert.ok(!JSON.stringify(denied).includes(secret));assert.equal(denied.artifacts.length,0);artifact.content='changed';const after=await a.dispatch('projectReport',{projectId:p.id,includeArtifactContent:true});assert.deepEqual(after.progress,denied.progress);assert.deepEqual(after.totals,denied.totals);});
 test('D02 library filters denied sources/artifacts before matching '+operations,async t=>{const {a,s,artifact}=await setup(t);assert.equal((await a.dispatch('librarySearch',{query:secret})).total,2);revoke(a,'source',s,operations);revoke(a,'artifact',artifact,operations);for(const history of [false,true]){const result=await a.dispatch('librarySearch',{query:secret,history});assert.equal(result.total,0);assert.equal(result.items.length,0);}assert.equal((await a.dispatch('librarySearch',{query:'Public task title'})).total,1);});
 test('D03 recommendation cannot score denied body/link but public title works '+operations,async t=>{const {a,s,task}=await setup(t);task.status='todo';assert.equal(target.suggest(a,{text:secret}).taskId,task.id);revoke(a,'source',s,operations,{taskId:task.id});assert.equal(target.suggest(a,{text:secret}).taskId,null);assert.equal(target.suggest(a,{text:'unrelated',provenance:{kind:'selection',url:s.provenance.url}}).taskId,null);assert.equal(target.suggest(a,{text:'Public task title'}).taskId,task.id);});
}

const access=require('../desktop/protocol-access.cjs');
function ownershipFixture(){
 const source={id:'s',projectId:'p'},artifact={id:'v',taskId:'t1',agentJobId:'j1',projectId:'p'};
 const tasks=[{id:'t1',agentJobId:'j1',projectId:'p',sourceIds:['s']},{id:'t2',agentJobId:'j2',projectId:'p',sourceIds:['s']}];
 const a={data:{sources:[source],artifacts:[artifact],tasks,delegations:[{id:'j1',projectId:'p',taskIds:['t1'],sourceIds:['s']},{id:'j2',projectId:'p',taskIds:['t2'],sourceIds:['s']}]},contextAccessCheck:r=>({allowed:r.taskId==='t1'&&r.jobId==='j1'})};
 return {a,source,artifact,tasks};
}
test('D04 owner index preserves task/job scope and rejects duplicate canonical IDs',()=>{
 const {a,source,artifact,tasks}=ownershipFixture();
 const check=(type,row,task)=>access.derivedRead(a,()=>access.canReadSnapshot(a,type,row,{task}));
 assert.equal(check('source',source,tasks[0]),true);assert.equal(check('artifact',artifact,tasks[0]),true);
 assert.equal(check('source',source,tasks[1]),false);assert.equal(check('artifact',artifact,tasks[1]),false);
 assert.equal(check('source',{...source},tasks[0]),false);
 for(const [table,row,type,target]of [['tasks',tasks[0],'source',source],['delegations',a.data.delegations[0],'artifact',artifact],['sources',source,'source',source],['artifacts',artifact,'artifact',artifact]]){
  a.data[table].push({...row});assert.equal(check(type,target,tasks[0]),false,table);a.data[table].pop();assert.equal(check(type,target,tasks[0]),true,table+' restored');
 }
});
test('D05 request ownership cache never caches grants, survives nesting, and expires on return/error',()=>{
 const {a,source,tasks}=ownershipFixture();let allow=true,calls=0;
 a.contextAccessCheck=()=>{calls++;return {allowed:allow};};
 access.derivedRead(a,()=>{
  assert.equal(access.canReadSnapshot(a,'source',source,{task:tasks[0]}),true);allow=false;
  access.derivedRead(a,()=>assert.equal(access.canReadSnapshot(a,'source',source,{task:tasks[0]}),false));
 });assert.equal(calls,2);
 allow=true;tasks[0].sourceIds=[];
 assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',source,{task:tasks[0]})),false);
 tasks[0].sourceIds=['s'];assert.throws(()=>access.derivedRead(a,()=>{throw Error('reader failure');}),/reader failure/);
 tasks[0].supersededSourceIds=['s'];assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',source,{task:tasks[0]})),false);
});
test('D06 ownership change during read retries from a new index; repeated change rejects',()=>{
 const {a,source,tasks}=ownershipFixture();let calls=0;
 const result=access.derivedRead(a,()=>{calls++;const allowed=access.canReadSnapshot(a,'source',source,{task:tasks[0]});if(calls===1)tasks[0].sourceIds=[];return allowed;});
 assert.equal(result,false);assert.equal(calls,2);
 assert.throws(()=>access.derivedRead(a,()=>{tasks[0].sourceIds=tasks[0].sourceIds.length?[]:['s'];return access.canReadSnapshot(a,'source',source,{task:tasks[0]});}),{code:'CONTEXT_VERSION_CHANGED'});
 delete a.contextAccessCheck;assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',source)),false);
});

test('D07 declared source job cannot become an unscoped read when owner is missing or contradictory',()=>{
 const {a,source}=ownershipFixture();a.contextAccessCheck=()=>({allowed:true});source.agentJobId='missing';
 assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',source)),false);
 source.agentJobId='j1';assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',source)),true);
 a.data.delegations[0].projectId='other';assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',source)),false);
});

for(const mutation of ['taskId','jobId','job-membership','job-source','withdrawn','contentDeleted'])test('DR1 real policy rejects '+mutation+' before private recommendation/link scoring',async t=>{
 const {a,p,s,task}=await setup(t);task.status='todo';
 const other=a.createTask({title:'Other public title',projectId:p.id,sourceIds:[s.id]});
 const job={id:'owning-job',projectId:p.id,taskIds:[task.id],sourceIds:[s.id],status:'paused'};a.data.delegations.push(job);task.agentJobId=job.id;
 policy.grant(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+s.id,taskId:task.id,jobId:job.id},operations:['local_retention','local_read']},{trusted:true,actor:'user_command',command:'test_reciprocal_owner'});
 assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',s,{task})),true);
 assert.ok(target.suggest(a,{text:secret}).candidates.some(c=>c.taskId===task.id));
 if(mutation==='taskId')s.taskId=other.id;
 if(mutation==='jobId'){s.jobId='other-job';a.data.delegations.push({id:'other-job',projectId:p.id,taskIds:[other.id],sourceIds:[s.id]});other.agentJobId='other-job';}
 if(mutation==='job-membership')job.taskIds=[];
 if(mutation==='job-source')job.sourceIds=[];
 if(mutation==='withdrawn')s.withdrawn=true;
 if(mutation==='contentDeleted')s.contentDeleted=true;
 assert.equal(access.derivedRead(a,()=>access.canReadSnapshot(a,'source',s,{task})),false);
 for(const input of [{text:secret},{text:'unrelated',provenance:{kind:'selection',url:s.provenance.url}}])assert.ok(!target.suggest(a,input).candidates.some(c=>c.taskId===task.id));
 assert.equal(target.suggest(a,{text:'Public task title'}).taskId,task.id);
 if(['withdrawn','contentDeleted'].includes(mutation)){
  for(const history of [false,true]){const result=await a.dispatch('librarySearch',{type:'source',query:secret,history});assert.equal(result.total,0);assert.equal(result.items.length,0);}
  const report=await a.dispatch('projectReport',{projectId:p.id,includeArtifactContent:true});assert.ok(!report.sources.some(r=>r.id===s.id));
  assert.ok(!a.publicState().sources.find(r=>r.id===s.id).content.includes(secret));
 }
});
for(const field of ['taskId','jobId','taskIds','sourceIds','withdrawn','contentDeleted'])test('DR1 freshness includes '+field+' and retries with new ownership',()=>{
 const {a,source,tasks}=ownershipFixture();let calls=0;
 const result=access.derivedRead(a,()=>{calls++;const allowed=access.canReadSnapshot(a,'source',source,{task:tasks[0]});if(calls===1){if(field==='taskIds'||field==='sourceIds')a.data.delegations[0][field]=[];else source[field]=['withdrawn','contentDeleted'].includes(field)?true:'missing';}return allowed;});
 assert.equal(calls,2);assert.equal(result,false);
});
