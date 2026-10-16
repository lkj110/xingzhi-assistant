// Read-only delivery projection. A URL in model prose is never a delivery receipt.
const crypto = require('node:crypto');
const path = require('node:path');
const {docTarget} = require('./lark-connector.cjs');
const rows = value => Array.isArray(value) ? value : [];
const kinds={lark_create:'lark',lark_update:'lark',github_create:'github',github_update:'github',write_file:'file'};
const labels={lark:'飞书文档',github:'GitHub 事项',file:'本地文件'};
function urlOf(action) {
  try {
    if(kinds[action.tool]==='lark'){
      const url = docTarget(action.result?.url);
      return action.result?.documentId && url.endsWith('/docx/' + action.result.documentId) ? url : null;
    }
    if(kinds[action.tool]==='github'){
      const url=new URL(action.result?.url),parts=url.pathname.split('/');
      if(url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password&&!url.port&&parts.length===5&&parts[3]==='issues'&&/^[1-9]\d*$/.test(parts[4])&&Number(parts[4])===action.result.number&&parts.slice(1,3).join('/').toLowerCase()===String(action.target).toLowerCase())return url.origin+url.pathname;
    }
    return null;
  } catch { return null; }
}
function saved(a,task,primary,action,actions){
  if(!primary||!action||action.deliveryConflict||action.status!=='done'||action.result?.verified!==true||action.artifactId!==primary.id||action.content!==primary.content)return null;
  const kind=kinds[action.tool];if(!kind)return null;
  const hash = crypto.createHash('sha256').update(primary.content).digest('hex');
  const url=kind==='file'?null:urlOf(action);if(kind!=='file'&&!url)return null;
  if(kind==='lark'&&(action.result.submittedHash!==hash||!action.result.readbackHash))return null;
  const file=kind==='file'?(action.result.latestPath||action.result.path):null;
  if(kind==='file'){
    const job=rows(a.data.delegations).find(row=>row.id===task.agentJobId);
    if(!file||!path.isAbsolute(file)||!job?.outputFolder||path.dirname(file)!==job.outputFolder||action.result.path!==action.target||path.dirname(action.target)!==job.outputFolder||action.result.hash!==hash||action.result.latestPath&&action.result.latestHash!==hash)return null;
  }
  // Later writes to the same destination supersede the old success, including
  // an update whose result is still uncertain. Do not quietly fall back to it.
  const target=row=>kinds[row.tool]==='file'?row.result?.latestPath||(row.latestName&&path.join(path.dirname(row.target),row.latestName))||row.result?.path:urlOf(row)||row.baseline?.url;
  if(actions.slice(actions.indexOf(action)+1).some(row=>kinds[row.tool]===kind&&['pending','running','uncertain','done'].includes(row.status)&&(!target(row)||target(row)===(file||url))))return null;
  return {kind,label:labels[kind],status:'saved',actionId:action.id,artifactId:primary.id,...(file?{path:file,filename:path.basename(file),format:action.fileFormat||action.result.format||path.extname(file).slice(1)}:{url}),title:action.title||primary.title,at:action.finishedAt||action.completedAt||action.createdAt,readbackVerified:true};
}
function present(a,task,primary){
  if(task.needsReplan||task.agentCancelled)return {primary:null,others:[]};
  const steps=rows(task.steps).filter(step=>step.kind==='external'&&kinds[step.tool]);
  const actions=rows(a.data.agentActions).filter(row=>row.taskId===task.id&&row.jobId===task.agentJobId&&kinds[row.tool]);
  const valid=actions.map(action=>saved(a,task,primary,action,actions)).filter(row=>row&&(!steps.some(step=>kinds[step.tool]===row.kind)||steps.some(step=>{let receipt;try{receipt=JSON.parse(step.evidence);}catch{}return step.done&&receipt?.actionId===row.actionId;})));
  let selected=null;
  if(steps.length){
    const step=steps.at(-1),kind=kinds[step.tool];let receipt;try{receipt=JSON.parse(step.evidence);}catch{}
    selected=step.done&&valid.find(row=>row.actionId===receipt?.actionId&&actions.find(a=>a.id===row.actionId)?.tool===step.tool);
    if(!selected)selected={kind,label:labels[kind],status:'pending',message:`${labels[kind]}交付尚未完成或需要重新核对。下面保留本地底稿，完成交付后会在这里显示最终入口。`};
  }else if(valid.length)selected=valid.at(-1);
  return {primary:selected,others:valid.filter(row=>row.actionId!==selected?.actionId)};
}
module.exports = {present,urlOf};
