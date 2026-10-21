const projectLifecycle=require('./project-lifecycle.cjs');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const tools=require('./agent-tools.cjs');
const projectSources=require('./project-rule-sources.cjs');
const changeTrigger=config=>['changes','project_changes'].includes(config.trigger);
const uid=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const day=(at=Date.now())=>{const d=new Date(at);return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;};
const tomorrow=(at=Date.now())=>{const d=new Date(at);d.setDate(d.getDate()+1);d.setHours(0,0,0,0);return d.toISOString();};
const required=(v,label,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`${label}不能为空且不能超过 ${max} 字符`);return v.trim();};
const integer=(v,min,max,fallback)=>{if(v==null)return fallback;if(!Number.isInteger(Number(v))||Number(v)<min||Number(v)>max)throw new Error(`数值必须在 ${min}–${max} 之间`);return Number(v);};
const mode=v=>['ask','auto'].includes(v)?v:'off';
function initialize(a) {
  a.data.workRules ||= [];a.data.ruleRuns ||= [];
  for(const r of a.data.ruleRuns)if(r.status==='running'){r.status='interrupted';r.finishedAt=now();}
  for(const r of a.data.workRules){r.pending ||= [];r.fingerprints ||= {};r.usage ||= {day:day(),calls:0,starts:0};}
}
function byId(a,id){const r=a.data.workRules.find(r=>r.id===id);if(!r)throw new Error('工作规则不存在');return r;}
function projectTriggerPending(a,job){
  if(!job?.ruleId)return false;
  const list=Array.isArray(a.data?.workRules)?a.data.workRules:[],rule=list.find(r=>r?.id===job.ruleId);
  if(rule&&!rule.config)return true;
  if(!rule||rule.config.trigger!=='project_changes'||rule.status!=='enabled'||job.ruleRevision!==rule.revision)return false;
  try{return job.projectId!==rule.config.projectId||require('./projects.cjs').byId(a,rule.config.projectId).jobId!==job.id||!!job.projectRuleAwaitingTrigger||!rule.projectAuthorizedSignature||rule.projectAuthorizedSignature!==projectSources.signature(a,rule.config);}catch{return true;}
}
function projectIngest(a,job,{note='',additions=0}={}){
  const rule=(Array.isArray(a.data?.workRules)?a.data.workRules:[]).find(r=>r?.id===job?.ruleId);if(rule?.config?.trigger!=='project_changes')return;
  if(note){delete job.projectRuleAwaitingTrigger;return;}
  if(additions&&job.status==='completed')job.projectRuleAwaitingTrigger=true;
}
function canRun(a,job) {
  if(!projectLifecycle.isJobActive(a.data,job))return false;
  if(!job.ruleId)return true;
  const rule=a.data.workRules.find(r=>r.id===job.ruleId);
  return !!rule&&rule.status==='enabled'&&projectLifecycle.isActive(a.data,rule.config.projectId)&&job.ruleRevision===rule.revision&&!projectTriggerPending(a,job);
}
function rollDay(a,rule) {
  if(rule.usage.day===day())return false;
  rule.usage={day:day(),calls:0,starts:0};
  for(const j of a.data.delegations.filter(j=>j.ruleId===rule.id&&j.ruleRevision===rule.revision&&j.status==='limited'&&j.limitReason==='rule_daily')) {
    if(rule.status==='enabled'&&projectLifecycle.isActive(a.data,rule.config.projectId)){j.status='ready';j.nextRunAt=now();j.limitReason=null;}
  }
  return true;
}
function charge(a,job) {
  if(!job.ruleId)return;
  const rule=byId(a,job.ruleId);
  if(!canRun(a,job))throw Object.assign(new Error('工作规则已暂停或版本已变化'),{rulePaused:true});
  rollDay(a,rule);
  rule.usage.calls++;
}
function normalize(a,input) {
  if(input.trigger==='project_changes')projectSources.assertScope(input);
  const existing=input.id?byId(a,input.id):null;
  // Recipe provenance is checked only when a new rule is prepared. Existing
  // rules keep the saved snapshot even when that recipe is revised or archived.
  if(existing&&input.templateId)throw new Error('已有规则沿用保存的工作方案；如需更换方案，请从方案新建规则');
  const template=existing?.config.template?structuredClone(existing.config.template):existing?null:require('./playbooks.cjs').validateDraft(a,input);
  const config={localTools:require('./agent-local.cjs').settings(input.localTools),projectId:input.projectId||null,name:required(input.name,'规则名称',100),goal:required(input.goal,'工作目标',10000),trigger:['daily','weekly','project_changes'].includes(input.trigger)?input.trigger:'changes',time:input.time||'09:00',weekday:integer(input.weekday,0,6,1),intervalMinutes:integer(input.intervalMinutes,5,1440,15),includeExisting:input.includeExisting!==false,folderIds:Array.isArray(input.folderIds)?[...new Set(input.folderIds)]:[],urls:Array.isArray(input.urls)?[...new Set(input.urls.map(u=>tools.webURL(u).href))]:[],filename:String(input.filename||'').trim().slice(0,100),keyword:String(input.keyword||'').trim().slice(0,200),useGithub:input.useGithub===true,githubRepo:input.useGithub?tools.repository(input.githubRepo||a.data.agentSettings.githubRepo):'',allowWeb:input.allowWeb!==false,useOutputFolder:input.useOutputFolder===true,outputFolder:input.useOutputFolder?a.data.agentSettings.outputFolder:'',fileMode:mode(input.fileMode),githubMode:mode(input.githubMode),githubUpdateMode:mode(input.githubUpdateMode),githubCommentMode:mode(input.githubCommentMode),commentIntervalMinutes:integer(input.commentIntervalMinutes,60,10080,1440),maxComments:integer(input.maxComments,1,10,3),autoAccept:input.autoAccept!==false,maxActions:integer(input.maxActions,1,12,6),dailyStarts:integer(input.dailyStarts,1,20,3)};
  if(template)config.template=template;
  config.capabilityIds=input.capabilityIds||[];config.capabilityGrants=require('./capabilities.cjs').grants(a,config.capabilityIds);
  if(config.trigger==='project_changes'){if(!config.projectId)throw new Error('项目资料变化规则必须选择项目');if(config.folderIds.length||config.urls.length||config.useGithub||config.filename)throw new Error('项目资料变化规则仅使用已入库材料，不能混用目录、网址、GitHub扫描或文件名筛选');}
  if(config.projectId)require('./projects.cjs').byId(a,config.projectId);
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.time))throw new Error('执行时间须为 HH:mm');
  if(config.urls.length>5||config.folderIds.length>5)throw new Error('每条规则最多选择 5 个网址和 5 个目录');
  if(config.folderIds.some(id=>!a.data.folders.some(f=>f.id===id)))throw new Error('资料目录不存在，请重新选择');
  if(config.urls.length&&!config.allowWeb)throw new Error('读取网址需要允许网页访问');
  if(config.trigger==='changes'&&!config.urls.length&&!config.folderIds.length&&!config.useGithub)throw new Error('按变化触发至少需要一个资料来源');
  if(config.useOutputFolder){if(!config.outputFolder||fs.realpathSync(config.outputFolder)!==config.outputFolder||!fs.statSync(config.outputFolder).isDirectory())throw new Error('请先在工具与连接选择有效产出目录');if(config.folderIds.some(id=>a.data.folders.find(f=>f.id===id).path===config.outputFolder))throw new Error('资料目录与产出目录需要分开，避免产出再次触发自己');}
  return config;
}
function nextRun(config,after=Date.now()) {
  if(changeTrigger(config))return new Date(after+config.intervalMinutes*60000).toISOString();
  const d=new Date(after),[h,m]=config.time.split(':').map(Number);d.setHours(h,m,0,0);
  if(config.trigger==='weekly')d.setDate(d.getDate()+(config.weekday-d.getDay()+7)%7);
  if(d.getTime()<=after)d.setDate(d.getDate()+(config.trigger==='weekly'?7:1));
  return d.toISOString();
}
function cleanIssue(r) {return {number:r.number,title:r.title,body:r.body,bodyHash:r.bodyHash||hash(r.body),state:r.state,comments:r.commentFingerprints||(r.comments||[]).map(c=>({id:c.id,author:c.author,contentHash:hash(c.body)})),coverage:r.coverage||'partial'};}
function excludeOwnComments(a,repo,r){
 const own=new Set(a.data.agentActions.filter(w=>w.status==='done'&&w.tool==='github_comment'&&w.target===repo&&w.number===r.number&&w.result?.commentId&&w.result?.verified&&w.result.body).flatMap(w=>r.commentFingerprints?.some(c=>c.id===w.result.commentId&&c.contentHash===hash(w.result.body))?[w.result.commentId]:[]));
 return {...r,commentFingerprints:r.commentFingerprints?.filter(c=>!own.has(c.id)),comments:r.comments?.filter(c=>!own.has(c.id))};
}
function authorizationScope(rule){return {id:'rule:'+rule.id,projectId:rule.config.projectId||null,...rule.config,taskIds:[],sourceIds:[],status:'ready'};}
function authorizeRule(a,rule,before){return require('./access-policy-store.cjs').syncTrustedJob(a,authorizationScope(rule),{...(before?{before:authorizationScope(before)}:{}),trusted:true,actor:'user_command',command:'ruleSave'});}
function policyRows(a,scope){return require('./access-policy-store.cjs').collectLegacy({...a.data,delegations:[scope],workRules:[],tasks:[],sources:[],artifacts:[],connectors:[]}).filter(r=>r.resourceScope?.jobId===scope.id);}
function assertRuleAuthority(a,rule){
  const store=require('./access-policy-store.cjs');
  for(const row of policyRows(a,authorizationScope(rule)))for(const operation of row.operations||[])store.assert(a,{principalScope:row.principalScope,resourceScope:row.resourceScope,operation});
}
function revokeRule(a,rule){
  const store=require('./access-policy-store.cjs'),scopes=[authorizationScope(rule),...a.data.delegations.filter(j=>j.ruleId===rule.id)];
  for(const scope of scopes)for(const row of policyRows(a,scope))store.revoke(a,{principalScope:row.principalScope,resourceScope:row.resourceScope,operations:row.operations},{trusted:true,actor:'user_command',command:'ruleArchive'});
}
async function scan(a,config,explicitScope) {
  projectLifecycle.assertActive(a.data,config.projectId);
  const records=[],signal=a.controller?.signal;
  const rule=a.data.workRules.find(r=>r.config===config),scope=explicitScope||(rule&&authorizationScope(rule));
  if(!scope)throw Error('规则读取范围未授权，请先保存规则或显式预览');
  if(rule)assertRuleAuthority(a,rule);
  if(config.trigger==='project_changes')return projectSources.scan(a,config);
  const authorize=(tool,args)=>{require('./execution-gate.cjs').assert(a,{readOnly:true});if(rule&&rule.status!=='enabled')throw Error('工作规则已暂停');require('./protocol-access.cjs').assertTool(a,scope,tool,args);};
  const add=(tool,args,result,identity=hash(result))=>{
    if(records.length>=20)throw new Error('匹配资料超过 20 份，请用文件名或关键词缩小规则范围');
    records.push({key:`${tool}:${JSON.stringify(args)}`,tool,args,result,digest:identity,title:result.title||args.name||result.url||tool});
  };
  const matches=value=>!config.keyword||value.toLowerCase().includes(config.keyword.toLowerCase());
  for(const folderId of config.folderIds) {
    signal?.throwIfAborted();authorize('list_files',{folderId});const files=tools.listFiles(a,scope,folderId);
    if(files.length>=100)throw new Error('目录达到 100 份扫描上限，请选择更小的资料目录');
    for(const file of files) {
      if(config.filename&&!file.name.toLowerCase().includes(config.filename.toLowerCase()))continue;
      const target=path.join(a.data.folders.find(f=>f.id===folderId).path,file.name);
      if(a.data.agentActions.some(r=>r.tool==='write_file'&&(r.result?.path===target||r.result?.latestPath===target||r.target===target)))continue;
      authorize('read_file',{folderId,name:file.name});const document=await tools.readDocument(a,scope,folderId,file.name,signal),full=document.content;
      if(!matches(`${file.name}\n${full}`))continue;
      add('read_file',{folderId,name:file.name},document,hash(full));
    }
  }
  for(const url of config.urls){signal?.throwIfAborted();authorize('read_url',{url});const r=await tools.readWeb(url,a.agentRequest,signal);if(matches(`${r.title}\n${r.content}`))add('read_url',{url},r);}
  if(config.useGithub) {
    authorize('github_list',{});const rows=await tools.github(a,config.githubRepo,'issues?state=all&sort=updated&direction=desc&per_page=100',{signal,permissionScope:scope});
    if(!Array.isArray(rows))throw new Error('GitHub 列表响应无效');
    if(rows.length>=100)throw new Error('仓库达到 100 条扫描上限，请改用具体 Issue 网页或较小的仓库');
    const matched=rows.filter(r=>!r.pull_request&&!a.data.agentActions.some(w=>w.tool==='github_create'&&w.target===config.githubRepo&&w.result?.number===r.number)&&matches(`${r.title}\n${r.body||''}`));
    if(matched.length>10)throw new Error('GitHub 匹配超过 10 个 Issue，请用关键词缩小范围');
    for(const row of matched){authorize('github_read',{number:row.number});const r=excludeOwnComments(a,config.githubRepo,await tools.readIssue(a,config.githubRepo,row.number,signal,{complete:true,permissionScope:scope}));add('github_read',{number:row.number},r,hash(cleanIssue(r)));records.at(-1).ownWriteIds=a.data.agentActions.filter(w=>w.tool==='github_update'&&w.status==='done'&&w.target===config.githubRepo&&w.number===row.number).map(w=>w.id);}
  }
  return records;
}
function ownUpdate(a,rule,previous,record) {
  if(record.tool!=='github_read'||!previous?.issue)return false;
  const actual=cleanIssue(record.result),old=previous.issue;
  const action=a.data.agentActions.findLast(r=>r.jobId&&r.target===rule.config.githubRepo&&r.number===actual.number&&r.tool==='github_update'&&r.status==='done'&&a.data.delegations.some(j=>j.id===r.jobId&&j.ruleId===rule.id));
  if(!action||previous.ownWriteIds?.includes(action.id)||hash(actual.comments)!==hash(old.comments))return false;
  return ['title','state'].every(k=>actual[k]===(action.desired[k]??old[k]))&&actual.bodyHash===(action.desired.body===undefined?old.bodyHash:hash(action.desired.body));
}
function changes(a,rule,records) {
  const previous=rule.fingerprints||{},current=new Map(records.map(r=>[r.key,r])),out=[];
  for(const r of records)if(previous[r.key]?.digest!==r.digest&&!ownUpdate(a,rule,previous[r.key],r))out.push({...r,change:previous[r.key]?'changed':'added'});
  for(const [key,old] of Object.entries(previous))if(!current.has(key))out.push({key,tool:old.tool,args:old.args,title:old.title,digest:'removed',change:'removed',result:{title:old.title,content:'此资料已移除或不再匹配规则筛选；旧内容不能当作当前事实。'}});
  return out;
}
function checkpoint(rule,records) {rule.fingerprints=Object.fromEntries(records.map(r=>[r.key,{digest:r.digest,title:r.title,tool:r.tool,args:r.args,...(r.tool==='github_read'?{issue:cleanIssue(r.result),ownWriteIds:r.ownWriteIds||[]}:{})}]));rule.initialized=true;}
function preflight(a,config) {
  projectLifecycle.assertActive(a.data,config.projectId);
  for(const role of ['organize','execute','verify'])a.available(role);
  if(config.useGithub&&[config.githubMode,config.githubUpdateMode,config.githubCommentMode].includes('auto')&&!a.data.agentSettings.githubToken)throw new Error('GitHub 自动写入需要先保存 Token');
}
function pause(a,rule,reason='用户暂停') {
  rule.status='paused';rule.summary=reason;
  for(const job of a.data.delegations.filter(j=>j.ruleId===rule.id&&j.ruleRevision===rule.revision&&['ready','running','watching','retry','limited'].includes(j.status))) {
    job.rulePausedState=job.status==='running'?'ready':job.status;job.status='paused';
    require('./execution.cjs').abortJob(a,job.id);
  }
  if(a.activeRuleId===rule.id)a.controller?.abort();
}
function pauseAll(a){for(const rule of a.data.workRules)if(rule.status==='enabled'&&projectLifecycle.isActive(a.data,rule.config.projectId))pause(a,rule,'已全局停止，等待明确恢复');}
function reopenRuleBatch(a,rule,job,run){
  // The enabled rule authorizes a new round of this delegation's goal. Record
  // that intent before source ingestion can requeue any accepted task.
  if(job.ruleReopenPending?.ruleId===rule.id&&job.ruleReopenPending.ruleRevision===rule.revision){run.workCommitId=job.ruleReopenPending.commitId;return;}
  const taskIds=(job.taskIds||[]).filter(id=>{const task=a.data.tasks.find(t=>t.id===id);return task&&task.agentJobId===job.id&&!task.deletedAt&&!task.agentCancelled&&(task.status==='completed'||task.acceptedAt||(task.acceptanceHistory||[]).some(entry=>entry.workRevision===(task.workRevision??1)));});
  if(job.status!=='completed'&&!job.projectRuleAwaitingTrigger&&!taskIds.length)return;
  const receipt=require('./work-journal.cjs').recordReopen(a,{kind:'job',id:job.id,actor:'policy',ruleId:rule.id,ruleRevision:rule.revision,triggerId:run.id,taskIds,commitId:`rule-reopen:${run.id}`,basisRefs:{ruleId:rule.id,ruleRevision:rule.revision,triggerId:run.id,changes:run.changes}});
  run.workCommitId=receipt.commitId;
}
function checkProject(a,rule,run,relevant){
  const projects=require('./projects.cjs'),project=projects.byId(a,rule.config.projectId);
  let job=projects.job(a,project);const inspection=projectSources.inspect(a,project,job);
  if(job&&(job.ruleId!==rule.id||job.ruleRevision!==rule.revision||job.projectId!==project.id))throw Error('项目委托归属或规则版本不一致，请在原入口核对');
  if(inspection.held||job&&(job.executionPaused||!['ready','watching','retry','completed'].includes(job.status)||job.pendingActionId)){rule.summary='资料变化已保留，等待项目委托恢复、确认或外部结果核对';run.status='queued';return false;}
  if(!job&&rule.usage.starts>=rule.config.dailyStarts){rule.nextRunAt=tomorrow();rule.summary='今日新建委托数已达上限，变化已保留';run.status='limited';return false;}
  preflight(a,rule.config);assertRuleAuthority(a,rule);const records=projectSources.current(a,rule.config),isNew=!job;
  if(isNew){job=require('./agent.cjs').buildJob(a,rule.config,rule.config);Object.assign(job,{ruleId:rule.id,ruleRevision:rule.revision,ruleName:rule.config.name,triggeredAt:now()});}
  else projects.snapshot(a,project,`项目资料规则核对 ${relevant.length} 份变化`);
  if(!isNew)reopenRuleBatch(a,rule,job,run);
  for(const task of inspection.tasks.filter(t=>t.captureId&&!t.agentJobId)){task.agentJobId=job.id;task.agentKey=`capture-${task.captureId}`;task.planVersion=1;task.planHistory=[];task.dependsOn=[];task.needsReplan='快速收集已记录事项，请沿用原 ID 核对目标和完成标准后规划';task.steps.forEach(s=>s.key ||= s.id);if(!job.taskIds.includes(task.id))job.taskIds.push(task.id);}
  projectSources.apply(a,project,job,records,inspection);
  job.history.push({at:now(),tool:'rule_trigger',result:{ruleName:rule.config.name,trigger:run.trigger,changes:run.changes}});job.history=job.history.slice(-30);
  Object.assign(job,{status:'ready',nextRunAt:now(),lastError:'',completedAt:null,summary:`项目资料规则已${isNew?'创建委托':'续办原委托'}：${rule.config.name}`});
  delete job.projectRuleAwaitingTrigger;delete job.projectRuleRecoveryHold;delete job.ruleReopenPending;
  if(isNew){a.data.delegations.unshift(job);project.jobId=job.id;rule.usage.starts++;}
  rule.activeJobId=job.id;rule.projectAuthorizedSignature=projectSources.signature(a,rule.config);delete rule.projectReauthorize;
  rule.pending=[];rule.summary=job.summary;run.status=isNew?'created':'merged';run.jobId=job.id;
  a.event('工作规则已触发',`${rule.config.name}：${run.changes.length} 份已入库资料变化，${isNew?'新建委托':'续办原委托'}`);return true;
}
async function check(a,rule,{force=false}={}) {
  projectLifecycle.assertActive(a.data,rule.config.projectId);
  if(rule.status!=='enabled')throw new Error('请先启用工作规则');
  const initial=rule.config.trigger==='project_changes'?structuredClone(a.data):null;
  a.activeRuleId=rule.id;rollDay(a,rule);
  let transaction=null;let run={id:uid(),ruleId:rule.id,startedAt:now(),status:'running',trigger:force?'手动检查':rule.config.trigger,changes:[]};
  a.data.ruleRuns.unshift(run);a.data.ruleRuns=a.data.ruleRuns.slice(0,300);try{a.save();}catch(error){if(initial){a.data=initial;a.activeRuleId=null;}throw error;}
  try {
    const records=await scan(a,rule.config);a.controller?.signal.throwIfAborted();
    const delta=changes(a,rule,records);
    rule.lastCheckedAt=now();rule.nextRunAt=nextRun(rule.config);
    if(!rule.initialized&&!rule.config.includeExisting&&changeTrigger(rule.config)){checkpoint(rule,records);rule.summary='已记录当前资料，等待后续变化';run.status='baseline';return;}
    const scheduled=!changeTrigger(rule.config);
    const relevant=scheduled?[...records.map(r=>({...r,change:'scheduled'})),...delta.filter(r=>r.change==='removed')]:delta;
    rule.pending=rule.config.trigger==='project_changes'?relevant.map(r=>({...r,result:{sourceId:r.sourceId||r.args.sourceId,title:r.title,content:String(r.result.content).slice(0,500)}})):relevant;
    run.changes=relevant.map(r=>({title:r.title,change:r.change}));
    if(!relevant.length&&!scheduled&&!rule.projectReauthorize){checkpoint(rule,records);rule.summary='资料无变化，未调用模型';run.status='unchanged';return;}
    if(rule.config.trigger==='project_changes'){transaction=structuredClone(a.data);if(checkProject(a,rule,run,relevant)){checkpoint(rule,records);a.save();}return;}
    const projects=require('./projects.cjs'),project=rule.config.projectId?projects.byId(a,rule.config.projectId):null;
    let job=a.data.delegations.find(j=>j.id===(project?.jobId||rule.activeJobId));
    if(job?.status==='completed'&&!project)job=null;
    if(job&&(job.executionPaused||!['ready','watching','retry',...(project?['completed']:[])].includes(job.status)||job.pendingActionId||projects.relatedActions(a,job).some(r=>['running','uncertain'].includes(r.status)))){rule.summary='新变化已保留，等待当前委托完成确认、恢复或补充';run.status='queued';return;}
    if(!job&&rule.usage.starts>=rule.config.dailyStarts){rule.nextRunAt=tomorrow();rule.summary='今日新建委托数已达上限，变化已保留';run.status='limited';return;}
    preflight(a,rule.config);assertRuleAuthority(a,rule);
    const agent=require('./agent.cjs');
    const isNew=!job;
    if(isNew){job=agent.buildJob(a,{...rule.config,intervalMinutes:rule.config.intervalMinutes},rule.config);Object.assign(job,{ruleId:rule.id,ruleRevision:rule.revision,ruleName:rule.config.name,triggeredAt:now()});if(rule.config.template)job.template=structuredClone(rule.config.template);}
    const watchKeys=new Set(job.watchers.map(w=>w.key||`${w.tool}:${JSON.stringify(w.args)}`));
    for(const r of relevant){if(r.change==='removed')watchKeys.delete(r.key);else watchKeys.add(r.key);}
    if(watchKeys.size>20)throw new Error('当前委托跟进来源已达 20 个，请完成此委托或缩小规则范围');
    if(project&&!isNew)projects.snapshot(a,project,`规则归并 ${relevant.length} 份变化`);
    if(!isNew)reopenRuleBatch(a,rule,job,run);
    // All changes and the new delegation are saved together before any model or write runs.
    for(const record of [...relevant].sort((x,y)=>(x.change==='removed'?-1:0)-(y.change==='removed'?-1:0))) {
      if(record.change==='removed'&&!job.watchers.some(w=>w.key===record.key)) {job.history.push({at:now(),tool:'source_removed',result:{title:record.title,detail:record.result.content}});continue;}
      agent.watch(a,job,record.tool,record.args,record.result,false);
      if(record.change==='removed')job.watchers=job.watchers.filter(w=>w.key!==record.key);
    }
    const trigger={at:now(),tool:'rule_trigger',result:{ruleName:rule.config.name,trigger:run.trigger,changes:run.changes}};
    job.history.push(trigger);job.history=job.history.slice(-30);job.status='ready';job.nextRunAt=now();job.lastError='';job.summary=`工作规则已${isNew?'创建委托':'合并新资料'}：${rule.config.name}`;
    if(isNew){a.data.delegations.unshift(job);rule.usage.starts++;if(project){project.jobId=job.id;projects.ingest(a,project,{checkpoint:false});}}
    rule.activeJobId=job.id;job.completedAt=null;
    checkpoint(rule,records);delete job.ruleReopenPending;rule.pending=[];rule.summary=job.summary;run.status=isNew?'created':'merged';run.jobId=job.id;
    a.event('工作规则已触发',`${rule.config.name}：${run.changes.length} 份资料，${isNew?'新建委托':'续办原委托'}`);a.save();
  } catch(error) {
    if(transaction&&!error.committed&&!run.workCommitId){const ruleId=rule.id,runId=run.id;a.data=transaction;rule=byId(a,ruleId);run=a.data.ruleRuns.find(r=>r.id===runId);}
    run.error=error.message;
    if(a.controller?.signal.aborted||rule.status==='paused'){run.status='paused';rule.summary='已暂停，未处理的变化将在恢复后检查';}
    else {rule.failures=(rule.failures||0)+1;rule.summary=error.message;rule.nextRunAt=new Date(Date.now()+Math.min(rule.failures,3)*60000).toISOString();run.status='error';if(rule.failures>=3){rule.status='blocked';a.event('工作规则需要处理',`${rule.config.name}：${error.message}`,null,'warning');}}
  } finally {if(run.status!=='error')rule.failures=0;rule.waitingForJob=run.status==='queued';run.finishedAt=now();rule.updatedAt=now();a.activeRuleId=null;a.save();}
}
function tick(a) {
  if(a.operation||!require('./stewardship.cjs').canAutomate(a))return false;
  let changed=false;
  for(const rule of a.data.workRules)if(rule.status==='enabled'&&projectLifecycle.isActive(a.data,rule.config.projectId)){changed=rollDay(a,rule)||changed;const job=a.data.delegations.find(j=>j.id===rule.activeJobId);if(rule.waitingForJob&&(!job||(!job.pendingActionId&&['ready','watching','retry','completed'].includes(job.status)))&&!(job?.status==='completed'&&rule.usage.starts>=rule.config.dailyStarts)){rule.nextRunAt=now();rule.waitingForJob=false;changed=true;}}
  if(changed)a.save();
  const rule=a.data.workRules.filter(r=>r.status==='enabled'&&projectLifecycle.isActive(a.data,r.config.projectId)&&(!r.nextRunAt||Date.parse(r.nextRunAt)<=Date.now())).sort((x,y)=>(x.nextRunAt||'').localeCompare(y.nextRunAt||''))[0];
  if(!rule)return false;
  a.launch(`检查工作规则 · ${rule.config.name}`,()=>check(a,rule));return true;
}
async function dispatchMutable(a,action,input) {
  if(action==='rulePause'){const r=byId(a,input.id);pause(a,r);a.save();return a.publicState();}
  a.ensureIdle();
  if(action==='rulePreview') {
    const config=normalize(a,input);const previous=input.id?byId(a,input.id):{fingerprints:{},config};const previewScope=authorizationScope({id:'preview-'+uid(),config});require('./access-policy-store.cjs').syncTrustedJob(a,previewScope,{trusted:true,actor:'user_command',command:'rulePreview'});
    a.rulePreview={requestId:input.requestId,status:'running'};
    return a.launch('预览工作规则触发',async()=>{try{const records=await scan(a,config,previewScope),delta=changes(a,{...previous,config},records);a.rulePreview={requestId:input.requestId,status:'done',at:now(),modelCalls:0,matched:records.length,baseline:changeTrigger(config)&&!previous.initialized&&!config.includeExisting,changes:(changeTrigger(config)?delta:[...records.map(r=>({...r,change:'scheduled'})),...delta.filter(r=>r.change==='removed')]).map(r=>({title:r.title,change:r.change,preview:String(r.result.content||r.result.body||'').slice(0,300)})),nextRunAt:nextRun(config)};}catch(e){a.rulePreview={requestId:input.requestId,status:'error',error:e.message};}});
  }
  if(action==='ruleSave') {
    const config=normalize(a,input);if(input.enabled)preflight(a,config);
    let rule=input.id?byId(a,input.id):null;const priorRule=rule?structuredClone(rule):null;
    const priorProjectJob=config.projectId?require('./projects.cjs').job(a,require('./projects.cjs').byId(a,config.projectId)):null;
    const manuallyPaused=config.trigger==='project_changes'&&priorProjectJob?.status==='paused'&&!priorProjectJob.rulePausedState;
    if(rule?.config.projectId&&rule.config.projectId!==config.projectId)throw new Error('已有项目规则不能更换项目');
    if(config.projectId){
      const project=require('./projects.cjs').byId(a,config.projectId),j=require('./projects.cjs').job(a,project);
      if(a.data.workRules.some(r=>r.id!==rule?.id&&r.config.projectId===config.projectId&&r.status!=='archived')||(j&&(!rule||j.ruleId!==rule.id)))throw new Error('每个项目使用一个持续委托或一条工作规则，请在原入口补充');
      if(j){if(!require('./projects.cjs').compatible({...j,capabilityGrants:config.capabilityGrants},config))throw new Error('项目规则已有委托，需沿用原授权范围；可以调整时间、筛选条件和目标');
        require('./projects.cjs').assertSettled(a,j);
      }
    }
    if(rule?.status==='archived')throw new Error('归档规则不能修改');
    if(rule){pause(a,rule,'规则已修改，原委托保持暂停');rule.revision++;rule.activeJobId=null;delete rule.projectAuthorizedSignature;delete rule.projectReauthorize;rule.fingerprints={};rule.initialized=false;rule.pending=[];}
    else {if(a.data.workRules.filter(r=>r.status!=='archived').length>=20)throw new Error('最多保留 20 条未归档工作规则');rule={id:uid(),revision:1,createdAt:now(),fingerprints:{},pending:[],initialized:false,usage:{day:day(),calls:0,starts:0}};a.data.workRules.unshift(rule);}
    if(config.projectId){const p=require('./projects.cjs').byId(a,config.projectId),j=require('./projects.cjs').job(a,p);if(j){
      // Keep the old goal in the project snapshot before updating the same
      // delegation. Its consumed calls and previously granted scope stay intact.
      require('./projects.cjs').ingest(a,p,{note:`工作规则目标：${config.goal}`});
      const previousScope=structuredClone(j);
      Object.assign(j,{capabilityGrants:config.capabilityGrants,goal:config.goal,title:config.goal.split('\n')[0].slice(0,70),maxActions:config.maxActions,intervalMinutes:config.intervalMinutes,ruleRevision:rule.revision,ruleName:config.name});
      require('./access-policy-store.cjs').syncTrustedJob(a,j,{before:previousScope,trusted:true,actor:'user_command',command:'ruleSave'});
      rule.activeJobId=j.id;const nextState='ready';
      if(['job','rule_daily'].includes(j.limitReason))delete j.limitReason;
      j.status=input.enabled&&!manuallyPaused?nextState:'paused';if(input.enabled||manuallyPaused)delete j.rulePausedState;else j.rulePausedState=nextState;
    }}
    Object.assign(rule,{config,status:input.enabled?'enabled':'paused',summary:input.enabled?'规则已启用，等待首次检查':'规则已保存，尚未启用',failures:0,updatedAt:now(),nextRunAt:changeTrigger(config)?now():nextRun(config)});authorizeRule(a,rule,priorRule);a.event('保存工作规则',config.name);
  } else {
    const rule=byId(a,input.id);
    if(action==='ruleRun'){if(rule.status!=='enabled')throw new Error('请先启用工作规则');return a.launch(`检查工作规则 · ${rule.config.name}`,()=>check(a,rule,{force:true}));}
    if(action==='ruleResume') {
      if(!['paused','blocked'].includes(rule.status))throw new Error('此规则无需恢复');preflight(a,rule.config);rule.status='enabled';rule.failures=0;rule.nextRunAt=now();rule.summary='已恢复，将检查未处理的变化';
      if(rule.config.trigger==='project_changes'){for(const j of a.data.delegations.filter(j=>j.ruleId===rule.id&&j.ruleRevision===rule.revision&&j.status==='paused'&&j.projectRuleRecoveryHold)){j.status='ready';j.nextRunAt=now();rule.projectReauthorize=true;}}
      for(const job of a.data.delegations.filter(j=>j.ruleId===rule.id&&j.ruleRevision===rule.revision&&j.status==='paused'&&j.rulePausedState)){job.status=job.rulePausedState;delete job.rulePausedState;job.nextRunAt=now();}
    } else if(action==='ruleArchive'){revokeRule(a,rule);pause(a,rule,'规则已归档');rule.status='archived';}
    else throw new Error('未知工作规则操作');
    rule.updatedAt=now();
  }
  a.save();return a.publicState();
}
async function dispatch(a,action,input={}){
  const projectMode=input.trigger==='project_changes'||input.id&&a.data.workRules.find(r=>r.id===input.id)?.config.trigger==='project_changes';
  const before=projectMode&&['ruleSave','ruleResume'].includes(action)?structuredClone(a.data):null;
  try{return await dispatchMutable(a,action,input);}catch(error){if(before&&!error.committed)a.data=before;throw error;}
}
module.exports={assertRuleAuthority,authorizationScope,authorizeRule,projectIngest,projectTriggerPending,initialize,canRun,charge,pause,pauseAll,normalize,nextRun,scan,changes,check,tick,dispatch,day};
