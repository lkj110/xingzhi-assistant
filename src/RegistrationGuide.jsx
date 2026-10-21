import React,{useState} from 'react';
import guides from '../desktop/registration-guides.json';
export default function RegistrationGuide({act}){
 const [error,setError]=useState('');
 return <details><summary>外部服务注册与授权指南</summary><p>依次准备账号、创建应用、授予目标范围，再回到“信息连接”保存。凭据只填本机密码栏。未完成授权和实际同步的服务仍显示待接入。</p>{guides.map(g=><details key={g.id}><summary>{g.name}</summary><ol>{g.steps.map((s,i)=><li key={i}>{s}</li>)}</ol><p>验收：{g.verify}</p><button className="button" disabled={!window.assistant?.desktop} onClick={async()=>{setError('');try{await act('registrationOpen',{id:g.id});}catch(e){setError(e.message);}}}>打开 {g.name} 官方入口</button><p><code>{g.url}</code></p></details>)}{error&&<p role="alert">{error}</p>}</details>;
}
