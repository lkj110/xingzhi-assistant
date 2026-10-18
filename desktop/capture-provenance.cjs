const kinds=new Set(['selection','screenshot','paste','file','manual']);
function normalize(value){
 if(value===undefined||value===null)return null;
 if(typeof value!=='object'||Array.isArray(value))throw Error('来源信息格式无效');
 const result={kind:kinds.has(value.kind)?value.kind:'manual'};
 for(const [key,max]of [['appName',120],['bundleId',250],['windowTitle',500],['fileName',300],['note',500]]){
  if(value[key]!==undefined&&typeof value[key]!=='string')throw Error('来源信息格式无效');
  if(value[key]?.trim())result[key]=value[key].trim().slice(0,max);
 }
 if(value.url){let url;try{url=new URL(value.url);}catch{throw Error('来源链接须为有效网页地址');}if(!['https:','http:'].includes(url.protocol))throw Error('来源链接仅支持 HTTP 或 HTTPS');url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(/token|auth|password|passwd|secret|signature|credential|session|jwt|ticket|api.?key|^key$|^code$/i.test(key))url.searchParams.delete(key);url.hash='';result.url=url.href.slice(0,2000);}
 if(value.capturedAt){if(typeof value.capturedAt!=='string'||!Number.isFinite(Date.parse(value.capturedAt)))throw Error('来源时间格式无效');result.capturedAt=new Date(value.capturedAt).toISOString();}
 return result;
}
function forFile(value,fileName,capturedAt=new Date().toISOString()){
 const provenance=normalize(value);
 return normalize({...provenance,kind:/\.(png|jpe?g)$/i.test(fileName)?'screenshot':provenance?.kind||'file',fileName,capturedAt:provenance?.capturedAt||capturedAt});
}
function label(value){const p=normalize(value);if(!p)return '';return [{selection:'选中文字',screenshot:'截图',paste:'粘贴',file:'文件导入',manual:'手动输入'}[p.kind],p.appName,p.windowTitle||p.fileName,p.note].filter(Boolean).join(' · ').slice(0,500);}
function sourceURL(data,input){
 if(!input||typeof input.id!=='string'||!Number.isInteger(input.index)||input.index<0)throw Error('来源记录无效');
 const source=data.sources.find(s=>s.id===input.id&&!s.deleted&&!s.projectExcluded);
 const item=source&&[source.provenance,...(source.captureOrigins||[])].filter(Boolean)[input.index];
 if(!item?.url)throw Error('来源链接不存在');
 return normalize({url:item.url}).url;
}
module.exports={normalize,forFile,label,sourceURL};
