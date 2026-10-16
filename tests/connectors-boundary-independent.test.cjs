const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const root=path.resolve(__dirname,'..');
const {Assistant}=require(path.join(root,'desktop/core.cjs'));
const connectors=require(path.join(root,'desktop/connectors.cjs')),web=require(path.join(root,'desktop/web-connections.cjs')),feeds=require(path.join(root,'desktop/feeds.cjs')),agent=require(path.join(root,'desktop/agent.cjs')),projects=require(path.join(root,'desktop/projects.cjs')),recovery=require(path.join(root,'desktop/recovery.cjs'));
const response=body=>({status:200,headers:{'content-type':'text/plain'},body});
async function fixture(t,extra={}) {const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-audit-connectors-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat:async()=>{throw Error('NO_PAID_MODEL');},officeRequest:async()=>{throw Error('NO_NETWORK');},webRequest:async()=>{throw Error('NO_NETWORK');},connectorRequest:async()=>{throw Error('NO_NETWORK');},agentRequest:async()=>{throw Error('NO_NETWORK');},...extra});await a.dispatch('projectSave',{name:'Audit'});await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});return a;}
async function webFixture(t,mode='web'){let body='approved v1';const request=async()=>mode==='web'?response(body):{status:200,headers:{'content-type':'application/rss+xml'},body:`<rss version="2.0"><channel><title>Test</title><item><guid>one</guid><title>Release</title><description>${body}</description></item></channel></rss>`};const a=await fixture(t,{webRequest:request});feeds.initialize(a,request);const p=a.data.projects[0];const j=agent.buildJob(a,{projectId:p.id,goal:'Wait for approval',allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.push(j);p.jobId=j.id;const type=mode==='web'?'webConnectionSave':'feedConnectionSave';await a.dispatch(type,{name:'Test',url:'https://example.com/source',projectId:p.id,intervalMinutes:5,enabled:true});const c=(mode==='web'?a.data.webConnections:a.data.feedConnections)[0];const sync=()=>mode==='web'?web.sync(a,c.id):feeds.sync(a,c.id);await sync();return {a,p,j,c,sync,set:v=>body=v};}
for(const mode of ['web','feed']) test(`${mode}: restored resolved followup must reopen if source advanced multiple versions`,async t=>{const f=await webFixture(t,mode);const s=f.a.data.sources[0];f.j.followups.push({key:'approved',expected:'release approved',status:'resolved',sourceId:s.id,sourceIds:[s.id],watchKeys:[mode==='web'?`webConnection:${f.c.id}`:`feedConnection:${f.c.id}:${s.feedEntryKey}`],resolvedAt:new Date().toISOString(),verification:{quote:'approved v1',reason:'Approved'}});f.a.save();const backup=recovery.create(f.a);f.set('approved v2');await f.sync();f.set('approval cancelled v3');await f.sync();await f.a.dispatch('backupRestore',{id:backup});await f.sync();const j=f.a.data.delegations.find(x=>x.id===f.j.id);assert.equal(j.sourceIds.includes(f.a.data.sources[0].id),true,'latest source reattached');assert.equal(j.followups[0].status,'waiting','resolved evidence from v1 must not survive current v3 cancellation');});
test('JSON connector must reject recurring cursor A/B cycle across restarts',async t=>{let calls=0;const request=async url=>{calls++;const token=new URL(url).searchParams.get('cursor');return response(JSON.stringify({version:1,items:[{id:'one',content:'unchanged'}],hasMore:true,nextCursor:token==='a'?'b':'a'}));};const a=await fixture(t,{officeRequest:request});await a.dispatch('connectorSave',{provider:'json',name:'Cycle source',target:'https://example.com/events',projectId:a.data.projects[0].id,enabled:true});const id=a.data.connectors[0].id;await connectors.sync(a,id);const b=new Assistant({dir:a.dir,officeRequest:request});await connectors.sync(b,id);assert.ok(calls<=4,'cycle should be detected before endlessly replaying pages');assert.equal(b.data.connectorRuns[0].status,'error');});
test('Control: real content and title changes remain traceable after backup restore',async t=>{const f=await webFixture(t);const old=f.a.data.sources[0],backup=recovery.create(f.a);f.set('changed');await f.sync();const latest=f.a.data.sources[0];await f.a.dispatch('backupRestore',{id:backup});await f.sync();const j=f.a.data.delegations.find(x=>x.id===f.j.id);assert.equal(j.status,'paused');assert.ok(j.sourceIds.includes(latest.id));const context=agent.context(f.a,j);assert.equal(context.sources.some(s=>s.id===old.id),false);assert.ok(context.historyCatalog.some(s=>s.id===old.id));assert.equal(context.sources.find(s=>s.id===latest.id).current,true);assert.equal((f.a.data.modelCalls||[]).length,0);});
test('Control: uncertain external receipt blocks replacing source and losing evidence',async t=>{const f=await webFixture(t);const before=f.a.data.sources[0].id;f.a.data.agentActions.push({id:'uncertain',jobId:f.j.id,status:'uncertain',tool:'lark_update'});f.set('changed');await f.sync();assert.equal(f.a.data.sources[0].id,before);assert.equal(f.a.data.webConnectionRuns[0].status,'error');assert.equal(f.a.data.agentActions[0].status,'uncertain');});
async function mount(a,name){const root=path.join(a.dir,name);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'SKILL.md'),'version 1');const p=await a.dispatch('capabilityInspect',{kind:'repository',path:root});await a.dispatch('capabilitySave',{token:p.token,allowedTools:['read_document']});return a.data.capabilities[0];}
test('Control: repository revoke/remount does not silently restore old task grant or affect another repository',async t=>{const a=await fixture(t),cap=require(path.join(root,'desktop/capabilities.cjs')),binding=require(path.join(root,'desktop/capability-binding.cjs'));const one=await mount(a,'one-repo'),two=await mount(a,'two-repo');const j=agent.buildJob(a,{goal:'Use two tools',capabilityIds:[one.id,two.id]});a.data.delegations.push(j);const args=c=>({capabilityId:c.id,tool:'read_document',input:{path:'SKILL.md'}});assert.equal((await cap.invoke(a,j,args(one))).result.content,'version 1');await a.dispatch('capabilityRemove',{id:one.id});await assert.rejects(cap.invoke(a,j,args(one)),/未授权/);assert.equal((await cap.invoke(a,j,args(two))).result.content,'version 1');await a.dispatch('capabilityToggle',{id:one.id,enabled:true});assert.equal(binding.bind(a,j,'使用 one-repo').length,0);await assert.rejects(cap.invoke(a,j,args(one)),/未授权/);await a.dispatch('capabilityGrant',{jobId:j.id,capabilityIds:[one.id,two.id]});fs.writeFileSync(path.join(one.path,'SKILL.md'),'version 2');assert.equal((await cap.invoke(a,j,args(one))).result.content,'version 2');});
test('Control: backup restore cannot resurrect a removed repository or external write grant',async t=>{const a=await fixture(t),c=await mount(a,'source-repo'),j=agent.buildJob(a,{goal:'Read',capabilityIds:[c.id]});a.data.delegations.push(j);a.save();const backup=recovery.create(a);await a.dispatch('capabilityRemove',{id:c.id});await a.dispatch('backupRestore',{id:backup});const next=a.data.capabilities.find(x=>x.id===c.id);assert.equal(next.enabled,false);assert.ok(next.removedAt);assert.equal(a.data.delegations[0].status,'paused');await assert.rejects(require(path.join(root,'desktop/capabilities.cjs')).invoke(a,a.data.delegations[0],{capabilityId:c.id,tool:'read_document',input:{path:'SKILL.md'}}),/未授权|委托已暂停/);assert.equal(require('../desktop/access-policy-store.cjs').checkTool(a,a.data.delegations[0],'capability_call',{capabilityId:c.id,tool:'read_document',input:{path:'SKILL.md'}}).allowed,false);});
test('Control: deleting/restoring task pauses only linked job; preserves sibling and fee ledger',async t=>{const a=await fixture(t),trash=require(path.join(root,'desktop/task-trash.cjs')),spend=require(path.join(root,'desktop/spend.cjs'));const first=agent.buildJob(a,{goal:'one'}),second=agent.buildJob(a,{goal:'two'});a.data.delegations.push(first,second);const task=a.createTask({title:'one'});task.agentJobId=first.id;first.taskIds.push(task.id);first.followups.push({key:'waiting',taskId:task.id,status:'waiting'});a.activeAgentJob=first;spend.scope(a).spentUSD=7;spend.persist(a);a.activeAgentJob=null;const ledger=structuredClone(a.spendLedger),sibling=structuredClone(second);await a.dispatch('taskTrashDelete',{id:task.id,revision:trash.preview(a,{id:task.id}).revision});assert.equal(first.status,'paused');assert.equal(first.followups[0].status,'cancelled');assert.deepEqual(second,sibling);assert.deepEqual(a.spendLedger,ledger);await a.dispatch('taskTrashRestore',{id:task.id,revision:task.trashRevision});assert.equal(first.status,'paused');assert.deepEqual(second,sibling);assert.deepEqual(a.spendLedger,ledger);});
test('Unrelated parallel job should not globally block deleting an idle standalone task',async t=>{const a=await fixture(t),execution=require(path.join(root,'desktop/execution.cjs')),trash=require(path.join(root,'desktop/task-trash.cjs'));const j=agent.buildJob(a,{goal:'Long unrelated work'});a.data.delegations.push(j);const task=a.createTask({title:'Unrelated idle task'});let release;const hold=new Promise(r=>release=r);execution.launch(a,{jobId:j.id},'fixture job',()=>hold);try{await a.dispatch('taskTrashDelete',{id:task.id,revision:trash.preview(a,{id:task.id}).revision});assert.ok(task.deletedAt);}finally{release();await a.runPromise;}});
for(const change of ['issue-body','comment-body'])test(`GitHub rule must detect ${change} edits after preview truncation boundary`,async t=>{let revision=1;const request=async url=>{const issue={number:1,title:'Tracked task',body:'A'.repeat(4500)+(change==='issue-body'?`priority=${revision}`:'stable'),state:'open',updated_at:`2026-10-15T00:0${revision}:00Z`,comments:1,html_url:'https://github.com/fixture/repo/issues/1'};const payload=url.includes('/comments?')?[{id:9,user:{login:'human'},body:'C'.repeat(1300)+(change==='comment-body'?`decision=${revision}`:'stable'),updated_at:issue.updated_at,html_url:'https://github.com/fixture/repo/issues/1#issuecomment-9'}]:url.includes('/issues?')?[issue]:issue;return response(JSON.stringify(payload));};const a=await fixture(t,{agentRequest:request});await a.dispatch('ruleSave',{name:'Watch GitHub',goal:'Respond to any substantive change',useGithub:true,githubRepo:'fixture/repo',includeExisting:false,enabled:true,folderIds:[],fileMode:'off',githubMode:'off'});const rule=a.data.workRules[0],rules=require(path.join(root,'desktop/work-rules.cjs'));await rules.check(a,rule);assert.equal(a.data.ruleRuns[0].status,'baseline');revision=2;await rules.check(a,rule);assert.equal(a.data.ruleRuns[0].status,'created','human edit should trigger follow-up even if the presentation preview stays identical');});

// Composition regressions: real core dispatch + isolated storage; all remote responses mocked.
async function githubFixture(t, count=225) {
  const state={body:'Baseline', title:'Tracked', comments:Array.from({length:count},(_,i)=>({id:i+1,user:{login:'human'},body:`comment-${i+1}`,updated_at:'2026-10-15T00:00:00Z',html_url:`https://github.com/fixture/repo/issues/1#issuecomment-${i+1}`})),updated:'2026-10-15T00:00:00Z'};
  const requests=[];
  const request=async raw=>{
    const url=new URL(raw); requests.push(url.pathname+url.search);
    const issue={number:1,title:state.title,body:state.body,state:'open',updated_at:state.updated,comments:state.comments.length,html_url:'https://github.com/fixture/repo/issues/1'};
    if(url.pathname.endsWith('/comments')){const page=Number(url.searchParams.get('page')||1);return response(JSON.stringify(state.comments.slice((page-1)*100,page*100)));}
    return response(JSON.stringify(url.pathname.endsWith('/issues')?[issue]:issue));
  };
  const a=await fixture(t,{agentRequest:request});
  await a.dispatch('ruleSave',{name:'Track all comments',goal:'Track human changes',useGithub:true,githubRepo:'fixture/repo',includeExisting:false,enabled:true,folderIds:[],fileMode:'off',githubMode:'off'});
  const rule=a.data.workRules[0], rules=require('../desktop/work-rules.cjs');
  const check=async()=>{await rules.check(a,rule);return a.data.ruleRuns[0];};
  assert.equal((await check()).status,'baseline');
  return {a,state,rule,requests,check};
}
for(const change of ['edit','delete']) test(`GitHub detects ${change} of earliest comment outside newest pages and preview`,async t=>{
  const f=await githubFixture(t,325);
  if(change==='edit')f.state.comments[0].body='Approval withdrawn in the first comment';else f.state.comments.shift();
  f.state.updated='2026-10-15T01:00:00Z';
  assert.equal((await f.check()).status,'created');
  assert.ok(f.requests.some(r=>r.endsWith('per_page=100&page=1')));
  assert.ok(f.requests.some(r=>r.endsWith('per_page=100&page=4')));
  const j=f.a.data.delegations[0]; assert.ok(j.sourceIds.length);
});

test('Forged App marker in human comment is included, even if copied from a real own receipt',async t=>{
  const f=await githubFixture(t,1),body='Please confirm\n\n<!-- xingzhi:abcdef123456 -->';
  f.a.data.agentActions.push({id:'own-comment',status:'done',tool:'github_comment',target:'fixture/repo',number:1,result:{commentId:2,verified:true,body}});
  f.state.comments.push({id:2,user:{login:'app'},body});
  assert.equal((await f.check()).status,'unchanged','exact own comment receipt is excluded');
  f.state.comments.push({id:3,user:{login:'human'},body});
  assert.equal((await f.check()).status,'created','same marker/body with another comment ID is human evidence');
});

test('Editing an App-created comment or mixing own comment with human edit triggers tracking',async t=>{
  const f=await githubFixture(t,1),body='App comment';
  f.a.data.agentActions.push({id:'own-comment',status:'done',tool:'github_comment',target:'fixture/repo',number:1,result:{commentId:2,verified:true,body}});
  f.state.comments.push({id:2,user:{login:'app'},body});
  assert.equal((await f.check()).status,'unchanged');
  f.state.comments[1].body='Human correction to previously created comment';
  f.state.comments[0].body='Another human correction';
  assert.equal((await f.check()).status,'created');
});

function ownUpdateFixture(f,body) {
  const job=agent.buildJob(f.a,{goal:'Original own update'});job.ruleId=f.rule.id;job.ruleRevision=f.rule.revision;
  f.a.data.delegations.push(job);
  const at=new Date().toISOString();
  const action={id:'own-update',jobId:job.id,status:'done',tool:'github_update',target:'fixture/repo',number:1,desired:{title:f.state.title,body,state:'open'},createdAt:at,finishedAt:at,result:{number:1,title:f.state.title,body,state:'open',updatedAt:at,url:'https://github.com/fixture/repo/issues/1',verified:true}};
  f.a.data.agentActions.push(action);return action;
}

test('Own Issue write cannot hide a simultaneous early human comment change',async t=>{
  const f=await githubFixture(t,225);ownUpdateFixture(f,'App content');f.state.body='App content';
  f.state.comments[0].body='New human requirement';
  assert.equal((await f.check()).status,'created');
});

test('A human reverting an Issue to an older App-written body is still a new change',async t=>{
  const f=await githubFixture(t,1);ownUpdateFixture(f,'App content');f.state.body='App content';
  assert.equal((await f.check()).status,'unchanged','only the new own write is ignored');
  f.state.body='Human content';assert.equal((await f.check()).status,'created');
  f.state.body='App content';f.state.updated='2026-10-15T03:00:00Z';
  assert.equal((await f.check()).status,'merged','an old write receipt cannot suppress a later human reversion');
});

async function jsonConnection(a) {
  await a.dispatch('connectorSave',{provider:'json',name:'Paged source',target:'https://example.com/events',projectId:a.data.projects[0].id,enabled:true});
  return a.data.connectors[0];
}
const jsonPage=(token,hasMore=true)=>response(JSON.stringify({version:1,items:[{id:'stable',content:'One stable message'}],hasMore,...(hasMore?{nextCursor:token}:{})}));

test('Cursor A to B to C to A is detected across repeated application restarts',async t=>{
  let allowed=1,calls=0;
  const request=async url=>{if(!allowed--)throw Error('injected transient transport failure');calls++;const token=new URL(url).searchParams.get('cursor')||'';return jsonPage({'':'a',a:'b',b:'c',c:'a'}[token]);};
  let a=await fixture(t,{officeRequest:request});const c=await jsonConnection(a),id=c.id,dir=a.dir;
  for(let i=0;i<4;i++){allowed=1;await connectors.sync(a,id);if(i<3)a=new Assistant({dir,officeRequest:request});}
  const current=a.data.connectors[0];assert.equal(current.health,'cursor_cycle');assert.equal(current.nextRunAt,null);assert.equal(current.syncWindow.status,'blocked');assert.equal(a.data.sources.length,1);assert.equal(calls,4);
  const b=new Assistant({dir,officeRequest:request});allowed=1;await connectors.sync(b,id);assert.equal(calls,4,'blocked window does not fetch again after restart');
});

test('Identical page bodies with unique forward cursors are valid and do not duplicate sources',async t=>{
  const seen=[];const a=await fixture(t,{officeRequest:async url=>{const token=new URL(url).searchParams.get('cursor')||'';seen.push(token);return token==='c'?jsonPage('',false):jsonPage({'':'a',a:'b',b:'c'}[token]);}});
  const c=await jsonConnection(a);await connectors.sync(a,c.id);
  assert.deepEqual(seen,['','a','b','c']);assert.equal(c.syncWindow.status,'complete');assert.equal(c.health,'healthy');assert.equal(a.data.sources.length,1);assert.equal(c.cursor.token,undefined);
});

test('Page persistence failure preserves unconsumed cursor and retries the page exactly once',async t=>{
  const seen=[];const a=await fixture(t,{officeRequest:async url=>{const token=new URL(url).searchParams.get('cursor')||'';seen.push(token);return token?jsonPage('',false):jsonPage('a');}});
  const c=await jsonConnection(a),save=a.save.bind(a);let fail=true;
  a.save=()=>{if(fail&&a.data.sources.length){fail=false;throw Error('injected storage failure');}return save();};
  await connectors.sync(a,c.id);assert.equal(a.data.sources.length,0);assert.equal(c.cursor,null);assert.equal(c.syncWindow,undefined);assert.equal(a.data.connectors[0],c);
  a.save=save;await connectors.sync(a,c.id);assert.deepEqual(seen,['','','a']);assert.equal(a.data.sources.length,1);assert.equal(c.syncWindow.status,'complete');assert.equal(c.cursor.token,undefined);
});

const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
async function linkedTask(a,title){const job=agent.buildJob(a,{goal:title});a.data.delegations.push(job);const task=a.createTask({title});task.agentJobId=job.id;job.taskIds.push(task.id);return {job,task};}

test('Committed deletion survives projection failure and keeps another running job object and later results',async t=>{
  const a=await fixture(t),execution=require('../desktop/execution.cjs'),trash=require('../desktop/task-trash.cjs'),{job,task:active}=await linkedTask(a,'Independent active'),{task:idle}=await linkedTask(a,'Idle');
  const gate=deferred(),started=deferred(),sourceArray=a.data.sources,artifactArray=a.data.artifacts,feedback=job.feedback;
  execution.launch(a,{jobId:job.id},'active',async view=>{started.resolve();await gate.promise;assert.equal(view.data.delegations.find(j=>j.id===job.id),job);job.summary='Finished through same object';view.data.artifacts.push({id:'after-delete-failure',taskId:active.id,title:'Result',content:'preserved',createdAt:new Date().toISOString()});view.save();});
  await started.promise;const save=a.save.bind(a);let failed=false;a.save=()=>{if(!failed&&idle.deletedAt){failed=true;throw Error('injected disk full');}return save();};
  try{await assert.rejects(a.dispatch('taskTrashDelete',{id:idle.id,revision:trash.preview(a,{id:idle.id}).revision}),error=>error.committed&&error.projectionPending&&/disk full/.test(error.message));assert.equal(a.data.tasks.find(x=>x.id===idle.id),idle);assert.ok(idle.deletedAt);assert.ok(idle.projectionPending);assert.equal(a.data.delegations.find(x=>x.id===job.id),job);assert.equal(job.feedback,feedback);assert.equal(a.data.sources,sourceArray);assert.equal(a.data.artifacts,artifactArray);}
  finally{a.save=save;gate.resolve();await a.runPromise;}
  assert.equal(job.summary,'Finished through same object');assert.equal(a.data.artifacts.at(-1).id,'after-delete-failure');const saved=JSON.parse(fs.readFileSync(a.file,'utf8'));assert.ok(saved.artifacts.some(r=>r.id==='after-delete-failure'));assert.ok(saved.tasks.find(t=>t.id===idle.id).deletedAt);assert.equal(idle.projectionPending,undefined);assert.equal(require('../desktop/work-journal.cjs').read(a).events.filter(e=>e.type==='deleted'&&e.entityId===idle.id).length,1);
});

for(const transitive of [false,true])test(`Running ${transitive?'transitive':'direct'} dependent task blocks deleting its prerequisite`,async t=>{
  const a=await fixture(t),execution=require('../desktop/execution.cjs'),trash=require('../desktop/task-trash.cjs');const prerequisite=a.createTask({title:'Prerequisite'}),middle=a.createTask({title:'Dependent'});middle.dependsOn=[prerequisite.id];
  const {job,task}=await linkedTask(a,'Running dependent');task.dependsOn=[transitive?middle.id:prerequisite.id];const hold=deferred();execution.launch(a,{jobId:job.id},'dependent',()=>hold.promise);
  try{const preview=trash.preview(a,{id:prerequisite.id});assert.equal(preview.allowed,false);assert.ok(preview.conflictingResources.some(r=>r.taskId===task.id));await assert.rejects(a.dispatch('taskTrashDelete',{id:prerequisite.id,revision:preview.revision}),/关联工作正在执行/);assert.equal(prerequisite.deletedAt,undefined);}
  finally{hold.resolve();await a.runPromise;}
});

test('Expired Slack cursor restarts its preserved window without being misclassified as a pagination cycle',async t=>{
  let refreshed=false;
  const a=await fixture(t,{officeRequest:async url=>{
    const cursor=new URL(url).searchParams.get('cursor');
    if(cursor==='expired'){refreshed=true;return response(JSON.stringify({ok:false,error:'invalid_cursor'}));}
    return response(JSON.stringify({ok:true,messages:[{ts:'1791000000.000001',text:'stable message',user:'U123'}],has_more:true,response_metadata:{next_cursor:refreshed?'fresh':'expired'}}));
  }});
  await a.dispatch('connectorSave',{provider:'slack',name:'Slack source',target:'C0123456789',projectId:a.data.projects[0].id,token:'MOCK_TOKEN',enabled:true});
  const c=a.data.connectors[0];await connectors.sync(a,c.id);const range=structuredClone(c.cursor.window);assert.equal(c.cursor.token,'expired');
  await connectors.sync(a,c.id);assert.equal(c.health,'cursor');assert.equal(c.cursor.token,undefined);
  await connectors.sync(a,c.id);assert.equal(c.health,'healthy');assert.equal(c.cursor.token,'fresh');assert.deepEqual(c.cursor.window,range);assert.equal(a.data.sources.length,1);
});

test('A repeated immediate cursor is a blocked cycle rather than endlessly retryable transport failure',async t=>{
  const a=await fixture(t,{officeRequest:async()=>jsonPage('a')}),c=await jsonConnection(a);
  await connectors.sync(a,c.id);assert.equal(c.health,'cursor_cycle');assert.equal(c.nextRunAt,null);assert.equal(c.syncWindow.status,'blocked');
});

test('An error after durable page commit keeps its cursor and does not replay committed page on restart',async t=>{
  const seen=[],request=async url=>{const token=new URL(url).searchParams.get('cursor')||'';seen.push(token);return token?jsonPage('',false):jsonPage('a');};
  const a=await fixture(t,{officeRequest:request}),c=await jsonConnection(a),save=a.save.bind(a);let fail=true;
  a.save=()=>{save();if(fail&&a.data.sources.length){fail=false;throw Object.assign(Error('injected post-commit observer error'),{committed:true});}};
  await connectors.sync(a,c.id);assert.equal(c.cursor.token,'a');assert.equal(c.syncWindow.sequence,1);assert.equal(a.data.sources.length,1);a.save=save;
  const b=new Assistant({dir:a.dir,officeRequest:request});await connectors.sync(b,c.id);assert.deepEqual(seen,['','a']);assert.equal(b.data.sources.length,1);assert.equal(b.data.connectors[0].syncWindow.status,'complete');
});

test('Replacing a connector credential restarts its partial authorization-scoped scan',async t=>{
  const requests=[];
  const a=await fixture(t,{officeRequest:async(url,options)=>{
    const cursor=new URL(url).searchParams.get('cursor')||'',credential=options.headers.Authorization;
    requests.push({cursor,credential});
    const renewed=credential==='Bearer NEW_MOCK_TOKEN';
    return response(JSON.stringify({ok:true,messages:[{ts:renewed&&!cursor?'1791000000.000002':'1791000000.000001',text:renewed&&!cursor?'Newly authorized message':'Previously readable message',user:'U123'}],has_more:!renewed||!cursor,response_metadata:{next_cursor:renewed?(cursor?'':'fresh-offset'):'shared-offset'}}));
  }});
  const config={provider:'slack',name:'Slack source',target:'C0123456789',projectId:a.data.projects[0].id,enabled:true};
  await a.dispatch('connectorSave',{...config,token:'OLD_MOCK_TOKEN'});
  const c=a.data.connectors[0];await connectors.sync(a,c.id);assert.equal(c.cursor.token,'shared-offset');
  const oldWindow=c.syncWindow.id;
  await a.dispatch('connectorSave',{...config,id:c.id,token:'NEW_MOCK_TOKEN'});
  await connectors.sync(a,c.id);
  assert.equal(requests.at(-1).cursor,'','a cursor from the previous credential must not skip newly authorized messages');
  assert.notEqual(c.syncWindow.id,oldWindow);assert.equal(c.syncWindow.status,'partial');
  assert.ok(a.data.sources.some(s=>s.content.includes('Newly authorized message')));
  await connectors.sync(a,c.id);
  assert.equal(requests.at(-1).cursor,'fresh-offset','the new scope restarts once, then resumes its own persisted cursor');
  assert.equal(c.syncWindow.status,'complete');assert.equal(c.health,'healthy');
});

test('Legacy capability evidence stays isolated by delegation and project, and observations cannot bypass revocation',async t=>{
  const a=await fixture(t),cap=await mount(a,'migration-repo'),firstProject=a.data.projects[0].id;
  await a.dispatch('projectSave',{name:'Second audit project'});
  const secondProject=a.data.projects.find(p=>p.id!==firstProject).id;
  const args={capabilityId:cap.id,tool:'read_document',input:{path:'SKILL.md'}};
  const originals=[];
  for(const [index,projectId] of [firstProject,firstProject,secondProject].entries()){
    const job=agent.buildJob(a,{goal:`Scoped legacy reader ${index}`,projectId,capabilityIds:[cap.id]});
    a.data.delegations.push(job);
    const result=await agent.act(a,job,'capability_call',args),source=a.data.sources.find(s=>s.id===result.sourceId);
    delete source.resourceKey;source.identity='capability:'+result.recordId;
    a.data.agentRuns.push({id:`legacy-run-${index}`,jobId:job.id,steps:[{tool:'capability_call',args,result}]});
    originals.push({jobId:job.id,sourceId:source.id,projectId});
  }
  a.save();
  const b=new Assistant({dir:a.dir,chat:async()=>{throw Error('NO_PAID_MODEL');},agentRequest:async()=>{throw Error('NO_NETWORK');}});
  const keys=new Set();
  for(const old of originals){
    const job=b.data.delegations.find(j=>j.id===old.jobId),result=await agent.act(b,job,'capability_call',args);
    assert.equal(result.sourceId,old.sourceId);assert.equal(result.contentChanged,false);
    const source=b.data.sources.find(s=>s.id===result.sourceId);assert.equal(source.projectId,old.projectId);keys.add(source.resourceKey);
    assert.deepEqual(job.sourceIds,[old.sourceId]);
  }
  assert.equal(keys.size,3,'same input does not merge different delegations or projects');
  await b.dispatch('capabilityRemove',{id:cap.id});const before=b.data.capabilityRuns.length;
  for(const {jobId} of originals)await assert.rejects(agent.act(b,b.data.delegations.find(j=>j.id===jobId),'capability_call',args),/未授权/);
  assert.equal(b.data.capabilityRuns.length,before,'a prior evidence observation cannot make a revoked tool execute');
});
