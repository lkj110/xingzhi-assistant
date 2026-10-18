const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const pin=require('../desktop/lark-pinned-session.cjs');
const denied=e=>e.code==='ACCESS_IDENTITY_BINDING_UNAVAILABLE';
const account={appId:'cli_A',openId:'ou_A',brand:'feishu'};
function fixture(t,body="console.log('lark-cli version 1.0.65')"){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p1-pin-test-'))),bin=path.join(dir,'lark-cli');
 fs.writeFileSync(bin,`#!${process.execPath}\n${body}\n`,{mode:0o700});t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,bin};
}
function session(t,cap,metadata=account){const s=pin.create(cap,metadata);t.after(()=>{try{pin.close(s);}catch{}});return s;}
test('supported CLI creates one private account config and keeps HOME/global profile untouched',async t=>{
 const {dir,bin}=fixture(t),home=process.env.HOME,profile=path.join(dir,'global-config.json');fs.writeFileSync(profile,'global profile B');
 const cap=await pin.capability(bin),candidate=pin.inspect(cap);assert.equal(candidate.kind,'candidate');assert.equal(candidate.configDir,undefined);
 const s=session(t,cap),transport=pin.inspect(s),configFile=path.join(transport.configDir,'config.json'),config=JSON.parse(fs.readFileSync(configFile));
 assert.equal(transport.kind,'pinned');assert.equal(transport.executablePath,fs.realpathSync(bin));
 assert.equal(fs.statSync(transport.configDir).mode&0o777,0o700);assert.equal(fs.statSync(configFile).mode&0o777,0o600);assert.equal(fs.statSync(transport.cwd).mode&0o777,0o700);
 assert.deepEqual(config,{strictMode:'user',currentApp:'cli_A',apps:[{appId:'cli_A',brand:'feishu',defaultAs:'user',appSecret:{source:'keychain',id:'appsecret:cli_A'},users:[{userOpenId:'ou_A'}]}]});
 assert.equal(process.env.HOME,home);assert.equal(fs.readFileSync(profile,'utf8'),'global profile B');
 assert.equal(JSON.stringify(s),'{}');pin.close(s);pin.close(s);assert.equal(fs.existsSync(transport.configDir),false);assert.throws(()=>pin.inspect(s),denied);
});
test('npm wrapper resolves only its existing native and never executes or downloads',async t=>{
 const {dir,bin}=fixture(t),root=path.join(dir,'package'),marker=path.join(dir,'wrapper-executed');fs.mkdirSync(path.join(root,'scripts'),{recursive:true});fs.mkdirSync(path.join(root,'bin'));
 const wrapper=path.join(root,'scripts/run.js');fs.writeFileSync(wrapper,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'executed');\n`,{mode:0o700});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@larksuite/cli',version:'1.0.65',bin:{'lark-cli':'scripts/run.js'}}));
 const native=path.join(root,'bin/lark-cli');fs.copyFileSync(bin,native);fs.chmodSync(native,0o700);
 assert.equal(pin.inspect(await pin.capability(wrapper)).executablePath,native);assert.equal(fs.existsSync(marker),false);
 fs.unlinkSync(native);await assert.rejects(pin.capability(wrapper),denied);assert.equal(fs.existsSync(marker),false);
});
test('unsupported version, missing file and unrecognized JS wrapper reject capability',async t=>{
 const {dir,bin}=fixture(t,"console.log('lark-cli version 1.0.66')");await assert.rejects(pin.capability(bin),denied);
 await assert.rejects(pin.capability(path.join(dir,'missing')),denied);await assert.rejects(pin.capability('relative'),denied);
 const wrapper=path.join(dir,'other.js');fs.copyFileSync(bin,wrapper);await assert.rejects(pin.capability(wrapper),denied);
});
test('native mutation during version probe and after capability invalidates it',async t=>{
 const first=fixture(t,"require('fs').appendFileSync(__filename,'\\n// changed');console.log('lark-cli version 1.0.65')");await assert.rejects(pin.capability(first.bin),denied);
 const {bin}=fixture(t),cap=await pin.capability(bin),s=session(t,cap);fs.appendFileSync(bin,'\n// native changed');
 assert.throws(()=>pin.inspect(cap),denied);assert.throws(()=>pin.inspect(s),denied);assert.throws(()=>pin.create(cap,account),denied);
});
test('copied, serialized and invented handles cannot authorize a transport',async t=>{
 const {bin}=fixture(t),cap=await pin.capability(bin),s=session(t,cap);
 for(const handle of [{},JSON.parse(JSON.stringify(cap)),{...s},null,'session']){assert.throws(()=>pin.inspect(handle),denied);assert.throws(()=>pin.create(handle,account),denied);}
 assert.throws(()=>pin.close(cap),denied);
});
test('identity accepts only public app/openID/brand fields',async t=>{
 const {bin}=fixture(t),cap=await pin.capability(bin);
 for(const input of [null,{},[],{...account,brand:'custom'},{...account,appId:'../../other'},{...account,openId:'x'},{...account,openId:'ou_'+'a'.repeat(121)},{...account,token:'fixture-secret'},{...account,appSecret:'fixture-secret'}])assert.throws(()=>pin.create(cap,input),denied);
 const s=session(t,cap,{...account,brand:'lark'});assert.equal(JSON.parse(fs.readFileSync(path.join(pin.inspect(s).configDir,'config.json'))).apps[0].brand,'lark');
});
test('config mutation and permissions fail before transport while independent session survives',async t=>{
 const {bin}=fixture(t),cap=await pin.capability(bin),one=session(t,cap),two=session(t,cap,{...account,openId:'ou_B'}),a=pin.inspect(one),b=pin.inspect(two);
 assert.notEqual(a.configDir,b.configDir);fs.writeFileSync(path.join(a.configDir,'config.json'),'{}');assert.throws(()=>pin.inspect(one),denied);
 assert.equal(pin.inspect(two).configDir,b.configDir);fs.chmodSync(path.join(b.configDir,'config.json'),0o644);assert.throws(()=>pin.inspect(two),denied);
 pin.close(one);assert.equal(fs.existsSync(b.configDir),true);
});
test('config symlink is rejected and cleanup never follows it',async t=>{
 const {dir,bin}=fixture(t),cap=await pin.capability(bin),s=session(t,cap),transport=pin.inspect(s),outside=path.join(dir,'outside');fs.writeFileSync(outside,'untouched',{mode:0o600});
 const file=path.join(transport.configDir,'config.json');fs.unlinkSync(file);fs.symlinkSync(outside,file);assert.throws(()=>pin.inspect(s),denied);pin.close(s);assert.equal(fs.readFileSync(outside,'utf8'),'untouched');
});
test('replaced session root is not recursively deleted',async t=>{
 const {bin}=fixture(t),s=session(t,await pin.capability(bin)),transport=pin.inspect(s),moved=transport.configDir+'-moved';
 fs.renameSync(transport.configDir,moved);fs.mkdirSync(transport.configDir,{mode:0o700});fs.writeFileSync(path.join(transport.configDir,'other'),'keep');
 t.after(()=>{fs.rmSync(moved,{recursive:true,force:true});fs.rmSync(transport.configDir,{recursive:true,force:true});});
 assert.throws(()=>pin.inspect(s),denied);assert.throws(()=>pin.close(s),e=>e.code==='ACCESS_IDENTITY_SESSION_CLEANUP_FAILED');pin.close(s);
 assert.equal(fs.readFileSync(path.join(transport.configDir,'other'),'utf8'),'keep');
});
test('creation failure cleans its private directory and cleanup failure invalidates handle',async t=>{
 const {bin}=fixture(t),cap=await pin.capability(bin),write=fs.writeFileSync;let created;
 try{fs.writeFileSync=function(file,...args){if(String(file).endsWith('/config.json')){created=path.dirname(file);throw Error('fixture disk full');}return write.call(this,file,...args);};assert.throws(()=>pin.create(cap,account),denied);}finally{fs.writeFileSync=write;}
 assert.ok(created);assert.equal(fs.existsSync(created),false);
 const s=session(t,cap),transport=pin.inspect(s),rm=fs.rmSync;
 try{fs.rmSync=function(file,...args){if(file===transport.configDir)throw Error('fixture EIO');return rm.call(this,file,...args);};assert.throws(()=>pin.close(s),e=>e.code==='ACCESS_IDENTITY_SESSION_CLEANUP_FAILED');}finally{fs.rmSync=rm;}
 assert.throws(()=>pin.inspect(s),denied);pin.close(s);fs.rmSync(transport.configDir,{recursive:true,force:true});
});
test('version probe replaces account overrides with its own empty private config',async t=>{
 const {dir,bin}=fixture(t),record=path.join(dir,'probe.json');fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs'),path=require('path'),configDir=process.env.LARKSUITE_CLI_CONFIG_DIR;fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),configDir,config:JSON.parse(fs.readFileSync(path.join(configDir,'config.json'))),overrides:['LARKSUITE_CLI_AUTH_PROXY','OPENCLAW_HOME','FEISHU_APP_SECRET'].filter(k=>process.env[k])}));console.log('lark-cli version 1.0.65');\n`,{mode:0o700});
 const keys=['LARKSUITE_CLI_CONFIG_DIR','LARKSUITE_CLI_AUTH_PROXY','OPENCLAW_HOME','FEISHU_APP_SECRET'],prior=keys.map(k=>process.env[k]);
 try{keys.forEach(k=>process.env[k]='fixture-override');await pin.capability(bin);}finally{keys.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});}
 const observed=JSON.parse(fs.readFileSync(record));assert.deepEqual(observed.args,['--version']);assert.deepEqual(observed.overrides,[]);assert.deepEqual(observed.config,{apps:[]});assert.notEqual(observed.configDir,'fixture-override');assert.equal(fs.existsSync(observed.configDir),false);
});
test('abort waits for version child exit and leaves no usable capability',async t=>{
 const {dir,bin}=fixture(t),record=path.join(dir,'pid');fs.writeFileSync(bin,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(record)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);\n`,{mode:0o700});
 const controller=new AbortController(),pending=pin.capability(bin,{signal:controller.signal});const rejection=assert.rejects(pending,e=>e.name==='AbortError');
 const deadline=Date.now()+5000;while(!fs.existsSync(record)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));controller.abort();await rejection;assert.ok(fs.existsSync(record),'version child started');
 assert.throws(()=>process.kill(Number(fs.readFileSync(record,'utf8')),0),e=>e.code==='ESRCH');
 await assert.rejects(pin.capability(bin,{signal:controller.signal}),e=>e.name==='AbortError');
});
test('cold process cannot rehydrate a session from its serialized handle',async t=>{
 const {dir,bin}=fixture(t),script=path.join(dir,'create.cjs'),mod=path.resolve(__dirname,'../desktop/lark-pinned-session.cjs');
 fs.writeFileSync(script,`const p=require(${JSON.stringify(mod)});(async()=>{const s=p.create(await p.capability(${JSON.stringify(bin)}),${JSON.stringify(account)});console.log(JSON.stringify({handle:s,...p.inspect(s)}));})();`);
 const old=JSON.parse(cp.execFileSync(process.execPath,[script],{encoding:'utf8'}));t.after(()=>fs.rmSync(old.configDir,{recursive:true,force:true}));
 assert.throws(()=>pin.inspect(old.handle),denied);const next=session(t,await pin.capability(bin));assert.notEqual(pin.inspect(next).configDir,old.configDir);
});
for(const mode of ['plain','file','keychain'])test('version probe avoids ambient '+mode+' secret resolution without changing HOME',async t=>{
 const {dir,bin}=fixture(t),home=path.join(dir,'home'),ambient=path.join(home,'.lark-cli'),record=path.join(dir,'config-observation');fs.mkdirSync(ambient,{recursive:true});
 fs.writeFileSync(path.join(ambient,'config.json'),JSON.stringify({apps:[{appId:'cli_A',appSecret:mode==='plain'?'synthetic-secret':{source:mode,id:'synthetic-secret-ref'}}]}));
 fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs'),path=require('path');const selected=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR||path.join(process.env.HOME,'.lark-cli'),'config.json'),config=JSON.parse(fs.readFileSync(selected));fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({home:process.env.HOME,secretResolutions:config.apps.filter(a=>a.appSecret).length,selected}));console.log('lark-cli version 1.0.65');\n`,{mode:0o700});
 const previous=process.env.HOME;try{process.env.HOME=home;await pin.capability(bin);}finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
 const result=JSON.parse(fs.readFileSync(record));assert.equal(result.home,home);assert.equal(result.secretResolutions,0);assert.notEqual(result.selected,path.join(ambient,'config.json'));assert.equal(fs.existsSync(path.dirname(result.selected)),false);
});
test('cancellation retains private config until same-group descendants have exited',async t=>{
 const {dir,bin}=fixture(t),ready=path.join(dir,'ready'),record=path.join(dir,'group.json'),grand=path.join(dir,'grand.cjs');
 fs.writeFileSync(grand,`process.on('SIGTERM',()=>{});const fs=require('fs'),ready=${JSON.stringify(ready)};setInterval(()=>{},100);setTimeout(()=>process.exit(0),8000);fs.writeFileSync(ready+'.tmp',String(process.pid));fs.renameSync(ready+'.tmp',ready);`);
 fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),child=cp.spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:'ignore'});child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);const record=${JSON.stringify(record)};fs.writeFileSync(record+'.tmp',JSON.stringify({pid:process.pid,child:child.pid,configDir:process.env.LARKSUITE_CLI_CONFIG_DIR}));fs.renameSync(record+'.tmp',record);}},10);setInterval(()=>{},100);setTimeout(()=>process.exit(0),8000);\n`,{mode:0o700});
 const controller=new AbortController(),pending=pin.capability(bin,{signal:controller.signal}),rejected=assert.rejects(pending,e=>e.name==='AbortError');
 let observed;
 try{
  const deadline=Date.now()+5000;while(!fs.existsSync(record)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(fs.existsSync(record),'complete group record must be published before cancellation');
  observed=JSON.parse(fs.readFileSync(record));assert.ok(Number.isSafeInteger(observed.pid)&&observed.pid>0);assert.ok(Number.isSafeInteger(observed.child)&&observed.child>0);assert.equal(Number(fs.readFileSync(ready,'utf8')),observed.child);assert.ok(path.isAbsolute(observed.configDir));assert.ok(fs.lstatSync(observed.configDir).isDirectory());
 }finally{controller.abort();await rejected;}
 assert.throws(()=>process.kill(observed.child,0),{code:'ESRCH'},'cancelled child must have exited');assert.throws(()=>fs.lstatSync(observed.configDir),{code:'ENOENT'},'private config must be absent, not inaccessible');
});
