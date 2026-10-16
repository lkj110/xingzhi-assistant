import React,{useState} from 'react';
import {workBusy} from './execution-state';

export function automaticLarkCreation(job,taskId){const grant=job.larkCreateGrant;return !!grant&&(job.larkCreatePolicies||[]).some(p=>p.taskId===taskId&&p.mode==='auto'&&p.openId===grant.openId&&p.target===grant.target&&p.approvedAt);}

export default function LarkCreatePolicy({data,job,act}){
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const grant=job.larkCreateGrant;
  if(!grant)return null;
  const tasks=data.tasks.filter(t=>job.taskIds.includes(t.id)&&!t.deletedAt&&!t.agentCancelled);
  const busy=saving||workBusy(data,{jobId:job.id})||!!data.projects.find(p=>p.id===job.projectId&&p.archivedAt);
  async function update(task,mode,allowUpdate=(job.larkCreatePolicies||[]).find(p=>p.taskId===task.id)?.allowUpdate===true){
    setSaving(true);setError('');
    try{await act('agentLarkCreatePolicy',{id:job.id,taskId:task.id,mode,allowUpdate,openId:grant.openId,target:grant.target},'飞书创建方式已保存');}catch(e){setError(e.message);}finally{setSaving(false);}
  }
  return <section className="agent-section" aria-label="飞书创建方式"><h3>飞书创建方式</h3><p>账号：{grant.userName||grant.openId} · 保存位置：{grant.target==='my_library'?'本人云文档':grant.target}</p><p className="help-text">自动创建仅适用于下方已授权事项、此账号和保存位置。Agent 按事项目标保存文稿并核对结果；切换账号或位置后重新确认，不改变分享权限。</p>{tasks.map(task=>{const auto=automaticLarkCreation(job,task.id),updates=auto&&(job.larkCreatePolicies||[]).some(p=>p.taskId===task.id&&p.allowUpdate);return <div className="agent-write" key={task.id}><div><strong>{task.title}</strong><p>{auto?'已授权按事项目标自动创建':'创建前确认具体文稿'}</p><button className="button" disabled={busy} onClick={()=>update(task,auto?'ask':'auto')}>{auto?'改为每次创建前确认':'允许本事项自动创建飞书文档'}</button><p className="help-text">更新会替换本事项由 App 创建的文档正文，保留原链接；发现人工修改或嵌入对象时停止。</p><button className="button" disabled={busy} onClick={()=>update(task,'auto',!updates)}>{updates?'改为每次更新前确认':'允许本事项自动更新已有飞书文档'}</button></div></div>;})}{error&&<p role="alert" className="form-error">{error}</p>}</section>;
}
