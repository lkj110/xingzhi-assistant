import React,{useState} from 'react';
import {FolderOpen,Plus,RefreshCw,Pause,Play,Trash2,X} from 'lucide-react';
import {desktop} from './api';
import './folder-connections.css';
const health={healthy:'同步正常',attention:'需要查看',error:'需要处理',unchecked:'等待检查',paused:'已暂停'};
const when=value=>value?new Date(value).toLocaleString('zh-CN'):'尚未同步';
export default function FolderConnections({data,act,perform}){
  const [editing,setEditing]=useState(null),[error,setError]=useState('');
  const busy=!!data.operation;
  async function choose(){setError('');try{const state=await act('chooseFolder',{configureFirst:true});const added=state.folders.find(f=>!data.folders.some(old=>old.id===f.id));if(added)setEditing(added.id);}catch(e){setError(e.message);}}
  return <section className="settings-card folder-connections"><header><div><h2><FolderOpen size={19}/>本地资料目录</h2><p>将授权目录绑定项目，内容更新后沿用已有事项继续推进。</p></div>{desktop&&<button className="button" disabled={busy} onClick={choose}><Plus size={15}/>连接资料目录</button>}</header>
    <p className="help-text">后台每 5 分钟检查，遵守自动运行时段和暂停设置。只读取所选目录，支持 TXT、MD、CSV、JSON、PDF 和 DOCX，每轮最多 100 份、合计 50 MB；未变化的文档直接复用解析结果。</p>
    {!desktop&&<p className="help-text">请在电脑端 App 中选择目录。</p>}{error&&<p className="form-error">{error}</p>}
    {!data.folders.length&&<p className="muted">连接目录后先选择归属项目，再开启同步。项目未创建委托时，材料会先保存。</p>}
    {data.folders.map(folder=><article className="folder-connection" key={folder.id}>
      <div className="connection-title"><h3>{folder.name}</h3><span className="connection-tag">{folder.enabled===false?'已暂停':health[folder.health]||'自动同步'}</span></div>
      <p>{data.projects.find(p=>p.id===folder.projectId)?.name||'独立材料'} · {folder.enabled===false?'自动同步已暂停':'每 5 分钟同步'}</p><code>{folder.path}</code>
      <small>最近检查：{when(folder.lastSyncedAt)}{folder.stats&&` · 检查 ${folder.stats.checked||0}/${folder.stats.total||0} 份 · 新增 ${folder.stats.added||0} 版 · 移除 ${folder.stats.removed||0} 份来源`}</small>
      {folder.error&&<p className="form-error">{folder.error}</p>}{folder.warnings?.map((warning,index)=><p className="folder-warning" key={index}>{warning}</p>)}
      {folder.projectId&&!data.projects.find(p=>p.id===folder.projectId)?.jobId&&<p className="muted">此项目尚未建立 Agent 委托，新增材料会先保存。</p>}
      <div className="connection-buttons"><button className="button small" disabled={busy} onClick={()=>setEditing(folder.id)}>设置目录</button><button className="button small" disabled={busy} onClick={()=>perform('folderSync',{id:folder.id})}><RefreshCw size={13}/>同步此目录</button><button className="button small" disabled={busy} onClick={()=>perform('folderToggle',{id:folder.id,enabled:folder.enabled===false})}>{folder.enabled===false?<Play size={13}/>:<Pause size={13}/>} {folder.enabled===false?'恢复目录同步':'暂停目录同步'}</button><button className="icon-button" disabled={busy} aria-label={`取消目录授权 ${folder.name}`} onClick={()=>{if(window.confirm(`取消「${folder.name}」的目录授权？已保存材料和历史会保留，Agent 将不能再读取此目录。`))perform('folderRemove',{id:folder.id});}}><Trash2 size={14}/></button></div>
      {editing===folder.id&&<FolderForm key={folder.id} folder={folder} data={data} act={act} close={()=>setEditing(null)}/>}
    </article>)}
    <details className="connection-help"><summary>版本、移除与授权范围</summary><p>不同文件分别记录来源；文件内容改回旧版本也会保留一次新版本。更换归属项目只影响后续同步，旧项目中的资料和记录会保留。</p><p>只有完整、无错误的扫描才能确认文件移除。移除后保留原文和历史、标记当前来源已撤回，并要求相关事项重新核对。目录不可访问、读取失败、超限或中断都不会被当成文件删除。</p><p>不读取子目录、符号链接、隐藏文件或本助手已记录的交付文件。已在项目中撤回的材料保持撤回，需明确重新关联才能恢复同步。暂停仅关闭自动同步；“同步此目录”可以手动检查一次。</p></details>
  </section>;
}
function FolderForm({folder,data,act,close}){
  const [name,setName]=useState(folder.name||''),[projectId,setProjectId]=useState(folder.projectId||''),[enabled,setEnabled]=useState(folder.enabled!==false),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  async function save(e){e.preventDefault();setSaving(true);setError('');try{await act('folderConfigure',{id:folder.id,name,projectId:projectId||null,enabled},'目录设置已保存');close();}catch(e){setError(e.message);}finally{setSaving(false);}}
  return <form className="folder-config-form" onSubmit={save} aria-label={`设置目录 ${folder.name}`}><header><strong>资料目录设置</strong><button className="icon-button" type="button" aria-label="关闭目录设置" onClick={close}><X size={16}/></button></header><label>目录名称<input required maxLength={100} aria-label="资料目录名称" value={name} onChange={e=>setName(e.target.value)}/></label><label>后续材料归属<select aria-label="资料目录归属项目" value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">独立材料</option>{data.projects.map(p=><option key={p.id} value={p.id} disabled={!!p.archivedAt}>{p.name}{p.archivedAt?'（已归档）':''}</option>)}</select></label><label className="connection-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>开启目录自动同步</label><small>保存后在下一次后台检查时读取；也可以点击“同步此目录”。本次设置不会给 Agent 增加文件写入或其他外部操作权限。</small>{error&&<p className="form-error">{error}</p>}<button className="button primary" disabled={saving||!!data.operation}>{saving?'保存中…':'保存目录设置'}</button></form>;
}
