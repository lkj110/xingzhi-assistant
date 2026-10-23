'use strict';
// Preserve recoverable DOCX table rows and footnote anchors; never infer layout.
async function docx(buffer){
 const zip=await require('jszip').loadAsync(buffer),{DOMParser}=require('@xmldom/xmldom');
 const parse=async name=>{const file=zip.file(name);if(!file)return null;const xml=await file.async('string');if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('DOCX XML 不允许外部实体');return new DOMParser().parseFromString(xml,'text/xml');};
 const document=await parse('word/document.xml');if(!document)throw Error('DOCX 缺少正文');
 const plain=node=>{if(node.nodeType===3)return '';if(node.localName==='t')return node.textContent;if(node.localName==='tab')return '\t';if(['br','cr'].includes(node.localName))return '\n';if(node.localName==='footnoteReference')return `[脚注${node.getAttribute('w:id')}]`;const children=Array.from(node.childNodes||[]);return children.map((child,index)=>plain(child)+(child.localName==='p'&&children.slice(index+1).some(n=>n.nodeType===1)?'\n':'')).join('');};
 const segments=[],body=document.getElementsByTagName('w:body')[0];
 for(const node of Array.from(body?.childNodes||[])){
  if(node.localName==='p'){const text=plain(node);if(text.trim())segments.push({id:'docx-'+segments.length,label:'正文段 '+(segments.length+1),paragraph:segments.length+1,text,structure:'paragraph'});}
  else if(node.localName==='tbl'){
   const rows=Array.from(node.getElementsByTagName('w:tr')).map(row=>({header:row.getElementsByTagName('w:tblHeader').length>0,text:Array.from(row.childNodes).filter(n=>n.localName==='tc').map(plain).join('\t')}));
   segments.push({id:'docx-'+segments.length,label:'表格 '+(segments.length+1),text:rows.map(r=>r.text).join('\n'),structure:'table',headerRows:rows.map((r,i)=>r.header?i:null).filter(i=>i!==null)});
  }
 }
 const footnotes=await parse('word/footnotes.xml');
 for(const node of Array.from(footnotes?.getElementsByTagName('w:footnote')||[])){
  const id=node.getAttribute('w:id');if(!/^\d+$/.test(id))continue;const text=plain(node);if(text.trim())segments.push({id:'footnote-'+id,label:`脚注${id}`,text:`[脚注${id}] ${text}`,structure:'footnote',footnoteId:id});
 }
 return {segments,warnings:['DOCX 已保留可读取的表格行和脚注；合并单元格、浮动文本及版面关系仍须核对原文件。']};
}
module.exports={docx};
