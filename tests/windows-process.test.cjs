'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const host=require('../desktop/windows-process.cjs'),pin=require('../desktop/lark-pinned-session.cjs'),lark=require('../desktop/lark-connector.cjs');
const windows={skip:process.platform!=='win32'};
function temp(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'行知 Windows 进程 ')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return dir;}
function run(file,args,input){return new Promise((resolve,reject)=>{let out='',err='';const child=host.spawn(file,args,{stdio:['pipe','pipe','pipe']});child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>resolve({code,out,err,confirmed:host.confirmed(child)}));child.stdin.end(input);});}
async function ready(file){const deadline=Date.now()+5000;while(!fs.existsSync(file)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(fs.existsSync(file),'fixture started');return JSON.parse(fs.readFileSync(file));}
test('Windows Job preserves UTF-8, stdin, exact arguments and nonzero exits without a shell',windows,async()=>{
 const args=['中文 空格','a"b','tail\\','semi;&|%PATH%','',String.raw`a\\\"b`];
 const r=await run(process.execPath,['-e',`let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(1),s}));console.error('诊断');process.exitCode=7;});`,...args],'输入正文');
 assert.equal(r.code,7);assert.equal(r.confirmed,true);assert.deepEqual(JSON.parse(r.out),{args,s:'输入正文'});assert.match(r.err,/诊断/);
});
test('Windows Job drains detached descendants after leader exit',windows,async t=>{
 const dir=temp(t),record=path.join(dir,'pid.json');
 const r=await run(process.execPath,['-e',`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(c.pid));c.unref();`]);
 assert.equal(r.code,0);assert.equal(r.confirmed,true);assert.throws(()=>process.kill(JSON.parse(fs.readFileSync(record)),0));
});
test('Windows Job cancellation confirms exit of both leader and detached descendant',windows,async t=>{
 const dir=temp(t),record=path.join(dir,'pid.json');
 const child=host.spawn(process.execPath,['-e',`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(record)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`],{stdio:'ignore'});
 const done=new Promise(r=>child.on('close',r));const pids=await ready(record);assert.equal(child.kill(),true);assert.equal(await done,130);assert.equal(host.confirmed(child),true);for(const pid of pids)assert.throws(()=>process.kill(pid,0));
});
test('Windows private ACLs reject broadened file permissions',windows,t=>{
 const dir=temp(t);host.secure(dir);const file=path.join(dir,'config.json');fs.writeFileSync(file,'{}');host.secure(file);assert.equal(host.check([dir,file]).length,2);
 cp.execFileSync(path.join(process.env.SystemRoot,'System32/icacls.exe'),[file,'/grant','*S-1-1-0:(R)'],{stdio:'pipe',windowsHide:true});
 assert.throws(()=>host.check([file]));host.secure(file);assert.equal(host.check([file]).length,1);
});
test('Windows Lark binds one account, verifies receipts and cleans private sessions',windows,async t=>{
 const dir=temp(t),record=path.join(dir,'seen.json');
 const bin=require('./helpers/native-cli.cjs').write(path.join(dir,'lark-cli'),`
 const fs=require('fs'),path=require('path'),args=process.argv.slice(2),out=v=>console.log(JSON.stringify(v));
 if(args[0]==='--version'){console.log('lark-cli version 1.0.65');process.exit(0);}
 if(args[0]==='auth'){out({appId:'cli_A',brand:'feishu',identities:{user:{openId:'ou_A'}}});process.exit(0);}
 const dir=process.env.LARKSUITE_CLI_CONFIG_DIR,c=JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
 fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({dir,c}));
 if(c.apps.length!==1||c.currentApp!=='cli_A'||c.apps[0].users[0].userOpenId!=='ou_A')process.exit(3);
 if(args[0]==='api')out({ok:true,identity:'user',data:{open_id:'ou_A',tenant_key:'tenant_A'}});
 else out({ok:true,identity:'user',data:{document:{content:'Windows 飞书资料',revision_id:1}}});
 `);
 const prior=process.env.PATH;process.env.PATH=dir+path.delimiter+prior;t.after(()=>process.env.PATH=prior);
 const result=await lark.identityPreview();assert.deepEqual(result.identity,{appId:'cli_A',openId:'ou_A',brand:'feishu',tenantId:'tenant_A'});
 const row=await lark.pinnedPage({kind:'document',target:'https://example.feishu.cn/docx/ABC'},{},{identity:result.identity,assertCurrent:()=>{}});
 assert.equal(row.items[0].content,'Windows 飞书资料');assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(record)).dir),false);
 const cap=await pin.capability(bin),session=pin.create(cap,result.identity.appId?{appId:'cli_A',openId:'ou_A',brand:'feishu'}:{}),details=pin.inspect(session);
 assert.ok(host.check([details.configDir,path.join(details.configDir,'config.json'),details.cwd]));
 fs.writeFileSync(path.join(details.configDir,'config.json'),'{}');assert.throws(()=>pin.inspect(session));pin.close(session);assert.equal(fs.existsSync(details.configDir),false);
});
