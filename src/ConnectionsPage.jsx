import ActiveCollection from './ActiveCollection';
import OfficeConnections from './OfficeConnections';
import React,{useState,useRef} from 'react';
import {SendPolicy} from './DecisionsPage';
import FolderConnections from './FolderConnections';
import WebConnections from './WebConnections';
import FeedConnections from './FeedConnections';
import {Link2,Plus,RefreshCw,Pause,Play,Trash2,Check,AlertCircle} from 'lucide-react';
const when=t=>t?new Date(t).toLocaleString('zh-CN'):'尚未同步';
const health={healthy:'连接正常',auth:'需要登录',permission:'权限不足',missing_cli:'需要安装 CLI',merge:'等待核对外部动作',unchecked:'待检测',paused:'已暂停',interrupted:'上轮中断，等待续传',error:'读取失败',connection:'连接失败',cursor:'正在恢复断点'};
export default function ConnectionsPage({data,act,perform,openProjects,openRules}){
  const formRef=useRef(null);
  const [form,setForm]=useState({name:'',kind:'document',target:'',projectId:data.projects.find(p=>!p.archivedAt)?.id||'',intervalMinutes:15,lookbackDays:7,enabled:true});
  const [error,setError]=useState(''),[checking,setChecking]=useState(false),[status,setStatus]=useState(data.larkHealth);
  async function check(){setChecking(true);try{setStatus(await act('connectorStatus'));}catch{}finally{setChecking(false);}}
  async function save(e){e.preventDefault();setError('');try{await act('connectorSave',form,'信息连接已保存');setForm({...form,id:undefined,name:'',target:''});}catch(e){setError(e.message);}}
  return <div className="connected-layout">
    <div className="connected-main"><ActiveCollection data={data} act={act} openProject={openProjects} openRules={openRules}/><OfficeConnections data={data} act={act} perform={perform} openProjects={openProjects}/><FolderConnections data={data} act={act} perform={perform}/><FeedConnections data={data} act={act} perform={perform} openProjects={openProjects}/><WebConnections data={data} act={act} perform={perform} openProjects={openProjects}/><section className="settings-card"><header><div><h2><Link2 size={19}/>飞书信息入口</h2><p>指定文档或会话，更新后自动归并到同一个项目。</p></div><button className="button" disabled={checking} onClick={check}><RefreshCw size={15}/>{checking?'检测中…':'检测飞书连接'}</button></header>
      <div className="connection-health">{status?.loggedIn?<Check size={18}/>:<AlertCircle size={18}/>}<span>{status?.message||'首次使用前，请检测本机飞书用户登录状态。'}</span></div>
      <details className="connection-help"><summary>连接配置与登录指引</summary><p>复用本机 lark-cli 的用户登录。首次安装后先完成应用配置，再运行对应的登录命令，在浏览器完成授权后重新检测。</p><code>lark-cli auth login --domain docs --domain im</code><p>同步入口执行读取命令；会话发送须单独授权。文档填写完整 /docx/ 或 /wiki/ 地址；会话填写 oc_ 开头的 ID。每个入口严格绑定一个项目。</p><p>文档检查全文变化；会话按发送时间增量读取，并回看最近 24 小时以发现编辑和撤回。更早消息的编辑、完整话题回复、附件与表格内容暂未覆盖。</p></details>
      {!data.projects.length?<div className="connection-health"><span>先建立一个项目，设置目标和 Agent 授权，即可让新材料自动推进事项。</span><button className="button" onClick={openProjects}>前往项目</button></div>:<form ref={formRef} className="connection-form" onSubmit={save}>
        <label>连接名称<input required maxLength={100} aria-label="连接名称" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="例如：产品周会纪要"/></label>
        <label>来源类型<select aria-label="连接来源类型" disabled={!!form.id} value={form.kind} onChange={e=>setForm({...form,kind:e.target.value,target:''})}><option value="document">飞书文档</option><option value="chat">飞书会话</option></select></label>
        <label className="connection-wide">{form.kind==='document'?'文档地址':'会话 ID'}<input required aria-label="连接来源地址" disabled={!!form.id} value={form.target} onChange={e=>setForm({...form,target:e.target.value})} placeholder={form.kind==='document'?'https://你的组织.feishu.cn/docx/…':'oc_…'}/></label>
        <label>归属项目<select required aria-label="连接归属项目" disabled={!!form.id} value={form.projectId} onChange={e=>setForm({...form,projectId:e.target.value})}><option value="">选择项目</option>{data.projects.map(p=><option key={p.id} value={p.id} disabled={!!p.archivedAt}>{p.name}{p.archivedAt?'（已归档）':''}</option>)}</select></label>
        <label>同步间隔<select aria-label="连接同步间隔" value={form.intervalMinutes} onChange={e=>setForm({...form,intervalMinutes:Number(e.target.value)})}>{[5,15,30,60,240,1440].map(n=><option key={n} value={n}>每 {n} 分钟</option>)}</select></label>
        {form.kind==='chat'&&<label>首次回看<select aria-label="首次回看" value={form.lookbackDays} onChange={e=>setForm({...form,lookbackDays:Number(e.target.value)})}>{[1,7,30].map(n=><option value={n} key={n}>过去 {n} 天</option>)}</select></label>}
        <label className="connection-check"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>保存后自动同步</label>
        {error&&<p className="test-error connection-wide">{error}</p>}
        <div className="connection-wide"><button className="button primary" disabled={!!data.operation}><Plus size={15}/>{form.id?'保存连接设置':'添加信息连接'}</button>{form.id&&<button type="button" className="button" onClick={()=>setForm({...form,id:undefined,name:'',target:''})}>取消编辑</button>}</div>
      </form>}
    </section>
    <section className="settings-card"><header><div><h2>已连接的来源</h2><p>同步不调用模型；有变化时，由项目原有 Agent 继续处理。</p></div></header>
      {!data.connectors.filter(c=>!c.provider||c.provider==='lark').length&&<p className="muted">还没有连接来源。</p>}
      {data.connectors.filter(c=>!c.provider||c.provider==='lark').map(c=><article className="connection-item" key={c.id}><div className="connection-title"><h3>{c.name}</h3><span className="connection-tag">{c.enabled?'自动同步':'已暂停'} · {health[c.health]||'待检查'}</span></div><p>{data.projects.find(p=>p.id===c.projectId)?.name} · {c.kind==='document'?'文档':'会话'}</p><code>{c.target}</code><small>最近成功：{when(c.lastSuccessAt)} · 已导入 {c.imported||0} 份版本 · {c.cursor?.token?'正在继续分页':'断点已保存'}</small>{c.error&&<p className="test-error">{c.error}</p>}{!data.projects.find(p=>p.id===c.projectId)?.jobId&&<p className="muted">此项目尚未建立委托。材料会先保存；创建项目委托后开始自动拆解。</p>}<div className="connection-buttons"><button className="button small" disabled={!!data.operation} onClick={()=>{setForm({...c});formRef.current?.scrollIntoView({block:'center'});}}>编辑连接</button><button className="button small" disabled={!!data.operation} onClick={()=>perform('connectorSync',{id:c.id})}><RefreshCw size={13}/>立即同步／重试</button><button className="button small" disabled={!!data.operation} onClick={()=>perform('connectorToggle',{id:c.id,enabled:!c.enabled})}>{c.enabled?<Pause size={13}/>:<Play size={13}/>} {c.enabled?'暂停同步':'恢复同步'}</button><button className="icon-button" aria-label={`移除连接 ${c.name}`} disabled={!!data.operation} onClick={()=>{if(window.confirm(`移除「${c.name}」？已收集的材料会保留。`))perform('connectorDelete',{id:c.id});}}><Trash2 size={15}/></button></div>{c.kind==='chat'&&<SendPolicy connection={c} data={data} act={act}/>}</article>)}
    </section></div>
    <aside className="settings-card connection-aside"><h3>从信息到结果</h3><ol><li>选择项目和来源</li><li>自动收集更新并保留出处</li><li>沿用原事项，调整受影响的计划</li><li>按项目授权推进、交付与跟进</li></ol><p>已暂停的项目保持暂停。登录失效或外部执行待核对时会保留断点，处理后点击重试。</p><h3>最近同步</h3>{data.connectorRuns.slice(0,8).map(r=><div className="connection-run" key={r.id}><strong>{data.connectors.find(c=>c.id===r.connectorId)?.name||'已移除的入口'}</strong><small>{when(r.startedAt)}</small><p>{{updated:'已归并新材料',unchanged:'没有变化',partial:'分页处理中',running:'正在同步',error:'需要处理',paused:'已暂停',interrupted:'上轮中断，等待续传'}[r.status]} · 新增 {r.added} 份</p></div>)}</aside>
  </div>;
}
