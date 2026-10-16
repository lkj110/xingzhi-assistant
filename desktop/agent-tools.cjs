const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const delivery = require('./delivery-format.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

const textTypes = new Set(['.txt', '.md', '.csv', '.json']);
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && [0,2].includes(c)) || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && ([18,19].includes(b) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const [first,second]=address.split(':').map(p=>parseInt(p||'0',16));
  return net.isIP(address) === 6 && /^[23]/i.test(address) && first!==0x2002 && !(first===0x2001&&(second===0||second===0xdb8||(second&0xfff0)===0x10||(second&0xfff0)===0x20)) && !address.includes('.');
}
function webURL(value) {
  let url; try { url = new URL(value); } catch { throw new Error('网页地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('网页仅支持不含凭据的 HTTP(S) 标准端口地址');
  url.hash = ''; return url;
}

// Pin a checked DNS address to the actual socket; revalidate every redirect.
async function publicRequest(value, { method = 'GET', headers = {}, body, signal, redirects = 0, allowedOrigin } = {}) {
  const url = webURL(value);
  if (allowedOrigin && url.origin !== allowedOrigin) throw new Error('网页重定向超出已授权站点，请为新的站点单独建立订阅');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const timeout = AbortSignal.timeout(30000);
  const requestSignal = signal ? AbortSignal.any([signal,timeout]) : timeout;
  requestSignal.throwIfAborted();
  // DNS itself is not cancelable. Stop waiting immediately, and never open a socket
  // when a late lookup eventually completes after cancellation or the deadline.
  let cancel;
  const stopped = new Promise((_,reject)=>{cancel=()=>reject(Object.assign(new Error('工具请求已停止或超时'),{retryable:!signal?.aborted}));requestSignal.addEventListener('abort',cancel,{once:true});});
  let addresses;
  try {addresses=net.isIP(hostname)?[{address:hostname,family:net.isIP(hostname)}]:await Promise.race([dns.lookup(hostname,{all:true}),stopped]);}
  finally {requestSignal.removeEventListener('abort',cancel);}
  requestSignal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('网页工具只访问公网；本地资料请通过授权文件夹读取');
  const response = await new Promise((resolve,reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const chosen = addresses[0];
    const req = transport.request(url, { method, signal:requestSignal, headers:{'User-Agent':'Xingzhi-Assistant/0.4', 'Accept-Encoding':'identity', ...headers}, lookup:(_host,options,callback) => options.all ? callback(null,[chosen]) : callback(null,chosen.address,chosen.family) }, res => {
      const chunks=[]; let size=0;
      res.on('data', chunk => { size += chunk.length; if (size > 2_000_000) { res.destroy(new Error('工具响应超过 2 MB，请缩小读取范围')); } else chunks.push(chunk); });
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8'),url:url.href}));
    });
    req.on('error', error => reject(Object.assign(new Error(requestSignal.aborted ? '工具请求已停止或超时' : '工具网络连接失败'), {retryable:!signal?.aborted})));
    if (body) req.write(body); req.end();
  });
  if ([301,302,303,307,308].includes(response.status)) {
    if (redirects >= 4 || headers.Authorization || method !== 'GET' || !response.headers.location) throw new Error('工具请求重定向被拒绝');
    return publicRequest(new URL(response.headers.location,url).href,{signal:requestSignal,redirects:redirects+1,allowedOrigin});
  }
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`工具请求失败（HTTP ${response.status}）`), {retryable:[429,500,502,503,504].includes(response.status)});
  return response;
}

function plainText(html) {
  return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|article|tr)>|<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name]))
    .replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):' ')
    .replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
}
async function readWeb(url, request, signal) {
  const response = await request(webURL(url).href,{signal});
  const type = response.headers['content-type'] || '';
  if (type && !/text\/|json|xml/.test(type)) throw new Error('网页工具只读取 HTML／文本；此链接是二进制文件');
  const html = /html/.test(type) || /^\s*</.test(response.body);
  const title = html ? plainText(response.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url) : url;
  const content = (html ? plainText(response.body) : response.body).slice(0,30000);
  if (!content.trim()) throw new Error('此网页没有可读取的文本，可能需要登录或浏览器渲染');
  const links = html ? [...response.body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].slice(0,60).flatMap(match=>{
    try { const target=webURL(new URL(match[1],response.url||url).href).href; return [{title:plainText(match[2]).slice(0,100),url:target}]; } catch { return []; }
  }) : [];
  return {title:title.slice(0,300),content,links,url:response.url||url};
}
function folderPath(assistant, job, folderId) {
  if (!job.folderIds.includes(folderId)) throw new Error('该文件夹不在此委托的授权范围');
  const folder = assistant.data.folders.find(f=>f.id===folderId);
  if (!folder || fs.realpathSync(folder.path) !== folder.path) throw new Error('授权文件夹已移除或路径发生变化');
  return folder.path;
}
function listFiles(assistant, job, folderId) {
  const dir = folderPath(assistant,job,folderId);
  return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&!e.name.startsWith('.')&&require('./documents.cjs').extensions.has(path.extname(e.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,100).map(e=>{
    const stat=fs.lstatSync(path.join(dir,e.name)); return {name:e.name,size:stat.size,modifiedAt:stat.mtime.toISOString()};
  });
}
function readFile(assistant,job,folderId,name,full=false) {
  const dir=folderPath(assistant,job,folderId);
  if (typeof name!=='string'||name!==path.basename(name)||name.startsWith('.')||!textTypes.has(path.extname(name).toLowerCase())) throw new Error('只能读取所选目录中的 TXT、MD、CSV、JSON 文件');
  const fd=fs.openSync(path.join(dir,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try { const stat=fs.fstatSync(fd); if(!stat.isFile()||stat.size>800000)throw new Error('文件过大或不是常规文件'); const value=fs.readFileSync(fd,'utf8');return full?value:value.slice(0,30000); } finally {fs.closeSync(fd);}
}
async function readDocument(assistant,job,folderId,name,signal) {
  const docs=require('./documents.cjs'),dir=folderPath(assistant,job,folderId);
  if(typeof name!=='string'||name!==path.basename(name)||name.startsWith('.')||!docs.extensions.has(path.extname(name).toLowerCase()))throw new Error('只能读取授权目录中的 TXT、MD、CSV、JSON、PDF、DOCX 文件');
  const fd=fs.openSync(path.join(dir,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let buffer;
  try {const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>docs.maxBytes)throw new Error('文件超过 10 MB 或不是常规文件');buffer=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
  if(textTypes.has(path.extname(name).toLowerCase())) {const content=buffer.toString('utf8');if(content.length>docs.maxChars)throw new Error('材料超过 50 万字符');return {title:name,content,segments:docs.paragraphs(content),format:path.extname(name).slice(1)};}
  return docs.parse(name,buffer,signal);
}
function outputFile(folder,name,content) {
  if (!folder || fs.realpathSync(folder)!==folder || !fs.statSync(folder).isDirectory()) throw new Error('请重新选择有效的产出文件夹');
  if (typeof name!=='string'||name!==path.basename(name)||name.startsWith('.')||!delivery.formats.has(delivery.formatOf(name))) throw new Error('产出文件须为当前目录中的 Markdown、TXT、CSV 或 JSON 文件');
  delivery.validate(content,delivery.formatOf(name));
  const target=path.join(folder,name);
  try {
    const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try {fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  } catch(error) {
    if(error.code!=='EEXIST')throw error;
    const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {if(!fs.fstatSync(fd).isFile()||fs.fstatSync(fd).size>800000||fs.readFileSync(fd,'utf8')!==content)throw new Error('目标文件已存在且内容不同，未覆盖；请在记录中处理冲突');}finally{fs.closeSync(fd);}
  }
  if (readOutput(target) !== content) throw new Error('文件写入后回读不一致');
  return {path:target,bytes:Buffer.byteLength(content),hash:hash(content),verified:true};
}
function readOutput(target) {
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const s=fs.fstatSync(fd);if(!s.isFile()||s.size>800000)throw new Error('产出文件类型或大小无效');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
}
function publishLatest(folder,name,content,expectedHash) {
  if(fs.realpathSync(folder)!==folder||name!==path.basename(name))throw new Error('产出目录或文件名无效');
  delivery.validate(content,delivery.formatOf(name));
  const target=path.join(folder,name);
  const current=()=>{try{return readOutput(target);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  const before=current();
  if(before===content)return {latestPath:target,latestHash:hash(content),verified:true};
  if((before===null?null:hash(before))!==expectedHash)throw Object.assign(new Error('最新版本文件被人工修改，已保留，请处理冲突后重试'),{conflict:true});
  const temp=path.join(folder,`.xingzhi-${crypto.randomUUID()}.tmp`);
  try {
    const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
    try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    if(current()!==before)throw Object.assign(new Error('写入期间文件发生变化，已停止更新'),{conflict:true});
    fs.renameSync(temp,target);
  } finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
  if(readOutput(target)!==content)throw new Error('最新版本文件回读不一致');
  return {latestPath:target,latestHash:hash(content),verified:true};
}
function revision(issue) {return hash(JSON.stringify([issue.title,issue.body||'',issue.state,issue.updated_at]));}
function repository(value) {
  if (typeof value!=='string'||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(p=>p==='.'||p==='..')) throw new Error('GitHub 仓库格式应为 owner/repo');
  return value;
}
async function github(assistant,repo,route,{method='GET',body,signal,job,permissionScope,activeWriteAction,action:approvedAction}={}) {
  repository(repo);
  if(typeof route!=='string'||route.startsWith('/')||route.split('?')[0].split('/').some(part=>part==='..'||part==='.')||/[\\#\r\n]/.test(route)||/%2f|%2e|%5c/i.test(route))throw Error('GitHub 请求超出授权范围');
  const policy=require('./access-policy-store.cjs'),principal=policy.githubPrincipal(assistant.data);
  const action=approvedAction||activeWriteAction||assistant.activeWriteAction;
  const scope=permissionScope||job||(action&&(assistant.data.delegations||[]).find(j=>j.id===action.jobId))||assistant.activeAgentJob;
  const operation=method==='GET'?'github_read':method==='POST'&&/^issues\/\d+\/comments$/.test(route)?'github_comment':method==='PATCH'?'github_update':method==='POST'&&route==='issues'?'github_create':null;
  function authorize(){
    if(!assistant.dir)return; // Pure transport fixtures have no workspace authority.
    if(!scope||scope.githubRepo!==repo||!operation)throw Object.assign(Error('GitHub 未授权或请求超出当前委托授权范围'),{code:'ACCESS_POLICY_UNKNOWN'});
    require('./execution-gate.cjs').assert(assistant,{job:scope,readOnly:method==='GET'});
    if(action&&method!=='GET'){
      if(action.jobId!==scope.id||action.target!==repo||action.tool!==operation||(operation!=='github_create'&&route!==`issues/${action.number}${operation==='github_comment'?'/comments':''}`))throw Object.assign(Error('GitHub 动作目标超出具体审批的授权范围'),{code:'ACCESS_POLICY_REVOKED'});
      const marker=`<!-- xingzhi:${action.key} -->`,expected=operation==='github_create'?{title:action.title,body:`${action.content}\n\n${marker}`}:operation==='github_comment'?{body:`${action.content}\n\n${marker}`}:action.desired;
      if(policy.hash(body)!==policy.hash(expected))throw Object.assign(Error('GitHub 请求正文与已授权动作不一致'),{code:'ACCESS_POLICY_REVOKED'});
    }
    require('./protocol-access.cjs').assertTool(assistant,scope,operation,{}, {principalScope:principal,...(action&&method!=='GET'?{action,taskId:action.taskId}:{})});
  }
  authorize();
  const sealed=assistant.data.agentSettings.githubToken;
  const key=sealed?await assistant.vault.open(sealed):'';
  if(method!=='GET'&&!key)throw new Error('写入 GitHub 需要先配置 Token');
  if(policy.hash(policy.githubPrincipal(assistant.data))!==policy.hash(principal))throw Object.assign(Error('GitHub 凭据已变化，请重新确认授权范围'),{code:'ACCESS_PRINCIPAL_CHANGED'});
  signal?.throwIfAborted();authorize();
  const response=await assistant.agentRequest(`https://api.github.com/repos/${repo}/${route}`,{method,signal,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(key?{Authorization:`Bearer ${key}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  try{return JSON.parse(response.body);}catch{throw new Error('GitHub 返回格式无效');}
}
function issueData(issue) {return {number:issue.number,title:issue.title,body:(issue.body||'').slice(0,25000),state:issue.state,state_reason:issue.state_reason,url:issue.html_url,updatedAt:issue.updated_at};}
async function readIssue(assistant,repo,number,signal,{complete=false,job,permissionScope,activeWriteAction}={}) {
  if(!Number.isInteger(number)||number<1)throw new Error('Issue 编号无效');
  const issue=await github(assistant,repo,`issues/${number}`,{signal,job,permissionScope,activeWriteAction});
  const comments=[],seen=new Set();let exhausted=false;
  const firstPage=complete?1:Math.max(1,Math.ceil(Number(issue.comments||0)/100)-2),limit=complete?100:3;
  for(let page=firstPage;page<firstPage+limit;page++) {
    const rows=await github(assistant,repo,`issues/${number}/comments?per_page=100&page=${page}`,{signal,job,permissionScope,activeWriteAction});
    if(!Array.isArray(rows))throw new Error('GitHub 评论格式无效');
    const fingerprint=hash(JSON.stringify(rows.map(c=>[c.id,c.body])));
    if(rows.length&&seen.has(fingerprint))throw new Error('GitHub 评论分页重复，覆盖范围未完成，稍后重试');seen.add(fingerprint);
    comments.push(...rows.map(c=>({id:c.id,author:c.user?.login,body:c.body||'',contentHash:hash(c.body||''),updatedAt:c.updated_at,url:c.html_url})));
    if(rows.length<100){exhausted=true;break;}
  }
  if(complete&&(!exhausted||new Set(comments.map(c=>c.id)).size<Number(issue.comments||0)))throw new Error('GitHub 评论尚未完整读取，不能判断无变化；请缩小来源范围后重试');
  if(issue.pull_request)throw new Error('此入口只支持 Issue，不修改 Pull Request');
  return {...issueData(issue),revision:revision(issue),bodyHash:hash(issue.body||''),commentFingerprints:comments.map(c=>({id:c.id,author:c.author,contentHash:c.contentHash})).sort((a,b)=>a.id-b.id),coverage:complete?'complete':'partial',body:(issue.body||'').slice(0,4000),comments:comments.slice(-12).map(c=>({...c,body:c.body.slice(0,1200)})),commentsTruncated:comments.length>12||Number(issue.comments)>comments.length||comments.some(c=>c.body.length>1200),bodyTruncated:(issue.body||'').length>4000};
}
async function findComment(a,repo,number,marker,signal,{job,permissionScope,activeWriteAction}={}) {
  const issue=await github(a,repo,`issues/${number}`,{signal,job,permissionScope,activeWriteAction});
  const last=Math.max(1,Math.ceil(Number(issue.comments||0)/100));
  for(let page=last;page>=Math.max(1,last-4);page--) {
    const rows=await github(a,repo,`issues/${number}/comments?per_page=100&page=${page}`,{signal,job,permissionScope,activeWriteAction});
    if(!Array.isArray(rows))throw new Error('GitHub 评论格式无效');
    const found=rows.find(c=>c.body?.includes(marker));if(found)return found;
  }
  return null;
}
async function findIssue(assistant,repo,marker,signal,{job,permissionScope,activeWriteAction}={}) {
  for(let page=1;page<=5;page++) {
    const rows=await github(assistant,repo,`issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,{signal,job,permissionScope,activeWriteAction});
    if(!Array.isArray(rows))throw new Error('GitHub 事项列表格式无效');
    const found=rows.find(i=>!i.pull_request&&i.body?.includes(marker));
    if(found)return issueData(found); if(rows.length<100)return null;
  }
  return null;
}
module.exports={publicAddress,webURL,publicRequest,readWeb,listFiles,readFile,readDocument,outputFile,readOutput,publishLatest,revision,repository,github,issueData,readIssue,findIssue,findComment};
