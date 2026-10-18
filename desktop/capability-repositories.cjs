const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const excluded = new Set(['.git','node_modules','.venv','venv','vendor','dist','build','.cache','coverage','__pycache__']);
const lintPaths = ['_lint_common.py','sql_anti_pattern_linter.py','py_anti_pattern_linter.py'].map(name => `scripts/governance/lint/${name}`);
const validPath = value => value && !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '..' || part === '.' || !part);
const included = name => validPath(name) && !name.split('/').some(part => excluded.has(part)) && (name.endsWith('.md') || name === 'package.json' || lintPaths.includes(name));
const sameIdentity=(before,after)=>['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].every(key=>before[key]===after[key]);
const fileChanged=()=>Object.assign(Error('能力文件或父目录身份在读取期间变化，已拒绝读取'),{code:'CAPABILITY_FILE_CHANGED'});

function readFile(root, relative) {
  if (!validPath(relative)) throw Error('能力文件路径无效');
  const target = path.join(root, relative);
  if (!fs.realpathSync(target).startsWith(root + path.sep) || fs.realpathSync(target) !== target) throw Error('能力文件超出授权仓库或含符号链接');
  const directories=[root];let parent=root;
  for(const segment of path.relative(root,path.dirname(target)).split(path.sep).filter(Boolean)){parent=path.join(parent,segment);directories.push(parent);}
  const parents=directories.map(directory=>{
    const stat=fs.lstatSync(directory,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink())throw fileChanged();
    return {directory,stat};
  });
  const before=fs.lstatSync(target,{bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size>1000000n)throw Error('能力文件不是独立普通文件或超过 1 MB');
  const descriptor=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const verify=()=>{
      if(!sameIdentity(before,fs.fstatSync(descriptor,{bigint:true}))||!sameIdentity(before,fs.lstatSync(target,{bigint:true}))||parents.some(entry=>!sameIdentity(entry.stat,fs.lstatSync(entry.directory,{bigint:true}))))throw fileChanged();
    };
    verify();
    const bytes=Buffer.alloc(Number(before.size)+1);let offset=0;
    while(offset<bytes.length){const count=fs.readSync(descriptor,bytes,offset,bytes.length-offset,null);if(!count)break;offset+=count;}
    verify();if(offset!==Number(before.size))throw fileChanged();
    return bytes.subarray(0,offset);
  }finally{fs.closeSync(descriptor);}
}

function rootOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw Error('请填写本地仓库路径');
  const root = fs.realpathSync(value.trim());
  if (!fs.statSync(root).isDirectory()) throw Error('请选择本地仓库目录');
  return root;
}

function inventory(root, dw = false) {
  const documents = []; let total = 0;
  function walk(relative, depth = 0) {
    if (depth > 16) throw Error('仓库目录超过 16 层，请选择更具体的能力目录');
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(name, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (documents.length >= 2500) throw Error('仓库文档超过 2500 个，请拆分挂载');
        const bytes = readFile(root, name); total += bytes.length;
        if (total > 32000000) throw Error('能力文档合计超过 32 MB，请拆分挂载');
        documents.push({path:name, hash:hash(bytes), bytes:bytes.length});
      }
    }
  }
  if (dw) {
    for (const name of ['AGENTS.md','.agents/skills/dw/SKILL.md']) {
      const bytes = readFile(root, name); documents.push({path:name,hash:hash(bytes),bytes:bytes.length});
    }
    for (const dir of ['.claude/skills','.claude/protocols','.claude/team-knowledge']) if (fs.existsSync(path.join(root,dir))) walk(dir);
  } else walk('');
  if (!documents.length) throw Error('未找到 Markdown 能力文档；请选含 SKILL.md、AGENTS.md、README 或说明文档的仓库');
  return documents.sort((a,b) => a.path.localeCompare(b.path));
}

// Never runs a checkout, repository hook, package installer or shell command.
function git(cwd, args, {signal, input, maxBytes = 2000000} = {}) {
  return new Promise((resolve,reject) => {
    const child = spawn('/usr/bin/git', ['--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.ext.allow=never','-C',cwd,...args], {
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_SSH_COMMAND:'ssh -oBatchMode=yes'}, detached:true, stdio:['pipe','pipe','pipe'],
    });
    let chunks = [], bytes = 0, ended = false;
    const kill = () => { try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');} };
    const finish = (error, value) => {if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort = () => {kill();finish(Error('仓库更新已取消'));};
    const timer = setTimeout(() => {kill();finish(Error('仓库检查或更新超过 60 秒；请检查网络与 Git 登录后重试'));},60000);
    child.on('error',()=>finish(Error('无法启动 Git，请安装系统 Git 后重试')));
    child.stdout.on('data',part=>{bytes+=part.length;if(bytes>maxBytes){kill();finish(Error('仓库返回超过读取上限'));}else chunks.push(part);});
    child.stderr.on('data',()=>{}); // Git diagnostics may include credential-bearing URLs.
    child.stdin.on('error',()=>{});
    child.on('close',code=>code===0?finish(null,Buffer.concat(chunks)):finish(Error('Git 检查或更新失败；请检查仓库、跟踪分支、网络及本机登录，不会回退使用旧版本')));
    signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)abort();
    child.stdin.end(input);
  });
}
const gitText = async (root,args,options) => (await git(root,args,options)).toString('utf8').trim();

async function localVersion(root, signal) {
  try {
    const top = await gitText(root,['rev-parse','--show-toplevel'],{signal});
    if (fs.realpathSync(top) !== root) return {};
    const commit = await gitText(root,['rev-parse','HEAD'],{signal});
    const dirty = !!(await gitText(root,['status','--porcelain','--untracked-files=normal'],{signal}));
    return {commit,dirty};
  } catch(error) {signal?.throwIfAborted();return {};}
}

async function remoteTarget(root, input, signal) {
  const top = await gitText(root,['rev-parse','--show-toplevel'],{signal});
  if (fs.realpathSync(top) !== root) throw Error('跟随远端时请选择 Git 仓库根目录');
  let current='';
  try{current=await gitText(root,['symbolic-ref','--short','HEAD'],{signal});}catch(error){signal?.throwIfAborted();if(!input.remote||!input.branch)throw Error('当前仓库未检出分支，请填写远端名和分支');}
  let remote = input.remote?.trim(), branch = input.branch?.trim();
  if (!remote) {try {remote=await gitText(root,['config','--get',`branch.${current}.remote`],{signal});} catch {remote='origin';}}
  if (!branch) {try {branch=(await gitText(root,['config','--get',`branch.${current}.merge`],{signal})).replace(/^refs\/heads\//,'');} catch {branch=current;}}
  if (!/^[\w.-]+$/.test(remote) || remote.startsWith('-') || remote === '.') throw Error('请选择一个有远端地址的 Git remote');
  if (!branch || branch.startsWith('-') || branch.length > 300) throw Error('远端分支无效');
  await gitText(root,['check-ref-format',`refs/heads/${branch}`],{signal});
  const url = await gitText(root,['remote','get-url',remote],{signal});
  if (!/^(?:https:\/\/|ssh:\/\/|file:\/\/|\/|[\w.-]+@[\w.-]+:)/.test(url) || /[\r\n]/.test(url)) throw Error('仅支持 HTTPS、SSH 或本地 Git 远端地址');
  if (/^https:\/\//.test(url) && (new URL(url).username || new URL(url).password)) throw Error('远端地址不可包含凭据，请改用系统 Git 凭据管理');
  return {remote,branch,url};
}

function privateDirectory(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if (fs.realpathSync(dir) !== dir) throw Error('能力缓存目录无效');
  return dir;
}

async function remoteSnapshot(a, root, target, signal) {
  const key = hash(JSON.stringify({root,target})), base = privateDirectory(path.join(a.dir,'capability-repositories',key));
  const bare = privateDirectory(path.join(base,'git'));
  if (!fs.existsSync(path.join(bare,'HEAD'))) await git(bare,['init','--bare'],{signal});
  await git(bare,['fetch','--no-tags','--no-recurse-submodules','--depth=1',target.url,`refs/heads/${target.branch}`],{signal});
  const commit = await gitText(bare,['rev-parse','FETCH_HEAD'],{signal});
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw Error('远端未返回有效提交');
  const raw = await gitText(bare,['ls-tree','-rz','--full-tree',commit],{signal,maxBytes:8000000});
  const entries = raw.split('\0').filter(Boolean).map(line=>{
    const match = line.match(/^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/);
    return match && included(match[3]) ? {oid:match[2],path:match[3]} : null;
  }).filter(Boolean);
  if (entries.length > 2504) throw Error('仓库文档超过上限，请选择更小的能力仓库');
  if (!entries.length) throw Error('远端分支没有可读取的能力文件');
  const ids = [...new Set(entries.map(e=>e.oid))];
  const blob = await git(bare,['cat-file','--batch'],{signal,input:ids.join('\n')+'\n',maxBytes:34000000});
  const contents = new Map(); let offset=0;
  for(const id of ids) {
    const end=blob.indexOf(10,offset), header=blob.subarray(offset,end).toString('utf8');
    const match=header.match(/^([a-f0-9]{40,64}) blob (\d+)$/), size=Number(match?.[2]);
    if(end<0||match?.[1]!==id||!Number.isSafeInteger(size)||size>1000000||end+size+1>=blob.length)throw Error('能力文件过大或 Git 内容不完整');
    contents.set(id,blob.subarray(end+1,end+1+size));offset=end+size+2;
  }
  // A new immutable-by-convention snapshot per refresh prevents mixing revisions.
  const snapshot=fs.mkdtempSync(path.join(base,'snapshot-'));
  try {
    for(const entry of entries) {const dest=path.join(snapshot,entry.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,contents.get(entry.oid),{mode:0o600,flag:'wx'});}
    return {readPath:snapshot,commit,dirty:false};
  } catch(error) {fs.rmSync(snapshot,{recursive:true,force:true});throw error;}
}

async function prepare(a, input, signal) {
  const root=rootOf(input.path),updateMode=input.updateMode==='remote'?'remote':'local';
  if(updateMode==='local')return {path:root,readPath:root,updateMode,gitSource:null,commit:null,dirty:false,...await localVersion(root,signal)};
  if(!a?.dir)throw Error('远端更新需要 App 工作空间');
  const gitSource=input.gitSource||await remoteTarget(root,input,signal);
  return {path:root,updateMode,gitSource,...await remoteSnapshot(a,root,gitSource,signal)};
}

function cleanup(snapshot, a) {
  if(snapshot?.updateMode!=='remote'||!snapshot.readPath||!a?.dir)return;
  const relative=path.relative(path.join(a.dir,'capability-repositories'),snapshot.readPath);
  if(!/^[a-f0-9]{64}[/\\]snapshot-[a-zA-Z0-9]+$/.test(relative))return;
  // Cleanup is best-effort after state is saved; it never changes the source checkout.
  try{fs.rmSync(snapshot.readPath,{recursive:true,force:true});}catch{}
}

module.exports={readFile,rootOf,inventory,prepare,cleanup,localVersion,git,lintPaths};
