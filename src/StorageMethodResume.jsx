import React,{useState} from 'react';
import {call} from './api';

export default function StorageMethodResume({job,act,busy}){
 const [preview,setPreview]=useState(null),[note,setNote]=useState(''),[executor,setExecutor]=useState('user'),[pending,setPending]=useState(false),[error,setError]=useState('');
 const view=job.storageMethodResume;
 if(!view?.candidate&&!view?.grant)return null;
 async function inspect(){setPending(true);setError('');try{const result=await call('agentStorageMethodResumePreview',{id:job.id,taskId:view.taskId});setPreview(result);if(!result.eligible)setError('当前记录不满足技术恢复条件：'+result.reason);}catch(e){setError(e.message);}finally{setPending(false);}}
 async function submit(e){e.preventDefault();setPending(true);setError('');try{
  await act('agentStorageMethodResume',{id:job.id,taskId:preview.taskId,bindingId:preview.bindingId,executedBy:executor,authorizationNote:note},'一次技术恢复授权已记录；实际请求和回执以执行记录为准');setNote('');setPreview(null);
 }catch(e){setError(e.message);setPreview(null);}finally{setPending(false);}}
 const phases={authorized:'已授权，尚未领取',prepared:'已领取，尚无外部边界回执',dispatch_started:'已进入可能外发边界，结果须核对',settled:'已记录本次结果'};
 return <section className="agent-approval" aria-label="旧存储查询技术恢复"><h3>旧存储查询的一次技术恢复</h3>
  <p>原 4 项查询结果仍未知，不能据此判断原请求未发送。每个原领取记录最多增加一次技术派发；已有唯一合法持久回执时只恢复关联。保留原记录、修订次数和累计费用，沿用当前授权与费用上限。</p>
  {view.grant?<div role="status"><p>技术恢复授权已记录。原失败运行：{view.grant.failedRunId}</p><ul>{view.grant.claims.map(c=><li key={c.claimKey}>{c.claimKey.slice(0,12)}：{c.phase==='settled'?(c.status==='failed'?'本次查询失败，原未知历史保留':'已有持久回执，来源关联进度以执行记录为准'):(phases[c.phase]||'本次阶段：'+c.phase)}</li>)}</ul></div>:<>
   <button className="button" type="button" disabled={busy||pending} onClick={inspect}>{pending?'正在核对…':'核对原记录与当前范围'}</button>
   {preview?.eligible&&<form className="form-stack" onSubmit={submit}>
    <p>已核对 {preview.claims.length} 项原记录；失败运行：{preview.failedRunId}。其中 {preview.claims.filter(c=>c.mode==='associate').length} 项已有回执，仅关联。</p>
    <label>授权依据<textarea aria-label="技术恢复授权依据" required maxLength={16000} rows={2} value={note} onChange={e=>setNote(e.target.value)} placeholder="说明允许本次技术恢复的已有授权"/></label>
    <label>本次操作人<select aria-label="技术恢复操作人" value={executor} onChange={e=>setExecutor(e.target.value)}><option value="user">本人</option><option value="supervisor">按本人已有授权操作的监督 Agent</option></select></label>
    <button className="button primary" disabled={busy||pending||!note.trim()}>{pending?'正在保存…':'记录一次技术恢复授权'}</button>
   </form>}
  </>}
  {error&&<p className="form-error" role="alert">{error}</p>}
 </section>;
}
