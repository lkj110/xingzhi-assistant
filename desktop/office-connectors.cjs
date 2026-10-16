const tools=require('./agent-tools.cjs');
const {urlOf}=require('./web-connections.cjs');
const labels={wecom:'企业微信机器人',dingtalk:'钉钉机器人',slack:'Slack 会话',notion:'Notion 页面',outlook:'Outlook 邮件',json:'通用 JSON 信息源'};
const fail=(message,connectorCode='error',more={})=>Object.assign(new Error(message),{connectorCode,...more});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function kind(c){return c.provider||'lark';}
function label(c){return labels[kind(c)]||'飞书';}
function notionId(value){
  let raw=String(value||'').trim();
  if(raw.startsWith('https://')){const u=new URL(raw);if(u.username||u.password||u.port||!/(^|\.)(notion\.so|notion\.site)$/.test(u.hostname))throw Error('请填写 Notion 页面地址或页面 ID');raw=u.pathname.split('/').filter(Boolean).at(-1)||'';}
  const found=raw.match(/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-f\d]{32})$/i);
  if(!found)throw Error('Notion 页面 ID 无效');
  const id=found[1].replace(/-/g,'').toLowerCase();return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}
function prepare(input){
  if(!labels[input.provider])throw Error('不支持此信息连接类型');
  let target=typeof input.target==='string'?input.target.trim():'';
  if(['wecom','dingtalk'].includes(input.provider)&&!/^[A-Za-z0-9_-]{3,200}$/.test(target))throw Error('请输入机器人 ID 或应用 Client ID');
  if(input.provider==='slack'&&!/^[CDG][A-Z0-9]{5,30}$/.test(target))throw Error('请填写 Slack 的频道或会话 ID，例如 C0123456789');
  if(input.provider==='notion')target=notionId(target);
  if(input.provider==='outlook'&&!/^[A-Za-z0-9_+=-]{1,512}$/.test(target))throw Error('请填写 Outlook 文件夹 ID 或 inbox');
  if(input.provider==='json'){
    target=urlOf(target);const u=new URL(target);
    if(u.protocol!=='https:'||u.search||u.hash)throw Error('通用信息源须为不带查询参数的公开 HTTPS 地址；凭据请填入令牌栏');
  }
  for(const [key,min,max,def] of [['intervalMinutes',5,1440,15],['lookbackDays',1,30,7]]){if(input[key]!==undefined&&(!Number.isInteger(input[key])||input[key]<min||input[key]>max))throw Error(`${key} 须为 ${min}–${max} 的整数`);}
  if(typeof input.enabled!=='boolean')throw Error('请选择是否自动同步');
  return {provider:input.provider,kind:'office',target,intervalMinutes:input.intervalMinutes??15,lookbackDays:input.lookbackDays??7};
}
function sanitize(state){state.connectors=(state.connectors||[]).map(({sealedToken,...c})=>({...c,...(kind(c)!=='lark'?{hasToken:!!sealedToken}:{})}));}
function sameEndpoint(value,base){
  let u;try{u=new URL(value);}catch{throw fail('分页地址无效，原断点已保留');}
  const expected=new URL(base);
  if(u.origin!==expected.origin||u.pathname!==expected.pathname||u.username||u.password||u.hash)throw fail('分页地址超出已授权来源，原断点已保留');
  return u.href;
}
async function json(a,c,url,signal,headers={}){
  let secret='';try{secret=c.sealedToken?await a.vault.open(c.sealedToken):'';}catch{throw fail('无法读取连接凭据，请重新保存访问令牌','auth');}
  if(!secret&&kind(c)!=='json')throw fail('请配置访问令牌','auth');
  let r;
  try{r=await a.officeRequest(url,{signal,allowedOrigin:new URL(url).origin,headers:{Accept:'application/json',...headers,...(secret?{Authorization:`Bearer ${secret}`}:{})}});}
  catch{if(signal?.aborted)throw fail('同步已停止');throw fail('无法连接信息来源，请检查网络后重试','connection');}
  signal?.throwIfAborted();
  if(!r||typeof r.body!=='string'||Buffer.byteLength(r.body)>2_000_000)throw fail('信息源响应无效或超过 2 MB');
  if(r.url&&new URL(r.url).origin!==new URL(url).origin)throw fail('信息源响应超出已授权站点');
  if(r.status===401)throw fail('访问令牌已失效，请更新凭据后重试','auth');
  if(r.status===403||r.status===404)throw fail('来源不存在或无读取权限，请检查授权范围和来源地址','permission');
  if(r.status===429){const raw=r.headers?.['retry-after'];const seconds=Number(raw);const ms=Number.isFinite(seconds)&&seconds>0?seconds*1000:Date.parse(raw)-Date.now();throw fail('服务限流，已保留断点并安排稍后继续','rate_limit',{retryAfterMs:Math.min(86400000,Math.max(60000,Number.isFinite(ms)?ms:60000))});}
  if(r.status<200||r.status>=300)throw fail(`信息源读取失败（HTTP ${r.status}），已保留断点`,'connection');
  let value;try{value=JSON.parse(r.body);}catch{throw fail('信息源未返回有效 JSON');}
  if(!object(value))throw fail('信息源响应结构无效');return value;
}
function pageResult(items,hasMore,token,more={}){
  if(typeof hasMore!=='boolean'||!Array.isArray(items)||items.length>50)throw fail('信息源分页结构无效');
  if(hasMore&&(typeof token!=='string'||!token||token.length>10000))throw fail('分页凭据缺失或过长，断点已保留');
  return {items,hasMore,token:hasMore?token:'',...more};
}
async function slack(a,c,w,signal){
  const u=new URL('https://slack.com/api/conversations.history');
  for(const [k,v]of Object.entries({channel:c.target,oldest:String(Date.parse(w.start)/1000),latest:String(Date.parse(w.end)/1000),inclusive:'true',limit:'15',...(w.token?{cursor:w.token}:{})}))u.searchParams.set(k,v);
  const r=await json(a,c,u.href,signal);
  if(r.ok!==true){if(['invalid_auth','not_authed','token_revoked','account_inactive'].includes(r.error))throw fail('Slack 登录已失效，请更新令牌','auth');if(['missing_scope','not_in_channel','channel_not_found'].includes(r.error))throw fail('Slack 会话无读取权限，请检查范围并将应用加入频道','permission');if(r.error==='invalid_cursor')throw fail('Slack 分页凭据失效，将从本轮起点重读并去重','cursor');throw fail('Slack 读取失败，请检查令牌及会话设置');}
  if(!Array.isArray(r.messages)||r.messages.length>15)throw fail('Slack 消息结构无效');
  const items=r.messages.map(m=>{
    if(typeof m.ts!=='string'||!/^\d+\.\d+$/.test(m.ts)||typeof m.text!=='string')throw fail('Slack 消息缺少有效 ID 或文字');
    return {remoteId:m.ts,title:`${c.name} · ${new Date(Number(m.ts)*1000).toISOString()}`,content:`发送者：${m.user||m.bot_id||'未知'}\n时间：${new Date(Number(m.ts)*1000).toISOString()}\n${m.text||'（此消息无文字）'}`,remoteCreatedAt:new Date(Number(m.ts)*1000).toISOString(),warnings:['当前同步会话主消息及最近 24 小时的编辑；话题回复、附件正文和历史删除需另行核对。']};
  });
  return pageResult(items,r.has_more===true||!!r.response_metadata?.next_cursor,r.response_metadata?.next_cursor,{yield:true,delayMs:60000});
}
const rich=rows=>(Array.isArray(rows)?rows:[]).map(x=>typeof x.plain_text==='string'?x.plain_text:typeof x.text?.content==='string'?x.text.content:'').join('');
async function notion(a,c,signal){
  const lines=[],warnings=new Set(),seen=new Set();let requests=0,characters=0;
  const add=line=>{characters+=line.length+1;if(characters>490000)throw fail('Notion 页面过大，请拆分为更小的页面');lines.push(line);};
  async function walk(id,depth){
    if(depth>12||seen.has(id))throw fail('Notion 嵌套过深或存在循环，请缩小页面范围');seen.add(id);
    let token='';const cursors=new Set();
    do{
      if(++requests>100)throw fail('Notion 页面超过 100 次读取上限，请拆分页面；旧版本保留');
      const u=new URL(`https://api.notion.com/v1/blocks/${id}/children`);u.searchParams.set('page_size','50');if(token)u.searchParams.set('start_cursor',token);
      const r=await json(a,c,u.href,signal,{'Notion-Version':'2026-03-11'});
      if(!Array.isArray(r.results)||r.results.length>50||typeof r.has_more!=='boolean')throw fail('Notion 页面结构无效');
      for(const b of r.results){
        if(typeof b.id!=='string'||notionId(b.id)!==b.id.toLowerCase()||typeof b.type!=='string')throw fail('Notion 内容块标识无效');
        const body=b[b.type]||{};let text=rich(body.rich_text);
        if(b.type==='to_do')text=`[${body.checked?'x':' '}] ${text}`;
        if(b.type==='table_row')text=(body.cells||[]).map(rich).join(' | ');
        if(body.title)text=String(body.title);
        if(body.expression)text=String(body.expression);
        if(!text&&['image','file','pdf','video','audio','embed','child_database','unsupported','child_page'].includes(b.type))warnings.add('页面包含附件、子页面、数据库或嵌入内容；仅同步所选页面可读取的文字，未下载附件或展开子页面/数据库。');
        if(text)add(`${'  '.repeat(depth)}${text}`);
        if(b.has_children&&!['child_page','child_database'].includes(b.type))await walk(b.id,depth+1);
      }
      if(!r.has_more)break;
      if(typeof r.next_cursor!=='string'||!r.next_cursor||r.next_cursor.length>10000||cursors.has(r.next_cursor))throw fail('Notion 分页凭据无效');
      token=r.next_cursor;cursors.add(token);
    }while(true);
  }
  await walk(c.target,0);
  return pageResult([{remoteId:c.target,title:c.name,content:lines.join('\n')||'（页面当前无文字内容）',warnings:[...warnings]}],false);
}
function htmlText(value){return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<br\s*\/?>|<\/(p|div|li)>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[key])).trim();}
async function outlook(a,c,w,signal){
  const base=`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(c.target)}/messages`,u=new URL(base);
  u.searchParams.set('$top','50');u.searchParams.set('$select','id,subject,from,receivedDateTime,body,hasAttachments,webLink');
  u.searchParams.set('$filter',`receivedDateTime ge ${w.start} and receivedDateTime le ${w.end}`);u.searchParams.set('$orderby','receivedDateTime asc');
  const r=await json(a,c,w.token?sameEndpoint(w.token,base):u.href,signal,{Prefer:'outlook.body-content-type="text", IdType="ImmutableId"'});
  if(!Array.isArray(r.value)||r.value.length>50)throw fail('Outlook 邮件结构无效');
  const items=r.value.map(m=>{
    if(typeof m.id!=='string'||!m.id||typeof m.body?.content!=='string')throw fail('邮件正文不可读取，请确认已授权 Mail.Read','permission');
    const body=m.body.contentType?.toLowerCase()==='html'?htmlText(m.body.content):m.body.content;
    return {remoteId:m.id,title:m.subject||'无主题邮件',content:`主题：${m.subject||'无主题'}\n发件人：${m.from?.emailAddress?.address||'未知'}\n收件时间：${m.receivedDateTime||'未知'}\n${body||'（无正文）'}`,warnings:m.hasAttachments?['该邮件包含附件，当前只同步邮件正文。']:[]};
  });
  const next=r['@odata.nextLink'];if(next!==undefined&&typeof next!=='string')throw fail('Outlook 分页地址无效');
  return pageResult(items,!!next,next?sameEndpoint(next,base):'');
}
async function bridge(a,c,w,signal){
  const u=new URL(c.target);u.searchParams.set('start',w.start);u.searchParams.set('end',w.end);u.searchParams.set('limit','50');if(w.token)u.searchParams.set('cursor',w.token);
  const r=await json(a,c,u.href,signal);
  if(r.version!==1||!Array.isArray(r.items)||r.items.length>50)throw fail('通用信息源须返回 version:1 和最多 50 条 items');
  const items=r.items.map(item=>{
    if(!object(item)||typeof item.id!=='string'||!item.id||item.id.length>1200||typeof item.content!=='string'||item.content.length>490000||item.deleted!==undefined&&typeof item.deleted!=='boolean'||item.title!==undefined&&(typeof item.title!=='string'||item.title.length>300))throw fail('通用信息源条目格式无效');
    return {remoteId:item.id,title:item.title||c.name,content:item.deleted?'此信息已撤回，旧内容不再作为当前依据。':item.content||'（无正文）',deleted:item.deleted===true,warnings:[]};
  });
  return pageResult(items,r.hasMore,r.nextCursor);
}
async function page(a,c,window,signal){
  if(kind(c)==='slack')return slack(a,c,window,signal);
  if(kind(c)==='notion')return notion(a,c,signal);
  if(kind(c)==='outlook')return outlook(a,c,window,signal);
  if(kind(c)==='json')return bridge(a,c,window,signal);
  throw fail('未知信息连接类型');
}
module.exports={labels,kind,label,prepare,sanitize,page,sameEndpoint,notionId};
