'use strict';
const crypto=require('node:crypto'),request=require('./agent-tools.cjs').publicRequest;
const previews=new WeakMap(),now=()=>new Date().toISOString(),hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function store(a){let map=previews.get(a);if(!map){map=new Map();previews.set(a,map);}for(const [id,p]of map)if(p.expires<Date.now())map.delete(id);while(map.size>=20)map.delete(map.keys().next().value);return map;}
function mailInput(input){
 const to=String(input.to||'').trim();if(!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to)||/[\r\n]/.test(to))throw Error('请填写单个有效收件人邮箱');
 if(typeof input.subject!=='string'||!input.subject.trim()||input.subject.length>200||/[\r\n]/.test(input.subject)||typeof input.body!=='string'||!input.body.trim()||input.body.length>100000)throw Error('邮件主题或正文无效');return {to,subject:input.subject,body:input.body};
}
const grant=c=>c.oauthGrantId||crypto.createHash('sha256').update(String(c.sealedOAuth)).digest('hex');
function mailScope(a,id){const c=a.data.connectors.find(c=>c.id===id&&c.provider==='outlook'&&c.allowSend===true&&c.enabled!==false);if(!c)throw Error('请先配置允许手动发信的 Outlook 连接');return {c,fingerprint:hash([c.id,c.authMode,c.oauthClientId,c.oauthTenant,c.sealedToken,grant(c),c.allowSend,c.enabled])};}
const mailConfig=c=>hash([c.id,c.authMode,c.oauthClientId,c.oauthTenant,c.sealedToken,grant(c),c.allowSend,c.enabled]);
function deployScope(a){const {githubRepo,githubToken}=a.data.agentSettings;if(!githubRepo||!githubToken)throw Error('请先配置 GitHub 仓库与具有 Actions 写权限的凭据');return {repo:require('./agent-tools.cjs').repository(githubRepo),fingerprint:hash([githubRepo,githubToken])};}
function deployInput(input){
  if(typeof input.workflow!=='string'||!/^([A-Za-z0-9_.-]+\.ya?ml|\d+)$/.test(input.workflow)||typeof input.ref!=='string'||!input.ref||input.ref.length>200||/[\x00-\x20]/.test(input.ref))throw Error('请填写工作流文件名和有效 Git 分支或标签');
  if(input.inputs!==undefined&&(!input.inputs||typeof input.inputs!=='object'||Array.isArray(input.inputs)||Object.keys(input.inputs).length>10||Object.entries(input.inputs).some(([k,v])=>!/^[A-Za-z0-9_-]{1,100}$/.test(k)||typeof v!=='string'||v.length>2000)))throw Error('工作流输入须为最多 10 项字符串键值');
  return {workflow:input.workflow,ref:input.ref,inputs:input.inputs||{}};
}
function prepare(a,kind,input){
 if(kind==='mail'){const {c,fingerprint}=mailScope(a,input.connectorId);return {kind,connectorId:c.id,account:c.name,fingerprint,mail:mailInput(input)};}
 if(kind!=='deployment')throw Error('未知外部操作');const scope=deployScope(a);return {kind,repo:scope.repo,...deployInput(input),fingerprint:scope.fingerprint};
}
async function submit(a,p,{signal,beforeSend=()=>{}}={}){
 const kind=p.kind;if(!['mail','deployment'].includes(kind))throw Error('未知外部操作');signal?.throwIfAborted();
 let secret,url,body,headers,scope;
 if(kind==='mail'){
  scope=mailScope(a,p.connectorId);if(scope.fingerprint!==p.fingerprint)throw Error('邮箱授权已变化，请重新预览');const c=scope.c,config=mailConfig(c);secret=c.authMode==='oauth'?await require('./office-oauth.cjs').accessToken(a,c):await a.vault.open(c.sealedToken);
  if(!a.data.connectors.includes(c)||!c.allowSend||config!==mailConfig(c))throw Error('邮箱授权已撤销或变化');url='https://graph.microsoft.com/v1.0/me/sendMail';body={message:{subject:p.mail.subject,body:{contentType:'Text',content:p.mail.body},toRecipients:[{emailAddress:{address:p.mail.to}}]},saveToSentItems:true};headers={};
 }else{scope=deployScope(a);if(scope.fingerprint!==p.fingerprint)throw Error('GitHub 授权已变化，请重新预览');secret=await a.vault.open(a.data.agentSettings.githubToken);if(deployScope(a).fingerprint!==scope.fingerprint)throw Error('GitHub 授权已变化，请重新预览');url=`https://api.github.com/repos/${scope.repo}/actions/workflows/${encodeURIComponent(p.workflow)}/dispatches`;body={ref:p.ref,inputs:p.inputs};headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};}
 // Consume once before network I/O. A timeout must not become an automatic duplicate send/deploy.
 beforeSend();signal?.throwIfAborted();
 const record={id:crypto.randomUUID(),kind,startedAt:now(),status:'submitting',...(kind==='mail'?{to:p.mail.to,subject:p.mail.subject}:{repo:p.repo,workflow:p.workflow,ref:p.ref})};a.data.localExternalRuns=[record,...a.data.localExternalRuns||[]].slice(0,50);a.save();
 try{
  const result=await (a.localExternalRequest||request)(url,{method:'POST',signal,allowedOrigin:new URL(url).origin,allowHttpErrors:true,headers:{...headers,'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify(body)});
  if(result.status===(kind==='mail'?202:204)){record.status='accepted';record.message=kind==='mail'?'Microsoft 已受理发送请求；不代表收件人已收到。':'GitHub 已受理工作流触发；部署结果请在 Actions 检查。';}
  else{record.status=result.status>=500?'uncertain':'rejected';record.message=`服务返回 HTTP ${result.status}，请检查服务端记录后处理。`;}
 }catch{record.status='uncertain';record.message='连接中断，无法确认是否已提交；先检查已发送邮件或 Actions 记录，避免重复操作。';}
 record.finishedAt=now();a.save();return {...record};
}
async function dispatch(a,action,input={}){
 if(!require('./workspace-view.cjs').trustedCommand(a,action))throw Error('请在本机工具界面预览并确认本次外部操作');a.ensureIdle();const map=store(a);
 if(['localMailPreview','localDeployPreview'].includes(action)){const p=prepare(a,action==='localMailPreview'?'mail':'deployment',input),token=crypto.randomUUID();map.set(token,{...p,expires:Date.now()+600000});return p.kind==='mail'?{token,kind:p.kind,account:p.account,...p.mail}:{token,kind:p.kind,repo:p.repo,workflow:p.workflow,ref:p.ref,inputs:p.inputs};}
 if(!['localMailSend','localDeploySend'].includes(action)||input.confirmed!==true)throw Error('请先预览，再明确确认本次操作');
 const p=map.get(input.token),kind=action==='localMailSend'?'mail':'deployment';if(!p||p.kind!==kind)throw Error('预览已失效或已提交，请重新核对');
 return submit(a,p,{beforeSend(){if(map.get(input.token)!==p)throw Error('本次操作已提交');map.delete(input.token);}});
}
module.exports={dispatch,mailInput,deployInput,prepare,submit};
