const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const tools=require('./agent-tools.cjs');
const plan=require('./agent-plan.cjs');
const delivery=require('./delivery-format.cjs');
const uid=()=>crypto.randomUUID(), now=()=>new Date().toISOString();
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const actions=[...require('./agent-local.cjs').actions,'lark_create','lark_update','write_file','github_create','github_update','github_comment'];
const version=task=>hash({primaryArtifactId:task.primaryArtifactId,title:task.title,description:task.description,criteria:task.criteria,sources:task.sourceIds,notes:task.notes,steps:task.steps,dependsOn:task.dependsOn,needsReplan:task.needsReplan});
function owned(a,job,id){const t=a.task(id);require('./task-trash.cjs').assertTask(t);if(t.agentJobId!==job.id)throw new Error('事项不属于当前委托');return t;}
function latest(a,task){return require('./deliverables.cjs').select(a,task);}
function mode(job,tool,taskId){if(require('./agent-local.cjs').actions.includes(tool))return require('./agent-local.cjs').mode(job,tool);return ({lark_create:require('./lark-create-policy.cjs').mode(job,taskId),lark_update:!job.larkCreateGrant?'off':require('./lark-create-policy.cjs').policy(job,taskId)?.allowUpdate?'auto':'ask',write_file:job.fileMode,github_create:job.githubMode,github_update:job.githubUpdateMode,github_comment:job.githubCommentMode})[tool]||'off';}
function linkedIssue(a,job,task,number) {
  const n=number || task.githubIssue?.number || a.data.agentActions.findLast(r=>r.taskId===task.id&&r.tool==='github_create'&&r.status==='done')?.result?.number;
  if(!Number.isInteger(n)||n<1)throw new Error('请先读取并关联要更新的 Issue');
  const watcher=job.watchers.find(w=>w.tool==='github_read'&&w.args.number===n&&(w.taskIds?.includes(task.id)||task.sourceIds.includes(w.sourceId)));
  if(!watcher)throw new Error('请先用 github_read 读取此 Issue 并通过 taskId 关联事项');
  return {number:n,watcher};
}
function checkCommentRate(a,job,record) {
  const since=Date.now()-(job.commentIntervalMinutes||1440)*60000;
  const sent=a.data.agentActions.filter(r=>r.id!==record.id&&r.jobId===job.id&&r.tool==='github_comment'&&r.number===record.number&&['done','running','uncertain'].includes(r.status));
  const recent=sent.findLast(r=>Date.parse(r.finishedAt||r.startedAt||r.createdAt)>since);
  if(recent)throw Object.assign(new Error('此 Issue 尚在评论冷却期，已安排稍后继续'),{deferredUntil:new Date(Date.parse(recent.finishedAt||recent.startedAt||recent.createdAt)+(job.commentIntervalMinutes||1440)*60000).toISOString()});
  if(sent.length>=(job.maxComments||3))throw Object.assign(new Error('此 Issue 已达到委托的评论次数上限'),{requiresInput:true});
}
function assertOutputFolder(folder) {
  try {if(folder && path.isAbsolute(folder) && fs.realpathSync(folder)===folder && fs.statSync(folder).isDirectory())return;}catch{}
  throw new Error('原产出目录已不存在或被符号链接替换，请重新选择有效目录并核对原交付');
}
function outputName(a,job,task,value,requestedFormat) {
  if(value!==undefined&&(typeof value!=='string'||value!==value.trim()||value.startsWith('.')||/[\\/:*?"<>|\x00-\x1f\x7f]/.test(value)||!delivery.formats.has(delivery.formatOf(value))||Buffer.byteLength(value)>180||/^行知-[a-f0-9]{8}-/i.test(value)||/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(value)))throw new Error('文件名须为单个 Markdown、TXT、CSV 或 JSON 文件名，不能包含路径、隐藏名称、设备保留名或保留前缀，最长 180 字节');
  if(requestedFormat!==undefined)delivery.normalize(requestedFormat);
  if(value!==undefined&&requestedFormat!==undefined&&delivery.formatOf(value)!==requestedFormat)throw new Error('交付格式与文件名扩展名不一致');
  const previous=a.data.agentActions.findLast(r=>r.jobId===job.id&&r.taskId===task.id&&r.tool==='write_file'&&r.role!=='supporting'&&r.latestName&&path.dirname(r.target)===job.outputFolder&&['done','pending','running','uncertain'].includes(r.status));
  const format=requestedFormat??(value!==undefined?delivery.formatOf(value):previous?delivery.formatOf(previous.latestName):'md');
  const name=value??(previous&&delivery.formatOf(previous.latestName)===format?previous.latestName:`行知-${task.id.slice(0,8)}-最新.${format}`);
  const samePath=p=>String(p).normalize('NFC').toLowerCase()===path.join(job.outputFolder,name).normalize('NFC').toLowerCase();
  if(a.data.agentActions.some(r=>r.tool==='write_file'&&r.taskId!==task.id&&['done','pending','running','uncertain'].includes(r.status)&&(samePath(r.result?.latestPath)||r.latestName&&samePath(path.join(path.dirname(r.target),r.latestName)))) )throw Object.assign(new Error('此文件名已用于另一个事项，请选择不同名称'),{conflict:true});
  return {name,format};
}
function validateFileRecord(a,record,{currentTask}={}) {
  const format=delivery.normalize(record.fileFormat||delivery.formatOf(record.target)||'md');
  if(delivery.formatOf(record.target)!==format||(record.latestName&&delivery.formatOf(record.latestName)!==format))throw new Error('交付记录的文件格式不一致，请重新准备交付');
  delivery.validate(record.content,format);
  const artifact=a.data.artifacts.find(r=>r.id===record.artifactId&&r.taskId===record.taskId);
  if(!artifact||artifact.content!==record.content||(currentTask&&!require('./deliverables.cjs').current(a,currentTask).some(r=>r.id===artifact.id)))throw Object.assign(new Error('当前产出与交付记录不一致，请重新准备交付'),{conflict:true});
  return format;
}
async function prepare(a,job,tool,args) {
  if(require('./agent-local.cjs').actions.includes(tool))return require('./agent-local.cjs').prepare(a,job,tool,args);
  require('./protocol-access.cjs').assertTool(a,job,'prepare_'+tool,args,{taskId:args.taskId});
  const task=owned(a,job,args.taskId);plan.assertReady(a,task);
  require('./evidence-consumption.cjs').assertDelivery(a,job,task);
  if(task.steps.some(s=>!s.done&&s.outputRole==='primary'))throw Error('主稿修订尚未完成，不能交付旧版本');
  if(task.status==='paused')throw new Error('事项已暂停');
  const artifact=require('./deliverables.cjs').select(a,task,tool==='write_file'?args.artifactId:undefined);
  await require('./tool-evidence.cjs').refreshForDelivery(a,task);
  require('./grounding.cjs').assertDelivery(a,task);
  const supporting=require('./deliverables.cjs').role(a,task,artifact)==='supporting';
  if(supporting&&!args.filename)throw Error('保存辅助报告必须指定独立文件名');
  if(tool==='write_file'&&!job.outputFolder)throw new Error('此委托尚未选择产出文件夹');
  if(tool==='write_file')assertOutputFolder(job.outputFolder);
  if(tool!=='write_file'&&!['lark_create','lark_update'].includes(tool)&&!job.githubRepo)throw new Error('此委托未授权 GitHub 仓库');
  let number,watcher,body,desired,baseline;
  const updatePrior=tool==='lark_update'?require('./lark-publish.cjs').priorDocument(a,job,task.id,args.url):null;
  if(tool==='lark_create'&&a.data.agentActions.some(r=>r.taskId===task.id&&r.jobId===job.id&&r.tool==='lark_create'&&r.status==='done'&&r.artifactId!==artifact.id))throw Error('此事项已有飞书文档，请用 lark_update 更新原文档，不要重复创建');
  const destination=tool==='write_file'?outputName(a,job,task,args.filename,args.format):undefined;
  const latestName=destination?.name,fileFormat=destination?.format;
  if(supporting&&a.data.agentActions.some(r=>r.taskId===task.id&&r.tool==='write_file'&&r.role!=='supporting'&&r.latestName?.normalize('NFC').toLowerCase()===latestName.normalize('NFC').toLowerCase()))throw Error('辅助报告不能覆盖主稿文件，请使用独立文件名');
  if(tool==='write_file')try{delivery.validate(artifact.content,fileFormat);}catch(error){throw Object.assign(error,{invalidDelivery:true});}
  const namedFile=tool==='write_file'&&latestName!==`行知-${task.id.slice(0,8)}-最新.${fileFormat}`;
  if(['github_update','github_comment'].includes(tool))({number,watcher}=linkedIssue(a,job,task,args.number));
  if(tool==='github_comment') {
    if(typeof args.body!=='string'||!args.body.trim()||args.body.length>10000)throw new Error('评论内容需要 1–10000 字符');
    body=args.body.trim();
    require('./grounding.cjs').assertPayload(a,task,body,artifact.id);
  }
  if(tool==='github_update') {
    if(args.state!==undefined&&!['open','closed'].includes(args.state))throw new Error('Issue 状态无效');
    desired={...(args.updateBody===false?{}:{title:task.title,body:artifact.content}),...(args.state?{state:args.state}:{})};
    if(!Object.keys(desired).length)throw new Error('没有要更新的字段');
  }
  const key=hash([job.id,task.id,tool,tool==='github_create'?'one-issue':tool==='github_comment'?[number,body]:[artifact.id,number,desired,...(['lark_create','lark_update'].includes(tool)?[job.larkCreateGrant?.target,job.larkCreateGrant?.openId,...(tool==='lark_update'?[updatePrior.result.url]:[])]:[]),...(namedFile?[latestName]:[]),...(tool==='write_file'&&fileFormat!=='md'?[fileFormat]:[])]]);
  const old=a.data.agentActions.findLast(r=>r.key===key);
  if(old&&['done','running','uncertain'].includes(old.status)){
    let republish=false;
    if(tool==='write_file'&&old.status==='done'&&old.result?.latestPath&&tools.readOutput(old.result.latestPath)!==artifact.content){
      const owner=a.data.agentActions.findLast(r=>r.taskId===task.id&&r.tool==='write_file'&&r.status==='done'&&r.result?.latestPath===old.result.latestPath);
      if(!owner||hash(tools.readOutput(old.result.latestPath))!==owner.result.latestHash)throw Object.assign(Error('最新版本文件被人工修改，已保留，请处理冲突后重试'),{conflict:true});
      republish=true;
    }
    if(!republish)return old;
  }
  if(old?.status==='rejected'&&old.version===version(task))throw new Error('该具体动作已被拒绝，请修改方案后再执行');
  if(old?.status==='pending'&&old.version===version(task))return old;
  const record={id:uid(),jobId:job.id,taskId:task.id,key,tool,status:'pending',version:version(task),artifactId:artifact.id,createdAt:now(),args:{taskId:task.id},target:tool==='write_file'?path.join(job.outputFolder,`行知-${task.id.slice(0,8)}-${artifact.id.slice(0,8)}.${fileFormat}`):['lark_create','lark_update'].includes(tool)?job.larkCreateGrant?.target:job.githubRepo,title:task.title,content:body||artifact.content,number};
  if(['lark_create','lark_update'].includes(tool)){
    require('./lark-publish.cjs').destination(record.target);record.larkOpenId=job.larkCreateGrant?.openId;record.larkUserName=job.larkCreateGrant?.userName;
    if(!record.larkOpenId)throw Error('请先连接飞书并确认文档创建权限');
    if(a.data.agentActions.some(r=>r.jobId===job.id&&r.taskId===task.id&&['lark_create','lark_update'].includes(r.tool)&&['running','uncertain'].includes(r.status)))throw needs('请先核对上次飞书创建结果，不能重复创建');
  }
  if(tool==='lark_update')await require('./lark-publish.cjs').prepareUpdate(a,job,task,record,updatePrior.result.url);
  if(tool==='write_file') {
    record.latestName=latestName;record.fileFormat=fileFormat;record.role=supporting?'supporting':'primary';
    if(args.artifactId)record.args.artifactId=args.artifactId;
    if(fileFormat!=='md')record.args.format=fileFormat;
    if(namedFile)record.args.filename=latestName;
    record.latestExpectedHash=a.data.agentActions.findLast(r=>r.taskId===task.id&&r.tool==='write_file'&&r.status==='done'&&r.result?.latestPath===path.join(job.outputFolder,record.latestName))?.result?.latestHash||null;
    if(namedFile&&!record.latestExpectedHash&&fs.existsSync(path.join(job.outputFolder,latestName)))throw Object.assign(new Error('指定文件已存在且不属于此事项的交付，已保留，请选择不同文件名'),{conflict:true});
  }
  if(tool==='github_comment')checkCommentRate(a,job,record);
  if(tool==='github_update') {
    const raw=await tools.github(a,job.githubRepo,`issues/${number}`,{signal:a.controller?.signal,permissionScope:job});
    if(raw.pull_request||raw.number!==number)throw new Error('目标不是有效的 Issue');
    if(watcher.revision!==tools.revision(raw))throw Object.assign(new Error('Issue 已有新修改，请重新读取后决定如何合并'),{conflict:true});
    baseline={title:raw.title,body:raw.body||'',state:raw.state,revision:tools.revision(raw)};
    // Keep stable creation markers so a later restart can still reconcile creation.
    if(desired.body!==undefined){const markers=(raw.body||'').match(/<!-- xingzhi:[a-f0-9]+ -->/g)||[];desired.body+=markers.length?`\n\n${markers.join('\n')}`:'';}
    Object.assign(record,{baseline,desired,content:JSON.stringify(desired,null,2)});
  }
  if(old)old.status='stale';a.data.agentActions.push(record);a.save();return record;
}
function evidence(a,task,record) {
  if(require('./agent-local.cjs').actions.includes(record.tool))return require('./agent-local.cjs').evidence(a,task,record);
  const step=task.steps.find(s=>!s.done);
  if(step?.kind==='external'&&step.tool===record.tool&&latest(a,task).id===record.artifactId) {
    step.done=true;step.evidence=JSON.stringify({actionId:record.id,...record.result});a.requeue(task);a.save();
  }
}
const matches=(raw,desired)=>Object.entries(desired).every(([key,value])=>(raw[key]??'')===value);
const needs=message=>Object.assign(new Error(message),{requiresInput:true});
const githubBody=record=>`${record.content}\n\n<!-- xingzhi:${record.key} -->`;
function githubLink(value,host,target,fragment=''){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname===host&&!url.username&&!url.password&&!url.port&&!url.search&&url.pathname.toLowerCase()===target.toLowerCase()&&url.hash===fragment;
  }catch{return false;}
}
const githubTarget=(value,repo,number,commentId)=>githubLink(value,'github.com',`/${repo}/issues/${number}`,commentId?`#issuecomment-${commentId}`:'');
function verifyIssue(actual,record,number,{created=false}={}){
  const expected=created?{title:record.title,body:githubBody(record)}:record.desired;
  if(!Number.isSafeInteger(number)||number<1||actual?.number!==number||actual.pull_request||!githubTarget(actual.html_url,record.target,number)||!expected||!Object.keys(expected).length||!matches(actual,expected))throw needs('GitHub 交付回读不一致或目标已变化，请核对原 Issue；不会重复创建或覆盖');
}
function verifyComment(actual,record,commentId){
  const id=actual?.id;
  if(!Number.isSafeInteger(id)||id<1||(commentId!==undefined&&id!==commentId)||actual.body!==githubBody(record)||!githubTarget(actual.html_url,record.target,record.number,id)||(actual.issue_url&&!githubLink(actual.issue_url,'api.github.com',`/repos/${record.target}/issues/${record.number}`)))throw needs('GitHub 评论交付回读不一致或目标已变化，请核对原评论；不会重复发送');
}
async function reconcile(a,job,record){
  // A prior attempt can only be inspected. Missing evidence never authorizes another write.
  job.pendingActionId=record.id;record.status='uncertain';a.save();
  require('./execution-gate.cjs').assert(a,{job,readOnly:true});
  require('./protocol-access.cjs').assertTool(a,job,'prepare_'+record.tool,record.args,{taskId:record.taskId});
  const signal=a.controller?.signal,marker=`<!-- xingzhi:${record.key} -->`;let result;
  try{
    signal?.throwIfAborted();
    if(['lark_create','lark_update'].includes(record.tool)){
      await require('./lark-publish.cjs').checkGrant(a,job,record);
      result=await require('./lark-publish.cjs').readback(a,record);
      result=saveLarkReadback(a,job,record,result);
    }else if(record.tool==='write_file'){
      if(path.dirname(record.target)!==job.outputFolder)throw needs('原产出目录已不在授权范围，请人工核对原文件');
      assertOutputFolder(job.outputFolder);
      const format=validateFileRecord(a,record);
      const latestPath=path.join(job.outputFolder,record.latestName||`行知-${record.taskId.slice(0,8)}-最新.md`);
      if(tools.readOutput(record.target)!==record.content||tools.readOutput(latestPath)!==record.content)throw needs('上次文件交付结果不一致，请核对后处理；不会自动覆盖');
      result={path:record.target,latestPath,format,bytes:Buffer.byteLength(record.content),hash:hash(record.content),latestHash:hash(record.content),verified:true};
    }else{
      if(record.target!==job.githubRepo)throw needs('原 GitHub 仓库已不在授权范围，请人工核对原执行结果');
      if(record.tool==='github_create'){
        const found=await tools.findIssue(a,record.target,marker,signal,{permissionScope:job});
        if(!found)throw needs('上次创建结果不明，未找到对应 Issue；请核对 GitHub 后处理，系统不会盲目重发');
        const actual=await tools.github(a,record.target,`issues/${found.number}`,{signal,permissionScope:job});
        verifyIssue(actual,record,found.number,{created:true});
        result={...tools.issueData(actual),verified:true};
      }else if(record.tool==='github_update'){
        const actual=await tools.github(a,record.target,`issues/${record.number}`,{signal,permissionScope:job});
        verifyIssue(actual,record,record.number);
        result={...tools.issueData(actual),verified:true};
      }else{
        const actual=await tools.findComment(a,record.target,record.number,marker,signal,{permissionScope:job});
        if(!actual)throw needs('上次评论结果不明，未找到对应记录；不会重复发送');
        verifyComment(actual,record,record.result?.commentId);
        result={commentId:actual.id,number:record.number,url:actual.html_url,body:actual.body,verified:true};
      }
    }
    signal?.throwIfAborted();
    if(!['lark_create','lark_update'].includes(record.tool))require('./action-facts.cjs').outcome(a,record,result);
    record.status='done';record.result=result;record.finishedAt=now();delete record.error;
    const task=owned(a,job,record.taskId);
    if(record.tool==='github_create')task.githubIssue={repo:record.target,number:result.number};
    if(record.version===version(task)&&!task.needsReplan&&task.status!=='paused')evidence(a,task,record);
    if(job.pendingActionId===record.id)job.pendingActionId=null;
    a.event('Agent 已核对执行结果',`${record.tool}：已只读确认原动作，未重复写入`,task.id,'success');a.save();return result;
  }catch(error){if(record.effectStatus==='applied'&&record.status==='done'){error.committed=true;throw error;}record.status='uncertain';record.error=error.message;a.save();throw needs(error.message);}
}
function saveLarkReadback(a,job,record,result){
  const {readbackContent,...receipt}=result;
  const saved=require('./action-facts.cjs').outcome(a,record,{...receipt,note:'创建回执和正文可读性已核对；请读取 sourceId 对照预期稿检查正文与链接，内容是否满足目标仍需结果检查和用户验收。'},readbackContent);
  return saved;
}
async function execute(a,job,record) {
  if(require('./agent-local.cjs').actions.includes(record.tool))return require('./agent-local.cjs').execute(a,job,record);
  const key=record.tool==='write_file'?'file:'+path.join(path.dirname(record.target),record.latestName||path.basename(record.target)).normalize('NFC').toLowerCase():record.tool.startsWith('github_')?'github:'+record.target.toLowerCase()+':'+(record.number||record.key):record.tool==='lark_update'?'lark:'+record.baseline.url:'action:'+record.id;
  return require('./execution.cjs').withWrite(a,key,()=>executeLocked(a,job,record));
}
async function executeLocked(a,job,record) {
  require('./project-lifecycle.cjs').assertJobActive(a.data,job);
  const task=owned(a,job,record.taskId);
  if(['running','uncertain'].includes(record.status))return reconcile(a,job,record);
  require('./evidence-consumption.cjs').assertDelivery(a,job,task);
  plan.assertReady(a,task);
  if(mode(job,record.tool,record.taskId)==='off')throw new Error('此委托未允许该写入工具');
  if(record.tool==='write_file')validateFileRecord(a,record,{currentTask:task});
  if(['lark_create','lark_update'].includes(record.tool)){if(latest(a,task).id!==record.artifactId||latest(a,task).content!==record.content)throw Object.assign(Error('飞书待发布文稿已变化，请重新准备'),{conflict:true});await require('./lark-publish.cjs').checkGrant(a,job,record);}
  if(record.status==='done')return {...record.result,reused:true};
  if(require('./projects.cjs').relatedActions(a,job).some(r=>r.id!==record.id&&['running','uncertain'].includes(r.status)))throw needs('请先核对之前的外部执行结果');
  if(job.status==='paused')throw needs('委托已暂停');
  if(mode(job,record.tool,record.taskId)==='ask'&&!record.approvedAt)throw needs('请先确认此具体写入动作');
  if(task.status==='paused'||record.version!==version(task)){record.status='stale';throw Object.assign(new Error('事项或产出已变化，原动作确认已失效'),{conflict:true});}
  let attempted=false;
  if(['lark_create','lark_update'].includes(record.tool)&&mode(job,record.tool,record.taskId)==='auto')record.authorization={kind:'task_policy',...require('./lark-create-policy.cjs').policy(job,record.taskId)};
  require('./execution-gate.cjs').assert(a,{job,task});
  await require('./tool-evidence.cjs').refreshForDelivery(a,task);
  require('./grounding.cjs').assertDelivery(a,task);
  require('./grounding.cjs').assertAction(a,task,record);
  require('./evidence-consumption.cjs').assertDelivery(a,job,task);
  require('./protocol-access.cjs').assertTool(a,job,record.tool,record.args,{taskId:record.taskId,...(mode(job,record.tool,record.taskId)==='ask'?{action:record}:{})});
  require('./action-facts.cjs').assertWritable(a);
  record.status='running';record.startedAt=now();job.pendingActionId=record.id;require('./action-facts.cjs').intent(a,record);a.save();
  const signal=a.controller?.signal;
  try {
    signal?.throwIfAborted();let result;
    if(['lark_create','lark_update'].includes(record.tool)){
      signal?.throwIfAborted();
      if(record.tool==='lark_create'){result=await require('./lark-publish.cjs').create(a,record,()=>{attempted=true;});}
      else result=await require('./lark-publish.cjs').update(a,record,()=>{attempted=true;});
      result=saveLarkReadback(a,job,record,result);
    } else if(record.tool==='write_file') {
      if(path.dirname(record.target)!==job.outputFolder)throw new Error('原产出目录已不在授权范围，请重新准备写入');
      const format=validateFileRecord(a,record,{currentTask:task});
      if(record.args?.filename&&!record.latestExpectedHash&&fs.existsSync(path.join(job.outputFolder,record.latestName)))throw Object.assign(new Error('确认后指定文件已被创建，已保留，请选择不同文件名'),{conflict:true});
      attempted=true;result=tools.outputFile(job.outputFolder,path.basename(record.target),record.content);
      record.result=result;require('./action-facts.cjs').receipt(a,record);
      result.format=format;
      Object.assign(result,tools.publishLatest(job.outputFolder,record.latestName||`行知-${task.id.slice(0,8)}-最新.md`,record.content,record.latestExpectedHash??null));
    } else {
      if(record.target!==job.githubRepo)throw new Error('GitHub 仓库授权已变化');
      const marker=`<!-- xingzhi:${record.key} -->`;
      if(record.tool==='github_create') {
        const existing=await tools.findIssue(a,job.githubRepo,marker,signal,{permissionScope:job});
        let number=existing?.number;
        if(!existing) {
          signal?.throwIfAborted();attempted=true;
          const raw=await tools.github(a,job.githubRepo,'issues',{method:'POST',signal,action:record,body:{title:record.title,body:`${record.content}\n\n${marker}`}});
          if(!Number.isInteger(raw.number)||!raw.html_url)throw new Error('GitHub 未返回有效的创建结果，请核对仓库');
          number=raw.number;
          record.result={number,url:raw.html_url};require('./action-facts.cjs').receipt(a,record);
        }
        // A marker locates a prior side effect; only the full current readback proves delivery.
        const actual=await tools.github(a,job.githubRepo,`issues/${number}`,{signal,permissionScope:job});
        verifyIssue(actual,record,number,{created:true});result=tools.issueData(actual);
        task.githubIssue={repo:job.githubRepo,number:result.number};result.verified=true;
      } else if(record.tool==='github_update') {
        let actual=await tools.github(a,job.githubRepo,`issues/${record.number}`,{signal,permissionScope:job});
        if(!matches(actual,record.desired)) {
          if(tools.revision(actual)!==record.baseline.revision)throw Object.assign(new Error('确认后 Issue 又被修改，已停止写入；请重新读取并合并'),{conflict:true});
          signal?.throwIfAborted();attempted=true;
          await tools.github(a,job.githubRepo,`issues/${record.number}`,{method:'PATCH',signal,action:record,body:record.desired});
          record.result={number:record.number,url:actual.html_url,updateAcknowledged:true};require('./action-facts.cjs').receipt(a,record);
          actual=await tools.github(a,job.githubRepo,`issues/${record.number}`,{signal,permissionScope:job});
        }
        verifyIssue(actual,record,record.number);
        result={...tools.issueData(actual),verified:true};
      } else {
        const posted=await tools.findComment(a,job.githubRepo,record.number,marker,signal,{permissionScope:job});
        let actual=posted,commentId=posted?.id;
        if(!actual) {
          checkCommentRate(a,job,record);signal?.throwIfAborted();attempted=true;
          const raw=await tools.github(a,job.githubRepo,`issues/${record.number}/comments`,{method:'POST',signal,action:record,body:{body:`${record.content}\n\n${marker}`}});
          if(!Number.isInteger(raw.id))throw new Error('GitHub 未返回有效评论编号');
          commentId=raw.id;
          record.result={commentId,number:record.number,url:raw.html_url};require('./action-facts.cjs').receipt(a,record);
          actual=await tools.github(a,job.githubRepo,`issues/comments/${raw.id}`,{signal,permissionScope:job});
        }
        verifyComment(actual,record,commentId);
        result={commentId:actual.id,number:record.number,url:actual.html_url,body:actual.body,verified:true};
      }
    }
    if(!['lark_create','lark_update'].includes(record.tool))require('./action-facts.cjs').outcome(a,record,result);
    record.status='done';record.result=result;record.finishedAt=now();delete record.error;
    if(job.pendingActionId===record.id)job.pendingActionId=null;
    if(require('./action-facts.cjs').eligible(a,record))evidence(a,task,record);a.event('Agent 已执行动作',`${record.tool}：${result.latestPath||result.path||result.url}`,task.id,'success');a.save();return result;
  } catch(error){if(record.effectStatus==='applied'&&record.status==='done'){error.committed=true;throw error;}const rejected=['lark_create','lark_update'].includes(record.tool)&&!record.result?.created&&!record.result?.updateAcknowledged&&['auth','permission','missing_cli'].includes(error.connectorCode);record.status=!rejected&&(attempted||error.requiresInput)?'uncertain':'failed';record.error=error.message;if(record.status!=='uncertain'&&job.pendingActionId===record.id)job.pendingActionId=null;a.save();throw error;}
}
async function verifyDelivery(a,job,task) {
  for(const r of a.data.agentActions.filter(r=>r.jobId===job.id&&r.taskId===task.id&&r.status==='done'&&require('./agent-local.cjs').actions.includes(r.tool)))require('./agent-local.cjs').verify(r);
  const records=a.data.agentActions.filter(r=>r.taskId===task.id&&r.jobId===job.id&&r.status==='done');
  if(job.outputFolder&&job.fileMode!=='off'&&task.steps.some(s=>s.kind!=='external')) {
    assertOutputFolder(job.outputFolder);
    const artifact=latest(a,task);
    const saved=records.findLast(r=>r.tool==='write_file'&&r.artifactId===artifact.id);
    if(!saved)throw new Error('当前最新产出尚未保存到指定文件夹，请先调用 write_file');
    validateFileRecord(a,saved,{currentTask:task});
    if(tools.readOutput(saved.result.path)!==artifact.content || (saved.result.latestPath&&tools.readOutput(saved.result.latestPath)!==artifact.content))throw new Error('交付文件已被修改或丢失，不能标记完成');
  }
  for(const record of records.filter(r=>['lark_create','lark_update'].includes(r.tool)&&r.artifactId===latest(a,task).id)){await require('./lark-publish.cjs').checkGrant(a,job,record);await require('./lark-publish.cjs').readback(a,record);}
  const external=records.filter(r=>['github_create','github_update'].includes(r.tool));
  const targets=new Map();
  for(const record of external.reverse()) {
    if(record.target!==job.githubRepo)throw needs('原 GitHub 仓库已不在授权范围，请人工核对原交付');
    const number=record.number||record.result?.number,expected=record.desired||{title:record.title,body:githubBody(record)};
    const target=targets.get(number)||{record,expected:{}};
    // A later state-only update replaces the expected state, not the delivered body.
    for(const [key,value] of Object.entries(expected))if(!Object.hasOwn(target.expected,key))target.expected[key]=value;
    targets.set(number,target);
  }
  for(const [number,{record,expected}] of targets){
    const actual=await tools.github(a,job.githubRepo,`issues/${number}`,{signal:a.controller?.signal,permissionScope:job});
    verifyIssue(actual,{...record,desired:expected},number);
  }
  for(const record of records.filter(r=>r.tool==='github_comment')){
    if(record.target!==job.githubRepo)throw needs('原 GitHub 仓库已不在授权范围，请人工核对原交付');
    const id=record.result?.commentId,signal=a.controller?.signal;
    // Older receipts can be located by their saved marker without sending anything again.
    const actual=Number.isSafeInteger(id)&&id>0?await tools.github(a,job.githubRepo,`issues/comments/${id}`,{signal,permissionScope:job}):await tools.findComment(a,job.githubRepo,record.number,`<!-- xingzhi:${record.key} -->`,signal,{permissionScope:job});
    verifyComment(actual,record,Number.isSafeInteger(id)&&id>0?id:undefined);
  }
}
function readRecordedFile(a,job,task,record){
 if(record.taskId!==task.id||record.jobId!==job.id||record.tool!=='write_file'||record.status!=='done'||job.fileMode==='off')throw Error('文件回读不在当前授权范围');
 assertOutputFolder(job.outputFolder);validateFileRecord(a,record,{currentTask:task});
 const paths=[record.result?.path,record.result?.latestPath].filter(Boolean);if(!paths.length)throw Error('文件回执缺少实际路径');
 return paths.map(file=>{if(path.dirname(file)!==job.outputFolder||fs.realpathSync(file)!==path.resolve(file)||fs.lstatSync(file).isSymbolicLink())throw Error('文件回读路径超出当前交付目录');const content=tools.readOutput(file);if(content!==record.content)throw Error('交付文件已改变');return {path:file,hash:hash(content)};});
}
function observeRecordedFile(a,job,task,record){
 if(!job||record.taskId!==task.id||record.jobId!==job.id||record.tool!=='write_file'||record.status!=='done')throw Error('文件回读不在当前授权范围');
 require('./execution-gate.cjs').assert(a,{job,task,readOnly:true});
 const artifacts=a.data.artifacts.filter(r=>r.id===record.artifactId);
 const access=require('./protocol-access.cjs');
 if(artifacts.length!==1||!access.readScopes(a,'artifact',artifacts[0],{task}).length||!access.allowedObject(a,'artifact',artifacts[0],job,task))throw Error('历史文件稿件不在当前可读范围');
 // Historical observations compare the recorded version, independently of
 // which artifact is now the primary delivery. Delivery gates stay strict.
 validateFileRecord(a,record);
 const paths=[...new Set([record.result?.path,record.result?.latestPath].filter(Boolean))];if(!paths.length)throw Error('文件回执缺少实际路径');
 return paths.map(file=>{
  if(path.resolve(file)!==file)throw Error('文件回读路径超出当前授权目录');
  const folder=(a.data.folders||[]).find(f=>(job.folderIds||[]).includes(f.id)&&f.path===path.dirname(file));
  if(folder){assertOutputFolder(folder.path);require('./protocol-access.cjs').assertTool(a,job,'read_file',{folderId:folder.id,name:path.basename(file)},{taskId:task.id});}
  else {if(job.fileMode==='off'||path.dirname(file)!==job.outputFolder)throw Error('文件回读不在当前授权目录');assertOutputFolder(job.outputFolder);}
  const base={fileName:path.basename(file),expectedHash:hash(record.content)};
  try{
   if(fs.lstatSync(file).isSymbolicLink()||fs.realpathSync(file)!==path.resolve(file))throw Error('文件回读路径超出当前交付目录');
   const content=tools.readOutput(file);
   return {...base,exists:true,currentHash:hash(content),contentMatches:content===record.content,characters:content.length,excerpt:content.slice(0,1200),excerptComplete:content.length<=1200};
  }catch(error){if(error.code!=='ENOENT')throw error;return {...base,exists:false,currentHash:null,contentMatches:false,characters:null,excerpt:'',excerptComplete:false};}
 });
}
async function readRecordedDelivery(a,job,task,record){
 if(record.taskId!==task.id||record.jobId!==job.id||record.status!=='done')throw Error('动作不在当前事项范围或尚未完成');
 if(record.tool==='write_file')return readRecordedFile(a,job,task,record);
 if(['lark_create','lark_update'].includes(record.tool)){await require('./lark-publish.cjs').checkGrant(a,job,record);return require('./lark-publish.cjs').readback(a,record);}
 if(record.target!==job.githubRepo)throw Error('原 GitHub 目标已不在当前授权范围');
 const signal=a.controller?.signal;
 if(['github_create','github_update'].includes(record.tool)){const number=record.number||record.result?.number;if(!Number.isSafeInteger(number)||number<1)throw Error('缺少实际 Issue 编号');const actual=await tools.github(a,job.githubRepo,`issues/${number}`,{signal,permissionScope:job});verifyIssue(actual,record,number);return actual;}
 if(record.tool==='github_comment'){const id=record.result?.commentId;if(!Number.isSafeInteger(id)||id<1)throw Error('缺少实际评论编号');const actual=await tools.github(a,job.githubRepo,`issues/comments/${id}`,{signal,permissionScope:job});verifyComment(actual,record,id);return actual;}
 throw Error('此动作没有可用的新鲜只读回读');
}
module.exports={actions,version,latest,mode,prepare,execute,evidence,verifyDelivery,readRecordedDelivery,readRecordedFile,observeRecordedFile};
