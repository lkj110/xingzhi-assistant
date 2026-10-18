import React,{useEffect,useState} from 'react';
import {Camera,Clipboard} from 'lucide-react';
import {call} from './api';
import './screenshot-input.css';

export async function serializeCaptureFiles(files){
 const items=[];
 for(const file of files){
  const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error(`无法读取文件：${file.name}`));reader.readAsDataURL(file);});
  items.push({title:file.name,base64,...(file.captureProvenance!==undefined?{provenance:file.captureProvenance}:{})});
 }
 return items;
}

export function pasteImages(event,addFiles,disabled){
 const items=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/'));
 if(!items.length)return;
 event.preventDefault();
 if(disabled)return;
 const images=items.map(item=>item.getAsFile()).filter(Boolean).map((file,index)=>Object.assign(new File([file],`粘贴截图-${Date.now()}-${index}.${file.type==='image/jpeg'?'jpg':'png'}`,{type:file.type}),{captureProvenance:{kind:'screenshot',note:'剪贴板图片',capturedAt:new Date().toISOString()}}));
 addFiles(images);
}
export default function ScreenshotInput({addFiles,disabled,onError,onBusy}){
 const [busy,setBusy]=useState(false);
 async function capture(action){
  if(busy||disabled)return;
  setBusy(true);onBusy?.(true);
  try{
   const result=await call(action);
   if(!result.cancelled){const bytes=Uint8Array.from(atob(result.base64),char=>char.charCodeAt(0));await addFiles([Object.assign(new File([bytes],result.title,{type:'image/png'}),{captureProvenance:{kind:'screenshot',note:action==='screenshotRegion'?'框选截图':'剪贴板图片',capturedAt:new Date().toISOString()}})]);}
  }catch(error){onError(error.message);}finally{setBusy(false);onBusy?.(false);}
 }
 return <div className="screenshot-input"><div>{window.assistant?.desktop&&<><button className="button" type="button" disabled={disabled||busy} onClick={()=>capture('screenshotRegion')}><Camera size={16}/>框选截图</button><button className="button" type="button" disabled={disabled||busy} onClick={()=>capture('screenshotClipboard')}><Clipboard size={16}/>粘贴剪贴板图片</button></>}</div><small>{busy?'正在获取截图…':'也可直接按 ⌘V / Ctrl+V 粘贴截图。添加后可识别文字，再选择整理或推进；指定项目的截图交给该项目委托处理。'}</small></div>;
}
export function ScreenshotPreview({files}){
 const [images,setImages]=useState([]);
 useEffect(()=>{const rows=files.filter(file=>/^image\/(png|jpeg)$/.test(file.type)||/\.(png|jpe?g)$/i.test(file.name)).map(file=>({name:file.name,url:URL.createObjectURL(file)}));setImages(rows);return()=>rows.forEach(row=>URL.revokeObjectURL(row.url));},[files]);
 return images.length>0&&<div className="screenshot-previews">{images.map(row=><img key={row.url} src={row.url} alt={`待识别截图：${row.name}`}/>)}</div>;
}
