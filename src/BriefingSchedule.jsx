import React,{useEffect,useRef,useState} from 'react';
import {Clock3,FolderOpen,RefreshCw} from 'lucide-react';
import {desktop} from './api';
import './briefing-schedule.css';
const when=v=>v?new Date(v).toLocaleString('zh-CN'):'尚未安排';
const labels={done:'已保存并核对',failed:'保存失败',interrupted:'上次保存中断',abandoned:'已放弃重试',running:'正在保存'};
export default function BriefingSchedule({data,act}){
  const [state,setState]=useState(null),[live,setLive]=useState(data.briefingSchedule||null),[form,setForm]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const ref=useRef(act);ref.current=act;
  const update=result=>{setState(result);setLive(result);setForm(result);};
  const incoming=JSON.stringify(data.briefingSchedule||null);
  // Parent polling updates run receipts without erasing an unfinished config
  // edit. A local action's receipt appears immediately, before the next poll.
  useEffect(()=>{if(data.briefingSchedule)setLive(data.briefingSchedule);},[incoming]);
  useEffect(()=>{let active=true;ref.current('briefingScheduleSnapshot').then(result=>{if(active)update(result);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  const change=(key,value)=>setForm(v=>({...v,[key]:value}));
  async function perform(action,input={},message=''){
    setBusy(true);setError('');setNotice('');
    try{const result=await act(action,{revision:state.revision,...input});if(result?.revision)update(result);if(message)setNotice(message);}
    catch(e){setError(e.message);try{setLive(await ref.current('briefingScheduleSnapshot'));}catch{}}finally{setBusy(false);}
  }
  if(!state||!form)return <p role="status">{error||'读取简报保存计划…'}</p>;
  const current=live||state,stale=current&&current.revision!==state.revision;
  const dirty=['enabled','projectId','range','format','cadence','time','weekday','timeZone'].some(key=>form[key]!==state[key]);
  const blocked=busy||!!data.operation;
  return <details className="briefing-schedule"><summary><Clock3 size={17}/>自动保存工作简报<span>{current?.enabled?'已启用':'未启用'}</span></summary>
    <p>每天或每周将简报写入你选择的本地文件夹。每次保存独立文件并回读核对，默认不附工作正文。无需模型调用。</p>
    <p className="schedule-note">遵循全局托管暂停和工作时段；电脑唤醒后只补存一份当前简报。修改配置后先保存，再手动试存。</p>
    {stale&&<p className="form-error">计划已在其他操作中变化，请刷新计划后重新编辑。</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="schedule-notice" role="status">{notice}</p>}
    <div className="schedule-folder"><span>{state.folder||'请选择专用于简报的文件夹'}</span><button className="button small" disabled={blocked||!desktop} onClick={()=>perform('chooseBriefingFolder')}><FolderOpen size={14}/>选择简报目录</button></div>
    {!desktop&&<small>选择本地目录需要桌面 App。</small>}
    <div className="schedule-fields">
      <label>简报范围<select aria-label="定时简报项目" value={form.projectId} disabled={blocked} onChange={e=>change('projectId',e.target.value)}><option value="">全部项目与独立工作</option><option value="@independent">仅独立工作</option>{data.projects.map(p=><option key={p.id} value={p.id} disabled={!!p.archivedAt}>{p.name}{p.archivedAt?'（已归档）':''}</option>)}</select></label>
      <label>回顾期间<select aria-label="定时简报回顾期间" value={form.range} disabled={blocked} onChange={e=>change('range',e.target.value)}><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option></select></label>
      <label>保存格式<select aria-label="定时简报格式" value={form.format} disabled={blocked} onChange={e=>change('format',e.target.value)}><option value="md">Markdown</option><option value="json">JSON</option></select></label>
      <label>频率<select aria-label="定时简报频率" value={form.cadence} disabled={blocked} onChange={e=>change('cadence',e.target.value)}><option value="daily">每天</option><option value="weekly">每周</option></select></label>
      {form.cadence==='weekly'&&<label>每周日期<select aria-label="定时简报星期" value={form.weekday} disabled={blocked} onChange={e=>change('weekday',Number(e.target.value))}>{['日','一','二','三','四','五','六'].map((d,i)=><option key={i} value={i}>星期{d}</option>)}</select></label>}
      <label>保存时刻<input aria-label="定时简报时刻" type="time" value={form.time} disabled={blocked} onChange={e=>change('time',e.target.value)}/></label>
      <label>时区<input aria-label="定时简报时区" value={form.timeZone} disabled={blocked} onChange={e=>change('timeZone',e.target.value)} placeholder="Asia/Shanghai"/></label>
    </div>
    <label className="schedule-enable"><input type="checkbox" aria-label="启用简报自动保存" checked={form.enabled} disabled={blocked} onChange={e=>change('enabled',e.target.checked)}/>启用自动保存到以上目录</label>
    <div className="schedule-buttons"><button className="button primary" disabled={blocked||stale} onClick={()=>perform('briefingScheduleSave',form,'简报计划已保存')}>保存简报计划</button><button className="button" disabled={blocked||stale||dirty||!state.folder} onClick={()=>perform('briefingScheduleRun',{},'已执行一次保存，请查看回执')}>立即保存一份简报</button><button className="button" disabled={blocked} onClick={()=>perform('briefingScheduleSnapshot')}><RefreshCw size={14}/>刷新保存记录</button>{current?.enabled&&<button className="button" disabled={blocked||stale} onClick={()=>perform('briefingSchedulePause')}>暂停简报计划</button>}</div>
    <p>下一次自动保存：{when(current?.nextRunAt)} · {current.timeZone}。最多保留最近 100 次回执，目录中的历史文件会继续保留。</p>
    {current?.error&&<p className="form-error">{current.error}</p>}
    <div className="schedule-runs">{(current?.runs||state.runs).slice(0,10).map(r=><article key={r.id}><div><strong>{labels[r.status]||r.status}</strong><small>{when(r.finishedAt||r.at)}</small><p>{r.filename}</p>{r.error&&<p className="form-error">{r.error}</p>}</div><div>{r.status==='done'&&desktop&&<button className="button small" disabled={blocked} onClick={()=>perform('briefingScheduleOpen',{id:r.id})}>在文件夹中查看</button>}{['failed','interrupted'].includes(r.status)&&<><button className="button small" disabled={blocked||stale} onClick={()=>perform('briefingScheduleRetry',{id:r.id})}>重试并核对原文件</button><button className="button small" disabled={blocked||stale} onClick={()=>perform('briefingScheduleDiscard',{id:r.id})}>放弃本次重试</button></>}</div></article>)}</div>
  </details>;
}
