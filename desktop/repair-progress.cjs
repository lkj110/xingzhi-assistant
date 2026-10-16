const crypto=require('node:crypto');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function tokens(value){
  const text=String(value).toLowerCase().replace(/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/g,'').replace(/\s+/g,'');
  return new Set([...(text.match(/[a-z\d_]{3,}/g)||[]),...(text.match(/[\u4e00-\u9fff]+/g)||[]).flatMap(s=>Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)))]);
}
function similar(a,b){const x=tokens(a),y=tokens(b);return x.size&&y.size&&2*[...x].filter(t=>y.has(t)).length/(x.size+y.size)>=.6;}
function check(a,job,step,{deferThrow=false}={}){
  const key=step.tool==='complete'?'goal':['advance_task','verify_content'].includes(step.tool)?'task:'+step.args.taskId:null;
  if(!key)return;
  const result=key==='goal'?step.result:step.result?.verification;
  if(!result)return;
  job.repairProgress ||= {};
  if(result.completed||result.awaitingReview||result.passed===true){require('./work-obligations.cjs').record(a,job,key,result);delete job.repairProgress[key];return;}
  if(!(result.complete===false||result.passed===false)||!result.gaps?.length)return;
  const ids=key==='goal'?job.taskIds:[step.args.taskId];
  const work=require('./work-efficiency.cjs'),basis=require('./evidence-basis.cjs');
  const intent=work.intent(a,job),old=job.repairProgress[key];
  const relevantIds=new Set((result.gapDetails||[]).filter(d=>(d.requirementId===key||key!=='goal'&&d.requirementId==='goal')&&result.gaps.includes(d.text)).flatMap(d=>d.sourceIds||[]));
  const facts=ids.flatMap(id=>{
    const task=a.task(id),context=require('./task-context.cjs').buildContext(a,require('./task-context.cjs').taskScope(task));
    return context.readableCatalog.filter(r=>r.purpose==='input'&&!r.ambiguous&&relevantIds.has(r.id)).map(r=>basis.hash(basis.facts(a.data.sources.find(s=>s.id===r.id),task,job)));
  });
  const seen=old?.intent===intent?(old.seenEvidence||[]):[],fresh=facts.filter(f=>!seen.includes(f));
  const changed=old?.intent!==intent||fresh.length>0&&seen.length<work.LIMITS.maxFacts;
  const attempts=changed?1:(old?.attempts||0)+1;
  const evidence=hash([...new Set(facts)].sort());
  const gaps=require('./work-obligations.cjs').record(a,job,key,result).filter(g=>g.status==='open').map(g=>({id:g.id,text:g.text,count:g.count}));
  const repeated=gaps.filter(g=>g.count>=4);
  job.repairProgress[key]={evidence,intent,seenEvidence:[...new Set([...seen,...facts])].slice(0,work.LIMITS.maxFacts),gaps,at:new Date().toISOString(),attempts};
  if(attempts>=work.LIMITS.suggestAt)job.repairProgress[key].suggestion='检查缺口仍未闭合：针对缺失证据更换来源或直接修复当前产物，不再重写解释或反复重规划。';
  if(!repeated.length&&attempts<work.LIMITS.stopAt)return;
  job.repairProgress[key].stoppedAt=new Date().toISOString();
  const error=Object.assign(Error(repeated.length?`同一检查缺口已在 4 次修订检查中持续出现，且没有新增相关证据，正在自动切换修订策略，重新核对主稿和交付证据：${repeated.map(g=>g.text).join('；').slice(0,1400)}`:`已累计 ${attempts} 次检查未闭合缺口且没有新增相关证据，正在自动改换证据来源或修订方式。`),{noProgress:true,code:'UNRESOLVED_GAPS',gapIds:repeated.map(g=>g.id)});
  if(deferThrow)return error;
  throw error;
}
module.exports={check,similar};
