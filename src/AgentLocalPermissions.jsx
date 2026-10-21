import React,{useState,useEffect} from 'react';
const fields=[['codeMode','Python / JavaScript'],['draftMode','邮件草稿'],['mediaMode','订阅图片 / 离线语音'],['mailMode','Outlook 发信'],['deployMode','GitHub 部署']];
export default function AgentLocalPermissions({job,value,onChange,act,busy=false}){
 const [draft,setDraft]=useState(job?.localTools||value||{}),[message,setMessage]=useState('');
 useEffect(()=>{setDraft(job?.localTools||value||{});setMessage('');},[job?.id,job?.localTools,value]);
 const current=onChange?value||{}:draft;
 return <details className="agent-local-permissions"><summary>新增工具权限</summary><p className="help-text">Agent 可自行规划并调用这些工具，结果保留在本次委托的交付目录。代码以你的本机用户身份执行，能访问文件和网络；选择自动执行即授权本次委托直接运行生成的代码。图片消耗订阅额度，每次委托最多提交 3 张。</p><div className="form-row">{fields.map(([key,label])=><label key={key}>{label}<select aria-label={'Agent '+label+'权限'} value={current[key]||'off'} disabled={busy} onChange={e=>{const next={...current,[key]:e.target.value};onChange?onChange(next):setDraft(next);}}><option value="off">不允许</option><option value="ask">执行前预览确认</option>{!['mailMode','deployMode'].includes(key)&&<option value="auto">允许自动调用</option>}</select></label>)}</div>{job&&<button className="button" disabled={busy} onClick={async()=>{try{await act('agentLocalSettings',{id:job.id,localTools:draft});setMessage('已保存，新权限从下一次动作生效');}catch(e){setMessage(e.message);}}}>保存新增工具权限</button>}{message&&<p role="status">{message}</p>}</details>;
}
