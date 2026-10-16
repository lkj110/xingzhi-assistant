// Parse table text into data only. The renderer uses React text nodes, never HTML.
export function tableCells(line) {
  let value=line.trim();
  if(value.startsWith('|'))value=value.slice(1);
  if(value.endsWith('|')&&!value.endsWith('\\|'))value=value.slice(0,-1);
  const cells=[];let cell='',code=0;
  for(let i=0;i<value.length;i++){
    if(value[i]==='\\'&&value[i+1]==='|'){cell+='|';i++;continue;}
    if(value[i]==='`'){
      let end=i;while(value[end]==='`')end++;
      const length=end-i;code=code===length?0:code||length;cell+=value.slice(i,end);i=end-1;continue;
    }
    if(value[i]==='|'&&!code){cells.push(cell.trim());cell='';}else cell+=value[i];
  }
  cells.push(cell.trim());return cells;
}
export function readTable(lines,start){
  if(!lines[start]?.includes('|')||!lines[start+1]?.includes('|'))return null;
  const headers=tableCells(lines[start]),separators=tableCells(lines[start+1]);
  if(headers.length<2||headers.length!==separators.length||!separators.every(c=>/^:?-{3,}:?$/.test(c)))return null;
  const align=separators.map(c=>c.startsWith(':')&&c.endsWith(':')?'center':c.endsWith(':')?'right':'left');
  const rows=[];let next=start+2;
  while(next<lines.length&&lines[next].trim()&&lines[next].includes('|')&&!/^\s*(?:```|~~~|#{1,6}\s)/.test(lines[next])){
    const cells=tableCells(lines[next]);
    // Never discard excess cells from malformed source text.
    if(cells.length>headers.length)break;
    rows.push([...cells,...Array(headers.length-cells.length).fill('')]);next++;
  }
  return {headers,align,rows,next};
}
