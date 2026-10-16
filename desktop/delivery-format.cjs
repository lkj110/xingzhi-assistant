const path = require('node:path');
const formats = new Set(['md','txt','csv','json']);
function formatOf(name) {return path.extname(String(name)).slice(1).toLowerCase();}
function normalize(value) {
  if(typeof value!=='string'||!formats.has(value))throw new Error('交付格式仅支持 Markdown、TXT、CSV 或 JSON');
  return value;
}
function csv(content) {
  const rows=[];let row=[],field='',quoted=false,closed=false,atStart=true;
  const finishField=()=>{row.push(field);field='';closed=false;atStart=true;};
  const finishRow=()=>{finishField();rows.push(row);row=[];};
  for(let i=0;i<content.length;i++) {
    const c=content[i];
    if(quoted) {if(c==='"'){if(content[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
    if(c==='"') {if(!atStart||closed)throw new Error('CSV 引号必须包住整个单元格，内部引号须成对转义');quoted=true;atStart=false;continue;}
    if(c===','){finishField();continue;}
    if(c==='\r'||c==='\n'){if(c==='\r'){if(content[i+1]!=='\n')throw new Error('CSV 行分隔请使用换行或 CRLF');i++;}finishRow();continue;}
    if(closed)throw new Error('CSV 结束引号后只能是分隔逗号或换行');
    field+=c;atStart=false;
  }
  if(quoted)throw new Error('CSV 存在未闭合的引号');
  if(row.length||field.length||closed||!atStart)finishRow();
  if(!rows.length)throw new Error('CSV 至少需要一行数据');
  const columns=rows[0].length;
  for(const [index,cells] of rows.entries()) {
    if(cells.length!==columns)throw new Error(`CSV 第 ${index+1} 行列数与第一行不一致`);
    for(const cell of cells) {
      const value=cell.trimStart();
      const signedNumber=/^[+-](?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())&&Number.isFinite(Number(value));
      if(/^[=+\-@]/.test(value)&&!signedNumber)throw new Error(`CSV 第 ${index+1} 行含可能执行的表格公式，请修订正文为安全的普通数据后再交付`);
    }
  }
  return {rows:rows.length,columns};
}
function validate(content,format) {
  normalize(format);
  if(typeof content!=='string'||!content.trim())throw new Error('交付正文不能为空');
  if(Buffer.byteLength(content)>800000)throw new Error('交付文件不能超过 800 KB');
  if(format==='json') {try{JSON.parse(content);}catch{throw new Error('JSON 正文格式无效，请先修订产出为完整 JSON，不要添加 Markdown 围栏或说明');}}
  if(format==='csv') {if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))throw new Error('CSV 含无效控制字符');return {format,...csv(content)};}
  return {format};
}
module.exports={formats,formatOf,normalize,validate};
