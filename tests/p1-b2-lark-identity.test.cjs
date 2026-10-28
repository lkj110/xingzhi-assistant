const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),connectors=require('../desktop/connectors.cjs'),policy=require('../desktop/access-policy-store.cjs'),lark=require('../desktop/lark-connector.cjs');
async function fixture(t,kind='chat'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'b2-lark-')),bin=path.join(root,process.platform==='win32'?'lark-cli.exe':'lark-cli'),stateFile=path.join(root,'remote.json'),trace=path.join(root,'trace.jsonl');
 const state={ambient:'A',bodies:0,users:{A:{appId:'cli_app',brand:'feishu',openId:'ou_A',tenantId:'tenant_A'},B:{appId:'cli_app',brand:'feishu',openId:'ou_B',tenantId:'tenant_B'}},pages:2};
 fs.writeFileSync(stateFile,JSON.stringify(state));
 require('./helpers/native-cli.cjs').write(bin,String.raw`
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),root=__dirname;
if(args[0]==='--version'){console.log('lark-cli version 1.0.65');process.exit(0);}
const file=path.join(root,'remote.json'),s=JSON.parse(fs.readFileSync(file)),out=x=>console.log(JSON.stringify(x));
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const cfg=process.env.LARKSUITE_CLI_CONFIG_DIR&&JSON.parse(fs.readFileSync(path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,'config.json')));
const app=cfg?.apps?.[0],who=app?Object.keys(s.users).find(k=>s.users[k].appId===app.appId&&s.users[k].openId===app.users[0].userOpenId&&s.users[k].brand===app.brand):s.ambient;
fs.appendFileSync(path.join(root,'trace.jsonl'),JSON.stringify({args,who,pinned:!!cfg,configDir:process.env.LARKSUITE_CLI_CONFIG_DIR||null,cwd:process.cwd(),home:process.env.HOME,token:args.includes('--page-token')?args[args.indexOf('--page-token')+1]:null})+'\n');
if(args[0]==='auth'){const u=s.users[s.ambient];out({appId:u.appId,brand:u.brand,identities:{user:{openId:u.openId,available:true,status:'ready'}}});process.exit(0);}
if(!who||s.revoked===who){out({ok:false,error:{type:'auth',message:'missing user token'}});process.exit(3);}
if(args[0]==='api'){const u=s.users[who];if(s.aba)s.ambient='B';save();out({ok:true,identity:'user',data:{open_id:s.wrongOpenId||u.openId,...(!s.missingTenant?{tenant_key:s.wrongTenant||u.tenantId}:{}),email:'PRIVATE_EMAIL',mobile:'PRIVATE_PHONE'}});process.exit(0);}
if(s.descendant&&args[0]==='im'){
 const childCode="const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>{try{fs.lstatSync(process.argv[2]);}catch(error){if(error.code==='ENOENT')fs.writeFileSync(process.argv[3],'removed while child alive');else fs.writeFileSync(process.argv[4],JSON.stringify({code:error.code||'UNKNOWN',message:error.message}));}},10);fs.writeFileSync(process.argv[1]+'.tmp',String(process.pid));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);";
 const child=require('node:child_process').spawn(process.execPath,['-e',childCode,path.join(root,'child-ready'),process.env.LARKSUITE_CLI_CONFIG_DIR,path.join(root,'premature-cleanup'),path.join(root,'child-observation-error')],{stdio:'ignore'});
 fs.writeFileSync(path.join(root,'group.json.tmp'),JSON.stringify({pid:process.pid,child:child.pid,configDir:process.env.LARKSUITE_CLI_CONFIG_DIR}));fs.renameSync(path.join(root,'group.json.tmp'),path.join(root,'group.json'));
 const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'child-ready'))){clearInterval(timer);if(s.descendant==='close'){out({ok:true,identity:'user',data:{messages:[],has_more:false}});process.exit(0);}}},10);
 return;
}
s.bodies++;if(s.aba)s.ambient='A';save();if(s.failAt===s.bodies){out({ok:false,error:{type:'network'}});process.exit(1);}
if(args[0]==='docs'){out({ok:true,identity:'user',data:{document:{content:who+' document body',revision_id:1}}});process.exit(0);}
const token=args.includes('--page-token')?args[args.indexOf('--page-token')+1]:null,index=token?Number(token.split(':')[1]):0;
out({ok:true,identity:'user',data:{messages:[{message_id:'om_'+who+'_'+index,content:{text:who+' body '+index},msg_type:'text',create_time:'1760000000000',sender:{id:'ou_sender'}}],has_more:index+1<s.pages,page_token:who+':'+(index+1)}});
`);
 const prior=process.env.PATH;process.env.PATH=root+path.delimiter+prior;
 let a=new Assistant({dir:path.join(root,'workspace'),chat:async()=>{throw Error('No model');}});
 t.after(async()=>{if(a.runPromise)await a.runPromise;process.env.PATH=prior;fs.rmSync(root,{recursive:true,force:true});});
 await a.dispatch('projectSave',{name:'P'});await a.dispatch('connectorSave',{name:'C',kind,target:kind==='chat'?'oc_fixture':'https://fixture.feishu.cn/docx/fixture',projectId:a.data.projects[0].id,enabled:false});
 const c=a.data.connectors[0];
 return {get a(){return a;},get c(){return a.data.connectors.find(x=>x.id===c.id);},root,bin,trace,read:()=>JSON.parse(fs.readFileSync(stateFile)),change:patch=>fs.writeFileSync(stateFile,JSON.stringify({...JSON.parse(fs.readFileSync(stateFile)),...patch})),events:()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[],restart:()=>{a=new Assistant({dir:path.join(root,'workspace'),chat:async()=>{throw Error('No model');}});return a;}};
}
async function bind(f,enableAfterBind=false){const p=await f.a.dispatch('connectorIdentityPreview',{id:f.c.id});const result=await f.a.dispatch('connectorBindPrincipal',{id:f.c.id,previewToken:p.previewToken,operationId:p.operationId,enableAfterBind});assert.equal(result.status,'bound');return p;}
const bodies=f=>f.events().filter(e=>['docs','im'].includes(e.args[0]));
const ui=(a,action,input)=>a.dispatch('uiCommand',{action,input});
async function archiveReopen(f){
 const id=f.c.projectId;
 for(const action of ['projectLifecycleArchive','projectLifecycleReopen']){
  const preview=await ui(f.a,'projectLifecyclePreview',{id});
  await ui(f.a,action,{id,revision:preview.revision});
 }
 assert.equal(f.c.enabled,false);assert.equal(f.c.nextRunAt,null);
}
for(const phase of ['preview','confirmation'])test('I14 '+phase+' in flight cannot cross project archive/reopen; fresh binding still enables',async t=>{
 const f=await fixture(t),p=phase==='confirmation'?await f.a.dispatch('connectorIdentityPreview',{id:f.c.id}):null;
 let cycled=false;f.a.connectorRequest=async(args,options)=>{
  const raw=await lark.request(args,options);
  if(args[0]==='api'&&!cycled){cycled=true;await archiveReopen(f);}
  return raw;
 };
 await assert.rejects(ui(f.a,p?'connectorBindPrincipal':'connectorIdentityPreview',p?{id:f.c.id,previewToken:p.previewToken,operationId:p.operationId,enableAfterBind:true}:{id:f.c.id}),{code:'CONTEXT_VERSION_CHANGED'});
 assert.ok(cycled);assert.equal(f.c.enabled,false);assert.equal(f.c.nextRunAt,null);assert.equal(policy.inventory(f.a).sequence,0);assert.equal(bodies(f).length,0);
 await bind(f,true);assert.equal(f.c.enabled,true);assert.equal(policy.inventory(f.a).sequence,3);
});
for(const restart of [false,true])test('I14 committed pending binding preserves later project pause and authority; restart='+restart,async t=>{
 const f=await fixture(t),p=await f.a.dispatch('connectorIdentityPreview',{id:f.c.id}),commit=policy.commitLarkBinding;let result;
 try{policy.commitLarkBinding=(...args)=>{commit(...args);throw Object.assign(Error('authority response lost'),{committed:true});};result=await ui(f.a,'connectorBindPrincipal',{id:f.c.id,previewToken:p.previewToken,operationId:p.operationId,enableAfterBind:true});}finally{policy.commitLarkBinding=commit;}
 assert.equal(result.status,'pending');assert.equal(result.committed,true);assert.equal(policy.inventory(f.a).sequence,3);
 const authority=fs.readFileSync(policy.locations(f.a).store,'utf8');
 await archiveReopen(f);if(restart)f.restart();
 assert.equal(connectors.tick(f.a),false);assert.equal(f.c.enabled,false);assert.equal(f.c.nextRunAt,null);assert.equal(bodies(f).length,0);assert.ok(f.c.pendingLarkBinding);assert.ok(!f.c.larkBinding);
 const status=await ui(f.a,'connectorBindingResult',{id:f.c.id,operationId:p.operationId});assert.equal(status.status,'superseded');assert.equal(status.committed,true);
 assert.equal(fs.readFileSync(policy.locations(f.a).store,'utf8'),authority);
 await bind(f,true);assert.equal(f.c.enabled,true);assert.ok(!f.c.pendingLarkBinding);
 const oldEvents=JSON.parse(authority).payload.events,newEvents=JSON.parse(fs.readFileSync(policy.locations(f.a).store)).payload.events;
 assert.deepEqual(newEvents.slice(0,oldEvents.length),oldEvents,'fresh binding preserves the committed authority history');
});
test('I14 an actual body arriving across archive/reopen cannot commit or overwrite pause',async t=>{
 const f=await fixture(t);await bind(f,true);const seq=policy.inventory(f.a).sequence;let cycled=false;
 f.a.connectorRequest=async(args,options)=>{const raw=await lark.request(args,options);if(args[0]==='im'&&!cycled){cycled=true;await archiveReopen(f);}return raw;};
 await connectors.sync(f.a,f.c.id);assert.ok(cycled);assert.equal(bodies(f).length,1);assert.equal(f.c.enabled,false);assert.equal(f.c.nextRunAt,null);assert.equal(f.c.health,'paused');assert.equal(f.c.cursor,null);assert.equal(f.a.data.sources.length,0);assert.equal(f.a.data.sourceObservations.length,0);assert.equal(policy.inventory(f.a).sequence,seq);
});
test('I14 old pending without lifecycle facts cannot resume on cold startup',async t=>{
 const f=await fixture(t),p=await f.a.dispatch('connectorIdentityPreview',{id:f.c.id}),commit=policy.commitLarkBinding;
 try{policy.commitLarkBinding=(...args)=>{commit(...args);throw Object.assign(Error('authority response lost'),{committed:true});};await ui(f.a,'connectorBindPrincipal',{id:f.c.id,previewToken:p.previewToken,operationId:p.operationId,enableAfterBind:true});}finally{policy.commitLarkBinding=commit;}
 delete f.c.pendingLarkBinding.projectLifecycleRevision;f.a.save();const authority=fs.readFileSync(policy.locations(f.a).store,'utf8');f.restart();
 assert.equal(connectors.tick(f.a),false);assert.equal(f.c.enabled,false);assert.equal(f.c.nextRunAt,null);assert.equal(bodies(f).length,0);assert.ok(f.c.pendingLarkBinding);assert.ok(!f.c.larkBinding);
 assert.equal((await ui(f.a,'connectorBindingResult',{id:f.c.id,operationId:p.operationId})).status,'superseded');assert.equal(fs.readFileSync(policy.locations(f.a).store,'utf8'),authority);
});
test('I04 old connector and absent health cannot authorize; save and retry issue zero CLI calls',async t=>{const f=await fixture(t);await connectors.sync(f.a,f.c.id);assert.equal(f.events().length,0);assert.equal(f.a.data.sources.length,0);assert.equal(f.c.health,'binding_required');assert.equal(policy.inventory(f.a).sequence,0);});
for(const kind of ['chat','document'])test('I01/I09 actual spawn keeps fixed A across global ABA: '+kind,async t=>{const f=await fixture(t,kind);await bind(f);f.change({aba:true});await connectors.sync(f.a,f.c.id);assert.equal(f.c.health,'healthy',f.c.error);assert.equal(bodies(f).length,kind==='chat'?2:1);assert.ok(bodies(f).every(e=>e.who==='A'&&e.pinned));assert.ok(f.a.data.sources.every(s=>s.larkIdentity.openId==='ou_A'&&s.content.includes('A ')));for(const e of f.events().filter(e=>e.pinned))assert.ok(!fs.existsSync(e.configDir));assert.ok(bodies(f).every(e=>e.home===process.env.HOME&&e.cwd.startsWith(e.configDir)));});
test('I01/I02 partial cursor survives restart, global B does not consume A token',async t=>{const f=await fixture(t);await bind(f);f.change({failAt:2});await connectors.sync(f.a,f.c.id);assert.equal(f.c.cursor.token,'A:1');assert.equal(f.a.data.sources.length,1);f.change({ambient:'B',failAt:null});f.restart();await connectors.sync(f.a,f.c.id);assert.equal(f.c.health,'healthy',f.c.error);assert.equal(f.a.data.sources.length,2);assert.deepEqual(bodies(f).filter(e=>e.token).map(e=>[e.who,e.token]),[['A','A:1'],['A','A:1']]);});
test('I05 explicit rebind archives A cursor and starts B without cross identity version links',async t=>{const f=await fixture(t);await bind(f);f.change({failAt:2});await connectors.sync(f.a,f.c.id);f.change({ambient:'B',failAt:null});await bind(f);assert.equal(f.c.cursor,null);assert.ok(f.c.larkBindingHistory.some(h=>h.cursor?.token==='A:1'));await connectors.sync(f.a,f.c.id);assert.equal(f.c.health,'healthy',f.c.error);assert.ok(f.a.data.sources.filter(s=>s.larkIdentity.openId==='ou_B').every(s=>!s.previousSourceId));assert.ok(bodies(f).filter(e=>e.who==='B').every(e=>!e.token||e.token.startsWith('B:')));});
test('I06 revoked local read after body drops page before observation and does not issue after GET',async t=>{const f=await fixture(t);await bind(f);let revoked=false;f.a.connectorRequest=async(args,options)=>{const raw=await lark.request(args,options);if(args[0]==='im'&&!revoked){revoked=true;const spec=require('../desktop/collection-permissions.cjs').spec('connector',f.c);policy.revoke(f.a,{...spec,operations:['local_read']},{trusted:true,actor:'user_command',command:'revoke'});}return raw;};const before=f.events().length;await connectors.sync(f.a,f.c.id);assert.equal(f.a.data.sources.length,0);assert.equal(f.a.data.sourceObservations.length,0);assert.equal(f.c.cursor,null);assert.equal(f.events().slice(before).filter(e=>e.args[0]==='api').length,1);assert.equal(f.c.health,'permission');});
test('I10 unreviewed native causes zero content; restored native permits normal authorized sync',async t=>{const f=await fixture(t);await bind(f);const target=process.platform==='win32'?f.bin+'.cjs':f.bin,original=fs.readFileSync(target,'utf8');fs.writeFileSync(target,original.replace('version 1.0.65','version 1.0.66'));await connectors.sync(f.a,f.c.id);assert.equal(bodies(f).length,0);assert.equal(f.c.health,'identity_binding_unavailable');fs.writeFileSync(target,original);await connectors.sync(f.a,f.c.id);assert.equal(f.c.health,'healthy',f.c.error);});
test('I11 same preview concurrent confirmation grants once and result query cannot undo later disable',async t=>{const f=await fixture(t),p=await f.a.dispatch('connectorIdentityPreview',{id:f.c.id}),input={id:f.c.id,previewToken:p.previewToken,operationId:p.operationId,enableAfterBind:true};const [a,b]=await Promise.all([f.a.dispatch('connectorBindPrincipal',input),f.a.dispatch('connectorBindPrincipal',input)]);assert.deepEqual(a,b);assert.equal(policy.inventory(f.a).sequence,3);assert.equal(f.c.larkBindingHistory.length,1);await assert.rejects(f.a.dispatch('connectorBindPrincipal',{...input,enableAfterBind:false}));await f.a.dispatch('connectorToggle',{id:f.c.id,enabled:false});const result=await f.a.dispatch('connectorBindingResult',{id:f.c.id,operationId:p.operationId});assert.equal(result.status,'bound');assert.equal(result.enabled,false);assert.equal(policy.inventory(f.a).sequence,3);});
for(const patch of [{missingTenant:true},{wrongTenant:'other_tenant'},{wrongOpenId:'ou_B'},{revoked:'A'}])test('I12 fixed identity unknown/changed cannot dispatch '+JSON.stringify(patch),async t=>{const f=await fixture(t);await bind(f);f.change(patch);await connectors.sync(f.a,f.c.id);assert.equal(bodies(f).length,0);assert.equal(f.a.data.sources.length,0);assert.equal(f.c.cursor,null);});
for(const phase of ['pending','authority','projection'])test('I07 binding save boundary '+phase+' preserves authority and reconciles after restart',async t=>{
 const f=await fixture(t),p=await f.a.dispatch('connectorIdentityPreview',{id:f.c.id}),save=f.a.save.bind(f.a),commit=policy.commitLarkBinding;let injected=false;
 if(phase==='authority')policy.commitLarkBinding=(...args)=>{const result=commit(...args);if(!injected){injected=true;throw Object.assign(Error('lost authority response'),{committed:true});}return result;};
 else f.a.save=()=>{if(!injected&&(phase==='pending'?!!f.c.pendingLarkBinding:!!f.c.larkBinding&&!f.c.pendingLarkBinding)){injected=true;throw Error('synthetic save failure');}return save();};
 let result;try{if(phase==='pending')await assert.rejects(f.a.dispatch('connectorBindPrincipal',{id:f.c.id,previewToken:p.previewToken,operationId:p.operationId}),/synthetic/);else result=await f.a.dispatch('connectorBindPrincipal',{id:f.c.id,previewToken:p.previewToken,operationId:p.operationId});}finally{policy.commitLarkBinding=commit;f.a.save=save;}
 assert.ok(injected);
 if(phase==='pending'){assert.equal(policy.inventory(f.a).sequence,0);assert.ok(!f.c.pendingLarkBinding);await connectors.sync(f.a,f.c.id);assert.equal(bodies(f).length,0);}
 else{assert.equal(result.status,'pending');assert.equal(result.committed,true);assert.equal(policy.inventory(f.a).sequence,3);f.restart();await connectors.sync(f.a,f.c.id);assert.equal(f.c.health,'healthy',f.c.error);assert.equal(f.c.larkBindingHistory.length,1);const grants=JSON.parse(fs.readFileSync(policy.locations(f.a).store)).payload.events.filter(e=>e.commitId===p.operationId);assert.equal(grants.length,3);}
});
test('I07 revoke recorded pending binding before restart prevents recovery from reauthorizing',async t=>{
 const f=await fixture(t),commit=policy.commitLarkBinding;policy.commitLarkBinding=(...args)=>{commit(...args);throw Object.assign(Error('response lost'),{committed:true});};let p;
 try{p=await f.a.dispatch('connectorIdentityPreview',{id:f.c.id});await f.a.dispatch('connectorBindPrincipal',{id:f.c.id,previewToken:p.previewToken,operationId:p.operationId});}finally{policy.commitLarkBinding=commit;}
 const spec=require('../desktop/collection-permissions.cjs').spec('connector',{...f.c,larkBinding:f.c.pendingLarkBinding.binding});policy.revoke(f.a,{...spec,operations:['local_read']},{trusted:true,actor:'user_command',command:'revoke'});const seq=policy.inventory(f.a).sequence;f.restart();await connectors.sync(f.a,f.c.id);assert.equal(bodies(f).length,0);assert.equal(policy.inventory(f.a).sequence,seq);assert.ok(!f.c.larkBinding);
});
test('I06 deletion while actual body is in flight cannot revive connector or save observations',async t=>{
 const f=await fixture(t);await bind(f);const id=f.c.id;f.a.connectorRequest=async(args,options)=>{const value=await lark.request(args,options);if(args[0]==='im')await f.a.dispatch('connectorDelete',{id});return value;};await connectors.sync(f.a,id);assert.equal(f.a.data.connectors.length,0);assert.equal(f.a.data.sources.length,0);assert.equal(f.a.data.sourceObservations.length,0);assert.equal(f.a.data.connectorRuns[0].status,'interrupted');
});
test('I03 changed tenant after body is discarded before any observation write',async t=>{const f=await fixture(t);await bind(f);f.a.connectorRequest=async(args,options)=>{const value=await lark.request(args,options);if(args[0]==='im')f.change({wrongTenant:'tenant_B'});return value;};await connectors.sync(f.a,f.c.id);assert.equal(bodies(f).length,1);assert.equal(f.a.data.sources.length,0);assert.equal(f.a.data.sourceObservations.length,0);assert.equal(f.c.cursor,null);});
test('I06 concurrent sync cannot double-consume a cursor',async t=>{const f=await fixture(t);await bind(f);const results=await Promise.allSettled([connectors.sync(f.a,f.c.id),connectors.sync(f.a,f.c.id)]);assert.equal(results.filter(x=>x.status==='rejected').length,1);assert.equal(f.a.data.sources.length,2);assert.equal(bodies(f).length,2);});

async function waitFor(test,ms=5000){const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw Error('fixture wait expired');await new Promise(r=>setTimeout(r,10));}}
for(const mode of ['close','abort','abort-transient-probe'])test('I13 actual same-group descendant ignores TERM; '+mode+' waits for group exit before session cleanup',async t=>{
 const f=await fixture(t);await bind(f);f.change({descendant:mode});
 const controller=new AbortController();f.a.controller=controller;
 const started=performance.now(),phases=[];f.a.connectorRequest=(args,options)=>{phases.push({op:args[0],ms:performance.now()-started});return lark.request(args,options);};
 const running=connectors.sync(f.a,f.c.id);
 try{await waitFor(()=>fs.existsSync(path.join(f.root,'child-ready'))&&fs.existsSync(path.join(f.root,'group.json')));}
 catch(error){controller.abort();await running.catch(()=>{});throw Object.assign(error,{diagnostic:{phases,elapsedMs:performance.now()-started,health:f.c.health,error:f.c.error,childReady:fs.existsSync(path.join(f.root,'child-ready')),groupReady:fs.existsSync(path.join(f.root,'group.json'))}});}
 t.diagnostic(JSON.stringify({mode,phases,readyMs:performance.now()-started}));
 const group=JSON.parse(fs.readFileSync(path.join(f.root,'group.json')));
 assert.ok(Number.isSafeInteger(group.pid)&&group.pid>0);assert.ok(Number.isSafeInteger(group.child)&&group.child>0);assert.equal(Number(fs.readFileSync(path.join(f.root,'child-ready'),'utf8')),group.child);assert.ok(path.isAbsolute(group.configDir));assert.ok(fs.lstatSync(group.configDir).isDirectory(),'private config must exist before cancellation');
 const originalKill=process.kill,windowsProcess=require('../desktop/windows-process.cjs'),originalConfirmed=windowsProcess.confirmed;let interruptedProbes=0;
 if(mode==='abort-transient-probe'&&process.platform==='win32')windowsProcess.confirmed=child=>{const value=originalConfirmed(child);if(value&&interruptedProbes===0){interruptedProbes++;return false;}return value;};
 else if(mode==='abort-transient-probe')process.kill=(pid,signal)=>{
  try{return originalKill(pid,signal);}catch(error){
   if(pid===-group.pid&&signal===0&&error.code==='ESRCH'&&interruptedProbes===0){interruptedProbes++;throw Object.assign(Error('transient exit observation'),{code:'EPERM'});}
   throw error;
  }
 };
 try{if(mode!=='close')controller.abort(new DOMException('fixture abort','AbortError'));await running;}finally{process.kill=originalKill;windowsProcess.confirmed=originalConfirmed;}
 assert.throws(()=>process.kill(process.platform==='win32'?group.pid:-group.pid,0),{code:'ESRCH'});assert.throws(()=>process.kill(group.child,0),{code:'ESRCH'});if(mode==='abort-transient-probe')assert.equal(interruptedProbes,1,'the transient probe must actually occur');
 const observationError=path.join(f.root,'child-observation-error');
 try{const diagnostic=fs.readFileSync(observationError,'utf8');assert.fail('child config observation failed: '+diagnostic);}catch(error){if(error.code!=='ENOENT')throw error;}
 assert.throws(()=>fs.lstatSync(path.join(f.root,'premature-cleanup')),{code:'ENOENT'},'private config must never disappear while the child is alive');assert.throws(()=>fs.lstatSync(group.configDir),{code:'ENOENT'},'private config must be absent after confirmed group exit, not inaccessible');
 assert.equal(f.a.data.sources.length,0);assert.equal(f.a.data.sourceObservations.length,0);
 if(mode!=='close')assert.equal(f.c.cursor,null);else assert.equal(f.c.health,'healthy',f.c.error);
});
test('I13 unknown process-group exit retains session and refuses body submission',async t=>{
 const f=await fixture(t);await bind(f);const kill=process.kill,windowsProcess=require('../desktop/windows-process.cjs'),confirmed=windowsProcess.confirmed;
 f.a.connectorRequest=async(args,options)=>{
  if(args[0]!=='im')return lark.request(args,options);
  if(process.platform==='win32')windowsProcess.confirmed=()=>false;
  else process.kill=(pid,signal)=>{if(pid<0&&signal===0)throw Object.assign(Error('synthetic exit status unavailable'),{code:'EPERM'});return kill(pid,signal);};
  try{return await lark.request(args,options);}finally{process.kill=kill;windowsProcess.confirmed=confirmed;}
 };
 await connectors.sync(f.a,f.c.id);assert.equal(f.c.health,'identity_binding_unavailable');
 assert.equal(f.a.data.sources.length,0);assert.equal(f.a.data.sourceObservations.length,0);assert.equal(f.c.cursor,null);
 const entry=bodies(f)[0];assert.ok(entry);assert.equal(fs.existsSync(entry.configDir),true);
 // The synthetic child has exited; only the group probe was unavailable.
 // Cleanup here is a test action, never application startup cleanup.
 fs.rmSync(entry.configDir,{recursive:true,force:true});
});
