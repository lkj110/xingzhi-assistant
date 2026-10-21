'use strict';
const attachments=require('./office-attachments.cjs');
const fail=(message,connectorCode='error')=>Object.assign(Error(message),{connectorCode});
const stamp=value=>typeof value==='string'&&/^\d{1,12}\.\d{1,9}$/.test(value)&&Number.isFinite(new Date(Number(value)*1000).getTime());
function slackState(token,c){
 if(!token?.startsWith('xz1:'))return {channel:c.target,history:token||'',done:false,threads:[]};
 let s;try{s=JSON.parse(token.slice(4));}catch{throw fail('Slack 话题断点无效','cursor');}
 if(s.channel!==c.target||typeof s.history!=='string'||s.history.length>2000||typeof s.done!=='boolean'||!Array.isArray(s.threads)||s.threads.length>15||s.threads.some(t=>!stamp(t.ts)||typeof t.cursor!=='string'||t.cursor.length>2000))throw fail('Slack 话题断点无效','cursor');
 return s;
}
async function slack(a,c,w,signal,h){
 const state=slackState(w.token,c),thread=state.threads[0],u=new URL(`https://slack.com/api/conversations.${thread?'replies':'history'}`);
 const query=thread?{channel:c.target,ts:thread.ts,limit:'15',...(thread.cursor?{cursor:thread.cursor}:{})}:{channel:c.target,oldest:String(Date.parse(w.start)/1000),latest:String(Date.parse(w.end)/1000),inclusive:'true',limit:'15',...(state.history?{cursor:state.history}:{})};
 for(const [key,value]of Object.entries(query))u.searchParams.set(key,value);
 const r=await h.json(a,c,u.href,signal);
 if(r.ok!==true){const code=['invalid_auth','not_authed','token_revoked','account_inactive'].includes(r.error)?'auth':['missing_scope','not_in_channel','channel_not_found','not_allowed_token_type'].includes(r.error)?'permission':r.error==='invalid_cursor'?'cursor':'error';throw fail('Slack 读取失败，请核对会话及话题/文件权限；原断点保留',code);}
 if(!Array.isArray(r.messages)||r.messages.length>15)throw fail('Slack 消息分页结构无效');
 const next=r.response_metadata?.next_cursor||'';
 if(typeof next!=='string'||next.length>2000||r.has_more===true&&!next||next&&(next===(thread?.cursor||state.history)))throw fail('Slack 分页凭据缺失或循环');
 const b=attachments.budget(),items=[];
 for(const m of r.messages){
  if(!stamp(m.ts)||typeof m.text!=='string')throw fail('Slack 消息缺少有效 ID 或正文');
  const at=new Date(Number(m.ts)*1000).toISOString(),warnings=['同步覆盖本轮时间范围内的主消息及其话题；较早话题的新回复、历史删除需另行核对。'];
  let content=`发送者：${m.user||m.bot_id||'未知'}\n时间：${at}\n${m.thread_ts&&m.thread_ts!==m.ts?`话题：${m.thread_ts}\n`:''}${m.text||'（此消息无文字）'}`;
  if(c.includeAttachments){
   if(m.files!==undefined&&!Array.isArray(m.files))throw fail('Slack 附件列表无效');
   for(const file of m.files||[]){
    if(file.is_external||!file.url_private_download&&!file.url_private){warnings.push(`${attachments.fileName(file.name)}：外部或受限附件，未下载正文`);continue;}
    const result=await attachments.download(a,c,{name:file.name,size:file.size,url:file.url_private_download||file.url_private},signal,b,{bearer:true});content+=result.text;warnings.push(...result.warnings);
   }
  }else if(m.files?.length)warnings.push('附件正文读取未启用');
  if(content.length>490000)throw fail('消息及附件正文过长，请缩小来源范围');
  items.push({remoteId:m.ts,title:`${c.name} · ${at}`,content,remoteCreatedAt:at,warnings});
 }
 if(thread){if(next)thread.cursor=next;else state.threads.shift();}
 else{state.history=next;state.done=!next;if(c.includeReplies)state.threads=r.messages.filter(m=>Number(m.reply_count)>0).map(m=>({ts:m.ts,cursor:''}));}
 const more=state.threads.length>0||!state.done;
 return h.pageResult(items,more,more?'xz1:'+JSON.stringify(state):'',{yield:true,delayMs:60000});
}
function property(value,h){
 if(!value||typeof value!=='object')return '';
 const v=value[value.type];
 if(['title','rich_text'].includes(value.type))return h.rich(v);
 if(['number','checkbox','url','email','phone_number','created_time','last_edited_time'].includes(value.type))return String(v??'');
 if(['select','status'].includes(value.type))return v?.name||'';
 if(value.type==='multi_select')return (v||[]).map(x=>x.name).join(', ');
 if(value.type==='date')return [v?.start,v?.end].filter(Boolean).join(' → ');
 if(value.type==='people')return (v||[]).map(x=>x.name||x.id).join(', ');
 if(value.type==='relation')return (v||[]).map(x=>x.id).join(', ');
 if(value.type==='formula')return property(v,h);
 if(value.type==='rollup')return v?.type==='array'?(v.array||[]).map(x=>property(x,h)).join(', '):property(v,h);
 if(value.type==='files')return (v||[]).map(x=>x.name).join(', ');
 return '';
}
async function notion(a,c,signal,h){
 const lines=[],warnings=new Set(),active=new Set(),visited=new Set(),budget=attachments.budget();let requests=0,characters=0;
 const add=line=>{characters+=line.length+1;if(characters>490000)throw fail('Notion 页面及展开内容超过 49 万字符，请缩小来源范围');lines.push(line);};
 const read=async(route,body)=>{if(++requests>100)throw fail('Notion 展开超过 100 次读取上限，旧版本保留');return h.json(a,c,'https://api.notion.com/v1/'+route,signal,{'Notion-Version':'2026-03-11',...(body?{'Content-Type':'application/json'}:{})},body?{method:'POST',body:JSON.stringify(body)}:{});};
 async function paged(route,body,fn){let cursor='';const seen=new Set();do{const r=await read(body?route:`${route}?page_size=50${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`,body?{...body,page_size:50,...(cursor?{start_cursor:cursor}:{})}:undefined);
  if(!Array.isArray(r.results)||r.results.length>50||typeof r.has_more!=='boolean')throw fail('Notion 分页结构无效');
  for(const entry of r.results)await fn(entry);
  if(!r.has_more)break;if(typeof r.next_cursor!=='string'||!r.next_cursor||r.next_cursor.length>2000||seen.has(r.next_cursor))throw fail('Notion 分页循环或凭据无效');cursor=r.next_cursor;seen.add(cursor);
 }while(true);}
 async function attachment(body,type){
  if(!c.includeAttachments){warnings.add('附件正文读取未启用');return;}
  const url=body.file?.url||body.external?.url;
  if(!url){warnings.add('附件没有可下载地址');return;}
  let name=body.name;try{name ||= decodeURIComponent(new URL(url).pathname.split('/').pop());}catch{}
  const result=await attachments.download(a,c,{name:name||`attachment.${type==='image'?'png':type}`,url},signal,budget);if(result.text)add(result.text);for(const w of result.warnings)warnings.add(w);
 }
 async function walk(id,depth,kind='page'){
  id=h.notionId(id);if(depth>12||active.has(id))throw fail('Notion 展开层级过深或存在循环，旧版本保留');if(visited.has(id))return;
  active.add(id);visited.add(id);
  if(kind==='database'){
   const db=await read(`databases/${id}`);if(!Array.isArray(db.data_sources)||db.data_sources.length>30)throw fail('Notion 数据库的数据源结构无效');
   for(const source of db.data_sources){const sourceId=h.notionId(source.id);add(`${'  '.repeat(depth)}数据库：${source.name||db.title&&h.rich(db.title)||id}`);
    await paged(`data_sources/${sourceId}/query`,{},async page=>{if(page.object!=='page')throw fail('Notion 数据源返回无效页面');const pid=h.notionId(page.id);add(`${'  '.repeat(depth+1)}记录 ${pid}`);for(const [name,value]of Object.entries(page.properties||{})){const text=property(value,h);if(text)add(`${name}：${text}`);if(value.has_more)warnings.add(`属性 ${name} 被平台截断，请核对完整属性`);if(value.type==='files')for(const f of value.files||[])await attachment(f,'file');}await walk(pid,depth+1);});
   }
  }else await paged(`blocks/${id}/children`,undefined,async block=>{
   const bid=h.notionId(block.id);if(typeof block.type!=='string')throw fail('Notion 内容块无效');const b=block[block.type]||{};let text=h.rich(b.rich_text);
   if(block.type==='to_do')text=`[${b.checked?'x':' '}] ${text}`;
   if(block.type==='table_row')text=(b.cells||[]).map(h.rich).join(' | ');
   if(typeof b.title==='string')text=b.title;if(typeof b.expression==='string')text=b.expression;
   if(text)add(`${'  '.repeat(depth)}${text}`);
   if(['image','file','pdf','audio','video'].includes(block.type))await attachment(b,block.type);
   if(['child_page','child_database'].includes(block.type)){if(c.expandChildren)await walk(bid,depth+1,block.type==='child_database'?'database':'page');else warnings.add('子页面/数据库展开未启用');}
   else if(block.has_children)await walk(bid,depth+1);
   else if(['embed','unsupported'].includes(block.type))warnings.add('嵌入或平台不支持的内容块未读取正文');
  });
  active.delete(id);
 }
 await walk(c.target,0,c.notionTargetType||'page');
 return h.pageResult([{remoteId:c.target,title:c.name,content:lines.join('\n')||'（页面当前无文字内容）',warnings:[...warnings]}],false);
}
async function outlook(a,c,w,signal,h){
 const base=`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(c.target)}/messages`,u=new URL(base);
 u.searchParams.set('$top','10');u.searchParams.set('$select','id,subject,from,receivedDateTime,body,hasAttachments,webLink');u.searchParams.set('$filter',`receivedDateTime ge ${w.start} and receivedDateTime le ${w.end}`);u.searchParams.set('$orderby','receivedDateTime asc');
 const headers={Prefer:'outlook.body-content-type="text", IdType="ImmutableId"'},r=await h.json(a,c,w.token?h.sameEndpoint(w.token,base):u.href,signal,headers),budget=attachments.budget(),items=[];
 if(!Array.isArray(r.value)||r.value.length>50)throw fail('Outlook 邮件分页结构无效');
 for(const m of r.value){
  if(typeof m.id!=='string'||!m.id||m.id.length>2000||typeof m.body?.content!=='string')throw fail('邮件正文不可读取，请确认 Mail.Read 权限','permission');
  const warnings=[];let content=`主题：${m.subject||'无主题'}\n发件人：${m.from?.emailAddress?.address||'未知'}\n收件时间：${m.receivedDateTime||'未知'}\n${m.body.contentType?.toLowerCase()==='html'?h.htmlText(m.body.content):m.body.content}`;
  if(m.hasAttachments){
   const ab=`${base}/${encodeURIComponent(m.id)}/attachments`;let link=ab+'?$top=20',pages=0;const seen=new Set();
   while(link){if(++pages>10||seen.has(link))throw fail('Outlook 附件分页过多或循环');seen.add(link);
    const ar=await h.json(a,c,link,signal,headers,{maxBytes:15_000_000});if(!Array.isArray(ar.value)||ar.value.length>20)throw fail('Outlook 附件列表无效');
    for(const file of ar.value){if(file['@odata.type']!=='#microsoft.graph.fileAttachment'){warnings.push(`${attachments.fileName(file.name)}：链接或邮件型附件未解析`);continue;}const result=await attachments.inline(file,signal,budget);content+=result.text;warnings.push(...result.warnings);}
    link=ar['@odata.nextLink']?h.sameEndpoint(ar['@odata.nextLink'],ab):'';
   }
  }
  if(content.length>490000)throw fail('邮件及附件正文超过 49 万字符');items.push({remoteId:m.id,title:m.subject||'无主题邮件',content,warnings});
 }
 const next=r['@odata.nextLink'];if(next!==undefined&&typeof next!=='string')throw fail('Outlook 分页地址无效');return h.pageResult(items,!!next,next?h.sameEndpoint(next,base):'');
}
module.exports={slack,notion,outlook,slackState};
