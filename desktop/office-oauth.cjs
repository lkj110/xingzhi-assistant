'use strict';
const pending=new WeakMap(),refreshes=new WeakMap();
const scopes=c=>'offline_access https://graph.microsoft.com/Mail.Read'+(c.allowSend?' https://graph.microsoft.com/Mail.Send':'');
const fail=()=>Object.assign(Error('Microsoft 授权已失效或未获批准，请重新登录'),{connectorCode:'auth'});
function config(input){
 if(input.authMode!=='oauth')return {};
 if(input.provider!=='outlook'||typeof input.oauthClientId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.oauthClientId))throw Error('请填写你在 Microsoft Entra 注册的公共客户端应用 ID');
 const tenant=input.oauthTenant||'common';if(!/^(common|organizations|consumers|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(tenant))throw Error('租户须为 common、organizations、consumers 或租户 ID');
 return {authMode:'oauth',oauthClientId:input.oauthClientId,oauthTenant:tenant};
}
function signature(c){return JSON.stringify([c.id,c.oauthClientId,c.oauthTenant,!!c.allowSend]);}
function current(a,c,sig){return a.data.connectors?.includes(c)&&signature(c)===sig&&c.authMode==='oauth';}
async function post(a,c,endpoint,body,signal){
 config(c);const url=`https://login.microsoftonline.com/${c.oauthTenant}/oauth2/v2.0/${endpoint}`;
 let r;try{r=await a.officeRequest(url,{method:'POST',signal,allowedOrigin:'https://login.microsoftonline.com',allowHttpErrors:true,headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.oauthClientId,...body}).toString()});}catch{signal?.throwIfAborted();throw Error('无法连接 Microsoft 登录服务，请稍后重试');}
 if(r.url&&new URL(r.url).origin!=='https://login.microsoftonline.com'||typeof r.body!=='string'||r.body.length>100000)throw fail();
 let data;try{data=JSON.parse(r.body);}catch{throw fail();}return {status:r.status,data};
}
async function persist(a,c,data,sig,previous={}){
 if(typeof data.access_token!=='string'||data.access_token.length>30000||data.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw fail();
 if(!current(a,c,sig))throw Error('登录期间连接配置已变化，请重新登录');
 const grantId=previous.accessToken?(previous.grantId||c.oauthGrantId||require('node:crypto').createHash('sha256').update(String(c.sealedOAuth)).digest('hex')):require('node:crypto').randomUUID();
 const tokens={grantId,accessToken:data.access_token,refreshToken:data.refresh_token||previous.refreshToken||'',expiresAt:Date.now()+data.expires_in*1000};
 const sealed=await a.vault.seal(JSON.stringify(tokens));if(!current(a,c,sig))throw fail();
 const before={sealedOAuth:c.sealedOAuth,oauthExpiresAt:c.oauthExpiresAt,oauthGrantId:c.oauthGrantId};c.sealedOAuth=sealed;c.oauthExpiresAt=new Date(tokens.expiresAt).toISOString();c.oauthGrantId=grantId;
 try{a.save();}catch(e){if(!e.committed)Object.assign(c,before);throw e;}return tokens.accessToken;
}
async function accessToken(a,c,signal,force=false){
 if(!c.sealedOAuth)throw fail();let saved;try{saved=JSON.parse(await a.vault.open(c.sealedOAuth));}catch{throw fail();}
 if(!force&&saved.expiresAt>Date.now()+120000)return saved.accessToken;
 if(!saved.refreshToken)throw fail();let map=refreshes.get(a);if(!map){map=new Map();refreshes.set(a,map);}if(map.has(c.id))return map.get(c.id);
 const sig=signature(c),sealed=c.sealedOAuth;
 const task=(async()=>{const r=await post(a,c,'token',{grant_type:'refresh_token',refresh_token:saved.refreshToken,scope:scopes(c)},signal);if(r.status!==200||c.sealedOAuth!==sealed)throw fail();return persist(a,c,r.data,sig,saved);})();
 map.set(c.id,task);try{return await task;}finally{map.delete(c.id);}
}
async function dispatch(a,action,input){
 if(!require('./workspace-view.cjs').trustedCommand(a,action))throw Error('请通过办公连接界面发起登录');
 const c=a.data.connectors?.find(x=>x.id===input.id&&x.provider==='outlook');if(!c||c.authMode!=='oauth')throw Error('请先保存 Outlook OAuth 连接');config(c);
 let map=pending.get(a);if(!map){map=new Map();pending.set(a,map);}
 if(action==='officeOAuthStart'){
  const sig=signature(c),r=await post(a,c,'devicecode',{scope:scopes(c)});
  if(r.status!==200||!current(a,c,sig)||typeof r.data.device_code!=='string'||typeof r.data.user_code!=='string'||r.data.user_code.length>40||!Number.isFinite(r.data.expires_in))throw Error('无法发起 Microsoft 登录，请检查应用 ID、公共客户端设置及租户策略');
  const u=new URL(r.data.verification_uri);if(u.protocol!=='https:'||!['microsoft.com','www.microsoft.com','login.microsoftonline.com'].includes(u.hostname)||u.username||u.password)throw fail();
  const interval=Math.max(5,Number(r.data.interval)||5)*1000;
  map.set(c.id,{sig,deviceCode:r.data.device_code,expires:Date.now()+Math.min(r.data.expires_in,1800)*1000,interval,next:Date.now()+interval});
  return {userCode:r.data.user_code,verificationUri:u.href,expiresIn:r.data.expires_in,intervalSeconds:interval/1000};
 }
 if(action==='officeOAuthPoll'){
  const p=map.get(c.id);if(!p||!current(a,c,p.sig)||Date.now()>=p.expires){map.delete(c.id);throw Error('登录会话已过期，请重新开始');}
  if(Date.now()<p.next)return {pending:true,intervalSeconds:Math.ceil((p.next-Date.now())/1000)};
  p.next=Date.now()+p.interval;
  const r=await post(a,c,'token',{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:p.deviceCode});
  if(r.data.error==='authorization_pending')return {pending:true,intervalSeconds:p.interval/1000};
  if(r.data.error==='slow_down'){p.interval+=5000;p.next=Date.now()+p.interval;return {pending:true,intervalSeconds:p.interval/1000};}
  map.delete(c.id);if(r.status!==200)throw fail();await persist(a,c,r.data,p.sig);return {connected:true};
 }
 if(action==='officeOAuthCancel'){map.delete(c.id);return {cancelled:true};}
 throw Error('未知 OAuth 操作');
}
module.exports={config,accessToken,dispatch};
