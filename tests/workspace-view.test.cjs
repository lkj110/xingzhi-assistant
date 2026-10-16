const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),policies=require('../desktop/access-policy-store.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'view-isolated-'));const a=new Assistant({dir,chat:()=>{throw Error('model forbidden');}});t.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});return a;}
test('large workspace projection excludes bodies, preserves explicit full export, and does not mutate stored data',async t=>{
 const a=fixture(t),text='long material with facts\n'.repeat(8000).trim();
 await a.dispatch('import',{items:Array.from({length:12},(_,i)=>({title:'material '+i,content:text}))});
 a.data.agentRuns.push({id:'run',jobId:'missing',status:'done',steps:Array.from({length:30},()=>({tool:'read_source',args:{},result:{body:text}}))});a.save();
 const raw=JSON.stringify(a.data),first=await a.dispatch('stateView');
 assert.ok(Buffer.byteLength(JSON.stringify(first))<Buffer.byteLength(raw)/10);
 assert.equal(first.state.sources[0].contentChars,text.length);assert.ok(first.state.sources[0].content.length<=130);
 assert.equal(first.state.agentRuns[0].steps.length,0);assert.equal(first.state.agentRuns[0].stepCount,30);
 assert.equal(JSON.stringify(a.data),raw);
 assert.equal((await a.dispatch('viewDetail',{kind:'source',id:a.data.sources[0].id})).content,text);
 assert.equal((await a.dispatch('uiCommand',{action:'export'})).sources[0].content,text);
 const page=await a.dispatch('viewDetail',{kind:'agentRun',id:'run',limit:2});assert.equal(page.steps.length,2);assert.equal(page.more,true);assert.equal(page.steps[0].result.truncated,true);
 assert.equal((await a.dispatch('viewDetail',{kind:'agentStep',id:'run',stepIndex:0})).result.body,text);
});
test('unchanged refresh returns only revision; mutation sends entity delta and preserves unchanged row references',async t=>{
 const a=fixture(t);await a.dispatch('import',{items:[{title:'one',content:'first'},{title:'two',content:'second'}]});
 const {mergeWorkspace}=await import('../src/workspace-sync.mjs');const first=await a.dispatch('stateView');
 const unchanged=await a.dispatch('stateView',{revision:first.revision});assert.equal(unchanged.unchanged,true);assert.equal(mergeWorkspace(first.state,unchanged),first.state);
 a.data.sources[0].title='changed';a.save();const next=await a.dispatch('stateView',{revision:first.revision});assert.ok(next.patch);assert.equal(next.patch.sources.upsert.length,1);
 const merged=mergeWorkspace(first.state,next);assert.equal(merged.sources[1],first.state.sources[1]);assert.equal(merged.sources[0].title,'changed');
 assert.throws(()=>mergeWorkspace({...first.state,viewRevision:'wrong'},next),/重新同步/);
});
test('permission revocation invalidates cached summary and all detail/read/export paths',async t=>{
 const a=fixture(t);await a.dispatch('import',{items:[{title:'private',content:'DO-NOT-EXPOSE-AFTER-REVOKE'}]});const s=a.data.sources[0];
 const first=await a.dispatch('stateView');assert.ok(first.state.sources[0].content.includes('DO-NOT'));
 const resourceScope={kind:'snapshot',key:'source:'+s.id};
 policies.revoke(a,{principalScope:policies.LOCAL,resourceScope,operations:['local_retention','local_read']},{trusted:true,actor:'user_command',command:'test'});
 const changed=await a.dispatch('stateView',{revision:first.revision});assert.notEqual(changed.revision,first.revision);
 const {mergeWorkspace}=await import('../src/workspace-sync.mjs');const state=mergeWorkspace(first.state,changed);assert.equal(state.sources[0].content,'');
 await assert.rejects(a.dispatch('viewDetail',{kind:'source',id:s.id}),/权限/);
 await assert.rejects(a.dispatch('uiCommand',{action:'readSource',input:{id:s.id}}),/权限/);
 assert.equal((await a.dispatch('export')).sources[0].content,'');
});
test('refresh requests are coalesced and in-flight pre-command responses cannot overwrite newer state',async()=>{
 const {createWorkspaceSync}=await import('../src/workspace-sync.mjs');const pending=[],applied=[];
 const sync=createWorkspaceSync({fetchState:()=>new Promise(resolve=>pending.push(resolve)),onState:s=>applied.push(s.viewRevision)});
 const first=sync.refresh();sync.refresh();assert.equal(pending.length,1);sync.refresh(true);
 pending.shift()({revision:'old',state:{viewRevision:'old'}});await new Promise(r=>setImmediate(r));assert.equal(pending.length,1);assert.deepEqual(applied,[]);
 pending.shift()({revision:'new',state:{viewRevision:'new'}});await first;assert.deepEqual(applied,['new']);sync.dispose();
});
test('summary projection preserves memory validity and plan history without checkpoint bodies',async t=>{
 const a=fixture(t);await a.dispatch('import',{items:[{title:'confirmed source',content:'confirmed facts '.repeat(1000)}]});
 await a.dispatch('memorySave',{kind:'fact',title:'confirmed',content:'confirmed by user',sourceId:a.data.sources[0].id});
 const task=a.createTask({title:'history'});task.planHistory=[{version:1,at:'2026-01-01',reason:'new requirement',steps:[{id:'old',title:'previous step',kind:'draft',done:true,checkpoint:{sections:[{content:'large private draft'}]}}]}];a.save();
 const state=(await a.dispatch('stateView')).state;
 assert.equal(state.memories[0].effective,true);assert.equal(state.memoryUsage[0].included,1);
 assert.equal(state.tasks[0].planHistory[0].steps[0].title,'previous step');assert.equal(state.tasks[0].planHistory[0].steps[0].checkpoint,undefined);
 assert.equal(a.data.tasks[0].planHistory[0].steps[0].checkpoint.sections[0].content,'large private draft');
});
test('summary decision revisions use canonical uncertain action content and remain actionable',async t=>{
 const a=fixture(t),row={id:'orphan',jobId:'gone-job',taskId:'gone-task',tool:'write_file',status:'uncertain',effectStatus:'unknown',target:path.join(a.dir,'old.md'),content:'old exact body',baseline:{content:'old baseline'},result:{}};
 a.data.agentActions.push(row);a.save();
 const state=(await a.dispatch('stateView')).state,card=state.decisionCards.find(r=>r.id==='action:orphan');
 assert.equal(card.action.content,row.content);assert.equal(card.revision,require('../desktop/decisions.cjs').cards(a.data).find(r=>r.id===card.id).revision);
 await a.dispatch('uiCommand',{action:'decisionActionResolve',input:{id:card.id,revision:card.revision,confirmedNotApplied:true}});
 assert.equal(row.effectStatus,'not_applied');
});
test('model history details preserve all records while home preview stays bounded',async t=>{
 const a=fixture(t);a.data.modelCalls=Array.from({length:30},(_,i)=>({id:String(i),at:new Date().toISOString(),status:'done',inputTokens:i,outputTokens:1}));a.save();
 assert.equal((await a.dispatch('stateView')).state.modelCalls.length,8);
 const detail=await a.dispatch('viewDetail',{kind:'modelCalls',id:'all'});assert.equal(detail.calls.length,30);
 assert.equal(detail.calls.reduce((n,r)=>n+r.inputTokens,0),435);
});
