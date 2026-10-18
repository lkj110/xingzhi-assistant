import React,{useState} from 'react';

export default function RepairValidation({job,data,act,busy}){
 const [note,setNote]=useState(''),[executor,setExecutor]=useState('user'),[pending,setPending]=useState(false),[error,setError]=useState('');
 const view=job.repairValidation,task=data.tasks.find(t=>t.id===view?.taskId);
 const phase=job.workState?.phase,gate=job.workState?.gate,blocking=job.workState?.blockingReasons||[];
 const execution=gate?.automaticAllowed===false?'当前自动推进受限，请查看实际推进状态':blocking.some(b=>b.code==='uncertain')?'正在等待核对原外部动作':({paused:'当前已暂停',approval:'等待原动作确认',needs_input:'等待处理当前卡点',blocked:'当前推进已停止',review:'等待你验收',running:'App 正在执行原交付或检查',ready:'等待调度原交付或检查'})[phase]||'以实际推进状态为准';
 if(!view?.candidate&&!view?.grant)return null;
 async function submit(e){e.preventDefault();setPending(true);setError('');try{
  await act('agentRepairValidation',{id:job.id,taskId:task?.id,artifactId:view.target?.artifactId||task?.primaryArtifactId,expectedWorkRevision:view.expectedWorkRevision,expectedTaskRevision:view.expectedTaskRevision,authorizationNote:note,executedBy:executor},'一次修复验证已记录，将按当前权限和原累计额度执行');setNote('');
 }catch(err){setError(err.message);}finally{setPending(false);}}
 return <section className="agent-approval" aria-label="一次修复验证"><h3>旧流程的修复验证</h3>
  <p>事项：{task?.title||"当前委托"}。历史尝试无法完整核对。可明确允许一次原稿修复及检查；失败后停止并保留结果，不重复赠送次数。沿用当前资料权限和累计费用上限，检查通过后继续原交付，最终仍由你验收。</p>
  {view.grant?<p role="status">已知历史失败 {view.grant.knownFailures} 次；本次最多修复 1 次。{view.grant.handedOff?'已取得对应缺口的新证据，转入原要求的继续推进；本次验证和历史记录保留。'+execution:view.grant.outcome==='failed'?'本次修复验证未通过：'+view.grant.reason:view.grant.outcome==='passed'?'本次修复检查通过；'+execution:view.grant.claimedAttemptId?'本次修复验证已开始，重启不会重新获得机会':'本次授权已记录，等待执行'}</p>:<form className="form-stack" onSubmit={submit}>
   <label>授权依据<textarea aria-label="修复验证授权依据" required rows={2} value={note} onChange={e=>setNote(e.target.value)} placeholder="说明本次允许修复验证的具体要求"/></label>
   <label>本次操作人<select aria-label="修复验证操作人" value={executor} onChange={e=>setExecutor(e.target.value)}><option value="user">本人</option><option value="supervisor">按本人已有授权操作的监督 Agent</option></select></label>
   <button className="button primary" disabled={busy||pending||!note.trim()||!task}>{pending?'正在核对…':'允许一次修复验证'}</button>
  </form>}
  {error&&<p className="form-error" role="alert">{error}</p>}
 </section>;
}
