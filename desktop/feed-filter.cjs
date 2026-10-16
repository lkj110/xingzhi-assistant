const crypto=require('node:crypto');
const limits={keywords:20,keywordCharacters:80,samples:5,sampleTitle:300,sampleBody:10000,sampleBytes:100000,decisions:30};
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>value.normalize('NFKC').toLowerCase();
function normalize(value){
 if(value===undefined)return {include:[],exclude:[],scope:'all',match:'any'};
 if(!object(value)||Object.keys(value).some(key=>!['include','exclude','scope','match'].includes(key)))throw Error('RSS筛选规则格式无效，请重新设置');
 const keywords=(items,label)=>{
  if(!Array.isArray(items)||items.length>limits.keywords)throw Error(`${label}关键词须为数组，最多${limits.keywords}个`);
  const seen=new Set(),result=[];
  for(const item of items){if(typeof item!=='string'||!item.trim()||item.length>limits.keywordCharacters)throw Error(`每个${label}关键词须为1–${limits.keywordCharacters}字符`);const text=item.trim(),key=canonical(text);if(key.length>limits.keywordCharacters)throw Error('关键词归一化后过长');if(!seen.has(key)){seen.add(key);result.push(text);}}
  return result;
 };
 if(!['title','body','all'].includes(value.scope)||!['any','all'].includes(value.match))throw Error('RSS筛选范围或包含方式无效');
 return {include:keywords(value.include,'包含'),exclude:keywords(value.exclude,'排除'),scope:value.scope,match:value.match};
}
function revision(value){let normalized;try{normalized=normalize(value);}catch{normalized=value;}return crypto.createHash('sha256').update(JSON.stringify(normalized)??'invalid').digest('hex');}
function explain(words){const shown=words.slice(0,3).map(word=>`「${word}」`).join('、');return shown+(words.length>3?`等${words.length}个`:'');}
function evaluate(rule,sample){
 rule=normalize(rule);
 const title=typeof sample.title==='string'?sample.title:'',body=typeof sample.body==='string'?sample.body:'';
 const fields=rule.scope==='title'?[title]:rule.scope==='body'?[body]:[title,body];const texts=fields.map(canonical);
 const matches=word=>texts.some(text=>text.includes(canonical(word)));
 const excluded=rule.exclude.filter(matches);
 if(excluded.length)return {accepted:false,code:'excluded-keyword',reason:`命中排除词 ${explain(excluded)}`,matched:excluded};
 if(!rule.include.length)return {accepted:true,code:'no-include-limit',reason:rule.exclude.length?'未命中排除词；未限定包含词':'未配置关键词限制',matched:[]};
 const included=rule.include.filter(matches),missing=rule.include.filter(word=>!included.includes(word));
 if(rule.match==='all'&&missing.length)return {accepted:false,code:'missing-all',reason:`未命中全部包含词，缺少 ${explain(missing)}`,matched:included};
 if(!included.length)return {accepted:false,code:'missing-any',reason:'未命中任一包含词',matched:[]};
 return {accepted:true,code:rule.match==='all'?'matched-all':'matched-any',reason:`命中${rule.match==='all'?'全部':'任一'}包含词 ${explain(included)}`,matched:included};
}
function preview(input){
 if(!object(input)||!Array.isArray(input.samples)||!input.samples.length||input.samples.length>limits.samples)throw Error(`请提供1–${limits.samples}份本地文本样例`);
 const filter=normalize(input.filter);let bytes=0;
 const samples=input.samples.map((sample,index)=>{if(!object(sample)||typeof sample.title!=='string'||typeof sample.body!=='string'||sample.title.length>limits.sampleTitle||sample.body.length>limits.sampleBody||!sample.title.trim()&&!sample.body.trim())throw Error('样例须有标题或正文，标题最多300字符，正文最多10000字符');bytes+=Buffer.byteLength(sample.title)+Buffer.byteLength(sample.body);return {index,title:sample.title,...evaluate(filter,sample)};});
 if(bytes>limits.sampleBytes)throw Error('本地样例合计最多100 KB');
 return {filter,revision:revision(filter),received:samples.filter(sample=>sample.accepted).length,filtered:samples.filter(sample=>!sample.accepted).length,samples};
}
module.exports={normalize,evaluate,preview,revision,limits};
