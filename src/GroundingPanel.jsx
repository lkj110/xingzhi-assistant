import React from 'react';
import {BookOpen,ShieldCheck} from 'lucide-react';
import './GroundingPanel.css';

const list=value=>Array.isArray(value)?value:[];
const kinds={fact:'事实',inference:'推断',unknown:'尚未确认',proposal:'建议'};
const when=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN'):'时间未记录';
const specificReason=value=>typeof value==='string'&&!['已核对关联结论','已核对所列原文依据','正文已明确区分未知或建议'].includes(value)?value:'';

function RequirementStatus({requirement,passed}){
  const label=requirement.status==='satisfied'?(passed?'该次核验满足':'待核对'):requirement.status==='deferred'?'等待后续交付':'存在缺口';
  return <span className={`grounding-label${passed&&requirement.status==='satisfied'?' checked':''}`}>{label}</span>;
}

export default function GroundingPanel({task,enabled=false}){
  const report=task?.grounding;
  if(!enabled&&!report)return null;
  if(!report)return <section className="detail-section grounding-panel" aria-label="要求与证据核验">
    <h3><BookOpen size={17}/>要求与证据核验</h3>
    <p className="help-text">已开启严格证据核验。推进时将按当前要求建立证据清单，交付前逐项核对关键结论与原文。</p>
    <p className="muted">尚无核验记录。</p>
  </section>;
  const requirements=list(report.requirements),claims=list(report.claims),issues=list(report.issues),sourceConflicts=list(report.sourceConflicts),claimMap=new Map(claims.map(c=>[c.id,c]));
  return <section className="detail-section grounding-panel" aria-label="要求与证据核验">
    <h3><ShieldCheck size={17}/>上次证据核验记录</h3>
    {task.evidenceSearch?.degraded&&<p className="help-text">最近一次本地语义检索不可用，已退回关键词检索；未命中不能证明资料不存在。</p>}
    <div className={`grounding-record${report.passed===true?' checked':''}`}>
      <strong>{report.passed===true?'该次核验通过':'该次核验尚未通过'}</strong>
      <small>{when(report.at)} · {requirements.length} 项要求 · {claims.length} 条关键结论{report.reused===true?' · 已复用相同依据的核验':''}</small>
      <p className="help-text">这是上次核验记录。来源、要求、权限或稿件变化后须重新检查，交付以当前检查状态为准。</p>
      {!enabled&&<p className="help-text">严格证据核验当前已关闭，此处保留历史记录。</p>}
    </div>
    {issues.length>0&&<details className="grounding-details"><summary>查看 {issues.length} 项核验缺口</summary><ul>{issues.map((issue,index)=><li key={index}>{String(issue)}</li>)}</ul></details>}
    {list(report.consistencyIssues).length>0&&<details className="grounding-details"><summary>正文中的矛盾位置</summary>{report.consistencyIssues.map((issue,index)=><article key={index}><p>{issue.reason}</p>{list(issue.anchors).map((anchor,i)=><figure key={i}><figcaption>字符 {anchor.start+1}–{anchor.end}</figcaption><blockquote>{anchor.quote}</blockquote></figure>)}</article>)}</details>}
    {sourceConflicts.length>0&&<details className="grounding-details"><summary>来源分歧记录（{sourceConflicts.length}）</summary>
      <p className="help-text">来源存在分歧。是否可交付仍以当前要求和核验状态为准。</p>
      <ul>{sourceConflicts.map((conflict,index)=><li key={index}>{String(conflict.reason||'请核对下方未知结论及对应原文。')}</li>)}</ul>
    </details>}
    <details className="grounding-details"><summary>要求与证据清单（{requirements.length}）</summary>
      {requirements.length?requirements.map((requirement,index)=><article className="grounding-requirement" key={requirement.id||index}>
        <RequirementStatus requirement={requirement} passed={report.passed===true}/>
        <p><strong>{requirement.text}</strong></p>
        {specificReason(requirement.reason)&&<p>{requirement.reason}</p>}
        <small>{list(requirement.claimIds).filter(id=>claimMap.has(id)).length} 条关联结论，可在下方核对原文</small>
      </article>):<p className="muted">本次未保存要求清单。</p>}
    </details>
    <details className="grounding-details"><summary>关键结论与原文（{claims.length}）</summary>
      {claims.length?claims.map((claim,index)=><article className="grounding-claim" key={claim.id||index}>
        <span className="grounding-label">{kinds[claim.kind]||'待核对的结论'}</span>
        <p><strong>{claim.text}</strong></p>{specificReason(claim.reason)&&<p>{claim.reason}</p>}
        {list(claim.citations).map((citation,citationIndex)=><figure className="grounding-citation" key={citationIndex}>
          <figcaption>{citation.title||'原始资料'}{Number.isSafeInteger(citation.start)&&Number.isSafeInteger(citation.end)?` · 字符 ${citation.start+1}–${citation.end}`:''}</figcaption>
          <blockquote>{citation.quote}</blockquote>
        </figure>)}
        {!list(claim.citations).length&&<small>未保存原文引用。建议或未知事项不代表已核实的事实。</small>}
      </article>):<p className="muted">本次未列出需绑定原文的关键结论。</p>}
    </details>
  </section>;
}
