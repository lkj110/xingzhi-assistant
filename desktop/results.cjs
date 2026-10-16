// Read-only presentation of the artifacts actually referenced by the current plan.
const acceptance = require('./acceptance.cjs');
const rows = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
function brief(artifact) {
  const content = text(artifact.content);
  return {id:artifact.id, title:artifact.title || '未命名成果', createdAt:artifact.createdAt,
    chars:content.length, preview:content.replace(/^#{1,6}\s+/gm,'').slice(0,220),
    outline:content.split('\n').filter(line=>/^#{1,2}\s+/.test(line)).map(line=>line.replace(/^#+\s+/, '')).slice(0,12)};
}
function overview(a) {
  const data=a.data, all=rows(data.artifacts), groups=[];
  let checks;
  for(const task of rows(data.tasks)) {
    const artifacts=all.filter(artifact=>artifact.taskId===task.id&&!artifact.accessPolicyQuarantined);
    if(!artifacts.length)continue;
    const job=rows(data.delegations).find(job=>job.id===task.agentJobId);
    const projectId=task.projectId||job?.projectId||null,project=rows(data.projects).find(project=>project.id===projectId);
    const current=[];
    if(!task.agentCancelled&&!task.needsReplan)for(const candidate of require('./deliverables.cjs').current(a,task)) {
      const artifact=artifacts.find(artifact=>artifact.id===candidate.id&&text(artifact.content).trim());
      if(artifact&&!current.some(row=>row.id===artifact.id))current.push(artifact);
    }
    const history=artifacts.filter(artifact=>!current.some(row=>row.id===artifact.id)).sort((a,b)=>text(b.createdAt).localeCompare(text(a.createdAt)));
    const reasons=['review','completed'].includes(task.status)?(checks ||= acceptance.presentationChecks(a))(task,task.status==='completed'):[];
    const archived=!!project?.archivedAt,cancelled=!!task.agentCancelled;
    const workState=require('./work-state.cjs').view(a,task);
    const ready=workState.acceptanceState==='awaiting_acceptance'&&!reasons.length&&!archived;
    const accepted=workState.lifecycle==='completed';
    const deliveries=rows(data.agentActions).filter(action=>action.taskId===task.id&&(!task.agentJobId||action.jobId===task.agentJobId)&&action.status==='done'&&['write_file','github_create','github_update','lark_create','lark_update'].includes(action.tool)&&current.some(artifact=>artifact.id===action.artifactId));
    const primary=require('./deliverables.cjs').primary(a,task);
    const primaryId=current.some(r=>r.id===primary?.id)?primary.id:null;
    const presentation=require('./delivery-presentation.cjs').present(a,task,primaryId?primary:null),delivery=presentation.primary;
    const status=task.deletedAt?'deleted':cancelled?'cancelled':archived?'archived':ready?'review':accepted?'accepted':task.status==='running'?'running':task.needsReplan||task.status==='blocked'||reasons.length?'needs_work':task.status==='paused'?'paused':'draft';
    const labels={deleted:'事项已删除',review:'待你验收',accepted:task.acceptedBy==='user'?'已由你验收':'已自动验收',running:'正在修订',needs_work:'需要继续处理',paused:'已暂停',draft:'进行中的成果',archived:'项目已归档',cancelled:'事项已取消'};
    const next={deleted:'历史成果已保留，可在工作台的「已删除」中恢复事项',review:'当前成果是否满足你的要求？',accepted:'成果已验收，可查看和使用',running:'Agent 正在处理，请等待新成果',needs_work:'先处理阻塞，再检查成果',paused:'事项已暂停，恢复后继续处理',draft:'执行与检查尚未完成',archived:'查看归档成果',cancelled:'查看保留的历史记录'};
    const detail=task.deletedAt?'删除事项不会删除已有文档、来源和费用记录。':ready?'先阅读当前成果与范围说明。符合要求后验收；有遗漏时提交修改意见。':accepted?(reasons.length?'历史验收保留，交付资料需要核对：'+reasons[0].message:'查看已验收成果；历史版本保留供追溯。'):workState.acceptanceState==='awaiting_check'?'文稿已通过检查，正在核对整体交付，完成后可验收。':task.needsReplan||reasons[0]?.message||task.lastError||task.waitingOn||'当前内容保留供查看，完成执行和检查后再验收。';
    groups.push({id:task.id,taskId:task.id,title:task.title,jobId:job?.id||null,projectId,projectName:project?.name||'独立工作',status,statusLabel:labels[status],ready,accepted,primaryId,delivery,otherDeliveries:presentation.others,next:next[status],detail,
      current:current.map(brief),history:history.map(artifact=>({...brief(artifact),reason:current.some(row=>row.stepId&&row.stepId===artifact.stepId)?'已被当前版本替代':task.needsReplan||task.status==='running'?'修订前的记录':'未纳入当前执行步骤'})),
      reasons,verification:task.verification?{passed:task.verification.passed===true,summary:text(task.verification.summary),at:task.verification.at}:null,
      deliveries:deliveries.map(action=>({id:action.id,artifactId:action.artifactId,verified:action.result?.verified===true&&!action.deliveryConflict,target:action.result?.latestPath||action.result?.path||action.result?.url||'',at:action.completedAt||action.finishedAt||action.at})),
      updatedAt:task.updatedAt||current.at(-1)?.createdAt||history[0]?.createdAt||''});
  }
  const order={review:0,needs_work:1,running:2,draft:3,paused:4,accepted:5,archived:6,cancelled:7,deleted:8};
  groups.sort((a,b)=>order[a.status]-order[b.status]||text(b.updatedAt).localeCompare(text(a.updatedAt))||a.id.localeCompare(b.id));
  const unlinked=all.filter(artifact=>!rows(data.tasks).some(task=>task.id===artifact.taskId)).map(brief);
  return {groups,unlinked,counts:{current:groups.reduce((n,g)=>n+g.current.length,0),history:groups.reduce((n,g)=>n+g.history.length,0)+unlinked.length,review:groups.filter(g=>g.ready).length,work:groups.filter(g=>!['accepted','archived','cancelled','deleted'].includes(g.status)).length},modelCalls:0,networkRequests:0};
}
module.exports={overview};
