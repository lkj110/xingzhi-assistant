const path = require('node:path');
const {performance}=require('node:perf_hooks');
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const imageExtensions = new Set(['.png','.jpg','.jpeg']);
const extensions = new Set(['.txt','.md','.csv','.json','.pdf','.docx',...imageExtensions]);
const maxBytes = 10_000_000, maxChars = 500_000;
function paragraphs(text) {
  const chunks = String(text).replace(/\r\n/g,'\n').split(/\n\s*\n/).filter(s=>s.trim());
  const segments = [];
  chunks.forEach((chunk,index)=>{for(let i=0;i<chunk.length;i+=1600)segments.push({id:`p${index+1}-${i/1600+1}`,label:`第 ${index+1} 段${chunk.length>1600?`（片段 ${i/1600+1}）`:''}`,paragraph:index+1,text:chunk.slice(i,i+1600).trim()});});
  return segments;
}
function finish(name, segments, format, warnings=[]) {
  segments = segments.filter(s=>s.text.trim()).flatMap(s=>{const groupId=s.groupId||s.id;if(s.text.length<=6000)return [{...s,groupId,partOffset:0}];const parts=[];for(let i=0;i<s.text.length;i+=6000)parts.push({...s,groupId,partOffset:i,id:`${s.id}-${i/6000+1}`,label:`${s.label}（片段 ${i/6000+1}）`,text:s.text.slice(i,i+6000)});return parts;});
  const content = segments.map(s=>`[${s.label}]\n${s.text}`).join('\n\n');
  if (!content.trim()) throw new Error(format==='pdf'?'PDF 没有可读取或识别的文字，请检查原文件':'文档没有可读取文字');
  if (content.length > maxChars) throw new Error('文档文字超过 50 万字符，请拆分后导入');
  return {title:name,content,format,segments,warnings};
}
function validateZip(buffer) {
  return new Promise((resolve,reject)=>require('yauzl').fromBuffer(buffer,{lazyEntries:true},(error,zip)=>{
    if(error)return reject(new Error('DOCX 压缩结构无效'));
    let total=0,count=0;
    const fail=()=>{zip.close();reject(new Error('DOCX 解压大小或文件数量超过上限'));};
    zip.on('error',()=>reject(new Error('DOCX 文档损坏')));
    zip.on('entry',entry=>{total+=entry.uncompressedSize;count++;if(total>50_000_000||count>2000||entry.uncompressedSize>20_000_000)return fail();zip.readEntry();});
    zip.on('end',resolve);zip.readEntry();
  }));
}
async function parseInWorker(name, buffer) {
  const ext=path.extname(name).toLowerCase();
  if(ext==='.pdf') {
    const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading=getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0});
    let doc;
    try {
      doc=await loading.promise;
      if(doc.numPages>250)throw new Error('PDF 超过 250 页，请拆分后导入');
      const segments=[],imageWithTextPages=[];let chars=0;
      for(let i=1;i<=doc.numPages;i++) {
        const page=await doc.getPage(i),text=await page.getTextContent();
        const value=text.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('').trim();chars+=value.length;
        if(chars>maxChars)throw new Error('文档文字超过 50 万字符，请拆分后导入');
        if(value){const operations=await page.getOperatorList();if(operations.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageXObjectRepeat].includes(op)))imageWithTextPages.push(i);}
        segments.push({id:`page${i}`,label:`第 ${i} 页`,page:i,text:value});page.cleanup();
      }
      // The parent owns any native OCR subprocess; a terminated worker never leaves one behind.
      return {pdfPages:segments,imageWithTextPages};
    } finally {await loading.destroy();}
  }
  if(ext==='.docx') {
    await validateZip(buffer);
    const result=await require('./document-structure.cjs').docx(buffer);
    return finish(name,result.segments,'docx',result.warnings);
  }
  if(['.csv','.json'].includes(ext))return finish(name,[{id:'structured-raw',label:'结构化原文',text:buffer.toString('utf8'),structure:'raw-contiguous'}],ext.slice(1));
  return finish(name,paragraphs(buffer.toString('utf8')),ext.slice(1));
}
function parse(name, buffer, signal) {
  const ext=path.extname(name).toLowerCase();
  if(!extensions.has(ext))throw new Error('支持 TXT、MD、CSV、JSON、PDF、DOCX、PNG、JPG、JPEG 文件');
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>maxBytes)throw new Error('单份文件须在 10 MB 以内且不能为空');
  signal?.throwIfAborted();
  // The owning thread manages the native process so cancellation cannot orphan it
  // when the document worker is terminated. Other formats retain their worker limits.
  if(imageExtensions.has(ext))return require('./image-ocr.cjs').recognize(buffer,signal).then(result=>{
    signal?.throwIfAborted();
    const warnings=['文字由本机识别，可能有错漏，请核对原图'];
    if(result.scaled)warnings.push('图片已缩小至最长边 4096 像素后识别，细小文字可能遗漏');
    const segments=result.lines.map((line,index)=>({id:`image1-p${index+1}`,label:`图片第 1 页 · 第 ${index+1} 段（本机识别）`,page:1,paragraph:index+1,text:line.text,localOCR:true,confidence:line.confidence,boundingBox:{...line.box,coordinateSystem:'normalized-top-left',orientation:'display'},imageWidth:result.width,imageHeight:result.height}));
    return finish(name,segments,result.format,warnings);
  });
  const started=performance.now();
  return parseWorker(name,buffer,signal).then(async result=>{
    if(ext!=='.pdf')return result;
    signal?.throwIfAborted();
    const pages=result.pdfPages,requested=pages.filter(page=>!page.text).map(page=>page.page),warnings=['PDF 按原页提取文字，跨页表头、脚注与阅读顺序须核对原页，未推断丢失结构。'];
    for(const page of result.imageWithTextPages||[])warnings.push(`第 ${page} 页已读取原有文本；同页图像中的文字未另行识别，请核对原页`);
    if(!requested.length)return finish(name,pages,'pdf',warnings);
    const pdfOCR=require('./pdf-ocr.cjs');
    const recognized=await pdfOCR.recognize(buffer,{pages:requested,pageCount:pages.length,signal},{timeoutMs:pdfOCR.limits.totalTimeoutMs-(performance.now()-started)});
    signal?.throwIfAborted();if(performance.now()-started>pdfOCR.limits.totalTimeoutMs)throw pdfOCR.failure('PDF_OCR_TIMEOUT');
    warnings.unshift(`第 ${requested.join('、')} 页由本机识别，可能有错漏，请核对原 PDF`);
    const byPage=new Map(recognized.map(page=>[page.page,page])),segments=[];
    for(const page of pages){
      if(page.text){segments.push(page);continue;}
      const found=byPage.get(page.page);
      if(!found)throw pdfOCR.failure('PDF_OCR_OUTPUT');
      if(!found.lines.length){warnings.push(`第 ${page.page} 页本机识别后仍无文字，可能为空白页或图像不清晰；该页未生成文字材料`);continue;}
      if(found.scaled)warnings.push(`第 ${page.page} 页已缩小至最长边 ${pdfOCR.limits.edge} 像素识别，细小文字可能遗漏`);
      for(const [index,line] of found.lines.entries())segments.push({id:`page${page.page}-ocr-p${index+1}`,label:`第 ${page.page} 页 · 第 ${index+1} 段（本机识别）`,page:page.page,paragraph:index+1,text:line.text,localOCR:true,confidence:line.confidence,boundingBox:{...line.box,coordinateSystem:'normalized-top-left',orientation:'display'},imageWidth:found.width,imageHeight:found.height,pageWidthPoints:found.pageWidthPoints,pageHeightPoints:found.pageHeightPoints});
    }
    if(!segments.length)throw pdfOCR.failure('PDF_OCR_EMPTY');
    return finish(name,segments,'pdf',warnings);
  });
}
function parseWorker(name,buffer,signal){
  return new Promise((resolve,reject)=>{
    const worker=new Worker('require(require("node:worker_threads").workerData.entry)',{eval:true,workerData:{entry:__filename,kind:'assistant-document-parser',name,buffer},resourceLimits:{maxOldGenerationSizeMb:256}});
    let finished=false;
    const done=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();error?reject(error):resolve(result);};
    const abort=()=>done(new Error('文档读取已停止'));
    const timer=setTimeout(()=>done(new Error('文档解析超过 30 秒，请拆分或转换后导入')),30000);
    signal?.addEventListener('abort',abort,{once:true});
    worker.on('message',message=>done(message.error?new Error(message.error):null,message.result));
    worker.on('error',()=>done(new Error('文档解析失败，请检查文件格式或是否损坏')));
    worker.on('exit',()=>{if(!finished)done(new Error('文档解析中断'));});
    if(signal?.aborted)abort();
  });
}
// Literal, case-insensitive OR matching, ranked by number of matched terms.
// Regex-looking queries are not silently reinterpreted as alternation.
function searchContract(query){
 const terms=String(query).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0,10);
 return {mode:'literal',match:'any',caseSensitive:false,terms,maxTerms:10,
  ...(/[|\[\]{}()^$*+?\\]/.test(query)?{warning:'REGEX_NOT_SUPPORTED',instruction:'仅支持空白分隔的字面多词匹配（任一词命中）；正则符号按普通字符匹配。例如 insert from join。'}:{})};
}
// Internal authorized read: callers must validate current source ACL first.
// Summary/catalog never calls this, so opening a workspace cannot inflate graphs.
function readContent(source){
 if(!source.platformSnapshot)return source.content;
 let snapshot;try{snapshot=JSON.parse(source.content);}catch{if(source.platformArchive)throw require('./platform-chunks.cjs').integrity('archive_invalid');return source.content;}
 if(!snapshot.platformResult&&!source.platformArchive&&!snapshot.platformArchive)return source.content;
 const data=require('./data-platform.cjs').restorePlatformData(snapshot,source);
 const {platformResult,platformArchive,...envelope}=snapshot;
 return JSON.stringify({...envelope,data},null,2);
}
function archived(source){
 if(!source.platformSnapshot)return false;
 if(source.platformArchive)return true;
 try{return !!JSON.parse(source.content).platformResult;}catch{return false;}
}
function platformSegments(content){
 const segments=[];
 for(let start=0;start<content.length;){
  let end=Math.min(content.length,start+1600);
  if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1])&&/[\uDC00-\uDFFF]/.test(content[end]))end++;
  const index=segments.length;
  segments.push({id:`platform-${index+1}`,label:`平台原文片段 ${index+1}`,paragraph:1,text:content.slice(start,end)});
  start=end;
 }
 return segments;
}
function excerpts(source,{query='',start=0,limit=6}={}) {
  const segments=archived(source)?platformSegments(readContent(source)):source.segments?.length?source.segments:paragraphs(source.content);
  const terms=String(query).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0,10);
  let selected=segments.map((segment,index)=>({...segment,index}));
  if(terms.length)selected=selected.map(s=>({...s,score:terms.reduce((n,t)=>n+(s.text.toLowerCase().includes(t)?1:0),0)})).filter(s=>s.score).sort((a,b)=>b.score-a.score||a.index-b.index);
  const offset=Math.max(0,Number(start)||0),count=Math.max(1,Math.min(10,Number(limit)||6));
  return {...(query?{search:searchContract(query)}:{}),sourceId:source.id,title:source.title,totalSegments:segments.length,totalMatches:selected.length,start:offset,segments:selected.slice(offset,offset+count).map(s=>({...s,text:s.text.slice(0,8000),truncated:s.text.length>8000})),more:selected.length>offset+count};
}
function summary(source,max=7000) {
  const isArchive=archived(source);
  if(isArchive){let parsed;try{parsed=JSON.parse(source.content);}catch{throw require('./platform-chunks.cjs').integrity('archive_invalid');}if(parsed.platformArchive){const {platformArchive,...publicSnapshot}=parsed;source={...source,content:JSON.stringify(publicSnapshot)};}}
  return {id:source.id,title:source.title,origin:source.origin,provenance:source.provenance,createdAt:source.createdAt,format:source.format,webConnectionId:source.webConnectionId,feedConnectionId:source.feedConnectionId,feedEntryKey:source.feedEntryKey,folderId:source.folderId,connectorId:source.connectorId,senderId:source.senderId,remoteCreatedAt:source.remoteCreatedAt,remoteId:source.remoteId,deleted:source.deleted,warnings:source.warnings||[],characters:source.content.length,version:source.version||1,previousSourceId:source.previousSourceId||null,segments:source.segments?.length || paragraphs(source.content).length,
    content:source.content.length>max?`${source.content.slice(0,max/2)}\n[中间内容省略，使用 search_source/read_source 获取]\n${source.content.slice(-max/2)}`:source.content,truncated:isArchive||source.content.length>max,...(isArchive?{directoryOnly:true,readView:{stored:'archive_directory',read:'original_redacted_platform_data',incomplete:true},note:'仅为保存目录，全文须按来源权限用 read_source/search_source 分页；目录字符数不代表全文长度。'}:{})};
}
if(!isMainThread&&workerData?.kind==='assistant-document-parser') parseInWorker(workerData.name,Buffer.from(workerData.buffer)).then(result=>parentPort.postMessage({result}),error=>parentPort.postMessage({error:error.name==='PasswordException'?'PDF 已加密，请解密后导入':error.message}));
function readSource(a,input){
 // detail checks the current public access policy, but deliberately strips
 // archives. Only after that check may this internal reader use the saved row.
 require('./workspace-view.cjs').detail(a,{kind:'source',id:input.id});
 const source=a.data.sources.find(s=>s.id===input.id);
 return excerpts(source,input);
}
module.exports={readSource,readContent,platformSegments,searchContract,parse,paragraphs,excerpts,summary,extensions,imageExtensions,maxBytes,maxChars};
