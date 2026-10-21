import React,{useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Bell,Check,Clock,RefreshCw,Undo2} from 'lucide-react';
import './attention.css';

const stateLabels={all:'全部关注',unread:'未读',read:'已读',snoozed:'稍后提醒'};
const categoryLabels={all:'全部类别',decision:'需要决定',approval:'外部动作',review:'成果验收',blocked:'推进受阻',followup:'等待跟进',deadline:'截止提醒',completion:'完成进展'};
const severityLabels={critical:'优先核对',warning:'需要关注',info:'等待处理',success:'已完成'};
const when=value=>value?new Date(value).toLocaleString('zh-CN'):'';
export default function AttentionPage({data,act,onNavigate,openTask,openJob,openProject}) {
  const [projectId,setProjectId]=useState(''),[state,setState]=useState('unread'),[category,setCategory]=useState('all'),[page,setPage]=useState(1),[result,setResult]=useState(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[refresh,setRefresh]=useState(0),[snooze,setSnooze]=useState({});
  const sequence=useRef(0),actRef=useRef(act);actRef.current=act;
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),30000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const id=++sequence.current;setLoading(true);setError('');
    Promise.resolve().then(()=>actRef.current('attentionSnapshot',{projectId,state,category,page})).then(value=>{if(sequence.current===id)setResult(value);}).catch(e=>{if(sequence.current===id)setError(e.message);}).finally(()=>{if(sequence.current===id)setLoading(false);});
    return()=>{sequence.current++;};
  },[projectId,state,category,page,refresh,data.events?.[0]?.id,!!data.operation]);
  async function update(action,item,extra={}) {
    setSaving(true);setError('');setNotice('');
    try{await actRef.current(action,{id:item.id,revision:item.revision,riskKey:item.riskKey,...extra});setNotice(action==='attentionAcknowledgeDeadline'?'已知晓本阶段截止风险；其他业务问题仍需分别处理。':action==='attentionRead'?'已标记为已读，工作状态保持原样。':action==='attentionSnooze'?'已设置稍后提醒。原事项继续遵循已有安排。':'已恢复为未读。');setRefresh(value=>value+1);}
    catch(e){setError(e.message);}
    finally{setSaving(false);}
  }
  function open(item) {
    if(onNavigate){onNavigate(item.route);return;}
    if(item.route.taskId)openTask?.(item.route.taskId);
    else if(item.route.jobId)openJob?.(item.route.jobId);
    else if(item.projectId)openProject?.(item.projectId);
  }
  const busy=loading||saving,items=result?.items||[];
  return <div className="attention-page">
    <section className="attention-intro"><div><Bell size={25}/><h2>需要你关注的工作，集中在这里</h2></div><p>查看待决定、成果验收、外部动作、推进阻塞、截止提醒和最近完成进展。内容变化或稍后提醒到期时，会重新成为未读。</p><small>已读只记录你看过；实际处理请进入原事项。聚合本机记录，模型调用 0 次、网络请求 0 次。</small></section>
    <div className="attention-toolbar"><label>所属项目<select aria-label="关注所属项目" disabled={saving} value={projectId} onChange={e=>{setProjectId(e.target.value);setPage(1);setNotice('');}}><option value="">全部项目与独立工作</option><option value="@independent">仅独立工作</option>{(data.projects||[]).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>关注类别<select aria-label="关注类别" disabled={saving} value={category} onChange={e=>{setCategory(e.target.value);setPage(1);}}>{Object.entries(categoryLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button className="button" disabled={busy} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/>刷新关注</button></div>
    <div className="attention-filters" aria-label="关注状态">{Object.entries(stateLabels).map(([key,label])=><button key={key} disabled={saving} className={state===key?'active':''} aria-pressed={state===key} onClick={()=>{setState(key);setPage(1);setNotice('');}}>{label}<span>{result?.counts?.[key]||0}</span></button>)}</div>
    {error&&<p className="form-error" role="alert">{error} <button className="text-button" disabled={saving} onClick={()=>setRefresh(value=>value+1)}>重新读取</button></p>}
    {notice&&<p className="attention-notice" role="status">{notice}</p>}
    {(result?.notices||[]).map(note=><p className="muted" key={note}>{note}</p>)}
    <section className="attention-items" aria-label="关注提醒列表" aria-busy={loading}>
      <header><strong>{loading?'正在读取本地记录…':`${result?.total||0} 条${state==='all'?'当前关注':stateLabels[state]}`}</strong>{result?.generatedAt&&<small>更新于 {when(result.generatedAt)}</small>}</header>
      {!error&&items.map(item=><article key={item.id} className={`attention-card ${item.severity} ${item.state}`}>
        <div className="attention-card-heading"><h3>{item.title}</h3><span>{item.category==='completion'?'已完成':severityLabels[item.severity]}</span></div>
        <div className="attention-meta"><span>{item.projectName}</span><span>{item.categoryLabel}</span><span>{stateLabels[item.state]}</span>{item.paused&&<span>工作已暂停</span>}{item.automaticRetry&&<span>已安排自动重试</span>}</div>
        <p>{item.detail}</p>
        {item.pauseReason&&<p>暂停原因：{item.pauseReason}</p>}
        {item.localDate&&<p className="attention-date">截止日期：{item.localDate}（{item.timeZone}）；具体时间待确认。</p>}
        {item.acknowledged&&<p>已知晓本阶段截止风险</p>}
        {item.deadlineAt&&<p className="attention-date">{item.category==='deadline'?'截止时间':'计划时间'}：{when(item.deadlineAt)}</p>}
        {item.state==='snoozed'&&<p className="attention-date">稍后提醒时间：{when(item.snoozedUntil)}</p>}
        {item.state==='read'&&<small>已读于 {when(item.readAt)}{item.category==='completion'?'；完成记录已查看。':'；原问题仍存在。'}</small>}
        <footer>{item.canAcknowledge&&!item.acknowledged&&<button className="button small" disabled={busy} onClick={()=>update('attentionAcknowledgeDeadline',item)}><Check size={14}/>已知晓本阶段风险</button>}<button className="button primary small" disabled={busy} onClick={()=>open(item)}>进入处理<ArrowUpRight size={14}/></button>{item.state==='read'?<button className="button small" disabled={busy} onClick={()=>update('attentionUnread',item)}><Undo2 size={14}/>标记未读</button>:<button className="button small" disabled={busy} onClick={()=>update('attentionRead',item)}><Check size={14}/>标记已读</button>}{item.state==='snoozed'?<button className="button small" disabled={busy} onClick={()=>update('attentionUnsnooze',item)}><Undo2 size={14}/>取消稍后提醒</button>:<div className="attention-snooze"><select aria-label={`稍后提醒时间：${item.title}`} disabled={busy} value={snooze[item.id]||30} onChange={e=>setSnooze(previous=>({...previous,[item.id]:Number(e.target.value)}))}><option value={30}>30 分钟后</option><option value={120}>2 小时后</option><option value={1440}>24 小时后</option></select><button className="button small" disabled={busy} onClick={()=>update('attentionSnooze',item,{minutes:snooze[item.id]||30})}><Clock size={14}/>稍后提醒</button></div>}</footer>
      </article>)}
      {!loading&&!error&&!items.length&&<div className="attention-empty"><Bell size={28}/><h3>当前筛选下没有关注记录</h3><p>待处理工作会根据最新状态自动进入关注中心。已解决的问题会自动移出。</p></div>}
    </section>
    {result?.pageCount>1&&<nav className="attention-pagination" aria-label="关注列表分页"><button className="button small" disabled={busy||result.page<=1} onClick={()=>setPage(result.page-1)}>上一页</button><span>第 {result.page} / {result.pageCount} 页 · {result.from}–{result.to} 条</span><button className="button small" disabled={busy||result.page>=result.pageCount} onClick={()=>setPage(result.page+1)}>下一页</button></nav>}
    <section className="attention-help"><h3>提醒如何工作</h3><ul><li>已知晓只关闭本阶段、相同条件的截止风险决定；权限、费用和验收问题仍需处理。</li><li>标记已读和稍后提醒只管理阅读状态，不批准外部动作、不回答问题，也不完成事项。</li><li>稍后提醒期间，若问题内容或紧急程度变化，会提前重新成为未读。到期提醒依赖 App 运行和电脑处于唤醒状态。</li><li>同一内容的系统通知会合并并去重。窗口在前台时，可以直接在这里查看；系统通知的展示受系统通知设置影响。</li><li>完成进展保留最近 7 天且当前依据完整的本机记录；本页不重新联网核对外部结果。</li><li>重启保留已读和稍后提醒记录；截止风险的处理与执行唤醒分别保存，恢复备份时与当前工作记录核对。</li></ul></section>
  </div>;
}
