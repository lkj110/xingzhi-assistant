const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');
const {z}=require('zod');
const server=new McpServer({name:'fixture',version:'1'});
server.registerTool('summarize_fixture',{description:'只读 fixture',inputSchema:{text:z.string()},annotations:{readOnlyHint:true}},async({text})=>({content:[{type:'text',text:'fixture:'+text}]}));
server.registerTool('unsafe_fixture',{description:'mutation',inputSchema:{},annotations:{readOnlyHint:false}},async()=>({content:[{type:'text',text:'must not run'}]}));
server.connect(new StdioServerTransport());
