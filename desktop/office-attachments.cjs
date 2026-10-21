'use strict';
const path=require('node:path'),documents=require('./documents.cjs');
const MAX_BYTES=10_000_000,MAX_TOTAL=30_000_000,MAX_FILES=20;
function budget(){return {bytes:0,files:0};}
function fileName(value){return path.posix.basename(String(value||'attachment').replace(/\\/g,'/')).replace(/[\x00-\x1f]/g,'').slice(0,200)||'attachment';}
function check(name,size,b){
 if(++b.files>MAX_FILES)throw Error('附件超过每页 20 份上限，请缩小来源范围');
 if(!documents.extensions.has(path.extname(name).toLowerCase()))return '此附件格式不支持正文解析';
 if(Number.isFinite(size)&&size>MAX_BYTES)return '附件超过 10 MB，请单独导入';
 return '';
}
async function parse(name,bytes,b,signal){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw Error('附件内容为空或超过 10 MB');
 b.bytes+=bytes.length;if(b.bytes>MAX_TOTAL)throw Error('附件累计超过每页 30 MB 上限');
 const result=await documents.parse(name,bytes,signal);
 return {text:`\n[附件：${name}]\n${result.content}`,warnings:result.warnings||[]};
}
async function download(a,c,file,signal,b,{bearer=false}={}){
 const name=fileName(file.name),skip=check(name,file.size,b);
 if(skip)return {text:'',warnings:[`${name}：${skip}`]};
 let url;try{url=new URL(file.url);}catch{throw Error('附件地址无效');}
 if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('附件须使用公开 HTTPS 地址');
 // Never forward a workspace token to a URL supplied by an attachment.
 if(bearer&&url.hostname!=='files.slack.com')throw Error('Slack 附件地址超出授权文件站点');
 const secret=bearer?await a.vault.open(c.sealedToken):'';
 let r;try{r=await a.officeRequest(url.href,{signal,allowedOrigin:url.origin,responseType:'buffer',maxBytes:MAX_BYTES,headers:secret?{Authorization:`Bearer ${secret}`}:{}});}catch{signal?.throwIfAborted();throw Error('附件下载失败，请检查授权或稍后重试；同步断点保留');}
 if(r.status!==200||r.url&&new URL(r.url).origin!==url.origin)throw Error('附件下载失败或重定向超出原站点');
 return parse(name,r.body,b,signal);
}
async function inline(file,signal,b){
 const name=fileName(file.name),skip=check(name,file.size,b);
 if(skip)return {text:'',warnings:[`${name}：${skip}`]};
 if(typeof file.contentBytes!=='string'||file.contentBytes.length>Math.ceil(MAX_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBytes))throw Error('附件编码无效或超出大小限制');
 return parse(name,Buffer.from(file.contentBytes,'base64'),b,signal);
}
module.exports={budget,fileName,download,inline};
