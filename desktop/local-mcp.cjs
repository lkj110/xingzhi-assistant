'use strict';
// Standalone stdio server, installed beside its pinned MCP SDK by local setup.
const fs=require('node:fs'),path=require('node:path');
const {Server}=require('@modelcontextprotocol/sdk/server/index.js'),{StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js'),{ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');
function reader(directory){
 const root=fs.realpathSync(directory);if(root!==path.resolve(directory)||!fs.lstatSync(root).isDirectory())throw Error('资料目录不可用');
 function safe(relative=''){
  if(typeof relative!=='string'||relative.length>1000||relative.includes('\0')||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||p.includes(':')))throw Error('只能读取资料目录内的相对路径');
  const target=path.resolve(root,relative);if(target!==root&&!target.startsWith(root+path.sep))throw Error('路径超出资料目录');
  if(fs.realpathSync(root)!==root)throw Error('资料目录已变化');let current=root;for(const part of path.relative(root,target).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink()||fs.realpathSync(current)!==current)throw Error('不读取链接或重定向目录');}return target;
 }
 function list(relative=''){return fs.readdirSync(safe(relative),{withFileTypes:true}).filter(x=>!x.name.startsWith('.')&&!x.isSymbolicLink()).slice(0,200).map(x=>({name:x.name,type:x.isDirectory()?'directory':x.isFile()?'file':'other'}));}
 function read(relative){const file=safe(relative),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>1000000||!['.txt','.md','.csv','.json','.sql','.py','.js','.ts'].includes(path.extname(file).toLowerCase()))throw Error('仅支持 1 MB 以内的文本与代码文件');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const after=fs.fstatSync(fd);if(after.ino!==stat.ino||after.dev!==stat.dev||after.size!==stat.size||safe(relative)!==file)throw Error('读取期间文件已变化');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
 return {list,read};
}
const tools=[
 {name:'list_directory',description:'列出已配置资料目录下的文件。不会访问目录以外的位置。',inputSchema:{type:'object',properties:{path:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'read_text',description:'读取资料目录内 TXT、Markdown、CSV、JSON 或代码文本；最多 1 MB，不执行代码。',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'search_text',description:'按字面关键词搜索资料目录第一层的文本内容，返回匹配片段。',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:100}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}}
];
async function main(){const files=reader(process.argv[2]),server=new Server({name:'xingzhi-local-documents',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{try{const input=request.params.arguments||{};let result;
  if(request.params.name==='list_directory')result=files.list(input.path||'');
  else if(request.params.name==='read_text')result={path:input.path,content:files.read(input.path)};
  else if(request.params.name==='search_text'){if(typeof input.query!=='string'||!input.query||input.query.length>100)throw Error('搜索词须为 1–100 字符');result=[];for(const entry of files.list()){if(entry.type!=='file')continue;let text;try{text=files.read(entry.name);}catch{continue;}const index=text.toLowerCase().indexOf(input.query.toLowerCase());if(index>=0)result.push({path:entry.name,offset:index,excerpt:text.slice(Math.max(0,index-100),index+300)});if(result.length>=30)break;}}
  else throw Error('未知工具');return {content:[{type:'text',text:JSON.stringify(result)}]};
 }catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
 await server.connect(new StdioServerTransport());
}
module.exports={reader,tools};if(require.main===module)main().catch(()=>{process.stderr.write('本地资料 MCP 无法启动\n');process.exitCode=1;});
