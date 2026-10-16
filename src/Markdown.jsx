import React, {memo} from 'react';
import {readTable} from './markdown-table.mjs';
import {needsTextPaging} from './render-bounds.mjs';
import {PagedText} from './RenderBounds';

export default memo(function Markdown({ text }) {
  if (needsTextPaging(text || '')) return <div className="markdown"><p className="help-text">长文按原文分页显示，可逐页查看完整内容。</p><PagedText text={text} label="文档原文"/></div>;
  const lines=(text||'').split('\n'),blocks=[];let code=false;
  const inline=line=>line.split(/(`+[^`]+`+|\*\*[^*]+\*\*|<br\s*\/?>)/gi).map((part,j)=>/^<br\s*\/?>$/i.test(part)?<br key={j}/>:part.startsWith('`')?<code key={j}>{part.replace(/^`+|`+$/g,'')}</code>:part.startsWith('**')?<strong key={j}>{part.slice(2,-2)}</strong>:part);
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.startsWith('```')){code=!code;blocks.push(<div key={i} className="code-label">{line.slice(3)||' '}</div>);continue;}
    if(code){blocks.push(<pre key={i}>{line||' '}</pre>);continue;}
    const table=readTable(lines,i);
    if(table){blocks.push(<div className="md-table-scroll" key={i} role="region" aria-label="文档表格" tabIndex={0}><table><thead><tr>{table.headers.map((cell,j)=><th key={j} scope="col" style={{textAlign:table.align[j]}}>{inline(cell)}</th>)}</tr></thead><tbody>{table.rows.map((row,r)=><tr key={r}>{row.map((cell,j)=><td key={j} style={{textAlign:table.align[j]}}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);i=table.next-1;continue;}
    if(line.startsWith('### '))blocks.push(<h4 key={i}>{inline(line.slice(4))}</h4>);
    else if(line.startsWith('## '))blocks.push(<h3 key={i}>{inline(line.slice(3))}</h3>);
    else if(line.startsWith('# '))blocks.push(<h2 key={i}>{inline(line.slice(2))}</h2>);
    else if(/^[-*] /.test(line))blocks.push(<div className="md-bullet" key={i}><span>•</span><span>{inline(line.slice(2))}</span></div>);
    else blocks.push(line?<p key={i}>{inline(line)}</p>:<div key={i} className="md-space"/>);
  }
  return <div className="markdown">{blocks}</div>;
});
