// Lark CLI 1.0.65: pin config selection without copying credentials or changing HOME.
// This is a local adapter contract, not protection against a malicious OS user.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const capabilities=new WeakMap(),sessions=new WeakMap();
const unavailable=()=>Object.assign(new Error('当前飞书读取组件无法固定请求账号，请检查受支持的 CLI 后重试。'),{code:'ACCESS_IDENTITY_BINDING_UNAVAILABLE',connectorCode:'identity_binding_unavailable'});
const cleanupFailure=()=>Object.assign(new Error('飞书临时会话清理失败，本轮已停止，请检查本地存储。'),{code:'ACCESS_IDENTITY_SESSION_CLEANUP_FAILED',connectorCode:'identity_binding_unavailable'});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fingerprint(file){
 const real=fs.realpathSync(file),stat=fs.lstatSync(real);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>300_000_000)throw unavailable();
 fs.accessSync(real,fs.constants.R_OK|fs.constants.X_OK);
 return {file:real,dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,mode:stat.mode,hash:hash(fs.readFileSync(real))};
}
function assertNative(info){
 try{if(JSON.stringify(fingerprint(info.file))!==JSON.stringify(info))throw unavailable();}catch{throw unavailable();}
}
function nativePath(entry){
 if(typeof entry!=='string'||!path.isAbsolute(entry))throw unavailable();
 const real=fs.realpathSync(entry);
 // npm's wrapper can download or switch the native file. Never execute it.
 if(path.basename(real)==='run.js'&&path.basename(path.dirname(real))==='scripts'){
  const root=path.dirname(path.dirname(real)),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(pkg.name!=='@larksuite/cli'||pkg.bin?.['lark-cli']!=='scripts/run.js')throw unavailable();
  return fs.realpathSync(path.join(root,'bin',process.platform==='win32'?'lark-cli.exe':'lark-cli'));
 }
 if(/\.(?:c?js|mjs)$/i.test(real))throw unavailable();
 return real;
}
function version(info,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(signal.reason||unavailable());
  // CLI startup resolves config even for --version. An empty private config
  // keeps capability probing out of the ambient account's secret resolution.
  let dir,cwd;
  try{
   dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'xingzhi-lark-version-'));fs.chmodSync(dir,0o700);
   fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({apps:[]}),{flag:'wx',mode:0o600});
   cwd=path.join(dir,'scratch');fs.mkdirSync(cwd,{mode:0o700});
  }catch{
   if(dir)try{fs.rmSync(dir,{recursive:true,force:true});}catch{return reject(cleanupFailure());}
   return reject(unavailable());
  }
  const env={};for(const key of ['HOME','PATH','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1';env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1';
  env.LARKSUITE_CLI_CONFIG_DIR=dir;
  const child=spawn(info.file,['--version'],{env,cwd,detached:true,stdio:['ignore','pipe','pipe']});
  let output='',error,killTimer;
  const kill=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer ||= setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);};
  const groupAlive=()=>{if(!Number.isSafeInteger(child.pid))return false;try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
  const abort=()=>{error=signal.reason||unavailable();kill();};
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{error=unavailable();kill();},10000);
  child.stdout.on('data',chunk=>{if(output.length+chunk.length>16000){error=unavailable();kill();}else output+=chunk.toString();});
  child.stderr.resume(); // Never return or persist raw diagnostics from a subprocess.
  child.on('error',()=>{error=unavailable();});
  child.on('close',async code=>{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   // A leader with detached stdio can close while its same-group child lives.
   // Keep escalation and the private config until the whole group is gone.
   if(groupAlive())kill();
   const deadline=Date.now()+3000;while(groupAlive()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
   clearTimeout(killTimer);
   if(groupAlive())return reject(Object.assign(new Error('无法确认飞书探测进程已退出，已保留临时配置并停止本轮。'),{code:'ACCESS_IDENTITY_PROCESS_EXIT_UNCONFIRMED',connectorCode:'identity_binding_unavailable'}));
   try{fs.rmSync(dir,{recursive:true,force:true});}catch{return reject(cleanupFailure());}
   if(error)return reject(error);
   if(code!==0||output.trim()!=='lark-cli version 1.0.65')return reject(unavailable());
   resolve();
  });
  if(signal?.aborted)abort();
 });
}
async function capability(executablePath,{signal}={}){
 signal?.throwIfAborted();let info;
 try{info=fingerprint(nativePath(executablePath));}catch{throw unavailable();}
 await version(info,signal);signal?.throwIfAborted();assertNative(info);
 const handle=Object.freeze({});capabilities.set(handle,info);return handle;
}
function identity(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['appId','openId','brand'].includes(k))||
  typeof value.appId!=='string'||!/^cli_[A-Za-z0-9_-]{1,120}$/.test(value.appId)||
  typeof value.openId!=='string'||!/^ou_[A-Za-z0-9_-]{1,120}$/.test(value.openId)||!['feishu','lark'].includes(value.brand))throw unavailable();
 return {appId:value.appId,openId:value.openId,brand:value.brand};
}
function location(file,type,mode){
 const s=fs.lstatSync(file);
 if(s.isSymbolicLink()||!(type==='directory'?s.isDirectory():s.isFile())||(s.mode&0o777)!==mode||fs.realpathSync(file)!==file)throw unavailable();
 return {dev:s.dev,ino:s.ino};
}
function sameLocation(file,type,mode,expected){if(JSON.stringify(location(file,type,mode))!==JSON.stringify(expected))throw unavailable();}
function create(handle,metadata,{signal}={}){
 signal?.throwIfAborted();const info=capabilities.get(handle);if(!info)throw unavailable();assertNative(info);
 const {appId,openId,brand}=identity(metadata);
 const config=JSON.stringify({strictMode:'user',currentApp:appId,apps:[{appId,brand,defaultAs:'user',appSecret:{source:'keychain',id:'appsecret:'+appId},users:[{userOpenId:openId}]}]});
 let dir;
 try{
  dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'xingzhi-lark-session-'));fs.chmodSync(dir,0o700);
  const file=path.join(dir,'config.json'),cwd=path.join(dir,'scratch');
  fs.writeFileSync(file,config,{flag:'wx',mode:0o600});fs.chmodSync(file,0o600);fs.mkdirSync(cwd,{mode:0o700});fs.chmodSync(cwd,0o700);
  const session=Object.freeze({});sessions.set(session,{info,dir,file,cwd,dirLocation:location(dir,'directory',0o700),fileLocation:location(file,'file',0o600),cwdLocation:location(cwd,'directory',0o700),configHash:hash(config),closed:false});return session;
 }catch{
  if(dir)try{fs.rmSync(dir,{recursive:true,force:true});}catch{throw cleanupFailure();}
  throw unavailable();
 }
}
function inspect(handle){
 const candidate=capabilities.get(handle);
 if(candidate){assertNative(candidate);return {kind:'candidate',executablePath:candidate.file};}
 const s=sessions.get(handle);if(!s||s.closed)throw unavailable();assertNative(s.info);
 try{
  sameLocation(s.dir,'directory',0o700,s.dirLocation);sameLocation(s.file,'file',0o600,s.fileLocation);sameLocation(s.cwd,'directory',0o700,s.cwdLocation);
  if(fs.statSync(s.file).size>4096)throw unavailable();
  if(hash(fs.readFileSync(s.file))!==s.configHash)throw unavailable();
 }catch{throw unavailable();}
 return {kind:'pinned',executablePath:s.info.file,configDir:s.dir,cwd:s.cwd};
}
function close(handle){
 const s=sessions.get(handle);if(!s)throw unavailable();if(s.closed)return;s.closed=true;
 // The transport must have observed every child exit before calling close.
 // If the root was replaced, never recursively remove someone else's directory.
 try{
  if(!fs.existsSync(s.dir))return;
  sameLocation(s.dir,'directory',0o700,s.dirLocation);fs.rmSync(s.dir,{recursive:true,force:true});
 }catch{throw cleanupFailure();}
}
module.exports={capability,create,inspect,close};
