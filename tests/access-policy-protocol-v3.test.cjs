'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const policy=require('../desktop/access-policy-store.cjs');
const recovery=require('../desktop/recovery.cjs');
const clone=structuredClone;
const URL='https://example.larkoffice.com/docx/TestDocument';
function fixture(t,{empty=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'policy-v3-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const job={id:'job',status:'ready',sourceIds:['s'],taskIds:['task'],allowWeb:true,folderIds:['f'],fileMode:'auto',outputFolder:path.join(dir,'output'),capabilityGrants:[{id:'cap',revision:'r1'}],dataPlatform:'sg-readonly',platformPrincipal:'fixture-user'};
 const task={id:'task',agentJobId:'job',status:'review',sourceIds:['s'],steps:[]};
 const a={dir,file:path.join(dir,'workspace.json'),data:{version:1,settings:{automatic:true},providers:[],tasks:empty?[]:[task],sources:empty?[]:[{id:'s',content:'synthetic text'}],artifacts:[],events:[],delegations:empty?[]:[job],folders:[{id:'f',path:path.join(dir,'input')}],capabilities:[{id:'cap',revision:'r1',enabled:true,allowedTools:['read_document','sql_review'],updateMode:'local'}],agentActions:[],runtime:{}}};
 a.save=()=>{fs.writeFileSync(a.file,JSON.stringify(a.data));};a.save();return {a,job,task};
}
const options=(command='test_grant')=>({trusted:true,actor:'user_command',command});
function web(jobId='job'){return {principalScope:policy.PUBLIC,resourceScope:{kind:'web',key:'public',jobId},operations:['read_url','search_web']};}
function request(spec,operation=spec.operations[0]){return {...spec,operation};}
function boot(a){assert.equal(policy.initialize(a).status,'complete');}
function faultRename(match,fn){const old=fs.renameSync;fs.renameSync=function(from,to){if(match(to))throw Error('injected rename failure');return old.apply(this,arguments);};try{return fn();}finally{fs.renameSync=old;}}
test('baseline pins full current bytes and preserves normal web/folder/capability/platform/local/model scopes',t=>{
 const {a,job,task}=fixture(t),original=fs.readFileSync(a.file);boot(a);
 assert.equal(policy.inventory(a).workspaceHash,policy.hash(original));assert.deepEqual(fs.readFileSync(policy.locations(a).original),original);
 for(const [tool,args,opts] of [['read_url',{url:'https://example.invalid'},{}],['list_files',{folderId:'f'},{}],['read_file',{folderId:'f'},{}],['capability_call',{capabilityId:'cap',tool:'sql_review'},{}],['platform_query',{},{}],['write_file',{},{}],['model',{},{}],['read_source',{sourceId:'s'},{taskId:task.id}]])assert.equal(policy.checkTool(a,job,tool,args,opts).allowed,true,tool);
 assert.equal(policy.checkTool(a,job,'arbitrary_shell',{}).allowed,false);
 assert.equal(policy.checkTool(a,{...job,id:'foreign'},'read_source',{sourceId:'s'}).allowed,false);
 assert.equal(policy.checkTool(a,job,'capability_call',{capabilityId:'cap',tool:'exec'}).allowed,false);
 a.data.capabilities[0].revision='r2';assert.equal(policy.checkTool(a,job,'capability_call',{capabilityId:'cap',tool:'sql_review'}).allowed,false);
});
test('old Lark readback obtains account only from unique matching successful original action and same job create grant',t=>{
 const {a,job}=fixture(t);job.documentGrants=[{target:URL,approvedAt:'fixture'}];job.larkCreateGrant={target:'personal',openId:'u1'};
 a.data.agentActions=[{id:'effect',jobId:job.id,status:'done',verified:true,larkOpenId:'u1',result:{url:URL}}];a.save();boot(a);
 assert.equal(policy.checkTool(a,job,'read_lark_document',{url:URL},{principalScope:{kind:'account',provider:'lark',subject:'u1'}}).allowed,true);
 assert.equal(policy.checkTool(a,job,'read_lark_document',{url:URL},{principalScope:{kind:'account',provider:'lark',subject:'u2'}}).allowed,false);
 const data=clone(a.data);data.agentActions.push({...data.agentActions[0],id:'other',larkOpenId:'u2'});
 assert.equal(policy.collectLegacy(data).find(r=>r.resourceScope?.kind==='document').decision,'unknown');
 data.agentActions=[];assert.equal(policy.collectLegacy(data).find(r=>r.resourceScope?.kind==='document').decision,'unknown');
});
test('grant/revoke validate actor, principal, tenant, operation and current revision; clocks cannot reorder them',t=>{
 const {a}=fixture(t);boot(a);const spec=web(),first=policy.check(a,request(spec));
 assert.throws(()=>policy.grant(a,spec,{actor:'model',trusted:true}),e=>e.code==='ACCESS_POLICY_UNTRUSTED');
 const receipt=policy.revoke(a,spec,{...options(),expectedRevision:first.grantRevision,commitId:'revoke'});
 assert.equal(receipt.committed,true);assert.equal(policy.check(a,request(spec)).decision,'revoked');
 assert.throws(()=>policy.grant(a,spec,{...options(),expectedRevision:first.grantRevision}),e=>e.code==='ACCESS_POLICY_CONFLICT');
 a.data.delegations[0].allowWeb=true;assert.equal(policy.check(a,request(spec)).allowed,false);
 policy.grant(a,spec,{...options(),expectedRevision:receipt.grantRevision,commitId:'grant'});
 assert.equal(policy.check(a,request(spec)).allowed,true);
 assert.equal(policy.grant(a,spec,{...options(),commitId:'grant'}).sequence,receipt.sequence+1);
 assert.equal(policy.check(a,request(spec,'ungranted_operation')).allowed,false);
});
test('task withdrawal blocks broad scope and later explicit narrow grant restores only that task',t=>{
 const {a}=fixture(t);boot(a);const one={...web(),resourceScope:{...web().resourceScope,taskId:'task'}};
 policy.revoke(a,one,options());assert.equal(policy.check(a,request(one)).allowed,false);assert.equal(policy.check(a,request(web())).allowed,true);
 policy.revoke(a,web(),options());policy.grant(a,one,options());
 assert.equal(policy.check(a,request(one)).allowed,true);assert.equal(policy.check(a,request(web())).allowed,false);
});
test('pending migration resumes from pinned original, never a changed workspace or backup',t=>{
 const {a}=fixture(t);const files=policy.locations(a),original=fs.readFileSync(a.file);
 const interrupted=faultRename(to=>to===files.store,()=>policy.initialize(a));assert.equal(interrupted.status,'unknown');
 assert.equal(JSON.parse(fs.readFileSync(files.migration)).payload.authorizationMigration,'pending');
 a.data.delegations[0].allowWeb=false;a.save();boot(a);assert.equal(policy.check(a,request(web())).allowed,true);assert.equal(policy.inventory(a).workspaceHash,policy.hash(original));
});
test('pending migration with no matching original remains unknown',t=>{
 const {a}=fixture(t),files=policy.locations(a);faultRename(to=>to===files.store,()=>policy.initialize(a));
 fs.unlinkSync(files.original);a.data.delegations[0].allowWeb=false;a.save();
 assert.equal(policy.initialize(a).reason,'pinned_workspace_missing');assert.equal(fs.existsSync(files.store),false);
});
test('complete then missing or corrupt store never imports backup authorization; explicit regrant restores one scope',t=>{
 for(const damage of ['missing','corrupt']){
  const {a}=fixture(t);boot(a);policy.revoke(a,web(),options());a.save();
  if(damage==='missing')fs.unlinkSync(policy.locations(a).store);else fs.writeFileSync(policy.locations(a).store,'broken');
  a.data.delegations[0].allowWeb=true;
  assert.equal(policy.initialize(a).status,'unknown');assert.equal(policy.check(a,request(web())).decision,'unknown');
  policy.grant(a,{...web(),operations:['read_url']},options('reauthorize_web'));
  assert.equal(policy.check(a,request(web(),'read_url')).allowed,true);assert.equal(policy.check(a,request(web(),'search_web')).allowed,false);
  assert.equal(policy.checkTool(a,a.data.delegations[0],'read_source',{sourceId:'s'}).allowed,false);
 }
});
test('automatic backup recovery cannot initialize missing authority from recovered contents',t=>{
 const {a}=fixture(t);a.recoveryFromBackup=true;assert.equal(policy.initialize(a).status,'unknown');assert.equal(fs.existsSync(policy.locations(a).store),false);
});
test('checksum-valid fork is still rejected and stat cache notices atomic replacement',t=>{
 const {a}=fixture(t);boot(a);assert.equal(policy.check(a,request(web())).allowed,true);
 const file=policy.locations(a).store,value=JSON.parse(fs.readFileSync(file));value.payload.events[1].sequence=1;value.checksum=policy.hash(value.payload);
 const replacement=file+'.replacement';fs.writeFileSync(replacement,JSON.stringify(value));fs.renameSync(replacement,file);
 assert.equal(policy.check(a,request(web())).allowed,false);
});
test('read cache is file-version scoped, not assistant scoped or a stale memory grant',t=>{
 const {a}=fixture(t);boot(a);policy.check(a,request(web()));
 const original=fs.readFileSync;let reads=0;fs.readFileSync=function(file,...args){if(file===policy.locations(a).store)reads++;return original.call(this,file,...args);};
 try{for(let i=0;i<100;i++)assert.equal(policy.check(a,request(web())).allowed,true);assert.equal(reads,0);}finally{fs.readFileSync=original;}
 const other={...a,data:clone(a.data)};policy.revoke(other,web(),options());assert.equal(policy.check(a,request(web())).allowed,false);
});
test('rename failure has no grant; projection failure preserves fsynced commit and pending receipt',t=>{
 const {a}=fixture(t);boot(a);const spec=web('new-job');
 assert.throws(()=>faultRename(to=>to===policy.locations(a).store,()=>policy.grant(a,spec,options())));assert.equal(policy.check(a,request(spec)).allowed,false);
 assert.throws(()=>policy.grant(a,spec,{...options(),project(){throw Error('projection failed');}}),e=>e.committed&&e.receipt.committed);
 assert.equal(policy.check(a,request(spec)).allowed,true);assert.ok(a.data.runtime.accessPolicyProjectionPending);
});
test('empty workspace supports explicit new job, selected capabilities, fresh source and artifact',t=>{
 const {a,job,task}=fixture(t,{empty:true});boot(a);a.data.delegations.push(job);a.data.tasks.push(task);
 policy.syncTrustedJob(a,job,options('agentCreate'));
 assert.equal(policy.checkTool(a,job,'model').allowed,true);assert.equal(policy.checkTool(a,job,'capability_call',{capabilityId:'cap',tool:'read_document'}).allowed,true);
 const source={id:'fresh',content:'new test'},artifact={id:'draft',taskId:task.id,content:'new draft'};a.data.sources.push(source);a.data.artifacts.push(artifact);job.sourceIds.push(source.id);task.sourceIds.push(source.id);
 policy.reconcile(a);assert.equal(source.accessPolicyQuarantined,false);
 policy.retainCreated(a,'source',source,{job,task,trusted:true,command:'fetch_completed'});
 policy.retainCreated(a,'artifact',artifact,{job,task,trusted:true,command:'draft_created'});
 assert.equal(source.accessPolicyQuarantined,false);assert.equal(artifact.accessPolicyQuarantined,false);
 assert.equal(policy.checkTool(a,job,'read_source',{sourceId:'fresh'},{taskId:task.id}).allowed,true);
 assert.equal(policy.checkTool(a,job,'read_artifact',{artifactId:'draft'}).allowed,true);
});
test('trusted delta changes only user permission difference, does not implicitly grant during save',t=>{
 const {a,job}=fixture(t);boot(a);const before=clone(a.data);job.allowWeb=false;
 policy.grantLegacyDelta(a,before,options('agentSettings'));assert.equal(policy.check(a,request(web())).allowed,false);
 const unchanged=clone(a.data);job.title='renamed';policy.grantLegacyDelta(a,unchanged,options('agentSettings'));
 assert.equal(policy.check(a,request(web())).allowed,false);
 const old=clone(job);job.allowWeb=true;policy.syncTrustedJob(a,job,{...options('explicit_web'),before:old});
 assert.equal(policy.check(a,request(web())).allowed,true);
});
test('retention is independent from remote permission, and neither creation nor regrant revives withdrawal',t=>{
 const {a,job,task}=fixture(t);boot(a);policy.revoke(a,web(),options());assert.equal(policy.checkTool(a,job,'read_source',{sourceId:'s'}).allowed,true);
 const spec={principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:s',jobId:job.id},operations:['local_retention']};policy.revoke(a,spec,options());
 assert.equal(policy.checkTool(a,job,'read_source',{sourceId:'s'}).allowed,false);
 assert.throws(()=>policy.retainCreated(a,'source',a.data.sources[0],{job,task,trusted:true}),e=>e.code==='ACCESS_POLICY_REVOKED');
 a.data.sources[0].deleted=true;policy.grant(a,spec,options());assert.equal(policy.check(a,request(spec)).allowed,false);
});
test('approved action grant is pinned to actor, action, task, target, version and content',t=>{
 const {a,job}=fixture(t);job.fileMode='ask';a.save();boot(a);const action={id:'write',taskId:'task',jobId:job.id,target:path.join(a.dir,'output','draft.md'),version:'v1',artifactId:'draft',content:'v1'};
 const req=policy.requestsForTool(a,job,'write_file',{}, {action,taskId:'task'})[0];policy.grant(a,{...req,operations:['write_file']},options('agentApprove'));
 assert.equal(policy.checkTool(a,job,'write_file',{}, {action,taskId:'task'}).allowed,true);
 assert.equal(policy.checkTool(a,job,'write_file',{}, {action:{...action,content:'v2'},taskId:'task'}).allowed,false);
 assert.equal(policy.checkTool(a,job,'write_file',{}, {action,taskId:'other'}).allowed,false);
});
test('legacy ledger merges monotonically, keeps orphans, and never overwrites an outcome with stale workspace',t=>{
 const {a}=fixture(t);a.lastBackupAt=Date.now();
 a.data.agentActions=[{id:'done',status:'done',effectStatus:'applied',result:{url:URL,sourceId:'s'}},{id:'orphan',status:'uncertain',taskId:'deleted'}];recovery.afterSave(a);
 a.data.agentActions=[{id:'done',status:'running'}];recovery.afterSave(a);
 const ledger=JSON.parse(fs.readFileSync(path.join(a.dir,'action-ledger.json')));assert.equal(ledger.find(r=>r.id==='done').status,'done');assert.equal(ledger[0].result.sourceId,'s');assert.ok(ledger.some(r=>r.id==='orphan'));
 assert.equal(fs.existsSync(path.join(a.dir,'action-facts.json')),false);
});
test('conflicting action facts remain historical observations instead of choosing a current outcome',()=>{
 const data={agentActions:[{id:'x',status:'done',effectStatus:'applied',target:'one'}]};
 recovery.mergeLedger(data,[{id:'x',status:'done',effectStatus:'not_applied',target:'two'}]);
 assert.equal(data.agentActions[0].status,'uncertain');assert.equal(data.agentActions[0].presentationStatus,'historical');assert.equal(data.agentActions[0].recoveryObservations.length,2);
});
test('maintenance pause preserves completed history and exposes orphan uncertain actions',t=>{
 const {a,job,task}=fixture(t);job.status='completed';job.summary='accepted';task.status='completed';task.acceptedAt='fixture';
 a.data.agentActions=[{id:'orphan',taskId:'deleted',jobId:job.id,status:'uncertain'}];recovery.pause(a.data);
 assert.equal(job.status,'completed');assert.equal(job.summary,'accepted');assert.equal(task.needsReplan,undefined);assert.equal(a.data.recoveryReviews[0].actionId,'orphan');assert.equal(job.pendingActionId,null);
});
test('restore uses journal acceptance/reopen order and current policy without network or model calls',t=>{
 const {a,job,task}=fixture(t);boot(a);const old=clone(a.data);const journal=require('../desktop/work-journal.cjs');
 journal.append(a,[{entityKind:'task',entityId:task.id,type:'accepted',actor:'user',workRevision:1,payload:{}},{entityKind:'job',entityId:job.id,type:'completed',actor:'user',workRevision:1,payload:{}}]);
 policy.revoke(a,web(),options());recovery.reconcileAuthorities(a,old);recovery.pause(old);
 assert.equal(old.tasks[0].status,'completed');assert.equal(old.delegations[0].status,'completed');assert.equal(old.delegations[0].allowWeb,false);
 journal.append(a,[{entityKind:'task',entityId:task.id,type:'reopened',actor:'user',workRevision:2,payload:{}}]);
 const restored=clone(old);recovery.reconcileAuthorities(a,restored);assert.equal(restored.tasks[0].status,'todo');assert.equal(restored.tasks[0].workRevision,2);assert.equal(restored.tasks[0].acceptanceHistory.length,1);
});
test('snapshot collection inherits new bodies without per-object events and rejects unbound sibling tasks',t=>{
 const {a,job,task}=fixture(t);boot(a);const sequence=policy.inventory(a).sequence;
 const source={id:'fresh-body',content:'fixture'};a.data.sources.push(source);job.sourceIds.push(source.id);task.sourceIds.push(source.id);
 const receipt=policy.retainCreated(a,'source',source,{job,task,trusted:true});assert.equal(receipt.inherited,true);assert.equal(policy.inventory(a).sequence,sequence);
 assert.equal(policy.checkTool(a,job,'read_source',{sourceId:source.id},{taskId:task.id}).allowed,true);
 a.data.tasks.push({id:'sibling',agentJobId:job.id,sourceIds:[],steps:[]});assert.equal(policy.checkTool(a,job,'read_source',{sourceId:source.id},{taskId:'sibling'}).allowed,false);
 const other={...job,id:'other',sourceIds:[],taskIds:[]};a.data.delegations.push(other);policy.syncTrustedJob(a,other,options('agentCreate'));
 assert.equal(policy.checkTool(a,other,'read_source',{sourceId:source.id}).allowed,false);
 policy.revoke(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+source.id,jobId:job.id},operations:['local_read']},options());
 assert.equal(policy.checkTool(a,job,'read_source',{sourceId:source.id},{taskId:task.id}).allowed,false);
});
test('standalone task collection is granted only by explicit creation delta',t=>{
 const {a}=fixture(t,{empty:true});boot(a);const before=clone(a.data),task={id:'manual',sourceIds:[],steps:[]};a.data.tasks.push(task);
 policy.grantLegacyDelta(a,before,options('createTask'));
 const artifact={id:'draft',taskId:'manual',content:'synthetic'};a.data.artifacts.push(artifact);
 assert.equal(policy.retainCreated(a,'artifact',artifact,{task,trusted:true}).inherited,true);
 assert.equal(policy.checkTool(a,null,'read_artifact',{artifactId:'draft'},{taskId:'manual'}).allowed,true);
});
test('Lark automatic projection preserves approval metadata and respects later revocation',t=>{
 const {a,job}=fixture(t);boot(a);const before=clone(job);
 job.larkCreateGrant={target:'personal',openId:'u1',userName:'Fixture User',approvedAt:'2026-01-01T00:00:00Z'};
 job.larkCreatePolicies=[{taskId:'task',target:'personal',openId:'u1',mode:'auto',allowUpdate:true,approvedAt:'2026-01-02T00:00:00Z'}];
 policy.syncTrustedJob(a,job,{...options('agentLarkCreatePolicy'),before});
 assert.equal(job.larkCreateGrant.userName,'Fixture User');assert.equal(job.larkCreatePolicies[0].approvedAt,'2026-01-02T00:00:00Z');assert.equal(require('../desktop/lark-create-policy.cjs').mode(job,'task'),'auto');
 const req=policy.requestsForTool(a,job,'lark_create',{}, {taskId:'task'})[0];policy.revoke(a,{...req,operations:['lark_create']},options());
 assert.equal(require('../desktop/lark-create-policy.cjs').mode(job,'task'),'ask');
});
test('complete sentinel and pinned migration prevent remigration when store and marker are both lost',t=>{
 const {a}=fixture(t);boot(a);policy.reconcile(a);a.save();fs.unlinkSync(policy.locations(a).store);fs.unlinkSync(policy.locations(a).migration);
 assert.equal(policy.initialize(a).status,'unknown');assert.equal(policy.check(a,request(web())).allowed,false);
});
test('nonwritable authority denies operations and no token or body enters policy events',t=>{
 const {a}=fixture(t);a.data.providers=[{id:'provider',secret:'NEVER_STORE_SECRET'}];a.data.sources[0].content='NEVER_STORE_BODY';a.save();boot(a);
 const file=policy.locations(a).store,body=fs.readFileSync(file,'utf8');assert.equal(body.includes('NEVER_STORE_SECRET'),false);assert.equal(body.includes('NEVER_STORE_BODY'),false);
 fs.chmodSync(file,0o400);assert.equal(policy.check(a,request(web())).allowed,false);fs.chmodSync(file,0o600);assert.equal(policy.check(a,request(web())).allowed,true);
});
test('automatic backup recovery keeps latest revoked permission and journal completion',t=>{
 const {a,job,task}=fixture(t);boot(a);recovery.create(a);policy.revoke(a,web(),options());
 require('../desktop/work-journal.cjs').append(a,[{entityKind:'task',entityId:task.id,type:'accepted',actor:'user',workRevision:1,payload:{finalDelivery:{artifactId:'missing'}}},{entityKind:'job',entityId:job.id,type:'completed',actor:'user',workRevision:1,payload:{}}]);
 fs.writeFileSync(a.file,'broken workspace');const restored=recovery.load(a,{});
 assert.equal(restored.delegations[0].allowWeb,false);assert.equal(restored.delegations[0].status,'completed');assert.equal(restored.tasks[0].status,'completed');assert.equal(restored.tasks[0].recoveryReview.code,'ACCEPTED_DELIVERY_MISSING');
});

test('model aliases use the same independent authority through protocol-access',t=>{
 const {a,job}=fixture(t);boot(a);const protocol=require('../desktop/protocol-access.cjs');
 assert.doesNotThrow(()=>protocol.assertTool(a,job,'model_request'));
 policy.revoke(a,{principalScope:policy.LOCAL,resourceScope:{kind:'model',key:'app',jobId:job.id},operations:['model','model_request']},options());
 for(const op of ['model','model_request'])assert.throws(()=>protocol.assertTool(a,job,op),/未授权|授权范围/);
});
test('GitHub credential principal is opaque, action-specific, and invalidated by rotation',async t=>{
 const {a,job}=fixture(t);a.data.agentSettings={githubToken:'SEALED_FIXTURE_ONLY'};job.githubRepo='fixture/repo';job.githubMode='ask';a.save();boot(a);
 const p=policy.githubPrincipal(a.data);assert.equal(p.kind,'credential');assert.match(p.subject,/sealed-sha256:[a-f0-9]{64}/);
 const r={id:'approved',jobId:job.id,taskId:'task',tool:'github_create',target:job.githubRepo,version:'v1',title:'Fixture',key:'k1',content:'test body',larkOpenId:'not-github'};
 require('../desktop/protocol-access.cjs').authorizeAction(a,r);
 assert.equal(policy.requestsForTool(a,job,r.tool,{}, {action:r,taskId:r.taskId})[0].principalScope.provider,'github');
 assert.equal(policy.checkTool(a,job,r.tool,{}, {action:r,taskId:r.taskId}).allowed,true);
 assert.equal(policy.checkTool(a,job,r.tool,{}, {action:{...r,id:'other'},taskId:r.taskId}).allowed,false);
 assert.doesNotMatch(fs.readFileSync(policy.locations(a).store,'utf8'),/SEALED_FIXTURE_ONLY|test body/);
 a.data.agentSettings.githubToken='OTHER_SEALED_FIXTURE';assert.equal(policy.checkTool(a,job,'github_read').allowed,false);
 assert.equal(policy.checkTool(a,job,r.tool,{}, {action:r,taskId:r.taskId}).allowed,false);
});
test('GitHub low-level requests check each page and a credential change while opening vault',async t=>{
 const {a,job}=fixture(t);a.data.agentSettings={githubToken:'SEALED_A'};job.githubRepo='fixture/repo';a.save();boot(a);
 const tools=require('../desktop/agent-tools.cjs');let calls=0;
 a.vault={open:async()=>{a.data.agentSettings.githubToken='SEALED_B';return 'fixture-token';}};a.agentRequest=async()=>{calls++;return {body:'{}'};};
 await assert.rejects(tools.github(a,job.githubRepo,'issues/1',{job}),/凭据已变化/);assert.equal(calls,0);
 a.data.agentSettings.githubToken='SEALED_A';a.vault.open=async()=>'';
 a.agentRequest=async()=>{calls++;policy.revoke(a,{principalScope:policy.githubPrincipal(a.data),resourceScope:{kind:'repository',key:job.githubRepo,jobId:job.id},operations:['github_read']},options());return {body:JSON.stringify({number:1,comments:2})};};
 await assert.rejects(tools.readIssue(a,job.githubRepo,1,undefined,{permissionScope:job}),/未授权|授权范围/);assert.equal(calls,1);
});
test('platform bootstrap is scoped, consumed once, and revoked selection never authorizes identity',t=>{
 const {a}=fixture(t,{empty:true});boot(a);const job={id:'fresh',dataPlatform:'sg-readonly',sourceIds:[],taskIds:[]};a.data.delegations.push(job);
 policy.syncTrustedJob(a,job,options('agentCreate'));const token=policy.beginPlatformIdentity(a,job);
 assert.equal(policy.checkTool(a,job,'platform_query',{queries:[{op:'identity'},{op:'projects'}]}).allowed,false);
 policy.bindPlatformIdentity(a,job,{username:'alice',tenantId:'tenant'},token);
 assert.throws(()=>policy.bindPlatformIdentity(a,job,{username:'bob'},token),/身份|授权/);
 assert.throws(()=>policy.bindPlatformIdentity(a,job,{username:'bob'},policy.beginPlatformIdentity(a,job)),/账号|授权/);
 const before=clone(job);job.dataPlatform='off';policy.syncTrustedJob(a,job,{...options('jobScopeChanged'),before});
 job.dataPlatform='sg-readonly';assert.throws(()=>policy.beginPlatformIdentity(a,job),/授权/);
});
test('legacy work rule scans and verified chat policies migrate without inventing senders',t=>{
 const {a}=fixture(t);a.data.workRules=[{id:'r',status:'enabled',config:{allowWeb:true,githubRepo:'fixture/public'}}];
 a.data.connectors=[{id:'chat',kind:'chat',target:'oc_1',projectId:'p',sendPolicy:{mode:'auto',openId:'u1',revision:'r1'}},{id:'unknown-chat',kind:'chat',target:'oc_2',projectId:'p',sendPolicy:{mode:'auto',revision:'r2'}}];a.save();boot(a);
 assert.equal(policy.checkTool(a,policy.ruleScope(a.data.workRules[0]),'read_url').allowed,true);
 assert.equal(policy.checkTool(a,policy.ruleScope(a.data.workRules[0]),'github_read').allowed,true);
 assert.equal(policy.check(a,{principalScope:{kind:'account',provider:'lark',subject:'u1'},resourceScope:{kind:'connector',key:'chat',projectId:'p',revision:'r1'},operation:'read_message'}).allowed,true);
 assert.equal(policy.inventory(a).rows.find(r=>r.source==='connectors:unknown-chat:sendPolicy').decision,'unknown');
});
test('recovery replays durable action facts after current authority and preserves errors on live writes',t=>{
 const {a,job}=fixture(t);boot(a);require('../desktop/protocol-access.cjs').initialize(a);
 const facts=require('../desktop/action-facts.cjs'),r={id:'durable',jobId:job.id,taskId:'task',tool:'write_file',version:'old',target:'/fixture'};
 a.data.agentActions.push(r);facts.receipt(a,{...r,result:{path:'/fixture/result'}});
 const old=clone(a.data);old.agentActions=[];recovery.reconcileAuthorities(a,old);
 assert.equal(old.agentActions[0].result.path,'/fixture/result');assert.equal(old.agentActions[0].status,'uncertain');
 fs.unlinkSync(path.join(a.dir,'action-facts.json'));recovery.reconcileAuthorities(a,clone(a.data));assert.match(a.actionFactsError,/缺失/);assert.throws(()=>facts.assertWritable(a),/缺失/);
});
