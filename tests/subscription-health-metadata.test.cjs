const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{spawn}=require('node:child_process');
function controlled(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'subscription-health-metadata-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bin=path.join(dir,'codex'),config=path.join(dir,'config.toml'),cache=path.join(dir,'models_cache.json');
 fs.writeFileSync(bin,"const args=process.argv.slice(2);if(args[0]==='--version')console.log('codex-cli 0.0.0-test');else if(args.join(' ')==='login status')console.log('Logged in using ChatGPT');else process.exit(99);");
 fs.writeFileSync(config,'model = "controlled"\nmodel_reasoning_effort = "medium"\n');fs.writeFileSync(cache,JSON.stringify({models:[{slug:'controlled',visibility:'list'}]}));
 const filename=path.resolve(__dirname,'../desktop/subscription.cjs'),realRequire=createRequire(filename),reads=[],calls=[],accesses=[],faults=new Map(),env={PATH:dir,HOME:dir,CODEX_HOME:dir,HTTPS_PROXY:'http://PRIVATE_PROXY:SECRET@127.0.0.1:1234'};
 const fakeFS={...fs,statSync(file){if(String(file).endsWith('/codex')&&file!==bin)throw Object.assign(Error('missing'),{code:'ENOENT'});return fs.statSync(file);},accessSync(file){if(file===bin)return;return fs.accessSync(file);},readFileSync(file,...args){reads.push(String(file));assert.notEqual(path.basename(file),'auth.json');return fs.readFileSync(file,...args);}};
 for(const name of ['statSync','realpathSync','accessSync','readFileSync']){const original=fakeFS[name];fakeFS[name]=(file,...args)=>{accesses.push({operation:name,file});if(faults.has(file))throw Object.assign(Error('controlled filesystem error'),{code:faults.get(file)});return original(file,...args);};}
 const context={module:{exports:{}},process:{env,kill:process.kill.bind(process)},Buffer,setTimeout,clearTimeout,require:n=>n==='node:fs'?fakeFS:n==='node:child_process'?{spawn:(file,args,options)=>{assert.equal(file,bin);calls.push(args);return spawn(process.execPath,[bin,...args],options);}}:realRequire(n)};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
 return {module:context.module.exports,dir,bin,config,cache,env,reads,calls,accesses,faults};
}
test('actual CLI file/config/env identity changes without reading tokens or configuration bodies',t=>{
 const f=controlled(t);let previous=f.module.identity();assert.deepEqual(f.reads,[]);assert.ok(!JSON.stringify(previous).includes('PRIVATE'));
 fs.appendFileSync(f.bin,'\n// local replacement');let next=f.module.identity();assert.notEqual(next.cliHash,previous.cliHash);previous=next;
 fs.appendFileSync(f.config,'model_verbosity = "low"\n');next=f.module.identity();assert.notEqual(next.configurationHash,previous.configurationHash);previous=next;
 f.env.LANG='new-language';next=f.module.identity();assert.notEqual(next.configurationHash,previous.configurationHash);previous=next;
 fs.appendFileSync(f.cache,' ');next=f.module.identity();assert.deepEqual(next,previous);previous=next;
 const replacement=f.bin+'-replacement';fs.copyFileSync(f.bin,replacement);fs.renameSync(replacement,f.bin);next=f.module.identity();assert.notEqual(next.cliHash,previous.cliHash);previous=next;
 fs.renameSync(f.bin,replacement);fs.symlinkSync(replacement,f.bin);next=f.module.identity();assert.notEqual(next.cliHash,previous.cliHash);
 assert.deepEqual(f.reads,[]);assert.deepEqual(f.calls,[]);
 assert.ok(f.accesses.every(v=>v.file!==f.cache));
});
test('subscription health status executes only controlled version and login-status children',async t=>{
 const f=controlled(t),result=await f.module.status();assert.equal(result.installed,true);assert.equal(result.loggedIn,true);assert.equal(result.model,'controlled');
 assert.deepEqual(f.calls.map(a=>Array.from(a)),[['--version'],['login','status']]);assert.ok(f.reads.every(p=>['config.toml','models_cache.json'].includes(path.basename(p))));
});
test('failed version child cannot produce a successful health observation despite login success',async t=>{
 const f=controlled(t);fs.appendFileSync(f.bin,"\nif(args[0]==='--version')process.exitCode=7;\n");
 await assert.rejects(f.module.status(),e=>e.code==='MODEL_CONFIG');assert.deepEqual(f.calls.map(a=>Array.from(a)),[['--version'],['login','status']]);
});
test('health identity never reads provider secrets or invokes recovery modules',t=>{
 const health=require('../desktop/subscription-health.cjs'),subscription=require('../desktop/subscription.cjs');
 const f=controlled(t);t.mock.method(subscription,'identity',f.module.identity);
 const provider={id:'codex',type:'codex',model:'controlled'};Object.defineProperty(provider,'sealedKey',{get(){throw Error('must not read token');}});
 const result=health.identity({data:{providers:[provider],settings:{roles:{execute:'codex'}},tasks:[]}});assert.match(result.configurationHash,/^[0-9a-f]{64}$/);assert.match(result.intentHash,/^[0-9a-f]{64}$/);
});

function healthFixture(t){
 const f=controlled(t),health=require('../desktop/subscription-health.cjs'),subscription=require('../desktop/subscription.cjs'),journal=require('../desktop/work-journal.cjs');
 const failedAt=new Date(Date.now()-60000).toISOString();
 const data={tasks:[{id:'task'}],delegations:[],providers:[{id:'codex',type:'codex',model:'controlled'}],settings:{roles:{execute:'codex'}},runtime:{}};
 const install=data=>({dir:f.dir,file:path.join(f.dir,'workspace.json'),data,save(){fs.writeFileSync(this.file,JSON.stringify(this.data));},dispatch(action){assert.equal(action,'subscriptionStatus');return health.check(this);}});
 const a=install(data);journal.initialize(a,{migrate:true});
 // Only IO is controlled; the CLI/config/env hashing algorithm is the real one.
 t.mock.method(subscription,'identity',f.module.identity);
 t.mock.method(subscription,'status',async()=>({installed:true,loggedIn:true}));
 return {...f,a,health,subscription,failedAt,run:()=>require('../desktop/workspace-view.cjs').command(a,{action:'subscriptionStatus'}),restart:()=>{const b=install(JSON.parse(fs.readFileSync(a.file)));journal.initialize(b);return b;}};
}
const cacheMutations={
 'same-content rewrite':f=>fs.writeFileSync(f.cache,fs.readFileSync(f.cache)),
 'same-content atomic replacement':f=>{const old=fs.statSync(f.cache);fs.copyFileSync(f.cache,f.cache+'.next');fs.renameSync(f.cache+'.next',f.cache);assert.notEqual(fs.statSync(f.cache).ino,old.ino);},
 whitespace:f=>fs.appendFileSync(f.cache,' \n\t'),
 removal:f=>fs.unlinkSync(f.cache),
 addition:f=>{fs.unlinkSync(f.cache);assert.ok(f.health.valid(f.a,{after:f.failedAt})||f.health.receipt(f.a).status==='pending');fs.writeFileSync(f.cache,'{"models":[]}');},
 'model change':f=>fs.writeFileSync(f.cache,'{"models":[{"slug":"new-model","visibility":"list"}]}'),
 'model removal':f=>fs.writeFileSync(f.cache,'{"models":[]}'),
 malformed:f=>fs.writeFileSync(f.cache,'{ broken JSON'),
 'unsupported schema':f=>fs.writeFileSync(f.cache,'{"models":{"unexpected":true},"version":-1}'),
 permissions:f=>fs.chmodSync(f.cache,0o000),
 unreadable:f=>f.faults.set(f.cache,'EACCES'),
 'unsupported filesystem':f=>f.faults.set(f.cache,'ENOTSUP'),
};
for(const [name,mutate]of Object.entries(cacheMutations))for(const timing of ['during','after'])test(`cache ${name} ${timing} check preserves real identity and durable health`,async t=>{
 const f=healthFixture(t),before=f.module.identity();
 if(timing==='during')t.mock.method(f.subscription,'status',async()=>{mutate(f);return {installed:true,loggedIn:true};});
 const result=await f.run();assert.equal(result.health?.status,'success');
 if(timing==='after')mutate(f);
 assert.deepEqual(f.module.identity(),before);assert.equal(f.health.valid(f.a,{after:f.failedAt})?.checkId,result.health.checkId);
 assert.equal(f.health.valid(f.restart(),{after:f.failedAt})?.checkId,result.health.checkId);
 assert.ok(f.accesses.every(v=>v.file!==f.cache),'identity must not stat, resolve, open or read cache');assert.deepEqual(f.reads,[]);assert.deepEqual(f.calls,[]);
});
const realMutations={
 'CLI content':f=>fs.appendFileSync(f.bin,'\n// changed CLI'),
 'CLI atomic replacement':f=>{fs.copyFileSync(f.bin,f.bin+'.next');fs.renameSync(f.bin+'.next',f.bin);},
 'config content':f=>fs.appendFileSync(f.config,'verbosity = "low"\n'),
 'config atomic replacement':f=>{fs.copyFileSync(f.config,f.config+'.next');fs.renameSync(f.config+'.next',f.config);},
 'config unreadable':f=>f.faults.set(f.config,'EACCES'),
 'allowlisted environment':f=>{f.env.LANG='zh_CN.UTF-8';},
 provider:f=>{f.a.data.providers[0].model='changed';},
 routing:f=>{f.a.data.modelRouting={enabled:true,economyId:'different'};},
 intent:f=>{f.a.data.tasks[0].evidenceConsumption={attempts:{old:{requests:[{requestId:'original',errorCode:'MODEL_AUTH'}]}}};},
};
for(const [name,mutate]of Object.entries(realMutations))for(const timing of ['during','after'])test(`${name} change ${timing} check still invalidates real health`,async t=>{
 const f=healthFixture(t);
 if(timing==='during')t.mock.method(f.subscription,'status',async()=>{mutate(f);return {installed:true,loggedIn:true};});
 const result=await f.run();
 if(timing==='after'){assert.equal(result.health?.status,'success');mutate(f);f.a.save();}else assert.equal(result.health,null);
 assert.equal(f.health.valid(f.a,{after:f.failedAt}),null);assert.equal(f.health.valid(f.restart(),{after:f.failedAt}),null);assert.deepEqual(f.calls,[]);
});
