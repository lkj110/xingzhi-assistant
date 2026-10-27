'use strict';
// Explicit installation only. Production inference has remote access disabled.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const model='Xenova/paraphrase-multilingual-MiniLM-L12-v2',revision='2c4055b12046f11709e9df2c122e59ffbdc2f900';
const root=path.join(__dirname,'../resources/evidence-encoder');
async function main(){
 fs.mkdirSync(root,{recursive:true});const files=[];
 for(const file of ['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx']){
  const dest=path.join(root,file);fs.mkdirSync(path.dirname(dest),{recursive:true});
  const response=await fetch(`https://huggingface.co/${model}/resolve/${revision}/${file}`);
  if(!response.ok)throw Error(`Download failed: ${file} ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());fs.writeFileSync(dest,bytes);
  files.push({file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  process.stdout.write(`${file}: ${bytes.length}\n`);
 }
 const card=await fetch('https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/raw/main/README.md').then(r=>{if(!r.ok)throw Error('License metadata unavailable');return r.text();});
 if(!/license: apache-2\.0/.test(card))throw Error('Unexpected upstream license');
 fs.writeFileSync(path.join(root,'MODEL-CARD.md'),card);
 const license=await fetch('https://www.apache.org/licenses/LICENSE-2.0.txt').then(r=>{if(!r.ok)throw Error('License unavailable');return r.text();});
 fs.writeFileSync(path.join(root,'LICENSE.txt'),license);
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({model,revision,runtime:'@huggingface/transformers@3.8.1',license:'Apache-2.0',files},null,2));
}
main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
