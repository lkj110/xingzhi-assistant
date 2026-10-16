import {workBusy} from './execution-state';
import React,{useEffect,useRef,useState} from 'react';
import {ArrowUpRight,CheckCheck,FileText,RefreshCw,ShieldCheck} from 'lucide-react';
import './acceptance.css';
import {ResultFiles} from './ResultsPage';

export default function AcceptancePage({data,act,onNavigate,openResult,focusTaskId,clearFocus,openRevision}) {
  const [projectId,setProjectId]=useState(''),[result,setResult]=useState(null),[selected,setSelected]=useState({}),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{setSelected({});setNotice('');},[focusTaskId]);
  const sequence=useRef(0),actRef=useRef(act);actRef.current=act;
  useEffect(()=>{
    const request=++sequence.current;setLoading(true);setError('');
    Promise.resolve().then(()=>actRef.current('acceptanceSnapshot',{projectId})).then(value=>{
      if(sequence.current!==request)return;
      setResult(value);
    }).catch(e=>{if(sequence.current===request)setError(e.message);}).finally(()=>{if(sequence.current===request)setLoading(false);});
    return()=>{sequence.current++;};
  },[projectId,refresh,data.events?.[0]?.id,!!data.operation]);
  const busy=loading||saving||!!data.exclusiveOperation,items=(result?.items||[]).filter(item=>!focusTaskId||item.id===focusTaskId),ready=items.filter(item=>item.ready&&!workBusy(data,{taskId:item.id})),count=Object.keys(selected).length;
  const staleCount=Object.entries(selected).filter(([id,revision])=>!items.some(item=>item.id===id&&item.revision===revision&&item.ready)).length;
  function toggle(item,checked){setSelected(previous=>{const next={...previous};if(checked)next[item.id]=item.revision;else delete next[item.id];return next;});setNotice('');}
  async function accept(chosen=Object.entries(selected).map(([id,revision])=>({id,revision}))){
    setSaving(true);setError('');setNotice('');
    try {
      const response=await actRef.current('acceptanceAccept',{projectId,items:chosen});
      setSelected({});setResult(response.snapshot);setNotice(`已验收 ${response.acceptedIds.length} 项成果。`);setRefresh(value=>value+1);
    } catch(e){setError(e.message);setSelected({});}
    finally{setSaving(false);}
  }
  function openTask(item){onNavigate?.({page:'board',taskId:item.id,...(item.projectId?{projectId:item.projectId}:{})});}
  return <div className={`acceptance-page ${focusTaskId?'focused':''}`}>
    <section className="acceptance-intro"><div><ShieldCheck size={25}/><h2>先看成果，再决定是否验收</h2></div><p>每个事项只展示当前版本。核对交付范围后，可以验收，也可以提交修改意见。</p><small>验收操作只更新本机完成记录；后续推进遵循已有托管设置和权限。</small></section>
    {focusTaskId&&<div className="acceptance-focus">正在查看所选事项的验收要点<button className="text-button" onClick={clearFocus}>查看全部待验收事项</button></div>}
    {!focusTaskId&&<><div className="acceptance-toolbar"><label>所属项目<select aria-label="验收所属项目" disabled={saving} value={projectId} onChange={e=>{setProjectId(e.target.value);setSelected({});setNotice('');}}><option value="">全部项目与独立工作</option><option value="@independent">仅独立工作</option>{(data.projects||[]).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button className="button" disabled={loading||saving} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/>刷新验收列表</button></div>
    <div className="acceptance-summary"><span><strong>{ready.length}</strong> 项可验收</span><span><strong>{items.length-ready.length}</strong> 项需补齐依据</span><small>本次模型调用 0 次 · 网络请求 0 次</small></div>
    <div className="acceptance-actions"><label><input aria-label="选择全部可验收事项" type="checkbox" disabled={busy||!ready.length||!!error} checked={ready.length>0&&ready.slice(0,100).every(item=>selected[item.id]===item.revision)} onChange={e=>setSelected(e.target.checked?Object.fromEntries(ready.slice(0,100).map(item=>[item.id,item.revision])):{})}/>选择可验收事项（最多 100 项）</label><button className="button primary" disabled={busy||Object.keys(selected).some(taskId=>workBusy(data,{taskId}))||!count||!!error||staleCount>0} onClick={()=>accept()}><CheckCheck size={16}/>{saving?'正在验收…':`验收所选 ${count} 项`}</button></div></>}
    {!loading&&staleCount>0&&<p className="acceptance-stale" role="alert">已选事项中有 {staleCount} 项依据发生变化，整批尚未验收。请查看最新内容后重新选择。 <button className="text-button" disabled={saving} onClick={()=>setSelected({})}>清除选择</button></p>}
    {data.exclusiveOperation&&<p className="muted">助手正在更新工作空间，完成后可以提交验收。</p>}
    {error&&<p className="form-error" role="alert">{error} <button className="text-button" disabled={saving} onClick={()=>setRefresh(value=>value+1)}>重新读取</button></p>}
    {notice&&<p className="acceptance-notice" role="status">{notice}</p>}
    <section className="acceptance-items" aria-label="成果验收列表" aria-busy={loading}>
      {loading&&<p className="muted">正在读取验收依据…</p>}
      {!error&&items.map(item=><article key={item.id} className={`acceptance-card ${item.ready?'ready':'blocked'}`}>
        <header><label><input type="checkbox" aria-label={`选择验收：${item.title}`} disabled={busy||workBusy(data,{taskId:item.id})||!item.ready||!selected[item.id]&&count>=100} checked={selected[item.id]===item.revision} onChange={e=>toggle(item,e.target.checked)}/><h3>{item.title}</h3></label><span className="acceptance-state">{item.ready?'可验收':'需补齐依据'}</span></header>
        <div className="acceptance-meta"><span>{item.projectName}</span>{item.jobPaused&&<span>委托已暂停，验收后保持暂停</span>}{item.verifiedAt&&<time>检查于 {new Date(item.verifiedAt).toLocaleString('zh-CN')}</time>}</div>
        <section className="acceptance-decision"><strong>需要你决定：是否接受当前成果？</strong><p>{item.ready?'请先阅读下方当前成果，核对交付范围、未验证部分是否符合约定。有遗漏可提交修改意见，让 Agent 继续。':'当前验收依据尚未补齐，请先查看问题并继续推进。'}</p></section>
        {data.resultOverview?.groups.find(g=>g.taskId===item.id)?<ResultFiles group={data.resultOverview.groups.find(g=>g.taskId===item.id)} openResult={openResult}/>:<div className="acceptance-artifacts">{item.artifacts.map(a=><button key={a.id} onClick={()=>openResult?.({type:'artifact',id:a.id,taskId:item.id})}><strong>{a.title}</strong><small>当前成果 · 查看完整产出</small></button>)}</div>}
        {item.verification&&<div className="acceptance-verification"><ShieldCheck size={17}/><div><strong>{item.verification.passed?'已有通过的检查记录':'结果检查尚未通过'}</strong><p>{item.verification.summary}</p>{item.verification.gaps.map((gap,index)=><p key={index}>{gap}</p>)}</div></div>}
        {item.reasons.length>0&&<ul className="acceptance-reasons">{item.reasons.map(reason=><li key={reason.code}>{reason.message}</li>)}</ul>}
        <details className="acceptance-criteria-details"><summary>对照原定完成标准</summary><p className="acceptance-criteria">{item.criteria}</p></details>
        <details><summary>查看依据：{item.steps.length} 个步骤 · {item.sources.length} 份材料 · {item.deliveries.length} 条回执</summary><div className="acceptance-evidence"><h4>执行步骤</h4>{item.steps.map(step=><p key={step.id}><strong>{step.done?'已完成':'待执行'} · {step.title}</strong>{step.evidence&&<span>{step.evidence}</span>}</p>)}<h4>引用材料</h4>{item.sources.length?item.sources.map(source=><button key={source.id} className="text-button" disabled={loading||saving||!source.available} onClick={()=>openResult?.({type:'source',id:source.id})}>{source.title} · 第 {source.version} 版 · {source.available?(source.current?'当前版本':'已有更新'):'不可用'}<ArrowUpRight size={13}/></button>):<p>此事项没有引用材料，以完成标准和步骤依据为准。</p>}<h4>执行回执</h4>{item.deliveries.length?item.deliveries.map(delivery=><p key={delivery.id}>{delivery.tool} · {delivery.verified?'已有回读确认':'已有成功记录'} · {delivery.current?'对应当前产出':'历史或人工确认回执'}<span>{delivery.target}</span></p>):<p>未记录外部交付；请按事项完成标准检查是否需要交付。</p>}</div></details>
        <footer className="acceptance-bottom-actions"><button className="button" disabled={busy||workBusy(data,{taskId:item.id})} onClick={()=>openRevision?openRevision(item.id):openTask(item)}>提出修改意见<ArrowUpRight size={14}/></button><button className="button primary" disabled={busy||workBusy(data,{taskId:item.id})||!item.ready||!!error} onClick={()=>accept([{id:item.id,revision:item.revision}])}>已阅读，验收该成果</button></footer>
      </article>)}
      {!loading&&!error&&!items.length&&<div className="acceptance-empty"><CheckCheck size={30}/><h3>当前范围没有待验收成果</h3><p>事项完成执行和结果检查后，会出现在这里。</p></div>}
    </section>
  </div>;
}
