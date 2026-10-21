'use strict';
// These tools share the Agent action journal, approval UI and task ownership rules.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const now=()=>new Date().toISOString(),hash=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const definitions={run_code:['codeMode','运行代码'],mail_draft:['draftMode','保存邮件草稿'],generate_image:['mediaMode','生成图片'],synthesize_speech:['mediaMode','生成语音'],send_mail:['mailMode','发送 Outlook 邮件'],github_deploy:['deployMode','触发 GitHub 工作流']};
const actions=Object.keys(definitions);
function settings(input={}){return Object.fromEntries([...new Set(Object.values(definitions).map(r=>r[0]))].map(k=>[k,['mailMode','deployMode'].includes(k)?input[k]==='ask'?'ask':'off':['ask','auto'].includes(input[k])?input[k]:'off']));}
function mode(job,tool){const field=definitions[tool]?.[0],value=job.localTools?.[field];return ['mailMode','deployMode'].includes(field)?value==='ask'?'ask':'off':['ask','auto'].includes(value)?value:'off';}
function owned(a,job,id){const task=a.task(id);require('./task-trash.cjs').assertTask(task);if(task.agentJobId!==job.id||!job.taskIds.includes(id))throw Error('事项不属于当前委托');return task;}
function bounded(value,label,max){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'为空或超过长度限制');return value;}
function validate(a,job,tool,input){
 const args={taskId:input.taskId};
 if(tool==='run_code'){require('./local-tools.cjs').validateCode({...input,confirmed:true});Object.assign(args,{language:input.language,code:input.code});}
 if(['mail_draft','send_mail'].includes(tool))Object.assign(args,require('./local-external.cjs').mailInput(input));
 if(tool==='send_mail')args.connectorId=bounded(input.connectorId,'邮箱连接',100);
 if(tool==='github_deploy')Object.assign(args,require('./local-external.cjs').deployInput(input));
 if(tool==='generate_image'){args.prompt=bounded(input.prompt,'图片描述',10000);const provider=a.data.providers.find(p=>p.id===(input.providerId||a.data.settings?.roles?.execute)&&p.type==='codex')||(!input.providerId&&a.data.providers.find(p=>p.type==='codex'));if(!provider)throw Error('未找到已配置的订阅模型');args.providerId=provider.id;args.model=provider.model;}
 if(tool==='synthesize_speech')args.text=bounded(input.text,'朗读文本',5000);
 return args;
}
function scope(a,job,tool,args){
 if(mode(job,tool)==='off')throw Error('此委托未授权 '+definitions[tool][1]+'，请在委托的新增工具权限中开启');
 const folder=job.outputFolder;if(!folder||!path.isAbsolute(folder)||!fs.existsSync(folder)||fs.realpathSync(folder)!==path.resolve(folder)||!fs.statSync(folder).isDirectory())throw Error('此委托需要有效的交付目录');
 const extra={};
 if(tool==='send_mail'){const c=a.data.connectors.find(c=>c.id===args.connectorId&&c.enabled&&(c.projectId||null)===(job.projectId||null));if(!c)throw Error('邮箱连接不在当前委托范围或已停用');extra.external=require('./local-external.cjs').prepare(a,'mail',args);}
 if(tool==='github_deploy'){if(!job.githubRepo||job.githubRepo!==a.data.agentSettings.githubRepo)throw Error('部署仓库不在当前委托范围');extra.external=require('./local-external.cjs').prepare(a,'deployment',args);}
 if(tool==='generate_image'){const p=a.data.providers.find(p=>p.id===args.providerId&&p.type==='codex'&&p.model===args.model);if(!p)throw Error('图像模型配置已变化');}
 return {folder,fingerprint:hash([settings(job.localTools),folder,job.githubRepo||'',extra.external?.fingerprint,args.model]),...extra};
}
async function prepare(a,job,tool,input){
 if(a.data.agentActions.some(r=>r.jobId===job.id&&['running','uncertain'].includes(r.status)))throw Object.assign(Error('上次动作结果未核清，不能通过新计划重复执行'),{requiresInput:true});
 const task=owned(a,job,input.taskId);require('./agent-plan.cjs').assertReady(a,task);require('./evidence-consumption.cjs').assertDelivery(a,job,task);
 const args=validate(a,job,tool,input),s=scope(a,job,tool,args),step=task.steps.find(s=>!s.done),version=require('./agent-writes.cjs').version(task);
 if(step?.kind!=='external'||step.tool!==tool)throw Error('请先把本工具绑定到当前 external 计划步骤，再执行该步骤');
 require('./protocol-access.cjs').assertTool(a,job,'prepare_'+tool,args,{taskId:task.id});
 const key=hash([job.id,task.id,step.id||step.key,tool,args]);
 const previous=a.data.agentActions.findLast(r=>r.key===key);
 if(previous&&['done','running','uncertain'].includes(previous.status))return previous;
 if(previous?.status==='rejected'&&previous.version===version)throw Error('此动作已被拒绝，请修改方案');
 if(previous?.status==='pending'&&previous.version===version&&previous.scopeHash===s.fingerprint)return previous;
 if(previous?.status==='pending')previous.status='stale';
 const record={id:crypto.randomUUID(),jobId:job.id,taskId:task.id,tool,key,args,status:'pending',version,stepId:step.id,stepKey:step.key,scopeHash:s.fingerprint,target:s.external?.repo||s.external?.mail?.to||s.folder,title:definitions[tool][1]+' · '+task.title,content:JSON.stringify(args,null,2),createdAt:now()};
 a.data.agentActions.push(record);a.save();return record;
}
function inventory(root){
 const result=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),s=fs.lstatSync(file);if(s.isSymbolicLink())throw Error('产出包含链接，不能作为交付');if(s.isDirectory())walk(file);else if(s.isFile()){if(result.length>=100||s.size>100_000_000)throw Error('交付文件超过 100 个或单个超过 100 MB');result.push({path:file,bytes:s.size,sha256:hash(fs.readFileSync(file))});}}}walk(root);return result;
}
function verify(record){
 if(!record.result)throw Error('缺少实际执行回执');
 for(const item of record.result.files||[]){const root=record.outputFolder,relative=path.relative(root,item.path);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||fs.realpathSync(item.path)!==path.resolve(item.path)||fs.lstatSync(item.path).isSymbolicLink()||fs.statSync(item.path).size!==item.bytes||hash(fs.readFileSync(item.path))!==item.sha256)throw Error('交付文件已改变或丢失，请核对原产出');}
 return true;
}
function current(a,task,record){
 const job=a.data.delegations.find(j=>j.id===task.agentJobId&&!j.deletedAt);
 if(!job||task.deletedAt||task.agentCancelled||task.needsReplan||record.jobId!==job.id||record.taskId!==task.id||!actions.includes(record.tool)||record.status!=='done'||record.result?.verified!==true||record.deliveryConflict||record.presentationStatus==='historical'||!job.outputFolder||path.dirname(record.outputFolder||'')!==job.outputFolder)return false;
 return task.steps.some(s=>{let receipt;try{receipt=JSON.parse(s.evidence);}catch{}return s.kind==='external'&&s.done&&s.tool===record.tool&&(s.id||s.key)===(record.stepId||record.stepKey)&&receipt?.actionId===record.id;});
}
function deliveryContext(a,task,record){
 const active=current(a,task,record),value={tool:record.tool,actionId:record.id,current:active,result:record.result};if(!active)return value;
 verify(record);let remaining=64000;value.readback=[];
 for(const file of record.result.files||[]){if(!/\.(txt|md|csv|json|py|cjs|js|log|eml)$/i.test(file.path)||remaining<=0)continue;const size=Math.min(file.bytes,16000,remaining),buffer=Buffer.alloc(size),fd=fs.openSync(file.path,'r');try{fs.readSync(fd,buffer,0,size,0);}finally{fs.closeSync(fd);}const content=buffer.toString('utf8');remaining-=size;const row={filename:path.basename(file.path),sha256:file.sha256,content,truncated:file.bytes>size};
  if(/\.eml$/i.test(file.path)&&!row.truncated){const [headers,...body]=content.split(/\r?\n\r?\n/),subject=headers.match(/^Subject: =\?UTF-8\?B\?([^?]*)\?=/im)?.[1];row.mail={to:headers.match(/^To: (.*)$/im)?.[1]?.trim(),subject:subject?Buffer.from(subject,'base64').toString('utf8'):null,body:Buffer.from(body.join('\n\n').replace(/\s/g,''),'base64').toString('utf8'),unsent:/^X-Unsent: 1\r?$/m.test(headers)};}
  value.readback.push(row);
 }
 return value;
}
function evidence(a,task,record){
 const step=task.steps.find(s=>!s.done);
 if(step?.kind!=='external'||step.tool!==record.tool||(step.id||step.key)!==(record.stepId||record.stepKey))return;
 verify(record);step.done=true;step.evidence=JSON.stringify({actionId:record.id,...record.result});a.requeue(task);a.save();
}
async function execute(a,job,record){return require('./execution.cjs').withWrite(a,'local-action:'+record.id,()=>executeLocked(a,job,record));}
async function executeLocked(a,job,r){
 const task=owned(a,job,r.taskId);require('./agent-plan.cjs').assertReady(a,task);
 if(r.status==='done'){verify(r);return {...r.result,reused:true};}
 if(['running','uncertain'].includes(r.status)){
  if(r.result?.files?.length&&r.effectStatus==='applied'){verify(r);r.status='done';if(job.pendingActionId===r.id)job.pendingActionId=null;if(r.version===require('./agent-writes.cjs').version(task))evidence(a,task,r);a.save();return {...r.result,reused:true};}
  throw Object.assign(Error('上次动作结果未核清，请检查原运行目录或服务端记录；不会自动重复执行'),{requiresInput:true});
 }
 const s=scope(a,job,r.tool,r.args);
 if(r.content!==JSON.stringify(r.args,null,2))throw Error('待执行参数与已预览内容不一致，请重新准备');
 if(r.status!=='pending'||r.scopeHash!==s.fingerprint||r.version!==require('./agent-writes.cjs').version(task))throw Object.assign(Error('事项、授权或目标已变化，请重新准备动作'),{conflict:true});
 if(mode(job,r.tool)==='ask'&&!r.approvedAt)throw Object.assign(Error('请先批准此具体动作'),{requiresInput:true});
 require('./execution-gate.cjs').assert(a,{job,task});require('./evidence-consumption.cjs').assertDelivery(a,job,task);
 require('./protocol-access.cjs').assertTool(a,job,r.tool,r.args,{taskId:task.id,...(r.approvedAt?{action:r}:{})});
 const signal=a.controller?.signal;signal?.throwIfAborted();
 require('./action-facts.cjs').assertWritable(a);r.status='running';r.startedAt=now();job.pendingActionId=r.id;
 r.outputFolder=path.join(s.folder,'Agent-'+r.id);fs.mkdirSync(r.outputFolder);require('./action-facts.cjs').intent(a,r);a.save();
 let attempted=false;
 try{
  let result;const args=r.args,cwd=r.outputFolder;
  if(r.tool==='run_code'){
   const runtime=require('./host-process.cjs').executable(args.language==='python'?'python':'node');if(!runtime)throw Error('未安装所需代码运行环境');
   const script=path.join(cwd,args.language==='python'?'main.py':'main.cjs');fs.writeFileSync(script,args.code,{flag:'wx'});attempted=true;
   result=await require('./local-tools.cjs').execute(runtime,args.language==='python'?['-I','-B','-X','utf8',script]:[script],cwd,signal);
   if(result.exitCode!==0){r.result=result;throw Error('代码执行失败：'+(result.stderr||result.stdout).slice(0,4000));}
  }else if(r.tool==='mail_draft'){attempted=true;result=require('./local-tools.cjs').mailDraft({data:{agentSettings:{outputFolder:cwd}}},args);}
  else if(r.tool==='generate_image'){
   const count=a.data.agentActions.filter(row=>row.jobId===job.id&&row.tool==='generate_image'&&row.id!==r.id&&['done','running','uncertain'].includes(row.status)).length;
   if(count>=3)throw Object.assign(Error('本次委托已生成或提交 3 张图片，请核对结果后另建明确的图片委托'),{requiresInput:true});
   const provider=a.data.providers.find(p=>p.id===args.providerId),spend=require('./spend.cjs'),ticket=spend.reserve(a,provider,[{role:'user',content:args.prompt}]);
   try{require('./agent.cjs').chargeCall(a);attempted=true;result=await require('./local-media.cjs').image({prompt:args.prompt,model:args.model,cwd,signal});}
   finally{if(attempted)spend.settle(a,ticket,null,null);else spend.cancel(a,ticket);}
  }
  else if(r.tool==='synthesize_speech'){attempted=true;result=await require('./local-media.cjs').speech({text:args.text,cwd,signal});}
  else{result=await require('./local-external.cjs').submit(a,s.external,{signal,beforeSend(){signal?.throwIfAborted();if(scope(a,job,r.tool,r.args).fingerprint!==r.scopeHash)throw Error('授权已变化');attempted=true;}});if(result.status!=='accepted'){r.result=result;throw Object.assign(Error(result.message),{uncertain:result.status==='uncertain'});}}
  r.result={...result,files:inventory(cwd),outputFolder:cwd,verified:true,verification:'已核对实际执行回执及本地文件哈希；业务内容仍需结果检查'};require('./action-facts.cjs').outcome(a,r,r.result);r.status='done';r.finishedAt=now();delete r.error;
  if(job.pendingActionId===r.id)job.pendingActionId=null;if(require('./action-facts.cjs').eligible(a,r)&&scope(a,job,r.tool,r.args).fingerprint===r.scopeHash)evidence(a,task,r);
  a.event('Agent 已执行新增工具',r.title,task.id,'success');a.save();return r.result;
 }catch(error){if(r.status==='done'&&r.effectStatus==='applied')throw error;r.status=error.uncertain||attempted&&['send_mail','github_deploy','generate_image'].includes(r.tool)?'uncertain':'failed';r.error=error.message;r.finishedAt=now();if(r.status!=='uncertain'&&job.pendingActionId===r.id)job.pendingActionId=null;a.save();throw error;}
}
function context(a,job){return {modes:settings(job.localTools),tools:actions.map(tool=>({tool,mode:mode(job,tool)})),imageModels:a.data.providers.filter(p=>p.type==='codex').map(p=>({id:p.id,model:p.model})),outlook:(a.data.connectors||[]).filter(c=>c.provider==='outlook'&&c.enabled&&c.allowSend&&(c.projectId||null)===(job.projectId||null)).map(c=>({id:c.id,name:c.name}))};}
function configure(a,input){
 if(!require('./workspace-view.cjs').trustedCommand(a,'agentLocalSettings'))throw Error('请从委托权限界面修改');a.ensureIdle({jobId:input.id});
 const job=a.data.delegations.find(j=>j.id===input.id&&!j.deletedAt);if(!job)throw Error('委托不存在');
 require('./project-lifecycle.cjs').assertJobActive(a.data,job);
 if(a.data.agentActions.some(r=>r.jobId===job.id&&actions.includes(r.tool)&&['running','uncertain'].includes(r.status)))throw Error('请先核对未完成动作，不能通过变更权限重复执行');
 job.localTools=settings(input.localTools);job.workRevision=(job.workRevision||1)+1;
 for(const r of a.data.agentActions.filter(r=>r.jobId===job.id&&actions.includes(r.tool)&&r.status==='pending')){r.status='stale';delete r.approvedAt;if(job.pendingActionId===r.id)job.pendingActionId=null;}
 if(job.status==='approval')job.status='ready';job.updatedAt=now();
 if(a.dir)require('./access-policy-store.cjs').syncTrustedJob(a,job,{trusted:true,actor:'user_command',command:'agentLocalSettings'});a.save();return {id:job.id,localTools:job.localTools};
}
function read(a,job,input){
 const task=owned(a,job,input.taskId),r=a.data.agentActions.find(r=>r.id===input.actionId&&r.jobId===job.id&&r.taskId===task.id&&r.status==='done'&&actions.includes(r.tool));if(!r)throw Error('执行结果不属于本事项');
 if(!job.outputFolder||path.dirname(r.outputFolder)!==job.outputFolder)throw Error('原交付目录不在当前委托范围');verify(r);
 if(!input.filename)return {actionId:r.id,...r.result};
 const file=r.result.files.find(f=>path.relative(r.outputFolder,f.path)===input.filename);if(!file)throw Error('文件不在本次已核对的产出列表');
 if(!/\.(txt|md|csv|json|py|cjs|js|log|eml)$/i.test(file.path))return {file,content:null,message:'二进制产出请在应用中预览，不能按文本读取'};
 const start=input.start??0;if(!Number.isSafeInteger(start)||start<0)throw Error('分页起点无效');const text=fs.readFileSync(file.path,'utf8');return {file,content:text.slice(start,start+16000),start,total:text.length,next:start+16000<text.length?start+16000:null};
}
function preview(a,input){
 if(!require('./workspace-view.cjs').trustedCommand(a,'agentLocalPreview'))throw Error('请从 Agent 结果界面预览');
 const r=a.data.agentActions.find(r=>r.id===input.id&&r.status==='done'&&['generate_image','synthesize_speech'].includes(r.tool)),job=r&&a.data.delegations.find(j=>j.id===r.jobId&&!j.deletedAt);if(!r||!job)throw Error('媒体结果不存在');owned(a,job,r.taskId);verify(r);
 const bytes=require('./local-media.cjs').checkedFile(r.result.file,r.outputFolder,{pngOnly:r.tool==='generate_image'});return {kind:r.tool==='generate_image'?'image':'speech',url:'data:'+(r.tool==='generate_image'?'image/png':'audio/wav')+';base64,'+bytes.toString('base64')};
}
const prompt=`新增工具均须先 plan_task 建立 kind=external、tool=实际工具名的当前步骤。权限见 context.localTools，off 不可执行，ask 会自动准备预览，批准后续跑。run_code {taskId,language:"python|javascript",code}：在独立交付目录执行，60 秒、500 KB 输出上限；具有本机用户权限，不能用代码规避发信/部署/文件权限。mail_draft {taskId,to,subject,body}：只生成 .eml。generate_image {taskId,prompt,providerId?}：使用订阅生成 PNG。synthesize_speech {taskId,text}：离线 WAV。send_mail {taskId,connectorId,to,subject,body} 和 github_deploy {taskId,workflow,ref,inputs?}：准备明确预览并等待逐次批准；accepted 仅说明平台受理，不能宣称收件人已收到或部署成功。不要使用 advance_task 模拟工具执行；文件路径、哈希和回执才是证据。结果 uncertain 时不可换 key、换步骤或重新提交。`;
module.exports={actions,definitions,settings,mode,prepare,execute,evidence,verify,current,deliveryContext,context,prompt:prompt+'read_local_result {taskId,actionId,filename?,start?}：读取当前委托已生成文件的真实内容、哈希和执行回执；应使用它核验代码结果，不能仅凭退出码判定业务正确。每个委托最多提交 3 张图片。',inventory,configure,read,preview};
