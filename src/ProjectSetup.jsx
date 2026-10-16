import {CapabilityPicker} from './CapabilitiesPage';
import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,Check,FolderOpen,RefreshCw,X} from 'lucide-react';
import {desktop} from './api';
import './project-setup.css';

const stages=['工作目标','材料来源','检查与启动'];
const defaults={criteria:'',keyword:'',larkText:'',capabilityIds:[],name:'',goal:'',background:'',text:'',feedText:'',pageText:'',folderIds:[],intervalMinutes:15,enabled:false,useOutputFolder:false,fileMode:'off',autoAccept:false};
const lines=text=>text.split('\n').map(v=>v.trim()).filter(Boolean);
export default function ProjectSetup({data,act,close,saved}){
 const [form,setForm]=useState(defaults),[step,setStep]=useState(0),[preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const dialog=useRef(),requestId=useRef(crypto.randomUUID()),pending=busy||!!data.operation;
 const hasModels=['organize','execute','verify'].every(role=>data.providers.some(p=>p.id===data.settings.roles[role]));
 const folders=data.folders.filter(f=>!f.projectId);
 const change=(key,value)=>{setForm(f=>({...f,[key]:value}));setPreview(null);setError('');requestId.current=crypto.randomUUID();};
 const payload=()=>{const {feedText,pageText,larkText,...values}=form;return {...values,larkSources:lines(larkText),feedUrls:lines(feedText),pageUrls:lines(pageText)};};
 useEffect(()=>{const prior=document.activeElement;return()=>prior?.focus();},[]);
 function keydown(e){if(e.key==='Escape'&&!busy)close();if(e.key==='Tab'){const nodes=[...dialog.current.querySelectorAll('input,textarea,select,button')].filter(n=>!n.disabled&&n.offsetParent!==null);if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0]?.focus();}}}
 async function inspect(){setBusy(true);setError('');try{setPreview(await act('projectSetupPreview',payload()));}catch(e){setError(e.message);setPreview(null);}finally{setBusy(false);}}
 async function create(){if(!preview||pending)return;setBusy(true);setError('');try{const result=await act('projectSetupCreate',{...payload(),revision:preview.revision,requestId:requestId.current});await act('state');saved(result.projectId);close();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function chooseFolder(){setBusy(true);setError('');try{const before=new Set(data.folders.map(f=>f.id));const state=await act('chooseFolder',{configureFirst:true});const added=state.folders.find(f=>!before.has(f.id)&&!f.projectId);if(added)change('folderIds',[...form.folderIds,added.id]);}catch(e){setError(e.message);}finally{setBusy(false);}}
 function next(){setError('');if(step===0&&(!form.name.trim()||!form.goal.trim())){setError('请填写项目名称和工作目标');return;}if(step===1&&(lines(form.feedText).length>3||lines(form.pageText).length>3||lines(form.larkText).length>3||form.folderIds.length>3)){setError('最多选择 3 个 RSS、3 个网页和 3 个目录');return;}setStep(step+1);}
 const summary=preview?.summary;
 return <div className="modal-backdrop"><section ref={dialog} onKeyDown={keydown} className="modal wide project-setup-modal" role="dialog" aria-modal="true" aria-label="新建托管项目">
  <header className="modal-header"><div><h2>新建托管项目</h2><p>确定目标和资料入口，让助手在材料变化后持续推进。</p></div><button className="icon-button" disabled={busy} aria-label="关闭托管设置" onClick={close}><X size={18}/></button></header>
  <ol className="setup-stages" aria-label="托管设置步骤">{stages.map((name,index)=><li key={name} className={index===step?'current':index<step?'finished':''} aria-current={index===step?'step':undefined}><span>{index<step?<Check size={14}/>:index+1}</span>{name}</li>)}</ol>
  <div className="modal-body form-stack">
   {step===0&&<>
    <label>项目名称<input autoFocus aria-label="托管项目名称" maxLength={100} value={form.name} disabled={pending} onChange={e=>change('name',e.target.value)} placeholder="例如：产品发布资料跟进"/></label>
    <label>希望助手完成什么<textarea aria-label="托管工作目标" maxLength={10000} rows={4} disabled={pending} value={form.goal} onChange={e=>change('goal',e.target.value)} placeholder="资料更新时，整理行动项和风险，推进可完成的工作，生成有来源依据的报告。"/></label>
    <label>预期结果与验收标准<textarea aria-label="托管预期结果" maxLength={2000} rows={3} value={form.criteria} disabled={pending} onChange={e=>change('criteria',e.target.value)} placeholder="例如：生成一页重点摘要，列出需要我决策的点；有变化时更新同一份成果。"/></label><label>长期背景与约束（可选）<textarea aria-label="托管项目背景" maxLength={10000} rows={2} disabled={pending} value={form.background} onChange={e=>change('background',e.target.value)} placeholder="已确定的事实、交付要求和偏好"/></label>
    <label>先放入一份材料（可选）<textarea aria-label="托管初始材料" maxLength={200000} rows={4} disabled={pending} value={form.text} onChange={e=>change('text',e.target.value)} placeholder="粘贴需求或会议纪要；创建后也可继续导入文件和扫描 PDF。"/></label>
   </>}
   {step===1&&<>
    <p className="help-text">来源更新后进入这个项目，由同一条规则检查并推进。没有订阅时，也可以持续手动补充材料。</p>
    <label>飞书文档或会话<textarea aria-label="托管飞书来源" rows={2} value={form.larkText} disabled={pending} onChange={e=>change('larkText',e.target.value)} placeholder="每行一个文档地址或 oc_ 会话 ID，最多 3 个"/><small>使用本机已登录的 lark-cli；仅读取指定来源。可在信息连接检测登录。</small></label><label>RSS / Atom 订阅<textarea aria-label="托管 RSS 订阅" rows={3} value={form.feedText} disabled={pending} onChange={e=>change('feedText',e.target.value)} placeholder="每行一个公开订阅地址，最多 3 个"/></label>
    <label>公开网页<textarea aria-label="托管网页订阅" rows={3} value={form.pageText} disabled={pending} onChange={e=>change('pageText',e.target.value)} placeholder="每行一个要持续检查的页面，最多 3 个"/></label>
    <fieldset className="setup-folders"><legend>已授权的资料目录</legend>{folders.map(folder=><label className="check-label" key={folder.id}><input type="checkbox" disabled={pending||!form.folderIds.includes(folder.id)&&form.folderIds.length>=3} checked={form.folderIds.includes(folder.id)} onChange={e=>change('folderIds',e.target.checked?[...form.folderIds,folder.id]:form.folderIds.filter(id=>id!==folder.id))}/><span>{folder.name}</span></label>)}{!folders.length&&<p className="muted">尚无未归属项目的授权目录。</p>}{desktop&&<button type="button" className="button" disabled={pending||form.folderIds.length>=3} onClick={chooseFolder}><FolderOpen size={15}/>选择资料目录</button>}<small>已属于其他项目的目录继续留在原项目。新增目录先保存为暂停；取消向导后也可在信息连接中查看或取消授权。</small></fieldset>
   </>}
   {step===2&&<><label>只处理包含关键词的材料（可选）<input aria-label="托管触发关键词" maxLength={200} value={form.keyword} disabled={pending} onChange={e=>change('keyword',e.target.value)} placeholder="留空处理这个项目的全部新材料"/></label><CapabilityPicker data={data} value={form.capabilityIds} disabled={pending} onChange={value=>change('capabilityIds',value)}/>
    <div className="form-row"><label>检查间隔<select aria-label="托管检查间隔" value={form.intervalMinutes} disabled={pending} onChange={e=>change('intervalMinutes',Number(e.target.value))}>{[5,15,30,60,120,1440].map(n=><option key={n} value={n}>{n===1440?'每天':`${n} 分钟`}</option>)}</select></label></div>
    <label>成果文件<select aria-label="托管文件保存方式" disabled={pending} value={form.useOutputFolder?form.fileMode:'off'} onChange={e=>{change('useOutputFolder',e.target.value!=='off');change('fileMode',e.target.value);}}><option value="off">保存在 App 工作产出中</option><option value="ask" disabled={!data.agentSettings.outputFolder}>写入已授权产出目录，每次确认</option><option value="auto" disabled={!data.agentSettings.outputFolder}>自动写入已授权产出目录</option></select><small>{data.agentSettings.outputFolder?`产出目录：${data.agentSettings.outputFolder}`:'可先创建项目，之后在工具与连接选择产出目录。'}</small></label>
    <label className="check-label"><input type="checkbox" aria-label="托管自动验收" checked={form.autoAccept} disabled={pending} onChange={e=>change('autoAccept',e.target.checked)}/>结果检查通过后自动验收事项</label>
    <label className="check-label"><input type="checkbox" aria-label="创建后启用托管" checked={form.enabled} disabled={pending||!hasModels} onChange={e=>change('enabled',e.target.checked)}/>创建后启用资料收集和推进规则</label>
    <p className="help-text">启用后按全局工作时段、暂停状态和调用额度运行。第一次也处理已有材料；缺少信息、需要确认或结果不明时会停下来等待处理。</p>
    {!hasModels&&<p className="help-text">三个角色的模型尚未配置完整。可以先创建为暂停，配置后分别启用信息连接和工作规则。</p>}
    <div className="setup-preview"><button type="button" className="button" disabled={pending} onClick={inspect}><RefreshCw size={15}/>检查配置并预览</button>{summary&&<section aria-label="托管配置预览"><h3>{summary.project.name}</h3><p className="setup-goal">{summary.project.goal}</p><dl><div><dt>初始材料</dt><dd>{summary.initialMaterial?`${summary.initialMaterial.characters} 字符`:'创建后补充'}</dd></div><div><dt>资料入口</dt><dd>{summary.connectors?.length||0} 个飞书来源 · {summary.feeds.length} 个 RSS · {summary.pages.length} 个网页 · {summary.folders.length} 个目录</dd></div><div><dt>推进安排</dt><dd>每 {summary.rule.intervalMinutes} 分钟检查 · 每次推进默认 $100 等值费用上限</dd></div><div><dt>成果保存</dt><dd>{summary.permissions.useOutputFolder?`${summary.permissions.outputFolderName} · ${summary.permissions.fileMode==='auto'?'自动写入':'每次确认'}`:'App 工作产出'}</dd></div><div><dt>初始状态</dt><dd>{summary.rule.enabled?'已启用，按托管条件运行':'资料入口和推进规则均暂停'}</dd></div></dl>{[...(summary.connectors||[]),...summary.feeds,...summary.pages,...summary.folders].length>0&&<ul>{[...(summary.connectors||[]),...summary.feeds,...summary.pages,...summary.folders].map((row,i)=><li key={i}>{row.url||row.target||row.name}</li>)}</ul>}<p>预期结果：{summary.criteria||'按工作目标检查'} · 关键词：{summary.keyword||'全部新材料'}</p><p>扩展能力：{summary.capabilities?.map(c=>c.name).join('、')||'未选择'}</p><p className="help-text">{summary.automatic.message}</p>{summary.warnings.map(w=><p className="help-text" key={w}>{w}</p>)}<small>配置检查未访问订阅、读取目录或调用模型。</small></section>}</div>
   </>}
   {error&&<p className="form-error" role="alert">{error}</p>}
  </div><footer className="modal-footer"><button type="button" className="button" disabled={pending||step===0} onClick={()=>setStep(step-1)}><ArrowLeft size={15}/>上一步</button>{step<2?<button type="button" className="button primary" disabled={pending} onClick={next}>下一步<ArrowRight size={15}/></button>:<button type="button" className="button primary" disabled={pending||!preview} onClick={create}>{busy?'正在处理…':error&&preview?'重试创建':form.enabled?'创建并启用托管':'创建为暂停'}</button>}</footer>
 </section></div>;
}
