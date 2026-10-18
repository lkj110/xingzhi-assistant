const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const pinned=require('./lark-pinned-session.cjs');
const requestReceipts=new WeakMap(),pageReceipts=new WeakMap(),unsafeSessions=new WeakSet();
const identityArgs=['api','GET','/open-apis/authen/v1/user_info','--as','user','--format','json'];
const identityError=(code='ACCESS_PRINCIPAL_UNKNOWN')=>Object.assign(Error('飞书固定账号或租户无法核验，请重新预览绑定'),{code,connectorCode:'auth'});
const bindingError=()=>Object.assign(Error('飞书请求缺少有效固定会话'),{code:'ACCESS_IDENTITY_BINDING_UNAVAILABLE',connectorCode:'identity_binding_unavailable'});

function executable() {
  const dirs = [...String(process.env.PATH || '').split(path.delimiter).filter(p=>path.isAbsolute(p)), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
  const nvm = path.join(os.homedir(), '.nvm/versions/node');
  try { for (const name of fs.readdirSync(nvm).filter(n=>/^v\d+\.\d+\.\d+$/.test(n)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).slice(0,10)) dirs.push(path.join(nvm,name,'bin')); } catch {}
  for (const dir of dirs) try { const file=path.join(dir,'lark-cli'); if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);return file;} } catch {}
  throw Object.assign(new Error('未找到飞书 CLI。请安装 lark-cli 后重新检测。'),{connectorCode:'missing_cli'});
}
function failure(data) {
  const code=String(data?.error?.type||'')+' '+String(data?.error?.subtype||'')+' '+String(data?.error?.code||'')+' '+String(data?.error?.message||'');
  if(/permission|scope|forbidden|99991672|1770032|10699/i.test(code))return Object.assign(new Error('飞书权限不足，请检查文档访问权限及应用读取权限。'),{connectorCode:'permission',permissionKind:/scope|99991672|permission_violations/i.test(code+JSON.stringify(data?.error?.permission_violations||''))?'scope':'resource'});
  if(/auth|token|login|missing.*user|user.*missing|9999166|9999167|9999168/i.test(code))return Object.assign(new Error('飞书用户登录已失效，请重新登录后点击重试。'),{connectorCode:'auth'});
  if(/page.token|page_token|pagination/i.test(code))return Object.assign(new Error('飞书分页凭据已失效，下次会从本轮起点重读并去重。'),{connectorCode:'cursor'});
  return Object.assign(new Error('飞书读取失败。请检查网络、资源地址和 CLI 版本后重试。'),{connectorCode:'connection'});
}
function request(args,{signal,timeoutMs=60000,input,cliCapability,pinnedSession}={}) {
  if(input!==undefined&&(typeof input!=='string'||Buffer.byteLength(input)>1000000))throw Error('飞书写入正文须小于 1 MB');
  if(cliCapability&&pinnedSession)throw bindingError();
  const handle=pinnedSession||cliCapability,transport=handle?pinned.inspect(handle):null;
  if(cliCapability&&(transport.kind!=='candidate'||JSON.stringify(args)!==JSON.stringify(['auth','status','--json'])))throw bindingError();
  if(pinnedSession&&(transport.kind!=='pinned'||input!==undefined||!pinnedReadArgs(args)))throw bindingError();
  const bin=transport?.executablePath||executable();
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const env={};for(const key of ['HOME','PATH','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];
    env.PATH=path.dirname(bin)+path.delimiter+(env.PATH||'/usr/bin:/bin');
    env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1';env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1';
    if(pinnedSession)env.LARKSUITE_CLI_CONFIG_DIR=transport.configDir;
    // Inspect immediately before spawn: no await or PATH lookup may select another binary.
    if(handle)pinned.inspect(handle);
    const child=spawn(bin,args,{env,stdio:[input===undefined?'ignore':'pipe','pipe','pipe'],detached:true,cwd:transport?.cwd||os.tmpdir()});
    if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
    let chunks=[],bytes=0,error,killTimer,diagnostic='';
    const kill=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer ||= setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);};
    const abort=()=>{error=signal.reason||new Error('飞书同步已停止');kill();};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{error=Object.assign(new Error('飞书请求等待超时，已保留进度，可重新检查。'),{connectorCode:'connection'});kill();},timeoutMs);
    child.stdout.on('data',b=>{bytes+=b.length;if(bytes>4_000_000){error=new Error('飞书响应超过 4 MB，请缩小来源范围');kill();}else chunks.push(b);});
    child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-64000);}); // Used only for classification; never returned or persisted.
    child.on('error',()=>{error=new Error('无法启动飞书 CLI，请检查安装');});
    child.on('close',async code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);
      try{await drainGroup(child.pid);}catch(e){if(pinnedSession)unsafeSessions.add(pinnedSession);error=e;}finally{clearTimeout(killTimer);}
      if(error)return reject(error);
      let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{try{value=JSON.parse(diagnostic);}catch{return reject(failure({error:{message:diagnostic.slice(0,4000)}}));}}
      if(code!==0||value.ok===false)return reject(failure(value));
      if(handle){try{pinned.inspect(handle);}catch(e){return reject(e);}if(!value||typeof value!=='object')return reject(bindingError());requestReceipts.set(value,{handle});}
      resolve(value);
    });
    if(signal?.aborted)abort();
  });
}
async function status(run=request) {
  try { const value=await run(['auth','status','--json','--verify']);const user=value.identities?.user;
    const loggedIn=user?.available===true&&(user.status==='ready'||user.status==='needs_refresh'&&user.verified===true&&value.verified===true)&&user.verified!==false&&value.verified!==false;
    return {installed:true,loggedIn,...(loggedIn?{openId:user.openId||null,userName:user.userName||null,scopes:String(user.scope||'').split(/\s+/).filter(Boolean)}:{}),message:loggedIn?'飞书用户身份可用；具体来源权限将在同步时检查':'飞书用户身份未登录或已过期，请连接飞书后重新检测。',checkedAt:new Date().toISOString()};
  }catch(error){return {installed:error.connectorCode!=='missing_cli',loggedIn:false,message:error.message,checkedAt:new Date().toISOString()};}
}
function docTarget(value){
  if(typeof value!=='string'||value.length>1000)throw new Error('请输入飞书文档 URL');
  let u;try{u=new URL(value.trim());}catch{throw new Error('请输入完整飞书文档 URL');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(u.hostname)||!/^\/(docx|wiki)\/[A-Za-z0-9]+\/?$/.test(u.pathname))throw new Error('仅支持飞书 /docx/ 或 /wiki/ 文档地址');
  return u.origin+u.pathname.replace(/\/$/,'');
}
async function page(connection,{start,end,token},run=request,signal){
  if(connection.kind==='document'){
    const r=await run(['docs','+fetch','--as','user','--doc',connection.target,'--doc-format','markdown','--format','json'],{signal});
    const doc=r.data?.document;if(!doc||typeof doc.content!=='string')throw new Error('飞书文档响应格式不兼容，请检查 CLI 版本');
    return {items:[{remoteId:connection.target,content:doc.content||'（文档内容为空）',remoteRevision:doc.revision_id,warnings:/<(?:img|sheet|bitable|source|whiteboard)\b|!\[/.test(doc.content)?['文档含图片、附件或嵌入对象，当前仅收集导出的文字，相关内容需另行核对。']:[]}],hasMore:false};
  }
  const args=['im','+chat-messages-list','--as','user','--chat-id',connection.target,'--start',start,'--end',end,'--order','asc','--page-size','50','--no-reactions','--format','json'];
  if(token)args.push('--page-token',token);
  const r=await run(args,{signal}),data=r.data;
  if(!data||!Array.isArray(data.messages)||data.messages.length>50||typeof data.has_more!=='boolean')throw new Error('飞书会话响应格式不兼容，断点未推进');
  return {items:data.messages.map(m=>{
    if(typeof m.message_id!=='string'||!/^om_[\w-]+$/.test(m.message_id))throw new Error('飞书消息缺少有效 ID');
    const body=messageText(m.content);
    return {remoteId:m.message_id,content:`消息 ID：${m.message_id}\n发送时间：${m.create_time||'未知'}\n发送者：${m.sender?.name||m.sender?.id||'未知'}\n类型：${m.msg_type||'未知'}\n${m.deleted?'此消息已撤回，旧内容不再作为当前依据。':body}`,remoteRevision:m.update_time||m.create_time,deleted:!!m.deleted,
      senderId:senderId(m.sender),remoteCreatedAt:timestamp(m.create_time),messageBody:m.deleted?'':body,messageType:m.msg_type,
      warnings:[...(!['text','post'].includes(m.msg_type)?['该消息可能包含未解析的附件或卡片，当前仅保留文字和资源标识。']:[]),...(m.thread_id?['存在话题回复；本入口未完整展开回复。']:[])]};
  }),hasMore:data.has_more,token:data.page_token};
}
function senderId(sender){const id=sender?.open_id||sender?.id?.open_id||sender?.id;return typeof id==='string'&&/^ou_[\w-]+$/.test(id)?id:null;}
function timestamp(value){const n=Number(value),ms=value&&Number.isFinite(n)?(n<1e12?n*1000:n):Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
function messageText(content){if(content&&typeof content==='object')return typeof content.text==='string'?content.text:JSON.stringify(content);if(typeof content!=='string')return '';try{const parsed=JSON.parse(content);if(typeof parsed.text==='string')return parsed.text;}catch{}return content;}
function authURL(value){
  let u;try{u=new URL(value);}catch{throw Error('飞书未返回有效授权地址，请检查 CLI 配置');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(u.hostname))throw Error('飞书授权地址不在官方域名内');
  return value; // OAuth URLs are opaque: validate without rewriting query parameters.
}
module.exports={request,status,page,docTarget,senderId,timestamp,messageText,failure,authURL};

function pinnedReadArgs(args){
 if(JSON.stringify(args)===JSON.stringify(identityArgs))return true;
 if(args.length===10&&args[0]==='docs'&&args[1]==='+fetch'&&args[2]==='--as'&&args[3]==='user'&&args[4]==='--doc'&&args[6]==='--doc-format'&&args[7]==='markdown'&&args[8]==='--format'&&args[9]==='json'){docTarget(args[5]);return true;}
 const fixed=['im','+chat-messages-list','--as','user','--chat-id',null,'--start',null,'--end',null,'--order','asc','--page-size','50','--no-reactions','--format','json'];
 return [17,19].includes(args.length)&&fixed.every((v,i)=>v===null||args[i]===v)&&/^oc_[A-Za-z0-9_-]{3,150}$/.test(args[5])&&Number.isFinite(Date.parse(args[7]))&&Number.isFinite(Date.parse(args[9]))&&(args.length===17||args[17]==='--page-token'&&typeof args[18]==='string'&&args[18].length<=10000);
}
function identityMetadata(value){
 if(!value||!/^cli_[A-Za-z0-9_-]{1,120}$/.test(value.appId||'')||!/^ou_[A-Za-z0-9_-]{1,120}$/.test(value.openId||'')||!['feishu','lark'].includes(value.brand))throw identityError();
 return {appId:value.appId,brand:value.brand,openId:value.openId};
}
async function fixedIdentity(session,metadata,run,signal){
 const raw=await run([...identityArgs],{signal,pinnedSession:session});signal?.throwIfAborted();
 if(requestReceipts.get(raw)?.handle!==session)throw bindingError();
 if(raw.ok!==true||raw.identity!=='user'||raw.data?.open_id!==metadata.openId||typeof raw.data?.tenant_key!=='string'||!raw.data.tenant_key.trim()||raw.data.tenant_key.length>200)throw identityError();
 return {...metadata,tenantId:raw.data.tenant_key};
}
async function identityPreview(run=request,signal){
 const capability=await pinned.capability(executable(),{signal});
 const raw=await run(['auth','status','--json'],{signal,cliCapability:capability});signal?.throwIfAborted();
 if(requestReceipts.get(raw)?.handle!==capability)throw bindingError();
 const metadata=identityMetadata({appId:raw.appId,brand:raw.brand,openId:raw.identities?.user?.openId});
 const session=pinned.create(capability,metadata,{signal});
 try{return {identity:await fixedIdentity(session,metadata,run,signal),capability};}finally{closeSession(session);}
}
async function confirmIdentity(capability,identity,run=request,signal){
 const metadata=identityMetadata(identity),session=pinned.create(capability,metadata,{signal});
 try{const current=await fixedIdentity(session,metadata,run,signal);if(current.tenantId!==identity.tenantId)throw identityError('ACCESS_PRINCIPAL_CHANGED');return current;}finally{closeSession(session);}
}
async function pinnedPage(connection,window,{identity,assertCurrent,signal,run=request}={}){
 if(typeof assertCurrent!=='function')throw bindingError();assertCurrent();signal?.throwIfAborted();
 const capability=await pinned.capability(executable(),{signal});assertCurrent();
 const metadata=identityMetadata(identity),session=pinned.create(capability,metadata,{signal});
 try{
  const before=await fixedIdentity(session,metadata,run,signal);assertCurrent();
  if(before.tenantId!==identity.tenantId)throw identityError('ACCESS_PRINCIPAL_CHANGED');
  const result=await page(connection,window,async(args,options)=>{assertCurrent();const raw=await run(args,{...options,pinnedSession:session});if(requestReceipts.get(raw)?.handle!==session)throw bindingError();return raw;},signal);
  signal?.throwIfAborted();assertCurrent();
  const after=await fixedIdentity(session,metadata,run,signal);assertCurrent();
  if(after.tenantId!==identity.tenantId)throw identityError('ACCESS_PRINCIPAL_CHANGED');
  pageReceipts.set(result,{identity:JSON.stringify(identity),assertCurrent});return result;
 }finally{closeSession(session);}
}
function assertPinnedPage(result,identity,assertCurrent){const receipt=pageReceipts.get(result);if(!receipt||receipt.identity!==JSON.stringify(identity)||receipt.assertCurrent!==assertCurrent)throw bindingError();assertCurrent();}
Object.assign(module.exports,{identityPreview,confirmIdentity,pinnedPage,assertPinnedPage});

async function drainGroup(pid){
 if(!pid)return;
 const unknown=()=>Object.assign(Error('飞书子进程尚未确认退出，临时会话已保留，本页未提交'),{code:'SESSION_CLEANUP_FAILED',connectorCode:'identity_binding_unavailable'});
 const exists=()=>{try{process.kill(-pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw unknown();}};
 if(!exists())return;
 try{process.kill(-pid,'SIGTERM');}catch{}
 const start=Date.now();let killed=false;
 while(exists()){
  if(!killed&&Date.now()-start>=1000){try{process.kill(-pid,'SIGKILL');}catch{}killed=true;}
  if(Date.now()-start>=5000)throw unknown();
  await new Promise(resolve=>setTimeout(resolve,20));
 }
}
function closeSession(session){if(!unsafeSessions.has(session))pinned.close(session);}
