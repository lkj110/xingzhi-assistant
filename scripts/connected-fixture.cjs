// Isolated Electron fixture. It is excluded from every packaged application.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const dataDir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dataDir)throw new Error('Test directory required');
const dir=fs.realpathSync(dataDir);if(!dir.startsWith(fs.realpathSync(os.tmpdir())+path.sep))throw Error('Temporary test directory required');
// Electron's process.execPath is not Node. The Node runner supplies this path.
const node=process.env.ASSISTANT_TEST_NODE_BINARY;
if(!node||!path.isAbsolute(node)||/\s/.test(node))throw Error('ASSISTANT_TEST_NODE_BINARY must be an absolute Node path without whitespace');
fs.accessSync(node,fs.constants.X_OK);
const cliDir=fs.mkdtempSync(path.join(dir,'synthetic-lark-')),priorPath=process.env.PATH;
function syntheticCLI(root){
 const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),same=expected=>JSON.stringify(args)===JSON.stringify(expected),out=value=>console.log(JSON.stringify(value));
 if(same(['--version'])){console.log('lark-cli version 1.0.65');return;}
 const identity={appId:'cli_connected_fixture',brand:'feishu',openId:'ou_connected_fixture',tenantId:'tenant_connected_fixture'};
 if(same(['auth','status','--json'])||same(['auth','status','--json','--verify'])){out({appId:identity.appId,brand:identity.brand,verified:true,identities:{user:{openId:identity.openId,available:true,status:'ready'}}});return;}
 const configDir=process.env.LARKSUITE_CLI_CONFIG_DIR;
 if(!configDir)throw Error('Synthetic content and identity requests require a pinned config');
 const config=JSON.parse(fs.readFileSync(path.join(configDir,'config.json'),'utf8')),app=config.apps?.[0];
 if(config.apps?.length!==1||app.appId!==identity.appId||app.brand!==identity.brand||app.users?.length!==1||app.users[0].userOpenId!==identity.openId)throw Error('Unexpected synthetic identity');
 if(same(['api','GET','/open-apis/authen/v1/user_info','--as','user','--format','json'])){out({ok:true,identity:'user',data:{open_id:identity.openId,tenant_key:identity.tenantId}});return;}
 if(same(['docs','+fetch','--as','user','--doc','https://test.feishu.cn/docx/Meeting','--doc-format','markdown','--format','json'])){out({ok:true,identity:'user',data:{document:{content:fs.readFileSync(path.join(root,'fixture-doc.md'),'utf8'),revision_id:1}}});return;}
 throw Error('Unexpected synthetic CLI command');
}
fs.writeFileSync(path.join(cliDir,'lark-cli'),`#!${node}\n(${syntheticCLI.toString()})(${JSON.stringify(dir)});\n`,{mode:0o700});
process.env.PATH=cliDir+path.delimiter+(priorPath||'');
process.once('exit',()=>{if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;fs.rmSync(cliDir,{recursive:true,force:true});});
const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};
require('../desktop/main.cjs');
