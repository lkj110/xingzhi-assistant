const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs');
const connectors=require('../desktop/connectors.cjs'),observations=require('../desktop/source-observations.cjs');
const acceptance=require('../desktop/acceptance.cjs'),basis=require('../desktop/evidence-basis.cjs');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const blocked=()=>{throw Error('B4 forbids real external/model calls');};

async function setup(context,{connector=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-b4-'));
  const remote={id:'synthetic-item',title:'Monday',content:'Synthetic unchanged body'};
  const page={items:null,hasMore:false};
  const instances=[];
  const options={dir,chat:blocked,agentRequest:blocked,connectorRequest:blocked,webRequest:blocked,feedRequest:blocked,
    officeRequest:async()=>({status:200,headers:{},body:JSON.stringify({version:1,...page,items:page.items||[remote]})})};
  const restart=()=>{const assistant=new Assistant(options);instances.push(assistant);return assistant;};
  const assistant=restart();
  context.after(()=>{for(const instance of instances){require('../desktop/deadline-scheduler.cjs').dispose(instance);instance.streamController?.dispose();}fs.rmSync(dir,{recursive:true,force:true});});
  await assistant.dispatch('projectSave',{name:'B4 synthetic project',background:'Original context'});
  const projectId=assistant.data.projects[0].id;
  if(connector){
    await assistant.dispatch('connectorSave',{provider:'json',kind:'office',name:'B4 input',target:'https://example.invalid/items',projectId,enabled:true});
    await connectors.sync(assistant,assistant.data.connectors[0].id);
  }
  return {assistant,remote,page,projectId,restart};
}
async function generated(assistant,projectId,sourceIds=[]){
  await assistant.dispatch('saveProvider',{name:'Synthetic only',model:'fixture',baseUrl:'https://example.invalid',inputPrice:0,outputPrice:0});
  await assistant.dispatch('createTask',{projectId,title:'Synthetic deliverable',criteria:'Contains explanation',sourceIds,steps:[{kind:'draft',title:'Draft'}]});
  const task=assistant.data.tasks[0];
  assistant.chat=async(_provider,_key,messages)=>messages[0].content.includes('推进给定事项')
    ?{kind:'artifact',title:'Explanation',content:'B4_SYNTHETIC_OUTPUT',summary:'Generated locally'}
    :{passed:true,summary:'Contains explanation',gaps:[]};
  await assistant.advance(task.id);
  assert.equal(task.status,'review');
  assert.equal(task.verification.basis,acceptance.basis(assistant,task));
  return task;
}
async function report(assistant,projectId){return assistant.dispatch('uiCommand',{action:'projectReport',input:{projectId,includeArtifactContent:true}});}

test('B4 title A to B to A travels through observation, source chain and current check across restart',async context=>{
  const fixture=await setup(context,{connector:true});let assistant=fixture.assistant;
  const first=assistant.data.sources[0],task=await generated(assistant,fixture.projectId,[first.id]);
  assert.equal(first.semanticFactSchema,2);
  const oldCheck=structuredClone(task.verification);
  fixture.remote.title='Friday';await connectors.sync(assistant,assistant.data.connectors[0].id);
  assert.equal(assistant.data.sources.length,2);
  const second=assistant.data.sources[0];assert.equal(second.title,'Friday');assert.notEqual(second.id,first.id);
  assert.equal(second.semanticFactSchema,2);
  assert.equal(second.previousSourceId,first.id);assert.equal(second.hash,digest(first.content));assert.notEqual(second.semanticHash,first.semanticHash);
  assert.equal(second.stableEventId,'after:'+first.id);assert.notEqual(second.observationId,first.observationId);
  assert.ok(task.sourceIds.includes(second.id));assert.ok(task.supersededSourceIds.includes(first.id));assert.ok(task.needsReplan);
  assert.notEqual(acceptance.basis(assistant,task),oldCheck.basis);assert.notEqual(task.verification?.passed,true);
  assert.equal(basis.relevantChange(first,second),true);
  const observationCount=assistant.data.sourceObservations.length;
  await connectors.sync(assistant,assistant.data.connectors[0].id);assert.equal(assistant.data.sources.length,2);assert.equal(assistant.data.sourceObservations.length,observationCount);
  assistant=fixture.restart();fixture.remote.title='Monday';await connectors.sync(assistant,assistant.data.connectors[0].id);
  const third=assistant.data.sources[0];assert.equal(assistant.data.sources.length,3);assert.equal(third.previousSourceId,second.id);
  assert.equal(third.semanticFactSchema,2);
  assert.equal(third.version,3);assert.notEqual(third.id,first.id);assert.equal(third.semanticHash,first.semanticHash);assert.equal(third.remoteRevision,undefined);
  await connectors.sync(assistant,assistant.data.connectors[0].id);assert.equal(assistant.data.sources.length,3);
  assert.equal(fixture.restart().data.sources[0].id,third.id);
});

test('B4 old body hashes deduplicate without rewriting historical source or observation',async context=>{
  const fixture=await setup(context,{connector:true}),assistant=fixture.assistant,source=assistant.data.sources[0];
  delete source.semanticHash;delete source.semanticFactSchema;assistant.save();
  const before=JSON.stringify(source),events=fs.readFileSync(path.join(assistant.dir,'source-observations.json'),'utf8');
  const restarted=fixture.restart();await connectors.sync(restarted,restarted.data.connectors[0].id);
  assert.equal(restarted.data.sources.length,1);assert.equal(JSON.stringify(restarted.data.sources[0]),before);
  assert.equal(fs.readFileSync(path.join(assistant.dir,'source-observations.json'),'utf8'),events);
  fixture.remote.title='Friday';await connectors.sync(restarted,restarted.data.connectors[0].id);
  assert.equal(restarted.data.sources.length,2);assert.equal(restarted.data.sources[0].previousSourceId,source.id);
  assert.equal(restarted.data.sources[0].semanticFactSchema,2);assert.equal(basis.relevantChange(source,restarted.data.sources[0]),true);
});

test('B4 title normalization, deletion and restoration preserve distinct transitions',async context=>{
  const {assistant,remote}=await setup(context,{connector:true}),connectorId=assistant.data.connectors[0].id;
  remote.title='  Monday  ';await connectors.sync(assistant,connectorId);assert.equal(assistant.data.sources.length,1);
  remote.deleted=true;await connectors.sync(assistant,connectorId);const removed=assistant.data.sources[0];assert.equal(removed.deleted,true);
  assert.equal(removed.semanticFactSchema,2);
  await connectors.sync(assistant,connectorId);assert.equal(assistant.data.sources.length,2);
  remote.deleted=false;remote.title='Monday';await connectors.sync(assistant,connectorId);
  assert.equal(assistant.data.sources.length,3);assert.equal(assistant.data.sources[0].previousSourceId,removed.id);
  assert.equal(assistant.data.sources[0].version,3);assert.notEqual(assistant.data.sources[0].deleted,true);
  assert.equal(assistant.data.sources[0].semanticFactSchema,2);
});

test('B4 failed source save retains cursor and retries exactly one semantic transition after restart',async context=>{
  const fixture=await setup(context,{connector:true}),assistant=fixture.assistant,first=assistant.data.sources[0];
  const cursor=structuredClone(assistant.data.connectors[0].cursor),save=assistant.save.bind(assistant);
  fixture.remote.title='Friday';let injected=false;
  assistant.save=()=>{if(!injected&&assistant.data.sources.length===2){injected=true;throw Error('B4 synthetic save failure');}return save();};
  await connectors.sync(assistant,assistant.data.connectors[0].id);
  assert.equal(injected,true);assert.equal(assistant.data.connectorRuns[0].status,'error');assert.equal(assistant.data.sources.length,1);
  assert.deepEqual(assistant.data.connectors[0].cursor,cursor);
  const restarted=fixture.restart();assert.equal(restarted.data.sources.length,1);
  await connectors.sync(restarted,restarted.data.connectors[0].id);assert.equal(restarted.data.sources.length,2);
  assert.equal(restarted.data.sources[0].previousSourceId,first.id);
  await connectors.sync(restarted,restarted.data.connectors[0].id);assert.equal(restarted.data.sources.length,2);
});

test('B4 title update preserves paused work and unknown side effect until explicitly reconciled',async context=>{
  const {assistant,remote,projectId}=await setup(context,{connector:true}),first=assistant.data.sources[0];
  const task=await generated(assistant,projectId,[first.id]);await assistant.dispatch('taskAction',{id:task.id,command:'pause'});
  const action={id:'b4-unknown',taskId:task.id,status:'uncertain',tool:'write_file',target:'/synthetic/output',result:{verified:false}};
  assistant.data.agentActions.push(action);assistant.save();const cursor=structuredClone(assistant.data.connectors[0].cursor),before=JSON.stringify(task);
  remote.title='Friday';await connectors.sync(assistant,assistant.data.connectors[0].id);
  assert.equal(assistant.data.sources.length,1);assert.equal(JSON.stringify(task),before);assert.equal(action.status,'uncertain');
  assert.deepEqual(assistant.data.connectors[0].cursor,cursor);assert.equal(assistant.data.connectors[0].health,'merge');
  const result=await report(assistant,projectId);assert.equal(result.progress.completed,0);assert.equal(result.progress.uncertainWrites,1);assert.equal(result.deliveries.length,0);
  action.status='failed';action.effectStatus='not_applied';assistant.save();await connectors.sync(assistant,assistant.data.connectors[0].id);
  assert.equal(assistant.data.sources.length,2);assert.equal(task.status,'paused');assert.ok(task.needsReplan);assert.equal(action.status,'failed');
});

test('B4 v2 observation matching cannot reuse a current source with a different title or deletion state',()=>{
  const assistant={data:{sources:[],sourceObservations:[],sourceObservationEvents:[],agentActions:[],decisions:[],projects:[],delegations:[]}};
  const first={id:'old',title:'Monday',content:'same body',projectId:'p',resourceKey:'synthetic:one',remoteRevision:'77',semanticFactSchema:2};
  assistant.data.sources.push(first);
  const changed={...first,id:undefined,title:'Friday',stableEventId:'after:old'};
  const checked=observations.observe(assistant,changed,{trustedInput:true});
  assert.notEqual(checked.sourceId,first.id);const second=observations.attach(assistant,changed,checked);
  assert.equal(second.previousSourceId,'old');assert.equal(second.remoteRevision,'77');
  assert.equal(basis.relevantChange(first,second),true);
  const deleted=observations.observe(assistant,{...second,id:undefined,deleted:true,stableEventId:'after:'+second.id},{trustedInput:true});
  assert.notEqual(deleted.sourceId,second.id);assert.equal(deleted.state,'closed');
});

test('B4 report keeps acceptance history but rejects changed project background and restores after explicit recheck',async context=>{
  const {assistant,projectId,restart}=await setup(context),task=await generated(assistant,projectId);
  await assistant.dispatch('taskAction',{id:task.id,command:'accept'});const history=structuredClone(task.acceptanceHistory),acceptedAt=task.acceptedAt;
  assert.equal((await report(assistant,projectId)).progress.completed,1);
  await assistant.dispatch('projectSave',{id:projectId,name:'B4 synthetic project',background:'Changed required context'});
  const before=JSON.stringify(assistant.data),result=await report(assistant,projectId),brief=await assistant.dispatch('briefingSnapshot',{projectId});
  assert.equal(result.progress.completed,0);assert.equal(result.progress.historicalAccepted,1);assert.equal(result.tasks[0].completionKind,'unverified');
  assert.equal(result.artifacts[0].accepted,false);assert.equal(result.artifacts[0].historicalAccepted,true);
  assert.equal(result.progress.completed,brief.completionCounts.checked);assert.equal(brief.completionCounts.unverified,1);
  assert.match(result.markdown,/历史已验收：1/);assert.match(result.markdown,/当前检查待核对/);
  assert.equal(task.status,'completed');assert.equal(task.acceptedAt,acceptedAt);assert.deepEqual(task.acceptanceHistory,history);assert.equal(JSON.stringify(assistant.data),before);
  assert.equal((await report(restart(),projectId)).progress.completed,0);
  await assistant.dispatch('updateTask',{id:task.id,criteria:'Contains explanation for changed context'});await assistant.advance(task.id);
  await assistant.dispatch('taskAction',{id:task.id,command:'accept'});
  assert.equal((await report(assistant,projectId)).progress.completed,1);assert.equal(task.acceptanceHistory.length,2);
});

test('B4 source title and artifact changes invalidate checks while scheduling metadata does not',async context=>{
  const {assistant,projectId}=await setup(context,{connector:true}),source=assistant.data.sources[0],task=await generated(assistant,projectId,[source.id]);
  await assistant.dispatch('taskAction',{id:task.id,command:'accept'});
  const unchanged=task.verification.basis;source.lastCheckedAt='2099-01-01';task.dueAt='2099-01-01';
  assert.equal(acceptance.basis(assistant,task),unchanged);assert.equal((await report(assistant,projectId)).progress.completed,1);
  source.title='Friday';assert.notEqual(acceptance.basis(assistant,task),unchanged);assert.equal((await report(assistant,projectId)).progress.completed,0);
  source.title='Monday';const artifact=assistant.data.artifacts[0];artifact.content+=' changed';
  assert.equal((await report(assistant,projectId)).progress.completed,0);assert.equal(task.status,'completed');assert.ok(task.acceptedAt);
});

test('B4 report never leaks denied current artifacts or source content',async context=>{
  const {assistant,projectId}=await setup(context),task=await generated(assistant,projectId);await assistant.dispatch('taskAction',{id:task.id,command:'accept'});
  const artifact=assistant.data.artifacts[0],policy=require('../desktop/access-policy-store.cjs');
  policy.revoke(assistant,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+artifact.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'b4_synthetic_revoke'});
  const before=JSON.stringify(assistant.data),result=await report(assistant,projectId);
  assert.equal(result.progress.completed,0);assert.equal(result.artifacts.length,0);assert.doesNotMatch(JSON.stringify(result),/B4_SYNTHETIC_OUTPUT/);assert.equal(JSON.stringify(assistant.data),before);
});

test('B4 legacy ordinary source basis survives upgrade while unknown writes still block without reopening acceptance',async context=>{
  const {assistant,projectId,restart}=await setup(context,{connector:true}),source=assistant.data.sources[0];
  const task=await generated(assistant,projectId,[source.id]);
  await assistant.dispatch('taskAction',{id:task.id,command:'accept'});
  const action={id:'b4-legacy-unknown',taskId:task.id,projectId,status:'uncertain',tool:'write_file',target:'/synthetic/legacy-output',result:{verified:false}};
  assistant.data.agentActions.push(action);
  const currentSources=basis.taskSources(assistant,task);
  const legacySources=currentSources.map(version=>({...version,content:source.fullContentHash||digest(JSON.stringify(source.content))}));
  const legacy=context.mock.method(basis,'taskSources',()=>legacySources);
  const oldBasis=acceptance.basis(assistant,task);legacy.mock.restore();
  task.verification.basis=oldBasis;task.verification.basisVersion=2;delete source.semanticHash;delete source.semanticFactSchema;assistant.save();
  const historical=structuredClone({acceptedAt:task.acceptedAt,acceptedBy:task.acceptedBy,acceptanceHistory:task.acceptanceHistory,workRevision:task.workRevision});
  const sourceHistory=JSON.stringify(assistant.data.sources),observationHistory=fs.readFileSync(path.join(assistant.dir,'source-observations.json'),'utf8');
  const restarted=restart(),restored=restarted.data.tasks.find(value=>value.id===task.id);
  assert.equal(acceptance.basis(restarted,restored),oldBasis);assert.equal(restored.verification.basis,oldBasis);
  assert.equal(restored.status,'completed');assert.deepEqual({acceptedAt:restored.acceptedAt,acceptedBy:restored.acceptedBy,acceptanceHistory:restored.acceptanceHistory,workRevision:restored.workRevision},historical);
  const reasons=acceptance.presentationChecks(restarted)(restored,true);assert.ok(!reasons.some(reason=>reason.code==='changed'));assert.ok(reasons.some(reason=>reason.code==='uncertain'));
  const before=JSON.stringify(restarted.data),result=await report(restarted,projectId),brief=await restarted.dispatch('briefingSnapshot',{projectId});
  assert.equal(result.progress.completed,0);assert.equal(result.progress.historicalAccepted,1);assert.equal(result.progress.uncertainWrites,1);
  assert.equal(result.deliveries.length,0);assert.equal(brief.completionCounts.checked,0);assert.equal(brief.completionCounts.unverified,1);assert.equal(JSON.stringify(restarted.data),before);
  await connectors.sync(restarted,restarted.data.connectors[0].id);
  assert.equal(JSON.stringify(restarted.data.sources),sourceHistory);assert.equal(fs.readFileSync(path.join(assistant.dir,'source-observations.json'),'utf8'),observationHistory);
  assert.equal(restarted.data.agentActions.length,1);assert.deepEqual(restarted.data.agentActions[0],action);assert.equal(restored.status,'completed');assert.equal(restarted.operation,null);
  const secondRestart=restart();assert.equal(secondRestart.data.tasks[0].status,'completed');assert.deepEqual(secondRestart.data.tasks[0].acceptanceHistory,historical.acceptanceHistory);assert.deepEqual(secondRestart.data.agentActions[0],action);
});

test('B4 real manual external evidence and manual completion never enter checked or verified delivery counts',async context=>{
  const {assistant,projectId,restart}=await setup(context),checkedTask=await generated(assistant,projectId);
  await assistant.dispatch('taskAction',{id:checkedTask.id,command:'accept'});
  await assistant.dispatch('createTask',{projectId,title:'Manual external evidence',steps:[{kind:'external',title:'Human confirmation'}]});
  const manualEvidence=assistant.data.tasks[0];
  await assistant.dispatch('taskAction',{id:manualEvidence.id,command:'externalDone',note:'Synthetic user evidence: performed offline'});await assistant.advance(manualEvidence.id);
  await assistant.dispatch('taskAction',{id:manualEvidence.id,command:'accept'});
  await assistant.dispatch('createTask',{projectId,title:'Manual completion without check'});const manualComplete=assistant.data.tasks[0];
  acceptance.markManualComplete(assistant,{id:manualComplete.id,confirmation:{summary:'Synthetic manual acknowledgement'}});
  const before=JSON.stringify(assistant.data),result=await report(assistant,projectId),brief=await assistant.dispatch('briefingSnapshot',{projectId});
  assert.equal(result.progress.completed,1);assert.equal(result.progress.manualEvidence,1);assert.equal(result.progress.manualCompleted,1);assert.equal(result.progress.historicalAccepted,3);
  assert.equal(result.tasks.find(value=>value.id===manualEvidence.id).completionKind,'manual_evidence');assert.equal(result.tasks.find(value=>value.id===manualEvidence.id).currentCheckValid,true);
  assert.equal(result.tasks.find(value=>value.id===manualComplete.id).completionKind,'manual_completed');assert.equal(result.tasks.find(value=>value.id===manualComplete.id).currentCheckValid,false);
  assert.equal(brief.completionCounts.checked,1);assert.equal(brief.completionCounts.manualEvidence,1);assert.equal(result.deliveries.length,0);assert.match(result.markdown,/不代表连接器读回核对/);
  assert.equal(JSON.stringify(assistant.data),before);assert.deepEqual((await report(restart(),projectId)).progress,result.progress);
});

test('B4 v2 plain-title semantic changes preserve platform snapshot semantics and full body integrity hash',()=>{
  const source={id:'plain',title:'Monday',content:'Exact body\r\n',hash:digest('Exact body\r\n'),fullContentHash:'retained-full-body',semanticFactSchema:2};
  assert.notEqual(basis.semanticFactVersion(source),basis.semanticFactVersion({...source,title:'Friday'}));
  assert.equal(basis.semanticFactVersion(source),basis.semanticFactVersion({...source,title:' Monday ',lastCheckedAt:'later'}));
  const platform={...source,platformSnapshot:true,content:JSON.stringify({query:{opaque:'legacy'},data:{confirmed:1}})};
  assert.equal(basis.semanticFactVersion(platform),basis.semanticFactVersion({...platform,title:'Friday'}));
  assert.equal(source.hash,digest('Exact body\r\n'));assert.equal(source.fullContentHash,'retained-full-body');
});

test('B4-IR01 conflicting page is rejected before any observation, source or cursor commit and retries safely',async context=>{
  for(const change of [{title:'Charlie'},{content:'Different body'},{deleted:true}])await context.test(JSON.stringify(change),async nested=>{
    const {assistant,remote,page,restart}=await setup(nested,{connector:true}),connector=assistant.data.connectors[0];
    const observationsFile=path.join(assistant.dir,'source-observations.json'),contentDirectory=path.join(assistant.dir,'observation-content');
    const snapshot=owner=>({sources:JSON.parse(JSON.stringify(owner.data.sources)),observations:structuredClone(owner.data.sourceObservations),events:structuredClone(owner.data.sourceObservationEvents),imported:owner.data.connectors[0].imported,cursor:structuredClone(owner.data.connectors[0].cursor),window:structuredClone(owner.data.connectors[0].syncWindow),log:fs.readFileSync(observationsFile,'utf8'),bodies:fs.readdirSync(contentDirectory).sort()});
    const original=snapshot(assistant);
    const replacement={...remote,title:'Bravo'},unrelated={id:'unrelated-item',title:'Unrelated',content:'Must not commit part of a rejected page'};
    page.items=[unrelated,replacement,{...replacement,...change}];page.hasMore=true;page.nextCursor='must-not-consume';
    for(let attempt=0;attempt<2;attempt++){
      await connectors.sync(assistant,connector.id);
      assert.equal(assistant.data.connectorRuns[0].status,'error');assert.equal(assistant.data.connectorRuns[0].code,'CONNECTOR_PAGE_CONFLICT');
      assert.equal(assistant.data.connectorRuns[0].added,0);assert.equal(assistant.data.connectorRuns[0].pages,0);
      assert.deepEqual(snapshot(assistant),original);assert.equal(connector.health,'merge');assert.equal(connector.nextRunAt,null);
    }
    const restored=restart();assert.deepEqual(snapshot(restored),original);
    await connectors.sync(restored,connector.id);assert.deepEqual(snapshot(restored),original);assert.equal(restored.data.connectorRuns[0].status,'error');
    page.items=[replacement,{...replacement},unrelated];page.hasMore=false;delete page.nextCursor;
    await connectors.sync(restored,connector.id);
    assert.equal(restored.data.connectorRuns[0].status,'updated');assert.equal(restored.data.connectorRuns[0].added,2);
    assert.equal(restored.data.sources.length,original.sources.length+2);assert.equal(restored.data.connectors[0].imported,original.imported+2);
    const latest=restored.data.sources.find(source=>source.remoteId===remote.id);assert.equal(latest.title,'Bravo');assert.equal(latest.previousSourceId,original.sources[0].id);
    const committed=JSON.stringify(restored.data.sources),committedLog=fs.readFileSync(observationsFile,'utf8');
    await connectors.sync(restored,connector.id);assert.equal(restored.data.connectorRuns[0].added,0);assert.equal(restored.data.connectors[0].imported,original.imported+2);
    assert.equal(JSON.stringify(restored.data.sources),committed);assert.equal(fs.readFileSync(observationsFile,'utf8'),committedLog);
    assert.equal(JSON.stringify(restart().data.sources),committed);
  });
});

test('B4-IR01 semantic duplicates collapse without merging different remote identities or source versions',async context=>{
  const {assistant,remote,page,restart}=await setup(context,{connector:true}),connector=assistant.data.connectors[0],first=assistant.data.sources[0];
  page.items=[{...remote,title:'Friday'},{...remote,title:' Friday '},{...remote,id:'second-identity',title:'Friday'}];
  await connectors.sync(assistant,connector.id);
  assert.equal(assistant.data.connectorRuns[0].added,2);assert.equal(connector.imported,3);assert.equal(assistant.data.sources.length,3);
  const replacement=assistant.data.sources.find(source=>source.remoteId===remote.id);assert.equal(replacement.previousSourceId,first.id);assert.equal(replacement.version,2);
  const separate=assistant.data.sources.find(source=>source.remoteId==='second-identity');assert.equal(separate.previousSourceId,undefined);assert.notEqual(separate.identity,replacement.identity);
  const observationCount=assistant.data.sourceObservations.length;await connectors.sync(assistant,connector.id);
  assert.equal(assistant.data.connectorRuns[0].added,0);assert.equal(assistant.data.sourceObservations.length,observationCount);
  const restored=restart();page.items=[{...remote},{...remote}];await connectors.sync(restored,connector.id);
  const returned=restored.data.sources[0];assert.equal(returned.title,'Monday');assert.equal(returned.previousSourceId,replacement.id);assert.equal(returned.version,3);assert.notEqual(returned.id,first.id);
  assert.equal(restored.data.connectorRuns[0].added,1);assert.equal(restored.data.connectors[0].imported,4);assert.equal(restored.data.sources.length,4);
});

test('B4-IR02 only a genuine current basis supports report, briefing and adjacent valid-check claims',async context=>{
  for(const value of [undefined,'','   ',null,false,0,{},[],'old-basis','current'])await context.test(JSON.stringify(value)??'missing',async nested=>{
    const {assistant,projectId,restart}=await setup(nested),task=await generated(assistant,projectId);
    const realBasis=task.verification.basis;
    const ready=require('../desktop/results.cjs').overview(assistant).groups.find(group=>group.id===task.id);assert.equal(ready.ready,true);
    await assistant.dispatch('taskAction',{id:task.id,command:'accept'});
    if(value===undefined)delete task.verification.basis;else if(value!=='current')task.verification.basis=value;
    assistant.save();const restored=restart(),current=restored.data.tasks.find(item=>item.id===task.id);
    const before=JSON.stringify(restored.data),historical=structuredClone({status:current.status,acceptedAt:current.acceptedAt,completedAt:current.completedAt,acceptedBy:current.acceptedBy,history:current.acceptanceHistory,workRevision:current.workRevision});
    const result=await report(restored,projectId),brief=await restored.dispatch('briefingSnapshot',{projectId}),expected=value==='current'?1:0;
    assert.equal(result.progress.completed,expected);assert.equal(brief.completionCounts.checked,expected);assert.equal(result.progress.historicalAccepted,1);
    assert.equal(acceptance.currentBasis(restored,current),value==='current');
    const results=require('../desktop/results.cjs').overview(restored).groups.find(group=>group.id===task.id);
    assert.equal(results.accepted,true);assert.equal(results.reasons.length===0,value==='current');
    const attention=require('../desktop/attention.cjs').snapshot(restored);assert.equal(attention.items.some(item=>item.id==='completion:task:'+task.id),value==='current');
    assert.equal(JSON.stringify(restored.data),before);
    await restored.dispatch('projectSave',{id:projectId,name:'B4 synthetic project',background:'Changed context after cold load'});
    const afterEdit=JSON.stringify(restored.data);
    assert.equal((await report(restored,projectId)).progress.completed,0);assert.equal((await restored.dispatch('briefingSnapshot',{projectId})).completionCounts.checked,0);
    assert.deepEqual({status:current.status,acceptedAt:current.acceptedAt,completedAt:current.completedAt,acceptedBy:current.acceptedBy,history:current.acceptanceHistory,workRevision:current.workRevision},historical);
    assert.equal(JSON.stringify(restored.data),afterEdit);assert.deepEqual(current.verification.basis,value==='current'?realBasis:value);
    if(value===undefined){
      restored.chat=assistant.chat;await restored.dispatch('updateTask',{id:task.id,criteria:'Contains explanation for changed context'});await restored.advance(task.id);
      assert.ok(current.verification.basis);assert.notEqual(current.verification.basis,realBasis);
      await restored.dispatch('taskAction',{id:task.id,command:'accept'});
      assert.equal((await report(restored,projectId)).progress.completed,1);assert.equal((await restored.dispatch('briefingSnapshot',{projectId})).completionCounts.checked,1);assert.equal(current.acceptanceHistory.length,2);
    }
  });
});

test('B4-IR02 presentation basis guard leaves legacy preflight, failure reasons and manual acceptance history unchanged',async context=>{
  const {assistant,projectId}=await setup(context),task=await generated(assistant,projectId),originalCheck=structuredClone(task.verification);
  delete task.verification.basis;
  const before=JSON.stringify(assistant.data);assert.deepEqual(acceptance.reasons(assistant,task),[]);assert.equal(acceptance.preflight(assistant,{id:task.id}),task);
  const reasons=acceptance.presentationChecks(assistant)(task);assert.ok(reasons.some(reason=>reason.code==='changed'));assert.equal(JSON.stringify(assistant.data),before);
  task.verification.passed=false;const failure=acceptance.reasons(assistant,task);assert.deepEqual(acceptance.presentationChecks(assistant)(task),failure);
  task.verification=originalCheck;acceptance.markManualComplete(assistant,{id:task.id,confirmation:{summary:'Synthetic explicit manual completion'}});
  const manualBefore=JSON.stringify(assistant.data),result=await report(assistant,projectId),brief=await assistant.dispatch('briefingSnapshot',{projectId});
  assert.equal(result.progress.manualCompleted,1);assert.equal(result.progress.completed,0);assert.equal(brief.completionCounts.checked,0);assert.equal(brief.completionCounts.unverified,1);assert.equal(JSON.stringify(assistant.data),manualBefore);
});

test('B4-IR03 unmarked ordinary facts preserve the exact legacy formula including full content identities',()=>{
  for(const content of [undefined,'','Exact body\r\n','e\u0301 and \u00e9'])for(const fullContentHash of [undefined,'','retained-full-body']){
    const source={id:'legacy',title:'Monday',content,fullContentHash,semanticHash:'not-a-schema'},before=structuredClone(source);
    const expected=fullContentHash||digest(JSON.stringify(content)??'null');
    assert.equal(basis.semanticFactVersion(source),expected);
    assert.equal(basis.semanticFactVersion({...source,title:'Friday'}),expected);
    assert.equal(basis.semanticFactVersion({...source,semanticFactSchema:undefined}),expected);
    assert.deepEqual(source,before);assert.equal(Object.hasOwn(source,'semanticFactSchema'),false);
    const current={...source,semanticFactSchema:2};
    assert.equal(basis.semanticFactVersion(current),basis.hash({title:'Monday',content:expected}));
    assert.notEqual(basis.semanticFactVersion(current),expected);
    assert.equal(basis.relevantChange(source,current),true);
  }
  const platform={id:'platform',title:'Monday',platformSnapshot:true,content:JSON.stringify({query:{opaque:'legacy'},data:{confirmed:1}}),fullContentHash:'not-the-platform-semantic-identity'};
  const original=basis.semanticFactVersion(platform);
  assert.equal(original,basis.hash(basis.facts(platform)));
  for(const semanticFactSchema of [undefined,2,null,'2',3])assert.equal(basis.semanticFactVersion({...platform,semanticFactSchema,title:'Friday'}),original);
});

test('B4-IR03 one projection scope distinguishes schema and title changes and never caches invalid schemas as legacy',()=>{
  const source={id:'cache-source',title:'Monday',content:'Exact body'},legacy=digest(JSON.stringify(source.content));
  require('../desktop/projection-cache.cjs').scope(()=>{
    assert.equal(basis.semanticFactVersion(source),legacy);
    source.semanticFactSchema=2;const current=basis.semanticFactVersion(source);assert.notEqual(current,legacy);
    source.semanticHash='forged-summary';assert.equal(basis.semanticFactVersion(source),current);
    source.title='Friday';const changed=basis.semanticFactVersion(source);assert.notEqual(changed,current);
    source.title='  Friday  ';assert.equal(basis.semanticFactVersion(source),changed);
    source.title='Monday';assert.equal(basis.semanticFactVersion(source),current);
    for(const semanticFactSchema of [null,false,true,0,1,-1,3,2.5,'2','',[],{},NaN,Infinity]){
      source.semanticFactSchema=semanticFactSchema;
      for(let attempt=0;attempt<2;attempt++)assert.throws(()=>basis.semanticFactVersion(source),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
      assert.throws(()=>basis.version(source),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
      assert.throws(()=>basis.readBasisVersion(source),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
    }
    delete source.semanticFactSchema;assert.equal(basis.semanticFactVersion(source),legacy);
    source.semanticFactSchema=2;assert.equal(basis.semanticFactVersion(source),current);
    source.content+=' changed';assert.notEqual(basis.semanticFactVersion(source),current);
  });
});

test('B4-IR03 local connector schema overrides remote fields only on new versions and keeps old checks stable until change',async context=>{
  const {assistant,remote,projectId,restart}=await setup(context,{connector:true}),source=assistant.data.sources[0],connector=assistant.data.connectors[0];
  assert.equal(source.semanticFactSchema,2);delete source.semanticFactSchema;delete source.semanticHash;assistant.save();
  const task=await generated(assistant,projectId,[source.id]);await assistant.dispatch('taskAction',{id:task.id,command:'accept'});
  const oldCheck=structuredClone(task.verification),original=JSON.stringify(source),observationsFile=path.join(assistant.dir,'source-observations.json'),observationLog=fs.readFileSync(observationsFile,'utf8');
  const restored=restart(),restoredConnector=restored.data.connectors[0],restoredTask=restored.data.tasks.find(value=>value.id===task.id);
  const repeated={remoteId:remote.id,title:remote.title,content:remote.content,semanticFactSchema:999};
  assert.equal(connectors.commit(restored,restoredConnector,[repeated],restoredConnector.cursor),0);
  assert.equal(repeated.semanticFactSchema,999);assert.equal(JSON.stringify(restored.data.sources[0]),original);assert.equal(fs.readFileSync(observationsFile,'utf8'),observationLog);
  assert.equal(acceptance.basis(restored,restoredTask),oldCheck.basis);assert.equal((await report(restored,projectId)).progress.completed,1);
  assert.equal(connectors.commit(restored,restoredConnector,[{...repeated,title:'Friday',semanticFactSchema:null}],restoredConnector.cursor),1);
  const replacement=restored.data.sources[0];assert.equal(replacement.semanticFactSchema,2);assert.equal(replacement.previousSourceId,source.id);
  assert.equal(basis.relevantChange(source,replacement),true);assert.notEqual(acceptance.basis(restored,restoredTask),oldCheck.basis);
  assert.equal(JSON.stringify(restored.data.sources.find(value=>value.id===source.id)),original);
  const observation=restored.data.sourceObservations.find(value=>value.observationId===replacement.observationId);
  const body=JSON.parse(fs.readFileSync(path.join(restored.dir,'observation-content',observation.contentRef.id+'.json'),'utf8'));
  assert.equal(body.semanticFactSchema,2);assert.equal(body.title,'Friday');
  const current=await report(restored,projectId);assert.equal(current.progress.completed,0);assert.equal(current.progress.historicalAccepted,1);
  const cold=restart();assert.equal(cold.data.sources[0].semanticFactSchema,2);assert.equal(cold.data.connectors.find(value=>value.id===connector.id).imported,2);
  assert.equal((await report(cold,projectId)).progress.completed,0);
});

test('B4-IR03 unknown ordinary schemas fail closed in check and presentation without altering acceptance history',async context=>{
  const {assistant,projectId}=await setup(context,{connector:true}),source=assistant.data.sources[0],task=await generated(assistant,projectId,[source.id]);
  await assistant.dispatch('taskAction',{id:task.id,command:'accept'});
  const historical=structuredClone(task.acceptanceHistory),check=structuredClone(task.verification);
  for(const semanticFactSchema of [null,1,'2',3]){
    source.semanticFactSchema=semanticFactSchema;const before=JSON.stringify(assistant.data);
    assert.throws(()=>acceptance.basis(assistant,task),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
    assert.throws(()=>acceptance.currentBasis(assistant,task),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
    assert.throws(()=>acceptance.presentationChecks(assistant)(task,true),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
    await assert.rejects(report(assistant,projectId),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
    await assert.rejects(assistant.dispatch('briefingSnapshot',{projectId}),{code:'SOURCE_SEMANTIC_SCHEMA_INVALID'});
    assert.equal(JSON.stringify(assistant.data),before);assert.deepEqual(task.acceptanceHistory,historical);assert.deepEqual(task.verification,check);
  }
  source.semanticFactSchema=2;assert.equal((await report(assistant,projectId)).progress.completed,1);
});
