const fs = require('node:fs');
const path = require('node:path');
const stewardship = require('./stewardship.cjs');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(object) : [];
const idOf = value => typeof value === 'string' && value.length <= 300 ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const categories = {models:'模型配置',collection:'资料收集',execution:'事项推进',delivery:'结果交付',automation:'自动托管',recovery:'运行与恢复'};
const ranks = {error:0,warning:1,unknown:2,info:3};
function redactor(data) {
  const privateValues = [];
  function collect(value) {if(typeof value === 'string' && value.length >= 3)privateValues.push(value);else if(object(value))Object.values(value).forEach(collect);}
  for(const p of rows(data.providers))for(const key of ['sealedKey','apiKey','key','token','baseUrl'])collect(p[key]);
  for(const key of ['githubToken','searchKey','outputFolder'])collect(data.agentSettings?.[key]);
  for(const f of rows(data.folders))collect(f.path);
  for(const j of rows(data.delegations))collect(j.outputFolder);
  return value => {
    let result = typeof value === 'string' ? value : '';
    for(const secret of privateValues.sort((a,b)=>b.length-a.length))result=result.split(secret).join('[已隐藏]');
    return result.replace(/https?:\/\/\S+/gi,'[网址已隐藏]').replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|Volumes|private|etc)\/)[^\s，。；]+/g,'[路径已隐藏]').replace(/\b(?:sk-|gh[pousr]_|github_pat_|Bearer\s+)[A-Za-z0-9_.-]+/gi,'[凭据已隐藏]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,160);
  };
}
function directory(value) {
  if(typeof value !== 'string' || !value)return {state:'missing'};
  if(!path.isAbsolute(value))return {state:'invalid'};
  try {
    if(fs.realpathSync(value)!==value || !fs.statSync(value).isDirectory())return {state:'changed'};
    fs.accessSync(value,fs.constants.R_OK);
    return {state:'present'};
  } catch {return {state:'unavailable'};}
}
function snapshot(a,input={}) {
  if(!object(input))throw new Error('工作体检参数无效');
  const data=object(a.data)?a.data:{}, projects=rows(data.projects), jobs=rows(data.delegations), tasks=rows(data.tasks), providers=rows(data.providers), settings=object(data.settings)?data.settings:{}, runtime=object(data.runtime)?data.runtime:{};
  const projectId=input.projectId??'';
  if(typeof projectId !== 'string'||projectId && projectId!=='@independent'&&!projects.some(p=>p.id===projectId))throw new Error('体检所属项目无效，请刷新后重新选择');
  const now=Date.now(), generatedAt=new Date(now).toISOString(), safe=redactor(data);
  const scope = pid => !projectId || (projectId==='@independent' ? !pid : pid===projectId);
  const jobById = id => jobs.find(j=>j.id===id);
  const pidTask = t => t.projectId || jobById(t.agentJobId)?.projectId || null;
  const scopedJobs=jobs.filter(j=>scope(j.projectId)),scopedTasks=tasks.filter(t=>scope(pidTask(t))&&!t.agentCancelled), findings=[];
  const seen = new Set();
  function add(code,category,severity,title,reason,nextStep,route,evidence=[],entity) {
    const key=code+':'+[route?.projectId,route?.jobId,route?.taskId,route?.folderId,route?.connectorId,route?.ruleId,route?.actionId,route?.queueId,route?.webConnectionId,route?.feedConnectionId,entity?.key].filter(Boolean).join(':');
    if(seen.has(key))return;seen.add(key);
    const cleanRoute={page:route?.page||'runtime'};
    for(const key of ['projectId','jobId','taskId','folderId','connectorId','ruleId','actionId','queueId','webConnectionId','feedConnectionId'])if(idOf(route?.[key]))cleanRoute[key]=route[key];
    findings.push({id:`health-${findings.length+1}`,code,category,severity,title,reason,evidence,nextStep,route:cleanRoute,...(entity?{entity:{kind:entity.kind,label:safe(entity.label)||'未命名'}}:{})});
  }
  const jobRoute=j=>({page:'agent',jobId:j.id,...(j.projectId?{projectId:j.projectId}:{})});
  const taskRoute=t=>({page:'board',taskId:t.id,...(pidTask(t)?{projectId:pidTask(t)}:{})});
  const entity=(kind,item)=>({kind,label:item.title||item.name,key:item.id});
  for(const name of ['tasks','delegations','providers','projects','agentActions','folders','connectors','workRules','webConnections','feedConnections','captureQueue'])if(data[name]!==undefined&&(!Array.isArray(data[name])||data[name].some(v=>!object(v)||!idOf(v.id))))add('legacy_'+name,'recovery','warning','部分旧记录格式异常','当前体检跳过了无法识别的记录，汇总可能不完整。','先在运行与恢复中创建备份，再检查对应工作记录。',{page:'runtime'},[]);
  let globalGate=null;
  try {globalGate=stewardship.status(a,now);}catch {add('meter_unknown','automation','unknown','托管策略状态未知','本地托管策略记录缺失或格式不完整。','打开运行与恢复核对托管策略。',{page:'runtime'});}
  if(a.stewardshipError)add('meter_error','automation','error','调用账本需要处理','调用账本无法读取或保存，模型调用已被暂停。','打开运行与恢复，保留现有记录并检查存储位置。',{page:'runtime'});
  else if(globalGate?.reason){const {reason,used,limit,nextAllowedAt}=globalGate;const details={paused:['info','自动托管已暂停','这是已保存的暂停设置。','需要继续自动工作时，在运行与恢复中恢复托管。'],budget:['warning','今日模型调用额度已用完','工作空间今日已达到模型调用上限。','等待下一日额度恢复，或在运行与恢复中调整上限。'],window:['info','当前处于自动工作时段之外','自动工作会在已设置的时段内继续。','如需调整时间，在运行与恢复中修改工作时段。'],offday:['info','今天未安排自动工作','自动工作只在已选择的星期和时段内继续。','如需调整星期，在运行与恢复中修改自动工作日。']}[reason];if(details)add('global_'+reason,'automation',...details,{page:'runtime'},[...(reason==='budget'?[`今日调用：${count(used)} / ${count(limit)}`]:[]),...(iso(nextAllowedAt)?[`下一可运行时间：${iso(nextAllowedAt)}`]:[])]);}
  if(runtime.stewardshipRecoveryHold)add('recovery_hold','recovery','warning','恢复后的工作等待核对','本地数据恢复后，自动工作仍处于恢复保护状态。','先核对项目计划和外部交付，再到运行与恢复决定是否恢复托管。',{page:'runtime'},iso(runtime.recoveryAt)?[`恢复时间：${iso(runtime.recoveryAt)}`]:[]);
  if(runtime.backupError)add('backup_error','recovery','error','最近自动备份未成功','本地记录提示备份失败，当前材料仍在工作空间中。','打开运行与恢复，检查磁盘空间后手动备份。',{page:'runtime'});
  if(a.suspended||runtime.suspended)add('suspended','automation','info','电脑休眠期间暂停执行','当前运行记录为休眠状态。','电脑唤醒并保持 App 运行后再查看体检。',{page:'runtime'});
  if(runtime.online===false)add('offline','recovery','warning','系统最近记录为离线','需要联网的收集和模型调用可能暂时不能完成。','确认网络恢复后查看失败事项并按需重试。',{page:'runtime'});
  else add('network_unverified','recovery','unknown','外部服务连通性未在此处验证',runtime.online===true?'系统记录为在线，但这不能证明模型或资料服务可访问。':'尚无系统网络检测记录。','需要确认具体服务时，前往对应模型或信息连接页面测试。',{page:'runtime'});
  const roleNames={organize:'整理材料',execute:'推进事项',verify:'检查结果'};
  for(const [role,label] of Object.entries(roleNames)) {
    const provider=providers.find(p=>p.id===settings.roles?.[role]);
    if(!provider)add('role_'+role,'models','warning',`${label}尚未选择有效模型`,'角色未分配模型，或原模型配置已被移除。',`在模型与设置中为“${label}”选择模型。`,{page:'settings'});
    else if(typeof provider.model!=='string'||!provider.model.trim()||provider.type!=='codex'&&(typeof provider.baseUrl!=='string'||!provider.baseUrl.trim()))add('provider_'+role,'models','warning',`${label}的模型配置不完整`,'模型名称或接口地址缺失。','在模型与设置中编辑对应模型并测试连接。',{page:'settings'});
  }
  if(Object.keys(roleNames).every(role=>providers.some(p=>p.id===settings.roles?.[role])))add('models_unverified','models','unknown','模型角色已配置，当前连接仍需按需验证','本页不发起模型请求；历史成功调用不能保证当前登录或接口有效。','在模型与设置中点击测试连接，或查看最近实际执行结果。',{page:'settings'});
  const recent=rows(data.modelCalls).filter(c=>iso(c.at)&&now-Date.parse(c.at)<=86400000&&Date.parse(c.at)<=now&&(!projectId || (c.jobId ? !!jobById(c.jobId)&&scope(jobById(c.jobId).projectId) : projectId==='@independent')));
  const failures=recent.filter(c=>c.status==='error');
  if(failures.length)add('recent_model_failures','models','warning','近 24 小时存在失败的模型调用','这里只汇总失败记录；后续成功不会抹去失败历史，是否仍受阻以事项当前状态为准。','打开运行与恢复查看调用记录，若事项仍阻塞，再处理模型配置。',{page:'runtime'},[`失败调用：${failures.length} 次`,`当前范围已记录调用：${recent.length} 次`]);
  const localHealth=(item,kind)=>{
    const isFolder=kind==='folder',isWeb=kind==='web',isFeed=kind==='feed',route={page:'connections',...(item.projectId?{projectId:item.projectId}:{}),[isFolder?'folderId':isWeb?'webConnectionId':isFeed?'feedConnectionId':'connectorId']:item.id}, label=isFolder?'资料目录':isWeb?'网页订阅':isFeed?'RSS 订阅':'信息连接', group=entity(label,item), enabled=item.enabled!==false;
    if(!enabled)add(kind+'_paused','collection','info',`${label}已暂停同步`,'已保存的材料和同步记录仍保留。','需要持续收集时，打开该连接核对设置后恢复同步。',route,[],group);
    if(isFolder){const check=directory(item.path);if(check.state!=='present')add('folder_path','collection',enabled?'warning':'info','资料目录当前不可读取','已授权目录不存在、不可读取或实际位置发生变化。','在信息连接中重新选择有效目录，并核对原材料归属。',route,[],group);}
    if(item.health&&['auth','permission','missing_cli','merge','error','connection','cursor'].includes(item.health))add(kind+'_failed','collection',enabled?'warning':'info',`${label}最近同步遇到问题`,({auth:'登录状态需要重新确认。',permission:'当前授权不足。',missing_cli:'本机资料连接工具尚未就绪。',merge:'项目外部动作待核对，同步断点已保留。',connection:'最近一次连接请求失败。',cursor:'同步断点需要重新核对。'})[item.health]||'最近同步未能完整结束，原材料仍保留。','打开该连接查看同步记录并处理原因，再手动同步一次。',route,iso(item.lastSyncedAt||item.lastCheckedAt)?[`最近检查：${iso(item.lastSyncedAt||item.lastCheckedAt)}`]:[],group);
    else if(item.health==='attention'||isFolder&&item.stats?.complete===false)add(kind+'_partial','collection','warning',`${label}本轮收集不完整`,'本轮存在跳过项、解析提示或扫描数量限制。','打开该连接查看提示，拆分材料或修正文件后同步。',route,[],group);
    if(!iso(item.lastSuccessAt))add(kind+'_unchecked','collection','unknown',`${label}尚无成功同步记录`,'配置存在，但本页不能确认资料已经成功读取。','打开该连接，按需执行一次同步并查看结果。',route,[],group);
    else if(enabled){const interval=isFolder?5:Math.max(5,Number(item.intervalMinutes)||15),age=now-Date.parse(item.lastSuccessAt),threshold=Math.max(30,interval*3)*60000;if(age>threshold)add(kind+'_stale','collection',globalGate?.automaticAllowed===false?'info':'warning',`${label}已有一段时间未成功同步`,'依据已保存的成功时间判断，休眠、暂停或工作时段也会造成间隔。','打开连接核对最近记录和下次同步时间，必要时手动同步。',route,[`最近成功：${iso(item.lastSuccessAt)}`,`提醒间隔：${Math.round(threshold/60000)} 分钟`],group);}
    if(isWeb&&item.health==='excluded')add('web_excluded','collection','info','网页来源已从项目排除','用户撤回的项目材料保持排除，后续同步不会自动重新纳入。','如需再次使用，请在项目中核对并重新关联材料。',route,[],group);
    if(!isFolder&&!isWeb&&!isFeed&&item.cursor?.token)add('connector_paging','collection','info','信息连接仍有待同步分页','已保存分页断点，当前材料可能尚未完整。','等待后续同步或打开该连接手动继续。',route,[],group);
  };
  for(const f of rows(data.folders).filter(f=>scope(f.projectId)))localHealth(f,'folder');
  for(const c of rows(data.connectors).filter(c=>scope(c.projectId)))localHealth(c,'connector');
  for(const c of rows(data.webConnections).filter(c=>scope(c.projectId)))localHealth(c,'web');
  for(const c of rows(data.feedConnections).filter(c=>scope(c.projectId)))localHealth(c,'feed');
  const routingConflicts=rows(data.sources).filter(s=>s.routing?.status==='conflict'&&!s.projectId&&!s.deleted&&!s.projectExcluded);
  if(scope(null)&&routingConflicts.length)add('routing_conflict','collection','warning','新材料的归属需要确认','材料同时匹配不同项目，暂时保留为独立材料，尚未交给模型整理。','到材料归类选择目标项目，或确认保持独立。',{page:'routing'},[`待归类材料：${routingConflicts.length} 份`]);
  for(const queue of rows(data.captureQueue).filter(q=>scope(q.projectId))) {
    const route={page:'capture',queueId:queue.id,...(queue.projectId?{projectId:queue.projectId}:{})},group={kind:'收集批次',label:Array.isArray(queue.itemTitles)?queue.itemTitles.filter(v=>typeof v==='string').join('、'):'收集批次',key:queue.id};
    const evidence=[`已导入材料：${Array.isArray(queue.sourceIds)?queue.sourceIds.length:0} 份`,...(iso(queue.importedAt)?[`导入时间：${iso(queue.importedAt)}`]:[])];
    if(queue.status==='failed'&&queue.autoRetry?.enabled===true&&queue.autoRetry?.retryable===true&&iso(queue.autoRetry.nextRetryAt))add('capture_retry','collection','info','收集批次已安排自动重试','本次遇到临时服务故障，将在重试时间到达且托管条件满足后继续。','可在收集队列查看时间、已用次数，或关闭自动重试。',route,[...evidence,`再次尝试：${iso(queue.autoRetry.nextRetryAt)}`],group);
    else if(queue.status==='failed')add('capture_failed','collection','warning','收集批次需要处理','材料暂存、导入或整理未能完成；已保存材料和事项会保留。','打开收集队列查看失败原因，处理后重试剩余步骤或取消。',route,evidence,group);
    else if(queue.status==='queued')add('capture_queued','collection','info','材料已进入收集队列','批次等待助手空闲，并遵循托管暂停、工作时段和调用额度设置。','在收集队列查看进度，必要时先处理全局托管限制。',route,evidence,group);
    else if(queue.status==='processing')add('capture_processing','collection','info','收集批次正在处理','正在导入或整理当前批次，其他批次继续等待。','可在收集队列查看进度或停止后续处理。',route,evidence,group);
  }
  for(const j of scopedJobs) {
    const route=jobRoute(j),group=entity('委托',j),active=j.status!=='completed';
    if(j.status==='paused')add('job_paused','execution','info','委托已暂停','这是当前已保存的暂停状态。','需要继续时，打开委托核对目标与权限后恢复。',route,[],group);
    else if(j.status==='blocked')add('job_blocked','execution','warning','委托推进遇到问题','当前委托处于阻塞状态，完整原因保存在委托记录中。','打开委托查看最近执行记录，修正后重试。',route,[],group);
    else if(j.status==='needs_input')add('job_input','execution','warning','委托需要补充信息','Agent 目前缺少推进所需的答案。','打开委托补充所需信息或处理待我决策。',route,[],group);
    else if(j.status==='review')add('job_review','execution','info','委托等待验收','已保存结果需要人工核对后才能继续。','打开委托检查产出并确认是否满足完成标准。',route,[],group);
    if(active&&j.status==='limited')add('job_limit','automation','warning','推进费用需要确认',j.summary||'费用或用量需要处理。','打开委托中的推进用量与额度，核对后继续。',route,[`已用调用：${count(j.callsUsed)}`],group);
    if(active&&require('./work-rules.cjs').projectTriggerPending({data},j))add('project_rule_check','automation','info','等待项目资料规则检查','项目材料已变化，需由工作规则核对当前触发条件后再推进。','打开工作规则检查资料，或等待已安排的检查。',{page:'rules',ruleId:j.ruleId,...(j.projectId?{projectId:j.projectId}:{})},[],group);
    if(active&&j.ruleId){const r=rows(data.workRules).find(r=>r.id===j.ruleId),sameScope=!!r&&(r.config?.projectId||null)===(j.projectId||null);if(!r||!sameScope||r.status!=='enabled'||r.revision!==j.ruleRevision)add('job_rule','automation',!r||!sameScope?'warning':'info','委托受工作规则状态限制',!r?'关联工作规则已不存在。':!sameScope?'委托与工作规则的项目归属不一致。':r.status!=='enabled'?'关联工作规则已暂停或归档。':'委托与工作规则版本不同。',sameScope?'打开工作规则核对当前计划，再决定如何继续委托。':'打开所属委托核对规则关联，保留现有材料和产出。',sameScope?{page:'rules',ruleId:r.id,...(j.projectId?{projectId:j.projectId}:{})}:route,[],group);}
    const writeExpected=scopedTasks.some(t=>t.agentJobId===j.id&&!['completed','paused'].includes(t.status)&&rows(t.steps).some(s=>!s.done&&s.tool==='write_file'));
    if(active&&(j.outputFolder||writeExpected)) {
      const state=directory(j.outputFolder).state;
      if(state!=='present')add('output_folder','delivery',j.status==='paused'?'info':'warning','委托产出目录需要重新核对','产出目录未选择、不可读取或实际位置发生变化。','打开委托核对原交付；恢复原授权目录的位置，或补充要求改为 App 内产出。',route,[],group);
      else add('output_write_unverified','delivery','unknown','产出目录存在，实际写入尚未由体检验证','本次仅检查目录位置与可读性，没有创建文件或核对交付正文。','可在委托的实际交付步骤中查看写入和回读结果。',route,[],group);
      if(writeExpected&&(!j.fileMode||j.fileMode==='off'))add('file_permission','delivery','warning','计划包含文件交付，但文件写入未授权','未完成步骤需要写入文件，当前委托关闭了文件写入。','可补充要求改为 App 内产出；需要文件交付时，新建委托并选择目录与确认方式。',route,[],group);
    }
    const revoked=Array.isArray(j.folderIds)?j.folderIds.filter(id=>!rows(data.folders).some(f=>f.id===id)):[];
    if(active&&revoked.length)add('missing_folder_grant','collection','warning','委托引用的资料目录已取消授权','已保存资料仍保留，Agent 无法继续读取已取消授权的目录。','打开委托核对资料范围，并在信息连接中选择需要的目录。',route,[`缺少目录授权：${revoked.length} 个`],group);
  }
  const ruleDate=new Date(now),ruleDay=`${ruleDate.getFullYear()}-${ruleDate.getMonth()+1}-${ruleDate.getDate()}`;
  for(const rule of rows(data.workRules).filter(r=>scope(r.config?.projectId)&&r.status!=='archived')) {
    const route={page:'rules',ruleId:rule.id,...(rule.config?.projectId?{projectId:rule.config.projectId}:{})},group={kind:'工作规则',label:rule.config?.name||rule.name,key:rule.id};
    if(rule.status==='paused')add('rule_paused','automation','info','工作规则已暂停','规则保留原有计划，当前不会启动新的工作。','需要继续周期工作时，打开规则核对设置后恢复。',route,[],group);
    if(rule.status==='enabled'&&rule.usage?.day===ruleDay){
      if(Array.isArray(rule.pending)&&rule.pending.length&&Number.isFinite(rule.config?.dailyStarts)&&rule.config.dailyStarts>0&&rule.usage.starts>=rule.config.dailyStarts)add('rule_start_limit','automation','warning','工作规则的新委托名额已用完','已有资料变化保留在规则中，今日不再启动新的委托。','打开工作规则查看待处理变化，按需调整上限或等待下一日。',route,[`今日新建委托：${count(rule.usage.starts)} / ${count(rule.config.dailyStarts)}`],group);
    }
  }
  for(const t of scopedTasks)if(!['completed','paused'].includes(t.status)) {
    if(t.status==='blocked')add('task_blocked','execution','warning','事项需要处理','当前事项处于阻塞状态，已有产出仍保留。','打开事项查看原因和验收意见，修改后重试。',taskRoute(t),[],entity('事项',t));
    if(t.needsReplan)add('task_replan','execution','warning','事项计划需要重新核对','来源、目标或执行依据发生变化，旧产出可能不再适用。','打开事项或所属委托核对新材料，让 Agent 修订计划后继续。',t.agentJobId&&jobById(t.agentJobId)&&(!t.projectId||jobById(t.agentJobId).projectId===t.projectId)?jobRoute(jobById(t.agentJobId)):taskRoute(t),[],entity('事项',t));
    if(t.agentJobId&&(!jobById(t.agentJobId)||t.projectId&&jobById(t.agentJobId).projectId!==t.projectId))add('task_link','execution','warning','事项与所属委托的关联需要核对','当前事项关联的委托不存在或项目归属不一致。','打开事项检查关联记录，处理前保留当前材料和产出。',taskRoute(t),[],entity('事项',t));
  }
  for(const action of rows(data.agentActions)) {
    const j=jobById(action.jobId),t=tasks.find(t=>t.id===action.taskId),pid=j?.projectId||t&&pidTask(t)||action.projectId;
    if(projectId&&(!j&&!t&&!action.projectId||!scope(pid)))continue;
    const route=j?{...jobRoute(j),actionId:action.id}:t?{...taskRoute(t),actionId:action.id}:{page:'decisions',actionId:action.id};
    if(action.status==='uncertain'||action.status==='running'&&!(require('./execution.cjs').jobActive(a,action.jobId)&&j?.pendingActionId===action.id))add('external_uncertain','delivery','error','外部执行结果需要核对','保存的记录无法确认此动作是否已经完成，重复执行可能产生重复交付。','打开原委托核对执行回执，先确认外部实际结果再继续。',route,[],j?entity('委托',j):t?entity('事项',t):undefined);
    else if(action.status==='pending')add('external_approval','delivery','info','外部动作等待确认','当前动作仍在待确认状态，尚未自动获得执行授权。','打开原委托核对具体内容并选择批准或拒绝。',route,[],j?entity('委托',j):undefined);
  }
  for(const d of rows(data.decisions).filter(d=>d.status==='open')){const j=jobById(d.jobId);if(projectId&&(!j||!scope(j.projectId)))continue;add('decision','execution','info','有待处理的决定','Agent 已整理需要人工判断的问题。','在待我决策中补充答案，相关工作会按已有计划继续。',{page:'decisions',...(j?{jobId:j.id,...(j.projectId?{projectId:j.projectId}:{})}:{})},[],j?entity('委托',j):undefined);}
  const independent=scopedTasks.filter(t=>!t.agentJobId&&t.status==='todo');
  if(independent.length&&!settings.automatic)add('independent_manual','automation','info','独立事项目前按手动方式推进','模型配置并不会自动开启独立事项托管。','需要自动推进这些事项时，在模型与设置中开启自动工作。',{page:'settings'},[`待推进独立事项：${independent.length} 个`]);
  if(a.operation)add('busy','automation','info','助手正在处理当前工作','后台存在运行中的操作，部分手动操作会暂时等待。','可等待当前操作完成后刷新体检。',{page:'runtime'});
  findings.sort((a,b)=>ranks[a.severity]-ranks[b.severity]||a.category.localeCompare(b.category)||a.id.localeCompare(b.id));
  const counts=Object.fromEntries(Object.keys(ranks).map(level=>[level,findings.filter(f=>f.severity===level).length]));
  const checks=Object.entries(categories).map(([id,label])=>{const list=findings.filter(f=>f.category===id);return {id,label,status:list.some(f=>['error','warning'].includes(f.severity))?'attention':list.some(f=>f.severity==='unknown')?'unknown':list.length?'info':'recorded',count:list.length};});
  return {generatedAt,projectId,scopeLabel:projectId==='@independent'?'独立工作':projectId?safe(projects.find(p=>p.id===projectId)?.name)||'所选项目':'全部项目与独立工作',checks,findings,counts,modelCalls:0,networkRequests:0,limitations:['依据当前本机记录和已授权目录位置生成，刷新不会调用模型、联网、读取文件正文或改变工作状态。','连接、登录、可写权限和实际交付内容需在对应功能中确认；没有异常记录不代表完整诊断通过。','近 24 小时调用记录按当前范围汇总；历史记录可能已因保留上限而被裁剪。']};
}
function exportReport(a,input={}) {
  if(!object(input)||!['md','json'].includes(input.format))throw new Error('体检导出格式须为 Markdown 或 JSON');
  const value=snapshot(a,input),report={generatedAt:value.generatedAt,scope:input.projectId?'所选工作范围':'全部工作范围',checks:value.checks,counts:value.counts,findings:value.findings.map(({code,category,severity,title,reason,evidence,nextStep})=>({code,category,severity,title,reason,evidence,nextStep})),modelCalls:0,networkRequests:0,limitations:value.limitations,redaction:'已省略工作名称、记录 ID、导航目标、路径、网址、凭据与用户原文。'};
  const severity={error:'需要先处理',warning:'需要关注',unknown:'尚未验证',info:'当前安排'};
  const content=input.format==='json'?JSON.stringify(report,null,2):['# 行知助手工作体检',`\n生成时间：${report.generatedAt}\n范围：${report.scope}\n`,report.redaction,'\n## 汇总\n',...Object.entries(report.counts).map(([key,value])=>`- ${severity[key]}：${value}`),'\n## 检查发现\n',...report.findings.flatMap(f=>[`### ${f.title}\n`,`- 类别：${categories[f.category]} · ${severity[f.severity]}`,`- 原因：${f.reason}`,...f.evidence.map(e=>`- 记录：${e}`),`- 下一步：${f.nextStep}\n`]),'## 体检范围\n',...report.limitations.map(v=>`- ${v}`)].join('\n');
  return {filename:`行知工作体检-${value.generatedAt.slice(0,10)}.${input.format}`,mime:input.format==='json'?'application/json':'text/markdown',content};
}
function dispatch(a,action,input={}) {
  if(action==='healthSnapshot')return snapshot(a,input);
  if(action==='healthExport')return exportReport(a,input);
  throw new Error('未知工作体检操作');
}
module.exports={snapshot,exportReport,dispatch,directory};
