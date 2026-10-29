import React, {useEffect, useState} from 'react';
import './MarkerConfirmation.css';
import CitationLabel from './CitationLabel.jsx';

const rows=value=>Array.isArray(value)?value:[];
export const hasMarkerHold=task=>!!task?.markerReviewHold?.reportHash;

export default function MarkerConfirmation({task,act,busy=false,enabled=true}){
  const [pending,setPending]=useState(''),[error,setError]=useState('');
  const hold=task?.markerReviewHold,report=task?.grounding,confirmation=task?.groundingMarkerConfirmation;
  useEffect(()=>{setError('');},[task?.id,hold?.reportHash]);
  if(!hasMarkerHold(task))return null;
  const matching=report?.reportHash===hold.reportHash&&report?.reviewDisposition==='marker_confirmation'&&report?.passed===false;
  const markers=matching?rows(report.markerReview):[],claims=rows(report?.claims);
  const confirmed=matching&&confirmation?.actor==='user'&&confirmation.reportHash===report.reportHash&&confirmation.basis===report.basis&&!!confirmation.confirmedAt;
  const disabled=busy||!!pending||task.status==='paused'||!enabled;
  async function submit(action){
    if(disabled)return;
    setPending(action);setError('');
    try{await act(action,{id:task.id,expectedReportHash:hold.reportHash});}
    catch(e){setError(e?.message||'操作未完成，请刷新后重试。');}
    finally{setPending('');}
  }
  return <section className="detail-section marker-confirmation" aria-label="表达标记人工确认">
    <h3>{confirmed?'表达确认已记录，等待重新核验':'表达标记待人工确认'}</h3>
    <p>请逐条对照文稿和引用，确认这些表达已清楚区分通知安排与事实断言。这里仅确认表达方式，不确认事实、批准或执行状态，也不代表核验或验收通过。</p>
    {markers.map((marker,index)=>{
      const claim=claims.find(c=>c.id===marker.claimId&&c.artifactId===marker.artifactId&&c.text===marker.text);
      return <article className="marker-confirmation-item" key={marker.claimId||index}>
        <h4>待确认表达 {index+1}</h4><blockquote>{marker.text}</blockquote>
        {rows(claim?.citations).map((citation,i)=><figure key={i}><figcaption><CitationLabel citation={citation}/></figcaption><blockquote>{citation.quote}</blockquote></figure>)}
        {!rows(claim?.citations).length&&<p className="help-text">当前页面缺少对应引用，请刷新并重新核验后再确认。</p>}
      </article>;
    })}
    {!matching&&<p className="help-text">待确认记录已变化，请重新核验以取得当前记录。</p>}
    {confirmed&&<p role="status">已记录这份稿件的表达确认。尚未重新核验，不会自动推进或完成验收。</p>}
    <p className="help-text">确认按钮只保存你的判断。随后点击“重新核验”才会调用检查模型；通过后仍需你手动验收。来源、要求、权限或稿件变化时，旧确认不能沿用。</p>
    {!enabled&&<p className="help-text">请先开启严格证据核验，再处理这条记录。</p>}
    {task.status==='paused'&&<p className="help-text">事项已暂停，请恢复事项后处理。</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="marker-confirmation-actions">
      {!confirmed&&<button type="button" className="button primary" disabled={disabled||!matching||!markers.length||markers.some(m=>!rows(claims.find(c=>c.id===m.claimId&&c.artifactId===m.artifactId&&c.text===m.text)?.citations).length)} onClick={()=>submit('confirmGroundingMarkers')}>{pending==='confirmGroundingMarkers'?'正在记录…':'确认这些表达已清楚'}</button>}
      <button type="button" className="button" disabled={disabled} onClick={()=>submit('recheckGroundingMarkers')}>{pending==='recheckGroundingMarkers'?'正在启动核验…':'重新核验'}</button>
    </div>
  </section>;
}
