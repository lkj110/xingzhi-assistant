import {LazyDetails,PagedList} from './RenderBounds';
import {workBusy} from './execution-state';
import React,{useEffect,useState} from 'react';
import {usageSummary,runUsageSummary,callUsage} from './run-usage.mjs';
const num=n=>(n||0).toLocaleString('zh-CN');
const usd=n=>`$${(n||0).toFixed(4)}`;
const roles={organize:'规划',execute:'执行',verify:'检查'};
export const runModelNames=run=>[...new Set((run.modelCallsDetail||[]).map(c=>c.model).filter(Boolean))].join('、');
export function RunUsageSummary({run}){return <span className="run-usage-summary">{runUsageSummary(run)}</span>;}

export function RunModels({run}){
  const calls=run.modelCallsDetail||[],groups=new Map();
  for(const c of calls){const key=JSON.stringify([c.providerId,c.model,c.reasoning]);if(!groups.has(key))groups.set(key,{...c,roles:new Set(),calls:0,retries:0,fallbacks:0,errors:0,running:0});const g=groups.get(key);g.roles.add(roles[c.role]||c.role||'执行');g.calls++;g.retries+=c.attempt>1&&!c.fallbackFrom?1:0;g.fallbacks+=c.fallbackFrom?1:0;g.errors+=['error','stopped','interrupted'].includes(c.status)?1:0;g.running+=c.status==='running'?1:0;}
  return <section aria-label="本轮使用模型"><strong>使用模型</strong>{groups.size?[...groups].map(([key,g])=><p className="help-text" key={key}><strong>{g.model||'模型名称未记录'}</strong>{g.providerName&&` · ${g.providerName}`}{g.reasoning&&` · 推理强度 ${g.reasoning}`} · {[...g.roles].join('、')} · {g.calls} 次调用{g.retries>0&&`（含 ${g.retries} 次重试）`}{g.fallbacks>0&&` · ${g.fallbacks} 次备用调用`}{g.errors>0&&` · ${g.errors} 次失败或中断`}{g.running>0&&` · ${g.running} 次进行中`}</p>):<p className="help-text">{run.modelUsageSource==='legacy'||!Array.isArray(run.modelCallsDetail)?'旧记录未保存使用模型。':'本轮尚未调用模型。'}</p>}{run.modelUsageSource==='legacy'&&calls.length>0&&<p className="help-text">根据可核对的历史调用恢复，已裁剪记录可能缺失。{Number.isFinite(run.modelCalls)&&run.modelCalls>calls.length?`原记录 ${run.modelCalls} 次，已找回 ${calls.length} 次。`:''}</p>}{calls.length>0&&<LazyDetails className="run-call-details" summary={<> 逐次调用：模型、选模原因与费用（{calls.length} 次）</>}>{()=><><PagedList items={calls} label="模型调用分页">{(c,i)=><div className="run-call" key={c.id||i}><strong>{i+1}. {c.model||'模型名称未记录'} · {c.stage==='json_repair'?'输出格式修复':c.stage==='planner'?'选择下一步工具':roles[c.role]||'执行'}{c.fallbackFrom?' · 备用模型':''}</strong><p className="help-text">{c.routing?.reason||'历史记录未保存选模原因'}{c.fallbackFrom?'；实际使用已配置的故障接续模型':''}</p><p className="help-text">{c.errorMessage}{c.errorCode?` · ${c.errorCode}`:""}{c.diagnostic?.fingerprint?` · 诊断编号 ${c.diagnostic.fingerprint}`:""}</p><UsageLine usage={callUsage(c)} pending={c.status==='running'}/>{c.pricing&&<p className="help-text">记录的基础单价（美元 / 百万 token）：输入 {c.pricing.input} · 缓存 {c.pricing.cached??c.pricing.input} · 输出 {c.pricing.output}{c.pricing.asOf?` · 参考日期 ${c.pricing.asOf}`:''}{c.pricing.longContext&&c.inputTokens>272000?' · 本次超过 272K 输入：输入及缓存 ×2，输出 ×1.5':''}{c.cacheWriteTokens>0?` · 缓存写入：短期 ×1.25${c.cacheWrite1hTokens>0?'，1 小时 ×2':''}`:''}</p>}</div>}</PagedList></>}</LazyDetails>}</section>;
}

export function UsageLine({usage,legacy=false,pending=false}){
  if(!usage)return <p className="help-text">{legacy?'旧记录未保存本轮用量。':'本轮尚无用量报告。'}</p>;
  return <p className="help-text">{(usage.reportedCalls??0)>0&&<>输入 {num(usage.inputTokens)}（其中缓存 {num(usage.cachedInputTokens)}） · 输出 {num(usage.outputTokens)} · </>}{usageSummary(usage,{pending})}</p>;
}

export function SpendControls({data,scopeKey,act,showRuns=[],requestConfirmation=0}){
  const busy=workBusy(data,scopeKey.startsWith('job:')?{jobId:scopeKey.slice(4)}:{taskId:scopeKey.slice(5)});
  const s=data.spendStatus?.scopes?.find(s=>s.key===scopeKey);
  const [confirm,setConfirm]=useState(false),[ack,setAck]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setConfirm(false);setAck(false);setError('');},[s?.id,s?.revision]);
  useEffect(()=>{if(requestConfirmation&&s&&!data.spendStatus?.error)setConfirm(s.unsettledCalls>0&&s.remainingUSD>0?'ack':s.blocked?.kind==='budget'?'add':false);},[requestConfirmation]);
  async function approve(){setSaving(true);setError('');try{await act('approveSpend',{id:s.id,revision:s.revision,confirmed:true,additionalUSD:confirm==='ack'?0:100,acknowledgeUnknown:ack},confirm==='ack'?'已确认未知用量，保留原额度上限':'已追加 $100 等值额度');setConfirm(false);}catch(e){setError(e.message);}finally{setSaving(false);}}
  return <section className="spend-controls" aria-label="推进用量与额度"><h3>推进用量与额度</h3>
    <p>本次全过程：<strong>{usd((s?.spentUSD||0)+(s?.heldUSD||0))} / ${(s?.limitUSD||100).toFixed(2)}</strong> · 剩余 {usd(s?.remainingUSD??100)}</p>
    <UsageLine usage={s?.usage}/>
    {!!s?.heldUSD&&<p className="help-text">含 {usd(s.heldUSD)} 预留额度（请求进行中，或未返回完整用量）。预留值不是实测费用。</p>}
    <p className="help-text">同一委托及其事项共享额度；独立事项单独累计。分段、自动续跑、重试、检查、重启和恢复备份都不重置。订阅按参考单价折算，不代表实际扣费或剩余订阅额度。</p>
    <p className="help-text">每次请求前预留，返回后结算。未返回用量时保留预留，在原额度内继续，不重复要求确认。已知费用加预留（含下一次请求）将超过上限时，才需追加额度。预留不是实测费用，单次实际用量仍可能高于预估。</p>
    {data.spendStatus?.error&&<p className="form-error" role="alert">{data.spendStatus.error}</p>}
    {s?.legacy&&<p className="help-text">含升级前的历史调用回算；历史价格、未返回用量或已裁剪记录可能不完整。</p>}
    {s?.blocked&&<p className="form-error" role="alert">{s.blocked.message}</p>}
    {s&&!data.spendStatus?.error&&s.blocked?.kind!=='pricing'&&<button className="button" disabled={busy||saving} onClick={()=>setConfirm(confirm==='add'?false:'add')}>追加 $100 等值额度…</button>}
    {s?.unsettledCalls>0&&s.remainingUSD>0&&!data.spendStatus?.error&&<button className="button" disabled={busy||saving} onClick={()=>setConfirm(confirm==='ack'?false:'ack')}>核对缺少预留的历史用量…</button>}
    {confirm&&<div className="criteria-box"><p>{confirm==='ack'?`确认已核对未知消耗，并保留 $${s.limitUSD.toFixed(2)} 上限继续？`:`确认将本次推进上限从 $${s.limitUSD.toFixed(2)} 提高到 $${(s.limitUSD+100).toFixed(2)}？`}已使用和预留额度将保留。因额度停下的委托会继续；其他暂停和问题仍保留。</p>{s.unsettledCalls>0&&<label className="check-label"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>我已知悉 {s.unsettledCalls} 次调用用量或价格不完整，实际消耗可能高于已报告值</label>}<div className="agent-actions"><button className="button" onClick={()=>setConfirm(false)} disabled={saving}>取消</button><button className="button primary" disabled={busy||saving||(s.unsettledCalls>0&&!ack)} onClick={approve}>{confirm==='ack'?'确认未知用量，保留原上限':'确认追加 $100'}</button></div></div>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {showRuns.length>0&&<LazyDetails summary={<> 每次事项推进的模型与消耗</>}>{()=><><PagedList items={showRuns} label="事项推进记录分页">{r=><div key={r.id}><strong>{new Date(r.startedAt).toLocaleString('zh-CN')} · {r.finishedAt?'已结束':'进行中'}</strong><RunUsageSummary run={r}/><RunModels run={r}/><UsageLine usage={r.usage}/></div>}</PagedList></>}</LazyDetails>}
  </section>;
}

export function PricingFields({form,set}){
  return <fieldset className="form-stack"><legend>费用折算单价</legend><small>美元 / 百万 token。订阅和官方接口的已知模型留空使用内置 Standard 参考价；其他接口必须填写。缓存单价留空按普通输入价保守计算。本地 Ollama 默认 $0。</small><div className="form-row">{[['inputPrice','输入单价'],['cachedInputPrice','缓存输入单价'],['outputPrice','输出单价']].map(([key,label])=><label key={key}>{label}<input aria-label={label} type="number" min="0" step="any" value={form[key]??''} onChange={e=>set(key,e.target.value)}/></label>)}</div><label className="check-label"><input type="checkbox" checked={!!form.longContextPricing} onChange={e=>set('longContextPricing',e.target.checked)}/>自定义价格：超过 272K 输入时，输入及缓存单价 ×2，输出 ×1.5</label><small>内置参考价已包含对应模型的长上下文规则；自定义价请按服务商的速度档位与地区费率填写。已结算的历史调用保留当时价格。</small></fieldset>;
}
