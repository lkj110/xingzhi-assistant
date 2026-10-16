import {LazyDetails,PagedList} from './RenderBounds';
import React,{useState} from 'react';
import {ArrowUpRight,FileText,History,CheckCheck,Search} from 'lucide-react';
import {call,desktop} from './api';
import './results.css';
const when=value=>value?new Date(value).toLocaleString('zh-CN'):'时间未记录';

export function DeliveryCard({group,delivery=group.delivery,secondary=false}){
  const [error,setError]=useState('');
  if(!delivery)return null;
  if(delivery.status!=='saved')return <p className="result-empty-current" role="status">{delivery.message}</p>;
  const openLabel=delivery.kind==='file'?'在文件夹查看':delivery.kind==='github'?'打开 GitHub 事项':'打开飞书文档';
  async function open(event){if(!desktop)return;event.preventDefault();setError('');try{await call('agentOpenResult',{actionId:delivery.actionId});}catch(e){setError(e.message);}}
  return <section className={secondary?'result-secondary-delivery':'result-primary result-delivery'} aria-label={`${delivery.label}交付成果`}><span className="result-eyebrow">{secondary?'其他交付位置':group.ready||group.accepted?'最终交付':'已保存版本'} · {delivery.label}</span><strong><FileText size={19}/>{delivery.filename||delivery.title}</strong>{delivery.url?<a className="result-open" href={delivery.url} target="_blank" rel="noreferrer" onClick={open}>{openLabel}<ArrowUpRight size={17}/></a>:desktop?<button className="text-button result-open" onClick={open}>{openLabel}<ArrowUpRight size={17}/></button>:<small>在桌面 App 中打开本地文件</small>}<span className="result-delivery-url">{delivery.url||delivery.path}</span><small>交付时已回读 · {when(delivery.at)}{!group.ready&&!group.accepted?' · 请结合当前检查状态使用':''}</small>{error&&<p className="form-error" role="alert">{error}</p>}</section>;
}

export function ResultFiles({group,openResult,compact=false}){
  const primary=group.current.find(a=>a.id===group.primaryId),others=group.current.filter(a=>a.id!==group.primaryId);
  const open=artifact=>openResult({type:'artifact',id:artifact.id,taskId:group.taskId});
  return <div className="result-files">
    <DeliveryCard group={group}/>
    {primary?group.delivery?<LazyDetails className="result-history result-local-draft" summary={<> <FileText size={14}/>本地底稿</>}>{()=><><p>{group.delivery.status==='saved'?'验收和分享请优先使用上方交付成果。本地底稿保留供对照和导出。':'这是已保存的文稿，最终交付状态见上方。'}</p><button className="result-history-file" onClick={()=>open(primary)}><span>{primary.title}</span><small>查看本地底稿 · {when(primary.createdAt)} · {primary.chars.toLocaleString()} 字符</small></button></>}</LazyDetails>:<button className="result-primary" onClick={()=>open(primary)}><span className="result-eyebrow">{group.current.length===1?'当前成果 · 先看这份':'当前成果 · 优先阅读'}</span><strong><FileText size={19}/>{primary.title}<ArrowUpRight size={17}/></strong><small>{when(primary.createdAt)} · {primary.chars.toLocaleString()} 字符</small>{!compact&&primary.outline.length>0&&<span className="result-outline">内容：{primary.outline.slice(0,3).join(' / ')}{primary.outline.length>3?' …':''}</span>}<span className="result-open">打开当前成果 →</span></button>:<p className="result-empty-current">暂时没有与当前执行步骤对应的成果。{group.history.length>0?'此前文稿保留在下方历史记录中。':'执行完成后会显示在这里。'}</p>}
    {group.otherDeliveries?.length>0&&<LazyDetails className="result-history" summary={<> 其他交付位置（{group.otherDeliveries.length}）</>}>{()=><><PagedList items={group.otherDeliveries} label="其他交付位置分页">{delivery=><DeliveryCard key={delivery.actionId} group={group} delivery={delivery} secondary/>}</PagedList></>}</LazyDetails>}
    {others.length>0&&<LazyDetails className="result-history result-other" summary={<> 辅助材料与检查报告（{others.length}）</>}>{()=><><PagedList items={others} label="辅助材料分页">{a=><button className="text-button" key={a.id} onClick={()=>open(a)}>{a.title}<ArrowUpRight size={14}/></button>}</PagedList></>}</LazyDetails>}
    {group.history.length>0&&<LazyDetails className="result-history" summary={<> <History size={14}/>历史版本与过程稿（{group.history.length}）</>}>{()=><><p>这些记录保留供追溯，本次验收以当前成果为准。</p><PagedList items={group.history} label="成果历史分页">{a=><button key={a.id} className="result-history-file" onClick={()=>open(a)}><span>{a.title}</span><small>{a.reason} · {when(a.createdAt)}</small></button>}</PagedList></>}</LazyDetails>}
  </div>;
}

export default function ResultsPage({data,openTrash,openResult,openTask,openReview,openRevision,openDecisions}){
  const [query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[project,setProject]=useState('');
  const result=data.resultOverview||{groups:[],unlinked:[],counts:{}},q=query.trim().toLocaleLowerCase();
  const groups=result.groups.filter(g=>(!project||g.projectId===project)&&(filter==='all'||filter==='review'&&g.ready||filter==='accepted'&&g.accepted||filter==='progress'&&!g.ready&&!g.accepted&&g.status!=='deleted')&&(!q||[g.title,g.projectName,...g.current.map(a=>a.title)].join(' ').toLocaleLowerCase().includes(q)));
  const otherDecisions=(data.decisionCards||[]).filter(d=>d.kind!=='review'&&!(d.kind==='task'&&data.tasks.some(t=>t.id===d.taskId&&t.status==='review')));
  return <div className="results-page">
    <section className="results-intro"><div><span className="result-eyebrow">当前该看什么</span><h2>{result.counts.review?`${result.counts.review} 项成果等你验收`:'按事项查看当前成果'}</h2><p>先看每项的当前成果，再处理需要你决定的事。历史版本收在各事项下。</p></div><div className="results-counts"><strong>{result.counts.current||0}<small>份当前成果</small></strong><strong>{result.counts.history||0}<small>份历史记录</small></strong></div></section>
    {otherDecisions.length>0&&<div className="results-decisions"><span>还有 {otherDecisions.length} 个问题需要你处理</span><button className="text-button" onClick={openDecisions}>查看待我决策<ArrowUpRight size={14}/></button></div>}
    <div className="results-toolbar"><label className="search-field"><Search size={16}/><input aria-label="搜索当前成果" placeholder="搜索事项、当前成果或项目" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="成果状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部事项</option><option value="review">待你验收</option><option value="progress">仍在处理</option><option value="accepted">已验收</option></select><select aria-label="成果所属项目" value={project} onChange={e=>setProject(e.target.value)}><option value="">全部项目</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    <section className="result-groups" aria-label="按事项整理的成果"><PagedList items={groups} resetKey={`${query}:${filter}:${project}`} pageSize={12} label="成果事项分页">{g=><article className={`result-card ${g.status}`} key={g.id}><header><div><small>{g.projectName}</small><h3>{g.title}</h3></div><span className="result-badge">{g.statusLabel}</span></header>
      <div className="result-next"><strong>{g.ready?'需要你决定':'当前进展'} · {g.next}</strong><p>{g.detail}</p></div>
      <ResultFiles group={g} openResult={openResult}/>
      {g.verification&&<LazyDetails className="result-check" key={g.ready?'review':'progress'} defaultOpen={g.ready} summary={<> 交付范围与检查结论</>}>{()=><><p>{g.verification.summary}</p>{g.reasons.length>0&&<ul>{g.reasons.map(r=><li key={r.code}>{r.message}</li>)}</ul>}<small>{g.ready?'已通过当前依据检查，等待你确认。':g.accepted?'已有有效验收记录。':'这是已有检查记录，请以当前状态和待处理问题为准。'}</small></>}</LazyDetails>}
      {g.deliveries.length>0&&<LazyDetails className="result-check" summary={<> 已保存的位置</>}>{()=><><PagedList items={g.deliveries} label="已保存位置分页">{d=><p key={d.id}>{d.target}<small>保存时{d.verified?'已回读核对':'已记录成功'} · {when(d.at)}</small></p>}</PagedList></>}</LazyDetails>}
      <footer>{g.ready&&<button className="button primary" onClick={()=>openReview(g.taskId)}><CheckCheck size={16}/>核对并验收</button>}<button className="button" onClick={()=>g.status==='deleted'?openTrash():g.ready?openRevision(g.taskId):openTask(g.taskId)}>{g.status==='deleted'?'前往已删除':g.ready?'提出修改意见':'查看事项与下一步'}</button></footer>
    </article>}</PagedList></section>
    {!groups.length&&<div className="agent-empty"><FileText size={32}/><h3>当前筛选下没有成果</h3><p>调整筛选，或等待事项生成产出。</p></div>}
    {result.unlinked.length>0&&!project&&!q&&filter==='all'&&<LazyDetails className="result-history" summary={<> 未关联事项的历史记录（{result.unlinked.length}）</>}>{()=><><p>这些文档未关联当前事项，请核对后使用。</p><PagedList items={result.unlinked} label="未关联历史分页">{a=><button className="result-history-file" key={a.id} onClick={()=>openResult({type:'artifact',id:a.id})}>{a.title}<small>{when(a.createdAt)}</small></button>}</PagedList></>}</LazyDetails>}
  </div>;
}
