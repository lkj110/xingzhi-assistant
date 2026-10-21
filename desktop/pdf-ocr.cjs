const path=require('node:path'),childProcess=require('node:child_process');
const limits=Object.freeze({bytes:10_000_000,pages:250,ocrPages:20,edge:3000,pixels:9_000_000,totalPixels:100_000_000,pagePoints:10000,characters:500_000,timeoutMs:45000,totalTimeoutMs:60000,outputBytes:4_000_000});
const messages={PDF_OCR_UNSUPPORTED:'扫描 PDF 本机识别需要 Windows 10/11 或 macOS 13 及以上系统',PDF_OCR_LANGUAGE:'Windows 未安装可用的 OCR 语言包，请在系统语言设置中添加中文或英文文字识别组件',PDF_OCR_UNAVAILABLE:'扫描 PDF 本地识别组件不可用，请重新安装完整应用',PDF_OCR_INVALID:'PDF 损坏或页面无法完整读取，请重新导出后导入',PDF_OCR_ENCRYPTED:'PDF 已加密，请解密后导入',PDF_OCR_LIMIT:'PDF 本机识别超过上限：文件 10 MB、总页数 250 页、需识别页面 20 页或页面尺寸过大，请拆分后导入',PDF_OCR_EMPTY:'PDF 所有页面均未识别到文字，请检查原文件或使用更清晰的扫描件',PDF_OCR_TIMEOUT:'PDF 读取与本机识别超时，请拆分文件后重试（整份最多 60 秒）',PDF_OCR_CANCELLED:'PDF 本机识别已停止',PDF_OCR_FAILED:'PDF 本机识别失败，请检查页面或拆分后重试',PDF_OCR_OUTPUT:'PDF 本机识别结果不完整或超过文字上限，请拆分后重试'};
function failure(code){const safe=Object.hasOwn(messages,code)?code:'PDF_OCR_FAILED';const error=new Error(messages[safe]);error.code=safe;error.automaticRetry=false;if(safe==='PDF_OCR_CANCELLED')error.name='AbortError';return error;}
function binaryPath(directory=__dirname){return path.join(directory,'native','bin','pdf-ocr').replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');}
function validateRequest(buffer,pages,pageCount){
  if(!Buffer.isBuffer(buffer)||buffer.length<5||buffer.length>limits.bytes||!buffer.subarray(0,1024).includes(Buffer.from('%PDF-')))throw failure('PDF_OCR_INVALID');
  if(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>limits.pages||!Array.isArray(pages)||!pages.length||pages.length>limits.ocrPages||new Set(pages).size!==pages.length||pages.some(page=>!Number.isSafeInteger(page)||page<1||page>pageCount))throw failure('PDF_OCR_LIMIT');
}
function validateResult(value,expected,pageCount,engine='apple-vision-pdf'){
  if(value?.version!==1||value.engine!==engine||value.pageCount!==pageCount||!Array.isArray(value.pages)||value.pages.length!==expected.length)throw failure('PDF_OCR_OUTPUT');
  const remaining=new Set(expected);let characters=0,totalPixels=0;
  const pages=value.pages.map(page=>{
    if(!page||!remaining.delete(page.page)||!Number.isSafeInteger(page.width)||!Number.isSafeInteger(page.height)||page.width<1||page.height<1||page.width>limits.edge||page.height>limits.edge||page.width*page.height>limits.pixels||!Array.isArray(page.lines)||page.lines.length>10000||!['pageWidthPoints','pageHeightPoints'].every(key=>Number.isFinite(page[key])&&page[key]>0&&page[key]<=limits.pagePoints))throw failure('PDF_OCR_OUTPUT');
    totalPixels+=page.width*page.height;if(totalPixels>limits.totalPixels)throw failure('PDF_OCR_OUTPUT');
    const lines=page.lines.map(line=>{const box=line?.box;if(typeof line?.text!=='string'||!line.text.trim()||!Number.isFinite(line.confidence)||line.confidence<0||line.confidence>1||!box||!['x','y','width','height'].every(key=>Number.isFinite(box[key])&&box[key]>=0&&box[key]<=1)||box.x+box.width>1.0001||box.y+box.height>1.0001)throw failure('PDF_OCR_OUTPUT');characters+=line.text.length;if(characters>limits.characters)throw failure('PDF_OCR_OUTPUT');return {text:line.text.trim(),confidence:line.confidence,box:{x:box.x,y:box.y,width:box.width,height:box.height}};});
    return {page:page.page,width:page.width,height:page.height,pageWidthPoints:page.pageWidthPoints,pageHeightPoints:page.pageHeightPoints,scaled:page.scaled===true,lines};
  });
  if(remaining.size)throw failure('PDF_OCR_OUTPUT');return pages.sort((a,b)=>a.page-b.page);
}
// The owning thread holds the child until it closes, including on cancel/timeout.
// Only bounded PDF bytes go through stdin; the helper accepts numeric page arguments.
function recognize(buffer,{pages,pageCount,signal}={}, {platform=process.platform,spawnImpl=childProcess.spawn,timeoutMs=limits.timeoutMs}={}){
  if(signal?.aborted)return Promise.reject(failure('PDF_OCR_CANCELLED'));
  if(!['darwin','win32'].includes(platform)||process.platform==='darwin'&&Number(require('node:os').release().split('.')[0])<22)return Promise.reject(failure('PDF_OCR_UNSUPPORTED'));
  try{validateRequest(buffer,pages,pageCount);}catch(error){return Promise.reject(error);}
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)return Promise.reject(failure('PDF_OCR_TIMEOUT'));
  return new Promise((resolve,reject)=>{
    let child,finished=false,stopped=null,size=0,chunks=[],timer;
    const settle=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const stop=code=>{if(finished||stopped)return;stopped=failure(code);child?.kill('SIGKILL');};
    const abort=()=>stop('PDF_OCR_CANCELLED');
    try{const command=platform==='win32'?require('./windows-native.cjs').ocrCommand('pdf',pages,pageCount):{file:binaryPath(),args:[String(pageCount),...pages.map(String)]};child=spawnImpl(command.file,command.args,{stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true});}catch{return settle(failure('PDF_OCR_UNAVAILABLE'));}
    child.on('error',()=>settle(stopped||failure('PDF_OCR_UNAVAILABLE')));
    child.stdout.on('data',chunk=>{if(finished||stopped)return;size+=chunk.length;if(size>limits.outputBytes){chunks=[];return stop('PDF_OCR_OUTPUT');}chunks.push(chunk);});
    child.stdin.on('error',()=>stop('PDF_OCR_FAILED'));
    child.on('close',code=>{if(stopped)return settle(stopped);if(signal?.aborted)return settle(failure('PDF_OCR_CANCELLED'));let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return settle(failure('PDF_OCR_FAILED'));}if(value?.error)return settle(failure(value.error));if(code!==0)return settle(failure('PDF_OCR_FAILED'));try{settle(null,validateResult(value,pages,pageCount,platform==='win32'?'windows-ocr-pdf':'apple-vision-pdf'));}catch(error){settle(error);}});
    timer=setTimeout(()=>stop('PDF_OCR_TIMEOUT'),Math.min(limits.timeoutMs,timeoutMs));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();if(!stopped)child.stdin.end(buffer);
  });
}
module.exports={recognize,limits,binaryPath,failure};
