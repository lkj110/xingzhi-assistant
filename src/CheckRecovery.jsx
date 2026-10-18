import React,{useState} from 'react';
export default function CheckRecovery({job,act,busy}){
 const [pending,setPending]=useState(false),[error,setError]=useState('');
 const view=job.checkRecovery;if(!view)return null;
 async function resume(){setPending(true);setError('');try{await act('agentCheckResume',{id:job.id,...view},view.paused?'接续已记录；仍保持暂停，恢复运行后核验':'已记录，将继续核验已保存的原稿');}catch(e){setError(e.message);}finally{setPending(false);}}
 return <section className="agent-approval" aria-label="原稿检查接续"><h3>继续未完成的原稿检查</h3><p>{view.kind==='internal_context_authorization'?'上一轮内部读取错误被误显示为需要外部授权。修正后会复用原稿和已读资料，形成一次检查结论；无需新增授权。':'上一轮暂停被旧版本误判为没有进展。已保存的稿件和核验记录仍在，可以继续原稿核验。'}原范围、待补缺口、费用上限和已用次数保持。</p>{view.paused&&<p>当前工作仍处于暂停；记录接续后，恢复运行时才会继续。</p>}<button className="button primary" disabled={busy||pending} onClick={resume}>{pending?'正在记录…':'继续原稿核验'}</button>{error&&<p role="alert" className="form-error">{error}</p>}</section>;
}
