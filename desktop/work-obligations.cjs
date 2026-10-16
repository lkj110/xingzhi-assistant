const {state}=require('./operation-ledger.cjs');
const evidence=require('./evidence-basis.cjs');
const now=()=>new Date().toISOString();
function requirements(a,job){
 const s=state(job),rows=[{id:'goal',authority:'user',text:job.executionContract?.text||job.goal,userDirectives:require('./requirements.cjs').directives(job)},...job.taskIds.map(id=>a.task(id)).filter(t=>!t.deletedAt&&!t.agentCancelled).map(t=>({id:'task:'+t.id,taskId:t.id,authority:t.userRequirement?'user':'agent_projection',text:require('./requirements.cjs').text(t)}))];
 for(const row of rows){const revision=evidence.hash({id:row.id,intent:evidence.intent(job,row.taskId?a.task(row.taskId):null)}),old=s.requirements.find(r=>r.id===row.id);if(!old)s.requirements.push({...row,revision});else if(old.revision!==revision){for(const gap of s.gaps.filter(g=>g.requirementId===row.id)){if(gap.status==='accepted_gap'&&gap.acceptedRequirementText===row.text)gap.requirementRevision=revision;else if(['open','accepted_gap'].includes(gap.status))gap.status='superseded';}Object.assign(old,{...row,revision});}else Object.assign(old,row);}
 return s.requirements.filter(r=>rows.some(row=>row.id===r.id));
}
function record(a,job,key,result){
 const s=state(job),reqs=requirements(a,job),req=reqs.find(r=>r.id===key)||reqs[0];
 if(!req)return [];
 const previous=s.gaps.filter(g=>g.requirementId===key&&g.requirementRevision===req.revision);
 if(result.passed===true||result.completed||result.awaitingReview){for(const g of previous)if(g.status!=='accepted_gap'){g.status='satisfied';g.resolvedAt=now();}return [];}
 if(!Array.isArray(result.gaps))return [];
 const similar=require('./repair-progress.cjs').similar;
 const active=[];
 for(const text of result.gaps){
  const detail=result.gapDetails?.find(d=>d.text===text&&(d.requirementId===key||req.taskId&&d.requirementId==='goal'));
  const task=req.taskId?a.task(req.taskId):null,access=require('./protocol-access.cjs');
  const artifactIds=[...new Set([detail?.artifactId,...(detail?.sourceIds||[])].filter(Boolean))];
  const artifacts=artifactIds.flatMap(id=>{const rows=a.data.artifacts.filter(r=>r.id===id);return rows.length===1&&(!task||rows[0].taskId===task.id)&&job.taskIds.includes(rows[0].taskId)&&access.allowedObject(a,'artifact',rows[0],job,task||a.task(rows[0].taskId))?rows:[];});
  const artifact=artifacts.find(r=>r.id===detail?.artifactId)||(artifacts.length===1?artifacts[0]:null);
  const validIds=(detail?.sourceIds||[]).filter(id=>job.sourceIds.includes(id)&&a.data.sources.some(s=>s.id===id&&access.allowedObject(a,'source',s,job,task)));
  let g=previous.find(g=>g.text===text||similar(g.text,text));
  const facts=validIds.length?evidence.hash(evidence.versions(validIds.map(id=>a.data.sources.find(s=>s.id===id)),req.taskId?a.task(req.taskId):null,job)):g?.evidenceBasis||null;
  if(!g){g={id:require('node:crypto').randomUUID(),requirementId:key,requirementRevision:req.revision,taskId:req.taskId,text,status:'open',count:0,createdAt:now()};s.gaps.push(g);}
  if(g.status==='accepted_gap'){active.push(g);continue;}
  g.count=facts&&facts!==g.evidenceBasis?1:g.count+1;
  Object.assign(g,{text,...(detail?.kind?{kind:detail.kind}:{}),...(artifact?{artifactId:artifact.id,artifactHash:evidence.hash(artifact.content),stepId:artifact.stepId}:{}),artifactRefs:detail?artifacts.map(r=>r.id):g.artifactRefs||[],evidenceBasis:facts,evidenceRefs:validIds.length?validIds:g.evidenceRefs||[],status:'open',lastAttempt:now()});active.push(g);
 }
 // A fresh check explicitly reports which gaps remain. Keep resolved history.
 for(const g of previous)if(!active.includes(g)&&g.status==='open'){g.status='satisfied';g.resolvedAt=now();}
 return active;
}
function permissionBoundary(job,operation){
 const s=state(job),accepted=operation?.acceptedBoundary||s.acceptedBoundary;
 if(accepted?.kind==='permission'&&accepted.policy==='document_and_continue'&&['user','user_contract'].includes(accepted.authority))return accepted;
 const gap=operation&&(s.gaps||[]).find(g=>g.status==='accepted_gap'&&g.acceptedBy==='user'&&(operation.id&&g.operationId===operation.id||operation.key&&g.operationKey===operation.key));
 if(gap)return {kind:'permission',policy:'document_and_continue',authority:'user',decisionId:gap.decisionId};
 // Compatibility with the existing explicit user-contract choice. Never infer
 // acceptance from an error, source, draft or ordinary feedback. Denial reuse
 // itself relies on typed permission facts in the ledger, not this text path.
 if(job.executionContract?.revision&&/先保留缺口[，,、 ]*完成可访问部分/.test(job.executionContract.text||''))return {kind:'permission',policy:'document_and_continue',authority:'user_contract',revision:job.executionContract.revision};
 return null;
}
function context(a,job){const s=state(job),reqs=requirements(a,job),acceptedBoundary=permissionBoundary(job);return {requirements:reqs,...(acceptedBoundary?{acceptedBoundary}:{}),gaps:s.gaps.filter(g=>['open','accepted_gap'].includes(g.status)),closedGaps:s.gaps.filter(g=>g.status==='satisfied').map(g=>({id:g.id,text:g.text,resolvedAt:g.resolvedAt}))};}
function lineageRoots(job){return require('./lineage-scope.cjs').resolve(job).rootIds;}
function frontier(a,job){
 if(job.dataPlatform!=='sg-readonly')return [];
 const sources=a.data.sources.filter(s=>job.sourceIds.includes(s.id)&&require('./protocol-access.cjs').allowedObject(a,'source',s,job)),inventory=require('./data-platform.cjs').fullInventory(sources),nodes=new Map(inventory.nodes.map(n=>[n.id,n])),rows=[];
 const scope=require('./lineage-scope.cjs').resolve(job);
 if(scope.status==='ready')return require('./lineage-frontier.cjs').build(sources,scope,inventory.queries).map(row=>{
  const query={op:row.direction,taskId:row.nodeId,depth:1};
  const failure=!row.crossRegion&&require('./operation-ledger.cjs').activeFailure(job,query,a);
  const status=row.crossRegion?(row.region==='unknown'?'scope_unresolved':'cross_region'):row.queried?'queried':failure?(failure.errorCode==='AUTH_REQUIRED'&&permissionBoundary(job,failure)?'accepted_boundary':'blocked'):'unexpanded';
  return {...row,status,error:failure?.error,query,note:row.crossRegion?'不同或不明确区域的节点仅保留边界，不发起SG自动查询。':row.queried?'已取得该方向的查询快照；深度、分页或截断不代表完整。':undefined};
 });
 // Retain legacy inventory for inspection, but no deterministic traversal is
 // allowed without a complete current scope. The planner resolves ambiguity.
 for(const direction of ['upstream','downstream']){
  const visited=new Map(inventory.queries.filter(q=>q.op===direction).map(q=>[String(q.query.taskId),q]));
  const discovered=new Set(inventory.queries.filter(q=>q.op===direction).flatMap(q=>[String(q.query.taskId),...(q.nodeIds||[]).map(String)]));
  for(const id of discovered){
   const node=nodes.get(id),done=visited.get(id),failure=require('./operation-ledger.cjs').activeFailure(job,{op:direction,taskId:id,depth:1},a);
   rows.push({nodeId:id,direction,scopeProven:false,scopeStatus:scope.status,scopeReason:scope.reason,status:done?'queried':node?.crossRegion?'cross_region':failure?(failure.errorCode==='AUTH_REQUIRED'&&permissionBoundary(job,failure)?'accepted_boundary':'blocked'):'unexpanded',sourceId:done?.sourceId,error:failure?.error,query:{op:direction,taskId:id,depth:1},note:done?'已取得该方向的查询快照；分页或平台截断仍须按来源核对。':'历史目录不证明属于当前入口范围；由Agent核对范围后选择具体查询，不自动扩张。'});
  }
 }
 return rows;
}
module.exports={requirements,record,context,frontier,lineageRoots};
