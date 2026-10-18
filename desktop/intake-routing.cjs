const projectLifecycle=require('./project-lifecycle.cjs');
const crypto=require('node:crypto');
const now=()=>new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const limits={rules:100,keywords:12,keywordChars:80,titleChars:300,contentChars:500000};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}须为 1–${max} 字符`);return value.trim();};
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase();
function config(a,input){
  if(!object(input))throw new Error('归类规则格式无效');
  const name=text(input.name,'规则名称',100),projectId=text(input.projectId,'归属项目',100);
  if(!a.data.projects.some(p=>p.id===projectId))throw new Error('归属项目不存在，请重新选择');
  if(!['title','content','all'].includes(input.field))throw new Error('请选择标题、正文或两者作为匹配范围');
  if(!['any','all'].includes(input.match))throw new Error('请选择任一或全部关键词匹配');
  if(!Array.isArray(input.keywords)||!input.keywords.length||input.keywords.length>limits.keywords)throw new Error('每条规则须填写 1–12 个关键词');
  const keywords=input.keywords.map(keyword=>text(keyword,'关键词',limits.keywordChars));
  if(new Set(keywords.map(normalize)).size!==keywords.length)throw new Error('同一规则中的关键词不能重复');
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('启用状态须为布尔值');
  return {name,projectId,field:input.field,match:input.match,keywords,enabled:input.enabled===true};
}
function initialize(a){
  a.data.intakeRoutingRules ||= [];
  if(!Array.isArray(a.data.intakeRoutingRules))throw new Error('自动归类规则格式无效');
  for(const rule of a.data.intakeRoutingRules){
    rule.revision ||= crypto.randomUUID();
    try{config(a,rule);if(rule.disabledReason)delete rule.disabledReason;}
    catch{rule.enabled=false;rule.disabledReason='规则或归属项目不可用，请编辑并重新启用。';}
  }
}
function byId(a,id){const row=a.data.intakeRoutingRules?.find(r=>r.id===id);if(!row)throw new Error('归类规则不存在');return row;}
function assertRevision(row,revision){if(revision!==row.revision)throw new Error('归类规则已变化，请刷新后再操作');}
function candidate(rule,title,content){
  const hits=rule.keywords.filter(keyword=>{const needle=normalize(keyword);return rule.field==='title'?title.includes(needle):rule.field==='content'?content.includes(needle):title.includes(needle)||content.includes(needle);});
  return (rule.match==='all'?hits.length===rule.keywords.length:hits.length>0)?hits:[];
}
function evaluate(a,sample,rules=a.data.intakeRoutingRules||[]){
  const title=normalize(sample.title),content=normalize(sample.content),matched=[];
  for(const rule of rules){
    if(!rule.enabled||!projectLifecycle.isActive(a.data,rule.projectId))continue;
    try{config(a,rule);}catch{continue;}
    const keywords=candidate(rule,title,content);
    if(keywords.length)matched.push({id:rule.id,name:rule.name,revision:rule.revision,projectId:rule.projectId,projectName:a.data.projects.find(p=>p.id===rule.projectId).name,keywords:[...keywords],field:rule.field});
  }
  const projectIds=[...new Set(matched.map(r=>r.projectId))];
  return {status:projectIds.length===1?'routed':projectIds.length>1?'conflict':'unmatched',projectId:projectIds.length===1?projectIds[0]:null,projectIds,matchedRules:matched,checkedAt:now()};
}
function route(a,item){
  const {routing:untrusted,...source}=item;
  if(source.projectId||source.folderId||source.connectorId||source.webConnectionId||source.agentJobId||source.copiedFrom)return source;
  initialize(a);
  const result=evaluate(a,source);
  if(result.status==='unmatched')return source;
  return {...source,projectId:result.projectId,routing:result};
}
function sourceRevision(source){return hash([source.id,source.projectId,source.state,source.routing,source.hash,source.title,source.content,source.origin,source.deleted,source.projectExcluded,source.updatedAt]);}
function pending(a){return a.data.sources.filter(s=>s.routing?.status==='conflict'&&!s.projectId&&!s.deleted&&!s.projectExcluded&&!a.data.sources.some(n=>!n.projectExcluded&&n.previousSourceId===s.id)).map(s=>({id:s.id,title:s.title,createdAt:s.createdAt,state:s.state,routing:structuredClone(s.routing),revision:sourceRevision(s),canResolve:s.state==='new'&&!a.data.tasks.some(t=>t.sourceIds?.includes(s.id))}));}
function snapshot(a){return {stateRevision:a.data.runtime?.revision||0,rules:(a.data.intakeRoutingRules||[]).map(rule=>({id:rule.id,creationRequestId:rule.creationRequestId,name:typeof rule.name==='string'?rule.name:'待修复规则',projectId:rule.projectId,field:rule.field,match:rule.match,keywords:Array.isArray(rule.keywords)?rule.keywords.filter(k=>typeof k==='string'):[],enabled:rule.enabled===true,revision:rule.revision,disabledReason:rule.disabledReason,createdAt:rule.createdAt,updatedAt:rule.updatedAt,projectName:a.data.projects.find(p=>p.id===rule.projectId)?.name||'项目不可用',available:!!a.data.projects.some(p=>p.id===rule.projectId)})),pending:pending(a),recent:a.data.sources.filter(s=>s.routing&&s.routing.status!=='conflict').slice(0,12).map(s=>({id:s.id,title:s.title,projectId:s.projectId,projectName:s.projectId?a.data.projects.find(p=>p.id===s.projectId)?.name||'项目不可用':'独立材料',status:s.routing.status,matchedRules:(s.routing.matchedRules||[]).map(r=>({name:r.name,keywords:r.keywords})),at:s.routing.resolvedAt||s.routing.checkedAt})),modelCalls:0,networkRequests:0};}
function resolve(a,input){
  const source=a.data.sources.find(s=>s.id===input.id);
  if(!source||source.routing?.status!=='conflict'||source.projectId||source.deleted||source.projectExcluded||source.state!=='new'||a.data.sources.some(n=>!n.projectExcluded&&n.previousSourceId===source.id)||a.data.tasks.some(t=>t.sourceIds?.includes(source.id)))throw new Error('材料状态已变化，不能在此归类，请刷新后核对');
  if(input.revision!==sourceRevision(source))throw new Error('材料或归类依据已变化，请刷新后再处理');
  if(!['project','independent'].includes(input.choice))throw new Error('请选择归入项目或保持独立');
  const p=input.choice==='project'?require('./projects.cjs').byId(a,input.projectId):null;
  const j=p?require('./projects.cjs').job(a,p):null;
  if(j)require('./projects.cjs').assertSettled(a,j);
  const before=structuredClone(a.data);
  try{
    source.projectId=p?.id||null;source.routing={...source.routing,status:p?'assigned':'kept_independent',projectId:p?.id||null,resolvedAt:now()};
    if(p)require('./projects.cjs').ingest(a,p);
    a.event('已处理材料归类',`${source.title}：${p?`归入「${p.name}」`:'保持独立材料，可继续整理'}。`);
    a.save();
  }catch(error){a.data=before;throw error;}
  return a.publicState();
}
async function dispatch(a,action,input={}){
  if(action==='intakeRoutingSnapshot')return snapshot(a);
  if(action==='intakeRoutingPreview'){
    if(!object(input)||!object(input.sample))throw new Error('请提供预览材料');
    const sample={title:input.sample.title===undefined?'':input.sample.title,content:input.sample.content===undefined?'':input.sample.content};
    if(typeof sample.title!=='string'||sample.title.length>limits.titleChars||typeof sample.content!=='string'||sample.content.length>limits.contentChars||(!sample.title.trim()&&!sample.content.trim()))throw new Error('预览需要标题或正文，标题最多 300 字符、正文最多 50 万字符');
    let rules=a.data.intakeRoutingRules||[];
    if(input.rule!==undefined){const c=config(a,input.rule);rules=[...rules.filter(r=>r.id!==input.rule.id),{...c,id:input.rule.id||'preview',revision:'preview',enabled:true}];}
    return {...evaluate(a,sample,rules),modelCalls:0,networkRequests:0,preview:true};
  }
  a.ensureIdle();
  if(action==='intakeRoutingResolve')return resolve(a,input);
  if(!['intakeRoutingSave','intakeRoutingToggle','intakeRoutingDelete'].includes(action))throw new Error('未知自动归类操作');
  let creation, replay;
  if(action==='intakeRoutingSave'&&!input.id){
    try{
      if(typeof input.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Object.assign(Error('新增归类规则需要有效请求身份和状态版本'),{code:'INTAKE_REQUEST_INVALID'});
      creation={creationRequestId:input.requestId,creationRequestHash:hash(config(a,input))};
      replay=(a.data.intakeRoutingRules||[]).find(r=>r.creationRequestId===input.requestId);
      if(replay&&replay.creationRequestHash!==creation.creationRequestHash)throw Object.assign(Error('同一请求身份不能用于另一条归类规则，请核对原结果'),{code:'INTAKE_REQUEST_CONFLICT'});
    }catch(error){error.committed=false;throw error;}
    if(replay){
      try{return {...a.publicState(),routingRuleId:replay.id,reused:true};}
      catch(error){error.committed=true;throw error;}
    }
  }
  let savedId;
  return a.commitOrdinary(()=>{
    if(action==='intakeRoutingSave'){
      const c=config(a,input),existing=input.id?byId(a,input.id):null;
      if(existing)assertRevision(existing,input.revision);
      if(!existing&&(a.data.intakeRoutingRules||[]).length>=limits.rules)throw new Error('最多保存 100 条归类规则，请先移除不再需要的规则');
      const row={...(existing||{}),...c,...creation,id:existing?.id||crypto.randomUUID(),revision:crypto.randomUUID(),createdAt:existing?.createdAt||now(),updatedAt:now()};delete row.disabledReason;
      savedId=row.id;
      if(existing)Object.assign(existing,row);else{a.data.intakeRoutingRules ||= [];a.data.intakeRoutingRules.push(row);}
      a.event('已保存自动归类规则',`${c.name}：${c.enabled?'已启用':'已暂停'}，仅影响后续导入的未分配材料。`);
    }else if(action==='intakeRoutingToggle'){
      const row=byId(a,input.id);assertRevision(row,input.revision);
      if(typeof input.enabled!=='boolean')throw new Error('启用状态须为布尔值');
      if(input.enabled)config(a,{...row,enabled:true});
      row.enabled=input.enabled;row.revision=crypto.randomUUID();row.updatedAt=now();if(row.enabled)delete row.disabledReason;
      a.event(row.enabled?'已启用自动归类规则':'已暂停自动归类规则',row.name);
    }else{
      const row=byId(a,input.id);assertRevision(row,input.revision);
      a.data.intakeRoutingRules=a.data.intakeRoutingRules.filter(r=>r.id!==row.id);
      a.event('已移除自动归类规则',`${row.name}：已归类的材料保持原归属。`);
    }
  },{expectedRevision:creation?input.expectedRevision:undefined,project:()=>({...a.publicState(),...(savedId?{routingRuleId:savedId,reused:false}:{})})});
}
function retain(current,restored){
  restored.intakeRoutingRules=structuredClone(current.intakeRoutingRules||[]).map(rule=>({...rule,enabled:false,revision:crypto.randomUUID()}));
  const resolved=new Set();
  for(const source of current.sources||[]){
    if(!['assigned','kept_independent'].includes(source.routing?.status))continue;
    const old=restored.sources.find(s=>s.id===source.id);if(!old)continue;
    old.routing=structuredClone(source.routing);old.projectId=source.projectId||null;old.state=source.state;old.processedAt=source.processedAt;
    if(source.projectExcluded)old.projectExcluded=true;else delete old.projectExcluded;
    resolved.add(source.id);
  }
  // Keep a later manual routing decision connected to the project that received it.
  for(const job of restored.delegations||[]){
    const live=current.delegations.find(j=>j.id===job.id);if(!live)continue;
    const additions=(live.sourceIds||[]).filter(id=>resolved.has(id)&&!job.sourceIds.includes(id)&&!current.sources.find(s=>s.id===id)?.projectExcluded);
    if(additions.length){job.sourceIds.push(...additions);job.summary='恢复后保留了后来确认归属的材料，请核对原计划。';}
  }
  for(const task of restored.tasks||[]){
    const live=current.tasks.find(t=>t.id===task.id);if(!live||task.agentCancelled)continue;
    const additions=(live.sourceIds||[]).filter(id=>resolved.has(id)&&!task.sourceIds.includes(id)&&!current.sources.find(s=>s.id===id)?.projectExcluded);
    if(!additions.length)continue;
    task.sourceIds.push(...additions);task.verification=null;delete task.completedAt;
    task.needsReplan='恢复后保留了后来确认归属的材料，请核对受影响的产出。';
    for(const step of task.steps)if(step.kind!=='external'){step.done=false;delete step.artifactId;delete step.evidence;}
    if(task.status==='paused')task.previousStatus='blocked';else task.status='blocked';task.lastError=task.needsReplan;
  }
}
module.exports={initialize,route,snapshot,dispatch,retain,limits};
