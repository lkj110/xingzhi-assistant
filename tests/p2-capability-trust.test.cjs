const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const children=require('node:child_process'),spawn=children.spawn;
let pythonCalls=0;
children.spawn=function(command,args,options){if(command.endsWith('/python3'))pythonCalls++;return spawn(command,args,options);};
const {Assistant}=require('../desktop/core.cjs'),capabilities=require('../desktop/capabilities.cjs'),agent=require('../desktop/agent.cjs');
const paths=require('../desktop/capability-repositories.cjs').lintPaths;
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const ui=(assistant,action,input={})=>assistant.dispatch('uiCommand',{action,input});
async function fixture(context){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p2-trust-')));
 const assistant=new Assistant({dir,chat:async()=>{throw Error('No model calls allowed');}});
 context.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(assistant);fs.rmSync(dir,{recursive:true,force:true});});
 await assistant.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
 const root=path.join(dir,'repository');
 for(const folder of ['.agents/skills/dw','scripts/governance/lint'])fs.mkdirSync(path.join(root,folder),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@bytedance-dev/dw-agent-team',version:'fixture'}));
 fs.writeFileSync(path.join(root,'AGENTS.md'),'original documentation');
 fs.writeFileSync(path.join(root,'.agents/skills/dw/SKILL.md'),'routing');
 for(const relative of paths)fs.writeFileSync(path.join(root,relative),'import json,sys\nprint(json.dumps({"input":sys.stdin.read(),"version":"original"}))');
 return {assistant,root,marker:path.join(dir,'python-marker')};
}
async function mount(assistant,root,options={}){
 const preview=await ui(assistant,'capabilityInspect',{kind:'repository',path:root,...options});
 await ui(assistant,'capabilitySave',{token:preview.token,allowedTools:preview.tools.map(tool=>tool.name),trusted:true});
 return assistant.data.capabilities[0];
}
function job(assistant,capability){const result=agent.buildJob(assistant,{goal:'synthetic review',capabilityIds:[capability.id]});assistant.data.delegations.push(result);assistant.save();return result;}
const review=(assistant,delegation,capability)=>capabilities.invoke(assistant,delegation,{capabilityId:capability.id,tool:'sql_review',input:{sql:'select 1'}});
const read=(assistant,delegation,capability)=>capabilities.invoke(assistant,delegation,{capabilityId:capability.id,tool:'read_document',input:{path:'AGENTS.md'}});
function changedScript(root,marker,extra=''){
 fs.writeFileSync(path.join(root,paths[1]),`import pathlib,json,sys\npathlib.Path(${JSON.stringify(marker)}).write_text("ran")\n${extra}\nprint(json.dumps({"input":sys.stdin.read(),"version":"updated"}))`);
}

test('default pinned rejects changed scripts with zero Python execution while documents remain latest',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability);
 const approved=structuredClone(capability.executionTrust),before=pythonCalls;
 changedScript(root,marker);fs.writeFileSync(path.join(root,'AGENTS.md'),'latest documentation');
 assert.equal((await read(assistant,delegation,capability)).result.content,'latest documentation');
 let failure;try{await review(assistant,delegation,capability);}catch(error){failure=error;}
 assert.equal(fs.existsSync(marker),false,'unapproved Python must not create a marker');
 assert.equal(pythonCalls,before,'no Python subprocess may start');
 assert.equal(failure?.code,'CAPABILITY_EXECUTION_CHANGED');
 assert.deepEqual(capability.executionTrust,approved);
 assert.equal(capability.executionTrust.mode,'pinned');
});

test('explicit trusted_latest runs updated local scripts and records actual identities across restart',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root,{executionMode:'trusted_latest'}),delegation=job(assistant,capability);
 const approved=structuredClone(capability.executionTrust),revision=capability.revision,before=pythonCalls;
 changedScript(root,marker);
 const result=await review(assistant,delegation,capability);
 assert.equal(result.result.findings.version,'updated');assert.equal(fs.readFileSync(marker,'utf8'),'ran');assert.equal(pythonCalls,before+1);
 const actual=paths.map(relative=>({path:relative,hash:digest(fs.readFileSync(path.join(root,relative),'utf8'))}));
 assert.deepEqual(result.usedVersion.scripts,actual);assert.equal(result.usedVersion.scriptsDigest,digest(actual));
 assert.equal(result.usedVersion.executionMode,'trusted_latest');assert.equal(result.usedVersion.executionTrustVersion,1);
 assert.notEqual(result.usedVersion.scriptsDigest,approved.scriptsDigest);assert.deepEqual(capability.executionTrust,approved);assert.equal(capability.revision,revision);
 const restarted=new Assistant({dir:assistant.dir});
 assert.deepEqual(restarted.data.capabilities[0].executionTrust,approved);assert.deepEqual(restarted.data.capabilityRuns[0].usedVersion,result.usedVersion);
 assert.equal((await review(restarted,restarted.data.delegations[0],restarted.data.capabilities[0])).result.findings.version,'updated');
 assert.equal((assistant.data.modelCalls||[]).length,0);
});

test('old and unknown contracts permit latest documents but refresh and grants never approve execution',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability);
 for(const trust of [undefined,{version:2,mode:'trusted_latest'},{version:1,mode:'automatic'},{version:1,mode:'pinned',scripts:[],scriptsDigest:'forged'}]){
  if(trust===undefined)delete capability.executionTrust;else capability.executionTrust=trust;
  assistant.save();const restarted=new Assistant({dir:assistant.dir}),current=restarted.data.capabilities[0],currentJob=restarted.data.delegations[0];
  fs.writeFileSync(path.join(root,'AGENTS.md'),'latest even with unconfirmed execution');
  const before=pythonCalls;
  assert.equal((await read(restarted,currentJob,current)).result.content,'latest even with unconfirmed execution');
  await ui(restarted,'capabilityRefresh',{id:current.id,executionMode:'trusted_latest'});
  await ui(restarted,'capabilityGrant',{jobId:currentJob.id,capabilityIds:[current.id],executionMode:'trusted_latest'});
  await assert.rejects(review(restarted,currentJob,current),/能力中心/);
  assert.equal(pythonCalls,before);assert.equal(fs.existsSync(marker),false);assert.deepEqual(current.executionTrust,trust);
 }
});

test('mode and digest cannot be supplied as approval, and direct dispatch or Agent cannot confirm',async context=>{
 const {assistant,root}=await fixture(context);
 for(const mode of ['latest','',null,{},[],true])await assert.rejects(ui(assistant,'capabilityInspect',{kind:'dw',path:root,executionMode:mode}),{code:'CAPABILITY_EXECUTION_MODE_INVALID'});
 for(const field of ['executionTrust','scriptsDigest','scripts'])await assert.rejects(ui(assistant,'capabilityInspect',{kind:'dw',path:root,[field]:'forged'}),{code:'CAPABILITY_EXECUTION_TRUST_INPUT'});
 const preview=await ui(assistant,'capabilityInspect',{kind:'dw',path:root}),input={token:preview.token,allowedTools:['sql_review'],trusted:true};
 await assert.rejects(assistant.dispatch('capabilitySave',input),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 await assert.rejects(assistant.dispatch('capabilitySave',{...input,trustedCommand:true,actor:'user_command'}),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
 await assert.rejects(ui(assistant,'capabilitySave',{...input,trusted:false}),{code:'CAPABILITY_EXECUTION_CONFIRMATION_REQUIRED'});
 await assert.rejects(ui(assistant,'capabilitySave',{...input,executionMode:'trusted_latest'}),{code:'CAPABILITY_EXECUTION_MODE_CHANGED'});
 await assert.rejects(ui(assistant,'capabilitySave',{...input,executionMode:'auto'}),{code:'CAPABILITY_EXECUTION_MODE_INVALID'});
 for(const field of ['executionTrust','scriptsDigest','scripts'])await assert.rejects(ui(assistant,'capabilitySave',{...input,[field]:'forged'}),{code:'CAPABILITY_EXECUTION_TRUST_INPUT'});
 const delegation=agent.buildJob(assistant,{goal:'synthetic attack'});
 await assert.rejects(agent.act(assistant,delegation,'capabilitySave',input),/不可用/);
 assert.equal(assistant.data.capabilities.length,0);
 await ui(assistant,'capabilitySave',input);assert.equal(assistant.data.capabilities[0].executionTrust.mode,'pinned');
 assert.equal(assistant.data.capabilities[0].executionTrust.scriptsDigest,preview.scriptsDigest);
});

test('changed preview scripts, stale token, restart and toggles cannot authorize a newer revision',async context=>{
 const {assistant,root,marker}=await fixture(context);
 const preview=await ui(assistant,'capabilityInspect',{kind:'dw',path:root});changedScript(root,marker);
 await assert.rejects(ui(assistant,'capabilitySave',{token:preview.token,allowedTools:['sql_review'],trusted:true}),{code:'CAPABILITY_EXECUTION_CHANGED'});
 assert.equal(assistant.data.capabilities.length,0);assert.equal(fs.existsSync(marker),false);
 const next=await ui(assistant,'capabilityInspect',{kind:'dw',path:root,executionMode:'trusted_latest'});
 await assert.rejects(ui(assistant,'capabilitySave',{token:preview.token,allowedTools:['sql_review'],trusted:true}),/先检查/);
 const restarted=new Assistant({dir:assistant.dir});await assert.rejects(ui(restarted,'capabilitySave',{token:next.token,allowedTools:['sql_review'],trusted:true}),/先检查/);
 await ui(assistant,'capabilitySave',{token:next.token,allowedTools:['sql_review'],trusted:true});
 const capability=assistant.data.capabilities[0],edit=await ui(assistant,'capabilityInspect',{kind:'dw',path:root,editId:capability.id});
 await ui(assistant,'capabilityToggle',{id:capability.id,enabled:false});
 await assert.rejects(ui(assistant,'capabilitySave',{token:edit.token,allowedTools:['sql_review'],trusted:true}),/配置已变化/);
 assert.equal(capability.executionTrust.mode,'trusted_latest');
});

test('pinned restart, regrant and refresh do not bless changes; explicit recheck invalidates old grants',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability);
 const approved=structuredClone(capability.executionTrust);changedScript(root,marker);fs.chmodSync(path.join(root,paths[1]),0o444);
 await ui(assistant,'capabilityRefresh',{id:capability.id});await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[capability.id]});
 assert.deepEqual(capability.executionTrust,approved);
 const restarted=new Assistant({dir:assistant.dir}),current=restarted.data.capabilities[0],currentJob=restarted.data.delegations[0],before=pythonCalls;
 await assert.rejects(review(restarted,currentJob,current),{code:'CAPABILITY_EXECUTION_CHANGED'});assert.equal(pythonCalls,before);
 const preview=await ui(restarted,'capabilityInspect',{kind:'dw',path:root,editId:current.id});
 await ui(restarted,'capabilitySave',{token:preview.token,allowedTools:current.allowedTools,trusted:true});
 const updated=restarted.data.capabilities[0];assert.notEqual(updated.revision,current.revision);assert.notEqual(updated.executionTrust.scriptsDigest,approved.scriptsDigest);
 await assert.rejects(review(restarted,currentJob,updated),/未授权|权限/);
 await ui(restarted,'capabilityGrant',{jobId:currentJob.id,capabilityIds:[updated.id]});
 assert.equal((await review(restarted,currentJob,updated)).result.findings.version,'updated');assert.equal(fs.existsSync(marker),true);
});

test('contract save failure rolls back without executing; a committed save remains committed on restart',async context=>{
 const {assistant,root}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability),original=structuredClone(capability);
 const preview=await ui(assistant,'capabilityInspect',{kind:'dw',path:root,editId:capability.id,executionMode:'trusted_latest'}),save=assistant.save,before=pythonCalls;
 assistant.save=()=>{throw Error('synthetic disk full');};
 await assert.rejects(ui(assistant,'capabilitySave',{token:preview.token,allowedTools:capability.allowedTools,trusted:true}),/disk full/);
 assistant.save=save;assert.deepEqual(assistant.data.capabilities[0],original);assert.equal(pythonCalls,before);
 const restarted=new Assistant({dir:assistant.dir});assert.deepEqual(restarted.data.capabilities[0].executionTrust,original.executionTrust);
 await ui(assistant,'capabilitySave',{token:preview.token,allowedTools:capability.allowedTools,trusted:true});
 const updated=assistant.data.capabilities[0];assert.equal(updated.executionTrust.mode,'trusted_latest');assert.notEqual(updated.revision,original.revision);
 await assert.rejects(review(assistant,delegation,updated),/未授权|权限/);
 const second=await ui(assistant,'capabilityInspect',{kind:'dw',path:root,editId:updated.id});
 assistant.save=function(){save.call(this);throw Object.assign(Error('synthetic post-commit failure'),{committed:true});};
 await assert.rejects(ui(assistant,'capabilitySave',{token:second.token,allowedTools:updated.allowedTools,trusted:true}),/post-commit/);assistant.save=save;
 assert.equal(assistant.data.capabilities[0].executionTrust.mode,'pinned');assert.equal(new Assistant({dir:assistant.dir}).data.capabilities[0].executionTrust.mode,'pinned');assert.equal(pythonCalls,before);
});

test('copy-time source changes and failed run persistence stop before any Python execution',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root,{executionMode:'trusted_latest'}),delegation=job(assistant,capability),save=assistant.save,before=pythonCalls;
 let changed=false;assistant.save=function(){if(this.data.capabilityRuns[0]?.usedVersion&&!changed){changed=true;changedScript(root,marker);}return save.call(this);};
 await assert.rejects(review(assistant,delegation,capability),/脚本发生变化/);assistant.save=save;
 assert.equal(pythonCalls,before);assert.equal(fs.existsSync(marker),false);assert.equal(assistant.data.capabilityRuns[0].status,'failed');
 let failed=false;assistant.save=function(){if(this.data.capabilityRuns[0]?.usedVersion&&!failed){failed=true;throw Error('run save failed');}return save.call(this);};
 await assert.rejects(review(assistant,delegation,capability),/run save failed/);assistant.save=save;
 assert.equal(pythonCalls,before);assert.equal(assistant.data.capabilityRuns[0].status,'failed');
});

test('source and cached snapshot symlinks, hardlinks, and content tampering fail before Python',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability),before=pythonCalls;
 const source=path.join(root,paths[1]),original=fs.readFileSync(source),outside=path.join(assistant.dir,'outside.py');fs.writeFileSync(outside,original);
 for(const kind of ['symlink','hardlink']){
  fs.rmSync(source);if(kind==='symlink')fs.symlinkSync(outside,source);else fs.linkSync(outside,source);
  await assert.rejects(review(assistant,delegation,capability),/链接|普通文件/);fs.rmSync(source);fs.writeFileSync(source,original);
 }
 const cacheRoot=path.join(assistant.dir,'capability-cache'),outsideCache=path.join(assistant.dir,'outside-cache');fs.mkdirSync(outsideCache);fs.symlinkSync(outsideCache,cacheRoot);
 await assert.rejects(review(assistant,delegation,capability),/缓存目录/);assert.deepEqual(fs.readdirSync(outsideCache),[]);fs.unlinkSync(cacheRoot);
 const cache=path.join(cacheRoot,capability.executionTrust.scriptsDigest),alternate=path.join(assistant.dir,'alternate');fs.mkdirSync(path.dirname(cache),{recursive:true});fs.mkdirSync(alternate);fs.symlinkSync(alternate,cache);
 await assert.rejects(review(assistant,delegation,capability),/缓存目录/);fs.unlinkSync(cache);
 const write=fs.writeFileSync;
 try{
  for(const kind of ['tamper','symlink','hardlink']){
   fs.writeFileSync=function(target,bytes,options){
    const result=write(target,bytes,options);
    if(typeof target==='string'&&target.includes('/capability-cache/')&&target.endsWith('/sql_anti_pattern_linter.py')){
     if(kind==='tamper')write(target,'print("tampered")');
     else{fs.unlinkSync(target);if(kind==='symlink')fs.symlinkSync(outside,target);else fs.linkSync(outside,target);}
    }
    return result;
   };
   await assert.rejects(review(assistant,delegation,capability),/快照摘要|链接|普通文件/);
  }
 }finally{fs.writeFileSync=write;}
 assert.equal(pythonCalls,before);assert.equal(fs.existsSync(marker),false);assert.deepEqual(fs.readFileSync(outside),original);
});

async function waitFor(file){for(let attempt=0;attempt<250;attempt++){if(fs.existsSync(file))return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('synthetic Python did not start');}

test('revocation before spawn stops execution and revocation during Python rejects its result after regrant',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root,{executionMode:'trusted_latest'}),delegation=job(assistant,capability),save=assistant.save,before=pythonCalls;
 let revoked=false;assistant.save=function(){const result=save.call(this);if(this.data.capabilityRuns[0]?.usedVersion&&!revoked){revoked=true;delegation.capabilityGrants=[];}return result;};
 await assert.rejects(review(assistant,delegation,capability),/授权已变化/);assistant.save=save;assert.equal(pythonCalls,before);
 await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[capability.id]});
 const release=path.join(assistant.dir,'release');changedScript(root,marker,`import time\nfor attempt in range(500):\n if pathlib.Path(${JSON.stringify(release)}).exists(): break\n time.sleep(0.01)`);
 const pending=review(assistant,delegation,capability),rejection=assert.rejects(pending,/授权已变化/);await waitFor(marker);
 await ui(assistant,'capabilityToggle',{id:capability.id,enabled:false});await ui(assistant,'capabilityToggle',{id:capability.id,enabled:true});await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[capability.id]});fs.writeFileSync(release,'continue');await rejection;
 assert.equal(assistant.data.capabilityRuns[0].status,'failed');assert.equal(pythonCalls,before+1);
 assert.equal((await review(assistant,delegation,capability)).result.findings.version,'updated');
});

test('policy revocation while Python runs is rechecked even if capability revision is unchanged',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root,{executionMode:'trusted_latest'}),delegation=job(assistant,capability);
 const release=path.join(assistant.dir,'release');changedScript(root,marker,`import time\nfor attempt in range(500):\n if pathlib.Path(${JSON.stringify(release)}).exists(): break\n time.sleep(0.01)`);
 const policies=require('../desktop/access-policy-store.cjs'),request=policies.requestsForTool(assistant,delegation,'capability_call',{capabilityId:capability.id,tool:'sql_review'})[0],revision=capability.revision;
 const pending=review(assistant,delegation,capability),rejection=assert.rejects(pending,/权限|授权/);await waitFor(marker);
 policies.revoke(assistant,{principalScope:request.principalScope,resourceScope:request.resourceScope,operations:[request.operation]},{trusted:true,actor:'user_command',command:'synthetic_revoke'});
 fs.writeFileSync(release,'continue');await rejection;assert.equal(capability.revision,revision);assert.equal(assistant.data.capabilityRuns[0].status,'failed');
});

function git(root,...args){return children.execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function commit(root,message){git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m',message);return git(root,'rev-parse','HEAD');}

test('remote latest documentation is separate from pinned scripts; explicit latest runs new isolated snapshot',async context=>{
 const {assistant,root,marker}=await fixture(context),origin=path.join(assistant.dir,'origin.git');fs.mkdirSync(origin);git(origin,'init','--bare');git(root,'init','-b','main');commit(root,'initial synthetic files');git(root,'remote','add','origin',origin);git(root,'push','-u','origin','main');
 const checkout=path.join(assistant.dir,'checkout');git(assistant.dir,'clone','-b','main',origin,checkout);
 const capability=await mount(assistant,checkout,{updateMode:'remote'}),delegation=job(assistant,capability),approved=structuredClone(capability.executionTrust),before=pythonCalls;
 const stale=await ui(assistant,'capabilityInspect',{kind:'dw',path:checkout,editId:capability.id,updateMode:'remote'});
 fs.writeFileSync(path.join(checkout,'AGENTS.md'),'user local modification');
 changedScript(root,marker);fs.writeFileSync(path.join(root,'AGENTS.md'),'remote latest');const updatedCommit=commit(root,'updated synthetic scripts');git(root,'push');
 await ui(assistant,'capabilitySave',{token:stale.token,allowedTools:capability.allowedTools,trusted:true});
 assert.equal((await read(assistant,delegation,capability)).result.content,'remote latest');
 await assert.rejects(review(assistant,delegation,capability),{code:'CAPABILITY_EXECUTION_CHANGED'});assert.equal(pythonCalls,before);assert.equal(fs.existsSync(marker),false);assert.deepEqual(capability.executionTrust,approved);
 const preview=await ui(assistant,'capabilityInspect',{kind:'dw',path:checkout,editId:capability.id,updateMode:'remote',executionMode:'trusted_latest'});
 await ui(assistant,'capabilitySave',{token:preview.token,allowedTools:capability.allowedTools,trusted:true});const updated=assistant.data.capabilities[0];await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[updated.id]});
 assert.equal(updated.commit,updatedCommit);
 changedScript(root,marker,'print("",end="")');const latestCommit=commit(root,'later trusted update');git(root,'push');
 const result=await review(assistant,delegation,updated);assert.equal(result.result.findings.version,'updated');assert.equal(result.usedVersion.commit,latestCommit);assert.equal(result.usedVersion.executionMode,'trusted_latest');assert.notEqual(result.usedVersion.scriptsDigest,updated.executionTrust.scriptsDigest);assert.equal(pythonCalls,before+1);
 assert.equal(fs.readFileSync(path.join(checkout,'AGENTS.md'),'utf8'),'user local modification');
 fs.renameSync(origin,origin+'.offline');await assert.rejects(review(assistant,delegation,updated),/不会回退/);assert.equal(pythonCalls,before+1);
});

test('all three script paths are pinned including the helper and the unused linter',async context=>{
 const {assistant,root}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability),before=pythonCalls;
 for(const relative of paths){
  const target=path.join(root,relative),original=fs.readFileSync(target);fs.appendFileSync(target,'\nprint("changed")');
  await assert.rejects(review(assistant,delegation,capability),{code:'CAPABILITY_EXECUTION_CHANGED'});fs.writeFileSync(target,original);
 }
 assert.equal(pythonCalls,before);
 assert.equal((await review(assistant,delegation,capability)).result.findings.version,'original');assert.equal(pythonCalls,before+1);
});

const sqlArguments=capability=>({capabilityId:capability.id,tool:'sql_review',input:{sql:'select 1'}});
function blockingScript(root,marker,release){changedScript(root,marker,`import time\nfor attempt in range(500):\n if pathlib.Path(${JSON.stringify(release)}).exists(): break\n time.sleep(0.01)`);}

test('IR01 same-revision grant revoke/regrant rejects old Agent output but a new invocation succeeds',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root,{executionMode:'trusted_latest'}),delegation=job(assistant,capability),args=sqlArguments(capability);
 const initial=await agent.act(assistant,delegation,'capability_call',args),oldSource=structuredClone(assistant.data.sources.find(source=>source.id===initial.sourceId));
 const policies=require('../desktop/access-policy-store.cjs'),before=policies.checkTool(assistant,delegation,'capability_call',args),revision=capability.revision,release=path.join(assistant.dir,'release');
 blockingScript(root,marker,release);
 const pending=agent.act(assistant,delegation,'capability_call',args),rejection=assert.rejects(pending,{code:'CAPABILITY_AUTHORIZATION_CHANGED'});
 await waitFor(marker);
 await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[]});await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[capability.id]});
 const after=policies.checkTool(assistant,delegation,'capability_call',args);assert.equal(capability.revision,revision);assert.equal(before.policyId,after.policyId);assert.notEqual(before.grantRevision,after.grantRevision);
 fs.writeFileSync(release,'continue');await rejection;
 const rejected=structuredClone(assistant.data.capabilityRuns[0]);assert.equal(rejected.status,'failed');assert.ok(rejected.executionCompletedAt);assert.ok(rejected.resultHash);assert.ok(rejected.resultRejectedAt);assert.equal(rejected.resultRejectionCode,'CAPABILITY_AUTHORIZATION_CHANGED');
 assert.deepEqual(assistant.data.sources.find(source=>source.id===initial.sourceId),oldSource);assert.equal(assistant.data.sources.length,1);
 const fresh=await agent.act(assistant,delegation,'capability_call',args);assert.equal(fresh.result.findings.version,'updated');assert.notEqual(fresh.recordId,rejected.id);
 assert.deepEqual(assistant.data.capabilityRuns.find(record=>record.id===rejected.id),rejected);
 const persisted=new Assistant({dir:assistant.dir}).data.capabilityRuns.find(record=>record.id===rejected.id);assert.deepEqual(persisted,rejected);
});

test('IR01 unrelated policy changes do not invalidate the original grant or its result proof',async context=>{
 const {assistant,root,marker}=await fixture(context),capability=await mount(assistant,root,{executionMode:'trusted_latest'}),delegation=job(assistant,capability),otherJob=job(assistant,capability),args=sqlArguments(capability);
 const policies=require('../desktop/access-policy-store.cjs'),before=policies.checkTool(assistant,delegation,'capability_call',args),release=path.join(assistant.dir,'release');blockingScript(root,marker,release);
 const pending=agent.act(assistant,delegation,'capability_call',args);await waitFor(marker);
 await ui(assistant,'capabilityGrant',{jobId:otherJob.id,capabilityIds:[]});const after=policies.checkTool(assistant,delegation,'capability_call',args);
 assert.notEqual(before.sequence,after.sequence);assert.equal(before.policyId,after.policyId);assert.equal(before.grantRevision,after.grantRevision);
 fs.writeFileSync(release,'continue');const result=await pending;assert.equal(result.result.findings.version,'updated');assert.ok(result.sourceId);assert.equal(assistant.data.capabilityRuns[0].resultRejectedAt,undefined);
});

test('IR02 handoff revoke/regrant preserves execution receipt and historical source without accepting late output',async context=>{
 const {assistant,root}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability),args={capabilityId:capability.id,tool:'read_document',input:{path:'AGENTS.md'}};
 const first=await agent.act(assistant,delegation,'capability_call',args),source=assistant.data.sources.find(row=>row.id===first.sourceId);source.identity='legacy-identity';assistant.save();const historical=structuredClone(source);
 fs.writeFileSync(path.join(root,'AGENTS.md'),'changed after historical source');
 const save=assistant.save;let revoked;
 assistant.save=function(){const result=save.call(this);if(!revoked&&this.data.capabilityRuns[0]?.status==='done'&&this.data.capabilityRuns[0].id!==first.recordId)revoked=Promise.resolve().then(async()=>{await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[]});await ui(assistant,'capabilityGrant',{jobId:delegation.id,capabilityIds:[capability.id]});});return result;};
 try{await assert.rejects(agent.act(assistant,delegation,'capability_call',args),{code:'CAPABILITY_AUTHORIZATION_CHANGED'});await revoked;}finally{assistant.save=save;}
 assert.equal(assistant.data.sources.length,1);assert.deepEqual(source,historical);
 const record=assistant.data.capabilityRuns[0];assert.equal(record.status,'failed');assert.ok(record.executionCompletedAt);assert.ok(record.resultHash);assert.ok(record.resultRejectedAt);
 const restarted=new Assistant({dir:assistant.dir});assert.deepEqual(restarted.data.sources.find(row=>row.id===first.sourceId),historical);assert.deepEqual(restarted.data.capabilityRuns[0],record);
 assert.equal((await agent.act(assistant,delegation,'capability_call',args)).result.content,'changed after historical source');
});

test('IR02 internal proofs reject JSON copies, replay, changed caller, tool, capability, input and return content',async context=>{
 const {assistant,root}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability),otherJob=job(assistant,capability),other=await fixture(context);
 const args={capabilityId:capability.id,tool:'read_document',input:{path:'AGENTS.md'}};
 let result=await capabilities.invoke(assistant,delegation,args);
 assert.throws(()=>capabilities.consumeResult(assistant,delegation,args,JSON.parse(JSON.stringify(result))),{code:'CAPABILITY_RESULT_PROOF_INVALID'});
 assert.equal(capabilities.consumeResult(assistant,delegation,{...args,input:{path:'AGENTS.md',start:0}},result),result);
 assert.throws(()=>capabilities.consumeResult(assistant,delegation,args,result),{code:'CAPABILITY_RESULT_PROOF_INVALID'});
 const cases=[
  [other.assistant,delegation,args],
  [assistant,otherJob,args],
  [assistant,{...delegation},args],
  [assistant,delegation,{...args,tool:'list_skills'}],
  [assistant,delegation,{...args,capabilityId:'another'}],
  [assistant,delegation,{...args,input:{path:'AGENTS.md',start:1}}],
 ];
 for(const [caller,target,input] of cases){result=await capabilities.invoke(assistant,delegation,args);assert.throws(()=>capabilities.consumeResult(caller,target,input,result),{code:'CAPABILITY_RESULT_PROOF_INVALID'});assert.throws(()=>capabilities.consumeResult(assistant,delegation,args,result),{code:'CAPABILITY_RESULT_PROOF_INVALID'});}
 result=await capabilities.invoke(assistant,delegation,args);result.result.content='forged text';assert.throws(()=>capabilities.consumeResult(assistant,delegation,args,result),{code:'CAPABILITY_RESULT_PROOF_INVALID'});
 assert.equal(assistant.data.sources.length,0);assert.equal(other.assistant.data.capabilityRuns.length,0);
});

test('IR02 consumer rechecks execution conditions and rejects mocked proofless returns before source mutation',async context=>{
 const {assistant,root}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability),args={capabilityId:capability.id,tool:'read_document',input:{path:'AGENTS.md'}};
 const result=await capabilities.invoke(assistant,delegation,args),status=delegation.status;delegation.status='paused';
 assert.throws(()=>capabilities.consumeResult(assistant,delegation,args,result),{code:'EXECUTION_GATE_CLOSED'});delegation.status=status;
 assert.ok(assistant.data.capabilityRuns[0].executionCompletedAt);assert.ok(assistant.data.capabilityRuns[0].resultRejectedAt);
 const original=capabilities.invoke;
 capabilities.invoke=async(...parameters)=>structuredClone(await original(...parameters));
 try{await assert.rejects(agent.act(assistant,delegation,'capability_call',args),{code:'CAPABILITY_RESULT_PROOF_INVALID'});}finally{capabilities.invoke=original;}
 assert.equal(assistant.data.sources.length,0);
 assert.ok((await agent.act(assistant,delegation,'capability_call',args)).sourceId);
});

test('IR03 beforestat versus fd rejects same-path open/swap/restore before reading foreign bytes',async context=>{
 const {assistant,root}=await fixture(context),repositories=require('../desktop/capability-repositories.cjs'),target=path.join(root,'AGENTS.md'),held=target+'.held',replacement=path.join(assistant.dir,'replacement');
 fs.writeFileSync(replacement,'outside replacement');const open=fs.openSync,readSync=fs.readSync;let foreignDescriptor,foreignReads=0;
 fs.openSync=function(filename,...args){if(filename!==target)return open.call(this,filename,...args);fs.renameSync(target,held);fs.renameSync(replacement,target);try{foreignDescriptor=open.call(this,filename,...args);return foreignDescriptor;}finally{fs.renameSync(target,replacement);fs.renameSync(held,target);}};
 fs.readSync=function(descriptor,...args){if(descriptor===foreignDescriptor)foreignReads++;return readSync.call(this,descriptor,...args);};
 try{assert.throws(()=>repositories.readFile(root,'AGENTS.md'),{code:'CAPABILITY_FILE_CHANGED'});}finally{fs.openSync=open;fs.readSync=readSync;}
 assert.equal(foreignReads,0);assert.equal(repositories.readFile(root,'AGENTS.md').toString(),'original documentation');
});

test('IR03 read-time parent restore and same-path replacement reject changed identities and keep later reads valid',async context=>{
 const {assistant,root}=await fixture(context),repositories=require('../desktop/capability-repositories.cjs'),folder=path.join(root,'guide'),held=path.join(root,'held');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'SKILL.md'),'ordinary guidance');
 const open=fs.openSync,readSync=fs.readSync,target=path.join(folder,'SKILL.md');
 for(const attack of ['parent-restore','file-replace']){
  let descriptorForTarget,changed=false;
  fs.openSync=function(filename,...args){const descriptor=open.call(this,filename,...args);if(filename===target)descriptorForTarget=descriptor;return descriptor;};
  fs.readSync=function(descriptor,...args){const count=readSync.call(this,descriptor,...args);if(descriptor===descriptorForTarget&&!changed){changed=true;if(attack==='parent-restore'){fs.renameSync(folder,held);fs.renameSync(held,folder);}else{fs.renameSync(target,path.join(assistant.dir,'old-file'));fs.writeFileSync(target,'replacement guidance');}}return count;};
  try{assert.throws(()=>repositories.readFile(root,'guide/SKILL.md'),{code:'CAPABILITY_FILE_CHANGED'});}finally{fs.openSync=open;fs.readSync=readSync;}
  assert.equal(repositories.readFile(root,'guide/SKILL.md').toString(),attack==='parent-restore'?'ordinary guidance':'replacement guidance');
 }
});

test('IR02 real proven capability returns preserve observation fingerprints and the no-progress guard',async context=>{
 const {assistant,root}=await fixture(context),capability=await mount(assistant,root),delegation=job(assistant,capability);
 const registry=require('../desktop/tool-registry.cjs'),ledger=require('../desktop/operation-ledger.cjs'),efficiency=require('../desktop/efficiency.cjs'),args={capabilityId:capability.id,tool:'read_document',input:{path:'AGENTS.md'}};
 const first=await agent.act(assistant,delegation,'capability_call',args),key=registry.request(delegation,'capability_call',args,assistant),observation=structuredClone(ledger.state(delegation).reads[key]),progress=efficiency.progress(assistant,delegation);
 const second=await agent.act(assistant,delegation,'capability_call',{...args,input:{path:'AGENTS.md',start:0}});
 assert.equal(second.sourceId,first.sourceId);assert.equal(ledger.state(delegation).reads[key].observations,2);assert.equal(ledger.state(delegation).reads[key].fingerprint,observation.fingerprint);assert.equal(efficiency.progress(assistant,delegation),progress);
 let stop;
 for(let attempt=0;attempt<8;attempt++){
  const before=efficiency.progress(assistant,delegation),step={tool:'capability_call',args:{...args,note:'ignored planner note '+attempt}};
  step.result=await agent.act(assistant,delegation,step.tool,step.args);
  try{efficiency.checkProgress(assistant,delegation,step,before);}catch(error){stop=error;break;}
 }
 assert.equal(stop?.code,'NO_NEW_EVIDENCE');
});
