import React, {useEffect, useRef, useState} from 'react';

export default function ModelRouting({data, act}) {
  const [form, setForm] = useState(null), [live, setLive] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const api = useRef(act); api.current = act;
  const incoming = JSON.stringify([data.modelRouting, data.providers, data.settings.roles]);
  useEffect(() => {
    let active = true;
    api.current('modelRoutingSnapshot').then(value => {if (active) {setLive(value); setForm(old => old || value);}}).catch(e => {if (active) setError(e.message);});
    return () => {active = false;};
  }, [incoming]);
  async function perform(save) {
    setBusy(true); setError(''); setNotice('');
    try {const value = await act(save ? 'modelRoutingSave' : 'modelRoutingSnapshot', save ? form : {}); setForm(value); setLive(value); if (save) setNotice(value.enabled ? '自动选模已启用' : '已恢复固定角色模型');}
    catch (e) {setError(e.message);}
    finally {setBusy(false);}
  }
  if (!form || !live) return <p role="status">{error || '读取自动选模配置…'}</p>;
  const stale = form.revision !== live.revision, blocked = busy || !!data.operation;
  const change = (key, value) => {setForm({...form, [key]: value}); setNotice('');};
  return <section className="settings-card" aria-label="自动选择模型">
    <header><div><h2>自动选择模型</h2><p>日常工作优先节省额度，复杂分析使用你指定的模型。</p></div></header>
    <label className="check-label"><input type="checkbox" aria-label="启用自动选模" checked={form.enabled} disabled={blocked || stale} onChange={e => change('enabled', e.target.checked)}/>根据当前工作自动选择模型</label>
    <div className="form-row">{[['economyId', '日常模型'], ['analysisId', '分析模型']].map(([key, label]) => <label key={key}>{label}<select aria-label={`自动选模${label}`} value={form[key]} disabled={blocked || stale} onChange={e => change(key, e.target.value)}><option value="">请选择已保存的模型</option>{live.providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>)}</div>
    <p className="help-text">选择下一步工具、提取事项、精简已有内容与日常跟进优先使用日常模型；实际血缘分析、根因分析、多来源对比及复杂结果检查使用分析模型。先看本次调用和当前步骤，再判断整体目标；内容长或请求超时不会自动升级。运行详情展示每次选模原因，事项详情中可单独指定。</p>
    <p className="help-text">自动选择和指定档位时，上下文只会发给这里选定的两项配置，并遵守现有调用额度。不会自行添加更昂贵的模型，故障接续也限于这两项配置。关闭自动选模或将事项设为「固定使用角色模型」时，使用上方角色模型及其备用配置。请按服务商实际价格选择两档模型，应用不自动推断费用。</p>
    {form.enabled && form.economyId && form.economyId === form.analysisId && <p role="status">两档使用同一配置，因此实际不会切换模型。</p>}
    {(stale || live.needsSave) && <p className="form-error" role="status">模型配置有变化或已恢复备份，自动选模已停用。请刷新并核对后保存。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="fallback-buttons"><button className="button primary" disabled={blocked || stale || (form.enabled && (!form.economyId || !form.analysisId))} onClick={() => perform(true)}>保存自动选模</button><button className="button" disabled={blocked} onClick={() => perform(false)}>刷新自动选模</button></div>
  </section>;
}

export function TaskModelPreference({task, data, act}) {
  const [error, setError] = useState('');
  useEffect(() => setError(''), [task.id]);
  return <section className="detail-section"><h3>模型选择</h3>
    <label>此事项的模型策略<select aria-label="事项模型策略" value={task.modelPreference || 'auto'} disabled={!!data.operation || task.status === 'completed'} onChange={async e => {setError(''); try {await act('updateTask', {id: task.id, modelPreference: e.target.value});} catch (e) {setError(e.message);}}}>
      <option value="auto">自动：根据当前步骤选择</option><option value="economy">指定日常模型</option><option value="analysis">指定分析模型</option><option value="fixed">固定使用角色模型</option>
    </select></label><p className="help-text">{data.modelRouting?.enabled ? '后续生成与检查使用此策略，已完成的产出保留。' : '请先在「模型与设置 → 自动选择模型」中启用；当前使用固定角色模型。'}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
