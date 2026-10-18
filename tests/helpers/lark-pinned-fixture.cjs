// Preserve legacy business fixtures while exercising real request/spawn receipts.
// The synthetic native only talks to this loopback server; no real CLI is used.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const lark=require('../../desktop/lark-connector.cjs'),pin=require('../../desktop/lark-pinned-session.cjs');
const paths=new Set();let originalPath;
async function attach(t,a,bodyRequest,{openId='ou_self'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b2-legacy-cli-')),active=new Map();
 if(!paths.size)originalPath=process.env.PATH;paths.add(dir);process.env.PATH=[...paths].reverse().join(path.delimiter)+path.delimiter+originalPath;
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  try{const {args,key}=JSON.parse(text),options=active.get(key);if(!options)throw Error('fixture request has no session');const value=await bodyRequest(args,options);res.end(JSON.stringify({ok:true,identity:'user',...value}));}
  catch(e){res.end(JSON.stringify({ok:false,error:{type:e.connectorCode||'network',message:e.message}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 fs.writeFileSync(path.join(dir,'lark-cli'),`#!${process.execPath}\n`+`
const fs=require('fs'),path=require('path'),http=require('http'),args=process.argv.slice(2),out=v=>console.log(JSON.stringify(v));
if(args[0]==='--version'){console.log('lark-cli version 1.0.65');process.exit(0);}
if(args[0]==='auth'){out({appId:'cli_fixture',brand:'feishu',identities:{user:{openId:${JSON.stringify(openId)}}}});process.exit(0);}
const key=process.env.LARKSUITE_CLI_CONFIG_DIR,config=JSON.parse(fs.readFileSync(path.join(key,'config.json'))),app=config.apps[0];
if(app.appId!=='cli_fixture'||app.users[0].userOpenId!==${JSON.stringify(openId)})throw Error('wrong fixture identity');
if(args[0]==='api'){out({ok:true,identity:'user',data:{open_id:app.users[0].userOpenId,tenant_key:'tenant_fixture'}});process.exit(0);}
const r=http.request({hostname:'127.0.0.1',port:${port},path:'/',method:'POST'},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>{console.log(text);process.exit(JSON.parse(text).ok===false?1:0);});});r.on('error',()=>process.exit(2));r.end(JSON.stringify({args,key}));
`,{mode:0o700});
 const request=async(args,options={})=>{
  if(!options.pinnedSession&&!options.cliCapability)return bodyRequest(args,options);
  const key=options.pinnedSession?pin.inspect(options.pinnedSession).configDir:null;
  if(key)active.set(key,options);
  try{return await lark.request(args,options);}finally{if(key)active.delete(key);}
 };
 a.connectorRequest=request;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));paths.delete(dir);process.env.PATH=paths.size?[...paths].reverse().join(path.delimiter)+path.delimiter+originalPath:originalPath;fs.rmSync(dir,{recursive:true,force:true});});
 return request;
}
async function bind(a,c){const preview=await a.dispatch('connectorIdentityPreview',{id:c.id});const result=await a.dispatch('connectorBindPrincipal',{id:c.id,previewToken:preview.previewToken,operationId:preview.operationId,enableAfterBind:c.enabled});if(result.status!=='bound')throw Error('fixture binding failed');}
module.exports={attach,bind};
