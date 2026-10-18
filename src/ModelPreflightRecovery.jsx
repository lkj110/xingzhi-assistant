import React,{useState} from 'react';

export default function ModelPreflightRecovery({job,act,busy}){
 const [note,setNote]=useState(''),[executor,setExecutor]=useState('user'),[pending,setPending]=useState(false),[error,setError]=useState('');
 const view=job.modelPreflightRecovery;
 if(!view)return null;
 async function attest(event){
  event.preventDefault();setPending(true);setError('');
  try{
   await act('agentModelPreflightAttest',{id:job.id,taskId:view.taskId,attemptId:view.attemptId,evidenceHash:view.evidenceHash,registryId:view.registry.id,expectedWorkRevision:view.expectedWorkRevision,expectedTaskRevision:view.expectedTaskRevision,executedBy:executor,authorizationNote:note},'旧版本来源确认已记录；请在应用内检测订阅状态，再继续推进。');
   setNote('');
  }catch(e){setError(e.message);}finally{setPending(false);}
 }
 async function check(){setPending(true);setError('');try{await act('subscriptionStatus',{},'订阅状态检测已完成；继续推进时会重新核对恢复条件。');}catch(e){setError(e.message);}finally{setPending(false);}}
 async function upgrade(event){event.preventDefault();setPending(true);setError('');try{
  await act('agentModelPreflightHealthUpgrade',{id:job.id,taskId:view.taskId,attemptId:view.attemptId,...view.healthUpgrade,executedBy:executor,authorizationNote:note},'已记录原恢复的配置确认；恢复次数和累计额度不变。请使用继续推进入口。');setNote('');
 }catch(e){setError(e.message);}finally{setPending(false);}}
 const states={prepared:'一次恢复已准备，尚未领取请求',claimed:'本次请求已领取，等待原请求结果',terminal:'本次请求结果已记录'};
 return <section className="agent-approval" aria-label="模型预检恢复">
  <h3>模型预检失败后的接续</h3>
  <p>原运行：{view.oldRunId}。接续沿用原稿、资料、权限和累计费用；本次原尝试最多恢复一次。</p>
  {view.grant?<><p role="status">{states[view.grant.status]||'请核对原请求状态'}。稿件修订和检查进展以工作记录为准。</p>{view.grant.status==='prepared'&&<><p>若仅检测过期且配置身份未变，可重新检测后使用原继续入口。若属于旧版健康身份，请先检测，再通过下方配置确认接续；重新检测本身不会替换原恢复记录。</p><button className="button" type="button" disabled={busy||pending} onClick={check}>{pending?'正在检测…':'检测订阅状态'}</button></>}</>:<>
   {!view.attested&&!view.native&&<form className="form-stack" onSubmit={attest}>
    <p>请确认这次历史失败由已安装的 0.42.0 r7 版本产生。确认只记录旧版本来源。</p>
    <details><summary>核对发布身份</summary><p>安装记录：{view.registry.manifestHash}</p><p>源码：{view.registry.sourceDigest}</p><p>安装包：{view.registry.packageDigest}</p><p>ASAR：{view.registry.asarHash}</p><p>原尝试：{view.attemptId}</p></details>
    <label>已有授权依据<textarea aria-label="模型预检恢复授权依据" required maxLength={16000} rows={2} value={note} onChange={e=>setNote(e.target.value)} placeholder="说明本次确认所依据的已有恢复授权"/></label>
    <label>本次操作人<select aria-label="模型预检恢复操作人" value={executor} onChange={e=>setExecutor(e.target.value)}><option value="user">本人</option><option value="supervisor">按本人已有授权操作的监督 Agent</option></select></label>
    <button className="button primary" disabled={busy||pending||!note.trim()}>{pending?'正在记录…':'确认已安装的 0.42.0 r7 来源'}</button>
   </form>}
   {(view.attested||view.native)&&<><p>预检来源已核对。检测成功后，使用原“继续推进”入口接续；实际派发前仍会核对当前条件。</p><button className="button" type="button" disabled={busy||pending} onClick={check}>{pending?'正在检测…':'检测订阅状态'}</button></>}
  </>}
  {view.healthUpgrade&&<form className="form-stack" onSubmit={upgrade} aria-label="原恢复健康身份升级">
   <h4>按当前配置接续原恢复</h4>
   <p>此恢复仍使用旧版健康身份，尚未调用模型。请先检测订阅，再明确确认按照当前已配置模型继续；保留原恢复记录、未知费用和总上限，不增加恢复次数。确认本身不会启动推进。</p>
   <label>本次配置确认的授权依据<textarea aria-label="健康身份升级授权依据" required maxLength={16000} rows={2} value={note} onChange={e=>setNote(e.target.value)}/></label>
   <label>本次确认人<select aria-label="健康身份升级确认人" value={executor} onChange={e=>setExecutor(e.target.value)}><option value="user">本人</option><option value="supervisor">按本人已有授权操作的监督 Agent</option></select></label>
   <button className="button primary" disabled={busy||pending||!note.trim()}>{pending?'正在记录…':'确认当前配置并保留原恢复'}</button>
  </form>}
  {error&&<p role="alert" className="form-error">{error}</p>}
 </section>;
}
