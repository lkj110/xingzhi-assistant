const access=require('./protocol-access.cjs');
const taskLabels={todo:'待推进',running:'正在推进',waiting:'等待反馈',review:'待验收',completed:'已完成',blocked:'需要关注',paused:'已暂停'};
const types=['project','job','source','task','artifact','decision','memory'];
function excerpt(value,query){
  const text=String(value||'').replace(/\s+/g,' '),at=query?text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()):-1;
  const start=Math.max(0,at-65),end=Math.min(text.length,start+260);
  return (start?'…':'')+text.slice(start,end)+(end<text.length?'…':'');
}
function search(a,input={}){return access.derivedRead(a,()=>searchOnce(a,input));}
function searchOnce(a,input={}){
  if(typeof input.query!=='undefined'&&(typeof input.query!=='string'||input.query.length>200))throw new Error('关键词最多 200 字符');
  const query=(input.query||'').trim(),needle=query.toLocaleLowerCase(),type=input.type||'all',projectId=input.projectId||'';
  if(type!=='all'&&!types.includes(type))throw new Error('检索类型无效');
  if(projectId&&!a.data.projects.some(p=>p.id===projectId))throw new Error('项目不存在');
  if(input.history!==undefined&&typeof input.history!=='boolean')throw new Error('历史筛选格式无效');
  const offset=input.offset??0,limit=input.limit??30;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('分页参数无效');
  const data=a.data,projects=new Map(data.projects.map(p=>[p.id,p])),tasks=new Map(data.tasks.map(t=>[t.id,t]));
  const jobs=new Map(data.delegations.map(j=>[j.id,j])),replaced=new Set(data.sources.filter(s=>!s.projectExcluded).map(s=>s.previousSourceId).filter(Boolean));
  const currentArtifacts=new Map(data.tasks.map(t=>[t.id,new Set(require('./deliverables.cjs').current(a,t).map(r=>r.id))]));
  const rows=[];
  function add(kind,row,title,body,scope,current,status,extra={}){
    if(type!=='all'&&type!==kind||projectId&&scope!==projectId||!input.history&&!current)return;
    const heading=String(title||''),content=String(body||''),name=projects.get(scope)?.name||'独立工作';
    if(needle&&!`${heading}\n${content}\n${name}`.toLocaleLowerCase().includes(needle))return;
    rows.push({id:row.id,type:kind,title:heading,excerpt:excerpt(content,query),projectId:scope||null,projectName:name,current,status,at:row.updatedAt||row.answeredAt||row.createdAt||row.at||'',score:needle?(heading.toLocaleLowerCase()===needle?3:heading.toLocaleLowerCase().includes(needle)?2:1):0,...extra});
  }
  for(const p of data.projects)add('project',p,p.name,p.background,p.id,true,'项目');
  for(const j of data.delegations)add('job',j,j.goal,j.summary,j.projectId,true,taskLabels[j.status]||({ready:'待继续',watching:'持续跟进',approval:'待确认',needs_input:'需要补充',limited:'额度已用完',retry:'等待重试'}[j.status])||j.status);
  for(const s of data.sources.filter(s=>access.canReadSnapshot(a,'source',s,{projectId})))add('source',s,s.title,s.content,s.projectId,!s.deleted&&!s.projectExcluded&&!replaced.has(s.id),s.deleted?'已撤回':s.projectExcluded?'已移出项目':replaced.has(s.id)?'历史版本':`当前材料 · 第 ${s.version||1} 版`);
  for(const t of data.tasks.filter(t=>!t.deletedAt))add('task',t,t.title,[t.description,t.criteria,t.waitingOn,...(t.notes||[]).map(n=>n.text)].filter(Boolean).join('\n'),t.projectId||jobs.get(t.agentJobId)?.projectId,!t.agentCancelled,t.agentCancelled?'已取消':taskLabels[t.status]||t.status,{taskId:t.id});
  for(const item of data.artifacts.filter(r=>access.canReadSnapshot(a,'artifact',r,{projectId}))){
    const t=tasks.get(item.taskId),current=!!t&&!t.agentCancelled&&!t.needsReplan&&currentArtifacts.get(t.id).has(item.id);
    const writes=data.agentActions.filter(w=>w.taskId===t?.id&&w.artifactId===item.id&&w.status==='done'&&['write_file','github_create','github_update'].includes(w.tool));
    add('artifact',item,item.title,item.content,t?.projectId||jobs.get(t?.agentJobId)?.projectId,current,current?(t.status==='completed'?'已验收产出':'当前产出 · 待完成验收'):'历史产出',{taskId:item.taskId,deliveries:writes.map(w=>({tool:w.tool,at:w.completedAt||w.at,target:w.result?.latestPath||w.result?.path||w.result?.url||'',verified:!!w.result?.verified})),sourceCount:t?.sourceIds.length||0});
  }
  for(const d of data.decisions||[])add('decision',d,d.question||d.title||'工作决策',[d.answer,d.suggestion,d.reason].filter(Boolean).join('\n'),jobs.get(d.jobId)?.projectId,d.status==='open',d.status==='open'?'等待决定':'已处理',{jobId:d.jobId});
  const memory=require('./memory.cjs').enrich(data);
  for(const m of memory.memories)add('memory',m,m.title,m.content,m.projectId,m.effective,m.effective?'正在生效':m.reason||'未生效');
  rows.sort((x,y)=>y.score-x.score||y.at.localeCompare(x.at)||x.type.localeCompare(y.type)||x.id.localeCompare(y.id));
  const counts=Object.fromEntries(types.map(t=>[t,rows.filter(r=>r.type===t).length]));
  return {query,total:rows.length,offset,limit,more:offset+limit<rows.length,counts,items:rows.slice(offset,offset+limit)};
}
module.exports={search};
