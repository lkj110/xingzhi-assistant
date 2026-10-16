import React,{useEffect,useMemo,useState} from 'react';
import {Clock3,RefreshCw,ShieldCheck,Zap,Download} from 'lucide-react';
import {call,desktop,download} from './api';
import StewardshipPanel from './StewardshipPanel';
import {Pagination} from './RenderBounds';
import {pageBounds} from './render-bounds.mjs';
const when=t=>t?new Date(t).toLocaleString('zh-CN'):'—';
// Remounted for each state revision: old or in-flight records cannot be shown
// or exported after a workspace change. The eight-row state preview is not used.
function ModelCallStats({repeated,children}){
  const [result,setResult]=useState({status:'loading',calls:[],error:''});
  const [attempt,setAttempt]=useState(0),[page,setPage]=useState(1);
  useEffect(()=>{
    let active=true;
    call('viewDetail',{kind:'modelCalls',id:'all'}).then(detail=>{
      if(!Array.isArray(detail?.calls))throw Error('调用记录响应不完整');
      if(active)setResult({status:'ready',calls:detail.calls,error:''});
    }).catch(error=>{if(active)setResult({status:'error',calls:[],error:error.message||'无法读取调用记录'});});
    return ()=>{active=false;};
  },[attempt]);
  const {calls,status,error}=result,ready=status==='ready';
  const stats=useMemo(()=>{
    const completed=calls.filter(c=>c.status==='done'),known=calls.filter(c=>Number.isFinite(c.inputTokens));
    return {completed:completed.length,known:known.length,duration:completed.reduce((n,c)=>n+(Number.isFinite(c.durationMs)?c.durationMs:0),0),
      totals:known.reduce((v,c)=>({input:v.input+c.inputTokens,output:v.output+(c.outputTokens||0),cached:v.cached+(c.cachedInputTokens||0)}),{input:0,output:0,cached:0}),
      cachedCalls:calls.filter(c=>Number.isFinite(c.cachedInputTokens)).length};
  },[calls]);
  const bounds=pageBounds(calls.length,page,30);
  function retry(){setResult({status:'loading',calls:[],error:''});setPage(1);setAttempt(n=>n+1);}
  return <section className="settings-card" aria-label="执行效率"><header><div><h2><Zap size={19}/>执行效率</h2><p>记录最近 1,000 次调用的耗时与用量，便于比较相同任务。</p></div><button className="button" disabled={!ready} onClick={()=>{if(ready)download('行知调用统计.json',JSON.stringify({calls,repeatedActions:repeated},null,2),'application/json');}}><Download size={15}/>导出统计</button></header>
    {children}
    {status==='loading'&&<p className="muted" role="status">正在加载完整调用记录…</p>}
    {status==='error'&&<div role="alert"><p className="test-error">调用记录加载失败：{error}</p><button className="button" onClick={retry}>重试加载调用记录</button></div>}
    {ready&&<>
      <div className="runtime-facts"><div><small>成功调用</small><strong>{stats.completed} / {calls.length}</strong></div><div><small>平均耗时</small><strong>{stats.completed?(stats.duration/stats.completed/1000).toFixed(1):'—'} 秒</strong></div><div><small>连续重复动作（累计）</small><strong>{repeated}</strong></div><div><small>模型报告的输入 / 输出</small><strong>{stats.totals.input.toLocaleString()} / {stats.totals.output.toLocaleString()}</strong></div></div>
      <p className="muted">{stats.known} 次返回了 token 用量，{calls.length-stats.known} 次未知。已报告的缓存输入：{stats.totals.cached.toLocaleString()}（{stats.cachedCalls} 次提供该字段）。这些数值不是订阅计费金额。</p>
      <div className="telemetry-table"><table><thead><tr><th>时间／模型</th><th>阶段</th><th>请求字符</th><th>耗时</th><th>输入 / 输出 token</th><th>状态</th></tr></thead><tbody>{calls.slice(bounds.start,bounds.end).map(c=><tr key={c.id}><td>{when(c.at)}<small>{c.model} {c.reasoning}</small>{c.fallbackFrom&&<small>备用接续 · 第 {c.attempt||2} 次尝试</small>}</td><td>{{json_repair:'输出格式修复',planner:'规划',goal_verify:'目标检查',task_work:'生成产出',task_verify:'事项检查',connection_test:'连接检测'}[c.stage]||c.stage}</td><td>{c.inputChars?.toLocaleString()??'—'}</td><td>{Number.isFinite(c.durationMs)?(c.durationMs/1000).toFixed(1)+'s':'—'}</td><td>{c.inputTokens??'—'} / {c.outputTokens??'—'}</td><td>{{done:'成功',error:'失败',running:'运行中',stopped:'已停止'}[c.status]}{c.status==='error'&&typeof c.errorCode==='string'&&<small>{c.errorCode}{c.errorMessage?` · ${c.errorMessage}`:""}{c.diagnostic?.fingerprint?` · 诊断 ${c.diagnostic.fingerprint}`:""}</small>}</td></tr>)}</tbody></table>{!calls.length&&<p className="muted">推进一个事项后，这里会出现调用记录。</p>}</div>
      <Pagination bounds={bounds} onChange={setPage} label="调用记录分页"/>
    </>}
  </section>;
}
export default function RuntimePage({data,act,perform}){
  const [compact,setCompact]=useState(data.settings.compactContext!==false);
  useEffect(()=>setCompact(data.settings.compactContext!==false),[data.settings.compactContext]);
  const [backups,setBackups]=useState([]),[preview,setPreview]=useState(null),[runtime,setRuntime]=useState(null),[busy,setBusy]=useState(false);
  async function refresh(){try{setBackups(await act('backupList'));if(desktop)setRuntime(await act('runtimeStatus'));}catch{}}
  useEffect(()=>{refresh();},[]);
  async function backup(){setBusy(true);try{setBackups(await act('backupCreate'));}catch{}finally{setBusy(false);}}
  async function restore(){setBusy(true);try{await act('backupRestore',{id:preview.id},'工作空间已恢复，自动推进已暂停');setPreview(null);await refresh();}catch{}finally{setBusy(false);}}
  const callsRevision=JSON.stringify([data.viewRevision??null,data.runtime?.revision??null]);
  const repeated=data.delegations.reduce((n,j)=>n+(j.repeatedActions||0),0);
  return <div className="runtime-layout">
    <StewardshipPanel data={data} act={act}/>
    <section className="settings-card"><header><div><h2><Clock3 size={19}/>运行状态</h2><p>窗口关闭后继续工作；电脑唤醒时补查到期任务。</p></div><button className="button" onClick={refresh}><RefreshCw size={15}/>刷新状态</button></header><p className="help-text">独立事项并行执行，各自记录模型、用量和费用。暂停某个委托不影响其他委托。</p><div className="runtime-facts"><div><small>当前工作</small><strong>{data.operation?.label||'等待新信息或到期事项'}</strong></div><div><small>网络</small><strong>{runtime?.online===false?'离线':runtime?.online?'系统网络可用':'未检测'}</strong></div><div><small>最近唤醒</small><strong>{when(data.runtime?.resumedAt)}</strong></div></div>
      {desktop&&<label className="connection-check"><input type="checkbox" disabled={!runtime?.loginSupported} checked={!!runtime?.openAtLogin} onChange={async e=>{const value=e.target.checked;setRuntime({...runtime,openAtLogin:value});try{const result=await act('runtimeStartup',{enabled:value});setRuntime({...runtime,...result});}catch{setRuntime(runtime);}}}/>登录电脑时启动行知助手 {!runtime?.loginSupported&&<small>（在打包后的 App 中设置）</small>}</label>}
      {data.runtime?.recoveryNotice&&<p className="connection-health">{data.runtime.recoveryNotice}</p>}{data.runtime?.backupError&&<p className="test-error">{data.runtime.backupError}</p>}
      <p className="muted">休眠和退出期间停止执行。手动暂停不会因唤醒而恢复；登录、权限或外部结果不明时会保留进度并提示处理。</p>
    </section>
    <ModelCallStats key={callsRevision} repeated={repeated}>
      <label className="connection-check"><input type="checkbox" checked={compact} onChange={async e=>{const value=e.target.checked;setCompact(value);try{await act('settings',{compactContext:value});}catch{setCompact(data.settings.compactContext!==false);}}}/>规划时使用项目摘要，按需读取完整来源和文稿</label><p className="muted">摘要保留目标、待确认项和下一步；执行与验收继续核对实际材料和产出。</p>
    </ModelCallStats>
    <section className="settings-card"><header><div><h2><ShieldCheck size={19}/>本地备份与恢复</h2><p>有保存操作时每小时自动备份，保留最近 30 份；恢复前另存一份当前数据。</p></div><button className="button" disabled={busy||!!data.operation} onClick={backup}>立即备份</button></header><p className="muted">备份保存在本机，包含加密后的配置，仅用于本机恢复。恢复保留较新的执行记录和当前授权，外部交付不会回滚。</p>
      {preview&&<div className="restore-preview"><h3>恢复预览 · {when(preview.at)}</h3><p>{preview.projects} 个项目 · {preview.tasks} 个事项 · {preview.sources} 份材料</p><p>{preview.notice}</p><div className="connection-buttons"><button className="button primary" disabled={busy||!!data.operation} onClick={restore}>恢复这份备份并暂停自动工作</button><button className="button" onClick={()=>setPreview(null)}>取消</button></div></div>}
      {backups.map(b=><div className="backup-row" key={b.id}><div><strong>{b.invalid?'备份校验失败':when(b.at)}</strong><small>{b.invalid?'原文件已保留':`${{manual:'手动备份',automatic:'自动备份','before-restore':'恢复前备份'}[b.reason]||b.reason} · ${b.tasks} 个事项 · ${(b.bytes/1024).toFixed(0)} KB`}</small></div><button className="button small" disabled={b.invalid||busy||!!data.operation} onClick={async()=>{try{setPreview(await act('backupPreview',{id:b.id}));}catch{}}}>预览恢复</button></div>)}
    </section>
  </div>;
}
