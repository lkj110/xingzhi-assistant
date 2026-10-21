const path=require('node:path');
const childProcess=require('node:child_process');

const limits=Object.freeze({bytes:10_000_000,pixels:25_000_000,edge:10000,recognitionEdge:4096,timeoutMs:25000,outputBytes:2_000_000,characters:500_000});
const messages={
  OCR_UNSUPPORTED:'图片文字识别需要 Windows 10/11 或 macOS 13 及以上系统',
  OCR_UNAVAILABLE:'本地图片识别组件不可用，请重新安装完整应用',
  OCR_LANGUAGE:'Windows 未安装可用的 OCR 语言包，请在系统语言设置中添加中文或英文文字识别组件',
  OCR_FORMAT:'仅支持 PNG、JPG、JPEG 图片，请转换格式后导入',
  OCR_INVALID:'图片损坏或无法完整读取，请重新导出 PNG 或 JPEG 图片',
  OCR_LIMIT:'图片须在 10 MB、单边 10000 像素和 2500 万总像素以内',
  OCR_EMPTY:'图片中没有识别到文字，请选择清晰且包含文字的图片',
  OCR_TIMEOUT:'本地图片识别超过 25 秒，请裁剪或缩小图片后重试',
  OCR_CANCELLED:'图片文字识别已停止',
  OCR_FAILED:'本地图片文字识别失败，请检查图片或裁剪后重试',
  OCR_OUTPUT:'本地图片识别结果无效或超过文字上限，请拆分图片后重试',
};
function failure(code){const safeCode=Object.hasOwn(messages,code)?code:'OCR_FAILED';const error=new Error(messages[safeCode]);error.code=safeCode;error.automaticRetry=false;if(safeCode==='OCR_CANCELLED')error.name='AbortError';return error;}
function binaryPath(directory=__dirname){return path.join(directory,'native','bin','image-ocr').replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');}
function validateResult(result,engine='apple-vision'){
  if(!result||result.version!==1||result.engine!==engine||!['png','jpeg'].includes(result.format)||!Number.isSafeInteger(result.width)||!Number.isSafeInteger(result.height)||result.width<1||result.height<1||result.width>limits.edge||result.height>limits.edge||result.width*result.height>limits.pixels||!Array.isArray(result.lines)||result.lines.length>10000)throw failure('OCR_OUTPUT');
  let characters=0;
  const lines=result.lines.map(line=>{
    const box=line?.box;
    if(typeof line?.text!=='string'||!line.text.trim()||!Number.isFinite(line.confidence)||line.confidence<0||line.confidence>1||!box||!['x','y','width','height'].every(key=>Number.isFinite(box[key])&&box[key]>=0&&box[key]<=1)||box.x+box.width>1.0001||box.y+box.height>1.0001)throw failure('OCR_OUTPUT');
    characters+=line.text.length;if(characters>limits.characters)throw failure('OCR_OUTPUT');
    return {text:line.text.trim(),confidence:line.confidence,box:{x:box.x,y:box.y,width:box.width,height:box.height}};
  });
  if(!lines.length)throw failure('OCR_EMPTY');
  return {format:result.format,width:result.width,height:result.height,scaled:result.scaled===true,lines};
}
// Image bytes travel only through stdin. No image file or OCR result is written by this helper.
// The injected options are for isolated process tests; the app always uses these fixed defaults.
function recognize(buffer,signal,{platform=process.platform,spawnImpl=childProcess.spawn,timeoutMs=limits.timeoutMs}={}){
  if(signal?.aborted)return Promise.reject(failure('OCR_CANCELLED'));
  if(!['darwin','win32'].includes(platform))return Promise.reject(failure('OCR_UNSUPPORTED'));
  if(process.platform==='darwin'&&Number(require('node:os').release().split('.')[0])<22)return Promise.reject(failure('OCR_UNSUPPORTED'));
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>limits.bytes)return Promise.reject(failure('OCR_LIMIT'));
  const png=buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
  if(!png&&!jpeg)return Promise.reject(failure('OCR_FORMAT'));
  return new Promise((resolve,reject)=>{
    let child,finished=false,stopped=null,size=0,chunks=[],timer;
    const settle=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const stop=code=>{if(finished||stopped)return;stopped=failure(code);child?.kill('SIGKILL');};
    const abort=()=>stop('OCR_CANCELLED');
    try {const command=platform==='win32'?require('./windows-native.cjs').ocrCommand('image'):{file:binaryPath(),args:[]};child=spawnImpl(command.file,command.args,{stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true});}
    catch{return settle(failure('OCR_UNAVAILABLE'));}
    child.on('error',()=>{if(!finished)settle(stopped||failure('OCR_UNAVAILABLE'));});
    child.stdout.on('data',chunk=>{if(stopped||finished)return;size+=chunk.length;if(size>limits.outputBytes){chunks=[];return stop('OCR_OUTPUT');}chunks.push(chunk);});
    child.stdin.on('error',()=>stop('OCR_FAILED'));
    child.on('close',(code)=>{
      if(stopped)return settle(stopped);
      if(signal?.aborted)return settle(failure('OCR_CANCELLED'));
      let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return settle(failure('OCR_FAILED'));}
      if(value?.error)return settle(failure(value.error));
      if(code!==0)return settle(failure('OCR_FAILED'));
      try{settle(null,validateResult(value,platform==='win32'?'windows-ocr':'apple-vision'));}catch(error){settle(error);}
    });
    timer=setTimeout(()=>stop('OCR_TIMEOUT'),Math.min(limits.timeoutMs,Math.max(1,timeoutMs)));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    if(!stopped)child.stdin.end(buffer);
  });
}
module.exports={recognize,limits,binaryPath};
