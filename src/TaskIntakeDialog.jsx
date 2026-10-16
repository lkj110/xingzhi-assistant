import {IntakeCapabilities} from './CapabilitiesPage';
import React, {useRef, useState} from 'react';

export default function TaskIntakeDialog({data, act, Modal, ManualForm, ProviderForm, onClose, onCreated}) {
  const [text, setText] = useState(''), [mode, setMode] = useState('compose');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [capabilityIds,setCapabilityIds]=useState([]);
  const requestId = useRef(crypto.randomUUID());
  const roles = ['organize', 'execute', 'verify'];
  const ready = roles.every(role => data.providers.some(p => p.id === data.settings.roles[role]));
  const [providerId, setProviderId] = useState(data.providers[0]?.id || '');

  async function create() {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const state = await act('taskIntake', {text, capabilityIds, requestId: requestId.current}, '原文已保存，Agent 将自动整理并推进');
      onCreated(state.captureQueue.find(row => row.intakeRequestId === requestId.current));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function useExisting() {
    setError(''); setBusy(true);
    try {
      const missing = Object.fromEntries(roles.filter(role => !data.providers.some(p => p.id === data.settings.roles[role])).map(role => [role, providerId]));
      await act('settings', {roles: missing}, '已连接 Agent 模型');
      setMode('compose');
      if (text.trim()) await create();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (mode === 'configure') return <ProviderForm act={act} onClose={() => setMode('compose')} onSaved={async () => {setMode('compose'); if (text.trim()) await create();}}/>;
  if (mode === 'manual') return <ManualForm initialDescription={text} act={act} onClose={onClose}/>;
  return <Modal title="新建事项" subtitle="贴一段话，Agent 会整理信息、制定计划并开始推进。" onClose={onClose}>
    <form onSubmit={e => {e.preventDefault(); if (ready) create(); else setMode('configure');}}>
      <div className="modal-body form-stack">
        <label>你想推进什么？<textarea aria-label="事项原文" autoFocus rows={7} maxLength={200000} disabled={busy} value={text} onChange={e => {setText(e.target.value); requestId.current = crypto.randomUUID(); setError('');}} placeholder="粘贴聊天记录、会议内容或直接说你的需求。例如：下周要交接项目，请根据这段记录整理负责人、当前进度和待解决问题，输出一页交接说明。"/></label>
        <p className="help-text">标题、背景、目标和执行步骤由 Agent 自动填写。你可以随时补充要求，最终成果由你验收。</p>
        <IntakeCapabilities data={data} value={capabilityIds} disabled={busy} onChange={ids=>{setCapabilityIds(ids);requestId.current=crypto.randomUUID();setError('');}}/>
        {!ready && <section className="criteria-box" aria-label="连接 Agent 提醒"><div><strong>先连接一个模型，Agent 才能替你整理和推进</strong><p>支持当前 Codex 订阅、API 和本地模型。配置时会保留这段内容。</p>
          {!!data.providers.length && <><label>使用已有模型<select aria-label="事项推进模型" value={providerId} onChange={e => setProviderId(e.target.value)}>{data.providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label><button type="button" className="button" disabled={busy || !providerId} onClick={useExisting}>补齐缺少的模型角色</button></>}
          <button type="button" className="text-button" disabled={busy} onClick={() => setMode('configure')}>连接模型</button><button type="button" className="text-button" disabled={busy} onClick={() => setMode('manual')}>暂不配置，手动创建</button>
        </div></section>}
        {data.stewardshipStatus?.automaticAllowed === false && <p className="help-text">{data.stewardshipStatus.message}。本次内容会先保存，恢复允许推进后自动处理。</p>}
        {data.operation && <p className="help-text">助手正在处理其他事项，本次内容会自动排队。</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !text.trim()}>{busy ? '正在记录…' : ready ? '创建并交给 Agent' : '连接模型并继续'}</button></div>
    </form>
  </Modal>;
}
