const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const observations=require('../desktop/source-observations.cjs');
const projects=require('../desktop/projects.cjs');
const connectors=require('../desktop/connectors.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const url='https://tenant.larkoffice.com/docx/fixture';
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-observations-v3-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const job={id:'job',projectId:'project',status:'watching',completedAt:'accepted',failures:4,sourceIds:[],taskIds:[],feedback:[],followups:[],history:[],watchers:[]};
  const data={projects:[{id:'project',name:'Fixture',jobId:job.id}],delegations:[job],tasks:[],agentActions:[],sources:[],decisions:[],projectChanges:[],workRules:[],runtime:{},folders:[],connectors:[]};
  const a={dir,data,task(id){return this.data.tasks.find(t=>t.id===id);},save(){fs.writeFileSync(path.join(dir,'workspace.json'),JSON.stringify(this.data));},event(){},requeue(){throw Error('Unexpected requeue');},ensureIdle(){},publicState(){return this.data;}};
  return {a,job,project:data.projects[0],restart(){const b={...a,data:JSON.parse(fs.readFileSync(path.join(dir,'workspace.json'),'utf8'))};return b;}};
}
function source(extra={}){return {title:'Fixture output',content:'complete output',projectId:'project',agentJobId:'job',resourceKey:url,principalScope:'account',remoteRevision:'2',...extra};}
function action(extra={}){return {id:'action',jobId:'job',taskId:'task',tool:'lark_update',target:url,larkOpenId:'account',status:'done',effectStatus:'applied',result:{url,revision:'2',readbackHash:hash('complete output'),verified:true},...extra};}
const opts={channel:'watch',trustedInput:true,scope:{projectId:'project',jobId:'job'}};
test('watch before outcome persists pending; outcome and restart resolve once without reopening continuous work',t=>{
  const f=fixture(t);f.a.data.agentActions.push(action({status:'uncertain',effectStatus:undefined,result:undefined}));
  const before=structuredClone(f.job),first=observations.observe(f.a,source(),opts);
  assert.equal(first.state,'pending');assert.equal(first.allowInput,false);assert.equal(f.a.data.sources.length,0);assert.deepEqual(f.job,before);f.a.save();
  const b=f.restart();b.data.agentActions=[action()];observations.reclassify(b,{actionId:'action'});
  assert.equal(b.data.sourceObservations[0].state,'resolved_observation');assert.equal(b.data.decisions[0].status,'resolved');assert.deepEqual(b.data.delegations[0],before);
  const count=b.data.sourceObservationEvents.length;observations.reclassify(b,{actionId:'action'});assert.equal(b.data.sourceObservationEvents.length,count);assert.equal(b.data.sources.length,0);
});
test('pending same basis never reevaluates by polling time and its concrete decision stays open',t=>{
  const {a,job}=fixture(t);const s=source({principalScope:null});a.data.agentActions.push(action());
  const x=observations.observe(a,s,opts);for(let i=0;i<4;i++)observations.observe(a,{...s,lastCheckedAt:String(i)},opts);
  assert.equal(a.data.sourceObservations.length,1);assert.equal(a.data.sourceObservationEvents.length,1);assert.equal(x.state,'pending');assert.equal(a.data.decisions.length,1);assert.match(a.data.decisions[0].context,/账号/);assert.equal(job.failures,4);
});
test('same content at another resource/account is independent input; legacy verified readback proves own output',t=>{
  const {a}=fixture(t);a.data.agentActions.push(action({effectStatus:undefined}));
  assert.equal(observations.observe(a,source(),opts).state,'resolved_observation');
  assert.equal(observations.observe(a,source({resourceKey:url+'Other'}),opts).state,'resolved_input');
  assert.equal(observations.observe(a,source({principalScope:'other-account'}),opts).state,'resolved_input');
  a.data.agentActions[0].result.verified=false;
  assert.equal(observations.observe(a,source(),opts).state,'pending','a legacy done label and unverified hash are not proof');
});
test('same-content new revision and out-of-order old revision do not change accepted work; real change has separate conflict',t=>{
  const {a,job}=fixture(t);a.data.agentActions.push(action());const before=structuredClone(job);
  assert.equal(observations.observe(a,source({remoteRevision:'3'}),opts).state,'resolved_observation');
  assert.equal(observations.observe(a,source({remoteRevision:'1',content:'old'}),opts).observation.historical,true);
  const conflict=observations.observe(a,source({remoteRevision:'4',content:'human edit'}),opts);
  assert.equal(conflict.state,'resolved_conflict');assert.equal(a.data.agentActions[0].deliveryConflict.observationId,conflict.observationId);assert.deepEqual(job,before);assert.equal(a.data.sources.length,0);
});
test('multiple exact candidate actions remain pending and never select a guessed actionId',t=>{
  const {a}=fixture(t);a.data.agentActions.push(action(),action({id:'second'}));const x=observations.observe(a,source(),opts);
  assert.equal(x.state,'pending');assert.deepEqual(x.observation.candidateActionIds,['action','second']);
});
test('explicit user reuse is input; resolved_input replay reuses existing watcher source with another id',t=>{
  const {a,job}=fixture(t);a.data.agentActions.push(action());const x=observations.observe(a,source(),{...opts,explicitInput:true,eventId:'user-purpose'});
  assert.equal(x.allowInput,true);a.data.sources.push({...source(),id:'watcher-source',observationId:x.observationId});job.sourceIds.push('watcher-source');
  observations.reclassify(a);observations.reclassify(a);assert.equal(a.data.sources.length,1);assert.deepEqual(job.sourceIds,['watcher-source']);
});
test('deletion closes only classification and survives late outcome; unknown action obligation remains',t=>{
  const {a}=fixture(t);a.data.agentActions.push(action({status:'uncertain',effectStatus:undefined}));const x=observations.observe(a,source(),opts);
  observations.close(a,{observationId:x.observationId},'user deleted',{deleteContent:true});assert.equal(a.data.decisions[0].status,'closed');assert.equal(a.data.agentActions[0].status,'uncertain');
  a.data.agentActions[0]=action();observations.reclassify(a);assert.equal(a.data.sourceObservations[0].state,'closed');assert.equal(a.data.sources.length,0);
});
test('observation event survives projection failure and replays without repeating input',t=>{
  const f=fixture(t);f.a.data.agentActions.push(action());f.a.save();const before=structuredClone(f.a.data);
  const x=observations.observe(f.a,source(),opts);f.a.data=before;observations.reclassify(f.a);assert.equal(f.a.data.sourceObservations[0].observationId,x.observationId);assert.equal(f.a.data.sourceObservations[0].state,'resolved_observation');
  const log=require('../desktop/work-journal.cjs').read(f.a);assert.equal(log.events.filter(e=>e.type==='source_observation').length,1);
});
test('project ingest cannot promote delivery readback or pending sources; explicit note still reopens',t=>{
  const {a,job,project}=fixture(t);a.data.agentActions.push(action());a.data.sources.push({...source(),id:'delivery',purpose:'delivery_readback',deliveryActionId:'action'});
  projects.ingest(a,project);assert.equal(job.status,'watching');assert.deepEqual(job.sourceIds,[]);assert.equal(job.feedback.length,0);
  projects.ingest(a,project,{note:'Please revise this output'});assert.equal(job.status,'ready');assert.equal(job.feedback.length,1);
});
test('connector saves observation before its cursor without ingesting own output or blocking on unknown action',t=>{
  const {a,job}=fixture(t),c={id:'connector',name:'Fixture',kind:'document',target:url,projectId:'project',principalScope:'account'};a.data.connectors.push(c);
  // Lark now requires a request receipt even for direct commit callers. Keep the generic
  // observation-ordering assertions below on the unchanged JSON connector path.
  assert.throws(()=>connectors.commit(a,c,[],{}),{code:'CONTEXT_VERSION_CHANGED'});c.provider='json';
  a.data.agentActions.push(action({status:'uncertain',effectStatus:undefined,result:undefined}));
  assert.equal(connectors.commit(a,c,[{remoteId:url,content:'complete output',remoteRevision:'2'}],{through:'cursor'}),0);
  assert.equal(c.cursor.through,'cursor');assert.equal(a.data.sources.length,0);assert.equal(a.data.sourceObservations[0].state,'pending');assert.equal(job.status,'watching');
  a.data.agentActions[0]=action();observations.reclassify(a);assert.equal(connectors.commit(a,c,[{remoteId:url,content:'complete output',remoteRevision:'2'}],{through:'cursor2'}),0);assert.equal(a.data.sources.length,0);assert.equal(job.failures,4);
});
test('directory observes named output, captures actual human modification and closes removed pending',async t=>{
  const {a,job}=fixture(t),folder={id:'folder',path:path.join(a.dir,'input'),projectId:'project',name:'Input',enabled:true};fs.mkdirSync(folder.path);a.data.folders.push(folder);
  const target=path.join(folder.path,'delivery.md');fs.writeFileSync(target,'complete output');a.data.agentActions.push(action({tool:'write_file',target,larkOpenId:undefined,result:{path:target,hash:hash('complete output'),verified:true}}));
  const folders=require('../desktop/folders.cjs');await folders.syncAllFolders(a);assert.equal(a.data.sources.length,0);assert.equal(a.data.sourceObservations[0].state,'resolved_observation');assert.equal(job.status,'watching');
  fs.writeFileSync(target,'human changed output');await folders.syncAllFolders(a);assert.equal(a.data.sourceObservations.at(-1).state,'resolved_conflict');assert.equal(a.data.sources.length,0);
  fs.unlinkSync(target);await folders.syncAllFolders(a);assert.equal(a.data.sourceObservations.at(-1).state,'closed');
});
test('GitHub verified schema recognizes own update/comment and preserves new human replies',t=>{
  const {a,job}=fixture(t);job.githubRepo='owner/repo';const target='https://github.com/owner/repo/issues/1';
  const snapshot={number:1,url:target,title:'Issue',body:'old',bodyHash:hash('old'),state:'open',comments:[],commentFingerprints:[],coverage:'complete'};
  a.data.sources.push({id:'prior',agentJobId:job.id,projectId:'project',resourceKey:target,content:JSON.stringify(snapshot)});
  a.data.agentActions.push({id:'write',jobId:job.id,tool:'github_update',target:'owner/repo',number:1,status:'done',result:{number:1,url:target,title:'Issue',body:'new',state:'open',verified:true}});
  const observe=value=>observations.observe(a,source({resourceKey:target,principalScope:null,remoteRevision:hash(JSON.stringify(value)),content:JSON.stringify(value)}),opts);
  const updated={...snapshot,body:'new',bodyHash:hash('new')};assert.equal(observe(updated).state,'resolved_observation');
  a.data.agentActions.push({id:'comment',jobId:job.id,tool:'github_comment',target:'owner/repo',number:1,status:'done',result:{url:target+'#issuecomment-2',commentId:2,body:'own comment',verified:true}});
  const own={...updated,commentFingerprints:[{id:2,author:'bot',contentHash:hash('own comment')}]};assert.equal(observe(own).state,'resolved_observation');
  const human={...own,commentFingerprints:[...own.commentFingerprints,{id:3,author:'human',contentHash:hash('reply')}]};assert.equal(observe(human).state,'resolved_input');assert.equal(job.status,'watching');
});
test('unacknowledged create has no target URL yet: observation waits until receipt identifies the resource',t=>{
  const {a}=fixture(t);a.data.agentActions.push(action({tool:'lark_create',target:'https://tenant.larkoffice.com/drive/folder/fixture',status:'uncertain',effectStatus:undefined,result:undefined}));
  const x=observations.observe(a,source(),opts);assert.equal(x.state,'pending');assert.equal(a.data.sources.length,0);
  a.data.agentActions[0]=action({tool:'lark_create'});observations.reclassify(a);assert.equal(a.data.sourceObservations[0].state,'resolved_observation');
});
test('user purpose resolution without remote revision preserves observation identity and commits one input',t=>{
  const {a,job}=fixture(t);const x=observations.observe(a,source({remoteRevision:null}),{...opts,trustedInput:false});assert.equal(x.state,'pending');
  observations.resolve(a,x.observationId,{purpose:'input',eventId:'purpose-event'});assert.equal(a.data.sourceObservations.length,1);assert.equal(a.data.sourceObservations[0].state,'resolved_input');assert.equal(a.data.sources.length,1);assert.equal(job.feedback.length,1);
  observations.reclassify(a);assert.equal(a.data.sources.length,1);assert.equal(job.feedback.length,1);
});
test('explicit attach of own delivery creates new input provenance without changing original delivery',async t=>{
  const {a,job,project}=fixture(t);a.data.agentActions.push(action());a.data.sources.push({...source(),id:'delivery',purpose:'delivery_readback',deliveryActionId:'action'});
  await projects.dispatch(a,'projectAttach',{id:project.id,sourceIds:['delivery']});
  assert.equal(a.data.sources.length,2);assert.equal(a.data.sources[0].purpose,'input');assert.equal(a.data.sources[0].deliveryActionId,undefined);assert.equal(a.data.sources[1].purpose,'delivery_readback');assert.equal(job.sourceIds.length,1);assert.equal(job.status,'ready');
});
test('later outcome for another resource releases real input exactly once across restart',t=>{
  const f=fixture(t),{a,job}=f;a.data.agentActions.push(action({tool:'lark_create',target:'https://tenant.larkoffice.com/drive/folder/fixture',status:'uncertain',effectStatus:undefined,result:undefined}));
  observations.observe(a,source(),opts);a.data.agentActions[0]=action({target:url+'Other',result:{url:url+'Other',readbackHash:hash('complete output'),revision:'2',verified:true}});
  observations.reclassify(a,{actionId:'action'});assert.equal(a.data.sourceObservations[0].state,'resolved_input');assert.equal(a.data.sources.length,1);assert.equal(job.feedback.length,1);a.save();
  const b=f.restart();observations.reclassify(b);assert.equal(b.data.sources.length,1);assert.equal(b.data.delegations[0].feedback.length,1);
});
test('linking a reused material and observing another channel preserve the resolution event identity',t=>{
  const {a}=fixture(t),x=observations.observe(a,source(),opts);const saved={...source(),id:'actual-existing'};a.data.sources.push(saved);
  observations.link(a,saved,x);const next=observations.observe(a,source(),{...opts,channel:'connector'});
  assert.equal(next.sourceId,saved.id);assert.equal(next.resolutionEventId,x.resolutionEventId);observations.reclassify(a);assert.equal(a.data.sources.length,1);
});
test('user observation-only choice survives repeated polls and later local reclassification',t=>{
  const {a}=fixture(t),s=source(),x=observations.observe(a,s,{...opts,trustedInput:false});assert.equal(x.state,'pending');
  observations.resolve(a,x.observationId,{purpose:'observation',eventId:'user-choice'});const count=a.data.sourceObservationEvents.length;
  observations.reclassify(a);assert.equal(observations.observe(a,s,{...opts,trustedInput:false}).state,'resolved_observation');assert.equal(a.data.sourceObservationEvents.length,count);assert.equal(a.data.sources.length,0);assert.equal(a.data.decisions[0].status,'resolved');
});
test('source classification card offers local choices without hiding acceptance or blocking feedback',async t=>{
  const {a,job}=fixture(t),decisions=require('../desktop/decisions.cjs');job.status='review';
  observations.observe(a,source(),{...opts,trustedInput:false});
  const cards=decisions.cards(a.data),card=cards.find(c=>c.kind==='source_classification');
  assert.deepEqual(card.choices,['input','observation','ignore']);assert.equal(card.blocking,false);assert.ok(cards.some(c=>c.kind==='review'));
  decisions.feedback(a,job,'synthetic unrelated answer',[]);assert.equal(job.status,'ready');
  const before=structuredClone(job),input={id:card.id,revision:card.revision,purpose:'observation'};
  await decisions.dispatch(a,'decisionSourceClassify',input);await decisions.dispatch(a,'decisionSourceClassify',input);
  assert.deepEqual(job,before);assert.equal(a.data.sources.length,0);assert.equal(a.data.decisions[0].status,'resolved');
});
test('ignore handles unknown original write and stale classification choices cannot admit content',async t=>{
  const {a,job}=fixture(t),decisions=require('../desktop/decisions.cjs');a.data.agentActions.push(action({status:'uncertain',effectStatus:undefined,result:undefined}));
  observations.observe(a,source(),opts);const card=decisions.cards(a.data).find(c=>c.kind==='source_classification'),before=structuredClone(job);
  await assert.rejects(decisions.dispatch(a,'decisionSourceClassify',{id:card.id,revision:'stale',purpose:'input'}),/依据已变化/);
  const input={id:card.id,revision:card.revision,purpose:'ignore'};await decisions.dispatch(a,'decisionSourceClassify',input);await decisions.dispatch(a,'decisionSourceClassify',input);
  assert.equal(a.data.agentActions[0].status,'uncertain');assert.equal(a.data.sourceObservations[0].state,'closed');assert.deepEqual(job,before);assert.equal(a.data.sources.length,0);
});
test('explicit input choice persists during unknown write and its outcome admits input exactly once',async t=>{
  const f=fixture(t),{a,job}=f,decisions=require('../desktop/decisions.cjs');a.data.agentActions.push(action({status:'uncertain',effectStatus:undefined,result:undefined}));
  observations.observe(a,source(),opts);const card=decisions.cards(a.data).find(c=>c.kind==='source_classification'),before=structuredClone(job);
  await decisions.dispatch(a,'decisionSourceClassify',{id:card.id,revision:card.revision,purpose:'input'});
  assert.deepEqual(job,before);assert.equal(a.data.sources.length,1);assert.equal(a.data.sourceObservations[0].userPurpose,'input');assert.equal(a.data.agentActions[0].status,'uncertain');
  const b=f.restart();b.data.agentActions[0]=action();observations.reclassify(b,{actionId:'action'});observations.reclassify(b,{actionId:'action'});
  assert.equal(b.data.delegations[0].feedback.length,1);assert.equal(b.data.sources.length,1);assert.equal(b.data.delegations[0].sourceIds.length,1);
});
test('project without delegation still presents a concrete classification card',async t=>{
  const {a}=fixture(t),decisions=require('../desktop/decisions.cjs');a.data.delegations=[];delete a.data.projects[0].jobId;
  observations.observe(a,source({agentJobId:null}),{channel:'folder',trustedInput:false,scope:{projectId:'project'}});
  const card=decisions.cards(a.data).find(c=>c.kind==='source_classification');assert.equal(card.jobTitle,'Fixture');assert.equal(card.jobId,null);
  await decisions.dispatch(a,'decisionSourceClassify',{id:card.id,revision:card.revision,purpose:'observation'});assert.equal(a.data.decisions[0].status,'resolved');
});
test('watcher link can reuse its explicitly bound standalone material but rejects another job owner',t=>{
  const {a,job}=fixture(t);job.projectId=null;const saved={...source({projectId:null,agentJobId:null}),id:'imported'};a.data.sources.push(saved);job.sourceIds.push(saved.id);
  const checked=observations.observe(a,source({projectId:null}),{channel:'agent_watch',trustedInput:true,scope:{jobId:job.id}});
  observations.link(a,saved,checked);assert.equal(checked.observation.sourceId,'imported');saved.agentJobId='foreign';assert.throws(()=>observations.link(a,saved,checked),/其他委托/);
});
test('repeated remote revision still records A-B-A content transition once',t=>{
  const {a,job}=fixture(t);let prior;
  for(const content of ['A','B','A','A']){
    const checked=observations.observe(a,source({content}),{...opts,eventId:observations.transitionEvent(a,prior,prior?.content!==content)});
    prior=observations.attach(a,source({content}),checked);projects.ingest(a,a.data.projects[0]);
  }
  assert.equal(a.data.sources.length,3);assert.equal(prior.version,3);assert.equal(job.feedback.length,3);
});
test('not-applied durable fact triggers local pending reclassification and replay does not duplicate input',t=>{
  const {a,job}=fixture(t),facts=require('../desktop/action-facts.cjs'),r=action({status:'uncertain',effectStatus:undefined,result:undefined});a.data.agentActions.push(r);
  observations.observe(a,source(),opts);facts.notApplied(a,r);
  assert.equal(r.effectStatus,'not_applied');assert.equal(a.data.sourceObservations[0].state,'resolved_input');assert.equal(job.feedback.length,1);
  facts.replay(a);assert.equal(a.actionFactsError,undefined);assert.equal(job.feedback.length,1);assert.equal(a.data.sources.length,1);
});
test('explicit folder removal durably revokes folder read while retaining snapshots across workspace rollback',async t=>{
  const {a,job}=fixture(t),policy=require('../desktop/access-policy-store.cjs'),folders=require('../desktop/folders.cjs');
  a.file=path.join(a.dir,'workspace.json');a.data.version=1;a.data.settings={automatic:false};a.data.providers=[];a.data.artifacts=[];a.data.events=[];
  const folder={id:'folder',name:'Synthetic folder',path:path.join(a.dir,'input'),projectId:'project',enabled:true};a.data.folders.push(folder);job.folderIds=[folder.id];
  const saved={...source({resourceKey:path.join(folder.path,'input.txt'),principalScope:'local'}),id:'snapshot'};a.data.sources.push(saved);job.sourceIds.push(saved.id);a.save();
  assert.equal(policy.initialize(a).status,'complete');assert.equal(policy.checkTool(a,job,'read_file',{folderId:folder.id}).allowed,true);
  const original=structuredClone(a.data);observations.observe(a,{...saved,id:undefined},{...opts,trustedInput:false});
  await folders.dispatch(a,'folderRemove',{id:folder.id});assert.equal(a.data.sourceObservations[0].state,'closed');assert.equal(a.data.sources[0].content,'complete output');
  a.data=original;policy.reconcile(a);
  assert.equal(policy.checkTool(a,a.data.delegations[0],'read_file',{folderId:folder.id}).allowed,false);
  assert.equal(policy.check(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:snapshot',jobId:job.id},operation:'local_retention'}).allowed,true);
});
test('resolved standalone input joins the existing job once and does not unpause it',t=>{
  const {a,job}=fixture(t);job.projectId=null;job.status='paused';
  const checked=observations.observe(a,source({projectId:null}),{channel:'agent_watch',trustedInput:false,scope:{jobId:job.id}});
  observations.resolve(a,checked.observationId,{purpose:'input',eventId:'standalone-choice'});observations.reclassify(a);
  assert.equal(job.status,'paused');assert.equal(job.sourceIds.length,1);assert.equal(job.feedback.length,1);assert.equal(a.data.sources.length,1);
});
test('explicit input classification copies a saved delivery without relabeling its readback',t=>{
  const {a,job}=fixture(t),delivery={...source(),id:'readback',purpose:'delivery_readback',deliveryActionId:'action'};
  a.data.sources.push(delivery);job.sourceIds.push(delivery.id);a.data.agentActions.push(action({status:'uncertain',effectStatus:undefined,result:undefined}));
  const checked=observations.observe(a,delivery,opts);assert.equal(checked.state,'pending');observations.resolve(a,checked.observationId,{purpose:'input',eventId:'readback-choice'});
  a.data.agentActions[0]=action();observations.reclassify(a);observations.reclassify(a);
  assert.equal(delivery.purpose,'delivery_readback');assert.equal(a.data.sources.length,2);assert.equal(a.data.sources[0].purpose,'input');assert.equal(a.data.sources[0].deliveryActionId,undefined);assert.equal(job.feedback.length,1);
});
test('ordinary source transaction rollback cannot be bypassed by observation replay',t=>{
  const f=fixture(t),{a}=f;observations.observe(a,source(),opts);a.save();const b=f.restart();
  observations.reclassify(b);assert.equal(b.data.sources.length,0);assert.equal(b.data.delegations[0].sourceIds.length,0);
  const checked=observations.observe(b,source(),opts);observations.attach(b,source(),checked);projects.ingest(b,b.data.projects[0]);observations.reclassify(b);
  assert.equal(b.data.sources.length,1);assert.equal(b.data.delegations[0].feedback.length,1);
});
test('standalone observations never chain onto another unassigned project job source',t=>{
  const {a,job}=fixture(t);job.projectId=null;
  const foreign={...source({projectId:null,agentJobId:'other-job',content:'foreign'}),id:'foreign',version:4};a.data.sources.push(foreign);
  const input=source({projectId:null}),checked=observations.observe(a,input,{channel:'watch',trustedInput:true,scope:{jobId:job.id}}),saved=observations.attach(a,input,checked);
  assert.equal(saved.previousSourceId,undefined);assert.equal(saved.version,1);
});
test('explicit input deferred behind another resource write is admitted on that later outcome',t=>{
  const {a,job}=fixture(t),r=action({id:'other',target:url+'Other',status:'uncertain',effectStatus:undefined,result:undefined});a.data.agentActions.push(action(),r);
  const checked=observations.observe(a,source({content:'changed'}),opts);observations.resolve(a,checked.observationId,{purpose:'input',eventId:'explicit-deferred'});assert.equal(job.feedback.length,0);
  require('../desktop/action-facts.cjs').notApplied(a,r);assert.equal(job.feedback.length,1);observations.reclassify(a);assert.equal(job.feedback.length,1);
});
test('own-output watcher retains explicit task subscriptions without admitting business input',t=>{
  const {a,job}=fixture(t),agent=require('../desktop/agent.cjs'),target='https://github.com/owner/repo/issues/1';
  const snapshot={number:1,title:'Own issue',body:'Own body',state:'open',url:target,revision:'r1',coverage:'complete',bodyHash:hash('Own body'),comments:[],commentFingerprints:[],bodyTruncated:false,commentsTruncated:false};
  for(const id of ['first','second']){a.data.tasks.push({id,agentJobId:job.id,projectId:'project',status:'todo',sourceIds:[]});job.taskIds.push(id);}
  a.data.agentActions.push({id:'own-create',jobId:job.id,taskId:'first',tool:'github_create',target:'owner/repo',status:'done',result:{number:1,title:snapshot.title,body:snapshot.body,state:snapshot.state,url:target,verified:true}});
  const before=structuredClone(job);
  for(const taskId of ['first','second','second'])assert.equal(agent.watch(a,job,'github_read',{number:1,taskId},snapshot,false).businessChanged,false);
  assert.equal(job.watchers.length,1);assert.deepEqual(job.watchers[0].taskIds,['first','second']);assert.equal(job.watchers[0].sourceId,null);assert.equal(a.data.sources.length,0);assert.deepEqual(job.sourceIds,before.sourceIds);assert.equal(job.status,before.status);assert.equal(job.failures,before.failures);
  assert.ok(a.data.tasks.every(t=>t.sourceIds.length===0&&!t.needsReplan));
});
test('explicit classification after acceptance reopens one revision and preserves both acceptances across replay',async t=>{
  const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),acceptance=require('../desktop/acceptance.cjs');
  const journal=require('../desktop/work-journal.cjs'),recovery=require('../desktop/recovery.cjs');
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-consumption-revision-')));
  let externalCalls=0;const forbidden=async()=>{externalCalls++;throw Error('Unexpected external boundary');};
  const a=new Assistant({dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,officeRequest:forbidden,webRequest:forbidden,feedRequest:forbidden});
  t.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);a.streamController?.dispose();fs.rmSync(dir,{recursive:true,force:true});assert.equal(externalCalls,0);});
  await a.dispatch('saveProvider',{name:'Offline fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
  let job=agent.buildJob(a,{goal:'Review synthetic delivery',allowWeb:false,autoAccept:false});a.data.delegations.push(job);
  let task=a.createTask({title:'Synthetic task',criteria:'Complete synthetic content',steps:[{title:'Draft',kind:'draft'}]});
  Object.assign(task,{agentJobId:job.id,workRevision:1,dependsOn:[]});job.taskIds.push(task.id);
  const artifact={id:'draft',taskId:task.id,stepId:task.steps[0].id,title:'Draft',content:'Synthetic delivered body'};
  Object.assign(task.steps[0],{key:'draft',done:true,artifactId:artifact.id});a.data.artifacts.push(artifact);
  require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task,job});
  const accept=()=>{
    delete task.needsReplan;task.status='review';job.status='review';
    task.verification={passed:true,summary:'Synthetic check',gaps:[],basis:acceptance.basis(a,task)};
    acceptance.recordCompletionCheck(a,job,{passed:true,summary:'Synthetic overall check',gaps:[]},{basis:acceptance.completionBasis(a,job)});
    acceptance.acceptOne(a,{id:task.id});
  };
  accept();const history=structuredClone(task.acceptanceHistory),beforeInput=structuredClone(a.data);
  const pending=observations.observe(a,source({projectId:null,agentJobId:job.id,content:'Explicit new input'}),{channel:'fixture',trustedInput:false,scope:{jobId:job.id,taskId:task.id}});
  const resolve=()=>observations.resolve(a,pending.observationId,{purpose:'input',eventId:'explicit-after-acceptance'});
  resolve();assert.equal(task.workRevision,2);assert.equal(job.workRevision,2);assert.equal(task.status,'todo');assert.equal(job.status,'ready');
  assert.deepEqual(task.acceptanceHistory,history);assert.equal(task.acceptedAt,undefined);assert.equal(task.acceptedRevision,undefined);
  const reopens=journal.read(a).events.filter(e=>e.type==='reopened');
  assert.equal(reopens.length,2);assert.ok(reopens.every(e=>e.actor==='source'&&e.workRevision===2));
  assert.ok(a.data.sourceObservations[0].inputConsumption.afterWorkSequence>=reopens.at(-1).sequence);
  const sequence=journal.read(a).events.length;resolve();observations.reclassify(a);
  assert.equal(journal.read(a).events.length,sequence);assert.equal(task.workRevision,2);assert.equal(job.workRevision,2);
  const restore=()=>{a.data=structuredClone(beforeInput);recovery.reconcileAuthorities(a,a.data);job=a.data.delegations[0];task=a.data.tasks[0];};
  restore();assert.equal(task.status,'todo');assert.equal(job.status,'ready');assert.equal(task.workRevision,2);assert.equal(job.workRevision,2);
  assert.deepEqual(task.acceptanceHistory,history);assert.deepEqual(task.sourceIds,[pending.sourceId]);
  accept();assert.deepEqual(task.acceptanceHistory.map(h=>h.workRevision),[1,2]);
  const finalSequence=journal.read(a).events.length;restore();observations.reclassify(a);
  assert.equal(task.status,'completed');assert.equal(job.status,'completed');assert.equal(task.workRevision,2);assert.equal(job.workRevision,2);
  assert.deepEqual(task.acceptanceHistory.map(h=>h.workRevision),[1,2]);assert.equal(task.acceptanceHistory[0].eventId,history[0].eventId);
  assert.equal(journal.read(a).events.length,finalSequence);assert.equal(journal.read(a).events.filter(e=>e.type==='reopened').length,2);
});
