import React, {useEffect, useState} from 'react';
import {PricingFields} from './SpendControls';
import {RequestPolicyFields} from './GenerationControls';
import catalog from '../desktop/model-catalog.json';

export const protocolLabel = type => catalog.protocols.find(p => p.id === type)?.label || 'OpenAI 兼容接口';
const defaults = {name:'',type:'codex',baseUrl:'',model:'',key:'',reasoning:'medium',jsonMode:true,inputPrice:'',outputPrice:'',authMode:'auto',maxOutputTokens:'',tokenParameter:'max_tokens',apiVersion:'',workspaceId:'',extraBody:'',requestPolicy:{idleMinutes:15,totalMinutes:0,retries:1}};
const groups = [...new Set(catalog.presets.map(p => p.group))];

export default function ProviderForm({provider,onClose,onSaved,act,Modal}) {
  const [form,setForm] = useState(() => ({...defaults,...provider,key:'',extraBody:provider?.extraBody && Object.keys(provider.extraBody).length ? JSON.stringify(provider.extraBody,null,2) : ''}));
  const [presetId,setPresetId] = useState(() => provider ? catalog.presets.find(p => p.type === provider.type && p.baseUrl === provider.baseUrl)?.id || '' : 'codex');
  const [status,setStatus] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false), [detecting,setDetecting] = useState(false);
  const [listing,setListing] = useState(false), [modelList,setModelList] = useState(null), [listError,setListError] = useState('');
  const selected = catalog.presets.find(p => p.id === presetId);
  const protocol = catalog.protocols.find(p => p.id === form.type);
  const resetList = () => { setModelList(null); setListError(''); };
  const set = (key,value) => {
    setForm(f => ({...f,[key]:value}));
    if (['baseUrl','key','authMode','apiVersion','workspaceId','clearKey'].includes(key)) resetList();
  };
  async function detect() {
    setDetecting(true);
    try {
      const result = await act('subscriptionStatus'); setStatus(result);
      if (result.model) setForm(f => f.type === 'codex' ? {...f,model:f.model || result.economical || result.model,name:f.name || 'ChatGPT 日常模型'} : f);
    } catch (e) { setError(e.message); } finally { setDetecting(false); }
  }
  useEffect(() => { if (form.type === 'codex') detect(); }, []);
  function choosePreset(id) {
    setPresetId(id); resetList(); setError('');
    const preset = catalog.presets.find(p => p.id === id);
    if (!preset) return;
    setForm(f => ({...defaults,id:f.id,requestPolicy:f.requestPolicy,name:preset.name,type:preset.type,baseUrl:preset.baseUrl,
      jsonMode:preset.jsonMode !== false,authMode:preset.authMode || 'auto',tokenParameter:preset.tokenParameter || 'max_tokens',
      inputPrice:preset.inputPrice ?? '',outputPrice:preset.outputPrice ?? '',clearKey:!!provider?.hasKey}));
    if (preset.type === 'codex') detect();
  }
  function chooseType(type) {
    const next = catalog.protocols.find(p => p.id === type);
    setPresetId(''); resetList(); setError('');
    setForm(f => ({...f,type,baseUrl:next.baseUrl,model:'',key:'',clearKey:!!provider?.hasKey,authMode:'auto',apiVersion:'',workspaceId:'',extraBody:'',maxOutputTokens:'',tokenParameter:'max_tokens'}));
    if (type === 'codex') detect();
  }
  async function listModels() {
    setListing(true); setListError(''); setModelList(null);
    try { setModelList(await act('listProviderModels',form)); }
    catch (e) { setListError(`${e.message}。仍可手动填写模型 ID。`); }
    finally { setListing(false); }
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { const result = await act('saveProvider',form,'模型配置已保存'); if (onSaved) await onSaved(result); else onClose(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <Modal title={provider ? '编辑模型配置' : '连接你的模型'} subtitle="连接云端服务或本地开源模型，供整理、推进和检查使用。" onClose={onClose}>
    <form onSubmit={save}>
      <div className="modal-body form-stack">
        <fieldset disabled={busy || listing} className="form-stack" style={{border:0,padding:0,margin:0,minWidth:0}}>
          <label>服务商预设<select aria-label="服务商预设" value={presetId} onChange={e => choosePreset(e.target.value)}>
            <option value="">自定义服务 / 网关</option>
            {groups.map(group => <optgroup key={group} label={group}>{catalog.presets.filter(p => p.group === group).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
          </select><small>DeepSeek、Kimi、千问、GLM 等可直连，也可通过聚合平台或本地服务接入。</small></label>
          <label>接口类型<select aria-label="接口类型" value={form.type} onChange={e => chooseType(e.target.value)}>{catalog.protocols.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select><small>{selected?.hint || protocol?.hint}</small></label>
          {form.type === 'codex' ? <div className="criteria-box"><div>
            <strong>{status?.message || '正在检测本机 Codex…'}</strong><p>{status?.version}</p>
            <p>复用本机 ChatGPT 登录，消耗订阅额度。没有登录时，在终端执行 codex login，然后重新检测。</p>
            <button type="button" className="button" disabled={detecting} onClick={detect}>{detecting ? '检测中…' : '重新检测登录'}</button>
          </div></div> : <>
            <label>服务地址<input aria-label="服务地址" required value={form.baseUrl} onChange={e => set('baseUrl',e.target.value)} placeholder={form.type === 'azure' ? 'https://你的资源.openai.azure.com/openai/v1' : protocol?.baseUrl || 'https://…/v1'}/></label>
            <label>API Key<input aria-label="API Key" type="password" autoComplete="new-password" value={form.key || ''} onChange={e => set('key',e.target.value)} placeholder={provider?.hasKey && !form.clearKey ? '已加密保存，留空保留' : '填写当前服务密钥；无鉴权的本地服务可留空'}/></label>
            {provider?.hasKey && <label className="check-label"><input type="checkbox" checked={!!form.clearKey} onChange={e => set('clearKey',e.target.checked)}/>清除已保存密钥（填写新密钥时会替换）</label>}
            <small>切换预设会重置模型和密钥；修改服务域名或端口后需重新填写密钥。</small>
          </>}
          <label>配置名称<input aria-label="配置名称" required value={form.name} onChange={e => set('name',e.target.value)} placeholder="例如：DeepSeek 日常模型"/></label>
          {form.type === 'codex' && status?.models?.length > 0 && <label>本机缓存的模型<select aria-label="本机可选模型" value={status.models.some(m => m.id === form.model) ? form.model : ''} onChange={e => {if(e.target.value)set('model',e.target.value);}}>
            <option value="">自定义模型 ID</option>{status.models.map(m => <option key={m.id} value={m.id}>{m.name}{m.id === status.economical ? ' · 日常经济选择' : ''}</option>)}
          </select><small>来自官方 CLI 缓存，实际可用性以测试连接为准。</small>{status.economical && <button type="button" className="button small" onClick={() => setForm(f => ({...f,model:status.economical,reasoning:'medium'}))}>使用日常经济模型</button>}</label>}
          {form.type !== 'codex' && <div className="form-stack">
            <button type="button" className="button" onClick={listModels} disabled={!form.baseUrl}>{listing ? '正在读取模型列表…' : '读取模型列表'}</button>
            {listError && <p className="form-error" role="alert">{listError}</p>}
            {modelList && <><label>服务返回的模型<select aria-label="服务返回的模型" value={modelList.models.some(m => m.id === form.model) ? form.model : ''} onChange={e => {if(e.target.value)set('model',e.target.value);}}>
              <option value="">选择一个模型或在下方手动填写</option>{modelList.models.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
            </select></label><small>已读取 {modelList.models.length} 个模型{modelList.truncated ? '（列表已截断，可手动填写其他 ID）' : ''}。请选择支持文本对话的模型；列表不保证账号拥有调用权限。</small></>}
          </div>}
          <label>{form.type === 'azure' ? '模型名称（部署名）' : '模型名称'}<input aria-label="模型名称" required value={form.model} onChange={e => set('model',e.target.value)} placeholder="填写此账号 / 本地服务可用的完整模型 ID"/><small>模型 ID 不设白名单，新模型和自部署模型均可手动填写。</small></label>
          {form.type === 'codex' ? <label>推理强度<select aria-label="推理强度" value={form.reasoning} onChange={e => set('reasoning',e.target.value)}>{['low','medium','high','xhigh'].map(r => <option key={r} value={r}>{r}</option>)}</select><small>新配置默认 medium；更高推理强度通常需要更长等待。</small></label> : <>
            <label className="check-label"><input type="checkbox" aria-label="请求 JSON 输出模式" checked={form.jsonMode} onChange={e => set('jsonMode',e.target.checked)}/>请求 JSON 输出模式</label>
            <small>{form.type === 'anthropic' ? 'Claude 兼容接口使用提示词请求 JSON。' : '若模型不支持原生 JSON 模式，可取消勾选。'}行知仍会校验工作协议需要的 JSON。</small>
            <details><summary>高级接口设置</summary><div className="form-stack" style={{paddingTop:12}}>
              <label>鉴权方式<select aria-label="鉴权方式" value={form.authMode} onChange={e => set('authMode',e.target.value)}>
                <option value="auto">按接口自动选择</option><option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key（Claude）</option><option value="x-goog-api-key">x-goog-api-key（Gemini）</option><option value="api-key">api-key（Azure）</option><option value="none">无需鉴权</option>
              </select></label>
              <label>最大输出 token<input aria-label="最大输出 token" type="number" min="16" max="1000000" step="1" value={form.maxOutputTokens ?? ''} onChange={e => set('maxOutputTokens',e.target.value)} placeholder={form.type === 'anthropic' ? '默认 8192' : '留空使用服务商默认值'}/><small>包含部分模型的推理消耗，不能超过模型上限。被截断的结果不会作为完整产出。</small></label>
              {['openai','azure'].includes(form.type) && <label>输出上限参数<select aria-label="输出上限参数" value={form.tokenParameter} onChange={e => set('tokenParameter',e.target.value)}><option value="max_tokens">max_tokens（多数兼容服务）</option><option value="max_completion_tokens">max_completion_tokens（部分推理模型）</option></select></label>}
              {['anthropic','azure'].includes(form.type) && <label>API 版本<input aria-label="API 版本" value={form.apiVersion} onChange={e => set('apiVersion',e.target.value)} placeholder={form.type === 'anthropic' ? '默认 2023-06-01' : '旧版必填；/openai/v1 可留空'}/></label>}
              {form.type === 'anthropic' && <label>Claude 工作空间 ID<input aria-label="Claude 工作空间 ID" value={form.workspaceId} onChange={e => set('workspaceId',e.target.value)} placeholder="仅跨工作空间密钥需要填写"/></label>}
              <label>高级生成参数（JSON）<textarea aria-label="高级生成参数" rows="4" value={form.extraBody} onChange={e => set('extraBody',e.target.value)} placeholder={'{\n  "temperature": 0.7\n}'}/><small>{form.type === 'gemini' ? '参数写入 generationConfig，例如 thinkingConfig。' : form.type === 'ollama' ? '参数写入 options，例如 num_ctx、temperature。' : '参数写入请求体，例如 thinking、reasoning_effort 或 enable_thinking；仅填写该模型支持的参数。'}不要填写密钥；不能覆盖模型、消息、工具或输出格式。</small></label>
            </div></details>
          </>}
          <PricingFields form={form} set={set}/>
          <RequestPolicyFields value={form.requestPolicy} onChange={value => set('requestPolicy',value)}/>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy || listing}>{busy ? '保存中…' : '保存模型'}</button></div>
    </form>
  </Modal>;
}
