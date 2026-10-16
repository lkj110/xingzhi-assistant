import React from 'react';
const labels={selection:'选中文字',screenshot:'截图',paste:'粘贴',manual:'手动输入',file:'文件导入'};
export default function SourceProvenance({source,compact=false,onOpen}){
 const items=[source.provenance,...(source.captureOrigins||[])].filter(Boolean);
 if(!items.length)return null;
 return <section className="source-provenance" aria-label="信息来源记录"><strong>信息来源</strong>{(compact?items.slice(0,1):items).map((p,i)=><div key={i}><span>{[labels[p.kind]||'收集',p.appName,p.windowTitle||p.fileName,p.note].filter(Boolean).join(' · ')}</span>{p.capturedAt&&<time>{new Date(p.capturedAt).toLocaleString('zh-CN')}</time>}{p.url&&<p>原文链接：{onOpen?<button className="text-button" onClick={()=>onOpen(i)}>{p.url}</button>:<a href={p.url} target="_blank" rel="noreferrer">{p.url}</a>}</p>}</div>)}</section>;
}
