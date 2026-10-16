import React,{useEffect,useRef,useState} from 'react';
import {Search,ArrowUpRight,FileText,RefreshCw} from 'lucide-react';
import './library.css';
const labels={all:'全部内容',project:'项目',job:'委托',source:'材料',task:'事项',artifact:'工作产出',decision:'决策',memory:'工作记忆'};
export default function LibraryPage({data,act,openResult,initialType='all'}){
  const [query,setQuery]=useState(''),[type,setType]=useState(initialType),[projectId,setProjectId]=useState(''),[history,setHistory]=useState(false),[offset,setOffset]=useState(0),[result,setResult]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const generation=useRef(0),actRef=useRef(act);actRef.current=act;
  useEffect(()=>{
    const id=++generation.current;setLoading(true);setError('');
    const timer=setTimeout(async()=>{try{const r=await actRef.current('librarySearch',{query,type,projectId,history,offset});if(generation.current===id)setResult(r);}catch(e){if(generation.current===id)setError(e.message);}finally{if(generation.current===id)setLoading(false);}},200);
    return()=>{clearTimeout(timer);generation.current++;};
  },[query,type,projectId,history,offset,refresh,data.sources.length,data.artifacts.length,data.events[0]?.id]);
  function filter(setter,value){setter(value);setOffset(0);}
  return <section className="library-page">
    <div className="library-toolbar"><label className="search-field"><Search size={17}/><input autoFocus aria-label="全局检索关键词" maxLength={200} placeholder="查找材料正文、目标、成果或曾经做过的决定" value={query} onChange={e=>filter(setQuery,e.target.value)}/></label><button className="button" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={15}/>刷新结果</button></div>
    <div className="library-filters"><label>内容类型<select aria-label="检索内容类型" value={type} onChange={e=>filter(setType,e.target.value)}>{Object.entries(labels).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>所属项目<select aria-label="检索所属项目" value={projectId} onChange={e=>filter(setProjectId,e.target.value)}><option value="">全部项目与独立工作</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={history} onChange={e=>filter(setHistory,e.target.checked)}/>包含历史与已失效内容</label></div>
    <p className="muted">搜索本机保存的完整文本。默认展示当前材料与产出，历史版本可单独包含；不会调用模型。</p>
    <div className="library-summary" role="status">{loading?'正在检索…':error||`找到 ${result?.total||0} 条内容`}{result?.total>0&&<small>当前显示 {result.offset+1}–{Math.min(result.offset+result.limit,result.total)}</small>}</div>
    <div className="library-results" aria-busy={loading}>{result?.items.map(r=><button key={`${r.type}:${r.id}`} className="library-result" disabled={loading||!!error} onClick={()=>openResult(r)}><div className="library-result-heading"><span className="library-kind">{labels[r.type]}</span><span className={!r.current?'library-historical':''}>{r.status}</span><ArrowUpRight size={15}/></div><h3>{r.title}</h3><p>{r.excerpt||'打开查看详情'}</p><footer><span>{r.projectName}</span>{r.at&&<time>{new Date(r.at).toLocaleString('zh-CN')}</time>}</footer>{r.deliveries?.length>0&&<div className="library-deliveries"><FileText size={14}/><span>{r.deliveries.length} 次成功交付记录 · {r.deliveries.at(-1).target}</span></div>}</button>)}</div>
    {!loading&&!error&&!result?.total&&<div className="agent-empty"><Search size={32}/><h3>{query?'没有找到相关内容':'还没有可显示的内容'}</h3><p>尝试调整关键词、项目或历史筛选。</p></div>}
    {result?.total>30&&<div className="library-pagination"><button className="button" disabled={loading||offset===0} onClick={()=>setOffset(Math.max(0,offset-30))}>上一页</button><button className="button" disabled={loading||!result.more} onClick={()=>setOffset(offset+30)}>下一页</button></div>}
  </section>;
}
