import React from 'react';

export default function CitationLabel({citation}){
  const title=citation.field==='title';
  return <>{citation.title||'原始资料'} · {title?'来源标题（仅辅助标识）':'正文'}{!title&&Number.isSafeInteger(citation.start)&&Number.isSafeInteger(citation.end)?` · 字符 ${citation.start+1}–${citation.end}`:''}</>;
}
