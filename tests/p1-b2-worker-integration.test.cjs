const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EngineClient}=require('../desktop/engine-client.cjs');
const marker='581902746',desktop=path.resolve(__dirname,'../desktop');
const fixture=String.raw`
exports.create=({Assistant,options})=>{
 const policy=require(desktop+'/access-policy-store.cjs');
 const denied=async()=>{throw Error('External access prohibited');};
 class Fixture extends Assistant{
  tick(){}
  async dispatch(action,input={}){
   if(action==='fixtureSetup'){
    await super.dispatch('saveProvider',{type:'ollama',name:'Synthetic',model:'fixture',baseUrl:'http://127.0.0.1:9',inputPrice:0,outputPrice:0});
    await super.dispatch('settings',{automatic:false,autoComplete:false});
    await super.dispatch('projectSave',{name:'Isolated report project'});const project=this.data.projects[0];
    await super.dispatch('import',{items:[{title:'Neutral source',content:'Evidence number 581902746',projectId:project.id}],projectId:project.id});const source=this.data.sources[0];
    const output=this.createTask({title:'Prepare public report',criteria:'Include the evidence number',projectId:project.id,sourceIds:[source.id],steps:[{title:'Write',kind:'draft'}]});output.generationMode='single';
    const ongoing=this.createTask({title:'Public followup title',criteria:'Track followup',projectId:project.id,sourceIds:[source.id]});
    this.save();return {projectId:project.id,sourceId:source.id,outputId:output.id,ongoingId:ongoing.id};
   }
   if(action==='fixtureAdvance'){
    await super.dispatch('advance',{id:input.id});await this.runPromise;const task=this.task(input.id);
    return {status:task.status,lastError:task.lastError,artifactId:task.steps[0].artifactId,calls:(this.data.modelCalls||[]).length};
   }
   if(action==='fixtureAccess'){
    for(const [kind,id] of [['source',input.sourceId],['artifact',input.artifactId]]){
     const spec={principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:kind+':'+id},operations:input.operations||['local_read']};
     policy[input.restore?'grant':'revoke'](this,spec,{trusted:true,actor:'user_command',command:'isolated_test_permission'});
    }
    return {calls:(this.data.modelCalls||[]).length};
   }
   if(action==='fixtureSummary')return {calls:(this.data.modelCalls||[]).length,status:this.task(input.id).status,acceptedBy:this.task(input.id).acceptedBy};
   return super.dispatch(action,input);
  }
 }
 const chat=async(_p,_k,_m,o)=>{o.onUsage?.({inputTokens:5,outputTokens:5,cachedInputTokens:0});return o.role==='verify'?{passed:true,summary:'The report includes the required evidence number',gaps:[]}:{kind:'artifact',title:'Public output',content:'Report evidence: 581902746',summary:'Draft prepared'};};
 return new Fixture({...options,chat,agentRequest:denied,connectorRequest:denied,officeRequest:denied,webRequest:denied,feedRequest:denied});
};`;
async function setup(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p1-b2-worker-'))),workspace=path.join(dir,'workspace'),fixtureModule=path.join(dir,'fixture.cjs');fs.mkdirSync(workspace);fs.writeFileSync(fixtureModule,`const desktop=${JSON.stringify(desktop)};\n`+fixture);
 let engine;
 const start=async()=>{engine=new EngineClient({dir:workspace,fixtureModule,native:async action=>action==='attentionAvailable'?{supported:false}:{ok:true}});await engine.ready;return engine;};
 t.after(async()=>{await engine?.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});
 return {engine:await start(),restart:async()=>{await engine.close();return start();},workspace};
}
const ui=(e,action,input)=>e.dispatch('uiCommand',{action,input});
for(const operations of [['local_read'],['local_retention','local_read']]){
 test('Worker generation→check→accept→derived views→revoke→cold restart '+operations,async t=>{
  const setupResult=await setup(t);let e=setupResult.engine;const ids=await e.dispatch('fixtureSetup');
  const generated=await e.dispatch('fixtureAdvance',{id:ids.outputId});assert.equal(generated.status,'review',generated.lastError);assert.ok(generated.artifactId);assert.equal(generated.calls,2);
  await ui(e,'taskAction',{id:ids.outputId,command:'accept'});const accepted=await e.dispatch('fixtureSummary',{id:ids.outputId});assert.equal(accepted.status,'completed');assert.equal(accepted.acceptedBy,'user');
  const report=await ui(e,'projectReport',{projectId:ids.projectId,includeArtifactContent:true});assert.match(report.markdown,new RegExp(marker));
  for(const type of ['source','artifact'])assert.equal((await ui(e,'librarySearch',{type,query:marker})).total,1);
  assert.equal((await e.capture('suggest',{text:marker})).taskId,ids.ongoingId);
  await e.dispatch('fixtureAccess',{...ids,artifactId:generated.artifactId,operations});
  const checkDenied=async()=>{
   const denied=await ui(e,'projectReport',{projectId:ids.projectId,includeArtifactContent:true});assert.ok(!JSON.stringify(denied).includes(marker));assert.equal(denied.artifacts.length,0);
   for(const type of ['source','artifact'])for(const history of [false,true])assert.equal((await ui(e,'librarySearch',{type,query:marker,history})).total,0);
   assert.equal((await e.capture('suggest',{text:marker})).taskId,null);
   assert.equal((await e.capture('suggest',{text:'Public followup title'})).taskId,ids.ongoingId);
   assert.deepEqual(await e.dispatch('fixtureSummary',{id:ids.outputId}),accepted);
  };
  await checkDenied();e=await setupResult.restart();await checkDenied();
  await e.dispatch('fixtureAccess',{...ids,artifactId:generated.artifactId,operations:['local_retention','local_read'],restore:true});
  assert.match((await ui(e,'projectReport',{projectId:ids.projectId,includeArtifactContent:true})).markdown,new RegExp(marker));
  for(const type of ['source','artifact'])assert.equal((await ui(e,'librarySearch',{type,query:marker})).total,1);
  assert.equal((await e.capture('suggest',{text:marker})).taskId,ids.ongoingId);assert.deepEqual(await e.dispatch('fixtureSummary',{id:ids.outputId}),accepted);
 });
}
