const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {Assistant}=require('../desktop/core.cjs'),cap=require('../desktop/capabilities.cjs'),agent=require('../desktop/agent.cjs'),repos=require('../desktop/capability-repositories.cjs');
const ui=(a,action,input={})=>a.dispatch('uiCommand',{action,input});
async function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-repos-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,chat:async()=>{throw Error('No model calls expected');}});await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});return a;}
function repo(a,name,body='version one'){const root=path.join(a.dir,name);fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'SKILL.md'),body);return root;}
async function mount(a,input,allowedTools){const p=await ui(a,'capabilityInspect',{kind:'repository',...input});await ui(a,'capabilitySave',{token:p.token,allowedTools:allowedTools||p.tools.map(t=>t.name),trusted:true});return a.data.capabilities[0];}
function job(a,ids){const j=agent.buildJob(a,{goal:'Use selected repository skills',capabilityIds:ids});a.data.delegations.push(j);return j;}
const read=(a,j,c,p='SKILL.md')=>agent.act(a,j,'capability_call',{capabilityId:c.id,tool:'read_document',input:{path:p}});
function git(root,...args){return execFileSync(require('../desktop/host-process.cjs').executable('git')||'git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function commit(root,message){git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m',message);return git(root,'rev-parse','HEAD');}

test('multiple same-named repositories remain independent; content updates keep grants and historical provenance',async t=>{
 const a=await fixture(t),one=repo(a,'first/team','one'),two=repo(a,'second/team','two');
 const c1=await mount(a,{path:one}),c2=await mount(a,{path:two});assert.equal(c1.name,c2.name);assert.notEqual(c1.id,c2.id);assert.equal(a.data.capabilities.length,2);
 const j=job(a,[c1.id,c2.id]),first=await read(a,j,c1);assert.equal(first.result.content,'one');assert.equal((await read(a,j,c2)).result.content,'two');
 const prior=structuredClone(a.data.capabilityRuns.find(r=>r.id===first.recordId)),revision=c1.revision;
 fs.writeFileSync(path.join(one,'SKILL.md'),'one latest');fs.writeFileSync(path.join(one,'NEW.md'),'new skill');
 const latest=await read(a,j,c1);assert.equal(latest.result.content,'one latest');assert.equal(c1.revision,revision);assert.notEqual(first.usedVersion.contentRevision,latest.usedVersion.contentRevision);
 assert.deepEqual(a.data.capabilityRuns.find(r=>r.id===first.recordId),prior);assert.deepEqual(a.data.sources.find(s=>s.id===latest.sourceId).capabilityVersion,latest.usedVersion);
 assert.equal(c1.documents.length,2);assert.equal(c2.documents.length,1);assert.equal((a.data.modelCalls||[]).length,0);
 const publicState=a.publicState();assert.ok(publicState.capabilities.every(c=>!('readPath' in c)&&!('documents' in c)&&!('scripts' in c)));
});

test('generic repository add, edit alias, tool scope change, remove and restore preserve independent records',async t=>{
 const a=await fixture(t),root=repo(a,'skills'),c=await mount(a,{path:root}),j=job(a,[c.id]),revision=c.revision;
 let p=await ui(a,'capabilityInspect',{kind:'repository',path:root,editId:c.id,name:'My skills'});await ui(a,'capabilitySave',{token:p.token,allowedTools:c.allowedTools});
 let updated=a.data.capabilities[0];assert.equal(updated.revision,revision);assert.equal(updated.name,'My skills');assert.equal((await read(a,j,updated)).result.content,'version one');
 p=await ui(a,'capabilityInspect',{kind:'repository',path:root});await assert.rejects(ui(a,'capabilitySave',{token:p.token,allowedTools:['list_skills']}),/已挂载/);
 p=await ui(a,'capabilityInspect',{kind:'repository',path:root,editId:c.id});await ui(a,'capabilitySave',{token:p.token,allowedTools:['list_skills']});updated=a.data.capabilities[0];assert.notEqual(updated.revision,revision);await assert.rejects(read(a,j,updated),/未授权/);
 await ui(a,'capabilityRemove',{id:c.id});assert.equal(a.data.capabilities.length,1);assert.ok(updated.removedAt);assert.equal(cap.context(a,j).length,0);
 await ui(a,'capabilityToggle',{id:c.id,enabled:true});assert.equal(updated.removedAt,null);await ui(a,'capabilityGrant',{jobId:j.id,capabilityIds:[c.id]});assert.equal(cap.context(a,j).length,1);
});

test('repository registry grows past ten while each job explicitly chooses its tools',async t=>{
 const a=await fixture(t);for(let n=0;n<12;n++)await mount(a,{path:repo(a,`repo-${n}`),name:`Skills ${n}`},['list_skills']);
 assert.equal(a.data.capabilities.length,12);assert.equal(cap.grants(a,a.data.capabilities.slice(0,10).map(c=>c.id)).length,10);assert.throws(()=>cap.grants(a,a.data.capabilities.map(c=>c.id)),/10/);
});

test('local updates do not add execution tools and symlink documents cannot escape repository',async t=>{
 const a=await fixture(t),root=repo(a,'skills'),c=await mount(a,{path:root}),j=job(a,[c.id]);
 const external=path.join(a.dir,'private.md');fs.writeFileSync(external,'private');{if(!require('./helpers/symlink.cjs').link(t,external,path.join(root,'outside.md')))return;}
 fs.writeFileSync(path.join(root,'evil.py'),'raise Exception("should never run")');
 await ui(a,'capabilityRefresh',{id:c.id});assert.deepEqual(c.tools.map(t=>t.name),['list_skills','read_document']);assert.ok(!c.documents.some(d=>d.path==='outside.md'));
 await assert.rejects(read(a,j,c,'outside.md'),/登记/);await assert.rejects(read(a,j,c,'../private.md'),/登记/);
 fs.rmSync(path.join(root,'SKILL.md'));{if(!require('./helpers/symlink.cjs').link(t,external,path.join(root,'SKILL.md')))return;}await assert.rejects(read(a,j,c),/未找到/);assert.equal(a.data.capabilityRuns[0].status,'failed');assert.equal(a.data.capabilityRuns[0].usedVersion,undefined);
});

test('git remote refresh reads newest commit without touching dirty checkout and fails closed when remote is missing',async t=>{
 const a=await fixture(t),origin=path.join(a.dir,'origin.git'),writer=repo(a,'writer','remote one');fs.mkdirSync(origin);git(origin,'init','--bare');git(writer,'init','-b','main');const firstCommit=commit(writer,'one');git(writer,'remote','add','origin',origin);git(writer,'push','-u','origin','main');
 const checkout=path.join(a.dir,'checkout');git(a.dir,'clone','-b','main',origin,checkout);fs.writeFileSync(path.join(checkout,'SKILL.md'),'local edits stay');fs.writeFileSync(path.join(checkout,'untracked.txt'),'keep');
 const c=await mount(a,{path:checkout,updateMode:'remote'}),j=job(a,[c.id]);assert.equal(c.gitSource.branch,'main');assert.equal((await read(a,j,c)).result.content,'remote one');assert.equal(c.commit,firstCommit);
 fs.writeFileSync(path.join(writer,'SKILL.md'),'remote two');const secondCommit=commit(writer,'two');git(writer,'push');
 const statusBefore=git(checkout,'status','--porcelain'),localHead=git(checkout,'rev-parse','HEAD'),r=await read(a,j,c);
 assert.equal(r.result.content,'remote two');assert.equal(r.usedVersion.commit,secondCommit);assert.equal(r.usedVersion.updateMode,'remote');assert.equal(c.revision,j.capabilityGrants[0].revision);assert.equal(git(checkout,'rev-parse','HEAD'),localHead);assert.equal(git(checkout,'status','--porcelain'),statusBefore);assert.equal(fs.readFileSync(path.join(checkout,'SKILL.md'),'utf8'),'local edits stay');
 const publicC=a.publicState().capabilities[0];assert.deepEqual(publicC.gitSource,{remote:'origin',branch:'main'});assert.ok(!publicC.readPath);assert.equal(fs.readdirSync(path.dirname(c.readPath)).filter(p=>p.startsWith('snapshot-')).length,1);
 fs.renameSync(origin,origin+'.offline');await assert.rejects(read(a,j,c),/不会回退/);assert.equal(a.data.capabilityRuns[0].status,'failed');assert.equal(a.data.capabilityRuns[0].usedVersion,undefined);assert.match(c.lastError,/Git/);assert.equal(a.data.sources.filter(s=>s.capabilityId===c.id).length,2);
 fs.renameSync(origin+'.offline',origin);assert.equal((await read(a,j,c)).result.content,'remote two');assert.equal(c.lastError,'');
 // Changing the update policy changes scope, requiring a fresh grant.
 const p=await ui(a,'capabilityInspect',{kind:'repository',editId:c.id,path:checkout,updateMode:'local'});await ui(a,'capabilitySave',{token:p.token,allowedTools:c.allowedTools});const local=a.data.capabilities[0];await assert.rejects(read(a,j,local),/未授权/);await ui(a,'capabilityGrant',{jobId:j.id,capabilityIds:[c.id]});const lr=await read(a,j,local);assert.equal(lr.result.content,'local edits stay');assert.equal(lr.usedVersion.dirty,true);assert.equal(local.gitSource,null);
});

test('remote branch configuration cannot be forged with a gitSource URL',async t=>{
 const a=await fixture(t),root=repo(a,'not-git');await assert.rejects(ui(a,'capabilityInspect',{kind:'repository',path:root,updateMode:'remote',gitSource:{url:'/untrusted',branch:'main',remote:'x'}}),/Git|根目录/);assert.equal(a.capabilityPreview,undefined);assert.equal(a.operation,null);
});

test('repository metadata replacement rolls back on persistence errors and stale previews cannot overwrite toggles',async t=>{
 const a=await fixture(t),root=repo(a,'skills'),c=await mount(a,{path:root}),old=structuredClone(c),save=a.save;
 fs.writeFileSync(path.join(root,'SKILL.md'),'new');a.save=()=>{throw Error('disk full');};await assert.rejects(ui(a,'capabilityRefresh',{id:c.id}),/disk full/);assert.deepEqual(c,old);a.save=save;
 const p=await ui(a,'capabilityInspect',{kind:'repository',path:root,editId:c.id});await ui(a,'capabilityToggle',{id:c.id,enabled:false});await assert.rejects(ui(a,'capabilitySave',{token:p.token,allowedTools:['read_document']}),/配置已变化/);assert.equal(c.enabled,false);
});

test('same-named MCP services with different arguments do not overwrite each other',async t=>{
 const a=await fixture(t),config={kind:'mcp',name:'Tools',command:process.execPath,cwd:path.resolve(__dirname,'..'),noModel:true};
 const one=await mount(a,{...config,args:[path.join(__dirname,'fixtures/capability-mcp.cjs'),'one']},['summarize_fixture']);const two=await mount(a,{...config,args:[path.join(__dirname,'fixtures/capability-mcp.cjs'),'two']},['summarize_fixture']);assert.notEqual(one.id,two.id);assert.equal(a.data.capabilities.length,2);
 const j=job(a,[one.id,two.id]);const r=await cap.invoke(a,j,{capabilityId:two.id,tool:'summarize_fixture',input:{text:'v2'}});assert.equal(r.result.content[0].text,'fixture:v2');assert.equal(r.usedVersion.updateMode,'service');assert.ok(r.usedVersion.contentRevision);
});

test('repository scans exclude dependency directories and enforce document size',async t=>{
 const a=await fixture(t),root=repo(a,'skills');fs.mkdirSync(path.join(root,'node_modules'));fs.writeFileSync(path.join(root,'node_modules','README.md'),'skip');assert.equal(repos.inventory(root).length,1);
 fs.writeFileSync(path.join(root,'large.md'),'a'.repeat(1000001));await assert.rejects(ui(a,'capabilityInspect',{kind:'repository',path:root}),/1 MB/);assert.equal(a.operation,null);
});
