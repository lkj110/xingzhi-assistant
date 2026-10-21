'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),host=require('./host-process.cjs');
const now=()=>new Date().toISOString();
function trusted(a,action){if(!require('./workspace-view.cjs').trustedCommand(a,action))throw Error('请在本机工具界面明确发起操作');}
function directory(target){fs.mkdirSync(target,{recursive:true});if(fs.realpathSync(target)!==path.resolve(target)||!fs.lstatSync(target).isDirectory())throw Error('本地目录包含链接或路径已变化');return fs.realpathSync(target);}
function paths(){const root=path.join(os.homedir(),'Documents','行知助手');return {root,materials:path.join(root,'资料'),output:path.join(root,'交付'),runtime:host.runtimeRoot()};}
function status(a){const p=paths();return {...p,platform:process.platform,arch:process.arch,runtimes:Object.fromEntries(['node','python','git'].map(name=>[name,host.executable(name)])),lark:host.executable('lark-cli',{candidates:host.directories().map(d=>path.join(d,'node_modules','@larksuite','cli','bin','lark-cli.exe'))}),outputFolder:a.data.agentSettings.outputFolder||'',folderConfigured:a.data.folders.some(f=>f.path===p.materials),mcpConfigured:(a.data.capabilities||[]).some(c=>c.name==='本机资料 MCP'&&c.enabled&&!c.removedAt),connectors:Object.fromEntries(['lark','wecom','dingtalk','slack','notion','outlook'].map(provider=>[provider,(a.data.connectors||[]).filter(c=>(c.provider||'lark')===provider).map(c=>({name:c.name,enabled:c.enabled,health:c.health,hasCredentials:!!c.sealedToken||!!c.sealedOAuth||!!c.larkBinding}))])),githubConfigured:!!a.data.agentSettings.githubRepo&&!!a.data.agentSettings.githubToken};}
async function setup(a){
 a.ensureIdle();const p=paths(),node=host.executable('node',{candidates:process.platform==='win32'?[path.join(p.runtime,'node','node.exe')]:[]});if(!node)throw Error('请先安装 Node 运行工具');directory(p.root);directory(p.materials);directory(p.output);
 const mcpDir=path.join(p.runtime,'npm');if(!fs.existsSync(path.join(mcpDir,'node_modules','@modelcontextprotocol','sdk','package.json')))throw Error('请先安装本地 MCP SDK');
 const script=path.join(mcpDir,'local-mcp.cjs'),bytes=fs.readFileSync(path.join(__dirname,'local-mcp.cjs'));
 if(fs.existsSync(script)&&!fs.readFileSync(script).equals(bytes))throw Error('本地 MCP 文件已修改，请核对版本后更新');if(!fs.existsSync(script))fs.writeFileSync(script,bytes,{flag:'wx'});
 if(!a.data.capabilities.some(c=>c.command===node&&c.args?.[0]===script&&!c.removedAt)){
  const cap=require('./capabilities.cjs'),preview=await cap.dispatch(a,'capabilityInspect',{kind:'mcp',name:'本机资料 MCP',command:node,args:[script,p.materials],cwd:p.materials,noModel:true});
  await cap.dispatch(a,'capabilitySave',{token:preview.token,allowedTools:preview.tools.map(t=>t.name),trusted:true});
 }
 a.ensureIdle();if(!a.data.folders.some(f=>f.path===p.materials)){const folder={id:crypto.randomUUID(),path:p.materials,name:'行知助手资料',enabled:true,projectId:null,health:'unchecked',addedAt:now()};a.data.folders.push(folder);require('./collection-permissions.cjs').configure(a,'folder',folder,{trusted:true,command:'localToolsSetup'});}
 if(!a.data.agentSettings.outputFolder)a.data.agentSettings.outputFolder=p.output;a.save();return status(a);
}
function validateCode(input){if(!['python','javascript'].includes(input.language)||typeof input.code!=='string'||!input.code.trim()||input.code.length>100000)throw Error('请选择 Python 或 JavaScript，并提供不超过 10 万字符的代码');if(input.confirmed!==true)throw Error('请确认执行本次代码');}
async function run(a,input){
 validateCode(input);a.ensureIdle();const runtime=host.executable(input.language==='python'?'python':'node');if(!runtime)throw Error('未找到所需运行环境');
 const output=a.data.agentSettings.outputFolder;if(!output)throw Error('请先配置交付目录');const root=directory(output),id=crypto.randomUUID(),dir=directory(path.join(root,'运行-'+id)),script=path.join(dir,input.language==='python'?'main.py':'main.cjs');fs.writeFileSync(script,input.code,{flag:'wx',encoding:'utf8'});
 const record={id,language:input.language,startedAt:now(),status:'running',outputFolder:dir,script,codeHash:crypto.createHash('sha256').update(input.code).digest('hex'),stdout:'',stderr:''};a.data.localToolRuns=[record,...a.data.localToolRuns||[]].slice(0,30);a.save();
 return a.launch('运行本机代码',async()=>{
  try{const result=await execute(runtime,input.language==='python'?['-I','-B','-X','utf8',script]:[script],dir,a.controller?.signal);Object.assign(record,result,{status:result.exitCode===0?'done':'failed'});}catch(e){Object.assign(record,{status:a.controller?.signal.aborted?'cancelled':'failed',error:e.message});}
  record.finishedAt=now();fs.writeFileSync(path.join(dir,'运行结果.json'),JSON.stringify(record,null,2),{flag:'wx'});a.save();
 });
}
function execute(command,args,cwd,signal,{timeout=60000,maxBytes=500000}={}){
 const spawn=process.platform==='win32'?require('./windows-process.cjs').spawn:require('node:child_process').spawn;
 return new Promise((resolve,reject)=>{let stdout='',stderr='',bytes=0,error,settled=false;const env=host.environment();env.PATH=host.directories().join(path.delimiter);const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const stop=e=>{error ||= e;host.terminate(child);},abort=()=>stop(Error('运行已取消'));
  const timer=setTimeout(()=>stop(Error('运行超过 60 秒，进程树已停止')),timeout);
  const finish=(e,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);e?reject(e):resolve(value);};
  const receive=(stream,b)=>{bytes+=Buffer.byteLength(b,'utf8');if(bytes>maxBytes)return stop(Error('运行输出超过 500 KB，进程树已停止'));if(stream==='stdout')stdout+=b;else stderr+=b;};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',b=>receive('stdout',b));child.stderr.on('data',b=>receive('stderr',b));child.on('error',e=>finish(e));child.on('close',code=>finish(error,{exitCode:code,stdout,stderr}));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
function mailDraft(a,input){
 const recipient=String(input.to||'').trim();if(!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)||/[\r\n]/.test(recipient))throw Error('请填写单个有效收件人邮箱');
 if(typeof input.subject!=='string'||!input.subject.trim()||input.subject.length>200||/[\r\n]/.test(input.subject)||typeof input.body!=='string'||input.body.length>100000)throw Error('邮件主题或正文无效');
 const root=directory(a.data.agentSettings.outputFolder||paths().output),file=path.join(root,'邮件草稿-'+crypto.randomUUID()+'.eml');
 const body=Buffer.from(input.body,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';
 fs.writeFileSync(file,`X-Unsent: 1\r\nTo: ${recipient}\r\nSubject: =?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`,{flag:'wx'});return {path:file,sent:false};
}
async function dispatch(a,action,input={}){if(action==='localToolsStatus')return status(a);trusted(a,action);if(action==='localToolsSetup')return setup(a);if(action==='localToolsRun')return run(a,input);if(action==='localToolsMailDraft')return mailDraft(a,input);throw Error('未知本机工具操作');}
function recover(data){
 for(const row of data.localMediaRuns||[])if(row.status==='running'){row.status='interrupted';row.finishedAt=now();row.error='应用退出时生成中断；不会自动重试消耗额度。';}
 for(const row of data.localToolRuns||[])if(row.status==='running'){row.status='interrupted';row.finishedAt=now();row.error='应用退出时运行中断，请检查运行目录；不会自动重跑。';}
 for(const row of data.localExternalRuns||[])if(row.status==='submitting'){row.status='uncertain';row.finishedAt=now();row.message='应用退出前已开始提交，结果未知；请先检查服务端记录，避免重复操作。';}
}
module.exports={dispatch,status,paths,execute,validateCode,mailDraft,recover};
