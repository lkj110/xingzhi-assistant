// Isolated Electron fixture. It is excluded from every packaged application.
const fs=require('node:fs'),path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Test directory required');
require('../desktop/lark-connector.cjs').request=async args=>{
  if(args[0]==='auth')return {identities:{user:{available:true,status:'ready'}},verified:true};
  return {ok:true,data:{document:{content:fs.readFileSync(path.join(dir,'fixture-doc.md'),'utf8'),revision_id:1}}};
};
const electron=require('electron');electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};
require('../desktop/main.cjs');
