import React,{useEffect,useRef,useState} from 'react';
import './model-fallback.css';
const roles=['organize','execute','verify'],names={organize:'信息整理',execute:'事项推进',verify:'结果检查'};
export default function ModelFallback({data,act}){
 const [snapshot,setSnapshot]=useState(null),[live,setLive]=useState(null),[form,setForm]=useState(null),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const api=useRef(act);api.current=act;const loaded=useRef(false);
 const update=value=>{setSnapshot(value);setLive(value);setForm(value.roles);setConsent(false);loaded.current=true;};
 const incoming=JSON.stringify([data.modelFallback,data.providers,data.settings.roles,data.modelCalls?.[0]?.id]);
 useEffect(()=>{let active=true;api.current('modelFallbackSnapshot').then(value=>{if(active){if(!loaded.current)update(value);else setLive(value);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[incoming]);
 async function perform(action){setBusy(true);setError('');setNotice('');try{const value=await act(action,action==='modelFallbackSave'?{revision:snapshot.revision,roles:form}:{});update(value);if(action==='modelFallbackSave')setNotice('备用模型配置已保存');}catch(e){setError(e.message);try{setLive(await api.current('modelFallbackSnapshot'));}catch{}}finally{setBusy(false);}}
 if(!snapshot||!form)return <p role="status">{error||'读取备用模型配置…'}</p>;
 const current=live||snapshot,stale=current.revision!==snapshot.revision,blocked=busy||!!data.operation,enabled=roles.some(role=>form[role].enabled);
 const change=(role,key,value)=>{setForm(f=>({...f,[role]:{...f[role],[key]:value}}));setConsent(false);setNotice('');};
 const providerName=id=>current.providers.find(p=>p.id===id)?.name||'未设置';
 return <section className="model-fallback" aria-label="角色备用模型"><h3>角色备用模型</h3>
  <p>主模型发生网络故障、请求超时或临时服务错误时，将同一次推理请求交给你选定的备用模型，最多接续一次。三个角色默认关闭。</p>
  <p className="muted">备用模型会收到同一份材料与上下文，并单独计入工作空间、规则和委托的调用额度。拒绝、额度耗尽、认证错误、无效结果、取消和本地保存失败均停止接续。连接测试只检查所选模型。</p>
  {stale&&<p className="form-error" role="status">模型或角色配置已变化，旧备用授权已失效。请刷新配置后重新选择并保存。</p>}
  {roles.some(role=>current.roles[role].needsSave)&&!stale&&<p className="form-error" role="status">模型配置变更或数据恢复后，备用接续已关闭；请核对模型后重新保存授权。</p>}
  {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <div className="fallback-roles">{roles.map(role=><div key={role} className="fallback-role"><strong>{names[role]}</strong><small>主模型：{providerName(current.roles[role].primaryId)}</small><label>备用模型<select aria-label={`${names[role]}备用模型`} value={form[role].providerId} disabled={blocked||stale} onChange={e=>change(role,'providerId',e.target.value)}><option value="">请选择备用模型</option>{current.providers.map(p=><option key={p.id} value={p.id} disabled={p.id===current.roles[role].primaryId}>{p.name} · {p.model}{p.id===current.roles[role].primaryId?'（当前主模型）':''}</option>)}</select></label><label className="fallback-toggle"><input type="checkbox" aria-label={`启用${names[role]}备用接续`} checked={form[role].enabled} disabled={blocked||stale} onChange={e=>change(role,'enabled',e.target.checked)}/>启用本角色备用接续</label></div>)}</div>
  {enabled&&<label className="fallback-consent"><input type="checkbox" aria-label="同意向备用模型发送同一上下文" checked={consent} disabled={blocked||stale} onChange={e=>setConsent(e.target.checked)}/>我同意在上述临时故障后，将同一上下文发送给所选备用模型，并单独计量每次尝试。</label>}
  <div className="fallback-buttons"><button className="button primary" disabled={blocked||stale||(enabled&&!consent)} onClick={()=>perform('modelFallbackSave')}>保存备用模型配置</button><button className="button" disabled={blocked} onClick={()=>perform('modelFallbackSnapshot')}>刷新备用模型配置</button></div>
  <details><summary>最近备用调用（{current.calls.length}）</summary>{!current.calls.length?<p className="muted">尚无备用模型调用。</p>:current.calls.map(row=><div className="fallback-call" key={row.id}><span>{names[row.role]} · {providerName(row.fallbackFrom)} → {providerName(row.providerId)}</span><small>{new Date(row.at).toLocaleString('zh-CN')} · 第 2 次尝试 · {row.status==='done'?'已返回':row.status==='running'?'请求中':row.status==='stopped'?'已停止':'失败'}{row.errorCode?` · ${row.errorCode}`:''}</small></div>)}</details>
 </section>;
}
