const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const office=require('./office-connectors.cjs');
const lifecycle=require('./project-lifecycle.cjs');
const {publicRequest}=require('./agent-tools.cjs');
const now=()=>new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const isStream=c=>['wecom','dingtalk'].includes(c?.provider);
function directory(a){const dir=path.join(a.dir,'chat-inbox');fs.mkdirSync(dir,{recursive:true,mode:0o700});const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('消息暂存目录无效');return dir;}
function files(a){const dir=directory(a);return fs.readdirSync(dir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>path.join(dir,name));}
function read(file){let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>600000)throw Error('消息暂存文件无效');const r=JSON.parse(fs.readFileSync(fd,'utf8'));if(r.version!==1||typeof r.connectorId!=='string'||typeof r.item?.remoteId!=='string'||typeof r.item?.content!=='string')throw Error('消息暂存内容无效');return r;}finally{if(fd!==undefined)fs.closeSync(fd);}}
function normalize(c,body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('机器人消息结构无效');
 const id=c.provider==='wecom'?body.msgid:body.msgId;
 if(typeof id!=='string'||!id||id.length>1200)throw Error('机器人消息缺少有效 ID');
 const type=body.msgtype||body.msgType||'unknown';let text=typeof body.text?.content==='string'?body.text.content:'';
 if(type==='mixed')text=(body.mixed?.msg_item||[]).filter(x=>x.msgtype==='text').map(x=>x.text?.content||'').join('\n');
 if(type==='richText')text=(body.content?.richText||[]).map(x=>x.text||'').join('\n');
 const warnings=[];if(type!=='text')warnings.push('此消息包含非纯文字内容；当前只收集可读取文字，图片、语音和附件可另行截图或导入。');
 const sender=c.provider==='wecom'?body.from?.userid:body.senderStaffId||body.senderId;
 const conversation=c.provider==='wecom'?body.chatid||body.from?.userid:body.conversationId;
 if(text.length>490000)throw Error('消息文字过长，请拆分后发送');
 const content=`来源：${office.label(c)}\n发送者：${String(sender||'未知').slice(0,500)}\n会话：${String(conversation||'未知').slice(0,500)}\n类型：${String(type).slice(0,100)}\n${text||'（消息无可读取文字，请补充文字或截图）'}`;
 return {remoteId:id,title:`${c.name} · ${text.trim().split('\n')[0].slice(0,80)||'待补充消息'}`,content,warnings};
}
function enqueue(a,c,item){
 const entry={version:1,connectorId:c.id,item,receivedAt:now()},body=JSON.stringify(entry),dir=directory(a),file=path.join(dir,hash(JSON.stringify([c.id,item.remoteId,item.content]))+'.json');
 if(fs.existsSync(file))return;
 const rows=files(a);if(rows.length>=500||rows.reduce((n,f)=>n+fs.lstatSync(f).size,0)+Buffer.byteLength(body)>25000000)throw Error('消息收件箱已满，请先处理已收集材料');
 const temp=path.join(dir,crypto.randomUUID()+'.tmp');let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}catch{throw Error('消息尚未写入磁盘，请检查可用空间');}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
}
function pending(a,id){return files(a).map(file=>({file,...read(file)})).filter(r=>!id||r.connectorId===id).sort((x,y)=>x.receivedAt.localeCompare(y.receivedAt));}
function drain(a,c){
 const rows=pending(a,c.id).slice(0,50);if(!rows.length)return;
 const count=require('./connectors.cjs').commit(a,c,rows.map(row=>row.item),c.cursor);
 // commit saves sources before acknowledging the local queue. A crash here replays
 // the same IDs through the normal version deduplication path.
 for(const row of rows)fs.unlinkSync(row.file);
 c=a.data.connectors.find(row=>row.id===c.id);c.lastSuccessAt=now();c.error='';c.health='healthy';
 a.data.connectorRuns.unshift({id:crypto.randomUUID(),connectorId:c.id,startedAt:now(),finishedAt:now(),status:count?'updated':'unchanged',added:count,pages:1});a.data.connectorRuns=a.data.connectorRuns.slice(0,200);a.save();
}
function eligible(a,c){return !!c?.enabled&&lifecycle.isActive(a.data,c.projectId)&&!a.suspended&&require('./stewardship.cjs').canAutomate(a);}
function factory(c,secret,{message,status,error}){
 if(c.provider==='wecom'){
  const {WSClient}=require('@wecom/aibot-node-sdk');
  const client=new WSClient({botId:c.target,secret,maxReconnectAttempts:0,maxAuthFailureAttempts:1,wsOptions:{maxPayload:2000000,handshakeTimeout:30000},logger:{debug(){},info(){},warn(){},error(){}}});
  client.on('authenticated',()=>status('connected'));client.on('disconnected',()=>status('disconnected'));client.on('error',()=>error());
  client.on('message',frame=>{try{message(frame.body);}catch{error('消息尚未保存，请检查收件箱后重新发送');}});
  return {connect:()=>client.connect(),disconnect:()=>client.disconnect()};
 }
 const {DWClient,TOPIC_ROBOT}=require('dingtalk-stream');
 const client=new DWClient({clientId:c.target,clientSecret:secret,debug:false,autoReconnect:false,keepAlive:true,subscriptions:[]});
 client.sslopts={rejectUnauthorized:true,maxPayload:2000000,handshakeTimeout:30000};
 // The SDK's endpoint request has no deadline. Keep it bounded and verify the
 // returned WebSocket destination before the SDK connects with its ticket.
 client.getEndpoint=async()=>{
  const url='https://api.dingtalk.com/v1.0/gateway/connections/open';
  const r=await publicRequest(url,{method:'POST',allowedOrigin:new URL(url).origin,headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({clientId:c.target,clientSecret:secret,subscriptions:[{type:'CALLBACK',topic:TOPIC_ROBOT}]})});
  if(r.status!==200)throw Error('钉钉连接认证失败');const value=JSON.parse(r.body),u=new URL(value.endpoint);
  if(u.protocol!=='wss:'||u.port||u.username||u.password||!/(^|\.)dingtalk\.com$/.test(u.hostname)||u.search||u.hash||typeof value.ticket!=='string'||value.ticket.length>10000)throw Error('钉钉连接地址无效');
  u.searchParams.set('ticket',value.ticket);client.dw_url=u.href;return client;
 };
 client.registerCallbackListener(TOPIC_ROBOT,frame=>{try{message(JSON.parse(frame.data));client.socketCallBackResponse(frame.headers.messageId,{success:true});}catch{error('消息尚未保存，平台可重试；请检查连接和收件箱');}});
 return {async connect(){await client.connect();if(client.connected)status('connected');else throw Error('钉钉连接失败');},disconnect:()=>client.disconnect(),connected:()=>client.connected};
}
function create(a,{createClient=factory}={}){
 const entries=new Map();let disposed=false;
 function stop(id){const row=entries.get(id);entries.delete(id);try{row?.client?.disconnect();}catch{}}
 function live(id,entry){return entries.get(id)===entry&&eligible(a,a.data.connectors.find(c=>c.id===id));}
 function setError(entry,message='连接失败，请检查机器人凭据、网络及应用发布状态后重试'){entry.state='error';entry.error=message;entry.retryAt=Date.now()+60000;try{entry.client?.disconnect();}catch{}}
 async function start(c,entry){
  try{
   const secret=await a.vault.open(c.sealedToken);if(!live(c.id,entry))return;
   entry.client=createClient(c,secret,{
    message:body=>{if(!live(c.id,entry))throw Error('连接已暂停');const current=a.data.connectors.find(row=>row.id===c.id);enqueue(a,current,normalize(current,body));entry.lastMessageAt=now();},
    status:state=>{if(entries.get(c.id)!==entry)return;entry.state=state;if(state==='disconnected')entry.retryAt=Date.now()+60000;},
    error:message=>{if(entries.get(c.id)===entry)setError(entry,message);}
   });
   await entry.client.connect();if(!live(c.id,entry))entry.client.disconnect();
  }catch{if(entries.get(c.id)===entry)setError(entry);}
 }
 function reconcile(){
  if(disposed)return;
  const desired=a.data.connectors.filter(c=>isStream(c)&&eligible(a,c));
  for(const [id,entry]of entries){const c=desired.find(c=>c.id===id);if(!c||entry.credential!==c.sealedToken)stop(id);else if(entry.client?.connected&&entry.state==='connected'&&!entry.client.connected()){entry.state='disconnected';entry.retryAt=Date.now()+60000;}else if(entry.state==='connecting'&&Date.now()-entry.startedAt>45000)setError(entry,'连接超过 45 秒，请检查网络或机器人凭据');else if(['error','disconnected'].includes(entry.state)&&Date.now()>=entry.retryAt)stop(id);}
  for(const c of desired)if(!entries.has(c.id)){const entry={state:'connecting',credential:c.sealedToken,error:'',retryAt:0,startedAt:Date.now()};entries.set(c.id,entry);entry.promise=start(c,entry);}
 }
 function snapshot(){
  let rows;try{rows=pending(a);}catch{return {error:'消息暂存文件需要检查，已停止归并',connections:[]};}
  return {connections:a.data.connectors.filter(isStream).map(c=>{const e=entries.get(c.id);return {id:c.id,status:e?.state||(eligible(a,c)?'waiting':'paused'),error:e?.error||'',lastMessageAt:e?.lastMessageAt||null,pending:rows.filter(r=>r.connectorId===c.id).length};}),orphaned:rows.filter(r=>!a.data.connectors.some(c=>c.id===r.connectorId)).length};
 }
 return {reconcile,snapshot,reconnect(id){stop(id);reconcile();},dispose(){disposed=true;for(const id of entries.keys())stop(id);},settled:()=>Promise.all([...entries.values()].map(e=>e.promise))};
}
function hasPending(a,projectId){try{return pending(a).some(row=>a.data.connectors.some(c=>c.id===row.connectorId&&c.projectId===projectId));}catch{return true;}}
function tick(a){
 let row;try{row=pending(a).find(r=>{const c=a.data.connectors.find(c=>c.id===r.connectorId);return isStream(c)&&eligible(a,c)&&(!c.inboxRetryAt||Date.parse(c.inboxRetryAt)<=Date.now());});}catch{return false;}
 if(!row)return false;const c=a.data.connectors.find(c=>c.id===row.connectorId);
 a.launch(`归并${office.label(c)}消息`,async()=>{try{drain(a,c);}catch{const current=a.data.connectors.find(item=>item.id===c.id);if(current){current.error='消息归并未完成，原始消息已保留；请核对项目待处理动作后重试';current.health='merge';current.inboxRetryAt=new Date(Date.now()+60000).toISOString();a.save();}}});return true;
}
module.exports={create,isStream,normalize,enqueue,pending,drain,tick,factory,hasPending};
