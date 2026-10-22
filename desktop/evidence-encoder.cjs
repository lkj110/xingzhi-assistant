'use strict';
const fs=require('node:fs'),path=require('node:path'),{Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const {hash}=require('./evidence-basis.cjs');
const VERSION='local-multilingual-v1';
const root=path.join(__dirname,'../resources/evidence-encoder');
let worker,sequence=0;const pending=new Map();let state={version:VERSION,ready:false,localOnly:true};
function status(){return {...state};}
function encode(texts,signal){
 signal?.throwIfAborted();
 if(!worker){
  worker=new Worker('require(require("node:worker_threads").workerData.entry)',{eval:true,workerData:{kind:'evidence-encoder',entry:__filename},resourceLimits:{maxOldGenerationSizeMb:512}});worker.unref();
  worker.on('message',m=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);p.cleanup();state={...state,...m.status};m.error?p.reject(Error(m.error)):p.resolve(m.vectors);if(!pending.size)worker?.unref();});
  const failed=()=>{for(const p of pending.values()){p.cleanup();p.reject(Error('本地向量编码器不可用'));}pending.clear();state.ready=false;worker=undefined;};
  worker.on('error',failed);worker.on('exit',failed);
 }
 return new Promise((resolve,reject)=>{
  const id=++sequence,abort=()=>{pending.delete(id);cleanup();reject(signal.reason||Error('已停止'));},timer=setTimeout(()=>{pending.delete(id);cleanup();reject(Error('本地向量索引超时'));},180000);
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  pending.set(id,{resolve,reject,cleanup});signal?.addEventListener('abort',abort,{once:true});worker.ref();worker.postMessage({id,texts});
 });
}
if(!isMainThread&&workerData?.kind==='evidence-encoder'){
 let extractor,chain=Promise.resolve();
 async function run(m){
  const start=performance.now();
  try{
   if(!extractor){
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
    if(manifest.runtime!=='@huggingface/transformers@3.8.1')throw Error('本地编码器版本不匹配');
    for(const f of manifest.files){if(!['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx'].includes(f.file))throw Error('本地模型清单无效');const bytes=fs.readFileSync(path.join(root,f.file));if(require('node:crypto').createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw Error('本地模型校验失败');}
    // The WASM CPU backend avoids native DLL dependencies on supported Windows hosts.
    const ort=await import('onnxruntime-web');globalThis[Symbol.for('onnxruntime')]=ort;
    const bundle=path.join(path.dirname(require.resolve('@huggingface/transformers')),'transformers.web.js');
    const {pipeline,env}=await import(require('node:url').pathToFileURL(bundle).href);
    env.allowRemoteModels=false;env.allowLocalModels=true;env.useBrowserCache=false;env.useFSCache=false;env.useCustomCache=true;
    env.customCache={match:async url=>{const f=manifest.files.find(f=>String(url).endsWith('/'+f.file));return f?new Response(fs.readFileSync(path.join(root,f.file))):undefined;},put:async()=>{}};
    env.backends.onnx.wasm.numThreads=1;
    env.backends.onnx.wasm.wasmPaths=require('node:url').pathToFileURL(path.dirname(require.resolve('onnxruntime-web'))+path.sep).href;
    extractor=await pipeline('feature-extraction','evidence-encoder',{dtype:'q8',device:'auto',local_files_only:true});
    state={...state,manifestHash:hash(manifest),model:manifest.model,revision:manifest.revision,backend:'wasm-cpu',ready:true};
   }
   const vectors=[];for(let i=0;i<m.texts.length;i+=16){const output=await extractor(m.texts.slice(i,i+16),{pooling:'mean',normalize:true,truncation:true,max_length:256});vectors.push(...output.tolist());}
   parentPort.postMessage({id:m.id,vectors,status:{...state,lastMs:Math.round(performance.now()-start),rss:process.memoryUsage().rss}});
  }catch(e){parentPort.postMessage({id:m.id,error:e.message,status:{...state,ready:false}});}
 }
 parentPort.on('message',m=>{chain=chain.then(()=>run(m));});
}
module.exports={VERSION,encode,status};
