import React,{useEffect,useRef,useState} from 'react';
import {Activity,ArrowUpRight,Download,RefreshCw,ShieldCheck} from 'lucide-react';
import {download} from './api';
import './health.css';

const levels={error:'需要先处理',warning:'需要关注',unknown:'尚未验证',info:'当前安排'};
const labels={attention:'需查看',unknown:'未验证',info:'有安排',recorded:'暂无异常记录'};
export default function HealthPage({data,act,onNavigate}) {
  const [projectId,setProjectId]=useState(''),[level,setLevel]=useState('all'),[result,setResult]=useState(null),[loading,setLoading]=useState(true),[exporting,setExporting]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const sequence=useRef(0),actRef=useRef(act);actRef.current=act;
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const id=++sequence.current;setLoading(true);setError('');
    Promise.resolve().then(()=>actRef.current('healthSnapshot',{projectId})).then(value=>{if(sequence.current===id)setResult(value);}).catch(e=>{if(sequence.current===id)setError(e.message);}).finally(()=>{if(sequence.current===id)setLoading(false);});
    return()=>{sequence.current++;};
  },[projectId,refresh,data.events?.[0]?.id,!!data.operation]);
  async function exportSummary(format) {
    setExporting(true);setError('');
    try {const report=await actRef.current('healthExport',{projectId,format});download(report.filename,report.content,report.mime);}
    catch(e){setError(e.message);}finally{setExporting(false);}
  }
  const findings=(result?.findings||[]).filter(row=>level==='all'||row.severity===level),blocked=loading||!!error;
  return <div className="health-page">
    <section className="health-intro"><div><ShieldCheck size={25}/><h2>看清当前工作卡在哪里</h2></div><p>从模型配置、资料收集到交付和恢复，把本机记录中的问题与下一步集中到一起。</p><small>体检只读 · 本次模型调用 0 次 · 本次网络请求 0 次</small></section>
    <div className="health-toolbar"><label>所属项目<select aria-label="体检所属项目" value={projectId} onChange={e=>{setProjectId(e.target.value);setLevel('all');}}><option value="">全部项目与独立工作</option><option value="@independent">仅独立工作</option>{(data.projects||[]).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><div><button className="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/>刷新体检</button><button className="button" disabled={blocked||exporting} onClick={()=>exportSummary('md')}><Download size={15}/>导出体检 Markdown</button><button className="button" disabled={blocked||exporting} onClick={()=>exportSummary('json')}>导出体检 JSON</button></div></div>
    <div className="health-checks" aria-label="体检类别">{(result?.checks||[]).map(check=><div key={check.id} className={`health-check ${check.status}`}><span>{check.label}</span><strong>{labels[check.status]}</strong><small>{check.count} 条记录</small></div>)}</div>
    <div className="health-filters" aria-label="体检严重程度"><button className={level==='all'?'active':''} aria-pressed={level==='all'} onClick={()=>setLevel('all')}>全部发现 <span>{result?.findings?.length||0}</span></button>{Object.entries(levels).map(([key,label])=><button key={key} className={level===key?'active':''} aria-pressed={level===key} onClick={()=>setLevel(key)}>{label} <span>{result?.counts?.[key]||0}</span></button>)}</div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <section className="health-findings" aria-label="工作体检结果" aria-busy={loading}><header><strong>{loading?'正在读取本地记录…':`${findings.length} 条发现`}</strong>{result?.generatedAt&&<small>快照时间：{new Date(result.generatedAt).toLocaleString('zh-CN')}</small>}</header>
      {!error&&findings.map(finding=><article key={finding.id} className={`health-finding ${finding.severity}`}><div className="health-finding-title"><h3>{finding.title}</h3><span>{levels[finding.severity]}</span></div>{finding.entity&&<small className="health-entity">{finding.entity.kind} · {finding.entity.label}</small>}<p>{finding.reason}</p>{finding.evidence.length>0&&<ul>{finding.evidence.map((evidence,index)=><li key={index}>{evidence}</li>)}</ul>}<div className="health-next"><p><strong>下一步：</strong>{finding.nextStep}</p><button className="button small" disabled={blocked} onClick={()=>onNavigate(finding.route)}>查看处理入口<ArrowUpRight size={14}/></button></div></article>)}
      {!loading&&!error&&!findings.length&&<div className="health-empty"><Activity size={28}/><h3>当前筛选下没有发现</h3><p>这表示本地记录中没有匹配项；外部服务连通性与实际结果仍以各功能的验证记录为准。</p></div>}
    </section>
    <section className="health-scope"><h3>体检覆盖范围</h3><ul>{(result?.limitations||['本页汇总当前本机记录，未主动测试外部服务。']).map(line=><li key={line}>{line}</li>)}</ul><p>导出保留原因、数量、时间和下一步，省略工作名称、原文、记录 ID、路径、网址与凭据。</p></section>
  </div>;
}
